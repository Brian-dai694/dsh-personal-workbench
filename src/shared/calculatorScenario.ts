/**
 * 测算方案的**输入契约**（服务端存、客户端算，共用一份）。
 *
 * ## 为什么不为负值做"自动修正"
 * `calculateAmazonEconomics` 会把负数/超范围的比例判成 `invalid` 并给出错误文案。
 * 如果这里把 `-3` 悄悄夹成 `0`，用户会看到"保存成功 + 结果正常"，
 * 但他填错的那个数被吞了 —— 这比直接报错更危险（错误数据看起来是合法的）。
 * 所以这里只做一件事：**把无法表示成 JSON 的值丢掉**（NaN / Infinity / 非数字），
 * 其余原样保留，让校验层去报错。
 *
 * ## 为什么允许缺字段
 * 老方案、手工改过的 JSON、将来新增的字段都可能缺项；缺项由调用方与默认值合并
 * （界面侧 `DEFAULTS` 合并），而不是在这里补一堆 0 —— 0 是有业务含义的值
 * （"没有仓储费" ≠ "没填仓储费"）。
 */

/** 参与计算的数值字段（顺序即界面顺序，便于生成 diff / 表格列）。 */
export const CALCULATOR_FIELDS = [
  'price', 'unitCost', 'freight', 'fbaFee', 'referralFee', 'storageFee', 'removalFee',
  'promotionCost', 'returnRate', 'returnLoss', 'otherCosts',
  'targetAcos', 'conversionRate', 'adOrderShare', 'marketCpc',
] as const

export type CalculatorField = typeof CALCULATOR_FIELDS[number]

/** 可选字段：不填就是"未提供"，与填 0 语义不同（校准对比尤其如此）。 */
export const CALCULATOR_OPTIONAL_FIELDS = ['calibrationCpc'] as const

export type CalculatorInputRecord = Partial<Record<CalculatorField | 'calibrationCpc', number>>

/**
 * 归一化一份输入：只保留能表示为 JSON 的有限数字。
 *
 * 非法值（字符串、null、NaN、Infinity）被**丢弃**而不是转 0 —— 丢弃后合并默认值时
 * 会回落默认值，用户能看出"这个字段没被保存"，而不是看到一个假的 0。
 */
export function normalizeCalculatorInput(raw: unknown): CalculatorInputRecord {
  if (raw === null || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const out: CalculatorInputRecord = {}
  for (const field of [...CALCULATOR_FIELDS, ...CALCULATOR_OPTIONAL_FIELDS]) {
    const value = source[field]
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value
  }
  return out
}

/**
 * **由别的字段推导**的字段：不参与"两个方案差在哪"。
 *
 * 销售佣金恒定 = 售价 × 15%（见下方 REFERRAL_FEE_RATE），两份方案售价不同时佣金必然
 * 跟着变 —— 把它列进 diff 只是在重复"售价差了"，还会让人误以为佣金是能自己填的输入项。
 */
export const CALCULATOR_DERIVED_FIELDS: ReadonlySet<string> = new Set(['referralFee'])

/** 两个方案之间**改了哪些字段**（只报数值不同的项；推导字段不报）。 */
export function diffCalculatorInputs(
  a: CalculatorInputRecord,
  b: CalculatorInputRecord,
): Array<{ field: CalculatorField | 'calibrationCpc'; from: number | null; to: number | null }> {
  const diffs: Array<{ field: CalculatorField | 'calibrationCpc'; from: number | null; to: number | null }> = []
  for (const field of [...CALCULATOR_FIELDS, ...CALCULATOR_OPTIONAL_FIELDS]) {
    if (CALCULATOR_DERIVED_FIELDS.has(field)) continue
    const from = a[field]
    const to = b[field]
    const fromValue = typeof from === 'number' ? from : null
    const toValue = typeof to === 'number' ? to : null
    if (fromValue !== toValue) diffs.push({ field, from: fromValue, to: toValue })
  }
  return diffs
}

/** 字段的中文名（表格与 diff 共用；缺了就显示原字段名，不静默）。 */
export const CALCULATOR_FIELD_LABELS: Record<CalculatorField | 'calibrationCpc', string> = {
  price: '售价',
  unitCost: '采购成本',
  freight: '头程运费',
  fbaFee: 'FBA 配送费',
  referralFee: '销售佣金',
  storageFee: '仓储费摊销',
  removalFee: '移除/弃置摊销',
  promotionCost: '促销成本摊销',
  returnRate: '退货率',
  returnLoss: '退货额外损失',
  otherCosts: '其他单件费用',
  targetAcos: '目标 ACOS',
  conversionRate: '转化率',
  adOrderShare: '广告订单占比',
  marketCpc: '市场参考 CPC',
  calibrationCpc: '外部盈亏 CPC',
}

/** 比例类字段：表格里要显示成百分比，不能显示 0.25。 */
export const CALCULATOR_RATE_FIELDS: ReadonlySet<string> = new Set(['returnRate', 'targetAcos', 'conversionRate', 'adOrderShare'])

/**
 * 销售佣金比例：**固定 15%**（用户口径，2026-10-27）。
 *
 * 为什么固定成比例、而不是留一个可改的金额：佣金按售价比例计，把金额做成可填项时，
 * 改了售价佣金不跟着变，盈亏 CPC 会安静地算错（结果看着依然合法，最难发现）。
 * 现在佣金只由售价推导；类目佣金率不同（如 8%）属于例外，那时改的是这个常量，
 * 不是界面上临时编一个金额。
 */
export const REFERRAL_FEE_RATE = 0.15

/** 售价对应的佣金；非法/非正售价按 0 处理，让校验层去报"售价必须大于 0"。 */
export function referralFeeOf(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  return Math.round(price * REFERRAL_FEE_RATE * 100) / 100
}

/**
 * 把一份测算输入里的佣金覆盖成「售价 × 15%」。
 *
 * 面板、方案库载入、多方案对比三条路径都必须过这里：否则会出现
 * 「面板上佣金是 15%，对比表里还是老方案存下的另一个数」——
 * 同一款货两张表两个结论，比算错更糟。
 */
export function withFixedReferralFee<T extends { price?: number; referralFee?: number }>(
  input: T,
): T & { referralFee: number } {
  return { ...input, referralFee: referralFeeOf(input.price ?? 0) }
}

/** 方案名归一：去空白 + 截断（过长的名字会把列表行撑爆）。 */
export function normalizeScenarioName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, 60)
}

/**
 * 测算的**默认参数**（界面初值，也是老方案缺字段时的回落值）。
 *
 * 放在共享模块而不是视图里：对比表要用同一份默认值补齐老方案，
 * 两边各写一份的话会出现「单看面板是 $39.99、对比表里是别的数」。
 */
export const CALCULATOR_DEFAULTS: Required<Omit<CalculatorInputRecord, 'calibrationCpc'>> = {
  price: 39.99,
  unitCost: 8,
  freight: 3,
  fbaFee: 6,
  /** 仅作占位：佣金恒定由售价推导（referralFeeOf(39.99) = 6.00）。 */
  referralFee: 6,
  storageFee: 0,
  removalFee: 0,
  promotionCost: 0,
  returnRate: 0.03,
  returnLoss: 2,
  otherCosts: 0,
  targetAcos: 0.25,
  conversionRate: 0.1,
  adOrderShare: 0.6,
  marketCpc: 1.2,
}
