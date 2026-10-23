/**
 * P1 独立证据：设置 GET/POST 的「专家自动召唤开关」接线（真实 HTTP）。
 *
 * 为什么要单独跑：P1 的批次清单里没有路由测试（`test/expertRoutes.test.mjs` 属 P5），
 * 但 P1 实际多接了一步 `src/api/routes.ts`（GET 合并 `readExpertSettings`、
 * POST 写 `expert_auto_summon`）。「改了路由却没有测试」正是不能靠"文件写好了"结账的地方，
 * 所以主会话用真实 HTTP 独立验一遍，把实际输出留成证据。
 *
 * 用法：node "docs/tasks/ed644638-.../evidence/p1-settings-http.mjs"
 * 退出码 0 = 全部断言通过。
 */
import http from 'node:http'
import { openWorkbenchDb } from '../../../../lib/db/database.js'
import { seedDictionaries } from '../../../../lib/db/seed.js'
import { makeRoutes } from '../../../../lib/api/routes.js'
import { readMeta } from '../../../../lib/db/repo.js'

const checks = []
function check(name, condition, detail) {
  checks.push({ name, ok: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

const db = openWorkbenchDb({ dbPath: ':memory:' })
seedDictionaries(db)
const routes = [...makeRoutes(db)]
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  for (const route of routes) {
    if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
    if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = address.port
const call = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

const SETTINGS = '/api/workbench/settings'

try {
  /** 1. 缺省（meta 里没有这个键）= 关。 */
  const initial = await call('GET', SETTINGS)
  check('GET 初始：autoSummonExperts 缺省为 false', initial.body.settings.autoSummonExperts === false && readMeta(db, 'expert_auto_summon') === undefined, { value: initial.body.settings.autoSummonExperts })

  /** 2. POST 真 boolean true：GET 必须一致，落库值是真实标记。 */
  const on = await call('POST', SETTINGS, { autoSummonExperts: true })
  check('POST true → 响应与 GET 都是 true', on.body.settings.autoSummonExperts === true && (await call('GET', SETTINGS)).body.settings.autoSummonExperts === true, { meta: readMeta(db, 'expert_auto_summon') })

  /** 3. POST 字符串 'false'：**不算**关（Boolean('false') 陷阱），也不该把状态改坏。 */
  const stringFalse = await call('POST', SETTINGS, { autoSummonExperts: 'false' })
  check("POST 字符串 'false' 不生效（真值仍是 true）", stringFalse.body.settings.autoSummonExperts === true, { value: stringFalse.body.settings.autoSummonExperts })

  /** 4. POST 真 boolean false：关。 */
  const off = await call('POST', SETTINGS, { autoSummonExperts: false, defaultEstimateMinutes: 45 })
  check('POST false → false，且同一请求里的默认耗时也落库', off.body.settings.autoSummonExperts === false && off.body.settings.defaultEstimateMinutes === 45, { value: off.body.settings.autoSummonExperts })

  /** 5. 只改开关，不得顺手把别的字段改掉（整表替换语义只该作用于显式传入的字段）。 */
  const onAgain = await call('POST', SETTINGS, { autoSummonExperts: true })
  check('只改开关：其他字段（默认耗时 45）保持不变', onAgain.body.settings.defaultEstimateMinutes === 45 && onAgain.body.settings.autoSummonExperts === true, { defaultEstimateMinutes: onAgain.body.settings.defaultEstimateMinutes })

  /** 6. 脏值（'yes' / 空串）读出来必须是关，不能因为"非空字符串"就当成开。 */
  const { writeMeta } = await import('../../../../lib/db/repo.js')
  let dirtyOk = true
  for (const dirty of ['yes', '', 'null', '0']) {
    writeMeta(db, 'expert_auto_summon', dirty)
    const read = await call('GET', SETTINGS)
    if (read.body.settings.autoSummonExperts !== false) dirtyOk = false
  }
  check("脏值（'yes' / '' / 'null' / '0'）一律读成 false", dirtyOk, {})
} finally {
  await new Promise((resolve) => server.close(resolve))
  db.close()
}

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\nSUMMARY pass=${checks.length - failed.length} fail=${failed.length} total=${checks.length}`)
process.exit(failed.length === 0 ? 0 : 1)
