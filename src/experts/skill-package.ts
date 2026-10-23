/**
 * 工作台 skill 包：`SKILL.md` 的严格解析 + "整包能不能安装"的结构校验。
 *
 * ## 为什么单独一个模块（而不是塞进 P4 的 provider）
 *
 * 规格 §7.2（provider 的 list/get）与 §6.1（草稿校验）必须用**同一把尺子**判 SKILL.md。
 * provider 自己再写一份 frontmatter 解析，必然漂移成"校验放行、发现拒绝"（或反过来），
 * 而那种不一致正是本任务的验收重点。所以解析与整包校验都只在这里实现一次，
 * P4 的 provider 直接复用。
 *
 * ## 三条硬口径（每条都有会红的测试）
 *
 * 1. YAML 只走 `parseDocument` + `core` schema + 空 `customTags`：拒绝解析错误、
 *    **非顶层映射**、重复 key、未解析标签；`toJS({ maxAliasCount: 0 })` 让任何锚点别名
 *    直接抛错（**不展开**，避免 alias 炸弹与"同一个对象被到处引用"）。
 * 2. `metadata` 原样保留（嵌套映射/序列照留成对象/数组），不塞成字符串、不静默丢弃；
 *    未知键是**数据**，不是错误。
 * 3. invocation 控制键接受真 boolean 与 `true/false/1/0/yes/no/on/off` 字符串；
 *    **绝不**用 `Boolean(value)` —— `Boolean('false')` 是 `true`，会把"关闭模型调用"
 *    读成"开启"，这是最典型的静默错误。
 *
 * ## 本模块是纯函数
 *
 * 不碰文件系统、不碰 DB、不联网：调用方（`drafts.ts` / provider）把文本与文件索引喂进来，
 * 这样"哪份文件属于哪个包"的判断只在一处，且可以被单元测试直接打红。
 */
import { isMap, parseDocument } from 'yaml'

import {
  EXPERT_RESERVED_FILE_NAMES,
  EXPERT_SKILL_BODY_MAX_CHARS,
  EXPERT_STAGED_FILE_MAX_BYTES,
  isExpertSkillName,
} from '../shared/expert.js'
import type { ExpertErrorCode, ExpertIssue, ExpertSkillRequirement } from '../shared/expert.js'
import { checkExpertRelativePathShape } from './paths.js'
import { isSha256Hex, sha256Hex, stableJson } from './provenance.js'

/** 宿主规范 invocation 键（kebab-case）。 */
const CONTROL_KEYS = ['disable-model-invocation', 'user-invocable'] as const
/** 规格明确要求**拒绝**的旧驼峰键（历史 SDK 键名）。 */
const LEGACY_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable'] as const
/** invocation 的真值/假值字符串（大小写不敏感，首尾空白先 trim）。 */
const TRUE_TOKENS = new Set(['true', '1', 'yes', 'on'])
const FALSE_TOKENS = new Set(['false', '0', 'no', 'off'])
/** 已被 frontmatter 顶层消费的键：其余键进 `metadata`。 */
const CONSUMED_KEYS = new Set<string>(['name', 'description', 'whenToUse', ...CONTROL_KEYS, ...LEGACY_KEYS])

export interface WorkbenchSkillInvocation {
  /** `disable-model-invocation` 归一后的布尔值。 */
  disableModelInvocation: boolean
  /** `user-invocable` 归一后的布尔值。 */
  userInvocable: boolean
}

/** 解析并校验通过的一份 SKILL.md。 */
export interface WorkbenchSkillDocument {
  name: string
  /** 非空；frontmatter 原文本（不截断）。 */
  description: string
  whenToUse?: string
  invocation: WorkbenchSkillInvocation
  /** frontmatter 里**除已消费键之外**的所有键，原样保留（含嵌套对象）。 */
  metadata: Record<string, unknown>
  /** 去掉 frontmatter 后 `trim` 过的正文。 */
  body: string
}

export interface WorkbenchSkillParseResult {
  ok: boolean
  skill?: WorkbenchSkillDocument
  errors: ExpertIssue[]
  warnings: ExpertIssue[]
}

function issue(code: ExpertErrorCode, field: string, message: string): ExpertIssue {
  return { code, field, message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * invocation 布尔值：真 boolean 直接用；字符串按白名单表；其余（含数字、数组、对象、未知词）
 * 一律返回 `undefined` 交给调用方报错（**不猜**、不当成默认值）。
 */
function parseInvocationFlag(value: unknown, fallback: boolean): boolean | undefined {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase()
    if (TRUE_TOKENS.has(token)) return true
    if (FALSE_TOKENS.has(token)) return false
  }
  return undefined
}

/** 取 frontmatter 块：第 1 行必须是 `---`，其后找下一条 `---`。返回 `undefined` = 形状不对。 */
function extractFrontmatter(text: string): { yamlText: string; bodyLines: string[] } | undefined {
  const lines = text.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return undefined
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) return undefined
  return { yamlText: lines.slice(1, end).join('\n'), bodyLines: lines.slice(end + 1) }
}

/**
 * 解析一份 SKILL.md 文本。
 *
 * @param raw 文件原文本（UTF-8 解码后；允许带 BOM）
 * @param field 诊断用的字段定位串（草稿校验传 `skill.<name>.SKILL.md`，provider 传真实相对路径）
 */
export function parseWorkbenchSkill(raw: string, field: string = 'SKILL.md'): WorkbenchSkillParseResult {
  const errors: ExpertIssue[] = []
  const warnings: ExpertIssue[] = []
  const fail = (code: ExpertErrorCode, message: string): WorkbenchSkillParseResult => {
    errors.push(issue(code, field, message))
    return { ok: false, errors, warnings }
  }

  if (typeof raw !== 'string') return fail('invalid-payload', 'SKILL.md 内容必须是字符串')

  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  const frontmatter = extractFrontmatter(text)
  if (frontmatter === undefined) {
    return fail('skill-package-invalid', 'SKILL.md 必须以 `---` frontmatter 开头，并以单独一行 `---` 结束')
  }

  let document: ReturnType<typeof parseDocument>
  try {
    document = parseDocument(frontmatter.yamlText, { schema: 'core', customTags: [], logLevel: 'silent' })
  } catch (error) {
    return fail('skill-package-invalid', `SKILL.md frontmatter 解析失败：${(error as Error).message}`)
  }
  if (document.errors.length > 0) {
    const first = document.errors[0]
    return fail('skill-package-invalid', `SKILL.md frontmatter YAML 非法：${String(first?.message ?? '').split('\n')[0] ?? ''}`)
  }
  /**
   * 未解析标签（`!mytag` / `!!js/function`）：core schema 不认它，yaml 只给 warning 并
   * 退回字符串。留着 warning 等于"自定义标签静默变成普通文本"，所以这里升级为错误。
   */
  const unresolved = document.warnings.find((warning) => warning.code === 'TAG_RESOLVE_FAILED')
  if (unresolved !== undefined) {
    return fail('skill-package-invalid', `SKILL.md frontmatter 含不受支持的标签：${String(unresolved.message ?? '').split('\n')[0] ?? ''}`)
  }
  if (isMap(document.contents) === false) {
    return fail('skill-package-invalid', 'SKILL.md frontmatter 必须是顶层映射（key: value 列表）')
  }

  let front: unknown
  try {
    /** `maxAliasCount: 0` = 任何锚点别名都直接抛错（不展开、不引入共享对象）。 */
    front = document.toJS({ maxAliasCount: 0 })
  } catch (error) {
    return fail('skill-package-invalid', `SKILL.md frontmatter 含别名/锚点，拒绝解析：${(error as Error).message}`)
  }
  if (isPlainObject(front) === false) {
    return fail('skill-package-invalid', 'SKILL.md frontmatter 必须是顶层映射（key: value 列表）')
  }

  /** 旧驼峰键：给**具体**错误（只说"不受支持"会让人以为是拼写巧合）。 */
  for (const legacy of LEGACY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(front, legacy)) {
      errors.push(issue(
        'skill-package-invalid',
        `${field}.${legacy}`,
        `SKILL.md 使用了旧键「${legacy}」；请改用宿主规范键 「disable-model-invocation」/「user-invocable」`,
      ))
    }
  }

  const name = front.name
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push(issue('skill-package-invalid', `${field}.name`, 'SKILL.md frontmatter 缺少非空的 name'))
  } else if (isExpertSkillName(name) === false) {
    errors.push(issue(
      'skill-package-invalid',
      `${field}.name`,
      `SKILL.md 的 name 必须是小写 kebab-case（1–64 字符）：「${name}」`,
    ))
  }

  const description = front.description
  if (typeof description !== 'string' || description.trim() === '') {
    errors.push(issue('skill-package-invalid', `${field}.description`, 'SKILL.md frontmatter 缺少非空的 description'))
  }

  let whenToUse: string | undefined
  if (front.whenToUse !== undefined && front.whenToUse !== null) {
    if (typeof front.whenToUse !== 'string' || front.whenToUse.trim() === '') {
      errors.push(issue('skill-package-invalid', `${field}.whenToUse`, 'whenToUse 必须是字符串（可以省略，但不能是空串/非字符串）'))
    } else {
      whenToUse = front.whenToUse
    }
  }

  const rawDisable = front['disable-model-invocation']
  const rawUser = front['user-invocable']
  const disableModelInvocation = parseInvocationFlag(rawDisable, false)
  if (disableModelInvocation === undefined) {
    errors.push(issue(
      'skill-package-invalid',
      `${field}.disable-model-invocation`,
      `disable-model-invocation 只接受 true/false 或 true/false/1/0/yes/no/on/off 字符串，收到 ${JSON.stringify(rawDisable)}`,
    ))
  }
  const userInvocable = parseInvocationFlag(rawUser, true)
  if (userInvocable === undefined) {
    errors.push(issue(
      'skill-package-invalid',
      `${field}.user-invocable`,
      `user-invocable 只接受 true/false 或 true/false/1/0/yes/no/on/off 字符串，收到 ${JSON.stringify(rawUser)}`,
    ))
  }

  const body = frontmatter.bodyLines.join('\n').trim()
  if (body === '') {
    errors.push(issue('skill-package-invalid', `${field}.body`, 'SKILL.md 正文为空（frontmatter 之后必须有内容）'))
  } else if (body.length > EXPERT_SKILL_BODY_MAX_CHARS) {
    errors.push(issue(
      'file-too-large',
      `${field}.body`,
      `SKILL.md 正文 ${body.length} 字符，超过上限 ${EXPERT_SKILL_BODY_MAX_CHARS} 字符`,
    ))
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(front)) {
    if (CONSUMED_KEYS.has(key)) continue
    metadata[key] = value
  }

  return {
    ok: true,
    skill: {
      name: name as string,
      description: description as string,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation: {
        disableModelInvocation: disableModelInvocation as boolean,
        userInvocable: userInvocable as boolean,
      },
      metadata,
      body,
    },
    errors,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// packageHash
// ---------------------------------------------------------------------------

/** 包内一条文件（`path` 相对 **skill 根**，不带 `<name>/` 前缀）。 */
export interface WorkbenchSkillPackageFile {
  path: string
  bytes: number
  sha256: string
}

export interface HashWorkbenchSkillInput {
  name: string
  /** SKILL.md 解析出来的元数据（`metadata` 字段）。 */
  metadata: Record<string, unknown>
  files: readonly WorkbenchSkillPackageFile[]
}

/**
 * 包哈希：`stableJson({name, metadata, files})` 的 SHA-256。
 *
 * - **排除管理文件自身**（`workbench-install.json`）：它是要被写进包里的产物，
 *   算进哈希就成了"自己包含自己的哈希"，永远算不出稳定值。
 * - 文件按 `path` 代码点排序后入哈希：同一批文件在索引里以什么顺序出现都不影响结果。
 * - `metadata` 由 `stableJson` 递归按键代码点排序，所以 frontmatter 的书写顺序不影响结果。
 */
export function hashSkillPackage(input: HashWorkbenchSkillInput): string {
  const files = input.files
    .filter((file) => EXPERT_RESERVED_FILE_NAMES.includes(file.path.split('/').pop() ?? '') === false)
    .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return sha256Hex(stableJson({ name: input.name, metadata: input.metadata, files }))
}

// ---------------------------------------------------------------------------
// 整包校验
// ---------------------------------------------------------------------------

/** skills 注册表里一条**已存在**的技能（由调用方从 skills 服务投影而来）。 */
export interface WorkbenchSkillRegistryEntry {
  name: string
  /** 是否允许模型调用（`modelInvocable`）。 */
  modelInvocable: boolean
}

/** skills 服务的**形状检查版**投影：没有服务时传 `undefined`（不是伪造一个假服务）。 */
export interface WorkbenchSkillRegistry {
  /** 服务是否真的可用（模块缺失/版本不匹配时为 `false`）。 */
  available: boolean
  find(name: string): WorkbenchSkillRegistryEntry | undefined
}

/** 正式目录里已有的同名 skill（由调用方读盘得到；纯函数不碰 FS）。 */
export interface WorkbenchSkillExistingInstall {
  /** 是否有工作台管理清单（`workbench-install.json`）。 */
  managed: boolean
  /** 管理清单里的 packageHash（读不到就是 `undefined`）。 */
  packageHash?: string
}

export interface ValidateWorkbenchSkillPackageInput {
  requirement: ExpertSkillRequirement
  /** 该 skill 的暂存文件；`path` 相对 **skill 根**（不含 `<name>/` 前缀）。 */
  files: readonly WorkbenchSkillPackageFile[]
  /** 读包内文本（入参是包内相对路径）；缺省表示拿不到内容。 */
  readText?: (packagePath: string) => string | undefined
  /** reuse 判定所需的注册表；缺省 = 当前没有 skills 服务。 */
  registry?: WorkbenchSkillRegistry
  /** 正式目标冲突判定；缺省 = 正式目录里没有同名 skill。 */
  existingInstall?: WorkbenchSkillExistingInstall
}

export interface ValidateWorkbenchSkillPackageResult {
  ok: boolean
  errors: ExpertIssue[]
  warnings: ExpertIssue[]
  /** 解析通过的 SKILL.md（能算 packageHash 时一定有）。 */
  skill?: WorkbenchSkillDocument
  packageHash?: string
}

/**
 * 校验一条 skill 需求对应的包。
 *
 * - `action='install'`：声明的 `packageFiles` 必须与暂存索引里该 skill 的文件集合
 *   **完全一致**（缺声明/多出未声明都是 `skill-package-invalid`），必须含 `SKILL.md`
 *   与 `sources/<sourceId>/LICENSE.txt`；`SKILL.md` 必须能解析、且 `name` 与目录名相同。
 * - `action='reuse'`：`packageFiles` 固定 `[]`；必需项在注册表里必须存在且 `modelInvocable=true`，
 *   服务缺失时必需项是错误、可选项是警告。
 */
export function validateWorkbenchSkillPackage(
  input: ValidateWorkbenchSkillPackageInput,
): ValidateWorkbenchSkillPackageResult {
  const errors: ExpertIssue[] = []
  const warnings: ExpertIssue[] = []
  const requirement = input.requirement
  const name = typeof requirement?.name === 'string' ? requirement.name : ''
  const field = `skill.${name === '' ? '?' : name}`
  const result = (): ValidateWorkbenchSkillPackageResult => ({ ok: errors.length === 0, errors, warnings })

  if (isExpertSkillName(name) === false) {
    errors.push(issue('skill-package-invalid', `${field}.name`, `技能名必须是小写 kebab-case（1–64 字符）：「${name}」`))
    return result()
  }
  if (requirement.action !== 'install' && requirement.action !== 'reuse') {
    errors.push(issue('skill-package-invalid', `${field}.action`, `action 只能是 install / reuse，收到 ${JSON.stringify(requirement.action)}`))
    return result()
  }

  const staged = new Map<string, WorkbenchSkillPackageFile>()
  for (const file of input.files) {
    if (staged.has(file.path)) {
      errors.push(issue('skill-package-invalid', `${field}.files`, `同一路径在暂存索引里出现两次：${file.path}`))
      continue
    }
    if (Number.isInteger(file.bytes) === false || file.bytes < 0) {
      errors.push(issue('invalid-payload', `${field}.files`, `文件 ${file.path} 的 bytes 非法：${String(file.bytes)}`))
      continue
    }
    if (isSha256Hex(file.sha256) === false) {
      errors.push(issue('invalid-payload', `${field}.files`, `文件 ${file.path} 的 sha256 不是 64 位小写十六进制`))
      continue
    }
    if (file.bytes > EXPERT_STAGED_FILE_MAX_BYTES) {
      errors.push(issue('file-too-large', `${field}.files`, `文件 ${file.path} 有 ${file.bytes} 字节，超过单文件上限 ${EXPERT_STAGED_FILE_MAX_BYTES} 字节`))
      // 仍然计入暂存集合：超限只报 file-too-large，不能顺带再报一条
      // "声明了但没暂存"（那是另一个错误原因，会让用户在错误的提示上修东西）。
    }
    staged.set(file.path, file)
  }

  if (requirement.action === 'reuse') {
    if (Array.isArray(requirement.packageFiles) === false || requirement.packageFiles.length > 0) {
      errors.push(issue('skill-package-invalid', `${field}.packageFiles`, 'action=reuse 时 packageFiles 必须为空数组（复用的包不由本插件提供）'))
    }
    if (staged.size > 0) {
      errors.push(issue('skill-package-invalid', `${field}.files`, `action=reuse 的 skill「${name}」不应再暂存文件（发现 ${staged.size} 个）`))
    }
    const registry = input.registry
    if (registry === undefined || registry.available === false) {
      const message = `当前没有可用的 skills 服务，无法确认要复用的技能「${name}」是否存在`
      if (requirement.required === true) errors.push(issue('skill-service-unavailable', `${field}.name`, message))
      else warnings.push(issue('skill-service-unavailable', `${field}.name`, message))
      return result()
    }
    const entry = registry.find(name)
    if (entry === undefined) {
      const message = `要复用的技能「${name}」在当前技能库里不存在`
      if (requirement.required === true) errors.push(issue('required-skill-unavailable', `${field}.name`, message))
      else warnings.push(issue('required-skill-unavailable', `${field}.name`, message))
      return result()
    }
    if (entry.modelInvocable !== true) {
      const message = `要复用的技能「${name}」不允许模型调用（model-invocable=false），不能作为专家技能`
      if (requirement.required === true) errors.push(issue('required-skill-unavailable', `${field}.name`, message))
      else warnings.push(issue('required-skill-unavailable', `${field}.name`, message))
    }
    return result()
  }

  // ---- action === 'install' ----
  if (Array.isArray(requirement.packageFiles) === false) {
    errors.push(issue('skill-package-invalid', `${field}.packageFiles`, 'action=install 时 packageFiles 必须是非空字符串数组'))
    return result()
  }
  const declared = new Set<string>()
  for (const entry of requirement.packageFiles) {
    if (typeof entry !== 'string' || entry === '') {
      errors.push(issue('skill-package-invalid', `${field}.packageFiles`, `packageFiles 含非法条目：${JSON.stringify(entry)}`))
      continue
    }
    if (entry === name || entry.startsWith(`${name}/`)) {
      errors.push(issue('skill-package-invalid', `${field}.packageFiles`, `packageFiles 条目不得重复 name 前缀（应为相对技能根）：${entry}`))
      continue
    }
    if (declared.has(entry)) {
      errors.push(issue('skill-package-invalid', `${field}.packageFiles`, `packageFiles 重复声明：${entry}`))
      continue
    }
    const shape = checkExpertRelativePathShape('skill', `${name}/${entry}`)
    if (shape !== undefined) {
      errors.push(issue('skill-package-invalid', `${field}.packageFiles`, `packageFiles 条目「${entry}」不合法：${shape.message}`))
      continue
    }
    declared.add(entry)
  }

  if (declared.has('SKILL.md') === false) {
    errors.push(issue('skill-package-invalid', `${field}.packageFiles`, 'packageFiles 必须包含 SKILL.md'))
  }
  const sourceId = requirement.sourceId
  if (typeof sourceId !== 'string' || sourceId === '') {
    errors.push(issue('skill-package-invalid', `${field}.sourceId`, 'action=install 时必须给出 sourceId（skill 包要带对应许可副本）'))
  } else {
    const licensePath = `sources/${sourceId}/LICENSE.txt`
    if (declared.has(licensePath) === false) {
      errors.push(issue(
        'skill-package-invalid',
        `${field}.packageFiles`,
        `packageFiles 必须包含该来源的许可副本 ${licensePath}（skill 的版权链要独立登记）`,
      ))
    }
  }

  /** 两个方向都要报：只判一边会让"多出一个未声明脚本"悄悄进正式目录。 */
  for (const path of declared) {
    if (staged.has(path) === false) {
      errors.push(issue('skill-package-invalid', `${field}.packageFiles`, `声明的文件尚未暂存：${path}`))
    }
  }
  for (const path of staged.keys()) {
    if (declared.has(path) === false) {
      errors.push(issue('skill-package-invalid', `${field}.files`, `暂存文件未在 packageFiles 中声明：${path}`))
    }
  }

  const skillText = input.readText?.('SKILL.md')
  let skill: WorkbenchSkillDocument | undefined
  if (skillText === undefined) {
    errors.push(issue('skill-package-invalid', `${field}.SKILL.md`, '读不到该 skill 的 SKILL.md 内容'))
  } else {
    const parsed = parseWorkbenchSkill(skillText, `${field}.SKILL.md`)
    errors.push(...parsed.errors)
    warnings.push(...parsed.warnings)
    if (parsed.ok && parsed.skill !== undefined) {
      skill = parsed.skill
      if (skill.name !== name) {
        errors.push(issue(
          'skill-package-invalid',
          `${field}.name`,
          `SKILL.md 的 name「${skill.name}」必须与目录名「${name}」相同`,
        ))
        skill = undefined
      }
    }
  }

  if (skill !== undefined) {
    const packageHash = hashSkillPackage({
      name,
      metadata: skill.metadata,
      files: [...staged.values()],
    })
    const existing = input.existingInstall
    if (existing !== undefined) {
      if (existing.managed !== true) {
        errors.push(issue(
          'skill-conflict',
          `${field}.name`,
          `正式技能目录里已有同名技能「${name}」且没有工作台管理清单，拒绝覆盖；请改名或改成 action=reuse`,
        ))
      } else if (existing.packageHash !== packageHash) {
        errors.push(issue(
          'skill-conflict',
          `${field}.name`,
          `正式技能目录里已有同名技能「${name}」且内容哈希不同（现有 ${String(existing.packageHash ?? '无')}，本次 ${packageHash}），拒绝覆盖；如需复用请改成 action=reuse`,
        ))
      }
    }
    return { ok: errors.length === 0, errors, warnings, skill, packageHash }
  }

  return result()
}
