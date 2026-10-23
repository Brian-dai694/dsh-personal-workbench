/**
 * P8：专家域客户端流程测试（AX-E52–E58）。
 *
 * ## 为什么是"流程依赖注入"而不是渲染测试
 *
 * 本批的硬要求是「不渲染 React、不 import 宿主包、`node --test` 直接可跑」。做法是：
 * **所有会连网、会碰宿主、会读时钟的边界都以参数注入**（`ExpertFlowDeps.call` /
 * `runtime` / `ctx` / `isAlive`），测试喂假实现、断言**真实流程函数**的请求序列与回执。
 * 因此这些断言能在实现变坏时变红，而不是"源码里出现过某段字面量"。
 *
 * 唯一的例外是 AX-E57 的"立即保存"与 AX-E58 的装配层不变量：那两条的语义本来就在
 * 装配/组件层（React 组件与 JSX），这里用**源码扫描**给出可复现的证据，并在断言文案里
 * 写明"这是源码级证据"。
 *
 * 逐条对应（XML 无、纯文本映射）：
 * - AX-E52 生成入口新身份、busy 拒绝、不复用 blank  → `AX-E52 …`
 * - AX-E53 五处失败各自可读 + release + 不动已有会话 → `AX-E53 …`
 * - AX-E54 四态按钮/文案 + 确认 payload 逐字段      → `AX-E54 …`
 * - AX-E55 版本冲突走刷新、绝不自动确认            → `AX-E55 …`
 * - AX-E56 安装后重读目录、required 缺失不进选择器   → `AX-E56 …`
 * - AX-E57 auto 开关失败回滚；flag 立即保存（源码级） → `AX-E57 …`
 * - AX-E58 装配层零 state/零请求；inject 逐字；旧分派 → `AX-E58 …`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_EXPERT_CATALOG,
  EXPERT_STATUS_LABELS,
  EXPERTS_CAPABILITIES_PATH,
  EXPERTS_METHODOLOGY_PATH,
  EXPERTS_GENERATION_START_PATH,
  expertDraftConfirmPath,
  expertDraftDetailPath,
  expertDraftValidatePath,
  buildExpertGenerationPrompt,
  createAutoSummonController,
  createExpertCatalogStore,
  createExpertDraftOps,
  createExpertGenerationRunner,
  expertAdminRows,
  expertDraftButtons,
  expertPersonaPreflightError,
  expertPickerPersonas,
  expertRowView,
  expertSessionTitle,
  hasSessionCreate,
  isExpertDraft,
  matchWorkspaceForCwd,
  normalizeExpertDraftResponse,
  readExpertDraftPayload,
  readExpertInstalledFromOutcome,
  readExpertPreflight,
  refreshExpertCatalogAfterInstall,
  safeSourceKeyLabel,
} from '../lib/client/hooks/useWorkbenchExperts.js'
// 服务端**真实**形状的生产者：假响应必须由它生成，不许手搓（见 makeServerExpertDraftView）。
import { expertDraftView } from '../lib/experts/drafts.js'
import { SESSION_OPEN_UNAVAILABLE } from '../lib/client/sessionRef.js'
import { read, stripComments, countInClient, assertClientCount } from './_clientSources.mjs'

// ---------------------------------------------------------------------------
// 假实现与固件
// ---------------------------------------------------------------------------

/** 一份合法的专家草稿 payload（`phase`/`contentVersion`/`validation` 由用例覆盖）。 */
function makePayload(overrides = {}) {
  return {
    version: 1,
    contentVersion: 1,
    expertId: 'generated/11111111-2222-3333-4444-555555555555',
    request: '一个会写周报的专家',
    phase: 'editing',
    personaMd: '---\nname: 周报专家\ndescription: 把零散记录整理成周报\n---\n你是周报专家。',
    provenance: {
      version: 1,
      creationKind: 'original',
      sources: [{
        id: 'src-1',
        repository: 'https://example.com/personas.git',
        upstreamPath: 'personas/weekly.md',
        commit: null,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        authors: ['某人'],
        license: 'MIT',
        copyrightNotice: '© 2026 某人',
        licenseFile: 'LICENSE',
        usedFor: ['persona'],
        modifications: '未改动',
      }],
      references: [],
      generationNote: '按方法论自建',
    },
    skills: [{ name: 'weekly-report', required: true, action: 'install', sourceId: 'src-1', packageFiles: [], reason: '写周报要用' }],
    files: [],
    validation: null,
    lastInstallError: null,
    ...overrides,
  }
}

function makeDraft(overrides = {}) {
  return {
    id: 'draft-1',
    kindCode: 'expert',
    sessionId: 'sess-new',
    statusCode: 'pending',
    deferredAt: null,
    deferCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    payload: makePayload(),
    ...overrides,
  }
}

/** 一份"已校验通过"的草稿（确认用例的起点）。 */
function makeValidatedDraft(overrides = {}) {
  return makeDraft({
    payload: makePayload({
      phase: 'validated',
      validation: {
        version: 1,
        manifestHash: 'hash-v1',
        checkedAt: '2026-01-01T00:00:00.000Z',
        errors: [],
        warnings: [],
      },
      ...overrides,
    }),
  })
}

/**
 * **服务端真实形状**：专家域只读视图（平铺 `draftId`，**没有** `id` / `payload`）。
 *
 * 关键：用产品自己的 `expertDraftView()`（`src/experts/drafts.ts:1388`）生成，而不是手搓。
 * 手搓的假响应只能证明"客户端和自己造的假数据一致"，照不到真实契约
 * —— 2026-10-05 P10 真机验收就是这么抓到 P8 的 `draft.id` / `draftId` 错配的
 * （点「开始生成」后第 7 步必失败、提示词永不发出，而 1289 条测试全绿）。
 * 服务端哪天再改字段名，这里跟着改，客户端读不出来会立刻变红。
 */
function makeServerExpertDraftView(payloadOverrides = {}) {
  return expertDraftView({
    id: 'draft-1',
    statusCode: 'pending',
    payload: makePayload(payloadOverrides),
  })
}

/**
 * 记录型假 HTTP：按**真实端点常量**分发，未准备的路径直接抛错（防"悄悄多打了一个请求"）。
 */
function makeCall(handlers) {
  const calls = []
  const call = async (path, init) => {
    const body = init?.body === undefined || init.body === null ? null : JSON.parse(String(init.body))
    calls.push({ path, method: init?.method ?? 'GET', body })
    if (Object.prototype.hasOwnProperty.call(handlers, path) === false) {
      throw new Error(`测试没有为 ${path} 准备假实现`)
    }
    const handler = handlers[path]
    return typeof handler === 'function' ? await handler({ path, init, body }) : handler
  }
  return {
    call,
    calls,
    count: (path) => calls.filter((c) => c.path === path).length,
  }
}

/**
 * 假宿主会话服务 + 记录器。
 *
 * `retain` 是 0.1.7-rc.2+ 的真实取引用路径（见 `src/client/sessionRef.ts` 的文件头）；
 * 假实现里同时挂 `connectWorkspace` 在 ctx 上，用来**证伪**"走了旧的复用路径"。
 */
function makeHost(options = {}) {
  const state = {
    /** 每次 `sessions.create` 的参数（断言"只传 workspaceId、不传 sessionId"）。 */
    createArgs: [],
    createCalls: 0,
    retainArgs: [],
    retainCalls: 0,
    releaseCalls: 0,
    renameCalls: [],
    prompts: [],
    /** 旧路径的调用数（必须恒为 0）。 */
    connectWorkspaceCalls: 0,
    openCalls: [],
    /** 会话列表：`sessions.create` 成功后会把新会话推进来（真实宿主也这样）。 */
    sessions: (options.sessions ?? [{ id: 'blank-1', blank: true, cwd: '/w', displayTitle: '空会话' }]).slice(),
  }
  const host = {
    state,
    runtime: {
      sessions: {
        list: {
          getSnapshot: () => ({
            ids: state.sessions.map((s) => s.id),
            byId: Object.fromEntries(state.sessions.map((s) => [s.id, s])),
          }),
        },
        create: async (opts) => {
          state.createCalls += 1
          state.createArgs.push(opts)
          if (options.createThrows !== undefined) throw options.createThrows
          const id = options.createdId ?? 'sess-new'
          state.sessions.push({ id, blank: false, cwd: opts?.workspaceId ?? '', displayTitle: '新建专家' })
          return id
        },
        retain: (sessionId, retainOptions) => {
          state.retainCalls += 1
          state.retainArgs.push(sessionId)
          void retainOptions
          if (options.acquireFails === true) {
            // 真实语义：引用拿到了，但 binding 读不出来 → acquireSession 自己释放并抛
            return { ready: Promise.resolve(), binding: undefined, release: () => { state.releaseCalls += 1 } }
          }
          return {
            ready: Promise.resolve(),
            release: () => { state.releaseCalls += 1 },
            binding: {
              session: {
                sessionId,
                rename: async (title) => {
                  state.renameCalls.push(title)
                  if (options.renameThrows === true) throw new Error('改名失败')
                  return { ok: true }
                },
                prompt: async (content, mode) => {
                  state.prompts.push({ sessionId, content, mode })
                  if (options.promptFails === true) return { ok: false, error: '队列已满' }
                  if (options.promptThrows === true) throw new Error('发送失败')
                  return { ok: true }
                },
              },
            },
          }
        },
      },
    },
    ctx: {
      uiWorkspace: {
        openSession: (target) => { state.openCalls.push(target) },
        // 旧路径（P8 明令不走）：被调用就会让断言变红。
        connectWorkspace: async (id) => { state.connectWorkspaceCalls += 1; return id },
      },
    },
  }
  return host
}

/** 生成流程的依赖束（`isAlive` 默认恒真）。 */
function makeDeps(host, call, extra = {}) {
  return {
    call,
    runtime: host.runtime,
    ctx: host.ctx,
    isAlive: () => true,
    ...extra,
  }
}

/** 生成流程的默认假服务端（能力 + 方法论 + 登记草稿都成功）。 */
function generationHandlers(draft = makeServerExpertDraftView()) {
  return {
    [EXPERTS_CAPABILITIES_PATH]: { ok: true, generation: { available: true }, skills: { available: true }, manualSummon: { available: true }, autoSummon: { available: true, enabled: false }, providerName: 'skills' },
    [EXPERTS_METHODOLOGY_PATH]: { ok: true, version: 1, text: '# 方法论\n1. 先问清用途\n2. 再写人格文档' },
    [EXPERTS_GENERATION_START_PATH]: { ok: true, draft },
  }
}

// ---------------------------------------------------------------------------
// AX-E52：生成入口 = 新的独立会话；连点拒绝；不复用 blank
// ---------------------------------------------------------------------------

test('AX-E52 点新建走 sessions.create 拿到新身份，不调用 connectWorkspace、不复用已有 blank 会话', async () => {
  const host = makeHost()
  const http = makeCall(generationHandlers())
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))

  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })

  assert.equal(outcome.ok, true, '成功路径必须 ok')
  assert.equal(outcome.code, null)
  assert.equal(outcome.sessionId, 'sess-new', '会话 id 必须来自 sessions.create 的返回值')
  assert.equal(outcome.draftId, 'draft-1')
  assert.equal(outcome.promptSent, true)
  assert.equal(outcome.opened, true)

  // ① 走的是 sessions.create，且**只传 workspaceId**（不传 sessionId ⇒ 不冒充已有会话）
  assert.equal(host.state.createCalls, 1)
  assert.deepEqual(host.state.createArgs[0], { workspaceId: 'ws-1' })
  // ② 旧路径（connectWorkspace）调用数必须是 0
  assert.equal(host.state.connectWorkspaceCalls, 0, '生成入口不许走 connectWorkspace 复用工作区')
  // ③ 取引用 / 发 prompt 都落在**新建的会话**上，blank 会话没被选中
  assert.deepEqual(host.state.retainArgs, ['sess-new'])
  assert.deepEqual(host.state.prompts.map((p) => p.sessionId), ['sess-new'])
  assert.equal(host.state.prompts[0].mode, 'queue', 'prompt 必须用 queue 模式')
  assert.equal(host.state.sessions.some((s) => s.id === 'blank-1'), true, 'blank 会话仍在，没被删/改')
  // ④ 提交前先读能力与方法论（方法论必须早于 create，见 §5.4 第 4 步）
  assert.equal(http.count(EXPERTS_CAPABILITIES_PATH), 1)
  assert.equal(http.count(EXPERTS_METHODOLOGY_PATH), 1)
  const order = http.calls.map((c) => c.path)
  assert.ok(order.indexOf(EXPERTS_METHODOLOGY_PATH) < order.indexOf(EXPERTS_GENERATION_START_PATH), '方法论要在登记草稿之前读到')
  // ⑤ 改名用的是 §5.4 的标题格式（失败也不影响流程）
  assert.deepEqual(host.state.renameCalls, [expertSessionTitle('一个会写周报的专家')])
  // ⑥ 引用一一配对释放
  assert.equal(host.state.releaseCalls, 1, 'acquire 出来的引用必须 release')
})

test('AX-E52 连点两次只有一次在跑：第二次被 busy 拒绝、不发第二个 create', async () => {
  const host = makeHost()
  const http = makeCall(generationHandlers())
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))

  const first = runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })
  const second = runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.code, 'busy', '第二次必须是 busy（本域自持的重入闸门）')
  assert.equal(host.state.createCalls, 1, '只允许建一个生成会话')
  assert.equal(http.count(EXPERTS_GENERATION_START_PATH), 1)
  assert.equal(host.state.prompts.length, 1)
})

test('AX-E52 文本为空时直接拒绝（不发任何请求）', async () => {
  const host = makeHost()
  const http = makeCall(generationHandlers())
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))
  const outcome = await runner.start({ request: '   ', workspaceId: 'ws-1' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'empty-request')
  assert.equal(http.calls.length, 0)
  assert.equal(host.state.createCalls, 0)
})

test('AX-E52 宿主缺 sessions.create 时明确报缺能力，不复用当前会话冒充', async () => {
  const host = makeHost()
  const http = makeCall(generationHandlers())
  const deps = makeDeps(host, http.call)
  // 摘掉 create（真实旧宿主的形状）
  deps.runtime = { sessions: { list: host.runtime.sessions.list } }
  const runner = createExpertGenerationRunner(deps)
  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'create-unavailable')
  assert.match(outcome.message, /sessions\.create/)
  assert.equal(http.calls.length, 0, '缺能力时不该再去试探服务端')
  assert.equal(hasSessionCreate({ sessions: {} }), false)
  assert.equal(hasSessionCreate(host.runtime), true)
})

// ---------------------------------------------------------------------------
// AX-E53：五处失败各自可读、release 到位、已有会话不被误删
// ---------------------------------------------------------------------------

test('AX-E53 create 失败：可读错误 + 会话列表不变 + 同一个 runner 可以重试', async () => {
  const host = makeHost({ createThrows: new Error('宿主 RPC 挂了') })
  const http = makeCall(generationHandlers())
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))
  const before = host.state.sessions.length

  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'create-failed')
  assert.match(outcome.message, /宿主 RPC 挂了/)
  assert.equal(host.state.sessions.length, before, '失败不许增删已有会话')
  assert.equal(host.state.releaseCalls, 0, '还没拿到引用，就没有可 release 的东西')
  assert.equal(http.count(EXPERTS_GENERATION_START_PATH), 0)
  // "草稿可继续"：失败后 busy 必须已经放掉，能再点一次
  assert.equal(runner.busy, false)
})

test('AX-E53 acquire 失败：可读错误 + 引用已被释放 + 已有会话仍在', async () => {
  const host = makeHost({ acquireFails: true })
  const http = makeCall(generationHandlers())
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))
  const before = host.state.sessions.map((s) => s.id)

  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'acquire-failed')
  assert.equal(outcome.sessionId, 'sess-new', '会话已经建出来了，必须回报 id 供"打开生成会话"')
  assert.equal(host.state.releaseCalls, 1, 'acquireSession 内部必须把拿到的引用释放掉')
  assert.deepEqual(host.state.sessions.map((s) => s.id), [...before, 'sess-new'], '新建的会话留在列表里，不删')
  assert.equal(http.count(EXPERTS_GENERATION_START_PATH), 0)
})

test('AX-E53 generation-start 失败：可读错误 + 草稿未建但会话保留 + release 一次', async () => {
  const host = makeHost()
  const http = makeCall({
    ...generationHandlers(),
    [EXPERTS_GENERATION_START_PATH]: () => { throw new Error('服务端 500') },
  })
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))

  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'generation-start-failed')
  assert.match(outcome.message, /服务端 500/)
  assert.equal(outcome.draftId, null)
  assert.equal(host.state.releaseCalls, 1)
  assert.equal(host.state.sessions.some((s) => s.id === 'sess-new'), true, '已有会话不能被误删')
  assert.equal(host.state.prompts.length, 0, '登记失败就不该再发 prompt')
})

test('AX-E53 prompt 失败：保留草稿与会话 id（可"打开生成会话/继续修改"）+ release 一次', async () => {
  const host = makeHost({ promptFails: true })
  const http = makeCall(generationHandlers())
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))

  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'prompt-failed')
  assert.equal(outcome.sessionId, 'sess-new')
  assert.equal(outcome.draftId, 'draft-1')
  assert.equal(outcome.draft?.id, 'draft-1')
  assert.equal(outcome.promptSent, false)
  assert.equal(host.state.releaseCalls, 1)
  assert.equal(host.state.sessions.some((s) => s.id === 'sess-new'), true)
})

test('AX-E53 open 失败：提示可以从草稿里打开会话，草稿与会话都保留', async () => {
  const host = makeHost()
  const http = makeCall(generationHandlers())
  // ctx 里没有 uiWorkspace.openSession、也没有 sessions.open ⇒ openSessionInMainView 必抛
  const runner = createExpertGenerationRunner({ ...makeDeps(host, http.call), ctx: {} })

  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'open-failed')
  assert.match(outcome.message, /打开生成会话/)
  assert.equal(outcome.promptSent, true, 'prompt 已经发出去了，这条事实不能被吞')
  assert.equal(outcome.draftId, 'draft-1')
  assert.equal(host.state.releaseCalls, 1)
  assert.equal(host.state.openCalls.length, 0)
  // 打开会话的唯一实现给的错误文案必须被沿用（不是另写一句）
  assert.match(SESSION_OPEN_UNAVAILABLE, /uiWorkspace\.openSession/)
})

test('AX-E53 isAlive 变假（面板已关）时中止：未取引用就中止不建会话，已取引用必须 finally release', async () => {
  // (a) 面板已经关了：连会话都不该建（用户没在等一个新会话），也没有引用可释放。
  const deadHost = makeHost()
  const deadHttp = makeCall(generationHandlers())
  const deadRunner = createExpertGenerationRunner({
    ...makeDeps(deadHost, deadHttp.call),
    isAlive: () => false,
  })
  const dead = await deadRunner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })
  assert.equal(dead.ok, false)
  assert.equal(dead.code, 'aborted')
  assert.equal(deadHost.state.createCalls, 0, '中止在 create 之前：不建会话')
  assert.equal(deadHost.state.releaseCalls, 0, '还没 acquire 过，没有可释放的引用')

  // (b) 中止发生在"已经 acquire、prompt 还没发"之间：引用必须被 finally 放掉，prompt 不许发。
  const host = makeHost()
  let alive = true
  const http = makeCall({
    ...generationHandlers(),
    [EXPERTS_GENERATION_START_PATH]: () => {
      alive = false
      return { ok: true, draft: makeServerExpertDraftView() }
    },
  })
  const deps = { ...makeDeps(host, http.call), isAlive: () => alive }
  const runner = createExpertGenerationRunner(deps)
  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'aborted')
  assert.equal(host.state.releaseCalls, 1, '中止路径同样必须 release')
  assert.equal(host.state.prompts.length, 0, '中止之后不许再发 prompt')
  assert.equal(outcome.draftId, 'draft-1', '草稿已经在服务端登记，必须如实交回，不许丢')
})

// ---------------------------------------------------------------------------
// AX-E54：草稿四态的按钮/文案 + 确认 payload（所见即所确认）
// ---------------------------------------------------------------------------

test('AX-E54 四种草稿状态的按钮/文案判定（纯函数）', () => {
  const editing = expertDraftButtons('editing', false, null)
  assert.equal(editing.validate.enabled, true)
  assert.equal(editing.confirm.enabled, false, 'editing 阶段确认必须禁用')
  assert.equal(editing.editWithAi.enabled, true, 'editing 阶段可以继续让 AI 修改')
  assert.equal(editing.confirm.label, '确认安装专家')

  const validated = expertDraftButtons('validated', false, null)
  assert.equal(validated.validate.enabled, true)
  assert.equal(validated.confirm.enabled, true, 'validated 阶段才能确认安装')

  const installing = expertDraftButtons('installing', false, null)
  assert.equal(installing.validate.enabled, false)
  assert.equal(installing.confirm.enabled, false, 'installing 阶段必须禁用（防重复安装）')
  assert.equal(installing.editWithAi.enabled, false)
  assert.equal(installing.notice, '安装中…（完成后这里会变成已安装）')

  const failed = expertDraftButtons('install-failed', false, null)
  assert.equal(failed.validate.enabled, true, 'install-failed 允许重新校验后重试')
  assert.equal(failed.confirm.enabled, false, '没重新校验通过之前不给确认')

  const busy = expertDraftButtons('validated', true, null)
  assert.equal(busy.confirm.enabled, false, '域 busy 时一律禁用')

  const broken = expertDraftButtons('unknown', false, null)
  assert.equal(broken.validate.enabled, false)
  assert.equal(broken.confirm.enabled, false)

  const withError = expertDraftButtons('validated', false, { code: 'install-in-progress', message: '正在安装' })
  assert.equal(withError.errorCode, 'install-in-progress')
  assert.equal(withError.confirm.enabled, false, '有稳定错误码时不给确认')

  // §9.4 禁止假文案
  const allLabels = [editing, validated, installing, failed, broken].flatMap((b) => [b.validate.label, b.confirm.label, b.editWithAi.label])
  assert.equal(allLabels.some((label) => label.includes('创建任务')), false, '专家草稿不许出现"创建任务"')
})

test('AX-E54 确认 body 恰好是 { expectedVersion, manifestHash }，且等于界面上看到的那一版', async () => {
  const host = makeHost()
  const expertResult = { kind: 'expert', draftId: 'draft-1', expertId: 'generated/x', manifestHash: 'hash-v1', installedAt: '2026-01-01T00:00:00.000Z', installedSkills: ['weekly-report'], reusedSkills: [], warnings: [] }
  const draft = makeValidatedDraft()
  const http = makeCall({
    [expertDraftConfirmPath('draft-1')]: { ok: true, expert: expertResult, replayed: false },
  })
  const ops = createExpertDraftOps(makeDeps(host, http.call))

  const outcome = await ops.confirm(draft)

  assert.equal(outcome.ok, true)
  assert.equal(http.calls.length, 1, '确认只发一个请求')
  assert.equal(http.calls[0].method, 'POST')
  assert.deepEqual(http.calls[0].body, { expectedVersion: 1, manifestHash: 'hash-v1' }, 'body 必须恰好这两个字段')
  assert.deepEqual(outcome.sent, { expectedVersion: 1, manifestHash: 'hash-v1' })
  assert.equal(outcome.expert?.installedSkills.join(','), 'weekly-report')
  assert.equal(outcome.replayed, false)
  assert.equal(outcome.refreshed, null)
})

test('AX-E54 版本/阶段对不上时**不发请求**（防止"确认的不是看到的那一版"）', async () => {
  const host = makeHost()
  const http = makeCall({})
  const ops = createExpertDraftOps(makeDeps(host, http.call))

  const editing = await ops.confirm(makeDraft())
  assert.equal(editing.code, 'draft-not-validated')
  assert.equal(editing.sent, null)

  const stale = makeValidatedDraft({ validation: { version: 0, manifestHash: 'hash-v0', checkedAt: 'x', errors: [], warnings: [] } })
  const staleOutcome = await ops.confirm(stale)
  assert.equal(staleOutcome.code, 'draft-not-validated', '校验快照版本与 contentVersion 不一致时必须拒绝')
  assert.equal(http.calls.length, 0, '一次请求都不该发出去')

  const installing = await ops.confirm(makeDraft({ payload: makePayload({ phase: 'installing' }) }))
  assert.equal(installing.code, 'install-in-progress')
  assert.equal(http.calls.length, 0)
})

test('AX-E54 校验 body 恰好 { expectedVersion }，校验问题回传成可读中文', async () => {
  const host = makeHost()
  const draft = makeDraft()
  // 服务端回的是平铺视图（`draftId` 在顶层）——真实形状由产品自己的 expertDraftView() 生成。
  const nextDraft = makeServerExpertDraftView({
    contentVersion: 2,
    phase: 'editing',
    validation: { version: 2, manifestHash: 'hash-v2', checkedAt: 'x', errors: [{ code: 'persona-md-missing', field: 'personaMd', message: '缺少人格文档正文' }], warnings: [] },
  })
  const http = makeCall({ [expertDraftValidatePath('draft-1')]: { ok: true, draft: nextDraft } })
  const ops = createExpertDraftOps(makeDeps(host, http.call))

  const outcome = await ops.validate(draft)

  assert.equal(http.calls[0].method, 'POST')
  assert.deepEqual(http.calls[0].body, { expectedVersion: 1 }, '校验只带 expectedVersion')
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.problems, ['缺少人格文档正文'])
  assert.equal(outcome.draft?.payload?.contentVersion, 2)
})

test('AX-E54 草稿 payload 读不出来时给稳定 code，不让界面崩在字段上', () => {
  assert.equal(readExpertDraftPayload(null).code, 'draft-invalid-payload')
  assert.equal(readExpertDraftPayload(makeDraft({ payload: null })).code, 'draft-invalid-payload')
  assert.equal(readExpertDraftPayload(makeDraft({ payload: { contentVersion: 'v1' } })).code, 'draft-invalid-payload')
  assert.equal(readExpertDraftPayload(makeDraft({ payload: { contentVersion: 1, phase: '胡说' } })).code, 'draft-invalid-payload')
  const ok = readExpertDraftPayload(makeValidatedDraft())
  assert.equal(ok.ok, true)
  assert.equal(ok.payload.contentVersion, 1)
  assert.equal(isExpertDraft(makeDraft()), true)
  assert.equal(isExpertDraft(makeDraft({ kindCode: 'task' })), false)
  assert.equal(isExpertDraft(null), false)
})

test('AX-E54 专家草稿横幅不出现"创建任务"（源码级：四态按钮只来自纯函数）', () => {
  const draftBody = stripComments(read('src/client/components/ExpertDraftBody.tsx'))
  assert.equal(draftBody.includes('创建任务'), false, 'ExpertDraftBody 不许出现假文案')
  assert.match(draftBody, /data-wb-expert-action="validate"/)
  assert.match(draftBody, /data-wb-expert-action="confirm"/)
  assert.match(draftBody, /data-wb-expert-draft=/)
  assert.match(draftBody, /data-wb-expert-version=/)
})

// ---------------------------------------------------------------------------
// AX-E55：看到 v1、服务端到 v2 ⇒ 409 分支 + 刷新预览 + 不自动确认
// ---------------------------------------------------------------------------

test('AX-E55 确认时服务端已经往前走了一版：版本冲突 → 刷新预览，且**没有**第二次确认', async () => {
  const host = makeHost()
  // 服务端那一份已经走到 v2（AI 又改过一版）——**直接构造真实形状**：
  // 不能把 { payload } 传给 makeValidatedDraft（那样会展开成 payload.payload，等于没改版本）。
  const serverDraft = makeServerExpertDraftView({
    contentVersion: 2,
    phase: 'editing',
    validation: { version: 1, manifestHash: 'hash-v1', checkedAt: 'x', errors: [], warnings: [] },
  })
  const http = makeCall({
    [expertDraftConfirmPath('draft-1')]: () => { throw new Error('HTTP 409（草稿版本冲突）') },
    [expertDraftDetailPath('draft-1')]: { ok: true, draft: serverDraft, drift: null },
  })
  const ops = createExpertDraftOps(makeDeps(host, http.call))

  const outcome = await ops.confirm(makeValidatedDraft())

  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'version-conflict')
  assert.match(outcome.message, /预览已刷新/)
  assert.notEqual(outcome.refreshed, null, '必须把最新草稿交出来给界面刷新预览')
  assert.equal(outcome.refreshed.payload.contentVersion, 2)
  assert.equal(outcome.sent?.expectedVersion, 1, '发出去的仍是用户看到的那一版')
  assert.equal(http.count(expertDraftConfirmPath('draft-1')), 1, '确认只发一次：绝不自动确认新版本')
  assert.equal(http.count(expertDraftDetailPath('draft-1')), 1, '失败后只重读一次草稿')
})

test('AX-E55 确认失败但不是版本冲突：按普通失败返回，仍不复用新版本', async () => {
  const host = makeHost()
  const http = makeCall({
    [expertDraftConfirmPath('draft-1')]: () => { throw new Error('网络断了') },
    [expertDraftDetailPath('draft-1')]: {
      ok: true,
      draft: makeServerExpertDraftView({ phase: 'validated', validation: { version: 1, manifestHash: 'hash-v1', checkedAt: 'x', errors: [], warnings: [] } }),
      drift: null,
    },
  })
  const ops = createExpertDraftOps(makeDeps(host, http.call))
  const outcome = await ops.confirm(makeValidatedDraft())
  assert.equal(outcome.code, 'confirm-failed')
  assert.match(outcome.message, /网络断了/)
  assert.equal(outcome.refreshed?.payload.contentVersion, 1, '版本没变就只是普通失败')
  assert.equal(http.count(expertDraftConfirmPath('draft-1')), 1)
})

test('AX-E55 安装安装中（installing）时重复确认被拒，不再打服务端', async () => {
  const host = makeHost()
  const http = makeCall({})
  const ops = createExpertDraftOps(makeDeps(host, http.call))
  const outcome = await ops.confirm(makeDraft({ payload: makePayload({ phase: 'installing', validation: { version: 1, manifestHash: 'hash-v1', checkedAt: 'x', errors: [], warnings: [] } }) }))
  assert.equal(outcome.code, 'install-in-progress')
  assert.equal(http.calls.length, 0)
})

// ---------------------------------------------------------------------------
// AX-E56：安装后重读目录 / required 缺失 / 坏文件行
// ---------------------------------------------------------------------------

test('AX-E56 安装成功后重读目录（假 fetch 记录调用次数）并说出实际装了什么', async () => {
  const http = makeCall({
    '/api/workbench/experts/catalog': { ok: true, experts: [], personas: [], diagnostics: [], skillsAvailable: true, preliminary: false },
  })
  const store = createExpertCatalogStore({
    call: http.call,
    onLoaded: () => undefined,
    onError: (error) => { throw new Error(`不该报错：${error.message}`) },
  })
  assert.equal(store.loadCount(), 0)

  const notices = []
  await refreshExpertCatalogAfterInstall({
    refresh: () => store.load(),
    onNotice: (message) => notices.push(message),
    expert: { installedSkills: ['weekly-report'], reusedSkills: ['doc-export'], warnings: [{ code: 'w', field: 'f', message: 'w' }] },
  })

  assert.equal(store.loadCount(), 1, '安装成功必须重读一次目录')
  assert.equal(http.count('/api/workbench/experts/catalog'), 1)
  assert.match(notices[0], /新增 skill：weekly-report/)
  assert.match(notices[0], /复用：doc-export/)
  assert.match(notices[0], /1 条警告/)
  assert.match(notices[0], /列表已按真实状态刷新/)
})

test('AX-E56 目录读取：重复调用各自计数，读失败给可读错误且不抛', async () => {
  const http = makeCall({ '/api/workbench/experts/catalog': () => { throw new Error('503 服务未装配') } })
  const errors = []
  const store = createExpertCatalogStore({ call: http.call, onLoaded: () => undefined, onError: (error) => errors.push(error) })
  const first = await store.load()
  const second = await store.load()
  assert.equal(first, null)
  assert.equal(second, null)
  assert.equal(store.loadCount(), 2, '失败也计数：界面要能显示"试过两次"')
  assert.equal(errors.length, 2)
  assert.equal(errors[0].code, 'catalog-load-failed')
  assert.match(errors[0].message, /503 服务未装配/)
})

/** 造一行目录数据（默认 usable）。 */
function makeRow(overrides = {}) {
  return {
    id: 'builtin/weekly',
    name: '周报专家',
    description: '把零散记录整理成周报',
    group: '写作',
    source: 'builtin',
    sourceKey: 'builtin',
    revision: 'r1',
    enabled: true,
    favorite: false,
    status: 'usable',
    issues: [],
    provenance: null,
    provenanceState: 'unrecorded',
    requiredSkills: [{ name: 'weekly-report', available: true, provider: 'pi-skill-hub', preliminary: false }],
    ...overrides,
  }
}

test('AX-E56 required 缺失的行：管理页可见、选择器不可选，且原因可读', () => {
  const missing = makeRow({
    id: 'user/broken-dep',
    name: '依赖缺失的专家',
    source: 'user',
    sourceKey: 'generated/xxx',
    status: 'dependency-unavailable',
    issues: [{ code: 'required-skill-missing', field: 'requiredSkills', message: '必需 skill「weekly-report」不可用' }],
    requiredSkills: [{ name: 'weekly-report', available: false, provider: null, preliminary: true }],
  })
  const usable = makeRow({ id: 'builtin/ok', name: '可用的专家' })
  const manual = { id: 'manual/pre-p8', name: '手工角色', description: '', descriptionTruncated: false, group: '', mode: 'normal', emoji: '', source: 'user', sourceKey: 'manual', enabled: true, favorite: false, revision: null }
  const catalog = {
    ...EMPTY_EXPERT_CATALOG,
    experts: [missing, usable],
    personas: [
      { id: missing.id, name: missing.name, description: missing.description, descriptionTruncated: false, group: '写作', mode: 'normal', emoji: '', source: 'user', sourceKey: 'x', enabled: true, favorite: false, revision: null },
      { id: usable.id, name: usable.name, description: usable.description, descriptionTruncated: false, group: '写作', mode: 'normal', emoji: '', source: 'builtin', sourceKey: 'builtin', enabled: true, favorite: false, revision: 'r1' },
      manual,
    ],
  }

  // 管理页：坏行仍在（不过滤），且原因可读
  const adminRows = expertAdminRows(catalog, '', 'all')
  assert.deepEqual(adminRows.map((row) => row.id), [missing.id, usable.id])
  const view = expertRowView(missing)
  assert.equal(view.selectable, false)
  assert.equal(view.issueLines.length, 1)
  assert.match(view.issueLines[0], /必需 skill/)
  assert.equal(view.skillLines[0], 'weekly-report：不可用（预检视角）')
  assert.equal(expertAdminRows(catalog, '', 'dependency-unavailable').length, 1, '状态筛选要能筛出它')
  assert.equal(expertAdminRows(catalog, '周报', 'all').length, 2, '搜索按名字/简介命中')

  // 选择器：依赖缺失的不进去；**没有对应行的手工角色仍可选**（AX-E56 明确要求）
  const picker = expertPickerPersonas(catalog)
  assert.deepEqual(picker.map((p) => p.id).sort(), [manual.id, usable.id].sort())
})

test('AX-E56 坏文件行：显示名兜底、来源未登记可读、绝对路径绝不回显', () => {
  const broken = makeRow({
    id: 'external/abs',
    name: '',
    source: 'external',
    sourceKey: 'D:\\Users\\me\\.dsh\\personas\\external\\team',
    status: 'invalid',
    provenanceState: 'invalid',
    issues: [{ code: 'persona-parse-failed', field: 'personaMd', message: '无法解析 frontmatter（缺 --- 分隔）' }],
  })
  const view = expertRowView(broken)
  assert.equal(view.name, broken.id, '没有 name 时用逻辑 id 当显示名')
  assert.equal(view.sourceKeyLabel, '外部目录 · team', '外部目录只显示末段目录名')
  assert.equal(view.sourceKeyLabel.includes('D:'), false)
  assert.equal(view.sourceKeyLabel.includes('\\'), false)
  assert.equal(view.issueLines[0], '无法解析 frontmatter（缺 --- 分隔）')
  assert.equal(view.selectable, false)
  assert.equal(safeSourceKeyLabel('builtin', 'D:\\secret\\builtin'), '内置')
  assert.equal(safeSourceKeyLabel('external', '/home/me/personas/team'), '外部目录 · team')
  assert.equal(EXPERT_STATUS_LABELS['installation-incomplete'].length > 0, true)
})

test('AX-E56 管理页来源行不重复、内置角色不显示"来源未登记"警告（列表可读性回归）', () => {
  const builtin = expertRowView(makeRow())
  assert.equal(builtin.sourceLabel, '内置')
  assert.equal(builtin.sourceKeyLabel, '', '内置的来源键与来源是同一个词，不再重复显示')
  assert.equal(builtin.provenanceLabel, '', '内置角色本来就没有上游来源，不当作"来源未登记"警告')
  const manual = expertRowView(makeRow({ id: 'user/manual', source: 'user', sourceKey: 'manual' }))
  assert.equal(manual.sourceKeyLabel, '', '用户库的 sourceKeyLabel 与 sourceLabel 相同，不重复')
  assert.match(manual.provenanceLabel, /来源未登记/, '用户手工放进来的角色仍保留可追溯性提示')
  const external = expertRowView(makeRow({ source: 'external', sourceKey: 'D:\\personas\\team' }))
  assert.equal(external.sourceKeyLabel, '外部目录 · team', '外部目录仍显示末段目录名')
})

test('专家草稿预览是两列网格，根不再复用 .wb-draft-field（2026-10-18 横向挤成一字一行的回归）', () => {
  const body = stripComments(read('src/client/components/ExpertDraftBody.tsx'))
  assert.match(body, /className="wb-expert-draft"/)
  assert.doesNotMatch(body, /className="wb-draft-field"/, '根不能再是 flex 行容器')
  const styles = stripComments(read('src/client/styles.ts'))
  assert.match(styles, /\.wb-expert-draft\s*\{[^}]*display:\s*grid/, '两列网格是布局的唯一来源')
  assert.match(styles, /grid-template-columns:\s*76px minmax\(0,\s*1fr\)/)
  assert.match(styles, /\.wb-expert-draft\s*>\s*:not\(\.wb-draft-field-k\):not\(\.wb-draft-field-v\)/, '说明/按钮行要横跨两列')
})

test('角色库/专家 UI 不把 Markdown 粗体标记直接渲染成星号（源码级）', () => {
  const files = [
    'src/client/components/PersonaAdmin.tsx',
    'src/client/components/ExpertCreateModal.tsx',
    'src/client/components/ExpertDraftBody.tsx',
    'src/client/components/DraftBanner.tsx',
    'src/client/components/CapacityRulePanel.tsx',
    'src/client/components/SettingsModal.tsx',
    'src/client/app/WorkbenchOverlays.tsx',
  ]
  const offenders = []
  for (const file of files) {
    const text = stripComments(read(file))
    if (text.includes('**')) offenders.push(file)
  }
  assert.deepEqual(offenders, [], '纯文本 UI 里出现 ** 会原样显示成星号')
})

test('AX-E56 安装回执 reader：形状不对返回 null，不硬编类型', () => {
  assert.equal(readExpertInstalledFromOutcome({}), null)
  assert.equal(readExpertInstalledFromOutcome(null), null)
  assert.equal(readExpertInstalledFromOutcome({ expert: null }), null)
  const expert = { kind: 'expert', draftId: 'd', expertId: 'e', manifestHash: 'h', installedAt: 't', installedSkills: [], reusedSkills: [], warnings: [] }
  assert.equal(readExpertInstalledFromOutcome({ expert })?.expertId, 'e')
})

// ---------------------------------------------------------------------------
// AX-E57：auto 开关失败回滚；flag 立即保存（源码级）
// ---------------------------------------------------------------------------

test('AX-E57 自主召唤开关保存失败：界面值回滚到服务端真值 + 给出可读错误', async () => {
  let server = true
  const controller = createAutoSummonController({
    readServerValue: () => server,
    writeServerValue: (next) => { server = next },
    save: async () => { throw new Error('设置写入被拒') },
  })
  assert.equal(controller.value(), true)

  const ok = await controller.set(false)

  assert.equal(ok, false)
  assert.equal(controller.value(), true, '失败必须回滚成服务端真值，不能停在用户点的那个值上')
  assert.equal(controller.error()?.code, 'auto-summon-save-failed')
  assert.match(controller.error()?.message ?? '', /设置写入被拒/)
  assert.equal(controller.busy(), false)
})

test('AX-E57 自主召唤开关保存成功：写回设置域真值（避免下次"保存设置"改回旧值）', async () => {
  let server = false
  const written = []
  const saved = []
  const controller = createAutoSummonController({
    readServerValue: () => server,
    writeServerValue: (next) => { written.push(next); server = next },
    save: async (next) => { saved.push(next) },
  })
  assert.equal(controller.value(), false, '默认关')

  const ok = await controller.set(true)

  assert.equal(ok, true)
  assert.deepEqual(saved, [true])
  assert.deepEqual(written, [true])
  assert.equal(controller.value(), true)
  assert.equal(controller.error(), null)
})

test('AX-E57 保存中重复点击被拒（只发一次保存）', async () => {
  let resolveSave
  const saved = []
  const controller = createAutoSummonController({
    readServerValue: () => false,
    writeServerValue: () => undefined,
    save: (next) => { saved.push(next); return new Promise((resolve) => { resolveSave = resolve }) },
  })
  const first = controller.set(true)
  const second = controller.set(false)
  assert.equal(await second, false, 'busy 时第二次直接拒绝')
  resolveSave()
  assert.equal(await first, true)
  assert.deepEqual(saved, [true])
})

test('AX-E57 收藏/停用仍"立即保存"、外部目录仍只在"保存设置"时提交（源码级）', () => {
  const aiSessions = stripComments(read('src/client/hooks/useWorkbenchAISessions.ts'))
  void aiSessions
  const experts = stripComments(read('src/client/hooks/useWorkbenchExperts.ts'))
  // 收藏/停用：三步（读现值 → personaFlagPatch → POST → 重读目录）都在专家域里
  const flagStart = experts.indexOf('const writePersonaFlag')
  assert.ok(flagStart > 0, 'writePersonaFlag 必须在专家域里')
  const flagBody = experts.slice(flagStart, experts.indexOf('const toggleFavorite', flagStart))
  assert.match(flagBody, /personaFlagPatch\(/)
  assert.match(flagBody, /method: 'POST'/, 'flag 改动必须立即 POST（旧口径：立即保存）')
  assert.match(flagBody, /await loadCatalog\(\)/, '保存后要重读目录显示服务端事实')

  // 外部目录：仍只由设置域的「保存设置」提交（组件里有输入框，但**没有**立即保存）
  const settingsModal = stripComments(read('src/client/components/SettingsModal.tsx'))
  assert.match(settingsModal, /personaExternalDir/, '外部目录输入框仍在设置弹窗里')
  assert.equal(/personaExternalDir[\s\S]{0,400}?method: 'POST'/.test(settingsModal), false, '外部目录不许出现"改一下就 POST"的立即保存')
  const personAdmin = stripComments(read('src/client/components/PersonaAdmin.tsx'))
  assert.equal(personAdmin.includes('personaExternalDir'), false, '角色库页不再持有外部目录输入（它归设置域）')
})

// ---------------------------------------------------------------------------
// AX-E58：装配层不变量（源码级）+ 旧分派不回归
// ---------------------------------------------------------------------------

/** 取出 `function WorkbenchApp(...) { ... }` 的函数体（跳过参数表里的对象类型花括号）。 */
function workbenchAppBody() {
  const source = stripComments(read('src/client/index.tsx'))
  const start = source.indexOf('function WorkbenchApp')
  assert.ok(start > 0, '必须能找到 WorkbenchApp')
  let depth = 0
  let bodyStart = -1
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) { bodyStart = source.indexOf('{', i); break }
    }
  }
  assert.ok(bodyStart > 0, '必须能找到 WorkbenchApp 的函数体')
  depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error('WorkbenchApp 函数体没有闭合')
}

test('AX-E58 WorkbenchApp 体内零 useState / 零网络 / 零定时器，只装配一次专家域 hook', () => {
  const body = workbenchAppBody()
  const count = (re) => (body.match(re) ?? []).length
  assert.equal(count(/useState\(/g), 0, 'WorkbenchApp 里不许再有业务 state（全归各域 hook）')
  assert.equal(count(/useRef</g), 2, '只允许两个惰性转发 ref：AI 会话入口（既有）+ 专家安装回调（本批，:187）')
  assert.equal(count(/setInterval\(/g), 0, '不许在装配层自起轮询')
  assert.equal(count(/fetch\(/g), 0)
  assert.equal(count(/[^a-zA-Z]api\(/g), 0, '装配层不许自己发请求')
  assert.equal(count(/useWorkbenchExperts\(/g), 1, '专家域只装配一次')
})

test('AX-E58 inject 逐字不变：客户端 5 项、顶层 4 项', () => {
  const capabilities = read('src/client/capabilities.ts')
  assert.match(capabilities, /export const inject = \['sessions', 'workspaces', 'connection', 'slots', 'layout'\] as const/)
  const top = read('src/index.ts')
  assert.match(top, /export const inject = \['webServer', 'systemPrompt', 'tools', 'commands'\]/)
  // 第二段 inputTriggers 注入只允许一处（P7 §9 第 9 条）。真实写法是
  // `injector.call(ctx, ['inputTriggers'], cb)`（expertInputSource.ts），所以断言字面量本身只许出现一次。
  assertClientCount(assert, /\['inputTriggers'\]/g, 1, '客户端只允许一处 inputTriggers 子 fiber 注入')
  assert.equal(
    /injector\.call\(ctx, \['inputTriggers'\]/.test(read('src/client/expertInputSource.ts')),
    true,
    '那一处注入必须仍然是 P7 的子 fiber 软注入，且全客户端没有第二处 ctx.inject([...])',
  )
  assertClientCount(assert, /ctx\.inject\(/g, 0, '客户端不许新增任何 ctx.inject(...) 硬注入（能力一律子 fiber 软注入）')
})

test('AX-E58 稳定 data 属性按 §12.3 唯一实现（递归覆盖整个 src/client）', () => {
  assertClientCount(assert, /data-wb-experts="admin"/g, 1, '管理区域只能有一处')
  assertClientCount(assert, /data-wb-experts="create-modal"/g, 1, '创建弹窗只能有一处')
  assertClientCount(assert, /data-wb-expert-action="create"/g, 1, '新建按钮只能有一处')
  assertClientCount(assert, /data-wb-expert-action="start-generation"/g, 1, '创建提交只能有一处')
  assertClientCount(assert, /data-wb-expert-action="validate"/g, 1, '校验按钮只能有一处')
  assertClientCount(assert, /data-wb-expert-action="confirm"/g, 1, '确认按钮只能有一处')
  assertClientCount(assert, /data-wb-expert-field="request"/g, 1, '需求输入只能有一处')
  assertClientCount(assert, /data-wb-expert-field="workspace"/g, 1, '工作区选择只能有一处')
  assertClientCount(assert, /data-wb-expert-field="auto-summon"/g, 1, '自主召唤开关只能有一处')
  for (const pattern of [/data-wb-expert-id=/g, /data-wb-expert-status=/g, /data-wb-expert-draft=/g, /data-wb-expert-version=/g, /data-wb-expert-error=/g]) {
    const { total, hits } = countInClient(pattern)
    assert.ok(total >= 1, `${pattern.source} 必须至少有一处（实际：${hits.join('、') || '无'}）`)
  }
})

test('AX-E58 旧的 /personas 目录拉取已消失，专家目录只有一个所有者', () => {
  // 旧的角色列表端点：除 /personas/bind 外，客户端不该再有人拉
  assertClientCount(assert, /\/api\/workbench\/personas(?!\/bind)/g, 0, 'PersonaAdmin / PersonaPicker 不许再拉旧列表')
  // 专家目录端点常量只在"定义处 + 专家域"里出现（不许第二处字面量）
  assertClientCount(assert, /EXPERTS_CATALOG_PATH/g, 4, '目录端点只允许在 expertInputSource(定义+沿用) 与专家域(hook+store)里出现')
  assertClientCount(assert, /EXPERTS_PREFLIGHT_PATH/g, 5, '预检端点只允许在定义处、专家域 reader、AI 会话入口守卫里出现')
  // 两处 preflight 必须是同一份实现
  assertClientCount(assert, /fetchExpertPreflight\(/g, 2, 'preflight 取数只有一处实现 + 一处调用')
  assertClientCount(assert, /expertPersonaPreflightError\(/g, 2, 'preflight 判定只有一处实现 + 一处调用')
  assertClientCount(assert, /useWorkbenchExperts\(/g, 2, '专家域 hook：定义 + 装配各一处')
})

test('AX-E58 入口守卫在同一份 preflight 之后才绑定，且失败时不拦普通角色（源码级）', () => {
  const source = stripComments(read('src/client/hooks/useWorkbenchAISessions.ts'))
  const preflight = source.indexOf('fetchExpertPreflight(api')
  const bind = source.indexOf("'/api/workbench/personas/bind'")
  assert.ok(preflight > 0, 'AI 会话入口必须调同一份 preflight')
  assert.ok(bind > 0, '绑定调用必须还在')
  assert.ok(preflight < bind, 'preflight 必须在 bind **之前**')
  // 只加守卫：绑定后的校验与"不发送 prompt"语义逐字保留
  assert.match(source, /bound\?\.binding\?\.personaId !== personaId/)
  assert.equal(source.includes('换角色'), false, '不许引入"换角色新会话"规则')
})

test('AX-E58 preflight 投影：形状不对不拦人，明确不可用才给中文原因（含当前 summary）', () => {
  const okView = readExpertPreflight({ ok: true, personaId: 'builtin/x', usable: true, issues: [], preliminary: true }, 'builtin/x')
  assert.equal(okView.usable, true)
  assert.equal(expertPersonaPreflightError(okView), null, '可用（哪怕是预检视角）不拦')

  const bad = readExpertPreflight({ ok: true, personaId: 'builtin/x', usable: false, code: 'required-skill-missing', summary: '「weekly-report」不可用', issues: [{ code: 'x', field: 'f', message: 'm' }] }, 'builtin/x')
  const message = expertPersonaPreflightError(bad)
  assert.match(message, /builtin\/x/)
  assert.match(message, /required-skill-missing/)
  assert.match(message, /weekly-report/, '要取 preflight 返回的当前值（summary），不是目录里那份旧值')
  assert.equal(message.includes('没有发送 prompt'), true)

  // 形状不对 / 换了人 ⇒ null（调用方据此"不拦"）
  assert.equal(readExpertPreflight(null, 'builtin/x'), null)
  assert.equal(readExpertPreflight({ ok: true }, 'builtin/x'), null)
  assert.equal(readExpertPreflight({ ok: true, personaId: 'other/y', usable: false }, 'builtin/x'), null)
  assert.equal(readExpertPreflight({ ok: true, personaId: 'builtin/x', usable: 'no' }, 'builtin/x'), null)
})

test('AX-E58 task / knowledge 等旧草稿分派没被专家分支改写', () => {
  const drafts = stripComments(read('src/client/hooks/useWorkbenchDrafts.ts'))
  const expertBranch = drafts.indexOf('readExpertInstalledFromOutcome(outcome)')
  const duplicate = drafts.indexOf('outcome.duplicateOf !== undefined')
  const replayed = drafts.indexOf('outcome.replayed === true')
  const reused = drafts.indexOf('outcome.reused === true')
  assert.ok(expertBranch > 0, '专家分支必须在草稿确认回执里')
  assert.ok(expertBranch < duplicate && duplicate < replayed && replayed < reused, '专家分支在前，其余三种旧回执顺序不变')
  assert.match(drafts, /setDuplicatePrompt\(/)
  assert.match(drafts, /这条草稿此前已经确认过了/)
  assert.match(drafts, /已按你选的「就用已有那条」收口/)

  const banner = stripComments(read('src/client/components/DraftBanner.tsx'))
  for (const kind of ['idea_cluster', 'idea_tasks', 'knowledge', 'report', 'daily_plan', 'review', 'completion', 'subtask_plan']) {
    assert.ok(banner.includes(`'${kind}'`), `DraftBanner 仍要认得 ${kind} 草稿`)
  }
  assert.match(banner, /isExpertDraft\(draft\)/, '专家分支必须由专家域的判定函数分流')
  // 打开会话的三条同步相邻顺序（test/draftBannerSessionJump.test.mjs 的判据之一）
  assert.match(banner, /openSessionInMainView\(/)
})

test('AX-E58 生成提示词是"短上下文 + 方法论全文 + 用户请求"，不绑旧会话', () => {
  const prompt = buildExpertGenerationPrompt({ request: '一个会写周报的专家', methodology: '# 方法论正文' })
  assert.match(prompt, /# 方法论正文/)
  assert.match(prompt, /一个会写周报的专家/)
  assert.equal(prompt.includes('sessionId'), false, '不许把会话 id 塞进提示词')
})

test('AX-E58 工作区匹配：精确优先、子目录次之、空 cwd 不猜', () => {
  const choices = [
    { workspaceId: 'ws-root', path: 'D:\\Code' },
    { workspaceId: 'ws-sub', path: 'D:\\Code\\<company>\\dsh-workbench' },
  ]
  assert.equal(matchWorkspaceForCwd(choices, 'D:\\Code\\<company>\\dsh-workbench'), 'ws-sub')
  assert.equal(matchWorkspaceForCwd(choices, 'd:/code/<company>/dsh-workbench/src'), 'ws-sub', 'cwd 是工作区子目录时也算命中')
  assert.equal(matchWorkspaceForCwd(choices, 'D:\\Code'), 'ws-root')
  assert.equal(matchWorkspaceForCwd(choices, ''), null, '拿不到 cwd 就要求用户手选')
  assert.equal(matchWorkspaceForCwd([{ workspaceId: '', path: 'D:\\Code' }], 'D:\\Code'), null)
  assert.equal(expertSessionTitle('  一个会写周报的专家  '), '新建专家：一个会写周报的专家')
  assert.equal(expertSessionTitle('x'.repeat(50)).length, '新建专家：'.length + 30, '标题取前 30 字符')
})

test('AX-E58 管理页空目录/纯函数不会崩（EMPTY_EXPERT_CATALOG 基线）', () => {
  assert.deepEqual(expertAdminRows(EMPTY_EXPERT_CATALOG, '', 'all'), [])
  assert.deepEqual(expertPickerPersonas(EMPTY_EXPERT_CATALOG), [])
  assert.equal(expertRowView(makeRow()).selectable, true)
})

// ---------------------------------------------------------------------------
// P11：服务端真实形状回归（2026-10-05 P10 真机验收抓到的 P8 契约错配）
//
// 专家域三件套回的是**平铺** `ExpertDraftView`（`draftId` 在顶层），而流程内部按通用
// `DraftView`（`id` + `payload`）读写。P8 的假响应是手搓的通用形状 ⇒ 全仓 1289 条测试
// 全绿，真机一跑却是"点开始生成没反应"（第 7 步必失败、提示词永不发出）。
// 下面把两种形状都钉住：**假响应必须由产品自己的 `expertDraftView()` 造**。
// ---------------------------------------------------------------------------

test('P11 normalizeExpertDraftResponse：两种真实形状都认，其它一律 null（不猜）', () => {
  const generic = makeDraft()
  assert.equal(normalizeExpertDraftResponse(generic), generic, '通用草稿形状（id + payload）原样放行')

  const flat = makeServerExpertDraftView()
  assert.equal('id' in flat, false, '前提：服务端平铺视图里没有 id')
  assert.equal(typeof flat.draftId, 'string')
  const normalized = normalizeExpertDraftResponse(flat)
  assert.equal(normalized.id, 'draft-1', 'id 必须来自 draftId')
  assert.equal(normalized.kindCode, 'expert')
  assert.equal(normalized.payload.contentVersion, 1, '平铺字段整体进 payload')
  assert.equal(normalized.statusCode, 'pending', 'statusCode 是平铺字段，要认')
  assert.equal(readExpertDraftPayload(normalized).ok, true)

  assert.equal(normalizeExpertDraftResponse(null), null)
  assert.equal(normalizeExpertDraftResponse(undefined), null)
  assert.equal(normalizeExpertDraftResponse({}), null, '两个形状都不是 → null，不许瞎认')
  assert.equal(normalizeExpertDraftResponse({ draftId: '   ' }), null)
  assert.equal(normalizeExpertDraftResponse('draft-1'), null)
  assert.equal(normalizeExpertDraftResponse({ id: 'draft-1', payload: null }), null, '有 id 但 payload 不成形状不算通用草稿')
})

test('P11 回归（P0）：generation-start 回平铺视图时，生成流程必须继续到发出提示词', async () => {
  const host = makeHost()
  const http = makeCall(generationHandlers())
  const runner = createExpertGenerationRunner(makeDeps(host, http.call))

  const outcome = await runner.start({ request: '一个会写周报的专家', workspaceId: 'ws-1' })

  assert.equal(outcome.ok, true, '平铺视图必须被认出来，不能停在 generation-start-failed')
  assert.equal(outcome.code, null)
  assert.equal(outcome.draftId, 'draft-1')
  assert.equal(outcome.promptSent, true, '第 9 步的提示词必须真的发出去（这正是 P10 真机抓到的症状）')
  assert.equal(host.state.prompts.length, 1)
  assert.equal(readExpertDraftPayload(outcome.draft).ok, true, '归一化之后 payload 必须读得出来')
})

test('P11 回归：validate / 重读草稿同样认平铺视图（否则校验后确认读不出草稿、版本冲突认不出来）', async () => {
  const host = makeHost()
  const serverNext = makeServerExpertDraftView({
    contentVersion: 2,
    phase: 'validated',
    validation: { version: 2, manifestHash: 'hash-v2', checkedAt: 'x', errors: [], warnings: [] },
  })

  const validateHttp = makeCall({ [expertDraftValidatePath('draft-1')]: { ok: true, draft: serverNext } })
  const validated = await createExpertDraftOps(makeDeps(host, validateHttp.call)).validate(makeDraft())
  assert.equal(readExpertDraftPayload(validated.draft).ok, true, 'validate 回来的平铺视图必须读得出 payload')
  assert.equal(validated.draft.payload.contentVersion, 2)

  // 确认失败后"是不是版本冲突"的判定，全靠 GET drafts/:id 能读出 contentVersion。
  const confirmHttp = makeCall({
    [expertDraftConfirmPath('draft-1')]: () => { throw new Error('HTTP 409（草稿版本冲突）') },
    [expertDraftDetailPath('draft-1')]: { ok: true, draft: serverNext, drift: [] },
  })
  const conflict = await createExpertDraftOps(makeDeps(host, confirmHttp.call)).confirm(makeValidatedDraft())
  assert.equal(conflict.code, 'version-conflict', '平铺视图读得出 contentVersion 才认得出冲突')
  assert.equal(readExpertDraftPayload(conflict.refreshed).ok, true)
  assert.equal(conflict.refreshed.payload.contentVersion, 2)
  assert.equal(confirmHttp.count(expertDraftConfirmPath('draft-1')), 1, '仍然只确认一次，不自动重放')
})
