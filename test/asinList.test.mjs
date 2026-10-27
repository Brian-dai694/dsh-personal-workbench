/**
 * 选品列表能力（migration 27：watch / manual_order）的仓储级测试。
 *
 * 为什么要测仓储而不是只测界面：
 * - 列表新增的排序键是**拼进 SQL** 的，白名单一旦漏掉就是注入面；
 * - 导入是 upsert，若 SQL 列数与参数数对不上（本次新增 watch 列），
 *   只有真正跑一次导入才暴露；
 * - 重新导入不能把用户手动标的「重点关注」冲掉。
 * 这三种错在 UI 上都表现为「看起来正常」，所以必须落在仓储断言上。
 * 迁移只碰内存库，不碰用户真库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../lib/db/database.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import { asinFacets, importAsinProducts, queryAsinPage, setAsinWatch } from '../lib/db/repo.js'

function openMemoryDb() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

function product(overrides) {
  return {
    asin: 'B0TEST0001',
    site: 'US',
    title: 'TIG 焊枪',
    currentTitle: null,
    imageUrl: null,
    url: null,
    price: 19.9,
    currency: 'USD',
    rating: 4.5,
    reviews: 100,
    bsr: 1000,
    brand: 'YOBEL',
    seller: 'YOBEL',
    shopId: 'SHOP1',
    shopName: 'YOBEL 官方店',
    category: '焊枪',
    note: null,
    tags: [],
    extraJson: '{}',
    addedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function seed(db) {
  const products = [
    product({ asin: 'B0TEST0001', title: '夹具 A', price: 9.9, tags: ['主打'], addedAt: '2026-10-01T00:00:00.000Z' }),
    product({ asin: 'B0TEST0002', title: '夹具 B', price: 19.9, tags: ['待验证', '主打'], addedAt: '2026-10-02T00:00:00.000Z' }),
    product({ asin: 'B0TEST0003', title: '夹具 C', price: null, tags: [], addedAt: '2026-10-03T00:00:00.000Z' }),
  ]
  return importAsinProducts(db, products, [], 0, null)
}

test('迁移到最新版本后，asin_products 具备 watch 与 manual_order 列', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
  const db = openMemoryDb()
  const columns = db.prepare('PRAGMA table_info(asin_products)').all().map((row) => row.name)
  assert.ok(columns.includes('watch'))
  assert.ok(columns.includes('manual_order'))
})

test('导入三件商品：总数与默认收藏时间倒序都对', () => {
  const db = openMemoryDb()
  assert.equal(seed(db).inserted, 3)
  const page = queryAsinPage(db)
  assert.equal(page.total, 3)
  assert.deepEqual(page.items.map((item) => item.asin), ['B0TEST0003', 'B0TEST0002', 'B0TEST0001'])
  assert.equal(page.items[2].watch, false)
})

test('标签筛选是精确标签匹配，且不会被 % 之类的字符放大成全表', () => {
  const db = openMemoryDb()
  seed(db)
  const main = queryAsinPage(db, { tag: '主打' })
  assert.equal(main.total, 2)
  assert.deepEqual(main.items.map((item) => item.asin).sort(), ['B0TEST0001', 'B0TEST0002'])

  const wildcard = queryAsinPage(db, { tag: '%' })
  assert.equal(wildcard.total, 0)
  assert.equal(wildcard.items.length, 0)
})

test('重点关注：标记后可筛选，且重新导入不会清掉用户标记', () => {
  const db = openMemoryDb()
  seed(db)
  assert.equal(setAsinWatch(db, 'B0TEST0002', true), true)
  assert.equal(queryAsinPage(db, { watch: 'watch' }).total, 1)
  assert.equal(queryAsinPage(db, { watch: 'normal' }).total, 2)
  assert.equal(asinFacets(db).watched, 1)

  // 重新导入同一批（导入里 watch 缺省 = 未关注）不得覆盖既有标记
  seed(db)
  assert.equal(queryAsinPage(db, { watch: 'watch' }).total, 1)
  assert.equal(asinFacets(db).watched, 1)
})

test('排序：价格升序、白名单外的字段退化为默认且不抛错', () => {
  const db = openMemoryDb()
  seed(db)
  const ascending = queryAsinPage(db, { sort: 'price', order: 'asc' }).items
    .map((item) => item.price)
    .filter((price) => price !== null)
  assert.deepEqual(ascending, [...ascending].sort((a, b) => a - b))

  const injected = queryAsinPage(db, { sort: 'price; DROP TABLE asin_products', order: 'asc' })
  assert.equal(injected.total, 3)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='asin_products'").get().n, 1)
})

test('分页：size 生效、total 是过滤后的总数而不是当页条数', () => {
  const db = openMemoryDb()
  seed(db)
  const first = queryAsinPage(db, { limit: 2, offset: 0 })
  const second = queryAsinPage(db, { limit: 2, offset: 2 })
  assert.equal(first.items.length, 2)
  assert.equal(second.items.length, 1)
  assert.equal(first.total, 3)
  assert.equal(second.total, 3)
  assert.notEqual(first.items[0].asin, second.items[0].asin)
})

test('facet：标签按命中数聚合，分类与店铺仍可用', () => {
  const db = openMemoryDb()
  seed(db)
  const facets = asinFacets(db)
  assert.equal(facets.total, 3)
  const tags = new Map(facets.tags.map((facet) => [facet.value, facet.count]))
  assert.equal(tags.get('主打'), 2)
  assert.equal(tags.get('待验证'), 1)
  assert.ok(facets.categories.some((facet) => facet.value === '焊枪'))
  assert.ok(facets.shops.some((facet) => facet.value === 'YOBEL 官方店'))
})
