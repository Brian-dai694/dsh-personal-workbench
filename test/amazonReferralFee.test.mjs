/**
 * 销售佣金**固定 15%**（2026-10-27 用户口径）。
 *
 * 关注点：
 * 1. 佣金只由售价推导，四舍五入到分，非法售价不产生负数佣金；
 * 2. `withFixedReferralFee` 覆盖任何传入的佣金，且不就地改调用方的对象；
 * 3. 佣金是**推导字段**，不参与"两份方案差在哪"（否则每份售价不同的方案都多一条噪音）；
 * 4. 方案对比也必须现按 15% 算 —— 老方案里存过的佣金金额不许渗进结论；
 * 5. 面板结构判据：佣金输入只读、计算入口只有一个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CALCULATOR_DEFAULTS, REFERRAL_FEE_RATE, diffCalculatorInputs, referralFeeOf, withFixedReferralFee,
} from '../lib/shared/calculatorScenario.js'
import { buildComparison } from '../lib/client/calculatorCompare.js'

const viewSource = readFileSync(new URL('../src/client/views/AmazonToolsView.tsx', import.meta.url), 'utf8')

test('佣金比例固定 15%，按售价推导并四舍五入到分', () => {
  assert.equal(REFERRAL_FEE_RATE, 0.15)
  assert.equal(referralFeeOf(39.99), 6, '39.99 × 15% = 5.9985，取到分应为 6.00')
  assert.equal(referralFeeOf(19.99), 3)
  assert.equal(referralFeeOf(10), 1.5)
  assert.equal(referralFeeOf(0), 0, '售价 0 时佣金只能是 0，负数佣金会让成本表看着更好看')
  assert.equal(referralFeeOf(-5), 0)
  assert.equal(referralFeeOf(Number.NaN), 0)
})

test('withFixedReferralFee 覆盖传入佣金，改售价即重算，且不就地改原对象', () => {
  const input = { ...CALCULATOR_DEFAULTS, price: 25, referralFee: 9 }
  assert.equal(withFixedReferralFee(input).referralFee, 3.75)
  assert.equal(withFixedReferralFee({ ...input, price: 40 }).referralFee, 6)
  assert.equal(input.referralFee, 9, '调用方的对象不许被改写')
})

test('佣金是推导字段：不参与方案 diff', () => {
  const a = { ...CALCULATOR_DEFAULTS }
  const b = { ...CALCULATOR_DEFAULTS, price: 29.99, referralFee: 99 }
  assert.deepEqual(diffCalculatorInputs(a, b).map((diff) => diff.field), ['price'],
    '售价不同时佣金必然跟着变，它不该单独占一条差异')
})

test('方案对比按 15% 现算：老方案存的佣金不渗进结论', () => {
  const table = buildComparison([
    { id: 'a', name: '基准', input: { price: 40, referralFee: 0 } },
    { id: 'b', name: '同价不同佣金', input: { price: 40, referralFee: 30 } },
  ], CALCULATOR_DEFAULTS)
  assert.equal(table.columns[0].input.referralFee, 6)
  assert.equal(table.columns[1].input.referralFee, 6, '列里的佣金必须是 40 × 15%')
  assert.equal(table.columns[0].result.effectiveProfit, table.columns[1].result.effectiveProfit)
  assert.deepEqual(table.columns[1].diffs, [], '参数实际相同 → 不许报差异')
})

test('测算面板：佣金只读、计算与保存都走推导后的输入', () => {
  assert.match(viewSource, /readonly: true \}/, '销售佣金字段必须标成只读（不可手填金额）')
  assert.match(viewSource, /readOnly=\{readonly === true\}/, '只读字段要落到 input 的 readOnly 上')
  assert.match(viewSource, /withFixedReferralFee\(input\)/, '计算入口用推导后的输入')
  assert.match(viewSource, /calculateAmazonEconomics\(calcInput\)/, '计算只吃 calcInput（佣金已是 15%）')
  assert.match(viewSource, /JSON\.stringify\(calcInput\)/, '本地缓存存的是推导后的输入')
})
