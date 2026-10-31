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
import type { OplogAssociationInput, OplogAssociationRecord } from '../oplogAssociationsV38.js'
import { oplogAssociationsReady, oplogListingId, resolveOplogAssociations } from '../oplogAssociationsV38.js'

/** 读侧关联形状（P4-B）：与 v38 模块同名，避免两处字段漂移。 */
export type OplogAssociation = OplogAssociationRecord

export interface OplogEntry extends OplogImportEntry {
  /** 置顶：列表排序优先 */
  pinned: boolean
  /** 关联的工作台任务；历史导入记录默认 null。 */
  taskId: string | null
  /**
   * 结构化关联（P4-B）。旧库（schema 37）没有这张表时恒为 `[]`，
   * 此时 `asins` 仍是唯一来源 —— 读路径不允许因此报错。
   */
  associations: OplogAssociation[]
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
  /** 按结构化关联反查（`US_B0XXXXXXXX` / `UNKNOWN_B0XXXXXXXX`）。 */
  listingId?: string
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
    associations: [],
  }
}

interface RawAssociationRow {
  entry_id: string
  ordinal: number
  role: string
  site: string | null
  asin: string
  sku: string | null
  listing_id: string
  source: string
}

/**
 * 批量挂上关联（一条 SQL，避免 N+1）。
 *
 * schema 37 的库没有这张表：直接原样返回 —— 日志照常可读，`asins` 是唯一来源。
 */
function attachAssociations(db: DatabaseSync, entries: OplogEntry[]): OplogEntry[] {
  if (entries.length === 0 || !oplogAssociationsReady(db)) return entries
  const ids = entries.map((entry) => entry.id)
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT entry_id, ordinal, role, site, asin, sku, listing_id, source
    FROM oplog_entry_associations
    WHERE entry_id IN (${placeholders})
    ORDER BY entry_id, ordinal
  `).all(...ids) as unknown as RawAssociationRow[]
  const byEntry = new Map<string, OplogAssociation[]>()
  for (const row of rows) {
    const list = byEntry.get(row.entry_id) ?? []
    list.push({
      site: row.site,
      asin: row.asin,
      role: row.role as OplogAssociation['role'],
      sku: row.sku,
      listingId: row.listing_id,
      source: row.source,
      ordinal: row.ordinal,
    })
    byEntry.set(row.entry_id, list)
  }
  for (const entry of entries) entry.associations = byEntry.get(entry.id) ?? []
  return entries
}

/** 把草稿里的关联落库（整组替换）：先删旧行，再按解析结果插入。 */
function writeAssociations(
  db: DatabaseSync,
  entry: Pick<OplogEntry, 'id' | 'site' | 'asins'>,
  inputs: readonly OplogAssociationInput[] | undefined,
  source: 'manual' | 'import',
): void {
  if (!oplogAssociationsReady(db)) return
  db.prepare('DELETE FROM oplog_entry_associations WHERE entry_id = ?').run(entry.id)
  const resolved = inputs !== undefined
    ? inputs
    /** 旧客户端只传 asins：落成 role=unknown、站点继承日志，绝不猜父子/SKU。 */
    : entry.asins.map((asin) => ({ asin, site: entry.site, role: 'unknown' as const }))
  const rows = resolveOplogAssociations(db, entry.id, entry.site, resolved)
  if (rows.length === 0) return
  const insert = db.prepare(`
    INSERT INTO oplog_entry_associations
      (id, entry_id, ordinal, role, site, site_key, asin, sku, sku_key, shop_id, listing_id, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `)
  const now = new Date().toISOString()
  for (const row of rows) {
    insert.run(
      `assoc-${randomUUID()}`, entry.id, row.ordinal, row.role, row.site, row.site ?? '',
      row.asin, row.sku, row.sku ?? '', oplogListingId(row.site, row.asin), source, now,
    )
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
  /**
   * 按结构化关联反查（P4-B）。
   *
   * schema 37 的库没有关联表：退回 `asin_json` 的包含匹配 —— 结果可能略宽（不同站点同 ASIN），
   * 但**不会漏**；有表时走 `idx_oplog_assoc_listing`，站点也精确。
   */
  if (filter.listingId !== undefined && filter.listingId !== '') {
    const listingId = filter.listingId.trim().toUpperCase()
    if (oplogAssociationsReady(db)) {
      where.push('EXISTS (SELECT 1 FROM oplog_entry_associations a WHERE a.entry_id = oplog_entries.id AND a.listing_id = ?)')
      params.push(listingId)
    } else {
      const asin = listingId.slice(listingId.indexOf('_') + 1)
      where.push('asin_json LIKE ?')
      params.push(`%${asin}%`)
    }
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
  const sql = `SELECT * FROM oplog_entries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, created_at DESC LIMIT ?`
  const rows = db.prepare(sql).all(...params, limit) as unknown as RawOplogRow[]
  return attachAssociations(db, rows.map(toEntry))
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
    /** 导入也把 ASIN 正规化进关联表；role 一律 unknown，站点继承日志，不猜。 */
    writeAssociations(db, { id: entry.id, site: entry.site, asins: entry.asins }, undefined, 'import')
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
  /**
   * P4-B 结构化关联。给了它就以它为准（`asins` 由它派生）；
   * 与 `asins` 同时给由路由层直接 400，不在仓储里二选一。
   */
  associations?: OplogAssociationInput[]
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
    asins: draft.associations !== undefined
      ? [...new Set(draft.associations
        .map((item) => item.asin.trim().toUpperCase())
        .filter((asin) => asin !== ''))]
      : draft.asins.map((a) => a.trim().toUpperCase()).filter((a) => a !== ''),
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
    associations: [],
  }
}

export function getOplogEntry(db: DatabaseSync, id: string): OplogEntry | null {
  const row = db.prepare('SELECT * FROM oplog_entries WHERE id = ?').get(id) as unknown as RawOplogRow | undefined
  if (row === undefined) return null
  return attachAssociations(db, [toEntry(row)])[0] ?? null
}

export function createOplogEntry(db: DatabaseSync, draft: OplogDraft): OplogEntry {
  const entry = normalizeDraft(draft, null)
  db.prepare(`INSERT INTO oplog_entries (id, log_type, title, content_text, asin_json, images_json, documents_json, shop_id, shop_name, site, type_color, log_date, created_at, updated_at, pinned, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
    entry.id, entry.logType, entry.title, entry.contentText, JSON.stringify(entry.asins), JSON.stringify(entry.images),
    JSON.stringify(entry.documents), entry.shopId, entry.shopName, entry.site, entry.typeColor, entry.logDate, entry.createdAt, entry.updatedAt, entry.taskId,
  )
  writeAssociations(db, entry, draft.associations, 'manual')
  return getOplogEntry(db, entry.id) ?? entry
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
  writeAssociations(db, entry, draft.associations, 'manual')
  return getOplogEntry(db, id) ?? entry
}

export function deleteOplogEntry(db: DatabaseSync, id: string): boolean {
  /** 关联表显式删：连接没开 `foreign_keys` 时不会自动 CASCADE。 */
  if (oplogAssociationsReady(db)) db.prepare('DELETE FROM oplog_entry_associations WHERE entry_id = ?').run(id)
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

/**
 * 关联任务的候选池。
 *
 * ⚠️ **2026-10-27 修**：原实现排除了 `done` / `cancelled`，后果是**任务一旦完成就再也无法
 * 从日志侧关联它** —— 想给一个已完成的任务补一条复盘日志，选择器里根本找不到。
 * 这个限制没有业务理由（完成 ≠ 不该被记录），所以放开为「只排除已归档」，
 * 并先用 `未完成优先` 排序：常用项仍在最前面，不会因为多出历史任务而变难选。
 */
export function listOplogTaskOptions(db: DatabaseSync): OplogTaskOption[] {
  return db.prepare(`SELECT id, title, status_code AS statusCode, due_at AS dueAt
    FROM tasks WHERE archived = 0
    ORDER BY CASE WHEN status_code IN ('done', 'cancelled') THEN 1 ELSE 0 END,
             CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT 500`)
    .all() as unknown as OplogTaskOption[]
}

export interface OplogCompletionCandidate {
  id: string
  title: string
  typeCode: string
  completedAt: string
}

/**
 * 某一天完成、但**还没有写进任何运营日志**的任务 —— 运营日志页「待归档」建议用。
 *
 * 为什么只出建议、不自动写日志：运营日志是**事实记录层**（业务日期 + 人写的叙事），
 * 任务完成是流程状态变化。自动写入只能拿到"系统当前时间"，跨天补记就错位，
 * 也会把叙事层冲成流水账。所以这里只**产出候选**：用户点一下 → 预填表单 → 他确认才落库。
 *
 * 日期口径与任务面板同一把尺子：`completed_at` 存的是 UTC ISO（`nowIso()`），
 * 按**本地日**比较（SQLite `date(..., 'localtime')`），与 `localDateString()` 等价。
 * 「已写过」用 `NOT EXISTS` 判定：同一任务写过多少条日志都不会再出现在建议里。
 */
export function listOplogCompletionCandidates(db: DatabaseSync, date: string, limit = 20): OplogCompletionCandidate[] {
  const day = date.trim()
  // 定宽 YYYY-MM-DD 才允许进 SQL；脏日期直接返回空，不猜
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return []
  const max = Math.min(Math.max(limit, 1), 100)
  return db.prepare(`SELECT t.id, t.title, t.type_code AS typeCode, t.completed_at AS completedAt
    FROM tasks t
    WHERE t.archived = 0 AND t.status_code = 'done' AND t.completed_at IS NOT NULL
      AND date(t.completed_at, 'localtime') = ?
      AND NOT EXISTS (SELECT 1 FROM oplog_entries o WHERE o.task_id = t.id)
    ORDER BY t.completed_at DESC LIMIT ?`).all(day, max) as unknown as OplogCompletionCandidate[]
}

/**
 * 某条任务被哪些运营日志引用（反向查询，任务详情的「关联日志」）。
 *
 * 在此之前关联是**单向**的：日志能指向任务，任务不知道自己被谁提到过。
 * 排序按业务日期倒序，与日志列表一致。
 */
export function listOplogEntriesByTask(db: DatabaseSync, taskId: string, limit = 100): OplogEntry[] {
  const id = taskId.trim()
  if (id === '') return []
  const max = Math.min(Math.max(limit, 1), 500)
  const rows = db.prepare(`SELECT * FROM oplog_entries WHERE task_id = ?
    ORDER BY COALESCE(NULLIF(log_date, ''), substr(created_at, 1, 10)) DESC, created_at DESC LIMIT ?`)
    .all(id, max) as unknown as RawOplogRow[]
  return attachAssociations(db, rows.map(toEntry))
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
