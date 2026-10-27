/**
 * 库存与补货测算（P3）：期初 + 期间到货 − 期间销量 → 可售天数 / 断货日 / 补货量。
 *
 * ## 三道硬门（来自 `amazon-inventory-forecast` 的口径，不能松）
 * 1. **数据时效**：盘点日期距今超过 `STALE_DAYS`（30 天）→ **不给断货日**，
 *    只给"可售天数"的相对结论并标注 unknown。用过期盘点抄一个断货日，比不给更危险。
 * 2. **进销存不闭合**：算出来是负库存，或者"期间到货"无法确认已到仓 → 标 `gap`，
 *    数字照算但必须标注缺口，不把它当准确结论。
 * 3. **计划到仓不算已到仓**：`inboundPlanned`（在途/计划）**从不抵扣库存**，
 *    只作为"补货缺口里已经安排了的部分"用于算还要补多少。
 *
 * 纯函数：不碰 DB、不碰网络，node 测试可直接调。
 */

/** 盘点数据超过这么多天就不给断货日。 */
export const STALE_DAYS = 30

export interface InventoryRow {
  sku: string
  asin?: string | null
  /** 盘点时点的在手库存。 */
  onHandStart: number
  /** 统计期内**已到仓**的到货量。 */
  arrivals: number
  /** 统计期内销量。 */
  sold: number
  /** 已下单但未到仓（在途/计划）：只用来算缺口，不抵扣库存。 */
  inboundPlanned?: number
  /** 日均目标销量（缺省用统计期日均）。 */
  dailyTarget?: number | null
}

export interface InventoryInput {
  /** 统计期天数（期初到盘点/今天）。 */
  windowDays: number
  /** 盘点日期（ISO）。 */
  countedAt: string
  /** 采购/头程到仓天数 + 安全库存天数，用于算补货量。 */
  leadTimeDays: number
  safetyDays: number
  /** 今天（测试注入；生产用 new Date()）。 */
  today?: Date
}

export type InventoryGap = '负库存' | '数据过期' | '统计期异常' | '无销量'

export interface InventoryMetric extends InventoryRow {
  /** 当前在手 = 期初 + 已到仓 − 销量。 */
  currentStock: number
  dailyRate: number | null
  /** 可售天数：无销量时为 null（不是 Infinity，界面要能显示"—"）。 */
  daysOfCover: number | null
  /** 断货日：数据过期 / 无销量时**必须为 null**，并在 gaps 说明原因。 */
  stockoutDate: string | null
  /** 建议补货量（不含在途）：达到 leadTime + safety 需要多少；已在途的部分单独扣。 */
  replenishQty: number | null
  gaps: InventoryGap[]
}

export interface InventoryResult {
  rows: InventoryMetric[]
  kpi: {
    rows: number
    /** 需要在 leadTime 内到货的 SKU 数（可售天数 < leadTime + safety）。 */
    urgent: number
    /** 断货日已过去 / 库存为 0 的 SKU。 */
    outOfStock: number
    /** 有数据缺口、结论不可当准确的 SKU 数。 */
    withGaps: number
  }
  /** 本次测算整体是否受"数据过期"影响。 */
  stale: boolean
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function dayDiff(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

export function analyseInventory(rows: InventoryRow[], input: InventoryInput): InventoryResult {
  const today = input.today ?? new Date()
  const counted = new Date(input.countedAt)
  const countedValid = !Number.isNaN(counted.getTime())
  const ageDays = countedValid ? dayDiff(counted, today) : Number.NaN
  const stale = !countedValid || ageDays > STALE_DAYS
  const windowOk = Number.isFinite(input.windowDays) && input.windowDays > 0

  const metrics: InventoryMetric[] = rows.map((row) => {
    const gaps: InventoryGap[] = []
    const currentStock = round(row.onHandStart + row.arrivals - row.sold)
    if (currentStock < 0) gaps.push('负库存')
    if (stale) gaps.push('数据过期')
    if (!windowOk) gaps.push('统计期异常')
    const dailyRate = windowOk ? round(row.sold / input.windowDays) : null
    if (dailyRate !== null && dailyRate <= 0) gaps.push('无销量')

    const daysOfCover = dailyRate !== null && dailyRate > 0 ? round(currentStock / dailyRate) : null
    // 硬门：数据过期或统计期异常 → 断货日一律不给（不是"大概算算"）
    const stockoutDate = (stale || !windowOk || daysOfCover === null)
      ? null
      : new Date(today.getTime() + daysOfCover * 86_400_000).toISOString().slice(0, 10)

    const targetDaily = row.dailyTarget !== null && row.dailyTarget !== undefined && row.dailyTarget > 0
      ? row.dailyTarget
      : dailyRate
    const needTotal = targetDaily === null ? null : targetDaily * (input.leadTimeDays + input.safetyDays)
    const replenishQty = needTotal === null
      ? null
      : Math.max(0, Math.ceil(needTotal - currentStock - (row.inboundPlanned ?? 0)))

    return {
      ...row,
      currentStock,
      dailyRate,
      daysOfCover,
      stockoutDate,
      replenishQty,
      gaps,
    }
  })

  const urgent = metrics.filter((row) => row.daysOfCover !== null && row.daysOfCover < input.leadTimeDays + input.safetyDays).length
  const outOfStock = metrics.filter((row) => row.currentStock <= 0).length
  const withGaps = metrics.filter((row) => row.gaps.length > 0).length
  return { rows: metrics, kpi: { rows: metrics.length, urgent, outOfStock, withGaps }, stale }
}

/* ── 解析（CSV / TSV） ──────────────────────────────────────────────────── */

export interface InventoryParseResult {
  ok: boolean
  rows: InventoryRow[]
  windowDays: number | null
  countedAt: string | null
  errors: string[]
  warnings: string[]
}

const ALIASES: Record<string, string[]> = {
  sku: ['sku', 'msku', 'sku编码', '商品编码'],
  asin: ['asin', '子asin'],
  onHandStart: ['期初库存', '期初', 'onhand', 'onhandstart', '期初数量'],
  arrivals: ['期间到货', '到货', '已到仓', 'arrivals', '入库'],
  sold: ['期间销量', '销量', 'sold', '出货'],
  inboundPlanned: ['在途', '在途数量', '计划到仓', '在途/计划', 'inboundplanned', 'inbound'],
  dailyTarget: ['日均目标', '日目标', 'target', '目标日销'],
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/[\s\u3000]+/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')').toLowerCase()
}

function toNumber(raw: string): number {
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return 0
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

function findColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const index = headers.indexOf(alias)
    if (index >= 0) return index
  }
  return -1
}

/**
 * 解析库存表。`统计天数` / `盘点日期` 优先从表头前的元数据行读；
 * 读不到就要求调用方传（界面上有输入框），**不默认猜 30 天**。
 */
export function parseInventoryCsv(text: string): InventoryParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const allLines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '')
  if (allLines.length < 2) return { ok: false, rows: [], windowDays: null, countedAt: null, errors: ['至少需要一行表头 + 一行数据'], warnings }

  /**
   * 表头不一定在第一行（报表前面常写「统计天数 / 盘点日期」），
   * 而且分隔符要按**表头那一行**判断：第一行是元数据时按它猜会把 TSV 当 CSV，
   * 整张表都被切成 1 列 → 误报"缺 SKU 列"。
   */
  const splitBoth = (line: string): { tab: string[]; comma: string[] } => ({ tab: line.split('\t'), comma: line.split(',') })
  const headerIndex = allLines.findIndex((line) => {
    const parts = splitBoth(line)
    return findColumn(parts.tab.map(normalizeHeader), ALIASES.sku!) >= 0
      || findColumn(parts.comma.map(normalizeHeader), ALIASES.sku!) >= 0
  })
  if (headerIndex < 0) {
    return { ok: false, rows: [], windowDays: null, countedAt: null, errors: ['找不到表头行：至少需要一列 SKU'], warnings }
  }
  const delimiter = (allLines[headerIndex] ?? '').includes('\t') ? '\t' : ','
  const lines = allLines.slice(headerIndex)
  const cells = lines.map((line) => (delimiter === '\t' ? line.split('\t') : line.split(',')))
  const header = (cells[0] ?? []).map(normalizeHeader)
  const body = cells.slice(1)

  const meta = allLines.slice(0, headerIndex).join(' ')
  const windowMatch = /(?:统计天数|统计周期)[:：\s]*(\d+)/.exec(meta)
  const dateMatch = /(?:盘点日期|统计截止)[:：\s]*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/.exec(meta)

  const skuIndex = findColumn(header, ALIASES.sku!)
  const onHandIndex = findColumn(header, ALIASES.onHandStart!)
  const arrivalsIndex = findColumn(header, ALIASES.arrivals!)
  const soldIndex = findColumn(header, ALIASES.sold!)
  const missing: string[] = []
  if (skuIndex < 0) missing.push('SKU')
  if (onHandIndex < 0) missing.push('期初库存')
  if (soldIndex < 0) missing.push('期间销量')
  if (missing.length > 0) return { ok: false, rows: [], windowDays: null, countedAt: null, errors: [`缺少必需列：${missing.join('、')}`], warnings }
  if (arrivalsIndex < 0) warnings.push('没有「期间到货」列，按 0 处理（进销存可能不闭合）')

  const asinIndex = findColumn(header, ALIASES.asin!)
  const inboundIndex = findColumn(header, ALIASES.inboundPlanned!)
  const targetIndex = findColumn(header, ALIASES.dailyTarget!)
  const rows: InventoryRow[] = []
  const skipped: number[] = []
  body.forEach((line, index) => {
    const sku = (line[skuIndex] ?? '').trim()
    if (sku === '') { skipped.push(index + 2); return }
    const read = (column: number): number => (column < 0 ? 0 : toNumber(line[column] ?? ''))
    rows.push({
      sku,
      asin: asinIndex < 0 ? null : ((line[asinIndex] ?? '').trim() || null),
      onHandStart: read(onHandIndex),
      arrivals: read(arrivalsIndex),
      sold: read(soldIndex),
      inboundPlanned: inboundIndex < 0 ? 0 : read(inboundIndex),
      dailyTarget: targetIndex < 0 ? null : (read(targetIndex) || null),
    })
  })
  if (rows.length === 0) errors.push('所有行都缺少 SKU')
  if (skipped.length > 0) warnings.push(`跳过 ${skipped.length} 行：SKU 为空（第 ${skipped.slice(0, 5).join('、')} 行）`)
  return {
    ok: errors.length === 0,
    rows,
    windowDays: windowMatch === null ? null : Number(windowMatch[1]),
    countedAt: dateMatch === null ? null : dateMatch[1]!.replace(/\//g, '-'),
    errors,
    warnings,
  }
}

/** 导出补货清单（人工确认用；不写任何平台）。 */
export function inventoryToCsv(rows: InventoryMetric[]): string {
  const header = ['SKU', 'ASIN', '在手', '日均', '可售天数', '断货日', '建议补货', '缺口']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([
      row.sku,
      row.asin ?? '',
      String(row.currentStock),
      row.dailyRate === null ? '' : String(row.dailyRate),
      row.daysOfCover === null ? '' : String(row.daysOfCover),
      row.stockoutDate ?? '',
      row.replenishQty === null ? '' : String(row.replenishQty),
      row.gaps.join(' / '),
    ].map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','))
  }
  return `${lines.join('\n')}\n`
}
