/**
 * 「规则值 vs 回填值」的差异描述（纯函数）。
 *
 * 为什么要单独显示：回填会**覆盖**规则结论，覆盖后界面上只剩一个值，
 * 人就看不出"这条是规则判的还是被证据改过的"。真正需要人看一眼的，
 * 恰恰是**两者不一致**的那几行 —— 那说明规则的前提在这条词上不成立。
 *
 * 输出刻意短：表格里一行放不下长句，并且只说"变了什么"。
 */

export interface WorthLike {
  worth: string
  suggestedMatch: string | null
}

const WORTH_TEXT: Record<string, string> = { invest: '值得投', watch: '观察', avoid: '避开', unknown: '未知' }
const MATCH_TEXT: Record<string, string> = { exact: '精准', phrase: '词组', broad: '广泛' }

export interface Divergence {
  /** 是否有差异（任一维度）。 */
  differs: boolean
  /** 结论是否被改过。 */
  worthChanged: boolean
  /** 建议匹配是否被改过。 */
  matchChanged: boolean
  /** 给表格用的一句话；一致时是「一致」。 */
  text: string
}

export function worthLabel(value: string): string {
  return WORTH_TEXT[value] ?? value
}

export function matchLabel(value: string | null): string {
  return value === null ? '—' : MATCH_TEXT[value] ?? value
}

export function describeDivergence(rule: WorthLike, applied: WorthLike, overridden: boolean): Divergence {
  if (!overridden) return { differs: false, worthChanged: false, matchChanged: false, text: '一致（规则）' }
  const worthChanged = rule.worth !== applied.worth
  const matchChanged = rule.suggestedMatch !== applied.suggestedMatch
  if (!worthChanged && !matchChanged) {
    return { differs: false, worthChanged: false, matchChanged: false, text: '一致（回填确认）' }
  }
  const parts: string[] = []
  if (worthChanged) parts.push(`${worthLabel(rule.worth)} → ${worthLabel(applied.worth)}`)
  if (matchChanged) parts.push(`${matchLabel(rule.suggestedMatch)} → ${matchLabel(applied.suggestedMatch)}`)
  return { differs: true, worthChanged, matchChanged, text: parts.join(' · ') }
}
