/**
 * 产品库「手动录入」（v1.19）：**不依赖选品页也能把产品库填起来**。
 *
 * 客户端的纯逻辑（`productFactDraft.ts`）不进宿主构建产物，测试里导入不到，
 * 所以这一层按本仓惯例做**源码级接线断言**（与 `viewHttpFence` / `productLibraryBoundary` 同风格）：
 * 钉住"入口在、表单在、写动作走 hook、身份字段在编辑态只读"这四件事。
 *
 * 为什么值得一条测试：旧版产品库只有"编辑"没有"新增"，而空态文案还引导用户去选品页 ——
 * 于是产品库自己永远长不出数据。这类"缺入口"不会报错，只会让人以为"功能没做"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments } from './_clientSources.mjs'

const VIEW = 'src/client/views/ProductLibraryView.tsx'
const FORM = 'src/client/components/ProductFactForm.tsx'
const HOOK = 'src/client/hooks/useProductLibrary.ts'
const DRAFT = 'src/client/productFactDraft.ts'
const ROUTES = 'src/api/routes/products.ts'

test('产品库有「手动录入」入口：标题栏 + 空态各一个 CTA', () => {
  const view = stripComments(read(VIEW))
  assert.match(view, /手动录入/, '标题栏必须有主按钮「手动录入」')
  assert.match(view, /录入第一个产品/, '空库时要有「录入第一个产品」的 CTA（否则空页面没有下一步）')
  assert.match(view, /openCreate\(/, '两个 CTA 都要打开录入弹框')
  assert.doesNotMatch(
    view, /去「选品」页收藏/,
    '空态不许再把用户推给选品页：产品库是独立事实表，选品不会往里写数据',
  )
})

test('录入/编辑共用一个表单组件，且身份字段在编辑态只读', () => {
  const view = stripComments(read(VIEW))
  assert.match(view, /import \{ ProductFactForm \}/, '必须复用抽出来的表单组件（视图不该再长一份表单）')
  assert.match(view, /mode=\{form\.mode\}/, '新建与编辑共用同一份组件')
  const form = stripComments(read(FORM))
  assert.match(form, /disabled=\{editing\}/, 'ASIN / 站点在编辑态必须 disabled（它们是身份）')
  assert.match(form, /身份字段，不可改/, '只读要有可读的原因，不能只是灰掉')
})

test('写动作全部走 hook，视图里不出现 HTTP 方法', () => {
  const view = stripComments(read(VIEW))
  for (const banned of [/method:\s*'POST'/, /method:\s*'PATCH'/, /method:\s*'DELETE'/, /JSON\.stringify\(/]) {
    assert.doesNotMatch(view, banned, `视图不该自己拼请求（命中 ${banned}）：写动作应在 useProductLibrary`)
  }
  const hook = stripComments(read(HOOK))
  assert.match(hook, /const create = useCallback/, 'hook 必须提供 create')
  assert.match(hook, /const update = useCallback/, 'hook 必须提供 update')
  assert.match(hook, /const remove = useCallback/, 'hook 必须提供 remove（录错了要能删）')
})

test('草稿层做身份与价格校验，且价格 0 不当作"没填"', () => {
  const draft = stripComments(read(DRAFT))
  assert.match(draft, /export function createBody/, '新建请求体由草稿层构造（视图与 hook 都不该拼字段）')
  assert.match(draft, /export function updateBody/, '编辑请求体只含事实字段')
  assert.match(draft, /站点必须是两位字母/, '站点在提交前就要拦（别等一次往返）')
  assert.match(draft, /ASIN 格式无效/, 'ASIN 在提交前就要拦')
  /**
   * 价格的空串才是"没填"：`0` 是合法价格。这一条曾经在选品库里踩过
   * （把 0 当成空值 → 白送价被存成"未定价"）。
   */
  assert.match(draft, /if \(value === ''\) return null/, '只有空串才是 null')
})

test('后端提供单条录入端点，且身份字段拒绝修改', () => {
  const routes = stripComments(read(ROUTES))
  assert.match(routes, /req\.method === 'POST' && pathname === PRODUCTS_PREFIX/, 'POST /products 是手动录入的落点')
  assert.match(routes, /req\.method === 'PATCH'/, 'PATCH 走 id')
  assert.match(routes, /req\.method === 'DELETE'/, 'DELETE 走 id')
  assert.match(routes, /code: 'duplicate'/, '重复键要带 code，前端才能区分"已存在"与其它 400')
})
