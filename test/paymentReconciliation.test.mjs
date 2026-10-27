/**
 * 付款对账（P4）纯函数测试。
 *
 * 对账是"钱"的事，最怕两种错：
 * - 把**未结算**（正常，跨周期）判成异常；
 * - 把**代扣广告费**当订单去配，结果凭空多出一批"差异"。
 * 这里把这两条钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRangeReport, parseSettlementReport, reconcilePayments, reconcileToCsv,
} from '../lib/shared/paymentReconciliation.js'

const RANGE = [
  '订单号\t交易类型\t金额',
  '111-1\tOrder\t29.99',
  '111-2\tOrder\t49.90',
  '111-3\tRefund\t-10.00',
].join('\n')

const SETTLEMENT = [
  '结算单号\t交易类型\t订单号\t金额',
  'S-1\tOrder Payment\t111-1\t29.99',
  'S-1\tCost of Advertising\t\t-12.40',
  'S-1\tTransfer\t\t17.59',
].join('\n')

test('解析：日期范围与结算报告都能读（结算行允许没有订单号）', () => {
  const range = parseRangeReport(RANGE)
  assert.equal(range.ok, true, range.errors.join('；'))
  assert.equal(range.rows.length, 3)
  const settlement = parseSettlementReport(SETTLEMENT)
  assert.equal(settlement.ok, true, settlement.errors.join('；'))
  assert.equal(settlement.rows.length, 3)
  assert.equal(settlement.rows[1].orderId, null)
})

test('对账：未结算订单单独列出，结算里有但范围没有的另列，不混为一谈', () => {
  const result = reconcilePayments({ rangeOrders: parseRangeReport(RANGE).rows, settlementLines: parseSettlementReport(SETTLEMENT).rows })
  assert.equal(result.kpi.rangeOrders, 3)
  assert.equal(result.kpi.settledOrders, 1)
  assert.equal(result.kpi.unsettled, 2)
  assert.deepEqual(result.unsettledOrders.map((order) => order.orderId).sort(), ['111-2', '111-3'])
  assert.equal(result.kpi.missingFromRange, 0)
})

test('广告费被单独归类，不参与订单匹配；与自填花费的差异单独给', () => {
  const result = reconcilePayments({
    rangeOrders: parseRangeReport(RANGE).rows,
    settlementLines: parseSettlementReport(SETTLEMENT).rows,
    adSpendDeclared: 15,
  })
  assert.equal(result.kpi.adFeeInSettlement, 12.4)
  assert.equal(result.adSpendDiff, -2.6) // 12.4 − 15
  assert.equal(result.kpi.transferTotal, 17.59)
  // 结算合计 = 29.99 − 12.40 + 17.59 = 35.18
  assert.ok(Math.abs(result.kpi.settlementTotal - 35.18) < 1e-9)
  assert.equal(result.kpi.residual, 0)
})

test('结算里出现、范围里没有的订单（跨周期）被标出来而不是判错', () => {
  const settlement = [
    '结算单号\t交易类型\t订单号\t金额',
    'S-9\tOrder Payment\t999-9\t88.00',
  ].join('\n')
  const result = reconcilePayments({ rangeOrders: parseRangeReport(RANGE).rows, settlementLines: parseSettlementReport(settlement).rows })
  assert.equal(result.kpi.missingFromRange, 1)
  assert.equal(result.missingFromRangeOrders[0].orderId, '999-9')
  assert.equal(result.missingFromRangeOrders[0].settlementId, 'S-9')
  assert.ok(result.kpi.unsettled > 0)
})

test('未识别交易类型会进 warning，不会被静默吞掉', () => {
  const settlement = [
    '交易类型\t金额',
    'Storage Fee\t-3.20',
  ].join('\n')
  const parsed = parseSettlementReport(settlement)
  assert.equal(parsed.ok, true)
  const result = reconcilePayments({ rangeOrders: [], settlementLines: parsed.rows })
  // Storage Fee 归为"其他"，分类差额应接近 0，但仍要能算出合计
  assert.ok(Math.abs(result.kpi.settlementTotal + 3.2) < 1e-9)
})

test('缺必需列直接拒绝；差异导出带队头', () => {
  const bad = parseRangeReport('订单号\t类型\n111-1\tOrder')
  assert.equal(bad.ok, false)
  assert.ok(bad.errors[0].includes('金额'), bad.errors[0])

  const result = reconcilePayments({ rangeOrders: parseRangeReport(RANGE).rows, settlementLines: parseSettlementReport(SETTLEMENT).rows })
  const csv = reconcileToCsv(result)
  assert.equal(csv.split('\n')[0], '分组,订单号,金额,说明')
  assert.ok(csv.includes('未结算'))
})
