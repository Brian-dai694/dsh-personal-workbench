/**
 * Amazon 报表数据集域（v1.18）：把用户在面板里导入的搜索词报表落库，
 * 供 UI 与 `workbench_read_search_terms` / `workbench_save_search_term_review` 双向读写。
 *
 * 边界（与 SOP 一致）：
 * - 这里只存**用户导入的报表原值**与 **AI 写回的建议**，不产生任何账户数据；
 * - 行数据按原样 JSON 存，不在这里做指标计算（计算是纯函数 `analyseTraffic` 的事），
 *   避免"存一份算出来的 CTR，后来改了算法就对不上"；
 * - 建议动作是封闭枚举，非法值在写入前拒绝（不静默落库成未知动作）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SearchTermAction, SearchTermAnnotation, TrafficRow } from '../../client/amazonTrafficTools.js'
import { SEARCH_TERM_ACTIONS } from '../../client/amazonTrafficTools.js'

export const AMAZON_DATASET_KINDS = ['search_term'] as const
export type AmazonDatasetKind = typeof AMAZON_DATASET_KINDS[number]

export interface AmazonDatasetRow {
  id: string
  kindCode: AmazonDatasetKind
  title: string
  period: string | null
  rows: TrafficRow[]
  annotations: SearchTermAnnotation[]
  sourceCode: string
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

/** 列表项：不带整份行数据（大表不塞进列表响应）。 */
export interface AmazonDatasetSummary {
  id: string
  kindCode: string
  title: string
  period: string | null
  rowCount: number
  annotationCount: number
  sourceCode: string
  createdAt: string
  updatedAt: string
}

interface RawDatasetRow {
  id: string
  kind_code: string
  title: string
  period: string | null
  rows_json: string
  annotations_json: string
  source_code: string
  session_id: string | null
  created_at: string
  updated_at: string
}

function parseRows(json: string): TrafficRow[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is TrafficRow => typeof item === 'object' && item !== null
      && typeof (item as TrafficRow).keyword === 'string')
  } catch { return [] }
}

function parseAnnotations(json: string): SearchTermAnnotation[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is SearchTermAnnotation => typeof item === 'object' && item !== null
      && typeof (item as SearchTermAnnotation).keyword === 'string'
      && SEARCH_TERM_ACTIONS.includes((item as SearchTermAnnotation).action))
  } catch { return [] }
}

function toRow(raw: RawDatasetRow): AmazonDatasetRow {
  return {
    id: raw.id,
    kindCode: raw.kind_code as AmazonDatasetKind,
    title: raw.title,
    period: raw.period,
    rows: parseRows(raw.rows_json),
    annotations: parseAnnotations(raw.annotations_json),
    sourceCode: raw.source_code,
    sessionId: raw.session_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

export interface CreateAmazonDatasetInput {
  kindCode?: AmazonDatasetKind
  title: string
  period?: string | null
  rows: TrafficRow[]
  sourceCode?: string
  sessionId?: string | null
}

export function createAmazonDataset(db: DatabaseSync, input: CreateAmazonDatasetInput): AmazonDatasetRow {
  if (input.title.trim() === '') throw new Error('title is required')
  if (input.rows.length === 0) throw new Error('rows must not be empty')
  const at = new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO amazon_datasets (id, kind_code, title, period, rows_json, annotations_json, source_code, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(
    id,
    input.kindCode ?? 'search_term',
    input.title.trim(),
    input.period ?? null,
    JSON.stringify(input.rows),
    input.sourceCode ?? 'paste',
    input.sessionId ?? null,
    at,
    at,
  )
  const created = getAmazonDataset(db, id)
  if (created === undefined) throw new Error('dataset insert failed')
  return created
}

export function getAmazonDataset(db: DatabaseSync, id: string): AmazonDatasetRow | undefined {
  const raw = db.prepare('SELECT * FROM amazon_datasets WHERE id = ?').get(id) as RawDatasetRow | undefined
  return raw === undefined ? undefined : toRow(raw)
}

/**
 * 最近一份数据集（面板打开时默认读它；agent 不传 id 时也读它）。
 *
 * 排序必须带 `rowid`：同一毫秒内导入两份时 `created_at` 完全相同，
 * 只按时间排会让"最近一份"变成随机结果（测试里当场复现过）。
 */
export function getLatestAmazonDataset(db: DatabaseSync, kindCode = 'search_term'): AmazonDatasetRow | undefined {
  const raw = db.prepare('SELECT * FROM amazon_datasets WHERE kind_code = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(kindCode) as RawDatasetRow | undefined
  return raw === undefined ? undefined : toRow(raw)
}

export function listAmazonDatasets(db: DatabaseSync, kindCode = 'search_term'): AmazonDatasetSummary[] {
  const rows = db.prepare('SELECT * FROM amazon_datasets WHERE kind_code = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(kindCode) as unknown as RawDatasetRow[]
  return rows.map((raw) => ({
    id: raw.id,
    kindCode: raw.kind_code,
    title: raw.title,
    period: raw.period,
    rowCount: parseRows(raw.rows_json).length,
    annotationCount: parseAnnotations(raw.annotations_json).length,
    sourceCode: raw.source_code,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }))
}

export interface SearchTermReviewInput {
  keyword: string
  action: string
  reason?: string
  evidence?: string
}

/**
 * 写回建议（**整份替换**）：agent 一次分析给出完整清单，比逐条 merge 更可核对；
 * 同关键词重复出现时后者覆盖前者（避免同一词给出互相矛盾的两条建议）。
 */
export function saveSearchTermReview(db: DatabaseSync, id: string, reviews: SearchTermReviewInput[]): AmazonDatasetRow {
  const dataset = getAmazonDataset(db, id)
  if (dataset === undefined) throw new Error('dataset not found')
  if (reviews.length === 0) throw new Error('reviews must not be empty')
  const byKeyword = new Map<string, SearchTermAnnotation>()
  const at = new Date().toISOString()
  for (const review of reviews) {
    const keyword = review.keyword.trim()
    if (keyword === '') throw new Error('review.keyword is required')
    if (!SEARCH_TERM_ACTIONS.includes(review.action as SearchTermAction)) {
      throw new Error(`review.action 非法：${review.action}（允许 ${SEARCH_TERM_ACTIONS.join(' / ')}）`)
    }
    byKeyword.set(keyword, {
      keyword,
      action: review.action as SearchTermAction,
      reason: (review.reason ?? '').trim(),
      evidence: review.evidence === 'observed' || review.evidence === 'unknown' ? review.evidence : 'derived',
      updatedAt: at,
    })
  }
  db.prepare('UPDATE amazon_datasets SET annotations_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify([...byKeyword.values()]), at, id)
  const updated = getAmazonDataset(db, id)
  if (updated === undefined) throw new Error('dataset update failed')
  return updated
}

export function deleteAmazonDataset(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM amazon_datasets WHERE id = ?').run(id)
  return Number(result.changes) > 0
}
