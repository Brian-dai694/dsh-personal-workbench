/**
 * 关键词分层决策（**唯一一份阈值实现**，报表页 / agent 工具 / 单测都引用它）。
 *
 * ## 为什么必须只有一份
 * 「点击 ≥ 8 且 0 单」这条门槛，过去在诊断文案、筛选预设、agent SOP 里各写过一遍。
 * 三处各改一处就会出现「面板说是否词、agent 说不动」—— 而人只会看到其中一个，
 * 于是把能出单的流量否掉，或者把钱留在垃圾词上。所以阈值集中在 `KEYWORD_RULES`，
 * 判定只在 `decideKeyword` 里写一次。
 *
 * ## 四条口径（与 T9 agent SOP 第 3 节逐字对应）
 * | 层 | 条件 |
 * |---|---|
 * | `negative` | 点击 ≥ 8 且 订单 = 0 且 花费 > 0 |
 * | `add` | 订单 ≥ 2 且 销售额 > 0 且 花费/销售额 ≤ 30% |
 * | `watch` | 其余里，有曝光或有花费 |
 * | `none` | 全 0（无曝光、无花费） |
 *
 * 细节：
 * - 判定**只看词级聚合结果**（`aggregateByKeyword` 的输出），不看单行：
 *   一个词被拆成 19 行时，每行最多 3 点击，按行永远到不了门槛。
 * - `sales = 0` 时 ACOS 是 unknown，不能当 0 用 —— 所以 `add` 显式要求 `sales > 0`。
 * - 脏值（`NaN` / 负值）按 0 计，与聚合口径一致，不抛错。
 * - 优先级：`negative` → `add` → `watch` → `none`。两类不会真冲突
 *   （否词要求 0 单，加词要求 ≥ 2 单），但顺序写清楚，读代码的人不用自己推。
 */

/**
 * 阈值常量（**改这里就是改全站口径**）。
 *
 * `negativeMinClicks = 8`：8 次点击仍无单，在统计上已足够说明相关性/Listing 有问题；
 * 用点击数而不是花费做门槛，是因为花费随竞价波动，点击数是"已经付过钱的行为量"。
 */
export const KEYWORD_RULES = {
  negativeMinClicks: 8,
  addMinOrders: 2,
  /** 目标 ACOS（0–1）：0.3 = 30%。 */
  addMaxAcos: 0.3,
} as const

export type KeywordDecisionCode = 'negative' | 'add' | 'watch' | 'none'

export const KEYWORD_DECISION_CODES: KeywordDecisionCode[] = ['negative', 'add', 'watch', 'none']

/** 决策需要的最小行形状：词级聚合结果（`KeywordAggregateRow`）直接可用。 */
export interface KeywordDecisionInput {
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
}

/**
 * 判定用的阈值（Step 2，2026-10-29）：`KEYWORD_RULES` 从"唯一口径"降级为**默认值**。
 *
 * 为什么必须参数化：账号级校准（设置域 `amazonKeywordThresholds`）已存在，
 * 而判定函数当时只读常量，于是"校准了也不生效"。参数化后，两页传同一个值，
 * 常量只负责没设置时的兜底。
 */
export interface KeywordThresholds {
  negativeMinClicks: number
  addMinOrders: number
  addMaxAcos: number
}

export const DEFAULT_KEYWORD_THRESHOLDS: KeywordThresholds = {
  negativeMinClicks: KEYWORD_RULES.negativeMinClicks,
  addMinOrders: KEYWORD_RULES.addMinOrders,
  addMaxAcos: KEYWORD_RULES.addMaxAcos,
}

/**
 * 设置域的形状（`AmazonKeywordThresholds`）→ 判定阈值。
 *
 * `null`/缺省 = 默认；只覆盖可校准的两项，`addMinOrders` 仍是常量 ——
 * 设置里没有这一项，就不该在别处偷偷给它一个"可调"的错觉。
 */
export function thresholdsFromSettings(
  settings: { wasteMinClicks: number; goodAcos: number } | null | undefined,
): KeywordThresholds {
  if (settings === null || settings === undefined) return DEFAULT_KEYWORD_THRESHOLDS
  return {
    negativeMinClicks: settings.wasteMinClicks,
    addMinOrders: KEYWORD_RULES.addMinOrders,
    addMaxAcos: settings.goodAcos,
  }
}

/** 脏值归零：只有有限的正数参与判定（负数 / NaN / Infinity 一律按 0）。 */
function metric(row: KeywordDecisionInput, key: keyof KeywordDecisionInput): number {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 单个词的分层结论。入参是**词级**聚合行，不是原始行；阈值缺省走 `DEFAULT_KEYWORD_THRESHOLDS`。 */
export function decideKeyword(
  row: KeywordDecisionInput,
  thresholds: KeywordThresholds = DEFAULT_KEYWORD_THRESHOLDS,
): KeywordDecisionCode {
  const impressions = metric(row, 'impressions')
  const clicks = metric(row, 'clicks')
  const orders = metric(row, 'orders')
  const spend = metric(row, 'spend')
  const sales = metric(row, 'sales')

  if (clicks >= thresholds.negativeMinClicks && orders === 0 && spend > 0) return 'negative'
  if (orders >= thresholds.addMinOrders && sales > 0 && spend / sales <= thresholds.addMaxAcos) return 'add'
  if (impressions > 0 || spend > 0) return 'watch'
  return 'none'
}

/**
 * 一片词的分层条数 —— 直接作为报表级结论的 `distribution`。
 *
 * 返回的四个键**总是存在**（没有就是 0），调用方不用做 `?? 0`；
 * 这样写进 `ai_summary` 的 distribution 结构稳定，报表页读的时候不会缺键。
 */
export function summarizeDecisions(rows: ReadonlyArray<KeywordDecisionInput>): Record<KeywordDecisionCode, number> {
  const counts: Record<KeywordDecisionCode, number> = { negative: 0, add: 0, watch: 0, none: 0 }
  for (const row of rows) counts[decideKeyword(row)] += 1
  return counts
}
