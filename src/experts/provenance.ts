/**
 * 专家域的**来源与许可校验**（规格 §3.3）与**清单哈希**（规格 §3.4）。
 *
 * 两条设计红线：
 *
 * 1. **纯函数**：这里不读磁盘、不联网。`licenseFile` / 原件是否存在、内容和哈希对不对，
 *    由调用方通过 `ExpertFileLookup` 传进来（服务层用暂存索引 + `readExpertTextFile`）。
 *    这样"许可校验"可以在 `node --test` 里用构造出来的索引穷举，不需要先造出一整个
 *    安装目录才能测一条规则。
 * 2. **不声称"法律真实性认证"**：`validateExpertSourceFiles` 只做**结构校验** ——
 *    原版权声明在不在、MIT 的许可条款段落全不全。仓库/commit 我们**不联网核验**，
 *    预览文案必须如实写"来源由生成会话登记"（§3.3 第 6、7 条）。
 */
import { createHash } from 'node:crypto'
import {
  EXPERT_ALLOWED_LICENSE,
  EXPERT_AUTHOR_MAX_CHARS,
  EXPERT_COMMIT_PATTERN,
  EXPERT_PROVENANCE_VERSION,
  EXPERT_SOURCE_MAX_AUTHORS,
  EXPERT_SOURCE_MAX_COUNT,
  EXPERT_STAGED_FILE_MAX_BYTES,
  EXPERT_STAGED_FILE_MAX_CHARS,
  isExpertSourceId,
  type ExpertCreationKind,
  type ExpertErrorCode,
  type ExpertIssue,
  type ExpertProvenance,
  type ExpertReference,
  type ExpertSource,
  type ExpertStagedFile,
} from '../shared/expert.js'

// ---------------------------------------------------------------------------
// 稳定 JSON（§3.4：递归按对象键代码点排序；数组顺序保留）
// ---------------------------------------------------------------------------

/** 键排序比较器：按**代码点**（不要 `localeCompare`，它受 locale 影响）。 */
function compareCodePoints(a: string, b: string): number {
  const left = [...a]
  const right = [...b]
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const l = left[index]!.codePointAt(0)!
    const r = right[index]!.codePointAt(0)!
    if (l !== r) return l < r ? -1 : 1
  }
  return left.length - right.length
}

/**
 * 稳定序列化：同样内容 → 同样字符串（与键插入顺序无关）。
 *
 * 数组**保留原顺序**（顺序本身是内容的一部分：文件清单、authors 都靠它表达语义）；
 * 对象键**递归排序**（否则 `{a,b}` 与 `{b,a}` 会算出两个 manifestHash，
 * 同内容重提交就会被误判成"内容变了"）。
 *
 * `undefined` 的对象属性直接丢弃（与 `JSON.stringify` 一致），数组里的 `undefined`
 * 序列化成 `null`（同样对齐 `JSON.stringify`）—— 不能出现"两个 undefined 拼出两种结果"。
 */
export function stableJson(value: unknown): string {
  return serializeStable(value)
}

function serializeStable(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  const type = typeof value
  if (type === 'boolean') return value === true ? 'true' : 'false'
  if (type === 'number') {
    const numeric = value as number
    return Number.isFinite(numeric) ? JSON.stringify(numeric) : 'null'
  }
  if (type === 'bigint') return JSON.stringify(String(value))
  if (type === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeStable(item)).join(',')}]`
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodePoints)
    const parts = keys.map((key) => `${JSON.stringify(key)}:${serializeStable(record[key])}`)
    return `{${parts.join(',')}}`
  }
  /** 函数 / symbol 等：`JSON.stringify` 在对象里会丢、在数组里变 null，这里统一成 null。 */
  return 'null'
}

/** 内容的 SHA-256（十六进制小写）。哈希输入**永远是实际字节或稳定 JSON 字符串**。 */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// manifestHash（§3.4）
// ---------------------------------------------------------------------------

export interface ExpertManifestHashInput {
  expertId: string
  /** 归一化后的人格正文（§3.4：先 `normalizePersonaText`，本函数不重复做）。 */
  personaMd: string
  provenance: ExpertProvenance | null
  skills: unknown
  files: readonly ExpertStagedFile[]
}

/**
 * `manifestHash` = SHA-256(稳定 JSON)。
 *
 * 输入**只有**五样：`expertId`、人格文本哈希、`provenance`、`skills`、按 area/path
 * 排序的文件 `sha256`/`bytes`。
 *
 * **刻意不包含**：`checkedAt`、`phase`、`lastInstallError`、`contentVersion`。
 * 理由 —— manifestHash 表达的是"**装出来的东西是什么**"：校验时间、当前阶段、
 * 上次失败信息、草稿改过几版，都不改变最终落盘的内容。把它们算进去会让
 * "同内容重提交"无端变成"内容变了"，从而白清一次 validation、逼用户重校验。
 */
export function expertManifestHash(input: ExpertManifestHashInput): string {
  const files = input.files
    .map((file) => ({ area: file.area, path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .slice()
    .sort((a, b) => compareCodePoints(`${a.area}\u0000${a.path}`, `${b.area}\u0000${b.path}`))
  const document = {
    expertId: input.expertId,
    personaSha256: sha256Hex(input.personaMd),
    provenance: input.provenance,
    skills: input.skills,
    files,
  }
  return sha256Hex(stableJson(document))
}

// ---------------------------------------------------------------------------
// 来源解析与校验（§3.3 第 1–5、8–10 条）
// ---------------------------------------------------------------------------

export type ExpertProvenanceParseResult =
  | { ok: true; provenance: ExpertProvenance; warnings: ExpertIssue[] }
  | { ok: false; errors: ExpertIssue[]; warnings: ExpertIssue[] }

export interface ParseExpertProvenanceOptions {
  /** 来源校验时是否要求这个人格真的带 skill 产物（决定 `usedFor` 语义提示，默认 false）。 */
  expectSkills?: boolean
}

function issue(code: ExpertErrorCode, field: string, message: string): ExpertIssue {
  return { code, field, message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxChars
}

function isHttpsHomepage(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  /** 不带 userinfo（`https://token@host/...` 会把凭据写进草稿并显示在界面上）。 */
  if (parsed.username !== '' || parsed.password !== '') return false
  /** 不带 query/hash。 */
  if (parsed.search !== '' || parsed.hash !== '') return false
  return parsed.hostname !== ''
}

function isSafeUpstreamPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (value.includes('\0')) return false
  if (value.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  if (value.startsWith('\\\\')) return false
  const segments = value.split('/')
  return segments.some((segment) => segment === '..' || segment === '.') === false
}

function isParsableIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
}

/** 形态像 commit 但其实是"分支名/日期"的值（规格 §3.3 第 3 条明令不许写）。 */
const FORBIDDEN_COMMIT_LITERALS = new Set(['main', 'master', 'head', 'latest', 'trunk', 'dev', 'develop'])

function commitLooksLikeBranchOrDate(value: string): boolean {
  const lower = value.trim().toLowerCase()
  if (FORBIDDEN_COMMIT_LITERALS.has(lower)) return true
  /** 只由数字与 `-`/`/` 组成、且不含 40 位十六进制 → 是日期或分支名，不是 SHA。 */
  if (/^\d{4}-\d{2}-\d{2}/.test(lower)) return true
  return false
}

function parseSource(raw: unknown, index: number): { source?: ExpertSource; issues: ExpertIssue[]; warnings: ExpertIssue[] } {
  const fieldPrefix = `provenance.sources[${index}]`
  const issues: ExpertIssue[] = []
  const warnings: ExpertIssue[] = []
  if (isPlainObject(raw) === false) {
    return { issues: [issue('source-invalid', fieldPrefix, '来源必须是一个对象')], warnings }
  }

  const id = raw.id
  if (isExpertSourceId(id) === false) {
    issues.push(issue('source-invalid', `${fieldPrefix}.id`, `来源 id 必须是 [a-z0-9][a-z0-9-]{0,47}，收到 ${JSON.stringify(id)}`))
  }
  if (isHttpsHomepage(raw.repository) === false) {
    issues.push(issue(
      'source-invalid',
      `${fieldPrefix}.repository`,
      'repository 必须是 HTTPS 仓库首页，且不带 token/userinfo/query/hash',
    ))
  }
  if (isSafeUpstreamPath(raw.upstreamPath) === false) {
    issues.push(issue('source-invalid', `${fieldPrefix}.upstreamPath`, 'upstreamPath 不得是绝对路径、UNC 或含 `..`'))
  }

  let commit: string | null = null
  if (raw.commit === null || raw.commit === undefined) {
    commit = null
    warnings.push(issue('source-commit-unknown', `${fieldPrefix}.commit`, '未取得 commit：追溯信息不完整，预览会显示"来源由生成会话登记"'))
  } else if (typeof raw.commit === 'string' && EXPERT_COMMIT_PATTERN.test(raw.commit)) {
    commit = raw.commit
  } else if (typeof raw.commit === 'string' && commitLooksLikeBranchOrDate(raw.commit)) {
    issues.push(issue(
      'source-invalid',
      `${fieldPrefix}.commit`,
      `commit 必须是 40 位小写 git SHA；不允许把分支名或日期当作 commit（收到 ${JSON.stringify(raw.commit)}）`,
    ))
  } else {
    issues.push(issue(
      'source-invalid',
      `${fieldPrefix}.commit`,
      `commit 必须是 40 位小写 git SHA 或 null，收到 ${JSON.stringify(raw.commit)}`,
    ))
  }

  if (isParsableIso(raw.fetchedAt) === false) {
    issues.push(issue('source-invalid', `${fieldPrefix}.fetchedAt`, 'fetchedAt 必须是可解析的 ISO 时间字符串'))
  }

  const authors: string[] = []
  if (Array.isArray(raw.authors) === false || raw.authors.length === 0) {
    issues.push(issue('source-invalid', `${fieldPrefix}.authors`, 'authors 必须是至少 1 条、至多 16 条的数组'))
  } else if (raw.authors.length > EXPERT_SOURCE_MAX_AUTHORS) {
    issues.push(issue('source-invalid', `${fieldPrefix}.authors`, `authors 最多 ${EXPERT_SOURCE_MAX_AUTHORS} 条，收到 ${raw.authors.length} 条`))
  } else {
    for (const [authorIndex, author] of raw.authors.entries()) {
      if (isNonEmptyString(author, EXPERT_AUTHOR_MAX_CHARS) === false) {
        issues.push(issue('source-invalid', `${fieldPrefix}.authors[${authorIndex}]`, `作者名必须是非空字符串且不超过 ${EXPERT_AUTHOR_MAX_CHARS} 字符`))
        continue
      }
      authors.push(author)
    }
  }

  if (raw.license !== EXPERT_ALLOWED_LICENSE) {
    /** 非 MIT / 无许可 / "反正是开源的" —— 本期一律不允许通过（§3.3 第 4 条）。 */
    issues.push(issue(
      'source-license-unsupported',
      `${fieldPrefix}.license`,
      `本期只接受转载素材的 MIT 许可；收到 ${JSON.stringify(raw.license)}（"开源"口头描述不算许可）`,
    ))
  }

  const copyrightNotice = raw.copyrightNotice
  if (isNonEmptyString(copyrightNotice, 4000) === false) {
    issues.push(issue('source-license-missing', `${fieldPrefix}.copyrightNotice`, '必须登记非空的原版权声明文本'))
  }

  const licenseFile = raw.licenseFile
  if (typeof licenseFile !== 'string' || licenseFile.trim() === '') {
    issues.push(issue('source-license-missing', `${fieldPrefix}.licenseFile`, '必须给出许可文本文件路径'))
  } else if (typeof id === 'string' && licenseFile !== `sources/${id}/LICENSE.txt`) {
    issues.push(issue(
      'source-license-missing',
      `${fieldPrefix}.licenseFile`,
      `licenseFile 必须指向本人格附件内的 sources/${id}/LICENSE.txt，收到 ${JSON.stringify(licenseFile)}`,
    ))
  }

  const usedFor: ('persona' | 'skill')[] = []
  if (Array.isArray(raw.usedFor) === false || raw.usedFor.length === 0) {
    issues.push(issue('source-invalid', `${fieldPrefix}.usedFor`, 'usedFor 必须是非空数组，取值 persona / skill'))
  } else {
    for (const [usedIndex, used] of raw.usedFor.entries()) {
      if (used !== 'persona' && used !== 'skill') {
        issues.push(issue('source-invalid', `${fieldPrefix}.usedFor[${usedIndex}]`, `usedFor 只允许 persona / skill，收到 ${JSON.stringify(used)}`))
        continue
      }
      if (usedFor.includes(used) === false) usedFor.push(used)
    }
  }

  const modifications = raw.modifications
  if (isNonEmptyString(modifications, 4000) === false) {
    issues.push(issue('source-invalid', `${fieldPrefix}.modifications`, '必须说明做了什么修改（不能只写"有修改"）'))
  } else if (/^(有|有做|做了)?修改$/.test(modifications.trim()) || /^modified$/i.test(modifications.trim())) {
    issues.push(issue('source-invalid', `${fieldPrefix}.modifications`, `modifications 不能只写"${modifications.trim()}"，要说明具体改了什么`))
  }

  if (issues.length > 0) return { issues, warnings }
  return {
    source: {
      id: id as string,
      repository: raw.repository as string,
      upstreamPath: raw.upstreamPath as string,
      commit,
      fetchedAt: raw.fetchedAt as string,
      authors,
      license: EXPERT_ALLOWED_LICENSE,
      copyrightNotice: copyrightNotice as string,
      licenseFile: licenseFile as string,
      usedFor,
      modifications: modifications as string,
    },
    issues,
    warnings,
  }
}

function parseReference(raw: unknown, index: number): { reference?: ExpertReference; issues: ExpertIssue[] } {
  const fieldPrefix = `provenance.references[${index}]`
  if (isPlainObject(raw) === false) {
    return { issues: [issue('source-invalid', fieldPrefix, 'references 的每一项必须是对象')] }
  }
  const issues: ExpertIssue[] = []
  if (isNonEmptyString(raw.title, 300) === false) {
    issues.push(issue('source-invalid', `${fieldPrefix}.title`, 'title 必须是非空字符串'))
  }
  if (typeof raw.url !== 'string' || /^https?:\/\//.test(raw.url) === false) {
    issues.push(issue('source-invalid', `${fieldPrefix}.url`, 'url 必须是 http(s) 地址'))
  }
  if (raw.use !== 'background-only') {
    issues.push(issue(
      'source-invalid',
      `${fieldPrefix}.use`,
      `references 只表示背景阅读，use 必须固定为 background-only；收到 ${JSON.stringify(raw.use)}（原文被复制或实质改写必须移入 sources 并带许可）`,
    ))
  }
  if (issues.length > 0) return { issues }
  return {
    reference: { title: raw.title as string, url: raw.url as string, use: 'background-only' },
    issues,
  }
}

/**
 * 解析并校验来源登记（§3.3 第 1–5、8–10 条）。
 *
 * 输入可以是**已解析的对象**，也可以是 `payload.provenance_json` 那种字符串
 * （后者非法 JSON 直接 `invalid-json`；未知 `version` 直接 `unknown-schema-version`
 * —— 这两种是"整份提交拒绝"，不是"挑几条好的一起收下"）。
 */
export function parseExpertProvenance(
  raw: unknown,
  options: ParseExpertProvenanceOptions = {},
): ExpertProvenanceParseResult {
  const warnings: ExpertIssue[] = []
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch (error) {
      return {
        ok: false,
        errors: [issue('invalid-json', 'provenance', `provenance_json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)],
        warnings,
      }
    }
  }
  if (isPlainObject(value) === false) {
    return { ok: false, errors: [issue('invalid-payload', 'provenance', 'provenance 必须是对象')], warnings }
  }

  const version = value.version
  if (version !== EXPERT_PROVENANCE_VERSION) {
    return {
      ok: false,
      errors: [issue(
        'unknown-schema-version',
        'provenance.version',
        `provenance 版本只支持 ${EXPERT_PROVENANCE_VERSION}，收到 ${JSON.stringify(version)}；未知版本整份拒绝`,
      )],
      warnings,
    }
  }

  const errors: ExpertIssue[] = []

  const creationKind = value.creationKind
  const creationKinds: ExpertCreationKind[] = ['translated', 'adapted', 'merged', 'original']
  const kindValid = creationKinds.includes(creationKind as ExpertCreationKind)
  if (kindValid === false) {
    errors.push(issue(
      'invalid-payload',
      'provenance.creationKind',
      `creationKind 必须是 ${creationKinds.join(' / ')} 之一，收到 ${JSON.stringify(creationKind)}`,
    ))
  }

  const rawSources = value.sources
  const sources: ExpertSource[] = []
  if (Array.isArray(rawSources) === false) {
    errors.push(issue('invalid-payload', 'provenance.sources', 'sources 必须是数组（original 可以是空数组）'))
  } else if (rawSources.length > EXPERT_SOURCE_MAX_COUNT) {
    errors.push(issue('source-invalid', 'provenance.sources', `sources 最多 ${EXPERT_SOURCE_MAX_COUNT} 条，收到 ${rawSources.length} 条`))
  } else {
    for (const [index, source] of rawSources.entries()) {
      const parsed = parseSource(source, index)
      errors.push(...parsed.issues)
      warnings.push(...parsed.warnings)
      if (parsed.source !== undefined) sources.push(parsed.source)
    }
    /** 同一 id 出现两次 → 后面那次的 `licenseFile` 会指向同一个文件，语义必然打架。 */
    const seen = new Map<string, number>()
    for (const [index, source] of sources.entries()) {
      const previous = seen.get(source.id)
      if (previous !== undefined) {
        errors.push(issue('source-invalid', `provenance.sources[${index}].id`, `来源 id 重复：${source.id}（第 ${previous} 条已用过）`))
      } else {
        seen.set(source.id, index)
      }
    }
  }

  const rawReferences = value.references ?? []
  const references: ExpertReference[] = []
  if (Array.isArray(rawReferences) === false) {
    errors.push(issue('invalid-payload', 'provenance.references', 'references 必须是数组'))
  } else {
    for (const [index, reference] of rawReferences.entries()) {
      const parsed = parseReference(reference, index)
      errors.push(...parsed.issues)
      if (parsed.reference !== undefined) references.push(parsed.reference)
    }
  }

  const generationNote = value.generationNote
  if (isNonEmptyString(generationNote, 4000) === false) {
    errors.push(issue('invalid-payload', 'provenance.generationNote', 'generationNote 必须是非空字符串'))
  }

  /**
   * §3.3 第 2 条：分支与来源条数的对应关系。这是**创作方式**的核心约束，
   * 不能用"没填来源就当原创"糊过去 —— 那正是版权链最常见的漏洞。
   */
  const personaSources = sources.filter((source) => source.usedFor.includes('persona'))
  if (kindValid === true) {
    const kind = creationKind as ExpertCreationKind
    if (kind === 'translated' || kind === 'adapted') {
      if (personaSources.length < 1) {
        errors.push(issue('source-invalid', 'provenance.sources', `${kind} 至少需要 1 个 usedFor 含 persona 的来源`))
      }
    } else if (kind === 'merged') {
      if (personaSources.length < 2) {
        errors.push(issue('source-invalid', 'provenance.sources', `merged 至少需要 2 个 usedFor 含 persona 的来源，收到 ${personaSources.length} 个`))
      }
    } else if (kind === 'original') {
      /**
       * `original` 允许 0 个来源；一旦登记了来源，就说明并非纯原创，此时必须**如实**说明
       * 每份来源的用途（不能靠把 `usedFor` 留空来"洗白"复制行为 —— background-only
       * 只存在于 references，进了 sources 就意味着有素材被用到了）。
       */
      for (const [index, source] of sources.entries()) {
        if (source.usedFor.length === 0) {
          errors.push(issue('source-invalid', `provenance.sources[${index}].usedFor`, 'original 登记了来源，就必须说明它被用在哪里（persona / skill）'))
        }
      }
    }
  }

  if (options.expectSkills === true) {
    const skillSources = sources.filter((source) => source.usedFor.includes('skill'))
    void skillSources
  }

  if (errors.length > 0) return { ok: false, errors, warnings }
  return {
    ok: true,
    provenance: {
      version: EXPERT_PROVENANCE_VERSION,
      creationKind: creationKind as ExpertCreationKind,
      sources,
      references,
      generationNote: generationNote as string,
    },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 许可文本与原件文件的校验（§3.3 第 5、6、8 条）
// ---------------------------------------------------------------------------

/** 调用方提供的文件查找表：`area + path` → 已知的字节数与哈希。 */
export interface ExpertFileLookup {
  /** 按 area + path 找一条（找不到返回 `undefined`）。 */
  find(area: 'persona-resource' | 'skill', path: string): { bytes: number; sha256: string } | undefined
  /** 读文本内容（找不到 / 不是文本返回 `undefined`）。 */
  readText?(area: 'persona-resource' | 'skill', path: string): string | undefined
}

/** 由暂存索引造一个 lookup（测试与 P2 服务层共用同一份实现）。 */
export function lookupFromStagedFiles(
  files: readonly ExpertStagedFile[],
  readText?: (file: ExpertStagedFile) => string | undefined,
): ExpertFileLookup {
  const index = new Map<string, ExpertStagedFile>()
  for (const file of files) index.set(`${file.area}\u0000${file.path}`, file)
  return {
    find(area, path) {
      const file = index.get(`${area}\u0000${path}`)
      return file === undefined ? undefined : { bytes: file.bytes, sha256: file.sha256 }
    },
    ...(readText === undefined ? {} : {
      readText(area: 'persona-resource' | 'skill', path: string) {
        const file = index.get(`${area}\u0000${path}`)
        return file === undefined ? undefined : readText(file)
      },
    }),
  }
}

export interface ValidateExpertSourceFilesOptions {
  /** 只校验用于哪个 area 的来源（缺省两者都校）。 */
  area?: 'persona' | 'skill'
  /**
   * 没有 `readText` 时是否只做"存在性 + 尺寸"校验，跳过结构文本检查（缺省 `false`，
   * 即：没有 `readText` 就明确报 `source-license-missing` 之外的一条**可诊断**问题，
   * 而不是悄悄放过许可文本检查）。
   */
  allowStructureSkip?: boolean
}

export interface ValidateExpertSourceFilesResult {
  ok: boolean
  errors: ExpertIssue[]
  warnings: ExpertIssue[]
}

/** MIT 许可条款的**结构**特征（不联网、不比对官方全文，只判"该有的段落在不在"）。 */
const MIT_PERMISSION_MARKERS = [
  'Permission is hereby granted, free of charge',
  'to deal in the Software without restriction',
]
const MIT_DISCLAIMER_MARKERS = [
  'THE SOFTWARE IS PROVIDED "AS IS"',
  'WITHOUT WARRANTY OF ANY KIND',
]

/**
 * 许可文本的结构比对前归一化：统一换行 + **折叠空白**。
 *
 * 为什么要折叠：MIT 原文在不同来源里被硬换行成不同宽度（官方模板 "…to deal" / "in the Software
 * without restriction…" 正好跨行），若按"标记必须出现在同一行"判，**排版合法但折行位置不同的
 * 真许可文本会被冤枉拒掉**——那是把"排版"当成了"内容"。折叠空白后标记是"跨行也算"的
 * 连续词串，而缺失授权段落的文本依旧找不到标记，判据的**抓错能力不变**。
 */
function normalizeLicenseText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
}

/**
 * 校验每份来源"该带的文件都带了、内容结构也对"（§3.3 第 5、6、8 条）。
 *
 * 判据（每一条都会在测试里被单独打红）：
 * - `licenseFile` 必须在该 area 的文件索引里（缺 → `source-license-missing`）；
 * - 许可文本不得为空、不得超尺寸（超 → `file-too-large`）、**必须包含原版权声明**
 *   与 MIT 的 permission/disclaimer 结构特征（缺 → `source-license-unsupported`）；
 * - `original.md` 若登记在索引里，尺寸也要过；
 * - **不联网核验**仓库/commit（§3.3 第 7 条），这里只回报 `source-commit-unknown` 这类追溯警告。
 *
 * 注意措辞：本函数做的是**结构校验**，不是"法律真实性认证"。
 */
export function validateExpertSourceFiles(
  provenance: ExpertProvenance,
  lookup: ExpertFileLookup,
  options: ValidateExpertSourceFilesOptions = {},
): ValidateExpertSourceFilesResult {
  const errors: ExpertIssue[] = []
  const warnings: ExpertIssue[] = []
  const area: 'persona-resource' | 'skill' = options.area === 'skill' ? 'skill' : 'persona-resource'

  for (const [index, source] of provenance.sources.entries()) {
    const fieldPrefix = `provenance.sources[${index}]`
    if (options.area !== undefined && source.usedFor.includes(options.area) === false) continue

    if (source.commit === null) {
      warnings.push(issue('source-commit-unknown', `${fieldPrefix}.commit`, `来源 ${source.id} 未取得 commit：追溯信息不完整（不联网核验）`))
    }

    const entry = lookup.find(area, source.licenseFile)
    if (entry === undefined) {
      errors.push(issue(
        'source-license-missing',
        `${fieldPrefix}.licenseFile`,
        `许可文本未随草稿暂存：${source.licenseFile}（每个复制素材都必须附原许可文本）`,
      ))
      continue
    }
    if (entry.bytes > EXPERT_STAGED_FILE_MAX_BYTES) {
      errors.push(issue('file-too-large', `${fieldPrefix}.licenseFile`, `许可文本 ${entry.bytes} 字节，超过暂存上限 ${EXPERT_STAGED_FILE_MAX_BYTES} 字节`))
    }

    const text = lookup.readText?.(area, source.licenseFile)
    if (text === undefined) {
      if (options.allowStructureSkip !== true) {
        errors.push(issue(
          'source-license-missing',
          `${fieldPrefix}.licenseFile`,
          '拿不到许可文本内容，无法做结构校验（需要 lookup.readText）',
        ))
      }
      continue
    }
    const normalized = normalizeLicenseText(text)
    if (normalized.trim() === '') {
      errors.push(issue('source-license-missing', `${fieldPrefix}.licenseFile`, '许可文本为空'))
      continue
    }
    if (normalized.length > EXPERT_STAGED_FILE_MAX_CHARS) {
      errors.push(issue(
        'file-too-large',
        `${fieldPrefix}.licenseFile`,
        `许可文本 ${normalized.length} 字符，超过单文件字符上限 ${EXPERT_STAGED_FILE_MAX_CHARS}（不截断，请如实拆分）`,
      ))
      continue
    }
    if (normalized.includes(source.copyrightNotice.trim()) === false) {
      errors.push(issue(
        'source-license-unsupported',
        `${fieldPrefix}.licenseFile`,
        '许可文本里找不到登记的原版权声明；不能只写"该项目采用 MIT 许可"',
      ))
    }
    for (const marker of MIT_PERMISSION_MARKERS) {
      if (normalized.includes(marker) === false) {
        errors.push(issue(
          'source-license-unsupported',
          `${fieldPrefix}.licenseFile`,
          `许可文本缺少 MIT 的授权段落（找不到「${marker}」）`,
        ))
        break
      }
    }
    for (const marker of MIT_DISCLAIMER_MARKERS) {
      if (normalized.includes(marker) === false) {
        errors.push(issue(
          'source-license-unsupported',
          `${fieldPrefix}.licenseFile`,
          `许可文本缺少 MIT 的免责声明段落（找不到「${marker}」）`,
        ))
        break
      }
    }

    /** 原件是归档材料：保留完整文件，尺寸超上限时**不截断**，只如实报告。 */
    const originalPath = `sources/${source.id}/original.md`
    const original = lookup.find(area, originalPath)
    if (original !== undefined && original.bytes > EXPERT_STAGED_FILE_MAX_BYTES) {
      warnings.push(issue(
        'file-too-large',
        `${fieldPrefix}.original`,
        `归档原件 ${originalPath} 有 ${original.bytes} 字节（超过资源工具可读上限）；原件按归档保留完整文件，读取会被既有工具拒绝`,
      ))
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 校验 SHA-256 十六进制串形状（用于"暂存文件是否被改过"的比对）。 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
