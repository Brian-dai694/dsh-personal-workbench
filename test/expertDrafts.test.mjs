/**
 * 专家草稿的服务端逻辑（`src/experts/drafts.ts`）。
 *
 * 覆盖验收断言 AX-E07–E13。每条断言都落在**真实产物**上：磁盘上的真实字节、
 * DB 里真实那一行的 payload、函数真实返回值 —— 不出现"只断言调用了某个函数"的写法。
 *
 * ## 夹具
 *
 * 每个用例一个 `mkdtempSync` 临时目录：`personas/`、`skills/`、`outside/`（根外哨兵）
 * 与一个真实 SQLite 库；`roots` 由 `resolveExpertRoots({personasDir, skillsDir})` 注入，
 * **不走 homedir**，所以测试永远不会碰到用户真实的 `~/.dsh/workbench`。
 *
 * 会话身份是"注入的 fake session"：工具层拿的是 `exec.agent.session.id`，
 * 这里就是那个字符串；换一个字符串就等于换一个会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { ExpertRepoError, createExpertDraft, defaultExpertId, getExpertDraft } from '../lib/db/repo/experts.js'
import { normalizePersonaText, parsePersonaDocument } from '../lib/personas/parse.js'
import { resolveExpertRoots } from '../lib/experts/paths.js'
import { sha256Hex } from '../lib/experts/provenance.js'
import {
  EXPERT_NO_SESSION_MESSAGE,
  assertExpertDraftOwner,
  expertDraftView,
  readExpertStagedFile,
  removeExpertStagedFile,
  stageExpertFile,
  submitExpertDraft,
  validateExpertDraft,
} from '../lib/experts/drafts.js'
import {
  EXPERT_DRAFT_MAX_FILES,
  EXPERT_DRAFT_MAX_TOTAL_BYTES,
  EXPERT_STAGED_FILE_MAX_BYTES,
} from '../lib/shared/expert.js'

const SESSION_A = 'session-fake-aaaa-0001'
const SESSION_B = 'session-fake-bbbb-0002'
const UUID_A = '11111111-2222-4333-8444-555555555555'
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

/** 递归数一个目录下的普通文件（用来断言"没留下超限暂存文件"）。 */
function countFiles(dir) {
  if (existsSync(dir) === false) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name))
    else total += 1
  }
  return total
}

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wb-expert-drafts-'))
  const personasDir = join(root, 'personas')
  const skillsDir = join(root, 'skills')
  const outsideDir = join(root, 'outside')
  mkdirSync(personasDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  const sentinel = join(outsideDir, 'sentinel.txt')
  writeFileSync(sentinel, '根外哨兵：一个字节都不许变。\n', 'utf8')

  const db = openWorkbenchDb({ dbPath: join(root, 'workbench.db') })
  seedDictionaries(db)
  const roots = resolveExpertRoots({ personasDir, skillsDir })
  const context = { db, roots, now: () => AT }
  const safeToRemove = root.startsWith(tmpdir()) && root.includes('dsh-wb-expert-drafts-')
  try {
    run({ root, db, roots, context, personasDir, skillsDir, sentinel, outsideDir })
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
// 夹具构造
// ---------------------------------------------------------------------------

const BODY = '## 身份与职责\n你负责审查需求，指出缺失条件与无法验收的表述。\n'

/** §5.3 模板（`group: 工程` 必须能被现有 parser 解析出来）。 */
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

/** 真实草稿行（注意：`createExpertDraft` 返回的是 `{draft,payload,reused}`）。 */
function newDraft(context, overrides = {}) {
  return createExpertDraft(context.db, {
    sessionId: SESSION_A,
    request: '做一个需求审查专家',
    expertId: defaultExpertId(UUID_A),
    ...overrides,
  }).draft
}

function submitValid(context, draft, extras = {}) {
  return submitExpertDraft(context, {
    draftId: draft.id,
    sessionId: SESSION_A,
    expectedVersion: 0,
    personaMd: personaDoc(),
    provenanceJson: provenanceObj(),
    skillsJson: [],
    ...extras,
  })
}

/** 索引里的暂存路径（真实落盘位置，用来直接读字节）。 */
function personaStagedPath(personasDir, draftId, path) {
  return join(personasDir, '.pending', draftId, 'files', path)
}

// ---------------------------------------------------------------------------
// AX-E07：正文 20000 / 20001 UTF-16 单元
// ---------------------------------------------------------------------------

test('AX-E07 正文 20000 个 UTF-16 单元通过、20001 报 oversized-body（与现有 parser 计数一致）', () => {
  withFixture(({ context, db }) => {
    const atLimit = personaDoc('x'.repeat(20000))
    /** 先问**现有 parser**：它认为正文多长（专家侧不许自己另算一套）。 */
    const parsedAtLimit = parsePersonaDocument(normalizePersonaText(atLimit))
    assert.equal(parsedAtLimit.ok, true)
    assert.equal(parsedAtLimit.document.body.length, 20000)

    const draft = newDraft(context)
    const okResult = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: atLimit,
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(okResult.ok, true, okResult.ok === false ? okResult.message : '')
    assert.equal(getExpertDraft(db, draft.id).payload.personaMd.includes('x'.repeat(20000)), true)

    const overResult = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: okResult.contentVersion,
      personaMd: personaDoc('x'.repeat(20001)),
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(overResult.ok, false)
    assert.equal(overResult.code, 'oversized-body')
    assert.equal(overResult.field, 'personaMd')
    assert.match(overResult.message, /20001/)
  })
})

test('AX-E07 CRLF / BOM / emoji 都按归一化后的 UTF-16 单元计数', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    const body = 'x'.repeat(20000)

    /** CRLF：归一后长度不变，必须通过。 */
    const crlf = personaDoc(body).replace(/\n/g, '\r\n')
    assert.equal(parsePersonaDocument(normalizePersonaText(crlf)).document.body.length, 20000)
    const crlfResult = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: crlf,
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(crlfResult.ok, true, crlfResult.ok === false ? crlfResult.message : '')

    /** BOM：去掉后仍应通过，且**存下来的**是没有 BOM 的归一化文本。 */
    const bomResult = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: crlfResult.contentVersion,
      personaMd: `\uFEFF${personaDoc(body)}`,
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(bomResult.ok, true, bomResult.ok === false ? bomResult.message : '')
    const stored = getExpertDraft(context.db, draft.id).payload.personaMd
    assert.equal(stored.startsWith('\uFEFF'), false)
    assert.equal(stored.includes('\r'), false)

    /** emoji：9999 个 emoji（19998 单元）+ 2 个字符 = 20000 单元，字节远大于 20000，仍须通过。 */
    const emojiBody = `${'😀'.repeat(9999)}xx`
    assert.equal(parsePersonaDocument(normalizePersonaText(personaDoc(emojiBody))).document.body.length, 20000)
    assert.equal(Buffer.byteLength(emojiBody, 'utf8') > 20000, true, '字节数必须与字符数不同，才能证明判的是 UTF-16 单元')
    const emojiOk = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: bomResult.contentVersion,
      personaMd: personaDoc(emojiBody),
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(emojiOk.ok, true, emojiOk.ok === false ? emojiOk.message : '')

    const emojiOver = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: emojiOk.contentVersion,
      personaMd: personaDoc(`${'😀'.repeat(9999)}xxx`),
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(emojiOver.ok, false)
    assert.equal(emojiOver.code, 'oversized-body')
  })
})

// ---------------------------------------------------------------------------
// AX-E08：坏输入当场拒绝，旧草稿逐字不损坏，且不放宽 parser
// ---------------------------------------------------------------------------

test('AX-E08 白名单外 frontmatter / 空正文 / 超长名称：提交失败且旧草稿不损坏', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const first = submitValid(context, draft)
    assert.equal(first.ok, true, first.ok === false ? first.message : '')
    const before = getExpertDraft(db, draft.id)
    const beforeMd = before.payload.personaMd

    const badCases = [
      {
        label: '白名单外 frontmatter',
        text: personaDoc().replace('group: 工程', 'group: 工程\nsecret: 不该被接受'),
        code: 'unsupported-frontmatter',
      },
      { label: '空正文', text: personaDoc().replace(BODY, '   \n  '), code: 'empty-body' },
      { label: '超长名称', text: personaDoc().replace('# 需求审查专家', `# ${'名'.repeat(41)}`), code: 'invalid-title' },
    ]

    for (const bad of badCases) {
      /** ① 现有 parser 本身就必须拒绝（"不会放宽 parser"的根据）。 */
      const direct = parsePersonaDocument(normalizePersonaText(bad.text))
      assert.equal(direct.ok, false, `${bad.label}：现有 parser 必须仍然拒绝`)
      assert.equal(direct.diagnostics.some((entry) => entry.code === bad.code), true, `${bad.label}：期望 ${bad.code}`)

      /** ② 工具层当场失败，错误码就是 parser 的原 code。 */
      const result = submitExpertDraft(context, {
        draftId: draft.id,
        sessionId: SESSION_A,
        expectedVersion: first.contentVersion,
        personaMd: bad.text,
        provenanceJson: provenanceObj(),
        skillsJson: [],
      })
      assert.equal(result.ok, false, `${bad.label}：必须失败`)
      assert.equal(result.code, bad.code, `${bad.label}：错误码`)
      assert.equal(result.field, 'personaMd')

      /** ③ DB 那一行**逐字没变**。 */
      const after = getExpertDraft(db, draft.id)
      assert.equal(after.payload.contentVersion, before.payload.contentVersion)
      assert.equal(after.payload.personaMd, beforeMd)
      assert.equal(after.updatedAt, before.updatedAt)
    }
  })
})

test('AX-E08 非法 JSON 与非法 skills 结构都拒绝，且 DB 不变', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const first = submitValid(context, draft)
    assert.equal(first.ok, true)
    const version = first.contentVersion
    const before = getExpertDraft(db, draft.id)

    const badJson = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: version,
      personaMd: personaDoc(),
      provenanceJson: '{不是 JSON',
      skillsJson: [],
    })
    assert.equal(badJson.ok, false)
    assert.equal(badJson.code, 'invalid-json')
    assert.equal(badJson.field, 'provenance_json')

    const badSkills = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: version,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [{ name: 'demo-skill', required: 'yes', action: 'install', sourceId: 'demo', packageFiles: ['SKILL.md'], reason: 'x' }],
    })
    assert.equal(badSkills.ok, false)
    assert.equal(badSkills.code, 'invalid-payload')

    const after = getExpertDraft(db, draft.id)
    assert.equal(after.payload.contentVersion, before.payload.contentVersion)
    assert.equal(JSON.stringify(after.payload), JSON.stringify(before.payload))
  })
})

// ---------------------------------------------------------------------------
// AX-E09：来源与许可
// ---------------------------------------------------------------------------

test('AX-E09 translated 无 sources / merged 单来源：提交失败', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const translatedNoSource = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj({ sources: [] }),
      skillsJson: [],
    })
    assert.equal(translatedNoSource.ok, false)
    assert.equal(translatedNoSource.code, 'source-invalid')
    assert.match(translatedNoSource.message, /至少需要 1 个/)

    const mergedOne = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj({ creationKind: 'merged' }),
      skillsJson: [],
    })
    assert.equal(mergedOne.ok, false)
    assert.equal(mergedOne.code, 'source-invalid')
    assert.match(mergedOne.message, /至少需要 2 个/)

    assert.equal(getExpertDraft(db, draft.id).payload.provenance, null)
  })
})

test('AX-E09 MIT 缺版权声明或缺许可全文：校验失败（只做结构校验，不宣称已核实）', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const submitted = submitValid(context, draft)
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')

    /** 许可文本里没有登记的原版权声明。 */
    const licenseWithoutCopyright = MIT_TEXT.replace(COPYRIGHT, 'Copyright (c) 1999 Someone Else')
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: licenseWithoutCopyright,
    })
    assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')
    const validateStage1 = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: staged.contentVersion,
      sessionId: SESSION_A,
    })
    assert.equal(validateStage1.ok, true)
    assert.equal(
      validateStage1.validation.errors.some((entry) => entry.code === 'source-license-unsupported'),
      true,
      '找不到原版权声明必须报 source-license-unsupported',
    )
    assert.equal(validateStage1.phase, 'editing')
    assert.equal(validateStage1.validation.errors.length > 0, true)

    /** 许可文本缺 MIT 授权段落（只有"本项目采用 MIT"这种口头描述）。 */
    const reStaged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: staged.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: `MIT License\n\n${COPYRIGHT}\n\n本项目采用 MIT 许可。\n`,
    })
    assert.equal(reStaged.ok, true)
    const validateStage2 = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: reStaged.contentVersion,
      sessionId: SESSION_A,
    })
    assert.equal(validateStage2.ok, true)
    assert.equal(validateStage2.validation.errors.some((entry) => entry.code === 'source-license-unsupported'), true)
    assert.equal(validateStage2.phase, 'editing')

    /** 结构合格（含原版权与 MIT 条款）就通过：这里判的是**结构**，不是"法律真实性认证"。 */
    const good = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: reStaged.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(good.ok, true)
    const validateGood = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: good.contentVersion,
      sessionId: SESSION_A,
    })
    assert.deepEqual(validateGood.validation.errors, [])
    assert.equal(validateGood.phase, 'validated')
    const allMessages = [
      ...validateGood.validation.errors.map((entry) => entry.message),
      ...validateGood.validation.warnings.map((entry) => entry.message),
    ].join('\n')
    assert.equal(/已核实|真实性认证通过|保证合法/.test(allMessages), false, '不得出现"已核实许可"的表述')

    /** 没有登记来源时也不能偷偷放过。 */
    assert.equal(getExpertDraft(db, draft.id).payload.files.length, 1)
  })
})

test('AX-E09 commit 缺失是警告不是错误', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    const submitted = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj({ sources: [sourceObj({ commit: null })] }),
      skillsJson: [],
    })
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')
    assert.equal(submitted.warnings.some((entry) => entry.code === 'source-commit-unknown'), true)

    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(staged.ok, true)
    const result = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: staged.contentVersion,
      sessionId: SESSION_A,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.validation.errors, [])
    assert.equal(result.validation.warnings.some((entry) => entry.code === 'source-commit-unknown'), true)
    assert.equal(result.phase, 'validated')

    /** 把 main 当 commit 写是**错误**（不许伪造）。 */
    const forged = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: staged.contentVersion,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj({ sources: [sourceObj({ commit: 'main' })] }),
      skillsJson: [],
    })
    assert.equal(forged.ok, false)
    assert.equal(forged.code, 'source-invalid')
  })
})

// ---------------------------------------------------------------------------
// AX-E10：许可文本逐字保存
// ---------------------------------------------------------------------------

test('AX-E10 含 CRLF 与原版权的许可文本：磁盘字节与输入完全一致（不翻译、不压缩）', () => {
  withFixture(({ context, personasDir, db }) => {
    const draft = newDraft(context)
    const submitted = submitValid(context, draft)
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')

    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')

    const onDisk = join(personasDir, '.pending', draft.id, 'files', 'sources', 'demo', 'LICENSE.txt')
    const bytes = readFileSync(onDisk)
    assert.deepEqual(bytes, Buffer.from(MIT_TEXT, 'utf8'), '磁盘字节必须与输入逐字节一致')
    assert.equal(bytes.includes(Buffer.from('\r\n')), true, 'CRLF 必须原样保留（不许被归一化）')
    assert.equal(bytes.toString('utf8').includes(COPYRIGHT), true)
    assert.equal(sha256Hex(bytes), sha256Hex(MIT_TEXT))

    /** 索引里的 sha256/bytes 也与真实磁盘一致。 */
    const payload = getExpertDraft(db, draft.id).payload
    assert.deepEqual(payload.files, [{
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
    }])

    const read = readExpertStagedFile(context, { draftId: draft.id, area: 'persona-resource', path: 'sources/demo/LICENSE.txt' })
    assert.equal(read.text, MIT_TEXT)
    assert.equal(read.bytes, bytes.length)
    assert.equal(read.archivedOnly, false)
  })
})

// ---------------------------------------------------------------------------
// AX-E11：owner 守卫
// ---------------------------------------------------------------------------

test('AX-E11 他会话 / 空 session / 伪造参数 session 一律拒绝，且不能改另一份草稿', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const before = getExpertDraft(db, draft.id)

    const foreign = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_B,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(foreign.ok, false)
    assert.equal(foreign.code, 'draft-owner-mismatch')

    const noSession = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: '',
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(noSession.ok, false)
    assert.equal(noSession.code, 'draft-owner-mismatch')
    assert.equal(noSession.message, EXPERT_NO_SESSION_MESSAGE)

    const undefinedSession = removeExpertStagedFile(context, {
      draftId: draft.id,
      sessionId: undefined,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
    })
    assert.equal(undefinedSession.ok, false)
    assert.equal(undefinedSession.code, 'draft-owner-mismatch')

    /** 守卫本身也抛（供工具层复用）：错误里有稳定 code。 */
    assert.throws(
      () => assertExpertDraftOwner(context, { draftId: draft.id, sessionId: SESSION_B }),
      (error) => error instanceof ExpertRepoError && error.code === 'draft-owner-mismatch',
    )
    assert.throws(
      () => assertExpertDraftOwner(context, { draftId: draft.id, sessionId: '' }),
      (error) => error instanceof ExpertRepoError && error.code === 'draft-owner-mismatch',
    )

    /** 另一个会话的草稿：本会话不能改它。 */
    const otherDraft = createExpertDraft(context.db, {
      sessionId: SESSION_B,
      request: '另一个会话的需求',
      expertId: defaultExpertId('99999999-8888-4777-8666-555555555555'),
    })
    const crossWrite = submitExpertDraft(context, {
      draftId: otherDraft.draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(crossWrite.ok, false)
    assert.equal(crossWrite.code, 'draft-owner-mismatch')
    assert.equal(getExpertDraft(db, otherDraft.draft.id).payload.personaMd, '')

    /** 被拒之后，本会话那份草稿一个字段都没变。 */
    const after = getExpertDraft(db, draft.id)
    assert.equal(JSON.stringify(after.payload), JSON.stringify(before.payload))
    assert.equal(countFiles(join(context.roots.personasDir, '.pending')), 0)
  })
})

test('AX-E11 没有真实会话上下文的草稿（session_id 为空）不能被任何会话操作', () => {
  withFixture(({ context }) => {
    const orphan = createExpertDraft(context.db, {
      sessionId: null,
      request: '无会话兜底草稿',
      expertId: defaultExpertId('77777777-6666-4555-8444-333333333333'),
    })
    const result = stageExpertFile(context, {
      draftId: orphan.draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'resources/a.md',
      contentUtf8: '内容',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'draft-owner-mismatch')
  })
})

test('AX-E11 草稿 id 不是 UUID / 状态非 pending / payload 版本未知都被守卫挡住', () => {
  withFixture(({ context, db }) => {
    const payload = {
      version: 1,
      contentVersion: 0,
      expertId: defaultExpertId(UUID_A),
      request: '手写的草稿',
      phase: 'editing',
      personaMd: '',
      provenance: null,
      skills: [],
      files: [],
      validation: null,
      lastInstallError: null,
    }
    const insert = (id, status, body) => {
      db.prepare(
        `INSERT INTO task_drafts (id, kind_code, session_id, payload_json, status_code, created_at, updated_at)
         VALUES (?, 'expert', ?, ?, ?, ?, ?)`,
      ).run(id, SESSION_A, JSON.stringify(body), status, AT, AT)
    }

    insert('not-a-uuid', 'pending', payload)
    assert.throws(
      () => assertExpertDraftOwner(context, { draftId: 'not-a-uuid', sessionId: SESSION_A }),
      (error) => error instanceof ExpertRepoError && error.code === 'invalid-payload',
    )

    const confirmedId = '22222222-3333-4444-8555-666666666666'
    insert(confirmedId, 'confirmed', payload)
    assert.throws(
      () => assertExpertDraftOwner(context, { draftId: confirmedId, sessionId: SESSION_A }),
      (error) => error instanceof ExpertRepoError && error.code === 'draft-not-pending',
    )

    const futureId = '33333333-4444-4555-8666-777777777777'
    insert(futureId, 'pending', { ...payload, version: 2 })
    assert.throws(
      () => assertExpertDraftOwner(context, { draftId: futureId, sessionId: SESSION_A }),
      (error) => error instanceof ExpertRepoError && error.code === 'unknown-schema-version',
    )

    const installingId = '44444444-5555-4666-8777-888888888888'
    insert(installingId, 'pending', { ...payload, phase: 'installing' })
    const installing = stageExpertFile(context, {
      draftId: installingId,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'resources/a.md',
      contentUtf8: '内容',
    })
    assert.equal(installing.ok, false)
    assert.equal(installing.code, 'install-in-progress')

    const unknown = stageExpertFile(context, {
      draftId: '55555555-6666-4777-8888-999999999999',
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'resources/a.md',
      contentUtf8: '内容',
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'draft-not-found')
  })
})

// ---------------------------------------------------------------------------
// AX-E12：配额
// ---------------------------------------------------------------------------

test('AX-E12 单件超 128 KiB：报 file-too-large，且磁盘与索引都不留痕', () => {
  withFixture(({ context, personasDir, db }) => {
    const draft = newDraft(context)
    const result = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'sources/demo/original.md',
      contentUtf8: 'x'.repeat(EXPERT_STAGED_FILE_MAX_BYTES + 1),
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'file-too-large')
    assert.equal(getExpertDraft(db, draft.id).payload.files.length, 0)
    assert.equal(countFiles(join(personasDir, '.pending')), 0, '被拒的暂存不许留下文件')
  })
})

test('AX-E12 总量超过 1 MiB：报 package-too-large，且不写入第 9 个文件', () => {
  withFixture(({ context, personasDir, db }) => {
    const draft = newDraft(context)
    let version = 0
    const chunk = 'x'.repeat(EXPERT_STAGED_FILE_MAX_BYTES)
    for (let index = 0; index < 8; index += 1) {
      const staged = stageExpertFile(context, {
        draftId: draft.id,
        sessionId: SESSION_A,
        expectedVersion: version,
        area: 'persona-resource',
        path: `resources/big-${index}.md`,
        contentUtf8: chunk,
      })
      assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')
      version = staged.contentVersion
    }
    assert.equal(getExpertDraft(db, draft.id).payload.files.reduce((sum, file) => sum + file.bytes, 0), EXPERT_DRAFT_MAX_TOTAL_BYTES)

    const overflow = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: version,
      area: 'persona-resource',
      path: 'resources/big-8.md',
      contentUtf8: chunk,
    })
    assert.equal(overflow.ok, false)
    assert.equal(overflow.code, 'package-too-large')
    assert.equal(existsSync(join(personasDir, '.pending', draft.id, 'files', 'resources', 'big-8.md')), false)
    assert.equal(getExpertDraft(db, draft.id).payload.files.length, 8)
  })
})

test('AX-E12 文件数超过 64：报 file-count-limit，索引保持 64 条', () => {
  withFixture(({ context, personasDir, db }) => {
    const draft = newDraft(context)
    let version = 0
    for (let index = 0; index < EXPERT_DRAFT_MAX_FILES; index += 1) {
      const staged = stageExpertFile(context, {
        draftId: draft.id,
        sessionId: SESSION_A,
        expectedVersion: version,
        area: 'persona-resource',
        path: `resources/f${String(index).padStart(3, '0')}.md`,
        contentUtf8: `第 ${index} 份`,
      })
      assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')
      version = staged.contentVersion
    }
    const overflow = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: version,
      area: 'persona-resource',
      path: 'resources/overflow.md',
      contentUtf8: '再来一份',
    })
    assert.equal(overflow.ok, false)
    assert.equal(overflow.code, 'file-count-limit')
    assert.equal(getExpertDraft(db, draft.id).payload.files.length, EXPERT_DRAFT_MAX_FILES)
    assert.equal(countFiles(join(personasDir, '.pending', draft.id, 'files')), EXPERT_DRAFT_MAX_FILES)
  })
})

test('AX-E12 skill 需求条数 / install 数 / reuse 数越界都报 file-count-limit', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    const installRequirement = (index) => ({
      name: `skill-${index}`,
      required: false,
      action: 'install',
      sourceId: 'demo',
      packageFiles: ['SKILL.md', 'sources/demo/LICENSE.txt'],
      reason: '需要它的方法论',
    })
    const reuseRequirement = (index) => ({
      name: `reuse-${index}`,
      required: false,
      action: 'reuse',
      sourceId: null,
      packageFiles: [],
      reason: '已有技能',
    })

    const tooManyRequirements = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: Array.from({ length: 25 }, (_, index) => reuseRequirement(index)),
    })
    assert.equal(tooManyRequirements.ok, false)
    assert.equal(tooManyRequirements.code, 'file-count-limit')

    const tooManyInstalls = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: Array.from({ length: 9 }, (_, index) => installRequirement(index)),
    })
    assert.equal(tooManyInstalls.ok, false)
    assert.equal(tooManyInstalls.code, 'file-count-limit')
    assert.match(tooManyInstalls.message, /install/)

    const tooManyReuses = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: Array.from({ length: 17 }, (_, index) => reuseRequirement(index)),
    })
    assert.equal(tooManyReuses.ok, false)
    assert.equal(tooManyReuses.code, 'file-count-limit')
    assert.match(tooManyReuses.message, /reuse/)

    /** 越界提交不能留下半截技能清单。 */
    assert.deepEqual(getExpertDraft(context.db, draft.id).payload.skills, [])
  })
})

// ---------------------------------------------------------------------------
// AX-E13：validate → stage → version 增 / validation 清空
// ---------------------------------------------------------------------------

test('AX-E13 validate 之后改一件文件：version 增、validation 清空、旧 manifestHash 失效', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const submitted = submitValid(context, draft)
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(staged.ok, true)

    const validated = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: staged.contentVersion,
      sessionId: SESSION_A,
    })
    assert.equal(validated.ok, true)
    assert.deepEqual(validated.validation.errors, [])
    assert.equal(validated.phase, 'validated')
    const oldHash = validated.manifestHash

    /** 同内容重提交：版本不变、validation 保留（"改一件"才算改）。 */
    const sameContent = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: validated.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(sameContent.ok, true)
    assert.equal(sameContent.changed, false)
    assert.equal(sameContent.contentVersion, validated.contentVersion)
    assert.notEqual(getExpertDraft(db, draft.id).payload.validation, null, '同内容重提交不该把用户看过的校验清掉')

    /** 真改一件：版本 +1、validation 清空、phase 回 editing。 */
    const changed = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: sameContent.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: `${MIT_TEXT}\n附注：仅排版变化。\n`,
    })
    assert.equal(changed.ok, true)
    assert.equal(changed.changed, true)
    assert.equal(changed.contentVersion, sameContent.contentVersion + 1)
    assert.equal(changed.phase, 'editing')

    const afterChange = getExpertDraft(db, draft.id).payload
    assert.equal(afterChange.validation, null)
    assert.equal(afterChange.phase, 'editing')

    /** 重新校验后 manifestHash 必须与旧的不同：旧 hash 已经无法确认。 */
    const revalidated = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: afterChange.contentVersion,
      sessionId: SESSION_A,
    })
    assert.equal(revalidated.ok, true)
    assert.notEqual(revalidated.manifestHash, oldHash)
    assert.equal(revalidated.validation.version, afterChange.contentVersion)
    assert.equal(expertDraftView(getExpertDraft(db, draft.id)).validation.manifestHash, revalidated.manifestHash)
  })
})

test('AX-E13 内容变更会作废旧校验（submit 改人格同样清 validation）', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const submitted = submitValid(context, draft)
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    const validated = validateExpertDraft(context, { draftId: draft.id, expectedVersion: staged.contentVersion, sessionId: SESSION_A })
    assert.equal(validated.phase, 'validated')

    const resubmit = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: validated.contentVersion,
      personaMd: personaDoc(`${BODY}\n补充：先列出所有缺失输入。\n`),
      provenanceJson: provenanceObj(),
      skillsJson: [],
    })
    assert.equal(resubmit.ok, true)
    assert.equal(resubmit.changed, true)
    assert.equal(resubmit.contentVersion, validated.contentVersion + 1)
    const payload = getExpertDraft(db, draft.id).payload
    assert.equal(payload.validation, null)
    assert.equal(payload.phase, 'editing')
  })
})

// ---------------------------------------------------------------------------
// 施工步骤 4/5：写入↔CAS 之间的中断
// ---------------------------------------------------------------------------

test('步骤 5 文件被改成另一内容：读与校验都报 staged-file-changed，且不自动确认', () => {
  withFixture(({ context, personasDir, db }) => {
    const draft = newDraft(context)
    const submitted = submitValid(context, draft)
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(staged.ok, true)

    /** 模拟"文件已换、DB 索引没跟上"（进程在 rename 与 CAS 之间被杀，或第三方改了文件）。 */
    const onDisk = join(personasDir, '.pending', draft.id, 'files', 'sources', 'demo', 'LICENSE.txt')
    writeFileSync(onDisk, '第三方换掉的内容\n', 'utf8')

    const read = readExpertStagedFile(context, { draftId: draft.id, area: 'persona-resource', path: 'sources/demo/LICENSE.txt' })
    assert.equal(read.ok, false)
    assert.equal(read.code, 'staged-file-changed')

    const validated = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: staged.contentVersion,
      sessionId: SESSION_A,
    })
    assert.equal(validated.ok, true, '结构上仍能给出校验结论')
    assert.equal(validated.validation.errors.some((entry) => entry.code === 'staged-file-changed'), true)
    assert.equal(validated.phase, 'editing', '不一致时绝不自动确认')
    assert.equal(String(validated.validation.manifestHash).length, 64)

    /** owner 按当前 DB 版本重新 stage 同一路径即可恢复一致。 */
    const recover = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: staged.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(recover.ok, true)
    const reread = readExpertStagedFile(context, { draftId: draft.id, area: 'persona-resource', path: 'sources/demo/LICENSE.txt' })
    assert.equal(reread.text, MIT_TEXT)
    assert.equal(sha256Hex(readFileSync(onDisk)), sha256Hex(MIT_TEXT))

    const revalidated = validateExpertDraft(context, {
      draftId: draft.id,
      expectedVersion: recover.contentVersion,
      sessionId: SESSION_A,
    })
    assert.deepEqual(revalidated.validation.errors, [])
    assert.equal(revalidated.phase, 'validated')
    assert.equal(getExpertDraft(db, draft.id).payload.contentVersion, recover.contentVersion)
  })
})

test('步骤 4 CAS 失败时：只在磁盘仍是本次新哈希时回滚，第三方改动绝不覆盖', () => {
  withFixture(({ context, personasDir, db }) => {
    const draft = newDraft(context)
    const submitted = submitValid(context, draft)

    /** 先放一份"旧内容"进去，才能验证"保留本次临时备份并恢复旧文件"。 */
    const seeded = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: '旧版本许可文本\n',
    })
    assert.equal(seeded.ok, true)
    const onDisk = join(personasDir, '.pending', draft.id, 'files', 'sources', 'demo', 'LICENSE.txt')
    assert.equal(readFileSync(onDisk, 'utf8'), '旧版本许可文本\n')

    /** ① CAS 冲突（failpoint 抛仓储错误）：回滚到旧字节，索引不变。 */
    const conflicting = {
      ...context,
      failpoint: (point) => {
        if (point === 'stage.before-cas') throw new ExpertRepoError('draft-version-conflict', '模拟并发 CAS 冲突')
      },
    }
    const failed = stageExpertFile(conflicting, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: seeded.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: '新版本许可文本\n',
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.code, 'draft-version-conflict')
    assert.equal(readFileSync(onDisk, 'utf8'), '旧版本许可文本\n', 'CAS 失败必须恢复写入前的字节')
    const payloadAfter = getExpertDraft(db, draft.id).payload
    assert.equal(payloadAfter.contentVersion, seeded.contentVersion)
    assert.equal(payloadAfter.files[0].sha256, sha256Hex('旧版本许可文本\n'))

    /** ② 目标已被第三方改成别的内容：**不覆盖**，第三方字节原样留下。 */
    const thirdParty = {
      ...context,
      failpoint: (point) => {
        if (point === 'stage.before-cas') {
          writeFileSync(onDisk, '第三方写进来的内容\n', 'utf8')
          throw new ExpertRepoError('draft-version-conflict', '模拟并发 CAS 冲突')
        }
      },
    }
    const refused = stageExpertFile(thirdParty, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: seeded.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: '本次想写的内容\n',
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'draft-version-conflict')
    assert.equal(readFileSync(onDisk, 'utf8'), '第三方写进来的内容\n', '第三方改动绝不能被回滚覆盖')

    /** ③ 新文件（此前不存在）在 CAS 失败时被删掉，不留孤儿。 */
    const orphan = {
      ...context,
      failpoint: (point) => {
        if (point === 'stage.before-cas') throw new ExpertRepoError('draft-version-conflict', '模拟并发 CAS 冲突')
      },
    }
    const fresh = stageExpertFile(orphan, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: seeded.contentVersion,
      area: 'persona-resource',
      path: 'resources/checklist.md',
      contentUtf8: '检查项\n',
    })
    assert.equal(fresh.ok, false)
    assert.equal(existsSync(join(personasDir, '.pending', draft.id, 'files', 'resources', 'checklist.md')), false)
  })
})

test('同一草稿的进程内互斥：重入被拒（install-in-progress）', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    const reentrant = {
      ...context,
      failpoint: (point) => {
        if (point === 'stage.after-file-write') {
          const inner = stageExpertFile(context, {
            draftId: draft.id,
            sessionId: SESSION_A,
            expectedVersion: 0,
            area: 'persona-resource',
            path: 'resources/inner.md',
            contentUtf8: '重入',
          })
          assert.equal(inner.ok, false)
          assert.equal(inner.code, 'install-in-progress')
        }
      },
    }
    const result = stageExpertFile(reentrant, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'resources/outer.md',
      contentUtf8: '外层',
    })
    assert.equal(result.ok, true)
  })
})

// ---------------------------------------------------------------------------
// stage / remove / read 的路径安全
// ---------------------------------------------------------------------------

test('stage 只接受形状合法的相对路径，绝不接受绝对路径或穿越', () => {
  withFixture(({ context, sentinel, outsideDir, db }) => {
    const draft = newDraft(context)
    const cases = [
      '../escape.md',
      'resources/../../escape.md',
      '/absolute.md',
      'C:/windows.md',
      'resources\\win.md',
      'resources/a%2e%2e.md',
      'resources/con.md',
      'resources/tail.md.',
      'resources/no-extension',
      'workbench-install.json',
      'sources/demo/workbench-install.json',
    ]
    for (const path of cases) {
      const result = stageExpertFile(context, {
        draftId: draft.id,
        sessionId: SESSION_A,
        expectedVersion: 0,
        area: 'persona-resource',
        path,
        contentUtf8: '内容',
      })
      assert.equal(result.ok, false, `${path} 必须被拒`)
      assert.equal(result.code, 'invalid-path', `${path} 的错误码`)
    }

    const badArea = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona',
      path: 'resources/a.md',
      contentUtf8: '内容',
    })
    assert.equal(badArea.ok, false)
    assert.equal(badArea.code, 'invalid-payload')

    const badContent = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'resources/a.md',
      contentUtf8: 42,
    })
    assert.equal(badContent.ok, false)
    assert.equal(badContent.code, 'invalid-payload')

    assert.equal(getExpertDraft(db, draft.id).payload.files.length, 0)
    assert.equal(readFileSync(sentinel, 'utf8'), '根外哨兵：一个字节都不许变。\n')
    assert.deepEqual(readdirSync(outsideDir), ['sentinel.txt'])
  })
})

test('remove 只删索引里属于本草稿的文件；不在索引里就是 changed:false 且不动磁盘', () => {
  withFixture(({ context, personasDir, sentinel, db }) => {
    const draft = newDraft(context)
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(staged.ok, true)
    const onDisk = join(personasDir, '.pending', draft.id, 'files', 'sources', 'demo', 'LICENSE.txt')
    assert.equal(existsSync(onDisk), true)

    /** 不在索引里（哪怕形状合法）→ changed:false，一个文件都不删。 */
    const notIndexed = removeExpertStagedFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: staged.contentVersion,
      area: 'persona-resource',
      path: 'resources/missing.md',
    })
    assert.equal(notIndexed.ok, true)
    assert.equal(notIndexed.changed, false)
    assert.equal(notIndexed.contentVersion, staged.contentVersion)
    assert.equal(existsSync(onDisk), true)

    /** 形状非法（穿越）→ 直接 invalid-path，绝不拿它去算目录。 */
    const traversal = removeExpertStagedFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: staged.contentVersion,
      area: 'persona-resource',
      path: '../../outside/sentinel.txt',
    })
    assert.equal(traversal.ok, false)
    assert.equal(traversal.code, 'invalid-path')
    assert.equal(readFileSync(sentinel, 'utf8'), '根外哨兵：一个字节都不许变。\n')

    /** 删索引里的那一条：磁盘文件消失、索引少一条、版本 +1。 */
    const removed = removeExpertStagedFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: staged.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
    })
    assert.equal(removed.ok, true)
    assert.equal(removed.changed, true)
    assert.equal(removed.contentVersion, staged.contentVersion + 1)
    assert.equal(existsSync(onDisk), false)
    assert.deepEqual(getExpertDraft(db, draft.id).payload.files, [])

    /** 再删一次是幂等的 changed:false。 */
    const again = removeExpertStagedFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: removed.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
    })
    assert.equal(again.ok, true)
    assert.equal(again.changed, false)
  })
})

test('read 只能读本草稿索引里的文件（别的路径返回 invalid-path）', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      area: 'persona-resource',
      path: 'resources/notes.md',
      contentUtf8: '笔记内容\n',
    })
    assert.equal(staged.ok, true)

    const hit = readExpertStagedFile(context, { draftId: draft.id, area: 'persona-resource', path: 'resources/notes.md' })
    assert.equal(hit.text, '笔记内容\n')
    assert.equal(hit.archivedOnly, false)

    const miss = readExpertStagedFile(context, { draftId: draft.id, area: 'persona-resource', path: 'resources/other.md' })
    assert.equal(miss.ok, false)
    assert.equal(miss.code, 'invalid-path')

    const unknownDraft = readExpertStagedFile(context, { draftId: '66666666-7777-4888-8999-000000000000', area: 'persona-resource', path: 'resources/notes.md' })
    assert.equal(unknownDraft.ok, false)
    assert.equal(unknownDraft.code, 'draft-not-found')

    /** 归档原件要标 archivedOnly。 */
    const archive = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: staged.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/original.md',
      contentUtf8: '上游原件全文\n',
    })
    assert.equal(archive.ok, true)
    const archived = readExpertStagedFile(context, { draftId: draft.id, area: 'persona-resource', path: 'sources/demo/original.md' })
    assert.equal(archived.archivedOnly, true)
  })
})

test('归档原件与许可全文超 20000 字符是 warning、普通资源是 error', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    const submitted = submitValid(context, draft)
    let version = submitted.contentVersion
    const big = 'x'.repeat(20001)

    for (const path of ['sources/demo/original.md', 'sources/demo/LICENSE.txt', 'resources/too-big.md']) {
      const staged = stageExpertFile(context, {
        draftId: draft.id,
        sessionId: SESSION_A,
        expectedVersion: version,
        area: 'persona-resource',
        path,
        contentUtf8: big,
      })
      assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')
      version = staged.contentVersion
    }

    const result = validateExpertDraft(context, { draftId: draft.id, expectedVersion: version, sessionId: SESSION_A })
    assert.equal(result.ok, true)
    const warningFields = result.validation.warnings.filter((entry) => entry.code === 'file-too-large').map((entry) => entry.field)
    assert.equal(warningFields.some((field) => field.includes('original.md')), true)
    assert.equal(warningFields.some((field) => field.includes('LICENSE.txt')), true)
    assert.equal(
      result.validation.errors.some((entry) => entry.code === 'file-too-large' && entry.field.includes('too-big.md')),
      true,
      '普通资源超限必须是 error，不能混成 warning',
    )
  })
})

test('步骤 9 warning 不自动消失：重复校验仍报同一条，且 validation 落进 DB 那一行', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    /** `commit: null` 是**警告**（source-commit-unknown），用来造"零 errors、有 warning"的草稿。 */
    const submitted = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj({ sources: [sourceObj({ commit: null })] }),
      skillsJson: [],
    })
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    assert.equal(staged.ok, true)

    const first = validateExpertDraft(context, { draftId: draft.id, expectedVersion: staged.contentVersion, sessionId: SESSION_A })
    assert.equal(first.ok, true)
    assert.deepEqual(first.validation.errors, [])
    assert.equal(first.validation.warnings.some((entry) => entry.code === 'source-commit-unknown'), true)
    /** 只有 warning、没有 error → 就是通过（否则用户永远无法确认）。 */
    assert.equal(first.phase, 'validated')

    /** 再校验一次（HTTP 路径）：警告不能因为"已经报过一次"就消失。 */
    const second = validateExpertDraft(context, { draftId: draft.id, expectedVersion: staged.contentVersion })
    assert.equal(second.ok, true)
    assert.deepEqual(second.validation.errors, [])
    assert.equal(second.validation.warnings.some((entry) => entry.code === 'source-commit-unknown'), true)
    assert.equal(second.validation.version, staged.contentVersion)
    assert.equal(second.validation.manifestHash, first.validation.manifestHash)

    /** 落库的是真实那一行：版本、哈希、警告都在。 */
    const row = getExpertDraft(db, draft.id)
    assert.equal(row.payload.validation.version, staged.contentVersion)
    assert.equal(row.payload.validation.manifestHash, first.validation.manifestHash)
    assert.equal(row.payload.validation.warnings.some((entry) => entry.code === 'source-commit-unknown'), true)
    assert.equal(row.payload.phase, 'validated')
  })
})

// ---------------------------------------------------------------------------
// skill 包在整份草稿里的校验（§6.1 第 6 步 + 第 9 步）
// ---------------------------------------------------------------------------

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

/**
 * 一份"版权链齐备"的暂存集合：来源 `demo` 的 `usedFor` 是 `['persona','skill']`，
 * 所以 **persona 侧与 skill 包内各要一份许可副本**（§3.3 ⑧：两条链各自登记）。
 */
function skillStagedFiles() {
  return [
    ['persona-resource', 'sources/demo/LICENSE.txt', MIT_TEXT],
    ['skill', 'demo-skill/SKILL.md', SKILL_MD],
    ['skill', 'demo-skill/sources/demo/LICENSE.txt', MIT_TEXT],
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

test('§6.1-6 skill 包完整则校验通过；缺一件或声明不一致则 skill-package-invalid', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const submitted = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [skillRequirement()],
    })
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')

    let version = submitted.contentVersion
    for (const [area, path, text] of skillStagedFiles()) {
      const staged = stageExpertFile(context, {
        draftId: draft.id,
        sessionId: SESSION_A,
        expectedVersion: version,
        area,
        path,
        contentUtf8: text,
      })
      assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')
      version = staged.contentVersion
    }

    /** 先成功一次。 */
    const good = validateExpertDraft(context, { draftId: draft.id, expectedVersion: version, sessionId: SESSION_A })
    assert.deepEqual(good.validation.errors, [])
    assert.equal(good.phase, 'validated')

    /** 声明里多一条没暂存的文件 → skill-package-invalid。 */
    const resubmit = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: good.contentVersion,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [skillRequirement({ packageFiles: ['SKILL.md', 'sources/demo/LICENSE.txt', 'references/missing.md'] })],
    })
    assert.equal(resubmit.ok, true)
    const bad = validateExpertDraft(context, { draftId: draft.id, expectedVersion: resubmit.contentVersion, sessionId: SESSION_A })
    assert.equal(bad.ok, true)
    assert.equal(
      bad.validation.errors.some((entry) => entry.code === 'skill-package-invalid' && /尚未暂存/.test(entry.message)),
      true,
    )
    assert.equal(bad.phase, 'editing')

    /** 暂存里多一条没声明的文件 → 同样 skill-package-invalid（双向）。 */
    const extra = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: resubmit.contentVersion,
      area: 'skill',
      path: 'demo-skill/references/extra.md',
      contentUtf8: '额外文件',
    })
    assert.equal(extra.ok, true)
    const back = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: extra.contentVersion,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [skillRequirement()],
    })
    assert.equal(back.ok, true)
    const bad2 = validateExpertDraft(context, { draftId: draft.id, expectedVersion: back.contentVersion, sessionId: SESSION_A })
    assert.equal(
      bad2.validation.errors.some((entry) => entry.code === 'skill-package-invalid' && /未在 packageFiles 中声明/.test(entry.message)),
      true,
    )
    void db
  })
})

test('§6.1-7/9 reuse 必需项与正式目录冲突：缺失是 error、同名冲突是 skill-conflict', () => {
  withFixture(({ context, skillsDir }) => {
    const draft = newDraft(context)
    const submitted = submitExpertDraft(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [
        { name: 'not-installed', required: true, action: 'reuse', sourceId: null, packageFiles: [], reason: '想复用' },
        { name: 'optional-missing', required: false, action: 'reuse', sourceId: null, packageFiles: [], reason: '可选复用' },
      ],
    })
    assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')
    const staged = stageExpertFile(context, {
      draftId: draft.id,
      sessionId: SESSION_A,
      expectedVersion: submitted.contentVersion,
      area: 'persona-resource',
      path: 'sources/demo/LICENSE.txt',
      contentUtf8: MIT_TEXT,
    })
    const validated = validateExpertDraft(context, { draftId: draft.id, expectedVersion: staged.contentVersion, sessionId: SESSION_A })
    assert.equal(validated.ok, true)
    assert.equal(validated.phase, 'editing')
    /** 没有 skills 服务（context.skills 未注入）：必需项是 error、可选项是 warning。 */
    assert.equal(
      validated.validation.errors.some((entry) => entry.code === 'skill-service-unavailable' && entry.field.startsWith('skills[0]')),
      true,
      '必需 reuse 在服务缺失时必须是 error',
    )
    assert.equal(
      validated.validation.warnings.some((entry) => entry.code === 'skill-service-unavailable' && entry.field.startsWith('skills[1]')),
      true,
      '可选 reuse 在服务缺失时只能是 warning',
    )

    /** 正式 skills 根下已有同名目录但没有管理清单 → skill-conflict（拒绝覆盖）。 */
    mkdirSync(join(skillsDir, 'demo-skill'), { recursive: true })
    writeFileSync(join(skillsDir, 'demo-skill', 'SKILL.md'), SKILL_MD, 'utf8')
    /**
     * 第二份草稿用另一个会话（`createExpertDraft` 对同一会话的同/异需求有去重与冲突规则：
     * 一个会话同时只留一份 pending 草稿），顺便验证"另一个会话的草稿互不干扰"。
     */
    const second = newDraft(context, { sessionId: SESSION_B, request: '第二份需求：安装同名技能' })
    const submitted2 = submitExpertDraft(context, {
      draftId: second.id,
      sessionId: SESSION_B,
      expectedVersion: 0,
      personaMd: personaDoc(),
      provenanceJson: provenanceObj(),
      skillsJson: [skillRequirement()],
    })
    assert.equal(submitted2.ok, true)
    let version = submitted2.contentVersion
    for (const [area, path, text] of skillStagedFiles()) {
      const s = stageExpertFile(context, { draftId: second.id, sessionId: SESSION_B, expectedVersion: version, area, path, contentUtf8: text })
      assert.equal(s.ok, true)
      version = s.contentVersion
    }
    const conflicted = validateExpertDraft(context, { draftId: second.id, expectedVersion: version, sessionId: SESSION_B })
    assert.equal(conflicted.ok, true)
    assert.equal(conflicted.validation.errors.some((entry) => entry.code === 'skill-conflict'), true)
    assert.equal(conflicted.phase, 'editing')
    void statSync
  })
})

test('§6.1-2 未提交人格正文 / 未提交来源时 validate 报错但仍是 ok:true', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    const result = validateExpertDraft(context, { draftId: draft.id, expectedVersion: 0 })
    assert.equal(result.ok, true)
    assert.equal(result.phase, 'editing')
    assert.equal(result.validation.errors.length > 0, true)
    assert.equal(result.validation.errors.some((entry) => entry.field === 'personaMd'), true)
    assert.equal(result.validation.errors.some((entry) => entry.field === 'provenance'), true)
    assert.equal(result.validation.version, 0)
    assert.equal(result.validation.checkedAt, AT)
  })
})

test('§6.1-1 守卫：validate 不带 sessionId 是 HTTP 路径，带错 sessionId 会被拒', () => {
  withFixture(({ context }) => {
    const draft = newDraft(context)
    /** HTTP 路径（没有 sessionId 键）：能读出校验结论。 */
    const httpPath = validateExpertDraft(context, { draftId: draft.id, expectedVersion: 0 })
    assert.equal(httpPath.ok, true)
    assert.equal(httpPath.validation.errors.length > 0, true)

    /** 工具路径带了别的会话：拒绝。 */
    const toolPath = validateExpertDraft(context, { draftId: draft.id, expectedVersion: 0, sessionId: SESSION_B })
    assert.equal(toolPath.ok, false)
    assert.equal(toolPath.code, 'draft-owner-mismatch')

    /** 版本不一致：draft-version-conflict。 */
    const stale = validateExpertDraft(context, { draftId: draft.id, expectedVersion: 7 })
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'draft-version-conflict')
    assert.equal(stale.currentVersion, 0)
  })
})

test('expertDraftView 与 isExpertValidation 的形状', () => {
  withFixture(({ context, db }) => {
    const draft = newDraft(context)
    const view = expertDraftView(getExpertDraft(db, draft.id))
    assert.equal(view.draftId, draft.id)
    assert.equal(view.contentVersion, 0)
    assert.equal(view.phase, 'editing')
    assert.match(view.expertId, /^generated\/[0-9a-f-]{36}$/)
    assert.deepEqual(view.files, [])
    assert.equal(view.validation, null)
  })
})
