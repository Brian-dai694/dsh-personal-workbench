/**
 * 回归：**P5 的生产装配**（AX-E50）。
 *
 * ## 为什么必须单开一个文件
 *
 * P1–P4 交付的是"模块"，P5 第一次把它们接到**真实入口** `apply()` 上。
 * 这一层最容易出的不是逻辑错，而是**接线错**：
 * - 顶层 `inject` 被塞进可选服务 ⇒ 没装 skills 的机器上整个插件 pending（本仓复发 3 次）；
 * - 路由 / 工具 / skills 子 fiber 各建一份 service ⇒ "设置改了但工具还在旧的"这类矛盾；
 * - `recover()` 没在注册 provider 前跑、`dispose()` 顺序把 db 关在别人前面；
 * - `loadPersonaTool` 的 preflight 没被生产注入 ⇒ §9.2 的"必需依赖缺失不得返回正文"形同不存在。
 *
 * 这个文件用**假 ctx**（与 `test/knowledgeRecallWiring.test.mjs` 同风格：`effect`/`inject`/`get`/`on`/
 * `webServer.register`/`tools.register`/`systemPrompt.section`/`commands.register`）在**临时 home**
 * 上跑完整 `apply()`，并且**真的**起一个 HTTP 服务器：路由、工具、skills 子 fiber 全部走真实路径。
 *
 * 临时 home 由 `apply(ctx, { home })` 提供（`Config.home`，P5 新增：数据库/专家库/角色库一起挪到
 * `<home>/.dsh/workbench`）—— 所以**绝不写** `~/.dsh/workbench`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.js'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { loadPersonaTool } from '../lib/tools/workbench.js'
import { createExpertService } from '../lib/experts/service.js'
import { resolveExpertRoots } from '../lib/experts/paths.js'
import { EXPERT_GENERATION_TOOL_NAMES } from '../lib/experts/tools.js'
import { EXPERT_HTTP_BODY_MAX_BYTES } from '../lib/shared/expert.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const INDEX_SOURCE = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8')

const AT = '2026-01-01T00:00:00.000Z'
const BOUND_SESSION = 'session-wiring-bound-aaaa'
const UNBOUND_SESSION = 'session-wiring-unbound-bbbb'
const PERSONA_BODY_MARK = '你负责审查用户给出的需求和设计'

const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 Demo Upstream',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
  '',
].join('\n')

function personaDoc() {
  return [
    '---',
    'group: 工程',
    '---',
    '',
    '# 需求审查专家',
    '',
    '> 分类：工程',
    '> 工作模式：只读审查',
    '> 建议 emoji：🔎',
    '> 建议简介：审查需求的完整性、可验证性及实现风险，输出明确问题和修改建议。',
    '',
    '## 身份与职责',
    '',
    `${PERSONA_BODY_MARK}，识别缺失条件、互相矛盾的约束和无法验收的表述。`,
    '',
    '## 工作流程',
    '',
    '1. 提取目标、输入、输出和约束。',
    '2. 核对每个主流程及失败分支。',
    '',
    '## 判断与检查',
    '',
    '没有代码或运行证据时，不把推测写成已确认事实。',
    '',
    '## 技能与资源',
    '',
    '必需技能：demo-skill。它没装上之前本专家不可用。',
    '',
    '## 输出与停止条件',
    '',
    '输出结论、问题位置、影响、修正建议和验证办法。',
    '',
  ].join('\n')
}

function skillDoc() {
  return [
    '---',
    'name: demo-skill',
    'description: 演示用的必需技能包，只在本回归测试里出现。',
    '---',
    '',
    '按说明加载即可。',
    '',
  ].join('\n')
}

function provenanceJson(usedFor) {
  return JSON.stringify({
    version: 1,
    creationKind: 'original',
    sources: [
      {
        id: 'demo',
        repository: 'https://github.com/example/demo',
        upstreamPath: 'skills/demo/SKILL.md',
        commit: null,
        fetchedAt: AT,
        authors: ['Demo Upstream'],
        license: 'MIT',
        copyrightNotice: 'Copyright (c) 2026 Demo Upstream',
        licenseFile: 'sources/demo/LICENSE.txt',
        usedFor,
        modifications: '改写为中文说明。',
      },
    ],
    references: [],
    generationNote: '本回归测试的固定夹具。',
  })
}

/** 一条 `action=install` 的必需技能需求：包内自带许可副本，安装不需要宿主 skills 服务。 */
function skillsJson() {
  return JSON.stringify([
    {
      name: 'demo-skill',
      required: true,
      action: 'install',
      sourceId: 'demo',
      packageFiles: ['SKILL.md', 'sources/demo/LICENSE.txt'],
      reason: '本专家没有这个技能就不能工作。',
    },
  ])
}

// ---------------------------------------------------------------------------
// 假宿主：与真 cordis 同形的**最小** ctx（只实现本插件用到的那几个面）
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
  const ctx = {
    logger: { info: push('info'), warn: push('warn'), error: push('error') },
    /**
     * 与 cordis 同语义：`fn()` 的返回值就是这条 effect 的释放函数。
     * 释放顺序由 `disposeAll()` 逆序执行（cordis 的 `DisposableList.clear()` 也是 `reverse()`）。
     */
    effect(fn, name) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push({ name: name ?? '(anonymous)', dispose })
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(key) { return serviceMap[key] },
    /**
     * 依赖齐全才建子 fiber；缺依赖时**什么都不做** —— 这正是"可选服务不进 inject、插件不 pending"
     * 的宿主侧语义。
     */
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
        return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) }
      },
    },
    tools: {
      register(tool) { tools.push(tool); return () => {} },
    },
    systemPrompt: {
      section(spec) { sections.push(spec); return () => {} },
      context() { return () => {} },
    },
    commands: { register(definition) { commands.push(definition); return () => {} } },
  }
  /** `commands` 走的是 `ctx.get('commands')` 软探测（与真宿主同路径），所以也要能被探测到。 */
  serviceMap.commands = ctx.commands
  return {
    ctx, routes, tools, sections, commands, logs, disposers,
    serviceMap,
    /** cordis 同序释放：同一 fiber 里后注册的先释放。 */
    async disposeAll() {
      for (const entry of [...disposers].reverse()) entry.dispose()
    },
  }
}

/** 假的宿主 skills 服务：`list` 为空 ⇒ 任何"要复用/要按名字找"的技能都找不到。 */
function fakeSkills() {
  const state = { registered: 0, unregistered: 0, invalidated: 0, providerName: null }
  const service = {
    async list() { return [] },
    registerProvider(create) {
      state.registered += 1
      const control = { signal: undefined, invalidate: () => { state.invalidated += 1 } }
      const provider = create(control)
      state.providerName = provider?.name ?? null
      return () => { state.unregistered += 1 }
    },
  }
  return { service, state }
}

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-workbench-expert-wiring-'))
  mkdirSync(join(home, '.dsh', 'workbench'), { recursive: true })
  return home
}

function removeTempDir(path) {
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try { rmSync(path, { recursive: true, force: true }); return } catch { /* Windows 偶发占用：重试 */ }
  }
}

/** 等一个条件成立（注册发生在 `expertRecovery.then(...)` 的微任务里，不能假设同步完成）。 */
async function waitFor(predicate, { timeoutMs = 5000, step = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, step))
  }
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

function toolOf(host, name) {
  const tool = host.tools.find((candidate) => candidate.name === name)
  assert.ok(tool !== undefined, `工具表里必须有 ${name}`)
  return tool
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('AX-E50: 顶层 inject 逐字未变（运行时数组 + 源码那一行）', () => {
  assert.deepEqual([...plugin.inject], ['webServer', 'systemPrompt', 'tools', 'commands'])
  assert.match(INDEX_SOURCE, /^export const inject = \['webServer', 'systemPrompt', 'tools', 'commands'\]$/m)
  /** 可选服务一个都不许混进来。 */
  for (const optional of ['skills', 'timer', 'llm', 'dshIm', 'teamMemory']) {
    assert.equal(plugin.inject.includes(optional), false, `inject 不许包含可选服务 ${optional}`)
  }
  assert.equal(typeof plugin.apply, 'function')
})

test('AX-E50: 一份专家 service —— 路由 / 工具 / skills 子 fiber 共用同一实例', async () => {
  /** 源码级：入口只创建一次服务。 */
  assert.equal(INDEX_SOURCE.match(/createExpertService\(/g)?.length, 1)
  assert.equal(INDEX_SOURCE.match(/expertGenerationTools\(experts\)/g)?.length, 1)

  const home = tempHome()
  const skills = fakeSkills()
  const host = fakeHost({ services: { skills: skills.service } })
  let server
  let controlDb
  try {
    plugin.apply(host.ctx, { home })

    /** 恢复必须在注册 provider 之前跑完（provider 注册发生在 `expertRecovery.then` 之后）。 */
    assert.equal(await waitFor(() => skills.state.registered === 1), true, 'skills provider 必须注册恰好一次')

    /** 路由表：专家前缀恰好注册一条（未装配时整段不注册）。 */
    assert.equal(host.routes.filter((route) => route.path === '/api/workbench/experts').length, 1)
    /** 命令表：`/workbench` 走宿主原生命令注册，同样只一次。 */
    assert.equal(host.commands.filter((definition) => definition.name === 'workbench').length, 1)
    /** 工具表：5 个生成工具各一次，且没有任何确认/安装工具。 */
    for (const name of EXPERT_GENERATION_TOOL_NAMES) {
      assert.equal(host.tools.filter((tool) => tool.name === name).length, 1, `${name} 必须注册恰好一次`)
    }
    assert.equal(host.tools.some((tool) => /confirm|install|approve|publish/i.test(tool.name)), false)

    server = await startServer(host.routes)

    /** ① 设置往返：真 boolean 生效，脏值不生效，响应是重读的 settings。 */
    const before = await server.request('GET', '/api/workbench/settings')
    assert.equal(before.status, 200)
    assert.equal(before.body.settings.autoSummonExperts, false)

    const written = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: true })
    assert.equal(written.status, 200)
    assert.equal(written.body.settings.autoSummonExperts, true)
    assert.equal(typeof written.body.settings.defaultWorkspace, 'string', '响应必须是重读的完整设置，不是请求体回显')

    const dirty = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: 'yes' })
    assert.equal(dirty.status, 200)
    assert.equal(dirty.body.settings.autoSummonExperts, true, '脏值不得写库，也不得改变既有真值')

    /** ② 能力：`autoSummon.enabled` 必须读**唯一设置真值**（刚刚写进去的那个）。 */
    const capabilities = await server.request('GET', '/api/workbench/experts/capabilities')
    assert.equal(capabilities.status, 200)
    assert.equal(capabilities.body.generation.available, true)
    assert.equal(capabilities.body.skills.available, true, '有 skills 服务时 skills.available 必须为 true')
    assert.equal(capabilities.body.autoSummon.enabled, true, '路由拿到的必须是同一份设置真值')
    for (const report of [capabilities.body.manualSummon, capabilities.body.autoSummon]) {
      assert.equal(report.available, false, 'P5 还没实现子代理调用，不许报 available:true')
      assert.equal(report.reason, 'expert-subagent-unavailable')
    }
    assert.equal(capabilities.body.providerName, 'personal-workbench')

    /** ③ 真实安装链：路由建草稿 → 工具提交/暂存/校验 → 路由确认（幂等回放）。 */
    const started = await server.request('POST', '/api/workbench/experts/generation-start', {
      sessionId: BOUND_SESSION,
      request: '帮我做一个需求审查专家',
      workspaceId: 'D:/Code/<company>/dsh-workbench',
    })
    assert.equal(started.status, 200)
    const draftId = started.body.draft.draftId

    const submit = await toolOf(host, 'workbench_submit_expert_draft').execute({
      draft_id: draftId,
      expected_version: 0,
      persona_md: personaDoc(),
      provenance_json: provenanceJson(['persona', 'skill']),
      skills_json: skillsJson(),
    }, { agent: { session: { id: BOUND_SESSION } } })
    assert.equal(submit.ok, true, `提交人格失败：${JSON.stringify(submit)}`)

    const stageLicense = await toolOf(host, 'workbench_stage_expert_file').execute({
      draft_id: draftId,
      expected_version: submit.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      content_utf8: MIT_TEXT,
    }, { agent: { session: { id: BOUND_SESSION } } })
    assert.equal(stageLicense.ok, true, `${JSON.stringify(stageLicense)}`)

    const stageSkill = await toolOf(host, 'workbench_stage_expert_file').execute({
      draft_id: draftId,
      expected_version: stageLicense.contentVersion,
      area: 'skill',
      path: 'demo-skill/SKILL.md',
      content_utf8: skillDoc(),
    }, { agent: { session: { id: BOUND_SESSION } } })
    assert.equal(stageSkill.ok, true, `${JSON.stringify(stageSkill)}`)

    const stageSkillLicense = await toolOf(host, 'workbench_stage_expert_file').execute({
      draft_id: draftId,
      expected_version: stageSkill.contentVersion,
      area: 'skill',
      path: 'demo-skill/sources/demo/LICENSE.txt',
      content_utf8: MIT_TEXT,
    }, { agent: { session: { id: BOUND_SESSION } } })
    assert.equal(stageSkillLicense.ok, true, `${JSON.stringify(stageSkillLicense)}`)

    const validated = await toolOf(host, 'workbench_validate_expert_draft').execute({
      draft_id: draftId,
      expected_version: stageSkillLicense.contentVersion,
    }, { agent: { session: { id: BOUND_SESSION } } })
    assert.equal(validated.ok, true)
    assert.deepEqual(validated.errors, [], `校验不该有错：${JSON.stringify(validated.errors)}`)

    const confirmed = await server.request('POST', `/api/workbench/drafts/${draftId}/confirm`, {
      expectedVersion: validated.contentVersion,
      manifestHash: validated.manifestHash,
    })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.ok, true)
    assert.equal(confirmed.body.expert.kind, 'expert')
    assert.equal(confirmed.body.replayed, false)
    const expertId = confirmed.body.expert.expertId

    /** 安装确实调用了"刷新技能注册表"——它只能通过**同一个** service 实例走到 skills 子 fiber。 */
    assert.equal(skills.state.invalidated >= 1, true, '安装必须刷新宿主技能注册表（证明 service 是同一份）')

    const replayed = await server.request('POST', `/api/workbench/drafts/${draftId}/confirm`, {
      expectedVersion: validated.contentVersion,
      manifestHash: validated.manifestHash,
    })
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body))
    assert.equal(replayed.body.replayed, true, '已确认的草稿再确认必须幂等回放')

    /** ④ 绑定角色（走真实 personas 路由，用的是同一份 db 连接）。 */
    const bound = await server.request('POST', '/api/workbench/personas/bind', {
      sessionId: BOUND_SESSION,
      personaId: expertId,
    })
    assert.equal(bound.status, 201, JSON.stringify(bound.body))
    assert.equal(bound.body.binding.personaId, expertId)

    /**
     * ⑤ preflight 注入：这个专家的必需技能（demo-skill）不在宿主技能库里 ⇒ 不允许返回正文。
     * 判据只能是 `usable === false`（`preliminary` 不算），所以这条同时守住 §9.2 的口径。
     */
    const loadPersona = toolOf(host, 'workbench_load_persona')
    const refused = await loadPersona.execute({}, { agent: { session: { id: BOUND_SESSION } } })
    assert.equal(typeof refused, 'string')
    assert.match(refused, /不返回角色正文/, `绑定且必需依赖缺失时必须拒绝：${refused}`)
    assert.equal(refused.includes(PERSONA_BODY_MARK), false, '拒绝时绝不能把正文塞回去')
    assert.match(refused, /demo-skill/)

    /** 未绑定会话的行为必须与"没有注入 preflight 的旧版"逐字一致。 */
    controlDb = openWorkbenchDb({ dbPath: ':memory:' })
    seedDictionaries(controlDb)
    const legacy = loadPersonaTool(controlDb, { home })
    const currentUnbound = await toolOf(host, 'workbench_load_persona').execute({}, { agent: { session: { id: UNBOUND_SESSION } } })
    const legacyUnbound = await legacy.execute({}, { agent: { session: { id: UNBOUND_SESSION } } })
    assert.equal(currentUnbound, legacyUnbound, '未绑定角色时行为必须与旧版逐字一致')
    assert.match(currentUnbound, /角色加载失败/)

    /** ⑥ 释放：skills 子 fiber 的释放函数必须注销 provider（幂等，不重复）。 */
    await host.disposeAll()
    assert.equal(skills.state.unregistered, 1)
  } finally {
    if (server !== undefined) await server.close()
    if (controlDb !== undefined) controlDb.close()
    removeTempDir(home)
  }
})

test('AX-E50: skills 服务缺失时插件不崩、不 pending，能力如实降级', async () => {
  const home = tempHome()
  const host = fakeHost()
  let server
  let controlDb
  try {
    plugin.apply(host.ctx, { home })
    assert.equal(host.routes.some((route) => route.path === '/api/workbench/experts'), true, '缺 skills 也要装配专家路由')

    server = await startServer(host.routes)
    const capabilities = await server.request('GET', '/api/workbench/experts/capabilities')
    assert.equal(capabilities.status, 200)
    assert.equal(capabilities.body.skills.available, false, '没有 skills 服务就是不可用，不许伪造')
    assert.match(capabilities.body.skills.reason, /skill-service-unavailable/)

    const methodology = await server.request('GET', '/api/workbench/experts/methodology')
    assert.equal(methodology.status, 200)
    assert.equal(methodology.body.version, 1)
    assert.equal(methodology.body.text.includes('### 13.'), true)

    const settings = await server.request('GET', '/api/workbench/settings')
    assert.equal(settings.body.settings.autoSummonExperts, false)

    /** 未绑定角色：行为与旧版一致（preflight 注入不影响"没有绑定"这条路径）。 */
    controlDb = openWorkbenchDb({ dbPath: ':memory:' })
    seedDictionaries(controlDb)
    const current = await toolOf(host, 'workbench_load_persona').execute({}, { agent: { session: { id: UNBOUND_SESSION } } })
    const legacy = await loadPersonaTool(controlDb, { home }).execute({}, { agent: { session: { id: UNBOUND_SESSION } } })
    assert.equal(current, legacy)

    await host.disposeAll()
  } finally {
    if (server !== undefined) await server.close()
    if (controlDb !== undefined) controlDb.close()
    removeTempDir(home)
  }
})

test('AX-E50: `.pending` 里的垃圾不会中断装配（recover 只影响那一条）', async () => {
  const home = tempHome()
  const host = fakeHost()
  let server
  try {
    /** 真实会遇到的形状：上次中断留下半个安装目录 + 一份读不动的 journal。 */
    const pending = join(home, '.dsh', 'workbench', 'personas', '.pending')
    mkdirSync(join(pending, 'not-a-uuid'), { recursive: true })
    writeFileSync(join(pending, 'not-a-uuid', 'install-journal.json'), '{ 不是 JSON')
    writeFileSync(join(pending, 'stray-file'), 'x')

    plugin.apply(host.ctx, { home })
    assert.equal(host.routes.some((route) => route.path === '/api/workbench/experts'), true)
    assert.equal(host.tools.filter((tool) => tool.name === 'workbench_get_expert_draft').length, 1)

    server = await startServer(host.routes)
    const capabilities = await server.request('GET', '/api/workbench/experts/capabilities')
    assert.equal(capabilities.status, 200)
    assert.equal(capabilities.body.generation.available, true)

    await host.disposeAll()
  } finally {
    if (server !== undefined) await server.close()
    removeTempDir(home)
  }
})

test('AX-E50: 入口源码里技能 provider 的注册与释放都是"子 fiber + effect"范式', () => {
  assert.equal(INDEX_SOURCE.match(/ctx\.inject\(\['skills'\]/g)?.length, 1)
  assert.equal(INDEX_SOURCE.match(/registerWorkbenchSkillProvider\(/g)?.length, 1)
  assert.equal(INDEX_SOURCE.match(/ctx\.effect\(\(\) => \(\) => experts\.dispose\(\)/g)?.length, 1)
  /**
   * `setAutoEnabled` 转发：它写的是**同一个 meta 键**（`expert_auto_summon`），
   * 所以 P5 里删掉这一行，HTTP 侧（capabilities 重读 DB）**观察不到差异**。
   * 真正的作用要到 P6 的自主召唤调度读服务状态时才显现 —— 这里至少用源码扫描
   * 挡住"接线被悄悄删掉"（这是 P5 能给出的最强证据，见报告"测试证明不了的地方"）。
   */
  const routesSource = readFileSync(join(REPO, 'src', 'api', 'routes.ts'), 'utf8')
  assert.equal(routesSource.match(/deps\.experts\?\.setAutoEnabled\(body\.autoSummonExperts\)/g)?.length, 1)
  /** dispose 必须注册在 db.close 之后（cordis 逆序释放 ⇒ 先跑 experts.dispose）。 */
  assert.equal(
    INDEX_SOURCE.indexOf('experts.dispose()') > INDEX_SOURCE.indexOf('db.close()'),
    true,
  )
  /** expert 分支不许接管旧任务草稿。 */
  const draftsSource = readFileSync(join(REPO, 'src', 'api', 'routes', 'drafts.ts'), 'utf8')
  assert.equal(
    draftsSource.indexOf("draft.kindCode === 'expert'") < draftsSource.indexOf("draft.statusCode !== 'pending'"),
    true,
    'expert confirm 必须插在 pending 闸门之前（否则幂等回放被 400 挡掉）',
  )
})

/**
 * 发一个**真的**超限 body（headers 里是**正确**的 content-length）。
 *
 * 与"声明式超限"那条不同：这里客户端真把 300KB 写进了套接字，用来证明**路由自己**
 * 能在读取前按声明长度挡住，而不是靠 fetch/宿主层先拒绝。413 可能在客户端还在写 body
 * 时就回包并重置连接，所以这里吞掉响应到达之后的网络错，以响应为准。
 */
function rawPost(url, bodyText) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(bodyText, 'utf8')
    const parsed = new URL(url)
    let status = null
    let text = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({ status, text, body: text === '' ? null : JSON.parse(text) })
    }
    const req = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    }, (res) => {
      status = res.statusCode ?? null
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', finish)
    })
    req.on('error', (error) => {
      if (status !== null) { finish(); return }
      if (settled) return
      settled = true
      reject(error)
    })
    req.setTimeout(15000, () => { req.destroy(new Error('rawPost 超时：既没有响应也没有网络错')) })
    req.end(payload)
  })
}

test('AX-E50: load_persona 的 preflight 把执行上下文的 live agent 原样传下去（真 scope 生效）', async () => {
  const home = tempHome()
  const listCalls = []
  const scopeKey = { label: 'wiring-agent-scope' }
  const skillsService = {
    /** 真实宿主里 `list` 会按 `options.scope` 筛最近层；这里只负责如实记下收到什么。 */
    async list(options) { listCalls.push(options); return [] },
    registerProvider(create) { create({ signal: undefined, invalidate: () => {} }); return () => {} },
  }
  const host = fakeHost({ services: { skills: skillsService } })
  let server
  try {
    /** 一篇普通用户角色（不需要安装、没有必需技能），只为让 preflight 真的跑到技能库。 */
    const userPersonas = join(home, '.dsh', 'workbench', 'personas')
    mkdirSync(userPersonas, { recursive: true })
    writeFileSync(join(userPersonas, 'wiring-scope-persona.md'), personaDoc(), 'utf8')

    plugin.apply(host.ctx, { home })
    server = await startServer(host.routes)

    const bound = await server.request('POST', '/api/workbench/personas/bind', {
      sessionId: BOUND_SESSION,
      personaId: 'wiring-scope-persona',
    })
    assert.equal(bound.status, 201, JSON.stringify(bound.body))

    const carrier = new Context()
    const scoped = createScope(carrier, scopeKey)
    const agent = { ctx: scoped.ctx, session: { id: BOUND_SESSION, header: { cwd: 'C:/wiring-agent-cwd' } } }
    assert.equal(scopeOf(agent.ctx), scopeKey, '真实 scopeOf：这就是下面要断言的 key')

    listCalls.length = 0
    const output = await toolOf(host, 'workbench_load_persona').execute({}, { agent })
    assert.equal(typeof output, 'string')
    assert.match(output, /【角色正文】/, '角色可用时必须照常返回正文（预检不是"一律拒绝"）')
    assert.equal(listCalls.length >= 1, true, 'preflight 必须真的按执行上下文的视角查过技能库')
    const lastCall = listCalls.at(-1)
    assert.deepEqual(lastCall.scope, scopeKey, '必须把 live agent 的 scope 原样传下去（丢了就退化成全局视角）')
    assert.equal(lastCall.cwd, 'C:/wiring-agent-cwd', 'cwd 也必须来自这个 live agent')
    scoped.dispose()

    await host.disposeAll()
  } finally {
    if (server !== undefined) await server.close()
    removeTempDir(home)
  }
})

test('AX-E50: settings POST 把真 boolean 转发给专家服务，脏值一次都不调（可注入桩）', async () => {
  const home = tempHome()
  const calls = []
  /** 桩只需要 `setAutoEnabled`：这条用例证明的是"接线真的调了服务"，不是服务内部实现。 */
  const stub = { setAutoEnabled(enabled) { calls.push(enabled) } }
  const db = openWorkbenchDb({ dbPath: join(home, 'wiring-settings.db') })
  seedDictionaries(db)
  let server
  try {
    server = await startServer(makeRoutes(db, { experts: stub }))

    const initial = await server.request('GET', '/api/workbench/settings')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.settings.autoSummonExperts, false)

    const on = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: true })
    assert.equal(on.status, 200)
    assert.deepEqual(calls, [true], 'POST true 必须恰好转发一次 true')
    assert.equal(on.body.settings.autoSummonExperts, true)
    assert.equal(typeof on.body.settings.defaultWorkspace, 'string', '响应是重新读出来的整份设置，不是请求体回显')

    const off = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: false })
    assert.equal(off.status, 200)
    assert.deepEqual(calls, [true, false], 'POST false 必须恰好再转发一次 false')
    assert.equal(off.body.settings.autoSummonExperts, false)

    for (const dirty of ['false', 'yes', '', 1, null, {}, []]) {
      const response = await server.request('POST', '/api/workbench/settings', { autoSummonExperts: dirty })
      assert.equal(response.status, 200, `脏值 ${JSON.stringify(dirty)} 只是不生效，不该让请求失败`)
    }
    assert.deepEqual(calls, [true, false], '脏值一个都不许转发给专家服务')
    const after = await server.request('GET', '/api/workbench/settings')
    assert.equal(after.body.settings.autoSummonExperts, false, '脏值也不写库：响应不是请求体回显')
  } finally {
    if (server !== undefined) await server.close()
    db.close()
    removeTempDir(home)
  }
})

test('AX-E31: 真发超过 EXPERT_HTTP_BODY_MAX_BYTES 的 body（content-length 正确）→ 413，一行草稿都不落', async () => {
  const home = tempHome()
  const db = openWorkbenchDb({ dbPath: join(home, 'wiring-oversize.db') })
  seedDictionaries(db)
  const service = createExpertService({
    db,
    ctx: { get: () => undefined },
    roots: resolveExpertRoots({ home }),
    now: () => AT,
  })
  let server
  try {
    server = await startServer(makeRoutes(db, { experts: service }))

    const oversized = `{"sessionId":"a","request":"${'x'.repeat(300 * 1024)}","workspaceId":"w"}`
    const bytes = Buffer.byteLength(oversized, 'utf8')
    assert.equal(bytes > EXPERT_HTTP_BODY_MAX_BYTES, true, '夹具必须真的超过上限')

    const response = await rawPost(`${server.base}/api/workbench/experts/generation-start`, oversized)
    assert.equal(response.status, 413, `原始响应：${response.text}`)
    assert.equal(response.body?.code, 'package-too-large')
    assert.equal(response.body?.draft, undefined, '413 的响应里不许有草稿')
    /** 挡住的位置：路由自己的 `content-length` 声明预检（未读取 body、未当合法 JSON 解析）。 */
    const count = db.prepare('SELECT COUNT(*) AS n FROM task_drafts').get().n
    assert.equal(count, 0, '超限请求不能被当成合法 JSON 处理：一行草稿都不许落库')
  } finally {
    if (server !== undefined) await server.close()
    service.dispose()
    db.close()
    removeTempDir(home)
  }
})
