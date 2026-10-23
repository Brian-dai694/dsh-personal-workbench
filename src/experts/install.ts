/**
 * 专家安装（确认）主链 —— 规格 §6.3（锁与日志）/ §6.4（确认算法 12 步）/ §6.5（失败与恢复）。
 *
 * ## 这一层解决的唯一问题
 *
 * 把一份**已校验**的专家草稿（人格正文 + 来源登记 + 技能包）从 `.pending/<draftId>/` 的暂存区，
 * 变成用户根下可被解析器/技能服务看见的正式文件，并且**在任何一步被打断之后**都能判定
 * "现在到底算装好了没有"。
 *
 * `publication.json` 是那个判定的唯一依据（见 `src/personas/managed.ts` 的长注释）：
 * 它在**最后**写，所以"看得见"与"确认过"是同一件事。
 *
 * ## 七条不可让步的性质
 *
 * 1. **构建件从暂存原件复制，绝不移动原件**：`.pending/<draftId>/.build-persona` 与
 *    `.pending/<draftId>/.build/<skillName>` 是**临时**的；唯一的那份暂存内容是重试的
 *    本钱，被 rename 走之后就再也装不成第二次了（§6.3 末段）。
 * 2. **每个正式目标都要二次核对**：`rename` 之前再 `lstat` 一次目标；已存在就不动它，
 *    同名技能内容哈希不同一律 `skill-conflict`（AX-E18：旧 skill 的字节必须一个不变）。
 * 3. **日志先写、再动文件**，且每次更新都保留上一份**可解析**的备份：日志是"我动过哪些
 *    文件"的唯一凭据；先动文件再写日志会让崩溃点变成无人认领的垃圾。
 * 4. **只有 DB 说 confirmed 才算确认**：`BEGIN IMMEDIATE` 短事务里 CAS 同版本 + 同状态，
 *    0 行即冲突。事务里不做任何文件/网络操作（`ROLLBACK` 不会撤销文件）。
 * 5. **补偿只删自己登记过的、且内容哈希完全一致的东西**：额外文件、被改过的文件、
 *    别人复用的共享 skill —— 一律不删，转 `install-repair-required` 让人来判。
 * 6. **ownerDbKey 决定"这份日志是不是我的"**：两个 profile 可以共享两个用户库根而用
 *    不同的 DB；别人的日志只跳过，绝不当"未提交"去补偿删除（§6.3）。
 * 7. **中断即补偿，补偿后可重试**：命中失败时草稿落 `install-failed`（仍在 `pending` 外层），
 *    暂存原件一个字节都不动，所以"用同一个 contentVersion 再来一次"永远是可行路径。
 *
 * ## 边界
 *
 * 生产入口**不暴露任何 failpoint 参数**：故障点只能通过构造上下文时注入的
 * `context.failpoint` 给测试用（`ExpertInstallContext` 由接线层构造，模型/HTTP 都碰不到）。
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  EXPERT_DRAFT_PAYLOAD_VERSION,
  EXPERT_GENERATED_DIR_NAME,
  EXPERT_INSTALL_JOURNAL_FILE_NAME,
  EXPERT_INSTALL_JOURNAL_VERSION,
  EXPERT_JOURNAL_PREVIOUS_NAME,
  EXPERT_PENDING_DIR_NAME,
  EXPERT_PUBLICATION_FILE_NAME,
  EXPERT_PUBLICATION_VERSION,
  EXPERT_PROVENANCE_FILE_NAME,
  EXPERT_RESERVED_FILE_NAMES,
  EXPERT_SKILL_INSTALL_FILE_NAME,
  EXPERT_SKILL_INSTALL_VERSION,
  EXPERT_STAGED_FILE_MAX_BYTES,
  expertUuidFromId,
  isExpertErrorCode,
  isExpertId,
  isExpertSkillName,
  isExpertUuid,
  type ExpertDraftPayload,
  type ExpertErrorCode,
  type ExpertFileArea,
  type ExpertInstallJournal,
  type ExpertInstallResult,
  type ExpertIssue,
  type ExpertPublishedPath,
  type ExpertStagedFile,
  type WorkbenchSkillInstall,
} from '../shared/expert.js'
import {
  commitExpertDraftInstallation,
  getExpertDraft,
  transitionExpertDraftInstall,
} from '../db/repo/experts.js'
import { managedPublicationRelativePath, readManagedSkillInstallState } from '../personas/managed.js'
import {
  acquireExpertInstallLock,
  atomicWriteText,
  readExpertTextFile,
  validateExpertRelativePath,
  type ExpertRoots,
} from './paths.js'
import {
  expertDraftCurrentVersion,
  expertRepoFailure,
  expertStagedRelativePath,
  validateExpertDraft,
  withExpertDraftMutex,
  type ExpertDraftContext,
  type ExpertDraftFailpoint,
  type ExpertOperationFailure,
} from './drafts.js'
import { isSha256Hex, sha256Hex } from './provenance.js'
import {
  validateWorkbenchSkillPackage,
  type WorkbenchSkillExistingInstall,
  type WorkbenchSkillPackageFile,
  type WorkbenchSkillRegistry,
} from './skill-package.js'

// ---------------------------------------------------------------------------
// 故障注入点（只为测试存在）
// ---------------------------------------------------------------------------

/**
 * 安装期的故障点。名字刻意是"**在谁之前/之后**"而不是"第几步"：
 * 步骤号会在实现里漂移，而"这是刚刚 publish 完 X 的那一刻"是稳定语义。
 */
export type ExpertInstallFailpoint =
  | 'install.after-validation'
  | 'install.before-prepared-journal'
  | 'install.after-prepared-journal'
  | 'install.before-persona-directory'
  | 'install.after-persona-directory'
  | 'install.before-skill-directory'
  | 'install.after-skill-directory'
  | 'install.before-persona-document'
  | 'install.after-persona-document'
  | 'install.before-files-published-journal'
  | 'install.after-files-published-journal'
  | 'install.before-db-commit'
  | 'install.after-db-commit'
  | 'install.before-publication'
  | 'install.after-publication'
  | 'install.before-provider-refresh'
  | 'install.after-ready-journal'

// ---------------------------------------------------------------------------
// 上下文与返回形状
// ---------------------------------------------------------------------------

/** 锁的测试注入点（生产一律走 `paths.ts` 的默认实现）。 */
export interface ExpertInstallLockInjections {
  isProcessAlive?: (pid: number) => boolean | undefined
  pid?: number
  hostname?: string
}

export interface ExpertInstallContext {
  db: DatabaseSync
  roots: ExpertRoots
  /** 根自己是链接时的包含边界（构造参数注入；不传 = 根是链接就 fail-closed）。 */
  allowRootLinkUnder?: string
  platform?: string
  now?: () => string
  failpoint?: (point: ExpertDraftFailpoint | ExpertInstallFailpoint) => void
  /**
   * 归属身份（§6.3）。不传就按 DB 解析：`PRAGMA database_list` 的 `main.file` →
   * 绝对 + NFC + Windows 大小写归一 → SHA-256；内存 DB 用**本进程该实例**的随机 UUID。
   *
   * 测试注入固定值，这样"两个 DB 共享同一个根"可以被稳定复现。
   */
  ownerDbKey?: string
  /** 工作台技能 provider 刷新（P4 注册真实实现）。抛错只写 warning，绝不撤销已持久安装。 */
  refreshSkills?: () => void
  /** skills 服务投影（reuse 判定）；没有服务就不传，不伪造一个假服务。 */
  skills?: WorkbenchSkillRegistry
  lock?: ExpertInstallLockInjections
}

export interface ExpertConfirmInput {
  draftId: unknown
  expectedVersion: unknown
  /**
   * 调用方手里那份校验结果的 `manifestHash`（§6.4 第 3 步）。
   * 不传/为空时退回草稿上 `validation.manifestHash` —— 但**校验仍会重新执行**，
   * "只看绿勾就确认"在这条路径上不可达。
   */
  expectedManifestHash?: unknown
  /**
   * 真实执行会话 id。**给了（含 `null`）就强制走 owner 守卫**；
   * 完全不传这个键 = HTTP 用户确认路径（浏览器没有 live Agent 身份）。
   */
  sessionId?: unknown
}

export interface ExpertInstallSuccess {
  ok: true
  result: ExpertInstallResult
  /** `true` = 本次**没有新建**任何正式文件（幂等回放或恢复补齐）。 */
  replayed: boolean
}

export type ExpertConfirmResult = ExpertInstallSuccess | ExpertOperationFailure

// ---------------------------------------------------------------------------
// 内部：失败载体（只在 install.ts 内部抛/接，出口一律是 ok:false 对象）
// ---------------------------------------------------------------------------

class InstallFailure extends Error {
  readonly code: ExpertErrorCode
  readonly field: string
  readonly errors?: ExpertIssue[]

  constructor(code: ExpertErrorCode, field: string, message: string, errors?: ExpertIssue[]) {
    super(message)
    this.name = 'InstallFailure'
    this.code = code
    this.field = field
    if (errors !== undefined) this.errors = errors
  }
}

function fail(code: ExpertErrorCode, field: string, message: string, errors?: ExpertIssue[]): never {
  throw new InstallFailure(code, field, message, errors)
}

function failure(
  code: ExpertErrorCode,
  field: string,
  message: string,
  errors?: ExpertIssue[],
  currentVersion?: number,
): ExpertOperationFailure {
  return {
    ok: false,
    code,
    field,
    message,
    ...(errors === undefined ? {} : { errors }),
    ...(currentVersion === undefined ? {} : { currentVersion }),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

// ---------------------------------------------------------------------------
// ownerDbKey（§6.3）
// ---------------------------------------------------------------------------

const ownerKeyCache = new WeakMap<object, string>()

/**
 * 「绝对 + NFC + Windows 大小写归一」的路径规范化。
 *
 * **这个值只用来取 SHA-256**：绝对路径既不进 journal，也不进任何 HTTP 响应
 * （`~/.dsh/...` 里可能带用户名，是隐私；而且换机器就该对不上）。
 */
export function canonicalDatabasePath(file: string): string {
  const absolute = resolve(file).normalize('NFC')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function computeOwnerDbKey(db: DatabaseSync): string {
  let file: unknown
  try {
    const rows = db.prepare('PRAGMA database_list').all() as Array<Record<string, unknown>>
    const main = rows.find((row) => row.name === 'main')
    if (main !== undefined) file = main.file
  } catch {
    file = undefined
  }
  if (typeof file !== 'string' || file.trim() === '') {
    /** 内存 DB：没有可比对的路径，用**该实例**的随机身份（同进程内稳定、跨进程必然不同）。 */
    return `memory:${randomUUID()}`
  }
  return sha256Hex(canonicalDatabasePath(file))
}

/** 取本次上下文所属的 DB 身份（注入值优先；同一 DB 实例的结果会被缓存）。 */
export function ownerDbKeyFor(context: ExpertInstallContext): string {
  if (typeof context.ownerDbKey === 'string' && context.ownerDbKey !== '') return context.ownerDbKey
  const key = context.db as unknown as object
  const cached = ownerKeyCache.get(key)
  if (cached !== undefined) return cached
  const computed = computeOwnerDbKey(context.db)
  ownerKeyCache.set(key, computed)
  return computed
}

// ---------------------------------------------------------------------------
// 路径：唯一一处拼安装期路径
// ---------------------------------------------------------------------------

function personasRootOf(context: ExpertInstallContext): string {
  return context.roots.personasDir
}

function skillsRootOf(context: ExpertInstallContext): string {
  return context.roots.skillsDir
}

function rootForPublishedArea(context: ExpertInstallContext, area: ExpertPublishedPath['area']): string {
  return area === 'skill-directory' ? skillsRootOf(context) : personasRootOf(context)
}

/** 把 `a/b/c` 形式的相对路径拼成绝对路径（跨平台用 `join`，不手写分隔符）。 */
function absoluteJoin(root: string, relative: string): string {
  return join(root, ...relative.split('/'))
}

/** `.pending/<draftId>`（相对 personas / skills 根）。 */
function pendingRelative(draftId: string): string {
  return `${EXPERT_PENDING_DIR_NAME}/${draftId}`
}

/** 人格附件目录的构建目录（相对 personas 根）。 */
function personaBuildRelative(draftId: string): string {
  return `${pendingRelative(draftId)}/.build-persona`
}

/** 技能包的构建目录（相对 skills 根）。 */
function skillBuildRelative(draftId: string, name: string): string {
  return `${pendingRelative(draftId)}/.build/${name}`
}

function journalRelative(draftId: string, previous = false): string {
  const name = previous ? EXPERT_JOURNAL_PREVIOUS_NAME : EXPERT_INSTALL_JOURNAL_FILE_NAME
  return `${pendingRelative(draftId)}/${name}`
}

function linkOptions(context: ExpertInstallContext): { allowRootLinkUnder?: string } {
  return context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }
}

function platformOptions(context: ExpertInstallContext): { platform?: string } {
  return context.platform === undefined ? {} : { platform: context.platform }
}

/**
 * 安装器写正式文件时**必须**放宽保留名（`publication.json` / `provenance.json` /
 * `workbench-install.json` / `install-journal.json`）。
 *
 * 这不是"给模型开了后门"：`allowReservedNames` 只在**本文件的校验**里传 ——
 * 暂存工具（`drafts.ts`）与来源校验从来不带它，所以模型侧依旧写不了保留名。
 */
function installerReservedNames(): readonly string[] {
  return EXPERT_RESERVED_FILE_NAMES
}

/** `generated/<uuid>` 形状（目录 entry 的 path）。 */
function isPersonaDirectoryRelativePath(path: string): boolean {
  const prefix = `${EXPERT_GENERATED_DIR_NAME}/`
  if (path.startsWith(prefix) === false) return false
  return isExpertUuid(path.slice(prefix.length))
}

/** `generated/<uuid>.md` 形状（文档 entry 的 path，也是它的文件名）。 */
function isPersonaDocumentRelativePath(path: string): boolean {
  if (path.endsWith('.md') === false) return false
  return isExpertId(path.slice(0, -3))
}

// ---------------------------------------------------------------------------
// 计划（§6.4 第 5–7 步要发布的全部东西，全在内存里先算清楚）
// ---------------------------------------------------------------------------

interface DraftedFile {
  /** 相对所在目录的相对路径（文档 entry 里就是它自己相对根的路径）。 */
  path: string
  content: string
  bytes: number
  sha256: string
}

interface PlannedPath {
  area: ExpertPublishedPath['area']
  /** 相对对应根；目录不带尾部 `/`。 */
  path: string
  /** 目录：目录内相对路径；文档：单条。 */
  files: DraftedFile[]
  /** 允许存在的、不属于本计划的文件（安装器自己写的管理文件）。 */
  allowedExtras: readonly string[]
}

interface PlanEntry extends PlannedPath {
  /** `create` = 本次新建；`keep-owned` = 已在位且可证明属于本专家（不重写）。 */
  disposition: 'create' | 'keep-owned'
}

interface SharedSkillReuse {
  area: 'skill-directory'
  path: string
  files: DraftedFile[]
}

interface InstallPlan {
  draftId: string
  expertId: string
  uuid: string
  manifestHash: string
  /** 按发布顺序：人格附件目录 → 技能目录 → 人格文档。 */
  entries: PlanEntry[]
  /** 本次**复用**的共享技能（只进 reusedPaths，绝不删除）。 */
  sharedSkills: SharedSkillReuse[]
  /** 已存在一份 ready 的 publication.json（恢复补齐：跳过发布，直接进 DB 提交）。 */
  publicationAlreadyReady: boolean
  warnings: ExpertIssue[]
}

function draftedFromText(path: string, content: string): DraftedFile {
  return { path, content, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha256Hex(content) }
}

/** 只带"账本"信息的文件（登记核对用，不含正文）。 */
function toLedgerFile(file: DraftedFile): { path: string; bytes: number; sha256: string } {
  return { path: file.path, bytes: file.bytes, sha256: file.sha256 }
}

interface VerifiedStaged {
  file: ExpertStagedFile
  text: string
  bytes: number
  sha256: string
}

function stagedKey(area: ExpertFileArea, path: string): string {
  return `${area}\u0000${path}`
}

/**
 * 按索引把暂存原件**重读一遍**并核对哈希（索引只是账本，磁盘才是事实）。
 *
 * 与 `validateExpertDraft` 第 4 步的区别只有一个：那里判"能不能确认"，这里还要把
 * **正文内容**带出来给安装器复制。两处都在同一份索引上核对哈希 —— 校验通过之后、
 * 复制之前磁盘仍可能被改（这正是 `staged-file-changed` 的用途）。
 */
function readVerifiedStaged(
  context: ExpertInstallContext,
  draftId: string,
  payload: ExpertDraftPayload,
): Map<string, VerifiedStaged> {
  const verified = new Map<string, VerifiedStaged>()
  for (const file of Array.isArray(payload.files) ? payload.files : []) {
    const field = `files.${file.area}:${file.path}`
    const shape = validateExpertRelativePath(file.area, file.path, platformOptions(context))
    if (shape !== undefined) fail('invalid-path', field, `暂存索引里的路径已不合法：${shape.message}`)
    const root = file.area === 'skill' ? skillsRootOf(context) : personasRootOf(context)
    const read = readExpertTextFile(root, expertStagedRelativePath(file.area, draftId, file.path), {
      maxBytes: EXPERT_STAGED_FILE_MAX_BYTES,
      ...linkOptions(context),
    })
    if (read.ok === false || read.text === undefined || read.sha256 === undefined || read.bytes === undefined) {
      fail(
        'staged-file-changed',
        field,
        `暂存原件读不回来（${read.problem?.message ?? '未知原因'}）；安装不会消耗它，但读不到就不能发布，请按当前 contentVersion 重新 stage`,
      )
    }
    if (read.sha256 !== file.sha256 || read.bytes !== file.bytes) {
      fail(
        'staged-file-changed',
        field,
        `暂存原件与索引不一致（索引 ${file.bytes} 字节 / ${String(file.sha256).slice(0, 12)}…，磁盘 ${read.bytes} 字节 / ${read.sha256.slice(0, 12)}…）；不自动确认，请重新 stage`,
      )
    }
    verified.set(stagedKey(file.area, file.path), { file, text: read.text, bytes: read.bytes, sha256: read.sha256 })
  }
  return verified
}

/** 目录当前的文件清单（相对目录；含未登记文件）。只读，遇到链接/特殊文件就拒。 */
function listRelativeFiles(
  root: string,
  dirRelative: string,
  maxDepth = 8,
): { ok: true; files: string[] } | { ok: false; message: string } {
  const base = absoluteJoin(root, dirRelative)
  const out: string[] = []
  const walk = (dir: string, prefix: string, depth: number): string | undefined => {
    if (depth > maxDepth) return `目录层数超过 ${maxDepth}：${prefix}`
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return `目录读不到：${prefix}（${errorText(error)}）`
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) return `目录里有符号链接/junction（第三方内容），拒绝对它做任何处理：${relative}`
      if (entry.isDirectory()) {
        const problem = walk(join(dir, entry.name), relative, depth + 1)
        if (problem !== undefined) return problem
        continue
      }
      if (entry.isFile()) {
        out.push(relative)
        continue
      }
      return `目录里有非普通文件条目：${relative}`
    }
    return undefined
  }
  const problem = walk(base, '', 1)
  if (problem !== undefined) return { ok: false, message: problem }
  return { ok: true, files: out }
}

interface VerifyOk { ok: true }
interface VerifyProblem { ok: false; code: ExpertErrorCode; message: string }

/**
 * 核对一份已发布内容与登记逐字节一致，且**没有登记外的文件**（§3.2 末段）。
 *
 * 登记外的文件一律视为"第三方新增内容"，绝不递归删除；这里只负责把它报出来。
 */
function verifyPublished(context: ExpertInstallContext, entry: PlannedPath): VerifyOk | VerifyProblem {
  const root = rootForPublishedArea(context, entry.area)
  if (entry.area === 'persona-document') {
    const file = entry.files[0]
    if (file === undefined) return { ok: false, code: 'install-repair-required', message: `登记里没有文档内容：${entry.path}` }
    const read = readExpertTextFile(root, entry.path, { maxBytes: EXPERT_STAGED_FILE_MAX_BYTES, ...linkOptions(context) })
    if (read.ok === false || read.sha256 === undefined || read.bytes === undefined) {
      return {
        ok: false,
        code: 'install-repair-required',
        message: `正式人格文档读不回来：${entry.path}（${read.problem?.message ?? '未知原因'}）`,
      }
    }
    if (read.sha256 !== file.sha256 || read.bytes !== file.bytes) {
      return {
        ok: false,
        code: 'install-repair-required',
        message: `正式人格文档与登记不一致（磁盘 ${read.bytes} 字节 / ${read.sha256.slice(0, 12)}…，登记 ${file.bytes} 字节 / ${file.sha256.slice(0, 12)}…）：${entry.path}`,
      }
    }
    return { ok: true }
  }

  for (const file of entry.files) {
    const relative = `${entry.path}/${file.path}`
    const read = readExpertTextFile(root, relative, { maxBytes: EXPERT_STAGED_FILE_MAX_BYTES, ...linkOptions(context) })
    if (read.ok === false || read.sha256 === undefined || read.bytes === undefined) {
      return { ok: false, code: 'install-repair-required', message: `正式文件读不回来：${relative}（${read.problem?.message ?? '未知原因'}）` }
    }
    if (read.sha256 !== file.sha256 || read.bytes !== file.bytes) {
      return {
        ok: false,
        code: 'install-repair-required',
        message: `正式文件与登记不一致（被第三方改过？）：${relative}（磁盘 ${read.bytes} 字节 / ${read.sha256.slice(0, 12)}…，登记 ${file.bytes} 字节 / ${file.sha256.slice(0, 12)}…）`,
      }
    }
  }

  const listed = listRelativeFiles(root, entry.path)
  if (listed.ok === false) return { ok: false, code: 'install-repair-required', message: `${entry.path}：${listed.message}` }
  const planned = new Set(entry.files.map((file) => file.path))
  const allowed = new Set(entry.allowedExtras)
  const extras = listed.files.filter((file) => planned.has(file) === false && allowed.has(file) === false)
  if (extras.length > 0) {
    return {
      ok: false,
      code: 'install-repair-required',
      message: `正式目录里有登记外的文件（第三方新增内容，不递归删除）：${extras.map((file) => `${entry.path}/${file}`).join('、')}`,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// journal（§6.3）
// ---------------------------------------------------------------------------

interface JournalState {
  journal: ExpertInstallJournal
  /** 主文件坏了、用的是 `journal.previous.json` 备份。 */
  degraded: boolean
}

export type ExpertJournalRead =
  | { ok: true; state: JournalState }
  | { ok: false; reason: 'missing' | 'corrupt'; message: string }

const JOURNAL_PHASES: readonly ExpertInstallJournal['phase'][] = [
  'prepared', 'files-published', 'db-committed', 'ready', 'rolling-back', 'rolled-back', 'repair-required',
]

/**
 * 校验日志里登记的一条路径。
 *
 * §3.2 末段要求"日志里的 paths 也要重新过路径边界检查" —— **目录**形状与**文件**形状
 * 要分开判：`generated/<uuid>` 与 `<skillName>` 本来就不带文本扩展名，用文件那套
 * 尺子去量目录必然误判。
 */
function parsePublishedPaths(raw: unknown, field: string, problems: string[]): ExpertPublishedPath[] {
  if (Array.isArray(raw) === false) {
    problems.push(`${field} 不是数组`)
    return []
  }
  const out: ExpertPublishedPath[] = []
  for (const [index, item] of raw.entries()) {
    if (isPlainObject(item) === false) {
      problems.push(`${field}[${index}] 不是对象`)
      continue
    }
    const area = item.area
    if (area !== 'persona-document' && area !== 'persona-directory' && area !== 'skill-directory') {
      problems.push(`${field}[${index}].area 非法：${JSON.stringify(area)}`)
      continue
    }
    if (typeof item.path !== 'string' || item.path === '') {
      problems.push(`${field}[${index}].path 不是非空字符串`)
      continue
    }
    const path = item.path
    if (area === 'persona-document' && isPersonaDocumentRelativePath(path) === false) {
      problems.push(`${field}[${index}].path 不是 generated/<UUID>.md：${path}`)
      continue
    }
    if (area === 'persona-directory' && isPersonaDirectoryRelativePath(path) === false) {
      problems.push(`${field}[${index}].path 不是 generated/<UUID>：${path}`)
      continue
    }
    if (area === 'skill-directory' && isExpertSkillName(path) === false) {
      problems.push(`${field}[${index}].path 不是合法 skill 名：${path}`)
      continue
    }

    const filesRaw = item.files
    if (Array.isArray(filesRaw) === false) {
      problems.push(`${field}[${index}].files 不是数组`)
      continue
    }
    if (area === 'persona-document' && filesRaw.length !== 1) {
      problems.push(`${field}[${index}].files 必须恰好一条（人格文档只有一个文件）`)
      continue
    }
    const files: Array<{ path: string; bytes: number; sha256: string }> = []
    let filesOk = true
    for (const [fileIndex, file] of filesRaw.entries()) {
      if (isPlainObject(file) === false
        || typeof file.path !== 'string' || file.path === ''
        || typeof file.bytes !== 'number' || Number.isInteger(file.bytes) === false || file.bytes < 0
        || typeof file.sha256 !== 'string' || isSha256Hex(file.sha256) === false) {
        problems.push(`${field}[${index}].files[${fileIndex}] 形状不对`)
        filesOk = false
        continue
      }
      const filePath = file.path
      if (area === 'persona-document') {
        if (filePath !== path) {
          problems.push(`${field}[${index}].files[${fileIndex}].path 必须与 entry 的 path 相同：${filePath}`)
          filesOk = false
        }
        continue
      }
      const expanded = area === 'skill-directory' ? `${path}/${filePath}` : filePath
      const shape = validateExpertRelativePath(area === 'skill-directory' ? 'skill' : 'persona-resource', expanded, {
        allowReservedNames: installerReservedNames(),
      })
      if (shape !== undefined) {
        problems.push(`${field}[${index}].files[${fileIndex}].path 不是合法的相对路径：${shape.message}`)
        filesOk = false
      }
    }
    if (filesOk === false) continue
    for (const file of filesRaw as Array<Record<string, unknown>>) {
      files.push({ path: file.path as string, bytes: file.bytes as number, sha256: file.sha256 as string })
    }
    out.push({ area, path, files })
  }
  return out
}

/** 日志的形状守卫（**只认自己认得的版本**，不猜、不迁移）。 */
function parseJournal(raw: string, expectedDraftId: string): { ok: true; journal: ExpertInstallJournal } | { ok: false; message: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    return { ok: false, message: `不是合法 JSON（${errorText(error)}）` }
  }
  if (isPlainObject(parsed) === false) return { ok: false, message: '不是一个 JSON 对象' }
  if (parsed.version !== EXPERT_INSTALL_JOURNAL_VERSION) {
    return { ok: false, message: `version 是 ${JSON.stringify(parsed.version)}，本版只认 ${EXPERT_INSTALL_JOURNAL_VERSION}` }
  }
  if (parsed.draftId !== expectedDraftId) {
    return { ok: false, message: `draftId 是 ${JSON.stringify(parsed.draftId)}，与所在目录 ${expectedDraftId} 不一致` }
  }
  if (isExpertId(parsed.expertId) === false) {
    return { ok: false, message: `expertId 不是 generated/<UUID>：${JSON.stringify(parsed.expertId)}` }
  }
  if (typeof parsed.manifestHash !== 'string' || isSha256Hex(parsed.manifestHash) === false) {
    return { ok: false, message: 'manifestHash 不是 sha256 十六进制串' }
  }
  if (typeof parsed.phase !== 'string' || JOURNAL_PHASES.includes(parsed.phase as ExpertInstallJournal['phase']) === false) {
    return { ok: false, message: `phase 非法：${JSON.stringify(parsed.phase)}` }
  }
  /**
   * `ownerDbKey` **刻意不在这里判**：缺失/空串是一种**可判定的状态**（"不知道是谁的"），
   * 与"日志结构坏了"是两件事 —— 前者只跳过、不删任何文件，后者才转 repair-required。
   * 所以这里只做**归一**：非字符串（字段缺失、null、别的类型）一律当作空串，
   * 由恢复路径统一走 `skipped-owner-unknown`，语义与"空串"完全一致。
   */
  const ownerDbKey = typeof parsed.ownerDbKey === 'string' ? parsed.ownerDbKey : ''

  const problems: string[] = []
  const createdPaths = parsePublishedPaths(parsed.createdPaths, 'createdPaths', problems)
  const reusedPaths = parsePublishedPaths(parsed.reusedPaths, 'reusedPaths', problems)
  if (problems.length > 0) return { ok: false, message: problems.join('；') }
  if (parsed.result !== null && parsed.result !== undefined && isPlainObject(parsed.result) === false) {
    return { ok: false, message: 'result 既不是 null 也不是对象' }
  }

  return {
    ok: true,
    journal: {
      version: EXPERT_INSTALL_JOURNAL_VERSION,
      ownerDbKey,
      draftId: expectedDraftId,
      expertId: parsed.expertId,
      manifestHash: parsed.manifestHash,
      phase: parsed.phase as ExpertInstallJournal['phase'],
      createdPaths,
      reusedPaths,
      result: (parsed.result ?? null) as ExpertInstallResult | null,
    },
  }
}

/**
 * 读一份草稿的安装日志：主文件优先，主文件坏了才用 `journal.previous.json`。
 *
 * 为什么允许"退回备份"：日志是**原子更新**的（临时名 + rename），主文件要么是旧的
 * 完整内容、要么是新的完整内容；连备份都解析不了才意味着真的坏了（转 repair-required）。
 */
export function readExpertInstallJournal(context: ExpertInstallContext, draftId: string): ExpertJournalRead {
  const root = personasRootOf(context)
  const main = readExpertTextFile(root, journalRelative(draftId), { maxBytes: 4 * 1024 * 1024, ...linkOptions(context) })
  if (main.ok && main.text !== undefined) {
    const parsed = parseJournal(main.text, draftId)
    if (parsed.ok) return { ok: true, state: { journal: parsed.journal, degraded: false } }
    const previous = readExpertTextFile(root, journalRelative(draftId, true), { maxBytes: 4 * 1024 * 1024, ...linkOptions(context) })
    if (previous.ok && previous.text !== undefined) {
      const fallback = parseJournal(previous.text, draftId)
      if (fallback.ok) return { ok: true, state: { journal: fallback.journal, degraded: true } }
    }
    return { ok: false, reason: 'corrupt', message: `安装日志坏了（${parsed.message}），且备份也不可用` }
  }

  const previous = readExpertTextFile(root, journalRelative(draftId, true), { maxBytes: 4 * 1024 * 1024, ...linkOptions(context) })
  if (previous.ok && previous.text !== undefined) {
    const fallback = parseJournal(previous.text, draftId)
    if (fallback.ok) return { ok: true, state: { journal: fallback.journal, degraded: true } }
  }
  return { ok: false, reason: 'missing', message: `没有安装日志（${journalRelative(draftId)}）` }
}

/**
 * 原子写一份日志，并把**上一份可解析的**日志留成备份。
 *
 * 顺序很要紧：先备份、再覆盖主文件。反过来会让"主文件写坏"和"备份也写坏"落在同一时刻，
 * 于是两个都解析不了。
 *
 * @throws InstallFailure（只被 `installPlanned` 与 `writeJournalQuietly` 接住）
 */
export function writeExpertInstallJournal(context: ExpertInstallContext, journal: ExpertInstallJournal): void {
  const root = personasRootOf(context)
  const mainRelative = journalRelative(journal.draftId)
  const existing = readExpertTextFile(root, mainRelative, { maxBytes: 4 * 1024 * 1024, ...linkOptions(context) })
  if (existing.ok && existing.text !== undefined && parseJournal(existing.text, journal.draftId).ok) {
    const backup = atomicWriteText(absoluteJoin(root, journalRelative(journal.draftId, true)), existing.text, {
      root,
      ...linkOptions(context),
    })
    if (backup.ok === false) {
      throw new InstallFailure('install-repair-required', 'install-journal', `保留日志备份失败：${backup.problem.message}`)
    }
  }
  const written = atomicWriteText(absoluteJoin(root, mainRelative), `${JSON.stringify(journal, null, 2)}\n`, {
    root,
    ...linkOptions(context),
  })
  if (written.ok === false) {
    throw new InstallFailure('invalid-path', 'install-journal', `写安装日志失败：${written.problem.message}`)
  }
}

/** 补偿/恢复路径上的日志写入：失败只吞掉（否则会拿日志错误盖住原始失败原因）。 */
function writeJournalQuietly(context: ExpertInstallContext, journal: ExpertInstallJournal): void {
  try {
    writeExpertInstallJournal(context, journal)
  } catch {
    /* 补偿已经做完了；日志写不进去由后续 `recover*` 按磁盘现状继续判 */
  }
}

// ---------------------------------------------------------------------------
// 计划构建（纯读；不写任何东西）
// ---------------------------------------------------------------------------

function existingSkillDirectory(
  context: ExpertInstallContext,
  name: string,
  field: string,
): { exists: boolean; state: ReturnType<typeof readManagedSkillInstallState> } {
  const root = skillsRootOf(context)
  let stats
  try {
    stats = lstatSync(absoluteJoin(root, name))
  } catch {
    return { exists: false, state: { managed: false, skillName: name, ready: false } }
  }
  if (stats.isDirectory() === false) {
    fail('skill-conflict', field, `正式 skills 根下已有同名条目「${name}」但不是目录，拒绝覆盖`)
  }
  return { exists: true, state: readManagedSkillInstallState(root, personasRootOf(context), name) }
}

function buildPlan(
  context: ExpertInstallContext,
  draftId: string,
  payload: ExpertDraftPayload,
  manifestHash: string,
): InstallPlan {
  if (isExpertId(payload.expertId) === false) {
    fail('invalid-payload', 'expertId', `草稿的 expertId 不是 generated/<小写UUID>：${JSON.stringify(payload.expertId)}`)
  }
  const uuid = expertUuidFromId(payload.expertId) as string
  const personaDirectory = `${EXPERT_GENERATED_DIR_NAME}/${uuid}`
  const personaDocumentPath = `${personaDirectory}.md`
  const verified = readVerifiedStaged(context, draftId, payload)

  if (payload.provenance === null || payload.provenance === undefined) {
    fail('invalid-payload', 'provenance', '草稿没有来源登记（provenance），无法生成 provenance.json')
  }
  const personaFiles: DraftedFile[] = [
    draftedFromText(EXPERT_PROVENANCE_FILE_NAME, `${JSON.stringify(payload.provenance, null, 2)}\n`),
  ]
  for (const file of Array.isArray(payload.files) ? payload.files : []) {
    if (file.area !== 'persona-resource') continue
    const entry = verified.get(stagedKey(file.area, file.path))
    if (entry === undefined) continue
    personaFiles.push({ path: file.path, content: entry.text, bytes: entry.bytes, sha256: entry.sha256 })
  }
  personaFiles.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  const document: DraftedFile = draftedFromText(personaDocumentPath, payload.personaMd)
  const personaRoot = personasRootOf(context)

  /** ---- 人格附件目录的当前位置 ---- */
  let personaDirectoryExists = false
  let publicationAlreadyReady = false
  try {
    const stats = lstatSync(absoluteJoin(personaRoot, personaDirectory))
    if (stats.isDirectory() === false) {
      fail('install-repair-required', 'persona-directory', `正式位置已有一个同名条目但不是目录，拒绝覆盖：${personaDirectory}`)
    }
    personaDirectoryExists = true
  } catch (error) {
    if (error instanceof InstallFailure) throw error
    personaDirectoryExists = false
  }
  if (personaDirectoryExists) {
    const check = verifyPublished(context, {
      area: 'persona-directory',
      path: personaDirectory,
      files: personaFiles,
      allowedExtras: [EXPERT_PUBLICATION_FILE_NAME],
    })
    if (check.ok === false) {
      fail('install-repair-required', 'persona-directory', `正式目录已存在但与本次计划不一致，不覆盖、不删除：${check.message}`)
    }
    const publicationRead = readExpertTextFile(
      personaRoot,
      `${personaDirectory}/${EXPERT_PUBLICATION_FILE_NAME}`,
      { maxBytes: 64 * 1024, ...linkOptions(context) },
    )
    if (publicationRead.ok && publicationRead.text !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(publicationRead.text) as unknown
      } catch {
        fail('install-repair-required', 'publication', `已存在的 ${personaDirectory}/${EXPERT_PUBLICATION_FILE_NAME} 不是合法 JSON，不覆盖也不删除`)
      }
      if (isPlainObject(parsed) === false || parsed.expertId !== payload.expertId || parsed.ready !== true) {
        fail('install-repair-required', 'publication', `已存在的 ${personaDirectory}/${EXPERT_PUBLICATION_FILE_NAME} 形状/归属不对，不覆盖也不删除`)
      }
      if (parsed.manifestHash !== manifestHash) {
        fail(
          'install-repair-required',
          'publication',
          `已存在的 publication.json 指向另一份 manifestHash（${String(parsed.manifestHash).slice(0, 12)}…），与本次（${manifestHash.slice(0, 12)}…）不一致；不覆盖`,
        )
      }
      publicationAlreadyReady = true
    }
  }

  /** ---- 人格文档的当前位置 ---- */
  const documentRead = readExpertTextFile(personaRoot, personaDocumentPath, {
    maxBytes: EXPERT_STAGED_FILE_MAX_BYTES,
    ...linkOptions(context),
  })
  if (documentRead.ok && documentRead.sha256 !== undefined && documentRead.bytes !== undefined) {
    if (documentRead.sha256 !== document.sha256 || documentRead.bytes !== document.bytes) {
      fail(
        'install-repair-required',
        'persona-directory',
        `正式人格文档 ${personaDocumentPath} 已存在且内容不同（被用户改过？），不覆盖：磁盘 ${documentRead.bytes} 字节 / ${documentRead.sha256.slice(0, 12)}…，本次 ${document.bytes} 字节 / ${document.sha256.slice(0, 12)}…`,
      )
    }
  }

  /** ---- 技能包 ---- */
  const skillEntries: PlanEntry[] = []
  const sharedSkills: SharedSkillReuse[] = []
  for (const [index, requirement] of (Array.isArray(payload.skills) ? payload.skills : []).entries()) {
    if (requirement.action !== 'install') continue
    const fieldPrefix = `skills[${index}]`
    const name = requirement.name
    if (isExpertSkillName(name) === false) {
      fail('invalid-path', `${fieldPrefix}.name`, `skill 名必须是小写 kebab-case（1–64 字符）：${JSON.stringify(name)}`)
    }
    const prefix = `${name}/`
    const stagedForSkill: WorkbenchSkillPackageFile[] = []
    const packedFiles: DraftedFile[] = []
    for (const file of Array.isArray(payload.files) ? payload.files : []) {
      if (file.area !== 'skill' || file.path.startsWith(prefix) === false) continue
      const entry = verified.get(stagedKey(file.area, file.path))
      if (entry === undefined) continue
      stagedForSkill.push({ path: file.path.slice(prefix.length), bytes: entry.bytes, sha256: entry.sha256 })
      packedFiles.push({ path: file.path.slice(prefix.length), content: entry.text, bytes: entry.bytes, sha256: entry.sha256 })
    }
    packedFiles.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

    const existing = existingSkillDirectory(context, name, `${fieldPrefix}.name`)
    const existingInstall: WorkbenchSkillExistingInstall | undefined = existing.exists === false
      ? undefined
      : existing.state.managed && existing.state.packageHash !== undefined
        ? { managed: true, packageHash: existing.state.packageHash }
        : { managed: false }

    const validated = validateWorkbenchSkillPackage({
      requirement,
      files: stagedForSkill,
      readText: (packagePath) => verified.get(stagedKey('skill', `${prefix}${packagePath}`))?.text,
      ...(existingInstall === undefined ? {} : { existingInstall }),
      ...(context.skills === undefined ? {} : { registry: context.skills }),
    })
    if (validated.ok === false || validated.packageHash === undefined) {
      const primary = validated.errors.find((entry) => isExpertErrorCode(entry.code))
      fail(
        (primary?.code as ExpertErrorCode | undefined) ?? 'skill-package-invalid',
        `${fieldPrefix}.${primary?.field ?? 'name'}`,
        validated.errors.map((entry) => entry.message).join('；') || `技能包校验未通过：${name}`,
        validated.errors,
      )
    }

    const installRecord: WorkbenchSkillInstall = {
      version: EXPERT_SKILL_INSTALL_VERSION,
      name,
      expertId: payload.expertId,
      installationId: draftId,
      packageHash: validated.packageHash,
      files: packedFiles.map(toLedgerFile),
    }
    const files: DraftedFile[] = [
      ...packedFiles,
      draftedFromText(EXPERT_SKILL_INSTALL_FILE_NAME, `${JSON.stringify(installRecord, null, 2)}\n`),
    ]
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

    if (existing.exists === false) {
      skillEntries.push({ area: 'skill-directory', path: name, files, disposition: 'create', allowedExtras: [] })
      continue
    }

    /** 到这里说明 `existingInstall.managed === true` 且哈希一致（否则上面已经报错）。 */
    const state = existing.state
    const ledger = state.files ?? []
    if (ledger.length === 0) {
      fail('skill-conflict', `${fieldPrefix}.name`, `同名技能「${name}」的管理清单没有 files 清单，无法核对可复用性，拒绝覆盖`)
    }
    for (const file of ledger) {
      const read = readExpertTextFile(skillsRootOf(context), `${name}/${file.path}`, {
        maxBytes: EXPERT_STAGED_FILE_MAX_BYTES,
        ...linkOptions(context),
      })
      if (read.ok === false || read.sha256 !== file.sha256 || read.bytes !== file.bytes) {
        fail('skill-conflict', `${fieldPrefix}.name`, `同名技能「${name}」的正式文件与它的管理清单不一致（被改过？）：${file.path}；拒绝覆盖`)
      }
    }
    if (state.expertId === payload.expertId) {
      skillEntries.push({ area: 'skill-directory', path: name, files, disposition: 'keep-owned', allowedExtras: [] })
      continue
    }
    if (state.ready !== true) {
      fail(
        'skill-conflict',
        `${fieldPrefix}.name`,
        `同名技能「${name}」内容哈希相同，但它关联的受管人格 ${String(state.expertId)} 发布门未 ready；无法确认这是可复用的完整包，拒绝覆盖`,
      )
    }
    sharedSkills.push({ area: 'skill-directory', path: name, files: ledger.map((file) => ({ ...file, content: '' })) })
  }

  const entries: PlanEntry[] = [
    {
      area: 'persona-directory',
      path: personaDirectory,
      files: personaFiles,
      disposition: personaDirectoryExists ? 'keep-owned' : 'create',
      allowedExtras: [EXPERT_PUBLICATION_FILE_NAME],
    },
    ...skillEntries,
    {
      area: 'persona-document',
      path: personaDocumentPath,
      files: [document],
      disposition: documentRead.ok ? 'keep-owned' : 'create',
      allowedExtras: [],
    },
  ]

  return {
    draftId,
    expertId: payload.expertId,
    uuid,
    manifestHash,
    entries,
    sharedSkills,
    publicationAlreadyReady,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// 发布（§6.4 第 5–7 步）
// ---------------------------------------------------------------------------

function toPublishedPath(entry: { area: ExpertPublishedPath['area']; path: string; files: DraftedFile[] }): ExpertPublishedPath {
  return { area: entry.area, path: entry.path, files: entry.files.map(toLedgerFile) }
}

/** 构建目录必须严格落在对应的根内 —— 删除它之前先证明这件事。 */
function assertScratchInsideRoot(root: string, scratchRelative: string): string {
  const absolute = resolve(absoluteJoin(root, scratchRelative))
  const rootResolved = resolve(root)
  const expectedPrefix = rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`
  if (absolute === rootResolved || absolute.startsWith(expectedPrefix) === false) {
    fail('invalid-path', 'build', `构建目录不在根内，拒绝清理：${absolute}`)
  }
  return absolute
}

function removeScratch(root: string, scratchRelative: string): void {
  rmSync(assertScratchInsideRoot(root, scratchRelative), { recursive: true, force: true })
}

function publishEntry(context: ExpertInstallContext, draftId: string, entry: PlanEntry): void {
  if (entry.disposition === 'keep-owned') return
  if (entry.area === 'persona-document') {
    const file = entry.files[0]
    if (file === undefined) fail('invalid-payload', 'persona-document', `计划里没有文档内容：${entry.path}`)
    const written = atomicWriteText(absoluteJoin(personasRootOf(context), entry.path), file.content, {
      root: personasRootOf(context),
      ...linkOptions(context),
    })
    if (written.ok === false) fail(written.problem.code, 'persona-document', `发布人格文档失败：${written.problem.message}`)
    return
  }

  const root = rootForPublishedArea(context, entry.area)
  const scratchRelative = entry.area === 'persona-directory'
    ? personaBuildRelative(draftId)
    : skillBuildRelative(draftId, entry.path)
  /** 从暂存原件复制（写进构建目录），**绝不消耗原件**（§6.3 末段）。 */
  removeScratch(root, scratchRelative)
  const scratchAbsolute = absoluteJoin(root, scratchRelative)
  mkdirSync(scratchAbsolute, { recursive: true })
  for (const file of entry.files) {
    const written = atomicWriteText(absoluteJoin(scratchAbsolute, file.path), file.content, {
      root: scratchAbsolute,
      ...linkOptions(context),
    })
    if (written.ok === false) {
      removeScratch(root, scratchRelative)
      fail(written.problem.code, `${entry.path}/${file.path}`, `写构建件失败：${written.problem.message}`)
    }
    if (written.sha256 !== file.sha256 || written.bytes !== file.bytes) {
      removeScratch(root, scratchRelative)
      fail('staged-file-changed', `${entry.path}/${file.path}`, '构建件写出来的哈希与计划不一致，拒绝发布（不留半成品）')
    }
  }

  const target = absoluteJoin(root, entry.path)
  mkdirSync(dirname(target), { recursive: true })
  /** rename 之前**二次核对目标不存在**（§6.4 第 6 步）：并发与上次崩溃都可能留痕。 */
  let exists = false
  try {
    lstatSync(target)
    exists = true
  } catch {
    exists = false
  }
  if (exists) {
    removeScratch(root, scratchRelative)
    fail(
      entry.area === 'skill-directory' ? 'skill-conflict' : 'install-repair-required',
      entry.path,
      `发布前发现目标已存在（本次不覆盖）：${entry.path}`,
    )
  }
  try {
    renameSync(scratchAbsolute, target)
  } catch (error) {
    removeScratch(root, scratchRelative)
    fail('install-repair-required', entry.path, `rename 发布失败（暂存原件未受影响，可重试）：${errorText(error)}`)
  }
}

function buildInstallResult(plan: InstallPlan, at: string, warnings: ExpertIssue[]): ExpertInstallResult {
  return {
    kind: 'expert',
    draftId: plan.draftId,
    expertId: plan.expertId,
    manifestHash: plan.manifestHash,
    installedAt: at,
    installedSkills: plan.entries.filter((entry) => entry.area === 'skill-directory').map((entry) => entry.path),
    reusedSkills: plan.sharedSkills.map((entry) => entry.path),
    warnings,
  }
}

function publishPublication(
  context: ExpertInstallContext,
  expertId: string,
  draftId: string,
  manifestHash: string,
  committedAt: string,
): void {
  const root = personasRootOf(context)
  const content = `${JSON.stringify({
    version: EXPERT_PUBLICATION_VERSION,
    expertId,
    installationId: draftId,
    manifestHash,
    ready: true,
    committedAt,
  }, null, 2)}\n`
  const written = atomicWriteText(absoluteJoin(root, managedPublicationRelativePath(expertId)), content, {
    root,
    ...linkOptions(context),
  })
  if (written.ok === false) fail(written.problem.code, 'publication', `发布 publication.json 失败：${written.problem.message}`)
}

function refreshProvider(context: ExpertInstallContext): ExpertIssue | undefined {
  if (context.refreshSkills === undefined) return undefined
  try {
    context.refreshSkills()
    return undefined
  } catch (error) {
    return {
      code: 'skill-service-unavailable',
      field: 'provider',
      message: `工作台技能 provider 刷新失败（安装已持久化，不撤销；下次请求会重试挂载）：${errorText(error)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// 补偿（§6.5 前三行）
// ---------------------------------------------------------------------------

/** 目录 entry 在补偿时**允许**存在的其它文件（安装器自己写的那一个）。 */
function allowedExtrasForRollback(area: ExpertPublishedPath['area']): readonly string[] {
  return area === 'persona-directory' ? [EXPERT_PUBLICATION_FILE_NAME] : []
}

export interface ExpertRollbackInput {
  draftId: string
  journal: ExpertInstallJournal
  /** 触发补偿的原因（写进日志与诊断文案）。 */
  reason: string
  /** 落进 `lastInstallError` 的那条问题；不传就按"被中断并已补偿"填 `canceled`。 */
  issue?: ExpertIssue
  /** 是否把草稿阶段落到 `install-failed`（默认 true；`abandoned` 草稿不落）。 */
  markDraft?: boolean
}

export interface ExpertRollbackOutcome {
  draftId: string
  action: 'rolled-back' | 'repair-required'
  deleted: string[]
  conflicts: string[]
  message: string
}

/**
 * 补偿一次**未提交**（DB 未 confirmed）的安装。
 *
 * **调用方必须已经持有 `personas/.install.lock`**（本函数不再抢锁：抢锁失败会变成
 * "补偿没做"，而补偿是失败路径上唯一要做的事）。
 *
 * 只删 `journal.createdPaths` 里登记过、且**当前内容哈希仍与登记一致**的路径：
 * 被第三方改过的文件、登记外的文件、`reusedPaths` 里的共享技能 —— 一个都不动。
 */
export function rollbackUncommittedInstallation(
  context: ExpertInstallContext,
  input: ExpertRollbackInput,
): ExpertRollbackOutcome {
  const journal: ExpertInstallJournal = { ...input.journal, phase: 'rolling-back' }
  writeJournalQuietly(context, journal)

  const deleted: string[] = []
  const conflicts: string[] = []
  const roots: Array<[string, string]> = [
    [personasRootOf(context), personaBuildRelative(input.draftId)],
    [skillsRootOf(context), `${pendingRelative(input.draftId)}/.build`],
  ]

  /** 反序删除：后发布的先撤（文档最后发布，但它会开发现门，先删更安全）。 */
  for (const entry of [...journal.createdPaths].reverse()) {
    const root = rootForPublishedArea(context, entry.area)
    const target = absoluteJoin(root, entry.path)
    try {
      lstatSync(target)
    } catch {
      /** 还没发布到这一步 —— 没什么要删的。 */
      continue
    }

    if (entry.area === 'persona-document') {
      const file = entry.files[0]
      const read = readExpertTextFile(root, entry.path, { maxBytes: EXPERT_STAGED_FILE_MAX_BYTES, ...linkOptions(context) })
      if (file === undefined || read.ok === false || read.sha256 !== file.sha256 || read.bytes !== file.bytes) {
        conflicts.push(`${entry.path}（内容与登记不一致，可能是第三方改动）`)
        continue
      }
      try {
        unlinkSync(target)
        deleted.push(entry.path)
      } catch (error) {
        conflicts.push(`${entry.path}（删除失败：${errorText(error)}）`)
      }
      continue
    }

    let isDirectory = false
    try {
      isDirectory = lstatSync(target).isDirectory()
    } catch {
      isDirectory = false
    }
    if (isDirectory === false) {
      conflicts.push(`${entry.path}（已不是目录）`)
      continue
    }
    const listed = listRelativeFiles(root, entry.path)
    if (listed.ok === false) {
      conflicts.push(`${entry.path}（${listed.message}）`)
      continue
    }
    const planned = new Map(entry.files.map((file) => [file.path, file]))
    const allowed = new Set(allowedExtrasForRollback(entry.area))
    let blocked = false
    for (const relative of listed.files) {
      if (planned.has(relative) === false) {
        if (allowed.has(relative)) continue
        /** 登记外的文件 = 第三方新增内容：**不递归删除**（§3.2 末段）。 */
        conflicts.push(`${entry.path}/${relative}（登记外的文件，不递归删除）`)
        blocked = true
        continue
      }
      const read = readExpertTextFile(root, `${entry.path}/${relative}`, {
        maxBytes: EXPERT_STAGED_FILE_MAX_BYTES,
        ...linkOptions(context),
      })
      const plannedFile = planned.get(relative) as DraftedFile
      if (read.ok === false || read.sha256 !== plannedFile.sha256 || read.bytes !== plannedFile.bytes) {
        conflicts.push(`${entry.path}/${relative}（内容与登记不一致，可能是第三方改动）`)
        blocked = true
      }
    }
    for (const [relative] of planned) {
      if (listed.files.includes(relative)) continue
      conflicts.push(`${entry.path}/${relative}（登记里有、磁盘上没了）`)
      blocked = true
    }
    if (blocked) continue
    try {
      rmSync(target, { recursive: true, force: true })
      deleted.push(entry.path)
    } catch (error) {
      conflicts.push(`${entry.path}（删除失败：${errorText(error)}）`)
    }
  }

  /** 构建目录是本次安装自己的临时产物，无论成败都清掉（不是"第三方内容"）。 */
  for (const [root, scratch] of roots) {
    try {
      removeScratch(root, scratch)
    } catch {
      /* 构建目录不存在/删不掉都不影响判定 */
    }
  }

  const repairRequired = conflicts.length > 0
  const defaultIssue: ExpertIssue = {
    code: 'canceled',
    field: 'install',
    message: `安装被中断（进程被杀/崩溃）并已补偿：已撤回本次新建的路径，暂存原件保留，可重新校验后再确认。原始原因：${input.reason}`,
  }
  const issue: ExpertIssue = repairRequired
    ? {
        code: 'install-repair-required',
        field: 'install',
        message: `补偿时发现无法安全删除的内容（不覆盖、不递归删第三方内容）：${conflicts.join('、')}。原始原因：${input.reason}`,
      }
    : (input.issue ?? defaultIssue)

  writeJournalQuietly(context, { ...journal, phase: repairRequired ? 'repair-required' : 'rolled-back' })

  if (input.markDraft !== false) {
    const version = expertDraftCurrentVersion(context, input.draftId)
    if (version !== undefined) {
      try {
        transitionExpertDraftInstall(context.db, input.draftId, version, { phase: 'install-failed', lastInstallError: issue })
      } catch {
        /* 草稿可能已被改/已确认；补偿本身已经完成，不把日志失败升级成新的失败 */
      }
    }
  }

  return {
    draftId: input.draftId,
    action: repairRequired ? 'repair-required' : 'rolled-back',
    deleted,
    conflicts,
    message: repairRequired
      ? `补偿发现第三方改动或登记外文件，已停下并标记 repair-required：${conflicts.join('、')}`
      : `已补偿本次未提交的安装（撤回 ${deleted.length} 条路径，暂存原件未动）`,
  }
}

// ---------------------------------------------------------------------------
// 确认安装（§6.4）
// ---------------------------------------------------------------------------

export function confirmExpertDraft(context: ExpertInstallContext, input: ExpertConfirmInput): ExpertConfirmResult {
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : ''
  if (draftId === '') return failure('invalid-payload', 'draftId', 'draft_id 必填（要确认安装的那份专家草稿）')
  if (isExpertUuid(draftId) === false) {
    return failure('invalid-payload', 'draftId', `草稿 id 不是标准小写 UUID，拒绝用它拼安装路径：${draftId}`)
  }
  const requireOwner = Object.prototype.hasOwnProperty.call(input, 'sessionId')

  try {
    return withExpertDraftMutex(draftId, () => {
      const acquired = acquireExpertInstallLock({
        lockPath: context.roots.installLockPath,
        draftId,
        mode: 'install',
        ...(context.now === undefined ? {} : { now: context.now }),
        ...(context.lock?.isProcessAlive === undefined ? {} : { isProcessAlive: context.lock.isProcessAlive }),
        ...(context.lock?.pid === undefined ? {} : { pid: context.lock.pid }),
        ...(context.lock?.hostname === undefined ? {} : { hostname: context.lock.hostname }),
      })
      if (acquired.ok === false) {
        return failure(acquired.code, 'install', acquired.message, undefined, expertDraftCurrentVersion(context, draftId))
      }
      try {
        return confirmLocked(context, input, draftId, requireOwner)
      } finally {
        /** 第 12 步：无论成败都释放**自己**的锁（别人的锁 `release` 会自己对不上 token 而让开）。 */
        acquired.handle.release()
      }
    })
  } catch (error) {
    /**
     * 幂等回放/恢复补齐这条路径上，`publishPublication` 之类的失败是**直接抛**的
     * （那些函数没有 `installPlanned` 那样的补偿上下文）。这里统一收成 ok:false：
     * 调用方永远拿到一个可读的失败对象，而不是异常。
     */
    if (error instanceof InstallFailure) {
      return failure(error.code, error.field, error.message, error.errors, expertDraftCurrentVersion(context, draftId))
    }
    const mapped = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(context, draftId))
    if (mapped !== undefined) return mapped
    throw error
  }
}

function confirmLocked(
  context: ExpertInstallContext,
  input: ExpertConfirmInput,
  draftId: string,
  requireOwner: boolean,
): ExpertConfirmResult {
  const draft = getExpertDraft(context.db, draftId)
  if (draft === undefined) return failure('draft-not-found', 'draftId', `专家草稿不存在：${draftId}`)
  let payload = draft.payload as unknown as ExpertDraftPayload
  if (payload.version !== EXPERT_DRAFT_PAYLOAD_VERSION) {
    return failure('unknown-schema-version', 'payload', `专家草稿 payload 版本是 ${String(payload.version)}，本版只认 ${EXPERT_DRAFT_PAYLOAD_VERSION}`)
  }
  if (requireOwner) {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (sessionId === '') {
      return failure('draft-owner-mismatch', 'sessionId', '无法确定当前会话：确认安装需要执行上下文里的真实会话 id，没有任何 session_id 入参。')
    }
    if (draft.sessionId !== sessionId) {
      return failure('draft-owner-mismatch', 'sessionId', `这份专家草稿属于另一个会话（草稿会话 ${draft.sessionId ?? '未知'}），本会话不能确认它`)
    }
  }

  /** 第 2 步：已确认且有 confirmResult → 恢复检查 + 幂等回放。 */
  if (draft.statusCode === 'confirmed') {
    const cached = payload.confirmResult
    if (cached === undefined) {
      return failure('draft-not-pending', 'statusCode', '专家草稿已确认，但库里没有 confirmResult，无法幂等回放')
    }
    return replayConfirmed(context, draftId, cached)
  }
  if (draft.statusCode !== 'pending') {
    return failure('draft-not-pending', 'statusCode', `专家草稿当前状态是 ${draft.statusCode}，不能确认安装`)
  }

  /** 上一轮崩在安装中间：先把日志/磁盘收拾干净，再按正常流程重装。 */
  if (payload.phase === 'installing') {
    const replayed = recoverInstallingDraft(context, draftId, payload)
    if (replayed !== undefined) return replayed
    const reread = getExpertDraft(context.db, draftId)
    if (reread === undefined) return failure('draft-not-found', 'draftId', `专家草稿不存在：${draftId}`)
    payload = reread.payload as unknown as ExpertDraftPayload
  }

  /** 第 3 步之一：版本。 */
  const expectedVersion = input.expectedVersion
  if (Number.isInteger(expectedVersion) === false || (expectedVersion as number) < 0 || expectedVersion !== payload.contentVersion) {
    return failure(
      'draft-version-conflict',
      'expectedVersion',
      `expected_version=${String(expectedVersion)} 与当前 contentVersion=${payload.contentVersion} 不一致；请用最新版本重试`,
      undefined,
      payload.contentVersion,
    )
  }

  const validation = payload.validation
  if (validation === null || validation === undefined) {
    return failure('draft-not-validated', 'validation', '草稿还没有校验结果（§6.1），不能确认安装；请先调用校验', undefined, payload.contentVersion)
  }
  if (Array.isArray(validation.errors) && validation.errors.length > 0) {
    return failure(
      'draft-not-validated',
      'validation',
      `草稿的校验结果里还有 ${validation.errors.length} 条错误，不能确认安装`,
      validation.errors,
      payload.contentVersion,
    )
  }
  const rawExpected = input.expectedManifestHash
  const expectedManifestHash = typeof rawExpected === 'string' && rawExpected.trim() !== ''
    ? rawExpected.trim()
    : validation.manifestHash
  if (isSha256Hex(expectedManifestHash) === false) {
    return failure('invalid-payload', 'expectedManifestHash', `expected_manifest_hash 不是 sha256 十六进制串：${JSON.stringify(rawExpected)}`)
  }
  if (validation.manifestHash !== expectedManifestHash) {
    return failure(
      'package-changed',
      'expectedManifestHash',
      `草稿上记录的 manifestHash（${String(validation.manifestHash).slice(0, 12)}…）与确认请求里的（${expectedManifestHash.slice(0, 12)}…）不一致；包已变，请重新校验后再确认`,
      undefined,
      payload.contentVersion,
    )
  }

  /** 第 3 步之二：**重新执行**完整校验（confirm 不能只看绿勾）。 */
  const revalidated = validateExpertDraft(context, { draftId, expectedVersion: payload.contentVersion }, { mutex: false })
  if (revalidated.ok === false) return revalidated
  if (revalidated.validation.errors.length > 0) {
    const primary = revalidated.validation.errors.find((entry) => isExpertErrorCode(entry.code))
    return failure(
      (primary?.code as ExpertErrorCode | undefined) ?? 'draft-not-validated',
      primary?.field ?? 'validation',
      `重新校验未通过（§6.4 第 3 步：confirm 必须重新跑一遍校验）：${revalidated.validation.errors.map((entry) => entry.message).join('；')}`,
      revalidated.validation.errors,
      revalidated.contentVersion,
    )
  }
  if (revalidated.manifestHash !== expectedManifestHash) {
    return failure(
      'package-changed',
      'expectedManifestHash',
      `重新校验算出的 manifestHash（${revalidated.manifestHash.slice(0, 12)}…）与确认请求里的（${expectedManifestHash.slice(0, 12)}…）不一致；包已变，请重新校验后再确认`,
      undefined,
      revalidated.contentVersion,
    )
  }

  context.failpoint?.('install.after-validation')

  let plan: InstallPlan
  try {
    plan = buildPlan(context, draftId, payload, expectedManifestHash)
  } catch (error) {
    if (error instanceof InstallFailure) return failure(error.code, error.field, error.message, error.errors, payload.contentVersion)
    const mapped = expertRepoFailure(error, 'draftId', payload.contentVersion)
    if (mapped !== undefined) return mapped
    throw error
  }
  plan.warnings = revalidated.validation.warnings

  return installPlanned(context, draftId, payload, plan)
}

function installPlanned(
  context: ExpertInstallContext,
  draftId: string,
  payload: ExpertDraftPayload,
  plan: InstallPlan,
): ExpertConfirmResult {
  const now = context.now ?? (() => new Date().toISOString())
  const created: ExpertPublishedPath[] = plan.entries.map(toPublishedPath)
  const reused: ExpertPublishedPath[] = plan.sharedSkills.map(toPublishedPath)

  let journal: ExpertInstallJournal = {
    version: EXPERT_INSTALL_JOURNAL_VERSION,
    ownerDbKey: ownerDbKeyFor(context),
    draftId,
    expertId: plan.expertId,
    manifestHash: plan.manifestHash,
    phase: 'prepared',
    createdPaths: created,
    reusedPaths: reused,
    result: null,
  }
  let committed = false
  let result: ExpertInstallResult | undefined

  const compensate = (code: ExpertErrorCode, field: string, message: string, errors?: ExpertIssue[]): ExpertConfirmResult => {
    if (committed) {
      /**
       * §6.5 第 4 行：**DB 已 confirmed 就不回滚**。这些文件已经是"用户的专家"了，
       * 撤掉它们会让一份已确认的草稿指向不存在的东西。按日志补齐 publication 即可
       * （再确认一次走 `replayConfirmed` 把该做的事做完）。
       */
      writeJournalQuietly(context, { ...journal, phase: 'db-committed', result: result ?? journal.result })
      return failure(
        code,
        field,
        `${message}；草稿已确认（DB 已提交），按 §6.5 不回滚：再确认一次即可补齐 publication.json 与 provider 挂载`,
        errors,
        payload.contentVersion,
      )
    }
    const rollback = rollbackUncommittedInstallation(context, {
      draftId,
      journal: { ...journal, createdPaths: created, reusedPaths: reused },
      reason: `${code}: ${message}`,
      issue: { code, field, message },
    })
    return failure(
      code,
      field,
      rollback.action === 'repair-required'
        ? `${message}；补偿未能安全撤回全部内容 —— ${rollback.message}`
        : `${message}；本次未提交（草稿仍为 pending / install-failed）并已补偿：${rollback.message}`,
      errors,
      payload.contentVersion,
    )
  }

  try {
    /** ---- 第 4 步：prepared 日志 + phase=installing ---- */
    context.failpoint?.('install.before-prepared-journal')
    writeExpertInstallJournal(context, journal)
    context.failpoint?.('install.after-prepared-journal')
    transitionExpertDraftInstall(context.db, draftId, payload.contentVersion, { phase: 'installing', lastInstallError: null }, now())

    for (const entry of plan.entries) {
      if (entry.area === 'persona-directory') context.failpoint?.('install.before-persona-directory')
      if (entry.area === 'skill-directory') context.failpoint?.('install.before-skill-directory')
      if (entry.area === 'persona-document') context.failpoint?.('install.before-persona-document')
      publishEntry(context, draftId, entry)
      if (entry.area === 'persona-directory') context.failpoint?.('install.after-persona-directory')
      if (entry.area === 'skill-directory') context.failpoint?.('install.after-skill-directory')
      if (entry.area === 'persona-document') context.failpoint?.('install.after-persona-document')
    }

    /** ---- 第 8 步：核对全部正式文件，再写 files-published 日志 ---- */
    for (const entry of plan.entries) {
      const check = verifyPublished(context, entry)
      if (check.ok === false) fail(check.code, entry.path, check.message)
    }
    context.failpoint?.('install.before-files-published-journal')
    journal = { ...journal, phase: 'files-published' }
    writeExpertInstallJournal(context, journal)
    context.failpoint?.('install.after-files-published-journal')

    /**
     * ---- 第 9 步：短事务确认（**唯一**把 status_code 变成 confirmed 的地方）----
     *
     * 绝不与任何文件/网络操作同事务：`ROLLBACK` 不会撤销文件（§6.4 末条）。
     */
    result = buildInstallResult(plan, now(), plan.warnings)
    context.failpoint?.('install.before-db-commit')
    commitExpertDraftInstallation(context.db, draftId, payload.contentVersion, result, now())
    committed = true
    context.failpoint?.('install.after-db-commit')

    /** ---- 第 10 步：db-committed 日志 + publication.json ---- */
    journal = { ...journal, phase: 'db-committed', result }
    writeExpertInstallJournal(context, journal)
    context.failpoint?.('install.before-publication')
    if (plan.publicationAlreadyReady === false) {
      publishPublication(context, plan.expertId, draftId, plan.manifestHash, now())
    }
    context.failpoint?.('install.after-publication')

    /** ---- 第 11 步：ready 日志 + provider 刷新 ---- */
    context.failpoint?.('install.before-provider-refresh')
    const warning = refreshProvider(context)
    const finalResult: ExpertInstallResult = warning === undefined ? result : { ...result, warnings: [...result.warnings, warning] }
    journal = { ...journal, phase: 'ready', result: finalResult }
    writeExpertInstallJournal(context, journal)
    context.failpoint?.('install.after-ready-journal')

    return { ok: true, result: finalResult, replayed: plan.entries.every((entry) => entry.disposition === 'keep-owned') }
  } catch (error) {
    if (error instanceof InstallFailure) return compensate(error.code, error.field, error.message, error.errors)
    const mapped = expertRepoFailure(error, 'draftId', payload.contentVersion)
    if (mapped !== undefined) return compensate(mapped.code as ExpertErrorCode, mapped.field, mapped.message, mapped.errors)
    /** 没料到的异常：照样补偿，并把"状态可能不一致"如实报出来（不静默吞掉）。 */
    return compensate('install-repair-required', 'install', `安装过程中出现未预期的异常：${errorText(error)}`)
  }
}

// ---------------------------------------------------------------------------
// 幂等回放与"装到一半"的收拾（§6.5 第 4 行）
// ---------------------------------------------------------------------------

function readPublication(context: ExpertInstallContext, expertId: string): 'ready' | 'absent' | 'broken' {
  const read = readExpertTextFile(personasRootOf(context), managedPublicationRelativePath(expertId), {
    maxBytes: 64 * 1024,
    ...linkOptions(context),
  })
  if (read.ok === false || read.text === undefined) return 'absent'
  try {
    const parsed = JSON.parse(read.text) as unknown
    if (isPlainObject(parsed) && parsed.version === EXPERT_PUBLICATION_VERSION && parsed.expertId === expertId && parsed.ready === true) return 'ready'
  } catch {
    return 'broken'
  }
  return 'broken'
}

function replayConfirmed(
  context: ExpertInstallContext,
  draftId: string,
  cached: ExpertInstallResult,
): ExpertConfirmResult {
  const publication = readPublication(context, cached.expertId)

  if (publication === 'ready') {
    /** 已经发布过：核对登记过的人格文档没被改（§6.5 第 6 行），然后原样回放。 */
    const journalRead = readExpertInstallJournal(context, draftId)
    if (journalRead.ok && journalRead.state.journal.ownerDbKey === ownerDbKeyFor(context)) {
      const entry = journalRead.state.journal.createdPaths.find((item) => item.area === 'persona-document')
      if (entry !== undefined) {
        const check = verifyPublished(context, { area: 'persona-document', path: entry.path, files: entry.files.map((file) => ({ ...file, content: '' })), allowedExtras: [] })
        if (check.ok === false) {
          writeJournalQuietly(context, { ...journalRead.state.journal, phase: 'repair-required' })
          return failure('install-repair-required', 'persona-document', `已发布的正式文件与登记不一致，不覆盖、不修复：${check.message}`)
        }
      }
    }
    const warning = refreshProvider(context)
    const result = warning === undefined ? cached : { ...cached, warnings: [...cached.warnings, warning] }
    return { ok: true, result, replayed: true }
  }

  /** DB 已 confirmed 但 publication 未 ready / 损坏 → **不回滚**，按日志与实际哈希补齐。 */
  const journalRead = readExpertInstallJournal(context, draftId)
  if (journalRead.ok === false) {
    return failure(
      'install-repair-required',
      'install-journal',
      `草稿已确认，但 publication.json 未就绪且安装日志不可用（${journalRead.message}）：无法判定要补发布什么，请人工检查`,
    )
  }
  const journal = journalRead.state.journal
  if (journal.ownerDbKey === '') {
    return failure('install-owner-unknown', 'install-journal', '安装日志没有 ownerDbKey（不知道是谁写的），不做任何文件操作')
  }
  if (journal.ownerDbKey !== ownerDbKeyFor(context)) {
    return failure('install-owner-unknown', 'install-journal', '安装日志属于另一个 DB（ownerDbKey 不匹配），不做任何文件操作')
  }
  if (journal.expertId !== cached.expertId || journal.manifestHash !== cached.manifestHash) {
    return failure(
      'install-repair-required',
      'install-journal',
      `安装日志（${journal.expertId} / ${journal.manifestHash.slice(0, 12)}…）与草稿的确认结果（${cached.expertId} / ${cached.manifestHash.slice(0, 12)}…）不一致，请人工检查`,
    )
  }
  for (const entry of journal.createdPaths) {
    const check = verifyPublished(context, {
      area: entry.area,
      path: entry.path,
      files: entry.files.map((file) => ({ ...file, content: '' })),
      allowedExtras: allowedExtrasForRollback(entry.area),
    })
    if (check.ok === false) {
      writeJournalQuietly(context, { ...journal, phase: 'repair-required' })
      return failure('install-repair-required', entry.path, `已确认的安装无法补齐发布（正式文件损坏/丢失或被改过）：${check.message}`)
    }
  }
  const at = (context.now ?? (() => new Date().toISOString()))()
  publishPublication(context, cached.expertId, journal.draftId, cached.manifestHash, at)
  const warning = refreshProvider(context)
  const result = warning === undefined ? cached : { ...cached, warnings: [...cached.warnings, warning] }
  writeJournalQuietly(context, { ...journal, phase: 'ready', result })
  return { ok: true, result, replayed: true }
}

/**
 * `confirm` 进入时草稿已经是 `installing`（上一轮崩在安装中间）。
 *
 * 返回 `undefined` 表示"已经收拾干净，可以按正常流程重装"；返回结果对象表示这次调用
 * 已经给出最终答复。
 */
function recoverInstallingDraft(
  context: ExpertInstallContext,
  draftId: string,
  payload: ExpertDraftPayload,
): ExpertConfirmResult | undefined {
  const journalRead = readExpertInstallJournal(context, draftId)
  if (journalRead.ok === false) {
    if (journalRead.reason === 'missing') {
      /**
       * `phase=installing` 是**先写日志再改 DB** 的，所以"没有日志"只可能是日志被删或
       * 草稿是从别处拷来的 —— 无法判定它动过哪些文件，绝不猜。
       */
      return failure('install-repair-required', 'install-journal', '草稿停在 installing 但找不到安装日志：无法判定它发布过什么，请人工检查后放弃或修复这份草稿')
    }
    return failure('install-repair-required', 'install-journal', `草稿停在 installing 且安装日志坏了：${journalRead.message}`)
  }
  const journal = journalRead.state.journal
  if (journal.ownerDbKey === '') {
    return failure('install-owner-unknown', 'install-journal', '安装日志没有 ownerDbKey（不知道是谁写的），不做任何文件操作')
  }
  if (journal.ownerDbKey !== ownerDbKeyFor(context)) {
    return failure('install-owner-unknown', 'install-journal', '安装日志属于另一个 DB（ownerDbKey 不匹配），不做任何文件操作')
  }
  if (journal.expertId !== payload.expertId) {
    return failure('install-repair-required', 'install-journal', `安装日志的 expertId（${journal.expertId}）与草稿（${payload.expertId}）不一致，请人工检查`)
  }
  const rollback = rollbackUncommittedInstallation(context, {
    draftId,
    journal,
    reason: '上一轮安装在 phase=installing 时中断（进程被杀或崩溃）',
  })
  if (rollback.action === 'repair-required') {
    return failure('install-repair-required', 'install', `${rollback.message}；请人工检查这些路径后再重试`)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 恢复（§6.5；第二轮在此基础上补完整故障矩阵测试）
// ---------------------------------------------------------------------------

export type ExpertRecoveryAction =
  | 'nothing-to-do'
  | 'already-ready'
  | 'completed-publication'
  | 'rolled-back'
  | 'repair-required'
  | 'skipped-foreign-owner'
  | 'skipped-owner-unknown'
  | 'skipped-locked'
  | 'skipped-no-draft'

export interface ExpertRecoveryOutcome {
  draftId: string
  action: ExpertRecoveryAction
  phase: ExpertInstallJournal['phase'] | 'unknown'
  message: string
}

/**
 * 恢复**一份**草稿的安装（§6.3 / §6.5）。要求调用方不持有安装锁（本函数自己抢）。
 *
 * 三条判定：
 *
 * - `ownerDbKey` 不属于本 DB（含缺失）→ **只跳过**，一个文件都不动；
 * - DB 已 `confirmed` → 补齐 `publication.json`（**不回滚**）；
 * - DB 还是 `pending`/`abandoned` → 补偿本次登记过且哈希一致的文件。
 */
export function recoverExpertInstallation(context: ExpertInstallContext, draftId: string): ExpertRecoveryOutcome {
  const journalRead = readExpertInstallJournal(context, draftId)
  if (journalRead.ok === false) {
    if (journalRead.reason === 'missing') {
      return { draftId, action: 'nothing-to-do', phase: 'unknown', message: '没有安装日志，无需恢复' }
    }
    return { draftId, action: 'repair-required', phase: 'unknown', message: journalRead.message }
  }
  const journal = journalRead.state.journal
  if (journal.phase === 'rolled-back') {
    return { draftId, action: 'nothing-to-do', phase: journal.phase, message: '这份安装已经补偿过了' }
  }
  if (journal.phase === 'repair-required') {
    return { draftId, action: 'repair-required', phase: journal.phase, message: '这份安装上次被判为 repair-required，等人处理（不自动重试）' }
  }
  if (journal.ownerDbKey === '') {
    return { draftId, action: 'skipped-owner-unknown', phase: journal.phase, message: '安装日志没有 ownerDbKey，不做任何文件操作' }
  }
  if (journal.ownerDbKey !== ownerDbKeyFor(context)) {
    return { draftId, action: 'skipped-foreign-owner', phase: journal.phase, message: '安装日志属于另一个 DB（另一个 profile）：只跳过、不动文件' }
  }

  const acquired = acquireExpertInstallLock({
    lockPath: context.roots.installLockPath,
    draftId,
    mode: 'recovery',
    ...(context.now === undefined ? {} : { now: context.now }),
    ...(context.lock?.isProcessAlive === undefined ? {} : { isProcessAlive: context.lock.isProcessAlive }),
    ...(context.lock?.pid === undefined ? {} : { pid: context.lock.pid }),
    ...(context.lock?.hostname === undefined ? {} : { hostname: context.lock.hostname }),
  })
  if (acquired.ok === false) {
    return { draftId, action: 'skipped-locked', phase: journal.phase, message: `没能取得安装锁，本次不恢复：${acquired.message}` }
  }
  try {
    const draft = getExpertDraft(context.db, draftId)
    if (draft === undefined) {
      return {
        draftId,
        action: 'skipped-no-draft',
        phase: journal.phase,
        message: '本 DB 里没有这份草稿：只跳过、不删任何文件（它可能属于另一个 DB，也可能已被放弃）',
      }
    }
    if (draft.statusCode === 'confirmed') {
      if (readPublication(context, journal.expertId) === 'ready') {
        return { draftId, action: 'already-ready', phase: journal.phase, message: '已确认且发布门已就绪' }
      }
      for (const entry of journal.createdPaths) {
        const check = verifyPublished(context, {
          area: entry.area,
          path: entry.path,
          files: entry.files.map((file) => ({ ...file, content: '' })),
          allowedExtras: allowedExtrasForRollback(entry.area),
        })
        if (check.ok === false) {
          writeJournalQuietly(context, { ...journal, phase: 'repair-required' })
          return { draftId, action: 'repair-required', phase: 'repair-required', message: `草稿已确认但正式文件对不上，不覆盖也不回滚：${check.message}` }
        }
      }
      const at = (context.now ?? (() => new Date().toISOString()))()
      try {
        publishPublication(context, journal.expertId, journal.draftId, journal.manifestHash, at)
      } catch (error) {
        return { draftId, action: 'repair-required', phase: journal.phase, message: `补发布 publication.json 失败：${errorText(error)}` }
      }
      const warning = refreshProvider(context)
      const result = journal.result === null
        ? null
        : warning === undefined ? journal.result : { ...journal.result, warnings: [...journal.result.warnings, warning] }
      writeJournalQuietly(context, { ...journal, phase: 'ready', result })
      return { draftId, action: 'completed-publication', phase: 'ready', message: '按日志补齐了 publication.json 并刷新了 provider（不回滚已确认的安装）' }
    }

    const rollback = rollbackUncommittedInstallation(context, {
      draftId,
      journal,
      reason: '启动/确认时的恢复检查：DB 未 confirmed',
      markDraft: draft.statusCode === 'pending',
    })
    return {
      draftId,
      action: rollback.action === 'repair-required' ? 'repair-required' : 'rolled-back',
      phase: rollback.action === 'repair-required' ? 'repair-required' : 'rolled-back',
      message: rollback.message,
    }
  } finally {
    acquired.handle.release()
  }
}

/**
 * 扫一遍 `.pending/`，恢复**归属于本 DB** 的安装日志。
 *
 * 一个条目坏掉**不得**阻止插件启动（§6.5 末段），所以这里绝不抛异常：
 * 每条草稿的结论都收成一条 `ExpertRecoveryOutcome`（`nothing-to-do` 不进列表）。
 */
export function recoverExpertInstallations(context: ExpertInstallContext): { outcomes: ExpertRecoveryOutcome[]; scanned: number } {
  const pendingRoot = absoluteJoin(personasRootOf(context), EXPERT_PENDING_DIR_NAME)
  let entries: Dirent[]
  try {
    entries = readdirSync(pendingRoot, { withFileTypes: true })
  } catch {
    return { outcomes: [], scanned: 0 }
  }
  const draftIds = entries
    .filter((entry) => entry.isDirectory() && isExpertUuid(entry.name))
    .map((entry) => entry.name)
    .sort()
  const outcomes: ExpertRecoveryOutcome[] = []
  for (const draftId of draftIds) {
    try {
      const outcome = recoverExpertInstallation(context, draftId)
      if (outcome.action === 'nothing-to-do') continue
      outcomes.push(outcome)
    } catch (error) {
      outcomes.push({
        draftId,
        action: 'repair-required',
        phase: 'unknown',
        message: `恢复该草稿时抛错（已隔离，不影响其它草稿与插件启动）：${errorText(error)}`,
      })
    }
  }
  return { outcomes, scanned: draftIds.length }
}
