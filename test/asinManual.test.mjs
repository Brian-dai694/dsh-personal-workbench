/**
 * 选品库「手工维护」（v1.18）：不依赖旧脚本备份也能建库。
 *
 * 钉住四件事：
 * 1. **新增**能落库并原样读回（含标签、关注、店铺）；
 * 2. **PATCH 只改传了的字段** —— 改价格不能把标签一起抹掉（否则"编辑一次，标签全没"）；
 * 3. 重复 ASIN / 重复店铺 id 是 `AsinConflictError`（路由 409），不是静默覆盖；
 * 4. 校验文案可读且**不静默夹取**（评分 6 → 400，而不是被悄悄改成 5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  AsinConflictError, createAsinProduct, createAsinStore, getAsinProduct, getAsinStore,
  listAsinStoreSummaries, updateAsinProduct, updateAsinStore,
} from '../lib/db/repo.js'

function withDb(run) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try { return run(db) } finally { db.close() }
}

test('手工新增商品：整条字段落库，ASIN 归一为大写', () => withDb((db) => {
  const created = createAsinProduct(db, {
    asin: ' b0manual01 ',
    title: ' 手工录入的焊接枪 ',
    site: 'us',
    shopName: '店铺一',
    shopId: 'shop-1',
    category: 'Welding torch',
    price: '39.99',
    rating: 4.5,
    reviews: '120',
    bsr: 5000,
    tags: ['焊接', '焊接', ' 蓝海 '],
    note: '先观察两周',
    watch: true,
  })
  assert.equal(created.asin, 'B0MANUAL01')
  assert.equal(created.title, '手工录入的焊接枪')
  assert.equal(created.site, 'US')
  assert.equal(created.price, 39.99)
  assert.equal(created.rating, 4.5)
  assert.equal(created.reviews, 120)
  assert.equal(created.bsr, 5000)
  assert.deepEqual(created.tags, ['焊接', '蓝海'], '标签去重且去空白')
  assert.equal(created.watch, true)
  assert.equal(created.judgment.verdict, 'none', '手工录入不代表已判断')
}))

test('手工新增商品：重复 ASIN 抛冲突，非法输入抛可读文案', () => withDb((db) => {
  createAsinProduct(db, { asin: 'B0MANUAL02', title: 't' })
  assert.throws(() => createAsinProduct(db, { asin: 'b0manual02' }), AsinConflictError)
  assert.throws(() => createAsinProduct(db, { asin: 'B0SHORT' }), /10 位字母数字/)
  assert.throws(() => createAsinProduct(db, { asin: 'B0MANUAL03', rating: 6 }), /评分/)
  assert.throws(() => createAsinProduct(db, { asin: 'B0MANUAL03', price: -1 }), /价格/)
  assert.throws(() => createAsinProduct(db, { asin: 'B0MANUAL03', url: 'javascript:alert(1)' }), /http\(s\)/)
  assert.equal(getAsinProduct(db, 'B0MANUAL03'), undefined, '被拒绝的输入不能留下半条记录')
}))

test('编辑商品：只改传了的字段（改价格不能抹掉标签/备注）', () => withDb((db) => {
  createAsinProduct(db, {
    asin: 'B0MANUAL04', title: '原标题', tags: ['A', 'B'], note: '备注留着', price: 10, watch: true,
  })
  const updated = updateAsinProduct(db, 'b0manual04', { price: 11.5 })
  assert.equal(updated.price, 11.5)
  assert.equal(updated.title, '原标题')
  assert.deepEqual(updated.tags, ['A', 'B'])
  assert.equal(updated.note, '备注留着')
  assert.equal(updated.watch, true)

  const cleared = updateAsinProduct(db, 'B0MANUAL04', { price: null, note: null, tags: [] })
  assert.equal(cleared.price, null, 'null = 清空')
  assert.equal(cleared.note, null)
  assert.deepEqual(cleared.tags, [])

  assert.throws(() => updateAsinProduct(db, 'B0MISSING0', { price: 1 }), /asin not found/)
  assert.throws(() => updateAsinProduct(db, 'B0MANUAL04', {}), /没有要更新的字段/)
  assert.throws(() => updateAsinProduct(db, 'B0MANUAL04', { reviews: 1.5 }), /整数/)
}))

test('店铺：新增按 `${site}_${sellerId}` 生成 id；编辑不换 id；重复 id 抛冲突', () => withDb((db) => {
  const created = createAsinStore(db, { name: ' 店铺一 ', sellerId: 'shop-1', site: 'us', note: 'n' })
  assert.equal(created.id, 'US_shop-1')
  assert.equal(created.name, '店铺一')
  assert.equal(created.watch, false)

  const renamed = updateAsinStore(db, 'US_shop-1', { name: '店铺一（改名）', watch: true })
  assert.equal(renamed.id, 'US_shop-1', 'id 是身份，不随改名变化')
  assert.equal(renamed.name, '店铺一（改名）')
  assert.equal(renamed.watch, true)

  assert.throws(() => createAsinStore(db, { name: '重复', sellerId: 'shop-1', site: 'US' }), AsinConflictError)
  assert.throws(() => createAsinStore(db, { name: '   ' }), /不能为空/)
  assert.throws(() => updateAsinStore(db, '不存在', { name: 'x' }), /店铺不存在/)

  const manual = createAsinStore(db, { name: '没有 Seller ID 的店' })
  assert.match(manual.id, /^manual_[0-9a-f]{8}$/, '没有 Seller ID 时用 manual_ 前缀，不拿店名当主键')
  assert.equal(getAsinStore(db, manual.id)?.name, '没有 Seller ID 的店')
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

test('路由：POST 新增 → 409 重复 → PATCH 编辑 → 404 不存在；响应带最新 facets', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/asin', { asin: 'B0ROUTE101', site: 'US', title: '路由新增', price: 12 })
    assert.equal(created.status, 201)
    assert.equal(created.body.ok, true)
    assert.equal(created.body.product.asin, 'B0ROUTE101')
    assert.equal(created.body.facets.total, 1)

    const duplicate = await request('POST', '/api/workbench/asin', { asin: 'B0ROUTE101', site: 'US' })
    assert.equal(duplicate.status, 409)
    assert.match(duplicate.body.error, /已经在选品库里/)

    const patched = await request('PATCH', '/api/workbench/asin/B0ROUTE101?site=US', { price: 13, tags: ['x'] })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.product.price, 13)
    assert.deepEqual(patched.body.product.tags, ['x'])

    assert.equal((await request('PATCH', '/api/workbench/asin/B0NOROUTE0?site=US', { price: 1 })).status, 404)
    assert.equal((await request('POST', '/api/workbench/asin', { asin: 'bad', site: 'US' })).status, 400)
  })
})

test('产品库表格导入：逐行创建，坏行与重复行不影响有效行且不覆盖旧数据', async () => {
  await withServer(async ({ request }) => {
    const first = await request('POST', '/api/workbench/asin/products/import', {
      products: [
        { asin: 'b0batch001', site: 'US', title: '有效商品', price: 12.5 },
        { asin: 'b0batch002', site: 'USA', title: '坏站点' },
        { asin: 'b0batch001', site: 'US', title: '重复商品', price: 99 },
        { asin: 'b0batch003', title: '缺站点' },
      ],
    })
    assert.equal(first.status, 200)
    assert.equal(first.body.created, 1)
    assert.equal(first.body.invalid, 2)
    assert.equal(first.body.duplicates, 1)
    assert.equal(first.body.results.map((row) => row.status).join(','), 'created,invalid,duplicate,invalid')
    assert.equal(first.body.results[0].product.price, 12.5)
    assert.equal((await request('GET', '/api/workbench/asin?site=US')).body.total, 1)

    const second = await request('POST', '/api/workbench/asin/products/import', {
      products: [{ asin: 'b0batch001', site: 'DE', title: '跨站点同 ASIN' }],
    })
    assert.equal(second.status, 200)
    assert.equal(second.body.created, 0, '当前单列 asin 主键不能静默新增跨站点重复')
    assert.equal(second.body.duplicates, 1)
  })
})

test('路由：店铺 POST 新增 → PATCH 编辑；列表里带现算关联商品数', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/asin/stores', { name: '店铺一', sellerId: 'shop-9', site: 'US' })
    assert.equal(created.status, 201)
    assert.equal(created.body.store.id, 'US_shop-9')
    assert.equal(created.body.stores.length, 1)

    await request('POST', '/api/workbench/asin', { asin: 'B0ROUTE201', site: 'US', shopId: 'shop-9', shopName: '店铺一' })
    const list = await request('GET', '/api/workbench/asin/stores')
    assert.equal(list.body.stores[0].linked, 1, '新增的商品要能被店铺的现算数看见')

    const renamed = await request('PATCH', '/api/workbench/asin/stores/US_shop-9', { name: '店铺一（改）' })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.store.name, '店铺一（改）')
    assert.equal(renamed.body.stores[0].linked, 1, '改名后按名字仍能关联到那条商品')

    assert.equal((await request('POST', '/api/workbench/asin/stores', { name: '重复', sellerId: 'shop-9', site: 'US' })).status, 409)
    assert.equal((await request('PATCH', '/api/workbench/asin/stores/不存在', { name: 'x' })).status, 404)
    assert.equal((await request('PATCH', '/api/workbench/asin/stores/US_shop-9', { name: '' })).status, 400)
  })
})

test('空库时店铺汇总为空数组（不是 undefined）', () => withDb((db) => {
  assert.deepEqual(listAsinStoreSummaries(db), [])
}))
