/**
 * 亚马逊广告报表：解析 + 指标 + 规则 + 行动清单（P1：搜索词 / 投放 / 广告活动）。
 *
 * ## 为什么放在 shared
 * 解析在浏览器里做（粘贴即看，不把原始报表先传一遍），规则在浏览器里算，
 * 但要能被 node 测试直接调用 —— 所以是纯函数，不碰 DOM、不碰 HTTP、不碰 DB。
 *
 * ## 三条纪律（和 SOP 一致）
 * 1. **缺列就 needs_data**：不在缺列时猜 0，否则「花费 0」会被当成"表现很好"；
 * 2. **规则阈值可解释**：每条建议都带 `reason` 与命中的阈值，人不认同可以改阈值重算；
 * 3. **只产出人工确认清单**：不写广告账户、不生成 Bulk，导出的是"给人看/照着改"的表。
 *
 * ## 列名口径
 * 亚马逊后台导出有中英两套表头、还有 TSV；这里做别名归一化，
 * 表头找不到时按"缺列"处理，不按位置硬猜（位置会随报表类型变）。
 */

export const AD_REPORT_KINDS = ['search_term', 'targeting', 'campaign', 'placement', 'budget', 'impression_share'] as const
export type AdReportKind = typeof AD_REPORT_KINDS[number]

/** 存储用的行形状：以 `keyword` 承载「这条记录的主体」——搜索词 / 投放词 / 活动名 / 广告位。 */
export interface AdReportRow {
  keyword: string
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
  campaign?: string | null
  adGroup?: string | null
  matchType?: string | null
  budget?: number | null
  status?: string | null
  /** 广告位（placement 报表用它区分"搜索结果顶部 / 商品页面 / 其余位置"）。 */
  placement?: string | null
  /** 搜索词展示量份额（0–1），只有份额报表有。 */
  share?: number | null
}

export type AdActionCode =
  | 'add_exact' | 'add_phrase' | 'negative_exact' | 'negative_phrase'
  | 'raise_bid' | 'lower_bid' | 'pause'
  | 'add_budget' | 'reduce_budget'
  | 'watch' | 'none'

export const AD_ACTION_LABELS: Record<AdActionCode, string> = {
  add_exact: '加精准词',
  add_phrase: '加词组',
  negative_exact: '精准否定',
  negative_phrase: '词组否定',
  raise_bid: '提价',
  lower_bid: '降价',
  pause: '暂停/收量',
  add_budget: '加预算',
  reduce_budget: '降预算',
  watch: '观察',
  none: '不动',
}

/** 产品阶段：成长期容忍更贵的学习期，成熟期只认真实回报。 */
export type ProductStage = 'growth' | 'mature'

export interface RuleConfig {
  /** 目标 ACOS（0–1）。 */
  targetAcos: number
  /** 判否词/降价前的**最小点击**样本，避免拿 2 个点击下结论。 */
  minClicks: number
  /** 判「值得加词」的最小订单数。 */
  minOrders: number
  stage: ProductStage
  /** 预算使用率低于它视为「钱没花掉」；高于它视为「被预算卡住」。 */
  lowBudgetUsage: number
  highBudgetUsage: number
  /** 展示量份额低于它算「份额缺口」（份额报表用）。 */
  lowShare: number
}

export const DEFAULT_RULES: RuleConfig = {
  targetAcos: 0.3,
  minClicks: 12,
  minOrders: 2,
  stage: 'growth',
  lowBudgetUsage: 0.5,
  highBudgetUsage: 0.9,
  lowShare: 0.1,
}

export interface AdMetric extends AdReportRow {
  /** 点击率；曝光为 0 时为 null（不是 0）。 */
  ctr: number | null
  cvr: number | null
  cpc: number | null
  acos: number | null
  roas: number | null
  /** 预算使用率：仅有预算信息时非 null。 */
  budgetUsage: number | null
  /** 每条记录落在哪个格子（搜索词按「订单×ACOS」，投放/活动按「CTR×CVR」）。 */
  quadrant: string
}

export interface ActionItem {
  entity: string
  campaign: string | null
  code: AdActionCode
  /** 优先级：1 = 先做（止损或明显机会），3 = 有空再看。 */
  priority: 1 | 2 | 3
  reason: string
  evidence: 'observed' | 'derived'
}

export interface AdAnalysis {
  kind: AdReportKind
  rows: AdMetric[]
  actions: ActionItem[]
  kpi: {
    rows: number
    spend: number
    sales: number
    orders: number
    clicks: number
    impressions: number
    acos: number | null
    cvr: number | null
    cpc: number | null
    /** 无订单行的花费占比：0–1；没有花费时为 null。 */
    wastedSpendShare: number | null
  }
  quadrantCounts: Record<string, number>
}

/* ── 表头归一化 ─────────────────────────────────────────────────────────── */

/** 去掉空格/全角括号/大小写差异，便于中英表头共用一套别名。 */
function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .toLowerCase()
}

/** 每个字段的别名表；按顺序命中即用，命中多个时取第一个（别名内部不重叠）。 */
const COLUMN_ALIASES: Record<string, string[]> = {
  keyword: ['客户搜索词', '搜索词', '用户搜索词', 'searchterm', 'customersearchterm', 'query'],
  targeting: ['投放', '投放词', '关键词', 'targeting', 'keywordtext', 'target'],
  campaign: ['广告活动名称', '广告活动', 'campaignname', 'campaign'],
  adGroup: ['广告组名称', '广告组', 'adgroupname', 'adgroup'],
  matchType: ['匹配类型', 'matchtype'],
  status: ['广告活动状态', '状态', 'status', 'campaignstatus'],
  budget: ['预算', '每日预算', 'budget', 'dailybudget'],
  impressions: ['曝光量', '展示量', '曝光', 'impressions'],
  clicks: ['点击量', '点击', 'clicks'],
  spend: ['花费', '广告花费', 'spend', 'cost'],
  sales: ['销售额', '广告销售额', '7天总销售额', 'sales', 'attributedsales7d'],
  orders: ['订单', '订单数', '广告订单', '7天总订单', 'orders', 'purchases', 'attributedconversions7d'],
  placement: ['广告位', '广告位类型', '投放位置', 'placement', 'placementtype'],
  share: ['曝光份额', '展示量份额', '搜索词展示量份额', '搜索词曝光份额', 'impressionshare', 'searchtermimpressionshare', 'share'],
}

/** 份额列是百分比：`12.5%` → 0.125；`0.125` 这类小数位视为已经是比例。 */
function toShare(raw: string): number | null {
  const text = raw.trim()
  if (text === '' || text === '-') return null
  const parsed = toNumber(text) / 100
  return parsed > 1 ? 1 : parsed
}

/** 金额/计数清洗：去掉货币符号、千分位、百分号；空串与 '-' 视为 0。 */
function toNumber(raw: string): number {
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return 0
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/** 按分隔符切行：TSV 优先，逗号表头则按 CSV 处理（支持简单引号包裹）。 */
function splitRows(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return []
  const first = lines[0] ?? ''
  const delimiter = first.includes('\t') ? '\t' : ','
  return lines.map((line) => (delimiter === '\t' ? line.split('\t') : splitCsvLine(line)))
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1 } else quoted = !quoted
    } else if (char === ',' && !quoted) { out.push(current); current = '' } else current += char
  }
  out.push(current)
  return out
}

function findColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const index = headers.indexOf(alias)
    if (index >= 0) return index
  }
  return -1
}

export interface ParseResult {
  ok: boolean
  rows: AdReportRow[]
  /** 报表自带的日期范围（表头前几行「报告时间/日期范围」里读），读不到就是 null。 */
  period: string | null
  errors: string[]
  warnings: string[]
}

/** 解析一份广告报表；缺必需列时 `ok=false` 且 errors 说清缺哪列。 */
export function parseAdReportCsv(text: string, kind: AdReportKind): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const matrix = splitRows(text)
  if (matrix.length < 2) {
    return { ok: false, rows: [], period: null, errors: ['内容至少需要一行表头 + 一行数据'], warnings }
  }
  const headerRow = (matrix[0] ?? []).map(normalizeHeader)
  const body = matrix.slice(1)
  const period = findPeriod(text)

  /**
   * 主体列按报表类型选：
   * - placement / budget 的"主体"是广告位 / 活动名；
   * - impression_share 的主体仍是搜索词（份额附着在词上）。
   */
  const entityColumns: Record<AdReportKind, string[]> = {
    search_term: [...COLUMN_ALIASES.keyword!, ...COLUMN_ALIASES.campaign!],
    targeting: [...COLUMN_ALIASES.targeting!, ...COLUMN_ALIASES.campaign!],
    campaign: [...COLUMN_ALIASES.campaign!],
    placement: [...COLUMN_ALIASES.placement!, ...COLUMN_ALIASES.campaign!],
    budget: [...COLUMN_ALIASES.campaign!],
    impression_share: [...COLUMN_ALIASES.keyword!, ...COLUMN_ALIASES.targeting!],
  }
  const entityIndex = findColumn(headerRow, entityColumns[kind])
  const required: Array<[string, number]> = [
    ['曝光量', findColumn(headerRow, COLUMN_ALIASES.impressions!)],
    ['点击量', findColumn(headerRow, COLUMN_ALIASES.clicks!)],
    ['花费', findColumn(headerRow, COLUMN_ALIASES.spend!)],
  ]
  const missing = required.filter(([, index]) => index < 0).map(([name]) => name)
  const entityLabels: Record<AdReportKind, string> = {
    search_term: '客户搜索词', targeting: '投放', campaign: '广告活动名称',
    placement: '广告位', budget: '广告活动名称', impression_share: '客户搜索词',
  }
  if (entityIndex < 0) missing.unshift(entityLabels[kind])
  const shareIndex = findColumn(headerRow, COLUMN_ALIASES.share!)
  if (kind === 'impression_share' && shareIndex < 0) missing.push('曝光份额')
  if (missing.length > 0) {
    return { ok: false, rows: [], period, errors: [`缺少必需列：${missing.join('、')}`], warnings }
  }

  const salesIndex = findColumn(headerRow, COLUMN_ALIASES.sales!)
  const ordersIndex = findColumn(headerRow, COLUMN_ALIASES.orders!)
  const campaignIndex = kind === 'campaign' || kind === 'budget' ? entityIndex : findColumn(headerRow, COLUMN_ALIASES.campaign!)
  const adGroupIndex = findColumn(headerRow, COLUMN_ALIASES.adGroup!)
  const matchIndex = findColumn(headerRow, COLUMN_ALIASES.matchType!)
  const budgetIndex = findColumn(headerRow, COLUMN_ALIASES.budget!)
  const statusIndex = findColumn(headerRow, COLUMN_ALIASES.status!)
  const placementIndex = findColumn(headerRow, COLUMN_ALIASES.placement!)
  if (salesIndex < 0 || ordersIndex < 0) warnings.push('没有「销售额/订单」列时，ACOS 与转化判断会缺数据')

  const rows: AdReportRow[] = []
  const skipped: number[] = []
  body.forEach((cells, index) => {
    const entity = (cells[entityIndex] ?? '').trim()
    if (entity === '') { skipped.push(index + 2); return }
    const read = (column: number): number => (column < 0 ? 0 : toNumber(cells[column] ?? ''))
    const text2 = (column: number): string | null => {
      if (column < 0) return null
      const value = (cells[column] ?? '').trim()
      return value === '' ? null : value
    }
    const budgetRaw = text2(budgetIndex)
    rows.push({
      keyword: entity,
      impressions: read(required[0]![1]),
      clicks: read(required[1]![1]),
      orders: read(ordersIndex),
      spend: read(required[2]![1]),
      sales: read(salesIndex),
      campaign: campaignIndex >= 0 && campaignIndex !== entityIndex ? text2(campaignIndex) : (kind === 'campaign' || kind === 'budget' ? entity : null),
      adGroup: text2(adGroupIndex),
      matchType: text2(matchIndex),
      budget: budgetRaw === null ? null : toNumber(budgetRaw),
      status: text2(statusIndex),
      placement: placementIndex >= 0 ? text2(placementIndex) : (kind === 'placement' ? entity : null),
      share: shareIndex < 0 ? null : toShare(cells[shareIndex] ?? ''),
    })
  })

  if (rows.length === 0) errors.push('所有行都缺少主体列（搜索词/投放/活动名为空）')
  if (skipped.length > 0) warnings.push(`跳过 ${skipped.length} 行：主体列为空（第 ${skipped.slice(0, 5).join('、')} 行）`)
  return { ok: errors.length === 0, rows, period, errors, warnings }
}

/** 表头外的日期范围：亚马逊报表常在首行写 `报告时间：2026-10-01 - 2026-10-14`。 */
function findPeriod(text: string): string | null {
  const head = text.split(/\r?\n/).slice(0, 3).join(' ')
  const match = /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*(?:-|~|至|到)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/.exec(head)
  return match === null ? null : `${match[1]} ~ ${match[2]}`
}

/* ── 指标与规则 ─────────────────────────────────────────────────────────── */

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/** 阶段调整后的判据：成长期放宽点击门槛，成熟期收紧 ACOS 容忍度。 */
function effectiveRules(config: RuleConfig): { minClicks: number; acosCeiling: number } {
  const growth = config.stage === 'growth'
  return {
    minClicks: growth ? Math.round(config.minClicks * 1.5) : config.minClicks,
    acosCeiling: growth ? config.targetAcos * 1.2 : config.targetAcos,
  }
}

/** 象限切分：搜索词看「订单×ACOS」，投放/活动看「CTR×CVR」，各自用中位数做分界。 */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0)
}

/**
 * 象限口径按报表类型分：
 * - 搜索词：订单 × ACOS（能不能加/该不该否）；
 * - 投放：CTR × CVR（点击值不值、转化行不行）；
 * - 活动 / 预算：预算使用率 × 是否出单（该加钱还是该收钱）；
 * - 广告位：ACOS × 样本（该加价还是该降价）；
 * - 份额：份额 × 效能（低份额高效 = 机会）。
 */
function quadrantOf(
  kind: AdReportKind,
  row: AdReportRow,
  acos: number | null,
  ctr: number | null,
  cvr: number | null,
  config: RuleConfig,
  rules: { minClicks: number; acosCeiling: number },
  ctrMedian: number,
  cvrMedian: number,
): string {
  if (kind === 'search_term') {
    return row.orders >= config.minOrders
      ? (acos !== null && acos <= config.targetAcos ? '转化好·可加词' : '有单·ACOS 偏高')
      : (row.clicks >= rules.minClicks ? '花$无单' : '样本不足')
  }
  if (kind === 'campaign' || kind === 'budget') {
    const usage = typeof row.budget === 'number' && row.budget > 0 ? row.spend / row.budget : null
    if (usage === null) return row.orders > 0 ? '有单·无预算' : '无自营预算'
    if (usage >= config.highBudgetUsage) return acos !== null && acos <= config.targetAcos ? '受限·可加预算' : '受限·先控价'
    if (usage <= config.lowBudgetUsage) return row.orders > 0 ? '闲置·可放量' : '闲置·无产出'
    return '使用合理'
  }
  if (kind === 'placement') {
    if (row.clicks < rules.minClicks) return '样本不足'
    if (acos === null) return '有花费·无销售'
    return acos <= config.targetAcos ? '高效·可加价' : acos <= rules.acosCeiling ? '中性' : '低效·可降价'
  }
  if (kind === 'impression_share') {
    const low = (row.share ?? 0) <= config.lowShare
    const efficient = acos !== null && acos <= config.targetAcos
    if (low) return efficient ? '低份额高效（机会）' : '低份额低效'
    return efficient ? '高份额高效' : '高份额低效'
  }
  return (ctr ?? 0) >= ctrMedian && (cvr ?? 0) >= cvrMedian
    ? '高点击高转化'
    : (ctr ?? 0) >= ctrMedian ? '高点击低转化' : (cvr ?? 0) >= cvrMedian ? '低点击高转化' : '双低'
}

export function analyseAdReport(rows: AdReportRow[], kind: AdReportKind, config: RuleConfig = DEFAULT_RULES): AdAnalysis {
  const rules = effectiveRules(config)
  const ctrMedian = median(rows.map((row) => ratio(row.clicks, row.impressions) ?? 0))
  const cvrMedian = median(rows.map((row) => ratio(row.orders, row.clicks) ?? 0))
  const acosMedian = median(rows.filter((row) => row.sales > 0).map((row) => (row.spend / row.sales) * 100))

  const metrics: AdMetric[] = rows.map((row) => {
    const ctr = ratio(row.clicks, row.impressions)
    const cvr = ratio(row.orders, row.clicks)
    const cpc = ratio(row.spend, row.clicks)
    const acos = ratio(row.spend, row.sales)
    const roas = ratio(row.sales, row.spend)
    const budgetUsage = (kind === 'campaign' || kind === 'budget') && typeof row.budget === 'number' && row.budget > 0 ? row.spend / row.budget : null
    const quadrant = quadrantOf(kind, row, acos, ctr, cvr, config, rules, ctrMedian, cvrMedian)
    return { ...row, ctr, cvr, cpc, acos, roas, budgetUsage, quadrant }
  })

  const actions: ActionItem[] = []
  for (const metric of metrics) {
    const tip = decide(metric, kind, config, rules, acosMedian)
    if (tip !== null) actions.push(tip)
  }
  // 优先级先排 1，再按花费降序：先看最烧钱的
  actions.sort((a, b) => (a.priority - b.priority) || (spendOf(b, metrics) - spendOf(a, metrics)))

  const spend = metrics.reduce((sum, row) => sum + row.spend, 0)
  const sales = metrics.reduce((sum, row) => sum + row.sales, 0)
  const orders = metrics.reduce((sum, row) => sum + row.orders, 0)
  const clicks = metrics.reduce((sum, row) => sum + row.clicks, 0)
  const impressions = metrics.reduce((sum, row) => sum + row.impressions, 0)
  const wasted = metrics.filter((row) => row.orders === 0).reduce((sum, row) => sum + row.spend, 0)
  const quadrantCounts: Record<string, number> = {}
  for (const metric of metrics) quadrantCounts[metric.quadrant] = (quadrantCounts[metric.quadrant] ?? 0) + 1

  return {
    kind,
    rows: metrics,
    actions,
    kpi: {
      rows: metrics.length,
      spend, sales, orders, clicks, impressions,
      acos: ratio(spend, sales),
      cvr: ratio(orders, clicks),
      cpc: ratio(spend, clicks),
      wastedSpendShare: spend > 0 ? wasted / spend : null,
    },
    quadrantCounts,
  }
}

function spendOf(action: ActionItem, metrics: AdMetric[]): number {
  return metrics.find((row) => row.keyword === action.entity && (action.campaign === null || row.campaign === action.campaign))?.spend ?? 0
}

/**
 * 单行规则。返回 null = 不动（不生成噪音建议）。
 * 每条 reason 都写清阈值与命中值，便于人复核或改阈值重算。
 */
function decide(
  row: AdMetric,
  kind: AdReportKind,
  config: RuleConfig,
  rules: { minClicks: number; acosCeiling: number },
  acosMedian: number,
): ActionItem | null {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
  const base = { entity: row.keyword, campaign: row.campaign ?? null, evidence: 'derived' as const }

  if (kind === 'search_term') {
    if (row.orders >= config.minOrders && row.acos !== null && row.acos <= config.targetAcos) {
      return { ...base, code: 'add_exact', priority: 2, reason: `${row.orders} 单、ACOS ${pct(row.acos)} ≤ 目标 ${pct(config.targetAcos)}，值得单独建精准词` }
    }
    if (row.orders === 0 && row.clicks >= rules.minClicks && row.spend > 0) {
      return { ...base, code: 'negative_exact', priority: 1, reason: `0 单、点击 ${row.clicks} ≥ 门槛 ${rules.minClicks}、花费 $${row.spend.toFixed(2)}，建议精准否定` }
    }
    if (row.orders === 0 && row.clicks >= Math.ceil(rules.minClicks / 2) && row.spend > 0) {
      return { ...base, code: 'watch', priority: 3, reason: `0 单但点击 ${row.clicks} 未到否词门槛 ${rules.minClicks}，先观察` }
    }
    if (row.orders >= config.minOrders && row.acos !== null && row.acos > config.targetAcos) {
      return { ...base, code: 'watch', priority: 2, reason: `有 ${row.orders} 单但 ACOS ${pct(row.acos)} 高于目标 ${pct(config.targetAcos)}，先控价再决定加词` }
    }
    return null
  }

  if (kind === 'targeting') {
    if (row.orders === 0 && row.clicks >= rules.minClicks * 2 && row.spend > 0) {
      return { ...base, code: 'pause', priority: 1, reason: `0 单且点击 ${row.clicks} ≥ 门槛 ${rules.minClicks * 2}，建议暂停或降为观察` }
    }
    if (row.acos !== null && row.acos <= config.targetAcos && row.clicks >= rules.minClicks) {
      return { ...base, code: 'raise_bid', priority: 2, reason: `ACOS ${pct(row.acos)} ≤ 目标 ${pct(config.targetAcos)} 且点击 ${row.clicks} 达样本，可小幅提价` }
    }
    if (row.acos !== null && row.acos > rules.acosCeiling && row.clicks >= rules.minClicks) {
      return { ...base, code: 'lower_bid', priority: 1, reason: `ACOS ${pct(row.acos)} 超过容忍线 ${pct(rules.acosCeiling)}（目标 ${pct(config.targetAcos)}），建议降价` }
    }
    if (row.orders === 0 && row.spend > 0) {
      return { ...base, code: 'watch', priority: 3, reason: `0 单、点击 ${row.clicks} 未到处理门槛，先观察` }
    }
    return null
  }

  if (kind === 'placement') {
    if (row.clicks < rules.minClicks) return null
    if (row.orders === 0 && row.spend > 0) {
      return { ...base, code: 'lower_bid', priority: 1, reason: `该广告位 0 单、点击 ${row.clicks} 达样本、花费 $${row.spend.toFixed(2)}，建议降低广告位加价` }
    }
    if (row.acos !== null && row.acos <= config.targetAcos) {
      return { ...base, code: 'raise_bid', priority: 2, reason: `该广告位 ACOS ${pct(row.acos)} ≤ 目标 ${pct(config.targetAcos)}，可提高广告位加价抢量` }
    }
    if (row.acos !== null && row.acos > rules.acosCeiling) {
      return { ...base, code: 'lower_bid', priority: 1, reason: `该广告位 ACOS ${pct(row.acos)} 超过容忍线 ${pct(rules.acosCeiling)}，建议降低加价` }
    }
    return null
  }

  if (kind === 'impression_share') {
    const share = row.share
    if (share === null || share === undefined) return null
    if (share <= config.lowShare && row.acos !== null && row.acos <= config.targetAcos && row.orders > 0) {
      return { ...base, code: 'raise_bid', priority: 2, reason: `份额仅 ${pct(share)}、ACOS ${pct(row.acos)} 达标且有 ${row.orders} 单，是低份额高效机会词，可提价抢曝光` }
    }
    if (share <= config.lowShare && row.orders === 0) {
      return { ...base, code: 'watch', priority: 3, reason: `份额 ${pct(share)} 且 0 单：曝光不够，先补样本再判断` }
    }
    if (share > config.lowShare && row.acos !== null && row.acos > rules.acosCeiling) {
      return { ...base, code: 'lower_bid', priority: 1, reason: `份额 ${pct(share)} 已有曝光但 ACOS ${pct(row.acos)} 超容忍线，先压价保利润` }
    }
    return null
  }

  // campaign / budget：同一套预算规则（两张报表都能算预算使用率）
  const usage = row.budgetUsage
  if (usage !== null && usage >= config.highBudgetUsage && row.acos !== null && row.acos <= config.targetAcos) {
    return { ...base, code: 'add_budget', priority: 2, reason: `预算使用 ${pct(usage)} ≥ ${pct(config.highBudgetUsage)} 且 ACOS ${pct(row.acos)} ≤ 目标，加预算能吃到更多单` }
  }
  if (usage !== null && usage >= config.highBudgetUsage && row.acos !== null && row.acos > rules.acosCeiling) {
    return { ...base, code: 'watch', priority: 1, reason: `预算打满（${pct(usage)}）但 ACOS ${pct(row.acos)} 超容忍线，先压价再加预算` }
  }
  if (usage !== null && usage <= config.lowBudgetUsage && row.orders === 0 && row.spend > 0) {
    return { ...base, code: 'reduce_budget', priority: 2, reason: `预算只用 ${pct(usage)} 且 0 单，钱没花掉也没产出，建议降到观察池` }
  }
  if (kind === 'budget' && usage !== null && usage <= config.lowBudgetUsage && row.orders > 0 && row.acos !== null && row.acos <= config.targetAcos) {
    return { ...base, code: 'watch', priority: 3, reason: `预算只用 ${pct(usage)} 但有 ${row.orders} 单且 ACOS 达标：钱没花掉，确认预算/竞价是否过低` }
  }
  if (row.spend > 0 && row.acos !== null && row.acos > rules.acosCeiling && row.acos > acosMedian) {
    return { ...base, code: 'lower_bid', priority: 3, reason: `ACOS ${pct(row.acos)} 高于期望线且高于同批中位 ${pct(acosMedian)}，可降价试一轮` }
  }
  return null
}

/* ── 导出（人工确认清单） ───────────────────────────────────────────────── */

/** 主体列名按报表类型取，导出的表头要能直接看懂是哪一列。 */
const ENTITY_HEADER: Record<AdReportKind, string> = {
  search_term: '搜索词',
  targeting: '投放',
  campaign: '广告活动',
  placement: '广告位',
  budget: '广告活动',
  impression_share: '搜索词',
}

/** 主体就是活动本身时不再重复一列「广告活动」。 */
function entityIsCampaign(kind: AdReportKind): boolean {
  return kind === 'campaign' || kind === 'budget'
}

export function actionsToCsv(actions: ActionItem[], kind: AdReportKind): string {
  const header = entityIsCampaign(kind)
    ? [ENTITY_HEADER[kind], '建议动作', '优先级', '理由']
    : [ENTITY_HEADER[kind], '广告活动', '建议动作', '优先级', '理由']
  const lines = [header.join(',')]
  for (const action of actions) {
    const label = AD_ACTION_LABELS[action.code]
    const cells = entityIsCampaign(kind)
      ? [action.entity, label, String(action.priority), action.reason]
      : [action.entity, action.campaign ?? '', label, String(action.priority), action.reason]
    lines.push(cells.map(escapeCsv).join(','))
  }
  return `${lines.join('\n')}\n`
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
