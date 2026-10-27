/**
 * 搜索词筛选/排序/汇总：纯函数边界测试。
 *
 * 关注点不是"能不能筛"，而是**筛出来的东西和界面上的数字必须同一个口径**：
 * - 按钮角标、表格行、汇总条三处必须同源（这里用同一批行交叉断言）；
 * - `acos === null`（销售额 0）不能被算成"超阈"，否则和无单重复计数；
 * - null 排序恒在最后，`0` 是真实值、不能被当成 null 排到后面；
 * - 汇总的"占整份花费"分母来自整份，不是筛出来的那一片。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TRAFFIC_FILTER, TRAFFIC_PRESETS, countByPreset, filterTrafficRows, matchesTrafficPreset,
  normalizeTrafficFilter, sortTrafficRows, summarizeTrafficSlice,
} from '../lib/shared/trafficFilter.js'
import { summariseSliceForCopy, TRAFFIC_COPY_HEADER } from '../lib/client/trafficCopy.js'

/** 造行：只写关键字段，其余按 0/null 兜底。 */
function row(keyword, overrides = {}) {
  const base = { keyword, impressions: 100, clicks: 10, orders: 0, spend: 10, sales: 0, acos: null, ctr: 0.1, cvr: 0, cpc: 1 }
  return { ...base, ...overrides }
}

const ROWS = [
  // 高花费无单：10 次点击 0 单
  row('waste word', { clicks: 10, spend: 20, orders: 0, sales: 0, acos: null }),
  // 有单但 ACOS 60%（超 30% 阈）
  row('expensive word', { clicks: 20, spend: 30, orders: 2, sales: 50, acos: 0.6 }),
  // 有单且 ACOS 10%（低）
  row('good word', { clicks: 30, spend: 10, orders: 3, sales: 100, acos: 0.1 }),
  // 有曝光无点击
  row('no click word', { impressions: 500, clicks: 0, spend: 0, orders: 0, sales: 0, acos: null, ctr: 0 }),
]

test('预设口径：高花费无单 / ACOS 超阈 / 无点击 / 低 ACOS 有单 互不重复计数', () => {
  assert.deepEqual(filterTrafficRows(ROWS, { preset: 'waste' }).map((r) => r.keyword), ['waste word'])
  assert.deepEqual(filterTrafficRows(ROWS, { preset: 'acos_over' }).map((r) => r.keyword), ['expensive word'])
  assert.deepEqual(filterTrafficRows(ROWS, { preset: 'no_click' }).map((r) => r.keyword), ['no click word'])
  assert.deepEqual(filterTrafficRows(ROWS, { preset: 'good' }).map((r) => r.keyword), ['good word'])
  // acos=null 的行（销售额 0）绝不能进 acos_over
  assert.equal(ROWS.filter((r) => r.acos === null).every((r) => !matchesTrafficPreset(r, 'acos_over', DEFAULT_TRAFFIC_FILTER)), true)
})

test('阈值：点击门槛与 ACOS 阈值的边界是闭/开区间', () => {
  const exact8 = row('exactly eight', { clicks: 8, orders: 0, spend: 5 })
  const seven = row('seven', { clicks: 7, orders: 0, spend: 5 })
  assert.equal(matchesTrafficPreset(exact8, 'waste', { ...DEFAULT_TRAFFIC_FILTER }), true, '点击恰好等于门槛要算进来')
  assert.equal(matchesTrafficPreset(seven, 'waste', { ...DEFAULT_TRAFFIC_FILTER }), false)

  const atThreshold = row('at threshold', { orders: 1, sales: 100, acos: 0.3 })
  const overThreshold = row('over', { orders: 1, sales: 100, acos: 0.31 })
  assert.equal(matchesTrafficPreset(atThreshold, 'acos_over', { ...DEFAULT_TRAFFIC_FILTER }), false, '恰好等于阈值不算超')
  assert.equal(matchesTrafficPreset(overThreshold, 'acos_over', { ...DEFAULT_TRAFFIC_FILTER }), true)
  assert.equal(matchesTrafficPreset(atThreshold, 'good', { ...DEFAULT_TRAFFIC_FILTER }), true, '恰好等于阈值算达标')
})

test('关键词搜索是包含匹配、大小写不敏感、可与预设叠加', () => {
  assert.deepEqual(filterTrafficRows(ROWS, { query: 'WORD' }).length, 4)
  assert.deepEqual(filterTrafficRows(ROWS, { query: 'expensive' }).map((r) => r.keyword), ['expensive word'])
  assert.deepEqual(filterTrafficRows(ROWS, { query: 'word', preset: 'no_click' }).map((r) => r.keyword), ['no click word'])
  assert.deepEqual(filterTrafficRows(ROWS, { query: '   ' }).length, 4, '纯空白搜索等于不筛')
})

test('阈值归一：NaN / 负数 / 越界被夹回可用区间，不把表筛成空', () => {
  assert.equal(normalizeTrafficFilter({ acosThreshold: Number.NaN }).acosThreshold, 0.3)
  assert.equal(normalizeTrafficFilter({ acosThreshold: -1 }).acosThreshold, 0)
  assert.equal(normalizeTrafficFilter({ acosThreshold: 99 }).acosThreshold, 10)
  assert.equal(normalizeTrafficFilter({ minClicks: 0 }).minClicks, 1)
  assert.equal(normalizeTrafficFilter({ minClicks: Number.POSITIVE_INFINITY }).minClicks, 8)
  assert.equal(normalizeTrafficFilter({ preset: 'bogus' }).preset, 'all')
})

test('排序：null 恒在最后（升降序都一样），0 是真实值不当空值', () => {
  const rows = [
    row('a', { spend: 5, acos: 0.2 }),
    row('b', { spend: 50, acos: null }),
    row('c', { spend: 0, acos: 0 }),
  ]
  assert.deepEqual(sortTrafficRows(rows, 'acos', 'desc').map((r) => r.keyword), ['a', 'c', 'b'])
  assert.deepEqual(sortTrafficRows(rows, 'acos', 'asc').map((r) => r.keyword), ['c', 'a', 'b'])
  assert.deepEqual(sortTrafficRows(rows, 'spend', 'desc').map((r) => r.keyword), ['b', 'a', 'c'])
  assert.deepEqual(sortTrafficRows(rows, 'spend', 'asc').map((r) => r.keyword), ['c', 'a', 'b'])
})

test('排序稳定：同值按花费降序、再按关键词升序，翻页不会看串行', () => {
  const rows = [
    row('zzz', { spend: 10, clicks: 5 }),
    row('aaa', { spend: 10, clicks: 5 }),
    row('mmm', { spend: 20, clicks: 5 }),
  ]
  assert.deepEqual(sortTrafficRows(rows, 'clicks', 'desc').map((r) => r.keyword), ['mmm', 'aaa', 'zzz'])
  // 幂等：同一输入再排一次结果不变
  assert.deepEqual(sortTrafficRows(sortTrafficRows(rows, 'clicks', 'desc'), 'clicks', 'desc').map((r) => r.keyword), ['mmm', 'aaa', 'zzz'])
})

test('汇总：占比分母是整份花费，不是筛出来的那一片', () => {
  const waste = filterTrafficRows(ROWS, { preset: 'waste' })
  const slice = summarizeTrafficSlice(waste, ROWS)
  assert.equal(slice.rows, 1)
  assert.equal(slice.spend, 20)
  // 整份花费 = 20 + 30 + 10 + 0 = 60 → 20/60
  assert.equal(Math.round(slice.spendShare * 1000) / 1000, 0.333)
  // 没给整份时不假装 0%
  assert.equal(summarizeTrafficSlice(waste).spendShare, null)
  // 销售额 0 → ACOS 为 null，不是 0%
  assert.equal(slice.acos, null)
})

test('角标与筛选同源：每个预设的角标数 === 该预设筛出的行数', () => {
  const counts = countByPreset(ROWS, DEFAULT_TRAFFIC_FILTER)
  for (const preset of TRAFFIC_PRESETS) {
    assert.equal(counts[preset], filterTrafficRows(ROWS, { preset }).length, `${preset} 角标与筛选结果必须一致`)
  }
  assert.equal(counts.all, ROWS.length)
})

test('复制 TSV：表头与界面同序，空值写 — 而不是 0', () => {
  const metrics = ROWS.map((r) => ({ ...r }))
  const annotations = new Map([['waste word', { action: 'negative_exact' }]])
  const text = summariseSliceForCopy(metrics, annotations)
  const lines = text.split('\n')
  assert.equal(lines.length, 1 + metrics.length)
  assert.equal(lines[0], TRAFFIC_COPY_HEADER.join('\t'))
  const first = lines[1].split('\t')
  assert.equal(first[0], 'waste word')
  assert.equal(first[1], '—', 'acos 为 null 时写 —，不能写 0%')
  assert.equal(first[5], '否精准')
  // 未标注的行写「待分析」，不写「不动」（不动是明确结论，不能冒充）
  assert.equal(lines[2].split('\t')[5], '待分析')
  assert.equal(lines[1].split('\t').length, TRAFFIC_COPY_HEADER.length)
})

/**
 * 占位渲染（react-dom/server）：证明工具条、预设角标、汇总条**真的在 DOM 里**，
 * 而不只是纯函数能算对。SSR 不跑 effect，所以不会发请求。
 */
test('渲染：筛选工具条与汇总条出现在结果区，行数按整份计算', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { AmazonTrafficDetailPane } = await import('../lib/client/views/AmazonTrafficDetailPane.js')

  const dataset = {
    id: 'ds-1', title: '搜索词报表 自检', period: '2026-10-01~2026-10-21',
    rows: ROWS.map((r) => ({ keyword: r.keyword, impressions: r.impressions, clicks: r.clicks, orders: r.orders, spend: r.spend, sales: r.sales })),
    annotations: [{ keyword: 'waste word', action: 'negative_exact', reason: '10 点击 0 单', evidence: 'derived', updatedAt: '2026-10-24T00:00:00.000Z' }],
  }
  const model = {
    datasets: [], current: dataset, busy: false, error: null, staleServer: null, updateFailed: false,
  abaLookup: new Map(),
  abaSource: '',
    actions: { refresh: async () => {}, importRows: async () => null, parseUpload: async () => '', select: async () => {}, remove: async () => {}, clearError: () => {} },
  }
  const html = renderToStaticMarkup(createElement(AmazonTrafficDetailPane, { model }))

  // 五个预设都在，且带角标数字
  for (const label of ['全部', '高花费无单', 'ACOS 超阈', '有曝光无点击', '低 ACOS 有单']) {
    assert.ok(html.includes(label), `工具条应包含预设「${label}」`)
  }
  // 默认「全部」：4 行全在表里
  assert.ok(html.includes('共 4 行'), '默认不筛选时应显示共 4 行')
  assert.ok(html.includes('占整份 100.0%'), '不筛选时这一片就是整份（占比 100%）')
  // 控件存在
  assert.ok(html.includes('aria-label="按搜索词过滤"'), '应有搜索框')
  assert.ok(html.includes('aria-label="ACOS 阈值（百分比）"'), '应有 ACOS 阈值输入')
  assert.ok(html.includes('aria-label="排序字段"'), '应有排序选择')
  assert.ok(html.includes('复制结果'), '应有复制按钮')
  // AI 建议映射到中文标签
  assert.ok(html.includes('否精准'), '有标注的行应显示中文动作')
  assert.ok(html.includes('待分析'), '无标注的行应显示待分析')
})

test('诊断文案与筛选预设共用同一个点击门槛（不许两处各写一个 8）', async () => {
  const { analyseTraffic } = await import('../lib/client/amazonTrafficTools.js')
  const { WASTE_MIN_CLICKS } = await import('../lib/shared/trafficFilter.js')
  // 恰好等于门槛：诊断要判成"高点击无订单"，筛选也要能筛出来
  const atThreshold = analyseTraffic([{ keyword: 'k', impressions: 100, clicks: WASTE_MIN_CLICKS, orders: 0, spend: 5, sales: 0 }])[0]
  assert.match(atThreshold.diagnosis, /高点击无订单/)
  assert.equal(matchesTrafficPreset(atThreshold, 'waste', { acosThreshold: 0.3, minClicks: WASTE_MIN_CLICKS }), true)
  // 门槛 -1：两边都不该命中
  const below = analyseTraffic([{ keyword: 'k', impressions: 100, clicks: WASTE_MIN_CLICKS - 1, orders: 0, spend: 5, sales: 0 }])[0]
  assert.doesNotMatch(below.diagnosis, /高点击无订单/)
  assert.equal(matchesTrafficPreset(below, 'waste', { acosThreshold: 0.3, minClicks: WASTE_MIN_CLICKS }), false)
})
