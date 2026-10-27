/**
 * 库存快照路由（migration 31）：`/api/workbench/inventory`
 *
 * - `GET  /`      最近一次盘点 + 历史列表（不含整份行数据）
 * - `POST /`      写入一次盘点（行由界面解析后提交）
 * - `GET  /:id`   读整份（行数据）
 * - `DELETE /:id` 删除
 *
 * 只存输入、不存结论：可售天数与断货日由界面按"今天 + 到货天数"现算。
 *
 * 响应信封（2026-10-27，决策 2）：一律走 `apiOk` / `apiError`。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import type { InventoryRow } from '../../shared/inventoryForecast.js'
import {
  createInventorySnapshot, deleteInventorySnapshot, getInventorySnapshot, getLatestInventorySnapshot, listInventorySnapshots,
} from '../../db/repo.js'
import { INVENTORY_PREFIX as PREFIX, apiError, apiOk, isLoopbackRequest, pathSegments, readJsonBody } from './helpers.js'



function readRow(value: unknown): InventoryRow | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const num = (input: unknown): number | null => typeof input === 'number' && Number.isFinite(input) ? input : null
  const sku = typeof raw.sku === 'string' ? raw.sku.trim() : ''
  const onHandStart = num(raw.onHandStart)
  const arrivals = num(raw.arrivals)
  const sold = num(raw.sold)
  if (sku === '' || onHandStart === null || arrivals === null || sold === null) return null
  return {
    sku,
    asin: typeof raw.asin === 'string' && raw.asin.trim() !== '' ? raw.asin.trim() : null,
    onHandStart,
    arrivals,
    sold,
    inboundPlanned: num(raw.inboundPlanned) ?? 0,
    dailyTarget: num(raw.dailyTarget),
  }
}
export function makeInventoryRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, PREFIX)
        const method = req.method ?? 'GET'

        if (segments.length === 0) {
          if (method === 'GET') {
            return apiOk(res, {
              latest: getLatestInventorySnapshot(db) ?? null,
              snapshots: listInventorySnapshots(db),
            })
          }
          if (method === 'POST') {
            const body = await readJsonBody(req, 2 * 1024 * 1024)
            if (body === undefined) return apiError(res, 400, 'invalid JSON body')
            const rows = Array.isArray(body.rows) ? body.rows.map(readRow) : []
            const valid = rows.filter((row): row is InventoryRow => row !== null)
            if (Array.isArray(body.rows) && valid.length !== body.rows.length) {
              return apiError(res, 400, 'rows 中存在不合法的行（SKU 为空或数字字段非法）')
            }
            try {
              const snapshot = createInventorySnapshot(db, {
                title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title : '库存盘点',
                countedAt: typeof body.countedAt === 'string' ? body.countedAt : '',
                windowDays: typeof body.windowDays === 'number' ? body.windowDays : 0,
                leadTimeDays: typeof body.leadTimeDays === 'number' ? body.leadTimeDays : 0,
                safetyDays: typeof body.safetyDays === 'number' ? body.safetyDays : 0,
                rows: valid,
              })
              /** 创建资源 → 201（语义正确，不为"统一"退回 200）。 */
              return apiOk(res, { snapshot, snapshots: listInventorySnapshots(db) }, 201)
            } catch (error) {
              return apiError(res, 400, error instanceof Error ? error.message : String(error))
            }
          }
          return apiError(res, 405, 'method not allowed')
        }

        const id = segments[0]!
        if (method === 'GET' && segments.length === 1) {
          const snapshot = getInventorySnapshot(db, id)
          return snapshot === undefined ? apiError(res, 404, 'snapshot not found') : apiOk(res, { snapshot })
        }
        if (method === 'DELETE' && segments.length === 1) {
          return deleteInventorySnapshot(db, id)
            ? apiOk(res)
            : apiError(res, 404, 'snapshot not found')
        }
        return apiError(res, 405, 'method not allowed')
      },
    },
  ]
}
