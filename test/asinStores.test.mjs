/**
 * 选品「店铺库」：列表带**库内现算**的关联商品数、关注、删除（不删商品）。
 *
 * 为什么专门测"现算数"：`asin_stores.products_count` 是导入时的快照，
 * 商品被删/改店铺后不会更新。若界面直接显示快照值，会出现"这家店 12 个商品、
 * 点进去只有 3 个"——用户会判断成筛选坏了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  deleteAsinStore, importAsinProducts, importAsinStores, listAsinStoreSummaries, listAsinStores,
  queryAsinPage, setAsinStoreWatch,
} from '../lib/db/repo.js'

function product(asin, overrides = {}) {
  return {
    asin, site: 'US', title: `标题 ${asin}`, currentTitle: null, imageUrl: null, url: null,
    price: 9.99, currency: 'USD', rating: 4.2, reviews: 10, bsr: 5000, brand: null, seller: null,
    shopId: 'shop-1', shopName: '店铺一', category: null, note: null, tags: [],
    extraJson: '{}', addedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function store(id, overrides = {}) {
  return {
    id, sellerId: 'shop-1', site: 'US', name: '店铺一', url: null, note: null,
    watch: false, lastScannedAt: null, productsCount: 12,
    ...overrides,
  }
}

function withDb(run) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try { return run(db) } finally { db.close() }
}

test('店铺列表：关联商品数按库内现算，快照值单独保留', () => withDb((db) => {
  importAsinStores(db, [store('US_shop-1', { productsCount: 12 })])
  importAsinProducts(db, [
    product('B0STORE001'),
    product('B0STORE002', { shopId: null, shopName: '店铺一' }),
    product('B0STORE003', { shopId: 'other', shopName: '别的店' }),
  ], [], 0, null)
  db.prepare('UPDATE asin_products SET watch = 1 WHERE asin = ?').run('B0STORE001')

  const [row] = listAsinStoreSummaries(db)
  assert.equal(row.name, '店铺一')
  assert.equal(row.linked, 2, '按 shop_id 或 shop_name 任一命中都算这家店的商品')
  assert.equal(row.watched, 1)
  assert.equal(row.productsCount, 12, '脚本快照值要保留，供界面提示不一致')
}))

test('店铺列表：id 与名字命中同一批商品时不重复计数', () => withDb((db) => {
  importAsinStores(db, [store('US_shop-1')])
  importAsinProducts(db, [product('B0STORE011'), product('B0STORE012')], [], 0, null)
  const [row] = listAsinStoreSummaries(db)
  assert.equal(row.linked, 2, '同一批商品不能被 id 和名字各数一遍')
}))

test('店铺关注：只改店铺标记，不影响商品', () => withDb((db) => {
  importAsinStores(db, [store('US_shop-1')])
  importAsinProducts(db, [product('B0STORE021')], [], 0, null)
  assert.equal(setAsinStoreWatch(db, 'US_shop-1', true), true)
  assert.equal(listAsinStores(db)[0].watch, true)
  assert.equal(queryAsinPage(db, { watch: 'watch' }).total, 0, '店铺关注不该把商品标成关注')
  assert.equal(setAsinStoreWatch(db, '不存在', true), false)
}))

test('删店铺只删记录，商品必须留着', () => withDb((db) => {
  importAsinStores(db, [store('US_shop-1')])
  importAsinProducts(db, [product('B0STORE031')], [], 0, null)
  assert.equal(deleteAsinStore(db, 'US_shop-1'), true)
  assert.equal(listAsinStores(db).length, 0)
  assert.equal(queryAsinPage(db, {}).total, 1, '删店铺记录不能连带删商品')
  assert.equal(deleteAsinStore(db, 'US_shop-1'), false, '重复删除返回 false 不抛错')
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
  if (address === null || typeof address === 'string') { server.close(); db.close(); throw new Error('no port') }
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try { await fn({ request, db }) } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('路由：GET /stores 带现算数；关注/删除；列表响应里的 stores 也是同一份形状', async () => {
  await withServer(async ({ request, db }) => {
    importAsinStores(db, [store('US_shop-1', { productsCount: 12 })])
    importAsinProducts(db, [product('B0STORER001'), product('B0STORER002')], [], 0, null)

    const list = await request('GET', '/api/workbench/asin/stores')
    assert.equal(list.status, 200)
    assert.equal(list.body.stores.length, 1)
    assert.equal(list.body.stores[0].linked, 2)
    assert.equal(list.body.stores[0].productsCount, 12)

    // 商品列表响应里的 stores 必须是同一形状（含 linked），否则界面会显示 undefined
    const products = await request('GET', '/api/workbench/asin')
    assert.equal(products.body.stores[0].linked, 2)

    const watched = await request('PATCH', '/api/workbench/asin/stores/US_shop-1/watch', { watch: true })
    assert.equal(watched.status, 200)
    assert.equal(watched.body.watch, true)

    const removed = await request('DELETE', '/api/workbench/asin/stores/US_shop-1')
    assert.equal(removed.status, 200)
    assert.equal((await request('GET', '/api/workbench/asin/stores')).body.stores.length, 0)
    assert.equal((await request('GET', '/api/workbench/asin')).body.total, 2, '删店铺后商品仍在')

    assert.equal((await request('DELETE', '/api/workbench/asin/stores/US_shop-1')).status, 404)
    assert.equal((await request('PATCH', '/api/workbench/asin/stores/US_shop-1/watch', { watch: 'yes' })).status, 400)
  })
})
