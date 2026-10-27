/**
 * 关键词 CSV 导出：纯函数 + 真写盘（路由层）。
 *
 * 为什么要单独测纯函数：客户端「复制 CSV」和服务端「导出文件」共用这一份生成规则，
 * 一旦转义或否词分段的规则漂移，就会出现"复制的能打开、导出的打不开"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keywordCsvFileName, keywordPlanCsv } from '../lib/shared/keywordPlanCsv.js'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createKeywordPlan } from '../lib/db/repo.js'

const ROWS = [
  { keyword: 'welding gloves', match: 'exact', campaign: 'SP-精准', rationale: '核心词' },
  { keyword: 'tig, mig gloves', match: 'phrase', campaign: 'SP-词组', rationale: '带逗号的词' },
  { keyword: 'quote "x" gloves', match: 'broad', campaign: 'SP-广泛', rationale: '带引号的词' },
]

test('CSV：逗号与引号被安全转义，否词单独成段', () => {
  const csv = keywordPlanCsv(ROWS, ['cheap', 'free sample'])
  const lines = csv.split('\n')
  assert.equal(lines[0], 'keyword,match,campaign,rationale')
  assert.equal(lines.length, 1 + ROWS.length + 2)
  // 逗号在引号内 → 列数仍是 4
  assert.equal(lines[2].startsWith('"tig, mig gloves",'), true)
  // 引号翻倍
  assert.equal(lines[3].includes('"quote ""x"" gloves"'), true)
  // 否词行标成 negative_exact，不混进投放词
  assert.equal(lines[4].startsWith('"cheap","negative_exact"'), true)
  assert.equal(lines[5].startsWith('"free sample","negative_exact"'), true)
})

test('CSV：没有否词时不多出空行；空输入也只有表头', () => {
  assert.equal(keywordPlanCsv(ROWS).split('\n').length, 1 + ROWS.length)
  assert.equal(keywordPlanCsv([], []), 'keyword,match,campaign,rationale')
})

test('文件名：Windows 非法字符被清洗，空标题回落 keywords', () => {
  assert.equal(keywordCsvFileName('Q4 主推: 焊接/手套*', new Date(2026, 9, 24)), 'Q4-主推-焊接-手套-20261024.csv')
  assert.equal(keywordCsvFileName('   ', new Date(2026, 9, 24)), 'keywords-20261024.csv')
  // 长标题被截到 48 字符：48 + '-' + 8 位日期 + '.csv' = 61
  const long = keywordCsvFileName('a'.repeat(80), new Date(2026, 9, 24))
  assert.equal(long.length, 61)
  assert.equal(long.endsWith('-20261024.csv'), true)
})

async function withServer(home, fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close(); db.close()
    throw new Error('测试服务器没有拿到端口')
  }
  const request = async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, { method })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  // 导出目录由 homedir() 决定：测试里把 HOME/USERPROFILE 指到临时目录
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { await fn({ request, db }) } finally {
    process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('导出：按库里的行写真实 CSV 文件（带 BOM），404 不写文件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-kw-export-'))
  try {
    await withServer(home, async ({ request, db }) => {
      const plan = createKeywordPlan(db, { title: '焊接手套', seed: 'welding gloves', rows: ROWS, negatives: ['cheap'] })
      const res = await request('POST', `/api/workbench/keyword-plans/${plan.id}/export`)
      assert.equal(res.status, 200)
      assert.equal(res.body.rows, 3)
      assert.equal(res.body.negatives, 1)
      assert.equal(existsSync(res.body.path), true, '返回的路径必须真的存在')

      const text = readFileSync(res.body.path, 'utf8')
      assert.equal(text.charCodeAt(0), 0xFEFF, 'Excel 打开中文需要 BOM')
      const lines = text.replace(/^\uFEFF/, '').split('\n')
      assert.equal(lines.length, 1 + 3 + 1)
      assert.equal(lines.at(-1).startsWith('"cheap","negative_exact"'), true)

      const missing = await request('POST', '/api/workbench/keyword-plans/nope/export')
      assert.equal(missing.status, 404)
    })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('导出：同名方案在同一天不会互相覆盖（自动加 (2)）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-kw-collide-'))
  try {
    await withServer(home, async ({ request, db }) => {
      const a = createKeywordPlan(db, { title: '同名', seed: 'x', rows: ROWS })
      const b = createKeywordPlan(db, { title: '同名', seed: 'y', rows: ROWS })
      const first = await request('POST', `/api/workbench/keyword-plans/${a.id}/export`)
      const second = await request('POST', `/api/workbench/keyword-plans/${b.id}/export`)
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.notEqual(first.body.path, second.body.path, '同名导出不能落到同一个文件')
      assert.match(second.body.path, /\(2\)\.csv$/)
      assert.equal(existsSync(first.body.path), true)
      assert.equal(existsSync(second.body.path), true)
    })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
