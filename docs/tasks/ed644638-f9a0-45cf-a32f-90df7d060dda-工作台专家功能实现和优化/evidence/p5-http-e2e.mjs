/**
 * P5 独立证据（**不属于仓库测试**）：无 UI 的真实 HTTP「创建 → 暂存 → 校验 → 确认 → catalog」全链。
 *
 * 为什么单独写：仓库测试分开验证"路由"和"工具"两层，各自注入替身；这条链要证明的是
 * **两层接在同一份真实服务上**跑得通，并且**用户可见的 HTTP 响应里没有服务端布局**：
 *
 *   1. 真实 `http.createServer` + `makeRoutes(db, { experts })`（不是直调 service）；
 *   2. 生成侧只走 §5.1 的 5 个工具（模型能用的那条路），确认侧只走用户能点的 HTTP；
 *   3. confirm 后断言正式库真的出现受管发布物（人格 + `demo-skill` 清单）；
 *   4. 再次 confirm → 幂等回放（`replayed: true`，不重复创建）；
 *   5. 全程扫描每个响应体：临时根绝对路径 / journal 名字一个都不许出现；
 *   6. 另一份草稿走 abandon → 只清自己的暂存，正式库不受影响。
 *
 * 用法（必须先 `pnpm build`）：
 *   node "docs/tasks/ed644638-f9a0-45cf-a32f-90df7d060dda-工作台专家功能实现和优化/evidence/p5-http-e2e.mjs"
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const load = (relative) => import(pathToFileURL(join(repoRoot, 'lib', relative)).href)

const plugin = await load('index.js')
const { openWorkbenchDb } = await load('db/database.js')
const { seedDictionaries } = await load('db/seed.js')
const { createExpertService } = await load('experts/service.js')
const { makeRoutes } = await load('api/routes.js')
const { expertGenerationTools, EXPERT_GENERATION_TOOL_NAMES } = await load('experts/tools.js')

const AT = '2026-01-01T00:00:00.000Z'
const SESSION = 'session-evidence-p5-http-0001'
const SESSION_ABANDON = 'session-evidence-p5-http-0002'
const COPYRIGHT = 'Copyright (c) 2026 Demo Authors'
const MIT_TEXT = [
  'MIT License',
  '',
  COPYRIGHT,
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
  '',
].join('\r\n')
const SKILL_MD = ['---', 'name: demo-skill', 'description: 演示技能', '---', '', '## 步骤', '1. 读取输入', '2. 输出结论', ''].join('\n')
const PERSONA_MD = [
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
  '你负责审查用户给出的需求和设计，识别缺失条件、互相矛盾的约束和无法验收的表述。',
  '',
  '## 工作流程',
  '',
  '1. 提取目标、输入、输出和约束。',
  '2. 核对每个主流程及失败分支。',
  '3. 以严重程度排序问题，给出依据和可以执行的修改。',
  '',
].join('\n')

/** 合法来源登记（1 个 MIT 源；许可全文必须随后原样暂存，否则校验必须报错）。 */
const TRANSLATED_PROVENANCE = {
  version: 1,
  creationKind: 'translated',
  sources: [
    {
      id: 'demo',
      repository: 'https://github.com/example/demo',
      upstreamPath: 'agents/reviewer.md',
      commit: 'a'.repeat(40),
      fetchedAt: AT,
      authors: ['Demo Author'],
      license: 'MIT',
      copyrightNotice: COPYRIGHT,
      licenseFile: 'sources/demo/LICENSE.txt',
      usedFor: ['persona', 'skill'],
      modifications: '翻译为中文',
    },
  ],
  references: [],
  generationNote: '依据上游 MIT 素材改写并登记来源',
}

let passed = 0
const lines = []
function check(label, fn) {
  fn()
  passed += 1
  lines.push(`  ✔ ${label}`)
}

function sha256ish(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-wb-p5-http-e2e-'))
const db = openWorkbenchDb({ dbPath: join(root, 'workbench.db') })
seedDictionaries(db)

/** 与 `index.ts` 生产口径一致：只给 `home`，其余根由宿主目录约定算出来。 */
const service = createExpertService({ db, ctx: { get: () => undefined }, roots: { home: root }, now: () => AT })
const { personasDir, skillsDir } = service.roots

const routes = makeRoutes(db, { experts: service })
let server
let serverWithSkills
const bodies = []
const fetchAt = async (baseUrl, method, path, body) => {
  const init = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  bodies.push({ path, text })
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

let base
const request = (method, path, body) => fetchAt(base, method, path, body)
const safeToRemove = root.startsWith(tmpdir()) && root.includes('dsh-wb-p5-http-e2e-')
try {
  assert.equal(safeToRemove, true, '临时根必须落在系统临时目录里且带本脚本前缀')
  check('根解析：`roots={home}` 把人格库/技能库都放在临时 home 内（生产同口径）', () => {
    assert.equal(personasDir.startsWith(root), true, personasDir)
    assert.equal(skillsDir.startsWith(root), true, skillsDir)
  })
  check('顶层 inject 逐字未变（可选 skills 服务绝不进 inject）', () => {
    assert.deepEqual([...plugin.inject], ['webServer', 'systemPrompt', 'tools', 'commands'])
  })

  const makeServer = (routeList) =>
    http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      for (const route of routeList) {
        if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
        if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  const listen = async (target) => {
    await new Promise((done) => target.listen(0, '127.0.0.1', done))
    return `http://127.0.0.1:${target.address().port}`
  }
  server = makeServer(routes)
  base = await listen(server)

  // --- 1. 能力与方法论（HTTP） -------------------------------------------------
  const capabilities = await request('GET', '/api/workbench/experts/capabilities')
  check('capabilities：生成可用、skills 如实降级、子代理能力不假装可用、enabled 是设置真值', () => {
    assert.equal(capabilities.status, 200)
    const body = capabilities.json
    assert.equal(body.generation.available, true)
    assert.equal(body.skills.available, false)
    assert.equal(body.skills.reason, 'skill-service-unavailable')
    assert.equal(body.manualSummon.available, false)
    assert.equal(body.manualSummon.reason, 'expert-subagent-unavailable')
    assert.equal(body.autoSummon.available, false)
    assert.equal(body.autoSummon.enabled, false)
    assert.equal(body.providerName, 'personal-workbench')
  })

  const methodology = await request('GET', '/api/workbench/experts/methodology')
  check('methodology：version 1、随包资产可读且含生成/校验工具名', () => {
    assert.equal(methodology.status, 200)
    assert.equal(methodology.json.version, 1)
    assert.equal(typeof methodology.json.text, 'string')
    assert.equal(methodology.json.text.includes('workbench_get_expert_draft'), true)
    assert.equal(methodology.json.text.includes('workbench_validate_expert_draft'), true)
  })

  // --- 2. generation-start（HTTP）→ 5 个生成工具（模型路径） -------------------
  const start = await request('POST', '/api/workbench/experts/generation-start', {
    sessionId: SESSION,
    request: '给我一个需求审查专家',
    workspaceId: 'ws-evidence',
  })
  check('generation-start：建 pending 草稿、内容版本 0', () => {
    assert.equal(start.status, 200)
    assert.equal(start.json.ok, true)
    assert.equal(start.json.draft.statusCode, 'pending')
    assert.equal(start.json.draft.contentVersion, 0)
    assert.equal(typeof start.json.draft.draftId === 'string' && start.json.draft.draftId.length > 0, true)
  })
  const draftId = start.json.draft.draftId

  const reuse = await request('POST', '/api/workbench/experts/generation-start', {
    sessionId: SESSION,
    request: '给我一个需求审查专家',
    workspaceId: 'ws-evidence',
  })
  const conflict = await request('POST', '/api/workbench/experts/generation-start', {
    sessionId: SESSION,
    request: '换个需求：给我一个性能诊断专家',
    workspaceId: 'ws-evidence',
  })
  check('generation-start：同 session 同 request 复用；不同 request → 409 generation-conflict', () => {
    assert.equal(reuse.json.draft.draftId, draftId)
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.code, 'generation-conflict')
  })

  const tools = new Map(expertGenerationTools(service).map((tool) => [tool.name, tool]))
  const exec = { agent: { session: { id: SESSION } } }
  const execOther = { agent: { session: { id: 'someone-else' } } }
  check('工具注册表：就是 §5.1 的 5 个名字，且没有任何确认/安装工具', () => {
    assert.deepEqual([...tools.keys()], [...EXPERT_GENERATION_TOOL_NAMES])
    for (const name of tools.keys()) assert.equal(/confirm|install|approve|publish/i.test(name), false, name)
  })

  const got = await tools.get('workbench_get_expert_draft').execute({}, exec)
  check('workbench_get_expert_draft：按执行会话取到同一份草稿（无 session_id 入参）', () => {
    assert.equal(got.ok, true)
    assert.equal(got.found, true)
    assert.equal(got.draftId, draftId)
    assert.equal(got.contentVersion, 0)
  })

  const submit = await tools.get('workbench_submit_expert_draft').execute({
    draft_id: draftId,
    expected_version: 0,
    persona_md: PERSONA_MD,
    provenance_json: JSON.stringify(TRANSLATED_PROVENANCE),
    skills_json: JSON.stringify([
      { name: 'demo-skill', required: true, action: 'install', sourceId: 'demo', packageFiles: ['SKILL.md', 'sources/demo/LICENSE.txt'], reason: '需要它的方法论' },
    ]),
  }, exec)
  check('workbench_submit_expert_draft：提交人格与元数据、版本 +1、清 validation', () => {
    assert.equal(submit.ok, true, submit.ok === false ? submit.message : 'submit 失败')
    assert.equal(submit.contentVersion, 1)
    assert.equal(submit.phase, 'editing')
  })

  const denied = await tools.get('workbench_submit_expert_draft').execute({
    draft_id: draftId,
    expected_version: 1,
    persona_md: PERSONA_MD,
    provenance_json: JSON.stringify({ version: 1, creationKind: 'original', sources: [], references: [], generationNote: 'x' }),
    skills_json: JSON.stringify([]),
  }, execOther)
  check('owner 守卫：另一个会话的同一份草稿 → 拒绝（授权只来自 exec.agent）', () => {
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'draft-owner-mismatch')
  })

  let version = submit.contentVersion
  const staged = [
    ['persona-resource', 'sources/demo/LICENSE.txt', MIT_TEXT],
    ['skill', 'demo-skill/SKILL.md', SKILL_MD],
    ['skill', 'demo-skill/sources/demo/LICENSE.txt', MIT_TEXT],
  ]
  for (const [area, path, content] of staged) {
    const result = await tools.get('workbench_stage_expert_file').execute({
      draft_id: draftId,
      expected_version: version,
      area,
      path,
      content_utf8: content,
    }, exec)
    assert.equal(result.ok, true, result.ok === false ? `${area}:${path} → ${result.message}` : 'stage 失败')
    version = result.contentVersion
  }
  check(`workbench_stage_expert_file：逐件暂存成功（${staged.length} 件，版本递增到 ${version}）`, () => {
    assert.equal(version, 4)
  })

  const laterStage = await tools.get('workbench_stage_expert_file').execute({
    draft_id: draftId,
    expected_version: 1,
    area: 'skill',
    path: 'demo-skill/SKILL.md',
    content_utf8: SKILL_MD,
  }, exec)
  check('版本控制：用旧 expected_version 暂存 → 拒绝并回当前版本', () => {
    assert.equal(laterStage.ok, false)
    assert.equal(laterStage.code, 'draft-version-conflict')
    assert.equal(laterStage.currentVersion, version)
  })

  const traversed = await tools.get('workbench_stage_expert_file').execute({
    draft_id: draftId,
    expected_version: version,
    area: 'skill',
    path: '../outside/SKILL.md',
    content_utf8: SKILL_MD,
  }, exec)
  check('路径守卫：越界路径（`..`）在工具这一层就被拒', () => {
    assert.equal(traversed.ok, false)
    assert.equal(traversed.code, 'invalid-path')
  })

  const toolValidate = await tools.get('workbench_validate_expert_draft').execute({
    draft_id: draftId,
    expected_version: version,
  }, exec)
  check('workbench_validate_expert_draft：工具路径校验通过（合法来源 + 许可全文）', () => {
    assert.equal(toolValidate.ok, true, toolValidate.ok === false ? toolValidate.message : 'validate 失败')
    assert.deepEqual(toolValidate.errors, [])
    assert.equal(sha256ish(toolValidate.manifestHash), true)
  })
  version = toolValidate.contentVersion

  // --- 3. HTTP 校验 / 读暂存文件 ----------------------------------------------
  const httpValidate = await request('POST', `/api/workbench/experts/drafts/${draftId}/validate`, { expectedVersion: version })
  check('HTTP validate：ok:true、errors 为空、phase 进入 validated（HITL 前仍不安装）', () => {
    assert.equal(httpValidate.status, 200)
    assert.equal(httpValidate.json.ok, true)
    assert.equal(httpValidate.json.draft.phase, 'validated')
    assert.deepEqual(httpValidate.json.validation.errors, [])
  })
  const manifestHash = httpValidate.json.validation.manifestHash
  check('HTTP validate：正式库此时一个文件都没有（确认前零写入）', () => {
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'SKILL.md')), false)
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'workbench-install.json')), false)
  })

  const readFile = await request(
    'GET',
    `/api/workbench/experts/drafts/${draftId}/file?area=skill&path=${encodeURIComponent('demo-skill/SKILL.md')}`,
  )
  check('HTTP file：只读这份草稿索引里的文件，字节与输入一致', () => {
    assert.equal(readFile.status, 200)
    assert.equal(readFile.json.text, SKILL_MD)
    assert.equal(readFile.json.bytes, Buffer.byteLength(SKILL_MD, 'utf8'))
    assert.equal(readFile.json.area, 'skill')
    assert.equal(readFile.json.path, 'demo-skill/SKILL.md')
  })

  const outsideRead = await request(
    'GET',
    `/api/workbench/experts/drafts/${draftId}/file?area=skill&path=${encodeURIComponent('../workbench.db')}`,
  )
  check('HTTP file：越界 / 不在索引里的路径拒绝（没有任意文件读）', () => {
    assert.equal(outsideRead.status >= 400, true, `${outsideRead.status}`)
    assert.equal(outsideRead.json.ok, false)
  })

  const catalogBefore = await request('GET', '/api/workbench/experts/catalog')
  check('HTTP catalog（确认前）：新专家还不存在', () => {
    assert.equal(catalogBefore.status, 200)
    assert.equal(catalogBefore.json.experts.some((row) => String(row.id).startsWith('generated/')), false)
  })

  // --- 4. 用户确认（HTTP）→ 受管发布 -----------------------------------------
  const confirm = await request('POST', `/api/workbench/drafts/${draftId}/confirm`, { expectedVersion: version, manifestHash })
  check('HTTP confirm：安装结果在 `expert` 字段，首次不是回放', () => {
    assert.equal(confirm.status, 200, confirm.text)
    assert.equal(confirm.json.ok, true)
    assert.equal(confirm.json.replayed, false)
    assert.equal(typeof confirm.json.expert, 'object')
    assert.equal(confirm.json.expert.kind, 'expert')
    assert.equal(confirm.json.expert.draftId, draftId)
    assert.equal(confirm.json.expert.installedSkills.includes('demo-skill'), true, confirm.text)
    assert.equal(Array.isArray(confirm.json.expert.reusedSkills), true)
  })

  const collectPersonaFiles = () => {
    const found = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === '.pending') continue
          walk(join(dir, entry.name))
        } else if (entry.name.endsWith('.md')) {
          found.push(join(dir, entry.name))
        }
      }
    }
    walk(personasDir)
    return found
  }
  const personaFiles = collectPersonaFiles()
  check('受管发布：正式人格库出现发布产物，技能包（含清单）就位', () => {
    assert.equal(personaFiles.length >= 1, true, '人格库应当有发布产物')
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'workbench-install.json')), true)
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'sources', 'demo', 'LICENSE.txt')), true)
  })

  const manifest = JSON.parse(readFileSync(join(skillsDir, 'demo-skill', 'workbench-install.json'), 'utf8'))
  check('受管发布：清单 packageHash 是 64 位 hex、files 逐条记录字节数', () => {
    assert.equal(sha256ish(manifest.packageHash), true)
    assert.equal(Array.isArray(manifest.files), true)
    assert.equal(manifest.files.length >= 2, true)
    for (const file of manifest.files) assert.equal(Number.isInteger(file.bytes), true, JSON.stringify(file))
  })

  const catalogAfter = await request('GET', '/api/workbench/experts/catalog')
  check('HTTP catalog（确认后）：受管发布被真的发现，但无 skills 服务时如实降级为 dependency-unavailable', () => {
    assert.equal(catalogAfter.status, 200)
    const expertId = confirm.json.expert.expertId
    assert.equal(expertId.startsWith('generated/'), true, expertId)
    const row = catalogAfter.json.experts.find((entry) => entry.id === expertId)
    assert.ok(row !== undefined, `catalog 里应当出现 ${expertId}：${JSON.stringify(catalogAfter.json.experts.map((e) => e.id))}`)
    // 发现链交给 `personasDir` ⇒ 来源是用户库（不是伪造的 'generated' 来源）；受管身份由 id 前缀表达。
    assert.equal(row.source, 'user', JSON.stringify(row))
    assert.equal(row.provenanceState, 'recorded')
    assert.equal(row.enabled, true)
    assert.equal(row.status, 'dependency-unavailable', JSON.stringify(row))
    assert.equal(row.issues.some((issue) => issue.code === 'skill-service-unavailable'), true, JSON.stringify(row.issues))
    assert.equal(row.requiredSkills.some((skill) => skill.name === 'demo-skill' && skill.available === false), true, JSON.stringify(row.requiredSkills))
    // 依赖不可用的专家**不得**混进可绑定的 personas 摘要。
    assert.equal(catalogAfter.json.personas.some((summary) => summary.id === expertId), false, JSON.stringify(catalogAfter.json.personas))
  })

  // --- 4b. 挂上真实 P4 provider（假 skills 服务）：同一份受管发布应当变可用 -------
  const providerModule = await load('experts/skill-provider.js')
  let invalidations = 0
  const provider = providerModule.createWorkbenchSkillProvider({
    skillsDir,
    personasDir,
    platform: process.platform,
  })({ signal: undefined, invalidate: () => { invalidations += 1 } })
  const listOptions = []
  const skillsService = {
    async list(options) {
      listOptions.push(options ?? null)
      const observation = await provider.list(options ?? {})
      return Array.isArray(observation) ? observation : (observation?.candidates ?? [])
    },
    async get(name, options) {
      const candidates = await skillsService.list(options)
      const candidate = candidates.find((entry) => entry.name === name)
      if (candidate === undefined) return undefined
      return provider.get(candidate, options ?? {})
    },
  }
  const serviceWithSkills = createExpertService({
    db,
    ctx: { get: (name) => (name === 'skills' ? skillsService : undefined) },
    roots: { home: root },
    now: () => AT,
  })
  const capsWithSkills = await serviceWithSkills.capabilities()
  check('capabilities（挂真实 provider 后）：skills 可用、providerName 指向工作台 provider、生成能力不受影响', () => {
    assert.equal(capsWithSkills.skills.available, true, JSON.stringify(capsWithSkills.skills))
    assert.equal(capsWithSkills.providerName, providerModule.WORKBENCH_SKILL_PROVIDER_NAME)
    assert.equal(capsWithSkills.generation.available, true, JSON.stringify(capsWithSkills.generation))
    // P6 未实现 ⇒ 手动/自主召唤即便挂了 skills 也必须如实说"子代理能力不可用"。
    assert.equal(capsWithSkills.manualSummon.available, false, JSON.stringify(capsWithSkills.manualSummon))
    assert.equal(capsWithSkills.autoSummon.available, false, JSON.stringify(capsWithSkills.autoSummon))
  })
  serverWithSkills = makeServer(makeRoutes(db, { experts: serviceWithSkills }))
  const baseWithSkills = await listen(serverWithSkills)
  const catalogWithSkills = await fetchAt(baseWithSkills, 'GET', '/api/workbench/experts/catalog')
  check('HTTP catalog（挂真实 provider 后）：同一份受管发布由 dependency-unavailable 变为 usable', () => {
    assert.equal(catalogWithSkills.status, 200, catalogWithSkills.text)
    const expertId = confirm.json.expert.expertId
    const row = catalogWithSkills.json.experts.find((entry) => entry.id === expertId)
    assert.ok(row !== undefined, JSON.stringify(catalogWithSkills.json.experts.map((e) => e.id)))
    assert.equal(row.status, 'usable', JSON.stringify(row))
    const required = row.requiredSkills.find((skill) => skill.name === 'demo-skill')
    assert.equal(required?.available, true, JSON.stringify(row.requiredSkills))
    assert.equal(required?.provider, providerModule.WORKBENCH_SKILL_PROVIDER_NAME, JSON.stringify(required))
    // 没有 live agent ⇒ 只能给 preliminary 结论，不能假装已经按 scope 仲裁过。
    assert.equal(required?.preliminary, true, JSON.stringify(required))
    assert.equal(catalogWithSkills.json.preliminary, true)
    // 依赖满足后，该专家才允许出现在可绑定摘要里。
    assert.equal(catalogWithSkills.json.personas.some((summary) => summary.id === expertId), true)
    assert.equal(listOptions.length > 0, true)
  })
  const preflightWithSkills = await fetchAt(baseWithSkills, 'POST', '/api/workbench/experts/preflight', {
    personaId: confirm.json.expert.expertId,
  })
  check('HTTP preflight（挂真实 provider 后）：usable:true、requisite 技能来自工作台 provider', () => {
    assert.equal(preflightWithSkills.status, 200, preflightWithSkills.text)
    const result = preflightWithSkills.json
    assert.equal(result.usable, true, JSON.stringify(result))
    assert.equal(result.preliminary, true)
    const skill = result.effectiveSkills.find((entry) => entry.name === 'demo-skill')
    assert.equal(skill?.available, true, JSON.stringify(result.effectiveSkills))
    assert.equal(skill?.provider, providerModule.WORKBENCH_SKILL_PROVIDER_NAME, JSON.stringify(skill))
    assert.equal(skill?.action === undefined || typeof skill.action === 'string', true)
  })
  check('provider 未被误触发失效（清单未被改动时 invalidate 不该被调用）', () => {
    assert.equal(invalidations, 0, `invalidate 被调用了 ${invalidations} 次`)
  })

  const replay = await request('POST', `/api/workbench/drafts/${draftId}/confirm`, { expectedVersion: version, manifestHash })
  check('HTTP confirm（再次）：幂等回放 `replayed: true`，不重复创建', () => {
    assert.equal(replay.status, 200, replay.text)
    assert.equal(replay.json.ok, true)
    assert.equal(replay.json.replayed, true)
    assert.deepEqual(replay.json.expert.installedSkills, confirm.json.expert.installedSkills)
  })

  const staleConfirm = await request('POST', `/api/workbench/drafts/${draftId}/confirm`, { expectedVersion: version - 1, manifestHash })
  check('已确认草稿 + 旧 version：走设计好的幂等回放（重放优先于版本校验，客户端丢响应也能恢复）', () => {
    assert.equal(staleConfirm.status, 200, staleConfirm.text)
    assert.equal(staleConfirm.json.ok, true)
    assert.equal(staleConfirm.json.replayed, true)
    assert.equal(staleConfirm.json.expert.manifestHash, confirm.json.expert.manifestHash)
  })

  // --- 5. 校验未过：errors 非空也必须 200/ok:true 且 phase 留在 editing --------
  const SESSION_BAD = 'session-evidence-p5-http-0003'
  const badStart = await request('POST', '/api/workbench/experts/generation-start', {
    sessionId: SESSION_BAD,
    request: '缺许可原件的专家',
    workspaceId: 'ws-evidence',
  })
  const badId = badStart.json.draft.draftId
  const badSubmit = await tools.get('workbench_submit_expert_draft').execute({
    draft_id: badId,
    expected_version: 0,
    persona_md: PERSONA_MD,
    provenance_json: JSON.stringify(TRANSLATED_PROVENANCE),
    skills_json: JSON.stringify([]),
  }, { agent: { session: { id: SESSION_BAD } } })
  /** 故意**不**暂存 `sources/demo/LICENSE.txt`：许可全文缺失必须被校验拦下。 */
  const badValidate = await request('POST', `/api/workbench/experts/drafts/${badId}/validate`, {
    expectedVersion: badSubmit.contentVersion,
  })
  check('HTTP validate（缺许可全文）：仍 200/ok:true，errors 非空且 phase 留在 editing', () => {
    assert.equal(badSubmit.ok, true, badSubmit.ok === false ? badSubmit.message : '提交应成功')
    assert.equal(badValidate.status, 200, badValidate.text)
    assert.equal(badValidate.json.ok, true)
    assert.equal(badValidate.json.validation.errors.length > 0, true, badValidate.text)
    assert.equal(badValidate.json.draft.phase, 'editing')
  })
  check('HTTP validate（缺许可全文）：缺项错误码稳定，且校验未过不发布任何东西', () => {
    const codes = badValidate.json.validation.errors.map((entry) => entry.code)
    assert.equal(codes.includes('source-license-missing'), true, JSON.stringify(codes))
    const now = []
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === '.pending') continue
          collect(join(dir, entry.name))
        } else if (entry.name.endsWith('.md')) {
          now.push(join(dir, entry.name))
        }
      }
    }
    collect(personasDir)
    assert.deepEqual(now, personaFiles, '正式人格库必须沿用上一次快照')
  })

  const unvalidatedConfirm = await request('POST', `/api/workbench/drafts/${badId}/confirm`, {
    expectedVersion: badSubmit.contentVersion,
    manifestHash: 'f'.repeat(64),
  })
  check('AX-E32：未过校验的 pending 草稿 confirm → 409，且正式库仍零写入', () => {
    assert.equal(unvalidatedConfirm.status, 409, unvalidatedConfirm.text)
    assert.equal(unvalidatedConfirm.json.ok, false)
    assert.deepEqual(collectPersonaFiles(), personaFiles, '被拒的 confirm 不得发布任何东西')
  })

  const stalePendingConfirm = await request('POST', `/api/workbench/drafts/${badId}/confirm`, {
    expectedVersion: badSubmit.contentVersion - 1,
    manifestHash,
  })
  check('AX-E32：pending 草稿用旧 version confirm → 409 draft-version-conflict，且不安装用户没看过的新内容', () => {
    assert.equal(stalePendingConfirm.status, 409, stalePendingConfirm.text)
    assert.equal(stalePendingConfirm.json.ok, false)
    assert.equal(stalePendingConfirm.json.code, 'draft-version-conflict', stalePendingConfirm.text)
  })

  const staleHashConfirm = await request('POST', `/api/workbench/drafts/${badId}/confirm`, {
    expectedVersion: badSubmit.contentVersion,
    manifestHash: 'f'.repeat(64),
  })
  check('AX-E32：版本对但 manifestHash 不符 → 409，且被拒后仍未发布', () => {
    assert.equal(staleHashConfirm.status, 409, staleHashConfirm.text)
    assert.equal(staleHashConfirm.json.ok, false)
    assert.deepEqual(collectPersonaFiles(), personaFiles, 'hash 不符的 confirm 不得发布任何东西')
  })

  // --- 6. 另一份草稿走 abandon ------------------------------------------------
  const second = await request('POST', '/api/workbench/experts/generation-start', {
    sessionId: SESSION_ABANDON,
    request: '再要一个方案设计专家',
    workspaceId: 'ws-evidence',
  })
  const secondId = second.json.draft.draftId
  const execSecond = { agent: { session: { id: SESSION_ABANDON } } }
  const secondStage = await tools.get('workbench_stage_expert_file').execute({
    draft_id: secondId,
    expected_version: 0,
    area: 'skill',
    path: 'demo-skill/SKILL.md',
    content_utf8: '不该被发布',
  }, execSecond)
  assert.equal(secondStage.ok, true, secondStage.message)
  const pendingDir = join(skillsDir, '.pending', secondId)
  const abandoned = await request('POST', `/api/workbench/drafts/${secondId}/abandon`, {
    expectedVersion: secondStage.contentVersion,
    reason: '不需要了',
  })
  check('HTTP abandon：草稿放弃、只清自己的暂存、正式库不受影响', () => {
    assert.equal(abandoned.status, 200, abandoned.text)
    assert.equal(abandoned.json.ok, true)
    assert.equal(existsSync(pendingDir), false, '这份草稿的暂存目录应被清掉')
    assert.equal(SKILL_MD.startsWith('不该'), false)
    assert.equal(readFileSync(join(skillsDir, 'demo-skill', 'SKILL.md'), 'utf8'), SKILL_MD, '正式技能包不许被放弃流程改动')
  })

  const abandonedAgain = await request('POST', `/api/workbench/drafts/${secondId}/abandon`, {
    expectedVersion: secondStage.contentVersion,
  })
  check('HTTP abandon（再次）：已放弃的草稿 → 409（不是 200 假成功）', () => {
    assert.equal(abandonedAgain.status, 409, abandonedAgain.text)
  })

  // --- 6. 响应泄露扫描 --------------------------------------------------------
  check('全链泄漏扫描：任何响应体里都不出现临时根绝对路径 / journal / ticket', () => {
    const roots = [root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\')]
    const forbidden = ['install-journal', 'ticket', 'accessToken', 'authorization']
    for (const entry of bodies) {
      for (const needle of roots) {
        assert.equal(entry.text.includes(needle), false, `${entry.path} 泄露了根：${needle}`)
      }
      for (const needle of forbidden) {
        assert.equal(entry.text.includes(needle), false, `${entry.path} 泄露了内部字段：${needle}`)
      }
    }
  })
  check('全链泄漏扫描：连宿主可见的路由数量也只在专家前缀下（没有第二套围栏/端点）', () => {
    const expertRoutes = routes.filter((route) => route.path.startsWith('/api/workbench/experts'))
    assert.equal(expertRoutes.length, 1)
    assert.equal(expertRoutes[0].kind, 'prefix')
  })

  lines.push('')
  lines.push(`P5 HTTP 端到端证据：${passed}/${passed} PASS，响应样本 ${bodies.length} 条`)
  console.log(lines.join('\n'))
  console.log(`EXIT=0`)
} catch (error) {
  console.error(lines.join('\n'))
  console.error(`\n✖ ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  if (server !== undefined) await new Promise((done) => server.close(done))
  if (serverWithSkills !== undefined) await new Promise((done) => serverWithSkills.close(done))
  try {
    db.close()
  } catch {}
  if (safeToRemove) rmSync(root, { recursive: true, force: true })
}
