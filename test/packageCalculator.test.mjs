import assert from 'node:assert/strict'
import test from 'node:test'
import { calculatePackage, calculateWorkbookShippingFee, calculateWorkbookReturnFee, fromKg, switchWeightUnit, toKg } from '../lib/shared/packageCalculator.js'

test('classifies small standard package and calculates monthly storage without inventing shipping rates', () => {
  const result = calculatePackage({ length: 5, width: 5, height: 0.5, weight: 0.1 })
  assert.equal(result.valid, true)
  assert.equal(result.packageClass, 'small_standard')
  assert.equal(result.shippingFee, 3.25)
  assert.equal(result.disposalFee, 0.97)
  assert.equal(result.returnFee, 1.78)
  assert.ok(result.monthlyStorageFee > 0)
})

test('converts centimeters and kilograms before calculating', () => {
  const result = calculatePackage({ length: 25.4, width: 25.4, height: 2.54, sizeUnit: 'cm', weight: 0.45359237, weightUnit: 'kg' })
  assert.equal(result.valid, true)
  assert.ok(Math.abs(result.dimensionsIn.length - 10) < 1e-10)
  assert.ok(Math.abs(result.weightLb - 1) < 1e-10)
})

test('preserves workbook exact fee gaps, missing branches and shared categories', () => {
  assert.equal(calculateWorkbookShippingFee('large_standard', 2, 2, 2.25), 6.24)
  assert.equal(calculateWorkbookShippingFee('large_standard', 2, 2, 2.254), 0)
  assert.equal(calculateWorkbookReturnFee('large_standard', 2, 2, 2.254), 0)
  assert.equal(calculateWorkbookShippingFee('large_standard', 1.1, 0.5, 1), 0)
  const side = Math.cbrt(139 * 2.254)
  const result = calculatePackage({ length: side, width: side, height: side, weight: 2.254 })
  assert.equal(result.packageClass, 'large_standard')
  const missing = calculatePackage({ length: 10, width: 10, height: 1, weight: 1.1 })
  assert.equal(missing.packageClass, 'large_standard')
  assert.equal(calculateWorkbookShippingFee('large_standard', 1.1, 0.5, 0), 0)
  const apparel = calculatePackage({ length: 10, width: 10, height: 2, weight: 1, category: 'apparel' })
  const dangerous = calculatePackage({ length: 10, width: 10, height: 2, weight: 1, category: 'dangerous_goods' })
  assert.equal(apparel.supported, true)
  assert.equal(dangerous.supported, true)
  assert.equal(apparel.shippingFee, calculatePackage({ length: 10, width: 10, height: 2, weight: 1 }).shippingFee)
  assert.equal(dangerous.returnFee, calculatePackage({ length: 10, width: 10, height: 2, weight: 1 }).returnFee)
})

test('rejects invalid dimensions and quantity', () => {
  const result = calculatePackage({ length: 0, width: 12, height: 8, weight: 2, quantity: 1.5 })
  assert.equal(result.valid, false)
  assert.equal(result.shippingFee, null)
  assert.equal(result.errors.length, 2)
})

test('matches the cached non-apparel worksheet row 3 values', () => {
  const result = calculatePackage({ length: 9.05511811023622, width: 5.90551181102362, height: 1.96850393700787, weight: 1.895975436, salePrice: 0.86 })
  assert.ok(Math.abs(result.shippingFee - 6.1) < 1e-8)
  assert.ok(Math.abs(result.lightSmallFee - 5.33) < 1e-8)
  assert.ok(Math.abs(result.monthlyStorageFee - 0.146202720226963) < 1e-10)
  assert.ok(Math.abs(result.disposalFee - 2.2) < 1e-8)
  assert.ok(Math.abs(result.returnFee - 4.63) < 1e-8)
})

test('matches apparel and dangerous-goods cached worksheet row 3 values', () => {
  const apparel = calculatePackage({ length: 9.05511811023622, width: 5.90551181102362, height: 0.393700787401575, weight: 0.66138678, salePrice: 0.86, category: 'apparel' })
  assert.equal(apparel.packageClass, 'small_standard')
  assert.ok(Math.abs(apparel.shippingFee - 3.74) < 1e-8)
  assert.ok(Math.abs(apparel.lightSmallFee - 2.97) < 1e-8)
  assert.ok(Math.abs(apparel.monthlyStorageFee - 0.0292405440453926) < 1e-10)
  assert.ok(Math.abs(apparel.disposalFee - 1.46) < 1e-8)
  assert.ok(Math.abs(apparel.returnFee - 2.08) < 1e-8)

  const dangerous = calculatePackage({ length: 9.05511811023622, width: 5.90551181102362, height: 1.96850393700787, weight: 1.895975436, salePrice: 0.86, category: 'dangerous_goods' })
  assert.equal(dangerous.packageClass, 'large_standard')
  assert.ok(Math.abs(dangerous.shippingFee - 6.1) < 1e-8)
  assert.ok(Math.abs(dangerous.lightSmallFee - 5.33) < 1e-8)
  assert.ok(Math.abs(dangerous.monthlyStorageFee - 0.146202720226963) < 1e-10)
  assert.ok(Math.abs(dangerous.disposalFee - 2.2) < 1e-8)
  assert.ok(Math.abs(dangerous.returnFee - 4.63) < 1e-8)
})

/**
 * 2026-11-01：切重量单位必须换算数值，而不是只换标签。
 *
 * 反例（本次修掉的旧行为）：2 lb 切到 kg 仍写 2 —— 物理重量从 0.91 kg 变成 2 kg，
 * 配送费、23 kg 超重判定跟着一起错。
 */
test('switchWeightUnit：切单位换算数值、物理重量不变，同单位是空操作', () => {
  const lb = { weight: 2, weightUnit: 'lb' }
  const kg = switchWeightUnit(lb, 'kg')
  assert.equal(kg.weightUnit, 'kg')
  assert.equal(kg.weight, 0.91)
  /** 切回去只允许 0.01 级别抖动，绝不能变成 2 kg。 */
  const back = switchWeightUnit(kg, 'lb')
  assert.equal(back.weight, 2.01)
  /** 同单位返回原对象：避免浮点往返把数值抖花。 */
  assert.equal(switchWeightUnit(lb, 'lb'), lb)
  assert.equal(switchWeightUnit({ weight: 1, weightUnit: 'kg' }, 'lb').weight, 2.2)
  /** 缺省单位按 lb 读，与 PackageCalculatorInput 的默认一致。 */
  assert.equal(switchWeightUnit({ weight: 2 }, 'kg').weight, 0.91)
  /** toKg / fromKg 是同一把尺子（外箱箱材复用它们）。 */
  assert.equal(toKg(1, 'lb'), 0.45359237)
  assert.equal(fromKg(0.45359237, 'lb'), 1)
  assert.equal(toKg(Number.NaN, 'lb'), 0)
})
