/**
 * 专家草稿的**服务端逻辑**：owner 守卫、人格/来源/技能提交、暂存文件增删、完整校验。
 *
 * ## 这一层解决什么
 *
 * 规格 §5.1 的五个工具都长在这一层上（`submit` / `stage` / `remove` / `validate` +
 * 一个 owner 守卫），§6.1 的十步校验也只在这里实现一次：P5 的 service 与后续批次
 * **只做接线**，不复制这里的判断。
 *
 * ## 五条硬口径
 *
 * 1. **身份只看真实执行会话**：`assertExpertDraftOwner` 拿的是 `exec.agent.session.id`，
 *    工具参数里**没有** `session_id`。模型自述的"当前会话"一律不采信（§5.1 最后一行）。
 * 2. **先完整校验再动 DB**（施工步骤 2）：非法 JSON、超限名称/正文、坏来源结构都在
 *    写库之前拒掉，所以一份曾经有效的草稿不会被半截输入毁掉。
 * 3. **一次只写一个文件，且路径只能来自索引**：`stage` 的落点由
 *    `area + path` 经路径形状校验后拼出，删除与读取用的是**索引里记的那条路径**，
 *    绝不用调用方给的字符串去算目录 —— 否则"删一个不存在的东西"就会变成删别的目录。
 * 4. **写入与 CAS 之间可以被中断，但不会静默自愈**：文件已改、DB 未改（进程被杀、
 *    或 CAS 冲突）时，下一次 `read`/`validate` 会比对索引哈希与磁盘哈希并返回
 *    `staged-file-changed`，**不自动确认**；owner 按当前 DB 版本重新 `stage` 即可恢复一致。
 *    CAS 失败时只有"目标仍是本次刚写入的那份哈希"才回滚，第三方改动一律不覆盖。
 * 5. **每次内容变更自动作废旧校验**：`files`/`personaMd`/`provenance`/`skills` 都是
 *    仓储层的内容键，变更即 `contentVersion + 1` 并清空 `validation`（§3.4）。
 *
 * ## 进程内互斥
 *
 * 本模块的函数都是**同步**的，所以一次调用内部不会被事件循环切开。`withExpertDraftMutex`
 * 因此只防一件事：同一个草稿的**重入**（例如 `failpoint` 钩子在写入之后又调了一次
 * `stage`）。跨进程的互斥由安装锁（`.install.lock`）负责，不在这里重复实现。
 */
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  EXPERT_BODY_MAX_CHARS,
  EXPERT_DRAFT_MAX_FILES,
  EXPERT_DRAFT_MAX_TOTAL_BYTES,
  EXPERT_DRAFT_PAYLOAD_VERSION,
  EXPERT_PENDING_DIR_NAME,
  EXPERT_PENDING_FILES_DIR_NAME,
  EXPERT_SKILL_MAX_INSTALLS,
  EXPERT_SKILL_MAX_REQUIREMENTS,
  EXPERT_SKILL_MAX_REUSES,
  EXPERT_STAGED_FILE_MAX_BYTES,
  EXPERT_STAGED_FILE_MAX_CHARS,
  EXPERT_VALIDATION_VERSION,
  isExpertErrorCode,
  isExpertSkillName,
  isExpertSourceId,
  isExpertUuid,
} from '../shared/expert.js'
import type {
  ExpertDraftPayload,
  ExpertDraftPhase,
  ExpertErrorCode,
  ExpertFileArea,
  ExpertIssue,
  ExpertProvenance,
  ExpertSkillRequirement,
  ExpertStagedFile,
  ExpertValidation,
} from '../shared/expert.js'
import { PERSONA_FILE_MAX_BYTES } from '../shared/persona.js'
import type { PersonaDiagnosticCode } from '../shared/persona.js'
/** 人格归一化与解析器**只在 `src/personas/parse.ts` 导出一份**：专家草稿必须用同一个 parser。 */
import { normalizePersonaText, parsePersonaDocument } from '../personas/parse.js'
import { ExpertRepoError, getExpertDraft, updateExpertDraftCas } from '../db/repo/experts.js'
import type { DraftRow } from '../db/repo/shared.js'
import {
  assertNoLinksInsideRoot,
  atomicWriteText,
  expertPathCompareKey,
  readExpertTextFile,
  rootForArea,
  validateExpertRelativePath,
  validateStagedFileContent,
} from './paths.js'
import type { ExpertPathProblem, ExpertRoots } from './paths.js'
import {
  expertManifestHash,
  lookupFromStagedFiles,
  parseExpertProvenance,
  sha256Hex,
  validateExpertSourceFiles,
} from './provenance.js'
import type { ExpertFileLookup } from './provenance.js'
import { validateWorkbenchSkillPackage } from './skill-package.js'
import type {
  WorkbenchSkillExistingInstall,
  WorkbenchSkillPackageFile,
  WorkbenchSkillRegistry,
} from './skill-package.js'

/** 故障注入点（**只为测试存在**）：让"文件已改、DB 未改"这类中间态可被稳定复现。 */
export type ExpertDraftFailpoint =
  | 'stage.after-file-write'
  | 'stage.before-cas'
  | 'remove.after-file-delete'
  | 'remove.before-cas'
  | 'submit.before-cas'
  | 'validate.before-write'

/**
 * 调用上下文。`roots` 只能来自构造参数（生产由 `resolveExpertRoots()` 解析宿主目录约定）；
 * HTTP / 工具层**没有任何**"传一个根进来"的参数。
 */
export interface ExpertDraftContext {
  db: DatabaseSync
  roots: ExpertRoots
  /** 根自己是链接时的包含边界（构造参数注入；不传 = 根是链接就 fail-closed）。 */
  allowRootLinkUnder?: string
  /** 平台（测试注入）。 */
  platform?: string
  now?: () => string
  failpoint?: (point: ExpertDraftFailpoint) => void
  /** skills 服务投影（reuse 判定用）；没有服务就不传，不伪造一个假服务。 */
  skills?: WorkbenchSkillRegistry
}

// ---------------------------------------------------------------------------
// 返回形状（§5.1）
// ---------------------------------------------------------------------------

export interface ExpertOperationSuccess {
  ok: true
  draftId: string
  contentVersion: number
  phase: ExpertDraftPhase
  changed: boolean
  errors: ExpertIssue[]
  warnings: ExpertIssue[]
  message: string
}

export interface ExpertOperationFailure {
  ok: false
  /**
   * 失败主因。除专家自己的 `ExpertErrorCode` 外，**人格正文的失败原因就是解析器的
   * `PersonaDiagnosticCode`**（§12.1：`oversized-body`/`unsupported-frontmatter` 必须原样
   * 透出，映射成别的词会让用户按错误的提示去改）。
   */
  code: ExpertErrorCode | PersonaDiagnosticCode
  field: string
  message: string
  /** 能合法读到当前版本时带上，供模型"用新版本重试"。 */
  currentVersion?: number
  /** 字段级问题（比 `message` 细；HTTP 顶层 code 仍是主因）。 */
  errors?: ExpertIssue[]
}

export type ExpertOperationResult = ExpertOperationSuccess | ExpertOperationFailure

/** 草稿的只读视图（HTTP GET / validate 返回用）。 */
export interface ExpertDraftView {
  draftId: string
  statusCode: string
  contentVersion: number
  phase: ExpertDraftPhase
  expertId: string
  request: string
  personaMd: string
  provenance: ExpertProvenance | null
  skills: ExpertSkillRequirement[]
  files: ExpertStagedFile[]
  validation: ExpertValidation | null
}

/** `GET /experts/drafts/:id/file` 的返回。 */
export interface ExpertFileView {
  draftId: string
  area: ExpertFileArea
  path: string
  text: string
  bytes: number
  sha256: string
  /** 归档原件（`sources/<id>/original.md`）：UI 标"仅归档"，不当模型可读资源。 */
  archivedOnly: boolean
}

export interface ExpertValidateSuccess {
  ok: true
  draftId: string
  contentVersion: number
  phase: ExpertDraftPhase
  changed: boolean
  manifestHash: string
  validation: ExpertValidation
}

export type ExpertValidateResult = ExpertValidateSuccess | ExpertOperationFailure

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function issue(code: ExpertErrorCode, field: string, message: string): ExpertIssue {
  return { code, field, message }
}

/**
 * `ExpertIssue.code` 是**宽松的 string**（同一个字段还要放 `PersonaDiagnosticCode`），
 * 所以往上抬成 `ExpertErrorCode` 时必须显式收窄：不是已知枚举值就退回调用方给的兜底值，
 * 而不是硬断言（硬断言会让一个笔误的 code 一路流到 HTTP 契约外面）。
 */
function asExpertErrorCode(code: string | undefined, fallback: ExpertErrorCode): ExpertErrorCode {
  return code !== undefined && isExpertErrorCode(code) ? code : fallback
}

/**
 * 人格正文失败的**首要原因码**。
 *
 * 这里不做"是不是已知枚举值"的收窄：`persona.errors[].code` 只有两个来源 ——
 * `parsePersonaDocument()` 的诊断（类型就是 `PersonaDiagnosticCode`）和本文件的
 * `issue()`（类型就是 `ExpertErrorCode`）—— 两者都是契约内的合法值，
 * 收窄反而会把 `oversized-body` 降级成 `invalid-payload`（AX-E07/E08 要的就是原码）。
 */
function personaFailureCode(code: string | undefined): ExpertErrorCode | PersonaDiagnosticCode {
  if (code === undefined) return 'invalid-payload'
  return isExpertErrorCode(code) ? code : (code as PersonaDiagnosticCode)
}

/** 按 (code, field, message) 去重后入列：同一件事只报一次，避免"三个模块各报一遍"。 */
function pushUnique(list: ExpertIssue[], entry: ExpertIssue): void {
  const hit = list.some((item) => item.code === entry.code && item.field === entry.field && item.message === entry.message)
  if (hit === false) list.push(entry)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 稳定顺序：先 area 后 path（与 manifestHash 的排序口径一致，便于"同内容 → changed:false"）。 */
function sortStagedFiles(files: readonly ExpertStagedFile[]): ExpertStagedFile[] {
  return [...files].sort((left, right) => {
    if (left.area !== right.area) return left.area < right.area ? -1 : 1
    if (left.path === right.path) return 0
    return left.path < right.path ? -1 : 1
  })
}

/** 索引条目的身份键（area + path 的**精确**文本）。 */
function fileKey(area: ExpertFileArea, path: string): string {
  return `${area}\u0000${path}`
}

/**
 * 索引路径 → 相对该 area 根的磁盘相对路径（**唯一一处**拼暂存路径的地方）。
 *
 * `<areaRoot>/.pending/<draftId>/files/<path>`（人格附件）或
 * `<areaRoot>/.pending/<draftId>/<skillName>/<path>`（skill 包），与规格 §3.1 逐字对应。
 *
 * **导出给安装器**（`src/experts/install.ts`）：安装要按同一张账本把暂存原件读回来，
 * 拼法再写一份就一定会和暂存侧分叉（改一处、漏一处 = 安装读到不存在的路径）。
 */
export function expertStagedRelativePath(area: ExpertFileArea, draftId: string, path: string): string {
  const base = `${EXPERT_PENDING_DIR_NAME}/${draftId}`
  return area === 'skill' ? `${base}/${path}` : `${base}/${EXPERT_PENDING_FILES_DIR_NAME}/${path}`
}

function areaRoot(roots: ExpertRoots, area: ExpertFileArea): string {
  return rootForArea(roots, area === 'skill' ? 'skill' : 'persona')
}

/** 归档原件：允许超过"模型可读"字符上限，只给 warning、不截断。 */
function isArchiveOriginal(path: string): boolean {
  return /^sources\/[a-z0-9][a-z0-9-]{0,47}\/original\.md$/.test(path)
}

/** 许可全文：同样保留完整文件，超字符上限只给 warning。 */
function isLicenseCopy(path: string): boolean {
  return /^sources\/[a-z0-9][a-z0-9-]{0,47}\/LICENSE\.txt$/.test(path)
}

// ---------------------------------------------------------------------------
// 进程内 draft 互斥
// ---------------------------------------------------------------------------

const heldDrafts = new Set<string>()

/**
 * 同步互斥：只在下述情况下拒绝——同一草稿的操作**重入**（典型来源是测试的 `failpoint`
 * 钩子在写文件之后又调一次工具）。串行调用者永远走得到业务逻辑。
 *
 * **导出给安装器**（§6.4 第 1 步"取 draft mutex"）：安装必须与暂存/校验共用**同一把**
 * 进程内互斥，另造一把会让"装到一半又被 stage"变成可能。
 */
export function withExpertDraftMutex<T>(draftId: string, operation: () => T): T {
  if (heldDrafts.has(draftId)) {
    throw new ExpertRepoError(
      'install-in-progress',
      `草稿 ${draftId} 正被本进程的另一次操作持有（同一草稿的进程内互斥）；请等这次操作结束后再用新版本重试`,
    )
  }
  heldDrafts.add(draftId)
  try {
    return operation()
  } finally {
    heldDrafts.delete(draftId)
  }
}

/**
 * `withExpertDraftMutex` 的工具层包装：重入（同一草稿的第二次操作）**必须变成 `ok:false`
 * 的稳定失败结果**，而不是把异常抛到工具层——工具层只认返回对象。
 */
function runInMutex<T>(draftId: string, operation: () => T, currentVersion?: number): T | ExpertOperationFailure {
  try {
    return withExpertDraftMutex(draftId, operation)
  } catch (error) {
    const failure = expertRepoFailure(error, 'draftId', currentVersion)
    if (failure !== undefined) return failure
    throw error
  }
}

// ---------------------------------------------------------------------------
// owner 守卫（§5.1：五个工具共用的同一个）
// ---------------------------------------------------------------------------

export interface ExpertDraftOwnerInput {
  draftId: unknown
  /**
   * **真实执行会话 id**（`exec.agent.session.id`）。工具参数里没有它，
   * 所以模型无法用"参数里的当前会话"替换执行身份。
   */
  sessionId: unknown
  /** 要求 `contentVersion` 恰好等于它；不传就只做身份/状态守卫。 */
  expectedVersion?: unknown
}

export interface ExpertOwnedDraft {
  draft: DraftRow
  payload: ExpertDraftPayload
}

/** 会话身份缺失时的统一文案（与 `src/personas/binding.ts` 的 `no-session` 同源口径）。 */
export const EXPERT_NO_SESSION_MESSAGE =
  '无法确定当前会话：本工具只能读取**执行上下文里的真实会话 id**，没有任何 session_id 入参。请在专家生成会话内调用它。'

/**
 * 草稿所有权守卫：真实 sessionId 非空 → 草稿存在且 kind=expert → sessionId 相等 →
 * 外层 pending → payload schema 版本 → `contentVersion` 相等 → phase 不是 installing。
 *
 * @throws ExpertRepoError `invalid-payload` / `draft-not-found` / `draft-owner-mismatch` /
 *   `draft-not-pending` / `unknown-schema-version` / `draft-version-conflict` / `install-in-progress`
 */
export function assertExpertDraftOwner(context: ExpertDraftContext, input: ExpertDraftOwnerInput): ExpertOwnedDraft {
  return loadOwnedDraft(context, input, true)
}

/**
 * 守卫的**唯一实现**。`requireSession=false` 只给 HTTP 用户操作路径用
 * （浏览器没有 live Agent 身份，`validateDraft(id, expectedVersion)` 也没有会话参数）——
 * 工具的入口**永远**走 `requireSession=true`，否则"身份只看执行上下文"就破了。
 */
function loadOwnedDraft(
  context: ExpertDraftContext,
  input: ExpertDraftOwnerInput,
  requireSession: boolean,
): ExpertOwnedDraft {
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : ''
  if (draftId === '') {
    throw new ExpertRepoError('invalid-payload', 'draft_id 必填（要操作的那份专家草稿）')
  }
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  if (requireSession && sessionId === '') {
    throw new ExpertRepoError('draft-owner-mismatch', EXPERT_NO_SESSION_MESSAGE)
  }

  const draft = getExpertDraft(context.db, draftId)
  if (draft === undefined) throw new ExpertRepoError('draft-not-found', `专家草稿不存在：${draftId}`)
  /**
   * 草稿 id 会被拼进暂存路径（`.pending/<draftId>/...`）。服务端只生成 UUID，
   * 但**读回来的东西不能自证可信**：形状不对就拒绝用它拼路径。
   */
  if (isExpertUuid(draft.id) === false) {
    throw new ExpertRepoError('invalid-payload', `草稿 id 不是标准小写 UUID，拒绝用它拼暂存路径：${draft.id}`)
  }
  if (requireSession && draft.sessionId !== sessionId) {
    throw new ExpertRepoError(
      'draft-owner-mismatch',
      `这份专家草稿属于另一个会话（草稿会话 ${draft.sessionId ?? '未知'}），本会话（${sessionId}）不能查看或修改它`,
    )
  }
  if (draft.statusCode !== 'pending') {
    throw new ExpertRepoError('draft-not-pending', `专家草稿当前状态是 ${draft.statusCode}，不可再修改`)
  }

  const payload = draft.payload as unknown as ExpertDraftPayload
  if (payload.version !== EXPERT_DRAFT_PAYLOAD_VERSION) {
    throw new ExpertRepoError(
      'unknown-schema-version',
      `专家草稿 payload 版本是 ${String(payload.version)}，本版只认 ${EXPERT_DRAFT_PAYLOAD_VERSION}`,
    )
  }
  if (Number.isInteger(payload.contentVersion) === false || payload.contentVersion < 0) {
    throw new ExpertRepoError('unknown-schema-version', `专家草稿的 contentVersion 非法：${String(payload.contentVersion)}`)
  }
  if (input.expectedVersion !== undefined) {
    const expected = input.expectedVersion
    if (Number.isInteger(expected) === false || (expected as number) < 0 || expected !== payload.contentVersion) {
      throw new ExpertRepoError(
        'draft-version-conflict',
        `expected_version=${String(expected)} 与当前 contentVersion=${payload.contentVersion} 不一致；请用最新版本重试`,
      )
    }
  }
  if (payload.phase === 'installing') {
    throw new ExpertRepoError('install-in-progress', '正在安装的专家草稿不可修改；请等待安装结束或走恢复')
  }
  return { draft, payload }
}

/**
 * 守卫抛错时回填 `currentVersion` 用：守卫失败往往正是因为它读到了另一个版本，
 * 失败结果必须把**当前真实版本**告诉调用方（§5.1 的 `currentVersion?` 字段）。
 */
export function expertDraftCurrentVersion(context: ExpertDraftContext, draftId: unknown): number | undefined {
  if (typeof draftId !== 'string' || draftId.trim() === '') return undefined
  const draft = getExpertDraft(context.db, draftId.trim())
  const payload = draft?.payload as unknown as ExpertDraftPayload | undefined
  const version = payload?.contentVersion
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : undefined
}

/** 仓储层异常的稳定转换：`field` 由调用方给定位串。**导出给安装器**共用同一份映射。 */
export function expertRepoFailure(error: unknown, field: string, currentVersion?: number | null): ExpertOperationFailure | undefined {
  if (error instanceof ExpertRepoError) {
    return {
      ok: false,
      code: error.code,
      field,
      message: error.message,
      ...(currentVersion == null ? {} : { currentVersion }),
    }
  }
  return undefined
}

function successMessage(contentVersion: number): string {
  return `专家草稿已更新，尚未安装。下一次操作使用 contentVersion=${contentVersion}。`
}

// ---------------------------------------------------------------------------
// submit：人格 + 来源 + 技能需求
// ---------------------------------------------------------------------------

export interface ExpertSubmitInput {
  draftId: unknown
  sessionId: unknown
  expectedVersion: unknown
  /** 人格 Markdown 原文（服务端会先 `normalizePersonaText`）。 */
  personaMd: unknown
  /** `provenance` 结构（JSON 字符串或已解析对象）。 */
  provenanceJson: unknown
  /** `ExpertSkillRequirement[]`（JSON 字符串或数组）。 */
  skillsJson: unknown
}

/** JSON 字符串/对象双入口解析：**非法 JSON 是 `invalid-json`**，不是"当成空值"。 */
function parseJsonField(raw: unknown, field: string): { ok: true; value: unknown } | { ok: false; issue: ExpertIssue } {
  if (typeof raw !== 'string') return { ok: true, value: raw }
  const text = raw.trim()
  if (text === '') return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return {
      ok: false,
      issue: issue('invalid-json', field, `${field} 不是合法 JSON：${(error as Error).message}`),
    }
  }
}

interface ParsedPersona {
  ok: boolean
  personaMd: string
  errors: ExpertIssue[]
  warnings: ExpertIssue[]
}

/**
 * 人格正文校验（§6.1 第 2 步的共用实现）：归一化 → UTF-8 字节上限 → 现有解析器 →
 * **新 generated 草稿额外的"显示分组 1–40 字符"要求**。不改旧手工/内置人格的 parser 规则。
 */
function checkPersona(personaMdRaw: unknown): ParsedPersona {
  if (typeof personaMdRaw !== 'string') {
    return { ok: false, personaMd: '', errors: [issue('invalid-payload', 'personaMd', 'persona_md 必须是字符串')], warnings: [] }
  }
  const personaMd = normalizePersonaText(personaMdRaw)
  const errors: ExpertIssue[] = []
  const warnings: ExpertIssue[] = []
  const bytes = Buffer.byteLength(personaMd, 'utf8')
  if (bytes > PERSONA_FILE_MAX_BYTES) {
    errors.push(issue('file-too-large', 'personaMd', `人格正文 ${bytes} 字节，超过上限 ${PERSONA_FILE_MAX_BYTES} 字节`))
  }
  const parsed = parsePersonaDocument(personaMd)
  for (const diagnostic of parsed.diagnostics) {
    const entry = issue(diagnostic.code as ExpertErrorCode, 'personaMd', diagnostic.message)
    if (parsed.ok) warnings.push(entry)
    else errors.push(entry)
  }
  if (parsed.ok) {
    const group = (parsed.document?.group ?? '').trim()
    if (group.length < 1 || group.length > 40) {
      errors.push(issue(
        'invalid-payload',
        'personaMd',
        `新生成专家必须在 frontmatter 里给出 1–40 字符的显示分组（group），当前是「${group}」`,
      ))
    }
    if (EXPERT_BODY_MAX_CHARS > 0 && (parsed.document?.body.length ?? 0) > EXPERT_BODY_MAX_CHARS) {
      errors.push(issue('file-too-large', 'personaMd', `人格正文超过上限 ${EXPERT_BODY_MAX_CHARS} 字符`))
    }
  } else {
    errors.push(issue('invalid-payload', 'personaMd', '人格正文未通过解析器，请按 §5.3 模板改写（不改动解析器规则）'))
  }
  return { ok: errors.length === 0, personaMd, errors, warnings }
}

interface ParsedSkills {
  ok: boolean
  skills: ExpertSkillRequirement[]
  errors: ExpertIssue[]
}

/**
 * 技能需求校验。
 *
 * 计数越界统一映射到既有的两个限流 code（错误码是**封闭枚举**，不能临时造新词）：
 * 数量超限 → `file-count-limit`，体积超限 → `package-too-large`。
 */
function checkSkills(raw: unknown, provenance: ExpertProvenance | null): ParsedSkills {
  const errors: ExpertIssue[] = []
  if (raw === undefined || raw === null) return { ok: true, skills: [], errors }
  if (Array.isArray(raw) === false) {
    return { ok: false, skills: [], errors: [issue('invalid-payload', 'skills', 'skills_json 必须是数组（找不到技能就传 []）')] }
  }
  if (raw.length > EXPERT_SKILL_MAX_REQUIREMENTS) {
    errors.push(issue('file-count-limit', 'skills', `技能需求最多 ${EXPERT_SKILL_MAX_REQUIREMENTS} 条，收到 ${raw.length} 条`))
  }

  const skills: ExpertSkillRequirement[] = []
  const seen = new Set<string>()
  let installs = 0
  let reuses = 0
  for (const [index, entry] of raw.entries()) {
    const field = `skills[${index}]`
    if (isPlainObject(entry) === false) {
      errors.push(issue('invalid-payload', field, '每条技能需求都必须是对象'))
      continue
    }
    const name = entry.name
    if (typeof name !== 'string' || isExpertSkillName(name) === false) {
      errors.push(issue('invalid-payload', `${field}.name`, `技能名必须是小写 kebab-case（1–64 字符）：「${String(name)}」`))
      continue
    }
    if (seen.has(name)) {
      errors.push(issue('invalid-payload', `${field}.name`, `技能需求里重复出现「${name}」`))
      continue
    }
    if (entry.required !== true && entry.required !== false) {
      errors.push(issue('invalid-payload', `${field}.required`, 'required 必须是真 boolean（不能是字符串）'))
      continue
    }
    const action = entry.action
    if (action !== 'install' && action !== 'reuse') {
      errors.push(issue('invalid-payload', `${field}.action`, `action 只能是 install / reuse，收到 ${JSON.stringify(action)}`))
      continue
    }
    const reason = entry.reason
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(issue('invalid-payload', `${field}.reason`, 'reason 必须非空（说明为什么要这个技能）'))
      continue
    }

    if (action === 'reuse') {
      reuses += 1
      if (entry.sourceId !== null && entry.sourceId !== undefined) {
        errors.push(issue('invalid-payload', `${field}.sourceId`, 'action=reuse 时 sourceId 必须是 null'))
        continue
      }
      const packageFiles = entry.packageFiles
      if (Array.isArray(packageFiles) === false || packageFiles.length > 0) {
        errors.push(issue('invalid-payload', `${field}.packageFiles`, 'action=reuse 时 packageFiles 必须是空数组'))
        continue
      }
      seen.add(name)
      skills.push({ name, required: entry.required, action, sourceId: null, packageFiles: [], reason })
      continue
    }

    // action === 'install'
    installs += 1
    const sourceId = entry.sourceId
    if (typeof sourceId !== 'string' || isExpertSourceId(sourceId) === false) {
      errors.push(issue('invalid-payload', `${field}.sourceId`, `action=install 时必须给出合法 sourceId，收到 ${JSON.stringify(sourceId)}`))
      continue
    }
    const source = provenance?.sources.find((item) => item.id === sourceId)
    if (source === undefined) {
      errors.push(issue('source-invalid', `${field}.sourceId`, `sourceId「${sourceId}」不在 provenance 的来源列表里`))
      continue
    }
    if (source.usedFor.includes('skill') === false) {
      errors.push(issue('source-invalid', `${field}.sourceId`, `来源「${sourceId}」的 usedFor 不含 skill，不能用来支撑 skill 包`))
      continue
    }
    const packageFiles = entry.packageFiles
    if (Array.isArray(packageFiles) === false || packageFiles.length === 0) {
      errors.push(issue('skill-package-invalid', `${field}.packageFiles`, 'action=install 时必须给出非空的 packageFiles 清单'))
      continue
    }
    seen.add(name)
    skills.push({
      name,
      required: entry.required,
      action,
      sourceId,
      packageFiles: packageFiles.filter((item): item is string => typeof item === 'string'),
      reason,
    })
  }

  if (installs > EXPERT_SKILL_MAX_INSTALLS) {
    errors.push(issue('file-count-limit', 'skills', `action=install 最多 ${EXPERT_SKILL_MAX_INSTALLS} 条，收到 ${installs} 条`))
  }
  if (reuses > EXPERT_SKILL_MAX_REUSES) {
    errors.push(issue('file-count-limit', 'skills', `action=reuse 最多 ${EXPERT_SKILL_MAX_REUSES} 条，收到 ${reuses} 条`))
  }
  return { ok: errors.length === 0, skills, errors }
}

/**
 * 提交人格正文与元数据（工具 `workbench_submit_expert_draft`）。
 *
 * **全部校验通过后才 CAS**：任何一项不合格都在写库之前返回 `ok:false`，
 * 之前那份有效草稿逐字保留。
 */
export function submitExpertDraft(context: ExpertDraftContext, input: ExpertSubmitInput): ExpertOperationResult {
  let owned: ExpertOwnedDraft
  try {
    owned = assertExpertDraftOwner(context, {
      draftId: input.draftId,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
    })
  } catch (error) {
    const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(context, input.draftId))
    if (failure !== undefined) return failure
    throw error
  }

  return runInMutex<ExpertOperationResult>(owned.draft.id, () => {
    const persona = checkPersona(input.personaMd)
    if (persona.ok === false) {
      return {
        ok: false,
        code: personaFailureCode(persona.errors[0]?.code),
        field: persona.errors[0]?.field ?? 'personaMd',
        message: persona.errors.map((entry) => entry.message).join('；'),
        currentVersion: owned.payload.contentVersion,
        errors: persona.errors,
      } satisfies ExpertOperationFailure
    }

    const provenanceRaw = parseJsonField(input.provenanceJson, 'provenance_json')
    if (provenanceRaw.ok === false) {
      return {
        ok: false,
        code: asExpertErrorCode(provenanceRaw.issue.code, 'invalid-json'),
        field: provenanceRaw.issue.field,
        message: provenanceRaw.issue.message,
        currentVersion: owned.payload.contentVersion,
        errors: [provenanceRaw.issue],
      } satisfies ExpertOperationFailure
    }

    const skillsRaw = parseJsonField(input.skillsJson, 'skills_json')
    if (skillsRaw.ok === false) {
      return {
        ok: false,
        code: asExpertErrorCode(skillsRaw.issue.code, 'invalid-json'),
        field: skillsRaw.issue.field,
        message: skillsRaw.issue.message,
        currentVersion: owned.payload.contentVersion,
        errors: [skillsRaw.issue],
      } satisfies ExpertOperationFailure
    }
    const rawSkills = skillsRaw.value ?? []
    const expectsSkillSource = Array.isArray(rawSkills)
      && rawSkills.some((entry) => isPlainObject(entry) && entry.action === 'install')

    const provenanceResult = parseExpertProvenance(provenanceRaw.value, { expectSkills: expectsSkillSource })
    if (provenanceResult.ok === false) {
      return {
        ok: false,
        code: asExpertErrorCode(provenanceResult.errors[0]?.code, 'invalid-payload'),
        field: provenanceResult.errors[0]?.field ?? 'provenance_json',
        message: provenanceResult.errors.map((entry) => entry.message).join('；'),
        currentVersion: owned.payload.contentVersion,
        errors: provenanceResult.errors,
      } satisfies ExpertOperationFailure
    }

    const skillsResult = checkSkills(rawSkills, provenanceResult.provenance)
    if (skillsResult.ok === false) {
      return {
        ok: false,
        code: asExpertErrorCode(skillsResult.errors[0]?.code, 'invalid-payload'),
        field: skillsResult.errors[0]?.field ?? 'skills_json',
        message: skillsResult.errors.map((entry) => entry.message).join('；'),
        currentVersion: owned.payload.contentVersion,
        errors: skillsResult.errors,
      } satisfies ExpertOperationFailure
    }

    try {
      context.failpoint?.('submit.before-cas')
      const updated = updateExpertDraftCas(context.db, owned.draft.id, owned.payload.contentVersion, {
        personaMd: persona.personaMd,
        provenance: provenanceResult.provenance,
        skills: skillsResult.skills,
      })
      return {
        ok: true,
        draftId: updated.draft.id,
        contentVersion: updated.payload.contentVersion,
        phase: updated.payload.phase,
        changed: updated.changed,
        errors: [],
        warnings: [...provenanceResult.warnings, ...persona.warnings],
        message: successMessage(updated.payload.contentVersion),
      } satisfies ExpertOperationSuccess
    } catch (error) {
      const failure = expertRepoFailure(error, 'draftId', owned.payload.contentVersion)
      if (failure !== undefined) return failure
      throw error
    }
  })
}

// ---------------------------------------------------------------------------
// stage / remove / read：暂存文件
// ---------------------------------------------------------------------------

export interface ExpertStageInput {
  draftId: unknown
  sessionId: unknown
  expectedVersion: unknown
  area: unknown
  path: unknown
  /** UTF-8 文本（**原样落盘**：许可文本的 CRLF 与版权行不会被重排）。 */
  contentUtf8: unknown
}

export interface ExpertRemoveInput {
  draftId: unknown
  sessionId: unknown
  expectedVersion: unknown
  area: unknown
  path: unknown
}

export interface ExpertReadStagedFileInput {
  draftId: unknown
  area: unknown
  path: unknown
}

/** 读一份"我们拥有的"暂存文件原始字节：拒绝链接、非普通文件、超限与非 UTF-8 文本。 */
function readOwnedStagedBytes(
  context: ExpertDraftContext,
  root: string,
  relativePath: string,
): { ok: true; bytes?: Buffer } | { ok: false; problem: ExpertPathProblem } {
  const linkOptions = context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }
  const linkCheck = assertNoLinksInsideRoot(root, relativePath, linkOptions)
  if (linkCheck.ok === false) return { ok: false, problem: linkCheck.problem }
  let stats
  try {
    stats = lstatSync(join(root, relativePath))
  } catch {
    return { ok: true, bytes: undefined }
  }
  if (stats.isFile() === false) {
    return { ok: false, problem: { code: 'invalid-path', message: `暂存目标不是普通文件（拒绝当文件处理）：${relativePath}` } }
  }
  if (stats.size > EXPERT_STAGED_FILE_MAX_BYTES) {
    return {
      ok: false,
      problem: { code: 'file-too-large', message: `暂存目标 ${stats.size} 字节，超过单文件上限 ${EXPERT_STAGED_FILE_MAX_BYTES} 字节：${relativePath}` },
    }
  }
  const bytes = readFileSync(join(root, relativePath))
  /** 只覆盖"本插件写过的 UTF-8 文本"：别的字节序列（第三方二进制）一律不动。 */
  if (Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) === false) {
    return { ok: false, problem: { code: 'invalid-path', message: `暂存目标不是 UTF-8 文本，拒绝覆盖：${relativePath}` } }
  }
  return { ok: true, bytes }
}

/**
 * 暂存**一个** UTF-8 文件并更新索引（工具 `workbench_stage_expert_file`）。
 *
 * 顺序：owner 守卫 → 路径形状与碰撞 → 内容尺寸 → 配额 → **写文件 → CAS**。
 * CAS 失败时，只有"磁盘上仍是本次刚写入的那份哈希"才回滚到写入前的字节。
 */
export function stageExpertFile(context: ExpertDraftContext, input: ExpertStageInput): ExpertOperationResult {
  let owned: ExpertOwnedDraft
  try {
    owned = assertExpertDraftOwner(context, {
      draftId: input.draftId,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
    })
  } catch (error) {
    const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(context, input.draftId))
    if (failure !== undefined) return failure
    throw error
  }

  return runInMutex<ExpertOperationResult>(owned.draft.id, () => {
    const payload = owned.payload
    const fail = (code: ExpertErrorCode, field: string, message: string, errors?: ExpertIssue[]): ExpertOperationFailure => ({
      ok: false,
      code,
      field,
      message,
      currentVersion: payload.contentVersion,
      ...(errors === undefined ? {} : { errors }),
    })

    const area = input.area
    if (area !== 'persona-resource' && area !== 'skill') {
      return fail('invalid-payload', 'area', `area 只能是 persona-resource / skill，收到 ${JSON.stringify(area)}`)
    }
    const path = input.path
    if (typeof path !== 'string') return fail('invalid-path', 'path', 'path 必须是字符串（相对该 area 的暂存根）')

    const sameArea = payload.files.filter((file) => file.area === area)
    const shape = validateExpertRelativePath(area, path, {
      existing: sameArea.map((file) => file.path),
      self: path,
      ...(context.platform === undefined ? {} : { platform: context.platform }),
    })
    if (shape !== undefined) return fail(shape.code, 'path', shape.message)

    const contentUtf8 = input.contentUtf8
    if (typeof contentUtf8 !== 'string') return fail('invalid-payload', 'content_utf8', 'content_utf8 必须是字符串')

    const bytes = Buffer.byteLength(contentUtf8, 'utf8')
    const sizeProblem = validateStagedFileContent(path, bytes)
    if (sizeProblem !== undefined) return fail(sizeProblem.code, 'content_utf8', sizeProblem.message)

    const others = payload.files.filter((file) => fileKey(file.area, file.path) !== fileKey(area, path))
    if (others.length + 1 > EXPERT_DRAFT_MAX_FILES) {
      return fail('file-count-limit', 'files', `一份草稿最多 ${EXPERT_DRAFT_MAX_FILES} 个暂存文件，本次将变成 ${others.length + 1} 个`)
    }
    const totalBytes = others.reduce((sum, file) => sum + file.bytes, 0) + bytes
    if (totalBytes > EXPERT_DRAFT_MAX_TOTAL_BYTES) {
      return fail('package-too-large', 'files', `暂存内容总量 ${totalBytes} 字节，超过上限 ${EXPERT_DRAFT_MAX_TOTAL_BYTES} 字节`)
    }

    const root = areaRoot(context.roots, area)
    const relative = expertStagedRelativePath(area, owned.draft.id, path)
    const target = join(root, relative)
    const before = readOwnedStagedBytes(context, root, relative)
    if (before.ok === false) return fail(before.problem.code, 'path', before.problem.message)

    const written = atomicWriteText(target, contentUtf8, {
      root,
      ...(context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }),
    })
    if (written.ok === false) return fail(written.problem.code, 'path', written.problem.message)

    /**
     * 回滚：**只在"磁盘上仍是本次刚写入的那份哈希"时**恢复写入前的字节。
     * 任何第三方变化（哈希不同、文件被删、被换成链接/目录）一律不碰。
     */
    const rollback = (): void => {
      let current: Buffer
      try {
        if (lstatSync(target).isFile() === false) return
        current = readFileSync(target)
      } catch {
        return
      }
      if (sha256Hex(current) !== written.sha256) return
      if (before.bytes === undefined) {
        try {
          unlinkSync(target)
        } catch {
          /** 文件已经不在了：索引本来就没有它，无需再做什么。 */
        }
        return
      }
      atomicWriteText(target, before.bytes.toString('utf8'), {
        root,
        ...(context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }),
      })
    }

    try {
      context.failpoint?.('stage.after-file-write')
      context.failpoint?.('stage.before-cas')
      const nextFiles = sortStagedFiles([
        ...others,
        { area, path, bytes: written.bytes, sha256: written.sha256 },
      ])
      const updated = updateExpertDraftCas(context.db, owned.draft.id, payload.contentVersion, { files: nextFiles })
      return {
        ok: true,
        draftId: updated.draft.id,
        contentVersion: updated.payload.contentVersion,
        phase: updated.payload.phase,
        changed: updated.changed,
        errors: [],
        warnings: [],
        message: successMessage(updated.payload.contentVersion),
      } satisfies ExpertOperationSuccess
    } catch (error) {
      rollback()
      const failure = expertRepoFailure(error, 'draftId', payload.contentVersion)
      if (failure !== undefined) return failure
      throw error
    }
  })
}

/**
 * 删除**索引里属于这份草稿**的一个暂存文件（工具 `workbench_remove_expert_staged_file`）。
 *
 * 不在索引里 → `ok:true, changed:false`（幂等），**不做任何文件操作**；
 * 落点只按索引里记的那条路径算，不会因为调用方给了一个奇怪字符串就去 rm 别的目录。
 */
export function removeExpertStagedFile(context: ExpertDraftContext, input: ExpertRemoveInput): ExpertOperationResult {
  let owned: ExpertOwnedDraft
  try {
    owned = assertExpertDraftOwner(context, {
      draftId: input.draftId,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
    })
  } catch (error) {
    const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(context, input.draftId))
    if (failure !== undefined) return failure
    throw error
  }

  return runInMutex<ExpertOperationResult>(owned.draft.id, () => {
    const payload = owned.payload
    const area = input.area
    if (area !== 'persona-resource' && area !== 'skill') {
      return {
        ok: false,
        code: 'invalid-payload',
        field: 'area',
        message: `area 只能是 persona-resource / skill，收到 ${JSON.stringify(area)}`,
        currentVersion: payload.contentVersion,
      } satisfies ExpertOperationFailure
    }
    const path = input.path
    if (typeof path !== 'string') {
      return {
        ok: false,
        code: 'invalid-path',
        field: 'path',
        message: 'path 必须是字符串',
        currentVersion: payload.contentVersion,
      } satisfies ExpertOperationFailure
    }
    const shape = validateExpertRelativePath(area, path, context.platform === undefined ? {} : { platform: context.platform })
    if (shape !== undefined) {
      return { ok: false, code: shape.code, field: 'path', message: shape.message, currentVersion: payload.contentVersion }
    }

    const wantedKey = expertPathCompareKey(area, path, context.platform ?? process.platform)
    const entry = payload.files.find((file) => file.area === area && expertPathCompareKey(file.area, file.path, context.platform ?? process.platform) === wantedKey)
    if (entry === undefined) {
      return {
        ok: true,
        draftId: owned.draft.id,
        contentVersion: payload.contentVersion,
        phase: payload.phase,
        changed: false,
        errors: [],
        warnings: [],
        message: `暂存索引里没有「${path}」，本次没有删除任何文件（contentVersion=${payload.contentVersion}）。`,
      } satisfies ExpertOperationSuccess
    }

    const root = areaRoot(context.roots, area)
    /** 落点只按**索引里记的**路径算 —— 绝不拿调用方给的字符串去算目录。 */
    const relative = expertStagedRelativePath(area, owned.draft.id, entry.path)
    const target = join(root, relative)
    const before = readOwnedStagedBytes(context, root, relative)
    if (before.ok === false) {
      return { ok: false, code: before.problem.code, field: 'path', message: before.problem.message, currentVersion: payload.contentVersion }
    }
    if (before.bytes !== undefined) {
      try {
        unlinkSync(target)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code !== 'ENOENT') {
          return { ok: false, code: 'invalid-path', field: 'path', message: `删除暂存文件失败：${(error as Error).message}`, currentVersion: payload.contentVersion }
        }
      }
    }

    try {
      context.failpoint?.('remove.after-file-delete')
      context.failpoint?.('remove.before-cas')
      const nextFiles = payload.files.filter((file) => fileKey(file.area, file.path) !== fileKey(entry.area, entry.path))
      const updated = updateExpertDraftCas(context.db, owned.draft.id, payload.contentVersion, { files: nextFiles })
      return {
        ok: true,
        draftId: updated.draft.id,
        contentVersion: updated.payload.contentVersion,
        phase: updated.payload.phase,
        changed: updated.changed,
        errors: [],
        warnings: [],
        message: successMessage(updated.payload.contentVersion),
      } satisfies ExpertOperationSuccess
    } catch (error) {
      /** 文件已删、DB 未改：把字节放回去，避免"索引还在、文件没了"。 */
      if (before.bytes !== undefined) {
        atomicWriteText(target, before.bytes.toString('utf8'), {
          root,
          ...(context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }),
        })
      }
      const failure = expertRepoFailure(error, 'draftId', payload.contentVersion)
      if (failure !== undefined) return failure
      throw error
    }
  })
}

/** 读一份**索引里属于这份草稿**的暂存文件（HTTP `GET /drafts/:id/file`）。 */
export function readExpertStagedFile(
  context: ExpertDraftContext,
  input: ExpertReadStagedFileInput,
): ExpertFileView | ExpertOperationFailure {
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : ''
  if (draftId === '') return { ok: false, code: 'invalid-payload', field: 'draftId', message: 'draft id 必填' }
  const draft = getExpertDraft(context.db, draftId)
  if (draft === undefined) return { ok: false, code: 'draft-not-found', field: 'draftId', message: `专家草稿不存在：${draftId}` }
  const area = input.area
  if (area !== 'persona-resource' && area !== 'skill') {
    return { ok: false, code: 'invalid-payload', field: 'area', message: `area 只能是 persona-resource / skill，收到 ${JSON.stringify(area)}` }
  }
  const path = input.path
  if (typeof path !== 'string') return { ok: false, code: 'invalid-path', field: 'path', message: 'path 必须是字符串' }

  const payload = draft.payload as unknown as ExpertDraftPayload
  const files = Array.isArray(payload.files) ? payload.files : []
  const wantedKey = expertPathCompareKey(area, path, context.platform ?? process.platform)
  const entry = files.find((file) => file.area === area && expertPathCompareKey(file.area, file.path, context.platform ?? process.platform) === wantedKey)
  if (entry === undefined) {
    return { ok: false, code: 'invalid-path', field: 'path', message: `这份草稿的暂存索引里没有「${path}」（只能读本草稿索引中的文件）` }
  }

  const root = areaRoot(context.roots, area)
  const relative = expertStagedRelativePath(area, draft.id, entry.path)
  const read = readExpertTextFile(root, relative, {
    maxBytes: EXPERT_STAGED_FILE_MAX_BYTES,
    ...(context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }),
  })
  if (read.ok === false || read.sha256 === undefined || read.bytes === undefined || read.text === undefined) {
    return {
      ok: false,
      code: 'staged-file-changed',
      field: 'path',
      message: `索引里的文件与磁盘不一致（${read.problem?.message ?? '读不回来'}）：不自动确认，请按当前版本重新 stage 该文件`,
    }
  }
  if (read.sha256 !== entry.sha256 || read.bytes !== entry.bytes) {
    return {
      ok: false,
      code: 'staged-file-changed',
      field: 'path',
      message: `磁盘内容与索引不一致（索引 ${entry.bytes} 字节，磁盘 ${read.bytes} 字节）：不自动确认，请按当前版本重新 stage 该文件`,
    }
  }
  return {
    draftId: draft.id,
    area,
    path: entry.path,
    text: read.text,
    bytes: read.bytes,
    sha256: read.sha256,
    archivedOnly: isArchiveOriginal(entry.path),
  }
}

// ---------------------------------------------------------------------------
// validate：§6.1 的十步
// ---------------------------------------------------------------------------

export interface ExpertValidateInput {
  draftId: unknown
  expectedVersion: unknown
  /**
   * 真实执行会话 id。**给了（含 `null`）就强制走 owner 守卫**；
   * 完全不传这个键 = HTTP 用户操作路径（浏览器没有 live Agent 身份）。
   */
  sessionId?: unknown
}

/** `validateExpertDraft` 的行为开关（默认值就是既有 HTTP 路径的行为）。 */
export interface ExpertValidateOptions {
  /**
   * `false` = **调用方已经持有**该草稿的进程内互斥，不要再取一次。
   *
   * 安装器的 `confirm` 就是这样：它先取互斥（挡住并发确认），第 3 步才在同一调用栈里
   * 调 `validateExpertDraft` 重新跑校验。默认 `true`。
   */
  mutex?: boolean
}

/** 读正式技能目录里已有的同名 skill 管理清单（判"能不能覆盖"）。 */
function readExistingSkillInstall(
  context: ExpertDraftContext,
  name: string,
): { existing?: WorkbenchSkillExistingInstall; problem?: ExpertPathProblem } {
  const root = context.roots.skillsDir
  const relative = name
  const linkOptions = context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }
  const linkCheck = assertNoLinksInsideRoot(root, relative, linkOptions)
  if (linkCheck.ok === false) return { problem: linkCheck.problem }
  let stats
  try {
    stats = lstatSync(join(root, relative))
  } catch {
    return {}
  }
  if (stats.isDirectory() === false) {
    return { problem: { code: 'invalid-path', message: `正式 skills 根下已有同名条目「${name}」但不是目录，拒绝覆盖` } }
  }
  const manifest = readExpertTextFile(root, `${name}/workbench-install.json`, linkOptions)
  if (manifest.ok === false || manifest.text === undefined) return { existing: { managed: false } }
  try {
    const parsed = JSON.parse(manifest.text) as unknown
    if (isPlainObject(parsed) && typeof parsed.packageHash === 'string') {
      return { existing: { managed: true, packageHash: parsed.packageHash } }
    }
  } catch {
    /** 清单坏了 = 没有可信的管理清单 → 拒绝覆盖。 */
    return { existing: { managed: false } }
  }
  return { existing: { managed: false } }
}

/**
 * 完整校验（§6.1 十步），返回并落库的 `validation`。
 *
 * 两个刻意的行为：
 * - **有错也是 `ok:true`**：`validation.errors` 非空、`phase` 留在 `editing`，
 *   这正是 HTTP 契约（"有错仍 200，但 errors 非空"）。
 * - **验证前重读真实文件**：索引只是账本，磁盘才是事实；不一致一律
 *   `staged-file-changed`，不自动确认、不替用户"修好"。
 */
export function validateExpertDraft(
  context: ExpertDraftContext,
  input: ExpertValidateInput,
  options: ExpertValidateOptions = {},
): ExpertValidateResult {
  const requireOwner = Object.prototype.hasOwnProperty.call(input, 'sessionId')
  let owned: ExpertOwnedDraft
  try {
    owned = loadOwnedDraft(context, { draftId: input.draftId, sessionId: input.sessionId, expectedVersion: input.expectedVersion }, requireOwner)
  } catch (error) {
    const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(context, input.draftId))
    if (failure !== undefined) return failure
    throw error
  }

  const run = (): ExpertValidateResult => {
    const payload = owned.payload
    const errors: ExpertIssue[] = []
    const warnings: ExpertIssue[] = []

    // ---- 步骤 2：人格正文 ----
    const persona = checkPersona(payload.personaMd)
    for (const entry of persona.errors) pushUnique(errors, entry)
    for (const entry of persona.warnings) pushUnique(warnings, entry)

    // ---- 步骤 3：来源与许可结构（真正的许可文本要读磁盘，所以放到步骤 4 之后） ----
    let provenance: ExpertProvenance | null = null
    if (payload.provenance === null || payload.provenance === undefined) {
      pushUnique(errors, issue('invalid-payload', 'provenance', '尚未提交来源登记（provenance_json），无法校验许可链'))
    } else {
      const reparsed = parseExpertProvenance(payload.provenance, {
        expectSkills: payload.skills.some((requirement) => requirement.action === 'install'),
      })
      if (reparsed.ok) {
        provenance = reparsed.provenance
        for (const entry of reparsed.warnings) pushUnique(warnings, entry)
      } else {
        for (const entry of reparsed.errors) pushUnique(errors, entry)
        for (const entry of reparsed.warnings) pushUnique(warnings, entry)
      }
    }

    // ---- 步骤 4：重读暂存索引文件（索引只是账本，磁盘才是事实） ----
    const indexFiles = Array.isArray(payload.files) ? payload.files : []
    if (indexFiles.length > EXPERT_DRAFT_MAX_FILES) {
      pushUnique(errors, issue('file-count-limit', 'files', `暂存索引有 ${indexFiles.length} 个文件，超过上限 ${EXPERT_DRAFT_MAX_FILES}`))
    }
    const indexTotalBytes = indexFiles.reduce((sum, file) => sum + (Number.isInteger(file.bytes) ? file.bytes : 0), 0)
    if (indexTotalBytes > EXPERT_DRAFT_MAX_TOTAL_BYTES) {
      pushUnique(errors, issue('package-too-large', 'files', `暂存内容总量 ${indexTotalBytes} 字节，超过上限 ${EXPERT_DRAFT_MAX_TOTAL_BYTES} 字节`))
    }

    const verified = new Map<string, { file: ExpertStagedFile; text: string; sha256: string; bytes: number }>()
    for (const file of indexFiles) {
      const field = `files.${file.area}:${file.path}`
      if (file.area !== 'persona-resource' && file.area !== 'skill') {
        pushUnique(errors, issue('invalid-path', field, `索引里的 area 非法：${JSON.stringify(file.area)}`))
        continue
      }
      const shape = validateExpertRelativePath(file.area, file.path, context.platform === undefined ? {} : { platform: context.platform })
      if (shape !== undefined) {
        pushUnique(errors, issue(shape.code, field, `索引里的路径已不合法：${shape.message}`))
        continue
      }
      const root = areaRoot(context.roots, file.area)
      const relative = expertStagedRelativePath(file.area, owned.draft.id, file.path)
      const read = readExpertTextFile(root, relative, {
        maxBytes: EXPERT_STAGED_FILE_MAX_BYTES,
        ...(context.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: context.allowRootLinkUnder }),
      })
      if (read.ok === false || read.text === undefined || read.sha256 === undefined || read.bytes === undefined) {
        pushUnique(errors, issue(
          'staged-file-changed',
          field,
          `索引里的文件读不回来（${read.problem?.message ?? '未知原因'}）：不自动确认，请按当前 contentVersion 重新 stage 该文件`,
        ))
        continue
      }
      if (read.sha256 !== file.sha256 || read.bytes !== file.bytes) {
        pushUnique(errors, issue(
          'staged-file-changed',
          field,
          `磁盘内容与索引不一致（索引 ${file.bytes} 字节 / ${String(file.sha256).slice(0, 12)}…，磁盘 ${read.bytes} 字节 / ${read.sha256.slice(0, 12)}…）：不自动确认，请按当前 contentVersion 重新 stage 该文件`,
        ))
        continue
      }
      verified.set(fileKey(file.area, file.path), { file, text: read.text, sha256: read.sha256, bytes: read.bytes })
    }

    const verifiedFiles = indexFiles.filter((file) => verified.has(fileKey(file.area, file.path)))
    const lookup = lookupFromStagedFiles(verifiedFiles, (file) => verified.get(fileKey(file.area, file.path))?.text)

    if (provenance !== null) {
      const sourceResult = validateExpertSourceFiles(provenance, lookup, { area: 'persona' })
      for (const entry of sourceResult.errors) pushUnique(errors, entry)
      for (const entry of sourceResult.warnings) pushUnique(warnings, entry)
    }

    // ---- 步骤 5：resources 可读性（归档原件/许可全文超字符上限只给 warning，不截断） ----
    for (const file of verifiedFiles) {
      if (file.area !== 'persona-resource') continue
      const entry = verified.get(fileKey(file.area, file.path))
      if (entry === undefined || entry.text.length <= EXPERT_STAGED_FILE_MAX_CHARS) continue
      const field = `files.${file.path}`
      if (isArchiveOriginal(file.path) || isLicenseCopy(file.path)) {
        pushUnique(warnings, issue(
          'file-too-large',
          field,
          `文件 ${entry.text.length} 字符，超过"模型可读"上限 ${EXPERT_STAGED_FILE_MAX_CHARS} 字符；按归档/许可原文保留完整文件（不截断，模型不能当资源读）`,
        ))
      } else {
        pushUnique(errors, issue(
          'file-too-large',
          field,
          `资源文件 ${entry.text.length} 字符，超过上限 ${EXPERT_STAGED_FILE_MAX_CHARS} 字符；请拆成多个文件`,
        ))
      }
    }

    // ---- 步骤 6–9：技能包与正式目标冲突 ----
    for (const [index, requirement] of (Array.isArray(payload.skills) ? payload.skills : []).entries()) {
      const fieldPrefix = `skills[${index}]`
      if (requirement.action === 'reuse') {
        const reduced = validateWorkbenchSkillPackage({
          requirement,
          files: [],
          ...(context.skills === undefined ? {} : { registry: context.skills }),
        })
        for (const entry of reduced.errors) pushUnique(errors, { ...entry, field: `${fieldPrefix}.${entry.field}` })
        for (const entry of reduced.warnings) pushUnique(warnings, { ...entry, field: `${fieldPrefix}.${entry.field}` })
        continue
      }

      const prefix = `${requirement.name}/`
      const stagedForSkill: WorkbenchSkillPackageFile[] = []
      for (const file of verifiedFiles) {
        if (file.area !== 'skill' || file.path.startsWith(prefix) === false) continue
        const entry = verified.get(fileKey(file.area, file.path))
        if (entry === undefined) continue
        stagedForSkill.push({ path: file.path.slice(prefix.length), bytes: entry.bytes, sha256: entry.sha256 })
      }
      const existingRead = readExistingSkillInstall(context, requirement.name)
      if (existingRead.problem !== undefined) {
        pushUnique(errors, issue(existingRead.problem.code, `${fieldPrefix}.name`, existingRead.problem.message))
      }
      const result = validateWorkbenchSkillPackage({
        requirement,
        files: stagedForSkill,
        readText: (packagePath) => verified.get(fileKey('skill', `${prefix}${packagePath}`))?.text,
        ...(existingRead.existing === undefined ? {} : { existingInstall: existingRead.existing }),
      })
      for (const entry of result.errors) pushUnique(errors, { ...entry, field: `${fieldPrefix}.${entry.field}` })
      for (const entry of result.warnings) pushUnique(warnings, { ...entry, field: `${fieldPrefix}.${entry.field}` })

      /** skill 侧的许可链独立校验：同一来源在 persona 与 skill 各要一份许可副本。 */
      if (provenance !== null) {
        const skillLookup: ExpertFileLookup = {
          find(area, path) {
            if (area !== 'skill') return lookup.find(area, path)
            const entry = verified.get(fileKey('skill', `${prefix}${path}`))
            return entry === undefined ? undefined : { bytes: entry.bytes, sha256: entry.sha256 }
          },
          readText(area, path) {
            if (area !== 'skill') return lookup.readText?.(area, path)
            return verified.get(fileKey('skill', `${prefix}${path}`))?.text
          },
        }
        const sourceResult = validateExpertSourceFiles(provenance, skillLookup, { area: 'skill' })
        for (const entry of sourceResult.errors) pushUnique(errors, { ...entry, field: `${fieldPrefix}.${entry.field}` })
        for (const entry of sourceResult.warnings) pushUnique(warnings, { ...entry, field: `${fieldPrefix}.${entry.field}` })
      }
    }

    // ---- 步骤 10：manifestHash + 落库 ----
    const manifestHash = expertManifestHash({
      expertId: payload.expertId,
      personaMd: payload.personaMd,
      provenance: payload.provenance ?? null,
      skills: payload.skills,
      files: indexFiles,
    })
    const validation: ExpertValidation = {
      version: payload.contentVersion,
      manifestHash,
      checkedAt: (context.now ?? (() => new Date().toISOString()))(),
      errors,
      warnings,
    }

    try {
      context.failpoint?.('validate.before-write')
      const updated = updateExpertDraftCas(context.db, owned.draft.id, payload.contentVersion, {
        validation,
        phase: errors.length === 0 ? 'validated' : 'editing',
      })
      return {
        ok: true,
        draftId: updated.draft.id,
        contentVersion: updated.payload.contentVersion,
        phase: updated.payload.phase,
        changed: updated.changed,
        manifestHash,
        validation,
      } satisfies ExpertValidateSuccess
    } catch (error) {
      const failure = expertRepoFailure(error, 'draftId', payload.contentVersion)
      if (failure !== undefined) return failure
      throw error
    }
  }

  /**
   * 安装器的 `confirm` 已经持有互斥，再取一次会被自己挡住（`install-in-progress`）
   * —— 那是"并发请求"的信号，不该出现在同一个调用栈里。所以给它一条显式的
   * **复用已有互斥**通道；默认仍然自己取（HTTP 校验路径靠它挡住并发）。
   */
  return options.mutex === false ? run() : runInMutex<ExpertValidateResult>(owned.draft.id, run)
}

/** 草稿的只读视图（供接线层拼 HTTP 响应，不暴露任何绝对路径）。 */
export function expertDraftView(draft: DraftRow): ExpertDraftView {
  const payload = draft.payload as unknown as ExpertDraftPayload
  return {
    draftId: draft.id,
    statusCode: draft.statusCode,
    contentVersion: payload.contentVersion,
    phase: payload.phase,
    expertId: payload.expertId,
    request: payload.request,
    personaMd: payload.personaMd,
    provenance: payload.provenance ?? null,
    skills: Array.isArray(payload.skills) ? payload.skills : [],
    files: Array.isArray(payload.files) ? payload.files : [],
    validation: payload.validation ?? null,
  }
}

/** 校验快照的形状守卫（P5 读回旧草稿时用）。 */
export function isExpertValidation(value: unknown): value is ExpertValidation {
  if (!isPlainObject(value)) return false
  return value.version === EXPERT_VALIDATION_VERSION
    && typeof value.manifestHash === 'string'
    && typeof value.checkedAt === 'string'
    && Array.isArray(value.errors)
    && Array.isArray(value.warnings)
}
