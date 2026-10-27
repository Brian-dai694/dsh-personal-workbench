/**
 * ABA 搜索词表：解析 + 分层 + 判垄断（纯函数，界面/测试共用）。
 *
 * ## 输入（亚马逊后台 / 卖家精灵的 ABA 导出）
 * 必需：关键词。
 * 可选：搜索排名 / 搜索量 / 点击 / 购买率 / 点击集中度。
 * 列名容忍中英文别名与前缀差异（真实导出常带单位括注，如「点击集中度(%)」）。
 *
 * ## 三条口径（写死在这里，界面不另算）
 * 1. **分层按 ABA 搜索排名**：≤100 头部、≤1000 中部、其余长尾。
 *    用排名而不是搜索量：排名是相对位置（跨词可比），搜索量会被类目规模带偏。
 * 2. **垄断看点击集中度**：≥ 50% 视为头部 ASIN 已吃掉过半点击。
 *    这是"要不要正面争"的判据，不是"这个品好不好"的判据。
 * 3. **"是否值得投"= 进入成本 × 转化能力**：
 *    - 垄断 → 不建议正面对打（可以长尾/词组绕开）；
 *    - 非垄断 + 购买率 ≥ 2% → 值得投；
 *    - 其余 → 观察（数据不足或转化太弱）。
 *
 * ⚠️ 购买率与点击集中度的**百分比歧义**：导出可能是 `3.5%`、`3.5` 或 `0.035`。
 * 统一规则：≤1 视为比例、>1 视为百分数除以 100 —— 两种写法都能读对，
 * 且不会把 0.035 读成 0.035%（差 100 倍）。
 */

export interface AbaKeywordRow {
  keyword: string
  /** ABA 搜索排名（越小越靠前）；缺列时为 null。 */
  rank: number | null
  /** 月搜索量；缺列时为 null。 */
  searches: number | null
  /** 点击（次数）；缺列时为 null。 */
  clicks: number | null
  /** 购买率 0–1；缺列时为 null。 */
  purchaseRate: number | null
  /** 点击集中度 0–1；缺列时为 null。 */
  clickConcentration: number | null
  /** SPR（要多少个评价才挤得进首页）；缺列时为 null。进入成本的核心指标。 */
  spr: number | null
  /** 商品数（同词在售商品数）；缺列时为 null。竞争面的直接指标。 */
  products: number | null
}

export type AbaTier = 'head' | 'middle' | 'tail' | 'unknown'

export type AbaWorth = 'invest' | 'avoid' | 'watch' | 'unknown'

export interface AbaKeywordClassification {
  tier: AbaTier
  /** 点击集中度 ≥ 阈值 */
  monopolized: boolean | null
  worth: AbaWorth
  /** 建议匹配方式（本地方案生成用；不写进广告账户）。 */
  suggestedMatch: 'exact' | 'phrase' | 'broad' | null
  /** 一句话理由（中文，直接显示）。 */
  reason: string
}

export interface AbaThresholds {
  headMaxRank: number
  middleMaxRank: number
  monopolyPercent: number
  investPurchaseRate: number
  /** SPR 上限：超过就说明"要堆的评价太多"，判观察而不是值得投。 */
  maxSpr: number
  /** 商品数上限：超过就说明赛道太挤。 */
  maxProducts: number
}

export const DEFAULT_ABA_THRESHOLDS: AbaThresholds = {
  headMaxRank: 100,
  middleMaxRank: 1000,
  monopolyPercent: 0.5,
  investPurchaseRate: 0.02,
  maxSpr: 30,
  maxProducts: 5000,
}

export function normalizeAbaThresholds(input: Partial<AbaThresholds>): AbaThresholds {
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
  const head = num(input.headMaxRank, DEFAULT_ABA_THRESHOLDS.headMaxRank)
  const middle = Math.max(head, num(input.middleMaxRank, DEFAULT_ABA_THRESHOLDS.middleMaxRank))
  return {
    headMaxRank: Math.round(head),
    middleMaxRank: Math.round(middle),
    monopolyPercent: Math.min(1, num(input.monopolyPercent, DEFAULT_ABA_THRESHOLDS.monopolyPercent)),
    investPurchaseRate: Math.min(1, num(input.investPurchaseRate, DEFAULT_ABA_THRESHOLDS.investPurchaseRate)),
    maxSpr: Math.round(num(input.maxSpr, DEFAULT_ABA_THRESHOLDS.maxSpr)),
    maxProducts: Math.round(num(input.maxProducts, DEFAULT_ABA_THRESHOLDS.maxProducts)),
  }
}

function pct(value: number): string {
  return String(Math.round(value * 1000) / 10)
}

export function classifyAbaRow(row: AbaKeywordRow, input: Partial<AbaThresholds> = {}): AbaKeywordClassification {
  const t = normalizeAbaThresholds(input)
  const tier: AbaTier = row.rank === null ? 'unknown' : row.rank <= t.headMaxRank ? 'head' : row.rank <= t.middleMaxRank ? 'middle' : 'tail'
  const monopolized = row.clickConcentration === null ? null : row.clickConcentration >= t.monopolyPercent
  const suggestedMatch = tier === 'head' ? 'exact' : tier === 'middle' ? 'phrase' : tier === 'tail' ? 'broad' : null

  if (monopolized === true) {
    return {
      tier, monopolized, worth: 'avoid', suggestedMatch,
      reason: `点击集中度 ${(row.clickConcentration ?? 0) * 100 >= 100 ? 100 : Math.round((row.clickConcentration ?? 0) * 1000) / 10}% ≥ 阈值 ${Math.round(t.monopolyPercent * 100)}%：头部已吃掉过半点击，正面打精准不划算，可绕长尾`,
    }
  }
  if (row.purchaseRate !== null && row.purchaseRate >= t.investPurchaseRate) {
    /**
     * 进入成本两道闸（2026-10-24 由实际回填结论倒逼出来的）：
     * 只看"购买率高且没垄断"会把 SPR 88 的大词和 SPR 6 的词判成一样值得投，
     * 而两者的实际投入差一个量级。所以 **SPR / 商品数任一超限 → 降为观察**。
     */
    if (row.spr !== null && row.spr > t.maxSpr) {
      return {
        tier, monopolized, worth: 'watch', suggestedMatch,
        reason: `购买率 ${pct(row.purchaseRate)}% 达标，但 SPR ${row.spr} > ${t.maxSpr}：要堆的评价太多，先观察`,
      }
    }
    if (row.products !== null && row.products > t.maxProducts) {
      return {
        tier, monopolized, worth: 'watch', suggestedMatch,
        reason: `购买率 ${pct(row.purchaseRate)}% 达标，但商品数 ${row.products} > ${t.maxProducts}：赛道太挤，先观察`,
      }
    }
    if (row.spr === null && row.products === null) {
      /**
       * 进入成本一项都没有时**不许给"值得投"**：
       * 购买率只说明"有人买"，不说明"我们挤得进去"。宁可标观察，也不给一个
       * 让用户以为可以进的结论。
       */
      return {
        tier, monopolized, worth: 'watch', suggestedMatch,
        reason: `购买率 ${pct(row.purchaseRate)}% 达标，但缺 SPR 与商品数（进入成本未知）：不给"值得投"，先补证据`,
      }
    }
    return {
      tier, monopolized, worth: 'invest', suggestedMatch,
      reason: `购买率 ${pct(row.purchaseRate)}% ≥ ${Math.round(t.investPurchaseRate * 100)}%，未垄断，SPR ${row.spr ?? '未知'} / 商品数 ${row.products ?? '未知'} 在限内：值得投`,
    }
  }
  if (row.purchaseRate === null && row.clickConcentration === null) {
    return { tier, monopolized, worth: 'unknown', suggestedMatch, reason: '缺购买率与点击集中度：不足以下判断（unknown）' }
  }
  return {
    tier, monopolized, worth: 'watch', suggestedMatch,
    reason: row.purchaseRate === null
      ? '缺购买率：先观察，不凭排名下结论'
      : `购买率 ${pct(row.purchaseRate)}% 低于阈值 ${Math.round(t.investPurchaseRate * 100)}%：先观察`,
  }
}

export interface AbaParseResult {
  ok: boolean
  rows: AbaKeywordRow[]
  errors: string[]
  warnings: string[]
  headerRow?: number
  delimiter?: string
  /** 认出来的列 → 原始列名（让用户核对"它到底认了哪一列"）。 */
  mapping?: Record<string, string>
}

const KEYWORD_ALIASES = ['关键词', '搜索词', 'keyword', 'search term', 'customer search term', '用户搜索词', '客户搜索词', '搜索关键字', '词']
const RANK_ALIASES = ['搜索排名', '搜索频率排名', 'aba排名', '排名', 'search rank', 'search frequency rank', 'rank']
const SEARCHES_ALIASES = ['搜索量', '月搜索量', '搜索次数', 'searches', 'search volume', 'volume']
const CLICKS_ALIASES = ['点击', '点击量', '点击次数', 'clicks', 'click']
const PURCHASE_ALIASES = ['购买率', '购买转化率', '搜索购买比', '购买率(%)', 'purchase rate', 'conversion', '转化率']
const CONCENTRATION_ALIASES = ['点击集中度', '点击集中度(%)', '点击集中度（%）', '点击共享', 'monopoly click rate', 'click concentration', '点击集中度(前三)']
const SPR_ALIASES = ['spr', '需评数', '所需评价数', 'spr值', '标准产品研究']
const PRODUCTS_ALIASES = ['商品数', '商品数量', '在售商品数', '竞争商品数', '搜索结果数', 'products', 'product count']

function normalizeHeader(value: string): string {
  return value.replace(/\uFEFF/g, '').replace(/[\s"'（）()]/g, '').replace(/[%％]$/, '').toLowerCase()
}

function findColumn(headers: readonly string[], aliases: readonly string[]): number {
  const normalized = headers.map(normalizeHeader)
  for (const alias of aliases) {
    const target = normalizeHeader(alias)
    const exact = normalized.indexOf(target)
    if (exact !== -1) return exact
  }
  for (const alias of aliases) {
    const target = normalizeHeader(alias)
    /**
     * 模糊匹配必须**双方都有意义**（各 ≥2 字符）：
     * 之前允许单字符互相包含，于是表头 `a,b` 里的 `a` 命中了 `rank`（含字母 a），
     * 把垃圾表整列当成「关键词 / 排名 / 搜索量」全部认下去 —— 等于**编造数据**。
     */
    if (target.length < 2) continue
    const partial = normalized.findIndex((header) => header.length >= 2 && (header.includes(target) || target.includes(header)))
    if (partial !== -1) return partial
  }
  return -1
}

/** 数字清洗：去千分位、货币符号、百分号；`--` / 空 → null。 */
function toNumber(raw: string): number | null {
  const text = raw.trim().replace(/,/g, '').replace(/[$¥€£]/g, '')
  if (text === '' || text === '--' || text === '-' || text === '—' || text === 'N/A' || text === 'n/a') return null
  const value = Number(text.replace(/%$/, ''))
  return Number.isFinite(value) ? value : null
}

/**
 * 百分比归一。三种真实写法都要读对：
 * - 带 % 号（`0.8%` / `62%`）：**一律除以 100** —— 显式百分号优先于数值大小，
 *   否则 `0.8%` 会被当成 0.8（=80%），差 100 倍；
 * - 不带 % 且 >1（`3.5` / `62`）：视为百分数；
 * - 不带 % 且 ≤1（`0.035` / `0.5`）：视为比例。
 */
function toRatio(raw: string): number | null {
  const text = raw.trim()
  const value = toNumber(text)
  if (value === null) return null
  const explicitPercent = /[%％]/.test(text)
  if (explicitPercent) return value / 100
  return value > 1 ? value / 100 : value
}

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter !== ',') return line.split(delimiter).map((cell) => cell.trim())
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1 } else quoted = !quoted
    } else if (char === ',' && !quoted) { cells.push(current.trim()); current = '' } else current += char
  }
  cells.push(current.trim())
  return cells
}

export function parseAbaKeywordTable(text: string): AbaParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const lines = normalized.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return { ok: false, rows: [], errors: ['文件是空的'], warnings }

  const tabCount = (lines[0].match(/\t/g) ?? []).length
  const commaCount = (lines[0].match(/,/g) ?? []).length
  const delimiter = tabCount >= commaCount && tabCount > 0 ? '\t' : ','

  let headerIndex = -1
  let mapping: Record<string, number> = {}
  for (let i = 0; i < Math.min(lines.length, 8); i += 1) {
    const cells = splitLine(lines[i], delimiter)
    const keyword = findColumn(cells, KEYWORD_ALIASES)
    if (keyword === -1) continue
    headerIndex = i
    mapping = {
      keyword,
      rank: findColumn(cells, RANK_ALIASES),
      searches: findColumn(cells, SEARCHES_ALIASES),
      clicks: findColumn(cells, CLICKS_ALIASES),
      purchaseRate: findColumn(cells, PURCHASE_ALIASES),
      clickConcentration: findColumn(cells, CONCENTRATION_ALIASES),
      spr: findColumn(cells, SPR_ALIASES),
      products: findColumn(cells, PRODUCTS_ALIASES),
    }
    break
  }
  if (headerIndex === -1) {
    return { ok: false, rows: [], errors: ['前 8 行里找不到「关键词」列（支持：关键词 / 搜索词 / keyword）'], warnings }
  }

  const headerCells = splitLine(lines[headerIndex], delimiter)
  const mappingNames: Record<string, string> = {}
  for (const [key, index] of Object.entries(mapping)) {
    if (index >= 0) mappingNames[key] = headerCells[index] ?? ''
  }
  if (mapping.rank === -1) warnings.push('没有「搜索排名」列：无法分层（会全部标成 unknown）')
  if (mapping.purchaseRate === -1) warnings.push('没有「购买率」列：值得投的判断会退化为 unknown/观察')
  if (mapping.clickConcentration === -1) warnings.push('没有「点击集中度」列：无法判垄断')

  const rows: AbaKeywordRow[] = []
  const seen = new Set<string>()
  let duplicates = 0
  /** ≤1 且不带百分号的单元格数量（歧义提示用）。 */
  let ambiguousRatioCells = 0
  const scanAmbiguous = (raw: string): void => {
    const text = raw.trim()
    if (text === '' || /[%％]/.test(text)) return
    const value = Number(text.replace(/,/g, ''))
    if (Number.isFinite(value) && value > 0 && value <= 1) ambiguousRatioCells += 1
  }
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i], delimiter)
    const keywordRaw = (cells[mapping.keyword] ?? '').trim()
    if (keywordRaw === '') continue
    const keyword = keywordRaw.toLowerCase()
    if (seen.has(keyword)) { duplicates += 1; continue }
    seen.add(keyword)
    if (mapping.purchaseRate !== -1) scanAmbiguous(cells[mapping.purchaseRate] ?? '')
    if (mapping.clickConcentration !== -1) scanAmbiguous(cells[mapping.clickConcentration] ?? '')
    rows.push({
      keyword: keywordRaw,
      rank: mapping.rank === -1 ? null : toNumber(cells[mapping.rank] ?? ''),
      searches: mapping.searches === -1 ? null : toNumber(cells[mapping.searches] ?? ''),
      clicks: mapping.clicks === -1 ? null : toNumber(cells[mapping.clicks] ?? ''),
      purchaseRate: mapping.purchaseRate === -1 ? null : toRatio(cells[mapping.purchaseRate] ?? ''),
      clickConcentration: mapping.clickConcentration === -1 ? null : toRatio(cells[mapping.clickConcentration] ?? ''),
      spr: mapping.spr === -1 ? null : toNumber(cells[mapping.spr] ?? ''),
      products: mapping.products === -1 ? null : toNumber(cells[mapping.products] ?? ''),
    })
  }
  if (duplicates > 0) warnings.push(`有 ${duplicates} 行是重复关键词（已去重，保留首次出现）`)
  /**
   * 无百分号的 ≤1 值有歧义：`0.8` 可能是 0.8（=80%）也可能是 0.8%（写少了 %）。
   * 我们按比例解读（0.8 = 80%），但必须**说清**，否则一次误读会让整张表判反。
   */
  if (ambiguousRatioCells > 0) {
    warnings.push(`有 ${ambiguousRatioCells} 个购买率/点击集中度的值 ≤1 且没写百分号，已按比例解读（如 0.8 = 80%）；若原表是 0.8%，请补上 % 再导入`)
  }
  if (rows.length === 0) errors.push('没有可用数据行')

  return {
    ok: errors.length === 0,
    rows,
    errors,
    warnings,
    headerRow: headerIndex + 1,
    delimiter,
    mapping: mappingNames,
  }
}

export interface AbaTierSummary {
  tier: AbaTier
  count: number
  searches: number
  /** 该层里被垄断的词数（点击集中度未知的不计）。 */
  monopolized: number
}

export function summarizeAbaTiers(rows: readonly AbaKeywordRow[], input: Partial<AbaThresholds> = {}): AbaTierSummary[] {
  const order: AbaTier[] = ['head', 'middle', 'tail', 'unknown']
  const buckets = new Map<AbaTier, AbaTierSummary>()
  for (const tier of order) buckets.set(tier, { tier, count: 0, searches: 0, monopolized: 0 })
  for (const row of rows) {
    const { tier, monopolized } = classifyAbaRow(row, input)
    const bucket = buckets.get(tier) ?? buckets.get('unknown')!
    bucket.count += 1
    bucket.searches += row.searches ?? 0
    if (monopolized === true) bucket.monopolized += 1
  }
  return order.map((tier) => buckets.get(tier)!).filter((bucket) => bucket.count > 0)
}

/**
 * 服务端侧的入参清洗：客户端的解析结果**不可信**（也可能是别的工具直接 POST）。
 *
 * 只保留能表示为有限数的字段；比例类字段做 0–1 夹取（超范围说明来源不一致，
 * 夹到边界而不是丢掉整行 —— 丢行会让用户以为"导入少了词"）。
 */
export function sanitizeAbaRows(raw: unknown): AbaKeywordRow[] {
  if (!Array.isArray(raw)) return []
  const out: AbaKeywordRow[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const keyword = typeof row.keyword === 'string' ? row.keyword.trim() : ''
    if (keyword === '') continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    const ratio = (value: unknown): number | null => {
      const n = num(value)
      return n === null ? null : Math.min(1, Math.max(0, n))
    }
    /** 计数类（SPR / 商品数）：取整、不许为负。 */
    const count = (value: unknown): number | null => {
      const n = num(value)
      return n === null ? null : Math.max(0, Math.round(n))
    }
    out.push({
      keyword,
      rank: num(row.rank),
      searches: num(row.searches),
      clicks: num(row.clicks),
      purchaseRate: ratio(row.purchaseRate),
      clickConcentration: ratio(row.clickConcentration),
      spr: count(row.spr),
      products: count(row.products),
    })
  }
  return out
}

/** 回填建议的封闭枚举（DSH / 人工写回都只能填这几个）。 */
export const ABA_ANNOTATION_ACTIONS = ['invest', 'avoid', 'watch', 'unknown'] as const
export type AbaAnnotationAction = typeof ABA_ANNOTATION_ACTIONS[number]

export interface AbaAnnotation {
  keyword: string
  /** 覆盖本地算出来的 worth（人工/DSH 的结论优先）。 */
  worth: AbaAnnotationAction
  suggestedMatch: 'exact' | 'phrase' | 'broad' | null
  reason: string
  evidence: 'observed' | 'derived' | 'unknown'
  updatedAt: string
}
