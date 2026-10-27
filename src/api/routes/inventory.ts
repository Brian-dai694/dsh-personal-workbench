/**
 * 库存快照路由（migration 31）：`/api/workbench/inventory`
 *
 * - `GET  /`      最近一次盘点 + 历史列表（不含整份行数据）
 * - `POST /`      写入一次盘点（行由界面解析后提交）
 * - `GET  /:id`   读整份（行数据）
 * - `DELETE /:id` 删除
 *
 * 只存输入、不存结论：可售天数与断货日由界面按"今天 + 到货天数"现算。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import type { InventoryRow } from '../../shared/inventoryForecast.js'
import {
  createInventorySnapshot, deleteInventorySnapshot, getInventorySnapshot, getLatestInventorySnapshot, listInventorySnapshots,
} from '../../db/repo.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './helpers.js'

const PREFIX = '/api/workbench/inventory'

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
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = url.pathname.slice(PREFIX.length).split('/').filter((part) => part !== '')
        const method = req.method ?? 'GET'

        if (segments.length === 0) {
          if (method === 'GET') {
            return writeJson(res, 200, {
              ok: true,
              latest: getLatestInventorySnapshot(db) ?? null,
              snapshots: listInventorySnapshots(db),
            })
          }
          if (method === 'POST') {
            const body = await readJsonBody(req, 2 * 1024 * 1024)
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            const rows = Array.isArray(body.rows) ? body.rows.map(readRow) : []
            const valid = rows.filter((row): row is InventoryRow => row !== null)
            if (Array.isArray(body.rows) && valid.length !== body.rows.length) {
              return writeJson(res, 400, { error: 'rows 中存在不合法的行（SKU 为空或数字字段非法）' })
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
              return writeJson(res, 201, { ok: true, snapshot, snapshots: listInventorySnapshots(db) })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }

        const id = segments[0]!
        if (method === 'GET' && segments.length === 1) {
          const snapshot = getInventorySnapshot(db, id)
          return writeJson(res, snapshot === undefined ? 404 : 200, snapshot === undefined ? { error: 'snapshot not found' } : { ok: true, snapshot })
        }
        if (method === 'DELETE' && segments.length === 1) {
          return deleteInventorySnapshot(db, id)
            ? writeJson(res, 200, { ok: true })
            : writeJson(res, 404, { error: 'snapshot not found' })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
  ]
}
