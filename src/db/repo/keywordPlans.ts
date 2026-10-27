/**
 * 关键词库仓储（2026-10-24）：把「关键词规划」的生成结果落库。
 *
 * ## 三条纪律
 * 1. **不编造搜索量**：这里只存我方**生成**的投放候选（关键词 + 匹配方式 + 活动路由 + 理由），
 *    不存任何"月搜索量/竞争度"数字 —— 那种数据只能来自 ABA/卖家精灵，且必须标 observed。
 * 2. **行是快照**：`rows_json` 原样保存生成时的结果；生成规则将来改了，历史方案不被改写。
 * 3. **ASIN 关联是弱关联**：选品库删了 ASIN，方案照样留着（`asin` 只是可空的线索字段），
 *    不建外键 —— 否则一次选品清理会连带删掉用户辛苦整理的关键词方案。
 */
import type { DatabaseSync } from 'node:sqlite'

export type KeywordMatchCode = 'exact' | 'phrase' | 'broad'

export interface KeywordPlanRow {
  keyword: string
  match: KeywordMatchCode
  campaign: string
  rationale: string
}

export interface KeywordPlan {
  id: string
  title: string
  seed: string
  modifiers: string[]
  matchTypes: KeywordMatchCode[]
  negatives: string[]
  rows: KeywordPlanRow[]
  /** 关联的选品库 ASIN（可空；弱关联，不做外键）。 */
  asin: string | null
  note: string
  createdAt: string
  updatedAt: string
}

/** 列表用的摘要：不带 rows（一份方案可能几百行，列表不需要）。 */
export interface KeywordPlanSummary {
  id: string
  title: string
  seed: string
  asin: string | null
  rowCount: number
  negativeCount: number
  createdAt: string
  updatedAt: string
}

export interface KeywordPlanInput {
  title: string
  seed?: string
  modifiers?: string[]
  matchTypes?: KeywordMatchCode[]
  negatives?: string[]
  rows?: KeywordPlanRow[]
  asin?: string | null
  note?: string
}

const MATCH_CODES: readonly KeywordMatchCode[] = ['exact', 'phrase', 'broad']

interface RawRow {
  id: string
  title: string
  seed: string
  modifiers_json: string
  match_types_json: string
  negatives_json: string
  rows_json: string
  asin: string | null
  note: string
  created_at: string
  updated_at: string
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/** 只接受封闭枚举；脏值（大小写/拼错）一律丢弃，不把非法匹配方式写进库。 */
function normalizeMatches(value: unknown): KeywordMatchCode[] {
  if (!Array.isArray(value)) return [...MATCH_CODES]
  const picked = value.filter((item): item is KeywordMatchCode => typeof item === 'string' && (MATCH_CODES as readonly string[]).includes(item))
  return picked.length === 0 ? [...MATCH_CODES] : [...new Set(picked)]
}

function normalizeWords(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== ''))]
}

function normalizeRows(value: unknown): KeywordPlanRow[] {
  if (!Array.isArray(value)) return []
  const rows: KeywordPlanRow[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const keyword = typeof row.keyword === 'string' ? row.keyword.trim().toLowerCase() : ''
    const match = typeof row.match === 'string' && (MATCH_CODES as readonly string[]).includes(row.match) ? row.match as KeywordMatchCode : null
    if (keyword === '' || match === null) continue
    rows.push({
      keyword,
      match,
      campaign: typeof row.campaign === 'string' ? row.campaign : '',
      rationale: typeof row.rationale === 'string' ? row.rationale : '',
    })
  }
  return rows
}

function toPlan(row: RawRow): KeywordPlan {
  return {
    id: row.id,
    title: row.title,
    seed: row.seed,
    modifiers: parseJson<string[]>(row.modifiers_json, []),
    matchTypes: normalizeMatches(parseJson<unknown>(row.match_types_json, [])),
    negatives: parseJson<string[]>(row.negatives_json, []),
    rows: parseJson<KeywordPlanRow[]>(row.rows_json, []),
    asin: row.asin,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listKeywordPlans(db: DatabaseSync): KeywordPlanSummary[] {
  const rows = db.prepare(`SELECT id, title, seed, modifiers_json, match_types_json, negatives_json, rows_json, asin, note, created_at, updated_at
    FROM keyword_plans ORDER BY updated_at DESC`).all() as unknown as RawRow[]
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    seed: row.seed,
    asin: row.asin,
    rowCount: parseJson<unknown[]>(row.rows_json, []).length,
    negativeCount: parseJson<unknown[]>(row.negatives_json, []).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export function getKeywordPlan(db: DatabaseSync, id: string): KeywordPlan | null {
  const row = db.prepare('SELECT * FROM keyword_plans WHERE id = ?').get(id) as unknown as RawRow | undefined
  return row === undefined ? null : toPlan(row)
}

export function createKeywordPlan(db: DatabaseSync, input: KeywordPlanInput, at = new Date().toISOString()): KeywordPlan {
  const title = input.title.trim()
  if (title === '') throw new Error('方案标题不能为空')
  const plan: KeywordPlan = {
    id: `kwp-${at.replace(/[^0-9]/g, '')}-${Math.floor(Math.random() * 100000)}`,
    title,
    seed: (input.seed ?? '').trim(),
    modifiers: normalizeWords(input.modifiers),
    matchTypes: normalizeMatches(input.matchTypes),
    negatives: normalizeWords(input.negatives),
    rows: normalizeRows(input.rows),
    asin: typeof input.asin === 'string' && input.asin.trim() !== '' ? input.asin.trim().toUpperCase() : null,
    note: input.note ?? '',
    createdAt: at,
    updatedAt: at,
  }
  db.prepare(`INSERT INTO keyword_plans (id, title, seed, modifiers_json, match_types_json, negatives_json, rows_json, asin, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    plan.id, plan.title, plan.seed, JSON.stringify(plan.modifiers), JSON.stringify(plan.matchTypes),
    JSON.stringify(plan.negatives), JSON.stringify(plan.rows), plan.asin, plan.note, plan.createdAt, plan.updatedAt,
  )
  return plan
}

/**
 * 局部更新：**只有显式给出的字段才改**。
 *
 * 为什么不做"整份替换"：界面上改标题/加一个否定词时不该把 `rows` 一起重算 ——
 * 那会让"我只是想改个名字"变成"方案内容被当前输入框覆盖"。显式传数组才替换数组。
 */
export function updateKeywordPlan(db: DatabaseSync, id: string, patch: Partial<KeywordPlanInput>, at = new Date().toISOString()): KeywordPlan | null {
  const existing = getKeywordPlan(db, id)
  if (existing === null) return null
  const next: KeywordPlan = {
    ...existing,
    title: patch.title === undefined ? existing.title : patch.title.trim(),
    seed: patch.seed === undefined ? existing.seed : patch.seed.trim(),
    modifiers: patch.modifiers === undefined ? existing.modifiers : normalizeWords(patch.modifiers),
    matchTypes: patch.matchTypes === undefined ? existing.matchTypes : normalizeMatches(patch.matchTypes),
    negatives: patch.negatives === undefined ? existing.negatives : normalizeWords(patch.negatives),
    rows: patch.rows === undefined ? existing.rows : normalizeRows(patch.rows),
    asin: patch.asin === undefined ? existing.asin : (typeof patch.asin === 'string' && patch.asin.trim() !== '' ? patch.asin.trim().toUpperCase() : null),
    note: patch.note === undefined ? existing.note : patch.note,
    updatedAt: at,
  }
  if (next.title === '') return null
  db.prepare(`UPDATE keyword_plans SET title = ?, seed = ?, modifiers_json = ?, match_types_json = ?, negatives_json = ?,
    rows_json = ?, asin = ?, note = ?, updated_at = ? WHERE id = ?`).run(
    next.title, next.seed, JSON.stringify(next.modifiers), JSON.stringify(next.matchTypes), JSON.stringify(next.negatives),
    JSON.stringify(next.rows), next.asin, next.note, next.updatedAt, id,
  )
  return next
}

export function deleteKeywordPlan(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM keyword_plans WHERE id = ?').run(id).changes > 0
}
