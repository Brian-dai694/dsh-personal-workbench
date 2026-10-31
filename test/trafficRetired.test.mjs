/**
 * 「流量分析」页签已被合并（2026-10-29）。
 *
 * ## 钉什么
 *
 * 搜索词结论只允许一个入口：报表分析的搜索词分支（它内嵌
 * `AmazonTrafficDetailPane`）。所以：
 * 1. 导航里**不许再出现** `traffic` 入口 —— 否则半年后有人以为它还能用；
 * 2. 类型里**保留** `'traffic'` —— 旧会话存着的 view 值不该让界面崩；
 * 3. 旧值落进来时有明确去处（提示 + 按钮），不是空白页。
 *
 * 这三条一起才成立：只删导航不保留类型，会让旧状态崩；只保留类型不给去处，
 * 会让人以为页面坏了。判据是源码扫描，因为这里没有可渲染的宿主。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { read, stripComments } from './_clientSources.mjs'

const HEADER = 'src/client/app/WorkbenchHeader.tsx'
const BODY = 'src/client/app/WorkbenchBody.tsx'
const CONTRACTS = 'src/client/app/contracts.ts'

test('导航里不再有「流量分析」入口', () => {
  const header = stripComments(read(HEADER))
  assert.doesNotMatch(header, /key:\s*'traffic'/, '导航项里仍登记了 traffic —— 它已经被合并进报表分析')
  assert.doesNotMatch(header, /label:\s*'流量分析'/, '导航文案里仍有「流量分析」')
  // 同一组里必须有报表分析，否则用户被"合并"到了一个不存在的地方
  assert.match(header, /key:\s*'reports'/, '报表分析必须仍在导航里（这是新的唯一入口）')
  for (const key of ['amazon', 'keywords', 'reports', 'asin', 'inventory', 'payments', 'oplog']) {
    assert.match(header, new RegExp(`key:\\s*'${key}'`), `${key} 版块必须保留`)
  }
})

test('旧的 traffic 导航记忆迁移到报表分析，不隐藏整个亚马逊子导航', () => {
  const header = stripComments(read(HEADER))
  assert.match(header, /if \(saved === 'traffic'\) return 'reports'/)
  assert.match(header, /\{inAds && \(/, '亚马逊各子版块仍应显示')
})

test("类型里保留 'traffic'（旧会话状态不许崩）", () => {
  assert.match(read(CONTRACTS), /'traffic'/, 'WorkbenchView 应保留 traffic 值：删掉会让旧会话的 view 值变成非法状态')
})

test('旧左栏视图文件已删除（不是"留着不用"）', () => {
  assert.equal(
    existsSync(new URL('../src/client/views/AmazonTrafficView.tsx', import.meta.url)),
    false,
    'AmazonTrafficView.tsx 应已删除：留着会让下一个人以为它还能用',
  )
})

test('旧值落进来时有明确去处，不是空白页', () => {
  const body = stripComments(read(BODY))
  assert.match(body, /已并入「报表分析 · 搜索词」/, '旧 traffic 视图要说明已合并，而不是渲染空壳')
  assert.match(body, /setView\('reports'\)/, '旧值要给一个直达报表分析的按钮')
  // 左栏视图与右栏详情都不许再渲染：否则会多出"没有左栏的右栏"
  assert.doesNotMatch(body, /<AmazonTrafficView/, 'WorkbenchBody 不许再渲染 AmazonTrafficView')
  assert.doesNotMatch(body, /<AmazonTrafficDetailPane/, '右栏 pane 只允许出现在报表页内嵌处')
})
