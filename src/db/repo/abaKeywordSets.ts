/**
 * ABA 词表仓储（migration 33）。
 *
 * 存**市场原始证据**（排名/搜索量/购买率/点击集中度）+ **回填结论**（worth/建议匹配/理由）。
 * 分层与判垄断**不存**：它们由 `shared/abaKeywordTable.ts` 现算 —— 阈值改了以后
 * 老数据不该继续显示旧分层（和库存快照同一条纪律）。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ABA_ANNOTATION_ACTIONS, sanitizeAbaRows,
  type AbaAnnotation, type AbaAnnotationAction, type AbaKeywordRow,
} from '../../shared/abaKeywordTable.js'

export interface AbaKeywordSet {
  id: string
  title: string
  period: string | null
  rows: AbaKeywordRow[]
  annotations: AbaAnnotation[]
  sourceCode: string
  createdAt: string
  updatedAt: string
}

export interface AbaKeywordSetSummary {
  id: string
  title: string
  period: string | null
  rowCount: number
  annotationCount: number
  /** 该表里被标成"不值得正面投"的词数（含回填），列表页一眼看出质量。 */
  createdAt: string
  updatedAt: string
}

interface RawRow {
  id: string
  title: string
  period: string | null
  rows_json: string
  annotations_json: string
  source_code: string
  created_at: string
  updated_at: string
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function normalizeAnnotations(raw: unknown): AbaAnnotation[] {
  if (!Array.isArray(raw)) return []
  const out: AbaAnnotation[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const keyword = typeof row.keyword === 'string' ? row.keyword.trim() : ''
    if (keyword === '' || seen.has(keyword.toLowerCase())) continue
    const worth = typeof row.worth === 'string' && (ABA_ANNOTATION_ACTIONS as readonly string[]).includes(row.worth)
      ? row.worth as AbaAnnotationAction
      : null
    if (worth === null) continue
    seen.add(keyword.toLowerCase())
    const match = row.suggestedMatch === 'exact' || row.suggestedMatch === 'phrase' || row.suggestedMatch === 'broad' ? row.suggestedMatch : null
    const evidence = row.evidence === 'observed' || row.evidence === 'derived' ? row.evidence : 'unknown'
    out.push({
      keyword,
      worth,
      suggestedMatch: match,
      reason: typeof row.reason === 'string' ? row.reason : '',
      evidence,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
    })
  }
  return out
}

function toSet(row: RawRow): AbaKeywordSet {
  return {
    id: row.id,
    title: row.title,
    period: row.period,
    rows: sanitizeAbaRows(parseJson<unknown>(row.rows_json, [])),
    annotations: normalizeAnnotations(parseJson<unknown>(row.annotations_json, [])),
    sourceCode: row.source_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listAbaKeywordSets(db: DatabaseSync): AbaKeywordSetSummary[] {
  const rows = db.prepare('SELECT * FROM aba_keyword_sets ORDER BY created_at DESC').all() as unknown as RawRow[]
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    period: row.period,
    rowCount: parseJson<unknown[]>(row.rows_json, []).length,
    annotationCount: parseJson<unknown[]>(row.annotations_json, []).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function getAbaKeywordSet(db: DatabaseSync, id: string): AbaKeywordSet | null {
  const row = db.prepare('SELECT * FROM aba_keyword_sets WHERE id = ?').get(id) as unknown as RawRow | undefined
  return row === undefined ? null : toSet(row)
}

export function createAbaKeywordSet(db: DatabaseSync, input: { title: string; period?: string | null; rows: unknown; sourceCode?: string }, at = new Date().toISOString()): AbaKeywordSet {
  const title = input.title.trim()
  if (title === '') throw new Error('词表标题不能为空')
  const rows = sanitizeAbaRows(input.rows)
  if (rows.length === 0) throw new Error('没有可用数据行（至少要有「关键词」列）')
  const set: AbaKeywordSet = {
    id: `aba-${randomUUID().slice(0, 8)}`,
    title,
    period: typeof input.period === 'string' && input.period.trim() !== '' ? input.period.trim() : null,
    rows,
    annotations: [],
    sourceCode: input.sourceCode ?? 'import',
    createdAt: at,
    updatedAt: at,
  }
  db.prepare(`INSERT INTO aba_keyword_sets (id, title, period, rows_json, annotations_json, source_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    set.id, set.title, set.period, JSON.stringify(set.rows), JSON.stringify(set.annotations), set.sourceCode, set.createdAt, set.updatedAt,
  )
  return set
}

/**
 * 写入回填（**按关键词整份替换**，未提及的保留）。
 *
 * 为什么是"合并"而不是"整表替换"：DSH 一次可能只回填十几条，
 * 整表替换会把人工之前标过的其它词全清掉。
 */
export function setAbaAnnotations(db: DatabaseSync, id: string, incoming: unknown, at = new Date().toISOString()): AbaKeywordSet | null {
  const existing = getAbaKeywordSet(db, id)
  if (existing === null) return null
  const fresh = normalizeAnnotations(incoming).map((item) => ({ ...item, updatedAt: at }))
  const byKeyword = new Map(existing.annotations.map((item) => [item.keyword.toLowerCase(), item]))
  for (const item of fresh) byKeyword.set(item.keyword.toLowerCase(), item)
  const merged = [...byKeyword.values()]
  db.prepare('UPDATE aba_keyword_sets SET annotations_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), at, id)
  return { ...existing, annotations: merged, updatedAt: at }
}

export function deleteAbaKeywordSet(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM aba_keyword_sets WHERE id = ?').run(id).changes > 0
}
