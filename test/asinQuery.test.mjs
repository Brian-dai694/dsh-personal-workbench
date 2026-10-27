import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { queryAsinPage, setAsinWatch, asinFacets, importAsinProducts } from '../lib/db/repo.js'

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-asin-query-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try { run(db) } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

function product(asin, overrides = {}) {
  return {
    asin, site: 'US', title: `Title ${asin}`, currentTitle: null, imageUrl: null, url: null,
    price: null, currency: 'USD', rating: null, reviews: null, bsr: null, brand: null,
    seller: null, shopId: null, shopName: null, category: null, note: null, tags: [],
    extraJson: '{}', addedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

test('ASIN query paginates, filters by tag/watch, and uses allowlisted sort keys', () => withDb((db) => {
  const products = [
    product('B000000001', { price: 20, rating: 4.3, tags: ['torch', 'popular'], addedAt: '2026-10-03T00:00:00.000Z' }),
    product('B000000002', { price: 10, rating: 4.8, tags: ['torch'], addedAt: '2026-10-02T00:00:00.000Z' }),
    product('B000000003', { price: 30, rating: 3.9, tags: ['cable'], addedAt: '2026-10-01T00:00:00.000Z' }),
  ]
  importAsinProducts(db, products, [], 0, null)
  assert.deepEqual(queryAsinPage(db, { sort: 'price', order: 'asc', limit: 2, offset: 0 }).items.map(x => x.price), [10, 20])
  assert.deepEqual(queryAsinPage(db, { sort: 'price', order: 'asc', limit: 2, offset: 2 }).items.map(x => x.price), [30])
  assert.equal(queryAsinPage(db, { sort: 'price', order: 'asc', limit: 2, offset: 2 }).total, 3)
  assert.deepEqual(queryAsinPage(db, { tag: 'torch' }).items.map(x => x.asin).sort(), ['B000000001', 'B000000002'])
  setAsinWatch(db, 'B000000002', true)
  assert.deepEqual(queryAsinPage(db, { watch: 'watch' }).items.map(x => x.asin), ['B000000002'])
  assert.deepEqual(queryAsinPage(db, { watch: 'normal' }).items.map(x => x.asin).sort(), ['B000000001', 'B000000003'])
  assert.deepEqual(queryAsinPage(db, { sort: 'price; DROP TABLE asin_products', order: 'asc' }).items.map(x => x.price), [10, 30, 20])
}))

test('ASIN facets count tag memberships and watched items', () => withDb((db) => {
  importAsinProducts(db, [
    product('B000000011', { tags: ['torch', 'kit'] }),
    product('B000000012', { tags: ['torch'] }),
  ], [], 0, null)
  setAsinWatch(db, 'B000000012', true)
  const facets = asinFacets(db)
  assert.equal(facets.total, 2)
  assert.equal(facets.watched, 1)
  assert.deepEqual(facets.tags, [{ value: 'torch', count: 2 }, { value: 'kit', count: 1 }])
}))

test('reimport does not clear an existing manual watch flag', () => withDb((db) => {
  importAsinProducts(db, [product('B000000021')], [], 0, null)
  setAsinWatch(db, 'B000000021', true)
  importAsinProducts(db, [product('B000000021', { title: 'Updated title', watch: false })], [], 0, null)
  const result = queryAsinPage(db, { watch: 'watch' })
  assert.equal(result.total, 1)
  assert.equal(result.items[0].title, 'Updated title')
}))
