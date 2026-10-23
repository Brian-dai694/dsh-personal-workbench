/**
 * 专家域的**服务层**（规格 §12.2 的固定表面）。
 *
 * ## 这一层是什么
 *
 * HTTP 路由（`api/routes/experts.ts`）与模型工具（`experts/tools.ts`）都**只调这一层**：
 * 域逻辑已经在 P1–P4 的模块里实现过一次（草稿、校验、安装、catalog、技能 provider），
 * 这里**只做接线与形状转换**，一行判断都不复制。
 *
 * ## 三条硬口径
 *
 * 1. **身份只来自 `exec`**：`submit/stage/remove/validate` 的会话 id 取
 *    `exec.agent.session.id`，参数里没有任何 `session_id`（§5.1 最后一行）。
 *    HTTP 用户操作（validate/confirm/abandon）与工具走**同一个** owner 守卫实现
 *    （`assertExpertDraftOwner`），差别只在"要不要校验会话归属"。
 * 2. **roots / now / failpoint 不从 HTTP 取**（§12.2 开头）：根由构造参数决定
 *    （生产缺省 = 宿主目录约定），HTTP 与工具层没有"传一个根进来"的入口。
 * 3. **能力探测必须诚实**：P5 还没有子代理调用能力，所以 `manualSummon` / `autoSummon`
 *    的 `available` 一律是 `false` 且原因写明是 `expert-subagent-unavailable`（P6 才实现）；
 *    `skills.available` 反映**真实**的服务探测结果；`autoSummon.enabled` 是
 *    `readExpertSettings(db)` 读出的**唯一设置真值**，不是缓存也不是入参。
 *
 * ## 相对 §12.2 的**附加**方法（都不改变既有语义，只是把"接线需要的东西"暴露出来）
 *
 * - `currentPendingDraft(sessionId)`：§5.1 的 `workbench_get_expert_draft` **没有参数**，
 *   只能按真实 session 找当前 pending 草稿；`getDraft(id)` 覆盖不了这条路径。
 * - `previewDraft(id)`：§4.1 的 `GET /experts/drafts/:id` 要求"文件漂移明确诊断"，
 *   而 `ExpertDraftView` 只有索引；漂移要拿索引与磁盘比对（复用 `readExpertStagedFile`）。
 * - `confirmDraftDetailed(...)`：§12.2 的 `confirmDraft` 返回 `ExpertInstallResult`，
 *   而幂等回放要能观察 `replayed`（AX-E33）；两个方法共用同一实现，`confirmDraft` 只是投影。
 * - `setSkillInvalidator(fn)`：装配层把 `registration.invalidateSkills` 挂进来
 *   （P4 交接义务 ④：不要把 registration 长期当单例存）。
 * - `projectFailure(error)`：HTTP 侧的**唯一**失败投影（两条路由共用一份），
 *   负责错误码 → 状态码、绝对路径 → 库名（§4 路径投影）。
 *
 * P6 才实现的 invocation 五个方法（`createManualRequest/runManual/runAuto/loadForChild/readForChild`）
 * **不在这里出现**：P5 既不实现也不假装可用（诚实性要求）。
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'

import {
  EXPERT_PENDING_DIR_NAME,
  EXPERT_REQUEST_MAX_CHARS,
  type ExpertErrorCode,
  type ExpertFileArea,
  type ExpertInstallResult,
  type ExpertIssue,
} from '../shared/expert.js'
import type { PersonaDiagnosticCode, PersonaSummary } from '../shared/persona.js'
import { abandonDraft as abandonDraftRow } from '../db/repo/drafts.js'
import {
  ExpertRepoError,
  createExpertDraft,
  defaultExpertId,
  getExpertDraft,
  getPendingExpertDraftForSession,
  readExpertSettings,
  writeExpertSettings,
} from '../db/repo/experts.js'
import { readPersonaSettings } from '../db/repo/personas.js'
import { defaultBuiltinPersonaRoot } from '../personas/library.js'
import {
  assertExpertDraftOwner,
  expertDraftCurrentVersion,
  expertDraftView,
  expertRepoFailure,
  readExpertStagedFile,
  removeExpertStagedFile,
  stageExpertFile,
  submitExpertDraft,
  validateExpertDraft,
  type ExpertDraftContext,
  type ExpertDraftFailpoint,
  type ExpertDraftView,
  type ExpertFileView,
  type ExpertOperationFailure,
  type ExpertOperationResult,
} from './drafts.js'
import {
  confirmExpertDraft,
  recoverExpertInstallations,
  type ExpertInstallContext,
  type ExpertInstallFailpoint,
  type ExpertInstallSuccess,
} from './install.js'
import {
  listExpertCatalog,
  preflightExpert,
  type ExpertCatalogRow,
  type ExpertPreflightResult,
} from './catalog.js'
import {
  probeExpertSkills,
  probeExpertSubagents,
  probeExpertTools,
  projectWorkbenchSkillRegistry,
  readLiveAgentCwd,
  resolveLiveAgentScope,
  selectSpawnProvider,
} from './host-adapter.js'
import {
  createExpertInvocation,
  ExpertInvocationError,
  isSubagentChildAgent,
  type CreateManualRequestInput,
  type CreateManualRequestResult,
  type ExpertInvocationResult,
  type ExpertLoadResult,
  type ExpertResourceResult,
} from './invocation.js'
import {
  EXPERT_GENERATION_TOOL_NAMES,
  RUN_EXPERT_REQUEST_TOOL_NAME,
  SUMMON_EXPERT_TOOL_NAME,
} from './tools.js'
import { WORKBENCH_SKILL_PROVIDER_NAME } from './skill-provider.js'
import type { WorkbenchSkillRegistry } from './skill-package.js'
import { isInsideExpertRoot, resolveExpertRoots, type ExpertRootOptions, type ExpertRoots } from './paths.js'

// ---------------------------------------------------------------------------
// 形状（§4.1 / §12.2）
// ---------------------------------------------------------------------------

/** 一项能力的可用性；`reason` 只在不可用时给，且必须是 §12.1 里的稳定 code。 */
export interface ExpertCapabilityReport {
  available: boolean
  reason: string | null
}

/** 自主召唤：除 available/reason 外必须带**唯一设置真值** `enabled`（§12.2 末条）。 */
export interface ExpertAutoSummonReport extends ExpertCapabilityReport {
  enabled: boolean
}

export interface ExpertCapabilities {
  /** 只表示**服务端**方法论/草稿能力；客户端还要自己检查 `sessions.create`。 */
  generation: ExpertCapabilityReport
  /** 真实探测到的 skills 服务。 */
  skills: ExpertCapabilityReport
  /** 手工召唤：**如实探测**子代理运行时的可用性（P6，§8.5 第 3 步）。 */
  manualSummon: ExpertCapabilityReport
  /** 同上，但要带设置真值 `enabled`（`enabled` 与 `available` 是两件事）。 */
  autoSummon: ExpertAutoSummonReport
  providerName: string
}

/** `GET /experts/catalog` 的响应体（§4.1：管理行 + 可选摘要 + diagnostics）。 */
export interface ExpertCatalogResponse {
  /** 全部管理行（含只带诊断的坏文档行）。 */
  experts: ExpertCatalogRow[]
  /** 仅 `status === 'usable'` 的现有 PersonaSummary（选择器用），不含诊断。 */
  personas: PersonaSummary[]
  /** 来源发现期的问题（例如某个库根不可读）。 */
  diagnostics: ExpertIssue[]
  skillsAvailable: boolean
  preliminary: boolean
}

/** `GET /experts/drafts/:id` 的响应体：草稿 + 索引与磁盘的漂移诊断。 */
export interface ExpertDraftPreview {
  draft: ExpertDraftView
  drift: ExpertIssue[]
}

/** HTTP 失败体（§4.2）。`code` 是稳定枚举；文案里的绝对路径已被投影掉。 */
export interface ExpertFailureBody {
  error: string
  code: string
  field?: string
  errors?: ExpertIssue[]
  currentVersion?: number
}

export interface ExpertFailureProjection {
  status: number
  body: ExpertFailureBody
}

/** 方法论资产（随包）的只读视图（§4.1）。 */
export interface ExpertMethodology {
  version: 1
  text: string
}

/** 工具侧的执行身份（`exec.agent` / `exec.signal` / `exec.callId`）。HTTP 侧**不得**构造。 */
export interface LiveExpertExec {
  readonly agent?: unknown
  readonly signal?: AbortSignal
  /**
   * 工具调用的稳定 id：auto（`summon_expert`）用它做"同一次分派只 start 一次"的身份（§8.6）。
   * HTTP / 路由路径没有它，只能走 manual。
   */
  readonly callId?: string
}

/** 工具参数（snake_case 已由 `experts/tools.ts` 转成域 camelCase，不含 sessionId）。 */
export interface ExpertSubmitDraftInput {
  draftId: unknown
  expectedVersion: unknown
  personaMd: unknown
  provenanceJson: unknown
  skillsJson: unknown
}

export interface ExpertStageDraftFileInput {
  draftId: unknown
  expectedVersion: unknown
  area: unknown
  path: unknown
  contentUtf8: unknown
}

export interface ExpertRemoveStagedFileInput {
  draftId: unknown
  expectedVersion: unknown
  area: unknown
  path: unknown
}

export interface ExpertStartingInput {
  sessionId: string
  request: string
  workspaceId: string
}

/**
 * §12.2 的固定表面。
 *
 * P5 只实现生成通道（草稿 / 安装 / 目录 / 技能）；P6 补齐**调用主链**五个方法，
 * 它们全部**委托**给 `invocation.ts`（本模块不复制那条状态机）。
 */
export interface ExpertService {
  capabilities(): Promise<ExpertCapabilities>
  methodology(): ExpertMethodology
  startGeneration(input: ExpertStartingInput): ExpertDraftView
  getDraft(id: string): ExpertDraftView
  currentPendingDraft(sessionId: string): ExpertDraftView | undefined
  previewDraft(id: string): ExpertDraftPreview
  submitDraft(input: ExpertSubmitDraftInput, exec: LiveExpertExec): Promise<ExpertOperationResult>
  stageFile(input: ExpertStageDraftFileInput, exec: LiveExpertExec): Promise<ExpertOperationResult>
  removeFile(input: ExpertRemoveStagedFileInput, exec: LiveExpertExec): Promise<ExpertOperationResult>
  /**
   * 校验草稿。`exec` 是**工具路径**才传的：传了就走 owner 守卫（真实会话必须持有这份草稿），
   * HTTP 用户操作路径**不传**（浏览器没有 live agent 身份，§4.2）。
   */
  validateDraft(id: string, expectedVersion: number, exec?: LiveExpertExec): Promise<ExpertDraftView>
  confirmDraft(id: string, expectedVersion: number, manifestHash: string): Promise<ExpertInstallResult>
  confirmDraftDetailed(id: string, expectedVersion: number, manifestHash: string): Promise<ExpertInstallSuccess>
  abandonDraft(id: string, expectedVersion: number, reason?: string): Promise<ExpertOperationResult>
  readStagedFile(id: string, area: ExpertFileArea, path: string): ExpertFileView
  catalog(query?: string): Promise<ExpertCatalogResponse>
  preflight(personaId: string, agent?: unknown): Promise<ExpertPreflightResult>

  // ---- 调用主链（P6，§8.1；实现全在 `invocation.ts`） --------------------
  /** 建立一次手工调用请求（TTL 30 分钟，进程内有效）。`sessionId` 由路由从真实会话取。 */
  createManualRequest(input: CreateManualRequestInput): CreateManualRequestResult
  runManual(requestId: string, task: string, exec: LiveExpertExec): Promise<ExpertInvocationResult>
  runAuto(personaId: string, task: string, exec: LiveExpertExec): Promise<ExpertInvocationResult>
  loadForChild(ticket: string, exec: LiveExpertExec): Promise<ExpertLoadResult>
  readForChild(ticket: string, path: string, exec: LiveExpertExec): Promise<ExpertResourceResult>

  setAutoEnabled(enabled: boolean): void
  /** 开关真值（唯一来源是库里的 meta 键；`summon_expert` 的动态注册读它）。 */
  autoSummonEnabled(): boolean
  /** 订阅开关变化（返回退订函数）：装配层据此注册 / 注销 `summon_expert` 与自主提示区块。 */
  onAutoSummonChange(listener: (enabled: boolean) => void): () => void
  setSkillInvalidator(invalidate: (() => boolean) | undefined): void
  invalidateSkills(): void
  recover(): Promise<ExpertIssue[]>
  dispose(): Promise<void>
  /** HTTP 失败投影（两条路由共用；不暴露根，也不把原 message 直接外发）。 */
  projectFailure(error: unknown): ExpertFailureProjection
  /** 只读根（装配层/测试断言用；**不**进任何 HTTP 响应）。 */
  readonly roots: ExpertRoots
}

export interface ExpertServiceDeps {
  db: DatabaseSync
  /** 宿主上下文（软探测 skills 用）。HTTP 只读它，不改它。 */
  ctx: unknown
  /** 根覆盖：**只给测试**；生产缺省走 `resolveExpertRoots()` 的宿主目录约定。 */
  roots?: ExpertRootOptions
  now?: () => string
  failpoint?: (point: ExpertDraftFailpoint | ExpertInstallFailpoint) => void
}

// ---------------------------------------------------------------------------
// 失败载体与投影（§4 路径投影 / §4.2 状态码）
// ---------------------------------------------------------------------------

/**
 * 域失败 → 可抛载体。
 *
 * 为什么**不**继承 `ExpertRepoError`：失败码可能是**人格解析器的** code
 * （`unsupported-frontmatter` / `oversized-body`，§12.1 要求原样透出），
 * 而基类的 `code` 被钉成 `ExpertErrorCode`，继承就得把 code 悄悄换成别的词 ——
 * 那正是"按错误提示去改，却改错了地方"。
 */
export class ExpertServiceError extends Error {
  readonly code: ExpertErrorCode | PersonaDiagnosticCode
  readonly field: string
  readonly errors?: ExpertIssue[]
  /** 能合法读到当前草稿版本时带上：客户端据此自愈（§5.1 失败形状）。 */
  readonly currentVersion?: number

  constructor(
    code: ExpertErrorCode | PersonaDiagnosticCode,
    field: string,
    message: string,
    errors?: ExpertIssue[],
    currentVersion?: number,
  ) {
    super(message)
    this.name = 'ExpertServiceError'
    this.code = code
    this.field = field
    if (errors !== undefined) this.errors = errors
    if (currentVersion !== undefined) this.currentVersion = currentVersion
  }
}

function failureToError(failure: ExpertOperationFailure, currentVersion?: number): ExpertServiceError {
  return new ExpertServiceError(
    failure.code,
    failure.field,
    failure.message,
    failure.errors,
    failure.currentVersion ?? currentVersion,
  )
}

const STATUS_413: ReadonlySet<string> = new Set([
  'file-too-large',
  'package-too-large',
  'file-count-limit',
  'oversized-file',
  'oversized-body',
  'resource-oversized',
])

const STATUS_404: ReadonlySet<string> = new Set([
  'draft-not-found',
  'expert-not-found',
  'manual-request-not-found',
])

const STATUS_503: ReadonlySet<string> = new Set([
  'methodology-unavailable',
  'generation-unavailable',
  'skill-service-unavailable',
  'skill-scope-unavailable',
  'required-skill-unavailable',
  'install-repair-required',
])

const STATUS_409: ReadonlySet<string> = new Set([
  'draft-version-conflict',
  'draft-not-pending',
  'draft-not-validated',
  'staged-file-changed',
  'package-changed',
  'generation-conflict',
  'install-in-progress',
  'install-busy',
  'install-lock-owner-unknown',
  'install-owner-unknown',
  'installation-incomplete',
  'skill-conflict',
  'expert-disabled',
  'expert-busy',
  'expert-auto-disabled',
  'manual-request-expired',
  'manual-request-session-mismatch',
  'manual-request-task-changed',
])

const STATUS_403: ReadonlySet<string> = new Set(['draft-owner-mismatch', 'path-link-forbidden'])

/**
 * §4.2 的封闭映射：坏 JSON 400、超限 413、未知 id 404、能力缺失 503、
 * 版本/冲突/正在安装 409、其余 400（含路径类错误与不认识的自定义 code）。
 */
export function expertErrorStatus(code: string): number {
  if (STATUS_413.has(code)) return 413
  if (STATUS_404.has(code)) return 404
  if (STATUS_503.has(code)) return 503
  if (STATUS_409.has(code)) return 409
  if (STATUS_403.has(code)) return 403
  return 400
}

/** 一个待替换的绝对根。 */
export interface ExpertPathLabel {
  path: string
  label: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 兜底：任何**剩下**的盘符/UNC/绝对路径都隐藏掉（宁可少说，不可泄露服务端布局）。 */
const REMAINING_ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`,;)\]}]*|\/(?:[\w.-]+\/)+[\w.-]+/g

/** 同上的**非全局**版本：`/g` 的 `lastIndex` 会在多次 `test` 之间残留，不能拿来当谓词。 */
const LOOKS_ABSOLUTE = /(?:[A-Za-z]:[\\/]|\\\\)|\/(?:[\w.-]+\/)+[\w.-]+/

/** 只做"已知根 → 库名"的替换（长根优先，避免父目录先吃掉子目录）。 */
function replaceKnownRoots(text: string, labels: readonly ExpertPathLabel[]): string {
  let result = text
  const sorted = [...labels]
    .filter((entry) => entry.path.trim() !== '')
    .sort((left, right) => right.path.length - left.path.length)
  for (const entry of sorted) {
    const pattern = new RegExp(escapeRegExp(entry.path), 'gi')
    result = result.replace(pattern, entry.label)
  }
  return result
}

/**
 * 把 message 里的已知根换成库名，再把残余绝对路径一律隐藏。
 *
 * 顺序很重要：先按具体根替换（信息量最大的是"哪个库"），再对剩下的绝对路径兜底，
 * 否则兜底会把"用户库\xxx"也一起吃掉。
 */
export function projectExpertMessage(message: string, labels: readonly ExpertPathLabel[]): string {
  return replaceKnownRoots(message, labels).replace(REMAINING_ABSOLUTE_PATH, '（服务端路径已隐藏）')
}

/**
 * 投影 `field`：§4 开头要求只出**相对** field。
 *
 * 目录发现期的坏文档会把**绝对 path** 当 field 传下来
 * （`catalog.ts` 的 `diagnosticToIssue(diagnostic, diagnostic.path)`），所以这里不能原样放行：
 * 命中已知根 → `用户库/相对路径`；剩下的绝对路径一律隐藏；本来就不是路径的 field（`expert.skills`）原样保留。
 */
export function projectExpertField(field: string, labels: readonly ExpertPathLabel[]): string {
  const replaced = replaceKnownRoots(field, labels)
  if (replaced !== field) return replaced
  return LOOKS_ABSOLUTE.test(field) ? '（服务端路径已隐藏）' : field
}

/** 逐条投影字段级问题（`code` 保留，`field` 相对化，文案投影）。 */
export function projectExpertIssues(issues: readonly ExpertIssue[], labels: readonly ExpertPathLabel[]): ExpertIssue[] {
  return issues.map((entry) => ({
    code: entry.code,
    field: projectExpertField(entry.field, labels),
    message: projectExpertMessage(entry.message, labels),
  }))
}

/** 人格诊断的投影：只留 `id/sourceKey/code/相对 field`，丢弃 path（§4 开头）。 */
export interface ExpertDiagnosticProjection {
  id: string
  sourceKey: string
  code: string
  field: string
}

// ---------------------------------------------------------------------------
// 资产定位（§11.1：相对 `import.meta.url`，不硬编码 cwd）
// ---------------------------------------------------------------------------

/** 随包方法论的路径（`lib/experts/service.js` → 包根 `assets/expert-generation/methodology.md`）。 */
export function methodologyAssetPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../../assets/expert-generation/methodology.md', moduleUrl))
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/** 从 live agent 上取真实会话 id（唯一的身份来源）。 */
function execSessionId(exec: LiveExpertExec | undefined): string {
  return readAgentSessionId(exec?.agent)
}

function readAgentSessionId(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return ''
  const session = (agent as { session?: unknown }).session
  if (typeof session !== 'object' || session === null) return ''
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' ? id.trim() : ''
}

function requireNonEmptyString(value: unknown, field: string, max: number, message: string): string {
  if (typeof value !== 'string') throw new ExpertServiceError('invalid-payload', field, message)
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) throw new ExpertServiceError('invalid-payload', field, message)
  return trimmed
}

function isFailure(value: unknown): value is ExpertOperationFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

export function createExpertService(deps: ExpertServiceDeps): ExpertService {
  const { db, ctx } = deps
  const roots = resolveExpertRoots(deps.roots ?? {})
  let skillInvalidator: (() => boolean) | undefined
  let disposed = false
  /** 开关变化监听者（`summon_expert` / 自主提示区块的动态注册靠它）。 */
  const autoSummonListeners = new Set<(enabled: boolean) => void>()

  /**
   * drafts / install 两个上下文**每次调用现造**：`skills` 探测必须反映"此刻"的宿主状态
   * （服务可能晚于本插件注册），构造期快照会把"后来才装上的技能库"永久漏掉。
   */
  const draftContext = (skills?: WorkbenchSkillRegistry): ExpertDraftContext => ({
    db,
    roots,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.failpoint === undefined ? {} : { failpoint: deps.failpoint }),
    ...(skills === undefined ? {} : { skills }),
  })

  const installContext = (skills?: WorkbenchSkillRegistry): ExpertInstallContext => ({
    db,
    roots,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.failpoint === undefined ? {} : { failpoint: deps.failpoint }),
    refreshSkills: () => {
      invalidateSkills()
    },
    ...(skills === undefined ? {} : { skills }),
  })

  /**
   * skills 服务的形状投影（`find` 供安装器/校验判 `reuse`）。
   *
   * HTTP 没有 live agent → scope 是 `undefined` → 投影自带 `preliminary: true`
   * （§9.1：HTTP 只做 preliminary 依赖检查，启动时再按真实 scope/cwd 复核）。
   */
  async function skillRegistry(exec?: LiveExpertExec): Promise<WorkbenchSkillRegistry | undefined> {
    const service = probeExpertSkills(ctx)
    if (service === undefined) return undefined
    const scope = await resolveLiveAgentScope(exec?.agent)
    const cwd = readLiveAgentCwd(exec?.agent)
    return projectWorkbenchSkillRegistry(service, {
      ...(scope.scope === undefined ? {} : { scope: scope.scope }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    })
  }

  function methodologyText(): string | undefined {
    let raw: string
    try {
      raw = readFileSync(methodologyAssetPath(), 'utf8')
    } catch {
      /** 缺资产是**可预期**的降级（打包漏了 assets），不是崩溃：交给 §10 报 503。 */
      return undefined
    }
    return raw.trim() === '' ? undefined : raw
  }

  function requireMethodology(): string {
    const text = methodologyText()
    if (text === undefined) {
      throw new ExpertServiceError(
        'methodology-unavailable',
        'methodology',
        '随包方法论资产不可用（assets/expert-generation/methodology.md 缺失或为空）：本次不能新建专家，请重新安装本插件',
      )
    }
    return text
  }

  function pathLabels(): ExpertPathLabel[] {
    const labels: ExpertPathLabel[] = [
      { path: roots.personasDir, label: '用户库' },
      { path: roots.skillsDir, label: '用户技能库' },
      { path: defaultBuiltinPersonaRoot(), label: '内置库' },
    ]
    try {
      const external = readPersonaSettings(db).personaExternalDir
      if (external !== '') labels.push({ path: external, label: '外部库' })
    } catch {
      /** 设置读不出来不影响投影：少一个标签，兜底仍会隐藏绝对路径。 */
    }
    return labels
  }

  function projectFailure(error: unknown): ExpertFailureProjection {
    /**
     * 调用主链的失败载体（P6）：与 `ExpertServiceError` 一样走同一条投影
     * （稳定 code → 状态码、绝对路径不进消息），只是 code 可能是人格解析 / 资源域的词。
     */
    if (error instanceof ExpertInvocationError) {
      const labels = pathLabels()
      return {
        status: expertErrorStatus(error.code),
        body: {
          error: projectExpertMessage(error.message, labels),
          code: error.code,
          field: projectExpertField(error.field, labels),
        },
      }
    }
    if (error instanceof ExpertServiceError) {
      const labels = pathLabels()
      const body: ExpertFailureBody = {
        error: projectExpertMessage(error.message, labels),
        code: error.code,
        field: projectExpertField(error.field, labels),
      }
      if (error.errors !== undefined) body.errors = projectExpertIssues(error.errors, labels)
      if (error.currentVersion !== undefined) body.currentVersion = error.currentVersion
      return { status: expertErrorStatus(error.code), body }
    }
    /**
     * 域失败**对象**（`ok: false` 的返回值，不是抛出的异常）。
     *
     * `abandonDraft`、以及工具路径（submit/stage/remove）都把它当返回值用 —— 让同一条
     * 投影同时吃掉两种载体，路由层与工具层就都不会各自维护一套"状态码 + 路径投影"。
     */
    if (typeof error === 'object' && error !== null && (error as { ok?: unknown }).ok === false) {
      const failure = error as ExpertOperationFailure
      const labels = pathLabels()
      const body: ExpertFailureBody = {
        error: projectExpertMessage(failure.message, labels),
        code: failure.code,
        field: projectExpertField(failure.field, labels),
      }
      if (failure.errors !== undefined) body.errors = projectExpertIssues(failure.errors, labels)
      if (failure.currentVersion !== undefined) body.currentVersion = failure.currentVersion
      return { status: expertErrorStatus(failure.code), body }
    }
    if (error instanceof ExpertRepoError) {
      return {
        status: expertErrorStatus(error.code),
        body: { error: projectExpertMessage(error.message, pathLabels()), code: error.code },
      }
    }
    /** 不认识的异常：既有路由层口径就是 400（不把内部栈/绝对路径外发）。 */
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 400,
      body: { error: projectExpertMessage(message, pathLabels()), code: 'invalid-payload' },
    }
  }

  /**
   * §8.5 第 15 步的**服务侧守卫**（AX-E43）：专家子代理不得再写专家草稿 / 再发起调用。
   *
   * 为什么不能只靠 `toolFilter.deny`：deny 只约束**工具**入口，而且 `summon_expert` 这类
   * 条件注册的名字在"未注册"时不会进 deny。守卫放在服务里，"子代理 → 草稿"这条边才真正闭环。
   */
  function assertNotExpertChild(exec: LiveExpertExec | undefined, action: string): void {
    if (isSubagentChildAgent(exec?.agent)) {
      throw new ExpertServiceError('expert-disabled', 'exec.agent', `专家子代理不能${action}（§8.5 第 15 步的服务侧守卫）`)
    }
  }

  /**
   * §7.3 的依赖预检（**唯一**一处实现）：接口方法 `preflight` 与调用主链的运行前预检
   * 共用它 —— 调用主链绝不写第二份"人格在不在、技能够不够"的判断。
   */
  async function preflightPersona(personaId: string, agent?: unknown): Promise<ExpertPreflightResult> {
    const service = probeExpertSkills(ctx)
    const result = await preflightExpert({
      db,
      roots,
      personaId,
      ...(service === undefined ? {} : { skills: service }),
      ...(agent === undefined ? {} : { agent }),
    })
    return { ...result, issues: projectExpertIssues(result.issues, pathLabels()) }
  }

  /**
   * 调用主链（§8.1）。状态全在 `invocation.ts`，这里只做**装配**：
   * 软探测（每次调用重新探）+ 路径投影 + 复用上面那一个依赖预检。
   */
  const invocation = createExpertInvocation({
    db,
    roots,
    probeSubagents: () => probeExpertSubagents(ctx),
    probeTools: () => probeExpertTools(ctx),
    preflight: (personaId, agent) => preflightPersona(personaId, agent),
    /** §8.5 第 14 步：5 个草稿生成工具 + 再发起调用；`load/read` 必须保持可用。 */
    deniedToolNames: [...EXPERT_GENERATION_TOOL_NAMES, RUN_EXPERT_REQUEST_TOOL_NAME],
    /** 只有**真的注册着**才进 deny（SDK 对不存在的名字是 loud 拒绝）。 */
    conditionalDeniedToolNames: [SUMMON_EXPERT_TOOL_NAME],
    sanitizeMessage: (text) => projectExpertMessage(text, pathLabels()),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })

  function getDraft(id: string): ExpertDraftView {
    const draftId = typeof id === 'string' ? id.trim() : ''
    if (draftId === '') throw new ExpertServiceError('invalid-payload', 'draftId', 'draft id 必填')
    const draft = getExpertDraft(db, draftId)
    if (draft === undefined) {
      throw new ExpertServiceError('draft-not-found', 'draftId', `专家草稿不存在：${draftId}`)
    }
    return expertDraftView(draft)
  }

  /**
   * 清这份草稿自己的暂存区（`.pending/<draftId>/`）。
   *
   * 只删**本草稿**的目录，且删之前先验路径仍在自己的根里（草稿 id 已在 owner 守卫里
   * 验过是小写 UUID，这里再挡一道"拼出来的路径必须落在根内"）。
   */
  function clearStagedArea(area: ExpertFileArea, draftId: string): ExpertIssue | undefined {
    const root = area === 'skill' ? roots.skillsDir : roots.personasDir
    /**
     * `isInsideExpertRoot(root, candidate)` 把 `candidate` 解析成**绝对路径**再比 ——
     * 传相对路径会被解析到 `process.cwd()` 底下，判定必然「在根外」，清理会被静默跳过。
     * 所以这里先把根拼出来，再验界、再删同一个 target。
     */
    const target = join(root, EXPERT_PENDING_DIR_NAME, draftId)
    if (isInsideExpertRoot(root, target, process.platform) === false) {
      return {
        code: 'invalid-path',
        field: 'draftId',
        message: `暂存路径越界，已跳过清理（area=${area}）：请人工检查 ${EXPERT_PENDING_DIR_NAME} 目录`,
      }
    }
    try {
      rmSync(target, { recursive: true, force: true })
      return undefined
    } catch (error) {
      return {
        code: 'invalid-path',
        field: 'draftId',
        message: `清理这份草稿的暂存文件失败（area=${area}）：${(error as Error).message}；草稿状态已放弃，正式库没有任何写入`,
      }
    }
  }

  /** 暂存写入前确保"这个 area 的根目录"存在（全新机器上它可能还不存在）。 */
  function ensureAreaRoot(area: unknown): void {
    if (area !== 'skill' && area !== 'persona-resource') return
    const root = area === 'skill' ? roots.skillsDir : roots.personasDir
    try {
      mkdirSync(root, { recursive: true })
    } catch {
      /** 建不了就交给后续写入报真实原因（不在这里编造错误码）。 */
    }
  }

  function invalidateSkills(): void {
    if (disposed || skillInvalidator === undefined) return
    try {
      skillInvalidator()
    } catch {
      /** 刷新失败不能掩盖调用方的原始路径（安装器那边只把它记成 warning）。 */
    }
  }

  /** 确认安装（HTTP 用户路径 + 工具路径共用的那一份实现）。 */
  async function runConfirm(id: string, expectedVersion: number, manifestHash: string): Promise<ExpertInstallSuccess> {
    const skills = await skillRegistry()
    const result = confirmExpertDraft(installContext(skills), {
      draftId: id,
      expectedVersion,
      expectedManifestHash: manifestHash,
    })
    if (result.ok === false) {
      /**
       * 安装器（P3）对版本冲突的失败**不带** `currentVersion` —— 但客户端需要它才能自愈
       * （§5.1：失败形状里"能合法读取时"带当前版本）。这里补一次读取，读不到就不带。
       */
      const currentVersion = result.currentVersion ?? expertDraftCurrentVersion(draftContext(skills), id)
      throw failureToError(result, currentVersion)
    }
    return result
  }

  return {
    roots,

    async capabilities(): Promise<ExpertCapabilities> {
      const methodologyOk = methodologyText() !== undefined
      const skillsOk = probeExpertSkills(ctx) !== undefined
      const enabled = readExpertSettings(db).autoSummonExperts
      /**
       * 子代理调用能力**如实探测**（§8.5 第 3 步 / AX-E49）：没有合格 `spawn` provider
       * （缺 subagents 服务、只有 fork/远程、缺 persona/toolFilter/depthLimit）就
       * `available:false` + `expert-subagent-unavailable`。宁可少一个入口，也不让界面放开
       * 一个必然失败的按钮。
       */
      const selection = selectSpawnProvider(probeExpertSubagents(ctx))
      const summon: ExpertCapabilityReport = selection.ok
        ? { available: true, reason: null }
        : { available: false, reason: selection.code }
      return {
        generation: methodologyOk
          ? { available: true, reason: null }
          : { available: false, reason: 'methodology-unavailable' },
        skills: skillsOk
          ? { available: true, reason: null }
          : { available: false, reason: 'skill-service-unavailable' },
        manualSummon: summon,
        autoSummon: { ...summon, enabled },
        providerName: WORKBENCH_SKILL_PROVIDER_NAME,
      }
    },

    methodology(): ExpertMethodology {
      return { version: 1, text: requireMethodology() }
    },

    startGeneration(input: ExpertStartingInput): ExpertDraftView {
      requireMethodology()
      const sessionId = requireNonEmptyString(input.sessionId, 'sessionId', 512, 'sessionId 必填（1–512 字符）')
      const request = requireNonEmptyString(
        input.request,
        'request',
        EXPERT_REQUEST_MAX_CHARS,
        `request 必填（trim 后 1–${EXPERT_REQUEST_MAX_CHARS} 字符）`,
      )
      requireNonEmptyString(input.workspaceId, 'workspaceId', 4096, 'workspaceId 必填（生成会话用什么工作区由客户端决定）')
      /**
       * `workspaceId` 只做**非空校验**：它决定客户端在哪个工作区开生成会话，
       * 服务端不落库也不参与草稿去重（去重键是 sessionId + request 指纹）。
       */
      const created = createExpertDraft(db, { sessionId, request, expertId: defaultExpertId() })
      return expertDraftView(created.draft)
    },

    getDraft,

    currentPendingDraft(sessionId: string): ExpertDraftView | undefined {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '') {
        throw new ExpertServiceError(
          'draft-owner-mismatch',
          'sessionId',
          '无法确定当前会话：只能读取**执行上下文里的真实会话 id**，没有任何 session_id 入参',
        )
      }
      const draft = getPendingExpertDraftForSession(db, id)
      if (draft === undefined) return undefined
      /** 走同一个 owner 守卫：kind/pending/会话归属/phase 都在这里再验一次。 */
      const owned = assertExpertDraftOwner(draftContext(), { draftId: draft.id, sessionId: id })
      return expertDraftView(owned.draft)
    },

    previewDraft(id: string): ExpertDraftPreview {
      const draft = getDraft(id)
      const drift: ExpertIssue[] = []
      for (const file of draft.files) {
        const read = readExpertStagedFile(draftContext(), { draftId: draft.draftId, area: file.area, path: file.path })
        if (isFailure(read)) {
          drift.push({ code: read.code, field: `${file.area}:${file.path}`, message: read.message })
        }
      }
      /**
       * 漂移文案里可能带服务端路径（`readExpertTextFile` 的原始原因），
       * 这条响应同样受 §4 开头约束 → 一律投影后再出门。
       */
      return { draft, drift: projectExpertIssues(drift, pathLabels()) }
    },

    async submitDraft(input: ExpertSubmitDraftInput, exec: LiveExpertExec): Promise<ExpertOperationResult> {
      assertNotExpertChild(exec, '写专家草稿')
      const sessionId = execSessionId(exec)
      try {
        return submitExpertDraft(draftContext(), {
          draftId: input.draftId,
          sessionId,
          expectedVersion: input.expectedVersion,
          personaMd: input.personaMd,
          provenanceJson: input.provenanceJson,
          skillsJson: input.skillsJson,
        })
      } catch (error) {
        const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(draftContext(), input.draftId))
        if (failure !== undefined) return failure
        throw error
      }
    },

    async stageFile(input: ExpertStageDraftFileInput, exec: LiveExpertExec): Promise<ExpertOperationResult> {
      assertNotExpertChild(exec, '暂存专家草稿文件')
      const sessionId = execSessionId(exec)
      /**
       * 全新机器上 `<home>/.dsh/workbench/personas`（或 `skills`）可能还不存在，
       * 而草稿暂存走的 `atomicWriteText` 只逐级创建**根以内**的目录（根本身不建）——
       * 不补这一步，第一次暂存会以 `invalid-path`：「创建目录失败：用户库\.pending（ENOENT）」。
       * 安装路径不受影响（它自己 `mkdirSync(..., { recursive: true })`）。
       */
      ensureAreaRoot(input.area)
      try {
        return stageExpertFile(draftContext(), {
          draftId: input.draftId,
          sessionId,
          expectedVersion: input.expectedVersion,
          area: input.area,
          path: input.path,
          contentUtf8: input.contentUtf8,
        })
      } catch (error) {
        const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(draftContext(), input.draftId))
        if (failure !== undefined) return failure
        throw error
      }
    },

    async removeFile(input: ExpertRemoveStagedFileInput, exec: LiveExpertExec): Promise<ExpertOperationResult> {
      assertNotExpertChild(exec, '删改专家草稿暂存文件')
      const sessionId = execSessionId(exec)
      try {
        return removeExpertStagedFile(draftContext(), {
          draftId: input.draftId,
          sessionId,
          expectedVersion: input.expectedVersion,
          area: input.area,
          path: input.path,
        })
      } catch (error) {
        const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(draftContext(), input.draftId))
        if (failure !== undefined) return failure
        throw error
      }
    },

    async validateDraft(id: string, expectedVersion: number, exec?: LiveExpertExec): Promise<ExpertDraftView> {
      /** 校验会写入校验快照（也是写）：同样挡住专家子代理。 */
      assertNotExpertChild(exec, '校验专家草稿')
      const skills = await skillRegistry()
      const result = validateExpertDraft(draftContext(skills), {
        draftId: id,
        expectedVersion,
        /**
         * **工具路径必须带会话身份**（§5.1：工具永远 requireSession=true，不许校验别的会话的草稿）；
         * HTTP 用户路径不传这个键（`hasOwnProperty` 决定是否走 owner 守卫）。
         */
        ...(exec === undefined ? {} : { sessionId: execSessionId(exec) }),
      })
      if (result.ok === false) {
        /** 与 confirm 同理：失败要带当前真实版本，模型/客户端才能自愈。 */
        const currentVersion = result.currentVersion ?? expertDraftCurrentVersion(draftContext(skills), id)
        throw failureToError(result, currentVersion)
      }
      return getDraft(id)
    },

    async confirmDraftDetailed(id: string, expectedVersion: number, manifestHash: string): Promise<ExpertInstallSuccess> {
      return runConfirm(id, expectedVersion, manifestHash)
    },

    async confirmDraft(id: string, expectedVersion: number, manifestHash: string): Promise<ExpertInstallResult> {
      const success = await runConfirm(id, expectedVersion, manifestHash)
      return success.result
    },

    async abandonDraft(id: string, expectedVersion: number, reason?: string): Promise<ExpertOperationResult> {
      const draftId = typeof id === 'string' ? id.trim() : ''
      if (draftId === '') {
        return { ok: false, code: 'invalid-payload', field: 'draftId', message: 'draft id 必填' }
      }
      const draft = getExpertDraft(db, draftId)
      if (draft === undefined) {
        return { ok: false, code: 'draft-not-found', field: 'draftId', message: `专家草稿不存在：${draftId}` }
      }
      let owned
      try {
        /**
         * 复用**同一个** owner 守卫（不许另写一套）。
         *
         * HTTP 放弃路径没有 live agent（§4.2：浏览器不带会话身份），所以这里按草稿自己的
         * 会话 id 过守卫 —— 与 `validateExpertDraft`/`confirmExpertDraft` 的
         * `requireSession=false` 是同一条口径（"HTTP 用户操作不看会话归属"），
         * 而 pending / schema 版本 / `expectedVersion` / `phase !== installing` 四项**照常生效**：
         * `installing` 时放弃必须 409（AX-E35）。
         */
        owned = assertExpertDraftOwner(draftContext(), { draftId, sessionId: draft.sessionId ?? '', expectedVersion })
      } catch (error) {
        const failure = expertRepoFailure(error, 'draftId', expertDraftCurrentVersion(draftContext(), draftId))
        if (failure !== undefined) return failure
        throw error
      }

      abandonDraftRow(db, draftId)
      const warnings: ExpertIssue[] = []
      const personaProblem = clearStagedArea('persona-resource', draftId)
      if (personaProblem !== undefined) warnings.push(personaProblem)
      const skillProblem = clearStagedArea('skill', draftId)
      if (skillProblem !== undefined) warnings.push(skillProblem)

      const trimmedReason = typeof reason === 'string' ? reason.trim() : ''
      return {
        ok: true,
        draftId,
        contentVersion: owned.payload.contentVersion,
        phase: owned.payload.phase,
        changed: true,
        errors: [],
        warnings,
        message: `专家草稿已放弃${trimmedReason === '' ? '' : `（原因：${trimmedReason}）`}；只清理了这份草稿的暂存文件，正式库没有任何写入。`,
      }
    },

    readStagedFile(id: string, area: ExpertFileArea, path: string): ExpertFileView {
      const result = readExpertStagedFile(draftContext(), { draftId: id, area, path })
      if (isFailure(result)) throw failureToError(result)
      return result
    },

    async catalog(query?: string): Promise<ExpertCatalogResponse> {
      const service = probeExpertSkills(ctx)
      const document = await listExpertCatalog({
        db,
        roots,
        ...(service === undefined ? {} : { skills: service }),
      })
      const search = typeof query === 'string' ? query.trim().toLowerCase() : ''
      const matches = (text: string): boolean => text.toLowerCase().includes(search)
      const selected = search === ''
        ? document.rows
        : document.rows.filter((row) =>
          matches(row.id) || matches(row.name) || matches(row.description) || matches(row.group) || matches(row.sourceKey))
      const personas = search === ''
        ? document.personas
        : document.personas.filter((summary) => matches(summary.id) || matches(summary.name) || matches(summary.description))
      const labels = pathLabels()
      /**
       * **行内问题也要投影**：坏文档的行问题来自人格解析器，其中的
       * `root-unreadable`/`oversized-file` 文案带绝对路径 —— 只投影顶层 `diagnostics`
       * 会让同一个响应从另一条缝里漏出服务端布局。
       */
      const experts = selected.map((row) => ({ ...row, issues: projectExpertIssues(row.issues, labels) }))
      return {
        experts,
        personas,
        diagnostics: projectExpertIssues(document.issues, labels),
        skillsAvailable: document.skillsAvailable,
        preliminary: document.preliminary,
      }
    },

    async preflight(personaId: string, agent?: unknown): Promise<ExpertPreflightResult> {
      return preflightPersona(personaId, agent)
    },

    // ---- 调用主链（P6）：全部委托给 invocation，本模块不复制那条状态机 ------
    createManualRequest(input: CreateManualRequestInput): CreateManualRequestResult {
      return invocation.createManualRequest(input)
    },

    async runManual(requestId: string, task: string, exec: LiveExpertExec): Promise<ExpertInvocationResult> {
      return invocation.runManual(requestId, task, exec)
    },

    async runAuto(personaId: string, task: string, exec: LiveExpertExec): Promise<ExpertInvocationResult> {
      return invocation.runAuto(personaId, task, exec)
    },

    async loadForChild(ticket: string, exec: LiveExpertExec): Promise<ExpertLoadResult> {
      return invocation.loadForChild(ticket, exec)
    },

    async readForChild(ticket: string, path: string, exec: LiveExpertExec): Promise<ExpertResourceResult> {
      return invocation.readForChild(ticket, path, exec)
    },

    setAutoEnabled(enabled: boolean): void {
      /** 只接受真 boolean（仓储层也再挡一次）：脏值不写库，读数永远是唯一真值来源。 */
      writeExpertSettings(db, { autoSummonExperts: enabled })
      /** 通知监听者（装配层据此注册 / 注销工具与提示区块）。监听者抛错不影响设置写入。 */
      for (const listener of [...autoSummonListeners]) {
        try {
          listener(enabled)
        } catch {
          /** 监听者自己的问题不能回滚设置：库是唯一真值，下次读还会得到同一个值。 */
        }
      }
    },

    autoSummonEnabled(): boolean {
      return readExpertSettings(db).autoSummonExperts
    },

    onAutoSummonChange(listener: (enabled: boolean) => void): () => void {
      autoSummonListeners.add(listener)
      return () => {
        autoSummonListeners.delete(listener)
      }
    },

    setSkillInvalidator(invalidate: (() => boolean) | undefined): void {
      skillInvalidator = invalidate
    },

    invalidateSkills,

    async recover(): Promise<ExpertIssue[]> {
      const { outcomes } = recoverExpertInstallations(installContext())
      const issues: ExpertIssue[] = []
      for (const outcome of outcomes) {
        const issue = recoveryIssue(outcome.action, outcome.draftId, outcome.message)
        if (issue !== undefined) issues.push(issue)
      }
      return projectExpertIssues(issues, pathLabels())
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      /**
       * 只释放**自己**拥有的东西：解挂刷新钩子、取消自己拥有的调用运行（dispose 里 abort
       * 子代理 signal 并等它们静止）；不关 db、不关别人的 service。
       */
      skillInvalidator = undefined
      autoSummonListeners.clear()
      await invocation.dispose()
    },

    projectFailure,
  }
}

/**
 * 恢复结果 → 问题列表。
 *
 * 只把**需要用户知道**的动作报出来（`repair-required` / owner 未知 / 被别人的锁挡住 /
 * 日志指向一份已不存在的草稿）；`nothing-to-do` / `already-ready` / 补齐成功 /
 * 别人的库（`skipped-foreign-owner`）都是正常运行，不产生问题。
 */
function recoveryIssue(action: string, draftId: string, message: string): ExpertIssue | undefined {
  switch (action) {
    case 'repair-required':
      return { code: 'install-repair-required', field: draftId, message }
    case 'skipped-owner-unknown':
      return { code: 'install-owner-unknown', field: draftId, message }
    case 'skipped-locked':
      return { code: 'install-busy', field: draftId, message }
    case 'skipped-no-draft':
      return { code: 'installation-incomplete', field: draftId, message }
    default:
      return undefined
  }
}
