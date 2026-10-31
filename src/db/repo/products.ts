/**
 * 产品库仓储（独立产品事实表 `products`，v1.19）。
 *
 * ## 为什么与 `db/repo/asin.ts` 那份选品仓储分开
 *
 * 产品库回答「这个商品是什么」，选品回答「我这次怎么判它」。两者共用一行会逼着
 * 产品库的写通道去碰 `verdict / score / judgment_json`（P3 边界就是防这个），
 * 所以这里**只读写事实列**，不认识任何评估字段。
 *
 * ## 事实字段的可写口径
 *
 * - `site + asin` 是身份，建了就不能改（改它等于换一条记录，应该删了再建）；
 * - 改名 / 改价 / 换店铺 / 换类目是日常动作，走 `updateProduct`；
 * - `updated_at` 只在**事实真的变了**时推进，这样列表按"最近改过"排序才有意义。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface ProductRecord {
  id: string
  site: string
  asin: string
  title: string
  price: number | null
  shopName: string | null
  category: string | null
  createdAt: string
  updatedAt: string
}

export interface ProductFacet { value: string; count: number }

export interface ProductFacets {
  sites: ProductFacet[]
  shops: ProductFacet[]
  categories: ProductFacet[]
  /** 全库总数（不受筛选影响）—— 下拉里的计数只在"全库"口径下才不会越筛越小。 */
  total: number
}

export interface ProductFilter {
  site?: string
  shop?: string
  category?: string
  q?: string
}

export interface ProductPage {
  items: ProductRecord[]
  total: number
  facets: ProductFacets
}

/** 同一 `site + asin` 已经存在（409 用；导入时逐行记 `duplicate`）。 */
export class ProductConflictError extends Error {}

/** PATCH 带了不属于事实字段的键（例如想改站点）—— 400 用，**不静默丢弃**。 */
export class ProductFieldError extends Error {}

/** 单次查询上限：再多就不是"看一眼"的场景，应该缩小筛选或走导出。 */
export const MAX_PRODUCT_PAGE_SIZE = 500
export const DEFAULT_PRODUCT_PAGE_SIZE = 50

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`)
  const result = value.trim()
  if (result.length === 0) throw new Error(`${field}不能为空`)
  if (result.length > max) throw new Error(`${field}不超过 ${max} 个字符`)
  return result
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`)
  const result = value.trim()
  if (result.length > max) throw new Error(`${field}不超过 ${max} 个字符`)
  return result || null
}

function optionalPrice(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(result) || result < 0 || result > 10_000_000) throw new Error('价格必须是 0 至 10000000 的数字')
  return result
}

function normalize(input: Record<string, unknown>) {
  /**
   * 站点单独校验（不套 `text(..., 2)`）：先按"两位字母"判，而不是先撞"不超过 2 个字符" ——
   * 用户填了 `USA` 应该看到"必须是两位字母"，看到"不超过 2 个字符"会以为是长度限制。
   */
  if (typeof input.site !== 'string') throw new Error('站点必须是文本')
  const site = input.site.trim().toUpperCase()
  if (site.length === 0) throw new Error('站点不能为空')
  if (!/^[A-Z]{2}$/.test(site)) throw new Error('站点必须是两位字母代码，例如 US / UK / DE')
  const asin = text(input.asin, 'ASIN', 20).toUpperCase()
  if (!/^[A-Z0-9-]{5,20}$/.test(asin)) throw new Error('ASIN 格式无效')
  return { site, asin, title: optionalText(input.title, '标题', 300) ?? '', price: optionalPrice(input.price), shopName: optionalText(input.shopName, '店铺', 120), category: optionalText(input.category, '分类', 120) }
}

function rowOf(row: Record<string, unknown>): ProductRecord {
  return { id: String(row.id), site: String(row.site), asin: String(row.asin), title: String(row.title), price: row.price === null ? null : Number(row.price), shopName: row.shop_name === null ? null : String(row.shop_name), category: row.category === null ? null : String(row.category), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

export function createProduct(db: DatabaseSync, input: Record<string, unknown>, now = new Date().toISOString()): ProductRecord {
  const value = normalize(input)
  if (db.prepare('SELECT 1 FROM products WHERE site = ? AND asin = ?').get(value.site, value.asin) !== undefined) throw new ProductConflictError(`${value.site} / ${value.asin} 已存在`)
  const id = `${value.site}_${value.asin}`
  db.prepare('INSERT INTO products (id, site, asin, title, price, shop_name, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, value.site, value.asin, value.title, value.price, value.shopName, value.category, now, now)
  return getProduct(db, value.site, value.asin)!
}

export function getProduct(db: DatabaseSync, site: string, asin: string): ProductRecord | undefined {
  const row = db.prepare('SELECT * FROM products WHERE site = ? AND asin = ?').get(site.toUpperCase(), asin.toUpperCase()) as Record<string, unknown> | undefined
  return row === undefined ? undefined : rowOf(row)
}

export function getProductById(db: DatabaseSync, id: string): ProductRecord | undefined {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row === undefined ? undefined : rowOf(row)
}

function whereOf(filter: ProductFilter): { clause: string; params: string[] } {
  const where: string[] = []
  const params: string[] = []
  if (filter.site !== undefined && filter.site !== '') { where.push('site = ?'); params.push(filter.site.toUpperCase()) }
  if (filter.shop !== undefined && filter.shop !== '') { where.push('shop_name = ?'); params.push(filter.shop) }
  if (filter.category !== undefined && filter.category !== '') { where.push('category = ?'); params.push(filter.category) }
  if (filter.q !== undefined && filter.q !== '') { where.push('(asin LIKE ? OR title LIKE ?)'); params.push(`%${filter.q}%`, `%${filter.q}%`) }
  return { clause: where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`, params }
}

/** 当前筛选的**全部**结果（不分页，给导出用；视图只显示一页）。 */
export function listProducts(db: DatabaseSync, filter: ProductFilter = {}): ProductRecord[] {
  const { clause, params } = whereOf(filter)
  const rows = db.prepare(`SELECT * FROM products${clause} ORDER BY updated_at DESC, site ASC, asin ASC`).all(...params) as unknown as Array<Record<string, unknown>>
  return rows.map(rowOf)
}

function facet(db: DatabaseSync, column: 'site' | 'shop_name' | 'category'): ProductFacet[] {
  return db.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM products WHERE ${column} IS NOT NULL AND ${column} != '' GROUP BY ${column} ORDER BY count DESC, value ASC`).all() as unknown as ProductFacet[]
}

/**
 * 分面计数一律按**全库**算（与选品页 `asinFacets` 同一口径）。
 *
 * 为什么不按"其它筛选项"过滤后再计数：那样同一个下拉在每次筛选后计数都在变，
 * 用户会以为数据被删了。全库口径下计数恒定，只表示"这一项有多少条"。
 */
export function productFacets(db: DatabaseSync): ProductFacets {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as unknown as { n: number }).n
  return { sites: facet(db, 'site'), shops: facet(db, 'shop_name'), categories: facet(db, 'category'), total }
}

export function queryProductPage(db: DatabaseSync, filter: ProductFilter = {}, page = 1, size = DEFAULT_PRODUCT_PAGE_SIZE): ProductPage {
  const safeSize = Math.min(Math.max(1, Math.floor(Number.isFinite(size) ? size : DEFAULT_PRODUCT_PAGE_SIZE)), MAX_PRODUCT_PAGE_SIZE)
  const safePage = Math.max(1, Math.floor(Number.isFinite(page) ? page : 1))
  const { clause, params } = whereOf(filter)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM products${clause}`).get(...params) as unknown as { n: number }).n
  const rows = db.prepare(`SELECT * FROM products${clause} ORDER BY updated_at DESC, site ASC, asin ASC LIMIT ? OFFSET ?`).all(...params, safeSize, (safePage - 1) * safeSize) as unknown as Array<Record<string, unknown>>
  return { items: rows.map(rowOf), total, facets: productFacets(db) }
}

export interface ProductPatch {
  title?: unknown
  price?: unknown
  shopName?: unknown
  category?: unknown
}

/** PATCH 允许的键：事实字段里**除身份外**的四项。 */
const PATCHABLE = new Set(['title', 'price', 'shopName', 'category'])

/**
 * 只改传入的字段（浅合并）。
 *
 * - 身份（`site` / `asin`）出现在请求里**直接报错**：它不是"改一改"的字段，
 *   静默忽略会让人以为改成功了；
 * - `title` 允许改成空串（还没维护标题是合法状态），其余空串即清空（存 `null`）。
 */
export function updateProduct(db: DatabaseSync, id: string, patch: ProductPatch, now = new Date().toISOString()): ProductRecord | undefined {
  const existing = getProductById(db, id)
  if (existing === undefined) return undefined
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE.has(key)) throw new ProductFieldError(`不能修改 ${key}：站点与 ASIN 是产品身份，要换请删除后重新录入`)
  }
  const title = patch.title === undefined ? existing.title : (optionalText(patch.title, '标题', 300) ?? '')
  const price = patch.price === undefined ? existing.price : optionalPrice(patch.price)
  const shopName = patch.shopName === undefined ? existing.shopName : optionalText(patch.shopName, '店铺', 120)
  const category = patch.category === undefined ? existing.category : optionalText(patch.category, '分类', 120)
  const changed = title !== existing.title || price !== existing.price || shopName !== existing.shopName || category !== existing.category
  /** 没有实质变化就不推进 `updated_at`：否则点一次"保存"就把列表顺序打乱。 */
  if (changed) db.prepare('UPDATE products SET title = ?, price = ?, shop_name = ?, category = ?, updated_at = ? WHERE id = ?').run(title, price, shopName, category, now, id)
  return getProductById(db, id)
}

export function deleteProduct(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM products WHERE id = ?').run(id).changes > 0
}
