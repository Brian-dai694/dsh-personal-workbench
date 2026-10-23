/**
 * P5 工具层测试：`src/experts/tools.ts` 的 5 个生成工具。
 *
 * 覆盖：
 *  - 工具名逐字（§5.1）与"注册表里没有任何确认/安装工具"（AX-E34）
 *  - 参数只有 snake_case 域字段，**没有** session_id / root / absolute_path
 *  - owner 守卫的全部负例：无 session / 他会话草稿 / 版本不符 / installing / 未知 id
 *  - 成功路径只到 validate：草稿仍是 pending，正式根一个文件都没发布
 *  - 随包资产 `assets/expert-generation/methodology.md` 里的最小人格示例能被**真实 parser** 解析
 *
 * 全部用独立临时目录（绝不碰 ~/.dsh/workbench）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createExpertDraft, getExpertDraft, transitionExpertDraftInstall } from '../lib/db/repo/experts.js'
import { parsePersonaDocument } from '../lib/personas/parse.js'
import { resolveExpertRoots } from '../lib/experts/paths.js'
import { createExpertService } from '../lib/experts/service.js'
import {
  EXPERT_GENERATION_TOOL_NAMES,
  expertGenerationTools,
} from '../lib/experts/tools.js'

const AT = '2026-01-01T00:00:00.000Z'
const SESSION_A = 'session-expert-tools-aaaa'
const SESSION_B = 'session-expert-tools-bbbb'

const EXEC_A = { agent: { session: { id: SESSION_A } } }
const EXEC_B = { agent: { session: { id: SESSION_B } } }

const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 Demo Author',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction.',
  '',
].join('\n')

/** 与 methodology.md 里的示例同构的最小人格（group 走 frontmatter）。 */
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
  '## 判断与检查',
  '',
  '没有代码或运行证据时，不把推测写成已确认事实。',
  '',
  '## 技能与资源',
  '',
  '本专家没有必需技能。',
  '',
  '## 输出与停止条件',
  '',
  '输出结论、问题位置、影响、修正建议和验证办法。',
  '',
].join('\n')

/** 合法来源登记（1 个 MIT 源，许可全文随包暂存）。 */
function provenanceJson() {
  return JSON.stringify({
    version: 1,
    creationKind: 'original',
    sources: [],
    references: [],
    generationNote: '按用户需求独立创作。',
  })
}

async function withService(fn) {
  const root = mkdtempSync(join(tmpdir(), 'wb-expert-tools-'))
  const personasDir = join(root, 'personas')
  const skillsDir = join(root, 'skills')
  mkdirSync(personasDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  const db = openWorkbenchDb({ dbPath: join(root, 'workbench.db') })
  try {
    seedDictionaries(db)
    const service = createExpertService({
      db,
      ctx: { get: () => undefined },
      roots: resolveExpertRoots({ personasDir, skillsDir }),
      now: () => AT,
    })
    const tools = new Map(expertGenerationTools(service).map((tool) => [tool.name, tool]))
    return await fn({ root, personasDir, skillsDir, db, service, tools })
  } finally {
    db.close()
    removeTempDir(root)
  }
}

function removeTempDir(dir) {
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

/** 造一份属于某个会话的 pending 草稿（生产里由生成会话创建）。 */
function startDraft(db, sessionId = SESSION_A, request = '给我一个需求审查专家') {
  const created = createExpertDraft(db, { sessionId, request })
  return created.draft.id
}

function tool(tools, name) {
  const found = tools.get(name)
  assert.ok(found !== undefined, `工具必须存在：${name}`)
  return found
}

// ---------------------------------------------------------------------------
// 注册表契约（AX-E34）
// ---------------------------------------------------------------------------

test('AX-E34: 注册表就是那 5 个生成工具，没有任何确认/安装工具', async () => {
  await withService(({ tools }) => {
    assert.deepEqual([...tools.keys()], [...EXPERT_GENERATION_TOOL_NAMES])
    assert.deepEqual([...EXPERT_GENERATION_TOOL_NAMES], [
      'workbench_get_expert_draft',
      'workbench_submit_expert_draft',
      'workbench_stage_expert_file',
      'workbench_remove_expert_staged_file',
      'workbench_validate_expert_draft',
    ])
    for (const name of tools.keys()) {
      assert.equal(/confirm|install|approve|publish|commit/i.test(name), false, `不许有确认类工具：${name}`)
    }
  })
})

test('AX-E34: 工具参数只有 snake_case 域字段，没有 session_id / root / absolute_path', async () => {
  await withService(({ tools }) => {
    const allowed = new Set([
      'draft_id',
      'expected_version',
      'persona_md',
      'provenance_json',
      'skills_json',
      'area',
      'path',
      'content_utf8',
    ])
    for (const spec of tools.values()) {
      const keys = Object.keys(spec.parameters.properties ?? {})
      for (const key of keys) {
        assert.equal(allowed.has(key), true, `${spec.name} 出现了域外参数：${key}`)
        assert.equal(/^(session_id|root|absolute_path|sessionId|workspace)$/.test(key), false, `${spec.name}.${key} 不许存在`)
      }
      assert.equal(spec.parameters.type, 'object')
    }
    assert.deepEqual(Object.keys(tool(tools, 'workbench_get_expert_draft').parameters.properties ?? {}), [])
  })
})

test('AX-E34: 源码里工具层不引用任何确认/安装入口', () => {
  const source = readFileSync(new URL('../src/experts/tools.ts', import.meta.url), 'utf8')
  assert.equal(/confirmDraft|confirmExpertDraft|installExpert|runConfirm/.test(source), false, '工具层不许碰确认/安装')
  assert.equal(/from '\.\.\/api\//.test(source), false, '工具层不许 import 路由（HTTP 不是工具的执行路径）')
})

// ---------------------------------------------------------------------------
// workbench_get_expert_draft
// ---------------------------------------------------------------------------

test('tools: get 只按执行会话找草稿；没有草稿时 found:false 而不是报错', async () => {
  await withService(async ({ db, tools }) => {
    const none = await tool(tools, 'workbench_get_expert_draft').execute({}, EXEC_A)
    assert.equal(none.ok, true)
    assert.equal(none.found, false)
    assert.equal(none.message.length > 0, true)

    const draftId = startDraft(db)
    const found = await tool(tools, 'workbench_get_expert_draft').execute({}, EXEC_A)
    assert.equal(found.ok, true)
    assert.equal(found.found, true)
    assert.equal(found.draftId, draftId)
    assert.equal(found.contentVersion, 0)
    assert.equal(found.phase, 'editing')
    assert.equal(found.draftId.includes('/'), false)

    /** 别的会话看不到这份草稿（按 session 查，天然隔离）。 */
    const other = await tool(tools, 'workbench_get_expert_draft').execute({}, EXEC_B)
    assert.equal(other.ok, true)
    assert.equal(other.found, false)
  })
})

test('tools: get 没有执行会话身份 → 如实拒绝（没有 session_id 入参可绕）', async () => {
  await withService(async ({ tools }) => {
    const result = await tool(tools, 'workbench_get_expert_draft').execute({}, {})
    assert.equal(result.ok, false)
    assert.equal(result.code, 'draft-owner-mismatch')
    assert.match(result.message, /真实会话 id/)
    assert.match(result.message, /没有任何 session_id 入参/)
  })
})

// ---------------------------------------------------------------------------
// owner 守卫负例（5 个工具共用同一个 assertExpertDraftOwner）
// ---------------------------------------------------------------------------

test('tools: owner 守卫负例——他会话草稿 / 未知 id / 无 session 一律拒绝', async () => {
  await withService(async ({ db, tools }) => {
    const draftId = startDraft(db)
    const submit = tool(tools, 'workbench_submit_expert_draft')
    const args = { draft_id: draftId, expected_version: 0, persona_md: PERSONA_MD, provenance_json: provenanceJson() }

    const otherSession = await submit.execute(args, EXEC_B)
    assert.equal(otherSession.ok, false)
    assert.equal(otherSession.code, 'draft-owner-mismatch')

    const noSession = await submit.execute(args, {})
    assert.equal(noSession.ok, false)
    assert.equal(noSession.code, 'draft-owner-mismatch')

    const unknown = await submit.execute({ ...args, draft_id: '11111111-2222-4333-8444-555555555555' }, EXEC_A)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'draft-not-found')
  })
})

test('tools: owner 守卫负例——版本不符带 currentVersion；installing 期一律拒绝', async () => {
  await withService(async ({ db, tools }) => {
    const draftId = startDraft(db)
    const submit = tool(tools, 'workbench_submit_expert_draft')
    const base = { draft_id: draftId, expected_version: 0, persona_md: PERSONA_MD, provenance_json: provenanceJson() }

    const first = await submit.execute(base, EXEC_A)
    assert.equal(first.ok, true)
    assert.equal(first.contentVersion, 1)
    assert.match(first.message, /contentVersion=1/)

    const stale = await submit.execute({ ...base, expected_version: 0, persona_md: PERSONA_MD.replace('需求审查专家', '需求审查专家二号') }, EXEC_A)
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'draft-version-conflict')
    assert.equal(stale.currentVersion, 1, '失败要带当前版本，模型才能自愈')

    transitionExpertDraftInstall(db, draftId, 1, { phase: 'installing' })
    const installing = await submit.execute({ ...base, expected_version: 1 }, EXEC_A)
    assert.equal(installing.ok, false)
    assert.equal(installing.code, 'install-in-progress')

    /** installing 期间 validate 也必须被拒（不许在装的过程中重校验改 hash）。 */
    const validate = await tool(tools, 'workbench_validate_expert_draft').execute({ draft_id: draftId, expected_version: 1 }, EXEC_A)
    assert.equal(validate.ok, false)
    assert.equal(validate.code, 'install-in-progress')
  })
})

test('tools: validate 走 owner 守卫——他会话 / 未知 id / 版本不符都被拒', async () => {
  await withService(async ({ db, tools }) => {
    const draftId = startDraft(db)
    const validate = tool(tools, 'workbench_validate_expert_draft')

    const other = await validate.execute({ draft_id: draftId, expected_version: 0 }, EXEC_B)
    assert.equal(other.ok, false)
    assert.equal(other.code, 'draft-owner-mismatch', '§5.1：工具永远 requireSession=true')

    const unknown = await validate.execute({ draft_id: '11111111-2222-4333-8444-555555555555', expected_version: 0 }, EXEC_A)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'draft-not-found')

    const stale = await validate.execute({ draft_id: draftId, expected_version: 7 }, EXEC_A)
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'draft-version-conflict')
    assert.equal(stale.currentVersion, 0)
  })
})

// ---------------------------------------------------------------------------
// 正常流程：submit → stage → remove → validate
// ---------------------------------------------------------------------------

test('tools: submit/stage/validate 全流程，且**只推进到待确认**（正式根零写入）', async () => {
  await withService(async ({ db, personasDir, skillsDir, tools }) => {
    const draftId = startDraft(db)

    const submitted = await tool(tools, 'workbench_submit_expert_draft').execute({
      draft_id: draftId,
      expected_version: 0,
      persona_md: PERSONA_MD,
      provenance_json: provenanceJson(),
      skills_json: '[]',
    }, EXEC_A)
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')
    assert.equal(submitted.phase, 'editing')
    assert.equal(submitted.changed, true)
    assert.deepEqual(submitted.errors, [])

    const staged = await tool(tools, 'workbench_stage_expert_file').execute({
      draft_id: draftId,
      expected_version: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      content_utf8: MIT_TEXT,
    }, EXEC_A)
    assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')

    /** 幂等删除：不在索引里的路径也是 ok:true / changed:false。 */
    const removed = await tool(tools, 'workbench_remove_expert_staged_file').execute({
      draft_id: draftId,
      expected_version: staged.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/NOT-THERE.txt',
    }, EXEC_A)
    assert.equal(removed.ok, true)
    assert.equal(removed.changed, false)

    const validated = await tool(tools, 'workbench_validate_expert_draft').execute({
      draft_id: draftId,
      expected_version: removed.contentVersion,
    }, EXEC_A)
    assert.equal(validated.ok, true)
    assert.deepEqual(validated.errors, [])
    assert.equal(validated.manifestHash.length > 0, true, '校验通过要给 manifestHash（用户确认时要带）')
    assert.match(validated.message, /待用户在界面确认安装/)

    /** AX-E34：到 validate 为止草稿仍是 pending，正式根没有被发布。 */
    const row = db.prepare('SELECT status_code FROM task_drafts WHERE id = ?').get(draftId)
    assert.equal(row.status_code, 'pending')
    const generated = join(personasDir, 'generated')
    const published = existsSync(generated) ? readdirSync(generated) : []
    assert.deepEqual(published, [], '没有确认工具 → 正式根不该出现任何东西')
    assert.equal(existsSync(join(skillsDir, 'generated')), false)
    assert.equal(existsSync(join(personasDir, 'generated')), false)
  })
})

test('tools: validate 有错误时 ok:true + errors 非空（草稿仍 editing，可继续改）', async () => {
  await withService(async ({ db, tools }) => {
    const draftId = startDraft(db)
    /** 人格合法、来源登记合法，但**许可全文没暂存** → validate 报 source-license-missing，不是工具失败。 */
    const submitted = await tool(tools, 'workbench_submit_expert_draft').execute({
      draft_id: draftId,
      expected_version: 0,
      persona_md: PERSONA_MD,
      provenance_json: JSON.stringify({
        version: 1,
        creationKind: 'adapted',
        sources: [{
          id: 'demo',
          repository: 'https://github.com/example/demo',
          upstreamPath: 'agents/reviewer.md',
          commit: null,
          fetchedAt: AT,
          authors: ['Demo Author'],
          license: 'MIT',
          copyrightNotice: 'Copyright (c) 2026 Demo Author',
          licenseFile: 'sources/demo/LICENSE.txt',
          usedFor: ['persona'],
          modifications: '翻译成中文并删减示例。',
        }],
        references: [],
        generationNote: '按上游改写。',
      }),
      skills_json: '[]',
    }, EXEC_A)
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')

    const validated = await tool(tools, 'workbench_validate_expert_draft').execute({
      draft_id: draftId,
      expected_version: submitted.contentVersion,
    }, EXEC_A)
    assert.equal(validated.ok, true)
    assert.equal(validated.errors.length > 0, true, '缺许可全文必须报错，但仍是 ok:true（草稿待修复）')
    assert.equal(validated.phase, 'editing')
    /** 有 errors ⇒ 安装器会以 `draft-not-validated` 拒绝 confirm（hash 本身不构成"通过"）。 */
    assert.equal(typeof validated.manifestHash, 'string')
    assert.match(validated.message, /按 errors 的 field 精确修改/)
    const draft = getExpertDraft(db, draftId)
    assert.equal(draft.statusCode, 'pending', '校验失败不代表草稿被丢掉')
  })
})

test('tools: stage 的路径校验真的生效（越界 / 保留名 / 二进制扩展名）', async () => {
  await withService(async ({ db, tools }) => {
    const draftId = startDraft(db)
    const submit = await tool(tools, 'workbench_submit_expert_draft').execute({
      draft_id: draftId,
      expected_version: 0,
      persona_md: PERSONA_MD,
      provenance_json: provenanceJson(),
      skills_json: '[]',
    }, EXEC_A)
    const version = submit.contentVersion
    const stage = tool(tools, 'workbench_stage_expert_file')

    const escape = await stage.execute({
      draft_id: draftId,
      expected_version: version,
      area: 'persona-resource',
      path: '../escape.txt',
      content_utf8: 'x',
    }, EXEC_A)
    assert.equal(escape.ok, false)
    assert.equal(escape.code, 'invalid-path')

    const reserved = await stage.execute({
      draft_id: draftId,
      expected_version: version,
      area: 'persona-resource',
      path: 'workbench-install.json',
      content_utf8: '{}',
    }, EXEC_A)
    assert.equal(reserved.ok, false)
    assert.equal(reserved.code, 'invalid-path')

    const binary = await stage.execute({
      draft_id: draftId,
      expected_version: version,
      area: 'persona-resource',
      path: 'sources/demo/logo.png',
      content_utf8: 'not really png',
    }, EXEC_A)
    assert.equal(binary.ok, false)
    assert.equal(binary.code, 'invalid-path', '只接受文本扩展名（二进制靠扩展名先挡）')
  })
})

test('tools: 失败与漂移文案都不带服务端绝对路径（投影走服务层那一份）', async () => {
  await withService(async ({ db, personasDir, root, tools }) => {
    const draftId = startDraft(db)
    const staged = await tool(tools, 'workbench_stage_expert_file').execute({
      draft_id: draftId,
      expected_version: 0,
      area: 'persona-resource',
      path: 'sources/demo/NOT-THERE.txt',
      content_utf8: 'x',
    }, EXEC_A)
    assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')

    /** 磁盘上的暂存文件被删掉 → validate 报 staged-file-changed（原因文案来自 FS，必须被投影）。 */
    rmSync(join(personasDir, '.pending', draftId, 'files', 'sources', 'demo', 'NOT-THERE.txt'))
    const drifted = await tool(tools, 'workbench_validate_expert_draft').execute({
      draft_id: draftId,
      expected_version: staged.contentVersion,
    }, EXEC_A)
    assert.equal(drifted.ok, true)
    assert.equal(drifted.errors.some((issue) => issue.code === 'staged-file-changed'), true)
    assert.equal(JSON.stringify(drifted.errors).includes(root), false, '错误文案不许带绝对路径')

    const stale = await tool(tools, 'workbench_submit_expert_draft').execute({
      draft_id: draftId,
      expected_version: 99,
      persona_md: PERSONA_MD,
    }, EXEC_A)
    assert.equal(stale.ok, false)
    assert.equal(stale.message.includes(root), false)
    assert.equal(JSON.stringify(stale).includes(root), false)
  })
})

// ---------------------------------------------------------------------------
// 随包资产：methodology.md 的示例必须能被真实 parser 解析
// ---------------------------------------------------------------------------

test('assets: methodology.md 的最小人格示例过真实 parsePersonaDocument（group=工程、正文非空）', () => {
  const assetPath = new URL('../assets/expert-generation/methodology.md', import.meta.url)
  const text = readFileSync(assetPath, 'utf8')
  const fenced = /```markdown\r?\n([\s\S]*?)```/.exec(text)
  assert.ok(fenced !== null, 'methodology.md 必须内嵌一个 ```markdown 示例')

  const parsed = parsePersonaDocument(fenced[1])
  assert.equal(parsed.ok, true, parsed.ok === false ? JSON.stringify(parsed.diagnostics) : '示例必须能被真实解析器解析')
  assert.equal(parsed.document.group, '工程', 'group 只认 frontmatter')
  assert.equal(parsed.document.body.trim().length > 0, true)
  assert.match(parsed.document.body, /身份与职责/)
  assert.equal(parsed.document.name, '需求审查专家')

  /** 资产本身还要覆盖 §5.2 的 13 步，且不依赖本地技能库/团队记忆。 */
  for (const step of ['### 1.', '### 13.']) {
    assert.equal(text.includes(step), true, `methodology.md 缺 ${step}`)
  }
  assert.equal(text.includes('K-Dense-AI/scientific-agents'), true)
  assert.equal(text.includes('msitarzewski/agency-agents'), true)
})

test('assets: methodology.md 是 LF，且不含绝对路径/仓库 cwd', () => {
  const assetPath = new URL('../assets/expert-generation/methodology.md', import.meta.url)
  const raw = readFileSync(assetPath, 'utf8')
  assert.equal(raw.includes('\r'), false, '资产必须是 LF')
  assert.equal(/[A-Za-z]:[\\/]/.test(raw), false, '资产里不许有绝对路径')
})
