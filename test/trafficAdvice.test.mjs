/**
 * 搜索词报表的本地规则建议：这是"导入后立刻能看到结论"的兜底，
 * 所以每条规则的**边界**必须钉死（8 次点击、30% ACOS 都是操作阈值，不是美学）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adviceForRow, buildLocalAdvice, summarizeAdvice } from '../lib/client/trafficAdvice.js'

const row = (over) => ({ keyword: 'k', clicks: 0, orders: 0, spend: 0, sales: 0, impressions: 0, ...over })

test('否词候选：点击 ≥8 且 0 单；7 次点击不否（样本不足）', () => {
  assert.equal(adviceForRow(row({ clicks: 8, spend: 4.2 })).action, 'negative_exact')
  assert.equal(adviceForRow(row({ clicks: 7, spend: 4.2 })).action, 'watch')
  assert.equal(adviceForRow(row({ clicks: 40, orders: 1, spend: 10, sales: 60 })).action, 'watch', '只有 1 单未达词级主规则的加词门槛')
  assert.equal(adviceForRow(row({ clicks: 40, orders: 1, spend: 30, sales: 60 })).action, 'watch', '有单但 ACOS 50% → 观察，仍是否定之外的处理')
})

test('有单：ACOS ≤30% 加精准，>30% 观察；销售额为 0 时 ACOS 未知也判观察', () => {
  assert.equal(adviceForRow(row({ clicks: 5, orders: 2, spend: 9, sales: 60 })).action, 'add_exact')
  assert.equal(adviceForRow(row({ clicks: 5, orders: 2, spend: 30, sales: 60 })).action, 'watch')
  assert.equal(adviceForRow(row({ clicks: 5, orders: 1, spend: 3, sales: 60 })).action, 'watch', '单笔订单只作观察，不能直接加精准')
  const unknown = adviceForRow(row({ clicks: 5, orders: 1, spend: 9, sales: 0 }))
  assert.equal(unknown.action, 'watch')
  assert.match(unknown.reason, /ACOS 未知/)
})

test('否词候选必须有正花费，且加词至少 2 单与词级分层规则一致', () => {
  assert.equal(adviceForRow(row({ clicks: 8, orders: 0, spend: 0 })).action, 'watch', '零花费不应成为否词候选')
  assert.equal(adviceForRow(row({ clicks: 8, orders: 0, spend: 0.01 })).action, 'negative_exact')
  assert.equal(adviceForRow(row({ clicks: 8, orders: 0, spend: 0.01 })).action, 'negative_exact')
  assert.equal(adviceForRow(row({ clicks: 5, orders: 1, spend: 2, sales: 20 })).action, 'watch')
  assert.equal(adviceForRow(row({ clicks: 5, orders: 2, spend: 6, sales: 20 })).action, 'add_exact')
})

test('有曝光 0 点击 → 观察（不是否词问题）；零曝光零点击 → none', () => {
  const noClick = adviceForRow(row({ impressions: 500, clicks: 0 }))
  assert.equal(noClick.action, 'watch')
  assert.match(noClick.reason, /相关性或主图/)
  assert.equal(adviceForRow(row({})).action, 'none')
})

test('整份建议：按花费降序取前 N、同词去重、跳过 none', () => {
  const rows = [
    row({ keyword: 'low', clicks: 9, spend: 1 }),
    row({ keyword: 'high', clicks: 20, spend: 30 }),
    row({ keyword: 'HIGH', clicks: 5, spend: 30 }),
    row({ keyword: 'noimp' }),
    row({ keyword: 'third', clicks: 8, spend: 12 }),
  ]
  const advice = buildLocalAdvice(rows, { limit: 2 })
  assert.equal(advice.length, 2, 'limit 生效')
  assert.equal(advice[0].keyword, 'high', '花费最高的先给')
  assert.equal(advice.every((item) => item.evidence === 'derived'), true)
  const all = buildLocalAdvice(rows)
  assert.equal(all.filter((item) => item.keyword.toLowerCase() === 'high').length, 1, '同词（大小写不同）只给一条')
  assert.equal(all.some((item) => item.keyword === 'noimp'), false, 'none 不入列')
  const stat = summarizeAdvice(all)
  assert.equal(stat.negative + stat.add + stat.watch, all.length)
})

test('词级建议先合并分散在多行的指标，任何行有订单都不得被误判为否词', () => {
  const advice = buildLocalAdvice([
    row({ keyword: ' TIG CUPS ', clicks: 3, orders: 0, spend: 3, sales: 0, impressions: 30 }),
    row({ keyword: 'tig cups', clicks: 3, orders: 1, spend: 3, sales: 20, impressions: 30 }),
    row({ keyword: 'tig cups', clicks: 2, orders: 0, spend: 2, sales: 0, impressions: 20 }),
  ])
  assert.equal(advice.length, 1)
  assert.equal(advice[0].keyword, 'TIG CUPS')
  assert.equal(advice[0].action, 'watch', '聚合后有订单且 ACOS=40%，只能观察，不能因其他行 0 单而否词')
  assert.match(advice[0].reason, /1 单但 ACOS 40\.0%/)
})

test('词级建议对聚合后的总点击应用门槛，limit 仅限制最终建议数', () => {
  const splitWaste = Array.from({ length: 4 }, (_, index) => row({
    keyword: 'split waste', clicks: 2, spend: index + 1, impressions: 20,
  }))
  const advice = buildLocalAdvice([
    ...splitWaste,
    row({ keyword: 'small sample', clicks: 7, spend: 9, impressions: 70 }),
    row({ keyword: 'good', clicks: 4, orders: 2, spend: 4, sales: 20, impressions: 40 }),
  ], { limit: 1 })
  assert.equal(advice.length, 1)
  assert.equal(advice[0].keyword, 'split waste')
  assert.equal(advice[0].action, 'negative_exact')
  assert.match(advice[0].reason, /8 次点击/)
})

test('阈值可调：把否词门槛降到 3 次，4 次点击的词立刻变否词候选', () => {
  const r = row({ clicks: 4, spend: 2 })
  assert.equal(adviceForRow(r).action, 'watch')
  assert.equal(adviceForRow(r, { wasteMinClicks: 3 }).action, 'negative_exact')
  assert.equal(adviceForRow(row({ clicks: 5, orders: 1, spend: 10, sales: 50 }), { goodAcos: 0.1 }).action, 'watch', 'ACOS 门槛收紧后不再算加词')
})