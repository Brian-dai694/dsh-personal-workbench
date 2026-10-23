/**
 * 工作台 skill 包解析与整包校验（`src/experts/skill-package.ts`）。
 *
 * 覆盖验收断言：
 * - **AX-E14**：坏包不可安装 —— invalid YAML、缺 name/description、目录名不符、
 *   legacy invocation key、字符串 `false` **不能**变成 `true`、metadata 保留（含嵌套）、
 *   自定义标签/锚点别名拒绝、正文 20000 通过 / 20001 拒绝。
 * - **AX-E12**：单件超限与"清单集合不一致"必须报对应错误（双向都报）。
 *
 * 断言全部落在**真实返回值**上（解析出来的 document、errors/warnings 的 code 与 field、
 * packageHash 的稳定性），不断言"调用了某个函数"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashSkillPackage, parseWorkbenchSkill, validateWorkbenchSkillPackage } from '../lib/experts/skill-package.js'
import { sha256Hex } from '../lib/experts/provenance.js'
import { EXPERT_SKILL_BODY_MAX_CHARS, EXPERT_STAGED_FILE_MAX_BYTES } from '../lib/shared/expert.js'

const BODY = '## 步骤\n1. 读取输入\n2. 输出结论\n'

/** 造一份 SKILL.md；`head` 给了就直接用它（用于造坏形状的例子）。 */
function skillText({
  name = 'demo-skill',
  description = '演示技能',
  whenToUse = null,
  extra = [],
  body = BODY,
  head = null,
} = {}) {
  if (head !== null) return head
  const lines = ['---']
  if (name !== null) lines.push(`name: ${name}`)
  if (description !== null) lines.push(`description: ${description}`)
  if (whenToUse !== null) lines.push(`whenToUse: ${whenToUse}`)
  lines.push(...extra)
  lines.push('---', '', body)
  return lines.join('\n')
}

const LICENSE = [
  'MIT License',
  '',
  'Copyright (c) 2026 Demo Authors',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  '',
].join('\n')

const SKILL_NAME = 'demo-skill'
const LICENSE_PATH = 'sources/demo/LICENSE.txt'

function filesOf(entries) {
  return entries.map(([path, text]) => ({ path, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256Hex(text) }))
}

function textMap(entries) {
  return new Map(entries)
}

/** 一个结构完整的 install 包（SKILL.md + 许可副本，声明与暂存逐条一致）。 */
function validPackage() {
  const entries = [['SKILL.md', skillText()], [LICENSE_PATH, LICENSE]]
  return {
    requirement: {
      name: SKILL_NAME,
      required: true,
      action: 'install',
      sourceId: 'demo',
      packageFiles: ['SKILL.md', LICENSE_PATH],
      reason: '需要按该技能的方法论执行',
    },
    files: filesOf(entries),
    readText: (path) => textMap(entries).get(path),
  }
}

function codes(list) {
  return list.map((entry) => entry.code)
}

// ---------------------------------------------------------------------------
// AX-E14：SKILL.md 解析
// ---------------------------------------------------------------------------

test('AX-E14 SKILL.md 解析：name/description/body 与 invocation 默认值', () => {
  const result = parseWorkbenchSkill(skillText({ whenToUse: '需要审查需求时' }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.skill.name, 'demo-skill')
  assert.equal(result.skill.description, '演示技能')
  assert.equal(result.skill.whenToUse, '需要审查需求时')
  assert.equal(result.skill.body, BODY.trim())
  assert.deepEqual(result.skill.invocation, { disableModelInvocation: false, userInvocable: true })
  assert.deepEqual(result.skill.metadata, {})
})

test('AX-E14 SKILL.md 解析：没有 frontmatter / 没有结束分隔线都拒绝', () => {
  const noFrontmatter = parseWorkbenchSkill('# 只有正文\n')
  assert.equal(noFrontmatter.ok, false)
  assert.deepEqual(codes(noFrontmatter.errors), ['skill-package-invalid'])

  const unterminated = parseWorkbenchSkill('---\nname: a\ndescription: b\n\n正文\n')
  assert.equal(unterminated.ok, false)
  assert.deepEqual(codes(unterminated.errors), ['skill-package-invalid'])
  assert.match(unterminated.errors[0].message, /---/)
})

test('AX-E14 SKILL.md 解析：invalid YAML 与重复 key 都拒绝（不能靠 toJS 兜）', () => {
  const badYaml = parseWorkbenchSkill(skillText({ head: '---\nname: [a\ndescription: b\n---\n\n正文\n' }))
  assert.equal(badYaml.ok, false)
  assert.deepEqual(codes(badYaml.errors), ['skill-package-invalid'])

  const duplicate = parseWorkbenchSkill(skillText({ head: '---\nname: a\ndescription: b\nname: c\n---\n\n正文\n' }))
  assert.equal(duplicate.ok, false)
  assert.deepEqual(codes(duplicate.errors), ['skill-package-invalid'])
  assert.equal(duplicate.skill, undefined, '重复 key 时绝不能返回一个"看起来能用"的 document')
})

test('AX-E14 SKILL.md 解析：非顶层 map 拒绝（序列与标量）', () => {
  const sequence = parseWorkbenchSkill(skillText({ head: '---\n- name: a\n- description: b\n---\n\n正文\n' }))
  assert.equal(sequence.ok, false)
  assert.deepEqual(codes(sequence.errors), ['skill-package-invalid'])

  const scalar = parseWorkbenchSkill(skillText({ head: '---\njust-a-scalar\n---\n\n正文\n' }))
  assert.equal(scalar.ok, false)
  assert.deepEqual(codes(scalar.errors), ['skill-package-invalid'])
})

test('AX-E14 SKILL.md 解析：锚点别名与自定义/JS 标签都拒绝', () => {
  const alias = parseWorkbenchSkill(skillText({
    head: '---\nname: a\ndescription: b\nx: &anchor q\ncity: *anchor\n---\n\n正文\n',
  }))
  assert.equal(alias.ok, false)
  assert.deepEqual(codes(alias.errors), ['skill-package-invalid'])
  assert.match(alias.errors[0].message, /别名|锚点/)

  const customTag = parseWorkbenchSkill(skillText({ head: '---\nname: !mytag a\ndescription: b\n---\n\n正文\n' }))
  assert.equal(customTag.ok, false)
  assert.deepEqual(codes(customTag.errors), ['skill-package-invalid'])

  const jsTag = parseWorkbenchSkill(skillText({ head: '---\nname: !!js/function "function(){}()"\ndescription: b\n---\n\n正文\n' }))
  assert.equal(jsTag.ok, false)
  assert.deepEqual(codes(jsTag.errors), ['skill-package-invalid'])
})

test('AX-E14 SKILL.md 解析：缺 name / 缺 description / 空 description 逐条报错', () => {
  const noName = parseWorkbenchSkill(skillText({ name: null }))
  assert.equal(noName.ok, false)
  assert.equal(codes(noName.errors).includes('skill-package-invalid'), true)
  assert.equal(noName.errors.some((entry) => entry.field.endsWith('.name')), true)

  const noDescription = parseWorkbenchSkill(skillText({ description: null }))
  assert.equal(noDescription.ok, false)
  assert.equal(noDescription.errors.some((entry) => entry.field.endsWith('.description')), true)

  const emptyDescription = parseWorkbenchSkill(skillText({ description: '""' }))
  assert.equal(emptyDescription.ok, false)
  assert.equal(emptyDescription.errors.some((entry) => entry.field.endsWith('.description')), true)

  const badName = parseWorkbenchSkill(skillText({ name: 'Demo_Skill' }))
  assert.equal(badName.ok, false)
  assert.equal(badName.errors.some((entry) => entry.field.endsWith('.name')), true)
})

test('AX-E14 SKILL.md 解析：legacy invocation key 被拒且给出具体键名', () => {
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    const result = parseWorkbenchSkill(skillText({ extra: [`${legacy}: true`] }))
    assert.equal(result.ok, false, `${legacy} 必须被拒`)
    const hit = result.errors.find((entry) => entry.field.endsWith(`.${legacy}`))
    assert.notEqual(hit, undefined, `${legacy} 要有字段级错误`)
    assert.equal(hit.code, 'skill-package-invalid')
    assert.match(hit.message, /disable-model-invocation|user-invocable/)
  }
})

test('AX-E14 SKILL.md 解析：字符串 false 不能变成 true，未知取值要报错', () => {
  const off = parseWorkbenchSkill(skillText({
    extra: ['disable-model-invocation: "false"', "user-invocable: 'no'"],
  }))
  assert.equal(off.ok, true)
  assert.deepEqual(off.skill.invocation, { disableModelInvocation: false, userInvocable: false })

  const on = parseWorkbenchSkill(skillText({
    extra: ['disable-model-invocation: "on"', "user-invocable: '1'"],
  }))
  assert.equal(on.ok, true)
  assert.deepEqual(on.skill.invocation, { disableModelInvocation: true, userInvocable: true })

  const realBoolean = parseWorkbenchSkill(skillText({ extra: ['disable-model-invocation: true', 'user-invocable: false'] }))
  assert.equal(realBoolean.ok, true)
  assert.deepEqual(realBoolean.skill.invocation, { disableModelInvocation: true, userInvocable: false })

  const unknown = parseWorkbenchSkill(skillText({ extra: ['disable-model-invocation: maybe'] }))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errors.some((entry) => entry.field.endsWith('.disable-model-invocation')), true)
})

test('AX-E14 SKILL.md 解析：metadata 原样保留（含嵌套对象与数组）', () => {
  const result = parseWorkbenchSkill(skillText({
    extra: [
      'license: MIT',
      'allowed-tools: [Read, Grep]',
      'nested:',
      '  a: 1',
      '  list: [x, y]',
    ],
  }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.skill.metadata, {
    license: 'MIT',
    'allowed-tools': ['Read', 'Grep'],
    nested: { a: 1, list: ['x', 'y'] },
  })
  assert.equal(typeof result.skill.metadata.nested, 'object', '嵌套内容不能被塞成字符串')
  assert.equal('name' in result.skill.metadata, false)
  assert.equal('description' in result.skill.metadata, false)
})

test('AX-E14 SKILL.md 解析：空正文拒绝，20000 字符通过、20001 拒绝', () => {
  const empty = parseWorkbenchSkill(skillText({ body: '   \n  \n' }))
  assert.equal(empty.ok, false)
  assert.equal(empty.errors.some((entry) => entry.field.endsWith('.body')), true)

  const exact = parseWorkbenchSkill(skillText({ body: 'x'.repeat(EXPERT_SKILL_BODY_MAX_CHARS) }))
  assert.equal(exact.ok, true)
  assert.equal(exact.skill.body.length, EXPERT_SKILL_BODY_MAX_CHARS)

  const over = parseWorkbenchSkill(skillText({ body: 'x'.repeat(EXPERT_SKILL_BODY_MAX_CHARS + 1) }))
  assert.equal(over.ok, false)
  assert.deepEqual(codes(over.errors), ['file-too-large'])
})

// ---------------------------------------------------------------------------
// AX-E12：整包清单一致性
// ---------------------------------------------------------------------------

test('AX-E12 结构完整的 install 包通过，并给出稳定 packageHash', () => {
  const input = validPackage()
  const result = validateWorkbenchSkillPackage(input)
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  assert.equal(result.skill.name, SKILL_NAME)
  assert.match(result.packageHash, /^[0-9a-f]{64}$/)

  const again = validateWorkbenchSkillPackage(validPackage())
  assert.equal(again.packageHash, result.packageHash, '同内容必须算出同一个 packageHash')
})

test('AX-E12 声明了但没暂存 / 暂存了但没声明：两个方向都要报 skill-package-invalid', () => {
  const missingStaged = validPackage()
  missingStaged.files = missingStaged.files.filter((file) => file.path !== LICENSE_PATH)
  const first = validateWorkbenchSkillPackage(missingStaged)
  assert.equal(first.ok, false)
  assert.deepEqual(codes(first.errors), ['skill-package-invalid'])
  assert.match(first.errors[0].message, /尚未暂存|未暂存/)

  const undeclared = validPackage()
  undeclared.files = [...undeclared.files, ...filesOf([['references/extra.md', '额外文件']])]
  const second = validateWorkbenchSkillPackage(undeclared)
  assert.equal(second.ok, false)
  assert.equal(second.errors.some((entry) => /未在 packageFiles 中声明/.test(entry.message)), true)
})

test('AX-E12 必须含 SKILL.md 与 sources/<sourceId>/LICENSE.txt', () => {
  const noSkillMd = validPackage()
  noSkillMd.requirement.packageFiles = [LICENSE_PATH]
  noSkillMd.files = noSkillMd.files.filter((file) => file.path !== 'SKILL.md')
  const first = validateWorkbenchSkillPackage(noSkillMd)
  assert.equal(first.ok, false)
  assert.equal(first.errors.some((entry) => /必须包含 SKILL\.md/.test(entry.message)), true)

  const noLicense = validPackage()
  noLicense.requirement.packageFiles = ['SKILL.md']
  noLicense.files = noLicense.files.filter((file) => file.path !== LICENSE_PATH)
  const second = validateWorkbenchSkillPackage(noLicense)
  assert.equal(second.ok, false)
  assert.equal(second.errors.some((entry) => /许可副本/.test(entry.message)), true)

  const noSourceId = validPackage()
  noSourceId.requirement.sourceId = null
  const third = validateWorkbenchSkillPackage(noSourceId)
  assert.equal(third.ok, false)
  assert.equal(third.errors.some((entry) => entry.field.endsWith('.sourceId')), true)
})

test('AX-E12 packageFiles 条目本身的形状：重复前缀 / 穿越 / 非文本 / 保留名一律拒', () => {
  const prefixed = validPackage()
  prefixed.requirement.packageFiles = ['SKILL.md', LICENSE_PATH, `${SKILL_NAME}/references/a.md`]
  assert.equal(validateWorkbenchSkillPackage(prefixed).errors.some((entry) => /不得重复 name 前缀/.test(entry.message)), true)

  const traversal = validPackage()
  traversal.requirement.packageFiles = ['SKILL.md', 'references/../../evil.md']
  assert.equal(validateWorkbenchSkillPackage(traversal).ok, false)

  const nonText = validPackage()
  nonText.requirement.packageFiles = ['SKILL.md', 'scripts/run.exe']
  assert.equal(validateWorkbenchSkillPackage(nonText).ok, false)

  const reserved = validPackage()
  reserved.requirement.packageFiles = ['SKILL.md', 'workbench-install.json']
  assert.equal(validateWorkbenchSkillPackage(reserved).ok, false)

  const duplicated = validPackage()
  duplicated.requirement.packageFiles = ['SKILL.md', 'SKILL.md', LICENSE_PATH]
  assert.equal(validateWorkbenchSkillPackage(duplicated).ok, false)
})

test('AX-E12 单件超 128 KiB 报 file-too-large', () => {
  const input = validPackage()
  input.files = input.files.map((file) => (file.path === LICENSE_PATH ? { ...file, bytes: EXPERT_STAGED_FILE_MAX_BYTES + 1 } : file))
  const result = validateWorkbenchSkillPackage(input)
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result.errors), ['file-too-large'])
})

test('AX-E12 SKILL.md 的 name 必须与目录名相同', () => {
  const input = validPackage()
  input.requirement.name = 'other-skill'
  input.requirement.packageFiles = ['SKILL.md', LICENSE_PATH]
  const result = validateWorkbenchSkillPackage(input)
  assert.equal(result.ok, false)
  assert.equal(result.errors.some((entry) => /必须与目录名/.test(entry.message)), true)
})

test('AX-E12 reuse：packageFiles 非空 / 有暂存文件都拒绝', () => {
  const base = {
    name: 'existing-skill',
    required: true,
    action: 'reuse',
    sourceId: null,
    packageFiles: [],
    reason: '已有技能，直接复用',
  }
  const notEmpty = validateWorkbenchSkillPackage({
    requirement: { ...base, packageFiles: ['SKILL.md'] },
    files: [],
    registry: { available: true, find: () => ({ name: 'existing-skill', modelInvocable: true }) },
  })
  assert.equal(notEmpty.ok, false)
  assert.deepEqual(codes(notEmpty.errors), ['skill-package-invalid'])

  const staged = validateWorkbenchSkillPackage({
    requirement: base,
    files: filesOf([[`${base.name}/SKILL.md`, skillText({ name: base.name })]]),
    registry: { available: true, find: () => ({ name: 'existing-skill', modelInvocable: true }) },
  })
  assert.equal(staged.ok, false)
  assert.equal(staged.errors.some((entry) => /不应再暂存文件/.test(entry.message)), true)
})

test('AX-E12 reuse：必需项缺失是 error、可选项缺失是 warning', () => {
  const requirement = {
    name: 'missing-skill',
    required: true,
    action: 'reuse',
    sourceId: null,
    packageFiles: [],
    reason: '希望复用',
  }
  const missingRegistry = validateWorkbenchSkillPackage({ requirement, files: [] })
  assert.equal(missingRegistry.ok, false)
  assert.deepEqual(codes(missingRegistry.errors), ['skill-service-unavailable'])

  const optionalMissingRegistry = validateWorkbenchSkillPackage({
    requirement: { ...requirement, required: false },
    files: [],
  })
  assert.equal(optionalMissingRegistry.ok, true)
  assert.deepEqual(codes(optionalMissingRegistry.warnings), ['skill-service-unavailable'])

  const emptyRegistry = { available: true, find: () => undefined }
  const notFound = validateWorkbenchSkillPackage({ requirement, files: [], registry: emptyRegistry })
  assert.equal(notFound.ok, false)
  assert.deepEqual(codes(notFound.errors), ['required-skill-unavailable'])

  const optionalNotFound = validateWorkbenchSkillPackage({
    requirement: { ...requirement, required: false },
    files: [],
    registry: emptyRegistry,
  })
  assert.equal(optionalNotFound.ok, true)
  assert.deepEqual(codes(optionalNotFound.warnings), ['required-skill-unavailable'])

  const notModelInvocable = validateWorkbenchSkillPackage({
    requirement,
    files: [],
    registry: { available: true, find: () => ({ name: 'missing-skill', modelInvocable: false }) },
  })
  assert.equal(notModelInvocable.ok, false)
  assert.deepEqual(codes(notModelInvocable.errors), ['required-skill-unavailable'])
})

// ---------------------------------------------------------------------------
// AX-E12 / §6.1 第 9 步：正式目标冲突
// ---------------------------------------------------------------------------

test('AX-E12 正式目录已有同名 skill：无管理清单或哈希不同都报 skill-conflict', () => {
  const input = validPackage()
  const hash = validateWorkbenchSkillPackage(input).packageHash

  const unmanaged = validateWorkbenchSkillPackage({ ...validPackage(), existingInstall: { managed: false } })
  assert.equal(unmanaged.ok, false)
  assert.deepEqual(codes(unmanaged.errors), ['skill-conflict'])

  const different = validateWorkbenchSkillPackage({
    ...validPackage(),
    existingInstall: { managed: true, packageHash: 'f'.repeat(64) },
  })
  assert.equal(different.ok, false)
  assert.deepEqual(codes(different.errors), ['skill-conflict'])

  const same = validateWorkbenchSkillPackage({ ...validPackage(), existingInstall: { managed: true, packageHash: hash } })
  assert.equal(same.ok, true, '同完整清单哈希 + 有管理清单应当允许（可复用）')
})

// ---------------------------------------------------------------------------
// packageHash 的稳定性
// ---------------------------------------------------------------------------

test('AX-E12 hashSkillPackage 与文件顺序无关，且排除管理文件自身', () => {
  const metadata = { license: 'MIT', nested: { b: 2, a: 1 } }
  const files = filesOf([['SKILL.md', skillText()], [LICENSE_PATH, LICENSE]])
  const base = hashSkillPackage({ name: SKILL_NAME, metadata, files })

  const reordered = hashSkillPackage({ name: SKILL_NAME, metadata, files: [...files].reverse() })
  assert.equal(reordered, base, '索引顺序不同不能改变 packageHash')

  const withManifest = hashSkillPackage({
    name: SKILL_NAME,
    metadata,
    files: [...files, { path: 'workbench-install.json', bytes: 12, sha256: 'a'.repeat(64) }],
  })
  assert.equal(withManifest, base, 'workbench-install.json 是管理文件自身，不进 packageHash')

  const differentMetadata = hashSkillPackage({ name: SKILL_NAME, metadata: { license: 'MIT' }, files })
  assert.notEqual(differentMetadata, base, 'SKILL.md 元数据变了，packageHash 必须跟着变')
})
