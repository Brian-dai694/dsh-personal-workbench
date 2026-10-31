/**
 * Univer 预览/能力提示的统一（2026-10-30）。
 *
 * 背景：报表、库存、付款对账各自复制了一份预览卡与能力提示（约 20 行 × 4）。
 * 复制品的代价不是"代码难看"，而是**改文案要改四处、漏一处就两页说法不同**
 * —— 草稿语义（提交待审阅 → 合并）尤其不能各说一套。
 *
 * 所以这里钉两件事：
 * 1. `views/` 里不再出现 `table.viewer.phase`（渲染细节只在 `UniverPreviewCard` 里）；
 * 2. 四个页面都引用同一对组件，不允许多写一份"差不多"的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments } from './_clientSources.mjs'

const PAGES = {
  report: 'src/client/views/AmazonReportView.tsx',
  inventory: 'src/client/views/InventoryView.tsx',
  payment: 'src/client/views/PaymentReconcileView.tsx',
  products: 'src/client/views/ProductLibraryView.tsx',
  keywords: 'src/client/views/AmazonKeywordView.tsx',
}

test('预览卡与能力提示只有一份实现', () => {
  for (const [name, path] of Object.entries(PAGES)) {
    const code = stripComments(read(path))
    assert.doesNotMatch(code, /table\.viewer\.phase/, `${name} 仍在直接读 viewer 状态 —— 应改用 UniverPreviewCard`)
    assert.match(code, /UniverPreviewCard/, `${name} 必须引用共用预览卡`)
    assert.match(code, /UniverCapabilityHint/, `${name} 必须引用共用能力提示`)
  }
})

test('草稿语义只在共用组件里出现（防止各页各写一句）', () => {
  const card = read('src/client/components/UniverPreviewCard.tsx')
  assert.match(card, /提交待审阅/, '共用预览卡必须说明"提交待审阅 → 合并"两步')
  for (const [name, path] of Object.entries(PAGES)) {
    /** 剥注释再判：注释里提一句"为什么抽出来"不算重复文案。 */
    assert.doesNotMatch(stripComments(read(path)), /提交待审阅/, `${name} 自己写了一份草稿说明 —— 文案会分叉`)
  }
})

test('产品库导出的是"当前筛选结果"，并走统一预览出口', () => {
  const view = stripComments(read(PAGES.products))
  assert.match(view, /actions\.fetchAll\(\)/, '导出必须取全部筛选结果')
  assert.match(view, /table\.actions\.openTable\(/, '产品库必须走 table-preview 统一出口')
  assert.doesNotMatch(view, /openCsv\(/, '不许再走 import-csv（那是另一条表格生成链路）')
})

test('关键词分析导出只读当前已保存方案快照并使用统一 Viewer', () => {
  const view = stripComments(read(PAGES.keywords))
  assert.match(view, /current\.rows\.map\(/, '快照必须来自当前已保存方案')
  assert.match(view, /table\.actions\.openTable\(/, '必须走统一 table-preview 出口')
  assert.match(view, /table\.available !== true \|\| table\.busy/, 'Univer 不可用或忙时禁用入口')
  assert.match(view, /UniverCapabilityHint/, '保留原生页面并提示能力降级')
  assert.match(view, /UniverPreviewCard/, 'Viewer 使用统一预览卡')
})
