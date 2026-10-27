/**
 * 选品导入的纯函数测试（逆向自油猴脚本的导出格式）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAsinImport } from '../lib/shared/asinImport.js'

test('normalizeAsinImport：接受 { products: {asin: row} }（脚本的存储形状）', () => {
  const result = normalizeAsinImport({
    ids: ['B0AAA11111'],
    products: {
      B0AAA11111: {
        asin: 'B0AAA11111',
        title: 'TIG 焊枪',
        image: 'https://img/1.jpg',
        url: 'https://amazon.com/dp/B0AAA11111',
        price: 19.99,
        rating: 4.5,
        reviewCount: 1234,
        bsrRank: 5678,
        shopId: 'YOBEL',
        category: '未分类',
        note: '重点',
        tags: ['主打', '待验证'],
        collectedAt: 1791278742984,
      },
    },
  })
  assert.equal(result.products.length, 1)
  const p = result.products[0]
  assert.equal(p.title, 'TIG 焊枪')
  assert.equal(p.imageUrl, 'https://img/1.jpg')
  assert.equal(p.reviews, 1234)
  assert.equal(p.bsr, 5678)
  assert.deepEqual(p.tags, ['主打', '待验证'])
  assert.equal(p.addedAt, '2026-10-06T09:25:42.984Z')
})

test('normalizeAsinImport：价格字符串 $1,299.99 能解析；字段名允许多种叫法', () => {
  const result = normalizeAsinImport([{
    asin: 'b0bbb22222',
    currentTitle: '现标题',
    imageUrl: 'https://img/2.jpg',
    price: '$1,299.99',
    reviews: '88',
    bsr: '12',
  }])
  const p = result.products[0]
  assert.equal(p.asin, 'B0BBB22222', 'ASIN 统一大写')
  assert.equal(p.title, '现标题', '没有 title 时退回 currentTitle')
  assert.equal(p.price, 1299.99)
  assert.equal(p.reviews, 88)
})

test('normalizeAsinImport：只有 ids 也能导入收藏关系', () => {
  const result = normalizeAsinImport({ ids: ['B0CCC33333', 'bad-id'] })
  assert.equal(result.products.length, 1)
  assert.equal(result.rejected, 1)
  assert.ok(result.firstReason !== null)
})

test('normalizeAsinImport：非法 ASIN 记入 rejected，不静默丢', () => {
  const result = normalizeAsinImport([{ asin: 'X' }, { asin: 'B0DDD44444', title: 'ok' }])
  assert.equal(result.products.length, 1)
  assert.equal(result.rejected, 1)
})

test('normalizeAsinImport：产品内的 snapshots 被收集成趋势点', () => {
  const result = normalizeAsinImport([{
    asin: 'B0EEE55555',
    title: 'x',
    snapshots: [
      { time: '2026-10-01T00:00:00Z', price: 20.99, reviews: 10, rating: 4.2, bsr: 300 },
      { time: '2026-10-02T00:00:00Z', price: 19.99, reviews: 12, rating: 4.3, bsr: 280 },
      { time: 'bad', price: 1 },
    ],
  }])
  assert.equal(result.snapshots.length, 2, '坏时间戳被跳过')
  assert.equal(result.snapshots[1].price, 19.99)
  assert.equal(result.snapshots[0].bsrMajor, 300)
})
