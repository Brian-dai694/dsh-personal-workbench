/**
 * P6 调用主链测试：`src/experts/invocation.ts` + 服务 / 工具 / 装配三层的调用面。
 *
 * 覆盖验收表里的 AX-E36–E44、AX-E48、AX-E49：
 *  - 请求表：所有者 / TTL / 任务指纹 / 同请求同任务只启动一次 / 容量与并发位（E37、E44）
 *  - ticket：只在子代理首轮之前 claim、父/普通会话/别人的 child/第二个 child 全拒（E39）
 *  - 人格：来源与修订在调用期钉死，运行中换文件或换来源一律拒绝（E40），父绑定行逐字不变（E36/E40）
 *  - 生命周期：五种失败 + 超时 + 取消，dispose 次数与残留位（E41）
 *  - 回传：空输出 / 未加载人格 / 超限截断，绝不伪造成功（E42）
 *  - 策略：专家子代理被服务侧守卫拒绝，deny 名单不写不存在的工具名（E43）
 *  - 开关：`summon_expert` 与提示区块按开关出现/消失（E48），能力缺失时如实不可用且不 pending（E49）
 *
 * 全部用独立临时目录（绝不碰 `~/.dsh/workbench`），且清理前先核验"确实在 tmpdir 下、确实是本文件前缀"。
 * 假 provider 只实现 SDK 形状（`spawn` + persona/toolFilter/depthLimit + `inheritsParentContext:false`），
 * 不 import 任何宿主包、不调真实 LLM。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import * as plugin from '../lib/index.js'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { getAiSession } from '../lib/db/repo.js'
import { PERSONA_BINDING_SCOPE, writePersonaBinding } from '../lib/db/repo/persona-bindings.js'
import { writePersonaSettings } from '../lib/db/repo/personas.js'
import { resolveExpertRoots } from '../lib/experts/paths.js'
import { createExpertService } from '../lib/experts/service.js'
import {
  childMaxDepth,
  createExpertInvocation,
  delegationDepth,
  expertPersonaInstruction,
  isSubagentChildAgent,
} from '../lib/experts/invocation.js'
import { probeExpertSubagents, probeExpertTools, selectSpawnProvider } from '../lib/experts/host-adapter.js'
import {
  EXPERT_GENERATION_TOOL_NAMES,
  EXPERT_INVOCATION_TOOL_NAMES,
  LOAD_INVOKED_EXPERT_TOOL_NAME,
  RUN_EXPERT_REQUEST_TOOL_NAME,
  SUMMON_EXPERT_TOOL_NAME,
  expertInvocationTools,
} from '../lib/experts/tools.js'

const AT = '2026-01-01T00:00:00.000Z'
const AT_MS = Date.parse(AT)
const TTL_MS = 30 * 60 * 1000
const SESSION_A = 'session-invocation-aaaa'
const SESSION_B = 'session-invocation-bbbb'
const SESSION_C = 'session-invocation-cccc'
const PERSONA_ID = 'engineering/合成实现者'
const TASK = '把这份合成输入整理成三条结论。'
/** 本测试用的临时目录前缀（清理前必须命中它）。 */
const TMP_PREFIX = 'wb-expert-invocation-'

// ---------------------------------------------------------------------------
// 夹具：人格文档 / 资源（与 personaBinding 测试同构）
// ---------------------------------------------------------------------------

function personaText({ title = '合成实现者', description = '合成简介。', body = '## 身份\n\n合成正文：只在子代理加载人格后才可以看到。\n' } = {}) {
  return `# ${title}\n\n> 自定义专家 · 分类 \`engineering\` · 工作模式：**只读诊断**\n> 建议 emoji：\`🧪\`　建议简介（\`description\`，≤160 字符）：\n> ${description}\n\n---\n\n${body}`
}

function writePersona(root, relativePath, text) {
  const full = join(root, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
  return full
}

/** 清理：只清理"确实在系统临时目录下、且确实带本文件前缀"的目录。 */
function removeTempDir(dir) {
  assert.equal(dir.startsWith(tmpdir()), true, `拒绝清理不在 tmpdir 下的目录：${dir}`)
  assert.equal(dir.includes(TMP_PREFIX), true, `拒绝清理不属于本测试的目录：${dir}`)
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 8) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

// ---------------------------------------------------------------------------
// 假 subagents 服务：形状照 `@deepseek-ai/dsh-subagent`，行为可脚本化
// ---------------------------------------------------------------------------

function fakeSubagents() {
  const state = {
    starts: [],
    disposes: 0,
    order: [],
    script: {},
    lastTicket: '',
    lastChild: undefined,
    /** 由脚手架注入：默认让子代理在首轮加载人格（`skipLoad` 可以关掉，用来验证"没加载"）。 */
    defaultLoad: undefined,
  }
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    async start() {
      throw new Error('测试只经过 runtime.start：provider.start 不应被直接调用')
    },
  }
  const service = {
    list: () => ['spawn'],
    getProvider: (name) => (name === 'spawn' ? provider : undefined),
    async start(name, request) {
      const script = state.script
      state.order.push('start:enter')
      state.starts.push({ name, request })
      const parentId = request?.parent?.session?.id ?? ''
      const childId = script.childId ?? `child-${state.starts.length}`
      const ticket = /([0-9a-f]{64})/.exec(String(request?.persona ?? ''))?.[1] ?? ''
      const childExec = {
        agent: {
          session: {
            id: childId,
            header: { origin: 'subagent', parentSession: parentId, cwd: 'D:/Code/<company>/dsh-workbench' },
          },
        },
      }
      state.lastTicket = ticket
      state.lastChild = { id: childId, exec: childExec }
      /** （a）AX-E38 时序：**返回 run 之前**就允许子代理跑第一轮（真实 in-process provider 就是这样）。 */
      if (typeof script.onStart === 'function') await script.onStart({ request, ticket, childExec, state })
      else if (script.skipLoad !== true && typeof state.defaultLoad === 'function') {
        await state.defaultLoad({ request, ticket, childExec, state })
      }
      state.order.push('start:leave')
      /** （c）基础设施故障：start 直接 reject。 */
      if (script.startReject === true) throw new Error('子代理服务不可用（假 provider 注入的基础设施故障）')
      let result
      if (script.noResult === true) result = undefined
      else if (script.result !== undefined) {
        result = typeof script.result === 'function' ? script.result({ request, ticket, childExec }) : script.result
      } else {
        result = { stopReason: 'completed', output: [{ type: 'text', text: '合成结论' }] }
      }
      if (result !== undefined && typeof result.then !== 'function') result = Promise.resolve(result)
      if (script.resultReject === true) {
        result = Promise.reject(new Error('子代理运行失败（假 provider 注入）'))
        result.catch(() => {})
      }
      return {
        id: script.runId ?? childId,
        localAgent: script.localAgentMissing === true ? undefined : { session: { id: childId } },
        result,
        /** （d）统计 dispose 次数（幂等性由调用方保证一次）。 */
        dispose: async () => { state.disposes += 1 },
      }
    },
  }
  return { service, provider, state }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function parentExec(sessionId, extra = {}) {
  return {
    agent: { session: { id: sessionId, header: { cwd: 'D:/Code/<company>/dsh-workbench' } }, options: {} },
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// 脚手架：真 service + 真 invocation（注入假 provider / 假时钟 / 独立临时库与人格根）
// ---------------------------------------------------------------------------

async function withInvocation(fn, options = {}) {
  const root = mkdtempSync(join(tmpdir(), TMP_PREFIX))
  const personasDir = join(root, 'personas')
  const skillsDir = join(root, 'skills')
  const externalDir = join(root, 'external')
  for (const dir of [personasDir, skillsDir, externalDir]) mkdirSync(dir, { recursive: true })
  const personaFile = writePersona(personasDir, join('engineering', '合成实现者.md'), personaText())
  writePersona(personasDir, join('engineering', '合成实现者', 'resources', 'checklist.md'), '# 清单\n\n- 一条合成检查项\n')
  const db = openWorkbenchDb({ dbPath: join(root, 'workbench.db') })
  const fake = options.subagents ?? fakeSubagents()
  const registered = [...EXPERT_GENERATION_TOOL_NAMES, ...EXPERT_INVOCATION_TOOL_NAMES]
  const tools = options.tools ?? { get: (name) => (registered.includes(name) ? { name } : undefined) }
  /** 时钟可拨动：TTL / 过期用"推进时间"验证，不真的等 30 分钟。 */
  let clock = AT
  let invocation
  try {
    seedDictionaries(db)
    const roots = resolveExpertRoots({ personasDir, skillsDir })
    const service = createExpertService({
      db,
      ctx: { get: (name) => (name === 'subagents' ? fake.service : name === 'tools' ? tools : undefined), logger: { info: () => {}, warn: () => {}, error: () => {} } },
      roots,
      now: () => clock,
    })
    invocation = createExpertInvocation({
      db,
      roots,
      probeSubagents: () => fake.service,
      probeTools: () => tools,
      preflight: options.preflight === undefined
        ? (personaId, agent) => service.preflight(personaId, agent)
        : (personaId, agent) => options.preflight(personaId, agent, (id, a) => service.preflight(id, a)),
      deniedToolNames: [...EXPERT_GENERATION_TOOL_NAMES, RUN_EXPERT_REQUEST_TOOL_NAME],
      conditionalDeniedToolNames: [SUMMON_EXPERT_TOOL_NAME],
      now: () => clock,
      timeoutMs: options.timeoutMs ?? 60_000,
    })
    /** 忠实假 child：默认在首轮就调用真实的 `loadForChild`（不加载的用例用 `skipLoad` 关掉）。 */
    fake.state.defaultLoad = async ({ ticket, childExec }) => {
      const loaded = await invocation.loadForChild(ticket, childExec)
      assert.equal(loaded.ok, true, `假子代理默认加载人格必须成功：${JSON.stringify(loaded)}`)
    }
    /** 生产路径：请求由界面创建，`expectedSourceKey/expectedRevision` 来自预检（人格身份钉死）。 */
    async function newManualRequest(sessionId = SESSION_A, task = TASK, target = invocation) {
      const preflight = await service.preflight(PERSONA_ID, parentExec(sessionId).agent)
      assert.equal(preflight.usable, true, `夹具人格必须可用：${JSON.stringify(preflight.issues)}`)
      const summary = preflight.summary
      assert.ok(summary !== null, '预检必须给出人格摘要（来源/修订的来源）')
      assert.match(summary.revision, /^[0-9a-f]{64}$/, '修订号必须是内容 SHA-256')
      const created = target.createManualRequest({
        sessionId,
        personaId: PERSONA_ID,
        expectedSourceKey: summary.sourceKey,
        expectedRevision: summary.revision,
      })
      return { ...created, task, sourceKey: summary.sourceKey, revision: summary.revision }
    }
    return await fn({
      root, db, roots, personasDir, skillsDir, externalDir, personaFile,
      service, invocation, fake, tools, newManualRequest,
      advance: (ms) => { clock = new Date(Date.parse(clock) + ms).toISOString() },
      now: () => clock,
    })
  } finally {
    if (invocation !== undefined) await invocation.dispose().catch(() => {})
    db.close()
    removeTempDir(root)
  }
}

/** 抓一个"拒绝"：返回 `ExpertInvocationError`（断言 code/field 用）。 */
async function caught(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('期望被拒绝，但调用成功了')
}

function bindingRow(db, sessionId) {
  const row = getAiSession(db, PERSONA_BINDING_SCOPE, sessionId)
  return row === undefined ? undefined : { sessionId: row.sessionId, note: row.note }
}

// ---------------------------------------------------------------------------
// AX-E36：手动请求（开关关着也能用）+ 不碰父绑定 + persona 参数只放静态句与 ticket
// ---------------------------------------------------------------------------

test('AX-E36 手动请求起独立子代理：父绑定逐字不变、persona 只有静态句+ticket、prompt 是任务文本', async () => {
  await withInvocation(async ({ db, service, fake, newManualRequest }) => {
    /** 先给父会话写一行**真实**绑定，用来证明调用前后逐字不变（不是"两边都空"）。 */
    writePersonaBinding(db, SESSION_A, {
      version: 1,
      personaId: 'engineering/另一个专家',
      sourceKey: 'user:engineering/另一个专家.md',
      relativePath: join('engineering', '另一个专家.md'),
      revision: 'a'.repeat(64),
    })
    const before = bindingRow(db, SESSION_A)
    assert.ok(before !== undefined, '夹具绑定必须已经落库')

    /**
     * 请求必须由**同一个**服务实例创建（服务层与直连调用各有一份请求表与票表），
     * 子代理那边也必须经由**同一个**实例加载，否则票在对方的表里不存在。
     */
    fake.state.defaultLoad = async ({ ticket, childExec }) => {
      const loaded = await service.loadForChild(ticket, childExec)
      assert.equal(loaded.ok, true, `合法 child 必须能加载人格：${JSON.stringify(loaded)}`)
    }
    const request = await newManualRequest(SESSION_A, TASK, service)
    const result = await service.runManual(request.requestId, request.task, parentExec(SESSION_A, { callId: 'call-e36' }))
    assert.equal(result.ok, true, `调用必须成功：${JSON.stringify(result)}`)
    assert.equal(result.personaId, PERSONA_ID)
    assert.equal(result.personaLoaded, true)
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.text, '合成结论')
    assert.equal(result.truncated, false)
    assert.deepEqual(result.warnings, [])
    assert.match(result.childSessionId, /^child-\d+$/, 'childSessionId 必须是真实 run.id')
    assert.equal(result.requestId, request.requestId)

    /** 父绑定行必须逐字不变（AX-E36 的核心断言）。 */
    assert.deepEqual(bindingRow(db, SESSION_A), before)

    /** persona 参数：只有静态短句 + hex ticket，**没有**人格正文/专家名/用户名/任务文本。 */
    const startRequest = fake.state.starts[0].request
    assert.equal(fake.state.starts[0].name, 'spawn', '§8.5 第 5 步：必须走 spawn')
    assert.equal(startRequest.persona, expertPersonaInstruction(fake.state.lastTicket))
    assert.match(startRequest.persona, /^你是本次工作台专家子代理。/)
    assert.match(startRequest.persona, new RegExp(fake.state.lastTicket))
    for (const forbidden of ['合成正文', '合成实现者', SESSION_A, request.task]) {
      assert.equal(startRequest.persona.includes(forbidden), false, `persona 参数不得出现「${forbidden}」`)
    }
    /** prompt 才是任务文本（+ 静态输出要求），且是 text block。 */
    assert.equal(Array.isArray(startRequest.prompt), true)
    assert.equal(startRequest.prompt[0].type, 'text')
    assert.equal(startRequest.prompt[0].text.startsWith(request.task), true)
    /** 深度与 toolFilter：maxDepth = 父深度 + 1；再发起调用被 deny。 */
    assert.equal(startRequest.maxDepth, 1)
    assert.equal(startRequest.toolFilter.deny.includes(RUN_EXPERT_REQUEST_TOOL_NAME), true)
    /** 父 Agent 是**逐字**传下去的（身份只来自执行上下文）。 */
    assert.equal(startRequest.parent.session.id, SESSION_A)

    /** 手动调用用的工具面确实注册着 3 个始终存在的工具（装配层契约）。 */
    const names = expertInvocationTools(service).map((tool) => tool.name)
    assert.deepEqual(names, [...EXPERT_INVOCATION_TOOL_NAMES])
    assert.equal(names.includes(LOAD_INVOKED_EXPERT_TOOL_NAME), true)
  })
})

// ---------------------------------------------------------------------------
// AX-E37：所有者 / TTL / 任务指纹 / 同请求同任务只启动一次
// ---------------------------------------------------------------------------

test('AX-E37 过期 / 跨会话 / 换任务都被明确拒绝；同请求同任务只启动一次', async () => {
  await withInvocation(async ({ invocation, fake, newManualRequest, advance }) => {
    /** ① 同请求 + 同任务：并发两次也只启动一次，且拿到同一份结果。 */
    const shared = await newManualRequest()
    const [first, second] = await Promise.all([
      invocation.runManual(shared.requestId, shared.task, parentExec(SESSION_A)),
      invocation.runManual(shared.requestId, shared.task, parentExec(SESSION_A)),
    ])
    assert.equal(fake.state.starts.length, 1, '同请求同任务并发只允许启动一次子代理')
    assert.deepEqual(first, second, '同请求同任务必须拿到同一份结果（共享同一个 Promise）')
    const again = await invocation.runManual(shared.requestId, shared.task, parentExec(SESSION_A))
    assert.deepEqual(again, first, '已完成的请求再调一次仍是同一份结果，不重复启动')
    assert.equal(fake.state.starts.length, 1)

    /** ② 同请求换任务：拒绝（任务指纹是第一执行时钉死的）。 */
    const changed = await caught(invocation.runManual(shared.requestId, '换一个完全不同的任务。', parentExec(SESSION_A)))
    assert.equal(changed.code, 'manual-request-task-changed')
    assert.equal(fake.state.starts.length, 1, '换任务被拒后不得再启动')

    /** ③ 另一个会话执行：拒绝（身份只认创建请求的那个会话）。 */
    const other = await caught(invocation.runManual(shared.requestId, shared.task, parentExec(SESSION_B)))
    assert.equal(other.code, 'manual-request-session-mismatch')

    /** ④ 过期：时间推进 30 分钟 + 1ms（TTL 用假时钟验证，不真的等）。 */
    const expiring = await newManualRequest()
    assert.equal(Date.parse(expiring.expiresAt), AT_MS + TTL_MS, 'expiresAt 必须是创建时间 + 30 分钟')
    advance(TTL_MS + 1)
    const expired = await caught(invocation.runManual(expiring.requestId, expiring.task, parentExec(SESSION_A)))
    assert.equal(expired.code, 'manual-request-expired')
    assert.equal(fake.state.starts.length, 1, '过期请求不得启动子代理')

    /** ⑤ 不存在的请求：明确报 not-found（不是"假装成功"）。 */
    const missing = await caught(invocation.runManual('00000000-0000-0000-0000-000000000000', TASK, parentExec(SESSION_A)))
    assert.equal(missing.code, 'manual-request-not-found')

    /** ⑥ 调用全部收尾：没有残留运行 / ticket / 并发位。 */
    const settled = invocation.stats()
    assert.equal(settled.tickets, 0)
    assert.equal(settled.activeSessions, 0)
    assert.equal(settled.activeTotal, 0)
    assert.equal(settled.running, 0)
  })
})

// ---------------------------------------------------------------------------
// AX-E38：start 返回之前子代理就 claim ticket（真实 in-process provider 的时序）
// ---------------------------------------------------------------------------

test('AX-E38 fake start 在返回前跑 loader：claim 成功、run.id 一致、顺序可证', async () => {
  await withInvocation(async ({ invocation, fake, newManualRequest }) => {
    const order = []
    fake.state.script.onStart = async ({ ticket, childExec }) => {
      assert.match(ticket, /^[0-9a-f]{64}$/, 'ticket 必须是 32 字节随机 hex')
      const loaded = await invocation.loadForChild(ticket, childExec)
      order.push(`load:${loaded.ok === true ? 'ok' : 'fail'}`)
      assert.equal(loaded.body.includes('合成正文'), true, '加载成功必须给回人格正文')
    }
    const request = await newManualRequest()
    const result = await invocation.runManual(request.requestId, request.task, parentExec(SESSION_A))
    assert.equal(result.ok, true)
    order.push(`run:${result.stopReason}`)
    /** 顺序：loader 在 start 返回**之前**成功（不能依赖"返回后再绑定"）。 */
    assert.deepEqual(order, ['load:ok', 'run:completed'])
    assert.deepEqual(fake.state.order, ['start:enter', 'start:leave'])
    assert.equal(result.childSessionId, fake.state.lastChild.id, 'run.id 必须与已 claim 的 child 一致')

    /** 反向：provider 返回的 run.id 与已 claim 的不一致 → 取消并报 adapter-contract-mismatch。 */
    fake.state.script = { runId: 'child-别人的会话' }
    const mismatch = await invocation.runManual(
      (await newManualRequest(SESSION_B)).requestId,
      TASK,
      parentExec(SESSION_B),
    )
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.code, 'adapter-contract-mismatch')
    assert.equal(mismatch.childSessionId, 'child-别人的会话', '真实 id 仍要带出来（便于排查），但不许当结果')
    assert.equal(fake.state.disposes, 2, '契约不符也要 dispose 掉那个 run')
  })
})

// ---------------------------------------------------------------------------
// AX-E39：ticket 的授权面
// ---------------------------------------------------------------------------

test('AX-E39 父/普通会话/别的父的 child/第二个 child 都拿不到票；合法 child 能读；结束后票失效', async () => {
  await withInvocation(async ({ invocation, fake, newManualRequest }) => {
    let inside = null
    fake.state.script.onStart = async ({ ticket, childExec }) => {
      /** 合法 child：先加载人格（这也正是"claim 成功"的正面证据）。 */
      const loaded = await invocation.loadForChild(ticket, childExec)
      assert.equal(loaded.ok, true, `合法 child 必须能加载人格：${JSON.stringify(loaded)}`)
      const read = await invocation.readForChild(ticket, join('resources', 'checklist.md'), childExec)
      assert.equal(read.ok, true)
      assert.equal(read.text.includes('一条合成检查项'), true)
      /** ① 父 Agent 自己：拒绝。 */
      const parent = await caught(invocation.loadForChild(ticket, parentExec(SESSION_A)))
      assert.equal(parent.code, 'ticket-invalid', '父会话不能用自己的 ticket 读子代理的人格')
      /** ② 普通会话（没有 subagent 头）：拒绝。 */
      const ordinary = await caught(invocation.loadForChild(ticket, parentExec('session-ordinary')))
      assert.equal(ordinary.code, 'ticket-invalid')
      /** ③ 另一个父会话的 child：拒绝（parentSession 对不上）。 */
      const foreign = await caught(invocation.loadForChild(ticket, {
        agent: { session: { id: 'child-foreign', header: { origin: 'subagent', parentSession: SESSION_B } } },
      }))
      assert.equal(foreign.code, 'ticket-invalid')
      /** ④ 同一个父的**第二个** child：票已被第一个 claim → 拒绝。 */
      const second = await caught(invocation.loadForChild(ticket, {
        agent: { session: { id: 'child-second', header: { origin: 'subagent', parentSession: SESSION_A } } },
      }))
      assert.equal(second.code, 'ticket-child-mismatch')
      inside = { ticket, childExec }
    }
    const request = await newManualRequest()
    const result = await invocation.runManual(request.requestId, request.task, parentExec(SESSION_A))
    assert.equal(result.ok, true, `调用必须成功：${JSON.stringify(result)}`)
    assert.ok(inside !== null, 'loader 必须真的在 start 返回前跑过')
    /** ⑤ 调用结束：票立即失效（不能"调用完了还能读人格"）。 */
    const after = await caught(invocation.loadForChild(inside.ticket, inside.childExec))
    assert.equal(after.code, 'ticket-invalid')
    const readAfter = await caught(invocation.readForChild(inside.ticket, join('resources', 'checklist.md'), inside.childExec))
    assert.equal(readAfter.code, 'ticket-invalid')
    assert.equal(invocation.stats().tickets, 0, '调用结束后不得残留 ticket')
  })
})

// ---------------------------------------------------------------------------
// AX-E40：调用期人格身份钉死（改文件 / 换来源都不认）
// ---------------------------------------------------------------------------

test('AX-E40 运行中改人格文件或换来源 → load/read 拒绝新修订；父绑定行逐字不变', async () => {
  await withInvocation(async ({ db, invocation, fake, personaFile, externalDir, newManualRequest }) => {
    writePersonaBinding(db, SESSION_A, {
      version: 1,
      personaId: PERSONA_ID,
      sourceKey: 'user:engineering/合成实现者.md',
      relativePath: join('engineering', '合成实现者.md'),
      revision: 'b'.repeat(64),
    })
    const before = bindingRow(db, SESSION_A)

    fake.state.script.onStart = async ({ ticket, childExec }) => {
      /** ⓪ 先正常加载一次：证明票本身是好的（后面的拒绝都是"运行期改了东西"造成的）。 */
      const first = await invocation.loadForChild(ticket, childExec)
      assert.equal(first.ok, true)
      /** ① 运行中改人格正文：解析出的修订号变了 → 拒绝，且**不给新正文**。 */
      writeFileSync(personaFile, personaText({ body: '## 身份\n\n改写后的正文：这段绝不能被读到。\n' }), 'utf8')
      const revisionChanged = await caught(invocation.loadForChild(ticket, childExec))
      assert.equal(revisionChanged.code, 'revision-changed')
      assert.equal(String(revisionChanged.message).includes('改写后的正文'), false, '拒绝时不得把新正文带出去')
      const readChanged = await caught(invocation.readForChild(ticket, join('resources', 'checklist.md'), childExec))
      assert.equal(readChanged.code, 'revision-changed')

      /** ② 还原内容、把同一份人格挪到**另一个来源**：来源对不上也要拒。 */
      writeFileSync(personaFile, personaText(), 'utf8')
      writePersona(externalDir, join('engineering', '合成实现者.md'), personaText())
      rmSync(personaFile, { force: true })
      writePersonaSettings(db, { personaExternalDir: externalDir })
      const sourceChanged = await caught(invocation.loadForChild(ticket, childExec))
      assert.equal(sourceChanged.code, 'revision-changed')
      assert.match(String(sourceChanged.message), /来源/)
    }
    const request = await newManualRequest()
    const result = await invocation.runManual(request.requestId, request.task, parentExec(SESSION_A))
    assert.equal(result.ok, true, `拒绝只影响那一次 load，调用本身照常完成：${JSON.stringify(result)}`)
    /** 父绑定行逐字不变。 */
    assert.deepEqual(bindingRow(db, SESSION_A), before)
  })
})

// ---------------------------------------------------------------------------
// AX-E41：五种失败路径 + 超时 / 取消的清理
// ---------------------------------------------------------------------------

test('AX-E41 error/aborted/max-tokens/start reject/result reject：真实 stopReason、dispose 次数、无残留', async () => {
  await withInvocation(async ({ invocation, fake, newManualRequest }) => {
    const busyOk = async (sessionId = SESSION_A) => {
      const request = await newManualRequest(sessionId)
      const result = await invocation.runManual(request.requestId, request.task, parentExec(sessionId))
      return result
    }

    /** ① 子代理自报 error。 */
    fake.state.script = { result: { stopReason: 'error', output: [], diagnostic: '合成诊断：子代理自己失败了' } }
    const errored = await busyOk()
    assert.equal(errored.ok, false)
    assert.equal(errored.stopReason, 'error')
    assert.equal(errored.code, 'expert-subagent-unavailable')
    assert.equal(fake.state.disposes, 1)

    /** ② 子代理自报 aborted → canceled。 */
    fake.state.script = { result: { stopReason: 'aborted', output: [{ type: 'text', text: '半截输出' }] } }
    const aborted = await busyOk(SESSION_B)
    assert.equal(aborted.ok, false)
    assert.equal(aborted.stopReason, 'aborted')
    assert.equal(aborted.code, 'canceled')
    assert.equal(aborted.text, '半截输出', '非完成态也要把 partial 文本带回来')
    assert.equal(fake.state.disposes, 2)

    /** ③ max-tokens：没有对应的 §12.1 码，如实报真实 stopReason（ok:false）。 */
    fake.state.script = { result: { stopReason: 'max-tokens', output: [{ type: 'text', text: '被截断的输出' }], diagnostic: '达到输出上限' } }
    const limited = await busyOk(SESSION_C)
    assert.equal(limited.ok, false)
    assert.equal(limited.stopReason, 'max-tokens')
    assert.equal(limited.text, '被截断的输出')
    assert.equal(fake.state.disposes, 3)

    /** ④ start reject（基础设施故障）：没有 run 可 dispose。 */
    fake.state.script = { startReject: true }
    const startFailed = await busyOk()
    assert.equal(startFailed.ok, false)
    assert.equal(startFailed.code, 'expert-subagent-unavailable')
    assert.equal(fake.state.disposes, 3, 'start 失败时没有 run，不该多一次 dispose')

    /** ⑤ result reject（基础设施故障）：走同一套清理。 */
    fake.state.script = { resultReject: true }
    const resultFailed = await busyOk(SESSION_B)
    assert.equal(resultFailed.ok, false)
    assert.equal(resultFailed.code, 'expert-subagent-unavailable')
    assert.equal(resultFailed.stopReason, 'error')
    assert.equal(fake.state.disposes, 4)

    /** 残留检查：位与票都释放，下一个调用不被 expert-busy 拦。 */
    assert.deepEqual(invocation.stats().activeTotal, 0)
    assert.deepEqual(invocation.stats().tickets, 0)
    assert.deepEqual(invocation.stats().running, 0)
    fake.state.script = {}
    const after = await busyOk(SESSION_C)
    assert.equal(after.ok, true, '失败路径之后并发位必须已经释放')
  })
})

test('AX-E41 超时与 exec.signal 取消：abort 子 signal、dispose 一次、位与票都释放', async () => {
  await withInvocation(async ({ invocation, fake, newManualRequest }) => {
    /** ① 超时（注入 50ms，不真的等 10 分钟）：run.result 永不 settle。 */
    fake.state.script = { result: new Promise(() => {}) }
    const request = await newManualRequest()
    const timedOut = await invocation.runManual(request.requestId, request.task, parentExec(SESSION_A))
    assert.equal(timedOut.ok, false)
    assert.equal(timedOut.code, 'timeout')
    assert.equal(fake.state.disposes, 1, '超时必须 dispose 掉那个 run')
    assert.equal(invocation.stats().activeTotal, 0)
    assert.equal(invocation.stats().tickets, 0)
  }, { timeoutMs: 50 })

  await withInvocation(async ({ invocation, fake, newManualRequest }) => {
    /** ② exec.signal 取消（用户在界面上取消这次调用）。 */
    const controller = new AbortController()
    fake.state.script = { result: new Promise(() => {}) }
    const request = await newManualRequest()
    const pending = invocation.runManual(request.requestId, request.task, parentExec(SESSION_A, { signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    const canceled = await pending
    assert.equal(canceled.ok, false)
    assert.equal(canceled.code, 'canceled')
    assert.equal(fake.state.disposes, 1)
    assert.equal(invocation.stats().activeTotal, 0)
    assert.equal(invocation.stats().running, 0)
  })
})

// ---------------------------------------------------------------------------
// AX-E42：回传的三种"不许算成功"
// ---------------------------------------------------------------------------

test('AX-E42 空输出 / 未加载人格 / 超 12000 截断：不许伪造成功，childSessionId 是真实 run id', async () => {
  await withInvocation(async ({ invocation, fake, newManualRequest }) => {
    /** ① 加载了人格但没有任何文本：expert-empty-output（不编摘要）。 */
    fake.state.script = { result: { stopReason: 'completed', output: [] } }
    const first = await newManualRequest()
    const empty = await invocation.runManual(first.requestId, first.task, parentExec(SESSION_A))
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'expert-empty-output')
    assert.equal(empty.stopReason, 'completed')
    assert.equal(empty.personaLoaded, true)
    assert.equal(empty.text, '')
    assert.equal(empty.message.includes('输出'), true)
    assert.equal(empty.message.includes('不伪造摘要'), true)

    /** ② 子代理压根没加载人格：expert-persona-not-loaded（它的文字只当"未完成加载的输出"）。 */
    fake.state.script = { skipLoad: true, result: { stopReason: 'completed', output: [{ type: 'text', text: '我没加载人格就自己干了' }] } }
    const second = await newManualRequest(SESSION_B)
    const notLoaded = await invocation.runManual(second.requestId, second.task, parentExec(SESSION_B))
    assert.equal(notLoaded.ok, false)
    assert.equal(notLoaded.code, 'expert-persona-not-loaded')
    assert.equal(notLoaded.personaLoaded, false)
    assert.equal(notLoaded.text, '我没加载人格就自己干了', '文本照实带出，但不算成功')

    /** ③ 超 12000：截断 + 显式 truncated，childSessionId 仍是真实 run id。 */
    const long = '结论'.repeat(7000)
    fake.state.script = { result: { stopReason: 'completed', output: [{ type: 'text', text: long }] } }
    const third = await newManualRequest(SESSION_C)
    const truncated = await invocation.runManual(third.requestId, third.task, parentExec(SESSION_C))
    assert.equal(truncated.ok, true)
    assert.equal(truncated.truncated, true)
    assert.equal(truncated.text.length <= 12000, true, `截断后不得超过 12000 字符，实际 ${truncated.text.length}`)
    assert.equal(truncated.childSessionId, fake.state.lastChild.id)
  })
})

// ---------------------------------------------------------------------------
// AX-E43：专家子代理的越权面 + deny 名单必须全是"真的存在"的名字
// ---------------------------------------------------------------------------

test('AX-E43 专家子代理再发起调用或写专家草稿 → 服务守卫拒绝；deny 名单不含不存在的工具名', async () => {
  await withInvocation(async ({ service, invocation, fake, newManualRequest, tools }) => {
    /** 子代理身份（真 Header 形状）：`origin=subagent` + `parentSession`。 */
    const childExec = {
      agent: { session: { id: 'child-guard', header: { origin: 'subagent', parentSession: SESSION_A } } },
    }
    assert.equal(isSubagentChildAgent(childExec.agent), true)

    /** 先跑一次**合法**调用，用来取到真正发下去的 toolFilter（deny 名单）。 */
    const request = await newManualRequest()
    const legit = await invocation.runManual(request.requestId, request.task, parentExec(SESSION_A))
    assert.equal(legit.ok, true)
    assert.equal(fake.state.starts.length, 1)

    /** ① 服务侧守卫：子代理不得再发起调用。 */
    const reentry = await caught(invocation.runManual(request.requestId, request.task, childExec))
    assert.equal(reentry.code, 'expert-disabled')
    const auto = await caught(invocation.runAuto(PERSONA_ID, request.task, childExec))
    assert.equal(auto.code, 'expert-disabled')
    /** ② 服务侧守卫：子代理不得写专家草稿（deny 只挡工具入口，这里挡服务入口）。 */
    const draft = await caught(service.submitDraft({ draftId: 'x', expectedVersion: 0, personaMd: '正文' }, childExec))
    assert.equal(draft.code, 'expert-disabled')
    const staged = await caught(service.stageFile({ draftId: 'x', expectedVersion: 0, area: 'persona-resource', path: 'a.md', contentUtf8: 'x' }, childExec))
    assert.equal(staged.code, 'expert-disabled')

    /** ③ deny 名单：5 个草稿生成工具 + 再发起调用；load/read 必须**不**被 deny。 */
    const deny = fake.state.starts[0].request.toolFilter.deny
    for (const name of EXPERT_GENERATION_TOOL_NAMES) {
      assert.equal(deny.includes(name), true, `deny 必须包含草稿工具 ${name}`)
    }
    assert.equal(deny.includes(RUN_EXPERT_REQUEST_TOOL_NAME), true)
    assert.equal(deny.includes(LOAD_INVOKED_EXPERT_TOOL_NAME), false, '子代理必须还能加载人格')
    assert.equal(deny.includes('workbench_read_invoked_expert_resource'), false)
    /** `summon_expert` 当前**没在**注册表里 → 绝不能写进 deny（SDK 对不存在的名字是 loud 拒绝）。 */
    assert.equal(tools.get(SUMMON_EXPERT_TOOL_NAME), undefined)
    assert.equal(deny.includes(SUMMON_EXPERT_TOOL_NAME), false, '不存在的工具名不得进 deny')
    /** deny 里每个名字都必须在当前注册表里真的存在（否则子代理根本起不来）。 */
    for (const name of deny) {
      assert.notEqual(tools.get(name), undefined, `deny 里的 ${name} 必须真的注册着`)
    }
  })

  /** ④ 反向：把 `summon_expert` 放进注册表 → 它必须进 deny（真的存在才禁）。 */
  await withInvocation(async ({ fake, newManualRequest, invocation, tools }) => {
    assert.notEqual(tools.get(SUMMON_EXPERT_TOOL_NAME), undefined)
    const request = await newManualRequest()
    const result = await invocation.runManual(request.requestId, request.task, parentExec(SESSION_A))
    assert.equal(result.ok, true)
    assert.equal(fake.state.starts[0].request.toolFilter.deny.includes(SUMMON_EXPERT_TOOL_NAME), true)
  }, {
    tools: {
      get: (name) => ([...EXPERT_GENERATION_TOOL_NAMES, ...EXPERT_INVOCATION_TOOL_NAMES].includes(name) ? { name } : (name === SUMMON_EXPERT_TOOL_NAME ? { name } : undefined)),
    },
  })
})

// ---------------------------------------------------------------------------
// AX-E44：并发位（不排队、不重复跑）
// ---------------------------------------------------------------------------

test('AX-E44 同父第二个与实例第三个 → expert-busy；完成后释放位（不排队、不重复跑）', async () => {
  await withInvocation(async ({ invocation, fake, newManualRequest }) => {
    const pending = deferred()
    fake.state.script = { result: pending.promise }
    const first = await newManualRequest(SESSION_A)
    const runningFirst = invocation.runManual(first.requestId, first.task, parentExec(SESSION_A))
    await new Promise((resolve) => setTimeout(resolve, 10))

    /** ① 同一个父会话的第二个请求：expert-busy（不排队）。 */
    const secondSameParent = await newManualRequest(SESSION_A)
    const busySame = await caught(invocation.runManual(secondSameParent.requestId, secondSameParent.task, parentExec(SESSION_A)))
    assert.equal(busySame.code, 'expert-busy')

    /** ② 第二个父会话可以起来（实例上限是 2）。 */
    const second = await newManualRequest(SESSION_B)
    const runningSecond = invocation.runManual(second.requestId, second.task, parentExec(SESSION_B))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fake.state.starts.length, 2, '实例上限 2：两个不同父会话都能起来')

    /** ③ 第三个父会话：expert-busy（实例总计 2 已满，不排队）。 */
    const third = await newManualRequest(SESSION_C)
    const busyTotal = await caught(invocation.runManual(third.requestId, third.task, parentExec(SESSION_C)))
    assert.equal(busyTotal.code, 'expert-busy')
    assert.equal(fake.state.starts.length, 2, '被拒的调用不得启动子代理')

    /** ④ 让前两个跑完：位释放，第三个能成功（证明"完成后释放"，不是永久卡住）。 */
    pending.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '合成结论' }] })
    const [one, two] = await Promise.all([runningFirst, runningSecond])
    assert.equal(one.ok, true)
    assert.equal(two.ok, true)
    assert.equal(invocation.stats().activeTotal, 0)
    const later = await invocation.runManual(third.requestId, third.task, parentExec(SESSION_C))
    assert.equal(later.ok, true, '前两个结束后第三个必须能跑')
    assert.equal(fake.state.starts.length, 3)
  })
})

// ---------------------------------------------------------------------------
// AX-E49（模块级）：能力如实 + 纯函数语义
// ---------------------------------------------------------------------------

test('AX-E49 缺 subagents / 只有 fork / 缺 persona|toolFilter|depthLimit → 能力如实不可用且不 pending', async () => {
  /** ① 没有 subagents 服务：`probeExpertSubagents` 返回 undefined，选择不通过。 */
  assert.equal(probeExpertSubagents({ get: () => undefined }), undefined)
  const missing = selectSpawnProvider(undefined)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'expert-subagent-unavailable')

  /** ② 形状不对（缺 start / getProvider / list 不是函数）：一样是"不可用"，不抛异常。 */
  assert.equal(probeExpertSubagents({ get: () => ({ list: () => [], getProvider: () => undefined }) }), undefined)
  assert.equal(probeExpertSubagents({ get: () => ({ list: () => [], getProvider: () => undefined, start: 'not-a-function' }) }), undefined)

  /** ③ 只有 fork（inheritsParentContext=true）→ 不许当替代品。 */
  const forkOnly = {
    list: () => ['fork'],
    getProvider: (name) => (name === 'fork'
      ? { name: 'fork', capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: true, start: async () => {} }
      : undefined),
  }
  assert.equal(selectSpawnProvider(forkOnly).ok, false)
  assert.equal(selectSpawnProvider(forkOnly).code, 'expert-subagent-unavailable')

  /** ④ spawn 在，但缺 persona / toolFilter / depthLimit：同样不可用（绝不"猜 API"）。 */
  for (const missingCapability of ['persona', 'toolFilter', 'depthLimit']) {
    const degraded = {
      list: () => ['spawn'],
      getProvider: () => ({
        name: 'spawn',
        capabilities: {
          agentOptions: true,
          outputSchema: true,
          depthLimit: missingCapability !== 'depthLimit',
          toolFilter: missingCapability !== 'toolFilter',
          persona: missingCapability !== 'persona',
        },
        inheritsParentContext: false,
        start: async () => {},
      }),
    }
    assert.equal(selectSpawnProvider(degraded).ok, false, `缺 ${missingCapability} 时不得认为可用`)
  }

  /** ⑤ 合格 spawn：可用（这是唯一被接受的一组 flags）。 */
  const ok = selectSpawnProvider(fakeSubagents().service)
  assert.equal(ok.ok, true)
  assert.equal(ok.provider.name, 'spawn')

  /** ⑥ 工具注册表探测：缺 get 就是"探测不到"，不抛异常。 */
  assert.equal(probeExpertTools({ get: () => ({ register: () => {} }) }), undefined)
  assert.equal(probeExpertTools({ get: () => undefined }), undefined)

  /** ⑦ 深度语义：父 = max(header, options)，子 = 父 + 1；非法值直接拒绝（不四舍五入）。 */
  assert.equal(delegationDepth({ session: { header: {} }, options: {} }), 0)
  assert.equal(delegationDepth({ session: { header: { delegationDepth: 2 } }, options: {} }), 2)
  assert.equal(delegationDepth({ session: { header: { delegationDepth: 1 } }, options: { subagentDepth: 3 } }), 3)
  assert.equal(childMaxDepth({ session: { header: { delegationDepth: 1 } }, options: {} }), 2)
  for (const bad of [-1, 1.5, -0, Number.MAX_SAFE_INTEGER + 2, '2']) {
    assert.throws(() => delegationDepth({ session: { header: { delegationDepth: bad } }, options: {} }), /委派深度/)
  }
  assert.throws(() => childMaxDepth({ session: { header: { delegationDepth: Number.MAX_SAFE_INTEGER } }, options: {} }), /maxDepth/)

  /** ⑧ 子代理身份判定只认 `header.origin==='subagent'`。 */
  assert.equal(isSubagentChildAgent({ session: { id: 'x', header: { origin: 'subagent' } } }), true)
  assert.equal(isSubagentChildAgent({ session: { id: 'x', header: {} } }), false)
  assert.equal(isSubagentChildAgent({ session: { id: 'x' } }), false)
  assert.equal(isSubagentChildAgent(undefined), false)

  /** ⑨ persona 硬编码指令：5 行逐字 + ticket 插值（不许掺专家名/正文）。 */
  const instruction = expertPersonaInstruction('f'.repeat(64))
  assert.equal(instruction, [
    '你是本次工作台专家子代理。',
    `处理任务前必须先调用 workbench_load_invoked_expert(ticket="${'f'.repeat(64)}")。`,
    '加载成功后按其正文工作；资源使用 workbench_read_invoked_expert_resource。',
    '未加载成功必须停止并报告原因。不要调用 workbench_load_persona。',
    '不能再次召唤工作台专家。按用户任务完成后输出结论、依据、限制和下一步。',
  ].join('\n'))
})

test('AX-E49 服务层能力如实：缺 spawn provider 时 manualSummon/autoSummon 都报不可用', async () => {
  /** ① 完全没有 subagents 服务。 */
  await withInvocation(async ({ service }) => {
    const capabilities = await service.capabilities()
    for (const report of [capabilities.manualSummon, capabilities.autoSummon]) {
      assert.equal(report.available, false)
      assert.equal(report.reason, 'expert-subagent-unavailable')
    }
  }, { subagents: { service: undefined, state: { starts: [], disposes: 0, order: [], script: {} } } })

  /** ② 有 subagents 服务、但没有合格的 spawn provider（只有 fork）。 */
  const forkOnly = {
    service: {
      list: () => ['fork'],
      getProvider: () => ({
        name: 'fork',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: true,
        start: async () => {},
      }),
      start: async () => { throw new Error('不该被调用') },
    },
    state: { starts: [], disposes: 0, order: [], script: {} },
  }
  await withInvocation(async ({ service }) => {
    const capabilities = await service.capabilities()
    assert.equal(capabilities.manualSummon.available, false)
    assert.equal(capabilities.autoSummon.reason, 'expert-subagent-unavailable')
    /** 调用也必须被拒（不是"能力说不可用、真调却能起"）；开关先打开，才能验证是能力而不是开关拦的。 */
    service.setAutoEnabled(true)
    const refused = await caught(service.runAuto(PERSONA_ID, TASK, parentExec(SESSION_A)))
    assert.equal(refused.code, 'expert-subagent-unavailable')
  }, { subagents: forkOnly })
})

test('AX-E49 运行前依赖预检不可用（拿不到技能作用域）→ 明确拒绝，一个子代理都不启动', async () => {
  await withInvocation(async ({ invocation, service, fake }) => {
    /**
     * 身份仍按**真实**预检钉死（sourceKey/revision 来自真人格），
     * 只有"运行前那一次依赖预检"被替换成"拿不到 scope helper"。
     */
    const created = await (async () => {
      const real = await service.preflight(PERSONA_ID, parentExec(SESSION_A).agent)
      assert.equal(real.usable, true)
      return invocation.createManualRequest({
        sessionId: SESSION_A,
        personaId: PERSONA_ID,
        expectedSourceKey: real.summary.sourceKey,
        expectedRevision: real.summary.revision,
      })
    })()
    const refused = await caught(invocation.runManual(created.requestId, TASK, parentExec(SESSION_A)))
    assert.equal(refused.code, 'skill-scope-unavailable')
    assert.equal(refused.field, 'persona_id')
    assert.match(refused.message, /预检未通过/)
    assert.equal(fake.state.starts.length, 0, '预检不可用时**不许**启动子代理')
    assert.equal(invocation.stats().activeTotal, 0, '失败路径也得把并发位放掉')
    assert.equal(invocation.stats().tickets, 0, '失败路径不得残留 ticket')
  }, {
    preflight: async (personaId, agent, real) => ({
      ...(await real(personaId, agent)),
      usable: false,
      status: 'dependency-unavailable',
      issues: [{ code: 'skill-scope-unavailable', field: 'skills', message: '拿不到技能作用域（scope helper 缺失）' }],
    }),
  })
})

// ---------------------------------------------------------------------------
// 装配层：假宿主（与真 cordis 同形的最小 ctx，且 disposer **真的**会摘掉注册）
// ---------------------------------------------------------------------------

function fakeHost({ services = {} } = {}) {
  const routes = []
  const tools = []
  const sections = []
  const commands = []
  const logs = []
  const disposers = []
  const serviceMap = { ...services }
  const push = (level) => (message) => { logs.push({ level, message: String(message) }) }
  const removeFrom = (list, entry) => () => {
    const index = list.indexOf(entry)
    if (index >= 0) list.splice(index, 1)
  }
  const ctx = {
    logger: { info: push('info'), warn: push('warn'), error: push('error') },
    effect(fn, name) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push({ name: name ?? '(anonymous)', dispose })
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(key) { return serviceMap[key] },
    inject(names, callback) {
      if (names.every((name) => serviceMap[name] !== undefined)) {
        const dispose = callback(ctx)
        if (typeof dispose === 'function') disposers.push({ name: `inject:${names.join(',')}`, dispose })
      }
      return () => {}
    },
    on(name, listener) { serviceMap[`__on:${name}`] = listener; return () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return removeFrom(routes, route)
      },
    },
    /**
     * 与真 `ToolRuntime` 同形：`register` 返回**会摘掉注册**的 disposer，
     * `get(name)` 能查到当前注册表 —— AX-E48 的"出现/消失"和 deny 名字校验都靠它。
     */
    tools: {
      register(tool) {
        tools.push(tool)
        return removeFrom(tools, tool)
      },
      get(name) { return tools.find((tool) => tool.name === name) },
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return removeFrom(sections, spec)
      },
      context() { return () => {} },
    },
    commands: { register(definition) { commands.push(definition); return removeFrom(commands, definition) } },
  }
  /** `commands` / `tools` 都走 `ctx.get(...)` 软探测（与真宿主同一路径）。 */
  serviceMap.commands = ctx.commands
  serviceMap.tools = ctx.tools
  return {
    ctx, routes, tools, sections, commands, logs, disposers, serviceMap,
    async disposeAll() {
      for (const entry of [...disposers].reverse()) entry.dispose()
    },
  }
}

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), TMP_PREFIX))
  mkdirSync(join(home, '.dsh', 'workbench', 'personas', 'engineering'), { recursive: true })
  writePersona(join(home, '.dsh', 'workbench', 'personas'), join('engineering', '合成实现者.md'), personaText())
  writePersona(join(home, '.dsh', 'workbench', 'personas'), join('engineering', '合成实现者', 'resources', 'checklist.md'), '# 清单\n\n- 一条合成检查项\n')
  return home
}

async function startServer(routes) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    for (const route of routes) {
      const matched = route.kind === 'prefix'
        ? url.pathname === route.path || url.pathname.startsWith(`${route.path}/`)
        : url.pathname === route.path
      if (matched) { route.handler(req, res); return }
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务器没有拿到端口')
  const base = `http://127.0.0.1:${address.port}`
  async function request(method, path, body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const text = await response.text()
        return { status: response.status, text, body: text === '' ? null : JSON.parse(text) }
      } catch (error) {
        const transient = /bad port|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed/i.test(String(error))
        if (transient === false || attempt >= 2) throw error
      }
    }
  }
  return { base, request, close: () => new Promise((resolve) => server.close(resolve)) }
}

// ---------------------------------------------------------------------------
// AX-E48：开关驱动的注册 / 注销（走真实 apply + 真实 HTTP 设置路由）
// ---------------------------------------------------------------------------

test('AX-E48 off→on→off：summon_expert 与 plugin:workbench-experts 按开关出现/消失；关闭后新启动被拒、已启动的仍完成', async () => {
  const home = tempHome()
  const fake = fakeSubagents()
  const host = fakeHost({ services: { subagents: fake.service } })
  let server
  try {
    await plugin.apply(host.ctx, { home })
    const summonTools = () => host.tools.filter((tool) => tool.name === SUMMON_EXPERT_TOOL_NAME)
    const promptSections = () => host.sections.filter((section) => section.name === 'plugin:workbench-experts')

    /** ① 默认关闭：工具与提示区块都不在（既不注册，也不"注册了但报不可用"）。 */
    assert.equal(summonTools().length, 0)
    assert.equal(promptSections().length, 0)
    /** 始终注册的 3 个调用工具必须在（不受开关影响）。 */
    for (const name of EXPERT_INVOCATION_TOOL_NAMES) {
      assert.equal(host.tools.filter((tool) => tool.name === name).length, 1, `${name} 必须始终注册`)
    }

    server = await startServer(host.routes)

    /** ② 打开：工具 + 提示区块出现（提示区块同步、不插值、顺序 320）。 */
    const on = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: true })
    assert.equal(on.status, 200)
    assert.equal(on.body.settings.autoSummonExperts, true)
    assert.equal(summonTools().length, 1, '打开后 summon_expert 必须注册恰好一次')
    assert.equal(promptSections().length, 1, '打开后自主专家提示区块必须注册恰好一次')
    const section = promptSections()[0]
    assert.equal(section.interpolate, false)
    assert.equal(section.order, 320)
    assert.equal(typeof section.text, 'function', 'text 必须是同步函数（宿主每轮调用）')
    const sectionText = section.text()
    assert.equal(typeof sectionText, 'string')
    assert.equal(sectionText.length > 0, true, '自主专家提示必须给出清单（至少有人格时）')

    /** ③ 已启动的调用：开启状态下开始，关闭后仍然完成。 */
    const summon = summonTools()[0]
    fake.state.script.onStart = async ({ ticket, childExec }) => {
      const load = host.tools.find((tool) => tool.name === LOAD_INVOKED_EXPERT_TOOL_NAME)
      const loaded = await load.execute({ ticket }, childExec)
      assert.equal(loaded.ok, true, `子代理必须能加载人格：${JSON.stringify(loaded)}`)
      assert.equal(loaded.body.includes('合成正文'), true)
    }
    const inFlight = summon.execute(
      { persona_id: PERSONA_ID, task: '写一段合成结论' },
      { agent: { session: { id: 'session-invocation-auto-aaaa', header: {} }, options: {} }, callId: 'call-auto-1' },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    const off = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: false })
    assert.equal(off.status, 200)
    assert.equal(off.body.settings.autoSummonExperts, false)
    /** ④ 关闭：工具与提示区块**摘掉**（disposer 真的生效）。 */
    assert.equal(summonTools().length, 0, '关闭后 summon_expert 必须注销')
    assert.equal(promptSections().length, 0, '关闭后提示区块必须注销')
    /** 已启动的那一次仍然跑完（关闭不杀已经开始的调用）。 */
    const finished = await inFlight
    assert.equal(finished.ok, true, `已启动的调用必须仍能完成：${JSON.stringify(finished)}`)

    /** ⑤ 关闭后新启动：被拒（关闭前已被模型接受的延迟调用不得继续启动）。 */
    const refused = await summon.execute(
      { persona_id: PERSONA_ID, task: '再写一段' },
      { agent: { session: { id: 'session-invocation-auto-aaaa', header: {} }, options: {} }, callId: 'call-auto-2' },
    )
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'expert-auto-disabled')

    /** ⑥ 能力报告与设置真值一致。 */
    const capabilities = await server.request('GET', '/api/workbench/experts/capabilities')
    assert.equal(capabilities.body.autoSummon.enabled, false)
    assert.equal(capabilities.body.manualSummon.available, true, '有合格 spawn provider 时手动调用能力必须为真')

    await host.disposeAll()
  } finally {
    if (server !== undefined) await server.close()
    removeTempDir(home)
  }
})

test('AX-E49 打开开关但没有合格 spawn provider：不注册 summon_expert、不注册提示区块、插件仍然正常装配', async () => {
  const home = tempHome()
  /** 只有 fork provider 的宿主：不能当 spawn 的替代品。 */
  const forkOnly = {
    list: () => ['fork'],
    getProvider: () => ({
      name: 'fork',
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: true,
      start: async () => {},
    }),
    start: async () => { throw new Error('不该被调用') },
  }
  const host = fakeHost({ services: { subagents: forkOnly } })
  let server
  try {
    await plugin.apply(host.ctx, { home })
    server = await startServer(host.routes)
    const on = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: true })
    assert.equal(on.status, 200)

    /** ① 没有合格 provider：工具与提示区块都不注册（不放开必然失败的入口）。 */
    assert.equal(host.tools.some((tool) => tool.name === SUMMON_EXPERT_TOOL_NAME), false)
    assert.equal(host.sections.some((section) => section.name === 'plugin:workbench-experts'), false)
    /** ② 插件**没 pending**：既有路由 / 工具 / 命令照常装配。 */
    assert.equal(host.routes.some((route) => route.path === '/api/workbench/experts'), true)
    assert.equal(host.tools.some((tool) => tool.name === 'workbench_get_expert_draft'), true)
    for (const name of EXPERT_INVOCATION_TOOL_NAMES) {
      assert.equal(host.tools.some((tool) => tool.name === name), true)
    }
    assert.equal(host.commands.some((definition) => definition.name === 'workbench'), true)
    /** ③ 能力如实不可用（不是"假装可用"）。 */
    const capabilities = await server.request('GET', '/api/workbench/experts/capabilities')
    assert.equal(capabilities.status, 200)
    assert.equal(capabilities.body.manualSummon.available, false)
    assert.equal(capabilities.body.manualSummon.reason, 'expert-subagent-unavailable')
    assert.equal(capabilities.body.autoSummon.available, false)
    assert.equal(capabilities.body.autoSummon.enabled, true, 'enabled 仍是设置真值（与 available 分开报）')

    await host.disposeAll()
  } finally {
    if (server !== undefined) await server.close()
    removeTempDir(home)
  }
})

test('AX-E49 完全没有 subagents 服务：开关打开也不注册、不 pending、其它路由照常', async () => {
  const home = tempHome()
  const host = fakeHost({ services: {} })
  let server
  try {
    await plugin.apply(host.ctx, { home })
    server = await startServer(host.routes)
    await server.request('POST', '/api/workbench/settings', { autoSummonExperts: true })
    assert.equal(host.tools.some((tool) => tool.name === SUMMON_EXPERT_TOOL_NAME), false)
    assert.equal(host.sections.some((section) => section.name === 'plugin:workbench-experts'), false)
    const capabilities = await server.request('GET', '/api/workbench/experts/capabilities')
    assert.equal(capabilities.status, 200)
    assert.equal(capabilities.body.manualSummon.available, false)
    assert.equal(capabilities.body.autoSummon.available, false)
    /** 手动调用在缺 spawn 时也必须被明确拒绝（服务侧二次守卫）。 */
    const capabilitiesBody = capabilities.body
    assert.equal(capabilitiesBody.providerName, 'personal-workbench')
    await host.disposeAll()
  } finally {
    if (server !== undefined) await server.close()
    removeTempDir(home)
  }
})
