/**
 * 客户端结构硬门：「视图不许发 HTTP」（2026-10-27，批次 8）。
 *
 * ## 这条规则本来就有，但只写在注释里
 *
 * `app/assembly.ts` 与 `index.tsx` 都写着「视图不许发 HTTP（D17 结构硬门）」，
 * 实测却在 **4 个视图 / 23 处**被破（后收敛到 3 个视图 / 13 处）。原因很简单：
 * **没有任何测试会红**。`test/httpFence.test.mjs` 管的是**服务端**的 loopback 围栏，
 * 与 `client/views/` 毫无关系。
 *
 * ## 判定口径
 *
 * 视图应当只拿"域的**结果**"和"意图回调"（见 `app/assembly.ts` 的设计说明），
 * 所以 `views/*.tsx` 里出现 `api(` 就是越界：它意味着视图自己在管 HTTP 生命周期
 * （谁重拉、失败怎么提示、清哪个 state），而这些正是域 hook 的职责。
 *
 * ## 棘轮
 *
 * 还没收回的视图登记在 `ALLOWED_VIEWS` 里，给一个**精确额度**：
 * - 实际数 > 额度 → 失败（又写了一处新的）；
 * - 实际数 < 额度 → 失败（说明收回了一部分，应把额度调低锁定成果）。
 *
 * 这样"部分完成"也是**有记录的完成**，而不是一个永远无法变绿的全或无断言。
 */
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { read, stripComments } from './_clientSources.mjs'

const VIEWS_DIR = 'src/client/views'

/**
 * 尚未收回的视图 → 允许保留的直接 HTTP 调用数。**只许减少。**
 *
 * ⚠️ 计数口径必须包含 `api<Type>(...)`（带泛型的写法）。第一版只匹配 `api(`，
 * 于是 `InventoryView` 的两处 `api<{ latest: … }>(...)` 整个漏掉、`AsinView` 从 9 数成 4 ——
 * 一个守卫如果数不准，它守住的就只是"看起来干净"。
 *
 * 已收回（不在表里，必须为 0）：`KnowledgeDetailPane`（2026-10-27，搬进 `useKnowledge`
 * 的 `saveDraft()` / `removeEntry()`，2 处 → 0）。
 */
const ALLOWED_VIEWS = {
  'AsinView.tsx': 9,
  'InventoryView.tsx': 2,
  'OpsLogView.tsx': 10,
}

function viewFiles() {
  return readdirSync(new URL(`../${VIEWS_DIR}/`, import.meta.url))
    .filter((name) => name.endsWith('.tsx'))
    .sort()
}

/**
 * 剥注释后再数：注释里提到 `api(` 是说明，不是实现。
 *
 * `\bapi\s*[<(]` 同时覆盖 `api(` 与 `api<T>(` —— 后者是本仓大量使用的写法
 * （`api<{ entries: KnowledgeEntry[] }>('/api/workbench/knowledge')`）。
 */
function directHttpCalls(file) {
  const code = stripComments(read(`${VIEWS_DIR}/${file}`))
  return (code.match(/\bapi\s*[<(]/g) ?? []).length
}

test('视图不得直接发 HTTP：未登记的视图必须为 0 处 api(', () => {
  const offenders = []
  for (const file of viewFiles()) {
    if (file in ALLOWED_VIEWS) continue
    const n = directHttpCalls(file)
    if (n > 0) offenders.push(`${file}=${n}`)
  }
  assert.deepEqual(
    offenders, [],
    `以下视图直接调用了 api()：${offenders.join(', ')}。`
    + '请把 HTTP 与状态搬进对应的域 hook（参考 KnowledgeDetailPane → useKnowledge.saveDraft/removeEntry），'
    + '视图只留意图与文案。',
  )
})

test('棘轮：已登记的视图只许减少，不许增加', () => {
  const stale = []
  for (const [file, allowed] of Object.entries(ALLOWED_VIEWS)) {
    const n = directHttpCalls(file)
    assert.ok(
      n <= allowed,
      `${file} 的直接 api( 从 ${allowed} 涨到 ${n}。新增的 HTTP 请写进域 hook，不要写回视图。`,
    )
    if (n < allowed) stale.push(`${file}: ${allowed} → ${n}`)
  }
  assert.deepEqual(
    stale, [],
    `以下视图已收回一部分，请下调 ALLOWED_VIEWS 锁定成果：${stale.join('; ')}`,
  )
})

test('已收回 HTTP 的视图不得再 import 客户端 api 封装', () => {
  for (const file of viewFiles()) {
    if (file in ALLOWED_VIEWS) continue
    const code = stripComments(read(`${VIEWS_DIR}/${file}`))
    assert.doesNotMatch(
      code, /import\s*\{[^}]*\bapi\b[^}]*\}\s*from\s*'\.\.\/api\.js'/,
      `${file} 不再直接发 HTTP，但还 import 着 ../api.js 的 api —— 加回来只要一行，所以这里也钉住。`,
    )
  }
})
