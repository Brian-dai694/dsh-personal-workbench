/**
 * 专家安装主链（`src/experts/install.ts`）+ 受管发布门（`src/personas/managed.ts`）。
 *
 * 覆盖验收断言 AX-E15–E19、AX-E23，以及 §6.4 的步骤级断言与 §6.5 中
 * **"发布前失败"**、**"DB 已 confirmed 但 publication 未 ready"** 两条决策路径。
 * AX-E20–E22（进程中断恢复的完整故障矩阵）属第二轮，见 `test/expertRecovery.test.mjs`。
 *
 * ## 这一批测试的写法约定
 *
 * 1. **只断言真实产物**：磁盘上的真实字节、DB 里真实那一行的 payload、`discoverPersonas`
 *    真实返回的列表 —— 不写"只断言调用了某个函数"。
 * 2. **"看不见"必须是可观测的**：`installation-incomplete` 诊断要在**安装中途**
 *    （failpoint 回调里）真的取一次，证明的是"那一刻解析器确实读不到"，而不是"最后读不到"。
 * 3. **门必须在两条路径上都成立**：`discoverPersonas` 与 `resolvePersona` 都要断言。
 * 4. 每个用例一个 `mkdtempSync` 临时根（`personas/` `/` `skills/` `/` `outside/` 哨兵
 *    `/` 空 `builtin/`），**从不碰真实的 `~/.dsh/workbench`**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createExpertDraft, defaultExpertId, getExpertDraft } from '../lib/db/repo/experts.js'
import { stageExpertFile, submitExpertDraft, validateExpertDraft } from '../lib/experts/drafts.js'
import {
  canonicalDatabasePath,
  confirmExpertDraft,
  recoverExpertInstallation,
  recoverExpertInstallations,
} from '../lib/experts/install.js'
import { acquireExpertInstallLock, resolveExpertRoots } from '../lib/experts/paths.js'
import { sha256Hex } from '../lib/experts/provenance.js'
import { discoverPersonas, resolvePersona } from '../lib/personas/library.js'
import {
  isManagedPersonaId,
  readManagedPersonaPublication,
  readManagedSkillInstallState,
} from '../lib/personas/managed.js'

const SESSION_A = 'session-fake-aaaa-0001'
const SESSION_B = 'session-fake-bbbb-0002'
const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const UUID_C = 'cccccccc-dddd-4eee-8fff-000000000000'
const AT = '2026-01-01T00:00:00.000Z'

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

function readText(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 目录快照：`相对路径:sha256` 的有序列表。
 *
 * 用它断言"一个字节都没变"（AX-E18 旧 skill 不被覆盖、AX-E19 共享 skill 不被补偿删除），
 * 比逐文件比对更难写错 —— 多出来的文件也会被发现。
 */
function snapshotTree(dir) {
  const out = []
  const walk = (current, prefix) => {
    if (existsSync(current) === false) return
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else out.push(`${rel}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
    }
  }
  walk(dir, '')
  return out
}

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wb-expert-install-'))
  const personasDir = join(root, 'personas')
  const skillsDir = join(root, 'skills')
  const outsideDir = join(root, 'outside')
  const builtinDir = join(root, 'builtin')
  mkdirSync(personasDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(builtinDir, { recursive: true })
  writeFileSync(join(outsideDir, 'sentinel.txt'), '根外哨兵：一个字节都不许变。\n', 'utf8')

  const dbPath = join(root, 'workbench.db')
  const db = openWorkbenchDb({ dbPath })
  seedDictionaries(db)
  const roots = resolveExpertRoots({ personasDir, skillsDir })
  const context = { db, roots, now: () => AT }
  const libraryOptions = { userDir: personasDir, externalDir: '', builtinDir }
  const safeToRemove = root.startsWith(tmpdir()) && root.includes('dsh-wb-expert-install-')
  try {
    run({ root, dbPath, db, roots, context, personasDir, skillsDir, outsideDir, builtinDir, libraryOptions })
  } finally {
    try {
      db.close()
    } catch {
      /** 已经关过了。 */
    }
    if (safeToRemove && existsSync(root)) removeTempDir(root)
  }
}

// ---------------------------------------------------------------------------
// 夹具构造（与 test/expertDrafts.test.mjs 同源，改的只是"要能一路走到 confirm"）
// ---------------------------------------------------------------------------

const BODY = '## 身份与职责\n你负责审查需求，指出缺失条件与无法验收的表述。\n'

function personaDoc(body = BODY) {
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
    body,
  ].join('\n')
}

const COPYRIGHT = 'Copyright (c) 2026 Demo Authors'
const MIT_TEXT = [
  'MIT License',
  '',
  COPYRIGHT,
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
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
  '',
].join('\r\n')

function sourceObj(overrides = {}) {
  return {
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
    modifications: '翻译为中文，删除与本期无关的段落',
    ...overrides,
  }
}

function provenanceObj(overrides = {}) {
  return {
    version: 1,
    creationKind: 'translated',
    sources: [sourceObj()],
    references: [],
    generationNote: '依据上游 MIT 素材改写并登记来源',
    ...overrides,
  }
}

/** `original` 的登记：允许 0 个来源（§3.3）。 */
function originalProvenance() {
  return provenanceObj({ creationKind: 'original', sources: [], generationNote: '无上游素材，完全新写' })
}

const SKILL_MD = [
  '---',
  'name: demo-skill',
  'description: 演示技能',
  '---',
  '',
  '## 步骤',
  '1. 读取输入',
  '2. 输出结论',
  '',
].join('\n')

const SECOND_SKILL_MD = [
  '---',
  'name: second-skill',
  'description: 第二个演示技能',
  '---',
  '',
  '## 步骤',
  '1. 先做甲',
  '2. 再做乙',
  '',
].join('\n')

/** 来源 `demo` 的 `usedFor` 是 `['persona','skill']` → persona 侧与 skill 包内各要一份许可副本。 */
function skillStagedFiles(name = 'demo-skill', skillMd = SKILL_MD) {
  return [
    ['persona-resource', 'sources/demo/LICENSE.txt', MIT_TEXT],
    ['skill', `${name}/SKILL.md`, skillMd],
    ['skill', `${name}/sources/demo/LICENSE.txt`, MIT_TEXT],
  ]
}

function skillRequirement(overrides = {}) {
  return {
    name: 'demo-skill',
    required: true,
    action: 'install',
    sourceId: 'demo',
    packageFiles: ['SKILL.md', 'sources/demo/LICENSE.txt'],
    reason: '需要它的方法论',
    ...overrides,
  }
}

/**
 * 造一份**已经校验通过**的草稿（submit → stage → validate），返回版本与 manifestHash。
 *
 * 校验必须真的通过：`confirmExpertDraft` 会**重新跑一遍**校验（§6.4 第 3 步），
 * 一份"看起来有 validation 字段"的草稿在这条路径上走不过去。
 */
function buildValidated(context, options = {}) {
  const {
    uuid = UUID_A,
    sessionId = SESSION_A,
    request = '做一个需求审查专家',
    personaMd = personaDoc(),
    provenance = provenanceObj(),
    skills = [],
    resources = [],
  } = options

  const draft = createExpertDraft(context.db, {
    sessionId,
    request,
    expertId: defaultExpertId(uuid),
  }).draft

  const submitted = submitExpertDraft(context, {
    draftId: draft.id,
    sessionId,
    expectedVersion: 0,
    personaMd,
    provenanceJson: provenance,
    skillsJson: skills,
  })
  assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')

  let version = submitted.contentVersion
  for (const [area, path, text] of resources) {
    const staged = stageExpertFile(context, { draftId: draft.id, sessionId, expectedVersion: version, area, path, contentUtf8: text })
    assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')
    version = staged.contentVersion
  }

  const validated = validateExpertDraft(context, { draftId: draft.id, expectedVersion: version, sessionId })
  assert.equal(validated.ok, true, validated.ok === false ? validated.message : '')
  assert.deepEqual(validated.validation.errors, [])
  return { draft, version: validated.contentVersion, manifestHash: validated.manifestHash, validated }
}

function confirmInput(built, extra = {}) {
  return { draftId: built.draft.id, expectedVersion: built.version, expectedManifestHash: built.manifestHash, ...extra }
}

function personaDocPath(personasDir, uuid) {
  return join(personasDir, 'generated', `${uuid}.md`)
}

function personaDirPath(personasDir, uuid) {
  return join(personasDir, 'generated', uuid)
}

function journalPath(personasDir, draftId) {
  return join(personasDir, '.pending', draftId, 'install-journal.json')
}

function stagedPersonaPath(personasDir, draftId, path) {
  return join(personasDir, '.pending', draftId, 'files', path)
}

function stagedSkillPath(skillsDir, draftId, path) {
  return join(skillsDir, '.pending', draftId, path)
}

// ---------------------------------------------------------------------------
// AX-E15：原创无技能草稿确认
// ---------------------------------------------------------------------------

test('AX-E15 原创无技能草稿确认：DB confirmed + publication.ready + 发现/解析可用 + 附件落地', () => {
  withFixture(({ context, db, personasDir, libraryOptions }) => {
    const built = buildValidated(context, { provenance: originalProvenance() })
    const expertId = `generated/${UUID_A}`

    /** 确认前：什么都没有（不是"有文件但看不见"，而是确实没发布）。 */
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)
    assert.equal(discoverPersonas(libraryOptions).personas.some((persona) => persona.id === expertId), false)

    const result = confirmExpertDraft(context, confirmInput(built))
    assert.equal(result.ok, true, result.ok === false ? result.message : '')
    assert.equal(result.replayed, false)
    assert.equal(result.result.kind, 'expert')
    assert.equal(result.result.expertId, expertId)
    assert.equal(result.result.draftId, built.draft.id)
    assert.equal(result.result.manifestHash, built.manifestHash)
    assert.equal(result.result.installedAt, AT)
    assert.deepEqual(result.result.installedSkills, [])
    assert.deepEqual(result.result.reusedSkills, [])
    assert.deepEqual(result.result.warnings, [])

    /** DB：那一行真的变成 confirmed，且 confirmResult 是同一个对象内容。 */
    const row = getExpertDraft(db, built.draft.id)
    assert.equal(row.statusCode, 'confirmed')
    assert.deepEqual(row.payload.confirmResult, result.result)

    /** FS：人格文档 + 附件目录（provenance.json 是安装器写的来源登记）。 */
    assert.equal(readText(personaDocPath(personasDir, UUID_A)), personaDoc())
    assert.equal(existsSync(join(personaDirPath(personasDir, UUID_A), 'provenance.json')), true)
    const storedProvenance = readJson(join(personaDirPath(personasDir, UUID_A), 'provenance.json'))
    assert.equal(storedProvenance.version, 1)
    assert.equal(storedProvenance.creationKind, 'original')
    assert.deepEqual(storedProvenance.sources, [])

    /** publication.json：形状与来源都必须精确（门就靠它）。 */
    const publication = readJson(join(personaDirPath(personasDir, UUID_A), 'publication.json'))
    assert.deepEqual(Object.keys(publication).sort(), ['committedAt', 'expertId', 'installationId', 'manifestHash', 'ready', 'version'])
    assert.equal(publication.version, 1)
    assert.equal(publication.expertId, expertId)
    assert.equal(publication.installationId, built.draft.id)
    assert.equal(publication.manifestHash, built.manifestHash)
    assert.equal(publication.ready, true)
    assert.equal(publication.committedAt, AT)

    /** journal：phase=ready、ownerDbKey 是 sha256（文件 DB），result 记着结果。 */
    const journal = readJson(journalPath(personasDir, built.draft.id))
    assert.equal(journal.phase, 'ready')
    assert.equal(journal.draftId, built.draft.id)
    assert.equal(journal.expertId, expertId)
    assert.equal(journal.manifestHash, built.manifestHash)
    assert.equal(journal.ownerDbKey.length, 64)
    assert.equal(journal.result.manifestHash, built.manifestHash)
    assert.deepEqual(journal.reusedPaths, [])
    assert.deepEqual(journal.createdPaths.map((entry) => entry.area), ['persona-directory', 'persona-document'])

    /** catalog：发现与解析都能拿到（AX-E15 的"catalog 可用"）。 */
    const discovery = discoverPersonas(libraryOptions)
    const summary = discovery.personas.find((persona) => persona.id === expertId)
    assert.notEqual(summary, undefined)
    assert.equal(summary.source, 'user')
    assert.equal(summary.name, '需求审查专家')
    const resolved = resolvePersona(expertId, libraryOptions)
    assert.equal(resolved.ok, true, resolved.ok === false ? JSON.stringify(resolved.diagnostics) : '')
    assert.equal(resolved.filePath, personaDocPath(personasDir, UUID_A))

    /** 受管判定与只读发布门读到的内容一致。 */
    assert.equal(isManagedPersonaId(expertId), true)
    assert.equal(isManagedPersonaId('engineering/reviewer'), false)
    const gate = readManagedPersonaPublication(personasDir, expertId)
    assert.equal(gate.ok, true)
    assert.equal(gate.publication.expertId, expertId)
    assert.equal(gate.publication.manifestHash, built.manifestHash)
    assert.equal(gate.publication.installationId, built.draft.id)
    assert.equal(gate.publication.committedAt, AT)
  })
})

test('§6.4 owner 守卫：给了 sessionId 就必须是草稿的会话（HTTP 路径不传这个键）', () => {
  withFixture(({ context }) => {
    const built = buildValidated(context, { provenance: originalProvenance() })

    const foreign = confirmExpertDraft(context, confirmInput(built, { sessionId: SESSION_B }))
    assert.equal(foreign.ok, false)
    assert.equal(foreign.code, 'draft-owner-mismatch')
    assert.equal(foreign.field, 'sessionId')

    const empty = confirmExpertDraft(context, confirmInput(built, { sessionId: '' }))
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'draft-owner-mismatch')

    /** 自己的会话 + HTTP 路径（不传 sessionId 键）都能过。 */
    const own = confirmExpertDraft(context, confirmInput(built, { sessionId: SESSION_A }))
    assert.equal(own.ok, true, own.ok === false ? own.message : '')
  })
})

// ---------------------------------------------------------------------------
// AX-E16：MIT + 两个 install skill；未 ready 前 discover/resolve 都读不到
// ---------------------------------------------------------------------------

test('AX-E16 MIT + 两个 install skill：许可链完整；未 ready 前发现与解析都读不到（installation-incomplete）', () => {
  withFixture(({ context, personasDir, skillsDir, libraryOptions }) => {
    const resources = [
      ['persona-resource', 'sources/demo/LICENSE.txt', MIT_TEXT],
      ...skillStagedFiles('demo-skill', SKILL_MD).filter(([area]) => area === 'skill'),
      ...skillStagedFiles('second-skill', SECOND_SKILL_MD).filter(([area]) => area === 'skill'),
    ]
    const built = buildValidated(context, {
      provenance: provenanceObj(),
      skills: [skillRequirement(), skillRequirement({ name: 'second-skill' })],
      resources,
    })
    const expertId = `generated/${UUID_A}`

    /** 安装中途取快照：这一刻解析器必须**读不到**这份人格，且给出正式诊断。 */
    const snapshots = []
    const confirmContext = {
      ...context,
      failpoint: (point) => {
        if (point !== 'install.after-persona-directory' && point !== 'install.after-skill-directory' && point !== 'install.after-persona-document') return
        snapshots.push({
          point,
          docExists: existsSync(personaDocPath(personasDir, UUID_A)),
          directoryExists: existsSync(personaDirPath(personasDir, UUID_A)),
          discovery: discoverPersonas(libraryOptions),
          resolved: resolvePersona(expertId, libraryOptions),
          publication: readManagedPersonaPublication(personasDir, expertId),
          demoSkill: readManagedSkillInstallState(skillsDir, personasDir, 'demo-skill'),
        })
      },
    }

    const result = confirmExpertDraft(confirmContext, confirmInput(built))
    assert.equal(result.ok, true, result.ok === false ? result.message : '')
    assert.deepEqual([...result.result.installedSkills].sort(), ['demo-skill', 'second-skill'])
    assert.deepEqual(result.result.reusedSkills, [])

    /** 快照断言：附件目录已就位，但 publication 还没发 —— 于是"看不见"。 */
    assert.equal(snapshots.length, 4)
    const afterDirectory = snapshots.find((entry) => entry.point === 'install.after-persona-directory')
    assert.equal(existsSync(personaDirPath(personasDir, UUID_A)), true)
    assert.equal(afterDirectory.directoryExists, true)
    assert.equal(afterDirectory.publication.ok, false)
    assert.equal(afterDirectory.publication.reason, 'missing')
    assert.equal(afterDirectory.discovery.personas.some((persona) => persona.id === expertId), false)
    /** 这一刻正式位置**还没有** `.md`，谈不上"跳过一个文档" —— 所以诊断要到文档落地后才有。 */
    assert.equal(afterDirectory.docExists, false)

    /** 技能目录已 rename 到正式位置，但关联人格没 ready → 技能状态是"不可用"。 */
    const afterSkill = snapshots.find((entry) => entry.point === 'install.after-skill-directory')
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'workbench-install.json')), true)
    assert.equal(afterSkill.demoSkill.managed, true)
    assert.equal(afterSkill.demoSkill.ready, false)
    assert.equal(afterSkill.demoSkill.problem.code, 'installation-incomplete')
    assert.equal(afterSkill.demoSkill.expertId, expertId)

    /** 人格文档已 rename 到正式位置（门仍未就绪）→ 发现与解析**两条路**都读不到。 */
    const afterDocument = snapshots.find((entry) => entry.point === 'install.after-persona-document')
    assert.equal(afterDocument.docExists, true)
    assert.equal(afterDocument.publication.ok, false)
    assert.equal(afterDocument.publication.reason, 'missing')
    assert.equal(afterDocument.discovery.personas.some((persona) => persona.id === expertId), false)
    assert.equal(
      afterDocument.discovery.diagnostics.some((diagnostic) => diagnostic.code === 'installation-incomplete'),
      true,
    )
    assert.equal(afterDocument.resolved.ok, false)
    assert.equal(afterDocument.resolved.reason, 'not-found')
    assert.equal(afterDocument.resolved.diagnostics.some((diagnostic) => diagnostic.code === 'installation-incomplete'), true)

    /** ready 之后：两条路都通，许可链完整（persona 侧 + 每个 skill 包内各一份）。 */
    assert.equal(readText(stagedPersonaPath(personasDir, built.draft.id, 'sources/demo/LICENSE.txt')), MIT_TEXT)
    assert.equal(readText(join(personaDirPath(personasDir, UUID_A), 'sources', 'demo', 'LICENSE.txt')), MIT_TEXT)
    for (const name of ['demo-skill', 'second-skill']) {
      assert.equal(readText(join(skillsDir, name, 'sources', 'demo', 'LICENSE.txt')), MIT_TEXT)
      const manifest = readJson(join(skillsDir, name, 'workbench-install.json'))
      assert.equal(manifest.expertId, expertId)
      assert.equal(manifest.installationId, built.draft.id)
      assert.equal(manifest.name, name)
      assert.equal(manifest.files.some((file) => file.path === 'SKILL.md'), true)
      const state = readManagedSkillInstallState(skillsDir, personasDir, name)
      assert.equal(state.ready, true)
      assert.equal(state.problem, undefined)
    }
    assert.equal(readManagedSkillInstallState(skillsDir, personasDir, 'not-installed').managed, false)

    const discovery = discoverPersonas(libraryOptions)
    assert.equal(discovery.personas.some((persona) => persona.id === expertId), true)
    assert.equal(resolvePersona(expertId, libraryOptions).ok, true)

    /** 普通（非受管）角色行为一字不变：手工放一份，照常发现。 */
    const handmade = join(personasDir, 'engineering', 'reviewer.md')
    mkdirSync(join(personasDir, 'engineering'), { recursive: true })
    writeFileSync(handmade, personaDoc(), 'utf8')
    const withHandmade = discoverPersonas(libraryOptions)
    assert.equal(withHandmade.personas.some((persona) => persona.id === 'engineering/reviewer'), true)
    assert.equal(withHandmade.diagnostics.some((diagnostic) => diagnostic.id === 'engineering/reviewer'), false)
  })
})

test('§6.2 发布门：同名 publication.json 坏掉 / ready=false 时同样跳过（不猜、不放行）', () => {
  withFixture(({ context, personasDir, libraryOptions }) => {
    const built = buildValidated(context, { provenance: originalProvenance() })
    const expertId = `generated/${UUID_A}`
    const result = confirmExpertDraft(context, confirmInput(built))
    assert.equal(result.ok, true, result.ok === false ? result.message : '')
    const publicationPath = join(personaDirPath(personasDir, UUID_A), 'publication.json')

    const cases = [
      ['ready=false', { ...readJson(publicationPath), ready: false }, 'not-ready'],
      ['version 变了', { ...readJson(publicationPath), version: 2 }, 'malformed'],
      ['expertId 指向别人', { ...readJson(publicationPath), expertId: `generated/${UUID_B}` }, 'expert-mismatch'],
    ]
    for (const [label, broken, reason] of cases) {
      writeJson(publicationPath, broken)
      const gate = readManagedPersonaPublication(personasDir, expertId)
      assert.equal(gate.ok, false, label)
      assert.equal(gate.reason, reason, label)
      assert.equal(gate.code, 'installation-incomplete', label)
      const discovery = discoverPersonas(libraryOptions)
      assert.equal(discovery.personas.some((persona) => persona.id === expertId), false, label)
      assert.equal(
        discovery.diagnostics.some((diagnostic) => diagnostic.code === 'installation-incomplete' && diagnostic.id === expertId),
        true,
        label,
      )
      assert.equal(resolvePersona(expertId, libraryOptions).ok, false, label)
    }

    /** 连 JSON 都不是 / 文件被删：同样只跳过，且**不修改**用户根里的任何字节。 */
    writeFileSync(publicationPath, '{ 不是 JSON', 'utf8')
    assert.equal(readManagedPersonaPublication(personasDir, expertId).reason, 'malformed')
    assert.equal(readText(publicationPath), '{ 不是 JSON')
    rmSync(publicationPath)
    assert.equal(readManagedPersonaPublication(personasDir, expertId).reason, 'missing')
    assert.equal(discoverPersonas(libraryOptions).personas.some((persona) => persona.id === expertId), false)

    /** 非受管 id 不走门：手工根里的普通角色照常。 */
    assert.equal(readManagedPersonaPublication(personasDir, 'engineering/reviewer').reason, 'not-managed-id')
  })
})

// ---------------------------------------------------------------------------
// AX-E17：重复确认 / 重入
// ---------------------------------------------------------------------------

test('AX-E17 重复确认幂等（同 expertId/confirmResult、文件数不增加）；重入被进程内互斥挡住', () => {
  withFixture(({ context, db, personasDir, skillsDir }) => {
    const built = buildValidated(context, {
      provenance: provenanceObj(),
      skills: [skillRequirement()],
      resources: skillStagedFiles(),
    })

    /** 重入：在安装中途再调一次同一份草稿的 confirm（模拟并发双请求）。 */
    let reentrant = null
    let reentrantCalls = 0
    const reentrantContext = {
      ...context,
      failpoint: (point) => {
        if (point !== 'install.before-db-commit' || reentrantCalls > 0) return
        reentrantCalls += 1
        reentrant = confirmExpertDraft(context, confirmInput(built))
      },
    }

    const first = confirmExpertDraft(reentrantContext, confirmInput(built))
    assert.equal(first.ok, true, first.ok === false ? first.message : '')
    assert.equal(reentrantCalls, 1)
    assert.equal(reentrant.ok, false)
    assert.equal(reentrant.code, 'install-in-progress')

    const filesAfterFirst = [...snapshotTree(personasDir), ...snapshotTree(skillsDir)]

    const second = confirmExpertDraft(context, confirmInput(built))
    assert.equal(second.ok, true, second.ok === false ? second.message : '')
    assert.equal(second.replayed, true)
    assert.equal(second.result.expertId, first.result.expertId)
    assert.equal(second.result.manifestHash, first.result.manifestHash)
    assert.deepEqual(second.result.installedSkills, first.result.installedSkills)

    /** 幂等：文件一个不多、内容一个字节不变；DB 行仍是同一份 confirmed 结果。 */
    assert.deepEqual([...snapshotTree(personasDir), ...snapshotTree(skillsDir)], filesAfterFirst)
    const row = getExpertDraft(db, built.draft.id)
    assert.equal(row.statusCode, 'confirmed')
    assert.deepEqual(row.payload.confirmResult, first.result)

    /** 受管技能只有一个（没有"多写一个同名专家或技能"）。 */
    assert.deepEqual(readdirSync(skillsDir).filter((name) => name !== '.pending').sort(), ['demo-skill'])
    assert.equal(readManagedSkillInstallState(skillsDir, personasDir, 'demo-skill').ready, true)
  })
})

// ---------------------------------------------------------------------------
// AX-E18：同名 skill 但内容哈希不同
// ---------------------------------------------------------------------------

const OTHER_SKILL_MD = ['---', 'name: demo-skill', 'description: 别人的同名技能', '---', '', '## 别人的步骤', '1. 什么都不做', ''].join('\n')

/** 造一个"别人的"同名技能目录：有工作台管理清单，但包哈希与本次不同。 */
function plantForeignSkill(skillsDir, { ownerUuid = UUID_B } = {}) {
  const dir = join(skillsDir, 'demo-skill')
  mkdirSync(join(dir, 'sources', 'demo'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), OTHER_SKILL_MD, 'utf8')
  writeFileSync(join(dir, 'sources', 'demo', 'LICENSE.txt'), MIT_TEXT, 'utf8')
  writeJson(join(dir, 'workbench-install.json'), {
    version: 1,
    name: 'demo-skill',
    expertId: `generated/${ownerUuid}`,
    installationId: UUID_C,
    packageHash: 'f'.repeat(64),
    files: [
      { path: 'SKILL.md', bytes: Buffer.byteLength(OTHER_SKILL_MD, 'utf8'), sha256: sha256Hex(OTHER_SKILL_MD) },
      { path: 'sources/demo/LICENSE.txt', bytes: Buffer.byteLength(MIT_TEXT, 'utf8'), sha256: sha256Hex(MIT_TEXT) },
    ],
  })
  return dir
}

test('AX-E18 同名 skill 内容哈希不同：确认时拒绝、旧 skill 字节不变、不静默覆盖、无正式入口', () => {
  withFixture(({ context, db, personasDir, skillsDir, libraryOptions }) => {
    /** 先做一份**已校验通过**的草稿（此刻正式位置还没有同名技能）。 */
    const built = buildValidated(context, {
      provenance: provenanceObj(),
      skills: [skillRequirement()],
      resources: skillStagedFiles(),
    })

    /** 校验通过之后、确认之前，正式位置出现了同名但内容不同的技能（真实竞态）。 */
    plantForeignSkill(skillsDir, { ownerUuid: UUID_B })
    const before = snapshotTree(join(skillsDir, 'demo-skill'))

    const result = confirmExpertDraft(context, confirmInput(built))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'skill-conflict')
    assert.match(result.message, /demo-skill/)

    /** 旧技能一个字节都没变（不静默覆盖）。 */
    assert.deepEqual(snapshotTree(join(skillsDir, 'demo-skill')), before)
    assert.equal(readText(join(skillsDir, 'demo-skill', 'SKILL.md')), OTHER_SKILL_MD)
    assert.equal(readJson(join(skillsDir, 'demo-skill', 'workbench-install.json')).expertId, `generated/${UUID_B}`)

    /** 没有任何正式入口：人格文档没发布、publication 没有、日志都没开始写。 */
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)
    assert.equal(existsSync(join(personaDirPath(personasDir, UUID_A), 'publication.json')), false)
    assert.equal(existsSync(journalPath(personasDir, built.draft.id)), false)
    assert.equal(discoverPersonas(libraryOptions).personas.length, 0)

    /** 草稿仍是 pending，落到 editing（校验没过的落点），错误可观测。 */
    const row = getExpertDraft(db, built.draft.id)
    assert.equal(row.statusCode, 'pending')
    assert.equal(row.payload.phase, 'editing')
    assert.equal(row.payload.validation.errors.some((entry) => entry.code === 'skill-conflict'), true)
  })
})

test('AX-E18 同名冲突在确认前就已存在：确认也必须拒绝（重新校验，不看绿勾）', () => {
  withFixture(({ context, db, personasDir, skillsDir }) => {
    /** 这次先把别人的技能放好，再录入草稿：校验阶段就会报 skill-conflict。 */
    plantForeignSkill(skillsDir, { ownerUuid: UUID_C })
    const before = snapshotTree(join(skillsDir, 'demo-skill'))

    const draft = createExpertDraft(context.db, {
      sessionId: SESSION_A,
      request: '做一个需求审查专家',
      expertId: defaultExpertId(UUID_A),
    }).draft
    const submitted = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [skillRequirement()],
    })
    assert.equal(submitted.ok, true)
    let version = submitted.contentVersion
    for (const [area, path, text] of skillStagedFiles()) {
      const staged = stageExpertFile(context, { draftId: draft.id, sessionId: SESSION_A, expectedVersion: version, area, path, contentUtf8: text })
      assert.equal(staged.ok, true)
      version = staged.contentVersion
    }

    const validated = validateExpertDraft(context, { draftId: draft.id, expectedVersion: version, sessionId: SESSION_A })
    assert.equal(validated.ok, true)
    assert.equal(validated.validation.errors.some((entry) => entry.code === 'skill-conflict'), true)
    assert.equal(validated.phase, 'editing')

    /** 拿着一份"有错"的校验结果去确认：直接拒绝，且不动磁盘。 */
    const result = confirmExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: validated.contentVersion,
      expectedManifestHash: validated.manifestHash,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'draft-not-validated')
    assert.deepEqual(snapshotTree(join(skillsDir, 'demo-skill')), before)
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)
    const row = getExpertDraft(db, draft.id)
    assert.equal(row.statusCode, 'pending')
    assert.equal(row.payload.phase, 'editing')
  })
})

// ---------------------------------------------------------------------------
// AX-E19：同一份完整 skill 已 ready → 复用；补偿不删共享技能
// ---------------------------------------------------------------------------

test('AX-E19 同完整哈希的 ready skill：明确复用、字节不变；补偿只撤回本次新建的东西', () => {
  withFixture(({ context, db, personasDir, skillsDir }) => {
    /** A 装上这个技能（成为"共享的现成包"）。 */
    const a = buildValidated(context, {
      uuid: UUID_A,
      provenance: provenanceObj(),
      skills: [skillRequirement()],
      resources: skillStagedFiles(),
    })
    const installed = confirmExpertDraft(context, confirmInput(a))
    assert.equal(installed.ok, true, installed.ok === false ? installed.message : '')
    assert.deepEqual(installed.result.installedSkills, ['demo-skill'])
    const sharedBefore = snapshotTree(join(skillsDir, 'demo-skill'))
    assert.deepEqual(sharedBefore.map((line) => line.split(':')[0]), ['SKILL.md', 'sources/demo/LICENSE.txt', 'workbench-install.json'])

    /** B：同名、同字节 → 同 packageHash → 只复用，不重写。 */
    const b = buildValidated(context, {
      uuid: UUID_B,
      provenance: provenanceObj(),
      skills: [skillRequirement()],
      resources: skillStagedFiles(),
    })
    const reused = confirmExpertDraft(context, confirmInput(b))
    assert.equal(reused.ok, true, reused.ok === false ? reused.message : '')
    assert.deepEqual(reused.result.installedSkills, [])
    assert.deepEqual(reused.result.reusedSkills, ['demo-skill'])
    assert.deepEqual(snapshotTree(join(skillsDir, 'demo-skill')), sharedBefore)
    assert.equal(readJson(join(skillsDir, 'demo-skill', 'workbench-install.json')).installationId, a.draft.id)
    const journalB = readJson(journalPath(personasDir, b.draft.id))
    assert.deepEqual(journalB.createdPaths.map((entry) => entry.area), ['persona-directory', 'persona-document'])
    assert.deepEqual(journalB.reusedPaths.map((entry) => entry.path), ['demo-skill'])

    /** C：同样复用；在 DB 提交前注入 CAS 冲突 → 本次未提交 → 干净补偿。 */
    const c = buildValidated(context, {
      uuid: UUID_C,
      provenance: provenanceObj(),
      skills: [skillRequirement()],
      resources: skillStagedFiles(),
    })
    let injected = false
    const conflictingContext = {
      ...context,
      failpoint: (point) => {
        if (point !== 'install.before-db-commit' || injected) return
        injected = true
        db.exec(`UPDATE task_drafts SET payload_json = json_set(payload_json, '$.contentVersion', 99) WHERE id = '${c.draft.id}'`)
      },
    }
    const rolledBack = confirmExpertDraft(conflictingContext, confirmInput(c))
    assert.equal(injected, true)
    assert.equal(rolledBack.ok, false)
    assert.equal(rolledBack.code, 'draft-version-conflict')

    /** 本次新建的人格文件被撤回；**共享技能毫发无损**（不删 reusedPaths）。 */
    assert.equal(existsSync(personaDocPath(personasDir, UUID_C)), false)
    assert.equal(existsSync(personaDirPath(personasDir, UUID_C)), false)
    assert.deepEqual(snapshotTree(join(skillsDir, 'demo-skill')), sharedBefore)
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'workbench-install.json')), true)

    /** 暂存原件一个都没被消耗（还能重试）；草稿仍 pending、错误可观测。 */
    assert.equal(existsSync(stagedSkillPath(skillsDir, c.draft.id, 'demo-skill/SKILL.md')), true)
    assert.equal(existsSync(stagedPersonaPath(personasDir, c.draft.id, 'sources/demo/LICENSE.txt')), true)
    const row = getExpertDraft(db, c.draft.id)
    assert.equal(row.statusCode, 'pending')
    assert.equal(row.payload.phase, 'install-failed')
    assert.equal(row.payload.lastInstallError.code, 'draft-version-conflict')
    const journalC = readJson(journalPath(personasDir, c.draft.id))
    assert.equal(journalC.phase, 'rolled-back')
    assert.deepEqual(journalC.createdPaths.map((entry) => entry.area), ['persona-directory', 'persona-document'])

    /** 撤回之后 A 的技能仍然 ready（门没被牵连）。 */
    assert.equal(readManagedSkillInstallState(skillsDir, personasDir, 'demo-skill').ready, true)
  })
})

// ---------------------------------------------------------------------------
// §6.5 第 4 行：DB 已 confirmed 但 publication 未 ready → 不回滚
// ---------------------------------------------------------------------------

test('§6.5 DB 已 confirmed 但 publication 未 ready：不回滚、按日志补齐并刷新；文件对不上才 repair-required', () => {
  withFixture(({ context, db, personasDir, libraryOptions }) => {
    const built = buildValidated(context, { provenance: originalProvenance() })
    const expertId = `generated/${UUID_A}`
    let refreshCount = 0

    /** 让 publication.json 这一次必然发不出去：占住那个路径当目录。 */
    let blockedOnce = false
    const blockingContext = {
      ...context,
      refreshSkills: () => { refreshCount += 1 },
      failpoint: (point) => {
        if (point !== 'install.before-publication' || blockedOnce) return
        blockedOnce = true
        mkdirSync(join(personaDirPath(personasDir, UUID_A), 'publication.json'), { recursive: true })
      },
    }

    const first = confirmExpertDraft(blockingContext, confirmInput(built))
    assert.equal(blockedOnce, true)
    assert.equal(first.ok, false)
    assert.match(first.message, /不回滚/)
    assert.equal(refreshCount, 0)

    /** 已确认的数据一条都没被撤回。 */
    const row = getExpertDraft(db, built.draft.id)
    assert.equal(row.statusCode, 'confirmed')
    assert.equal(row.payload.confirmResult.expertId, expertId)
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true)
    const journal = readJson(journalPath(personasDir, built.draft.id))
    assert.equal(journal.phase, 'db-committed')
    assert.equal(journal.result.expertId, expertId)
    assert.equal(journal.result.manifestHash, built.manifestHash)

    /** 门没就绪 → 看不见。 */
    assert.equal(discoverPersonas(libraryOptions).personas.some((persona) => persona.id === expertId), false)

    /** 障碍还在：补齐发布这一步失败，但**依然不回滚**。 */
    const stillBlocked = confirmExpertDraft({ ...context, refreshSkills: () => { refreshCount += 1 } }, confirmInput(built))
    assert.equal(stillBlocked.ok, false)
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true)
    assert.equal(getExpertDraft(db, built.draft.id).statusCode, 'confirmed')

    /** 移除障碍后：同一份确认请求把 publication 补齐，并刷新 provider。 */
    rmSync(join(personaDirPath(personasDir, UUID_A), 'publication.json'), { recursive: true, force: true })
    const healed = confirmExpertDraft({ ...context, refreshSkills: () => { refreshCount += 1 } }, confirmInput(built))
    assert.equal(healed.ok, true, healed.ok === false ? healed.message : '')
    assert.equal(healed.replayed, true)
    assert.equal(refreshCount, 1)
    assert.equal(readJson(join(personaDirPath(personasDir, UUID_A), 'publication.json')).ready, true)
    assert.equal(readJson(journalPath(personasDir, built.draft.id)).phase, 'ready')
    assert.equal(discoverPersonas(libraryOptions).personas.some((persona) => persona.id === expertId), true)
  })
})

test('§6.5 DB 已 confirmed 但正式人格文档被改成别的内容：不覆盖、报 repair-required 并指出相对路径', () => {
  withFixture(({ context, db, personasDir, libraryOptions }) => {
    const built = buildValidated(context, { provenance: originalProvenance() })
    const expertId = `generated/${UUID_A}`
    const docPath = personaDocPath(personasDir, UUID_A)

    /** 先正常装完，再模拟"用户手改了已发布的正式文档、并把门文件挪掉"。 */
    const installed = confirmExpertDraft(context, confirmInput(built))
    assert.equal(installed.ok, true, installed.ok === false ? installed.message : '')
    rmSync(join(personaDirPath(personasDir, UUID_A), 'publication.json'))
    writeFileSync(docPath, `${personaDoc()}\n用户手改的一行\n`, 'utf8')
    const before = readText(docPath)

    const result = confirmExpertDraft(context, confirmInput(built))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'install-repair-required')
    assert.match(result.message, /generated\/[0-9a-f-]+\.md/)
    assert.equal(readText(docPath), before)
    assert.equal(existsSync(join(personaDirPath(personasDir, UUID_A), 'publication.json')), false)
    assert.equal(getExpertDraft(db, built.draft.id).statusCode, 'confirmed')
    assert.equal(discoverPersonas(libraryOptions).personas.some((persona) => persona.id === expertId), false)
    const journal = readJson(journalPath(personasDir, built.draft.id))
    assert.equal(journal.phase, 'repair-required')
  })
})

// ---------------------------------------------------------------------------
// AX-E23：锁
// ---------------------------------------------------------------------------

test('AX-E23 活 owner 拒绝、死 owner 可回收、owner 状态不明不强删；绝不释放别人的锁', () => {
  withFixture(({ context, roots, personasDir }) => {
    const built = buildValidated(context, { provenance: originalProvenance() })
    const lockPath = roots.installLockPath

    /** 先让"另一个进程"（活着的）拿着锁。 */
    const held = acquireExpertInstallLock({ lockPath, draftId: built.draft.id, pid: 4242, hostname: hostname(), now: () => AT })
    assert.equal(held.ok, true)
    const othersLock = readText(lockPath)

    const busy = confirmExpertDraft({ ...context, lock: { isProcessAlive: () => true } }, confirmInput(built))
    assert.equal(busy.ok, false)
    assert.equal(busy.code, 'install-busy')
    assert.equal(readText(lockPath), othersLock)

    /** owner 状态不明（进程状态查不出来）→ 不强删、不进入安装。 */
    const unknown = confirmExpertDraft({ ...context, lock: { isProcessAlive: () => undefined } }, confirmInput(built))
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'install-lock-owner-unknown')
    assert.equal(readText(lockPath), othersLock)

    /** 另一台主机的锁 → 同样按"不明"处理。 */
    const foreignHost = confirmExpertDraft({ ...context, lock: { isProcessAlive: () => true, hostname: 'another-host' } }, confirmInput(built))
    assert.equal(foreignHost.ok, false)
    assert.equal(foreignHost.code, 'install-lock-owner-unknown')
    assert.equal(readText(lockPath), othersLock)

    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)

    /** 死 owner（同主机、进程明确不存在）→ 回收死锁并装成功。 */
    const dead = confirmExpertDraft({ ...context, lock: { isProcessAlive: () => false } }, confirmInput(built))
    assert.equal(dead.ok, true, dead.ok === false ? dead.message : '')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true)
    /** 装完释放的是**自己**的锁：锁文件不该留下。 */
    assert.equal(existsSync(lockPath), false)

    /** 别人的锁：token 被换掉之后 release 不能删它。 */
    const mine = acquireExpertInstallLock({ lockPath, draftId: built.draft.id, now: () => AT })
    assert.equal(mine.ok, true)
    writeJson(lockPath, { pid: 9999, hostname: hostname(), token: 'someone-else-token', acquiredAt: AT })
    mine.handle.release()
    assert.equal(existsSync(lockPath), true)
    assert.equal(readJson(lockPath).token, 'someone-else-token')
    rmSync(lockPath, { force: true })
  })
})

// ---------------------------------------------------------------------------
// ownerDbKey（§6.3）：别人的日志只跳过，不能当"未提交"去补偿删除
// ---------------------------------------------------------------------------

test('§6.3 ownerDbKey：别的 DB / 缺失 owner 的日志只跳过；本 DB 的日志才按 DB 状态补偿', () => {
  withFixture(({ context, db, dbPath, personasDir, skillsDir }) => {
    const draft = createExpertDraft(db, {
      sessionId: SESSION_A,
      request: '做一个需求审查专家',
      expertId: defaultExpertId(UUID_A),
    }).draft

    /** 手工摆一份"已经发布了一半"的现场：一个正式人格文档 + 一份 prepared 日志。 */
    const docRelative = `generated/${UUID_A}.md`
    const docText = personaDoc()
    mkdirSync(personaDirPath(personasDir, UUID_A), { recursive: true })
    writeFileSync(personaDocPath(personasDir, UUID_A), docText, 'utf8')
    const entry = {
      area: 'persona-document',
      path: docRelative,
      files: [{ path: docRelative, bytes: Buffer.byteLength(docText, 'utf8'), sha256: sha256Hex(docText) }],
    }
    const journalOf = (ownerDbKey) => ({
      version: 1,
      ownerDbKey,
      draftId: draft.id,
      expertId: `generated/${UUID_A}`,
      manifestHash: sha256Hex('manifest-of-another-db'),
      phase: 'prepared',
      createdPaths: [entry],
      reusedPaths: [],
      result: null,
    })
    const writeJournal = (value) => {
      mkdirSync(join(personasDir, '.pending', draft.id), { recursive: true })
      writeJson(journalPath(personasDir, draft.id), value)
    }

    /** ① 别的 DB 写的：只跳过，一个文件都不动。 */
    writeJournal(journalOf('f'.repeat(64)))
    const foreign = recoverExpertInstallation(context, draft.id)
    assert.equal(foreign.action, 'skipped-foreign-owner')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true)
    assert.equal(readJson(journalPath(personasDir, draft.id)).phase, 'prepared')
    assert.equal(getExpertDraft(db, draft.id).payload.phase, 'editing')

    /** ② owner 缺失：同样不碰文件（不知道是谁的，就不许替它做主）。 */
    writeJournal(journalOf(''))
    const unknownOwner = recoverExpertInstallation(context, draft.id)
    assert.equal(unknownOwner.action, 'skipped-owner-unknown')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true)

    /** ③ 本 DB 的：草稿还是 pending → 补偿。ownerDbKey 按 §6.3 算法算出来给用。 */
    const ownKey = sha256Hex(canonicalDatabasePath(dbPath))
    writeJournal(journalOf(ownKey))
    const rolledBack = recoverExpertInstallation(context, draft.id)
    assert.equal(rolledBack.action, 'rolled-back')
    assert.deepEqual(rolledBack.phase, 'rolled-back')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)
    assert.equal(readJson(journalPath(personasDir, draft.id)).phase, 'rolled-back')
    const row = getExpertDraft(db, draft.id)
    assert.equal(row.statusCode, 'pending')
    assert.equal(row.payload.phase, 'install-failed')
    assert.equal(row.payload.lastInstallError.code, 'canceled')

    /** ④ 一次真实安装之后：扫描只报"已就绪"，不会去重做或回滚。 */
    const built = buildValidated(context, { uuid: UUID_B, sessionId: SESSION_B, provenance: originalProvenance() })
    const installed = confirmExpertDraft(context, confirmInput(built))
    assert.equal(installed.ok, true, installed.ok === false ? installed.message : '')
    const scan = recoverExpertInstallations(context)
    assert.equal(scan.outcomes.some((outcome) => outcome.draftId === built.draft.id && outcome.action === 'already-ready'), true)
    assert.equal(scan.outcomes.every((outcome) => outcome.action !== 'rolled-back'), true)
    assert.equal(existsSync(personaDocPath(personasDir, UUID_B)), true)
    assert.equal(skillsDir.endsWith('skills'), true)
  })
})
