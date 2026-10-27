/**
 * 付款对账（P4）：把「日期范围报告」与「付款/结算报告」对起来，产出差异清单。
 *
 * ## 三个必须分开算的东西
 * 1. **订单**：日期范围报告里有的订单，结算里有没有对应的 Order Payment；
 *    反过来，结算里出现的订单，日期范围里有没有（跨周期结算很正常，不能一律算错）。
 * 2. **广告费**：结算是亚马逊**代扣**的广告费（Cost of Advertising），
 *    它不是订单，不能混进订单差异，要单独列并与用户填的广告花费比。
 * 3. **回款**：Transfer/回款行与结算合计的关系 —— 只报告，不假设"应该等于"。
 *
 * ## 两条纪律
 * - **不猜缺失**：只按订单号/交易类型匹配；对不上就列出来，不按金额相近硬配。
 * - **区分"未结算"与"异常"**：日期范围里有、结算里没有 = 未结算（正常现象，尤其在途周期）；
 *   结算里有、日期范围里没有 = 跨周期或漏导，标注而不是判错。
 *
 * 纯函数：不碰 DB/网络。
 */

export interface RangeOrder {
  orderId: string
  amount: number
  /** 日期范围报告里的类型：Order / Refund / 其他。 */
  kind: string
}

export interface SettlementLine {
  orderId: string | null
  /** 交易类型（Order Payment / Cost of Advertising / Transfer / Refund …）。 */
  type: string
  amount: number
  settlementId: string | null
}

export interface ReconcileInput {
  rangeOrders: RangeOrder[]
  settlementLines: SettlementLine[]
  /** 用户填的广告花费（可选）：用来和结算里的代扣广告费对比。 */
  adSpendDeclared?: number | null
}

export interface ReconcileResult {
  kpi: {
    rangeOrders: number
    settledOrders: number
    /** 日期范围有、结算没有的订单数（未结算）。 */
    unsettled: number
    /** 结算有、日期范围没有的订单数（跨周期/漏导）。 */
    missingFromRange: number
    settlementTotal: number
    rangeTotal: number
    adFeeInSettlement: number
    transferTotal: number
    /** 结算合计 −（订单 + 广告费 + 回款 + 其他）的差；正常应接近 0。 */
    residual: number
  }
  unsettledOrders: RangeOrder[]
  missingFromRangeOrders: Array<{ orderId: string; amount: number; settlementId: string | null }>
  adSpendDiff: number | null
  warnings: string[]
}

const AD_TYPES = ['costofadvertising', 'advertising', '广告费', '广告']
const TRANSFER_TYPES = ['transfer', '回款', '转账']

function norm(value: string): string {
  return value.replace(/[\s\u3000]/g, '').toLowerCase()
}

function isAdType(type: string): boolean {
  const value = norm(type)
  return AD_TYPES.some((token) => value.includes(token))
}

function isTransferType(type: string): boolean {
  const value = norm(type)
  return TRANSFER_TYPES.some((token) => value.includes(token))
}

function isOrderType(type: string): boolean {
  const value = norm(type)
  return value.includes('order') || value.includes('订单') || value.includes('refund') || value.includes('退款')
}

export function reconcilePayments(input: ReconcileInput): ReconcileResult {
  const warnings: string[] = []
  const rangeByOrder = new Map<string, RangeOrder>()
  for (const order of input.rangeOrders) {
    const id = order.orderId.trim()
    if (id === '') continue
    const before = rangeByOrder.get(id)
    rangeByOrder.set(id, before === undefined ? { ...order, orderId: id } : { ...before, amount: before.amount + order.amount })
  }

  const settlementOrders = new Map<string, { orderId: string; amount: number; settlementId: string | null }>()
  let settlementTotal = 0
  let adFeeInSettlement = 0
  let adFeeSigned = 0
  let transferTotal = 0
  let otherTotal = 0
  for (const line of input.settlementLines) {
    settlementTotal += line.amount
    if (isAdType(line.type)) { adFeeInSettlement += Math.abs(line.amount); adFeeSigned += line.amount; continue }
    if (isTransferType(line.type)) { transferTotal += line.amount; continue }
    if (!isOrderType(line.type)) { otherTotal += line.amount; continue }
    const id = (line.orderId ?? '').trim()
    if (id === '') {
      warnings.push(`有一条「${line.type}」没有订单号，无法匹配（金额 ${line.amount.toFixed(2)}）`)
      continue
    }
    const before = settlementOrders.get(id)
    settlementOrders.set(id, {
      orderId: id,
      amount: (before?.amount ?? 0) + line.amount,
      settlementId: line.settlementId ?? before?.settlementId ?? null,
    })
  }

  const unsettledOrders: RangeOrder[] = []
  for (const [id, order] of rangeByOrder) {
    if (!settlementOrders.has(id)) unsettledOrders.push(order)
  }
  const missingFromRangeOrders: Array<{ orderId: string; amount: number; settlementId: string | null }> = []
  for (const [id, line] of settlementOrders) {
    if (!rangeByOrder.has(id)) missingFromRangeOrders.push(line)
  }

  const rangeTotal = [...rangeByOrder.values()].reduce((sum, order) => sum + order.amount, 0)
  const orderSettlementTotal = [...settlementOrders.values()].reduce((sum, line) => sum + line.amount, 0)
  /**
   * 分类差额用**带符号**的合计来算：广告费在结算里是负数（代扣），
   * 若这里拿"绝对值"去加，差额会凭空变成 −2×广告费（金额对不上，还会被误判成漏单）。
   */
  const residual = round(settlementTotal - (orderSettlementTotal + adFeeSigned + transferTotal + otherTotal))
  if (Math.abs(residual) > 0.01) warnings.push(`结算合计与其他分类相加差 ${residual.toFixed(2)}（可能有未识别交易类型）`)

  const adSpendDiff = input.adSpendDeclared === null || input.adSpendDeclared === undefined
    ? null
    : round(adFeeInSettlement - Math.abs(input.adSpendDeclared))

  return {
    kpi: {
      rangeOrders: rangeByOrder.size,
      settledOrders: settlementOrders.size,
      unsettled: unsettledOrders.length,
      missingFromRange: missingFromRangeOrders.length,
      settlementTotal: round(settlementTotal),
      rangeTotal: round(rangeTotal),
      adFeeInSettlement: round(adFeeInSettlement),
      transferTotal: round(transferTotal),
      residual,
    },
    unsettledOrders,
    missingFromRangeOrders,
    adSpendDiff,
    warnings,
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/* ── 解析 ───────────────────────────────────────────────────────────────── */

function toNumber(raw: string): number {
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-') return 0
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : 0
}

function splitLines(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return []
  const delimiter = (lines[0] ?? '').includes('\t') ? '\t' : ','
  return lines.map((line) => (delimiter === '\t' ? line.split('\t') : line.split(',')))
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/[\s\u3000]+/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')').toLowerCase()
}

function findColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const index = headers.indexOf(alias)
    if (index >= 0) return index
  }
  return -1
}

const ORDER_ID_ALIASES = ['订单号', '订单编号', 'orderid', 'order-id', 'amazonorderid']
const AMOUNT_ALIASES = ['金额', 'amount', 'totalamount', '总额']
const TYPE_ALIASES = ['交易类型', '类型', 'transactiontype', 'amounttype', 'amount-type', 'amountdescription', 'amount-description']
const SETTLEMENT_ALIASES = ['结算单号', 'settlementid', 'settlement-id', '付款编号']

export interface ParsePaymentsResult<T> {
  ok: boolean
  rows: T[]
  errors: string[]
  warnings: string[]
}

/** 日期范围报告：至少要有订单号 + 金额。 */
export function parseRangeReport(text: string): ParsePaymentsResult<RangeOrder> {
  const matrix = splitLines(text)
  if (matrix.length < 2) return { ok: false, rows: [], errors: ['至少需要一行表头 + 一行数据'], warnings: [] }
  const header = (matrix[0] ?? []).map(normalizeHeader)
  const orderIndex = findColumn(header, ORDER_ID_ALIASES)
  const amountIndex = findColumn(header, AMOUNT_ALIASES)
  const typeIndex = findColumn(header, TYPE_ALIASES)
  const missing: string[] = []
  if (orderIndex < 0) missing.push('订单号')
  if (amountIndex < 0) missing.push('金额')
  if (missing.length > 0) return { ok: false, rows: [], errors: [`缺少必需列：${missing.join('、')}`], warnings: [] }
  const rows: RangeOrder[] = []
  const warnings: string[] = []
  let skipped = 0
  for (const line of matrix.slice(1)) {
    const orderId = (line[orderIndex] ?? '').trim()
    if (orderId === '') { skipped += 1; continue }
    rows.push({ orderId, amount: toNumber(line[amountIndex] ?? ''), kind: typeIndex < 0 ? 'Order' : ((line[typeIndex] ?? '').trim() || 'Order') })
  }
  if (skipped > 0) warnings.push(`跳过 ${skipped} 行：订单号为空`)
  return { ok: rows.length > 0, rows, errors: rows.length === 0 ? ['所有行都缺少订单号'] : [], warnings }
}

/** 付款/结算报告：至少要有交易类型 + 金额；订单号与结算单号可选（广告费/回款行没有订单号）。 */
export function parseSettlementReport(text: string): ParsePaymentsResult<SettlementLine> {
  const matrix = splitLines(text)
  if (matrix.length < 2) return { ok: false, rows: [], errors: ['至少需要一行表头 + 一行数据'], warnings: [] }
  const header = (matrix[0] ?? []).map(normalizeHeader)
  const typeIndex = findColumn(header, TYPE_ALIASES)
  const amountIndex = findColumn(header, AMOUNT_ALIASES)
  const missing: string[] = []
  if (typeIndex < 0) missing.push('交易类型')
  if (amountIndex < 0) missing.push('金额')
  if (missing.length > 0) return { ok: false, rows: [], errors: [`缺少必需列：${missing.join('、')}`], warnings: [] }
  const orderIndex = findColumn(header, ORDER_ID_ALIASES)
  const settlementIndex = findColumn(header, SETTLEMENT_ALIASES)
  const rows: SettlementLine[] = []
  for (const line of matrix.slice(1)) {
    rows.push({
      orderId: orderIndex < 0 ? null : ((line[orderIndex] ?? '').trim() || null),
      type: (line[typeIndex] ?? '').trim(),
      amount: toNumber(line[amountIndex] ?? ''),
      settlementId: settlementIndex < 0 ? null : ((line[settlementIndex] ?? '').trim() || null),
    })
  }
  return { ok: rows.length > 0, rows, errors: rows.length === 0 ? ['没有可读取的结算行'] : [], warnings: [] }
}

/** 差异清单导出（人工确认用）。 */
export function reconcileToCsv(result: ReconcileResult): string {
  const lines = ['分组,订单号,金额,说明']
  for (const order of result.unsettledOrders) lines.push(['未结算', order.orderId, String(order.amount), '日期范围有、结算报告没有'].join(','))
  for (const order of result.missingFromRangeOrders) {
    lines.push(['结算有但范围无', order.orderId, String(order.amount), order.settlementId ?? '跨周期或漏导'].join(','))
  }
  return `${lines.join('\n')}\n`
}
