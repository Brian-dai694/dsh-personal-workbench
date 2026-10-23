/**
 * P4 独立证据（**不属于仓库测试**）：真实安装器 → 真实 provider。
 *
 * 为什么单独写：仓库测试里 `workbench-install.json` 是**夹具构造**的，所以"清单 hash 复核"
 * 只能证明"provider 认自己算出来的哈希"，证明不了"provider 算的哈希 == 安装器写进清单的哈希"。
 * 这条链只有**真跑一遍安装**才能证明。本脚本：
 *
 *   1. 用真实草稿链（create → submit → stage → validate → confirm）装一个受管技能，
 *      包内含子目录文件、许可副本，以及一个**点开头的文件**（`.notes.txt`）；
 *   2. 断言清单里的 `packageHash` 与 provider 候选的 `locator.packageHash` **逐字相等**；
 *   3. 断言清单 `files[]` 每一条的 bytes/sha256 与磁盘真实字节相符；
 *   4. 篡改 SKILL.md → list 不得列出、get 拿不到且 invalidate 一次；
 *   5. 还原后删掉包内一个文件 → 同样拒绝；全部还原 → 又可见（证明门判的是**当下字节**）。
 *
 * 用法（必须先 `pnpm build`）：
 *   node "docs/tasks/ed644638-f9a0-45cf-a32f-90df7d060dda-工作台专家功能实现和优化/evidence/p4-provider-real-install.mjs"
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const load = (relative) => import(pathToFileURL(join(repoRoot, 'lib', relative)).href)

const { openWorkbenchDb } = await load('db/database.js')
const { seedDictionaries } = await load('db/seed.js')
const { createExpertDraft, defaultExpertId } = await load('db/repo/experts.js')
const { stageExpertFile, submitExpertDraft, validateExpertDraft } = await load('experts/drafts.js')
const { confirmExpertDraft } = await load('experts/install.js')
const { resolveExpertRoots } = await load('experts/paths.js')
const { createWorkbenchSkillProvider, readWorkbenchSkillProviderDiagnostics, WORKBENCH_SKILL_PROVIDER_NAME } = await load(
  'experts/skill-provider.js',
)

const SESSION = 'session-evidence-p4-0001'
const UUID_A = '11111111-2222-4333-8444-555555555555'
const AT = '2026-01-01T00:00:00.000Z'
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
const DOT_FILE = '# 包内点开头文件\n安装器把它算进 packageHash，provider 也必须算进去。\n'

let passed = 0
const checks = []
function check(label, fn) {
  try {
    fn()
    passed += 1
    checks.push(`  ✔ ${label}`)
  } catch (error) {
    checks.push(`  ✖ ${label}\n      ${error.message.split('\n')[0]}`)
    throw error
  }
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** provider.list 返回 `{candidates, complete}`（observation），不是裸数组。 */
function candidatesOf(raw) {
  if (Array.isArray(raw)) return raw
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.candidates)) return raw.candidates
  return []
}

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
    '> 建议简介：审查需求的完整性、可验证性及实现风险。',
    '',
    '## 身份与职责',
    '你负责审查需求，指出缺失条件与无法验收的表述。',
    '',
  ].join('\n')
}

const root = mkdtempSync(join(tmpdir(), 'dsh-wb-p4-provider-real-install-'))
const personasDir = join(root, 'personas')
const skillsDir = join(root, 'skills')
const outsideDir = join(root, 'outside')
const builtinDir = join(root, 'builtin')
for (const dir of [personasDir, skillsDir, outsideDir, builtinDir]) mkdirSync(dir, { recursive: true })
writeFileSync(join(outsideDir, 'sentinel.txt'), '根外哨兵：一个字节都不许变。\n', 'utf8')

const skillDir = join(skillsDir, 'demo-skill')
const manifestPath = join(skillDir, 'workbench-install.json')
const skillMdPath = join(skillDir, 'SKILL.md')
const dotPath = join(skillDir, '.notes.txt')
const nestedPath = join(skillDir, 'sources', 'demo', 'LICENSE.txt')

let db
const safeToRemove = root.startsWith(tmpdir()) && root.includes('dsh-wb-p4-provider-real-install-')
try {
  db = openWorkbenchDb({ dbPath: join(root, 'workbench.db') })
  seedDictionaries(db)
  const roots = resolveExpertRoots({ personasDir, skillsDir })
  const context = { db, roots, now: () => AT }

  // --- 1. 真实安装：一个受管人格 + 一个受管技能 -------------------------------
  const draft = createExpertDraft(db, { sessionId: SESSION, request: '做一个需求审查专家', expertId: defaultExpertId(UUID_A) }).draft
  const requirement = {
    name: 'demo-skill',
    required: true,
    action: 'install',
    sourceId: 'demo',
    packageFiles: ['SKILL.md', '.notes.txt', 'sources/demo/LICENSE.txt'],
    reason: '需要它的方法论',
  }
  const submitted = submitExpertDraft(context, {
    draftId: draft.id,
    sessionId: SESSION,
    expectedVersion: 0,
    personaMd: personaDoc(),
    provenanceJson: {
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
    },
    skillsJson: [requirement],
  })
  assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : 'submit 失败')

  let version = submitted.contentVersion
  const stagedFiles = [
    ['persona-resource', 'sources/demo/LICENSE.txt', MIT_TEXT],
    ['skill', 'demo-skill/SKILL.md', SKILL_MD],
    ['skill', 'demo-skill/.notes.txt', DOT_FILE],
    ['skill', 'demo-skill/sources/demo/LICENSE.txt', MIT_TEXT],
  ]
  for (const [area, path, text] of stagedFiles) {
    const staged = stageExpertFile(context, { draftId: draft.id, sessionId: SESSION, expectedVersion: version, area, path, contentUtf8: text })
    assert.equal(staged.ok, true, staged.ok === false ? staged.message : `stage ${path} 失败`)
    version = staged.contentVersion
  }
  const validated = validateExpertDraft(context, { draftId: draft.id, expectedVersion: version, sessionId: SESSION })
  assert.equal(validated.ok, true, validated.ok === false ? validated.message : 'validate 失败')
  assert.deepEqual(validated.validation.errors, [])

  const confirmed = confirmExpertDraft(context, {
    draftId: draft.id,
    expectedVersion: validated.contentVersion,
    expectedManifestHash: validated.manifestHash,
  })
  assert.equal(confirmed.ok, true, confirmed.ok === false ? confirmed.message : 'confirm 失败')
  check('真实安装：confirm ok，技能目录与清单已就位', () => {
    assert.equal(existsSync(manifestPath), true)
    assert.equal(existsSync(skillMdPath), true)
    assert.equal(existsSync(dotPath), true)
    assert.equal(existsSync(nestedPath), true)
  })

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('清单 files[] 的 bytes/sha256 与磁盘真实字节相符（含点开头文件）', () => {
    const listed = [...manifest.files].map((file) => file.path).sort()
    assert.deepEqual(listed, ['.notes.txt', 'SKILL.md', 'sources/demo/LICENSE.txt'])
    for (const file of manifest.files) {
      const bytes = readFileSync(join(skillDir, file.path))
      assert.equal(bytes.length, file.bytes, `${file.path} bytes`)
      assert.equal(sha256Of(bytes), file.sha256, `${file.path} sha256`)
    }
  })

  // --- 2. 真实 provider 认这份安装产物 --------------------------------------
  const invalidations = { count: 0 }
  const makeProvider = () =>
    createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {
        invalidations.count += 1
      },
    })

  const provider = makeProvider()
  const candidates = candidatesOf(await provider.list({}))
  check('provider.list：真实的受管技能被列出，且没有诊断', () => {
    assert.deepEqual(
      candidates.map((item) => item.name),
      ['demo-skill'],
    )
    assert.deepEqual(readWorkbenchSkillProviderDiagnostics(provider), [])
  })

  const candidate = candidates.find((item) => item.name === 'demo-skill')
  check('清单 packageHash == provider 重算的 locator.packageHash（真实安装产物，逐字相等）', () => {
    assert.equal(candidate.locator.packageHash, manifest.packageHash)
    assert.match(manifest.packageHash, /^[0-9a-f]{64}$/)
  })
  check('候选形状：rank 600 / provider 名 / source=bundled / 目录资源基', () => {
    assert.equal(candidate.rank, 600)
    assert.equal(candidate.provider, WORKBENCH_SKILL_PROVIDER_NAME)
    assert.equal(candidate.source, 'bundled')
    assert.equal(candidate.resourceBase.path, skillDir)
    assert.equal(candidate.path, skillMdPath)
  })

  const definition = await provider.get(candidate, {})
  check('provider.get：拿到正文（去 frontmatter、trim），点开头文件已计入包', () => {
    assert.equal(typeof definition.content, 'string')
    assert.equal(definition.content.startsWith('---'), false)
    assert.equal(definition.content, '## 步骤\n1. 读取输入\n2. 输出结论')
  })

  // --- 3. 篡改 → 拒绝 --------------------------------------------------------
  writeFileSync(skillMdPath, `${SKILL_MD}\n被手工追加的一行\n`, 'utf8')
  const afterEdit = makeProvider()
  const editedNames = candidatesOf(await afterEdit.list({})).map((item) => item.name)
  check('手改 SKILL.md 后：list 不再列出，诊断是 skill-package-invalid', () => {
    assert.deepEqual(editedNames, [])
    const diagnostics = readWorkbenchSkillProviderDiagnostics(afterEdit)
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].code, 'skill-package-invalid')
    assert.match(diagnostics[0].message, /与安装清单不一致/)
    assert.equal(diagnostics[0].skill, 'demo-skill')
  })
  const forged = { ...candidate, locator: { name: 'demo-skill', packageHash: manifest.packageHash } }
  const forgedDefinition = await afterEdit.get(forged, {})
  check('手改后 get（即使伪造正确的 locator）也拿不到，并 invalidate 一次', () => {
    assert.equal(forgedDefinition, undefined)
    assert.equal(invalidations.count, 1)
  })

  // --- 4. 还原文件、改删文件 → 拒绝；全部还原 → 又可见 -----------------------
  writeFileSync(skillMdPath, SKILL_MD, 'utf8')
  rmSync(dotPath, { force: true })
  const afterRemove = makeProvider()
  const afterRemoveNames = candidatesOf(await afterRemove.list({})).map((item) => item.name)
  check('删掉包内点开头文件后：list 为空（包集合变了，哈希对不上）', () => {
    assert.deepEqual(afterRemoveNames, [])
    assert.equal(readWorkbenchSkillProviderDiagnostics(afterRemove)[0].code, 'skill-package-invalid')
  })

  writeFileSync(dotPath, DOT_FILE, 'utf8')
  const restored = makeProvider()
  const restoredCandidates = candidatesOf(await restored.list({}))
  check('全部还原后：技能重新可见，且 locator.packageHash 与清单仍然相等', () => {
    assert.deepEqual(
      restoredCandidates.map((item) => item.name),
      ['demo-skill'],
    )
    assert.equal(restoredCandidates[0].locator.packageHash, manifest.packageHash)
    assert.deepEqual(readWorkbenchSkillProviderDiagnostics(restored), [])
  })

  check('根外哨兵一个字节都没变', () => {
    assert.equal(readFileSync(join(outsideDir, 'sentinel.txt'), 'utf8'), '根外哨兵：一个字节都不许变。\n')
  })
} finally {
  try {
    db?.close()
  } catch {
    /** 已经关过了。 */
  }
  if (safeToRemove && existsSync(root)) rmSync(root, { recursive: true, force: true })
}

console.log(checks.join('\n'))
console.log(`\nP4 evidence（真实安装器 → 真实 provider）：${passed}/${checks.length} PASS`)
console.log(`临时根已清理：${existsSync(root) === false}`)
process.exit(passed === checks.length ? 0 : 1)
