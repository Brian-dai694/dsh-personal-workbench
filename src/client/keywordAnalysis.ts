/**
 * 关键词分析块的数据装配（T5，纯函数）：词级聚合 → 分层结论 → Top 风险 / Top 机会。
 *
 * ## 为什么这层不写阈值
 * 阈值与判定**只有一份实现**：`shared/keywordDecision.ts`（`KEYWORD_RULES` / `decideKeyword`）。
 * 本文件只做展示需要的二次汇总（每个桶的数量与花费、Top N 的排序），
 * 任何"多少点击算否词"的判断都必须回调 `decideKeyword` —— 这样面板、agent 与单测
 * 不可能各说各话。
 *
 * ## 口径
 * - 词级聚合用 `aggregateByKeyword`：1243 行 → 767 词（同一词在多广告组/匹配类型里被合并）；
 * - 花费 / 销售额按**词级**加总（与聚合行一致，不再从原始行算第二遍）；
 * - ACOS = 花费 / 销售额；销售额为 0 时是 unknown（`null`），不当 0 用；
 * - Top 风险 = `negative` 按花费降序前 N；Top 机会 = `add` 按销售额降序前 N；
 * - 「缺投放单元信息」= 没有任何一行同时带广告组与匹配类型 —— 此时词级 0 单不足以直接否词。
 */
import { aggregateByKeyword, type KeywordAggregateInput } from '../shared/keywordAggregate.js'
import {
  KEYWORD_DECISION_CODES, decideKeyword,
  type KeywordDecisionCode, type KeywordThresholds,
} from '../shared/keywordDecision.js'
import type { SearchTermAction } from '../shared/amazonTrafficTools.js'

/** 桶的显示名：顺序与 `KEYWORD_DECISION_CODES` 一致（否定 → 加词 → 观察 → 不动）。 */
export const DECISION_LABEL: Record<KeywordDecisionCode, string> = {
  negative: '否定',
  add: '加词',
  watch: '观察',
  none: '不动',
}

/**
 * 结论码 → 搜索词动作码（Step 2，2026-10-29）。
 *
 * 报表行**区分不了** exact / phrase（那是投放结构信息，搜索词报表里没有），
 * 所以这里给的是**派生默认值**：一律取 exact，证据等级恒为 `derived`。
 * 想要 phrase 必须有人真的看过投放结构再写 —— 不许拿这张表冒充 observed。
 */
export const SEARCH_TERM_ACTION_OF: Record<KeywordDecisionCode, SearchTermAction> = {
  negative: 'negative_exact',
  add: 'add_exact',
  watch: 'watch',
  none: 'none',
}

/** Top 榜默认取 5 条。 */
export const TOP_LIMIT = 5

/**
 * 输入行：词级聚合所需的最小字段，外加可选的投放单元字段。
 *
 * 流量分析导入的 `TrafficRow` 只有六列，所以这两个字段通常不存在 ——
 * 那正是「否词需按投放单元复核」提示要出现的情形。
 */
export interface KeywordAnalysisInputRow extends KeywordAggregateInput {
  adGroup?: string | null
  matchType?: string | null
}

export interface KeywordBucketView {
  code: KeywordDecisionCode
  label: string
  count: number
  spend: number
}

export interface KeywordTopView {
  keyword: string
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
}

/** 词级明细行：三页（流量 / 关键词 / 报表）共用同一份判定结果。 */
export interface KeywordWordView extends KeywordTopView {
  code: KeywordDecisionCode
  rowCount: number
  /** 销售额为 0 时是 unknown（null）。 */
  acos: number | null
}

export interface KeywordAnalysis {
  /** 原始行数（报表里的行）。 */
  rowCount: number  /** 聚合后的唯一词数。 */
  wordCount: number
  spend: number
  sales: number
  /** 销售额为 0 时是 unknown（null）。 */
  acos: number | null
  buckets: KeywordBucketView[]
  risks: KeywordTopView[]
  opportunities: KeywordTopView[]
  /** 全部词（按花费降序），供关键词页与报表页共用，不在各自页面重算。 */
  words: KeywordWordView[]
  /** 0 单词的花费合计与占比（销售额为 0 时占比是 null）。 */
  zeroOrderSpend: number
  zeroOrderSpendShare: number | null
  /** 报表是否缺少广告组 / 匹配类型（决定是否显示"需按投放单元复核"）。 */
  missingPlacement: boolean
  /**
   * 缺投放单元的**原因**（2026-10-29）：界面要把两种情形分开说，否则用户不知道该
   * 回去重新导出，还是该找我们。
   *
   * - `column-absent`：文件里没有这两列（或整列为空）→ 用户侧：去后台按投放单元导出；
   * - `legacy-rows`：这行数据是旧格式导入的，当时还没有这三列 → 我方历史遗留；重新导入即可带上。
   * - `null`：投放单元信息齐全，不需要提示。
   */
  placementGap: PlacementGapReason | null
}

/** 投放单元缺失的两种来源，见 `KeywordAnalysis.placementGap`。 */
export type PlacementGapReason = 'column-absent' | 'legacy-rows'

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 是否带投放单元信息：要求**同一行**同时有广告组与匹配类型。
 *
 * 两列都缺、或只带其一，都不足以把人带到具体投放单元 —— 结论仍是词级的。
 */
export function hasPlacementDetail(rows: ReadonlyArray<KeywordAnalysisInputRow>): boolean {
  return rows.some((row) => nonEmpty(row.adGroup) && nonEmpty(row.matchType))
}

/**
 * 缺投放单元时判断**是哪种缺法**。
 *
 * 判据是字段**存在性**而不是值：新导入的行总是带 `adGroup`/`matchType` 键（可能是 null），
 * 旧数据集的行连键都没有 —— 这两种在界面上要给出完全不同的下一步。
 */
export function placementGapOf(rows: ReadonlyArray<KeywordAnalysisInputRow>): PlacementGapReason | null {
  if (hasPlacementDetail(rows)) return null
  const hasColumnKey = rows.some(
    (row) => Object.prototype.hasOwnProperty.call(row, 'adGroup')
      || Object.prototype.hasOwnProperty.call(row, 'matchType'),
  )
  return hasColumnKey ? 'column-absent' : 'legacy-rows'
}

function toTopView(word: { keyword: string; impressions: number; clicks: number; orders: number; spend: number; sales: number }): KeywordTopView {
  return {
    keyword: word.keyword,
    impressions: word.impressions,
    clicks: word.clicks,
    orders: word.orders,
    spend: word.spend,
    sales: word.sales,
  }
}

/** 销售额降序 → 花费降序 → 词升序（末级唯一，保证同数据输出稳定）。 */
function compareOpportunity(a: KeywordTopView, b: KeywordTopView): number {
  if (a.sales !== b.sales) return b.sales - a.sales
  if (a.spend !== b.spend) return b.spend - a.spend
  if (a.keyword === b.keyword) return 0
  return a.keyword < b.keyword ? -1 : 1
}

/**
 * 装配词级结论。
 *
 * `thresholds` 缺省走 `DEFAULT_KEYWORD_THRESHOLDS`；两页必须传**同一个**值
 * （设置域 `amazonKeywordThresholds`），否则同一份数据会得出两种结论。
 */
export function buildKeywordAnalysis(
  rows: ReadonlyArray<KeywordAnalysisInputRow>,
  options: { topLimit?: number; thresholds?: KeywordThresholds } = {},
): KeywordAnalysis {
  const limit = options.topLimit ?? TOP_LIMIT
  const words = aggregateByKeyword(rows)

  const counts: Record<KeywordDecisionCode, number> = { negative: 0, add: 0, watch: 0, none: 0 }
  const spendBy: Record<KeywordDecisionCode, number> = { negative: 0, add: 0, watch: 0, none: 0 }
  const negative: KeywordTopView[] = []
  const positive: KeywordTopView[] = []
  const wordViews: KeywordWordView[] = []
  let spend = 0
  let sales = 0
  let zeroOrderSpend = 0

  for (const word of words) {
    const code = decideKeyword(word, options.thresholds)
    counts[code] += 1
    spendBy[code] += word.spend
    spend += word.spend
    sales += word.sales
    if (word.orders === 0) zeroOrderSpend += word.spend
    wordViews.push({
      ...toTopView(word),
      code,
      rowCount: word.rowCount,
      acos: word.sales > 0 ? word.spend / word.sales : null,
    })
    if (code === 'negative') negative.push(toTopView(word))
    else if (code === 'add') positive.push(toTopView(word))
  }

  return {
    rowCount: rows.length,
    wordCount: words.length,
    spend,
    sales,
    acos: sales > 0 ? spend / sales : null,
    // 聚合结果本身按花费降序，所以风险榜直接切前 N 就是"按花费前 5"。
    buckets: KEYWORD_DECISION_CODES.map((code) => ({
      code,
      label: DECISION_LABEL[code],
      count: counts[code],
      spend: spendBy[code],
    })),
    risks: negative.slice(0, limit),
    opportunities: [...positive].sort(compareOpportunity).slice(0, limit),
    words: wordViews,
    zeroOrderSpend,
    zeroOrderSpendShare: spend > 0 ? zeroOrderSpend / spend : null,
    missingPlacement: !hasPlacementDetail(rows),
    placementGap: placementGapOf(rows),
  }
}
