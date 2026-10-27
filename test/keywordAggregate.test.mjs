/**
 * 关键词聚合（`src/shared/keywordAggregate.ts`）：词级合并的边界测试。
 *
 * 数据来源：`test/fixtures/keyword-aggregate.golden.json` —— 从本地工作台 DB 里
 * 真实导入的搜索词报表（来源 `source.rows = 1243` 行）中摘出的原始行，
 * 不是编的示例。四个 case 覆盖口径的四条边界：
 * - 重复词合并：`tig cups` 44 行 → 55 点击 / 4 单 / $56.84 / $115.87；
 * - 无单词合并：`tig torch` 19 行 → 23 点击 / 0 单 / $23.31（按单行永远判不出否词）；
 * - 大小写与首尾空白合并；但**中间连续空格不归一**（`tig  cups` 是另一个词）；
 * - 空词跳过、负值/`null` 归零。
 *
 * 另外补两条夹具管不到的口径：排序（花费→点击→词）与幂等/入参不被修改。
 *
 * ⚠️ 金额是浮点求和（56.84 会算成 56.839999999999996），比较一律用容差；
 * 展示/写回层的"保留两位"在调用方做，聚合本身不四舍五入（否则大表会被反复舍入放大误差）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aggregateByKeyword } from '../lib/shared/keywordAggregate.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/keyword-aggregate.golden.json', import.meta.url), 'utf8'))

/** 浮点求和带尾差，金额/点击用容差比较，不用 ===。 */
function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: 期望 ${expected}，实际 ${actual}`)
}

/** 逐字段核对一组聚合结果（不比较顺序，顺序另有测试）。 */
function assertGroup(actual, expected) {
  assert.equal(actual.keyword, expected.keyword, '显示词')
  assert.equal(actual.rowCount, expected.rowCount, `${expected.keyword} 合并行数`)
  close(actual.impressions, expected.impressions, `${expected.keyword} 曝光`)
  close(actual.clicks, expected.clicks, `${expected.keyword} 点击`)
  close(actual.orders, expected.orders, `${expected.keyword} 订单`)
  close(actual.spend, expected.spend, `${expected.keyword} 花费`)
  close(actual.sales, expected.sales, `${expected.keyword} 销售额`)
}

test('黄金夹具：四个真实 case 的聚合结果与 DB 核对值一致', () => {
  assert.equal(fixture.source.rows, 1243, '夹具来源必须是那份 1243 行的报表')
  assert.ok(fixture.cases.length >= 4)

  for (const item of fixture.cases) {
    const result = aggregateByKeyword(item.input)
    const expectedList = Array.isArray(item.expected) ? item.expected : [item.expected]
    for (const expected of expectedList) {
      const group = result.find((row) => row.keyword === expected.keyword)
      assert.ok(group !== undefined, `${item.name}：缺少词「${expected.keyword}」（实际：${result.map((row) => row.keyword).join('、')}）`)
      assertGroup(group, expected)
    }
    // 一行都不能凭空消失：各组 rowCount 之和 === 输入里非空词的行数（空词按口径跳过）
    const countable = item.input.filter((row) => typeof row.keyword === 'string' && row.keyword.trim() !== '').length
    const counted = result.reduce((sum, row) => sum + row.rowCount, 0)
    assert.equal(counted, countable, `${item.name}：合并后行数合计必须等于输入的非空词行数`)
  }
})

test('大小写与首尾空白合并；中间连续空格视为另一个词', () => {
  const item = fixture.cases.find((entry) => entry.name === '大小写与空白合并')
  assert.ok(item !== undefined, '夹具里应有「大小写与空白合并」这个 case')
  const result = aggregateByKeyword(item.input)
  assert.deepEqual(result.map((row) => row.keyword).sort(), ['Tig Cups', 'tig  cups'])
  const merged = result.find((row) => row.keyword === 'Tig Cups')
  assert.equal(merged.rowCount, 2, '`Tig Cups` 与 `  tig cups ` 合成一组，双空格的 `tig  cups` 不并入')
  assert.equal(merged.keyword, 'Tig Cups', '显示词取首次出现的原词大小写')
})

test('重复词合并后可判出"23 点击 0 单"：词级结论不是单行结论', () => {
  const item = fixture.cases.find((entry) => entry.name === '无单词合并')
  assert.ok(item !== undefined)
  // 单行视角：每行最多 3 点击，永远到不了 8 点击的否词门槛
  assert.ok(item.input.every((row) => row.clicks < 8), '夹具行里没有任何一行到 8 点击')
  const [torch] = aggregateByKeyword(item.input)
  assert.equal(torch.rowCount, 19)
  assert.equal(torch.clicks, 23, '合并后 23 点击 ≥ 门槛 8，且 0 单 → 才判得出否词候选')
  assert.equal(torch.orders, 0)
})

test('空词跳过、负值 / null / NaN 归零，且不抛错', () => {
  const result = aggregateByKeyword([
    { keyword: '', impressions: 1, clicks: 1, orders: 1, spend: 1, sales: 1 },
    { keyword: '   ', impressions: 1, clicks: 1, orders: 1, spend: 1, sales: 1 },
    { keyword: 'dirty', impressions: -5, clicks: Number.NaN, orders: null, spend: Number.POSITIVE_INFINITY, sales: -3 },
    { keyword: 'Dirty', clicks: 4, spend: 1 },
  ])
  assert.equal(result.length, 1, '空词不产生组，大小写变体并入同一组')
  assert.equal(result[0].keyword, 'dirty')
  assert.equal(result[0].rowCount, 2)
  assert.equal(result[0].impressions, 0)
  assert.equal(result[0].clicks, 4)
  assert.equal(result[0].orders, 0)
  assert.equal(result[0].spend, 1)
  assert.equal(result[0].sales, 0)
  assert.deepEqual(aggregateByKeyword([]), [])
})

test('排序确定：花费降序 → 点击降序 → 词升序，打乱输入与重复聚合结果不变', () => {
  const row = (keyword, spend, clicks) => ({ keyword, impressions: 0, clicks, orders: 0, spend, sales: 0 })
  const rows = [row('b', 10, 5), row('a', 10, 5), row('c', 20, 1), row('d', 10, 9), row('e', 10, 5)]
  const expected = ['c', 'd', 'a', 'b', 'e']
  assert.deepEqual(aggregateByKeyword(rows).map((item) => item.keyword), expected)
  assert.deepEqual(aggregateByKeyword([...rows].reverse()).map((item) => item.keyword), expected, '输入顺序不影响结果')
  assert.deepEqual(
    aggregateByKeyword(rows).map((item) => item.keyword),
    aggregateByKeyword(rows).map((item) => item.keyword),
    '幂等：同一输入聚合两次逐字一致',
  )
})

test('两个真实词一起聚合：花费高者在前，合计等于分别算再相加', () => {
  const cups = fixture.cases.find((entry) => entry.name === '重复词合并').input
  const torch = fixture.cases.find((entry) => entry.name === '无单词合并').input
  const merged = aggregateByKeyword([...cups, ...torch])
  assert.equal(merged.length, 2)
  // 花费 56.84 > 23.31：tig cups 排第一
  assert.deepEqual(merged.map((item) => item.keyword), ['tig cups', 'tig torch'])
  close(merged[0].spend, 56.84)
  close(merged[1].spend, 23.31)
  // 合计等于"分别算再相加"，聚合不会丢数据
  close(merged[0].spend + merged[1].spend, 80.15)
  assert.equal(merged.reduce((sum, item) => sum + item.rowCount, 0), 63)
})
