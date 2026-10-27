/**
 * 库存快照仓储（migration 31）：只存**盘点输入**，不存算出来的结论。
 *
 * 理由：可售天数/断货日依赖「今天」与到货天数，存结论隔天就是错的；
 * 存输入，界面每次打开按当时参数重算（与库存技能"数据时效"硬门同一条纪律）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { InventoryRow } from '../../shared/inventoryForecast.js'

export interface InventorySnapshot {
  id: string
  title: string
  countedAt: string
  windowDays: number
  leadTimeDays: number
  safetyDays: number
  rows: InventoryRow[]
  createdAt: string
}

export interface InventorySnapshotSummary {
  id: string
  title: string
  countedAt: string
  windowDays: number
  rowCount: number
  createdAt: string
}

interface RawRow {
  id: string
  title: string
  counted_at: string
  window_days: number
  lead_time_days: number
  safety_days: number
  rows_json: string
  created_at: string
}

function parseRows(json: string): InventoryRow[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is InventoryRow => typeof item === 'object' && item !== null
      && typeof (item as InventoryRow).sku === 'string' && (item as InventoryRow).sku !== '')
  } catch { return [] }
}

function toSnapshot(raw: RawRow): InventorySnapshot {
  return {
    id: raw.id,
    title: raw.title,
    countedAt: raw.counted_at,
    windowDays: Number(raw.window_days),
    leadTimeDays: Number(raw.lead_time_days),
    safetyDays: Number(raw.safety_days),
    rows: parseRows(raw.rows_json),
    createdAt: raw.created_at,
  }
}

export interface CreateInventorySnapshotInput {
  title: string
  countedAt: string
  windowDays: number
  leadTimeDays?: number
  safetyDays?: number
  rows: InventoryRow[]
}

/** 写入一次盘点；参数越界直接拒绝（不让"统计期 0 天"这种输入算出无穷大的可售天数）。 */
export function createInventorySnapshot(db: DatabaseSync, input: CreateInventorySnapshotInput): InventorySnapshot {
  if (input.title.trim() === '') throw new Error('title is required')
  if (input.rows.length === 0) throw new Error('rows must not be empty')
  if (!Number.isInteger(input.windowDays) || input.windowDays <= 0 || input.windowDays > 365) {
    throw new Error('windowDays 必须是 1–365 的整数')
  }
  const counted = Date.parse(input.countedAt)
  if (!Number.isFinite(counted)) throw new Error('countedAt 必须是合法日期')
  const lead = input.leadTimeDays ?? 0
  const safety = input.safetyDays ?? 0
  if (!Number.isInteger(lead) || lead < 0 || lead > 365) throw new Error('leadTimeDays 必须是 0–365 的整数')
  if (!Number.isInteger(safety) || safety < 0 || safety > 365) throw new Error('safetyDays 必须是 0–365 的整数')
  const id = randomUUID()
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO inventory_snapshots (id, title, counted_at, window_days, lead_time_days, safety_days, rows_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.title.trim(), new Date(counted).toISOString(), input.windowDays, lead, safety, JSON.stringify(input.rows), at)
  const created = getInventorySnapshot(db, id)
  if (created === undefined) throw new Error('snapshot insert failed')
  return created
}

export function getInventorySnapshot(db: DatabaseSync, id: string): InventorySnapshot | undefined {
  const raw = db.prepare('SELECT * FROM inventory_snapshots WHERE id = ?').get(id) as RawRow | undefined
  return raw === undefined ? undefined : toSnapshot(raw)
}

/** 最近一次盘点（看板默认读它）。排序带 rowid，同毫秒导入两份时也有确定顺序。 */
export function getLatestInventorySnapshot(db: DatabaseSync): InventorySnapshot | undefined {
  const raw = db.prepare('SELECT * FROM inventory_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as RawRow | undefined
  return raw === undefined ? undefined : toSnapshot(raw)
}

export function listInventorySnapshots(db: DatabaseSync): InventorySnapshotSummary[] {
  const rows = db.prepare('SELECT * FROM inventory_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 50').all() as unknown as RawRow[]
  return rows.map((raw) => ({
    id: raw.id,
    title: raw.title,
    countedAt: raw.counted_at,
    windowDays: Number(raw.window_days),
    rowCount: parseRows(raw.rows_json).length,
    createdAt: raw.created_at,
  }))
}

export function deleteInventorySnapshot(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM inventory_snapshots WHERE id = ?').run(id).changes) > 0
}
