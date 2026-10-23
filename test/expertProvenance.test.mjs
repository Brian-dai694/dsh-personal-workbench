/**
 * 专家域**来源 / 许可校验与清单哈希**（`src/experts/provenance.ts`）。
 *
 * 覆盖验收断言：**AX-E05**（`upstreamPath` / `licenseFile` 里的路径形态）、
 * **AX-E06**（来源校验只做结构检查、不联网核验；缺许可就拒）。
 *
 * 本模块是纯函数：所有"文件是否存在、内容对不对"都由测试构造的 `ExpertFileLookup`
 * 提供 —— 这样每条规则都能被单独打红，不必先造出一整个安装目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stableJson, sha256Hex, expertManifestHash, parseExpertProvenance, validateExpertSourceFiles,
  lookupFromStagedFiles, isSha256Hex,
} from '../lib/experts/provenance.js'
import {
  EXPERT_SOURCE_MAX_COUNT, EXPERT_SOURCE_MAX_AUTHORS, EXPERT_ALLOWED_LICENSE,
} from '../lib/shared/expert.js'

const SHA_A = 'a'.repeat(40)
const SHA_1 = '1'.repeat(40)

/** 一份完全合法的 MIT 来源（各负例在此基础上只改一处）。 */
function source(overrides = {}) {
  return {
    id: 'agent-kit',
    repository: 'https://github.com/example/agent-kit',
    upstreamPath: 'agents/planner.md',
    commit: SHA_A,
    fetchedAt: '2026-01-02T03:04:05.000Z',
    authors: ['Zhang San <zhang@example.com>'],
    license: 'MIT',
    copyrightNotice: 'Copyright (c) 2024 Example Authors',
    licenseFile: 'sources/agent-kit/LICENSE.txt',
    usedFor: ['persona'],
    modifications: '删去工具清单一节，把中文术语统一为「专家」',
    ...overrides,
  }
}

function provenance(overrides = {}) {
  return {
    version: 1,
    creationKind: 'translated',
    sources: [source()],
    references: [{ title: 'Anthropic 的角色设计说明', url: 'https://example.com/roles', use: 'background-only' }],
    generationNote: '把上游的规划角色翻译并裁剪成工作台专家',
    ...overrides,
  }
}

/** MIT 许可文本（结构特征齐全，逐行照 MIT 原文排版）。 */
const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2024 Example Authors',
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
].join('\n')

function stagedFile(area, path, text) {
  return { area, path, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) }
}

/** 用「路径 → 文本」造一个 lookup（与生产 `lookupFromStagedFiles` 同一实现）。 */
function lookupOf(entries) {
  const files = Object.entries(entries).map(([key, text]) => {
    const [area, ...rest] = key.split('|')
    return stagedFile(area, rest.join('|'), text)
  })
  const byPath = new Map(files.map((file) => [`${file.area}|${file.path}`, entries[`${file.area}|${file.path}`]]))
  return lookupFromStagedFiles(files, (file) => byPath.get(`${file.area}|${file.path}`))
}

// ---------------------------------------------------------------------------
// stableJson（§3.4）
// ---------------------------------------------------------------------------

test('stableJson：对象键递归排序（代码点）、数组顺序保留、undefined 语义与 JSON.stringify 对齐', () => {
  /** 键顺序不影响结果。 */
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }))
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  /** 递归。 */
  assert.equal(stableJson({ z: { b: 1, a: 2 }, a: 0 }), '{"a":0,"z":{"a":2,"b":1}}')
  /** 数组顺序**是内容**：不许排序。 */
  assert.equal(stableJson({ a: [2, 1, 3] }), '{"a":[2,1,3]}')
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }))
  /** 代码点排序（不是 localeCompare）：大写字母在小写之前。 */
  assert.equal(stableJson({ b: 1, A: 2, a: 3 }), '{"A":2,"a":3,"b":1}')
  assert.equal(stableJson({ Z: 1, a: 1 }), '{"Z":1,"a":1}')
  /** undefined：对象属性丢弃、数组元素变 null（与 JSON.stringify 一致）。 */
  assert.equal(stableJson({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(stableJson([1, undefined, 2]), '[1,null,2]')
  assert.equal(stableJson(undefined), 'null')
  assert.equal(stableJson(null), 'null')
  assert.equal(stableJson(NaN), 'null')
  assert.equal(stableJson(Infinity), 'null')
  /** 中文键按代码点排（不能因 locale 不同得出两种结果）。 */
  assert.equal(stableJson({ 中文: 1, abc: 2, 阿: 3 }), stableJson({ 阿: 3, abc: 2, 中文: 1 }))
  /** 与 JSON.stringify 的等价性（排序后再比，用于证明"没自造一套字符串语法"）。 */
  const complex = { n: 1, s: 'x"y', t: true, f: false, nul: null, arr: [{ b: 1, a: [] }], empty: {} }
  assert.deepEqual(JSON.parse(stableJson(complex)), JSON.parse(JSON.stringify(complex)))
})

test('sha256Hex 与 isSha256Hex：哈希对实际字节算', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  /** 中文按 UTF-8 字节算（不是 UTF-16 码元）。 */
  assert.equal(sha256Hex('中'), sha256Hex(Buffer.from('中', 'utf8')))
  assert.equal(isSha256Hex(sha256Hex('x')), true)
  assert.equal(isSha256Hex('A'.repeat(64)), false, '大写十六进制不接受')
  assert.equal(isSha256Hex('a'.repeat(63)), false)
})

// ---------------------------------------------------------------------------
// expertManifestHash（§3.4）
// ---------------------------------------------------------------------------

test('manifestHash：随内容变、随文件顺序不变、**不**含 checkedAt/phase/contentVersion/lastInstallError', () => {
  const base = {
    expertId: 'generated/01234567-89ab-cdef-0123-456789abcdef',
    personaMd: '正文',
    provenance: provenance(),
    skills: [],
    files: [stagedFile('persona-resource', 'sources/agent-kit/LICENSE.txt', MIT_TEXT)],
  }
  const hash = expertManifestHash(base)
  assert.match(hash, /^[0-9a-f]{64}$/)

  /** 同输入同输出（纯函数）。 */
  assert.equal(expertManifestHash(base), hash)
  /** 文件顺序不影响（内部按 area/path 排序）。 */
  const twoFiles = {
    ...base,
    files: [
      stagedFile('persona-resource', 'a.md', 'A'),
      stagedFile('persona-resource', 'b.md', 'B'),
    ],
  }
  assert.equal(expertManifestHash({ ...twoFiles, files: [...twoFiles.files].reverse() }), expertManifestHash(twoFiles))
  /** 内容变 → hash 变。 */
  assert.notEqual(expertManifestHash({ ...base, personaMd: '另一版正文' }), hash)
  assert.notEqual(expertManifestHash({ ...base, files: [stagedFile('persona-resource', 'sources/agent-kit/LICENSE.txt', `${MIT_TEXT}\n附注`)] }), hash)
  assert.notEqual(expertManifestHash({ ...base, skills: [{ name: 'x', required: true, action: 'reuse', sourceId: null, packageFiles: [], reason: 'r' }] }), hash)
  assert.notEqual(expertManifestHash({ ...base, provenance: provenance({ generationNote: '改了说明' }) }), hash)
  assert.notEqual(expertManifestHash({ ...base, expertId: 'generated/01234567-89ab-cdef-0123-456789abcdee' }), hash)
  /** area 参与身份：同 path 不同 area 不是同一个文件。 */
  assert.notEqual(expertManifestHash({ ...base, files: [stagedFile('skill', 'sources/agent-kit/LICENSE.txt', MIT_TEXT)] }), hash)

  /**
   * 校验时间 / 阶段 / 上一版失败信息 / contentVersion **都不在**输入里：
   * 它们不改变"装出来的东西是什么"，算进去会让"同内容重提交"白清一次校验。
   */
  const withNoise = { ...base, checkedAt: '2026-09-09T09:09:09.000Z', phase: 'validated', contentVersion: 7, lastInstallError: { code: 'install-busy', field: 'x', message: 'y' } }
  const hashWithoutNoise = expertManifestHash({
    expertId: base.expertId, personaMd: base.personaMd, provenance: base.provenance, skills: base.skills, files: base.files,
  })
  assert.equal(expertManifestHash(withNoise), hashWithoutNoise, '噪音字段被算进了 manifestHash')
})

// ---------------------------------------------------------------------------
// parseExpertProvenance：正例
// ---------------------------------------------------------------------------

test('parseExpertProvenance：合法 translated 通过，未知 schema 版本与非法 JSON 整份拒绝', () => {
  const ok = parseExpertProvenance(JSON.stringify(provenance()))
  assert.equal(ok.ok, true, `应通过：${ok.ok === false ? JSON.stringify(ok.errors) : ''}`)
  assert.deepEqual(ok.warnings, [])
  assert.equal(ok.provenance.sources.length, 1)
  assert.equal(ok.provenance.sources[0].commit, SHA_A)
  assert.equal(ok.provenance.references[0].use, 'background-only')

  /** 未来源版本：整份拒绝，且给 unknown-schema-version。 */
  const future = parseExpertProvenance(provenance({ version: 2 }))
  assert.equal(future.ok, false)
  assert.equal(future.errors[0].code, 'unknown-schema-version')
  /** 版本缺失也拒（不能"当成 1 处理"）。 */
  const noVersion = parseExpertProvenance({ ...provenance(), version: undefined })
  assert.equal(noVersion.ok, false)
  assert.equal(noVersion.errors[0].code, 'unknown-schema-version')

  /** 非法 JSON。 */
  const broken = parseExpertProvenance('{ not json')
  assert.equal(broken.ok, false)
  assert.equal(broken.errors[0].code, 'invalid-json')
  /** 非对象。 */
  assert.equal(parseExpertProvenance('[]').errors[0].code, 'invalid-payload')
  assert.equal(parseExpertProvenance(42).errors[0].code, 'invalid-payload')
})

test('parseExpertProvenance：commit 缺失给 source-commit-unknown 警告；把 main/HEAD/日期写成 commit 直接拒', () => {
  const noCommit = parseExpertProvenance(provenance({ sources: [source({ commit: null })] }))
  assert.equal(noCommit.ok, true, '取不到 commit 允许通过（只给警告）')
  assert.deepEqual(noCommit.warnings.map((warning) => warning.code), ['source-commit-unknown'])
  assert.equal(noCommit.provenance.sources[0].commit, null)
  assert.match(noCommit.warnings[0].field, /commit$/)

  for (const fake of ['main', 'master', 'HEAD', 'latest', '2026-01-02', 'v1.2.3', 'abc123']) {
    const parsed = parseExpertProvenance(provenance({ sources: [source({ commit: fake })] }))
    assert.equal(parsed.ok, false, `不允许把 ${fake} 当 commit`)
    assert.ok(parsed.errors.some((error) => error.code === 'source-invalid' && error.field.endsWith('.commit')), `缺少 commit 字段的错误：${fake}`)
  }
  /** 大写 SHA 也不算（git 输出是小写，大写多半是手抄错的）。 */
  assert.equal(parseExpertProvenance(provenance({ sources: [source({ commit: SHA_A.toUpperCase() })] })).ok, false)
})

test('parseExpertProvenance：来源条数随创作方式（translated/adapted ≥1、merged ≥2、original 可 0）', () => {
  const one = (kind) => parseExpertProvenance(provenance({ creationKind: kind, sources: [source()] }))
  assert.equal(one('translated').ok, true)
  assert.equal(one('adapted').ok, true)
  assert.equal(one('merged').ok, false, 'merged 至少 2 个 persona 来源')
  assert.ok(one('merged').errors.some((error) => error.code === 'source-invalid'))

  const two = parseExpertProvenance(provenance({
    creationKind: 'merged',
    sources: [source(), source({ id: 'other-kit', licenseFile: 'sources/other-kit/LICENSE.txt' })],
  }))
  assert.equal(two.ok, true)
  assert.equal(two.provenance.sources.length, 2)

  /** 两条来源 id 相同 → 后一条的 licenseFile 必指向同一个文件，语义打架。 */
  const dupId = parseExpertProvenance(provenance({
    creationKind: 'merged',
    sources: [source(), source()],
  }))
  assert.equal(dupId.ok, false)
  assert.ok(dupId.errors.some((error) => /重复/.test(error.message)))

  /** original：0 条来源合法；登记了来源就必须说明用途。 */
  const pureOriginal = parseExpertProvenance(provenance({ creationKind: 'original', sources: [], references: [] }))
  assert.equal(pureOriginal.ok, true)
  assert.deepEqual(pureOriginal.provenance.sources, [])
  const sloppy = parseExpertProvenance(provenance({ creationKind: 'original', sources: [source({ usedFor: [] })] }))
  assert.equal(sloppy.ok, false)
  assert.ok(sloppy.errors.some((error) => error.field.endsWith('.usedFor')))

  /** 非 persona 来源（只用于 skill）不能满足 translated 的 persona 来源要求。 */
  const skillOnly = parseExpertProvenance(provenance({ creationKind: 'translated', sources: [source({ usedFor: ['skill'] })] }))
  assert.equal(skillOnly.ok, false)
})

test('parseExpertProvenance：repository / upstreamPath / authors / license / 版权声明 / licenseFile / modifications 逐条把关', () => {
  const bad = (patch, expectCode, fieldPart) => {
    const parsed = parseExpertProvenance(provenance({ sources: [source(patch)] }))
    assert.equal(parsed.ok, false, `应拒绝：${JSON.stringify(patch)}`)
    const hit = parsed.errors.find((error) => error.code === expectCode)
    assert.ok(hit !== undefined, `期望 code=${expectCode}，实际 ${JSON.stringify(parsed.errors.map((e) => e.code))}`)
    if (fieldPart !== undefined) assert.ok(hit.field.includes(fieldPart), `期望 field 含 ${fieldPart}，实际 ${hit.field}`)
  }

  /** repository 必须是 HTTPS 首页，且不带 token/userinfo/query/hash。 */
  bad({ repository: 'http://github.com/example/agent-kit' }, 'source-invalid', 'repository')
  bad({ repository: 'https://user:token@github.com/example/agent-kit' }, 'source-invalid', 'repository')
  bad({ repository: 'https://github.com/example/agent-kit?token=abc' }, 'source-invalid', 'repository')
  bad({ repository: 'https://github.com/example/agent-kit#readme' }, 'source-invalid', 'repository')
  bad({ repository: 'git@github.com:example/agent-kit.git' }, 'source-invalid', 'repository')
  bad({ repository: '' }, 'source-invalid', 'repository')

  /** upstreamPath 不得绝对 / UNC / `..`。 */
  bad({ upstreamPath: '/etc/passwd' }, 'source-invalid', 'upstreamPath')
  bad({ upstreamPath: 'C:/agents/a.md' }, 'source-invalid', 'upstreamPath')
  bad({ upstreamPath: '\\\\server\\share\\a.md' }, 'source-invalid', 'upstreamPath')
  bad({ upstreamPath: '../secret.md' }, 'source-invalid', 'upstreamPath')
  bad({ upstreamPath: 'a/../../b.md' }, 'source-invalid', 'upstreamPath')
  bad({ upstreamPath: 'a\u0000b.md' }, 'source-invalid', 'upstreamPath')
  assert.equal(parseExpertProvenance(provenance({ sources: [source({ upstreamPath: 'deep/a/b/c.md' })] })).ok, true)

  /** authors：非空、1–16 条、每条 ≤200 字符。 */
  bad({ authors: [] }, 'source-invalid', 'authors')
  bad({ authors: ['  '] }, 'source-invalid', 'authors')
  bad({ authors: Array.from({ length: EXPERT_SOURCE_MAX_AUTHORS + 1 }, (_, index) => `A${index}`) }, 'source-invalid', 'authors')
  bad({ authors: ['x'.repeat(201)] }, 'source-invalid', 'authors')
  assert.equal(parseExpertProvenance(provenance({ sources: [source({ authors: Array.from({ length: EXPERT_SOURCE_MAX_AUTHORS }, (_, i) => `A${i}`) })] })).ok, true)

  /** 许可：非 MIT / 缺省 / 口头"开源"都不通过。 */
  for (const license of ['Apache-2.0', 'BSD-3-Clause', '', 'unknown', 'open source']) {
    bad({ license }, 'source-license-unsupported', 'license')
  }
  assert.equal(EXPERT_ALLOWED_LICENSE, 'MIT')

  /** 版权声明必须非空。 */
  bad({ copyrightNotice: '' }, 'source-license-missing', 'copyrightNotice')
  bad({ copyrightNotice: '   ' }, 'source-license-missing', 'copyrightNotice')

  /** licenseFile 必须指向本人格附件里的 sources/<id>/LICENSE.txt。 */
  bad({ licenseFile: '' }, 'source-license-missing', 'licenseFile')
  bad({ licenseFile: 'LICENSE.txt' }, 'source-license-missing', 'licenseFile')
  bad({ licenseFile: '../../LICENSE.txt' }, 'source-license-missing', 'licenseFile')
  bad({ licenseFile: 'sources/other-id/LICENSE.txt' }, 'source-license-missing', 'licenseFile')

  /** modifications 不能只写"有修改"。 */
  bad({ modifications: '' }, 'source-invalid', 'modifications')
  bad({ modifications: '有修改' }, 'source-invalid', 'modifications')
  bad({ modifications: 'modified' }, 'source-invalid', 'modifications')

  /** 作者名不合法时 id/形状仍要有稳定 code。 */
  bad({ id: 'Bad_Id' }, 'source-invalid', 'id')
  bad({ id: '-bad' }, 'source-invalid', 'id')
  bad({ fetchedAt: '不是时间' }, 'source-invalid', 'fetchedAt')
  bad({ usedFor: ['person', 'skill'] }, 'source-invalid', 'usedFor')
  bad({ usedFor: [] }, 'source-invalid', 'usedFor')

  /** 来源条数上限 8。 */
  const tooMany = parseExpertProvenance(provenance({
    creationKind: 'merged',
    sources: Array.from({ length: EXPERT_SOURCE_MAX_COUNT + 1 }, (_, index) => source({ id: `kit-${index}`, licenseFile: `sources/kit-${index}/LICENSE.txt` })),
  }))
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.errors.some((error) => error.code === 'source-invalid' && /最多 8 条/.test(error.message)))
})

test('parseExpertProvenance：references 只表示背景阅读（use 必须是 background-only）', () => {
  const ok = parseExpertProvenance(provenance())
  assert.equal(ok.ok, true)
  const wrongUse = parseExpertProvenance(provenance({ references: [{ title: 't', url: 'https://example.com', use: 'copied' }] }))
  assert.equal(wrongUse.ok, false)
  assert.ok(wrongUse.errors.some((error) => error.code === 'source-invalid' && error.field.endsWith('.use')))
  const missingTitle = parseExpertProvenance(provenance({ references: [{ url: 'https://example.com', use: 'background-only' }] }))
  assert.equal(missingTitle.ok, false)
  const badUrl = parseExpertProvenance(provenance({ references: [{ title: 't', url: 'file:///etc/passwd', use: 'background-only' }] }))
  assert.equal(badUrl.ok, false)
})

// ---------------------------------------------------------------------------
// validateExpertSourceFiles：许可文本结构校验（§3.3 第 5、6、8 条）
// ---------------------------------------------------------------------------

test('validateExpertSourceFiles：许可文本齐 → 通过；缺文件、空文件、缺版权声明、缺 MIT 段落 → 各有稳定 code', () => {
  const parsed = parseExpertProvenance(provenance())
  assert.equal(parsed.ok, true)
  const prov = parsed.provenance
  const key = 'persona-resource|sources/agent-kit/LICENSE.txt'

  const good = validateExpertSourceFiles(prov, lookupOf({ [key]: MIT_TEXT }))
  assert.equal(good.ok, true, `应通过：${JSON.stringify(good.errors)}`)
  assert.deepEqual(good.errors, [])
  assert.deepEqual(good.warnings, [])

  /** 缺许可文件。 */
  const missing = validateExpertSourceFiles(prov, lookupOf({}))
  assert.equal(missing.ok, false)
  assert.equal(missing.errors[0].code, 'source-license-missing')
  assert.match(missing.errors[0].message, /sources\/agent-kit\/LICENSE\.txt/)

  /** 空文件。 */
  const empty = validateExpertSourceFiles(prov, lookupOf({ [key]: '   \n  ' }))
  assert.equal(empty.ok, false)
  assert.equal(empty.errors[0].code, 'source-license-missing')

  /** 有文件、但没有版权声明（"这个项目是 MIT"式口头描述）。 */
  const noCopyright = validateExpertSourceFiles(prov, lookupOf({ [key]: MIT_TEXT.replace('Copyright (c) 2024 Example Authors', 'See upstream repository for license terms.') }))
  assert.equal(noCopyright.ok, false)
  assert.equal(noCopyright.errors[0].code, 'source-license-unsupported')
  assert.match(noCopyright.errors[0].message, /版权声明/)

  /** 缺 MIT 授权段。 */
  const noPermission = validateExpertSourceFiles(prov, lookupOf({ [key]: 'MIT License\n\nCopyright (c) 2024 Example Authors\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n' }))
  assert.equal(noPermission.ok, false)
  assert.ok(noPermission.errors.some((error) => error.code === 'source-license-unsupported' && /授权段落/.test(error.message)))

  /** 缺免责段。 */
  const noDisclaimer = validateExpertSourceFiles(prov, lookupOf({ [key]: 'MIT License\n\nCopyright (c) 2024 Example Authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction.\n' }))
  assert.equal(noDisclaimer.ok, false)
  assert.ok(noDisclaimer.errors.some((error) => error.code === 'source-license-unsupported' && /免责声明/.test(error.message)))

  /** CRLF 的许可文本应当被接受（换行风格不是内容身份）。 */
  const crlf = validateExpertSourceFiles(prov, lookupOf({ [key]: MIT_TEXT.replace(/\n/g, '\r\n') }))
  assert.equal(crlf.ok, true, `CRLF 不应被拒：${JSON.stringify(crlf.errors)}`)

  /** 拿不到文本内容时不许"悄悄放过结构校验"。 */
  const noReader = validateExpertSourceFiles(prov, { find: () => ({ bytes: 10, sha256: 'a'.repeat(64) }) })
  assert.equal(noReader.ok, false)
  assert.equal(noReader.errors[0].code, 'source-license-missing')
  /** 显式允许跳过结构检查时才通过（供只读快照场景使用）。 */
  assert.equal(validateExpertSourceFiles(prov, { find: () => ({ bytes: 10, sha256: 'a'.repeat(64) }) }, { allowStructureSkip: true }).ok, true)
})

test('validateExpertSourceFiles：超尺寸报 file-too-large；归档原件超限只给警告（保留完整文件、不截断）', () => {
  const parsed = parseExpertProvenance(provenance())
  const prov = parsed.provenance
  const key = 'persona-resource|sources/agent-kit/LICENSE.txt'
  /** 索引里声明的字节数超过单文件上限。 */
  const oversized = validateExpertSourceFiles(prov, { find: () => ({ bytes: 200 * 1024, sha256: 'a'.repeat(64) }), readText: () => MIT_TEXT })
  assert.equal(oversized.ok, false)
  assert.equal(oversized.errors[0].code, 'file-too-large')

  /** 字符数超上限（解码后）也要拒。 */
  const longText = `${MIT_TEXT}\n${'x'.repeat(20001)}`
  const tooManyChars = validateExpertSourceFiles(prov, lookupOf({ [key]: longText }))
  assert.equal(tooManyChars.ok, false)
  assert.ok(tooManyChars.errors.some((error) => error.code === 'file-too-large' && /字符/.test(error.message)))

  /** 归档原件超限：**警告**（不是错误）—— 原件按归档保留完整文件。 */
  const withBigOriginal = validateExpertSourceFiles(prov, lookupOf({
    [key]: MIT_TEXT,
    'persona-resource|sources/agent-kit/original.md': 'y'.repeat(300 * 1024),
  }))
  assert.equal(withBigOriginal.ok, true, '归档原件超限不该拦住提交')
  assert.deepEqual(withBigOriginal.warnings.map((warning) => warning.code), ['file-too-large'])
  assert.match(withBigOriginal.warnings[0].message, /归档/)
})

test('validateExpertSourceFiles：按 area 过滤（skill 包的许可链单独校验）', () => {
  /** 一份只用于 skill 的来源：persona area 校验时跳过，skill area 校验时必须查。 */
  const parsed = parseExpertProvenance(provenance({
    creationKind: 'original',
    references: [],
    sources: [source({ usedFor: ['skill'], licenseFile: 'sources/agent-kit/LICENSE.txt' })],
  }))
  assert.equal(parsed.ok, true, `应通过：${parsed.ok === false ? JSON.stringify(parsed.errors) : ''}`)
  const prov = parsed.provenance
  /** persona 侧：该来源与 persona 无关 → 不校验、不报错。 */
  assert.equal(validateExpertSourceFiles(prov, lookupOf({}), { area: 'persona' }).ok, true)
  /** skill 侧：同一份缺失就是错误。 */
  const skillSide = validateExpertSourceFiles(prov, lookupOf({}), { area: 'skill' })
  assert.equal(skillSide.ok, false)
  assert.equal(skillSide.errors[0].code, 'source-license-missing')
  /** skill 根下的相对路径形态（`<name>/sources/<id>/LICENSE.txt`）。 */
  const skillKey = 'skill|my-skill/sources/agent-kit/LICENSE.txt'
  assert.equal(validateExpertSourceFiles(
    { ...prov, sources: [{ ...prov.sources[0], licenseFile: 'my-skill/sources/agent-kit/LICENSE.txt' }] },
    lookupOf({ [skillKey]: MIT_TEXT }),
    { area: 'skill' },
  ).ok, true)
})

test('validateExpertSourceFiles：commit 缺失只给追溯警告，不联网核验（§3.3 第 7 条）', () => {
  const parsed = parseExpertProvenance(provenance({ sources: [source({ commit: null })] }))
  assert.equal(parsed.ok, true)
  const result = validateExpertSourceFiles(parsed.provenance, lookupOf({ 'persona-resource|sources/agent-kit/LICENSE.txt': MIT_TEXT }))
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((warning) => warning.code === 'source-commit-unknown'))
  assert.ok(result.warnings.every((warning) => warning.field !== ''), '警告也必须带 field，便于界面定位')
})

test('lookupFromStagedFiles：只按 area + path 命中，bytes/sha256 原样带回', () => {
  const text = 'hello\n'
  const files = [stagedFile('persona-resource', 'a.md', text), stagedFile('skill', 'my-skill/a.md', text)]
  const lookup = lookupFromStagedFiles(files, (file) => `content-of-${file.path}`)
  assert.deepEqual(lookup.find('persona-resource', 'a.md'), { bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) })
  assert.deepEqual(lookup.find('skill', 'my-skill/a.md'), { bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) })
  assert.equal(lookup.find('persona-resource', 'my-skill/a.md'), undefined, 'area 必须参与匹配')
  assert.equal(lookup.find('skill', 'a.md'), undefined)
  assert.equal(lookup.readText('persona-resource', 'a.md'), 'content-of-a.md')
  assert.equal(lookup.readText('persona-resource', 'nope.md'), undefined)
  /** 没给 readText 时不提供该方法（调用方据此判断"能不能做结构校验"）。 */
  assert.equal(lookupFromStagedFiles(files).readText, undefined)
})

test('parseExpertProvenance 对同一份来源的多个问题会一次全报（不做"报一个就返回"）', () => {
  const parsed = parseExpertProvenance(provenance({
    sources: [source({ id: 'Bad Id', repository: 'http://x', upstreamPath: '../a', commit: 'main', fetchedAt: 'x', authors: [], license: 'unknown', copyrightNotice: '', licenseFile: 'x', usedFor: ['nope'], modifications: '' })],
    generationNote: '',
  }))
  assert.equal(parsed.ok, false)
  const fields = new Set(parsed.errors.map((error) => error.field))
  for (const expected of [
    'provenance.sources[0].id', 'provenance.sources[0].repository', 'provenance.sources[0].upstreamPath',
    'provenance.sources[0].commit', 'provenance.sources[0].fetchedAt', 'provenance.sources[0].authors',
    'provenance.sources[0].license', 'provenance.sources[0].copyrightNotice', 'provenance.sources[0].licenseFile',
    'provenance.sources[0].usedFor[0]', 'provenance.sources[0].modifications', 'provenance.generationNote',
  ]) {
    assert.ok(fields.has(expected), `缺少字段级问题：${expected}`)
  }
  /** 每个问题都必须带非空 message（界面直接显示它）。 */
  assert.ok(parsed.errors.every((error) => typeof error.message === 'string' && error.message.length > 0))
  assert.ok(parsed.errors.every((error) => typeof error.code === 'string' && /^[a-z][a-z0-9-]*$/.test(error.code)))
})
