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
    if (!Number.isFinite(value)) errors.push(`${field} must be finite`)
    else if (value < 0) errors.push(`${field} cannot be negative`)
  }
  const highestCpc = errors.length === 0
    ? input.bid * (1 + input.placementPercent / 100) * input.maxMultiplier
    : Number.NaN
  return { valid: errors.length === 0, errors, highestCpc }
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
    if (!Number.isFinite(value)) errors.push(`${field} must be finite`)
    else if (value < 0) errors.push(`${field} cannot be negative`)
  }
  for (const [field, max] of RATE_FIELDS) {
    if (input[field] > max) errors.push(`${field} must be between 0 and ${max}`)
  }
  if (input.calibrationCpc !== undefined && (!Number.isFinite(input.calibrationCpc) || input.calibrationCpc < 0)) {
    errors.push('calibrationCpc must be a finite non-negative amount')
  }
  if (input.price <= 0) errors.push('price must be greater than zero')

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
