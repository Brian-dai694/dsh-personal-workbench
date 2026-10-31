/**
 * P4-B（schema v38）：运营日志 0..n 结构化关联。
 *
 * 设计纪律（与架构师的 P4 最小范围一致）：
 * 1. **只增表**：不碰 `oplog_entries` 任何列，`asin_json` 逐字节保留；
 * 2. **身份前置**：每条关联先归一到 `site + ASIN`；站点缺失/非法保持 `NULL`，绝不回填 US；
 * 3. **不推断关系**：role 只接受 `parent|child|sku|unknown`，存量回填一律 `unknown`；
 *    父子/SKU 只能由用户显式给出，不从 ASIN 字符串猜；
 * 4. **未知/歧义进复核**：复用 v37 的 `migration_review`（按 source_table+source_key+reason 去重）；
 * 5. **幂等**：建表 `IF NOT EXISTS`，回填 `INSERT OR IGNORE`，重复执行 0 新增。
 *
 * v38 只准备“可写可读”的规范化数据；`asin_json` 仍是兼容来源，读路径同时返回两者。
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeSite } from './asinIdentityV37.js'

export const OPLOG_ASSOCIATIONS_V38_VERSION = 38

export const OPLOG_ASSOCIATION_ROLES = ['parent', 'child', 'sku', 'unknown'] as const
export type OplogAssociationRole = typeof OPLOG_ASSOCIATION_ROLES[number]

/** 写入侧输入：站点可省（继承日志站点），角色默认 unknown。 */
export interface OplogAssociationInput {
  site?: string | null
  asin: string
  role?: string | null
  sku?: string | null
}

/** 读侧形状：与仓储层 `OplogAssociation` 对齐（两边字段名保持一致，避免二次映射）。 */
export interface OplogAssociationRecord {
  site: string | null
  asin: string
  role: OplogAssociationRole
  sku: string | null
  listingId: string
  source: string
  ordinal: number
}

export interface OplogAssociationBackfillReport {
  readonly version: 38
  readonly entries: number
  readonly fromAsinJson: number
  readonly inserted: number
  readonly duplicates: number
  /** 身份表查不到唯一 `(site, asin)` 或站点缺失/非法而**没有**建关联的条数。 */
  readonly unresolved: number
  readonly reviewsAdded: number
  readonly byReason: Record<string, number>
  readonly reviewRows: Array<{ sourceTable: string; sourceKey: string; reason: string }>
}

const DDL = `
CREATE TABLE IF NOT EXISTS oplog_entry_associations (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES oplog_entries(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  role        TEXT NOT NULL DEFAULT 'unknown',
  site        TEXT,
  site_key    TEXT NOT NULL DEFAULT '',
  asin        TEXT NOT NULL DEFAULT '',
  sku         TEXT,
  sku_key     TEXT NOT NULL DEFAULT '',
  shop_id     TEXT,
  listing_id  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_oplog_assoc_identity
  ON oplog_entry_associations(entry_id, role, site_key, asin, sku_key);
CREATE INDEX IF NOT EXISTS idx_oplog_assoc_entry
  ON oplog_entry_associations(entry_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_oplog_assoc_listing
  ON oplog_entry_associations(listing_id);
`

/** 派生键：与导出键 `productKey` 同一口径（`UNKNOWN_<asin>` 表示站点未定）。 */
export function oplogListingId(site: string | null, asin: string): string {
  const normalizedSite = (site ?? '').trim().toUpperCase()
  return `${normalizedSite === '' ? 'UNKNOWN' : normalizedSite}_${asin.trim().toUpperCase()}`
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined
}

/** 建表；可重复执行。 */
export function applyOplogAssociationsV38(db: DatabaseSync): void {
  db.exec(DDL)
}

/** 关联表是否已就绪：未迁移（schema 37）时仓储要能降级，不能因此读不了日志。 */
export function oplogAssociationsReady(db: DatabaseSync): boolean {
  return tableExists(db, 'oplog_entry_associations')
}

/** ASIN 宽松归一（日志里的历史值可能不合 10 位规则，不能整条丢）。 */
export function normalizeOplogAsin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const asin = value.trim().toUpperCase()
  return asin === '' ? null : asin
}

export function normalizeAssociationRole(value: unknown): OplogAssociationRole | null {
  if (typeof value !== 'string') return null
  const role = value.trim().toLowerCase()
  return (OPLOG_ASSOCIATION_ROLES as readonly string[]).includes(role) ? role as OplogAssociationRole : null
}

/**
 * 身份是否已解析：必须在 v37 影子身份表里查到**唯一** `(site, asin)`。
 *
 * 只看 shadow（`asin_products_v2`），不看 v1：P4 的身份前置就是这张表。
 * 表不存在（schema < 37 的库）一律视为未解析，宁可少建关联也不造悬空键。
 */
export function identityExists(db: DatabaseSync, site: string, asin: string): boolean {
  if (!tableExists(db, 'asin_products_v2')) return false
  return db.prepare('SELECT 1 AS x FROM asin_products_v2 WHERE site = ? AND asin = ? LIMIT 1').get(site, asin) !== undefined
}

/** 该 ASIN 在 v1/shadow 里出现过的站点（升序）。读不到就返回空数组。 */export function knownSitesForAsin(db: DatabaseSync, asin: string): string[] {
  const sites = new Set<string>()
  if (tableExists(db, 'asin_products')) {
    const row = db.prepare('SELECT site FROM asin_products WHERE asin = ?').get(asin) as { site: string | null } | undefined
    const site = normalizeSite(row?.site)
    if (site !== null) sites.add(site)
  }
  if (tableExists(db, 'asin_products_v2')) {
    const rows = db.prepare('SELECT DISTINCT site FROM asin_products_v2 WHERE asin = ?').all(asin) as unknown as Array<{ site: string }>
    for (const row of rows) {
      const site = normalizeSite(row.site)
      if (site !== null) sites.add(site)
    }
  }
  return [...sites].sort()
}

interface ReviewSink {
  add(sourceTable: string, sourceKey: string, reason: string, payload: unknown): boolean
  added(): number
  byReason(): Record<string, number>
  rows(): Array<{ sourceTable: string; sourceKey: string; reason: string }>
}

function reviewSink(db: DatabaseSync, now: string): ReviewSink {
  if (!tableExists(db, 'migration_review')) {
    return { add: () => false, added: () => 0, byReason: () => ({}), rows: () => [] }
  }
  const stmt = db.prepare(`
    INSERT INTO migration_review (id, source_table, source_key, reason, payload_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(source_table, source_key, reason) DO NOTHING
  `)
  let added = 0
  const reasons: Record<string, number> = {}
  const rows: Array<{ sourceTable: string; sourceKey: string; reason: string }> = []
  return {
    add(sourceTable, sourceKey, reason, payload) {
      const result = stmt.run(`review-${randomUUID()}`, sourceTable, sourceKey, reason, JSON.stringify(payload), now)
      const changed = Number(result.changes) > 0
      if (changed) {
        added += 1
        reasons[reason] = (reasons[reason] ?? 0) + 1
        if (rows.length < 100) rows.push({ sourceTable, sourceKey, reason })
      }
      return changed
    },
    added: () => added,
    byReason: () => reasons,
    rows: () => rows,
  }
}

/**
 * 把 `asin_json` 回填成关联行。
 *
 * 只读 `oplog_entries`、只写 `oplog_entry_associations` / `migration_review`；
 * 存量 role 一律 `unknown`，站点取日志自身 site（不合法则 NULL + 复核）。
 */
export function backfillOplogAssociationsV38(db: DatabaseSync): OplogAssociationBackfillReport {
  applyOplogAssociationsV38(db)
  const now = new Date().toISOString()
  const review = reviewSink(db, now)
  const entries = db.prepare('SELECT id, site, asin_json FROM oplog_entries').all() as unknown as Array<{
    id: string; site: string | null; asin_json: string
  }>
  const insert = db.prepare(`
    INSERT OR IGNORE INTO oplog_entry_associations
      (id, entry_id, ordinal, role, site, site_key, asin, sku, sku_key, shop_id, listing_id, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '', NULL, ?, 'legacy', ?)
  `)

  let fromAsinJson = 0
  let inserted = 0
  let duplicates = 0
  let unresolved = 0
  for (const entry of entries) {
    let asins: unknown = []
    try { asins = JSON.parse(entry.asin_json) } catch { asins = [] }
    if (!Array.isArray(asins)) continue
    const entrySite = normalizeSite(entry.site)
    /** 显式写了但格式非法的站点，与"没写"要分开处理。 */
    const entrySiteInvalid = entrySite === null
      && typeof entry.site === 'string' && entry.site.trim() !== ''
    asins.forEach((raw, index) => {
      const asin = normalizeOplogAsin(raw)
      const reviewKey = `${entry.id}#${index}`
      if (asin === null) {
        fromAsinJson += 1
        review.add('oplog_entries', reviewKey, 'association_asin_invalid', { asin: raw ?? null })
        unresolved += 1
        return
      }
      fromAsinJson += 1
      /**
       * **身份表里没有唯一 `(site, asin)` 就不建关联**（2026-10-30 架构师审查）：
       * 关联必须指向已解析身份，否则 `listing_id` 是悬空文本。旧日志原值留在 `asin_json`，
       * 这里只进复核队列 —— 真实库里产品表是 0 行，那 8 条日志因此一条都不会被绑定。
       */
      if (entrySite === null) {
        if (entrySiteInvalid) review.add('oplog_entries', reviewKey, 'association_site_invalid', { asin, site: entry.site })
        else review.add('oplog_entries', reviewKey, 'association_site_unknown', { asin, site: null })
        unresolved += 1
        return
      }
      if (!identityExists(db, entrySite, asin)) {
        const sites = knownSitesForAsin(db, asin)
        review.add('oplog_entries', reviewKey,
          sites.length > 0 ? 'association_site_mismatch' : 'association_identity_missing',
          { asin, site: entrySite, candidates: sites })
        unresolved += 1
        return
      }
      const result = insert.run(
        `assoc-${randomUUID()}`, entry.id, index, 'unknown', entrySite, entrySite, asin,
        oplogListingId(entrySite, asin), now,
      )
      if (Number(result.changes) > 0) inserted += 1
      /**
       * 重复（重跑回填时命中唯一索引）**只计数，不进复核队列**。
       *
       * `migration_review` 是给人看的待办：重复关联没有任何需要人判断的东西，
       * 写进去只会在每次重跑时堆噪音、把真正待处理的 `association_site_unknown` 淹掉。
       * 回填的幂等验收看 `report.inserted === 0`，不看复核行数增长。
       */
      else duplicates += 1
    })
  }

  return {
    version: 38,
    entries: entries.length,
    fromAsinJson,
    inserted,
    duplicates,
    unresolved,
    reviewsAdded: review.added(),
    byReason: review.byReason(),
    reviewRows: review.rows(),
  }
}

/**
 * 写入侧：把一次日志草稿的关联解析成表行。
 *
 * 站点与身份规则（2026-10-30 架构师审查后收紧）：
 * - `site` **字段缺省**才继承日志站点；
 * - 显式 `null` / 空串 / 非法格式 → `association_site_invalid` 复核，**不回退到日志站点**、不建关联；
 * - 继承或显式站点仍为空 → `association_site_unknown` 复核，不建关联；
 * - 只有身份表（`asin_products_v2`）里存在该 `(site, asin)` 才建关联；否则进复核，
 *   绝不产出悬空的 `listing_id`；
 * - 角色非法降级 `unknown` + 复核（路由层还会再校验一次并 400）。
 *
 * 复核 key 用身份而不是序号：反复保存同一条日志不会堆积重复待办。
 */
export function resolveOplogAssociations(
  db: DatabaseSync,
  entryId: string,
  entrySite: string | null,
  inputs: readonly OplogAssociationInput[],
): OplogAssociationRecord[] {
  const now = new Date().toISOString()
  const review = reviewSink(db, now)
  const defaultSite = normalizeSite(entrySite)
  const seen = new Set<string>()
  const out: OplogAssociationRecord[] = []
  for (const input of inputs) {
    const asin = normalizeOplogAsin(input.asin)
    if (asin === null) continue
    const rawRole = input.role === undefined || input.role === null || input.role === ''
      ? 'unknown'
      : input.role
    const role = normalizeAssociationRole(rawRole)
    const finalRole: OplogAssociationRole = role ?? 'unknown'
    const sku = typeof input.sku === 'string' && input.sku.trim() !== '' ? input.sku.trim() : null

    /** 站点：区分“没给”“给了空/非法”“给了合法值”。 */
    let site: string | null
    let siteInvalid = false
    if (input.site === undefined) {
      site = defaultSite
    } else if (input.site === null) {
      site = null
      siteInvalid = true
    } else {
      const trimmed = input.site.trim()
      if (trimmed === '') {
        site = null
        siteInvalid = true
      } else if (!/^[A-Za-z]{2}$/.test(trimmed)) {
        site = null
        siteInvalid = true
      } else {
        site = trimmed.toUpperCase()
      }
    }

    const key = `${finalRole}|${site ?? ''}|${asin}|${sku ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const reviewKey = `${entryId}#${finalRole}|${site ?? ''}|${asin}`

    if (role === null) {
      review.add('oplog_entries', reviewKey, 'association_role_invalid', { asin, role: rawRole })
    }
    if (siteInvalid) {
      review.add('oplog_entries', reviewKey, 'association_site_invalid', { asin, site: input.site ?? null })
      continue
    }
    if (site === null) {
      review.add('oplog_entries', reviewKey, 'association_site_unknown', { asin, site: null })
      continue
    }
    if (!identityExists(db, site, asin)) {
      const sites = knownSitesForAsin(db, asin)
      review.add('oplog_entries', reviewKey,
        sites.length > 0 ? 'association_site_mismatch' : 'association_identity_missing',
        { asin, site, candidates: sites })
      continue
    }

    out.push({
      site,
      asin,
      role: finalRole,
      sku,
      listingId: oplogListingId(site, asin),
      source: 'manual',
      ordinal: out.length,
    })
  }
  return out
}
