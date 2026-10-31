/**
 * 选品导出 / 回导 / 批量操作。
 *
 * 这一组测试的核心是**回导闭环**：导出的 JSON 必须能被自己的导入器读回来，
 * 并且关注标记与判断结论不丢。理由是导入器只按固定的键名读，导出时少写一个键，
 * 备份就静默降级 —— 而用户以为"我有备份"。
 *
 * 同时覆盖本轮修掉的一个真 bug：`importAsinStores` 的 upsert 曾引用
 * `asin_products.watch`（在 asin_stores 上不存在），`prepare` 当场抛错，
 * 结果是**任何** ASIN JSON 导入都会失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  asinFacets, batchUpdateAsins, importAsinProducts, importAsinStores, listAllAsinProducts,
  listAsinStores, queryAsinPage, setAsinJudgment, setAsinWatch,
} from '../lib/db/repo.js'
import { buildAsinBackup, productKey } from '../lib/shared/asinExport.js'
import { normalizeAsinImport } from '../lib/shared/asinImport.js'

function product(asin, overrides = {}) {
  return {
    asin, site: 'US', title: `标题 ${asin}`, currentTitle: null, imageUrl: null, url: null,
    price: 19.99, currency: 'USD', rating: 4.5, reviews: 120, bsr: 3000, brand: 'BR', seller: 'SL',
    shopId: 'shop-1', shopName: '店铺一', category: '工具', note: null, tags: ['候选'],
    extraJson: JSON.stringify({ deal: { active: true, type: 'BD', discountPercent: 15, price: 16.99, listPrice: 19.99 }, bsrList: [{ rank: 3000 }], boughtMonth: 300 }),
    addedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-asin-export-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try { return run(db) } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

const STORE = { id: 'US_shop-1', sellerId: 'shop-1', site: 'US', name: '店铺一', url: null, note: null, watch: false, lastScannedAt: null, productsCount: 1 }

test('店铺导入不再抛错（回归：upsert 曾引用 asin_products.watch）', () => withDb((db) => {
  assert.equal(importAsinStores(db, [STORE]), 1)
  assert.equal(listAsinStores(db).length, 1)
  // 再来一次走 ON CONFLICT 分支，仍然不能抛
  assert.equal(importAsinStores(db, [{ ...STORE, watch: true, name: '店铺一（改）' }]), 1)
  const [row] = listAsinStores(db)
  assert.equal(row.name, '店铺一（改）')
  assert.equal(row.watch, true, '关注的店铺不能被后续导入清掉')
}))

test('导出键是 site_ASIN，次要字段摊平回顶层（否则回导就丢）', () => withDb((db) => {
  importAsinProducts(db, [product('B0EXPORT01')], [], 0, null)
  const backup = buildAsinBackup(listAllAsinProducts(db), listAsinStores(db), new Date('2026-10-24T00:00:00Z'))
  assert.deepEqual(Object.keys(backup.products), ['US_B0EXPORT01'])
  const record = backup.products['US_B0EXPORT01']
  assert.equal(record.price, 19.99)
  assert.equal(record.reviewCount, 120)
  assert.equal(record.boughtPastMonth, 300, 'extraJson 的 boughtMonth 必须翻译成导入器认识的 boughtPastMonth')
  assert.equal(record.dealActive, true, 'deal 对象必须拆成导入器认识的 dealActive/dealPrice…')
  assert.equal(record.dealPrice, 16.99)
  assert.deepEqual(record.tags, ['候选'])
  assert.deepEqual(backup.categories, ['工具'])
  assert.deepEqual(backup.tags, ['候选'])
  assert.equal(backup.exportedAt, '2026-10-24T00:00:00.000Z')
}))

test('回导闭环：导出的 JSON 能被自己的导入器读回，价格/标签/关注/结论都在', () => withDb((db) => {
  importAsinProducts(db, [product('B0ROUND001', { watch: true })], [], 0, null)
  setAsinWatch(db, 'B0ROUND001', true)
  setAsinJudgment(db, 'B0ROUND001', { verdict: 'do', score: 82, nextAction: '先拍主图', source: 'manual' })

  const backup = buildAsinBackup(listAllAsinProducts(db), listAsinStores(db))
  const parsed = normalizeAsinImport(JSON.parse(JSON.stringify(backup)))

  assert.equal(parsed.rejected, 0)
  assert.equal(parsed.products.length, 1)
  const back = parsed.products[0]
  assert.equal(back.asin, 'B0ROUND001')
  assert.equal(back.site, 'US')
  assert.equal(back.price, 19.99)
  assert.deepEqual(back.tags, ['候选'])
  assert.equal(back.watch, true, '关注标记必须能回导')
  assert.equal(back.judgment?.verdict, 'do', '判断结论必须能回导')
  assert.equal(back.judgment?.score, 82)
  assert.equal(back.judgment?.nextAction, '先拍主图')
  assert.equal(JSON.parse(back.extraJson).boughtMonth, 300, '次要字段往返后仍在')
}))

test('回导时非法 verdict 被丢弃（外部文件不可信），分数被夹到 0–100', () => {
  const parsed = normalizeAsinImport({
    products: {
      US_B0BAD00001: { asin: 'B0BAD00001', verdict: '看起来能做', score: 400 },
      US_B0BAD00002: { asin: 'B0BAD00002', verdict: 'do', score: 999 },
    },
  })
  assert.equal(parsed.products[0].judgment, undefined, '自由文本 verdict 不能进库')
  assert.equal(parsed.products[1].judgment?.verdict, 'do')
  assert.equal(parsed.products[1].judgment?.score, 100, '越界分数要夹到 100')
})

test('批量：关注/取消、加标签幂等、删标签、删除（含趋势），不存在的 ASIN 只计数', () => withDb((db) => {
  importAsinProducts(db, [product('B0BATCH001'), product('B0BATCH002'), product('B0BATCH003')], [], 0, null)
  db.prepare('INSERT INTO asin_snapshots (id, asin, captured_at, price) VALUES (?, ?, ?, ?)').run('s1', 'B0BATCH003', '2026-10-01T00:00:00.000Z', 19.99)

  const watched = batchUpdateAsins(db, ['b0batch001', 'B0BATCH002'], 'watch')
  assert.equal(watched.affected, 2)
  assert.deepEqual(queryAsinPage(db, { watch: 'watch' }).items.map((p) => p.asin).sort(), ['B0BATCH001', 'B0BATCH002'])

  const added = batchUpdateAsins(db, ['B0BATCH001'], 'addTag', '重点')
  assert.equal(added.affected, 1)
  // 幂等：再加一次同名标签不重复写
  batchUpdateAsins(db, ['B0BATCH001'], 'addTag', '重点')
  assert.deepEqual(queryAsinPage(db, { tag: '重点' }).items.map((p) => p.asin), ['B0BATCH001'])

  batchUpdateAsins(db, ['B0BATCH001'], 'removeTag', '重点')
  assert.equal(queryAsinPage(db, { tag: '重点' }).total, 0)

  const deleted = batchUpdateAsins(db, ['B0BATCH003', 'B0MISSING01'], 'delete')
  assert.equal(deleted.affected, 1)
  assert.equal(deleted.missing, 1, '不存在的 ASIN 只计数，不让整批失败')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_snapshots WHERE asin = ?').get('B0BATCH003').n, 0, '趋势采样随商品一起删')

  assert.equal(asinFacets(db).total, 2)
}))

test('批量：空列表/非法动作/空标签/超上限都被拒（不静默截断）', () => withDb((db) => {
  importAsinProducts(db, [product('B0LIMIT001')], [], 0, null)
  assert.throws(() => batchUpdateAsins(db, [], 'watch'), /至少选择一个/)
  assert.throws(() => batchUpdateAsins(db, ['B0LIMIT001'], 'nuke'), /不支持的批量动作/)
  assert.throws(() => batchUpdateAsins(db, ['B0LIMIT001'], 'addTag', '   '), /标签不能为空/)
  const tooMany = Array.from({ length: 501 }, (_, i) => `B0LIMIT${String(i).padStart(3, '0')}`)
  assert.throws(() => batchUpdateAsins(db, tooMany, 'watch'), /一次最多处理/)
}))

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
  if (address === null || typeof address === 'string') { server.close(); db.close(); throw new Error('no port') }
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { await fn({ request, db }) } finally {
    process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('路由：导入（含 stores 与判断）→ 导出文件 → 批量', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-asin-home-'))
  try {
    await withServer(home, async ({ request, db }) => {
      // 导入一份「带店铺 + 带判断」的备份：这条路径以前会因 stores 直接抛错
      const imported = await request('POST', '/api/workbench/asin/import', {
        version: 1,
        products: { US_B0ROUTE001: { asin: 'B0ROUTE001', title: '路由商品', price: 12.5, tags: ['A'], watch: true, verdict: 'watch', score: 55 } },
        stores: { 'US_shop-1': { sellerId: 'shop-1', site: 'US', name: '店铺一' } },
      })
      assert.equal(imported.status, 200, '导入不能因为 stores 失败')
      assert.equal(imported.body.inserted, 1)
      assert.equal(imported.body.stores, 1)
      assert.equal(imported.body.judgmentRestored, 1, '备份里的判断结论要恢复')

      const product = queryAsinPage(db, {}).items[0]
      assert.equal(product.watch, true)
      assert.equal(product.judgment.verdict, 'watch')
      assert.equal(product.judgment.score, 55)

      // 导出 → 真文件 → 能再导入
      const exported = await request('GET', '/api/workbench/asin/export')
      assert.equal(exported.status, 200)
      assert.equal(exported.body.products, 1)
      const raw = readFileSync(exported.body.path, 'utf8')
      const backup = JSON.parse(raw)
      assert.deepEqual(Object.keys(backup.products), ['US_B0ROUTE001'])
      assert.equal(normalizeAsinImport(backup).products.length, 1)

      // 批量
      const batched = await request('POST', '/api/workbench/asin/batch', { asins: ['B0ROUTE001'], action: 'addTag', tag: 'B' })
      assert.equal(batched.status, 200)
      assert.equal(batched.body.affected, 1)
      assert.deepEqual(queryAsinPage(db, { tag: 'B' }).items.map((p) => p.asin), ['B0ROUTE001'])

      assert.equal((await request('POST', '/api/workbench/asin/batch', { asins: ['B0ROUTE001'], action: 'explode' })).status, 400)
    })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('导出仅选中：?asins= 只导那些', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wb-asin-home2-'))
  try {
    await withServer(home, async ({ request, db }) => {
      importAsinProducts(db, [product('B0SEL00001'), product('B0SEL00002')], [], 0, null)
      const exported = await request('GET', '/api/workbench/asin/export?asins=b0sel00002')
      assert.equal(exported.status, 200)
      assert.equal(exported.body.products, 1)
      const backup = JSON.parse(readFileSync(exported.body.path, 'utf8'))
      assert.deepEqual(Object.keys(backup.products), ['US_B0SEL00002'])
    })
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('productKey：缺站点用 UNKNOWN（不默认 US），ASIN 大写', () => {
  assert.equal(productKey({ asin: 'b0abc', site: '' }), 'UNKNOWN_B0ABC')
  assert.equal(productKey({ asin: 'b0abc', site: 'jp' }), 'JP_B0ABC')
})

test('全量快照：评分卡分项 / VOC 痛点 / 风险 / 覆盖词数都能回导', () => withDb((db) => {
  importAsinProducts(db, [product('B0FULL0001')], [], 0, null)
  setAsinJudgment(db, 'B0FULL0001', {
    verdict: 'do',
    score: 88,
    nextAction: '先打样再拍主图',
    criteria: [{ name: '需求强度', value: '高' }, { name: '竞争', value: '中' }],
    painPoints: [{ label: '手套不透气', count: 7 }, { label: '尺寸偏小', count: 3 }],
    risk: { level: 'medium', note: 'US 有一件近似商标' },
    keywordCount: 42,
    source: 'amazon-selection-human-plus',
  })

  const backup = buildAsinBackup(listAllAsinProducts(db), listAsinStores(db))
  const record = backup.products['US_B0FULL0001']
  assert.equal(record.verdict, undefined, '新版导出不再平铺 verdict，改用嵌套 judgment')
  assert.deepEqual(record.judgment.criteria, [{ name: '需求强度', value: '高' }, { name: '竞争', value: '中' }])
  assert.deepEqual(record.judgment.painPoints, [{ label: '手套不透气', count: 7 }, { label: '尺寸偏小', count: 3 }])
  assert.deepEqual(record.judgment.risk, { level: 'medium', note: 'US 有一件近似商标' })
  assert.equal(record.judgment.keywordCount, 42)

  const parsed = normalizeAsinImport(JSON.parse(JSON.stringify(backup)))
  const back = parsed.products[0].judgment
  assert.equal(back.verdict, 'do')
  assert.equal(back.score, 88)
  assert.equal(back.nextAction, '先打样再拍主图')
  assert.deepEqual(back.criteria, [{ name: '需求强度', value: '高' }, { name: '竞争', value: '中' }], '评分卡分项必须往返不丢')
  assert.deepEqual(back.painPoints, [{ label: '手套不透气', count: 7 }, { label: '尺寸偏小', count: 3 }], 'VOC 痛点必须往返不丢')
  assert.deepEqual(back.risk, { level: 'medium', note: 'US 有一件近似商标' })
  assert.equal(back.keywordCount, 42)
  assert.equal(back.judgedSource, 'amazon-selection-human-plus')
}))

test('旧版备份（平铺 verdict/score）仍能读；嵌套里的坏分数只丢判断、不毁整份导入', () => {
  const legacy = normalizeAsinImport({ products: { US_B0LEGACY01: { asin: 'B0LEGACY01', verdict: 'drop', score: 12 } } })
  assert.equal(legacy.products[0].judgment?.verdict, 'drop')
  assert.equal(legacy.products[0].judgment?.score, 12)

  const badNested = normalizeAsinImport({
    products: {
      US_B0NESTED01: { asin: 'B0NESTED01', title: '坏判断', judgment: { verdict: 'do', score: 500 } },
      US_B0NESTED02: { asin: 'B0NESTED02', title: '好判断', judgment: { verdict: 'watch', score: 60 } },
    },
  })
  assert.equal(badNested.rejected, 0, '坏判断不该让整条商品被拒绝')
  assert.equal(badNested.products.length, 2)
  assert.equal(badNested.products[0].judgment, undefined, '越界分数 → 丢弃该判断')
  assert.equal(badNested.products[0].title, '坏判断', '商品本身照常导入')
  assert.equal(badNested.products[1].judgment?.verdict, 'watch')
})
