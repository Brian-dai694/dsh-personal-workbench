/**
 * 选品仓储：产品库读写、趋势采样、筛选候选值。
 * 只做「收藏库」这条主线；店铺动态（旧脚本的 store_v1_*）留到下一步。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AsinProduct, AsinSnapshot, AsinStore } from '../../shared/asinImport.js'
import { ASIN_VERDICTS, emptyJudgment, isAsinVerdict, normalizeJudgmentInput } from '../../shared/asinJudgment.js'
import type { AsinJudgment, AsinJudgmentInput, AsinVerdict } from '../../shared/asinJudgment.js'
import { onTaskCompleted } from './task-completion-hooks.js'
import { parseTask, type RawTaskRow } from './task-primitives.js'
import type { TaskRow } from '../types.js'

export { ASIN_VERDICTS, isAsinVerdict, emptyJudgment }
export type { AsinJudgment, AsinJudgmentInput, AsinVerdict }

/** 判断结论（共享枚举的别名，保持旧的导入路径可用）。 */

export interface AsinFilter {
  category?: string
  shop?: string
  keyword?: string
  tag?: string
  watch?: 'watch' | 'normal'
  /** 判断结论筛选：do=可做 / watch=观望 / drop=放弃 / none=未判断。 */
  verdict?: AsinVerdict
  sort?: 'collectedAt' | 'updatedAt' | 'price' | 'rating' | 'reviews' | 'bsr' | 'manualOrder' | 'score'
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** 判断结论：封闭枚举来自 `shared/asinJudgment`，AI 与 UI 共用。 */

interface RawAsinRow {
  asin: string
  title: string
  current_title: string | null
  image_url: string | null
  url: string | null
  price: number | null
  rating: number | null
  reviews: number | null
  bsr: number | null
  shop_id: string | null
  shop_name: string | null
  category: string | null
  note: string | null
  tags_json: string
  site: string | null
  extra_json: string | null
  brand: string | null
  seller: string | null
  currency: string | null
  watch: number | null
  manual_order: number | null
  verdict: string | null
  score: number | null
  judgment_json: string | null
  judged_at: string | null
  judged_source: string | null
  added_at: string
  updated_at: string
}

function toProduct(row: RawAsinRow): AsinProduct {
  let tags: string[] = []
  try { const parsed = JSON.parse(row.tags_json) as unknown; if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string') } catch { tags = [] }
  return {
    asin: row.asin,
    title: row.title,
    currentTitle: row.current_title,
    imageUrl: row.image_url,
    url: row.url,
    price: row.price,
    rating: row.rating,
    reviews: row.reviews,
    bsr: row.bsr,
    shopId: row.shop_id,
    shopName: row.shop_name,
    category: row.category,
    note: row.note,
    tags,
    site: row.site ?? 'US',
    extraJson: row.extra_json ?? '{}',
    brand: row.brand,
    seller: row.seller,
    currency: row.currency,
    watch: row.watch === 1,
    manualOrder: row.manual_order,
    judgment: toJudgment(row),
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  }
}

/** 从「提成列 + JSON」还原判断结果；JSON 坏了也不影响列表（退回空判断）。 */
function toJudgment(row: RawAsinRow): AsinJudgment {
  const base = emptyJudgment()
  let parsed: Partial<AsinJudgment> = {}
  try { parsed = JSON.parse(row.judgment_json ?? '{}') as Partial<AsinJudgment> } catch { parsed = {} }
  return {
    ...base,
    ...parsed,
    verdict: isAsinVerdict(row.verdict) ? row.verdict : 'none',
    score: row.score,
    judgedAt: row.judged_at,
    judgedSource: row.judged_source,
    risk: parsed.risk ?? base.risk,
    criteria: Array.isArray(parsed.criteria) ? parsed.criteria : [],
    painPoints: Array.isArray(parsed.painPoints) ? parsed.painPoints : [],
  }
}

export interface AsinPage { items: AsinProduct[]; total: number }

/** 列表页查询；排序列来自固定白名单，过滤值全部参数化。 */
export function queryAsinPage(db: DatabaseSync, filter: AsinFilter = {}): AsinPage {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.category) { where.push('category = ?'); params.push(filter.category) }
  if (filter.shop) { where.push('(shop_id = ? OR shop_name = ?)'); params.push(filter.shop, filter.shop) }
  if (filter.tag) {
    const tags = db.prepare('SELECT asin, tags_json FROM asin_products').all() as unknown as Array<{ asin: string; tags_json: string }>
    const matches = tags.filter((row) => {
      try { return (JSON.parse(row.tags_json) as unknown[]).includes(filter.tag as string) } catch { return false }
    }).map((row) => row.asin)
    if (matches.length === 0) where.push('1 = 0')
    else { where.push(`asin IN (${matches.map(() => '?').join(',')})`); params.push(...matches) }
  }
  if (filter.watch === 'watch') where.push('watch = 1')
  if (filter.watch === 'normal') where.push('(watch IS NULL OR watch = 0)')
  if (filter.verdict !== undefined && filter.verdict !== ('all' as AsinVerdict)) {
    // verdict 列有 NOT NULL DEFAULT 'none'，所以"未判断"就是 'none'，不需要 IS NULL 分支
    where.push('verdict = ?'); params.push(filter.verdict)
  }
  if (filter.keyword) {
    const like = `%${filter.keyword}%`
    where.push('(asin LIKE ? OR title LIKE ? OR current_title LIKE ? OR note LIKE ? OR brand LIKE ?)')
    params.push(like, like, like, like, like)
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM asin_products${clause}`).get(...params) as unknown as { n: number }).n
  const sortColumns: Record<string, string> = {
    collectedAt: 'added_at', updatedAt: 'updated_at', price: 'price', rating: 'rating',
    reviews: 'reviews', bsr: 'bsr', manualOrder: 'manual_order', score: 'score',
  }
  const sort = sortColumns[filter.sort ?? 'collectedAt'] ?? 'added_at'
  const direction = filter.order === 'asc' ? 'ASC' : 'DESC'
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  const rows = db.prepare(`SELECT * FROM asin_products${clause} ORDER BY COALESCE(watch, 0) DESC, ${sort} ${direction} LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as RawAsinRow[]
  return { items: rows.map(toProduct), total }
}

export function listAsinProducts(db: DatabaseSync, filter: AsinFilter = {}): AsinProduct[] {
  return queryAsinPage(db, filter).items
}

export interface AsinFacets { categories: Array<{ value: string; count: number }>; shops: Array<{ value: string; count: number }>; tags: Array<{ value: string; count: number }>; verdicts: Array<{ value: string; count: number }>; total: number; watched: number }

export function asinFacets(db: DatabaseSync): AsinFacets {
  const group = (column: 'category' | 'shop_name'): Array<{ value: string; count: number }> =>
    db.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM asin_products WHERE ${column} IS NOT NULL AND ${column} != '' GROUP BY ${column} ORDER BY count DESC`).all() as unknown as Array<{ value: string; count: number }>
  const total = (db.prepare('SELECT COUNT(*) AS n FROM asin_products').get() as unknown as { n: number }).n
  const counts = new Map<string, number>()
  const tagRows = db.prepare("SELECT tags_json FROM asin_products WHERE tags_json != '[]'").all() as unknown as Array<{ tags_json: string }>
  for (const row of tagRows) {
    try {
      const tags = JSON.parse(row.tags_json) as unknown
      if (Array.isArray(tags)) for (const tag of tags) if (typeof tag === 'string' && tag !== '') counts.set(tag, (counts.get(tag) ?? 0) + 1)
    } catch { /* Ignore malformed tags for facets; the product remains visible. */ }
  }
  const tags = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
  const watched = (db.prepare('SELECT COUNT(*) AS n FROM asin_products WHERE watch = 1').get() as unknown as { n: number }).n
  const verdicts = db.prepare("SELECT verdict AS value, COUNT(*) AS count FROM asin_products GROUP BY verdict ORDER BY count DESC").all() as unknown as Array<{ value: string; count: number }>
  return { categories: group('category'), shops: group('shop_name'), tags, verdicts, total, watched }
}

export function setAsinWatch(db: DatabaseSync, asin: string, watch: boolean): boolean {
  return db.prepare('UPDATE asin_products SET watch = ?, updated_at = ? WHERE asin = ?').run(watch ? 1 : 0, new Date().toISOString(), asin).changes > 0
}

/**
 * 写入判断结果（技能回写通道）。
 *
 * 纪律：
 * - `verdict` 必须是封闭枚举（不接受"看起来像可做"这种自由文本，否则筛选就废了）；
 * - `score` 只接受 0–100，超出范围直接拒绝（不静默夹取，避免"分被悄悄改小"）；
 * - **未提供的字段沿用原值**（浅合并）：面板上点一下结论不该把 VOC、评分卡一起抹掉；
 *   要清空就给空数组 / null，而不是"没传"。
 */
export function setAsinJudgment(db: DatabaseSync, asin: string, input: AsinJudgmentInput): AsinJudgment {
  const checked = normalizeJudgmentInput(input)
  const existingRow = db.prepare('SELECT * FROM asin_products WHERE asin = ?').get(asin) as unknown as RawAsinRow | undefined
  if (existingRow === undefined) throw new Error('asin not found')
  const before = toJudgment(existingRow)
  const at = new Date().toISOString()
  const payload: Omit<AsinJudgment, 'verdict' | 'score' | 'judgedAt' | 'judgedSource'> = {
    nextAction: checked.nextAction === undefined ? before.nextAction : checked.nextAction,
    criteria: checked.criteria === undefined ? before.criteria : checked.criteria,
    painPoints: checked.painPoints === undefined ? before.painPoints : checked.painPoints,
    risk: checked.risk === undefined ? before.risk : checked.risk,
    keywordCount: checked.keywordCount === undefined ? before.keywordCount : checked.keywordCount,
  }
  const score = checked.score === undefined ? before.score : checked.score
  db.prepare(
    `UPDATE asin_products SET verdict = ?, score = ?, judgment_json = ?, judged_at = ?, judged_source = ?, updated_at = ?
     WHERE asin = ?`,
  ).run(checked.verdict, score, JSON.stringify(payload), at, checked.source ?? 'manual', at, asin)
  return { ...payload, verdict: checked.verdict, score, judgedAt: at, judgedSource: checked.source ?? 'manual' }
}

/** 读一批判断结果（agent 用；列表页已随查询带回）。 */
export function listAsinJudgments(db: DatabaseSync, verdict?: AsinVerdict, limit = 50): Array<{ asin: string; title: string; judgment: AsinJudgment }> {
  const rows = verdict === undefined
    ? db.prepare('SELECT * FROM asin_products ORDER BY COALESCE(score, -1) DESC, updated_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM asin_products WHERE verdict = ? ORDER BY COALESCE(score, -1) DESC, updated_at DESC LIMIT ?').all(verdict, limit)
  return (rows as unknown as RawAsinRow[]).map((row) => ({ asin: row.asin, title: row.title, judgment: toJudgment(row) }))
}

export interface AsinTrendPoint { capturedAt: string; price: number | null; reviews: number | null; rating: number | null; bsrMajor: number | null; monthlySales: number | null }

export function asinTrend(db: DatabaseSync, asin: string, limit = 60): AsinTrendPoint[] {
  const rows = db.prepare('SELECT captured_at, price, reviews, rating, bsr_major, monthly_sales FROM asin_snapshots WHERE asin = ? ORDER BY captured_at ASC LIMIT ?').all(asin, limit) as unknown as Array<{ captured_at: string; price: number | null; reviews: number | null; rating: number | null; bsr_major: number | null; monthly_sales: number | null }>
  return rows.map((row) => ({ capturedAt: row.captured_at, price: row.price, reviews: row.reviews, rating: row.rating, bsrMajor: row.bsr_major, monthlySales: row.monthly_sales }))
}

/** 趋势点批量读取：给列表里的迷你图用（一条 SQL，避免 N+1）。 */
export function trendsFor(db: DatabaseSync, asins: readonly string[], limitPerAsin = 24): Map<string, number[]> {
  const out = new Map<string, number[]>()
  if (asins.length === 0) return out
  const placeholders = asins.map(() => '?').join(',')
  const rows = db.prepare(`SELECT asin, captured_at, price FROM asin_snapshots WHERE asin IN (${placeholders}) AND price IS NOT NULL ORDER BY asin, captured_at ASC`).all(...asins) as unknown as Array<{ asin: string; captured_at: string; price: number }>
  for (const row of rows) {
    const list = out.get(row.asin) ?? []
    list.push(row.price)
    if (list.length > limitPerAsin) list.shift()
    out.set(row.asin, list)
  }
  return out
}

export interface AsinImportSummary { inserted: number; snapshots: number; rejected: number; firstReason: string | null }

export function importAsinProducts(db: DatabaseSync, products: readonly AsinProduct[], snapshots: readonly AsinSnapshot[], rejected: number, firstReason: string | null): AsinImportSummary {
  const upsert = db.prepare(`
    INSERT INTO asin_products (asin, title, current_title, image_url, url, price, rating, reviews, bsr, shop_id, shop_name, category, note, tags_json, added_at, updated_at, site, extra_json, brand, seller, currency, watch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asin) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE asin_products.title END,
      current_title = COALESCE(excluded.current_title, asin_products.current_title),
      image_url = COALESCE(excluded.image_url, asin_products.image_url),
      url = COALESCE(excluded.url, asin_products.url),
      price = COALESCE(excluded.price, asin_products.price),
      rating = COALESCE(excluded.rating, asin_products.rating),
      reviews = COALESCE(excluded.reviews, asin_products.reviews),
      bsr = COALESCE(excluded.bsr, asin_products.bsr),
      shop_id = COALESCE(excluded.shop_id, asin_products.shop_id),
      shop_name = COALESCE(excluded.shop_name, asin_products.shop_name),
      category = COALESCE(excluded.category, asin_products.category),
      note = COALESCE(excluded.note, asin_products.note),
      tags_json = CASE WHEN excluded.tags_json != '[]' THEN excluded.tags_json ELSE asin_products.tags_json END,
      site = COALESCE(excluded.site, asin_products.site),
      extra_json = CASE WHEN excluded.extra_json != '{}' THEN excluded.extra_json ELSE asin_products.extra_json END,
      brand = COALESCE(excluded.brand, asin_products.brand),
      seller = COALESCE(excluded.seller, asin_products.seller),
      currency = COALESCE(excluded.currency, asin_products.currency),
        updated_at = excluded.updated_at
  `)
  let inserted = 0
  for (const p of products) {
    upsert.run(p.asin, p.title, p.currentTitle, p.imageUrl, p.url, p.price, p.rating, p.reviews, p.bsr, p.shopId, p.shopName, p.category, p.note, JSON.stringify(p.tags), p.addedAt, p.updatedAt, p.site, p.extraJson, p.brand, p.seller, p.currency, p.watch === true ? 1 : 0)
    inserted += 1
  }
  // 采样：按 (asin, captured_at) 去重，重复导入不翻倍
  const hasSnap = db.prepare('SELECT 1 AS x FROM asin_snapshots WHERE asin = ? AND captured_at = ? LIMIT 1')
  const snap = db.prepare('INSERT INTO asin_snapshots (id, asin, captured_at, price, monthly_sales, reviews, rating, bsr_major, bsr_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  let snapped = 0
  for (const s of snapshots) {
    if (hasSnap.get(s.asin, s.capturedAt) !== undefined) continue
    snap.run(randomUUID(), s.asin, s.capturedAt, s.price, s.monthlySales, s.reviews, s.rating, s.bsrMajor, s.bsrMinor)
    snapped += 1
  }
  return { inserted, snapshots: snapped, rejected, firstReason }
}


/** 店铺：按 id 覆盖；产品数按导入快照更新。 */
export function importAsinStores(db: DatabaseSync, stores: readonly AsinStore[]): number {
  const stmt = db.prepare(`INSERT INTO asin_stores (id, seller_id, site, name, url, note, watch, last_scanned_at, products_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      seller_id = COALESCE(excluded.seller_id, asin_stores.seller_id),
      site = COALESCE(excluded.site, asin_stores.site),
      name = excluded.name,
      url = COALESCE(excluded.url, asin_stores.url),
      note = COALESCE(excluded.note, asin_stores.note),
      /* 之前错写成 asin_products.watch：在 asin_stores 的 upsert 里引用不存在的表，prepare 当场抛错。 */
      watch = MAX(COALESCE(asin_stores.watch, 0), excluded.watch),
      last_scanned_at = COALESCE(excluded.last_scanned_at, asin_stores.last_scanned_at),
      products_count = excluded.products_count`)
  let n = 0
  for (const s of stores) {
    stmt.run(s.id, s.sellerId, s.site, s.name, s.url, s.note, s.watch ? 1 : 0, s.lastScannedAt, s.productsCount)
    n += 1
  }
  return n
}

export interface AsinStoreRow { id: string; sellerId: string | null; site: string | null; name: string; url: string | null; note: string | null; watch: boolean; lastScannedAt: string | null; productsCount: number }

export function listAsinStores(db: DatabaseSync): AsinStoreRow[] {
  const rows = db.prepare('SELECT * FROM asin_stores ORDER BY watch DESC, name ASC').all() as unknown as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id), sellerId: row.seller_id === null ? null : String(row.seller_id), site: row.site === null ? null : String(row.site),
    name: String(row.name), url: row.url === null ? null : String(row.url), note: row.note === null ? null : String(row.note),
    watch: Number(row.watch) === 1, lastScannedAt: row.last_scanned_at === null ? null : String(row.last_scanned_at), productsCount: Number(row.products_count ?? 0),
  }))
}


/**
 * 批量操作（v1.24）：对一组 ASIN 一次做完一件事。
 *
 * 为什么必须做成一个接口而不是循环调单条：界面上"选了 20 个 → 加标签"如果循环发 20 个请求，
 * 中途失败一半就得到**部分生效且无法解释**的状态；这里一个事务内完成，要么全成要么全不成。
 *
 * 支持的动作（封闭枚举，别的值直接拒绝，不做"猜用户想干什么"）：
 * - `watch` / `unwatch`：关注标记；
 * - `addTag` / `removeTag`：标签增删（**幂等**，重复加同名标签不会重复写入）；
 * - `delete`：删除商品（连同其趋势采样；判断结论随行走，因为整条记录没了）。
 *
 * 纪律：ASIN 一律大写去重；不存在的 ASIN 计入 `missing` 而不是让整批失败
 * （用户可能从旧页面复制了已删除的 ASIN）；上限 500 条，超出直接报错而不是静默截断。
 */
export type AsinBatchAction = 'watch' | 'unwatch' | 'addTag' | 'removeTag' | 'delete'

export const ASIN_BATCH_ACTIONS: AsinBatchAction[] = ['watch', 'unwatch', 'addTag', 'removeTag', 'delete']

export const ASIN_BATCH_LIMIT = 500

export interface AsinBatchResult { action: AsinBatchAction; affected: number; missing: number; tag: string | null }

function readTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function batchUpdateAsins(
  db: DatabaseSync,
  asins: readonly string[],
  action: AsinBatchAction,
  tag = '',
  at = new Date().toISOString(),
): AsinBatchResult {
  if (!ASIN_BATCH_ACTIONS.includes(action)) throw new Error(`不支持的批量动作：${action}`)
  const clean = [...new Set(asins.map((value) => value.trim().toUpperCase()).filter((value) => value !== ''))]
  if (clean.length === 0) throw new Error('至少选择一个 ASIN')
  if (clean.length > ASIN_BATCH_LIMIT) throw new Error(`一次最多处理 ${ASIN_BATCH_LIMIT} 个 ASIN（本次 ${clean.length} 个）`)
  const cleanTag = tag.trim()
  if ((action === 'addTag' || action === 'removeTag') && cleanTag === '') throw new Error('标签不能为空')

  const existing = new Set(
    (db.prepare(`SELECT asin FROM asin_products WHERE asin IN (${clean.map(() => '?').join(',')})`).all(...clean) as unknown as Array<{ asin: string }>)
      .map((row) => row.asin),
  )
  const present = clean.filter((asin) => existing.has(asin))
  const missing = clean.length - present.length
  if (present.length === 0) return { action, affected: 0, missing, tag: action === 'addTag' || action === 'removeTag' ? cleanTag : null }

  db.exec('BEGIN')
  try {
    let affected = 0
    if (action === 'watch' || action === 'unwatch') {
      const stmt = db.prepare('UPDATE asin_products SET watch = ?, updated_at = ? WHERE asin = ?')
      for (const asin of present) affected += Number(stmt.run(action === 'watch' ? 1 : 0, at, asin).changes)
    } else if (action === 'delete') {
      const snapshots = db.prepare('DELETE FROM asin_snapshots WHERE asin = ?')
      const stmt = db.prepare('DELETE FROM asin_products WHERE asin = ?')
      for (const asin of present) {
        snapshots.run(asin)
        affected += Number(stmt.run(asin).changes)
      }
    } else {
      /** 标签是 JSON 数组：逐条整列重写（数组很小，没有必要拆表）。 */
      const read = db.prepare('SELECT tags_json FROM asin_products WHERE asin = ?')
      const write = db.prepare('UPDATE asin_products SET tags_json = ?, updated_at = ? WHERE asin = ?')
      for (const asin of present) {
        const row = read.get(asin) as unknown as { tags_json: string } | undefined
        if (row === undefined) continue
        const before = readTags(row.tags_json)
        const next = action === 'addTag'
          ? (before.includes(cleanTag) ? before : [...before, cleanTag])
          : before.filter((item) => item !== cleanTag)
        if (next.length === before.length && action === 'addTag') continue
        write.run(JSON.stringify(next), at, asin)
        affected += 1
      }
    }
    db.exec('COMMIT')
    return { action, affected, missing, tag: action === 'addTag' || action === 'removeTag' ? cleanTag : null }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 导出用：取全部商品（导出必须覆盖整库，不能只导当前页）。 */
export function listAllAsinProducts(db: DatabaseSync): AsinProduct[] {
  const rows = db.prepare('SELECT * FROM asin_products ORDER BY COALESCE(watch, 0) DESC, added_at DESC').all() as unknown as RawAsinRow[]
  return rows.map(toProduct)
}

/**
 * 店铺域（v1.25）：列表带**真实关联商品数**，可关注、可删除。
 *
 * 为什么不能直接用 `asin_stores.products_count`：它是导入时脚本写的快照，
 * 之后商品被删、被改店铺都不会更新 —— 界面显示"这家店 12 个商品"、点进去只有 3 个，
 * 用户会以为筛选坏了。所以这里现算 `linked`（按 shop_id 或 shop_name 命中），
 * 快照值只作为 `scannedCount` 保留，两者不一致时界面能看出"脚本扫描数与库内不一致"。
 */
export interface AsinStoreSummary extends AsinStoreRow {
  /** 库内现算的关联商品数。 */
  linked: number
  /** 关注的商品数（同一店铺下）。 */
  watched: number
}

export function listAsinStoreSummaries(db: DatabaseSync): AsinStoreSummary[] {
  const stores = listAsinStores(db)
  const rows = db.prepare('SELECT shop_id, shop_name, watch FROM asin_products').all() as unknown as Array<{ shop_id: string | null; shop_name: string | null; watch: number | null }>
  const byKey = new Map<string, { linked: number; watched: number }>()
  for (const row of rows) {
    for (const key of [row.shop_id, row.shop_name]) {
      if (key === null || key === '') continue
      const current = byKey.get(key) ?? { linked: 0, watched: 0 }
      current.linked += 1
      if (row.watch === 1) current.watched += 1
      byKey.set(key, current)
    }
  }
  return stores.map((store) => {
    /** 一个店铺可能同时按 id 和名字命中同一批商品：取两者较大值，避免重复计数。 */
    const byId = store.sellerId === null ? undefined : byKey.get(store.sellerId)
    const byName = byKey.get(store.name)
    return {
      ...store,
      linked: Math.max(byId?.linked ?? 0, byName?.linked ?? 0),
      watched: Math.max(byId?.watched ?? 0, byName?.watched ?? 0),
    }
  })
}

export function setAsinStoreWatch(db: DatabaseSync, id: string, watch: boolean): boolean {
  return db.prepare('UPDATE asin_stores SET watch = ? WHERE id = ?').run(watch ? 1 : 0, id).changes > 0
}

/**
 * 删除店铺记录（**不删商品**）。
 *
 * 这条边界很重要：店铺只是"从脚本带过来的一行扫描记录"，商品是用户自己攒的库。
 * 删店铺顺手删商品等于用一次点击毁掉选品结果 —— 商品要删请走商品列表。
 */
export function deleteAsinStore(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM asin_stores WHERE id = ?').run(id).changes > 0
}

/**
 * 立项回写（v1.28）：任务完成后，把结果记回选品库那条商品。
 *
 * ## 写哪儿、为什么不写判断
 * 写 `note`（商品备注），不写 `judgment`：**判断是人给的结论**，
 * 机器完成任务不能替人改"可做/观望"。备注是自由文本，追加一行事实最安全。
 *
 * ## 幂等
 * 同一任务完成两次（重复触发级联/手工再点）只写一行：用固定前缀
 * `[立项完成]` + 任务 id 做去重判据，重复调用直接返回 false。
 *
 * ## 只对"由选品库立项的任务"生效
 * 判据是任务 `extra.asin`；普通任务没有这个锚点，这里什么都不做。
 */
export function appendAsinLaunchOutcome(db: DatabaseSync, asin: string, taskId: string, taskTitle: string, at = new Date().toISOString()): boolean {
  const clean = asin.trim().toUpperCase()
  if (clean === '') return false
  const row = db.prepare('SELECT note FROM asin_products WHERE asin = ?').get(clean) as unknown as { note: string | null } | undefined
  if (row === undefined) return false
  const day = at.slice(0, 10)
  const line = `[立项完成 ${day}] ${taskTitle}（任务 ${taskId}）`
  const before = row.note ?? ''
  if (before.includes(`（任务 ${taskId}）`)) return false
  const next = before === '' ? line : `${before}\n${line}`
  db.prepare('UPDATE asin_products SET note = ?, updated_at = ? WHERE asin = ?').run(next, at, clean)
  return true
}

/** 立项路由需要的 ASIN 摘要（只读五个字段 + 判断原文）。 */
export interface AsinTaskSource {
  title: string
  price: number | null
  site: string | null
  verdict: string | null
  score: number | null
  judgmentJson: string | null
}

/**
 * 取一条 ASIN 的立项摘要；不存在返回 undefined。
 *
 * 为什么不复用 `listAsinProducts`：那会把 30 列 + 标签/店铺聚合全查一遍，
 * 而立项只需要拼一段描述。**但 SQL 仍然归仓储**（架构规则 R7）。
 */
export function getAsinTaskSource(db: DatabaseSync, asin: string): AsinTaskSource | undefined {
  const row = db.prepare(
    'SELECT title, price, site, verdict, score, judgment_json FROM asin_products WHERE asin = ?',
  ).get(asin) as unknown as { title: string; price: number | null; site: string | null; verdict: string | null; score: number | null; judgment_json: string | null } | undefined
  if (row === undefined) return undefined
  return {
    title: row.title,
    price: row.price,
    site: row.site,
    verdict: row.verdict,
    score: row.score,
    judgmentJson: row.judgment_json,
  }
}

/**
 * 选品立项的**幂等锚点**（v1.26）：同一个 ASIN 只允许有一条未完成的立项任务。
 *
 * 判据存在 `tasks.extra.asin`（`extra` 列里的键），用 LIKE 直接查：
 * 这里的数据量很小（几十条），没必要为此单开一列或一张关联表；
 * 但**必须**在创建前查一次，否则用户点两下"立项"就会得到两个重复任务。
 *
 * 只匹配未完成/未取消/未归档的任务：上一个立项做完了，允许再立一次
 * （第二轮做同一个品是完全正常的事）。
 *
 * ⚠️ 2026-10-27 批次 4：本函数原先住在 `tasks.ts`（通用任务域）。
 * 它问的是**选品语义** —— `extra.asin` 这个锚点只有"从选品库立项"才会写，
 * 普通任务永远没有。放在通用任务表模块里，等于让任务域替选品域保管判据，
 * 于是"任务表长什么样"和"选品怎么防重"被混成一个问题。
 * 现在归位到选品域；对外仍由 `db/repo.ts` 再导出，调用点不用改。
 */
export function findOpenTaskByAsin(db: DatabaseSync, asin: string): TaskRow | undefined {
  const clean = asin.trim().toUpperCase()
  if (clean === '') return undefined
  const rows = db.prepare(`SELECT * FROM tasks
    WHERE archived = 0 AND status_code NOT IN ('done', 'cancelled')
      AND extra LIKE ?`).all(`%"asin":"${clean}"%`) as unknown as RawTaskRow[]
  return rows.map((row) => parseTask(row, db)).find((task): task is TaskRow => task !== undefined)
}

/**
 * 选品域对「任务已完成」的反应：把立项结果回写成一条商品备注。
 *
 * **为什么是注册而不是被调用**：任务完成发生在任务域内部（级联 / 手工改状态两条路径），
 * 选品域不该被任务域 import（那是 D3 的跨域渗透）。
 * 所以反过来 —— 本模块在加载时订阅一次，任务域完成后广播。
 * 依赖方向变成 `status → hooks ← asin`，两边互不知道对方存在。
 *
 * **为什么注册在模块作用域**：`db/repo.ts` 会再导出本模块，所以只要有仓储，
 * 这个处理器就必然注册；不需要额外初始化调用（少一个"忘记调"的失败模式）。
 *
 * **幂等性**：处理器本身幂等 —— `appendAsinLaunchOutcome` 用
 * `[立项完成] + 任务 id` 判重，热重载导致的重复注册不会写重复行。
 */
onTaskCompleted((db, task, at) => {
  const asin = typeof task.extra.asin === 'string' ? task.extra.asin : ''
  if (asin === '') return
  appendAsinLaunchOutcome(db, asin, task.id, task.title, at)
})
