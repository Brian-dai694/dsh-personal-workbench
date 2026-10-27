/**
 * 搜索词报表的**本地规则建议**（纯函数，不调用 AI、不需要会话）。
 *
 * 为什么要有它：界面上的「AI 建议」列原本只在"有人/AI 写过建议"时才有内容，
 * 于是刚导入的报表**整列都是「待分析」**，看起来像功能坏了。
 * 这里给一套**离线可算**的基线规则：导入即可看，AI 只做修正与深挖。
 *
 * 规则口径（与流量筛选栏的默认阈值一致，改一处必须改另一处）：
 * - 按 `keyword.trim().toLowerCase()` 先聚合所有报表行，再判断词级点击/订单/花费/ACOS；
 * - 点击达到阈值、0 单且花费 > 0 → 否词候选（negative_exact），仍须按活动/广告组确认归因；
 * - 至少 `KEYWORD_RULES.addMinOrders` 单且 ACOS ≤ `KEYWORD_RULES.addMaxAcos` → 精准加词（add_exact）；
 * - 有单但未达加词门槛或 ACOS 超阈 → 观察（watch）；
 * - 有曝光但 0 点击 → 观察（watch）；样本不足 → 观察（watch）。
 * - 结果仅对有证据的建议标记 derived；无曝光/点击而未判定的词不生成建议行。
 *
 * 证据等级一律是 `derived`（本地按报表算出来的），不是 observed（市场/账户原始事实）。
 */
import { KEYWORD_RULES } from '../shared/keywordDecision.js'

export interface AdviceRowInput {
  keyword: string
  clicks: number
  orders: number
  spend: number
  sales: number
  impressions: number
}

export type LocalAdviceAction = 'negative_exact' | 'add_exact' | 'watch' | 'none'

export interface LocalAdvice {
  keyword: string
  action: LocalAdviceAction
  reason: string
  evidence: 'derived'
}

interface AggregatedAdviceRow extends AdviceRowInput {
  rowCount: number
}

function aggregateAdviceRows(rows: readonly AdviceRowInput[]): AggregatedAdviceRow[] {
  const groups = new Map<string, AggregatedAdviceRow>()
  for (const row of rows) {
    const keyword = typeof row.keyword === 'string' ? row.keyword.trim() : ''
    if (keyword === '') continue
    const key = keyword.toLowerCase()
    let group = groups.get(key)
    if (group === undefined) {
      group = { keyword, impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0, rowCount: 0 }
      groups.set(key, group)
    }
    group.rowCount += 1
    for (const metric of ['impressions', 'clicks', 'orders', 'spend', 'sales'] as const) {
      const value = row[metric]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) group[metric] += value
    }
  }
  return [...groups.values()]
}

export interface AdviceThresholds {
  /** 判「否词候选」的最小点击数。 */
  wasteMinClicks: number
  /** 判「值得加词」的最大 ACOS（0–1）。 */
  goodAcos: number
}

export const DEFAULT_ADVICE_THRESHOLDS: AdviceThresholds = { wasteMinClicks: 8, goodAcos: 0.3 }

export function adviceForRow(row: AdviceRowInput, input: Partial<AdviceThresholds> = {}): LocalAdvice {
  const t: AdviceThresholds = {
    wasteMinClicks: typeof input.wasteMinClicks === 'number' && input.wasteMinClicks >= 1 ? input.wasteMinClicks : DEFAULT_ADVICE_THRESHOLDS.wasteMinClicks,
    goodAcos: typeof input.goodAcos === 'number' && input.goodAcos > 0 && input.goodAcos <= 1 ? input.goodAcos : DEFAULT_ADVICE_THRESHOLDS.goodAcos,
  }
  const clicks = Math.max(0, Math.round(row.clicks))
  const orders = Math.max(0, Math.round(row.orders))
  const spend = Number.isFinite(row.spend) ? row.spend : 0
  const sales = Number.isFinite(row.sales) ? row.sales : 0
  const impressions = Math.max(0, Math.round(row.impressions))

  if (orders === 0 && spend > 0 && clicks >= t.wasteMinClicks) {
    return {
      keyword: row.keyword,
      action: 'negative_exact',
      reason: `${clicks} 次点击 / $${spend.toFixed(2)} 花费 / 0 单（${'rowCount' in row ? row.rowCount : 1} 行聚合）：否词候选；先按投放单元复核，不要账户级否定`,
      evidence: 'derived',
    }
  }
  if (orders > 0) {
    const acos = sales > 0 ? spend / sales : null
    if (orders >= KEYWORD_RULES.addMinOrders && acos !== null && acos <= t.goodAcos) {
      return {
        keyword: row.keyword,
        action: 'add_exact',
        reason: `${orders} 单 / ACOS ${(acos * 100).toFixed(1)}% ≤ ${Math.round(t.goodAcos * 100)}%：值得加精准并提预算`,
        evidence: 'derived',
      }
    }
    return {
      keyword: row.keyword,
      action: 'watch',
      reason: `${orders} 单但 ACOS ${acos === null ? '未知' : `${(acos * 100).toFixed(1)}%`}：能出单但太贵，先降竞价/降位再观察`,
      evidence: 'derived',
    }
  }
  if (clicks === 0 && impressions > 0) {
    return {
      keyword: row.keyword,
      action: 'watch',
      reason: `${impressions.toLocaleString('en-US')} 次曝光 / 0 点击：词相关性或主图价格有问题，不是否词能解决的`,
      evidence: 'derived',
    }
  }
  if (clicks > 0) {
    return {
      keyword: row.keyword,
      action: 'watch',
      reason: `仅 ${clicks} 次点击 / 0 单（未达 ${t.wasteMinClicks} 次门槛）：样本太小，先观察别急否`,
      evidence: 'derived',
    }
  }
  return { keyword: row.keyword, action: 'none', reason: '没有曝光也没有点击：报表里不该出现，检查数据源', evidence: 'derived' }
}

/**
 * 整份报表的建议。
 *
 * 输入报表按投放单元拆行，必须先聚合完整报表再分层；limit 只限制输出数量，
 * 不得截断输入或在看到同词首行后就下结论。默认最多输出 200 个词级建议。
 */
export function buildLocalAdvice(rows: readonly AdviceRowInput[], options: { limit?: number; thresholds?: Partial<AdviceThresholds> } = {}): LocalAdvice[] {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : 200
  return aggregateAdviceRows(rows)
    .sort((a, b) => (b.spend - a.spend) || (b.clicks - a.clicks))
    .map((row) => adviceForRow(row, options.thresholds))
    .filter((advice) => advice.action !== 'none')
    .slice(0, limit)
}

/** 统计条：界面上一句话说明"这套规则给了什么"。 */
export function summarizeAdvice(advice: readonly LocalAdvice[]): { negative: number; add: number; watch: number } {
  return {
    negative: advice.filter((item) => item.action === 'negative_exact').length,
    add: advice.filter((item) => item.action === 'add_exact').length,
    watch: advice.filter((item) => item.action === 'watch').length,
  }
}
