/**
 * 响应信封（2026-10-27，决策 2）：`/api/workbench/*` 的每个响应都必须带 `ok`。
 *
 * ## 背景
 *
 * 收口前成功/失败响应有两套写法：核心域手写 `{ ok: true, … }`，Amazon 域 7 个路由文件
 * 返回**裸对象**。实测 134 个 `writeJson` 调用点里：成功 14 处带 `ok`、17 处不带；
 * 失败 1 处带、82 处不带。`ok` 缺了不会立刻出错（客户端 `client/api.ts` 只读 HTTP 状态码
 * 与 `body.error`），所以它会**长期静默存在**，直到有人想按 `ok` 判断而拿到 `undefined`。
 *
 * ## 这个测试守三件事
 *
 * 1. **Amazon 7 文件已完全收口**：源码里不得再出现手写 `writeJson(` / `{ ok: … }`
 *    （必须走 `apiOk` / `apiError`）。扫描前先剥注释 —— 否则本文件与实现文件里
 *    「原实现是 `{ ok: true }`」这类**说明性注释**会把断言打红。
 * 2. **核心域是债务棘轮**：仍允许手写 `writeJson`，但**总数只许下降**。
 *    基线在收口 Amazon 域之后一次性钉死；后续每迁一个文件就把基线调低。
 *    这样既不需要大爆炸式重写 337 处，也不会有人把新债写进来。
 * 3. **收口函数本身是对的**：`apiOk` 产 `{ok:true}`、`apiError` 产 `{ok:false,error}`，
 *    且 `writeJson` 仍是唯一底层原语（`httpFence.test.mjs` 负责"不存在第二份实现"）。
 */
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { read, stripComments } from './_clientSources.mjs'

const ROUTES_DIR = 'src/api/routes'

/** 收口 Amazon 域时改过的 7 个文件（决策 2 的直接对象）。 */
const AMAZON_ROUTES = [
  'aba-keywords.ts',
  'amazon-datasets.ts',
  'asin.ts',
  'calculator-scenarios.ts',
  'inventory.ts',
  'keyword-plans.ts',
  'oplog.ts',
]

/**
 * 债务棘轮基线：Amazon 域收口**之后**，核心域剩余的手写 `writeJson(res, ` 处数。
 *
 * ⚠️ 只允许下调。迁移某个文件后把这里的数字改小；**永不上调**。
 * 上调 = 又写了一处新的手写响应，应该改走 `apiOk` / `apiError`。
 */
const RAW_WRITEJSON_BASELINE = 278

function routeFiles() {
  return readdirSync(new URL(`../${ROUTES_DIR}/`, import.meta.url))
    .filter((name) => name.endsWith('.ts'))
    .sort()
}

function countOf(source, pattern) {
  return (source.match(pattern) ?? []).length
}

test('Amazon 7 个路由文件已全部走 apiOk / apiError，不再手写响应体', () => {
  for (const file of AMAZON_ROUTES) {
    const code = stripComments(read(`${ROUTES_DIR}/${file}`))
    assert.equal(
      countOf(code, /writeJson\(/g), 0,
      `${file} 仍直接调用 writeJson：成功应走 apiOk、失败应走 apiError`,
    )
    assert.equal(
      countOf(code, /\{\s*ok\s*:/g), 0,
      `${file} 仍手写 { ok: … }：信封只能由 apiOk / apiError 产生`,
    )
  }
})

test('Amazon 7 个路由文件确实用到了这两个收口函数（防止"删空也算通过"）', () => {
  for (const file of AMAZON_ROUTES) {
    const code = stripComments(read(`${ROUTES_DIR}/${file}`))
    assert.match(code, /\bapiOk\(/, `${file} 没有用到 apiOk`)
    assert.match(code, /\bapiError\(/, `${file} 没有用到 apiError`)
  }
})

test('核心域手写 writeJson 是债务棘轮：只许下降', () => {
  let total = 0
  const perFile = []
  for (const file of routeFiles()) {
    const code = stripComments(read(`${ROUTES_DIR}/${file}`))
    const n = countOf(code, /writeJson\(res,\s/g)
    if (n > 0) perFile.push(`${file}=${n}`)
    total += n
  }
  assert.ok(
    total <= RAW_WRITEJSON_BASELINE,
    `手写 writeJson 从基线 ${RAW_WRITEJSON_BASELINE} 涨到 ${total}（${perFile.join(', ')}）。`
    + '新增响应请走 apiOk / apiError；若本次是迁移导致的下降，请把 RAW_WRITEJSON_BASELINE 调低锁定成果。',
  )
})

test('apiOk / apiError 产生正确的信封形状', async () => {
  /** 与 `panelCss.test.mjs` 同一约定：从构建产物导入，`pnpm test` 会先 `pnpm build`。 */
  const { apiError, apiOk } = await import('../lib/api/http.js')
  const capture = () => {
    const state = { status: 0, body: '' }
    const res = {
      writeHead(status) { state.status = status },
      end(payload) { state.body = String(payload) },
    }
    return { state, res }
  }

  const okCase = capture()
  apiOk(okCase.res, { dataset: { id: 'd1' } })
  assert.deepEqual(JSON.parse(okCase.state.body), { ok: true, dataset: { id: 'd1' } })
  assert.equal(okCase.state.status, 200)

  const created = capture()
  apiOk(created.res, { dataset: { id: 'd2' } }, 201)
  assert.equal(created.state.status, 201, '创建类接口必须保留 201，不要为"统一"退回 200')
  assert.equal(JSON.parse(created.state.body).ok, true)

  const errCase = capture()
  apiError(errCase.res, 409, '已存在同名方案', { existingId: 'x9' })
  assert.deepEqual(
    JSON.parse(errCase.state.body),
    { ok: false, error: '已存在同名方案', existingId: 'x9' },
  )
  assert.equal(errCase.state.status, 409)

  /** `error` 必须在**顶层**：客户端 `client/api.ts` 读的就是 `body.error`。 */
  const nested = capture()
  apiError(nested.res, 400, '顶层错误')
  assert.equal(typeof JSON.parse(nested.state.body).error, 'string')
})
