/**
 * P1（schema v37）：选品/产品身份影子表 + 复核队列。
 *
 * 设计纪律（与 P0 审计一致）：
 * 1. **只增表**：不改 `asin_products` / `asin_snapshots` 任何列，不切换读写路径；
 * 2. **未知站点不回填 US**：site 缺失/非法一律进 `migration_review`，原表保持原样；
 * 3. **幂等**：所有回填 `INSERT OR IGNORE`，复核队列按 (source_table, source_key, reason) 去重；
 * 4. 父子/SKU 关系**不推断**：`asin_relations` / `asin_skus` 本次只建表，不写入任何猜测数据。
 *
 * 这份迁移只准备“未来可读”的影子数据；v1 仍是唯一读取来源，P2 才会加兼容层。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const ASIN_IDENTITY_V37_VERSION = 37

const SHADOW_DDL = `
CREATE TABLE IF NOT EXISTS asin_products_v2 (
  site             TEXT NOT NULL,
  asin             TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  current_title    TEXT,
  image_url        TEXT,
  url              TEXT,
  price            REAL,
  rating           REAL,
  reviews          INTEGER,
  bsr              INTEGER,
  shop_id          TEXT,
  shop_name        TEXT,
  category         TEXT,
  note             TEXT,
  tags_json        TEXT NOT NULL DEFAULT '[]',
  extra_json       TEXT NOT NULL DEFAULT '{}',
  brand            TEXT,
  seller           TEXT,
  currency         TEXT,
  watch            INTEGER NOT NULL DEFAULT 0,
  manual_order     INTEGER,
  added_at         TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (site, asin)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asin_products_v2_asin ON asin_products_v2(asin);

CREATE TABLE IF NOT EXISTS asin_snapshots_v2 (
  id           TEXT PRIMARY KEY,
  site         TEXT NOT NULL,
  asin         TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  price        REAL,
  monthly_sales INTEGER,
  reviews      INTEGER,
  rating       REAL,
  bsr_major    INTEGER,
  bsr_minor    INTEGER,
  UNIQUE (site, asin, captured_at)
) STRICT;

CREATE TABLE IF NOT EXISTS asin_judgments (
  id            TEXT PRIMARY KEY,
  site          TEXT NOT NULL,
  asin          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  verdict       TEXT NOT NULL,
  score         REAL,
  judgment_json TEXT NOT NULL DEFAULT '{}',
  judged_at     TEXT NOT NULL,
  judged_source TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (site, asin, version)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asin_judgments_lookup ON asin_judgments(site, asin, judged_at DESC);

CREATE TABLE IF NOT EXISTS asin_relations (
  id            TEXT PRIMARY KEY,
  site          TEXT NOT NULL,
  parent_asin   TEXT NOT NULL,
  child_asin    TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'variation',
  created_at    TEXT NOT NULL,
  UNIQUE (site, parent_asin, child_asin, relation_type)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asin_relations_parent ON asin_relations(site, parent_asin);
CREATE INDEX IF NOT EXISTS idx_asin_relations_child ON asin_relations(site, child_asin);

CREATE TABLE IF NOT EXISTS asin_skus (
  id         TEXT PRIMARY KEY,
  site       TEXT NOT NULL,
  asin       TEXT NOT NULL,
  shop_id    TEXT,
  sku        TEXT NOT NULL,
  valid_from TEXT,
  valid_to   TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, sku)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_asin_skus_listing ON asin_skus(site, asin);

CREATE TABLE IF NOT EXISTS migration_review (
  id           TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_key   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  UNIQUE (source_table, source_key, reason)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_migration_review_status ON migration_review(status, created_at);
`

const SITE_RE = /^[A-Z]{2}$/
const ASIN_RE = /^[A-Z0-9]{10}$/

export interface AsinIdentityBackfillReport {
  readonly version: 37
  readonly products: { readonly source: number; readonly inserted: number; readonly reviewed: number }
  readonly snapshots: { readonly source: number; readonly inserted: number; readonly reviewed: number }
  readonly judgments: { readonly inserted: number; readonly skipped: number }
  readonly reviews: { readonly added: number; readonly total: number; readonly byReason: Record<string, number> }
  readonly reviewRows: Array<{ sourceTable: string; sourceKey: string; reason: string }>
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 只规范化，不猜：非法/缺失返回 null，由调用方写复核队列。 */
export function normalizeSite(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const site = value.trim().toUpperCase()
  return SITE_RE.test(site) ? site : null
}

export function normalizeAsin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const asin = value.trim().toUpperCase()
  return ASIN_RE.test(asin) ? asin : null
}

/** 创建 v37 的六张影子表；可重复执行。 */
export function applyAsinIdentityV37(db: DatabaseSync): void {
  db.exec(SHADOW_DDL)
}

/**
 * 回填影子表 + 复核队列。
 *
 * 只读 v1 表、只写 v2/复核队列；不更新/删除 v1 任何行。
 * 第二次执行应为“0 新增”，用于迁移幂等验收。
 */
export function backfillAsinIdentityV37(db: DatabaseSync): AsinIdentityBackfillReport {
  const now = new Date().toISOString()
  const addReviewStmt = db.prepare(`
    INSERT INTO migration_review (id, source_table, source_key, reason, payload_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(source_table, source_key, reason) DO NOTHING
  `)
  const byReason: Record<string, number> = {}
  const reviewRows: Array<{ sourceTable: string; sourceKey: string; reason: string }> = []
  let reviewsAdded = 0

  const addReview = (sourceTable: string, sourceKey: string, reason: string, payload: unknown): boolean => {
    const result = addReviewStmt.run(`review-${randomUUID()}`, sourceTable, sourceKey, reason, JSON.stringify(payload), now)
    const changed = Number(result.changes) > 0
    if (changed) {
      reviewsAdded += 1
      byReason[reason] = (byReason[reason] ?? 0) + 1
      if (reviewRows.length < 100) reviewRows.push({ sourceTable, sourceKey, reason })
    }
    return changed
  }

  // ---------------- 产品 ----------------
  const productRows = tableExists(db, 'asin_products')
    ? db.prepare('SELECT * FROM asin_products').all().map(asRecord)
    : []
  const productInsert = db.prepare(`
    INSERT OR IGNORE INTO asin_products_v2
      (site, asin, title, current_title, image_url, url, price, rating, reviews, bsr, shop_id, shop_name,
       category, note, tags_json, extra_json, brand, seller, currency, watch, manual_order, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const judgmentInsert = db.prepare(`
    INSERT OR IGNORE INTO asin_judgments
      (id, site, asin, version, verdict, score, judgment_json, judged_at, judged_source, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `)

  let productsInserted = 0
  let productsReviewed = 0
  let judgmentsInserted = 0
  let judgmentsSkipped = 0
  const siteByAsin = new Map<string, string>()

  for (const row of productRows) {
    const asin = normalizeAsin(row.asin)
    const site = normalizeSite(row.site)
    if (asin === null) {
      addReview('asin_products', String(row.asin ?? ''), 'asin_invalid', { asin: row.asin ?? null, site: row.site ?? null })
      productsReviewed += 1
      continue
    }
    if (site === null) {
      addReview('asin_products', asin, 'site_unknown', { asin, site: row.site ?? null })
      productsReviewed += 1
      continue
    }
    siteByAsin.set(asin, site)
    const result = productInsert.run(
      site, asin,
      text(row.title) ?? '',
      text(row.current_title), text(row.image_url), text(row.url),
      numberOrNull(row.price), numberOrNull(row.rating), numberOrNull(row.reviews), numberOrNull(row.bsr),
      text(row.shop_id), text(row.shop_name), text(row.category), text(row.note),
      text(row.tags_json) ?? '[]', text(row.extra_json) ?? '{}',
      text(row.brand), text(row.seller), text(row.currency),
      row.watch === 1 || row.watch === true ? 1 : 0,
      numberOrNull(row.manual_order),
      text(row.added_at) ?? now, text(row.updated_at) ?? now,
    )
    if (Number(result.changes) > 0) productsInserted += 1

    const hasJudgment = (row.judged_at !== null && row.judged_at !== undefined)
      || (typeof row.verdict === 'string' && row.verdict !== 'none')
      || (typeof row.judgment_json === 'string' && row.judgment_json !== '' && row.judgment_json !== '{}')
    if (!hasJudgment) continue
    const judgedAt = text(row.judged_at) ?? text(row.updated_at) ?? text(row.added_at) ?? now
    const judgmentResult = judgmentInsert.run(
      `judgment-${randomUUID()}`, site, asin,
      typeof row.verdict === 'string' && row.verdict !== '' ? row.verdict : 'none',
      numberOrNull(row.score),
      text(row.judgment_json) ?? '{}',
      judgedAt,
      text(row.judged_source),
      now,
    )
    if (Number(judgmentResult.changes) > 0) judgmentsInserted += 1
    else judgmentsSkipped += 1
  }

  // ---------------- 快照 ----------------
  const snapshotRows = tableExists(db, 'asin_snapshots')
    ? db.prepare('SELECT * FROM asin_snapshots').all().map(asRecord)
    : []
  const snapshotInsert = db.prepare(`
    INSERT OR IGNORE INTO asin_snapshots_v2
      (id, site, asin, captured_at, price, monthly_sales, reviews, rating, bsr_major, bsr_minor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let snapshotsInserted = 0
  let snapshotsReviewed = 0
  for (const row of snapshotRows) {
    const asin = normalizeAsin(row.asin)
    if (asin === null) {
      addReview('asin_snapshots', String(row.id ?? ''), 'asin_invalid', { asin: row.asin ?? null })
      snapshotsReviewed += 1
      continue
    }
    const site = siteByAsin.get(asin)
    if (site === undefined) {
      /** 产品库没有它，或产品站点未知：孤儿/无站点快照，禁止猜 US。 */
      const reason = productRows.some((product) => normalizeAsin(product.asin) === asin) ? 'site_unknown' : 'snapshot_orphan'
      addReview('asin_snapshots', String(row.id ?? `${asin}@${String(row.captured_at ?? '')}`), reason, {
        asin, capturedAt: row.captured_at ?? null,
      })
      snapshotsReviewed += 1
      continue
    }
    const result = snapshotInsert.run(
      String(row.id ?? randomUUID()), site, asin, String(row.captured_at ?? ''),
      numberOrNull(row.price), numberOrNull(row.monthly_sales), numberOrNull(row.reviews),
      numberOrNull(row.rating), numberOrNull(row.bsr_major), numberOrNull(row.bsr_minor),
    )
    if (Number(result.changes) > 0) snapshotsInserted += 1
  }

  // ---------------- 日志站点（P1 只入复核队列，不做关联表） ----------------
  const logRows = tableExists(db, 'oplog_entries')
    ? db.prepare('SELECT id, site FROM oplog_entries').all().map(asRecord)
    : []
  for (const row of logRows) {
    const rawSite = row.site
    if (rawSite === null || rawSite === undefined || (typeof rawSite === 'string' && rawSite.trim() === '')) {
      addReview('oplog_entries', String(row.id ?? ''), 'site_unknown', { site: null })
      continue
    }
    if (normalizeSite(rawSite) === null) {
      addReview('oplog_entries', String(row.id ?? ''), 'site_invalid', { site: rawSite })
    }
  }

  const totalReviewRow = tableExists(db, 'migration_review')
    ? db.prepare('SELECT COUNT(*) AS n FROM migration_review').get() as { n?: number } | undefined
    : undefined
  const totalReviews = Number(totalReviewRow?.n ?? 0)

  return {
    version: 37,
    products: { source: productRows.length, inserted: productsInserted, reviewed: productsReviewed },
    snapshots: { source: snapshotRows.length, inserted: snapshotsInserted, reviewed: snapshotsReviewed },
    judgments: { inserted: judgmentsInserted, skipped: judgmentsSkipped },
    reviews: { added: reviewsAdded, total: totalReviews, byReason },
    reviewRows,
  }
}
