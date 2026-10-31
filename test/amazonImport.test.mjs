/**
 * P2-1 / P2-2：数据集新列与**统一导入路由**。
 *
 * 三件事一次测清：
 * 1. 六种 `kind_code` 都能导入（每种额外列的校验口径不同）；
 * 2. 缺列 → 400 + 中文原因（点名缺哪一列），不存半份；
 * 3. 旧路由 `POST /amazon/datasets` 与新路由 `POST /amazon/import` 行为一致（同一实现），
 *    且重复导入返回既有那份（`duplicate: true`），不再堆行。
 *
 * 迁移只碰内存库，绝不动用户真库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import { migrate } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { getAmazonDataset, listAmazonDatasets } from '../lib/db/repo.js'

/** 部署中（真实库）的版本：用来模拟"从 35 迁到 36"。 */
const DEPLOYED_VERSION = 35

function openMemoryDb() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  seedDictionaries(db)
  return db
}

/** 造一份 35 版库：跑到 v35 为止，再写一行老数据。 */
function openDbAtDeployedVersion() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  for (const migration of MIGRATIONS.filter((item) => item.version <= DEPLOYED_VERSION)) migration.up(db)
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(DEPLOYED_VERSION))
  db.prepare(`INSERT INTO amazon_datasets
    (id, kind_code, title, period, rows_json, annotations_json, source_code, session_id, ai_summary, created_at, updated_at)
    VALUES ('legacy-1', 'search_term', '老报表', '2026-10-01~2026-10-07', ?, '[]', 'paste', NULL, NULL, ?, ?)`)
    .run(JSON.stringify([{ keyword: 'tig torch', impressions: 10, clicks: 1, orders: 0, spend: 1, sales: 0 }]),
      '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')
  return db
}

const CORE = { keyword: 'tig torch', impressions: 100, clicks: 8, orders: 0, spend: 5.5, sales: 0 }

function rowsFor(kind) {
  const core = { ...CORE }
  switch (kind) {
    case 'targeting': return [{ ...core, matchType: 'exact', campaign: 'SP-手动词' }]
    case 'placement': return [{ ...core, placement: '搜索结果顶部' }]
    case 'budget': return [{ ...core, budget: 20 }]
    case 'impression_share': return [{ ...core, share: 0.12 }]
    case 'campaign': return [{ ...core, campaign: 'SP-自动' }]
    default: return [core]
  }
}

function startServer() {
  const db = openMemoryDb()
  const routes = makeRoutes(db, {})
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  return { db, server }
}

async function withServer(fn) {
  const { db, server } = startServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close(); db.close()
    throw new Error(`测试服务器没有拿到端口（address=${String(address)}）`)
  }
  const base = `http://127.0.0.1:${address.port}`
  const request = async (method, path, body) => {
    const init = body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const res = await fetch(`${base}${path}`, init)
    const text = await res.text()
    let parsed
    try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text } }
    return { status: res.status, body: parsed }
  }
  try { await fn({ db, request }) } finally { server.close(); db.close() }
}

const KINDS = ['search_term', 'targeting', 'campaign', 'placement', 'budget', 'impression_share']

test('六种 kind_code 都能从统一路由导入，并原样读回类型', async () => {
  await withServer(async ({ db, request }) => {
    for (const kind of KINDS) {
      const created = await request('POST', '/api/workbench/amazon/import', {
        kind_code: kind,
        title: `${kind} 报表 2026/10/29 10:00:00`,
        period: `2026-10-${String(KINDS.indexOf(kind) + 1).padStart(2, '0')}~2026-10-29`,
        rows: rowsFor(kind),
      })
      assert.equal(created.status, 201, `${kind} 导入应成功：${JSON.stringify(created.body)}`)
      assert.equal(created.body.duplicate, false)
      assert.equal(created.body.dataset.kindCode, kind)
      assert.equal(created.body.datasetId, created.body.dataset.id)
      assert.equal(created.body.dataset.univerFile, null, '刚导入时没有表格路径')

      const reread = await request('GET', `/api/workbench/amazon/datasets/${created.body.dataset.id}`)
      assert.equal(reread.status, 200)
      assert.equal(reread.body.dataset.kindCode, kind)
      assert.equal(reread.body.dataset.rows.length, 1)
    }
    assert.equal(listAmazonDatasets(db, 'targeting').length, 1)
  })
})

test('缺列 → 400 且点名缺哪一列；不落半份数据', async () => {
  await withServer(async ({ db, request }) => {
    const cases = [
      { kind_code: 'search_term', rows: [{ keyword: 'a', impressions: 1, clicks: 1, orders: 0, spend: 0 }], missing: '销售额' },
      { kind_code: 'targeting', rows: [{ ...CORE }], missing: '匹配类型' },
      { kind_code: 'placement', rows: [{ ...CORE }], missing: '广告位' },
      { kind_code: 'budget', rows: [{ ...CORE }], missing: '预算' },
      { kind_code: 'impression_share', rows: [{ ...CORE }], missing: '曝光份额' },
    ]
    for (const item of cases) {
      const res = await request('POST', '/api/workbench/amazon/import', { kind_code: item.kind_code, rows: item.rows })
      const text = JSON.stringify(res.body)
      assert.equal(res.status, 400, `${item.kind_code} 缺列应 400，实际：${text}`)
      assert.match(res.body.error, new RegExp(item.missing), `错误信息应点名缺「${item.missing}」：${text}`)
      assert.equal(res.body.code, 'missing-columns')
      assert.ok(Array.isArray(res.body.missing) && res.body.missing.includes(item.missing))
    }
    const list = await request('GET', '/api/workbench/amazon/datasets')
    assert.equal(list.body.datasets.length, 0, '被拒的导入不得留下任何数据集')
    assert.equal(listAmazonDatasets(db).length, 0)
  })
})

test('坏行（关键词为空 / 数字是字符串）→ 400，不猜成 0', async () => {
  await withServer(async ({ request }) => {
    const emptyKeyword = await request('POST', '/api/workbench/amazon/import', {
      kind_code: 'search_term',
      rows: [{ ...CORE, keyword: '   ' }],
    })
    assert.equal(emptyKeyword.status, 400)
    assert.match(emptyKeyword.body.error, /搜索词.*为空/)

    const stringNumber = await request('POST', '/api/workbench/amazon/import', {
      kind_code: 'search_term',
      rows: [{ ...CORE, spend: '5.5' }],
    })
    assert.equal(stringNumber.status, 400)
    assert.match(stringNumber.body.error, /花费.*非负数字/)
  })
})

test('非法 kind_code → 400 并列出允许值', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', '/api/workbench/amazon/import', { kind_code: 'unknown_kind', rows: [CORE] })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'invalid-kind')
    assert.match(res.body.error, /search_term/)
  })
})

test('旧路由 delegate 新实现：kindCode 兼容、校验口径一致', async () => {
  await withServer(async ({ request }) => {
    const legacy = await request('POST', '/api/workbench/amazon/datasets', {
      kindCode: 'targeting',
      title: '旧入口',
      period: '2026-10-01~2026-10-07',
      rows: rowsFor('targeting'),
    })
    assert.equal(legacy.status, 201)
    assert.equal(legacy.body.dataset.kindCode, 'targeting')

    /** 缺列走旧入口也必须 400（证明不是两套校验）。 */
    const missing = await request('POST', '/api/workbench/amazon/datasets', {
      kindCode: 'targeting',
      rows: [CORE],
    })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /匹配类型/)
    assert.equal(missing.body.code, 'missing-columns')
  })
})

test('重复导入（同 kind_code + 同 period + 同行数）返回既有那份', async () => {
  await withServer(async ({ request }) => {
    const payload = {
      kind_code: 'search_term',
      title: '搜索词报表 2026/10/24 13:59:09',
      period: '2026-10-18~2026-10-24',
      rows: [{ ...CORE }, { ...CORE, keyword: 'tig cups' }],
    }
    const first = await request('POST', '/api/workbench/amazon/import', payload)
    assert.equal(first.status, 201)
    assert.equal(first.body.duplicate, false)

    const second = await request('POST', '/api/workbench/amazon/import', { ...payload, title: '搜索词报表 2026/10/24 14:10:00' })
    assert.equal(second.status, 200, '重复导入不是"又建一份"')
    assert.equal(second.body.duplicate, true)
    assert.equal(second.body.dataset.id, first.body.dataset.id)

    const list = await request('GET', '/api/workbench/amazon/datasets')
    assert.equal(list.body.datasets.length, 1, '列表里仍只有一份')
  })
})

test('迁移：35 → 36 只加 univer_file；老行 kind_code 不变、univer_file 为 null', () => {
  assert.ok(SCHEMA_VERSION >= 36, '本批改动要求 schema ≥ 36')
  const db = openDbAtDeployedVersion()
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(DEPLOYED_VERSION))

  migrate(db)
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION))

  const columns = db.prepare('PRAGMA table_info(amazon_datasets)').all().map((row) => row.name)
  assert.ok(columns.includes('univer_file'), 'v36 应加上 univer_file')
  assert.equal(columns.includes('kind'), false, '不要再造 kind 列（复用 kind_code）')

  const legacy = getAmazonDataset(db, 'legacy-1')
  assert.ok(legacy !== undefined)
  assert.equal(legacy.kindCode, 'search_term', '老行 kind_code 保持 search_term')
  assert.equal(legacy.univerFile, null, '老行 univer_file 是 NULL，不伪造路径')
})
