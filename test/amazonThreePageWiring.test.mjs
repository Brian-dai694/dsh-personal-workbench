/**
 * T3：工作台广告三页联动 —— **单一数据源**的接线不变量（源码级扫描）。
 *
 * 这三页（流量分析 / 关键词 / 报表分析）曾经各有一套数据来源：
 * 关键词页自己拉 datasets 的 list + detail，报表页自己也有一份 current + loadLatest。
 * 结果同一时间页面上能出现两份"当前报表"，用户无法核对哪份是真的。
 *
 * 本文件只钉三件事，不多钉：
 * 1. 三个视图里没有 `api(`（D17 结构硬门：视图不发 HTTP）；
 * 2. 三页读的是**同一个** `amazonData`（props 链一路传下去，不各拉一份）；
 * 3. `AmazonReportView` 的必填 props 全仓只有 `WorkbenchBody` 一处装配。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, readClientSources, stripComments } from './_clientSources.mjs'

const KEYWORD_VIEW = 'src/client/views/AmazonKeywordView.tsx'
const ABA_PANEL = 'src/client/views/AmazonAbaKeywordPanel.tsx'
const REPORT_VIEW = 'src/client/views/AmazonReportView.tsx'
const BODY = 'src/client/app/WorkbenchBody.tsx'
const ASSEMBLY = 'src/client/app/assembly.ts'

test('T3：三个视图都不发 HTTP（请求只在 hook 里）', () => {
  for (const path of [KEYWORD_VIEW, ABA_PANEL, REPORT_VIEW]) {
    const code = stripComments(read(path))
    assert.doesNotMatch(code, /\bapi\s*[<(]/, `${path} 仍出现 api( —— 视图只拿结果与意图，请求归 hook（D17）`)
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${path} 仍出现 fetch( —— 同上`)
  }
  // 关键页的两次 datasets 请求确实搬走了：面板里不再出现数据集路由
  assert.doesNotMatch(stripComments(read(ABA_PANEL)), /amazon\/datasets/, 'ABA 面板不许再自己读数据集列表/详情')
  // 报表页的三条请求（列表 / 详情 / 导入）都在 hook 里
  assert.match(read('src/client/hooks/useAdReportDatasets.ts'), /\/api\/workbench\/amazon\/datasets/)
  assert.match(read('src/client/hooks/useAbaKeywordSets.ts'), /\/api\/workbench\/aba-keywords/)
})

test('T3：三页读的是同一个 amazonData（props 链不各拉一份）', () => {
  const assembly = read(ASSEMBLY)
  const body = read(BODY)

  // 唯一所有者：装配层只声明一次 amazonData
  assert.match(assembly, /amazonData: ReturnType<typeof useAmazonDatasets>/, '装配层必须有 amazonData（唯一所有者）')

  // 流量分析：本来就吃这份模型
  assert.match(body, /view === 'traffic' && <AmazonTrafficView model=\{props\.amazonData\} \/>/,
    '流量分析必须继续读 props.amazonData')

  // 关键词页：把同一份 amazonData 往下交给 ABA 面板
  assert.match(body, /<AmazonKeywordView model=\{props\.keywordPlans\} amazon=\{props\.amazonData\} aba=\{props\.abaKeywordSets\}/,
    '关键词页必须拿到同一个 amazonData')
  assert.match(read(KEYWORD_VIEW), /<AmazonAbaKeywordPanel onSendToAI=\{onSendToAI\} model=\{amazon\} aba=\{aba\} \/>/,
    'ABA 面板必须用页面传下来的 model，而不是自己再拉一份')
  assert.match(read(ABA_PANEL), /model: UseAmazonDatasetsResult/, '面板的 model 就是共享模型的类型')

  // 报表分析：搜索词一路同源；其余类型走独立 hook（类型上已排除 search_term）
  assert.match(body, /<AmazonReportView amazon=\{props\.amazonData\} reports=\{props\.adReportData\} \/>/,
    '报表页的搜索词一路必须读同一个 amazonData')
  assert.match(read(REPORT_VIEW), /kind === 'search_term' \? \(amazon\.current\?\.rows \?\? \[\]\)/,
    'search_term 的 row 来源必须是共享 current')
  assert.match(read('src/client/hooks/useAdReportDatasets.ts'),
    /export type LocalAdReportKind = Exclude<AdReportKind, 'search_term'>/,
    '本地报表 hook 收不到 search_term，结构上就不可能覆盖共享 current')
})

test('T3：AmazonReportView 的必填 props 只有 WorkbenchBody 一处装配', () => {
  const hits = readClientSources()
    .filter((file) => stripComments(file.text).includes('<AmazonReportView'))
    .map((file) => file.rel)
  assert.deepEqual(hits, [BODY], `AmazonReportView 只允许在 WorkbenchBody 装配，实际：${hits.join('、') || '无'}`)

  const report = read(REPORT_VIEW)
  // 两个 props 都是必填（可选会让"忘了传"静默变成空数据）
  assert.match(report, /\bamazon: UseAmazonDatasetsResult/, 'amazon 必填')
  assert.match(report, /\breports: UseAdReportDatasetsResult/, 'reports 必填')
})
