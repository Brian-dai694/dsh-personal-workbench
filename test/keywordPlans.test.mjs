/**
 * 关键词库：仓储 + HTTP 两层测试。
 *
 * 验收关注点（都是"用户能感知"的）：
 * 1. 保存后能读回**同样的行**（快照不被改写）；
 * 2. 局部更新只改显式字段 —— 改标题不能把 rows 清空；
 * 3. 脏值不落库（非法匹配方式 / 空标题）；
 * 4. 删掉方案不牵连别的方案；
 * 5. 选品库的 ASIN 只是弱关联：ASIN 不存在也能存（选品库清空不该连带毁词库）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  createKeywordPlan, deleteKeywordPlan, getKeywordPlan, listKeywordPlans, updateKeywordPlan,
} from '../lib/db/repo.js'

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-keyword-plan-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try { return run(db) } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

const ROWS = [
  { keyword: 'welding gloves', match: 'exact', campaign: 'SP-精准', rationale: '核心词' },
  { keyword: 'tig welding gloves', match: 'phrase', campaign: 'SP-词组', rationale: '长尾' },
]

test('仓储：保存后读回同样的行（快照），列表带行数与否词数', () => withDb((db) => {
  const plan = createKeywordPlan(db, {
    title: '焊接手套 主推', seed: 'welding gloves', modifiers: ['TIG', 'mig', 'tig'],
    matchTypes: ['exact', 'phrase'], negatives: ['cheap', 'CHEAP', 'free'], rows: ROWS, asin: ' b0test1234 ',
  })
  assert.equal(plan.title, '焊接手套 主推')
  // 修饰词/否词都做了小写化与去重
  assert.deepEqual(plan.modifiers.sort(), ['mig', 'tig'])
  assert.deepEqual(plan.negatives.sort(), ['cheap', 'free'])
  assert.equal(plan.asin, 'B0TEST1234')

  const back = getKeywordPlan(db, plan.id)
  assert.deepEqual(back.rows, ROWS)

  const [summary] = listKeywordPlans(db)
  assert.equal(summary.rowCount, 2)
  assert.equal(summary.negativeCount, 2)
}))

test('仓储：局部更新只改显式字段，改标题不清空 rows', () => withDb((db) => {
  const plan = createKeywordPlan(db, { title: 'A', seed: 'x', rows: ROWS })
  const renamed = updateKeywordPlan(db, plan.id, { title: 'B' })
  assert.equal(renamed.title, 'B')
  assert.deepEqual(renamed.rows, ROWS, '只改标题时 rows 必须原样保留')
  assert.equal(renamed.seed, 'x')

  // 显式传 null 才解绑 ASIN
  const linked = updateKeywordPlan(db, plan.id, { asin: 'B0ABC' })
  assert.equal(linked.asin, 'B0ABC')
  assert.equal(updateKeywordPlan(db, plan.id, { asin: null }).asin, null)

  // 空标题视为非法，不改库
  assert.equal(updateKeywordPlan(db, plan.id, { title: '   ' }), null)
  assert.equal(getKeywordPlan(db, plan.id).title, 'B')
}))

test('仓储：脏值不落库（非法匹配方式被丢弃、空标题抛错）', () => withDb((db) => {
  const plan = createKeywordPlan(db, {
    title: '脏值', seed: 'y',
    matchTypes: ['exact', 'bogus', 'EXACT'],
    rows: [
      { keyword: 'ok', match: 'broad', campaign: '', rationale: '' },
      { keyword: '', match: 'exact', campaign: '', rationale: '' },
      { keyword: 'bad match', match: 'weird', campaign: '', rationale: '' },
    ],
  })
  assert.deepEqual(plan.matchTypes, ['exact'])
  assert.deepEqual(plan.rows.map((r) => r.keyword), ['ok'])
  assert.throws(() => createKeywordPlan(db, { title: '   ' }), /标题不能为空/)
}))

test('仓储：删一份不牵连另一份', () => withDb((db) => {
  const a = createKeywordPlan(db, { title: 'A', seed: 'a' })
  const b = createKeywordPlan(db, { title: 'B', seed: 'b' })
  assert.equal(deleteKeywordPlan(db, a.id), true)
  assert.equal(deleteKeywordPlan(db, a.id), false, '重复删除返回 false，不抛错')
  assert.deepEqual(listKeywordPlans(db).map((p) => p.id), [b.id])
}))

async function withServer(fn) {
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
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try { await fn({ request }) } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('路由：建 → 列表 → 读全文 → 改名 → 删', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/keyword-plans', {
      title: '焊接手套', seed: 'welding gloves', modifiers: ['tig'], negatives: ['cheap'], rows: ROWS,
    })
    assert.equal(created.status, 200)
    const id = created.body.plan.id

    const list = await request('GET', '/api/workbench/keyword-plans')
    assert.equal(list.status, 200)
    assert.equal(list.body.plans.length, 1)
    assert.equal(list.body.plans[0].rowCount, 2)

    const one = await request('GET', `/api/workbench/keyword-plans/${id}`)
    assert.equal(one.status, 200)
    assert.deepEqual(one.body.plan.rows, ROWS)

    const renamed = await request('PATCH', `/api/workbench/keyword-plans/${id}`, { title: '焊接手套 v2' })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.plan.title, '焊接手套 v2')
    assert.equal(renamed.body.plan.rows.length, 2, '改名不许丢行')

    const removed = await request('DELETE', `/api/workbench/keyword-plans/${id}`)
    assert.equal(removed.status, 200)
    const after = await request('GET', `/api/workbench/keyword-plans/${id}`)
    assert.equal(after.status, 404)
  })
})

test('路由：空标题 400、未知 id 404（不返回 200 假成功）', async () => {
  await withServer(async ({ request }) => {
    const empty = await request('POST', '/api/workbench/keyword-plans', { title: '  ' })
    assert.equal(empty.status, 400)
    assert.match(empty.body.error, /标题不能为空/)
    assert.equal((await request('GET', '/api/workbench/keyword-plans/nope')).status, 404)
    assert.equal((await request('PATCH', '/api/workbench/keyword-plans/nope', { title: 'x' })).status, 404)
    assert.equal((await request('DELETE', '/api/workbench/keyword-plans/nope')).status, 404)
  })
})
