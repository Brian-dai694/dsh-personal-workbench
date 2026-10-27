/**
 * AI 报表结论（`aiSummary`）的**只读解析**（T4，纯函数）。
 *
 * 为什么单独一层：`aiSummary` 在存储层是"任意 JSON 对象"（口径改了不用迁表），
 * 所以界面不能直接点字段 —— 缺字段、类型不对、老行是 null 都要能安静降级。
 * 这里把不可信 JSON 收成一个**所有字段可为空**的视图；渲染层不再做判空与类型判断。
 *
 * 边界：本文件不产生结论、不补默认值、不把 0 当成"没有"。
 * `null` = 这一项 agent 没给（unknown），不是 0。
 */
export type AiSummaryDistribution = Record<'negative' | 'add' | 'watch' | 'none', number | null>

export interface AiSummaryTotalsView {
  impressions: number | null
  clicks: number | null
  orders: number | null
  spend: number | null
  sales: number | null
  /** 比率（0–1）；销售额为 0 时 agent 可能给 null。 */
  acos: number | null
}

export interface AiSummaryRisksView {
  keyword: string
  spend: number | null
}

export interface AiSummaryOpportunitiesView {
  keyword: string
  sales: number | null
}

export interface AiSummaryView {
  totals: AiSummaryTotalsView
  rows: number | null
  uniqueKeywords: number | null
  distribution: AiSummaryDistribution
  negativeSpend: number | null
  topRisks: AiSummaryRisksView[]
  topOpportunities: AiSummaryOpportunitiesView[]
  notes: string[]
  evidence: string | null
  sessionId: string | null
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function keywordList(value: unknown, metric: 'spend' | 'sales'): Array<{ keyword: string; value: number | null }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ keyword: string; value: number | null }> = []
  for (const item of value) {
    const record = asObject(item)
    if (record === null) continue
    const keyword = asString(record.keyword)
    if (keyword === null) continue
    out.push({ keyword, value: asNumber(record[metric]) })
  }
  return out
}

/** 读一份 aiSummary；不是对象（含 null）时返回 null = 还没有结论。 */
export function readAiSummary(payload: Record<string, unknown> | null): AiSummaryView | null {
  const root = asObject(payload)
  if (root === null) return null

  const totals = asObject(root.totals) ?? {}
  const distribution = asObject(root.distribution) ?? {}
  const notes = Array.isArray(root.notes) ? root.notes.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []

  return {
    totals: {
      impressions: asNumber(totals.impressions),
      clicks: asNumber(totals.clicks),
      orders: asNumber(totals.orders),
      spend: asNumber(totals.spend),
      sales: asNumber(totals.sales),
      acos: asNumber(totals.acos),
    },
    rows: asNumber(root.rows),
    uniqueKeywords: asNumber(root.uniqueKeywords),
    distribution: {
      negative: asNumber(distribution.negative),
      add: asNumber(distribution.add),
      watch: asNumber(distribution.watch),
      none: asNumber(distribution.none),
    },
    negativeSpend: asNumber(root.negativeSpend),
    topRisks: keywordList(root.topRisks, 'spend').map((item) => ({ keyword: item.keyword, spend: item.value })),
    topOpportunities: keywordList(root.topOpportunities, 'sales').map((item) => ({ keyword: item.keyword, sales: item.value })),
    notes,
    evidence: asString(root.evidence),
    sessionId: asString(root.session_id),
  }
}
