/**
 * 专家安装的**中断与恢复**（`src/experts/install.ts` 的 `recover*` / `rollback*`）。
 *
 * 覆盖验收断言 AX-E20（任一 FS 发布点失败 → 没有可发现入口、只撤本次拥有的路径、
 * 原暂存仍可重试）、AX-E21（DB COMMIT 后 publication 前中断 → 新实例恢复 ready、
 * 重复确认幂等、不回滚已确认数据）、AX-E22（外部修改已发布文件 / 两个 journal 都坏 /
 * 其他 DB 的 journal → repair-required 或跳过，不覆盖不删除，其余工作台照常）。
 *
 * ## 两种中断形态，用途不同，不要混
 *
 * 1. **进程内失败（本文件 §A）**：`context.failpoint` 回调抛错 → `installPlanned` 的 catch
 *    接住并**当场补偿**。这是"异常被接住、立刻收尾"的形态，用来逐个故障点验证
 *    补偿决策（DB 落点、撤了哪些路径、journal 终态、暂存是否可重试）。
 * 2. **真进程被杀（本文件 §B）**：抛错**模拟不了**被杀（补偿一定会跑）。所以 §B 起一个
 *    真实子进程（`node <临时脚本>`）跑 stage → validate → confirm，并在指定故障点
 *    `process.exit(97)` —— 不走 finally、不补偿、不释放锁，磁盘上留下的是**真正的**崩溃现场：
 *    半成品正式文件 + 对应 phase 的 journal + 一把 owner 已死的锁。
 *    然后父进程在**同一个 dbPath 上重新 open 一个 DB 句柄 + 新的 context**（= 新实例），
 *    调 `recoverExpertInstallations` / `recoverExpertInstallation`，按 §6.5 逐行验收。
 *
 * 用子进程而不是"手工摆现场"的理由：手工摆现场要复刻 `buildPlan` 里
 * provenance.json / workbench-install.json / publication.json 的字节与哈希，
 * 复刻写错就会验证一个**不存在的**现场；而 `process.exit` 在故障点上死掉是产品代码
 * 自己的执行路径（注入点仍然只有 `context.failpoint` 这一个，模型/HTTP 都到不了它）。
 *
 * ## 写法约定
 *
 * - 每个用例一个 `mkdtempSync` 临时根（`personas/` + `skills/` + `outside/` 哨兵 + 空 `builtin/`），
 *   **从不碰真实的 `~/.dsh/workbench`**。
 * - 只断言真实产物：DB 里那一行的 payload、磁盘上的真实字节、`discoverPersonas` /
 *   `resolvePersona` 的真实返回。错误码只作为补充证据，不作为唯一证据。
 * - "一个字节都没动"一律用 `snapshotTree`（相对路径 + sha256 的有序列表）断言，
 *   多出来的文件也会被发现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { createExpertDraft, defaultExpertId, getExpertDraft, transitionExpertDraftInstall } from '../lib/db/repo/experts.js'
import { stageExpertFile, submitExpertDraft, validateExpertDraft } from '../lib/experts/drafts.js'
import {
  canonicalDatabasePath,
  confirmExpertDraft,
  readExpertInstallJournal,
  recoverExpertInstallation,
  recoverExpertInstallations,
} from '../lib/experts/install.js'
import { acquireExpertInstallLock, resolveExpertRoots } from '../lib/experts/paths.js'
import { sha256Hex } from '../lib/experts/provenance.js'
import { discoverPersonas, resolvePersona } from '../lib/personas/library.js'
import { readManagedPersonaPublication } from '../lib/personas/managed.js'

const SESSION_A = 'session-fake-aaaa-0001'
const SESSION_B = 'session-fake-bbbb-0002'
const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const AT = '2026-01-01T00:00:00.000Z'

/** 子进程里 import 的根：与本文件同级的 `../lib/`。 */
const LIB_URL = new URL('../lib/', import.meta.url).href
/** `src/experts/install.ts` 里的全部安装期故障点（17 个，与生产类型的联合成员一一对应）。 */
const PRE_JOURNAL_FAILPOINTS = [
  /**
   * 单独一例：这一刻连 `install-journal.json` 都还没写（`buildPlan` 是纯读的，之后才进
   * 补偿器覆盖的 `installPlanned`）。所以它**没有可补偿的东西**，异常会照原样抛给调用方
   * —— 这是设计上的分界，不是漏网之鱼；用例断言的是"磁盘与 DB 一个字节都没动"。
   */
  'install.after-validation',
]
const PRE_COMMIT_FAILPOINTS = [
  'install.before-prepared-journal',
  'install.after-prepared-journal',
  'install.before-persona-directory',
  'install.after-persona-directory',
  'install.before-skill-directory',
  'install.after-skill-directory',
  'install.before-persona-document',
  'install.after-persona-document',
  'install.before-files-published-journal',
  'install.after-files-published-journal',
  'install.before-db-commit',
]
const POST_COMMIT_FAILPOINTS = [
  'install.after-db-commit',
  'install.before-publication',
  'install.after-publication',
  'install.before-provider-refresh',
  'install.after-ready-journal',
]

// ---------------------------------------------------------------------------
// 临时根与磁盘工具
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

function readText(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 写一段**故意坏掉的**文本（用它是因为要绕过 `writeJson` 的 JSON 化）。 */
function writeText(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/**
 * 目录快照：`相对路径:sha256` 的有序列表。
 *
 * 用它断言"一个字节都没变"（不覆盖用户的改动、不删别人的共享文件、暂存原件不动），
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-wb-expert-recovery-'))
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
  const opened = []
  const openDb = (name = 'workbench.db') => {
    const handle = openWorkbenchDb({ dbPath: join(root, name) })
    seedDictionaries(handle)
    opened.push(handle)
    return handle
  }
  const closeDb = (handle) => {
    const index = opened.indexOf(handle)
    if (index >= 0) opened.splice(index, 1)
    try {
      handle.close()
    } catch {
      /** 已经关过了。 */
    }
  }

  const db = openDb()
  const roots = resolveExpertRoots({ personasDir, skillsDir })
  const context = { db, roots, now: () => AT }
  const libraryOptions = { userDir: personasDir, externalDir: '', builtinDir }
  const safeToRemove = root.startsWith(tmpdir()) && root.includes('dsh-wb-expert-recovery-')
  try {
    run({
      root,
      dbPath,
      db,
      roots,
      context,
      personasDir,
      skillsDir,
      outsideDir,
      builtinDir,
      libraryOptions,
      openDb,
      closeDb,
    })
  } finally {
    for (const handle of opened.splice(0)) {
      try {
        handle.close()
      } catch {
        /** 关不掉也必须继续清理。 */
      }
    }
    if (safeToRemove && existsSync(root)) removeTempDir(root)
  }
}

// ---------------------------------------------------------------------------
// 夹具构造（与 test/expertInstall.test.mjs 同源：要能一路走到 confirm）
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
 * 造一份**已经校验通过**的草稿（submit → stage → validate）。
 *
 * 校验必须真的通过：`confirmExpertDraft` 会**重新跑一遍**校验（§6.4 第 3 步）。
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

function previousJournalPath(personasDir, draftId) {
  return join(personasDir, '.pending', draftId, 'journal.previous.json')
}

function pendingPersonaDir(personasDir, draftId) {
  return join(personasDir, '.pending', draftId)
}

function pendingSkillDir(skillsDir, draftId) {
  return join(skillsDir, '.pending', draftId)
}

/** 受管人格在发现链里"看得见吗"：两条路都要问。 */
function visible(libraryOptions, expertId) {
  const discovery = discoverPersonas(libraryOptions)
  return {
    listed: discovery.personas.some((persona) => persona.id === expertId),
    resolved: resolvePersona(expertId, libraryOptions).ok,
    incomplete: discovery.diagnostics.some(
      (diagnostic) => diagnostic.code === 'installation-incomplete' && diagnostic.id === expertId,
    ),
  }
}

// ---------------------------------------------------------------------------
// §A 进程内失败：17 个故障点逐个跑（异常被接住 → 当场补偿）
// ---------------------------------------------------------------------------

/** 一份"人格 + 一个 install 技能"的已校验草稿（skill 故障点才会真的被走到）。 */
function buildWithSkill(context, options = {}) {
  return buildValidated(context, {
    provenance: provenanceObj(),
    skills: [skillRequirement()],
    resources: skillStagedFiles(),
    ...options,
  })
}

/** 记下"走到过哪些故障点"，并在目标点上抛错 —— 于是安装**恰好**断在那里。 */
function contextFailingAt(context, point, visited) {
  return {
    ...context,
    failpoint: (current) => {
      visited.push(current)
      if (current === point) throw new Error(`注入故障：${point}`)
    },
  }
}

test('AX-E20 发行前最后一次校验之后失败：连日志都还没写，磁盘与 DB 一个字节都没动', () => {
  for (const point of PRE_JOURNAL_FAILPOINTS) {
    withFixture(({ context, db, personasDir, skillsDir, libraryOptions }) => {
      const built = buildWithSkill(context)
      const draftId = built.draft.id
      const expertId = `generated/${UUID_A}`
      const personaStaging = join(pendingPersonaDir(personasDir, draftId), 'files')
      const skillStaging = pendingSkillDir(skillsDir, draftId)
      const stagedPersona = snapshotTree(personaStaging)
      const stagedSkill = snapshotTree(skillStaging)
      const beforePending = snapshotTree(pendingPersonaDir(personasDir, draftId))

      const visited = []
      assert.throws(
        () => confirmExpertDraft(contextFailingAt(context, point, visited), confirmInput(built)),
        /注入故障/,
        `${point}：这一刻在补偿器之外，异常原样抛出`,
      )
      assert.equal(visited[visited.length - 1], point, point)

      /** ① 什么都没写：连日志都没有（`install-journal.json` 只由安装器写，这里还没轮到它）。 */
      assert.equal(existsSync(journalPath(personasDir, draftId)), false, point)
      assert.deepEqual(snapshotTree(pendingPersonaDir(personasDir, draftId)), beforePending, point)
      assert.equal(existsSync(join(pendingPersonaDir(personasDir, draftId), '.build-persona')), false, point)
      assert.equal(existsSync(join(skillStaging, '.build')), false, point)

      /** ② DB 保持"已校验但没进安装"：阶段与错误字段都没被动过。 */
      const row = getExpertDraft(db, draftId)
      assert.equal(row.statusCode, 'pending', point)
      assert.equal(row.payload.phase, 'validated', point)
      assert.equal(row.payload.contentVersion, built.version, point)
      assert.equal(row.payload.lastInstallError, null, point)

      /** ③ 没有入口，且暂存原件可原样重试。 */
      assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false, point)
      const hidden = visible(libraryOptions, expertId)
      assert.equal(hidden.listed, false, point)
      assert.equal(hidden.resolved, false, point)
      assert.deepEqual(snapshotTree(personaStaging), stagedPersona, point)
      assert.deepEqual(snapshotTree(skillStaging), stagedSkill, point)

      const retry = confirmExpertDraft(context, confirmInput(built))
      assert.equal(retry.ok, true, `${point}：重试应当成功（${retry.ok === false ? retry.message : ''}）`)
      assert.equal(visible(libraryOptions, expertId).listed, true, point)
    })
  }
})

test('AX-E20 发布前 11 个故障点：草稿仍 pending/install-failed、无入口、只撤本次路径、暂存可重试', () => {
  for (const point of PRE_COMMIT_FAILPOINTS) {
    withFixture(({ context, db, personasDir, skillsDir, libraryOptions }) => {
      const built = buildWithSkill(context)
      const draftId = built.draft.id
      const expertId = `generated/${UUID_A}`
      const personaStaging = join(pendingPersonaDir(personasDir, draftId), 'files')
      const skillStaging = pendingSkillDir(skillsDir, draftId)
      const stagedPersona = snapshotTree(personaStaging)
      const stagedSkill = snapshotTree(skillStaging)
      assert.equal(stagedPersona.length > 0, true, `${point}：夹具没暂存到附件`)
      assert.equal(stagedSkill.length > 0, true, `${point}：夹具没暂存到技能包`)

      const visited = []
      const result = confirmExpertDraft(contextFailingAt(context, point, visited), confirmInput(built))

      /** ① 失败回执：未预期异常走 catch-all，如实报成"需要人工确认的补偿"。 */
      assert.equal(result.ok, false, `${point}：应该失败`)
      assert.equal(result.code, 'install-repair-required', `${point}：${result.ok ? '' : result.message}`)
      assert.match(result.message, /未提交|补偿/, `${point}：${result.message}`)
      /** 证明"恰好断在目标点"：最后一个被走到的故障点就是它。 */
      assert.equal(visited[visited.length - 1], point, `${point}：实际最后走到 ${visited[visited.length - 1]}`)

      /** ② DB：仍是 pending，阶段 install-failed，版本号没漂。 */
      const row = getExpertDraft(db, draftId)
      assert.equal(row.statusCode, 'pending', point)
      assert.equal(row.payload.phase, 'install-failed', point)
      assert.equal(row.payload.contentVersion, built.version, point)
      assert.equal(row.payload.lastInstallError.code, 'install-repair-required', point)

      /** ③ 正式位置：没有可发现入口（目录与文档都不该留下）。 */
      assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false, point)
      assert.equal(existsSync(personaDirPath(personasDir, UUID_A)), false, point)
      assert.equal(existsSync(join(skillsDir, 'demo-skill')), false, point)
      const hidden = visible(libraryOptions, expertId)
      assert.equal(hidden.listed, false, point)
      assert.equal(hidden.resolved, false, point)

      /** ④ journal 终态 = rolled-back（构建目录也被清掉）。 */
      assert.equal(readJson(journalPath(personasDir, draftId)).phase, 'rolled-back', point)
      assert.equal(existsSync(join(pendingPersonaDir(personasDir, draftId), '.build-persona')), false, point)
      assert.equal(existsSync(join(skillStaging, '.build')), false, point)

      /** ⑤ 暂存原件一个字节没动 → 同一个 contentVersion 可以再来一次，并且这次成功。 */
      assert.deepEqual(snapshotTree(personaStaging), stagedPersona, point)
      assert.deepEqual(snapshotTree(skillStaging), stagedSkill, point)

      const retry = confirmExpertDraft(context, confirmInput(built))
      assert.equal(retry.ok, true, `${point}：重试应当成功（${retry.ok === false ? retry.message : ''}）`)
      assert.equal(retry.replayed, false, point)
      const after = visible(libraryOptions, expertId)
      assert.equal(after.listed, true, point)
      assert.equal(after.resolved, true, point)
      assert.equal(readManagedPersonaPublication(personasDir, expertId).ok, true, point)
      assert.equal(readJson(journalPath(personasDir, draftId)).phase, 'ready', point)
      assert.equal(getExpertDraft(db, draftId).statusCode, 'confirmed', point)
    })
  }
})

test('AX-E21 DB COMMIT 之后 5 个故障点：不回滚已确认数据、补齐 publication、重复确认幂等', () => {
  for (const point of POST_COMMIT_FAILPOINTS) {
    withFixture(({ context, db, personasDir, skillsDir, libraryOptions }) => {
      const built = buildWithSkill(context)
      const draftId = built.draft.id
      const expertId = `generated/${UUID_A}`
      const personaStaging = join(pendingPersonaDir(personasDir, draftId), 'files')
      const stagedPersona = snapshotTree(personaStaging)

      const visited = []
      const result = confirmExpertDraft(contextFailingAt(context, point, visited), confirmInput(built))
      assert.equal(result.ok, false, `${point}：应该失败`)
      assert.equal(result.code, 'install-repair-required', `${point}：${result.ok ? '' : result.message}`)
      assert.match(result.message, /不回滚/, `${point}：${result.message}`)
      assert.equal(visited[visited.length - 1], point, point)

      /**
       * 断点后的日志终态：**已提交分支的补偿统一把日志钉在 `db-committed`**（不回滚）。
       * 特别地 `install.after-ready-journal`：日志本来已经是 `ready`，补偿会把它重写成
       * `db-committed` —— 仅测试可达（生产不会在这个点抛错），恢复仍按 DB + publication
       * 判 `already-ready`，无功能影响；已在交接材料"规格偏差"里如实记录。
       */
      assert.equal(readJson(journalPath(personasDir, draftId)).phase, 'db-committed', point)

      /** ① DB 已 confirmed：**绝不回滚**（这是 §6.5 第 4 行唯一允许的落点）。 */
      const row = getExpertDraft(db, draftId)
      assert.equal(row.statusCode, 'confirmed', point)
      assert.equal(row.payload.confirmResult.expertId, expertId, point)
      assert.equal(row.payload.confirmResult.manifestHash, built.manifestHash, point)

      /** ② 正式文件全部留下（含技能包与人格文档）。 */
      assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true, point)
      assert.equal(existsSync(join(personaDirPath(personasDir, UUID_A), 'provenance.json')), true, point)
      assert.equal(existsSync(join(skillsDir, 'demo-skill', 'workbench-install.json')), true, point)
      assert.deepEqual(snapshotTree(personaStaging), stagedPersona, point)

      /**
       * ③ publication 与可见性由"断在 publication 之前还是之后"决定：
       *    after-db-commit / before-publication → 门没发 → 读不到（但文档已在正式位置）；
       *    after-publication 及之后 → 门已发 → 可发现。
       */
      const publicationReady = readManagedPersonaPublication(personasDir, expertId).ok
      const expectedReady = point !== 'install.after-db-commit' && point !== 'install.before-publication'
      assert.equal(publicationReady, expectedReady, point)
      const during = visible(libraryOptions, expertId)
      assert.equal(during.listed, expectedReady, point)
      assert.equal(during.resolved, expectedReady, point)
      if (expectedReady === false) {
        assert.equal(during.incomplete, true, `${point}：应当给出 installation-incomplete 诊断`)
      }

      /** ④ 重复确认：幂等回放，补齐 publication，幂等（不新增文件）。 */
      const replay = confirmExpertDraft(context, confirmInput(built))
      assert.equal(replay.ok, true, `${point}：${replay.ok === false ? replay.message : ''}`)
      assert.equal(replay.replayed, true, point)
      assert.equal(replay.result.expertId, expertId, point)
      assert.equal(replay.result.manifestHash, built.manifestHash, point)
      assert.equal(readManagedPersonaPublication(personasDir, expertId).ok, true, point)
      const after = visible(libraryOptions, expertId)
      assert.equal(after.listed, true, point)
      assert.equal(after.resolved, true, point)
      /**
       * 回放之后日志的落点分两种（**实现如此，用例如实记录**）：
       * - 回放时 publication 还没就绪（`after-db-commit` / `before-publication`）→ 走"补齐发布"
       *   分支，末尾把日志推回 `ready`；
       * - 回放时 publication 已就绪（其余三点）→ 走"原样回放"分支，**不重写日志**，
       *   于是日志停在上一步补偿留下的 `db-committed`。恢复判定只看 DB + publication
       *   （→ `already-ready`），所以不影响功能。
       */
      const healed = point === 'install.after-db-commit' || point === 'install.before-publication'
      assert.equal(readJson(journalPath(personasDir, draftId)).phase, healed ? 'ready' : 'db-committed', point)

      /** ⑤ 再确认仍然幂等：已发布内容一个字节都不变（含 publication.json 的时间戳）。 */
      const published = snapshotTree(join(personasDir, 'generated'))
      const again = confirmExpertDraft(context, confirmInput(built))
      assert.equal(again.ok, true, point)
      assert.equal(again.replayed, true, point)
      assert.deepEqual(snapshotTree(join(personasDir, 'generated')), published, `${point}：回放不该改动已发布内容`)
    })
  }
})

// ---------------------------------------------------------------------------
// §B 真进程被杀：在故障点上当场消失（不走 finally、不补偿、不释放锁）
// ---------------------------------------------------------------------------

/**
 * 子进程跑的是**产品代码自己的路径**（stage → validate → confirm），只在目标故障点
 * `process.exit(97)` 当场消失。
 *
 * 用 `process.exit` 而不是发信号：退出码确定、跨平台一致，而且同样满足"不展开调用栈、
 * 不执行 finally、不做补偿、不释放锁"这四条关键性质（`finally` 里的锁释放因此被跳过）。
 * 断电/信号打断**写到一半**的字节撕裂不在本期范围内（§6.3 末段）。
 */
const CHILD_SCRIPT = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  '',
  "const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))",
  'const lib = config.libUrl',
  "const { openWorkbenchDb } = await import(lib + 'db/database.js')",
  "const { createExpertDraft, defaultExpertId } = await import(lib + 'db/repo/experts.js')",
  "const { stageExpertFile, submitExpertDraft, validateExpertDraft } = await import(lib + 'experts/drafts.js')",
  "const { confirmExpertDraft } = await import(lib + 'experts/install.js')",
  "const { resolveExpertRoots } = await import(lib + 'experts/paths.js')",
  '',
  'const db = openWorkbenchDb({ dbPath: config.dbPath })',
  'const roots = resolveExpertRoots({ personasDir: config.personasDir, skillsDir: config.skillsDir })',
  'const context = {',
  '  db,',
  '  roots,',
  '  now: () => config.at,',
  '  ...(config.ownerDbKey === null ? {} : { ownerDbKey: config.ownerDbKey }),',
  '  failpoint: (point) => {',
  '    if (point !== config.failpoint) return',
  "    writeFileSync(config.markerPath, point + '\\n', 'utf8')",
  '    process.exit(97)',
  '  },',
  '}',
  '',
  'const draftId = createExpertDraft(db, {',
  '  sessionId: config.sessionId,',
  '  request: config.request,',
  '  expertId: defaultExpertId(config.uuid),',
  '}).draft.id',
  'const submitted = submitExpertDraft(context, {',
  '  draftId,',
  '  sessionId: config.sessionId,',
  '  expectedVersion: 0,',
  '  personaMd: config.personaMd,',
  '  provenanceJson: config.provenance,',
  '  skillsJson: config.skills,',
  '})',
  'if (submitted.ok !== true) {',
  "  writeFileSync(config.errorPath, JSON.stringify({ step: 'submit', submitted }, null, 2))",
  '  process.exit(3)',
  '}',
  'let version = submitted.contentVersion',
  'for (const file of config.resources) {',
  '  const staged = stageExpertFile(context, {',
  '    draftId,',
  '    sessionId: config.sessionId,',
  '    expectedVersion: version,',
  '    area: file[0],',
  '    path: file[1],',
  '    contentUtf8: file[2],',
  '  })',
  '  if (staged.ok !== true) {',
  "    writeFileSync(config.errorPath, JSON.stringify({ step: 'stage', path: file[1], staged }, null, 2))",
  '    process.exit(4)',
  '  }',
  '  version = staged.contentVersion',
  '}',
  'const validated = validateExpertDraft(context, { draftId, expectedVersion: version, sessionId: config.sessionId })',
  'if (validated.ok !== true || validated.validation.errors.length > 0) {',
  "  writeFileSync(config.errorPath, JSON.stringify({ step: 'validate', validated }, null, 2))",
  '  process.exit(5)',
  '}',
  "writeFileSync(config.statePath, JSON.stringify({ draftId, version: validated.contentVersion, manifestHash: validated.manifestHash }, null, 2))",
  'const confirmed = confirmExpertDraft(context, {',
  '  draftId,',
  '  expectedVersion: validated.contentVersion,',
  '  expectedManifestHash: validated.manifestHash,',
  '})',
  'writeFileSync(config.resultPath, JSON.stringify({',
  '  ok: confirmed.ok,',
  '  code: confirmed.ok === true ? null : confirmed.code,',
  '  draftId,',
  '  version: validated.contentVersion,',
  '  manifestHash: validated.manifestHash,',
  '}, null, 2))',
  'process.exit(confirmed.ok === true ? 0 : 6)',
  '',
].join('\n')

/**
 * 起一个真实子进程跑到指定故障点后当场死掉，返回它在磁盘上留下的现场。
 *
 * 子进程用 `process.exit(97)` 退出 → `spawnSync` 的 `status` 就是 97（证明它**恰好**死在
 * 目标点上），并且 `.install.lock` 会作为"owner 已死的锁"留在磁盘上。
 */
function crashInstall(fixture, options) {
  const { point, uuid = UUID_A, sessionId = SESSION_A, ownerDbKey = null, dbPath = fixture.dbPath } = options
  const scriptPath = join(fixture.root, 'crash-child.mjs')
  const configPath = join(fixture.root, 'crash-config.json')
  const markerPath = join(fixture.root, 'crash-marker.txt')
  const statePath = join(fixture.root, 'crash-state.json')
  const errorPath = join(fixture.root, 'crash-error.json')
  writeFileSync(scriptPath, CHILD_SCRIPT, 'utf8')
  writeJson(configPath, {
    libUrl: LIB_URL,
    dbPath,
    personasDir: fixture.personasDir,
    skillsDir: fixture.skillsDir,
    at: AT,
    sessionId,
    request: '做一个需求审查专家',
    uuid,
    personaMd: personaDoc(),
    provenance: provenanceObj(),
    skills: [skillRequirement()],
    resources: skillStagedFiles(),
    failpoint: point,
    ownerDbKey,
    markerPath,
    statePath,
    errorPath,
  })
  const run = spawnSync(process.execPath, [scriptPath, configPath], { stdio: 'ignore', cwd: fixture.root, timeout: 120000 })

  const detail = existsSync(errorPath) ? `；子进程报错：${readText(errorPath)}` : ''
  assert.equal(existsSync(markerPath), true, `子进程没能走到故障点 ${point}（status=${String(run.status)}）${detail}`)
  assert.equal(run.status, 97, `子进程应当死在故障点 ${point}（status=${String(run.status)}）${detail}`)
  const state = readJson(statePath)
  return { run, state, draftId: state.draftId, version: state.version, manifestHash: state.manifestHash, markerPath }
}

test('AX-E20 真崩溃 @prepared：新实例按日志补偿，撤掉正式文件、暂存可重试', () => {
  withFixture((fixture) => {
    const { context, db, personasDir, skillsDir, roots, libraryOptions } = fixture
    const expertId = `generated/${UUID_A}`
    const crash = crashInstall(fixture, { point: 'install.after-prepared-journal' })

    /** 现场①：锁是那个已经死掉的子进程留下的（没有 finally → 没被释放）。 */
    assert.equal(existsSync(roots.installLockPath), true)
    assert.equal(readJson(roots.installLockPath).pid, crash.run.pid)
    assert.equal(readJson(roots.installLockPath).draftId, crash.draftId)
    /** 现场②：journal 停在 prepared，正式位置还什么都没有。 */
    assert.equal(readJson(journalPath(personasDir, crash.draftId)).phase, 'prepared')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)
    assert.equal(existsSync(personaDirPath(personasDir, UUID_A)), false)

    /** 新实例：关掉旧句柄、在同一个 dbPath 上重新 open，构造新的 context。 */
    fixture.closeDb(db)
    const freshDb = fixture.openDb()
    const fresh = { db: freshDb, roots, now: () => AT }
    const row = getExpertDraft(freshDb, crash.draftId)
    assert.equal(row.statusCode, 'pending')
    /** 日志先写、DB 阶段后改（§6.4 第 4 步的顺序），所以断在这个点上 DB 还是上一阶段。 */
    assert.equal(row.payload.phase, 'validated')

    const scan = recoverExpertInstallations(fresh)
    assert.equal(scan.scanned, 1)
    assert.deepEqual(scan.outcomes.map((outcome) => [outcome.draftId, outcome.action]), [[crash.draftId, 'rolled-back']])
    assert.equal(readJson(journalPath(personasDir, crash.draftId)).phase, 'rolled-back')
    assert.equal(getExpertDraft(freshDb, crash.draftId).payload.phase, 'install-failed')
    assert.equal(getExpertDraft(freshDb, crash.draftId).payload.lastInstallError.code, 'canceled')
    assert.equal(visible(libraryOptions, expertId).listed, false)
    /** 补偿做完了，锁也该被这次恢复自己释放（不是留一把死锁）。 */
    assert.equal(existsSync(roots.installLockPath), false)

    /** 暂存原件没被动过 → 同一个 contentVersion 重试成功。 */
    const retry = confirmExpertDraft(fresh, {
      draftId: crash.draftId,
      expectedVersion: crash.version,
      expectedManifestHash: crash.manifestHash,
    })
    assert.equal(retry.ok, true, retry.ok === false ? retry.message : '')
    assert.equal(visible(libraryOptions, expertId).listed, true)
    assert.equal(visible(libraryOptions, expertId).resolved, true)
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'SKILL.md')), true)
  })
})

test('AX-E20 真崩溃 @files-published：新实例撤掉全部正式文件，且未被发现过', () => {
  withFixture((fixture) => {
    const { db, personasDir, skillsDir, roots, libraryOptions } = fixture
    const expertId = `generated/${UUID_A}`
    const crash = crashInstall(fixture, { point: 'install.after-files-published-journal' })

    /** 现场：正式文件全都在（目录 + 技能包 + 人格文档），只差 publication 与 DB 提交。 */
    assert.equal(readJson(journalPath(personasDir, crash.draftId)).phase, 'files-published')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true)
    assert.equal(existsSync(join(personaDirPath(personasDir, UUID_A), 'provenance.json')), true)
    assert.equal(existsSync(join(skillsDir, 'demo-skill', 'SKILL.md')), true)
    const during = visible(libraryOptions, expertId)
    assert.equal(during.listed, false)
    assert.equal(during.resolved, false)
    assert.equal(during.incomplete, true)

    fixture.closeDb(db)
    const freshDb = fixture.openDb()
    const fresh = { db: freshDb, roots, now: () => AT }
    assert.equal(getExpertDraft(freshDb, crash.draftId).payload.phase, 'installing')

    const outcome = recoverExpertInstallation(fresh, crash.draftId)
    assert.equal(outcome.action, 'rolled-back')
    assert.deepEqual(outcome.phase, 'rolled-back')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)
    assert.equal(existsSync(personaDirPath(personasDir, UUID_A)), false)
    assert.equal(existsSync(join(skillsDir, 'demo-skill')), false)
    assert.equal(visible(libraryOptions, expertId).listed, false)

    /** 暂存原件完整，重试能装成功（AX-E20 的"原暂存仍可重试"）。 */
    const retry = confirmExpertDraft(fresh, {
      draftId: crash.draftId,
      expectedVersion: crash.version,
      expectedManifestHash: crash.manifestHash,
    })
    assert.equal(retry.ok, true, retry.ok === false ? retry.message : '')
    assert.equal(visible(libraryOptions, expertId).listed, true)
  })
})

test('AX-E21 真崩溃 @DB 已提交：新实例补齐 publication（不回滚），重复确认幂等', () => {
  /**
   * 两个都测：`after-db-commit` 时日志还停在上一阶段（`db-committed` 日志写在 COMMIT 之后），
   * `before-publication` 时日志已经是 `db-committed` —— 恢复要能同时吃下这两种现场。
   */
  for (const [point, expectedJournalPhase] of [
    ['install.after-db-commit', 'files-published'],
    ['install.before-publication', 'db-committed'],
  ]) {
    withFixture((fixture) => {
      const { db, personasDir, skillsDir, roots, libraryOptions } = fixture
      const expertId = `generated/${UUID_A}`
      const crash = crashInstall(fixture, { point })

      assert.equal(readJson(journalPath(personasDir, crash.draftId)).phase, expectedJournalPhase, point)
      assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), true, point)
      assert.equal(existsSync(join(personaDirPath(personasDir, UUID_A), 'publication.json')), false, point)
      assert.equal(visible(libraryOptions, expertId).listed, false, point)

      fixture.closeDb(db)
      const freshDb = fixture.openDb()
      const fresh = { db: freshDb, roots, now: () => AT }
      /** 现场：DB 已 confirmed 但门没发 —— §6.5 说**不回滚**，只补齐。 */
      const row = getExpertDraft(freshDb, crash.draftId)
      assert.equal(row.statusCode, 'confirmed', point)
      assert.equal(row.payload.confirmResult.manifestHash, crash.manifestHash, point)
      const published = snapshotTree(join(personasDir, 'generated'))

      const outcome = recoverExpertInstallation(fresh, crash.draftId)
      assert.equal(outcome.action, 'completed-publication', point)
      assert.deepEqual(outcome.phase, 'ready', point)
      assert.equal(existsSync(join(personaDirPath(personasDir, UUID_A), 'publication.json')), true, point)
      assert.equal(existsSync(join(skillsDir, 'demo-skill', 'workbench-install.json')), true, point)
      const after = visible(libraryOptions, expertId)
      assert.equal(after.listed, true, point)
      assert.equal(after.resolved, true, point)
      /** 只多了一个 publication.json，其余正式内容一个字节都没变。 */
      const added = snapshotTree(join(personasDir, 'generated')).filter((entry) => published.includes(entry) === false)
      assert.deepEqual(added.map((entry) => entry.split(':')[0]), [`${UUID_A}/publication.json`], point)
      assert.equal(getExpertDraft(freshDb, crash.draftId).statusCode, 'confirmed', point)

      /** 重复确认：同一个 expertId / confirmResult，文件数不增加。 */
      const before = snapshotTree(join(personasDir, 'generated'))
      const replay = confirmExpertDraft(fresh, {
        draftId: crash.draftId,
        expectedVersion: crash.version,
        expectedManifestHash: crash.manifestHash,
      })
      assert.equal(replay.ok, true, replay.ok === false ? replay.message : '')
      assert.equal(replay.replayed, true, point)
      assert.equal(replay.result.expertId, expertId, point)
      assert.deepEqual(snapshotTree(join(personasDir, 'generated')), before, point)
    })
  }
})

test('AX-E21 真崩溃 @ready：新实例只报 already-ready，一个字节都不改', () => {
  withFixture((fixture) => {
    const { db, personasDir, roots, libraryOptions } = fixture
    const expertId = `generated/${UUID_A}`
    const crash = crashInstall(fixture, { point: 'install.after-ready-journal' })

    assert.equal(readJson(journalPath(personasDir, crash.draftId)).phase, 'ready')
    const before = snapshotTree(join(personasDir, 'generated'))
    assert.equal(visible(libraryOptions, expertId).listed, true)

    fixture.closeDb(db)
    const freshDb = fixture.openDb()
    const fresh = { db: freshDb, roots, now: () => AT }
    assert.equal(getExpertDraft(freshDb, crash.draftId).statusCode, 'confirmed')

    const scan = recoverExpertInstallations(fresh)
    assert.deepEqual(scan.outcomes.map((outcome) => [outcome.draftId, outcome.action]), [[crash.draftId, 'already-ready']])
    assert.deepEqual(snapshotTree(join(personasDir, 'generated')), before)
    assert.equal(readJson(journalPath(personasDir, crash.draftId)).phase, 'ready')
    assert.equal(existsSync(roots.installLockPath), false, '恢复完要释放自己拿的锁')
  })
})

// ---------------------------------------------------------------------------
// §C 恢复期的锁：活 owner / 死 owner / 状态不明 / 别的主机
// ---------------------------------------------------------------------------

/**
 * 手工摆一份"已经发布了一个正式人格文档、DB 还没确认、日志停在 prepared"的现场。
 *
 * 手工摆是为了精确控制 `ownerDbKey`（这正是本组用例要测的变量）；文件字节与登记哈希
 * 由同一段代码算出，所以"补偿时核对内容哈希"这条真的会被走到。
 */
function handMadeScene(fixture, options = {}) {
  const { uuid = UUID_A, sessionId = SESSION_A, phase = 'prepared', ownerDbKey } = options
  const { db, personasDir } = fixture
  const draft = createExpertDraft(db, {
    sessionId,
    request: '做一个需求审查专家',
    expertId: defaultExpertId(uuid),
  }).draft
  const docRelative = `generated/${uuid}.md`
  const docText = personaDoc()
  mkdirSync(personaDirPath(personasDir, uuid), { recursive: true })
  writeFileSync(personaDocPath(personasDir, uuid), docText, 'utf8')
  const bytes = Buffer.byteLength(docText, 'utf8')
  const entry = {
    area: 'persona-document',
    path: docRelative,
    files: [{ path: docRelative, bytes, sha256: sha256Hex(docText) }],
  }
  const journal = {
    version: 1,
    ownerDbKey,
    draftId: draft.id,
    expertId: `generated/${uuid}`,
    manifestHash: sha256Hex('hand-made-manifest'),
    phase,
    createdPaths: [entry],
    reusedPaths: [],
    result: null,
  }
  return { draft, journal, docPath: personaDocPath(personasDir, uuid), docText, entry }
}

function writeJournalObject(fixture, journal) {
  writeJson(journalPath(fixture.personasDir, journal.draftId), journal)
}

test('AX-E23 恢复期锁三档：活/不明/别的主机都跳过且不碰别人的锁，死 owner 可回收', () => {
  withFixture((fixture) => {
    const { context, personasDir, roots, dbPath } = fixture
    const scene = handMadeScene(fixture, { ownerDbKey: sha256Hex(canonicalDatabasePath(dbPath)) })
    writeJournalObject(fixture, scene.journal)
    const lockPath = roots.installLockPath

    const putLock = (options = {}) => {
      rmSync(lockPath, { force: true })
      const held = acquireExpertInstallLock({ lockPath, draftId: scene.draft.id, now: () => AT, ...options })
      assert.equal(held.ok, true)
      return readText(lockPath)
    }

    /** ① 活 owner（另一个进程还在跑）：只跳过，锁一个字节都不动。 */
    const liveLock = putLock({ pid: 4242, hostname: hostname() })
    const live = recoverExpertInstallation({ ...context, lock: { isProcessAlive: () => true } }, scene.draft.id)
    assert.equal(live.action, 'skipped-locked')
    assert.match(live.message, /锁/)
    assert.equal(readText(lockPath), liveLock)
    assert.equal(existsSync(scene.docPath), true)

    /** ② 进程状态查不出来：同样不强删。 */
    const unknown = recoverExpertInstallation({ ...context, lock: { isProcessAlive: () => undefined } }, scene.draft.id)
    assert.equal(unknown.action, 'skipped-locked')
    assert.equal(readText(lockPath), liveLock)
    assert.equal(existsSync(scene.docPath), true)

    /** ③ 别的主机留下的锁：本机既不能判断也不能删。 */
    const foreignLock = putLock({ pid: 4242, hostname: 'another-host' })
    const foreign = recoverExpertInstallation(context, scene.draft.id)
    assert.equal(foreign.action, 'skipped-locked')
    assert.equal(readText(lockPath), foreignLock)
    assert.equal(existsSync(scene.docPath), true)

    /** ④ 死 owner（同主机、进程确实没了）：回收死锁 → 真的把补偿做完。 */
    putLock({ pid: 4242, hostname: hostname() })
    const dead = recoverExpertInstallation({ ...context, lock: { isProcessAlive: () => false } }, scene.draft.id)
    assert.equal(dead.action, 'rolled-back')
    assert.equal(existsSync(scene.docPath), false)
    /** 回收后自己拿的那把锁要释放干净（不留死锁给下一轮）。 */
    assert.equal(existsSync(lockPath), false)
    assert.equal(readJson(journalPath(personasDir, scene.draft.id)).phase, 'rolled-back')
    const row = getExpertDraft(fixture.db, scene.draft.id)
    assert.equal(row.statusCode, 'pending')
    assert.equal(row.payload.phase, 'install-failed')
  })
})

// ---------------------------------------------------------------------------
// §D journal 组合：备份、双坏、owner 缺失/空/他库
// ---------------------------------------------------------------------------

test('AX-E22 主日志坏而备份完整：用备份继续（degraded），主日志坏了照样能补偿', () => {
  withFixture((fixture) => {
    const { context, personasDir, dbPath, libraryOptions } = fixture

    /** ① 一次真安装之后：主日志 = ready、备份 = 上一份（db-committed）。 */
    const built = buildValidated(context, { provenance: originalProvenance() })
    const installed = confirmExpertDraft(context, confirmInput(built))
    assert.equal(installed.ok, true, installed.ok === false ? installed.message : '')
    assert.equal(readJson(journalPath(personasDir, built.draft.id)).phase, 'ready')
    assert.equal(existsSync(previousJournalPath(personasDir, built.draft.id)), true)
    assert.equal(readJson(previousJournalPath(personasDir, built.draft.id)).phase, 'db-committed')

    /** 主日志被写坏 → 读的时候退到备份，并明确标出 degraded。 */
    writeText(journalPath(personasDir, built.draft.id), '{ 这不是 JSON')
    const read = readExpertInstallJournal(context, built.draft.id)
    assert.equal(read.ok, true)
    assert.equal(read.state.degraded, true)
    assert.equal(read.state.journal.phase, 'db-committed')
    /** 已确认且门已就绪 → 恢复只报 already-ready，不改任何文件。 */
    const before = snapshotTree(join(personasDir, 'generated'))
    const outcome = recoverExpertInstallation(context, built.draft.id)
    assert.equal(outcome.action, 'already-ready')
    assert.deepEqual(snapshotTree(join(personasDir, 'generated')), before)
    assert.equal(visible(libraryOptions, `generated/${UUID_A}`).listed, true)

    /** ② 备份**真的被用来做决策**：DB 未确认 + 文档已发布 + 主日志坏。 */
    const scene = handMadeScene(fixture, { uuid: UUID_B, sessionId: SESSION_B, ownerDbKey: sha256Hex(canonicalDatabasePath(dbPath)) })
    writeJson(previousJournalPath(personasDir, scene.draft.id), scene.journal)
    writeText(journalPath(personasDir, scene.draft.id), '也坏了：{"version":1,')
    const degraded = readExpertInstallJournal(context, scene.draft.id)
    assert.equal(degraded.ok, true)
    assert.equal(degraded.state.degraded, true)
    assert.equal(degraded.state.journal.phase, 'prepared')
    /** 用备份里的 createdPaths 把这次未提交的发布撤掉。 */
    const rolled = recoverExpertInstallation(context, scene.draft.id)
    assert.equal(rolled.action, 'rolled-back')
    assert.equal(existsSync(scene.docPath), false)
  })
})

test('AX-E22 两份日志都坏：报 repair-required 且一个文件都不动，其它草稿照常恢复', () => {
  withFixture((fixture) => {
    const { context, personasDir, dbPath } = fixture
    const scene = handMadeScene(fixture, { uuid: UUID_B, sessionId: SESSION_B, ownerDbKey: sha256Hex(canonicalDatabasePath(dbPath)) })
    writeText(journalPath(personasDir, scene.draft.id), '{ 坏了')
    writeText(previousJournalPath(personasDir, scene.draft.id), '{ 也坏了')

    const read = readExpertInstallJournal(context, scene.draft.id)
    assert.equal(read.ok, false)
    assert.equal(read.reason, 'corrupt')
    assert.equal(existsSync(scene.docPath), true)
    const before = snapshotTree(pendingPersonaDir(personasDir, scene.draft.id))

    const outcome = recoverExpertInstallation(context, scene.draft.id)
    assert.equal(outcome.action, 'repair-required')
    assert.deepEqual(outcome.phase, 'unknown')
    /** 判不出来就**什么都不做**：正式文件留着，日志也不重写。 */
    assert.equal(existsSync(scene.docPath), true)
    assert.deepEqual(snapshotTree(pendingPersonaDir(personasDir, scene.draft.id)), before)

    /** 同一轮扫描里混进一份健康安装：坏条目不得妨碍它（AX-E22 的"其余工作台正常"）。 */
    const healthy = buildValidated(context, { uuid: UUID_A, sessionId: SESSION_A, provenance: originalProvenance() })
    assert.equal(confirmExpertDraft(context, confirmInput(healthy)).ok, true)
    const scan = recoverExpertInstallations(context)
    assert.equal(scan.scanned, 2)
    assert.deepEqual(
      scan.outcomes.map((entry) => [entry.draftId, entry.action]).sort(),
      [[healthy.draft.id, 'already-ready'], [scene.draft.id, 'repair-required']].sort(),
    )
    assert.equal(visible({ userDir: personasDir, externalDir: '', builtinDir: fixture.builtinDir }, `generated/${UUID_A}`).listed, true)
  })
})

test('AX-E22 ownerDbKey 缺失 / 空串 / null / 属于别的 DB：一律只跳过、一个文件都不动', () => {
  withFixture((fixture) => {
    const { context, personasDir, dbPath } = fixture
    const ownKey = sha256Hex(canonicalDatabasePath(dbPath))
    const cases = [
      ['ownerDbKey 缺失（字段都没有）', undefined, 'skipped-owner-unknown'],
      ['ownerDbKey 是空串', '', 'skipped-owner-unknown'],
      ['ownerDbKey 不是字符串（null）', null, 'skipped-owner-unknown'],
      ['ownerDbKey 属于另一个 DB', 'f'.repeat(64), 'skipped-foreign-owner'],
    ]

    for (const [index, [label, ownerDbKey, expectedAction]] of cases.entries()) {
      /** 每个 case 一个独立草稿：同一个 session 再建草稿会**复用**上一份（install-failed 会串味）。 */
      const scene = handMadeScene(fixture, { sessionId: `${SESSION_A}-${index}`, ownerDbKey })
      writeJournalObject(fixture, scene.journal)
      const journalBefore = readText(journalPath(personasDir, scene.draft.id))

      const outcome = recoverExpertInstallation(context, scene.draft.id)
      assert.equal(outcome.action, expectedAction, `${label}：${outcome.message}`)
      /** 文件不动、日志不重写、DB 不动 —— 三条都要成立。 */
      assert.equal(existsSync(scene.docPath), true, label)
      assert.equal(readText(journalPath(personasDir, scene.draft.id)), journalBefore, label)
      const row = getExpertDraft(fixture.db, scene.draft.id)
      assert.equal(row.statusCode, 'pending', label)
      assert.equal(row.payload.phase, 'editing', label)
      /** 换个 owner 认领它就能正常补偿 —— 证明上面"跳过"不是因为它坏得没法处理。 */
      if (expectedAction === 'skipped-owner-unknown') {
        writeJournalObject(fixture, { ...scene.journal, ownerDbKey: ownKey })
        const claimed = recoverExpertInstallation(context, scene.draft.id)
        assert.equal(claimed.action, 'rolled-back', label)
        assert.equal(existsSync(scene.docPath), false, label)
      } else {
        rmSync(personaDocPath(personasDir, UUID_A), { force: true })
      }
    }
  })
})

test('恢复视角：日志被删但草稿停在 installing → 确认拒绝安装，恢复不猜', () => {
  withFixture((fixture) => {
    const { context, db, personasDir } = fixture
    const built = buildValidated(context, { provenance: originalProvenance() })
    /** 手工把草稿推到 installing（等价于"日志先写好、然后有人把日志删了"）。 */
    const moved = transitionExpertDraftInstall(db, built.draft.id, built.version, { phase: 'installing' }, AT)
    assert.equal(moved.payload.phase, 'installing')
    assert.equal(existsSync(journalPath(personasDir, built.draft.id)), false)

    /** 确认路径：判不出动过哪些文件，**绝不猜**，直接要求人工处理。 */
    const confirm = confirmExpertDraft(context, confirmInput(built))
    assert.equal(confirm.ok, false)
    assert.equal(confirm.code, 'install-repair-required')
    assert.match(confirm.message, /找不到安装日志/)
    assert.equal(getExpertDraft(db, built.draft.id).payload.phase, 'installing')
    assert.equal(existsSync(personaDocPath(personasDir, UUID_A)), false)

    /** 恢复路径：没有日志 = 没有要恢复的东西（它不会替这份草稿做决定）。 */
    const outcome = recoverExpertInstallation(context, built.draft.id)
    assert.equal(outcome.action, 'nothing-to-do')
    assert.equal(getExpertDraft(db, built.draft.id).payload.phase, 'installing')

    /** 只删主日志、留着备份时仍能读到（degraded），不会误判成"没有日志"。 */
    const healthy = buildValidated(context, { uuid: UUID_B, sessionId: SESSION_B, provenance: originalProvenance() })
    assert.equal(confirmExpertDraft(context, confirmInput(healthy)).ok, true)
    rmSync(journalPath(personasDir, healthy.draft.id))
    const fallback = readExpertInstallJournal(context, healthy.draft.id)
    assert.equal(fallback.ok, true)
    assert.equal(fallback.state.degraded, true)
    assert.equal(recoverExpertInstallation(context, healthy.draft.id).action, 'already-ready')
  })
})

// ---------------------------------------------------------------------------
// §E 两个独立 DB 共享同一对根：只动自己的文件，别人的人格跨 profile 仍可发现
// ---------------------------------------------------------------------------

/**
 * §6.3 要求 `ownerDbKey` 存在的**唯一理由**就是这条用例：两个 profile 共用
 * `personas/`、`skills/` 两个根，却各有各的 DB。A 库装好的东西在 B 库看来"没有草稿"
 * —— 如果按"本 DB 里没有这份 draft 就当未提交"去补偿，就会把 A 的正式安装拆掉。
 */
test('AX-E22 两个 DB 共享同一对根：B 库只补偿自己的草稿，A 库的受管人格跨 profile 仍可见', () => {
  withFixture((fixture) => {
    const { db, openDb, personasDir, skillsDir, roots, libraryOptions } = fixture
    const contextA = { db, roots, now: () => AT }

    /** A 库把一份专家装到 ready（同一对根上的第一份正式安装）。 */
    const builtA = buildValidated(contextA, { provenance: originalProvenance() })
    assert.equal(confirmExpertDraft(contextA, confirmInput(builtA)).ok, true)
    assert.equal(visible(libraryOptions, `generated/${UUID_A}`).listed, true)
    assert.equal(readJson(journalPath(personasDir, builtA.draft.id)).phase, 'ready')
    const generatedBefore = snapshotTree(join(personasDir, 'generated'))
    const skillsBefore = snapshotTree(skillsDir)

    /** B 库（另一个 dbPath）在同一对根上崩在 files-published：正式文件在、门还没立。 */
    const dbBPath = join(fixture.root, 'profile-b.db')
    const crash = crashInstall(fixture, {
      point: 'install.after-files-published-journal',
      uuid: UUID_B,
      sessionId: SESSION_B,
      dbPath: dbBPath,
      ownerDbKey: null,
    })
    assert.equal(readJson(journalPath(personasDir, crash.draftId)).phase, 'files-published')
    assert.equal(readJson(journalPath(personasDir, crash.draftId)).ownerDbKey, sha256Hex(canonicalDatabasePath(dbBPath)))
    assert.equal(existsSync(personaDocPath(personasDir, UUID_B)), true)
    /** 半成品还不是"人格"：`.md` 已落地但门还没立 → 跳过文档并给诊断，谁都不该发现它。 */
    assert.deepEqual(visible(libraryOptions, `generated/${UUID_B}`), { listed: false, resolved: false, incomplete: true })

    /** B 库新实例（新句柄 + 新 context）：它是**另一个 owner**，只看得到自己的草稿。 */
    const dbB = openDb('profile-b.db')
    const contextB = { db: dbB, roots, now: () => AT }
    assert.equal(getExpertDraft(dbB, crash.draftId).statusCode, 'pending')
    /** A 的草稿在 B 库里根本不存在 —— 这正是"不能按本 DB 状态去补偿别人日志"的现场。 */
    assert.equal(getExpertDraft(dbB, builtA.draft.id), undefined)

    const scan = recoverExpertInstallations(contextB)
    assert.equal(scan.scanned, 2)
    assert.deepEqual(
      scan.outcomes.map((entry) => [entry.draftId, entry.action]).sort(),
      [[crash.draftId, 'rolled-back'], [builtA.draft.id, 'skipped-foreign-owner']].sort(),
    )

    /** ① B 的补偿只撤自己的路径：A 的人格、A 的技能、A 的日志一个字节都没动。 */
    assert.deepEqual(snapshotTree(join(personasDir, 'generated')), generatedBefore)
    /**
     * skills 根上**只多出 B 自己的暂存目录**：`.build/` 构建件要清掉，
     * 但暂存原件必须留着（重试唯一可用的源），A 的任何东西都不许动。
     */
    const skillsAfter = snapshotTree(skillsDir)
    assert.deepEqual(
      skillsAfter.filter((line) => line.startsWith(`.pending/${crash.draftId}/`) === false),
      skillsBefore,
    )
    assert.equal(skillsAfter.some((line) => line.startsWith(`.pending/${crash.draftId}/`)), true)
    assert.equal(skillsAfter.some((line) => line.includes('/.build/')), false)
    assert.equal(readJson(journalPath(personasDir, builtA.draft.id)).phase, 'ready')
    /** ② A 的正式文件没有被当成"B 的未提交发布"删掉，跨 profile 仍然可发现、可解析。 */
    assert.deepEqual(visible(libraryOptions, `generated/${UUID_A}`), { listed: true, resolved: true, incomplete: false })
    /** ③ B 自己的半成品被撤干净，草稿落 install-failed，`generated/<B>` 整个目录也没留下。 */
    assert.equal(existsSync(personaDocPath(personasDir, UUID_B)), false)
    assert.equal(existsSync(personaDirPath(personasDir, UUID_B)), false)
    assert.equal(getExpertDraft(dbB, crash.draftId).payload.phase, 'install-failed')
    /** ④ A 库那边的草稿仍是 confirmed（B 的恢复碰不到 A 的 DB）。 */
    assert.equal(getExpertDraft(db, builtA.draft.id).statusCode, 'confirmed')
    assert.equal(confirmExpertDraft(contextA, confirmInput(builtA)).ok, true)

    /** ⑤ 再让 B 对自己**第二份**未确认安装做补偿：仍然不动 A（新草稿、新 uuid）。 */
    fixture.closeDb(dbB)
    const crashB2 = crashInstall(fixture, {
      point: 'install.after-persona-document',
      uuid: 'cccccccc-dddd-4eee-8fff-000000000000',
      sessionId: `${SESSION_B}-2`,
      dbPath: dbBPath,
      ownerDbKey: null,
    })
    const dbB2 = openDb('profile-b.db')
    const outcomeB2 = recoverExpertInstallation({ db: dbB2, roots, now: () => AT }, crashB2.draftId)
    assert.equal(outcomeB2.action, 'rolled-back')
    assert.equal(existsSync(personaDocPath(personasDir, 'cccccccc-dddd-4eee-8fff-000000000000')), false)
    assert.deepEqual(snapshotTree(join(personasDir, 'generated')), generatedBefore)
    assert.equal(visible(libraryOptions, `generated/${UUID_A}`).resolved, true)
    fixture.closeDb(dbB2)
  })
})




