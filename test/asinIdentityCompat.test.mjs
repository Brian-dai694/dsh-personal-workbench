/**
 * P2 身份兼容合同（后端侧）：
 * - 读：无 site 唯一匹配兼容；多站点歧义 409 `identity_required` + candidates；
 * - 写：无 site 一律 400 `site_required`；站点不符 409 `site_mismatch`；
 * - 创建：无 site 400，空站点不默认 US；
 * - 批量：旧字符串数组唯一匹配兼容，任一条歧义整体 409；对象数组按 site 解析。
 *
 * 读路径仍是 v1；同 ASIN 两个站点用影子表 fixture 模拟“已有多站点身份”。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'

async function withServer(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') { server.close(); db.close(); throw new Error('no port') }
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? {} : JSON.parse(text) }
  }
  try { await fn({ request, db }) } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

const ASIN = 'B0COMPAT01'
const NOW = '2026-10-29T00:00:00.000Z'

function addShadowSite(db, site) {
  db.prepare(`INSERT INTO asin_products_v2 (site, asin, title, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(site, ASIN, `${site} listing`, NOW, NOW)
}

test('创建：缺 site 400 site_required；带 site 201 且 identityState=ok', async () => {
  await withServer(async ({ request }) => {
    const missing = await request('POST', '/api/workbench/asin', { asin: ASIN, title: '缺站点' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.code, 'site_required')

    const created = await request('POST', '/api/workbench/asin', { asin: ASIN, site: 'us', title: '有站点' })
    assert.equal(created.status, 201)
    assert.equal(created.body.product.site, 'US')
    assert.equal(created.body.product.identityState, 'ok')
  })
})

test('读：唯一匹配兼容；影子表出现第二站点后 409 identity_required + candidates', async () => {
  await withServer(async ({ request, db }) => {
    const created = await request('POST', '/api/workbench/asin', { asin: ASIN, site: 'US', title: 't' })
    assert.equal(created.status, 201)

    const unique = await request('GET', `/api/workbench/asin/${ASIN}/trend`)
    assert.equal(unique.status, 200, '唯一匹配时无 site 仍可读')

    addShadowSite(db, 'DE')
    const ambiguous = await request('GET', `/api/workbench/asin/${ASIN}/trend`)
    assert.equal(ambiguous.status, 409)
    assert.equal(ambiguous.body.code, 'identity_required')
    assert.deepEqual(ambiguous.body.candidates, [{ site: 'DE' }, { site: 'US' }])

    const explicit = await request('GET', `/api/workbench/asin/${ASIN}/trend?site=US`)
    assert.equal(explicit.status, 200)

    const mismatch = await request('GET', `/api/workbench/asin/${ASIN}/trend?site=DE`)
    assert.equal(mismatch.status, 409, 'P2 读路径仍 v1：不能拿 US 行冒充 DE')
    assert.equal(mismatch.body.code, 'site_mismatch')
  })
})

test('写：PATCH/watch/judgment/task 缺 site 一律 400 site_required；空站点等同缺省', async () => {
  await withServer(async ({ request }) => {
    await request('POST', '/api/workbench/asin', { asin: ASIN, site: 'US', title: 't' })
    const cases = [
      ['PATCH', `/api/workbench/asin/${ASIN}`, { price: 12 }],
      ['PATCH', `/api/workbench/asin/${ASIN}?site=`, { price: 12 }],
      ['PATCH', `/api/workbench/asin/${ASIN}/watch`, { watch: true }],
      ['PATCH', `/api/workbench/asin/${ASIN}/judgment`, { verdict: 'do' }],
      ['POST', `/api/workbench/asin/${ASIN}/task`, {}],
    ]
    for (const [method, path, body] of cases) {
      const res = await request(method, path, body)
      assert.equal(res.status, 400, `${method} ${path} 应 400，实际 ${res.status}`)
      assert.equal(res.body.code, 'site_required')
    }

    const ok = await request('PATCH', `/api/workbench/asin/${ASIN}?site=US`, { price: 12 })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.product.price, 12)
  })
})

test('批量：旧字符串数组遇歧义整体 409；对象数组带 site 可执行', async () => {
  await withServer(async ({ request, db }) => {
    await request('POST', '/api/workbench/asin', { asin: ASIN, site: 'US', title: 't' })
    addShadowSite(db, 'DE')

    const legacy = await request('POST', '/api/workbench/asin/batch', { action: 'watch', asins: [ASIN] })
    assert.equal(legacy.status, 409)
    assert.equal(legacy.body.code, 'identity_required')

    const objects = await request('POST', '/api/workbench/asin/batch', {
      action: 'watch',
      items: [{ site: 'US', asin: ASIN }],
    })
    assert.equal(objects.status, 200)
    assert.equal(objects.body.affected, 1)

    const mixed = await request('POST', '/api/workbench/asin/batch', {
      action: 'watch',
      items: [{ site: 'US', asin: ASIN }, { site: 'DE', asin: ASIN }],
    })
    assert.equal(mixed.status, 409, '对象数组也不能把两个站点混在一次 v1 批量写入里')
    assert.equal(mixed.body.code, 'site_mismatch')
  })
})

test('导入：缺 site 的商品保为 null/needs_site，不被默认成 US', async () => {
  await withServer(async ({ request }) => {
    const imported = await request('POST', '/api/workbench/asin/import', {
      products: [{ asin: ASIN, title: '旧备份无站点' }],
    })
    assert.ok(imported.status === 200 || imported.status === 201)
    const list = await request('GET', '/api/workbench/asin')
    const product = list.body.products.find((item) => item.asin === ASIN)
    assert.ok(product !== undefined)
    assert.equal(product.site, null)
    assert.equal(product.identityState, 'needs_site')
    assert.deepEqual(list.body.facets.sites, [], '空站点不进 sites facets，不能被当成 US')
  })
})
