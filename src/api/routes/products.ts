/**
 * 产品库路由（v1.19）：独立的「产品事实」读写通道。
 *
 * ## 与选品路由的关系
 *
 * `/api/workbench/asin/*` 读写 `asin_products`（含判断字段）；这里是 `/api/workbench/products`，
 * 只碰 `products` 表。两条通道**互不写入**，这样产品库的写权限不可能顺手改到判断结论。
 *
 * ## 端点
 *
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | GET | `/products` | 列表（`site/shop/category/q/page/size`）+ 分面 |
 * | POST | `/products` | **手动录入**一条（重复键 409） |
 * | POST | `/products/import` | 批量导入（逐行回报 created/duplicate/invalid） |
 * | PATCH | `/products/:id` | 改事实字段（身份不可改） |
 * | DELETE | `/products/:id` | 删除一条 |
 *
 * `:id` 是 `站点_ASIN`（例如 `US_B0XXXXXXXX`）—— 由仓储生成，前端原样传回即可。
 * 用 id 而不是 `site+asin` 两个参数：少一次"站点与 ASIN 不匹配"的分支。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  createProduct, deleteProduct, getProductById, ProductConflictError, ProductFieldError,
  queryProductPage, updateProduct, DEFAULT_PRODUCT_PAGE_SIZE,
} from '../../db/repo/products.js'
import { apiError, apiOk, isLoopbackRequest, readJsonBody } from './helpers.js'

export const PRODUCTS_PREFIX = '/api/workbench/products'

const IMPORT_PATH = `${PRODUCTS_PREFIX}/import`
const MAX_IMPORT_ROWS = 2000

function optionalParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null || value.trim() === '' ? undefined : value.trim()
}

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 路径里的 id（已去前缀）；不是单条路径时返回 `''`。 */
function pathId(pathname: string): string {
  if (!pathname.startsWith(`${PRODUCTS_PREFIX}/`)) return ''
  const rest = pathname.slice(PRODUCTS_PREFIX.length + 1)
  if (rest === '' || rest.includes('/')) return ''
  try { return decodeURIComponent(rest) } catch { return '' }
}

export function makeProductRoutes(db: DatabaseSync): WebRoute[] {
  return [{
    kind: 'prefix',
    path: PRODUCTS_PREFIX,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname

      if (req.method === 'GET' && pathname === PRODUCTS_PREFIX) {
        const page = queryProductPage(
          db,
          { site: optionalParam(url, 'site'), shop: optionalParam(url, 'shop'), category: optionalParam(url, 'category'), q: optionalParam(url, 'q') },
          numberParam(url, 'page', 1),
          numberParam(url, 'size', DEFAULT_PRODUCT_PAGE_SIZE),
        )
        return apiOk(res, { products: page.items, total: page.total, facets: page.facets })
      }

      if (req.method === 'POST' && pathname === IMPORT_PATH) {
        const body = await readJsonBody(req, 4 * 1024 * 1024)
        if (body === undefined) return apiError(res, 413, '导入内容过大或不是合法 JSON（上限 4MB）')
        const rows = body.products
        if (!Array.isArray(rows) || rows.length === 0) return apiError(res, 400, 'products 必须是非空数组')
        if (rows.length > MAX_IMPORT_ROWS) return apiError(res, 400, `一次最多导入 ${MAX_IMPORT_ROWS} 行`)
        const results: Array<Record<string, unknown>> = []
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]
          if (row === null || typeof row !== 'object' || Array.isArray(row)) { results.push({ index, status: 'invalid', error: '产品行必须是对象' }); continue }
          try {
            const product = createProduct(db, row as Record<string, unknown>)
            results.push({ index, status: 'created', product })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            results.push({ index, status: error instanceof ProductConflictError ? 'duplicate' : 'invalid', error: message })
          }
        }
        const created = results.filter((r) => r.status === 'created').length
        const duplicates = results.filter((r) => r.status === 'duplicate').length
        return apiOk(res, { created, invalid: results.length - created - duplicates, duplicates, results })
      }

      if (req.method === 'POST' && pathname === PRODUCTS_PREFIX) {
        const body = await readJsonBody(req)
        if (body === undefined) return apiError(res, 413, '录入内容过大或不是合法 JSON')
        try {
          return apiOk(res, { product: createProduct(db, body) }, 201)
        } catch (error) {
          if (error instanceof ProductConflictError) return apiError(res, 409, error.message, { code: 'duplicate' })
          return apiError(res, 400, error instanceof Error ? error.message : String(error))
        }
      }

      const id = pathId(pathname)
      if (id !== '' && req.method === 'PATCH') {
        const body = await readJsonBody(req)
        if (body === undefined) return apiError(res, 413, '修改内容过大或不是合法 JSON')
        try {
          const product = updateProduct(db, id, body)
          if (product === undefined) return apiError(res, 404, '产品不存在（可能已被删除，刷新列表试试）')
          return apiOk(res, { product })
        } catch (error) {
          if (error instanceof ProductFieldError) return apiError(res, 400, error.message, { code: 'immutable_field' })
          return apiError(res, 400, error instanceof Error ? error.message : String(error))
        }
      }

      if (id !== '' && req.method === 'DELETE') {
        /**
         * 删除**不级联**到选品判断（两张表本来就无关）。这里显式返回 deleted，
         * 而不是空 200：前端要据此区分"删掉了"与"早就不在"。
         */
        if (getProductById(db, id) === undefined) return apiError(res, 404, '产品不存在（可能已被删除，刷新列表试试）')
        return apiOk(res, { deleted: deleteProduct(db, id) })
      }

      return apiError(res, 404, 'not found')
    },
  }]
}
