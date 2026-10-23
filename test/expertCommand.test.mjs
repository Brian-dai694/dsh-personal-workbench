/**
 * AX-E47 / AX-E51（命令侧）：`/expert <persona-id> -- <任务>`。
 *
 * ## 这组用例在证明什么
 *
 * - **AX-E47**：语法（第一个 `" -- "` 分隔、不按显示名匹配、无参给帮助与最多 20 条 ID、
 *   缺任务**不建请求**）；合法命令**只走同一条**手动 request 路径 + `agent.steer`，
 *   不另开"直接 start 子代理"的口子。
 * - **AX-E51**：注册外壳与 `/workbench` 同层同写法（`ctx.effect` 包 `commands.register` 的
 *   disposer）；热重载 / 卸载 3 轮后命令表里**各一份**，且卸载后不再写失效上下文。
 *
 * 命令定义是工厂（`expertCommandDefinition`），所以这里**直接驱动 handler**，
 * 不需要真的起 cordis —— 只有"注册外壳"那一组用假 ctx（与 `expertWiring.test.mjs` 同风格）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { EXPERT_COMMAND_HELP_MAX_IDS, expertCommandDefinition, expertCommandHelp, expertHelpIds, parseExpertCommand } from '../lib/experts/command.js'
import { EXPERT_INVOCATION_DIRECTIVE } from '../lib/client/expertPrompt.js'
import { ExpertServiceError, expertErrorStatus } from '../lib/experts/service.js'
import { makeExpertRoutes } from '../lib/api/routes/experts.js'
import { EXPERTS_MANUAL_REQUESTS_PATH } from '../lib/client/expertInputSource.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const PERSONA_ID = 'generated/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_ID = 'session-expert-command-aaaa'
const SOURCE_KEY = 'generated'
const REVISION = 'c'.repeat(64)
const REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TASK = '审查这份需求的遗漏与矛盾之处'

function summaryFixture() {
  return { id: PERSONA_ID, name: '需求审查专家', description: '审查需求。', sourceKey: SOURCE_KEY, revision: REVISION }
}

/** 假专家服务：记录 preflight / createManualRequest 的每一次调用（**没有隐藏成功**）。 */
function fakeService({ preflight, create } = {}) {
  const calls = { preflight: [], create: [] }
  return {
    calls,
    catalog: async () => ({ personas: [summaryFixture()], experts: [], diagnostics: [], skillsAvailable: false, preliminary: true }),
    preflight: async (personaId, agent) => {
      calls.preflight.push({ personaId, agent })
      if (typeof preflight === 'function') return preflight(personaId, agent)
      if (preflight instanceof Error) throw preflight
      if (personaId !== PERSONA_ID) {
        return { personaId, usable: false, status: 'expert-not-found', issues: [{ code: 'expert-not-found', message: '角色库里没有这个 ID' }], effectiveSkills: [], preliminary: false, summary: null }
      }
      return { personaId, usable: true, status: 'usable', issues: [], effectiveSkills: [], preliminary: false, summary: summaryFixture() }
    },
    createManualRequest: (input) => {
      calls.create.push(input)
      if (typeof create === 'function') return create(input)
      if (create instanceof Error) throw create
      return { requestId: REQUEST_ID, expiresAt: '2026-01-01T00:30:00.000Z' }
    },
  }
}

/** 一次 handler 调用的最小环境：真 agent 替身 + steer 记录。 */
function invocation(rawInput, { hasSession = true, hasSteer = true } = {}) {
  const steered = []
  const agent = {}
  if (hasSession) agent.session = { id: SESSION_ID, header: { origin: 'top', cwd: 'D:/Code/<company>/dsh-workbench' } }
  if (hasSteer) agent.steer = (message) => { steered.push(message) }
  return { agent, rawInput, steered }
}

async function runExpert(rawInput, options = {}, serviceOptions = {}) {
  const service = fakeService(serviceOptions)
  const definition = expertCommandDefinition({}, { experts: service })
  const env = invocation(rawInput, options)
  const result = await definition.handler(env)
  return { result, service, env }
}

// ---------------------------------------------------------------------------
// 纯解析
// ---------------------------------------------------------------------------

test('AX-E47 parseExpertCommand：第一个 " -- " 分隔，左右各自 trim', () => {
  assert.deepEqual(parseExpertCommand(`  ${PERSONA_ID} -- ${TASK}  `), { ok: true, personaId: PERSONA_ID, task: TASK })
  // 任务里再有 " -- " 不影响：只按**第一个**分隔符切
  assert.deepEqual(parseExpertCommand(`${PERSONA_ID} -- 先做 A -- 再做 B`), { ok: true, personaId: PERSONA_ID, task: '先做 A -- 再做 B' })
  // 减号/空格形状不够就不算分隔符
  assert.deepEqual(parseExpertCommand(`${PERSONA_ID} --${TASK}`), { ok: false, code: 'missing-separator' })
  assert.deepEqual(parseExpertCommand(`${PERSONA_ID}-- ${TASK}`), { ok: false, code: 'missing-separator' })
  assert.deepEqual(parseExpertCommand(''), { ok: false, code: 'empty' })
  assert.deepEqual(parseExpertCommand('   '), { ok: false, code: 'empty' })
  /**
   * 「分隔符不完整」（左侧空白 / 右侧空白 / 缺一侧空格）**统一**是 `missing-separator`：
   * 整串 `trim()` 会把分隔符两侧的空格一起吃掉，`" -- "` 就不再匹配。
   *
   * 所以实现里**故意没有** `missing-persona` / `missing-task` 这些分支 —— 这个解析器能可靠
   * 区分的只有"分隔符在不在"，写三条"猜"的分支只会让人以为有被测过的缺 ID 路径。
   * 用户拿到的文案会把正确格式与例子都列出来（见下一个用例）。
   */
  assert.deepEqual(parseExpertCommand('   -- ' + TASK), { ok: false, code: 'missing-separator' })
  assert.deepEqual(parseExpertCommand(`${PERSONA_ID} -- `), { ok: false, code: 'missing-separator' })
  assert.deepEqual(parseExpertCommand(`${PERSONA_ID} --\n`), { ok: false, code: 'missing-separator' })
  // 非字符串（宿主可能传 undefined）
  assert.deepEqual(parseExpertCommand(undefined), { ok: false, code: 'empty' })
})

test('AX-E47 expertHelpIds / expertCommandHelp：最多 20 条、按 catalog 顺序、空目录有兜底文案', () => {
  const personas = Array.from({ length: 25 }, (_, index) => ({ id: `generated/p-${String(index).padStart(2, '0')}` }))
  const ids = expertHelpIds({ personas })
  assert.equal(ids.length, EXPERT_COMMAND_HELP_MAX_IDS)
  assert.equal(ids[0], 'generated/p-00')
  assert.equal(ids.at(-1), 'generated/p-19')
  assert.equal(expertHelpIds(undefined).length, 0)
  assert.equal(expertHelpIds({ personas: [{ id: '  ' }, { name: '没有 id' }] }).length, 0)
  assert.match(expertCommandHelp(ids), /用法：\/expert <persona-id> -- <任务>/)
  assert.match(expertCommandHelp(ids), /- generated\/p-00/)
  assert.match(expertCommandHelp([]), /没有可用的专家 ID/)
})

// ---------------------------------------------------------------------------
// AX-E47：命令行为
// ---------------------------------------------------------------------------

test('AX-E47 无参数：返回帮助 + 最多 20 条可用 ID，一个请求都不建', async () => {
  const { result, service } = await runExpert('')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法：\/expert <persona-id> -- <任务>/)
  assert.match(result.text, new RegExp(PERSONA_ID.replace(/[/\\]/g, '\\$&')), '帮助里要列出可用 ID')
  assert.deepEqual(service.calls.preflight, [], '无参不许预检')
  assert.deepEqual(service.calls.create, [], '无参绝不建请求')
})

test('AX-E47 缺分隔符（含缺一侧空格 / 缺 ID / 缺任务）：都是 kind:error + 格式说明，且**不建 request**', async () => {
  for (const rawInput of [
    `${PERSONA_ID} ${TASK}`,
    // 分隔符两侧都要有空格：`ID --` 少了右侧空格
    `${PERSONA_ID} --`,
    // 右侧只有空白（整串 trim 会吃掉分隔符右侧的空格）⇒ 同样是"格式不对"
    `${PERSONA_ID} --    `,
    `   -- ${TASK}`,
  ]) {
    const { result, service } = await runExpert(rawInput)
    assert.equal(result.kind, 'error', `${rawInput} 必须是错误`)
    assert.match(result.text, /缺少分隔符/, `${rawInput} 要说清是格式问题`)
    assert.match(result.text, /\/expert <persona-id> -- <任务>/, '把正确格式给出来')
    assert.deepEqual(service.calls.create, [], `${rawInput} 不许建请求`)
    assert.deepEqual(service.calls.preflight, [], `${rawInput} 连预检都不该发生（先判语法）`)
  }
})

test('AX-E47 用显示名而不是 ID：报错并提示改用 ID（不猜、不模糊匹配）', async () => {
  const { result, service } = await runExpert(`需求审查专家 -- ${TASK}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /当前不可用/, '按 ID 预检失败 ⇒ 如实说不可用')
  assert.match(result.text, /角色库里没有这个 ID/, '把预检诊断带上（用户才知道为什么）')
  assert.deepEqual(service.calls.create, [], '显示名绝不建请求')
  assert.equal(service.calls.preflight.length, 1, '它确实走的是"按 ID 预检"这条路（显示名只是查不到）')
})

test('AX-E47 合法命令：preflight 取 summary → 同一条 createManualRequest → steer → success', async () => {
  const { result, service, env } = await runExpert(`${PERSONA_ID} -- ${TASK}`)
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.equal(result.text.includes(REQUEST_ID), true, `回执里要有 request id：${result.text}`)

  // ① 身份取自 live agent 的 preflight summary（P6 交接 §9-2）
  assert.equal(service.calls.preflight.length, 1)
  assert.equal(service.calls.preflight[0].personaId, PERSONA_ID)
  assert.equal(service.calls.preflight[0].agent, env.agent, '预检必须拿到**真实 live agent**（cwd/scope 都在它身上）')

  // ② 只建一条请求，且字段完全来自 preflight summary + agent.session.id
  assert.deepEqual(service.calls.create, [{
    sessionId: SESSION_ID,
    personaId: PERSONA_ID,
    expectedSourceKey: SOURCE_KEY,
    expectedRevision: REVISION,
  }])

  // ③ steer 一条用户消息，正文就是 expertPrompt 的逐字短指令
  assert.equal(env.steered.length, 1, '只允许 steer 一条')
  const message = env.steered[0]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  const text = message.content.map((block) => block.text).join('')
  assert.equal(text.includes(`request_id="${REQUEST_ID}"`), true)
  assert.equal(text.includes(TASK), true)
  assert.equal(text.includes('不能把这个 request_id 用于其他任务'), true)
  for (const line of EXPERT_INVOCATION_DIRECTIVE) {
    assert.equal(text.includes(line.replace('<requestId>', REQUEST_ID)), true, `短指令必须逐字包含：${line}`)
  }
})

test('AX-E47 无会话身份 / 无 steer：都不建请求（身份与投递通道缺一不可）', async () => {
  const noSession = await runExpert(`${PERSONA_ID} -- ${TASK}`, { hasSession: false })
  assert.equal(noSession.result.kind, 'error')
  assert.match(noSession.result.text, /会话身份/)
  assert.deepEqual(noSession.service.calls.preflight, [], '没有身份时连预检都不做')

  const noSteer = await runExpert(`${PERSONA_ID} -- ${TASK}`, { hasSteer: false })
  assert.equal(noSteer.result.kind, 'error')
  assert.match(noSteer.result.text, /agent\.steer 不可用/)
  assert.deepEqual(noSteer.service.calls.create, [], '不能把请求建出来却送不出去')
})

test('AX-E47 steer 失败：如实报"请求已建立但送达失败"（不谎报成功、不隐藏 id）', async () => {
  const service = fakeService()
  const definition = expertCommandDefinition({}, { experts: service })
  const env = invocation(`${PERSONA_ID} -- ${TASK}`)
  env.agent.steer = () => { throw new Error('会话已被用户关闭') }
  const result = await definition.handler(env)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /会话已被用户关闭/)
  assert.equal(result.text.includes(REQUEST_ID), true, '已经把 id 说清楚，用户/模型才能收尾')
  assert.equal(service.calls.create.length, 1)
})

test('AX-E47 建请求失败（revision-changed）：返回可读错误、不 steer 任何东西', async () => {
  const service = fakeService({ create: new Error('expected_revision 与当前专家内容不一致（revision-changed）') })
  const definition = expertCommandDefinition({}, { experts: service })
  const env = invocation(`${PERSONA_ID} -- ${TASK}`)
  const result = await definition.handler(env)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /revision-changed/)
  assert.match(result.text, /请求没有建立/)
  assert.deepEqual(env.steered, [], '请求没建出来就不许 steer')
})

test('AX-E47 目录读不出来不影响合法命令：帮助降级，但按 ID 的命令照常成功', async () => {
  const service = fakeService()
  service.catalog = async () => { throw new Error('目录不可读') }
  const definition = expertCommandDefinition({}, { experts: service })

  const help = await definition.handler(invocation(''))
  assert.equal(help.kind, 'error')
  assert.match(help.text, /没有可用的专家 ID/)

  const ok = await definition.handler(invocation(`${PERSONA_ID} -- ${TASK}`))
  assert.equal(ok.kind, 'success', JSON.stringify(ok))
  assert.equal(service.calls.create.length, 1)
})

test('AX-E47 没有专家服务时工厂当场拒绝（不是"注册一个永远报错的命令"）', () => {
  assert.throws(() => expertCommandDefinition({}, {}), /没有专家服务/)
  assert.throws(() => expertCommandDefinition({}, { experts: {} }), /没有专家服务/)
  const definition = expertCommandDefinition({}, { experts: fakeService() })
  assert.equal(definition.name, 'expert')
  assert.equal(definition.input.hint, '<persona-id> -- <任务>')
})

// ---------------------------------------------------------------------------
// AX-E51：注册外壳（与 /workbench 同层同写法）
//
// 这一组**不复制**入口的注册形状：真正被驱动的是 `createExpertInputTriggerRegistrar`
// （@ 源那一侧的唯一外壳），而 `/expert` 命令那一侧用源码扫描锁死入口形态。
// 上一版曾在这里抄一份 `registerExpertLikeEntry()`，那种抄件对"入口写错"完全免疫。
// ---------------------------------------------------------------------------

/**
 * 注册外壳必须**逐字来自** `src/index.ts`，而不是本文件里另写一份"仿制品"。
 *
 * 上一版这里有一个 `registerExpertLikeEntry()`：它把入口那段 `ctx.effect(...)` 抄了一遍，
 * 于是它对"入口本身写错"完全免疫（抄错了测的还是抄件）。现在改成两件**真**事：
 * 1. 直接驱动唯一的注册外壳（本文件上面那条 `createExpertInputTriggerRegistrar` 的用例）；
 * 2. 用源码扫描锁死入口的形态（下面这条用例）。
 */
test('AX-E51 缺 commands 服务：入口必须"软探测 + 可读日志 + 不抛 + 不进 inject"', () => {
  const index = read('src/index.ts')
  const code = index.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.match(code, /probeService<CommandsProbe>\(ctx, 'commands'\)/, '拿不到 commands 必须走软探测（ctx.get）')
  assert.match(code, /未注册 \/expert 命令：宿主没有提供 commands 服务/, '缺服务时要有可读日志')
  assert.match(code, /^export const inject = \['webServer', 'systemPrompt', 'tools', 'commands'\]$/m, 'commands 已在 inject 里，但不许再塞别的宿主服务')
  assert.equal(/console\.warn\(notice\)/.test(code), true, '日志要能被终端看到（不只写 logger）')
})

test('AX-E47/E51 入口源码：/expert 与 /workbench 同层注册、commands 走软探测、顶层 inject 逐字不变', () => {
  const index = read('src/index.ts')
  assert.match(index, /^export const inject = \['webServer', 'systemPrompt', 'tools', 'commands'\]$/m, '顶层 inject 必须逐字不变')
  assert.equal((index.match(/registerExpertCommand\(ctx, db, experts\)/g) ?? []).length, 1, '注册点只许一处')
  const workbenchAt = index.indexOf('registerWorkbenchCommand(ctx, db)')
  const expertAt = index.indexOf('registerExpertCommand(ctx, db, experts)')
  assert.equal(workbenchAt > 0 && expertAt > workbenchAt, true, '/expert 紧随 /workbench 之后（同一层）')
  assert.match(index, /ctx\.effect\(\s*\(\) => commands\.register\(expertCommandDefinition\(db, \{ experts \}\)\)/, '/expert 必须用 ctx.effect 包住 disposer')
  assert.match(index, /probeService<CommandsProbe>\(ctx, 'commands'\)/, '拿不到 commands 走软探测（不写进 inject）')
  /** 命令定义必须**只有工厂**：入口里不许再出现一份分隔符解析（那会让 AX-E47 的用例失去意义）。 */
  const code = index.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.equal(code.includes(' -- '), false, '入口不许内联 " -- " 解析（解析只在 experts/command.ts）')
})

test('AX-E47 注册外壳的模块归属：命令解析只在 src/experts/command.ts，HTTP 契约点只在 client/expertInputSource.ts', () => {
  const command = read('src/experts/command.ts')
  assert.match(command, /export function parseExpertCommand\(/)
  assert.match(command, /\.trim\(\)\.indexOf\(' -- '\)|text\.indexOf\(' -- '\)/, '分隔符必须是第一个 " -- "（不写正则模糊匹配）')
  assert.equal(/\.match\(|\.search\(|new RegExp\(/.test(command), false, '解析不许写成正则模糊匹配')
  assert.match(command, /export function expertCommandDefinition\(/)
  /** 只允许 steer + createManualRequest：不许出现任何"直接启动子代理"的调用名。 */
  assert.equal(/runAuto\(|\.start\(|startSubagent|spawnAgent/.test(command), false, '命令路径不得直接启动子代理')
  const input = read('src/client/expertInputSource.ts')
  assert.match(input, /EXPERTS_MANUAL_REQUESTS_PATH = '\/api\/workbench\/experts\/manual-requests'/)
  assert.match(input, /EXPERTS_PREFLIGHT_PATH = '\/api\/workbench\/experts\/preflight'/)
})

// ---------------------------------------------------------------------------
// AX-E45/E46 的服务端一半：POST /api/workbench/experts/manual-requests
// ---------------------------------------------------------------------------

/** 起一个真 HTTP 服务（127.0.0.1 随机端口），只挂既有 `makeExpertRoutes`。 */
async function startExpertServer(service) {
  const routes = makeExpertRoutes({}, service)
  const handler = routes[0].handler
  const server = http.createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    })
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: response.status, json, raw: text }
  }
  return { request, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** 只实现本组用例需要的三个方法的假服务（真实实现由 expertRoutes.test.mjs 覆盖）。 */
function routeService({ onCreate } = {}) {
  const calls = []
  return {
    calls,
    createManualRequest(input) {
      calls.push(input)
      if (typeof onCreate === 'function') return onCreate(input)
      return { requestId: REQUEST_ID, expiresAt: '2026-01-01T00:30:00.000Z' }
    },
    projectFailure(error) {
      if (error instanceof ExpertServiceError) {
        return { status: expertErrorStatus(error.code), body: { error: error.message, code: error.code, field: error.field } }
      }
      return { status: 500, body: { error: 'internal', code: 'internal' } }
    },
  }
}

test('AX-E45 契约：POST manual-requests 合法 body → 200 {ok:true,requestId,expiresAt}，且字段原样交给服务', async () => {
  const service = routeService()
  const server = await startExpertServer(service)
  try {
    const res = await server.request('POST', EXPERTS_MANUAL_REQUESTS_PATH, {
      sessionId: SESSION_ID, personaId: PERSONA_ID, expectedSourceKey: SOURCE_KEY, expectedRevision: REVISION,
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, requestId: REQUEST_ID, expiresAt: '2026-01-01T00:30:00.000Z' })
    assert.deepEqual(service.calls, [{ sessionId: SESSION_ID, personaId: PERSONA_ID, expectedSourceKey: SOURCE_KEY, expectedRevision: REVISION }])
    /** 响应里不许出现执行 ticket / 绝对路径（§4.1）。 */
    assert.equal(/ticket/i.test(res.raw), false, '响应不得含 ticket')
    assert.equal(res.raw.includes('D:\\'), false, '响应不得含服务端绝对路径')
  } finally {
    await server.close()
  }
})

test('AX-E46 契约：非 POST → 405；缺字段 → 400 invalid-payload 且不建请求；身份不符 → 走 service.projectFailure', async () => {
  const service = routeService({
    onCreate: (input) => {
      if (input.expectedRevision !== REVISION) {
        throw new ExpertServiceError('revision-changed', 'expected_revision', 'expected_revision 与当前专家内容不一致，请重新选择专家。')
      }
      return { requestId: REQUEST_ID, expiresAt: '2026-01-01T00:30:00.000Z' }
    },
  })
  const server = await startExpertServer(service)
  try {
    /** ① 方法不对 */
    const get = await server.request('GET', EXPERTS_MANUAL_REQUESTS_PATH)
    assert.equal(get.status, 405)
    assert.equal(get.json.error, 'method not allowed')

    /** ② 缺字段（逐个）：400 + invalid-payload + field 指名 */
    for (const field of ['sessionId', 'personaId', 'expectedSourceKey', 'expectedRevision']) {
      const body = { sessionId: SESSION_ID, personaId: PERSONA_ID, expectedSourceKey: SOURCE_KEY, expectedRevision: REVISION }
      body[field] = '   '
      const res = await server.request('POST', EXPERTS_MANUAL_REQUESTS_PATH, body)
      assert.equal(res.status, 400, `${field} 为空必须 400`)
      assert.equal(res.json.code, 'invalid-payload')
      assert.equal(res.json.field, field)
    }
    assert.deepEqual(service.calls, [], '校验失败的请求一个都不许进服务层')

    /** ③ 身份不符：错误走唯一投影口（状态码由 code 决定，不是自造） */
    const stale = await server.request('POST', EXPERTS_MANUAL_REQUESTS_PATH, {
      sessionId: SESSION_ID, personaId: PERSONA_ID, expectedSourceKey: SOURCE_KEY, expectedRevision: 'd'.repeat(64),
    })
    assert.equal(stale.status, expertErrorStatus('revision-changed'))
    assert.equal(stale.json.code, 'revision-changed')
    assert.equal(stale.json.field, 'expected_revision')
    assert.equal(stale.json.ok, false)

    /** ④ 坏 JSON 是 400（沿用既有 readBody 口径） */
    const bad = await server.request('POST', EXPERTS_MANUAL_REQUESTS_PATH, '{not json')
    assert.equal(bad.status, 400)
    assert.equal(bad.json.code, 'invalid-json')
  } finally {
    await server.close()
  }
})

test('AX-E46 契约：既有围栏没被绕过（不改写 head/不碰 socket），manual-requests 只用 readBody/writeJson/requireText', () => {
  const source = read('src/api/routes/experts.ts')
  assert.equal(source.includes('res.writeHead('), false, '不许自己写 head（httpFence 也会扫）')
  assert.equal(source.includes('socket.remoteAddress'), false, '不许自己判 socket')
  assert.match(source, /if \(head === 'manual-requests'\)/)
  assert.match(source, /const sessionId = requireText\(body, 'sessionId', MAX_ID_CHARS\)/)
  assert.match(source, /writeJson\(res, 200, \{ ok: true, requestId: created\.requestId, expiresAt: created\.expiresAt \}\)/)
  /** ticket 与子代理读取路径**永远**没有 HTTP 入口（注释里提到它们的名字是允许的）。 */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.equal(/loadForChild|readForChild/.test(code), false, 'HTTP 层不得暴露 ticket 入口')
})
