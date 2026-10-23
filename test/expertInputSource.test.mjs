/**
 * AX-E45 / AX-E46 / AX-E51（输入侧）：`@` 专家引用源。
 *
 * ## 这组用例在证明什么
 *
 * - **AX-E45**：`@` 文件与 `@` 专家**并存**是结构事实 —— 本源只是**另一个 source**
 *   （`trigger='@'` + `name='workbench-expert'`），既不实现 `matchSpace` / `matchEnter`
 *   （那两个钩子才是"抢文件路径仲裁"的入口），也不碰 DOM。选中专家是**同步**产出
 *   `{insert}`，建请求是**异步**的 codec。
 * - **AX-E46**：失败**必须可见** —— `inputTriggers` 缺失时"这个源不注册"（面板/`/expert`
 *   照常可用）；serialize 阶段任何失败都**抛错阻止发送**，绝不静默降级成普通 `@` 文本；
 *   跨会话复制来的旧 ref 不许在别的会话里生效。
 * - **AX-E51**：热重载 / 卸载 3 轮后注册数**恒为一**，且卸载后不再写失效上下文。
 *
 * ## 脚手架说明
 *
 * 两个"源"（内置文件 + 专家）都是**最小形状替身**：本文件不 import 宿主包，
 * 只按真实 d.ts 的结构子集造对象。真实的 HTTP 路径另有一个用例：用假 `api()` 记录
 * **发出去的请求体**（这才能证明 `serialize` 用的是 ref 里的 sessionId、且 sourceKey/revision
 * 来自 preflight 而不是目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXPERT_CANDIDATE_PREFIX, EXPERT_REF_VERSION, EXPERT_REFERENCE_SOURCE, EXPERT_TRIGGER_ORDER,
  EXPERT_TRIGGER_NAME, EXPERTS_CATALOG_PATH, EXPERTS_MANUAL_REQUESTS_PATH, EXPERTS_PREFLIGHT_PATH,
  createExpertInputSource, createExpertInputTriggerRegistrar, decodeExpertRef, encodeExpertRef, installExpertInputSource,
  expertCandidatePersonaId, expertCandidatesFromCatalog, expertClipboardText, filterExpertCandidates,
} from '../lib/client/expertInputSource.js'
import { buildExpertInvocationPrompt, requireExpertRequestId } from '../lib/client/expertPrompt.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(join(REPO, path), 'utf8').replace(/\r\n/g, '\n')

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const PERSONA_ID = 'generated/expert-aaaa'
const SESSION_ID = 'session-expert-input-aaaa'
const SOURCE_KEY = 'generated'
const REVISION = 'a'.repeat(64)
const REQUEST_ID = '11111111-2222-4333-8444-555555555555'

/** `GET /experts/catalog` 的最小响应（`personas` 是选择器用的那份）。 */
function catalogFixture(overrides = {}) {
  return {
    experts: [],
    diagnostics: [],
    skillsAvailable: false,
    preliminary: true,
    personas: [{
      id: PERSONA_ID,
      name: '需求审查专家',
      description: '审查需求的完整性、可验证性及实现风险。',
      descriptionTruncated: false,
      group: 'engineering',
      mode: '',
      emoji: '🔎',
      source: 'generated',
      sourceKey: SOURCE_KEY,
      enabled: true,
      favorite: false,
      revision: REVISION,
    }],
    ...overrides,
  }
}

/** `POST /experts/preflight` 的最小响应（`summary` 是建请求唯一的身份取处）。 */
function preflightFixture(overrides = {}) {
  return {
    ok: true,
    personaId: PERSONA_ID,
    usable: true,
    status: 'usable',
    issues: [],
    effectiveSkills: [],
    preliminary: true,
    summary: { id: PERSONA_ID, name: '需求审查专家', sourceKey: SOURCE_KEY, revision: REVISION },
    ...overrides,
  }
}

/**
 * 假 `api()`：记录每一次调用，并按路径给出响应。
 *
 * 它同时是"**唯一**把 `api()` 接到源上"的证据来源：`createExpertInputSourceFromApi` 之外，
 * 源自己不认识 fetch / URL（用例末尾有源码级扫描）。
 */
function fakeApi({ catalog = catalogFixture(), preflight = preflightFixture(), manual = { ok: true, requestId: REQUEST_ID, expiresAt: '2026-01-01T00:30:00.000Z' } } = {}) {
  const calls = []
  const call = async (path, init) => {
    calls.push({ path, init })
    if (path === EXPERTS_CATALOG_PATH) return typeof catalog === 'function' ? catalog(init) : catalog
    if (path === EXPERTS_PREFLIGHT_PATH) {
      if (typeof preflight === 'function') return preflight(init)
      if (preflight instanceof Error) throw preflight
      return preflight
    }
    if (path === EXPERTS_MANUAL_REQUESTS_PATH) {
      if (typeof manual === 'function') return manual(init)
      if (manual instanceof Error) throw manual
      return manual
    }
    throw new Error(`假 api() 不认识这个路径：${path}`)
  }
  return { call, calls }
}

/** `onPick` 的输入（照真实 `InputTriggerPick` 的结构子集）。 */
function pickFixture(overrides = {}) {
  const candidate = expertCandidatesFromCatalog(catalogFixture())[0]
  return {
    candidate,
    session: { sessionId: SESSION_ID },
    position: 'inline',
    via: 'menu',
    action: 'pick',
    span: { start: 0, end: 1, draftRev: 3 },
    ...overrides,
  }
}

/** 一个最小的"内置文件引用"源替身：它存在的意义是"另一个 source 也在同一个 trigger 上"。 */
function fileSourceStub(onPicks) {
  return {
    trigger: '@',
    name: 'files',
    order: 0,
    async candidates() { return [{ name: 'README.md', label: 'README.md' }] },
    onPick(pick) { onPicks.push(pick); return { insert: { source: 'files', ref: 'README.md', label: 'README.md', clipboardText: 'README.md' } } },
  }
}

/** 真 `ctx.inputTriggers` 的最小替身（重复 `(trigger,name)` 注册会抛，与宿主同语义）。 */
function fakeTriggerService() {
  const sources = []
  const state = { registered: 0, disposed: 0 }
  return {
    sources,
    state,
    registerSource(source) {
      const duplicate = sources.some((item) => item.trigger === source.trigger && item.name === source.name)
      if (duplicate) throw new Error(`duplicate input trigger source: ${source.trigger}${source.name}`)
      state.registered += 1
      sources.push(source)
      return () => {
        state.disposed += 1
        const index = sources.indexOf(source)
        if (index >= 0) sources.splice(index, 1)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// AX-E45：@ 文件 与 @ 专家 并存
// ---------------------------------------------------------------------------

test('AX-E45 两个独立 @ source 并存：专家源是 name=workbench-expert 的另一个 source，不抢文件仲裁', async () => {
  const picks = []
  const fileSource = fileSourceStub(picks)
  const { call } = fakeApi()
  const expertSource = createExpertInputSource({
    getCatalog: (signal) => call(EXPERTS_CATALOG_PATH, { signal }),
    getPreflight: (input, signal) => call(EXPERTS_PREFLIGHT_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
    postManualRequest: (input, signal) => call(EXPERTS_MANUAL_REQUESTS_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
  })

  // ① 两个 source 的结构身份：trigger 相同、name 不同 ⇒ 宿主视为两个分组
  assert.equal(expertSource.trigger, '@')
  assert.equal(expertSource.name, EXPERT_TRIGGER_NAME)
  assert.equal(expertSource.order, EXPERT_TRIGGER_ORDER)
  assert.equal(fileSource.trigger, '@')
  assert.notEqual(fileSource.name, expertSource.name, '两个 source 必须有不同的 name（重复注册会被宿主拒绝）')

  // ② 专家源**不实现**参与文件路径仲裁的两个钩子（实现它们才是"抢"）
  assert.equal('matchSpace' in expertSource, false, '专家源不得实现 matchSpace')
  assert.equal('matchEnter' in expertSource, false, '专家源不得实现 matchEnter')

  // ③ 候选：名字带前缀、value 是严格 JSON
  const candidates = await expertSource.candidates({ sessionId: SESSION_ID }, { query: '', drilled: false, position: 'inline', signal: new AbortController().signal })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, `${EXPERT_CANDIDATE_PREFIX}${PERSONA_ID}`)
  assert.equal(candidates[0].label, '需求审查专家')
  assert.deepEqual(JSON.parse(candidates[0].value), { personaId: PERSONA_ID, sourceKey: SOURCE_KEY, revision: REVISION })

  // ④ onPick 是**同步**的：返回值就是 insert，不是一个 Promise
  const outcome = expertSource.onPick(pickFixture())
  assert.equal(outcome instanceof Promise, false, 'onPick 绝不能返回 Promise（选中卡网络往返）')
  assert.equal(typeof outcome.insert, 'object')
  assert.equal(outcome.insert.source, EXPERT_REFERENCE_SOURCE)
  assert.equal(outcome.insert.appearance, 'session')
  assert.equal(outcome.insert.label, '需求审查专家')
  assert.equal(outcome.insert.clipboardText, `@expert:${PERSONA_ID}`)
  assert.equal(outcome.insert.ref.includes(SESSION_ID), true, 'ref 必须带**选中那一刻**的会话身份')
  assert.equal(JSON.parse(outcome.insert.ref).version, EXPERT_REF_VERSION)

  // 内置文件源照常工作（两个 source 互不影响）
  fileSource.onPick({ candidate: { name: 'README.md' } })
  assert.equal(picks.length, 1)
})

test('AX-E45 codec 异步成功：serialize → preflight → manual-requests → 短指令（严格顺序）', async () => {
  const { call, calls } = fakeApi()
  const source = createExpertInputSource({
    getCatalog: (signal) => call(EXPERTS_CATALOG_PATH, { signal }),
    getPreflight: (input, signal) => call(EXPERTS_PREFLIGHT_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
    postManualRequest: (input, signal) => call(EXPERTS_MANUAL_REQUESTS_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
  })
  const ref = source.onPick(pickFixture()).insert.ref

  const text = await source.codec.serialize(ref, new AbortController().signal)
  assert.equal(typeof text, 'string')
  assert.equal(text, buildExpertInvocationPrompt({ requestId: REQUEST_ID, task: '' }), '输出必须是 expertPrompt 的短指令（逐字）')
  assert.equal(text.includes(REQUEST_ID), true)
  assert.equal(text.includes('workbench_run_expert_request'), true)
  assert.equal(text.includes('不能把这个 request_id 用于其他任务'), true)

  assert.deepEqual(calls.map((entry) => entry.path), [EXPERTS_PREFLIGHT_PATH, EXPERTS_MANUAL_REQUESTS_PATH], '必须先 preflight 再建请求')
  const preflightBody = JSON.parse(calls[0].init.body)
  assert.deepEqual(preflightBody, { personaId: PERSONA_ID, sessionId: SESSION_ID }, 'preflight 必须带 ref 的会话身份')
  const manualBody = JSON.parse(calls[1].init.body)
  assert.deepEqual(manualBody, {
    sessionId: SESSION_ID,
    personaId: PERSONA_ID,
    expectedSourceKey: SOURCE_KEY,
    expectedRevision: REVISION,
  })

  // 剪贴板投影：可读文本，不泄漏内部 JSON
  assert.equal(source.codec.clipboardText(ref), `@expert:${PERSONA_ID}`)
})

// ---------------------------------------------------------------------------
// AX-E46：失败必须可见
// ---------------------------------------------------------------------------

test('AX-E46 serialize 失败保留输入并阻止发送：preflight 说不可用 ⇒ 抛可读错误、不建任何 request', async () => {
  const { call, calls } = fakeApi({ preflight: preflightFixture({ usable: false, status: 'missing-skill', summary: null, issues: [{ code: 'required-skill-unavailable', message: '缺少必需技能 demo-skill' }] }) })
  const source = createExpertInputSource({
    getCatalog: (signal) => call(EXPERTS_CATALOG_PATH, { signal }),
    getPreflight: (input, signal) => call(EXPERTS_PREFLIGHT_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
    postManualRequest: (input, signal) => call(EXPERTS_MANUAL_REQUESTS_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
  })
  const ref = source.onPick(pickFixture()).insert.ref

  await assert.rejects(
    () => source.codec.serialize(ref, new AbortController().signal),
    (error) => {
      assert.match(error.message, /当前不可用/)
      assert.match(error.message, new RegExp(PERSONA_ID.replace(/[/\\]/g, '\\$&')))
      /** 可读错误里不许出现"看起来成功了"的话术。 */
      assert.doesNotMatch(error.message, /workbench_run_expert_request/)
      return true
    },
  )
  assert.deepEqual(calls.map((entry) => entry.path), [EXPERTS_PREFLIGHT_PATH], '不建任何 request（没有隐藏成功）')
})

test('AX-E46 HTTP 失败：manual-requests 抛错 ⇒ serialize 抛同一原因，绝不静默返回普通文本', async () => {
  const { call } = fakeApi({ manual: new Error('HTTP 400（/api/workbench/experts/manual-requests）：expected_revision 与当前专家不一致') })
  const source = createExpertInputSource({
    getCatalog: (signal) => call(EXPERTS_CATALOG_PATH, { signal }),
    getPreflight: (input, signal) => call(EXPERTS_PREFLIGHT_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
    postManualRequest: (input, signal) => call(EXPERTS_MANUAL_REQUESTS_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
  })
  const ref = source.onPick(pickFixture()).insert.ref

  await assert.rejects(
    () => source.codec.serialize(ref, new AbortController().signal),
    (error) => {
      assert.match(error.message, /expected_revision/, '服务端原因必须原样冒出来（不然用户不知道改什么）')
      return true
    },
  )
})

test('AX-E46 身份变动：目录里的 revision 变了，serialize 用 preflight 的**当前**值（不是目录里的旧值）', async () => {
  const freshRevision = 'b'.repeat(64)
  const { call, calls } = fakeApi({ preflight: preflightFixture({ summary: { id: PERSONA_ID, name: '需求审查专家', sourceKey: SOURCE_KEY, revision: freshRevision } }) })
  const source = createExpertInputSource({
    getCatalog: (signal) => call(EXPERTS_CATALOG_PATH, { signal }),
    getPreflight: (input, signal) => call(EXPERTS_PREFLIGHT_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
    postManualRequest: (input, signal) => call(EXPERTS_MANUAL_REQUESTS_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
  })
  const ref = source.onPick(pickFixture()).insert.ref
  assert.equal(JSON.parse(ref).revision, REVISION, '目录那一刻的值是旧的')

  await source.codec.serialize(ref, new AbortController().signal)
  const manualBody = JSON.parse(calls.find((entry) => entry.path === EXPERTS_MANUAL_REQUESTS_PATH).init.body)
  assert.equal(manualBody.expectedRevision, freshRevision, '必须用 preflight 的当前 revision（用旧值运行时必然 revision-changed）')
})

test('AX-E46 跨会话复制：serialize 只认 ref 里的 sessionId，不读"全局当前会话"', async () => {
  const { call, calls } = fakeApi()
  const source = createExpertInputSource({
    getCatalog: (signal) => call(EXPERTS_CATALOG_PATH, { signal }),
    getPreflight: (input, signal) => call(EXPERTS_PREFLIGHT_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
    postManualRequest: (input, signal) => call(EXPERTS_MANUAL_REQUESTS_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
  })
  /** 这个 ref 是在**别的会话**里选出来的，现在被粘贴到当前会话。 */
  const foreign = encodeExpertRef({ sessionId: 'session-foreign-bbbb', personaId: PERSONA_ID, sourceKey: SOURCE_KEY, revision: REVISION })
  await source.codec.serialize(foreign, new AbortController().signal)
  const manualBody = JSON.parse(calls.find((entry) => entry.path === EXPERTS_MANUAL_REQUESTS_PATH).init.body)
  assert.equal(manualBody.sessionId, 'session-foreign-bbbb', '必须原样使用 ref 的 sessionId（服务端据此回 manual-request-session-mismatch）')
  assert.equal(manualBody.sessionId === SESSION_ID, false)
})

test('AX-E46 坏 ref / 坏候选 / 取消：一律拒绝，且不产生任何请求', async () => {
  const { call, calls } = fakeApi()
  const source = createExpertInputSource({
    getCatalog: (signal) => call(EXPERTS_CATALOG_PATH, { signal }),
    getPreflight: (input, signal) => call(EXPERTS_PREFLIGHT_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
    postManualRequest: (input, signal) => call(EXPERTS_MANUAL_REQUESTS_PATH, { method: 'POST', body: JSON.stringify(input), signal }),
  })

  for (const bad of ['', 'not json', '{"version":2,"sessionId":"s","personaId":"p","sourceKey":"k","revision":"r"}', '[]', 'null', JSON.stringify({ version: 1, sessionId: '', personaId: 'p', sourceKey: 'k', revision: 'r' })]) {
    assert.equal(decodeExpertRef(bad), undefined, `坏 ref 必须解不出来：${bad}`)
    await assert.rejects(() => source.codec.serialize(bad, new AbortController().signal), /已损坏|版本不符/)
    assert.throws(() => source.codec.clipboardText(bad), /已损坏/)
  }

  // 坏候选 value：onPick 当场抛错，不产出 insert
  assert.throws(() => source.onPick(pickFixture({ candidate: { name: 'expert:x', value: '{oops' } })), /候选数据已损坏/)
  assert.throws(() => expertCandidatePersonaId({ value: JSON.stringify({ personaId: '  ' }) }), /候选数据已损坏/)

  // 已取消的信号：不建请求（用户取消了，不该留下一条没人执行的请求）
  const okRef = source.onPick(pickFixture()).insert.ref
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(() => source.codec.serialize(okRef, aborted.signal), /已取消/)
  assert.deepEqual(calls, [], '以上失败路径一个 HTTP 调用都不许发生')
})

test('AX-E46 inputTriggers 缺失：源不注册、打一条可读日志、不抛（面板与 /expert 照常可用）', async () => {
  const logs = []
  const service = fakeTriggerService()
  /** ① 服务缺失（`ctx.get('inputTriggers')` 拿不到） */
  const missing = createExpertInputTriggerRegistrar({
    optionalService: () => undefined,
    logger: { warn: (message) => logs.push(message) },
  })
  missing.register()
  assert.equal(missing.isRegistered(), false)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /inputTriggers/)
  assert.match(logs[0], /照常可用/)
  missing.dispose()
  assert.equal(service.state.registered, 0)

  /** ② 服务在但 `registerSource` 不是函数（宿主形状漂移） */
  const broken = createExpertInputTriggerRegistrar({
    optionalService: () => ({}),
    logger: { warn: (message) => logs.push(message) },
  })
  broken.register()
  assert.equal(broken.isRegistered(), false)
  assert.match(logs.at(-1), /inputTriggers/)

  /** ③ 服务可用：注册恰好一次，且**注册的是专家源** */
  const createSource = () => ({ trigger: '@', name: EXPERT_TRIGGER_NAME, order: EXPERT_TRIGGER_ORDER, async candidates() { return [] }, onPick() { return undefined } })
  const good = createExpertInputTriggerRegistrar({ optionalService: () => service, logger: { warn: (message) => logs.push(message) } }, { createSource })
  good.register()
  assert.equal(good.isRegistered(), true)
  assert.equal(service.state.registered, 1)
  assert.equal(service.sources.length, 1)
  assert.equal(service.sources[0].name, EXPERT_TRIGGER_NAME)
})

// ---------------------------------------------------------------------------
// AX-E51：热重载 / 卸载 3 轮
// ---------------------------------------------------------------------------

test('AX-E51 子 fiber 生命周期（仿 cordis）：注册 3 轮后恒为一份，dispose 后归零', async () => {
  const service = fakeTriggerService()
  const logs = []
  const createSource = () => ({ trigger: '@', name: EXPERT_TRIGGER_NAME, order: EXPERT_TRIGGER_ORDER, async candidates() { return [] }, onPick() { return undefined } })

  /** 仿 cordis 的子 fiber：`inject(['inputTriggers'], cb)` 的 disposer 就是 cb 的返回值。 */
  for (let round = 0; round < 3; round += 1) {
    const registrar = createExpertInputTriggerRegistrar({
      optionalService: (name) => (name === 'inputTriggers' ? service : undefined),
      logger: { warn: (message) => logs.push(message) },
    }, { createSource })
    /** 真实入口里同一次 apply 只注册一次。 */
    registrar.register()
    assert.equal(registrar.isRegistered(), true, `第 ${round + 1} 轮注册后必须在册`)
    assert.equal(service.sources.length, 1, `第 ${round + 1} 轮：同一次 apply 里也只能有一份`)
    /**
     * 额外的重复调用**只替换自己那一份**（宿主对 `(trigger,name)` 重复注册是**抛错**的，
     * 真"叠加"会让第二份当场抛错）；这里断言"仍然只有一份"。
     */
    const before = service.state.registered
    registrar.register()
    assert.equal(service.sources.length, 1, '重复 register 不许叠加')
    assert.equal(service.state.registered, before + 1, '它做的是"释放旧的、注册新的"')
    assert.equal(service.state.disposed, before, `第 ${round + 1} 轮的旧 disposer 要恰好跑一次`)
    registrar.dispose()
    registrar.dispose()
    assert.equal(registrar.isRegistered(), false)
    assert.equal(service.sources.length, 0, `第 ${round + 1} 轮卸载后必须归零`)
  }
  assert.equal(service.state.registered, 6, '三轮 × 两次 register（第二次是替换）')
  assert.equal(service.state.disposed, 6, '每轮的 disposer 必须**恰好**跑一次（含被替换掉的那份）')
  assert.deepEqual(logs, [], '正常路径不许有任何告警')

  /** 已 dispose 的实例再调 register 是 no-op（卸载后不再写失效上下文）。 */
  const dead = createExpertInputTriggerRegistrar({ optionalService: () => service }, { createSource })
  dead.dispose()
  dead.register()
  assert.equal(dead.isRegistered(), false)
  assert.equal(service.sources.length, 0)
})

test('AX-E51 卸载后再触发的异步回调不写上下文：`isRegistered` 一直是"没有东西在册"', async () => {
  const service = fakeTriggerService()
  const registrar = createExpertInputTriggerRegistrar({
    optionalService: () => service,
    logger: { warn: () => {} },
  }, { createSource: () => ({ trigger: '@', name: EXPERT_TRIGGER_NAME, order: 1, async candidates() { return [] }, onPick() { return undefined } }) })
  registrar.register()
  registrar.dispose()
  /** 模拟"卸载之后才 settle 的回调"：它只能看到 disposal → 什么都不做。 */
  await new Promise((resolve) => setTimeout(resolve, 5))
  registrar.register()
  assert.equal(registrar.isRegistered(), false)
  assert.equal(service.sources.length, 0)
})

test('AX-E51 入口装配（installExpertInputSource）：缺 ctx.inject / inject 抛错都只记日志；3 轮装配恒一份、清理归零', () => {
  const service = fakeTriggerService()
  const logs = []
  const originalWarn = console.warn
  /** 注意：替换后的实现**不能再调 `console.warn`**，否则自递归爆栈。 */
  console.warn = (message) => { logs.push(message) }
  try {
    /** ① 老版本宿主：没有 `inject` ⇒ 只打日志、返回 no-op（面板照常加载）。 */
    assert.doesNotThrow(() => installExpertInputSource({}))
    assert.match(logs.at(-1), /宿主没有 ctx\.inject/)
    assert.equal(service.sources.length, 0)

    /** ② `inject` 自己抛错 ⇒ 同样只是"这个源不注册"。 */
    assert.doesNotThrow(() => installExpertInputSource({ inject: () => { throw new Error('子 fiber 建不起来') } }))
    assert.match(logs.at(-1), /注册专家 @ 引用源失败/)
    assert.equal(service.sources.length, 0)

    /**
     * ③ 真宿主形状：`inject` 的回调返回子 fiber 自己的 disposer，宿主负责调用。
     * 两种清理路径都必须**自成一体且幂等**：
     * - `round === 0` 只走**子 fiber 的** disposer（热重载里宿主单独清理子 fiber 的路径）；
     * - `round > 0` 只走**入口返回的** disposer（插件卸载的路径）。
     */
    const installOnce = () => {
      const childDisposers = []
      let injectedNames
      const ctx = {
        inject(names, callback) {
          injectedNames = names
          const dispose = callback({})
          if (typeof dispose === 'function') childDisposers.push(dispose)
          return () => { for (const disposeChild of childDisposers.splice(0)) disposeChild() }
        },
      }
      const disposeInstall = installExpertInputSource(ctx, () => createExpertInputTriggerRegistrar({
        optionalService: () => service,
        logger: { warn: () => {} },
      }, { createSource: () => ({ trigger: '@', name: EXPERT_TRIGGER_NAME, order: EXPERT_TRIGGER_ORDER, async candidates() { return [] }, onPick() { return undefined } }) }))
      return { injectedNames, childDisposers, disposeInstall }
    }

    for (let round = 0; round < 3; round += 1) {
      const { injectedNames, childDisposers, disposeInstall } = installOnce()
      assert.deepEqual(injectedNames, ['inputTriggers'], '只允许注入 inputTriggers 这一项')
      assert.equal(service.sources.length, 1, `第 ${round + 1} 轮：装配后恰好一份`)
      const byChildFiber = round === 0
      assert.equal(childDisposers.length, 1, '子 fiber 回调必须返回自己的 disposer')
      if (byChildFiber) {
        /**
         * **只**跑子 fiber 自己的 disposer（不碰入口那条）：热重载里宿主单独清理子 fiber 的路径。
         * 入口那条留到最后再调，用来证明它此刻只能是 no-op（否则先后调用会掩盖空壳）。
         */
        childDisposers[0]()
        assert.equal(service.sources.length, 0, `第 ${round + 1} 轮：子 fiber 清理后归零`)
        assert.equal(service.state.disposed, round + 1, '子 fiber 自己的 disposer 必须把注册摘掉（不能指望入口那条帮忙）')
        disposeInstall()
        childDisposers[0]()
      } else {
        disposeInstall()
        assert.equal(service.sources.length, 0, `第 ${round + 1} 轮：清理后归零`)
        assert.equal(service.state.disposed, round + 1, '入口返回的 disposer 必须把注册摘掉')
        disposeInstall()
        disposeInstall()
      }
      assert.equal(service.sources.length, 0, `第 ${round + 1} 轮：两条路径都幂等，注册数仍是 0`)
      assert.equal(service.state.disposed, round + 1, '注册器的 dispose 全程恰好跑一次')
    }
  } finally {
    console.warn = originalWarn
  }
})

// ---------------------------------------------------------------------------
// 接线（源码级）：唯一入口、不加进 inject
// ---------------------------------------------------------------------------

test('AX-E45/E46 接线：专家 @ 源只在 entry 里用一行装配（子 fiber 软注入），且 inputTriggers 不在 inject 里', () => {
  const entry = read('src/client/index.tsx')
  const capabilities = read('src/client/capabilities.ts')
  assert.equal((entry.match(/installExpertInputSource\(ctx\)/g) ?? []).length, 1, '入口只允许装配一次')
  assert.match(entry, /officialDisposers\.push\(disposeExpertInput\)/, '装配出来的清理函数必须交给统一 disposer')
  const input = read('src/client/expertInputSource.ts')
  assert.match(input, /injector\.call\(ctx, \['inputTriggers'\]/, '必须走子 fiber 软注入（ctx.inject）')
  assert.match(input, /export function installExpertInputSource\(/)
  assert.equal(/^\s*(?:'|")?inputTriggers/m.test(capabilities), false, 'inputTriggers 不许进客户端 inject 清单')
  assert.match(capabilities, /export const inject = \['sessions', 'workspaces', 'connection', 'slots', 'layout'\]/, '五项链表逐字不变')
})

test('AX-E45/E46 源模块不认识 fetch / URL / document / React（纯逻辑，可被 node --test 直接驱动）', () => {
  const source = read('src/client/expertInputSource.ts')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/document\./.test(code), false, '不读 document')
  assert.equal(/from 'react'/.test(code), false, '不 import React')
  assert.equal(/\bfetch\(/.test(code), false, 'HTTP 只走注入的 api()，不自建 fetch')
  assert.match(code, /export function createExpertInputSourceFromApi\(/, '生产装配是一个显式函数（唯一把 api() 接进来的地方）')
  assert.match(code, /ExpertApiCall = api/, '默认参数就是真实的 api()')
})

test('AX-E45 ref 编解码：版本化 JSON、四字段非空、坏版本/非 JSON 一律拒绝', () => {
  const ref = encodeExpertRef({ sessionId: SESSION_ID, personaId: PERSONA_ID, sourceKey: SOURCE_KEY, revision: REVISION })
  assert.deepEqual(JSON.parse(ref), { version: 1, sessionId: SESSION_ID, personaId: PERSONA_ID, sourceKey: SOURCE_KEY, revision: REVISION })
  assert.deepEqual(decodeExpertRef(ref), JSON.parse(ref))
  // trim 口径：带空白的值是可用的，但存进去的是 trim 后的
  assert.equal(JSON.parse(encodeExpertRef({ sessionId: ` ${SESSION_ID} `, personaId: PERSONA_ID, sourceKey: SOURCE_KEY, revision: REVISION })).sessionId, SESSION_ID)
  for (const missing of ['sessionId', 'personaId', 'sourceKey', 'revision']) {
    const parts = { sessionId: SESSION_ID, personaId: PERSONA_ID, sourceKey: SOURCE_KEY, revision: REVISION, [missing]: '   ' }
    assert.throws(() => encodeExpertRef(parts), new RegExp(missing), `缺 ${missing} 必须抛错`)
  }
  assert.equal(expertClipboardText(ref), `@expert:${PERSONA_ID}`)
})

test('AX-E45 候选过滤：按名字/显示名/简介匹配，空查询返回全部且不改顺序', () => {
  const candidates = expertCandidatesFromCatalog(catalogFixture())
  assert.equal(filterExpertCandidates(candidates, '').length, 1)
  assert.equal(filterExpertCandidates(candidates, '需求').length, 1)
  assert.equal(filterExpertCandidates(candidates, 'expert:').length, 1)
  assert.equal(filterExpertCandidates(candidates, '不存在').length, 0)
  /** 坏 catalog（缺 personas / 元素缺 sourceKey）不抛、只是少几条。 */
  assert.deepEqual(expertCandidatesFromCatalog(undefined), [])
  assert.deepEqual(expertCandidatesFromCatalog({ personas: [{ id: 'x/y', name: 'X' }] }), [], '缺 sourceKey 的候选不能进菜单（建不出请求）')
})

test('短指令：requestId 严格校验（引号/换行/控制字符一律拒绝），正文不内联人格', () => {
  const text = buildExpertInvocationPrompt({ requestId: REQUEST_ID, task: '审查这份需求' })
  assert.equal(text.includes(`request_id="${REQUEST_ID}"`), true)
  assert.equal(text.includes('审查这份需求'), true)
  for (const bad of ['', '   ', null, 42, 'a"b', 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb']) {
    assert.throws(() => requireExpertRequestId(bad), /拒绝生成调用指令|请求 id/, String(bad))
  }
  assert.throws(() => requireExpertRequestId('x'.repeat(300)), /过长/)
})
