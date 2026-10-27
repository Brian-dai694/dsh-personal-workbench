/**
 * 用**你自己的报表**校准建议阈值（纯函数）。
 *
 * 为什么需要：默认的「点击 ≥8 且 0 单 → 否词」「ACOS ≤30% → 加词」是行业常见值，
 * 但你这份报表里最高的词也只有 4 次点击 —— 8 次的门槛等于永远不触发。
 * 阈值应该由「你实际出单的词长什么样」反推，而不是照抄别人的数字。
 *
 * ## 口径
 * - **出单基线**：取有单的词（orders > 0），看它们拿到 1 单大概需要多少点击、ACOS 多少；
 * - `wasteMinClicks` = 出单词点击数的 **中位数** 向上取整 —— 含义是
 *   "典型出单词花这么多点击就能出单，你花了同样的点击还没单，就不再是运气问题"；
 * - `goodAcos` = 出单词 ACOS 的 **75 分位** —— 含义是"75% 的出单词都能做到这个 ACOS 以内"；
 * - 样本不足（出单词 < 5）时 **不给**校准结果：靠 2-3 个样本反推阈值比默认值更糟。
 *
 * 输出里带 `rationale`，把实际数字写出来，方便你判断要不要采纳。
 */

export interface CalibrationRowInput {
  keyword: string
  clicks: number
  orders: number
  spend: number
  sales: number
}

export interface CalibrationResult {
  /** 能不能给结论（样本太少时为 false，此时 thresholds 为 null）。 */
  ok: boolean
  thresholds: { wasteMinClicks: number; goodAcos: number } | null
  /** 出单样本量。 */
  winners: number
  /** 有花费但没单的样本量。 */
  losers: number
  /** 一句话说明（含实际数字），直接显示给用户。 */
  rationale: string
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

const MIN_WINNERS = 5

export function deriveAdviceThresholds(rows: readonly CalibrationRowInput[]): CalibrationResult {
  const winners = rows.filter((row) => row.orders > 0)
  const losers = rows.filter((row) => row.orders === 0 && (row.clicks > 0 || row.spend > 0))
  if (winners.length < MIN_WINNERS) {
    return {
      ok: false,
      thresholds: null,
      winners: winners.length,
      losers: losers.length,
      rationale: `出单词只有 ${winners.length} 个（至少需要 ${MIN_WINNERS} 个才有统计意义）：继续用默认阈值，不要用几个样本反推口径`,
    }
  }

  const clicksSorted = winners.map((row) => Math.max(1, Math.round(row.clicks))).sort((a, b) => a - b)
  const clicksMedian = percentile(clicksSorted, 0.5) ?? 1
  const clicksP75 = percentile(clicksSorted, 0.75) ?? clicksMedian

  /**
   * **分布重叠就不能校准**（2026-10-24 用真实报表发现的坑）。
   *
   * 第一版直接拿"出单词点击数中位数"当浪费门槛，结果在这份真实报表上算出 **2 次点击**：
   * 83 个出单词里大多数是 1 次点击就出单，而 1,160 个无单词平均也只有 ~1 次点击。
   * 两组分布几乎完全重叠 —— 说明这份数据里没有可用于区分"会出单 / 不会出单"的点击信息，
   * 此时切在哪里都是瞎猜，而且会把上千个词全部变成"否词候选"（灾难性建议）。
   *
   * 判据：无单词点击 P90 ≤ 出单词点击 P75 → 重叠 → 拒绝给结论，继续用默认口径。
   */
  const loserClicks = losers.map((row) => Math.max(0, Math.round(row.clicks))).sort((a, b) => a - b)
  const loserP90 = percentile(loserClicks, 0.9) ?? 0
  if (clicksP75 < 3 || loserP90 <= clicksP75) {
    return {
      ok: false,
      thresholds: null,
      winners: winners.length,
      losers: losers.length,
      rationale: `出单词 ${winners.length} 个（点击 P75 = ${Math.round(clicksP75)}），无单词 ${losers.length} 个（点击 P90 = ${Math.round(loserP90)}）：两组点击分布重叠，这份报表不足以反推出可靠的「多少点击还没单算浪费」。建议拉长报表周期或提高预算后重新校准；在此之前继续用默认 8 次 / 30%。`,
    }
  }

  const wasteMinClicks = Math.max(3, Math.ceil(clicksP75))

  const acosList = winners
    .filter((row) => row.sales > 0)
    .map((row) => row.spend / row.sales)
    .sort((a, b) => a - b)
  const acosP75 = percentile(acosList, 0.75)
  /** 没有销售额数据时退回默认 30%，并在理由里说明。 */
  const goodAcos = acosP75 === null ? 0.3 : Math.min(0.95, Math.max(0.1, Math.round(acosP75 * 20) / 20))

  const wasteSpend = losers.length > 0
    ? losers.reduce((sum, row) => sum + row.spend, 0)
    : 0

  return {
    ok: true,
    thresholds: { wasteMinClicks, goodAcos },
    winners: winners.length,
    losers: losers.length,
    rationale: [
      `${winners.length} 个出单词的点击中位数 ${Math.round(clicksMedian)}、P75 ${Math.round(clicksP75)}（无单词 P90 = ${Math.round(loserP90)}，两组可分），`,
      `所以把「多少点击还没单就算浪费」定在 ${wasteMinClicks}；`,
      acosP75 === null
        ? '出单词里没有销售额数据，ACOS 阈值保持默认 30%'
        : `75% 的出单词 ACOS ≤ ${(goodAcos * 100).toFixed(0)}%，所以加词线定在 ${(goodAcos * 100).toFixed(0)}%`,
      losers.length > 0 ? `；当前 ${losers.length} 个有花费无单的词共花了 $${wasteSpend.toFixed(2)}` : '',
    ].join(''),
  }
}
