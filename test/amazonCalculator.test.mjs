import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateAmazonBid, calculateAmazonEconomics } from '../lib/client/amazonCalculator.js'

const base = {
  price: 40,
  unitCost: 8,
  freight: 3,
  fbaFee: 6,
  referralFee: 6,
  storageFee: 0.5,
  removalFee: 0.2,
  promotionCost: 1,
  returnRate: 0.05,
  returnLoss: 2,
  otherCosts: 1,
  targetAcos: 0.25,
  conversionRate: 0.1,
  adOrderShare: 0.6,
  marketCpc: 1.2,
}

test('calculates effective profit, ACOS and CPC recommendations', () => {
  const result = calculateAmazonEconomics(base)
  assert.equal(result.valid, true)
  assert.equal(result.totalVariableCost, 25.7)
  assert.ok(Math.abs(result.effectiveProfit - 12.2) < 1e-10)
  assert.ok(Math.abs(result.marginRate - 12.2 / 40) < 1e-10)
  assert.ok(Math.abs(result.breakEvenAcos - 12.2 / 40) < 1e-10)
  assert.ok(Math.abs(result.breakEvenCpc - 1.22) < 1e-10)
  assert.equal(result.suggestedCpc, 1)
  assert.equal(result.safetyCpc, 0.8)
  assert.ok(Math.abs(result.profitAfterAds - 6.2) < 1e-10)
})

test('rejects invalid rates and negative amounts', () => {
  const result = calculateAmazonEconomics({ ...base, returnRate: 1.1, targetAcos: -0.1, unitCost: -2 })
  assert.equal(result.valid, false)
  assert.equal(result.errors.length, 3)
})

test('returns null ratios for zero price and finite output for valid zero values', () => {
  const result = calculateAmazonEconomics({ ...base, price: 0, conversionRate: 0, returnRate: 0 })
  assert.equal(result.valid, false)
  assert.equal(result.marginRate, null)
  assert.equal(result.breakEvenAcos, null)
  assert.equal(result.profitAfterAdsRate, null)
  assert.equal(result.breakEvenCpc, null)
})

test('compares an externally supplied CPC without claiming calibration', () => {
  const result = calculateAmazonEconomics({ ...base, calibrationCpc: 1.5 })
  assert.ok(Math.abs(result.calibrationCpcGap + 0.28) < 1e-10)
  assert.equal(calculateAmazonEconomics(base).calibrationCpcGap, null)
})

test('storage, removal and promotion costs reduce contribution and break-even CPC', () => {
  const withoutExtra = calculateAmazonEconomics({ ...base, storageFee: 0, removalFee: 0, promotionCost: 0 })
  const withExtra = calculateAmazonEconomics(base)
  assert.ok(Math.abs(withoutExtra.effectiveProfit - withExtra.effectiveProfit - 1.7) < 1e-10)
  assert.ok(withoutExtra.breakEvenCpc > withExtra.breakEvenCpc)
})

test('calculates placement-adjusted CPC and rejects invalid bid inputs', () => {
  const bid = calculateAmazonBid({ bid: 0.8, placementPercent: 50, maxMultiplier: 2 })
  assert.ok(Math.abs(bid.highestCpc - 2.4) < 1e-10)
  assert.equal(bid.valid, true)
  assert.equal(calculateAmazonBid({ bid: -1, placementPercent: 50, maxMultiplier: 2 }).valid, false)
})

test('does not create break-even ad capacity for negative contribution margin', () => {
  const result = calculateAmazonEconomics({ ...base, unitCost: 30 })
  assert.ok(result.effectiveProfit < 0)
  assert.equal(result.breakEvenCpc, null)
  assert.equal(result.valid, true)
})
