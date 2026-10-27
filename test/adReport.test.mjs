/**
 * 广告报表分析（P1）纯函数测试：解析容错 + 三类规则 + 导出。
 *
 * 为什么这些断言重要：
 * - 报表列名有中英两套、还有 TSV；解析错一列，后面所有「建议」都是错的，
 *   而界面上看起来一切正常（有数、有建议）；
 * - 规则必须**样本不足就别下结论**：把 3 个点击判成否词，是真金白银的损失；
 * - 导出的是人工确认清单，列顺序与转义要能直接贴回 Excel。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AD_ACTION_LABELS, DEFAULT_RULES, actionsToCsv, analyseAdReport, parseAdReportCsv,
} from '../lib/shared/adReport.js'

const CN_SEARCH_TERM = [
  '客户搜索词\t曝光量\t点击量\t花费\t销售额\t订单',
  'welding gloves\t1000\t32\t$24.00\t0\t0',
  'tig gloves\t800\t18\t$14.50\t$120.00\t3',
  'mig gloves\t500\t3\t$1.20\t0\t0',
].join('\n')

test('解析：中文表头 + TSV + 货币符号，数字能落到正确字段', () => {
  const parsed = parseAdReportCsv(CN_SEARCH_TERM, 'search_term')
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.rows.length, 3)
  const tig = parsed.rows.find((row) => row.keyword === 'tig gloves')
  assert.deepEqual(
    { clicks: tig.clicks, spend: tig.spend, sales: tig.sales, orders: tig.orders },
    { clicks: 18, spend: 14.5, sales: 120, orders: 3 },
  )
})

test('解析：英文表头 + CSV 引号（搜索词里带逗号）', () => {
  const text = [
    'Customer Search Term,Impressions,Clicks,Spend,Sales,Orders',
    '"torch, tig 17",900,20,12.5,60,1',
    'cup 10,300,4,2,0,0',
  ].join('\n')
  const parsed = parseAdReportCsv(text, 'search_term')
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.rows[0].keyword, 'torch, tig 17')
  assert.equal(parsed.rows[0].orders, 1)
})

test('解析：缺必需列时明确报缺哪列，不静默按 0 处理', () => {
  const parsed = parseAdReportCsv('客户搜索词\nfoo\n', 'search_term')
  assert.equal(parsed.ok, false)
  assert.ok(parsed.errors[0].includes('曝光量'), parsed.errors[0])
  assert.equal(parsed.rows.length, 0)
})

test('解析：主体列为空的行被跳过，并在 warnings 里点名行号', () => {
  const text = [
    '客户搜索词\t曝光量\t点击量\t花费\t销售额\t订单',
    '\t100\t10\t5\t0\t0',
    'ok\t100\t10\t5\t50\t2',
  ].join('\n')
  const parsed = parseAdReportCsv(text, 'search_term')
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].keyword, 'ok')
  assert.ok(parsed.warnings.some((line) => line.includes('第 2 行')), parsed.warnings.join('；'))
})

test('规则（搜索词）：0 单且点击达门槛 → 精准否定；有单且 ACOS 达标 → 加精准', () => {
  const parsed = parseAdReportCsv(CN_SEARCH_TERM, 'search_term')
  const result = analyseAdReport(parsed.rows, 'search_term', DEFAULT_RULES)
  const byEntity = new Map(result.actions.map((action) => [action.entity, action.code]))
  assert.equal(byEntity.get('welding gloves'), 'negative_exact')
  assert.equal(byEntity.get('tig gloves'), 'add_exact')
  // 3 个点击、$1.2：样本不足，**不产生建议**（不拿噪音当结论，避免清单变噪音）
  assert.equal(byEntity.get('mig gloves'), undefined)
  // 0 单花费占比：24 / (24+14.5+1.2)
  assert.ok(Math.abs((result.kpi.wastedSpendShare ?? 0) - 25.2 / 39.7) < 1e-9)
})

test('规则：成长期放宽点击门槛 —— 同一行在成熟期是否词、成长期只是观察', () => {
  const rows = parseAdReportCsv('客户搜索词\t曝光量\t点击量\t花费\t销售额\t订单\nmid\t100\t15\t$9\t0\t0', 'search_term').rows
  const mature = analyseAdReport(rows, 'search_term', { ...DEFAULT_RULES, stage: 'mature', minClicks: 12 })
  const growth = analyseAdReport(rows, 'search_term', { ...DEFAULT_RULES, stage: 'growth', minClicks: 12 })
  assert.equal(mature.actions[0].code, 'negative_exact')
  assert.equal(growth.actions[0].code, 'watch')
})

test('规则（投放）：0 单高点击 → 暂停；ACOS 达标 → 提价；ACOS 超线 → 降价', () => {
  const text = [
    '投放\t匹配类型\t广告活动名称\t曝光量\t点击量\t花费\t销售额\t订单',
    'dead\t广泛\tSP-A\t9000\t40\t$30\t0\t0',
    'star\t精准\tSP-A\t4000\t30\t$12\t$90\t3',
    'costly\t精准\tSP-A\t6000\t30\t$40\t$80\t2',
  ].join('\n')
  const parsed = parseAdReportCsv(text, 'targeting')
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  const result = analyseAdReport(parsed.rows, 'targeting', DEFAULT_RULES)
  const byEntity = new Map(result.actions.map((action) => [action.entity, action.code]))
  assert.equal(byEntity.get('dead'), 'pause')
  assert.equal(byEntity.get('star'), 'raise_bid')
  assert.equal(byEntity.get('costly'), 'lower_bid')
})

test('规则（活动）：预算打满且 ACOS 达标 → 加预算；低使用率 0 单 → 降预算', () => {
  const text = [
    '广告活动名称\t预算\t曝光量\t点击量\t花费\t销售额\t订单',
    'SP-star\t$50\t20000\t200\t$48\t$300\t10',
    'SP-idle\t$100\t900\t9\t$20\t$0\t0',
  ].join('\n')
  const parsed = parseAdReportCsv(text, 'campaign')
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.rows[0].budget, 50)
  const result = analyseAdReport(parsed.rows, 'campaign', DEFAULT_RULES)
  const byEntity = new Map(result.actions.map((action) => [action.entity, action.code]))
  assert.equal(byEntity.get('SP-star'), 'add_budget')
  assert.equal(byEntity.get('SP-idle'), 'reduce_budget')
})

test('导出：活动报表少一列主体列，理由里的逗号与引号被正确转义', () => {
  const actions = [
    { entity: 'SP-A', campaign: null, code: 'add_budget', priority: 2, reason: '预算打满, ACOS "达标"', evidence: 'derived' },
  ]
  const csv = actionsToCsv(actions, 'campaign')
  const lines = csv.trim().split('\n')
  assert.equal(lines[0], '广告活动,建议动作,优先级,理由')
  assert.ok(lines[1].includes(AD_ACTION_LABELS.add_budget))
  assert.ok(lines[1].includes('"预算打满, ACOS ""达标"""'), lines[1])

  const targeting = actionsToCsv(actions, 'targeting').trim().split('\n')
  // 表头按报表类型写具体主体名（P2 起不再是笼统的「主体」）
  assert.equal(targeting[0], '投放,广告活动,建议动作,优先级,理由')
})

/* ── P2：广告位 / 预算 / 搜索词份额 ─────────────────────────────────────── */

test('P2 广告位：按活动 × 广告位解析，ACOS 达标加价、超线降价、0 单收量', () => {
  const text = [
    '广告位\t广告活动名称\t曝光量\t点击量\t花费\t销售额\t订单',
    '搜索结果顶部\tSP-A\t5000\t60\t$48\t$200\t5',
    '商品页面\tSP-A\t7000\t40\t$30\t$40\t1',
    '搜索结果的其余位置\tSP-A\t9000\t35\t$21\t$0\t0',
  ].join('\n')
  const parsed = parseAdReportCsv(text, 'placement')
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.rows[0].placement, '搜索结果顶部')
  assert.equal(parsed.rows[0].campaign, 'SP-A')

  const result = analyseAdReport(parsed.rows, 'placement', DEFAULT_RULES)
  const byPlacement = new Map(result.actions.map((action) => [action.entity, action.code]))
  assert.equal(byPlacement.get('搜索结果顶部'), 'raise_bid')
  assert.equal(byPlacement.get('商品页面'), 'lower_bid') // ACOS 75% 超容忍线
  assert.equal(byPlacement.get('搜索结果的其余位置'), 'lower_bid') // 0 单但点击 35 达样本
})

test('P2 广告位：点击未达样本时不给结论（不拿 5 个点击调加价）', () => {
  const rows = parseAdReportCsv('广告位\t广告活动名称\t曝光量\t点击量\t花费\t销售额\t订单\n商品页面\tSP-A\t100\t5\t$3\t$0\t0', 'placement').rows
  const result = analyseAdReport(rows, 'placement', DEFAULT_RULES)
  assert.equal(result.actions.length, 0)
  assert.equal(result.rows[0].quadrant, '样本不足')
})

test('P2 预算：打满且达标加预算；低使用率无单降预算；低使用率有单只观察', () => {
  const text = [
    '广告活动名称\t预算\t花费\t曝光量\t点击量\t销售额\t订单',
    'SP-star\t$50\t$48\t20000\t200\t$300\t10',
    'SP-idle\t$100\t$20\t900\t9\t$0\t0',
    'SP-quiet\t$100\t$20\t3000\t40\t$150\t4',
  ].join('\n')
  const parsed = parseAdReportCsv(text, 'budget')
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  const result = analyseAdReport(parsed.rows, 'budget', DEFAULT_RULES)
  const byCampaign = new Map(result.actions.map((action) => [action.entity, action.code]))
  assert.equal(byCampaign.get('SP-star'), 'add_budget')
  assert.equal(byCampaign.get('SP-idle'), 'reduce_budget')
  assert.equal(byCampaign.get('SP-quiet'), 'watch')
})

test('P2 份额：百分比解析成 0–1，低份额高效给提价、高份额低效给降价', () => {
  const text = [
    '客户搜索词\t曝光份额\t曝光量\t点击量\t花费\t销售额\t订单',
    'tig torch cup\t6.5%\t3000\t45\t$30\t$120\t3',
    'welding gloves\t48%\t9000\t120\t$140\t$200\t3',
  ].join('\n')
  const parsed = parseAdReportCsv(text, 'impression_share')
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.ok(Math.abs((parsed.rows[0].share ?? 0) - 0.065) < 1e-9)

  const result = analyseAdReport(parsed.rows, 'impression_share', DEFAULT_RULES)
  const byKeyword = new Map(result.actions.map((action) => [action.entity, action.code]))
  assert.equal(byKeyword.get('tig torch cup'), 'raise_bid') // 低份额 + ACOS 25% 达标
  assert.equal(byKeyword.get('welding gloves'), 'lower_bid') // 高份额 + ACOS 70% 超线
})

test('P2 份额：缺「曝光份额」列时拒绝导入（份额报表没有份额就没有意义）', () => {
  const parsed = parseAdReportCsv('客户搜索词\t曝光量\t点击量\t花费\t销售额\t订单\nfoo\t100\t10\t5\t50\t2', 'impression_share')
  assert.equal(parsed.ok, false)
  assert.ok(parsed.errors[0].includes('曝光份额'), parsed.errors[0])
})

test('P2 导出：份额报表表头写「搜索词」而不是笼统的「主体」', () => {
  const actions = [{ entity: 'tig torch cup', campaign: null, code: 'raise_bid', priority: 2, reason: '低份额高效', evidence: 'derived' }]
  const header = actionsToCsv(actions, 'impression_share').trim().split('\n')[0]
  assert.equal(header, '搜索词,广告活动,建议动作,优先级,理由')
  assert.equal(actionsToCsv(actions, 'placement').trim().split('\n')[0], '广告位,广告活动,建议动作,优先级,理由')
})
