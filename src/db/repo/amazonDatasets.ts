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
import type { SearchTermAction, SearchTermAnnotation, TrafficRow } from '../../shared/amazonTrafficTools.js'
import { SEARCH_TERM_ACTIONS } from '../../shared/amazonTrafficTools.js'
import { AMAZON_DATASET_KINDS, isAmazonDatasetKind } from '../../amazon/import.js'
import type { AmazonDatasetKind } from '../../amazon/import.js'

/**
 * 种类定义只有一份（`amazon/import.ts`）：仓储、导入校验、CSV 导出都从那里取，
 * 否则"允许的 kind 列表"与"每种 kind 要哪些列"会各自漂移。
 */
export { AMAZON_DATASET_KINDS, isAmazonDatasetKind }
export type { AmazonDatasetKind }

export interface AmazonDatasetRow {
  id: string
  /** 报表类型：复用历史列 `kind_code`（六种取值，对齐 `AdReportKind`）。 */
  kindCode: AmazonDatasetKind
  title: string
  period: string | null
  rows: TrafficRow[]
  annotations: SearchTermAnnotation[]
  /**
   * 报表级 AI 结论（schema 34）：整段 JSON，**整体读、整体替换**。
   * `null` = 还没做过报表级结论（老行也是 null，不伪造空结论）。
   */
  aiSummary: AmazonDatasetSummaryPayload | null
  /**
   * 生成过的 `.univer` 绝对路径（schema 36）。`null` = 还没生成。
   * 生成一次就复用；只有文件不在了或用户明确要求重新生成才重建。
   */
  univerFile: string | null
  sourceCode: string
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 报表级结论的形状由分析口径决定（totals / distribution / topRisks / notes…），
 * 存储层只保证"是一个 JSON 对象"，不在这里锁字段 —— 锁死了口径一改就要迁表。
 * 结构与证据等级约定见 T9 agent SOP 第 5 节。
 */
export type AmazonDatasetSummaryPayload = Record<string, unknown>

/** 列表项：不带整份行数据（大表不塞进列表响应）。 */
export interface AmazonDatasetSummary {
  id: string
  /** 报表类型：直接来自 `kind_code`（六种取值）。 */
  kindCode: string
  title: string
  period: string | null
  rowCount: number
  annotationCount: number
  /** 已生成过 `.univer` 表格的路径；没生成过为 null。 */
  univerFile: string | null
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
  /** schema 34 才有的列；老库迁移后为 NULL。 */
  ai_summary: string | null
  /** schema 36 才有的列；NULL = 还没生成过表格。 */
  univer_file: string | null
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

/**
 * 读取报表级结论：坏 JSON / 不是对象 / 老行 NULL 一律当 `null`。
 *
 * 为什么容错到不抛错：这一列是 AI 写的，人可能手工改坏；
 * 因为一条坏 JSON 让整份报表打不开，比丢一个结论严重得多。
 */
function parseAiSummary(json: string | null): AmazonDatasetSummaryPayload | null {
  if (typeof json !== 'string' || json.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as AmazonDatasetSummaryPayload
  } catch { return null }
}

/**
 * 报表类型只从 `kind_code` 读（那一列早就有，且建了索引）。
 *
 * 遇到不认识的值降级为 `search_term` 而不是抛错：读一份老报表/被手工改过的行，
 * 不该让整个面板打不开。
 */
function kindCodeOf(raw: RawDatasetRow): AmazonDatasetKind {
  return isAmazonDatasetKind(raw.kind_code) ? raw.kind_code : 'search_term'
}

/** `univer_file`：非空字符串才算有；空白/非字符串降级为 null（不伪造路径）。 */
function parseUniverFile(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function toRow(raw: RawDatasetRow): AmazonDatasetRow {
  return {
    id: raw.id,
    kindCode: kindCodeOf(raw),
    title: raw.title,
    period: raw.period,
    rows: parseRows(raw.rows_json),
    annotations: parseAnnotations(raw.annotations_json),
    aiSummary: parseAiSummary(raw.ai_summary ?? null),
    univerFile: parseUniverFile(raw.univer_file),
    sourceCode: raw.source_code,
    sessionId: raw.session_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

export interface CreateAmazonDatasetInput {
  /** **必填**：不允许再默认 `search_term`（缺类型会写错口径，见 `importAmazonDataset`）。 */
  kindCode: AmazonDatasetKind
  title: string
  period?: string | null
  rows: TrafficRow[]
  sourceCode?: string
  sessionId?: string | null
  /** 导入时就带着表格路径（一般由生成接口写回，这里只给需要预置的场景）。 */
  univerFile?: string | null
}

export function createAmazonDataset(db: DatabaseSync, input: CreateAmazonDatasetInput): AmazonDatasetRow {
  if (input.title.trim() === '') throw new Error('title is required')
  if (input.rows.length === 0) throw new Error('rows must not be empty')
  /** 运行期兜底：JS 调用方（测试/脚本）绕过 TS 时也必须显式给 kind。 */
  if (typeof input.kindCode !== 'string' || !isAmazonDatasetKind(input.kindCode)) {
    throw new Error(`kind_code 必填且必须合法（收到 ${String(input.kindCode)}；允许 ${AMAZON_DATASET_KINDS.join(' / ')}）`)
  }
  const requested = input.kindCode
  const at = new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO amazon_datasets
       (id, kind_code, title, period, rows_json, annotations_json, source_code, session_id, univer_file, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    requested,
    input.title.trim(),
    input.period ?? null,
    JSON.stringify(input.rows),
    input.sourceCode ?? 'paste',
    input.sessionId ?? null,
    parseUniverFile(input.univerFile ?? null),
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
    kindCode: kindCodeOf(raw),
    title: raw.title,
    period: raw.period,
    rowCount: parseRows(raw.rows_json).length,
    annotationCount: parseAnnotations(raw.annotations_json).length,
    univerFile: parseUniverFile(raw.univer_file),
    sourceCode: raw.source_code,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }))
}

/**
 * 找一份「同一类报表 + 同一周期 + 行数相同」的既有数据集。
 *
 * 背景（2026-10-24 真实数据）：用户库里 3 份 `搜索词报表` 行数完全一样（1243 行），
 * 是同一天三次重复导入 —— 面板列表因此看起来"怎么导了这么多份"。
 * 导入时命中这个签名就返回**既有那份**（前端提示"这份已经导过了"），不新增行。
 *
 * 只比 kind_code / period / 行数，不比标题：标题带时间戳（`... 13:59:09`），
 * 拿它做签名等于永远不命中。周期未知（period 为 null）时不判重 ——
 * 两份都不带周期的报表可能是不同批数据，静默合并比重复更危险。
 */
export function findDuplicateAmazonDataset(
  db: DatabaseSync,
  kindCode: AmazonDatasetKind,
  period: string | null,
  rowCount: number,
): AmazonDatasetRow | undefined {
  if (period === null) return undefined
  const rows = db.prepare(
    'SELECT * FROM amazon_datasets WHERE kind_code = ? AND period = ? ORDER BY created_at DESC, rowid DESC LIMIT 20',
  ).all(kindCode, period) as unknown as RawDatasetRow[]
  for (const raw of rows) {
    if (parseRows(raw.rows_json).length === rowCount) return toRow(raw)
  }
  return undefined
}

/**
 * 记录/清除该数据集生成过的 `.univer` 表格路径。
 *
 * 只写 `univer_file`：生成表格不该刷新 `updated_at` 之外的东西，
 * 更不该动 `rows_json` / `annotations_json`（否则"重新生成表格"会看起来像"报表变了"）。
 */
export function setAmazonDatasetUniverFile(db: DatabaseSync, id: string, file: string | null): AmazonDatasetRow {
  const dataset = getAmazonDataset(db, id)
  if (dataset === undefined) throw new Error('dataset not found')
  const at = new Date().toISOString()
  db.prepare('UPDATE amazon_datasets SET univer_file = ?, updated_at = ? WHERE id = ?')
    .run(parseUniverFile(file), at, id)
  const updated = getAmazonDataset(db, id)
  if (updated === undefined) throw new Error('dataset update failed')
  return updated
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
  /**
   * kind 守卫：词级建议只属于搜索词报表。
   * 没有这道守卫，agent 拿 campaign 的 dataset_id 也能写回搜索词建议 —— 合并后最难查的旁路。
   */
  if (dataset.kindCode !== 'search_term') {
    throw new Error(`kind_mismatch：dataset ${id} 是 ${dataset.kindCode}，只有 search_term 可以写回词级建议`)
  }
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

/**
 * 写回报表级结论（**整份替换**，不是 merge）。
 *
 * 为什么整份替换：结论里 `totals` / `distribution` / `topRisks` 是**互相自洽的一组数**
 * （否词条数、否词花费、总额都来自同一次分析）。逐字段 merge 会拼出"上一次的条数 +
 * 这一次的花费"这种不可能同时成立的组合。
 *
 * `null` = 清空结论（回到"还没做过报表级结论"），与老行语义一致。
 * 只动 `ai_summary`，不碰 `rows_json` / `annotations_json`。
 */
export function saveAmazonDatasetSummary(
  db: DatabaseSync,
  id: string,
  summary: AmazonDatasetSummaryPayload | null,
): AmazonDatasetRow {
  const dataset = getAmazonDataset(db, id)
  if (dataset === undefined) throw new Error('dataset not found')
  /** 同 `saveSearchTermReview`：报表级结论也只属于搜索词。 */
  if (dataset.kindCode !== 'search_term') {
    throw new Error(`kind_mismatch：dataset ${id} 是 ${dataset.kindCode}，只有 search_term 可以写回报表级结论`)
  }
  if (summary !== null && (typeof summary !== 'object' || Array.isArray(summary))) {
    throw new Error('summary 必须是 JSON 对象或 null')
  }
  const at = new Date().toISOString()
  db.prepare('UPDATE amazon_datasets SET ai_summary = ?, updated_at = ? WHERE id = ?')
    .run(summary === null ? null : JSON.stringify(summary), at, id)
  const updated = getAmazonDataset(db, id)
  if (updated === undefined) throw new Error('dataset update failed')
  return updated
}

export function deleteAmazonDataset(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM amazon_datasets WHERE id = ?').run(id)
  return Number(result.changes) > 0
}
