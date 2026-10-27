/**
 * 流量分析「词级分析块」的数据装配（`src/client/keywordAnalysis.ts`）。
 *
 * 这一层是面板真正显示的数字来源：聚合 → 分层 → Top 风险/机会。
 * 之前只有 shared 层的单测，装配层没有护栏 —— 一旦这里把风险榜按错字段排序，
 * shared 的测试全绿、界面数字却会错。
 *
 * 夹具 `keyword-decisions-20261024.json` 是那份 1243 行报表**按词聚合后**的 767 个词
 * （金额已收到分）。因此本文件输入 767 行、断言 767 词；1243 → 767 的合并本身
 * 由 `keywordAggregate.test.mjs` 负责。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildKeywordAnalysis } from '../lib/client/keywordAnalysis.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/keyword-decisions-20261024.json', import.meta.url), 'utf8'))

const round2 = (value) => Math.round(value * 100) / 100

test('真实数据装配：767 词 → 7 / 3 / 757 / 0，否词花费 $97.93', () => {
  const analysis = buildKeywordAnalysis(fixture.words)

  assert.equal(analysis.rowCount, 767, '输入是聚合后的 767 个词行')
  assert.equal(analysis.wordCount, 767)
  assert.deepEqual(analysis.buckets.map((bucket) => bucket.code), ['negative', 'add', 'watch', 'none'])
  assert.deepEqual(analysis.buckets.map((bucket) => bucket.count), [7, 3, 757, 0])
  assert.equal(round2(analysis.buckets[0].spend), 97.93, '否词花费合计')
  assert.equal(round2(analysis.spend), 1207.36)
  assert.equal(round2(analysis.sales), 3704.44)
  assert.equal(Number((analysis.acos * 100).toFixed(1)), 32.6)
  // 词级明细与 0 单花费占比：三页（流量 / 关键词 / 报表）都读这几个字段
  assert.equal(analysis.words.length, 767)
  assert.equal(analysis.words[0].keyword, 'tig cups', '全部词按花费降序，第一名是 tig cups')
  assert.equal(analysis.words[0].code, 'watch')
  assert.equal(round2(analysis.words[0].spend), 56.84)
  assert.equal(round2(analysis.zeroOrderSpend), 903.71)
  assert.equal(Number((analysis.zeroOrderSpendShare * 100).toFixed(2)), 74.85)
})

test('Top 风险按花费前 5，且包含 tig torch（单行永远判不出来的词）', () => {
  const analysis = buildKeywordAnalysis(fixture.words)
  assert.equal(analysis.risks.length, 5)
  assert.ok(analysis.risks.some((item) => item.keyword === 'tig torch'), 'tig torch 必须在 Top 风险里')
  assert.equal(analysis.risks[0].keyword, 'tig consumables kit', '花费最高者排第一')
  const spends = analysis.risks.map((item) => item.spend)
  assert.deepEqual(spends, [...spends].sort((a, b) => b - a), '风险榜按花费降序')
})

test('Top 机会按销售额前 3：tig welding accessories / tig cups jumbo / jumbo tig cups', () => {
  const analysis = buildKeywordAnalysis(fixture.words)
  assert.deepEqual(
    analysis.opportunities.map((item) => item.keyword),
    ['tig welding accessories', 'tig cups jumbo', 'jumbo tig cups'],
  )
})

test('报表没有广告组/匹配类型时标记 missingPlacement（界面据此提示按投放单元复核）', () => {
  const analysis = buildKeywordAnalysis(fixture.words)
  assert.equal(analysis.missingPlacement, true)
  const withPlacement = fixture.words.map((word, index) => index === 0
    ? { ...word, adGroup: 'SP-A', matchType: 'exact' }
    : word)
  assert.equal(buildKeywordAnalysis(withPlacement).missingPlacement, false)
})

test('原始行重复时 rowCount 与 wordCount 分开计数，且合并后能跨过否词门槛', () => {
  const rows = [
    { keyword: 'tig cups', impressions: 10, clicks: 5, orders: 0, spend: 1, sales: 0 },
    { keyword: 'Tig Cups', impressions: 5, clicks: 4, orders: 0, spend: 1, sales: 0 },
    { keyword: 'other', impressions: 1, clicks: 1, orders: 2, spend: 3, sales: 100 },
  ]
  const analysis = buildKeywordAnalysis(rows)
  assert.equal(analysis.rowCount, 3)
  assert.equal(analysis.wordCount, 2)
  assert.equal(analysis.buckets[0].count, 1, '合并后 9 次点击 → 否词')
  assert.equal(round2(analysis.risks[0].spend), 2)
})
