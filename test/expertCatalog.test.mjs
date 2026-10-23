/**
 * 专家目录（`src/experts/catalog.ts`）的测试。
 *
 * 覆盖验收断言 **AX-E29 / AX-E30**，以及 `buildAutoExpertPrompt` 的 30 条 / 80 字符 /
 * 6000 字符 / 排序 / 文案 / `interpolate:false`，和 AX-E48/E49 中 P4 能做的
 * **scope 前置断言**（真实 `scopeOf` 参与 `skills.list/get` 的传参）。
 *
 * ## 诚实性约定
 *
 * `skills` 服务在本仓**不存在真实实现**（宿主 runtime）：
 * - 需要"注册表里有什么"的用例，用 `createWorkbenchSkillProjection()` 直接喂一份**投影**
 *   （这等价于宿主 `list()` 之后的状态，跳过的是宿主自己的合并仲裁）；
 * - 需要断言"真调了 list/get 且传了什么"的用例，用**spy 服务**记录参数；
 * - `scopeOf` 用真实 `@deepseek-ai/dsh-scope`（devDependency）真跑。
 *
 * 真实宿主注册表的仲裁、真实 provider 重载**没有**运行，已写进交接的未验证项。
 *
 * 每个用例一个 `mkdtempSync` 临时根；`finally` 只删自己核验过的目录，从不碰 `~/.dsh/workbench`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createExpertDraft, defaultExpertId } from '../lib/db/repo/experts.js'
import { writePersonaSettings } from '../lib/db/repo/personas.js'
import { submitExpertDraft } from '../lib/experts/drafts.js'
import { resolveExpertRoots } from '../lib/experts/paths.js'
import {
  AUTO_EXPERT_PROMPT_BLOCK_NAME,
  AUTO_EXPERT_PROMPT_DESCRIPTION_MAX_CHARS,
  AUTO_EXPERT_PROMPT_MAX_ENTRIES,
  AUTO_EXPERT_PROMPT_MAX_TOTAL_CHARS,
  AUTO_EXPERT_PROMPT_ORDER,
  buildAutoExpertPrompt,
  listExpertCatalog,
  preflightExpert,
} from '../lib/experts/catalog.js'
import { createWorkbenchSkillProjection } from '../lib/experts/host-adapter.js'
import {
  WORKBENCH_SKILL_PROVIDER_NAME,
  createWorkbenchSkillProvider,
  readWorkbenchSkillProviderDiagnostics,
} from '../lib/experts/skill-provider.js'
import { writeManagedSkillManifest } from './fixtures/expertSkillFixture.mjs'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function removeTempDir(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 9) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

const PREFIX = 'dsh-wb-expert-catalog-'
const AT = '2026-01-01T00:00:00.000Z'
const HEX = 'a'.repeat(64)
const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const UUID_C = 'cccccccc-dddd-4eee-8fff-000000000000'
const UUID_D = 'dddddddd-1111-4222-8333-444444444444'

function withCatalogFixture(run) {
  const root = mkdtempSync(join(tmpdir(), PREFIX))
  const personasDir = join(root, 'personas')
  const skillsDir = join(root, 'skills')
  const builtinDir = join(root, 'builtin')
  const externalDir = join(root, 'external')
  for (const dir of [personasDir, skillsDir, builtinDir, externalDir]) mkdirSync(dir, { recursive: true })
  const dbPath = join(root, 'workbench.db')
  const db = openWorkbenchDb({ dbPath })
  seedDictionaries(db)
  const roots = resolveExpertRoots({ personasDir, skillsDir })
  const context = { db, roots, now: () => AT }
  /** 目录判定用的根覆盖（与 `ExpertCatalogRootOverrides` 同形）。 */
  const overrides = { personasDir, skillsDir, userDir: personasDir, builtinDir, externalDir }
  const safeToRemove = root.startsWith(tmpdir()) && root.includes(PREFIX)
  return Promise.resolve()
    .then(() => run({ root, db, roots, context, personasDir, skillsDir, builtinDir, externalDir, overrides }))
    .finally(() => {
      try {
        db.close()
      } catch {
        /** 已经关过了。 */
      }
      if (safeToRemove) removeTempDir(root)
    })
}

/** 与真实角色库同形态的合成角色文档（不含任何真实/公司正文）。 */
function personaText({
  title = '合成专家',
  group = '工程',
  description = '一段合成简介。',
  body = '## 身份与职责\n\n合成正文：只做测试用。\n',
} = {}) {
  return [
    '---',
    `group: ${group}`,
    '---',
    '',
    `# ${title}`,
    '',
    `> 分类：${group}`,
    '> 工作模式：只读审查',
    '> 建议 emoji：🔎',
    `> 建议简介：${description}`,
    '',
    body,
  ].join('\n')
}

function writePersonaFile(root, relativePath, text) {
  const full = join(root, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
  return full
}

function skillText(name, description = '演示技能') {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', '## 步骤', '1. 读取输入', '2. 输出结论', ''].join('\n')
}

function writeSkillPackage(skillsDir, name, description) {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillText(name, description), 'utf8')
  return dir
}

function provenanceObj(overrides = {}) {
  return {
    version: 1,
    creationKind: 'translated',
    sources: [{
      id: 'demo',
      repository: 'https://github.com/example/demo',
      upstreamPath: 'agents/reviewer.md',
      commit: 'a'.repeat(40),
      fetchedAt: AT,
      authors: ['Demo Author'],
      license: 'MIT',
      copyrightNotice: 'Copyright (c) 2026 Demo Authors',
      licenseFile: 'sources/demo/LICENSE.txt',
      usedFor: ['persona', 'skill'],
      modifications: '翻译为中文，删除与本期无关的段落',
    }],
    references: [],
    generationNote: '依据上游 MIT 素材改写并登记来源',
    ...overrides,
  }
}

function requirement(overrides = {}) {
  return {
    name: 'demo-skill',
    required: true,
    action: 'install',
    sourceId: 'demo',
    packageFiles: ['SKILL.md'],
    reason: '需要它的方法论',
    ...overrides,
  }
}

/**
 * 造一份**已发布**的受管人格（走真实的草稿写入路径拿技能需求）。
 *
 * 返回 `{personaId, installationId, personaMd}`；`publish:false` 用于演"安装没走完"。
 */
function installManagedPersona(context, paths, options = {}) {
  const {
    uuid = UUID_A,
    title = '受管专家',
    description = '受管安装的专家。',
    requirements = [],
    publish = true,
    skills = [],
  } = options
  const sessionId = `session-${uuid}`
  const personaMd = personaText({ title, description })
  const draft = createExpertDraft(context.db, {
    sessionId,
    request: '造一个受管专家',
    expertId: defaultExpertId(uuid),
  }).draft
  const submitted = submitExpertDraft(context, {
    draftId: draft.id,
    sessionId,
    expectedVersion: 0,
    personaMd,
    provenanceJson: provenanceObj(),
    skillsJson: requirements,
  })
  assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')

  writePersonaFile(paths.personasDir, join('generated', `${uuid}.md`), personaMd)
  const personaDir = join(paths.personasDir, 'generated', uuid)
  mkdirSync(personaDir, { recursive: true })
  writeFileSync(join(personaDir, 'provenance.json'), `${JSON.stringify(provenanceObj(), null, 2)}\n`, 'utf8')
  if (publish) {
    writeFileSync(join(personaDir, 'publication.json'), `${JSON.stringify({
      version: 1,
      expertId: `generated/${uuid}`,
      installationId: draft.id,
      manifestHash: HEX,
      committedAt: AT,
      ready: true,
    }, null, 2)}\n`, 'utf8')
  }
  for (const spec of skills) {
    const names = typeof spec === 'string' ? [spec] : spec.names
    for (const name of names) {
      writeSkillPackage(paths.skillsDir, name)
      /** 清单必须是**真实哈希**（provider 会拿它和目录重算出来的整包哈希比对）。 */
      writeManagedSkillManifest(join(paths.skillsDir, name), {
        name,
        expertId: `generated/${uuid}`,
        installationId: draft.id,
      })
    }
  }
  return { personaId: `generated/${uuid}`, installationId: draft.id, personaMd }
}

function skillEntry(name, overrides = {}) {
  return {
    name,
    description: '演示技能',
    modelInvocable: true,
    userInvocable: true,
    provider: WORKBENCH_SKILL_PROVIDER_NAME,
    source: 'bundled',
    rank: 600,
    locator: { name },
    ...overrides,
  }
}

function rowFor(document, id, source = undefined) {
  return document.rows.find((row) => row.id === id && (source === undefined || row.source === source))
}

function issueCodes(row) {
  return row.issues.map((item) => item.code)
}

// ---------------------------------------------------------------------------
// AX-E29：目录行、状态优先级、被压掉的文档各自成行
// ---------------------------------------------------------------------------

test('AX-E29 坏文件/停用/同名被压掉/未发布各自成行且状态准确；不可用不进 personas', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, builtinDir, externalDir, overrides }) => {
    // 内置、外部、手工用户：都没有来源登记，但都必须可用（unrecorded，不补猜上游）
    writePersonaFile(builtinDir, join('eng', 'reviewer.md'), personaText({ title: '内置审查官', description: '内置角色。' }))
    writePersonaFile(externalDir, join('ext-role.md'), personaText({ title: '外部角色', description: '外部目录里的角色。' }))
    writePersonaFile(personasDir, join('manual-role.md'), personaText({ title: '手工用户角色', description: '用户手写的角色。' }))
    // 解析失败（正文为空 → empty-body）：用相对文件名当显示名
    writePersonaFile(personasDir, join('broken.md'), ['---', 'group: 工程', '---', '', '# 没有正文', '', '   ', ''].join('\n'))
    // 停用
    writePersonaFile(personasDir, join('disabled-role.md'), personaText({ title: '被停用的角色', description: '停用角色。' }))
    writePersonaSettings(db, { personaDisabledIds: ['disabled-role'] })
    // 同名冲突：内置与用户各一份，用户胜出（library 既有规则），被压掉的那份仍留一行
    writePersonaFile(builtinDir, join('dup-role.md'), personaText({ title: '内置同名', description: '内置那份。' }))
    writePersonaFile(personasDir, join('dup-role.md'), personaText({ title: '用户同名', description: '用户那份。' }))

    // 受管人格 A：要求一个**已装且已发布**的技能 → 可用
    writeSkillPackage(skillsDir, 'demo-skill')
    const managedOk = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '受管可用专家',
      description: '要求一条已安装的技能。',
      requirements: [requirement()],
      skills: ['demo-skill'],
    })
    // 受管人格 B：要求一个**没装**的技能 → dependency-unavailable
    const managedMissing = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_B,
      title: '受管缺技能专家',
      description: '要求一条没装的技能。',
      requirements: [requirement({ name: 'missing-skill' })],
    })
    // 受管人格 C：可选技能缺失 → 仍然可用，只留 warning
    const managedOptional = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_C,
      title: '受管可选技能专家',
      description: '可选技能没装。',
      requirements: [requirement({ name: 'optional-skill', required: false })],
    })
    // 受管人格 D：文档在、发布门没就绪（没有 publication.json）→ installation-incomplete
    const managedUnpublished = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_D,
      title: '受管未发布专家',
      description: '发布门没就绪。',
      requirements: [],
      publish: false,
    })

    const projection = createWorkbenchSkillProjection({
      entries: [skillEntry('demo-skill')],
      available: true,
      preliminary: false,
    })
    const document = await listExpertCatalog({ db, roots: overrides, projection })

    // 生效行：只有 usable 的才进 personas（'dup-role' 的胜者是可用的那一位）
    const usableIds = document.personas.map((item) => item.id)
    assert.deepEqual(
      [...usableIds].sort(),
      ['dup-role', 'eng/reviewer', 'ext-role', 'manual-role', managedOk.personaId, managedOptional.personaId].sort(),
    )
    for (const summary of document.personas) {
      const row = rowFor(document, summary.id, summary.source)
      assert.equal(row.status, 'usable', `${summary.id} 应当是 usable`)
      assert.equal(row.revision, summary.revision)
    }

    // 没有来源登记的三类：仍可用 + provenanceState='unrecorded'
    for (const id of ['eng/reviewer', 'ext-role', 'manual-role']) {
      const row = rowFor(document, id)
      assert.equal(row.provenanceState, 'unrecorded')
      assert.equal(row.provenance, null)
    }
    assert.equal(rowFor(document, 'eng/reviewer').source, 'builtin')
    assert.equal(rowFor(document, 'ext-role').source, 'external')
    assert.equal(rowFor(document, 'manual-role').source, 'user')

    // 受管可用：来源登记读到了（recorded）+ requiredSkills 说明白了"用哪家的技能"
    const ok = rowFor(document, managedOk.personaId)
    assert.equal(ok.provenanceState, 'recorded')
    assert.equal(ok.provenance.creationKind, 'translated')
    assert.deepEqual(ok.requiredSkills, [{ name: 'demo-skill', available: true, provider: WORKBENCH_SKILL_PROVIDER_NAME, preliminary: false }])
    assert.deepEqual(ok.issues, [])

    // 停用
    const disabled = rowFor(document, 'disabled-role')
    assert.equal(disabled.status, 'disabled')
    assert.equal(disabled.enabled, false)
    assert.equal(document.personas.some((item) => item.id === 'disabled-role'), false)

    // 解析失败：一行、状态 invalid、显示名是相对文件名
    const broken = document.rows.find((row) => row.id === 'broken')
    assert.ok(broken, '坏文件也要有一行（用户得知道少了谁）')
    assert.equal(broken.status, 'invalid')
    assert.equal(broken.name, 'broken.md')
    assert.equal(broken.revision, null)
    assert.ok(issueCodes(broken).includes('empty-body'), `坏文件的诊断要带上原因，实际 ${issueCodes(broken).join(',')}`)

    // 同名冲突：用户胜出在前，被压掉的内置那份另起一行（sourceKey 不同，不合并成假摘要）
    const winner = rowFor(document, 'dup-role', 'user')
    const loser = rowFor(document, 'dup-role', 'builtin')
    assert.ok(winner && loser, '胜者与被压掉的文档要各有一行')
    assert.equal(winner.status, 'usable')
    assert.equal(loser.status, 'disabled')
    assert.notEqual(winner.sourceKey, loser.sourceKey)
    assert.ok(issueCodes(loser).includes('duplicate-id-overridden'))
    assert.ok(document.rows.indexOf(winner) < document.rows.indexOf(loser), '同一 id 的第一行必须是生效行')

    // 受管但发布门没就绪：有行、状态 installation-incomplete、不进 personas
    const unpublished = rowFor(document, managedUnpublished.personaId)
    assert.equal(unpublished.status, 'installation-incomplete')
    assert.ok(issueCodes(unpublished).includes('installation-incomplete'))
    assert.equal(document.personas.some((item) => item.id === managedUnpublished.personaId), false)

    // 必需技能缺失 → dependency-unavailable（问题里带上技能名与"当前 scope 下没有"）
    const missing = rowFor(document, managedMissing.personaId)
    assert.equal(missing.status, 'dependency-unavailable')
    assert.deepEqual(missing.requiredSkills, [{ name: 'missing-skill', available: false, provider: null, preliminary: false }])
    assert.ok(issueCodes(missing).includes('required-skill-unavailable'))
    assert.match(missing.issues.find((item) => item.code === 'required-skill-unavailable').message, /missing-skill/)

    // 可选技能缺失 → 仍可用，只给提示
    const optional = rowFor(document, managedOptional.personaId)
    assert.equal(optional.status, 'usable')
    assert.deepEqual(optional.requiredSkills, [], '可选技能不进 requiredSkills（它不挡执行）')
    assert.ok(issueCodes(optional).includes('required-skill-unavailable'))
    assert.match(optional.issues.find((item) => item.code === 'required-skill-unavailable').message, /可选技能，仅提示/)
  })
})

test('AX-E29 受管人格的安装草稿丢了也不误判：人格仍 usable，只多一条说明', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '受管专家',
      description: '草稿稍后会被删掉。',
      requirements: [requirement()],
      skills: ['demo-skill'],
    })
    // 直接删掉草稿行（模拟库里查不到安装记录），publication.json 仍在
    db.prepare('DELETE FROM task_drafts WHERE id = ?').run(managed.installationId)
    // 技能仍在、发布门仍 ready
    const projection = createWorkbenchSkillProjection({ entries: [skillEntry('demo-skill')], available: true })
    const document = await listExpertCatalog({ db, roots: overrides, projection })
    const row = rowFor(document, managed.personaId)
    assert.equal(row.status, 'usable', '缺草稿只是"复核不了需求"，不能把装好的人格判成不可用')
    assert.equal(row.provenanceState, 'recorded')
    assert.deepEqual(row.requiredSkills, [], '复核不了就如实空着，不猜')
    const issue = document.issues.find((item) => item.code === 'draft-not-found')
    assert.ok(issue, `要留下一条可读说明，实际 ${document.issues.map((item) => item.code).join(',')}`)
    assert.match(issue.message, /仍按已发布处理/)
  })
})

test('AX-E29 状态优先级：installation-incomplete 压过 invalid/disabled', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    // 受管 + 未发布 + 同时被用户停用：状态必须是 installation-incomplete（安装没走完优先说）
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_B,
      title: '受管未发布且被停用',
      description: '两个问题同时存在。',
      requirements: [],
      publish: false,
    })
    writePersonaSettings(db, { personaDisabledIds: [managed.personaId] })
    const document = await listExpertCatalog({ db, roots: overrides, projection: createWorkbenchSkillProjection({ entries: [], available: true }) })
    const row = rowFor(document, managed.personaId)
    assert.equal(row.status, 'installation-incomplete')
  })
})

// ---------------------------------------------------------------------------
// AX-E30：skills 服务缺失 / 技能不可用时的降级
// ---------------------------------------------------------------------------

test('AX-E30 skills 服务缺失：必需技能不判可用、无依赖人格仍可用、可选缺失只警告', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, builtinDir, overrides }) => {
    writePersonaFile(builtinDir, join('plain-role.md'), personaText({ title: '无依赖角色', description: '不依赖技能。' }))
    const managedRequired = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '要技能的专家',
      description: '必需技能。',
      requirements: [requirement()],
    })
    const managedOptional = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_C,
      title: '可选技能的专家',
      description: '可选技能。',
      requirements: [requirement({ name: 'optional-skill', required: false })],
    })

    const document = await listExpertCatalog({ db, roots: overrides })
    assert.equal(document.skillsAvailable, false)
    assert.equal(document.preliminary, true, '没有任何 skills 服务/scope → 判定是 preliminary')

    const required = rowFor(document, managedRequired.personaId)
    assert.equal(required.status, 'dependency-unavailable')
    assert.deepEqual(required.requiredSkills, [{ name: 'demo-skill', available: false, provider: null, preliminary: true }])
    assert.ok(issueCodes(required).includes('skill-service-unavailable'))
    assert.equal(document.personas.some((item) => item.id === managedRequired.personaId), false)

    // 无依赖人格照常可用
    assert.equal(rowFor(document, 'plain-role').status, 'usable')
    assert.ok(document.personas.some((item) => item.id === 'plain-role'))

    // 可选技能缺失：可用，但留着提示
    const optional = rowFor(document, managedOptional.personaId)
    assert.equal(optional.status, 'usable')
    assert.ok(issueCodes(optional).includes('skill-service-unavailable'))

    // 预检：不能返回"通过"
    const preflight = await preflightExpert({ db, roots: overrides, personaId: managedRequired.personaId })
    assert.equal(preflight.usable, false)
    assert.equal(preflight.status, 'dependency-unavailable')
    assert.equal(preflight.effectiveSkills[0].available, false)
    assert.equal(preflight.effectiveSkills[0].required, true)
    assert.equal(preflight.preliminary, true)
    assert.equal(preflight.summary.id, managedRequired.personaId)
    // 无依赖人格的预检要能通过
    const plainPreflight = await preflightExpert({ db, roots: overrides, personaId: 'plain-role' })
    assert.equal(plainPreflight.usable, true)
    assert.deepEqual(plainPreflight.effectiveSkills, [])
    // 不存在的 id：明确不可用，不抛
    const ghost = await preflightExpert({ db, roots: overrides, personaId: 'not-there' })
    assert.equal(ghost.usable, false)
    assert.equal(ghost.summary, null)
    assert.equal(ghost.issues[0].code, 'expert-not-found')
  })
})

test('AX-E30 技能存在但 modelInvocable=false / 同名被用户覆盖：不可用与 skill-shadowed 都如实说', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '要技能的专家',
      description: '演示技能。',
      requirements: [requirement()],
    })
    // 技能在，但不允许模型调用 → dependency-unavailable
    const notInvocable = createWorkbenchSkillProjection({ entries: [skillEntry('demo-skill', { modelInvocable: false })], available: true })
    const document = await listExpertCatalog({ db, roots: overrides, projection: notInvocable })
    const row = rowFor(document, managed.personaId)
    assert.equal(row.status, 'dependency-unavailable')
    assert.match(row.issues.find((item) => item.code === 'required-skill-unavailable').message, /modelInvocable=false/)

    // 同名被更高优先级的用户技能覆盖 → 警告 skill-shadowed，但仍然算"技能可用"（不强行绕开用户覆盖）
    const shadowed = createWorkbenchSkillProjection({ entries: [skillEntry('demo-skill', { provider: 'user-skills', source: 'user' })], available: true })
    const shadowedDocument = await listExpertCatalog({ db, roots: overrides, projection: shadowed })
    const shadowedRow = rowFor(shadowedDocument, managed.personaId)
    assert.equal(shadowedRow.status, 'usable')
    assert.ok(issueCodes(shadowedRow).includes('skill-shadowed'))
    assert.match(shadowedRow.issues.find((item) => item.code === 'skill-shadowed').message, /不强行改名绕过用户覆盖/)
    const preflight = await preflightExpert({ db, roots: overrides, projection: shadowed, personaId: managed.personaId })
    assert.equal(preflight.usable, true)
    assert.equal(preflight.effectiveSkills[0].provider, 'user-skills', 'actualProvider 必须是真正生效的那个')
    assert.equal(preflight.effectiveSkills[0].source, 'user')
    assert.equal(preflight.effectiveSkills[0].shadowed, true)
  })
})

test('AX-E30 受管技能管理清单坏了（人格仍已发布）：目录判必需技能不可用，如实说原因', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '要技能的专家',
      description: '技能清单坏了。',
      requirements: [requirement()],
      skills: ['demo-skill'],
    })
    // 人格的发布门仍然 ready；坏的是**技能自己的管理清单**（packageHash 不是 sha256）
    writeFileSync(join(skillsDir, 'demo-skill', 'workbench-install.json'), `${JSON.stringify({
      version: 1,
      name: 'demo-skill',
      expertId: `generated/${UUID_A}`,
      installationId: managed.installationId,
      packageHash: 'not-a-sha256',
      files: [],
    }, null, 2)}\n`, 'utf8')

    // 这里**用真实的 provider**当 skills 服务：发布门是它判的，不是测试里手写的投影
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {},
    })
    const service = { list: (options) => provider.list(options) }
    // 带上真实 scope 的 live agent：这样结论是"权威视角"，不是 preliminary 降级
    const host = new Context()
    const scoped = createScope(host, { kind: 'catalog-test' })
    const agent = { ctx: scoped.ctx, session: { header: { cwd: 'C:/agent-cwd' } } }
    try {
      const document = await listExpertCatalog({ db, roots: overrides, skills: service, agent })
      assert.equal(document.skillsAvailable, true, 'skills 服务在：只是那条技能被发布门挡住了')
      assert.equal(document.preliminary, false, '传了真实 scope 就不是降级视角')
      const row = rowFor(document, managed.personaId)
      assert.equal(row.status, 'dependency-unavailable')
      assert.deepEqual(row.requiredSkills, [{ name: 'demo-skill', available: false, provider: null, preliminary: false }])
      assert.ok(issueCodes(row).includes('required-skill-unavailable'))
      const diagnostics = readWorkbenchSkillProviderDiagnostics(provider)
      assert.ok(diagnostics.some((item) => item.code === 'skill-package-invalid'), '坏清单的原因要能从 provider 诊断里读到')
    } finally {
      scoped.dispose()
    }
  })
})

test('AX-E30 受管技能与安装清单一致：用真实 provider 当服务 → 目录判可用（清单校验不误杀）', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '要技能的专家',
      description: '技能装好了。',
      requirements: [requirement()],
      skills: ['demo-skill'],
    })
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {},
    })
    const service = { list: (options) => provider.list(options) }
    const document = await listExpertCatalog({ db, roots: overrides, skills: service })
    const row = rowFor(document, managed.personaId)
    assert.equal(row.status, 'usable')
    assert.deepEqual(row.requiredSkills, [
      { name: 'demo-skill', available: true, provider: WORKBENCH_SKILL_PROVIDER_NAME, preliminary: true },
    ])
    assert.deepEqual(readWorkbenchSkillProviderDiagnostics(provider), [], '未被改动的受管技能不该有任何诊断')
  })
})

// ---------------------------------------------------------------------------
// AX-E26/E49 前置：真实 scope 参与 list/get 的传参
// ---------------------------------------------------------------------------
test('AX-E26/E49 catalog 真的把 scopeOf(agent.ctx)/cwd/signal 传给 skills.list 与 get', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '要技能的专家',
      description: '演示技能。',
      requirements: [requirement()],
    })
    const carrier = new Context()
    const scopeKey = { label: 'agent-scope' }
    const scoped = createScope(carrier, scopeKey)
    const agent = { ctx: scoped.ctx, session: { header: { cwd: 'C:/agent-cwd' } } }
    assert.equal(scopeOf(agent.ctx), scopeKey, '真实 scopeOf：这是下面断言里那个 key')

    const listCalls = []
    const getCalls = []
    const service = {
      async list(options) {
        listCalls.push(options)
        return [{
          name: 'demo-skill',
          description: '演示技能',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: WORKBENCH_SKILL_PROVIDER_NAME,
          rank: 600,
          locator: { name: 'demo-skill' },
        }]
      },
      async get(name, options) {
        getCalls.push({ name, options })
        return { name, content: '正文' }
      },
    }
    const controller = new AbortController()
    const document = await listExpertCatalog({ db, roots: overrides, skills: service, agent, signal: controller.signal })

    assert.equal(listCalls.length, 1)
    assert.equal(listCalls[0].scope, scopeKey, '必须显式传 scopeOf(agent.ctx) 的结果（注册表不会替我们筛）')
    assert.equal(listCalls[0].cwd, 'C:/agent-cwd')
    assert.equal(listCalls[0].signal, controller.signal)
    assert.equal(getCalls.length, 1)
    assert.equal(getCalls[0].name, 'demo-skill')
    assert.equal(getCalls[0].options.scope, scopeKey)
    assert.equal(getCalls[0].options.cwd, 'C:/agent-cwd')
    assert.equal(getCalls[0].options.signal, controller.signal)

    const row = rowFor(document, managed.personaId)
    assert.equal(row.status, 'usable')
    assert.equal(document.preliminary, false, '传了真实 scope 就不是降级视角')
    scoped.dispose()
  })
})

test('AX-E49 有 live agent 但 scope 拿不到（helper 抛错）→ skill-scope-unavailable，绝不判"通过"', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '要技能的专家',
      description: '演示技能。',
      requirements: [requirement()],
    })
    const agent = { ctx: {}, session: { header: { cwd: 'C:/agent-cwd' } } }
    const scopeHelper = { scopeOf: () => { throw new Error('宿主内部炸了') } }
    const service = {
      async list() {
        // scope 拿不到时我们只能走"全局视角"：即便这条全局列表是空的，结论也必须是不能判可用
        return []
      },
    }
    const document = await listExpertCatalog({ db, roots: overrides, skills: service, agent, scopeHelper })
    const row = rowFor(document, managed.personaId)
    assert.equal(row.status, 'dependency-unavailable')
    assert.equal(row.requiredSkills[0].available, false)
    const issue = row.issues.find((item) => item.code === 'skill-scope-unavailable')
    assert.ok(issue, `实际 ${issueCodes(row).join(',')}`)
    assert.match(issue.message, /无法按 Agent scope 判定/)
    assert.equal(document.preliminary, true)

    const preflight = await preflightExpert({ db, roots: overrides, skills: service, agent, scopeHelper, personaId: managed.personaId })
    assert.equal(preflight.usable, false)
    assert.equal(preflight.preliminary, true)
  })
})

// ---------------------------------------------------------------------------
// 自主召唤提示
// ---------------------------------------------------------------------------

test('buildAutoExpertPrompt 30 条 / 80 字符 / 6000 字符 / 收藏优先 / interpolate:false 全部成立', async () => {
  await withCatalogFixture(async ({ db, personasDir, skillsDir, builtinDir, externalDir, overrides }) => {
    // 35 个内置角色 + 1 个描述超长 + 1 个停用 + 1 个坏文件
    const ids = []
    for (let index = 1; index <= 35; index += 1) {
      const id = `gen/p${String(index).padStart(2, '0')}`
      ids.push(id)
      writePersonaFile(builtinDir, join('gen', `p${String(index).padStart(2, '0')}.md`), personaText({
        title: `角色${index}`,
        description: `第 ${index} 个合成角色的简介。`,
      }))
    }
    writePersonaFile(personasDir, join('long-desc.md'), personaText({
      title: '长简介角色',
      description: `很长${'的简介'.repeat(60)}`,
    }))
    writePersonaFile(personasDir, join('disabled.md'), personaText({ title: '停用角色', description: '停用。' }))
    writePersonaFile(personasDir, join('broken2.md'), ['---', 'group: 工程', '---', '', '# 没有正文', '', '  ', ''].join('\n'))
    writePersonaSettings(db, { personaDisabledIds: ['disabled'], personaFavorites: ['gen/p30', 'long-desc'] })

    const block = buildAutoExpertPrompt({ db, roots: overrides })
    assert.equal(block.name, AUTO_EXPERT_PROMPT_BLOCK_NAME)
    assert.equal(block.order, AUTO_EXPERT_PROMPT_ORDER)
    assert.equal(block.interpolate, false, 'interpolate 必须是 false（花括号不得变成模板变量）')
    assert.equal(block.total, 36, '坏文件/停用/受管未发布都不算候选；35 内置 + 长简介 = 36')
    assert.equal(block.listed, AUTO_EXPERT_PROMPT_MAX_ENTRIES)
    assert.equal(block.truncated, true)
    assert.ok(block.text.length <= AUTO_EXPERT_PROMPT_MAX_TOTAL_CHARS)
    assert.match(block.text, /仅列出前 30 条 \/ 共 36 条/)
    assert.match(block.text, /更多角色可由用户用 @ 显式指定/)

    const lines = block.text.split('\n').filter((line) => line.startsWith('- '))
    assert.equal(lines.length, 30)
    // 收藏优先：long-desc 与 gen/p30 必须在最前面（两者之间按 ID 排序）
    assert.ok(lines[0].includes('（gen/p30）'), `第一条应当是收藏里的 gen/p30，实际 ${lines[0]}`)
    assert.ok(lines[1].includes('（long-desc）'), `第二条应当是收藏里的 long-desc，实际 ${lines[1]}`)
    assert.ok(lines[2].includes('（gen/p01）'), '其余按 ID 排序')
    // 坏文件与停用不出现在提示里
    assert.equal(block.text.includes('disabled'), false)
    assert.equal(block.text.includes('broken2'), false)
    // 每条简介不超过 80 字符（含省略号）
    for (const line of lines) {
      const description = line.slice(line.indexOf('：') + 1)
      assert.ok(description.length <= AUTO_EXPERT_PROMPT_DESCRIPTION_MAX_CHARS, `简介超长：${line}`)
    }
    const longLine = lines.find((line) => line.includes('（long-desc）'))
    assert.ok(longLine.endsWith('…'), '超长简介用省略号收尾')

    // 总长上限真的生效：给一个很小的上限，逐条减少
    const tiny = buildAutoExpertPrompt({ db, roots: overrides, maxTotalChars: 700 })
    assert.ok(tiny.text.length <= 700)
    assert.ok(tiny.listed < 30)
    assert.match(tiny.text, new RegExp(`仅列出前 ${tiny.listed} 条 / 共 36 条`))

    // 每条上限也可注入（界面/其他调用点用得上）
    const short = buildAutoExpertPrompt({ db, roots: overrides, maxDescriptionChars: 10, maxEntries: 2 })
    assert.equal(short.listed, 2)
    for (const line of short.text.split('\n').filter((line) => line.startsWith('- '))) {
      assert.ok(line.slice(line.indexOf('：') + 1).length <= 10)
    }
  })
})

test('buildAutoExpertPrompt 不做技能预检：必需技能缺失的受管人格也会列出（摘要不是权限证明）', async () => {
  await withCatalogFixture(async ({ db, context, personasDir, skillsDir, overrides }) => {
    const managed = installManagedPersona(context, { personasDir, skillsDir }, {
      uuid: UUID_A,
      title: '缺技能的专家',
      description: '技能没装，但已发布。',
      requirements: [requirement({ name: 'never-installed' })],
    })
    const block = buildAutoExpertPrompt({ db, roots: overrides })
    assert.equal(block.total, 1)
    assert.equal(block.listed, 1)
    assert.ok(block.text.includes(`（${managed.personaId}）`), '提示里要能列出它（摘要只说明"有这个人"，不是"技能齐了"）')
    // 空库：明确说"共 0 条"，不留一段会让人误以为有角色的空文本
    const empty = buildAutoExpertPrompt({ db, roots: { ...overrides, personasDir: join(personasDir, 'nope'), userDir: join(personasDir, 'nope'), builtinDir: join(personasDir, 'nope2') } })
    assert.equal(empty.total, 0)
    assert.match(empty.text, /共 0 条/)
  })
})

test('buildAutoExpertPrompt 摘要里的花括号/标签是字面量（interpolate:false）', async () => {
  await withCatalogFixture(async ({ db, personasDir, builtinDir, externalDir, overrides }) => {
    writePersonaFile(personasDir, join('brace-role.md'), personaText({
      title: '花括号角色 {{danger}}',
      description: '简介里有 ${var} 与 <tag>。',
    }))
    const block = buildAutoExpertPrompt({ db, roots: overrides })
    assert.equal(block.interpolate, false)
    assert.ok(block.text.includes('{{danger}}'), '花括号必须原样保留')
    assert.ok(block.text.includes('${var}'))
    assert.ok(block.text.includes('<tag>'))
  })
})
