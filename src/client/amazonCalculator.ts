import { CALCULATOR_FIELD_LABELS } from '../shared/calculatorScenario.js'

export interface AmazonCalculatorInput {
  price: number
  unitCost: number
  freight: number
  fbaFee: number
  referralFee: number
  storageFee: number
  removalFee: number
  promotionCost: number
  returnRate: number
  returnLoss: number
  otherCosts: number
  targetAcos: number
  conversionRate: number
  adOrderShare: number
  marketCpc: number
  calibrationCpc?: number
}

export interface AmazonCalculatorResult {
  valid: boolean
  errors: string[]
  effectiveProfit: number
  marginRate: number | null
  breakEvenAcos: number | null
  breakEvenCpc: number | null
  suggestedCpc: number
  safetyCpc: number
  profitAfterAds: number
  profitAfterAdsRate: number | null
  marketCpcGap: number | null
  calibrationCpcGap: number | null
  totalVariableCost: number
}

export interface AmazonBidInput {
  bid: number
  placementPercent: number
  maxMultiplier: number
}

export interface AmazonBidResult {
  valid: boolean
  errors: string[]
  highestCpc: number
}

export function calculateAmazonBid(input: AmazonBidInput): AmazonBidResult {
  const errors: string[] = []
  for (const [field, value] of Object.entries(input)) {
    if (!Number.isFinite(value)) errors.push(`${labelOf(field)}必须是有效数字`)
    else if (value < 0) errors.push(`${labelOf(field)}不能为负`)
  }
  const highestCpc = errors.length === 0
    ? input.bid * (1 + input.placementPercent / 100) * input.maxMultiplier
    : Number.NaN
  return { valid: errors.length === 0, errors, highestCpc }
}

/**
 * 字段的中文名：错误信息里不能用 price 这种内部键名 —— 用户看到的是中文界面，
 * 一句 price cannot be negative 既看不懂也不知道该改哪个框。
 * 名称的唯一来源是 shared/calculatorScenario.ts（与对比表共用，不另写一份）。
 */
function labelOf(field: string): string {
  return (CALCULATOR_FIELD_LABELS as Record<string, string | undefined>)[field] ?? field
}

type RequiredCostField = 'unitCost' | 'freight' | 'fbaFee' | 'referralFee' | 'storageFee' | 'removalFee' | 'promotionCost' | 'otherCosts'

const COST_FIELDS: RequiredCostField[] = [
  'unitCost', 'freight', 'fbaFee', 'referralFee', 'storageFee', 'removalFee', 'promotionCost', 'otherCosts',
]

const RATE_FIELDS: Array<['returnRate' | 'targetAcos' | 'conversionRate' | 'adOrderShare', number]> = [
  ['returnRate', 1], ['targetAcos', 1], ['conversionRate', 1], ['adOrderShare', 1],
]

export function calculateAmazonEconomics(input: AmazonCalculatorInput): AmazonCalculatorResult {
  const errors: string[] = []
  for (const [field, value] of Object.entries(input)) {
    if (field === 'calibrationCpc' && value === undefined) continue
    if (!Number.isFinite(value)) errors.push(`${labelOf(field)}必须是有效数字`)
    else if (value < 0) errors.push(`${labelOf(field)}不能为负`)
  }
  for (const [field, max] of RATE_FIELDS) {
    if (input[field] > max) errors.push(`${labelOf(field)}必须在 0 到 ${max * 100}% 之间`)
  }
  if (input.calibrationCpc !== undefined && (!Number.isFinite(input.calibrationCpc) || input.calibrationCpc < 0)) {
    errors.push(`${labelOf('calibrationCpc')}必须是有效的非负金额`)
  }
  if (input.price <= 0) errors.push('售价必须大于 0')

  const totalVariableCost = COST_FIELDS.reduce((sum, field) => sum + input[field], 0)
  const effectiveProfit = input.price
    - totalVariableCost
    - input.returnRate * input.price
    - input.returnRate * input.returnLoss
  const marginRate = input.price > 0 ? effectiveProfit / input.price : null
  const breakEvenAcos = input.price > 0 ? effectiveProfit / input.price : null
  const breakEvenCpc = effectiveProfit > 0 && marginRate !== null
    ? input.price * input.conversionRate * marginRate
    : null
  const suggestedCpc = input.price * input.conversionRate * input.targetAcos
  const safetyCpc = suggestedCpc * 0.8
  const profitAfterAds = effectiveProfit - input.price * input.adOrderShare * input.targetAcos

  return {
    valid: errors.length === 0,
    errors,
    effectiveProfit,
    marginRate,
    breakEvenAcos,
    breakEvenCpc,
    suggestedCpc,
    safetyCpc,
    profitAfterAds,
    profitAfterAdsRate: input.price > 0 ? profitAfterAds / input.price : null,
    marketCpcGap: input.marketCpc > 0 ? input.marketCpc - suggestedCpc : null,
    calibrationCpcGap: input.calibrationCpc === undefined ? null : (breakEvenCpc ?? 0) - input.calibrationCpc,
    totalVariableCost,
  }
}
