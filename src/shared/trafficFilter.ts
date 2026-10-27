/**
 * 搜索词表的**筛选与排序**（纯函数，界面与测试共用一份）。
 *
 * ## 为什么要抽出来
 * 广告日审最耗时的动作不是"看数"，而是**在几百行里找出该处理的那十几行**：
 * 高花费零单、ACOS 超阈、有曝光无点击。把这些口径写成纯函数有两个好处：
 * 1. 界面上的"浪费/超阈/无点击"三个数字和表里筛出来的行**必然一致**（同一个实现）；
 * 2. 口径可以单独测边界（`acos` 为 null、`clicks` 恰好等于阈值）。
 *
 * ## 三条口径（与页面底部的 SOP 文案逐字对应，不要各自发明）
 * - **高花费无单**：`clicks >= minClicks` 且 `orders === 0`。
 *   用点击数而不是花费做门槛：花费会随竞价波动，点击数是"已经付过钱的行为量"，
 *   8 次点击仍无单在统计上已足够说明相关性/Listing 有问题。
 * - **ACOS 超阈**：`acos !== null && acos > threshold`。
 *   `acos === null`（销售额为 0）**不算超阈**，它属于"无单"那一类，混进来会重复计数。
 * - **有曝光无点击**：`impressions > 0 && clicks === 0`。
 *
 * ## 排序
 * 空值（`acos`/`ctr`/`cvr`/`cpc` 为 null）一律排**最后**：让"没数据"不占前排。
 * 同值时按花费降序、再按关键词升序 —— 保证翻页/刷新后顺序稳定，不会看串行。
 */

/** 筛选需要的最小行形状（结构化，不依赖界面那边的具体类型）。 */
export interface TrafficFilterableRow {
  keyword: string
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
  acos: number | null
  ctr: number | null
  cvr: number | null
  cpc: number | null
}

export type TrafficPreset = 'all' | 'waste' | 'acos_over' | 'no_click' | 'good'

export const TRAFFIC_PRESETS: TrafficPreset[] = ['all', 'waste', 'acos_over', 'no_click', 'good']

/**
 * 「高花费无单」的点击门槛（唯一的 8 在这里）。
 *
 * ⚠️ 这个数字**同时**决定两件事：行内诊断文案（`analyseTraffic` 的 "高点击无订单"）
 * 与筛选预设 `waste`。之前两处各写一个 `8`，谁改一处就会出现
 * 「诊断说浪费、筛选筛不出来」—— 所以常量放在共享模块，两边都引用它。
 */
export const WASTE_MIN_CLICKS = 8

export interface TrafficFilterState {
  /** 关键词包含式搜索（大小写不敏感，去首尾空白）。 */
  query: string
  preset: TrafficPreset
  /** ACOS 阈值（0–1）。`waste` 不用它，`acos_over` / `good` 用它。 */
  acosThreshold: number
  /** `waste` 的点击门槛（≥ 该值且 0 单）。 */
  minClicks: number
}

export const DEFAULT_TRAFFIC_FILTER: TrafficFilterState = {
  query: '',
  preset: 'all',
  acosThreshold: 0.3,
  minClicks: WASTE_MIN_CLICKS,
}

/** 阈值归一：非法/越界值夹回可用区间，避免界面输入 `-5` 或 `NaN` 把筛选搞成空表。 */
export function normalizeTrafficFilter(state: Partial<TrafficFilterState>): TrafficFilterState {
  const threshold = Number(state.acosThreshold)
  const minClicks = Number(state.minClicks)
  return {
    query: typeof state.query === 'string' ? state.query : '',
    preset: state.preset !== undefined && TRAFFIC_PRESETS.includes(state.preset) ? state.preset : 'all',
    acosThreshold: Number.isFinite(threshold) ? Math.min(10, Math.max(0, threshold)) : DEFAULT_TRAFFIC_FILTER.acosThreshold,
    minClicks: Number.isFinite(minClicks) ? Math.min(10000, Math.max(1, Math.round(minClicks))) : DEFAULT_TRAFFIC_FILTER.minClicks,
  }
}

export function matchesTrafficPreset(row: TrafficFilterableRow, preset: TrafficPreset, filter: Pick<TrafficFilterState, 'acosThreshold' | 'minClicks'>): boolean {
  switch (preset) {
    case 'waste':
      return row.clicks >= filter.minClicks && row.orders === 0
    case 'acos_over':
      return row.acos !== null && row.acos > filter.acosThreshold
    case 'no_click':
      return row.impressions > 0 && row.clicks === 0
    case 'good':
      return row.orders > 0 && row.acos !== null && row.acos <= filter.acosThreshold
    case 'all':
    default:
      return true
  }
}

export function filterTrafficRows<T extends TrafficFilterableRow>(rows: readonly T[], input: Partial<TrafficFilterState>): T[] {
  const state = normalizeTrafficFilter(input)
  const needle = state.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (needle !== '' && !row.keyword.toLowerCase().includes(needle)) return false
    return matchesTrafficPreset(row, state.preset, state)
  })
}

export type TrafficSortKey = 'spend' | 'clicks' | 'orders' | 'impressions' | 'sales' | 'acos' | 'ctr' | 'cvr' | 'cpc'

export const TRAFFIC_SORT_KEYS: TrafficSortKey[] = ['spend', 'clicks', 'orders', 'impressions', 'sales', 'acos', 'ctr', 'cvr', 'cpc']

/**
 * 取排序值：非有限数一律当"无数据"（null）。
 *
 * ⚠️ `0` 是**真实值**（花费 0、订单 0、ACOS 0），不能和 null 混为一谈 ——
 * 把 0 当空值会让"花费为 0 的词"被排到最后，用户就看不到"没花钱但有点击"的异常行。
 */
function sortValue(row: TrafficFilterableRow, key: TrafficSortKey): number | null {
  const value = row[key as keyof TrafficFilterableRow]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/** 稳定排序：空值恒在最后（不受升降序影响），同值按花费降序 → 关键词升序兜底。 */
export function sortTrafficRows<T extends TrafficFilterableRow>(rows: readonly T[], key: TrafficSortKey, direction: 'asc' | 'desc' = 'desc'): T[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key)
    const bv = sortValue(b, key)
    if (av === null && bv === null) return tieBreak(a, b)
    if (av === null) return 1
    if (bv === null) return -1
    if (av !== bv) return (av - bv) * factor
    return tieBreak(a, b)
  })
}

function tieBreak(a: TrafficFilterableRow, b: TrafficFilterableRow): number {
  if (a.spend !== b.spend) return b.spend - a.spend
  return a.keyword.localeCompare(b.keyword)
}

export interface TrafficSliceSummary {
  rows: number
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
  /** 这几行的花费占整份报表的比例（整份花费为 0 时 null，不假装 0%）。 */
  spendShare: number | null
  /** 这几行的 ACOS（销售额为 0 时 null）。 */
  acos: number | null
}

/**
 * 汇总一片行的合计与占比。
 *
 * @param rows 要汇总的行（筛出来的一片）
 * @param allRows 整份报表的行；给了才算 `spendShare`，没给就是 null（不假装 0%）
 */
export function summarizeTrafficSlice(rows: readonly TrafficFilterableRow[], allRows?: readonly TrafficFilterableRow[]): TrafficSliceSummary {
  const totals = rows.reduce((acc, row) => ({
    impressions: acc.impressions + row.impressions,
    clicks: acc.clicks + row.clicks,
    orders: acc.orders + row.orders,
    spend: acc.spend + row.spend,
    sales: acc.sales + row.sales,
  }), { impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 })
  const allSpend = allRows === undefined ? null : allRows.reduce((sum, row) => sum + row.spend, 0)
  return {
    rows: rows.length,
    ...totals,
    spendShare: allSpend !== null && allSpend > 0 ? totals.spend / allSpend : null,
    acos: totals.sales > 0 ? totals.spend / totals.sales : null,
  }
}

/** 每个预设命中的行数（给筛选按钮上的角标用，与筛选走同一个判定）。 */
export function countByPreset(rows: readonly TrafficFilterableRow[], filter: Pick<TrafficFilterState, 'acosThreshold' | 'minClicks'>): Record<TrafficPreset, number> {
  const counts: Record<TrafficPreset, number> = { all: 0, waste: 0, acos_over: 0, no_click: 0, good: 0 }
  for (const row of rows) {
    counts.all += 1
    for (const preset of TRAFFIC_PRESETS) {
      if (preset !== 'all' && matchesTrafficPreset(row, preset, filter)) counts[preset] += 1
    }
  }
  return counts
}
