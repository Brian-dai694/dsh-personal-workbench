/**
 * P2 前端合同（`site + ASIN`）：这些断言钉的是"身份参数不能漏"。
 *
 * 为什么用源码扫描而不是渲染测试：`AsinView` 750+ 行、依赖宿主，node 里渲染不了。
 * 而这次的风险点恰好都能在源码上判定 —— 某个写操作**漏了 site**，界面上看不出来，
 * 只会在服务端变成 400/409，用户拿到一句他看不懂的话。
 *
 * 运行时那半（`ApiError` 真的带 status/code）用临时编译产物另测，见交付说明里的命令。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments } from './_clientSources.mjs'

const API = 'src/client/api.ts'
const VIEW = 'src/client/views/AsinView.tsx'
const LIBRARY = 'src/client/hooks/useAsinLibrary.ts'
const DRAFT = 'src/client/asinManualDraft.ts'

test('api() 抛 ApiError 且保留给界面判断用的 status/code', () => {
  const code = stripComments(read(API))
  assert.match(code, /export class ApiError extends Error/, '必须有 ApiError 类型')
  assert.match(code, /readonly status: number/, 'status 必须保留（409 要能分支）')
  assert.match(code, /readonly code: string \| null/, 'code 必须保留（identity_required 等）')
  assert.match(code, /throw new ApiError\(/, '非 2xx 必须抛 ApiError 而不是裸 Error')
})

test('写操作逐个带 site（watch / judgment / 立项）', () => {
  const code = stripComments(read(VIEW))
  assert.match(code, /\/watch\?site=\$\{encodeURIComponent\(identity\.site\)\}/, 'watch 必须带 site')
  assert.match(code, /\/judgment\?site=\$\{encodeURIComponent\(identity\.site\)\}/, 'judgment 必须带 site')
  assert.match(code, /\/task\?site=\$\{encodeURIComponent\(taskDraft\.site\)\}/, '立项必须带 site')
  assert.match(code, /const identityOf = useCallback/, '写操作前要有身份守卫（站点未定不发请求）')
})

test('批量与导出用 {site,asin}，且站点未定时拒绝而不是跳过', () => {
  const code = stripComments(read(VIEW))
  assert.match(code, /items, action, tag: batchTag/, '批量 body 必须是 items[{site,asin}]')
  assert.doesNotMatch(code, /asins: \[\.\.\.picked\]/, '批量不许再发裸 asin 数组')
  assert.match(code, /JSON\.stringify\(items\)/, '导出选中必须发对象数组')
  assert.match(code, /站点未定/, '站点未定要明确拦住并说明，不能静默跳过')
})

test('列表支持 site 筛选（facets 也读 sites）', () => {
  const code = stripComments(read(VIEW))
  assert.match(code, /params\.set\('site', site\)/, '列表查询必须带 site')
  assert.match(code, /sites: Facet\[\]/, 'facets 必须包含站点分组')
})

test('409/400 有可恢复反馈，不是把 message 原样抛出', () => {
  const code = stripComments(read(VIEW))
  for (const codeName of ['identity_required', 'site_mismatch', 'site_required']) {
    assert.match(code, new RegExp(`'${codeName}'`), `必须处理 ${codeName}`)
  }
})

test('创建/更新走 query site 合同', () => {
  const code = stripComments(read(LIBRARY))
  assert.match(code, /withSite\(/, '写路径要统一把 site 提到 query')
  assert.match(code, /withSite\(PREFIX, body\)/, '创建商品带 site')
  assert.match(code, /withSite\(`\$\{PREFIX\}\/\$\{encodeURIComponent\(asin\)\}`/, '更新商品带 site')
})

test('编辑表单不再把"站点未知"静默回填成 US', () => {
  const code = stripComments(read(DRAFT))
  assert.doesNotMatch(code, /product\.site === '' \? DEFAULT_SITE/, '未知站点不许默认 US —— 那正是隐式回填的入口')
  assert.match(code, /site: product\.site \?\? '',/, '未知站点保持空，逼用户显式选')
})
