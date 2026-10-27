/**
 * 运营日志展示口径测试（v2）：类型配色与旧应用一致、KPI 口径、日期分组。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPLOG_TYPE_COLORS, colorForType, groupEntries, oplogKpi } from '../lib/shared/oplogView.js'

test('类型颜色：已知类型按旧应用顺序取色，未知类型稳定不抖', () => {
  const known = ['Listing', '复盘', '库存', '销售', '广告', '促销', '事件', '其它']
  assert.equal(colorForType('Listing', known), OPLOG_TYPE_COLORS[0])
  assert.equal(colorForType('促销', known), OPLOG_TYPE_COLORS[5])
  const a = colorForType('新类型X')
  const b = colorForType('新类型X')
  assert.equal(a, b, '同一未知类型两次取色必须一致')
  assert.ok(OPLOG_TYPE_COLORS.includes(a))
})

test('KPI：本周/本月/本年/总计按本地日界数', () => {
  const now = new Date(2026, 9, 23, 12, 0, 0) // 2026-10-23 周五
  const kpi = oplogKpi([
    new Date(2026, 9, 23, 9, 0, 0).toISOString(),   // 本周
    new Date(2026, 9, 21, 9, 0, 0).toISOString(),   // 本周（周一）
    new Date(2026, 9, 2, 9, 0, 0).toISOString(),    // 本月更早
    new Date(2026, 0, 5, 9, 0, 0).toISOString(),    // 本年更早
    new Date(2025, 0, 5, 9, 0, 0).toISOString(),    // 去年
  ], now)
  assert.deepEqual(kpi, { week: 2, month: 3, year: 4, total: 5 })
})

test('日期分组：今天/昨天/本周更早/本月更早/更早，空组不出现', () => {
  const now = new Date(2026, 9, 23, 12, 0, 0)
  const groups = groupEntries([
    { id: 'a', createdAt: new Date(2026, 9, 23, 9, 0, 0).toISOString() },
    { id: 'b', createdAt: new Date(2026, 9, 22, 9, 0, 0).toISOString() },
    { id: 'c', createdAt: new Date(2026, 9, 20, 9, 0, 0).toISOString() },
    { id: 'd', createdAt: new Date(2026, 9, 2, 9, 0, 0).toISOString() },
    { id: 'e', createdAt: new Date(2026, 0, 2, 9, 0, 0).toISOString() },
  ], now)
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'week', 'month', 'earlier'])
  assert.deepEqual(groups.map((g) => g.items.length), [1, 1, 1, 1, 1])
})

test('日期分组优先用业务日期 logDate（YYYY-MM-DD），缺失才回退 createdAt', () => {
  const now = new Date(2026, 9, 23, 12, 0, 0)
  const groups = groupEntries([
    // 今天导入、但业务日期是本月更早：必须落「本月更早」，不能因为刚导入就进「今天」
    { id: 'a', createdAt: new Date(2026, 9, 23, 9, 0, 0).toISOString(), logDate: '2026-10-02' },
    // 业务日期就是今天
    { id: 'b', createdAt: new Date(2026, 9, 1, 9, 0, 0).toISOString(), logDate: '2026-10-23' },
    // 老记录没有 logDate：仍按 createdAt 归组（不能丢）
    { id: 'c', createdAt: new Date(2026, 9, 22, 9, 0, 0).toISOString() },
  ], now)
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'month'])
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [['b'], ['c'], ['a']])
})
