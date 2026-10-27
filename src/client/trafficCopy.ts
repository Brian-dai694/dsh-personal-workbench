/**
 * 把"当前筛选结果"复制成 TSV（贴进 Excel 直接成表）。
 *
 * 单独成模块的理由：这是**用户真正拿去干活**的产物（贴给运营、贴进 Bulk 前的核对表），
 * 所以它有独立可测的形状（列名、行序、空值写法），不该混在视图里靠肉眼保证。
 *
 * 约定：
 * - 列与界面表格**同序同义**（搜索词 / ACOS / 点击 / 订单 / 花费 / AI 建议 / 曝光 / 销售额 / CTR / CVR / CPC）；
 * - 用 TSV 而不是 CSV：粘贴到 Excel 不会被"关键词里带逗号"打断列；
 * - 空值写 `—` 而不是 `0`/空：**没有数据不等于零**，写 0 会被下游当成事实；
 * - 百分比保留 1 位小数，钱保留 2 位 —— 与界面显示完全一致。
 */
import type { TrafficMetric, SearchTermAction } from './amazonTrafficTools.js'

const ACTION_LABEL: Record<SearchTermAction, string> = {
  add_exact: '加精准',
  add_phrase: '加词组',
  negative_exact: '否精准',
  negative_phrase: '否词组',
  watch: '观察',
  none: '不动',
}

export const TRAFFIC_COPY_HEADER = ['搜索词', 'ACOS', '点击', '订单', '花费', 'AI 建议', '曝光', '销售额', 'CTR', 'CVR', 'CPC'] as const

const percent = (value: number | null): string => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
const money = (value: number | null): string => (value === null ? '—' : `$${value.toFixed(2)}`)

export function summariseSliceForCopy(
  rows: readonly TrafficMetric[],
  annotations: ReadonlyMap<string, { action: SearchTermAction }>,
): string {
  const lines = [TRAFFIC_COPY_HEADER.join('\t')]
  for (const row of rows) {
    const note = annotations.get(row.keyword)
    lines.push([
      row.keyword,
      percent(row.acos),
      String(row.clicks),
      String(row.orders),
      money(row.spend),
      note === undefined ? '待分析' : ACTION_LABEL[note.action],
      String(row.impressions),
      money(row.sales),
      percent(row.ctr),
      percent(row.cvr),
      money(row.cpc),
    ].join('\t'))
  }
  return lines.join('\n')
}
