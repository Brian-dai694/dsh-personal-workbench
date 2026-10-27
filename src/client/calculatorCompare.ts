/**
 * 测算方案的**对比逻辑**（纯函数）。
 *
 * 为什么要有它：单看一份参数只能回答"这个假设保不保本"；真正要决定的是
 * 「三个定价 / 两个采购成本里挑哪个」。对比表把同一款货的多份假设排在一起，
 * 并且**明确标出差在哪个字段**（否则用户只看到四个不同结果，不知道是谁导致的）。
 *
 * 三条纪律：
 * 1. **结论现算**：每列都调 `calculateAmazonEconomics`，不使用任何存下来的旧结论。
 * 2. **非法输入照样列出**：`valid=false` 的方案保留在表里并显示错误数，
 *    静默隐藏会让用户以为"我存的那份不见了"。
 * 3. **差值只报真实差异**：`diffCalculatorInputs` 只报数值不同的字段；
 *    两个方案完全相同时返回空数组，界面据此显示"参数相同"。
 */
import { calculateAmazonEconomics, type AmazonCalculatorInput, type AmazonCalculatorResult } from './amazonCalculator.js'
import {
  CALCULATOR_FIELD_LABELS, diffCalculatorInputs,
  type CalculatorInputRecord,
} from '../shared/calculatorScenario.js'

export interface ComparisonColumn {
  id: string
  name: string
  asin: string | null
  note: string
  /** 与默认值合并后的完整输入（计算用）。 */
  input: AmazonCalculatorInput
  result: AmazonCalculatorResult
  /** 相对**第一列**改了哪些字段（第一列恒为空数组）。 */
  diffs: Array<{ field: keyof typeof CALCULATOR_FIELD_LABELS; from: number | null; to: number | null }>
  updatedAt: string
}

export interface ComparisonTable {
  columns: ComparisonColumn[]
  /** 有列非法时的提示（哪几列、错在哪），交给界面显示。 */
  warnings: string[]
}

/**
 * @param scenarios 待对比的方案（顺序即列顺序；第一列作为比较基准）
 * @param defaults 缺字段时回落的默认值（与界面共用同一份 DEFAULTS）
 */
export function buildComparison(
  scenarios: ReadonlyArray<{ id: string; name: string; input: CalculatorInputRecord; note?: string; asin?: string | null; updatedAt?: string }>,
  defaults: AmazonCalculatorInput,
): ComparisonTable {
  const warnings: string[] = []
  const columns: ComparisonColumn[] = []
  let baseline: CalculatorInputRecord | null = null
  for (const scenario of scenarios) {
    const merged: AmazonCalculatorInput = { ...defaults, ...scenario.input }
    const result = calculateAmazonEconomics(merged)
    if (!result.valid) warnings.push(`「${scenario.name}」参数不合法：${result.errors.slice(0, 2).join('；')}`)
    const diffs = baseline === null ? [] : diffCalculatorInputs(baseline, scenario.input)
    if (baseline === null) baseline = scenario.input
    columns.push({
      id: scenario.id,
      name: scenario.name,
      asin: scenario.asin ?? null,
      note: scenario.note ?? '',
      input: merged,
      result,
      diffs,
      updatedAt: scenario.updatedAt ?? '',
    })
  }
  return { columns, warnings }
}

/** 对比表的一行定义：哪些指标放在表里（顺序即显示顺序）。 */
export interface ComparisonMetric {
  key: string
  label: string
  /** 取值：拿不到（null/NaN）时显示 —，不写 0。 */
  value: (column: ComparisonColumn) => number | null
  format: 'money' | 'percent' | 'number'
  /** 越大越好 / 越小越好 / 中性（只用于给最优值加标记）。 */
  better: 'high' | 'low' | 'none'
}

export const COMPARISON_METRICS: ComparisonMetric[] = [
  { key: 'price', label: '售价', value: (c) => c.input.price, format: 'money', better: 'none' },
  { key: 'totalVariableCost', label: '单件成本合计', value: (c) => c.result.totalVariableCost, format: 'money', better: 'low' },
  { key: 'effectiveProfit', label: '有效贡献', value: (c) => c.result.effectiveProfit, format: 'money', better: 'high' },
  { key: 'marginRate', label: '贡献率', value: (c) => c.result.marginRate, format: 'percent', better: 'high' },
  { key: 'breakEvenAcos', label: '盈亏 ACOS', value: (c) => c.result.breakEvenAcos, format: 'percent', better: 'none' },
  { key: 'breakEvenCpc', label: '盈亏 CPC', value: (c) => c.result.breakEvenCpc, format: 'money', better: 'high' },
  { key: 'suggestedCpc', label: '目标 ACOS CPC', value: (c) => c.result.suggestedCpc, format: 'money', better: 'none' },
  { key: 'profitAfterAds', label: '广告后利润', value: (c) => c.result.profitAfterAds, format: 'money', better: 'high' },
  { key: 'adOrderShare', label: '广告订单占比', value: (c) => c.input.adOrderShare, format: 'percent', better: 'none' },
  { key: 'conversionRate', label: '转化率', value: (c) => c.input.conversionRate, format: 'percent', better: 'none' },
]

/**
 * 某一行里"最好的那一列"的 id。
 *
 * 三条排除规则（都来自真实误判）：
 * 1. `better === 'none'` 的行不给标记（售价没有"更好"的方向）；
 * 2. **参数非法的列不参与**：否则一个 `price: -1` 的坏方案会以"成本最低"拿下「优」，
 *    等于用标记把错误数据推荐给用户；
 * 3. 有效值少于 2 个、或全列同值时不标（每列都"最优"等于没有信息）。
 */
export function bestColumnId(metric: ComparisonMetric, columns: readonly ComparisonColumn[]): string | null {
  if (metric.better === 'none') return null
  const values = columns
    .filter((column) => column.result.valid)
    .map((column) => ({ id: column.id, value: metric.value(column) }))
    .filter((item): item is { id: string; value: number } => item.value !== null && Number.isFinite(item.value))
  if (values.length < 2) return null
  const best = values.reduce((acc, item) => {
    if (metric.better === 'high') return item.value > acc.value ? item : acc
    return item.value < acc.value ? item : acc
  })
  // 全列同值时不给标记（否则每列都"最优"，标记失去意义）
  if (values.every((item) => item.value === best.value)) return null
  return best.id
}

export function formatComparisonValue(value: number | null, format: ComparisonMetric['format']): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (format === 'percent') return `${(value * 100).toFixed(1)}%`
  if (format === 'money') return `$${value.toFixed(2)}`
  return String(value)
}

/**
 * diff 的一句话描述（表格最后一行的"差在哪"）。
 *
 * **只列前三项，其余折叠成「等 N 项」**：截图实测过，一份"只填了售价"的方案相对基准
 * 会差 14 个字段，全列出来会把这一行撑到半屏高，把整张表压变形 ——
 * 而前三项通常已经足够回答"它差在哪"。
 */
export function describeDiffs(column: ComparisonColumn, baselineName: string, limit = 3): string {
  if (column.diffs.length === 0) return `与「${baselineName}」参数相同`
  const format = (value: number | null): string => (value === null ? '未填' : String(Math.round(value * 10000) / 10000))
  const shown = column.diffs.slice(0, limit).map((diff) => {
    const label = CALCULATOR_FIELD_LABELS[diff.field] ?? diff.field
    return `${label} ${format(diff.from)} → ${format(diff.to)}`
  })
  const rest = column.diffs.length - shown.length
  return `相比「${baselineName}」：` + shown.join('；') + (rest > 0 ? `；等 ${column.diffs.length} 项` : '')
}
