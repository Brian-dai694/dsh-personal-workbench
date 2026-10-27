import assert from 'node:assert/strict'
import test from 'node:test'
import { buildKeywordPlan, keywordPlanCsv } from '../lib/shared/amazonKeywordTools.js'
import { analyseTraffic, parseTrafficCsv } from '../lib/shared/amazonTrafficTools.js'

// Keep the pure client regressions here; host tools are validated through build/wiring.
test('builds deduplicated keyword tiers and CSV safely', () => {
  const rows = buildKeywordPlan('TIG gloves tig', 'heat resistant, leather', ['exact', 'phrase'])
  assert.equal(rows.length, 8)
  assert.equal(rows[0].keyword, 'tig gloves')
  assert.match(keywordPlanCsv(rows), /keyword,match,campaign,rationale/)
})

test('parses quoted traffic CSV and diagnoses high clicks without orders', () => {
  const parsed = parseTrafficCsv('keyword,impressions,clicks,orders,spend,sales\n"foo, gloves",1000,10,0,8,0\nbar,100,2,1,1,20')
  assert.equal(parsed.ok, true)
  const metrics = analyseTraffic(parsed.rows)
  assert.equal(metrics[0].keyword, 'foo, gloves')
  assert.equal(metrics[0].ctr, 0.01)
  assert.equal(metrics[0].diagnosis.startsWith('高点击无订单'), true)
  assert.equal(metrics[1].roas, 20)
})

test('rejects missing and malformed values instead of converting them to zero', () => {
  const missing = parseTrafficCsv('keyword,impressions\nfoo,100')
  assert.equal(missing.ok, false)
  assert.match(missing.errors[0], /缺少列/)
  const malformed = parseTrafficCsv('keyword,impressions,clicks,orders,spend,sales\nfoo,100,nope,1,1,20')
  assert.equal(malformed.ok, false)
  assert.match(malformed.errors[0], /不是有效/)
})

test('accepts common Chinese Amazon headers and reporting metadata', () => {
  const parsed = parseTrafficCsv('Reporting Range=2026-10-01~2026-10-07\n用户搜索词,曝光,点击,广告订单,广告花费,广告销售额\nfoo,100,2,1,1,20')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.period, '2026-10-01~2026-10-07')
  assert.equal(parsed.rows[0].sales, 20)
})

/**
 * 2026-10-22 用户真实报表回归：从 Excel 粘贴得到的是 **TSV**，且前面还带两行标题，
 * 旧实现按首行猜分隔符（标题行没有分隔符 → 退回逗号）把整份读成一列，然后报"数字非法"。
 */
test('自动定位表头并识别 TSV（Excel 粘贴形态）', () => {
  const tsv = '广告搜索词报告\n2026-10-11 至 2026-10-17\n用户搜索词\t曝光\t点击\t广告订单\t广告花费\t广告销售额\ntig torch cup\t1200\t18\t2\t9.5\t45\nmig gloves\t300\t0\t0\t0\t0'
  const parsed = parseTrafficCsv(tsv)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.delimiter, '\t')
  assert.equal(parsed.headerRow, 3)
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rows[0].sales, 45)
})

test('同名列按打分取对：广告订单 而不是 间接订单', () => {
  const parsed = parseTrafficCsv('用户搜索词,曝光,点击,间接订单,广告订单,广告花费,广告销售额,间接销售额\nfoo,100,5,9,1,2,20,90')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.rows[0].orders, 1)
  assert.equal(parsed.rows[0].sales, 20)
})

test('引号未闭合不再整份拒绝：按容错模式解析并给出 warning', () => {
  const parsed = parseTrafficCsv('keyword,impressions,clicks,orders,spend,sales\n"foo gloves,1000,20,1,8,30')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.rows[0].keyword, 'foo gloves')
  assert.equal(parsed.rows[0].spend, 8)
  assert.equal(parsed.warnings.some((line) => line.includes('引号未闭合')), true)
})

test('表头认不出来就明确报缺列，不硬把首行当表头', () => {
  const parsed = parseTrafficCsv('1,2,3,4,5,6\n7,8,9,10,11,12')
  assert.equal(parsed.ok, false)
  assert.match(parsed.errors[0], /缺少列/)
})

/**
 * 2026-10-22 真实事故：700+ 行报表里第 657/695 行有几个 `N/A` 单元格，
 * 旧实现整份 `ok:false`，用户看着满屏正确数据却导不进来。
 * 新口径：坏行跳过并逐条点名（绝不当 0 计入统计），合计/汇总行直接忽略。
 */
test('个别坏行只跳过并报数，不再整份拒绝', () => {
  const header = 'keyword,impressions,clicks,orders,spend,sales'
  const good = Array.from({ length: 10 }, (_, index) => `kw${index},100,5,1,1,20`)
  const bad = 'broken-row,100,N/A,1,1,20'
  const total = '总计,1000,50,10,10,200'
  const parsed = parseTrafficCsv([header, ...good, bad, total].join('\n'))
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.rows.length, 10, '坏行与合计行都不进统计')
  const text = parsed.warnings.join('；')
  assert.match(text, /跳过 1 行/)
  assert.match(text, /第 12 行 clicks 不是有效的非负数字/, '必须点名是哪一行哪一列')
  assert.match(text, /忽略 1 行合计/)
})

test('全部行都坏时仍然失败（错的是文件格式，不是个别单元格）', () => {
  const parsed = parseTrafficCsv('keyword,impressions,clicks,orders,spend,sales\nbroken,100,N/A,1,1,20')
  assert.equal(parsed.ok, false)
  assert.match(parsed.errors[0], /没有可用数据行/)
})
