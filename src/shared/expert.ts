/**
 * 专家域的**类型与常量唯一权威源**（规格 §1.4 限值、§3.2 类型、§12.1 错误码）。
 *
 * 这个文件刻意"什么都不做"：不读磁盘、不 import React、不 import 宿主 SDK。
 * 理由（dsh-plugin-change §1）：判定逻辑要能在 `node --test` 里直接加载并断言，
 * 而"限值散落在实现里"正是后来没人知道 128 KiB 到底是谁定的那种局面的起点。
 *
 * 每个限值只有**一处**定义，实现与测试都从这里取；要改就同时改这里与规格。
 */

// ---------------------------------------------------------------------------
// 错误码（§12.1 封闭枚举）
// ---------------------------------------------------------------------------

/**
 * 专家域全部稳定错误码。
 *
 * **封闭**：任何"临时想一个 code"都是 bug —— 前端要靠它分流，测试要靠它断言，
 * 中文文案只进 `message`，绝不进 `code`。
 */
export const EXPERT_ERROR_CODES = [
  'invalid-json',
  'invalid-payload',
  'unknown-schema-version',
  'invalid-path',
  'path-link-forbidden',
  'file-too-large',
  'package-too-large',
  'file-count-limit',
  'source-invalid',
  'source-license-missing',
  'source-license-unsupported',
  'source-commit-unknown',
  'skill-package-invalid',
  'skill-conflict',
  'skill-shadowed',
  'required-skill-unavailable',
  'skill-service-unavailable',
  'skill-scope-unavailable',
  'draft-not-found',
  'draft-owner-mismatch',
  'draft-version-conflict',
  'draft-not-pending',
  'draft-not-validated',
  'staged-file-changed',
  'package-changed',
  'generation-conflict',
  'methodology-unavailable',
  'generation-unavailable',
  'install-in-progress',
  'install-busy',
  'install-lock-owner-unknown',
  'install-repair-required',
  'install-owner-unknown',
  'installation-incomplete',
  'expert-not-found',
  'expert-disabled',
  'expert-busy',
  'expert-auto-disabled',
  'expert-subagent-unavailable',
  'expert-empty-output',
  'expert-persona-not-loaded',
  'manual-request-expired',
  'manual-request-not-found',
  'manual-request-session-mismatch',
  'manual-request-task-changed',
  'ticket-invalid',
  'ticket-child-mismatch',
  'adapter-contract-mismatch',
  'canceled',
  'timeout',
] as const

export type ExpertErrorCode = (typeof EXPERT_ERROR_CODES)[number]

const EXPERT_ERROR_CODE_SET: ReadonlySet<string> = new Set(EXPERT_ERROR_CODES)

/** 是不是本域的稳定错误码（HTTP 包装层按它决定"是不是已知语义失败"）。 */
export function isExpertErrorCode(value: unknown): value is ExpertErrorCode {
  return typeof value === 'string' && EXPERT_ERROR_CODE_SET.has(value)
}

// ---------------------------------------------------------------------------
// 结构性常量（§3.2 里那些"写死在格式里"的字面量）
// ---------------------------------------------------------------------------

/** `ExpertDraftPayload.version` 的当前值。 */
export const EXPERT_DRAFT_PAYLOAD_VERSION = 1
/** `ExpertProvenance.version` 的当前值。 */
export const EXPERT_PROVENANCE_VERSION = 1
/** `ExpertValidation.version` 的当前值（校验记录格式版本，与草稿 contentVersion 无关）。 */
export const EXPERT_VALIDATION_VERSION = 1
/** `WorkbenchSkillInstall.version` 的当前值。 */
export const EXPERT_SKILL_INSTALL_VERSION = 1
/** `ExpertInstallJournal.version` 的当前值。 */
export const EXPERT_INSTALL_JOURNAL_VERSION = 1

/** 专家草稿的外层 `kind_code`（`task_drafts.kind_code`）。 */
export const EXPERT_DRAFT_KIND = 'expert'
/** 外层状态：只用这三个，phase 不得升格成外层状态（§3.2）。 */
export const EXPERT_DRAFT_STATUSES = ['pending', 'confirmed', 'abandoned'] as const
export type ExpertDraftStatus = (typeof EXPERT_DRAFT_STATUSES)[number]

/** `settings`(meta) 里自动召唤开关的键名。 */
export const EXPERT_AUTO_SUMMON_META_KEY = 'expert_auto_summon'
/** `ai_session_scope` 字典 code：专家生成会话。 */
export const EXPERT_GENERATION_SCOPE_CODE = 'expert_generation'

/** 安装日志主文件名。 */
export const EXPERT_INSTALL_JOURNAL_FILE_NAME = 'install-journal.json'
/** 跨进程安装锁的文件名（放在 personas 根下）。 */
export const EXPERT_INSTALL_LOCK_FILE_NAME = '.install.lock'
/** 未提交暂存区的目录名（放在 personas / skills 根下）。 */
export const EXPERT_PENDING_DIR_NAME = '.pending'
/** 已安装人格文档所在目录名（放在 personas 根下）。 */
export const EXPERT_GENERATED_DIR_NAME = 'generated'
/** 安装器写、用于上一轮恢复的日志备份名。 */
export const EXPERT_JOURNAL_PREVIOUS_NAME = 'journal.previous.json'
/** 暂存区里存放附件文件的目录名。 */
export const EXPERT_PENDING_FILES_DIR_NAME = 'files'
/** 受管人格的发布门文件名（`generated/<UUID>/publication.json`，**只有安装器写**）。 */
export const EXPERT_PUBLICATION_FILE_NAME = 'publication.json'
/** 安装器写的来源登记文件（`generated/<UUID>/provenance.json`）。 */
export const EXPERT_PROVENANCE_FILE_NAME = 'provenance.json'
/** 已安装 skill 的管理清单文件名（`<skillName>/workbench-install.json`，**只有安装器写**）。 */
export const EXPERT_SKILL_INSTALL_FILE_NAME = 'workbench-install.json'
/** `publication.json` 的版本（形状守卫用；不是 `ExpertInstallJournal.version`）。 */
export const EXPERT_PUBLICATION_VERSION = 1

/** 安装器/持久化保留名：**模型不得**通过暂存工具写这些文件。 */
export const EXPERT_RESERVED_FILE_NAMES: readonly string[] = [
  EXPERT_PUBLICATION_FILE_NAME,
  EXPERT_PROVENANCE_FILE_NAME,
  EXPERT_SKILL_INSTALL_FILE_NAME,
  EXPERT_INSTALL_JOURNAL_FILE_NAME,
]

// ---------------------------------------------------------------------------
// 限值（§1.4）
// ---------------------------------------------------------------------------

/** 用户原始请求长度上限（字符）。 */
export const EXPERT_REQUEST_MAX_CHARS = 2000
/** 专家正文上限：归一化、去标题/元信息后按现有解析器算出的 UTF-16 单元数。 */
export const EXPERT_BODY_MAX_CHARS = 20000
/** 单份暂存文件的 UTF-8 字节上限（仅文本）。 */
export const EXPERT_STAGED_FILE_MAX_BYTES = 128 * 1024
/**
 * 「正文类」暂存文件的字符上限（解码后 UTF-16 单元）。
 *
 * **不是暂存门槛**：规格对暂存文件只规定 128 KiB 字节（见上一条），
 * 这个值表示"资源工具/正文能完整读回来的字符上限"。归档原件与完整许可文本
 * 允许超过它（保留完整文件、超限只给 warning，不截断），因此
 * `validateStagedFileContent` 只在调用方显式传 `maxChars` 时才判它。
 */
export const EXPERT_STAGED_FILE_MAX_CHARS = 20000
/** 单份草稿的暂存文件数量上限（不含服务端产生的管理文件）。 */
export const EXPERT_DRAFT_MAX_FILES = 64
/** 单份草稿的暂存内容总量上限（字节）。 */
export const EXPERT_DRAFT_MAX_TOTAL_BYTES = 1024 * 1024
/** 一个人格最多携带的来源条数。 */
export const EXPERT_SOURCE_MAX_COUNT = 8
/** 每条来源的作者条数上限。 */
export const EXPERT_SOURCE_MAX_AUTHORS = 16
/** 单条作者名长度上限（字符）。 */
export const EXPERT_AUTHOR_MAX_CHARS = 200
/** 单次安装最多新增的 skill 数。 */
export const EXPERT_SKILL_MAX_INSTALLS = 8
/** skills 需求里 action=reuse 的条数上限。 */
export const EXPERT_SKILL_MAX_REUSES = 16
/** skills 需求总条数上限。 */
export const EXPERT_SKILL_MAX_REQUIREMENTS = 24
/** 单个 SKILL.md 正文上限（UTF-16 单元）。 */
export const EXPERT_SKILL_BODY_MAX_CHARS = 20000
/** 人格资源相对路径的最大层数（与现有附件遍历契约对齐）。 */
export const EXPERT_RESOURCE_MAX_DEPTH = 4
/** 方法论修复的最大尝试次数。 */
export const EXPERT_METHODOLOGY_MAX_ATTEMPTS = 3
/** 手动 request 的有效期（毫秒，自创建起 30 分钟）。 */
export const EXPERT_MANUAL_REQUEST_TTL_MS = 30 * 60 * 1000
/** 子代理单次最长运行时间（毫秒，10 分钟）。 */
export const EXPERT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000
/** 每个父会话最多同时进行的专家调用数。 */
export const EXPERT_MAX_CONCURRENT_PER_SESSION = 1
/** 每个插件实例最多同时进行的专家调用数。 */
export const EXPERT_MAX_CONCURRENT_TOTAL = 2
/** 回传给父会话的文本上限（UTF-16 单元）。 */
export const EXPERT_CHILD_RESULT_MAX_CHARS = 12000
/** 专家相关公共 HTTP JSON body 上限（字节）——复用 `readJsonBody` 的既有机制，不放宽全局上限。 */
export const EXPERT_HTTP_BODY_MAX_BYTES = 256 * 1024
/** 子代理 provider 固定值（本期只走 spawn）。 */
export const EXPERT_PROVIDER_CODE = 'spawn'

/** `sourceId` 形状：`[a-z0-9][a-z0-9-]{0,47}`。 */
export const EXPERT_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
/** `skillName` 形状：小写 kebab-case，1–64 字符。 */
export const EXPERT_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** `skillName` 长度上限（字符）。 */
export const EXPERT_SKILL_NAME_MAX_CHARS = 64
/** 标准小写 UUID 字符串（draftId / expertUuid）。 */
export const EXPERT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** 40 位小写 git SHA（`commit` 字段的形状）。 */
export const EXPERT_COMMIT_PATTERN = /^[0-9a-f]{40}$/
/** 本期唯一允许的许可标识。 */
export const EXPERT_ALLOWED_LICENSE = 'MIT'
/** MIT 许可原文地址（校验依据，不做联网核验）。 */
export const EXPERT_LICENSE_REFERENCE_URL = 'https://opensource.org/license/mit'

/** 文本扩展名白名单（与 `PERSONA_RESOURCE_EXTENSIONS` 同源，这里只做类型侧引用声明）。 */
export const EXPERT_TEXT_EXTENSIONS = [
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.ts', '.js', '.mjs', '.py', '.ps1',
] as const

// ---------------------------------------------------------------------------
// 构造判别（uuid / sourceId / skillName）—— 只有"长得对不对"，不碰文件系统
// ---------------------------------------------------------------------------

/** `draftId` / `expertUuid` 是否形如标准小写 UUID。 */
export function isExpertUuid(value: unknown): value is string {
  return typeof value === 'string' && EXPERT_UUID_PATTERN.test(value)
}

/** `expertId` 必须是 `generated/<UUID>`（generated 段固定，ID 只由服务端产生）。 */
export function isExpertId(value: unknown): value is string {
  if (typeof value !== 'string' || value.startsWith(`${EXPERT_GENERATED_DIR_NAME}/`) === false) return false
  return isExpertUuid(value.slice(EXPERT_GENERATED_DIR_NAME.length + 1))
}

/** 由 UUID 得到 `expertId`（**唯一**一处拼法）。 */
export function expertIdFromUuid(uuid: string): string {
  return `${EXPERT_GENERATED_DIR_NAME}/${uuid}`
}

/** `expertId` → UUID；形状不对返回 `undefined`。 */
export function expertUuidFromId(expertId: unknown): string | undefined {
  return isExpertId(expertId) ? (expertId as string).slice(EXPERT_GENERATED_DIR_NAME.length + 1) : undefined
}

/**
 * `sourceId` 形状判定：`[a-z0-9]` 开头，其后 `[a-z0-9-]`，总长 1–48。
 *
 * **为什么不用 `EXPERT_SOURCE_ID_PATTERN.test()`**：形状模式与「长度上界」是**两件事**，
 * 而这个函数必须同时保证两者。`/^[a-z0-9][a-z0-9-]{0,47}$/` 只表达形状，长度上界
 * （48）在模式里只是个巧合数字；一旦有人改常量而忘了改模式，两者就会静默分叉。
 * 所以这里把两件事放在**同一处**逐字符判定：长度用常量判、形状逐字符判 ——
 * 只有一份权威判据，改常量就必然改到判定本身。
 * `EXPERT_SOURCE_ID_PATTERN` / `EXPERT_SKILL_NAME_PATTERN` 仍导出（供阅读与扫描测试），
 * 但**判定全部走下面这两个函数**。
 */
export function isExpertSourceId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 48) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isLowerAlpha = code >= 0x61 && code <= 0x7a
    const isDigit = code >= 0x30 && code <= 0x39
    if (isLowerAlpha || isDigit) continue
    if (index > 0 && code === 0x2d) continue
    return false
  }
  return true
}

/**
 * `skillName` 形状判定（小写 kebab-case，1–64 字符）。
 *
 * 同样把「形状」与「长度上界（`EXPERT_SKILL_NAME_MAX_CHARS`）」放在同一处判定
 * （理由见 `isExpertSourceId` 的注释）：每个 `-` 分段必须非空且全为 `[a-z0-9]`，
 * 即不允许开头/结尾/连续连字符。
 */
export function isExpertSkillName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > EXPERT_SKILL_NAME_MAX_CHARS) return false
  let segmentLength = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const isLowerAlpha = code >= 0x61 && code <= 0x7a
    const isDigit = code >= 0x30 && code <= 0x39
    if (isLowerAlpha || isDigit) {
      segmentLength += 1
      continue
    }
    if (code === 0x2d && segmentLength > 0) {
      segmentLength = 0
      continue
    }
    return false
  }
  return segmentLength > 0
}

// ---------------------------------------------------------------------------
// §3.2 类型
// ---------------------------------------------------------------------------

/** 专家的创作方式：翻译 / 改编 / 合并 / 原创。 */
export type ExpertCreationKind = 'translated' | 'adapted' | 'merged' | 'original'

/** `pending` 草稿的内部阶段（**不是**外层状态）。 */
export type ExpertDraftPhase = 'editing' | 'validated' | 'installing' | 'install-failed'

/** 暂存文件属于哪一块。 */
export type ExpertFileArea = 'persona-resource' | 'skill'

/** 一条被复制素材的来源登记。 */
export interface ExpertSource {
  /** `[a-z0-9][a-z0-9-]{0,47}`。 */
  id: string
  /** HTTPS 仓库首页；不得带 token、userinfo、query/hash。 */
  repository: string
  /** 上游路径；不得是绝对路径或含 `..`。 */
  upstreamPath: string
  /** 确实取得的 40 位 git SHA；取不到写 `null`（配 `source-commit-unknown` 警告）。 */
  commit: string | null
  /** 可解析的 ISO 时间。 */
  fetchedAt: string
  /** 1–16 条，每条 1–200 字符。 */
  authors: string[]
  /** 本期只允许 `MIT`。 */
  license: 'MIT'
  /** 版权声明原文本（非空）。 */
  copyrightNotice: string
  /** 本人格附件内 `sources/<id>/LICENSE.txt`。 */
  licenseFile: string
  /** 这份素材被用在哪：人格正文 / skill 包。 */
  usedFor: ('persona' | 'skill')[]
  /** 改了什么；不能只写"有修改"。 */
  modifications: string
}

/** 只作背景阅读的引用（原文被复制或实质改写就不该出现在这里）。 */
export interface ExpertReference {
  title: string
  url: string
  use: 'background-only'
}

/** 人格的来源登记整体。 */
export interface ExpertProvenance {
  version: 1
  creationKind: ExpertCreationKind
  /** 0–8；`original` 可为 0，其他分支至少 1。 */
  sources: ExpertSource[]
  references: ExpertReference[]
  generationNote: string
}

/** 一条 skill 需求。 */
export interface ExpertSkillRequirement {
  name: string
  required: boolean
  action: 'install' | 'reuse'
  /** `install` 必须关联 `usedFor` 含 `skill` 的来源；`reuse` 为 `null`。 */
  sourceId: string | null
  /** `install` 的完整声明相对文件清单（相对该 skill 根）；`reuse` 固定 `[]`。 */
  packageFiles: string[]
  reason: string
}

/** 暂存文件索引里的一条（sha256 按实际写入字节算）。 */
export interface ExpertStagedFile {
  area: ExpertFileArea
  /** `persona-resource`：相对附件根；`skill`：`<name>/<相对路径>`。 */
  path: string
  bytes: number
  sha256: string
}

/** 一条字段级问题。`code` 只能是 `ExpertErrorCode` 或既有 `PersonaDiagnosticCode`。 */
export interface ExpertIssue {
  code: string
  field: string
  message: string
}

/** 一次校验的结果快照。 */
export interface ExpertValidation {
  /** 哪一版草稿被校验（= 当时的 contentVersion）。 */
  version: number
  manifestHash: string
  checkedAt: string
  errors: ExpertIssue[]
  warnings: ExpertIssue[]
}

/** 安装成功后回填到草稿里的结果。 */
export interface ExpertInstallResult {
  kind: 'expert'
  draftId: string
  expertId: string
  manifestHash: string
  installedAt: string
  installedSkills: string[]
  reusedSkills: string[]
  warnings: ExpertIssue[]
}

/** `task_drafts.payload_json` 的形状。 */
export interface ExpertDraftPayload {
  version: 1
  /** 初始 0，每次成功变更 +1。 */
  contentVersion: number
  /** `generated/<UUID>`。 */
  expertId: string
  /** 1–2000 字符。 */
  request: string
  phase: ExpertDraftPhase
  /** 初始为空；提交成功才填。 */
  personaMd: string
  provenance: ExpertProvenance | null
  skills: ExpertSkillRequirement[]
  files: ExpertStagedFile[]
  validation: ExpertValidation | null
  lastInstallError: ExpertIssue | null
  /** 安装器写；其余路径不得覆盖。 */
  confirmResult?: ExpertInstallResult
}

/** 已安装 skill 的管理文件。 */
export interface WorkbenchSkillInstall {
  version: 1
  name: string
  expertId: string
  /** = draftId。 */
  installationId: string
  /** 按 files（排除管理文件自身）与 SKILL.md 解析元数据计算；路径相对 skill 根。 */
  packageHash: string
  files: Array<{ path: string; bytes: number; sha256: string }>
}

/** 安装日志里登记的一条已发布路径。 */
export interface ExpertPublishedPath {
  area: 'persona-document' | 'persona-directory' | 'skill-directory'
  /** 相对对应 personas / skills 根；目录**不带**尾部 `/`。 */
  path: string
  files: Array<{ path: string; bytes: number; sha256: string }>
}

/** 安装/回滚的持久日志（`personas/.pending/<draftId>/install-journal.json`）。 */
export interface ExpertInstallJournal {
  version: 1
  ownerDbKey: string
  draftId: string
  expertId: string
  manifestHash: string
  phase: 'prepared' | 'files-published' | 'db-committed' | 'ready' | 'rolling-back' | 'rolled-back' | 'repair-required'
  createdPaths: ExpertPublishedPath[]
  reusedPaths: ExpertPublishedPath[]
  result: ExpertInstallResult | null
}

/** settings 里专家相关的一段（`readExpertSettings` 的返回）。 */
export interface ExpertSettings {
  autoSummonExperts: boolean
}
