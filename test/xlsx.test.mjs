/**
 * v1.20：Excel 导入（`.xlsx` 解包 → TSV → 与粘贴共用同一套列校验）。
 *
 * 这组断言盯的是三件容易出错的事：
 * 1. 共享字符串与数字都能读出来（Amazon 导出里关键词是字符串、指标是数字）；
 * 2. **空单元格不导致整行错位**（`<c r="D3">` 跳列时必须按列号补空）；
 * 3. 旧版 `.xls`（复合文档）**不许被当文本硬读** —— 那正是用户截图里
 *    "第 657 行 clicks 不是有效数字"的成因，必须换成可操作的提示。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readXlsx, sheetToTsv, sniffKind } from '../lib/lib/xlsx.js'
import { parseTrafficCsv } from '../lib/shared/amazonTrafficTools.js'
import { buildFakeCfb, buildXls, buildXlsx } from './_xlsxFixture.mjs'

const HEADER = ['用户搜索词', '曝光', '点击', '广告订单', '广告花费', '广告销售额']

test('xlsx：共享字符串 / 数字 / 跳列空单元格都能正确读出', () => {
  const buffer = buildXlsx([
    ['广告搜索词报告'],
    ['2026-10-11 至 2026-10-17'],
    HEADER,
    ['tig torch cup', 1200, 18, 2, 9.5, 45],
    ['mig gloves', 300, '', 0, '', 0],
  ])
  assert.equal(sniffKind(buffer), 'zip')
  const parsed = readXlsx(buffer)
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.sheets.length, 1)
  const grid = parsed.sheets[0].grid
  assert.equal(grid[2][0], '用户搜索词')
  assert.equal(grid[3][0], 'tig torch cup')
  assert.equal(grid[3][1], '1200')
  assert.equal(grid[4][2], '', '空单元格必须留空串，不能把后面的列挤到前面')

  const tsv = sheetToTsv(parsed.sheets[0])
  const traffic = parseTrafficCsv(tsv)
  assert.equal(traffic.ok, true, traffic.errors.join('；'))
  assert.equal(traffic.headerRow, 3)
  assert.equal(traffic.rows.length, 2)
  assert.equal(traffic.rows[0].spend, 9.5)
  assert.equal(traffic.rows[1].impressions, 300)
})

test('xlsx：缺列时仍然报 needs_data（不因为来自 Excel 就放行）', () => {
  const buffer = buildXlsx([['关键词', '曝光'], ['foo', 10]])
  const parsed = readXlsx(buffer)
  assert.equal(parsed.ok, true)
  const traffic = parseTrafficCsv(sheetToTsv(parsed.sheets[0]))
  assert.equal(traffic.ok, false)
  assert.match(traffic.errors[0], /缺少列/)
})

test('损坏的 CFB/Excel 容器被拒绝且不尝试文本解析', () => {
  const buffer = buildFakeCfb()
  assert.equal(sniffKind(buffer), 'cfb')
  const parsed = readXlsx(buffer)
  assert.equal(parsed.ok, false)
  assert.match(parsed.errors[0], /Excel 解析失败/)
})

test('legacy BIFF .xls：真实文件字节可读，表头与数据不丢列', () => {
  const buffer = buildXls([
    ['广告搜索词报告'],
    ['用户搜索词', '曝光', '点击', '广告订单', '广告花费', '广告销售额'],
    ['tig torch cup', 1200, 18, 2, 9.5, 45],
  ])
  assert.equal(sniffKind(buffer), 'cfb', 'BIFF8 xls 使用 OLE compound file 魔数')
  const parsed = readXlsx(buffer)
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.sheets[0].name, 'Search Terms')
  const traffic = parseTrafficCsv(sheetToTsv(parsed.sheets[0]))
  assert.equal(traffic.ok, true, traffic.errors.join('；'))
  assert.equal(traffic.rows[0].keyword, 'tig torch cup')
  assert.equal(traffic.rows[0].orders, 2)
  assert.equal(traffic.rows[0].sales, 45)
})

test('非 Excel 的二进制不会被当成表格', () => {
  const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x00])
  assert.equal(sniffKind(junk), 'unknown')
  assert.equal(readXlsx(junk).ok, false)
})
