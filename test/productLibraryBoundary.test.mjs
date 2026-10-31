/**
 * P3 边界：产品库**只读产品事实**，选品保留评估。
 *
 * 这一层最容易被"顺手"破坏：有人想在看板上加一列结论，于是产品库开始显示 verdict。
 * 一旦两页都显示结论，又回到"同一个商品两处说法"的老问题。
 *
 * 判据放在**投影层**（`useProductLibrary` 的 `ProductFact`）而不是渲染层：
 * 字段不在投影里，渲染就漏不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments } from './_clientSources.mjs'

const VIEW = 'src/client/views/ProductLibraryView.tsx'
const HOOK = 'src/client/hooks/useProductLibrary.ts'
const ASIN_VIEW = 'src/client/views/AsinView.tsx'
const HEADER = 'src/client/app/WorkbenchHeader.tsx'
const BODY = 'src/client/app/WorkbenchBody.tsx'

test('产品库投影里没有评估字段', () => {
  const hook = stripComments(read(HOOK))
  assert.doesNotMatch(hook, /verdict/, '投影层不许出现 verdict')
  assert.doesNotMatch(hook, /score/, '投影层不许出现 score')
  assert.doesNotMatch(hook, /judgment/i, '投影层不许带 judgment')
  assert.doesNotMatch(hook, /voc|painPoint/i, '投影层不许带 VOC 痛点')
  assert.doesNotMatch(hook, /nextAction/, '投影层不许带下一步')
})

test('产品库视图不渲染评估字段', () => {
  const view = stripComments(read(VIEW))
  for (const banned of ['verdict', 'ASIN_VERDICT_LABELS', 'nextAction', 'score', 'VOC']) {
    assert.equal(view.includes(banned), false, `产品库视图出现了 ${banned}`)
  }
  assert.match(view, /站点/, '必须能按站点看')
  assert.match(view, /待补/, '站点未知要显示「待补」，不许当成 US')
})

test('产品库走 hook 取数，视图不发 HTTP', () => {
  const view = stripComments(read(VIEW))
  assert.doesNotMatch(view, /\bapi\s*[<(]/, '视图不许直接调 api()')
  assert.doesNotMatch(view, /\bfetch\s*\(/, '视图不许直接 fetch()')
  assert.match(view, /useProductLibrary/, '必须走 useProductLibrary')
})

test('导航与装配：产品库是独立入口，选品页只给跳转', () => {
  assert.match(read(HEADER), /key:\s*'products'/, '导航必须有产品库入口')
  assert.match(read(HEADER), /label:\s*'产品库'/, '导航文案要是「产品库」')
  assert.match(read(BODY), /view === 'products' && \(/, '主区分派要渲染产品库')
  assert.match(read(BODY), /<ProductLibraryView[\s\S]*?table=\{props\.univerTable\}/, '产品库必须拿到表格能力域（统一出口）')
  const asin = stripComments(read(ASIN_VIEW))
  assert.match(asin, /onOpenProducts/, '选品页要有跳到产品库的入口')
  assert.match(asin, /onOpenProducts\(product\.asin, product\.site\)/, '跳转必须带上 site + asin（落点不能是空列表）')
  assert.doesNotMatch(asin, /import \{ ProductLibraryView \}/, '选品页不许内嵌产品库（两份详情必然漂移）')
})

test('B3：落地意图 site 与 q 成对传递，装配层不许把 site 丢掉', () => {
  const body = stripComments(read(BODY))
  // 装配层必须把 site 一起放进意图；只传 asin 就是 FDE 抓到的那个缺陷
  assert.match(body, /setProductFocus\(\{ q: asin, site: site \?\? '' \}\)/, 'onOpenProducts 必须同时写 q 与 site')
  assert.doesNotMatch(body, /setProductFocus\(asin\)/, '不许只传 asin')
  // 落地层必须用 site 初始化筛选，否则同 ASIN 多站点会搜出两行
  const hook = stripComments(read(HOOK))
  assert.match(hook, /site: focus\?\.site \?\? ''/, '落地时必须初始化 site 筛选')
  assert.match(hook, /q: focus\?\.q \?\? ''/, '落地时初始化 q')
})
