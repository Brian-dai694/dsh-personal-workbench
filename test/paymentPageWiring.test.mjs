/**
 * 付款对账页的接线（2026-10-29 第 3 项）。
 *
 * 这一页原来只有两个 textarea：能贴、不能读文件，也没有"多工作表"的概念。
 * 现在它有了三条新契约，任一被改回去都会静默丢功能：
 *
 * 1. 文件解析走 hook（视图不发 HTTP），`.xlsx` 才有可能；
 * 2. `sheetCount > 1` 必须**点名导入了哪一张** —— 付款报表最容易多 sheet，
 *    静默取第一张会让人拿错数据去对账（比报错更难查）；
 * 3. 超限文案与后端同一句（约 7.5MB），不许出现第二套数字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments } from './_clientSources.mjs'

const VIEW = 'src/client/views/PaymentReconcileView.tsx'
const HOOK = 'src/client/hooks/usePaymentReconcile.ts'
const BODY = 'src/client/app/WorkbenchBody.tsx'

test('付款对账：文件读取在 hook 里，视图不发请求', () => {
  const code = stripComments(read(VIEW))
  assert.doesNotMatch(code, /\bapi\s*[<(]/, '视图不许直接调 api()')
  assert.doesNotMatch(code, /\bfetch\s*\(/, '视图不许直接 fetch()')
  assert.match(code, /usePaymentReconcile/, '文件解析必须来自 usePaymentReconcile')
  assert.match(stripComments(read(HOOK)), /parseUploadFile/, 'hook 里走共享的解析实现，不另写一套')
})

test('付款对账：多工作表必须点名导入了哪一张', () => {
  const code = read(VIEW)
  assert.match(code, /sheetCount/, '必须读 sheetCount，否则无法判断多表')
  assert.match(code, /只导入了/, '必须明确告诉用户只导入了第一张')
  assert.match(code, /sheetName/, '提示里要带出被导入的表名，不能只说"N 张表"')
})

test('付款对账：超限文案与后端同一句（约 7.5MB）', () => {
  const code = read(VIEW)
  assert.match(code, /7\.5MB/, '文案要写约 7.5MB')
  assert.doesNotMatch(code, /12MB/, '不许残留旧的 12MB 口径（那是请求体上限，不是源文件上限）')
})

test('付款对账：差异结论走统一预览出口，且表格能力从装配层下发', () => {
  const code = read(VIEW)
  assert.match(code, /table\.actions\.openTable\(/, '必须走 table-preview（结构化行）统一出口')
  assert.doesNotMatch(stripComments(code), /openCsv\(/, '不许再走 import-csv（另一条表格生成链路）')
  assert.match(stripComments(read(BODY)), /<PaymentReconcileView table=\{props\.univerTable\} \/>/,
    'WorkbenchBody 必须把表格能力域交给付款对账页')
})
