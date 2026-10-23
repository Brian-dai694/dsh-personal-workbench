import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { calculateAmazonBid, calculateAmazonEconomics, type AmazonCalculatorInput } from './client/amazonCalculator.js'
import { buildKeywordPlan, type KeywordMatch } from './client/amazonKeywordTools.js'
import { analyseTraffic, parseTrafficCsv } from './client/amazonTrafficTools.js'
import { getAmazonDataset, getLatestAmazonDataset, saveSearchTermReview } from './db/repo.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function numberArg(args: Record<string, unknown>, key: string, fallback = 0): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function money(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `$${value.toFixed(2)}`
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(2)}%`
}

export function amazonBidCalculatorTool() {
  return defineTool({
    name: 'amazon_calculate_bid_cpc',
    description: '在当前 DSH 对话中调用个人工作台的广告竞价计算工具。按基础 Bid、广告位加价百分比和最高倍数计算最高 CPC。只输出建议，不修改广告账户；实际竞价、预算和广告位表现仍需账户报表核验。',
    parameters: {
      bid: { type: 'number', required: true, description: '基础竞价 USD' },
      placement_percent: { type: 'number', required: true, description: '广告位加价百分比，例如 50 表示 +50%' },
      max_multiplier: { type: 'number', required: true, description: '最高倍数，例如 2 表示最多乘 2' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const bid = numberArg(args, 'bid', Number.NaN)
      const placementPercent = numberArg(args, 'placement_percent', Number.NaN)
      const maxMultiplier = numberArg(args, 'max_multiplier', Number.NaN)
      if (![bid, placementPercent, maxMultiplier].every(Number.isFinite) || bid < 0 || placementPercent < 0 || maxMultiplier < 0) {
        return 'invalid_input：bid、placement_percent、max_multiplier 必须是非负数字'
      }
      const result = calculateAmazonBid({ bid, placementPercent, maxMultiplier })
      return [
        'Amazon 广告竞价计算结果（derived；只提供建议，不修改广告账户）',
        `公式：Bid × (1 + 广告位加价/100) × 最高倍数`,
        `最高 CPC：$${result.highestCpc.toFixed(2)}（基础竞价 $${bid.toFixed(2)} × ${1 + placementPercent / 100} × ${maxMultiplier}）`,
        'unknown/needs_data：未连接广告账户，实际竞价、广告位流量、ACOS 和转化表现需用账户报表核验。请人工确认后再改价。',
      ] .join('\n')
    },
  })
}

export function amazonCpcBreakevenTool() {
  return defineTool({
    name: 'workbench_cpc_breakeven',
    description: '在当前 DSH 对话中调用个人工作台的亚马逊利润/CPC 工具。根据售价、成本、费率、目标 ACOS 和转化率计算有效毛利、盈亏平衡 ACOS/CPC、建议 CPC 和广告后利润。只输出可审阅建议，不修改广告账户。没有真实账户 ACOS 时必须标记 unknown。',
    parameters: {
      price: { type: 'number', required: true, description: '售价 USD' },
      unit_cost: { type: 'number', required: true, description: '采购成本 USD' },
      freight: { type: 'number', required: true, description: '头程运费 USD' },
      fba_fee: { type: 'number', required: true, description: 'FBA 费用 USD' },
      referral_fee: { type: 'number', required: true, description: '佣金 USD' },
      storage_fee: { type: 'number', required: true, description: '按单件摊销仓储费 USD' },
      removal_fee: { type: 'number', required: true, description: '按单件摊销移除/弃置费 USD' },
      promotion_cost: { type: 'number', required: true, description: '按单件摊销促销折扣及活动费用 USD' },
      return_rate: { type: 'number', required: true, description: '退货率，0-1，例如 0.03' },
      return_loss: { type: 'number', required: true, description: '每笔退货额外损失 USD' },
      other_costs: { type: 'number', required: true, description: '其他单件费用 USD' },
      target_acos: { type: 'number', required: true, description: '目标 ACOS，0-1，例如 0.25' },
      conversion_rate: { type: 'number', required: true, description: '转化率，0-1，例如 0.1' },
      ad_order_share: { type: 'number', required: true, description: '广告订单占比，0-1，例如 0.6' },
      market_cpc: { type: 'number', description: '市场参考 CPC USD，可省略；不代表账户实际 CPC' },
      calibration_cpc: { type: 'number', description: '外部 CPC 计算器结果 USD，用于差异校准；不可伪造或省略来源说明' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const input: AmazonCalculatorInput = {
        price: numberArg(args, 'price'),
        unitCost: numberArg(args, 'unit_cost'),
        freight: numberArg(args, 'freight'),
        fbaFee: numberArg(args, 'fba_fee'),
        referralFee: numberArg(args, 'referral_fee'),
        storageFee: numberArg(args, 'storage_fee'),
        removalFee: numberArg(args, 'removal_fee'),
        promotionCost: numberArg(args, 'promotion_cost'),
        returnRate: numberArg(args, 'return_rate'),
        returnLoss: numberArg(args, 'return_loss'),
        otherCosts: numberArg(args, 'other_costs'),
        targetAcos: numberArg(args, 'target_acos'),
        conversionRate: numberArg(args, 'conversion_rate'),
        adOrderShare: numberArg(args, 'ad_order_share'),
        marketCpc: numberArg(args, 'market_cpc'),
        calibrationCpc: typeof args.calibration_cpc === 'number' ? args.calibration_cpc : undefined,
      }
      const result = calculateAmazonEconomics(input)
      if (!result.valid) return `needs_data/invalid_input：${result.errors.join('；')}`
      return [
        'Amazon 利润/CPC 联动结果（derived；仅建议，不修改广告账户）',
        `有效单件毛利：${money(result.effectiveProfit)}；有效毛利率：${percent(result.marginRate)}`,
        `盈亏平衡 ACOS：${percent(result.breakEvenAcos)}；盈亏平衡 CPC：${money(result.breakEvenCpc)}`,
        `目标 ACOS 对应建议 CPC：${money(result.suggestedCpc)}；盈亏平衡 CPC 安全值（80%）：${money(result.breakEvenCpc === null ? null : result.breakEvenCpc * 0.8)}`,
        `目标 ACOS 下广告后利润：${money(result.profitAfterAds)}；市场 CPC 差值：${result.marketCpcGap === null ? 'unknown/未提供' : money(result.marketCpcGap)}`,
        result.effectiveProfit <= 0 ? '风险：有效毛利不为正，不建议扩量。' : '下一步：结合真实广告报告、库存和排名做人工确认。账户实际 ACOS：unknown（本工具未连接广告账户）。',
      ].join('\n')
    },
  })
}

export function amazonKeywordCombinerTool() {
  return defineTool({
    name: 'amazon_combine_keywords',
    description: '在当前 DSH 对话中调用个人工作台的关键词组合器。把多组词根按连接符、前缀、后缀生成去重候选词。只输出候选，不编造搜索量、不判断相关性、不创建广告；生成后仍需人工检查相关性、商标和 ABA/卖家精灵证据。',
    parameters: {
      groups: { type: 'json', required: true, description: '词组数组，例如 [["tig","mig"],["torch","gun"]]；每组不能为空' },
      joiner: { type: 'string', description: '组之间连接符，默认空格' },
      prefixes: { type: 'json', description: '可选前缀数组，例如 ["best", "welding"]' },
      suffixes: { type: 'json', description: '可选后缀数组，例如 ["for beginners"]' },
      limit: { type: 'number', description: '最多返回条数，默认 200，最大 1000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const rawGroups = Array.isArray(args.groups) ? args.groups : []
      const groups = rawGroups.map((group) => Array.isArray(group)
        ? group.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
        : [])
      if (groups.length === 0 || groups.some((group) => group.length === 0)) return 'needs_data：groups 必须是至少一组非空词组数组'
      const joiner = typeof args.joiner === 'string' ? args.joiner : ' '
      const prefixes = Array.isArray(args.prefixes) ? args.prefixes.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean) : ['']
      const suffixes = Array.isArray(args.suffixes) ? args.suffixes.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean) : ['']
      const requestedLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 200
      const limit = Math.max(1, Math.min(1000, requestedLimit))
      let combinations: string[][] = [[]]
      for (const group of groups) {
        const next: string[][] = []
        for (const previous of combinations) for (const value of group) next.push([...previous, value])
        combinations = next
        if (combinations.length > limit * 2) break
      }
      const rows = [...new Set(combinations.flatMap((parts) => prefixes.flatMap((prefix) => suffixes.map((suffix) => `${prefix ? `${prefix}${joiner}` : ''}${parts.join(joiner)}${suffix ? `${joiner}${suffix}` : ''}`.trim()))))].filter(Boolean)
      const shown = rows.slice(0, limit)
      return [
        `Amazon 关键词组合结果（derived；共生成 ${rows.length} 条，返回 ${shown.length} 条）`,
        shown.map((keyword, index) => `${index + 1}. ${keyword}`).join('\n'),
        rows.length > shown.length ? `提示：结果已限制为 ${limit} 条，未展示 ${rows.length - shown.length} 条。` : '',
        'needs_data：组合结果没有搜索量、竞争度、转化或相关性证据；请结合 ABA/卖家精灵和产品信息人工筛选后再进入投放准备。',
      ].filter(Boolean).join('\n')
    },
  })
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []; let field = ''; let quoted = false
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i]
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i += 1 } else quoted = !quoted
    } else if ((char === ',' || char === '\t') && !quoted) { row.push(field); field = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && csv[i + 1] === '\n') i += 1
      row.push(field); field = ''; if (row.some((value) => value.trim() !== '')) rows.push(row); row = []
    } else field += char
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function norm(value: string): string { return value.trim().toLowerCase().replace(/[\s_()-]/g, '') }
function numeric(value: string): number | null {
  const parsed = Number(value.replace(/[,$%\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function amazonKeywordStrategyTool() {
  return defineTool({
    name: 'amazon_classify_keyword_strategy',
    description: '在当前 DSH 对话中调用个人工作台的关键词策略工具。传入 ABA 热门搜索词 CSV 原文，按 ABA 排名区间分为头部/中部/长尾，并可按 ASIN 转化份额阈值标记可能垄断词。缺列或格式错误直接返回 needs_data；不把市场数据当成账户表现。',
    parameters: {
      csv: { type: 'string', required: true, description: 'ABA 热门搜索词 CSV 或 TSV 原文，需包含关键词和 ABA 排名列，可选 ASIN 转化份额列' },
      head_max_rank: { type: 'number', description: '头部词最大排名，默认 100' },
      middle_max_rank: { type: 'number', description: '中部词最大排名，默认 1000' },
      conversion_share_threshold: { type: 'number', description: 'ASIN 转化份额垄断阈值，百分比数值，例如 50' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const csv = typeof args.csv === 'string' ? args.csv : ''
      if (csv.trim() === '') return 'needs_data：请提供 ABA 热门搜索词 CSV/TSV 原文'
      if (csv.length > 1_500_000) return 'invalid_input：文件内容超过 1.5MB，请按周期或店铺拆分'
      let rows: string[][]
      try { rows = parseCsv(csv) } catch (error) { return `needs_data：${error instanceof Error ? error.message : 'CSV 解析失败'}` }
      if (rows.length < 2) return 'needs_data：至少需要表头和一行数据'
      const headerIndex = rows.findIndex((row) => row.some((value) => /search.?term|关键词|搜索词/i.test(norm(value))) && row.some((value) => /aba|排名|rank/i.test(norm(value))))
      if (headerIndex < 0) return 'needs_data：找不到同时包含关键词和 ABA 排名的表头'
      const header = rows[headerIndex].map(norm)
      const keywordIndex = header.findIndex((value) => /searchterm|keyword|用户搜索词|搜索词/.test(value))
      const rankIndex = header.findIndex((value) => /abarank|rank|排名|搜索排名/.test(value))
      const shareIndex = header.findIndex((value) => /conversion.*share|转化份额|转化率/.test(value))
      if (keywordIndex < 0 || rankIndex < 0) return 'needs_data：缺少关键词或 ABA 排名列'
      const headMax = typeof args.head_max_rank === 'number' && args.head_max_rank > 0 ? Math.floor(args.head_max_rank) : 100
      const middleMax = typeof args.middle_max_rank === 'number' && args.middle_max_rank > headMax ? Math.floor(args.middle_max_rank) : 1000
      const threshold = typeof args.conversion_share_threshold === 'number' && args.conversion_share_threshold > 0 ? args.conversion_share_threshold : 50
      const counts = { head: 0, middle: 0, longTail: 0, invalid: 0, dominated: 0 }
      const samples: string[] = []
      for (const row of rows.slice(headerIndex + 1)) {
        const keyword = row[keywordIndex]?.trim() ?? ''
        const rank = numeric(row[rankIndex] ?? '')
        if (keyword === '' || rank === null || rank <= 0) { counts.invalid += 1; continue }
        const bucket = rank <= headMax ? '头部词' : rank <= middleMax ? '中部词' : '长尾词'
        counts[bucket === '头部词' ? 'head' : bucket === '中部词' ? 'middle' : 'longTail'] += 1
        const share = shareIndex >= 0 ? numeric(row[shareIndex] ?? '') : null
        const dominated = share !== null && share >= threshold
        if (dominated) counts.dominated += 1
        if (samples.length < 30) samples.push(`${keyword} | ABA ${Math.round(rank)} | ${bucket}${dominated ? ` | 可能垄断：转化份额 ${share}%` : ''}`)
      }
      return [
        `Amazon 关键词策略分层（derived；市场数据，不是账户表现）`,
        `头部词（1-${headMax}）：${counts.head}；中部词（${headMax + 1}-${middleMax}）：${counts.middle}；长尾词（>${middleMax}）：${counts.longTail}；无效行：${counts.invalid}`,
        shareIndex >= 0 ? `ASIN 转化份额≥${threshold}% 的可能垄断词：${counts.dominated} 条` : 'needs_data：未找到 ASIN 转化份额列，无法执行垄断词过滤',
        samples.length > 0 ? `样例：\n${samples.join('\n')}` : 'needs_data：没有可用关键词数据行',
        '下一步：结合产品相关性、卖家精灵/ABA 证据和投放单元级广告报告人工筛选；本工具不创建广告、不执行否词。',
      ] .join('\n')
    },
  })
}

type VolatilityRow = { keyword: string; rank: number; clicksShare: number; conversionShare: number }

function parseVolatilityRows(csv: string): { rows: VolatilityRow[]; error?: string } {
  let records: string[][]
  try { records = parseCsv(csv) } catch (error) { return { rows: [], error: error instanceof Error ? error.message : 'CSV 解析失败' } }
  if (records.length < 2) return { rows: [], error: '至少需要表头和一行数据' }
  const headerIndex = records.findIndex((row) => row.some((value) => /search.?term|关键词|搜索词/i.test(norm(value))) && row.some((value) => /aba|排名|rank/i.test(norm(value))))
  if (headerIndex < 0) return { rows: [], error: '找不到同时包含关键词和 ABA 排名的表头' }
  const header = records[headerIndex].map(norm)
  const find = (pattern: RegExp) => header.findIndex((value) => pattern.test(value))
  const keywordIndex = find(/searchterm|keyword|用户搜索词|搜索词/)
  const rankIndex = find(/abarank|rank|排名|搜索排名/)
  const clicksIndex = find(/top.?3.*click|前三.*点击|点击份额/)
  const conversionIndex = find(/top.?3.*conversion|前三.*转化|转化份额/)
  if ([keywordIndex, rankIndex, clicksIndex, conversionIndex].some((index) => index < 0)) return { rows: [], error: '需要关键词、ABA 排名、前三点击份额、前三转化份额四列' }
  const rows: VolatilityRow[] = []
  for (const record of records.slice(headerIndex + 1)) {
    const keyword = record[keywordIndex]?.trim() ?? ''
    const rank = numeric(record[rankIndex] ?? '')
    const clicksShare = numeric(record[clicksIndex] ?? '')
    const conversionShare = numeric(record[conversionIndex] ?? '')
    if (keyword === '' || rank === null || clicksShare === null || conversionShare === null || rank <= 0) continue
    rows.push({ keyword, rank, clicksShare, conversionShare })
  }
  return { rows }
}

export function amazonSearchTermVolatilityTool() {
  return defineTool({
    name: 'amazon_analyze_search_term_volatility',
    description: '在当前 DSH 对话中调用个人工作台的搜索词波动分析工具。比较两期 ABA CSV/TSV 中同一关键词的 ABA 排名、前三点击份额和前三转化份额变化，筛选波动较大的词。只输出研究清单，不执行否词、调价或预算修改。',
    parameters: {
      baseline_csv: { type: 'string', required: true, description: '基准期 ABA 搜索词 CSV/TSV 原文' },
      current_csv: { type: 'string', required: true, description: '当前期 ABA 搜索词 CSV/TSV 原文' },
      change_threshold_percent: { type: 'number', description: '任一指标绝对变化达到该百分比即标记，默认 30' },
      limit: { type: 'number', description: '最多返回词数，默认 50，最大 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const baseline = typeof args.baseline_csv === 'string' ? args.baseline_csv : ''
      const current = typeof args.current_csv === 'string' ? args.current_csv : ''
      if (baseline.trim() === '' || current.trim() === '') return 'needs_data：请同时提供基准期和当前期 ABA CSV/TSV 原文'
      if (baseline.length + current.length > 2_500_000) return 'invalid_input：两期文件合计超过 2.5MB，请按店铺或周期拆分'
      const before = parseVolatilityRows(baseline)
      const after = parseVolatilityRows(current)
      if (before.error) return `needs_data：基准期输入校验失败：${before.error}`
      if (after.error) return `needs_data：当前期输入校验失败：${after.error}`
      const beforeMap = new Map(before.rows.map((row) => [row.keyword.toLowerCase(), row]))
      const threshold = typeof args.change_threshold_percent === 'number' && args.change_threshold_percent > 0 ? args.change_threshold_percent : 30
      const limitRaw = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50
      const limit = Math.min(200, limitRaw)
      const changes = after.rows.flatMap((now) => {
        const old = beforeMap.get(now.keyword.toLowerCase())
        if (!old) return []
        const change = (currentValue: number, oldValue: number) => oldValue === 0 ? (currentValue === 0 ? 0 : 100) : Math.abs((currentValue - oldValue) / oldValue) * 100
        const rankChange = change(now.rank, old.rank)
        const clicksChange = change(now.clicksShare, old.clicksShare)
        const conversionChange = change(now.conversionShare, old.conversionShare)
        const maxChange = Math.max(rankChange, clicksChange, conversionChange)
        return maxChange >= threshold ? [{ now, old, rankChange, clicksChange, conversionChange, maxChange }] : []
      }).sort((a, b) => b.maxChange - a.maxChange).slice(0, limit)
      const preview = changes.map((item, index) => `${index + 1}. ${item.now.keyword} | ABA ${item.old.rank}→${item.now.rank}（${item.rankChange.toFixed(1)}%）| 点击份额 ${item.old.clicksShare}%→${item.now.clicksShare}%（${item.clicksChange.toFixed(1)}%）| 转化份额 ${item.old.conversionShare}%→${item.now.conversionShare}%（${item.conversionChange.toFixed(1)}%）`).join('\n')
      return [
        `Amazon 搜索词波动分析（derived；匹配 ${before.rows.length}→${after.rows.length} 行）`,
        `阈值：任一指标绝对变化 ≥${threshold}%；波动词：${changes.length} 条`,
        preview || '没有达到阈值的匹配词，或两期关键词没有交集。',
        'unknown/needs_data：波动不等于广告问题或可执行动作；还需结合投放单元、广告报告、Listing、库存和毛利人工判断。不要仅凭词级波动否词或调价。',
      ] .join('\n')
    },
  })
}

export function amazonKeywordPlannerTool() {
  return defineTool({
    name: 'amazon_build_keyword_plan',
    description: '在当前 DSH 对话中调用个人工作台的关键词规划工具。根据核心词和修饰词生成精准/词组/广泛候选及活动路由。只生成待审阅候选，不编造搜索量、不创建广告。',
    parameters: {
      seed: { type: 'string', required: true, description: '产品核心词' },
      modifiers: { type: 'string', description: '规格、场景、人群修饰词，逗号或空格分隔' },
      match_types: { type: 'json', description: '可选数组：exact、phrase、broad；默认三种' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const seed = typeof args.seed === 'string' ? args.seed.trim() : ''
      if (seed === '') return 'needs_data：seed 核心词不能为空'
      const rawTypes = Array.isArray(args.match_types) ? args.match_types : undefined
      const allowed: KeywordMatch[] = ['exact', 'phrase', 'broad']
      const matchTypes = rawTypes === undefined ? allowed : rawTypes.filter((value): value is KeywordMatch => typeof value === 'string' && allowed.includes(value as KeywordMatch))
      if (matchTypes.length === 0) return 'invalid_input：match_types 必须包含 exact、phrase、broad 至少一项'
      const modifiers = typeof args.modifiers === 'string' ? args.modifiers : ''
      const rows = buildKeywordPlan(seed, modifiers, matchTypes)
      const preview = rows.slice(0, 100).map((row, index) => `${index + 1}. ${row.keyword} | ${row.match} | ${row.campaign} | ${row.rationale}`).join('\n')
      return `Amazon 关键词规划结果（derived；${rows.length} 条）\n${preview}\n\nunknown/needs_data：未连接 ABA、卖家精灵或广告账户，暂无搜索量、竞争度和实际转化证据。只生成候选，不创建广告。`
    },
  })
}

export function amazonTrafficAnalyzerTool() {
  return defineTool({
    name: 'amazon_analyze_traffic_csv',
    description: '在当前 DSH 对话中调用个人工作台的搜索词/流量分析工具。传入 Amazon Ads CSV 原文，校验中文或英文列名并计算 CTR、CVR、CPC、ACOS、ROAS，返回异常诊断。只读分析，不执行否词、调价或预算修改。',
    parameters: {
      csv: { type: 'string', required: true, description: 'Amazon Ads 搜索词 CSV 原文（可含 Reporting Range 元数据行）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const csv = typeof args.csv === 'string' ? args.csv : ''
      if (csv.trim() === '') return 'needs_data：请提供搜索词 CSV 原文'
      if (csv.length > 1_500_000) return 'invalid_input：CSV 超过 1.5MB，请按周期或店铺拆分后再分析'
      const parsed = parseTrafficCsv(csv)
      if (!parsed.ok) return `needs_data：输入校验未通过：${parsed.errors.join('；')}`
      const rows = analyseTraffic(parsed.rows)
      const highRisk = rows.filter((row) => row.clicks >= 8 && row.orders === 0).slice(0, 20)
      const efficient = rows.filter((row) => row.orders > 0 && (row.acos ?? 1) <= 0.3).slice(0, 20)
      return [
        `Amazon 流量分析结果（derived；周期：${parsed.period ?? '未提供'}；${rows.length} 行）`,
        `observed：已解析输入 CSV；账户实际数据仅来自用户提供文件。`,
        `高点击无订单：${highRisk.length} 条${highRisk.length > 0 ? `\n${highRisk.map((row) => `- ${row.keyword}：${row.clicks} clicks，花费 $${row.spend.toFixed(2)}`).join('\n')}` : ''}`,
        `有转化且 ACOS≤30%：${efficient.length} 条${efficient.length > 0 ? `\n${efficient.map((row) => `- ${row.keyword}：ACOS ${row.acos === null ? '—' : `${(row.acos * 100).toFixed(2)}%`}，ROAS ${row.roas?.toFixed(2) ?? '—'}`).join('\n')}` : ''}`,
        'unknown/needs_data：未提供 Listing、库存、毛利和多周期对照，不能仅凭本文件执行否词、调价或预算修改。',
      ].join('\n')
    },
  })
}

/**
 * 读工作台里**已导入**的搜索词报表（agent 的读通道）。
 *
 * 与 `amazon_analyze_traffic_csv` 的分工：那个是「你贴 CSV 给我算」，
 * 这个是「用户已经在面板里导入过，去读那份真实数据」—— 后者才能和界面上的建议列对上。
 */
export function readSearchTermsTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_read_search_terms',
    description: '读取个人工作台里已导入的搜索词报表（面板里导入的那份真实数据），返回逐行指标、合计与高花费/高点击无单线索，并带上已有的人工或 AI 建议。只读，不修改广告账户。没有导入过时必须返回 needs_data，不得编造。',
    parameters: {
      dataset_id: { type: 'string', description: '数据集 id；省略则读最近导入的一份' },
      limit: { type: 'number', description: '最多返回多少行（默认 200，最大 1000），按花费从高到低' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const id = typeof args.dataset_id === 'string' ? args.dataset_id.trim() : ''
      const dataset = id === '' ? getLatestAmazonDataset(db) : getAmazonDataset(db, id)
      if (dataset === undefined) return 'needs_data：工作台里还没有导入搜索词报表（请在「搜索词」面板导入 CSV/TSV 后再调用）'
      const limitRaw = numberArg(args, 'limit', 200)
      const limit = Math.min(1000, Math.max(1, Math.floor(limitRaw)))
      const metrics = analyseTraffic(dataset.rows).sort((a, b) => b.spend - a.spend)
      const shown = metrics.slice(0, limit)
      const totals = metrics.reduce((acc, row) => ({
        impressions: acc.impressions + row.impressions,
        clicks: acc.clicks + row.clicks,
        orders: acc.orders + row.orders,
        spend: acc.spend + row.spend,
        sales: acc.sales + row.sales,
      }), { impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 })
      const annotations = new Map(dataset.annotations.map((item) => [item.keyword, item]))
      return [
        `数据集：${dataset.title}（id=${dataset.id}）`,
        `周期：${dataset.period ?? 'unknown（报表未给 Reporting Range）'}；行数：${dataset.rows.length}；已显示：${shown.length}`,
        `observed（用户导入的报表原值）与 derived（本地计算）合计：曝光 ${totals.impressions} · 点击 ${totals.clicks} · 订单 ${totals.orders} · 花费 $${totals.spend.toFixed(2)} · 销售额 $${totals.sales.toFixed(2)}`,
        '',
        '搜索词 | 曝光 | 点击 | 订单 | 花费 | 销售额 | CTR | CVR | CPC | ACOS | 现有建议',
        ...shown.map((row) => {
          const note = annotations.get(row.keyword)
          return `${row.keyword} | ${row.impressions} | ${row.clicks} | ${row.orders} | ${money(row.spend)} | ${money(row.sales)} | ${percent(row.ctr)} | ${percent(row.cvr)} | ${money(row.cpc)} | ${percent(row.acos)} | ${note === undefined ? '（无）' : `${note.action}：${note.reason || '（未写理由）'}`}`
        }),
        '',
        'unknown：账户花费/归因口径与投放单元（广告组/匹配类型）归属 —— 报表若没有这些列，不能按词级归因下否词结论，需按投放单元复核。',
        '下一步：如需给出分层建议，请调用 workbench_save_search_term_review 写回（action ∈ add_exact/add_phrase/negative_exact/negative_phrase/watch/none），只出清单，不执行任何广告修改。',
      ].join('\n')
    },
  })
}

/** 把分层建议写回工作台（agent 的写通道）；面板会立即显示这些结论。 */
export function saveSearchTermReviewTool(db: DatabaseSync) {
  return defineTool({
    name: 'workbench_save_search_term_review',
    description: '把搜索词分层建议写回个人工作台的数据集（整份替换该数据集的建议列表），用户在「搜索词」面板能看到并复核。只写建议与理由，不修改广告账户、不下发否词或调价。',
    parameters: {
      dataset_id: { type: 'string', required: true, description: '数据集 id（从 workbench_read_search_terms 的返回里取）' },
      reviews: { type: 'json', required: true, description: '建议数组，每项 {keyword, action, reason?, evidence?}；action 只能是 add_exact/add_phrase/negative_exact/negative_phrase/watch/none，evidence 为 observed/derived/unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value: string) => text(value) },
    async execute(args: Record<string, unknown>) {
      const datasetId = typeof args.dataset_id === 'string' ? args.dataset_id.trim() : ''
      if (datasetId === '') return 'invalid_input：dataset_id 必填'
      const raw = Array.isArray(args.reviews) ? args.reviews : []
      if (raw.length === 0) return 'invalid_input：reviews 不能为空'
      try {
        const dataset = saveSearchTermReview(db, datasetId, raw.map((item) => {
          const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
          return {
            keyword: typeof record.keyword === 'string' ? record.keyword : '',
            action: typeof record.action === 'string' ? record.action : '',
            reason: typeof record.reason === 'string' ? record.reason : '',
            evidence: typeof record.evidence === 'string' ? record.evidence : undefined,
          }
        }))
        const counts = dataset.annotations.reduce<Record<string, number>>((acc, item) => {
          acc[item.action] = (acc[item.action] ?? 0) + 1
          return acc
        }, {})
        return [
          '已写回工作台（derived；只写建议，不执行广告修改）',
          `数据集：${dataset.title}（id=${dataset.id}）；建议条数：${dataset.annotations.length}`,
          `分布：${Object.entries(counts).map(([action, count]) => `${action} ${count}`).join(' · ')}`,
          '用户在「搜索词」面板可见并逐条复核；否词/加词/调价仍需人工在广告后台执行。',
        ].join('\n')
      } catch (error) {
        return `invalid_input：${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
