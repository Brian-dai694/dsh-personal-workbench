/**
 * 运营日志仓储（2026-10-23 接入第 1 步：只读视图 + 导入）。
 *
 * 只做两件事：读列表、批量导入。写入一律 `INSERT OR REPLACE`（按 id 幂等），
 * 这样同一份导出重复导入不会翻倍；不提供删除/编辑（第 2 步再做）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OplogImportEntry } from '../../shared/oplogImport.js'
import { colorForType, startOfWeek } from '../../shared/oplogView.js'

export interface OplogEntry extends OplogImportEntry {
  /** 置顶：列表排序优先 */
  pinned: boolean
  /** 关联的工作台任务；历史导入记录默认 null。 */
  taskId: string | null
}

export interface OplogTaskOption {
  id: string
  title: string
  statusCode: string
  dueAt: string | null
}

export interface OplogFilter {
  logType?: string
  shopId?: string
  site?: string
  keyword?: string
  /** 业务日期 YYYY-MM-DD（日历跳转用；与日期索引同一表达式）。 */
  logDate?: string
  limit?: number
}

interface RawOplogRow {
  id: string
  log_type: string
  title: string
  content_text: string
  asin_json: string
  images_json: string
  documents_json: string
  shop_id: string | null
  shop_name: string | null
  type_color: string | null
  log_date: string | null
  site: string | null
  created_at: string
  updated_at: string
  pinned: number | null
  task_id: string | null
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function toEntry(row: RawOplogRow): OplogEntry {
  return {
    id: row.id,
    logType: row.log_type,
    title: row.title,
    contentText: row.content_text,
    asins: parseJson<string[]>(row.asin_json, []),
    images: parseJson<OplogEntry['images']>(row.images_json, []),
    documents: parseJson<OplogEntry['documents']>(row.documents_json, []),
    shopId: row.shop_id,
    shopName: row.shop_name,
    typeColor: row.type_color ?? colorForType(row.log_type),
    logDate: row.log_date ?? row.created_at.slice(0, 10),
    site: row.site,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: (row.pinned ?? 0) === 1,
    taskId: row.task_id ?? null,
  }
}

export function listOplogEntries(db: DatabaseSync, filter: OplogFilter = {}): OplogEntry[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.logType !== undefined && filter.logType !== '') { where.push('log_type = ?'); params.push(filter.logType) }
  if (filter.shopId !== undefined && filter.shopId !== '') { where.push('shop_id = ?'); params.push(filter.shopId) }
  if (filter.site !== undefined && filter.site !== '') { where.push('site = ?'); params.push(filter.site) }
  /**
   * 按业务日期筛（日历跳过来的那一天）。
   *
   * 用与 `listOplogDayIndex` **完全相同**的日期表达式：否则会出现
   * 「格子说有 3 条、点进去筛出 2 条」这类自相矛盾的界面。
   */
  if (filter.logDate !== undefined && filter.logDate !== '') {
    where.push("COALESCE(NULLIF(log_date, ''), substr(created_at, 1, 10)) = ?")
    params.push(filter.logDate)
  }
  if (filter.keyword !== undefined && filter.keyword !== '') {
    where.push('(title LIKE ? OR content_text LIKE ?)')
    const like = `%${filter.keyword}%`
    params.push(like, like)
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  const sql = `SELECT * FROM oplog_entries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, created_at DESC LIMIT ?`
  const rows = db.prepare(sql).all(...params, limit) as unknown as RawOplogRow[]
  return rows.map(toEntry)
}

export interface OplogFacets {
  types: Array<{ value: string; count: number }>
  shops: Array<{ value: string; count: number }>
  sites: Array<{ value: string; count: number }>
  total: number
}

/** 筛选器需要的候选值：直接从数据里数，不维护第二份字典。 */
export function oplogFacets(db: DatabaseSync): OplogFacets {
  const count = (column: string): Array<{ value: string; count: number }> =>
    (db.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM oplog_entries WHERE ${column} IS NOT NULL AND ${column} != '' GROUP BY ${column} ORDER BY count DESC`).all() as unknown as Array<{ value: string; count: number }>)
  const total = (db.prepare('SELECT COUNT(*) AS n FROM oplog_entries').get() as unknown as { n: number }).n
  return { types: count('log_type'), shops: count('shop_id'), sites: count('site'), total }
}

export interface OplogImportSummary {
  inserted: number
  skipped: number
  rejected: number
  firstReason: string | null
}

/** 幂等导入：同 id 覆盖，不新增重复行。 */
export function importOplogEntries(
  db: DatabaseSync,
  entries: readonly OplogImportEntry[],
  rejected: number,
  firstReason: string | null,
): OplogImportSummary {
  const stmt = db.prepare(`
    INSERT INTO oplog_entries (id, log_type, title, content_text, asin_json, images_json, documents_json, shop_id, shop_name, site, type_color, log_date, created_at, updated_at, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      log_type = excluded.log_type,
      title = excluded.title,
      content_text = excluded.content_text,
      asin_json = excluded.asin_json,
      images_json = excluded.images_json,
      documents_json = excluded.documents_json,
      shop_id = excluded.shop_id,
      shop_name = excluded.shop_name,
      type_color = excluded.type_color,
      log_date = excluded.log_date,
      site = excluded.site,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `)
  let inserted = 0
  for (const entry of entries) {
    stmt.run(
      entry.id,
      entry.logType,
      entry.title,
      entry.contentText,
      JSON.stringify(entry.asins),
      JSON.stringify(entry.images),
      JSON.stringify(entry.documents),
      entry.shopId,
      entry.shopName,
      entry.site,
      entry.typeColor,
      entry.logDate,
      entry.createdAt,
      entry.updatedAt,
    )
    inserted += 1
  }
  return { inserted, skipped: entries.length - inserted, rejected, firstReason }
}


export interface OplogKpiCounts { week: number; month: number; year: number; total: number }

/** KPI 用 SQL 数（不拉全表）：本周/本月/本年/总计。周起点与 shared/oplogView 同一口径。 */
export function oplogKpiCounts(db: DatabaseSync, now: Date = new Date()): OplogKpiCounts {
  const since = (d: Date): string => d.toISOString()
  const count = (from: string | null): number => {
    if (from === null) return (db.prepare('SELECT COUNT(*) AS n FROM oplog_entries').get() as unknown as { n: number }).n
    return (db.prepare('SELECT COUNT(*) AS n FROM oplog_entries WHERE created_at >= ?').get(from) as unknown as { n: number }).n
  }
  return {
    week: count(since(startOfWeek(now))),
    month: count(since(new Date(now.getFullYear(), now.getMonth(), 1))),
    year: count(since(new Date(now.getFullYear(), 0, 1))),
    total: count(null),
  }
}


export interface OplogDraft {
  title: string
  logType: string
  contentText: string
  shopId: string | null
  site: string | null
  logDate: string
  asins: string[]
  documents: OplogEntry['documents']
  taskId?: string | null
}

function normalizeDraft(draft: OplogDraft, existing: OplogEntry | null): OplogEntry {
  const now = new Date().toISOString()
  return {
    /**
     * 新建日志的 id 必须**真的唯一**。
     *
     * 旧写法是 `时间戳数字 + Math.floor(Math.random()*1000)`：同一毫秒内连建几条时
     * 有 1/1000 的碰撞概率，撞上就是一句 `UNIQUE constraint failed: oplog_entries.id`
     * 甩给用户（本轮测试里真实复现过一次）。改成 UUID 前缀后同毫秒也不会撞。
     */
    id: existing?.id ?? 'oplog-' + now.replace(/[^0-9]/g, '') + '-' + randomUUID().slice(0, 8),
    logType: draft.logType.trim() === '' ? '其它' : draft.logType.trim(),
    title: draft.title.trim(),
    contentText: draft.contentText,
    asins: draft.asins.map((a) => a.trim().toUpperCase()).filter((a) => a !== ''),
    images: existing?.images ?? [],
    documents: draft.documents,
    shopId: draft.shopId,
    shopName: draft.shopId,
    site: draft.site,
    typeColor: existing?.typeColor ?? colorForType(draft.logType),
    logDate: draft.logDate,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    pinned: existing?.pinned ?? false,
    taskId: draft.taskId === undefined ? (existing?.taskId ?? null) : draft.taskId,
  }
}

export function getOplogEntry(db: DatabaseSync, id: string): OplogEntry | null {
  const row = db.prepare('SELECT * FROM oplog_entries WHERE id = ?').get(id) as unknown as RawOplogRow | undefined
  return row === undefined ? null : toEntry(row)
}

export function createOplogEntry(db: DatabaseSync, draft: OplogDraft): OplogEntry {
  const entry = normalizeDraft(draft, null)
  db.prepare(`INSERT INTO oplog_entries (id, log_type, title, content_text, asin_json, images_json, documents_json, shop_id, shop_name, site, type_color, log_date, created_at, updated_at, pinned, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    entry.id, entry.logType, entry.title, entry.contentText, JSON.stringify(entry.asins), JSON.stringify(entry.images),
    JSON.stringify(entry.documents), entry.shopId, entry.shopName, entry.site, entry.typeColor, entry.logDate, entry.createdAt, entry.updatedAt, entry.taskId,
  )
  return entry
}

export function updateOplogEntry(db: DatabaseSync, id: string, draft: OplogDraft): OplogEntry | null {
  const existing = getOplogEntry(db, id)
  if (existing === null) return null
  const entry = normalizeDraft(draft, existing)
  db.prepare(`UPDATE oplog_entries SET log_type = ?, title = ?, content_text = ?, asin_json = ?, documents_json = ?,
    shop_id = ?, shop_name = ?, site = ?, type_color = ?, log_date = ?, task_id = ?, updated_at = ? WHERE id = ?`).run(
    entry.logType, entry.title, entry.contentText, JSON.stringify(entry.asins), JSON.stringify(entry.documents),
    entry.shopId, entry.shopName, entry.site, entry.typeColor, entry.logDate, entry.taskId, entry.updatedAt, id,
  )
  return entry
}

export function deleteOplogEntry(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM oplog_entries WHERE id = ?').run(id).changes > 0
}

export function setOplogPinned(db: DatabaseSync, id: string, pinned: boolean): boolean {
  return db.prepare('UPDATE oplog_entries SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, new Date().toISOString(), id).changes > 0
}

/* ---------------- 类型字典 ---------------- */

export interface OplogType { name: string; color: string; sort: number }

export interface OplogDayIndexEntry {
  date: string
  count: number
}

/**
 * 日历格子用的「每天有几条日志」索引。
 *
 * 日期口径与列表分组一致：优先 `log_date`（业务日期），历史记录为空时退回
 * `created_at` 的前 10 位（导入时已写成 ISO，取日期部分是安全的）。
 * 只返回有日志的日期，日历侧按需查表，不铺 365 天空行。
 */
export function listOplogDayIndex(db: DatabaseSync, limitDays = 800): OplogDayIndexEntry[] {
  const days = Math.min(Math.max(limitDays, 1), 3650)
  return db.prepare(`SELECT COALESCE(NULLIF(log_date, ''), substr(created_at, 1, 10)) AS date, COUNT(*) AS count
    FROM oplog_entries
    GROUP BY date
    ORDER BY date DESC
    LIMIT ?`).all(days) as unknown as OplogDayIndexEntry[]
}

export function listOplogTaskOptions(db: DatabaseSync): OplogTaskOption[] {
  return db.prepare(`SELECT id, title, status_code AS statusCode, due_at AS dueAt
    FROM tasks WHERE archived = 0 AND status_code NOT IN ('done', 'cancelled')
    ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT 500`)
    .all() as unknown as OplogTaskOption[]
}

export function listOplogTypes(db: DatabaseSync): OplogType[] {
  return db.prepare('SELECT name, color, sort FROM oplog_types ORDER BY sort ASC, name ASC').all() as unknown as OplogType[]
}

export function upsertOplogType(db: DatabaseSync, name: string, color: string): OplogType {
  const clean = name.trim()
  const nextSort = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM oplog_types').get() as unknown as { n: number }).n
  db.prepare('INSERT INTO oplog_types (name, color, sort) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET color = excluded.color').run(clean, color, nextSort)
  return { name: clean, color, sort: nextSort }
}

export function deleteOplogType(db: DatabaseSync, name: string): boolean {
  return db.prepare('DELETE FROM oplog_types WHERE name = ?').run(name).changes > 0
}
