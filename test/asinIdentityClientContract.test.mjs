/**
 * P2 客户端合同（envelope / 错误码），给前端 `ApiError(status, code, message)` 用。
 *
 * ## 为什么单独一个文件
 *
 * `asinIdentityCompat.test.mjs` 守的是**后端行为**（唯一匹配、409、不默认 US）；
 * 这个文件守的是**前端要解析的字段名与形状**：字段改名、少一个 `candidates`、
 * 把文案从 `error` 挪到 `message`，都会在这里红，而不是等到界面上弹出一个
 * `HTTP 400（/api/workbench/asin）` 才发现。
 *
 * ## 已锁定的三条（observed，与 `src/api/http.ts` 一致）
 *
 * 1. 失败信封是 `{ ok:false, error:<中文文案>, code?, asin?, candidates? }` ——
 *    文案字段叫 **`error`**，不是 `message`；`client/api.ts` 读的也是 `body.error`。
 * 2. `code` 只在这三种身份错误上出现：`site_required`(400)、`identity_required`(409)、
 *    `site_mismatch`(409)；站点格式非法这类文本错误**没有 code**，前端只显示文案。
 * 3. `candidates` 每项当前只有 `{ site }`（两位大写字母，升序）；`shopName` 尚未提供，
 *    前端不要假设它一定存在。
 *
 * ## 库与 DB
 *
 * 全部用 `:memory:`，不打开也不写入 `~/.dsh/workbench/workbench.db`；导出用例把
 * `HOME` / `USERPROFILE` 指向临时目录，失败路径不应产生任何文件。
 *
 * 默认从 `../lib/` 导入（`pnpm test` 会先 build）。只想验证临时编译产物时可设
 * `WB_CONTRACT_LIB=<目录>` 指过去，避免为了跑一条合同测试去重建 `lib/`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB_ROOT = process.env.WB_CONTRACT_LIB ?? fileURLToPath(new URL('../lib/', import.meta.url))
const load = (relative) => import(pathToFileURL(join(LIB_ROOT, relative)).href)

const { openWorkbenchDb } = await load('db/database.js')
const { seedDictionaries } = await load('db/seed.js')
const { makeRoutes } = await load('api/routes.js')

/** 必须是 10 位字母数字：`normalizeAsinCode` 会拒掉 11 位，测试造数别踩。 */
const ASIN = 'B0CONTRACT'
const OTHER = 'B0CONTRAC2'
const NOW = '2026-10-29T00:00:00.000Z'
const PREFIX = '/api/workbench/asin'

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

/** 影子表里再放一个站点，模拟“同一 ASIN 已有多站点身份”。 */
function addShadowSite(db, site) {
  db.prepare(`INSERT INTO asin_products_v2 (site, asin, title, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(site, ASIN, `${site} listing`, NOW, NOW)
}

const keysOf = (value) => Object.keys(value).sort()

test('400 site_required：文案在 error（不是 message），带 code/asin，无 candidates', async () => {
  await withServer(async ({ request }) => {
    const missing = await request('POST', PREFIX, { asin: ASIN, title: '缺站点' })
    assert.equal(missing.status, 400)
    assert.deepEqual(keysOf(missing.body), ['asin', 'code', 'error', 'ok'])
    assert.equal(missing.body.ok, false)
    assert.equal(missing.body.code, 'site_required')
    assert.equal(missing.body.asin, ASIN)
    assert.equal(typeof missing.body.error, 'string')
    assert.ok(missing.body.error.length > 0, 'error 必须是非空中文文案，前端直接展示')
    assert.equal(missing.body.message, undefined, '文案字段是 error；不要同时出 message，前端会读错一个')

    /** 空串站点与缺省同义：仍是 400，不会回退到唯一匹配或 US。 */
    const emptySite = await request('POST', `${PREFIX}?site=`, { asin: ASIN })
    assert.equal(emptySite.status, 400)
    assert.equal(emptySite.body.code, 'site_required')
  })
})

test('站点格式非法：400 有文案但无 code（前端走通用文案分支）', async () => {
  await withServer(async ({ request }) => {
    const bad = await request('POST', PREFIX, { asin: ASIN, site: 'USA' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
    assert.equal(bad.body.code, undefined, '格式错误目前不带 code，别在前端按 code 分支')
    assert.match(bad.body.error, /两位字母/)
  })
})

test('409 identity_required：{ok,error,code,asin,candidates:[{site}]}，站点升序', async () => {
  await withServer(async ({ request, db }) => {
    await request('POST', PREFIX, { asin: ASIN, site: 'US', title: 't' })
    addShadowSite(db, 'DE')

    const ambiguous = await request('GET', `${PREFIX}/${ASIN}/trend`)
    assert.equal(ambiguous.status, 409)
    assert.deepEqual(keysOf(ambiguous.body), ['asin', 'candidates', 'code', 'error', 'ok'])
    assert.equal(ambiguous.body.code, 'identity_required')
    assert.equal(ambiguous.body.asin, ASIN)
    assert.equal(typeof ambiguous.body.error, 'string')
    assert.deepEqual(ambiguous.body.candidates, [{ site: 'DE' }, { site: 'US' }])
    for (const candidate of ambiguous.body.candidates) {
      assert.deepEqual(keysOf(candidate), ['site'], 'candidates 目前只有 site，shopName 尚未提供')
      assert.match(candidate.site, /^[A-Z]{2}$/)
    }
  })
})

test('409 site_mismatch：请求站点与已有行不符时同样是 409 + candidates', async () => {
  await withServer(async ({ request, db }) => {
    await request('POST', PREFIX, { asin: ASIN, site: 'US', title: 't' })
    addShadowSite(db, 'DE')

    const mismatch = await request('GET', `${PREFIX}/${ASIN}/trend?site=DE`)
    assert.equal(mismatch.status, 409)
    assert.equal(mismatch.body.code, 'site_mismatch')
    assert.equal(mismatch.body.asin, ASIN)
    assert.deepEqual(mismatch.body.candidates, [{ site: 'DE' }, { site: 'US' }])
    assert.equal(typeof mismatch.body.error, 'string')
  })
})

test('写：PATCH/watch/judgment/task 的 400 形状一致，成功回 product+facets', async () => {
  await withServer(async ({ request }) => {
    await request('POST', PREFIX, { asin: ASIN, site: 'US', title: 't' })
    for (const [method, path, body] of [
      ['PATCH', `${PREFIX}/${ASIN}`, { price: 12 }],
      ['PATCH', `${PREFIX}/${ASIN}/watch`, { watch: true }],
      ['PATCH', `${PREFIX}/${ASIN}/judgment`, { verdict: 'do' }],
      ['POST', `${PREFIX}/${ASIN}/task`, {}],
    ]) {
      const res = await request(method, path, body)
      assert.equal(res.status, 400, `${method} ${path}`)
      assert.equal(res.body.code, 'site_required')
      assert.equal(typeof res.body.error, 'string')
      assert.equal(res.body.ok, false)
    }

    const patched = await request('PATCH', `${PREFIX}/${ASIN}?site=us`, { price: 12 })
    assert.equal(patched.status, 200)
    assert.deepEqual(keysOf(patched.body), ['facets', 'ok', 'product'])
    assert.equal(patched.body.product.site, 'US', '小写站点归一为大写')
    assert.equal(patched.body.product.identityState, 'ok')
  })
})

test('成功信封：创建 201、列表 facets.sites 是 {value,count} 而不是字符串', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', `${PREFIX}?site=us`, { asin: ASIN, title: 't' })
    assert.equal(created.status, 201)
    assert.deepEqual(keysOf(created.body), ['facets', 'ok', 'product'])
    assert.equal(created.body.ok, true)
    assert.equal(created.body.product.site, 'US')
    assert.equal(created.body.product.identityState, 'ok')

    /** 无站点商品只能从导入进来：写接口一律要求 site，这正是合同要的效果。 */
    const imported = await request('POST', `${PREFIX}/import`, { products: [{ asin: OTHER, title: '旧备份无站点' }] })
    assert.equal(imported.status, 200)
    assert.equal(imported.body.ok, true)
    const all = await request('GET', PREFIX)
    assert.equal(all.status, 200)
    assert.equal(all.body.ok, true)
    const siteLess = all.body.products.find((product) => product.asin === OTHER)
    assert.equal(siteLess.site, null)
    assert.equal(siteLess.identityState, 'needs_site')

    assert.deepEqual(all.body.facets.sites, [{ value: 'US', count: 1 }], 'facets.sites 是 {value,count} 且空站点不入选')

    const filtered = await request('GET', `${PREFIX}?site=US`)
    assert.equal(filtered.body.total, 1)
    assert.deepEqual(filtered.body.products.map((product) => product.asin), [ASIN])
  })
})

test('trend：成功带 asin/site/points，小写路径回显统一大写', async () => {
  await withServer(async ({ request }) => {
    await request('POST', PREFIX, { asin: ASIN, site: 'US', title: 't' })
    const trend = await request('GET', `${PREFIX}/${ASIN.toLowerCase()}/trend`)
    assert.equal(trend.status, 200)
    assert.deepEqual(keysOf(trend.body), ['asin', 'ok', 'points', 'site'])
    assert.equal(trend.body.asin, ASIN, '回显必须与库内大写一致，前端按它做 key 才对得上')
    assert.equal(trend.body.site, 'US', '无 site 读取时前端需要知道解析到了哪个站点')
    assert.deepEqual(trend.body.points, [])
  })
})

test('批量：旧数组歧义 409；跨站点对象数组 409 且候选是站点并集', async () => {
  await withServer(async ({ request, db }) => {
    await request('POST', PREFIX, { asin: ASIN, site: 'US', title: 't' })
    await request('POST', PREFIX, { asin: OTHER, site: 'DE', title: 't2' })
    addShadowSite(db, 'DE')

    const legacy = await request('POST', `${PREFIX}/batch`, { action: 'watch', asins: [ASIN] })
    assert.equal(legacy.status, 409)
    assert.equal(legacy.body.code, 'identity_required')
    assert.deepEqual(legacy.body.candidates, [{ site: 'DE' }, { site: 'US' }])

    const crossSite = await request('POST', `${PREFIX}/batch`, {
      action: 'watch',
      items: [{ site: 'US', asin: ASIN }, { site: 'DE', asin: OTHER }],
    })
    assert.equal(crossSite.status, 409)
    assert.equal(crossSite.body.code, 'identity_required')
    assert.deepEqual(crossSite.body.candidates, [{ site: 'DE' }, { site: 'US' }])
    assert.equal(typeof crossSite.body.error, 'string')
  })
})

test('导出：歧义时 409 且不落任何文件（HOME 已指向临时目录）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-asin-contract-'))
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    await withServer(async ({ request, db }) => {
      await request('POST', PREFIX, { asin: ASIN, site: 'US', title: 't' })
      addShadowSite(db, 'DE')

      const ambiguous = await request('GET', `${PREFIX}/export?asins=${encodeURIComponent(JSON.stringify([ASIN]))}`)
      assert.equal(ambiguous.status, 409)
      assert.equal(ambiguous.body.code, 'identity_required')
      assert.deepEqual(ambiguous.body.candidates, [{ site: 'DE' }, { site: 'US' }])
      assert.deepEqual(readdirSync(home), [], '409 必须在写文件之前返回')
    })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    rmSync(home, { recursive: true, force: true })
  }
})
