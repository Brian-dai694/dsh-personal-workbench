export type KeywordMatch = 'exact' | 'phrase' | 'broad'

/**
 * CSV 生成已迁到 `shared/keywordPlanCsv.ts`（服务端写文件要用**同一份**转义规则）。
 * 这里保留旧导出名，避免一次性改掉所有调用点；实现只有一处。
 */
export { keywordPlanCsv } from './keywordPlanCsv.js'

export interface KeywordPlanRow {
  keyword: string
  match: KeywordMatch
  campaign: string
  rationale: string
}

const WORD_SPLIT = /[\s,，、;；|]+/

function cleanWords(value: string): string[] {
  return value.split(WORD_SPLIT).map((item) => item.trim().toLowerCase()).filter(Boolean)
}

export function buildKeywordPlan(seed: string, modifiers: string, matchTypes: KeywordMatch[] = ['exact', 'phrase', 'broad']): KeywordPlanRow[] {
  const root = [...new Set(seed.trim().toLowerCase().split(/\s+/).filter(Boolean))].join(' ')
  const extras = [...new Set(cleanWords(modifiers))]
  const phrases = new Set<string>(root ? [root] : [])
  for (const extra of extras) {
    if (root) phrases.add(`${extra} ${root}`)
  }
  return [...phrases].flatMap((keyword) => matchTypes.map((match) => ({
    keyword,
    match,
    campaign: match === 'exact' ? 'SP-精准' : match === 'phrase' ? 'SP-词组' : 'SP-广泛',
    rationale: match === 'exact' ? '核心词，优先验证转化' : match === 'phrase' ? '扩展长尾，观察搜索词' : '低预算探索词根',
  })))
}

