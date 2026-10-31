/**
 * Amazon 报表数据集的**种类定义 + 导入校验 + CSV 序列化**（纯函数，宿主侧共用）。
 *
 * 位置说明：本模块只被宿主（路由与仓储）使用，按 architecture R1 不放 `shared/`；
 * 客户端若将来也要复用，再评估抽到双端契约，而不是先塞回 shared。
 *
 * ## 为什么要有这一份
 * 六个 `kind` 各自要求的列不同（投放要有匹配类型、广告位报表要有广告位、份额报表要有份额…），
 * 如果校验散在路由里、CSV 表头散在页面里，就必然出现「导入说成功、表格里缺一列」。
 * 这里一处定义：**校验用的必需列**与**导出用的列顺序**都从 `AMAZON_KIND_COLUMNS` 取。
 *
 * ## 列名口径
 * 表头直接沿用亚马逊中文导出的常用叫法（与 `amazonTrafficTools.ts` 的别名表一致），
 * 数字列**原样写数值**（不加引号、不加货币符号）—— 否则 Univer 会把它们当文本，图表算不了。
 */

import type { TrafficRow } from '../shared/amazonTrafficTools.js'

/** 六种报表类型（与数据库 `amazon_datasets.kind` / `kind_code` 同一套 code）。 */
export const AMAZON_DATASET_KINDS = ['search_term', 'targeting', 'campaign', 'placement', 'budget', 'impression_share'] as const
export type AmazonDatasetKind = typeof AMAZON_DATASET_KINDS[number]

export function isAmazonDatasetKind(value: unknown): value is AmazonDatasetKind {
  return typeof value === 'string' && (AMAZON_DATASET_KINDS as readonly string[]).includes(value)
}

/** 给用户看的中文名（用于缺省标题、错误文案）。 */
export const AMAZON_KIND_LABELS: Record<AmazonDatasetKind, string> = {
  search_term: '搜索词报表',
  targeting: '投放报表',
  campaign: '广告活动报表',
  placement: '广告位报表',
  budget: '预算报表',
  impression_share: '曝光份额报表',
}

/** 行形状：核心六列必有，其余按报表类型可选。 */
export interface AmazonImportRow extends TrafficRow {
  campaign?: string | null
  adGroup?: string | null
  matchType?: string | null
  budget?: number | null
  status?: string | null
  placement?: string | null
  /** 搜索词曝光份额（0–1）。 */
  share?: number | null
}

interface ColumnSpec {
  readonly field: keyof AmazonImportRow
  readonly label: string
}

/** 核心指标列：所有 kind 都要求（与 `TrafficRow` 一一对应）。 */
const CORE_COLUMNS: readonly ColumnSpec[] = [
  { field: 'keyword', label: '搜索词' },
  { field: 'impressions', label: '曝光' },
  { field: 'clicks', label: '点击' },
  { field: 'orders', label: '订单' },
  { field: 'spend', label: '花费' },
  { field: 'sales', label: '销售额' },
]

/** 每种 kind 额外**必须**有的列（缺了就是"这份报表根本不是这个类型"）。 */
const EXTRA_REQUIRED: Record<AmazonDatasetKind, readonly ColumnSpec[]> = {
  search_term: [],
  targeting: [{ field: 'matchType', label: '匹配类型' }],
  campaign: [],
  placement: [{ field: 'placement', label: '广告位' }],
  budget: [{ field: 'budget', label: '预算' }],
  impression_share: [{ field: 'share', label: '曝光份额' }],
}

/** 每种 kind 生成表格时的列（顺序即表头顺序）。 */
const CSV_EXTRA: Record<AmazonDatasetKind, readonly ColumnSpec[]> = {
  search_term: [],
  targeting: [
    { field: 'campaign', label: '广告活动' },
    { field: 'adGroup', label: '广告组' },
    { field: 'matchType', label: '匹配类型' },
  ],
  campaign: [{ field: 'campaign', label: '广告活动' }],
  placement: [{ field: 'placement', label: '广告位' }],
  budget: [{ field: 'budget', label: '预算' }],
  impression_share: [{ field: 'share', label: '曝光份额' }],
}

export interface AmazonKindColumns {
  readonly kind: AmazonDatasetKind
  readonly label: string
  /** 必需列（核心六列 + 该 kind 的额外列）。 */
  readonly required: readonly ColumnSpec[]
  /** CSV 导出列（必需列 + 该 kind 的可展示列）。 */
  readonly csv: readonly ColumnSpec[]
}

function kindColumns(kind: AmazonDatasetKind): AmazonKindColumns {
  return {
    kind,
    label: AMAZON_KIND_LABELS[kind],
    required: [...CORE_COLUMNS, ...EXTRA_REQUIRED[kind]],
    csv: [...CORE_COLUMNS, ...CSV_EXTRA[kind]],
  }
}

export const AMAZON_KIND_COLUMNS: Record<AmazonDatasetKind, AmazonKindColumns> = {
  search_term: kindColumns('search_term'),
  targeting: kindColumns('targeting'),
  campaign: kindColumns('campaign'),
  placement: kindColumns('placement'),
  budget: kindColumns('budget'),
  impression_share: kindColumns('impression_share'),
}

export type AmazonImportValidation =
  | { readonly ok: true; readonly rows: AmazonImportRow[] }
  | {
    readonly ok: false
    /** 给人看的中文原因（能直接放进 400 响应）。 */
    readonly message: string
    /** 缺的列名（只有"缺列"这一类才有，便于前端高亮）。 */
    readonly missing: string[]
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数字列：必须是非负有限数（不把 `"1,234"` 这种字符串悄悄转成 0）。 */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 文本列：去空白；空串与 null 都按"没有"处理。 */
function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 校验一份导入行。
 *
 * 两类失败分开报：
 * - **缺列**：所有行都没有这个字段（说明类型选错/报表没这一列）→ 列出缺哪几列；
 * - **坏行**：字段在、但值不合法（关键词为空、指标是字符串/负数）→ 指明第几行的哪一列。
 *
 * 不做"能读多少存多少"：半份数据比报错更难查。
 */
export function validateAmazonImportRows(kind: AmazonDatasetKind, raw: unknown): AmazonImportValidation {
  const columns = AMAZON_KIND_COLUMNS[kind]
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: `${columns.label}至少要有一行数据`, missing: [] }
  }
  const records = raw.filter(isRecord)
  if (records.length !== raw.length) {
    return { ok: false, message: 'rows 中存在不是对象的数据行', missing: [] }
  }

  /** 缺列：所有行都不带这个字段。 */
  const missing = columns.required
    .filter((column) => records.every((row) => row[column.field] === undefined))
    .map((column) => column.label)
  if (missing.length > 0) {
    return { ok: false, message: `缺少必需列：${missing.join('、')}`, missing }
  }

  const rows: AmazonImportRow[] = []
  for (const [index, record] of records.entries()) {
    const line = index + 1
    const keyword = readText(record.keyword)
    if (keyword === null) return { ok: false, message: `第 ${line} 行的「搜索词」为空`, missing: [] }

    const numbers: number[] = []
    for (const column of CORE_COLUMNS.filter((item) => item.field !== 'keyword')) {
      const value = readNumber(record[column.field])
      if (value === null) return { ok: false, message: `第 ${line} 行的「${column.label}」不是非负数字`, missing: [] }
      numbers.push(value)
    }
    const [impressions, clicks, orders, spend, sales] = numbers as [number, number, number, number, number]

    const extra: { budget?: number; share?: number; matchType?: string; placement?: string } = {}
    for (const column of EXTRA_REQUIRED[kind]) {
      if (column.field === 'budget') {
        const value = readNumber(record.budget)
        if (value === null) return { ok: false, message: `第 ${line} 行的「预算」不是非负数字`, missing: [] }
        extra.budget = value
      } else if (column.field === 'share') {
        const value = typeof record.share === 'number' && Number.isFinite(record.share) ? record.share : null
        if (value === null || value < 0 || value > 1) {
          return { ok: false, message: `第 ${line} 行的「曝光份额」必须是 0–1 之间的数字（例如 0.125）`, missing: [] }
        }
        extra.share = value
      } else if (column.field === 'matchType' || column.field === 'placement') {
        const value = readText(record[column.field])
        if (value === null) return { ok: false, message: `第 ${line} 行的「${column.label}」为空`, missing: [] }
        extra[column.field] = value
      }
    }

    /** 可选列：带上就校验类型，不带就是 null（不猜）。 */
    const optionalText: Partial<AmazonImportRow> = {
      campaign: readText(record.campaign),
      adGroup: readText(record.adGroup),
      status: readText(record.status),
      placement: readText(record.placement),
    }
    const budget = readNumber(record.budget)
    const share = typeof record.share === 'number' && Number.isFinite(record.share) && record.share >= 0 && record.share <= 1
      ? record.share
      : null

    rows.push({
      keyword,
      impressions, clicks, orders, spend, sales,
      campaign: optionalText.campaign ?? null,
      adGroup: optionalText.adGroup ?? null,
      matchType: extra.matchType ?? readText(record.matchType),
      budget: extra.budget ?? budget,
      status: optionalText.status ?? null,
      placement: extra.placement ?? optionalText.placement ?? null,
      share: extra.share ?? share,
    })
  }
  return { ok: true, rows }
}

/** CSV 单元格：含分隔符/引号/换行才加引号（数字保持裸值，Univer 才会当数值读）。 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? String(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 把一份数据集的行序列化成 CSV（首行表头，UTF-8、不带 BOM）。
 *
 * 列顺序来自 `AMAZON_KIND_COLUMNS[kind].csv`，所以"校验要什么列"和"表格里有什么列"
 * 永远是同一份定义。数字列写裸值 —— 加了引号 Univer 会当文本，图表/公式就用不了。
 */
export function datasetRowsToCsv(kind: AmazonDatasetKind, rows: readonly AmazonImportRow[]): string {
  const columns = AMAZON_KIND_COLUMNS[kind].csv
  const lines = [columns.map((column) => csvCell(column.label)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.field] ?? null)).join(','))
  }
  return `${lines.join('\n')}\n`
}
