/**
 * 搜索词报表的本地解析与诊断（纯函数，供面板与 DSH 工具共用）。
 *
 * 口径来自仓库 SOP（`check_inputs.py --kind search-term` 的实测结论）：
 * 1. 真实亚马逊中文导出用的是 `用户搜索词` / `点击` / `广告订单` / `广告花费` / `广告销售额`，
 *    别名表若只写「点击量/订单数」会**误报缺列**；
 * 2. 报表常带 1–2 行标题或说明行，表头必须**自动定位**（按命中别名的打分最高行）；
 * 3. 同名列容易选错：`广告订单` vs `间接订单`、`广告销售额` vs `间接销售额` ——
 *    用打分匹配（精确 3 / 前缀 2 / 包含 1，同分取更长别名），不要用「包含就取第一个」；
 * 4. ABA CSV 首行是 `Reporting Range=...` 元数据，必须先跳过。
 *
 * 另外两件本面板特有的事：
 * - 从 Excel 直接粘贴得到的是 **TSV**，不是 CSV —— 分隔符按表头行自动判定；
 * - 用户粘贴常被截断，导致引号不闭合。这种情况**不再整份拒绝**（旧实现会直接
 *   "CSV 引号未闭合"），而是按容错模式解析并给一条 warning，让数据尽量可用。
 */

export interface TrafficRow {
  keyword: string
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
}

export interface TrafficParseResult {
  ok: boolean
  rows: TrafficRow[]
  /** 致命错误（缺列 / 数字非法）：非空即 ok=false。 */
  errors: string[]
  /** 非致命提示（空单元格按 0 计、引号未闭合等），ok 仍可为 true。 */
  warnings: string[]
  period?: string
  /** 表头在原文中的行号（1 基；便于用户核对「它到底认了哪一行当表头」）。 */
  headerRow?: number
  delimiter?: string
}

export interface TrafficMetric extends TrafficRow {
  ctr: number | null
  cvr: number | null
  cpc: number | null
  acos: number | null
  roas: number | null
  diagnosis: string
}

/** AI 写回的建议动作（封闭枚举，落库前校验）。 */
export type SearchTermAction = 'add_exact' | 'add_phrase' | 'negative_exact' | 'negative_phrase' | 'watch' | 'none'

export const SEARCH_TERM_ACTIONS: SearchTermAction[] = ['add_exact', 'add_phrase', 'negative_exact', 'negative_phrase', 'watch', 'none']

export interface SearchTermAnnotation {
  keyword: string
  action: SearchTermAction
  reason: string
  /** 证据等级：observed（报表原始值）/ derived（本地计算）/ unknown（缺口）。 */
  evidence: 'observed' | 'derived' | 'unknown'
  updatedAt: string
}

const REQUIRED_COLUMNS: Record<keyof TrafficRow, string[]> = {
  keyword: ['keyword', 'search term', 'customer search term', '用户搜索词', '客户搜索词', '搜索词', '搜索关键字'],
  impressions: ['impressions', 'impression', '曝光量', '曝光次数', '曝光', '展示量', '展示次数'],
  clicks: ['clicks', 'click', '点击量', '点击次数', '点击'],
  orders: ['orders', 'order', '广告订单', '订单数', '订单', '7天总订单', '总订单'],
  spend: ['spend', 'cost', '广告花费', '花费', '广告支出', '支出'],
  sales: ['sales', 'revenue', '广告销售额', '广告归因销售额', '销售额', '7天总销售额', '总销售额'],
}

export function analyseTraffic(rows: TrafficRow[]): TrafficMetric[] {
  return rows.map((row) => {
    const ctr = row.impressions > 0 ? row.clicks / row.impressions : null
    const cvr = row.clicks > 0 ? row.orders / row.clicks : null
    const cpc = row.clicks > 0 ? row.spend / row.clicks : null
    const acos = row.sales > 0 ? row.spend / row.sales : null
    const roas = row.spend > 0 ? row.sales / row.spend : null
    const diagnosis = row.clicks >= 8 && row.orders === 0
      ? '高点击无订单：优先检查相关性、Listing 与价格'
      : row.orders > 0 && (acos ?? 0) <= 0.3
        ? '有转化且 ACOS 较低：可进入人工扩量评估'
        : row.impressions > 0 && row.clicks === 0
          ? '有曝光无点击：检查主图、标题与竞价'
          : '继续积累数据'
    return { ...row, ctr, cvr, cpc, acos, roas, diagnosis }
  })
}

interface RecordSplit {
  records: string[][]
  delimiter: string
  warnings: string[]
}

/** 解析成「记录 → 字段」，支持 `"` 转义与记录内换行；`interpretQuotes=false` 时按容错模式整行切分。 */
function splitRecords(text: string, interpretQuotes = true): RecordSplit {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const delimiter = pickDelimiter(normalized)
  const records: string[][] = []
  const warnings: string[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (interpretQuotes && char === '"') {
      if (quoted && normalized[i + 1] === '"') { field += '"'; i += 1 }
      else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      fields.push(field); field = ''
    } else if (char === '\n' && !quoted) {
      fields.push(field); field = ''
      if (fields.some((value) => value.trim() !== '')) records.push(fields)
      fields = []
    } else field += char
  }
  if (quoted) warnings.push('原文引号未闭合（已按容错模式解析，请确认粘贴是否被截断）')
  fields.push(field)
  if (fields.some((value) => value.trim() !== '')) records.push(fields)
  return { records, delimiter, warnings }
}

/** 分隔符：看前 5 个非空行里哪种分隔符出现最多（标题行通常没有分隔符，不能只看第一行）。 */
function pickDelimiter(text: string): string {
  const sample = text.split('\n').filter((line) => line.trim() !== '').slice(0, 5).join('\n')
  const counts: Array<[string, number]> = [
    ['\t', (sample.match(/\t/g) ?? []).length],
    [',', (sample.match(/,/g) ?? []).length],
    [';', (sample.match(/;/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

function normalizeHeader(value: string): string { return value.trim().toLowerCase().replace(/[\s_()（）:：*/-]/g, '') }

/** 单个表头格对某个字段的匹配分：精确 3 / 前缀 2 / 包含 1，同分取更长的别名。 */
function scoreAlias(cell: string, aliases: string[]): number {
  let best = 0
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias)
    if (normalizedAlias === '') continue
    const score = cell === normalizedAlias
      ? 3
      : (cell.startsWith(normalizedAlias) || normalizedAlias.startsWith(cell)) && cell !== ''
        ? 2
        : cell.includes(normalizedAlias) || normalizedAlias.includes(cell) ? 1 : 0
    if (score > best || (score === best && score > 0)) best = Math.max(best, score)
  }
  return best
}

function isMetadataRow(cells: string[]): boolean {
  const joined = cells.join(' ')
  return /(?:reporting range|报告范围|日期范围|report period)\s*[=:：]/i.test(joined)
    || /^(?:report|报表|广告搜索词报告)/i.test(cells[0]?.trim() ?? '')
}

function parseNumberLoose(value: string): number | null {
  const raw = value.trim()
  if (raw === '' || raw === '—' || raw === '-' || raw === '--') return null
  const negative = /^\(.*\)$/.test(raw)
  const cleaned = raw.replace(/[$,%\s()]/g, '')
  if (cleaned === '') return null
  const result = Number(cleaned)
  if (!Number.isFinite(result)) return Number.NaN
  return negative ? -result : result
}

export function parseTrafficCsv(text: string): TrafficParseResult {
  const empty: TrafficParseResult = { ok: false, rows: [], errors: [], warnings: [] }
  if (text.trim() === '') return { ...empty, errors: ['请先粘贴或导入报表内容'] }

  let split = splitRecords(text)
  /**
   * 引号不闭合时**重解析一遍**并关闭引号语义：否则一个未闭合的 `"` 会把后面所有行
   * 吞进同一个字段（用户实测就是这样整份失败的）。warning 保留，让用户知道要复核。
   */
  if (split.warnings.length > 0) {
    const lenient = splitRecords(text, false)
    split = { ...lenient, warnings: split.warnings }
  }
  const { records, delimiter, warnings } = split
  if (records.length === 0) return { ...empty, errors: ['没有解析到任何行'] }

  /**
   * 表头定位：在前 5 个非元数据行里挑「六个必备列全部命中、总分最高」的一行。
   * 找不到就明确报缺列 —— 不要把首行硬当表头（那正是「误报缺列」的来源）。
   */
  const candidates = records.slice(0, 6)
  let bestIndex = -1
  let bestScore = 0
  let bestMapping: Record<keyof TrafficRow, number> | null = null
  for (let rowIndex = 0; rowIndex < candidates.length; rowIndex += 1) {
    const cells = candidates[rowIndex].map(normalizeHeader)
    if (isMetadataRow(candidates[rowIndex])) continue
    const mapping = {} as Record<keyof TrafficRow, number>
    let total = 0
    let complete = true
    for (const key of Object.keys(REQUIRED_COLUMNS) as Array<keyof TrafficRow>) {
      let bestCell = -1
      let cellScore = 0
      cells.forEach((cell, index) => {
        const score = scoreAlias(cell, REQUIRED_COLUMNS[key])
        if (score > cellScore) { cellScore = score; bestCell = index }
      })
      if (bestCell < 0) { complete = false; break }
      mapping[key] = bestCell
      total += cellScore
    }
    if (complete && total > bestScore) { bestScore = total; bestIndex = rowIndex; bestMapping = mapping }
  }

  if (bestMapping === null) {
    const header = candidates.find((cells) => !isMetadataRow(cells)) ?? candidates[0]
    const headerCells = header.map(normalizeHeader)
    const missing = (Object.keys(REQUIRED_COLUMNS) as Array<keyof TrafficRow>)
      .filter((key) => !headerCells.some((cell) => scoreAlias(cell, REQUIRED_COLUMNS[key]) > 0))
      .map((key) => REQUIRED_COLUMNS[key][0])
    return {
      ...empty,
      warnings,
      errors: [missing.length > 0 ? `缺少列：${missing.join('、')}` : '未能定位表头（前 6 行都没有同时包含关键词/曝光/点击/订单/花费/销售额）'],
      headerRow: 1,
      delimiter,
    }
  }

  const headerRow = records[bestIndex]
  const period = extractPeriod(records.slice(0, bestIndex + 1))
  const dataRows = records.slice(bestIndex + 1)
  const rows: TrafficRow[] = []
  const rowWarnings: string[] = []
  /**
   * 坏行**跳过并报数**，不再"一行坏就整份拒绝"。
   *
   * 真实事故（2026-10-22）：700 多行的报表里第 657/695 行有几个单元格是
   * `N/A` 或合计行，旧实现直接 `ok:false`，用户看着满屏正确数据却导不进来。
   * 现在的口径：坏行不进统计（绝不把非数字当 0），但在 warnings 里逐条点名；
   * 只有**一行都解析不出来**时才整体失败 —— 那时错的是文件格式，不是个别单元格。
   */
  const skipped: string[] = []
  let summaryRows = 0

  dataRows.forEach((values, offset) => {
    const lineNumber = bestIndex + 2 + offset
    if (values.every((value) => value.trim() === '')) return
    if (isMetadataRow(values)) return
    const keyword = (values[bestMapping!.keyword] ?? '').trim().replace(/^"+|"+$/g, '').trim()
    if (keyword === '') {
      skipped.push(`第 ${lineNumber} 行关键词为空`)
      return
    }
    /** 汇总/合计行不是数据：跳过且不报错（它们的数字列往往本来就是空的）。 */
    if (/^(?:总计|合计|小计|总和|汇总|grand\s+total|total|sum)\s*[:：]?\s*$/i.test(keyword)) {
      summaryRows += 1
      return
    }
    const numbers = {} as Record<'impressions' | 'clicks' | 'orders' | 'spend' | 'sales', number>
    let broken = ''
    for (const key of ['impressions', 'clicks', 'orders', 'spend', 'sales'] as const) {
      const parsed = parseNumberLoose(values[bestMapping![key]] ?? '')
      if (parsed === null) {
        numbers[key] = 0
        rowWarnings.push(`第 ${lineNumber} 行 ${key} 为空（按 0 计）`)
      } else if (Number.isNaN(parsed) || parsed < 0) {
        broken = `${key} 不是有效的非负数字`
        break
      } else numbers[key] = parsed
    }
    if (broken !== '') {
      skipped.push(`第 ${lineNumber} 行 ${broken}`)
      return
    }
    rows.push({ keyword, ...numbers })
  })

  if (rows.length === 0) {
    const detail = skipped.length > 0 ? skipped.slice(0, 3).join('；') : '表头已识别，但没有数据行'
    return { ...empty, warnings: [...warnings, ...rowWarnings], errors: [`没有可用数据行：${detail}`], headerRow: bestIndex + 1, delimiter }
  }
  const skipWarnings = skipped.length === 0
    ? []
    : [`跳过 ${skipped.length} 行无法解析的数据（未计入统计）：${skipped.slice(0, 3).join('；')}${skipped.length > 3 ? '…' : ''}`]
  if (summaryRows > 0) skipWarnings.push(`忽略 ${summaryRows} 行合计/汇总行`)

  return {
    ok: true,
    rows,
    errors: [],
    warnings: [...warnings, ...rowWarnings, ...skipWarnings].slice(0, 6),
    period,
    headerRow: bestIndex + 1,
    delimiter,
  }
}

function extractPeriod(leadingRecords: string[][]): string | undefined {
  for (const cells of leadingRecords) {
    const joined = cells.join(' ')
    const labelled = joined.match(/(?:reporting range|报告范围|日期范围|report period)\s*[=:：]\s*([^,;]+)/i)
    if (labelled !== null) return labelled[1].trim()
    /** 亚马逊中文导出常把周期写成一行裸日期区间（`2026-10-11 至 2026-10-17`），没有标签。 */
    const bare = joined.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～|-{1,2})\s*(\d{4}-\d{2}-\d{2})/)
    if (bare !== null) return `${bare[1]}~${bare[2]}`
  }
  return undefined
}

/**
 * 给 AI 的交接摘要：只放**能核对**的东西（行数、合计、Top 花费行、缺口），
 * 并要求后续一律引用 dataset_id 去读原始行，避免模型拿这份摘要当全量数据。
 */
export function summarizeTrafficForAI(input: {
  datasetId: string
  title: string
  period: string | null
  rows: TrafficRow[]
}): string {
  const metrics = analyseTraffic(input.rows)
  const totals = metrics.reduce((acc, row) => ({
    impressions: acc.impressions + row.impressions,
    clicks: acc.clicks + row.clicks,
    orders: acc.orders + row.orders,
    spend: acc.spend + row.spend,
    sales: acc.sales + row.sales,
  }), { impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 })
  const top = [...metrics].sort((a, b) => b.spend - a.spend).slice(0, 5)
  const waste = metrics.filter((row) => row.clicks >= 8 && row.orders === 0)
  return [
    '搜索词报表已导入工作台（derived 口径，账户数据来自本表格，未连接广告账户 API）',
    `dataset_id：${input.datasetId}`,
    `标题：${input.title}；周期：${input.period ?? 'unknown（报表未给出 Reporting Range）'}；数据行：${input.rows.length}`,
    `合计：曝光 ${totals.impressions} · 点击 ${totals.clicks} · 订单 ${totals.orders} · 花费 $${totals.spend.toFixed(2)} · 销售额 $${totals.sales.toFixed(2)}`,
    `整体 ACOS：${totals.sales > 0 ? `${((totals.spend / totals.sales) * 100).toFixed(1)}%` : 'unknown（无销售额）'}；整体 CPC：${totals.clicks > 0 ? `$${(totals.spend / totals.clicks).toFixed(2)}` : 'unknown'}`,
    `花费 Top5：${top.map((row) => `${row.keyword}($${row.spend.toFixed(2)}/点击 ${row.clicks}/订单 ${row.orders}/ACOS ${row.acos === null ? '—' : `${(row.acos * 100).toFixed(1)}%`})`).join('；')}`,
    `高点击无订单：${waste.length > 0 ? waste.map((row) => row.keyword).join('、') : '无'}`,
    '',
    '请按搜索词 SOP 执行：先调用 workbench_read_search_terms 拉取**全部原始行**（不要只用这份摘要），再按投放单元级归因分层；',
    '结论分 observed / derived / unknown；否词与加词只出人工确认清单，不要执行任何广告账户修改。',
    '分层完成后调用 workbench_save_search_term_review 写回建议（dataset_id 同上），界面会显示你的判断。',
  ].join('\n')
}
