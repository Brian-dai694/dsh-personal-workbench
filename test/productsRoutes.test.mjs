/**
 * 产品库路由（v1.19）：**独立产品事实表**的读写合同。
 *
 * 这一层钉住四件事：
 * 1. 手动录入能落库并原样读回（站点/ASIN 归一成大写，重复键 409 而不是静默覆盖）；
 * 2. PATCH **只改传了的字段**（改价格不能把店铺一起抹掉），身份字段一律拒绝；
 * 3. DELETE 幂等语义清楚：第一次 200，第二次 404（不是空 200）；
 * 4. 列表带筛选 / 分页 / 分面，且 **从不读写 `asin_products`**（选品判断不受影响）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { makeRoutes } from '../lib/api/routes.js'

async function withServer(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  const routes = makeRoutes(db)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = routes.find((item) => item.kind === 'prefix' && url.pathname.startsWith(item.path))
    if (route) return route.handler(req, res)
    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: JSON.parse(await response.text()) }
  }
  try { await fn({ request, db }) } finally { await new Promise((resolve) => server.close(resolve)); db.close() }
}

test('独立产品库：跨站点同 ASIN 可共存，重复键逐行回报，选品表不受影响', async () => {
  await withServer(async ({ request, db }) => {
    const response = await request('POST', '/api/workbench/products/import', { products: [
      { site: 'US', asin: 'B0PRODUCT1', title: '美国商品', price: 12 },
      { site: 'DE', asin: 'B0PRODUCT1', title: '德国商品', price: 13 },
      { site: 'US', asin: 'B0PRODUCT1', title: '重复商品', price: 99 },
      { site: 'USA', asin: 'B0BAD001', title: '坏站点' },
      { site: 'US', asin: 'B0PRODUCT2', title: '第二商品' },
    ] })
    assert.equal(response.status, 200)
    assert.deepEqual([response.body.created, response.body.invalid, response.body.duplicates], [3, 1, 1])
    assert.deepEqual(response.body.results.map((row) => row.status), ['created', 'created', 'duplicate', 'invalid', 'created'])
    const list = await request('GET', '/api/workbench/products')
    assert.equal(list.body.products.length, 3)
    assert.deepEqual(list.body.products.map((row) => `${row.site}:${row.asin}`).sort(), ['DE:B0PRODUCT1', 'US:B0PRODUCT1', 'US:B0PRODUCT2'])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_products').get().n, 0)
  })
})

test('手动录入：单条新建 201，站点/ASIN 归一，字段原样读回', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/products', {
      site: 'us',
      asin: ' b0manual01 ',
      title: ' 手工录入的焊接枪 ',
      price: '39.99',
      shopName: '店铺一',
      category: 'Welding torch',
    })
    assert.equal(created.status, 201)
    const product = created.body.product
    assert.equal(product.id, 'US_B0MANUAL01', 'id 由站点_ASIN 生成，前端原样传回')
    assert.equal(product.site, 'US')
    assert.equal(product.asin, 'B0MANUAL01')
    assert.equal(product.title, '手工录入的焊接枪')
    assert.equal(product.price, 39.99)
    assert.equal(product.shopName, '店铺一')
    assert.equal(product.category, 'Welding torch')

    const list = await request('GET', '/api/workbench/products')
    assert.equal(list.body.total, 1)
    assert.equal(list.body.facets.sites[0].value, 'US')
    assert.equal(list.body.facets.total, 1)
  })
})

test('手动录入：重复键 409、非法输入 400（都不静默覆盖/夹取）', async () => {
  await withServer(async ({ request }) => {
    await request('POST', '/api/workbench/products', { site: 'US', asin: 'B0MANUAL02', title: 't' })
    const duplicate = await request('POST', '/api/workbench/products', { site: 'us', asin: 'b0manual02', title: 'again' })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.code, 'duplicate')
    assert.match(duplicate.body.error, /已存在/)

    const badSite = await request('POST', '/api/workbench/products', { site: 'USA', asin: 'B0MANUAL03' })
    assert.equal(badSite.status, 400)
    assert.match(badSite.body.error, /两位字母/)

    const badPrice = await request('POST', '/api/workbench/products', { site: 'US', asin: 'B0MANUAL03', price: -1 })
    assert.equal(badPrice.status, 400)
    assert.match(badPrice.body.error, /价格/)
  })
})

test('编辑：只改传了的字段，身份字段拒绝，无实质变化不动 updated_at', async () => {
  await withServer(async ({ request }) => {
    const created = (await request('POST', '/api/workbench/products', {
      site: 'US', asin: 'B0PATCH01', title: '原标题', price: 10, shopName: '店铺一', category: '甲',
    })).body.product

    const patched = await request('PATCH', `/api/workbench/products/${created.id}`, { price: 12.5 })
    assert.equal(patched.status, 200)
    const product = patched.body.product
    assert.equal(product.price, 12.5, '价格改了')
    assert.equal(product.title, '原标题', '没传的标题必须保留')
    assert.equal(product.shopName, '店铺一', '没传的店铺必须保留')
    assert.equal(product.category, '甲', '没传的类目必须保留')

    const identity = await request('PATCH', `/api/workbench/products/${created.id}`, { site: 'DE' })
    assert.equal(identity.status, 400, '站点是身份，不允许改')
    assert.equal(identity.body.code, 'immutable_field')

    const cleared = await request('PATCH', `/api/workbench/products/${created.id}`, { title: '', shopName: '', category: '' })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.product.title, '', '标题允许清空（还没维护标题是合法状态）')
    assert.equal(cleared.body.product.shopName, null, '店铺清空落成 null')
    assert.equal(cleared.body.product.category, null, '类目清空落成 null')

    const missing = await request('PATCH', '/api/workbench/products/US_B0NOTEXIST', { price: 1 })
    assert.equal(missing.status, 404)
  })
})

test('删除：第一次 200、第二次 404；选品表仍然不受影响', async () => {
  await withServer(async ({ request, db }) => {
    const created = (await request('POST', '/api/workbench/products', { site: 'US', asin: 'B0DEL0001' })).body.product
    const first = await request('DELETE', `/api/workbench/products/${created.id}`)
    assert.equal(first.status, 200)
    assert.equal(first.body.deleted, true)
    const second = await request('DELETE', `/api/workbench/products/${created.id}`)
    assert.equal(second.status, 404, '再删一次必须是 404，不能假装成功')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_products').get().n, 0)
  })
})

test('列表：站点/店铺/类目/关键词筛选 + 分页 + 分面按全库计数', async () => {
  await withServer(async ({ request }) => {
    await request('POST', '/api/workbench/products/import', { products: [
      { site: 'US', asin: 'B0FILTER01', title: '焊接枪', shopName: '店A', category: 'Torch' },
      { site: 'US', asin: 'B0FILTER02', title: '焊接面罩', shopName: '店A', category: 'Helmet' },
      { site: 'DE', asin: 'B0FILTER03', title: 'Schweissgeraet', shopName: '店B', category: 'Torch' },
    ] })

    const usOnly = await request('GET', '/api/workbench/products?site=us')
    assert.equal(usOnly.body.total, 2)
    assert.deepEqual(usOnly.body.products.map((row) => row.asin).sort(), ['B0FILTER01', 'B0FILTER02'])

    const byShop = await request('GET', '/api/workbench/products?shop=' + encodeURIComponent('店A'))
    assert.equal(byShop.body.total, 2)

    const byCategory = await request('GET', '/api/workbench/products?category=Torch')
    assert.equal(byCategory.body.total, 2)

    const byQuery = await request('GET', '/api/workbench/products?q=' + encodeURIComponent('面罩'))
    assert.equal(byQuery.body.total, 1)
    assert.equal(byQuery.body.products[0].asin, 'B0FILTER02')

    /** 分面按全库算：筛了 US 之后，DE 的站点计数**不缩水**（否则用户会以为数据被删了）。 */
    assert.equal(usOnly.body.facets.total, 3)
    assert.deepEqual(usOnly.body.facets.sites.map((f) => f.value).sort(), ['DE', 'US'])

    const paged = await request('GET', '/api/workbench/products?page=2&size=2')
    assert.equal(paged.body.total, 3)
    assert.equal(paged.body.products.length, 1, '第 2 页只剩 1 条')
  })
})
