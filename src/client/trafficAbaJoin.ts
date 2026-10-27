/**
 * 搜索词 → ABA 词表 的反向关联（纯函数）。
 *
 * 关键词页已经能"看一个市场词在我们这边的花费/订单"；这里做反向：
 * 在**搜索词报表**里看每个词在 ABA 里处于哪一层、是否被头部垄断。
 *
 * 为什么值得做：报表只能回答"这个词我们亏了多少钱"，
 * 而"该不该继续争"取决于市场结构 —— 一个高花费无单的头部垄断词，
 * 结论是"别正面打"，而不是"再优化 Listing 试试"。
 *
 * ## 匹配口径（与正向一致，不许两套）
 * - **精确词**、大小写不敏感、去首尾空白；
 * - 不做词根/模糊匹配：`b07dn8y7c1` 这类 ASIN 搜索词模糊匹配会串到无关词，归因就错了；
 * - 多份 ABA 词表里同一个词出现多次时，**排名更靠前（数字更小）的那份胜出**，
 *   因为同一个词在不同周期导出里排名会变，取更好的那份最能说明"它曾经有多强"。
 */
import { classifyAbaRow, type AbaAnnotation, type AbaKeywordRow, type AbaThresholds } from '../shared/abaKeywordTable.js'

export interface AbaLookupEntry {
  tier: string
  monopolized: boolean | null
  worth: string
  suggestedMatch: string | null
  /** 该词来自哪份词表（追溯用）。 */
  fromSet: string
  /** 是否被人工/DSH 回填覆盖过。 */
  overridden: boolean
}

interface SetLike {
  title: string
  rows: AbaKeywordRow[]
  annotations?: AbaAnnotation[]
}

/**
 * 把若干份 ABA 词表压成一个"词 → 市场判断"的查表。
 *
 * @param sets 词表（顺序即优先级，越靠前越优先；同词重复时先到者胜出并记下排名更优者）
 */
export function buildAbaLookup(sets: readonly SetLike[], thresholds: Partial<AbaThresholds> = {}): Map<string, AbaLookupEntry> {
  const out = new Map<string, AbaLookupEntry>()
  const rankOf = new Map<string, number>()
  for (const set of sets) {
    const annotations = new Map<string, AbaAnnotation>()
    for (const item of set.annotations ?? []) annotations.set(item.keyword.trim().toLowerCase(), item)
    for (const row of set.rows) {
      const key = row.keyword.trim().toLowerCase()
      if (key === '') continue
      const base = classifyAbaRow(row, thresholds)
      const note = annotations.get(key)
      const entry: AbaLookupEntry = {
        tier: base.tier,
        monopolized: base.monopolized,
        worth: note?.worth ?? base.worth,
        suggestedMatch: note?.suggestedMatch ?? base.suggestedMatch,
        fromSet: set.title,
        overridden: note !== undefined,
      }
      const existingRank = rankOf.get(key)
      const rank = row.rank ?? Number.POSITIVE_INFINITY
      /** 同词多份词表：排名更靠前的胜出（null 排名视为最弱，不挤掉有排名的）。 */
      if (existingRank === undefined || rank < existingRank) {
        out.set(key, entry)
        rankOf.set(key, rank)
      }
    }
  }
  return out
}

export function lookupAba(lookup: ReadonlyMap<string, AbaLookupEntry>, keyword: string): AbaLookupEntry | null {
  return lookup.get(keyword.trim().toLowerCase()) ?? null
}

export const ABA_TIER_SHORT: Record<string, string> = { head: '头部', middle: '中部', tail: '长尾', unknown: '未知' }
export const ABA_WORTH_SHORT: Record<string, string> = { invest: '值得投', watch: '观察', avoid: '避开', unknown: '未知' }

/** 一行里给搜索词报表用的一句话市场判断（空字符串 = 没匹配到，界面不显示）。 */
export function abaBadgeText(entry: AbaLookupEntry | null): string {
  if (entry === null) return ''
  const tier = ABA_TIER_SHORT[entry.tier] ?? entry.tier
  if (entry.monopolized === true) return `${tier} · 已垄断`
  if (entry.monopolized === false) return `${tier} · 未垄断`
  return `${tier} · 垄断未知`
}
