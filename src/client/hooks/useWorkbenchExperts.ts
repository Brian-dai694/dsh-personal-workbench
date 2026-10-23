/**
 * 专家域（P8）：**目录 / 生成 / 草稿动作的唯一所有者**，外加本域全部纯流程函数。
 *
 * ## 为什么流程函数与 React 分开（`dsh-plugin-change` §1）
 *
 * P8 的验收点（AX-E52–E55、E57）全是**流程**判定：谁被调用、调用顺序、失败时留下什么、
 * 确认时发了哪两个字段。这些判定不能只写在 JSX 里 —— 那样只能靠"读源码猜"来验收。
 * 所以本文件的做法是：**流程写成接收依赖的闭包（runner / store / controller）**，
 * React hook 只是它们的装配与投影。`test/expertClientFlow.test.mjs` 用假 runtime /
 * 假 fetch 直接驱动这些函数，断言会随实现变坏而变红。
 *
 * ## 五条不许动的口径（都有规格或事故背书）
 *
 * 1. **生成会话一律 `sessions.create({ workspaceId })`**（方案 §5.4 第 5 步）：
 *    不传 `sessionId`、不调 `connectWorkspace`、**不读会话列表去猜"当前/最后一条"**。
 *    读完这个文件你会发现生成链路一次都不碰 `sessions.list` —— 这是刻意的，
 *    因为"猜一个会话来复用"正是 AX-E52 要防的事故。没装 `create` 的宿主上
 *    开工前就报 `create-unavailable`（缺能力明说，不静默降级成"复用当前会话"）。
 * 2. **每个 await 之后查一次 `isAlive()`**：面板/实例已经没了就别再往下走、别再 setState。
 * 3. **失败不删不改用户已有的东西**：本域只 `create` 与 `retain/release`，
 *    绝不 archive / delete / 覆盖任何会话；失败时草稿与会话都留着，交给界面给下一步入口。
 * 4. **确认必须带"所见版本"**：`{ expectedVersion, manifestHash }` 两个字段都来自
 *    被渲染的那一份草稿的 payload，不重算、不猜；版本已经变过时**只刷新预览**，
 *    绝不自动确认新内容（AX-E55）。
 * 5. **`autoSummonExperts` 的写入只有一处**：本域 POST 局部 patch，
 *    成功后把真值写回设置域；失败时丢掉乐观值（界面自动回到服务端真值）并显示错误。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { EXPERTS_CATALOG_PATH, EXPERTS_PREFLIGHT_PATH, type ExpertApiCall } from '../expertInputSource.js'
import { personaFlagPatch } from '../personaPicker.js'
import { acquireSession, openSessionInMainView } from '../sessionRef.js'
import {
  EXPERT_DRAFT_KIND,
  type ExpertDraftPayload,
  type ExpertDraftPhase,
  type ExpertInstallResult,
  type ExpertIssue,
  type ExpertProvenance,
} from '../../shared/expert.js'
import type { DraftView } from '../../shared/contracts.js'
import type { PersonaSummary } from '../../shared/persona.js'
import type { ExpertCatalogRequiredSkill, ExpertCatalogRow, ExpertCatalogStatus } from '../../experts/catalog.js'
import type { ExpertCatalogResponse, ExpertCapabilities } from '../../experts/service.js'
import type { WorkbenchRuntime } from '../viewTypes.js'

// ---------------------------------------------------------------------------
// 1. 端点常量（本域新增的**唯一**出处；P7 那三条仍在 `expertInputSource.ts` 里复用）
// ---------------------------------------------------------------------------

/** `GET`：服务端能力（generation/skills/manualSummon/autoSummon + providerName）。 */
export const EXPERTS_CAPABILITIES_PATH = '/api/workbench/experts/capabilities'
/** `GET`：方法论全文（生成提示词的短上下文拼装依据）。 */
export const EXPERTS_METHODOLOGY_PATH = '/api/workbench/experts/methodology'
/** `POST`：登记一次生成（body 恰为 `{sessionId, request, workspaceId}`）→ pending 草稿。 */
export const EXPERTS_GENERATION_START_PATH = '/api/workbench/experts/generation-start'
/** `GET`：单份专家草稿（body 里带 `drift`，我们只读 `draft`）。 */
export function expertDraftDetailPath(draftId: string): string {
  return `/api/workbench/experts/drafts/${draftId}`
}
/** `POST`：校验草稿（body 恰为 `{ expectedVersion }`）。 */
export function expertDraftValidatePath(draftId: string): string {
  return `/api/workbench/experts/drafts/${draftId}/validate`
}
/**
 * `POST`：**确认安装**。
 *
 * ⚠️ 走既有的草稿确认路由（`src/api/routes/drafts.ts` 的 expert 分支），
 * 不是计划文稿里写的 `/experts/.../confirm`（那条在真实实现里不存在）。
 * body 恰为 `{ expectedVersion, manifestHash }`。
 */
export function expertDraftConfirmPath(draftId: string): string {
  return `/api/workbench/drafts/${draftId}/confirm`
}
/** `POST`：放弃草稿（body 恰为 `{ expectedVersion, reason? }`）。 */
export function expertDraftAbandonPath(draftId: string): string {
  return `/api/workbench/drafts/${draftId}/abandon`
}
/**
 * `POST`：生效行预检（PersonaPicker 与 AI 会话入口**共用同一条**，方案 §9.2）。
 *
 * 这里**不重新写字面量**：`expertInputSource.ts:49` 是它的唯一定义处，
 * 本模块只是把它连同其余端点常量一起再导出，让调用点在一处取用。
 */
export { EXPERTS_PREFLIGHT_PATH } from '../expertInputSource.js'
/** 设置写入端点（`autoSummonExperts` 与人格 flag 都走它；本文件里只此一处字面量）。 */
const SETTINGS_PATH = '/api/workbench/settings'

// ---------------------------------------------------------------------------
// 2. 类型
// ---------------------------------------------------------------------------

/** 目录响应的客户端投影（形状与服务端响应一致，本域起个名字便于断言）。 */
export type ExpertCatalogView = ExpertCatalogResponse

/** 空目录（尚未加载成功时的稳定值：**不是** undefined，避免调用点到处判空）。 */
export const EMPTY_EXPERT_CATALOG: ExpertCatalogView = {
  experts: [],
  personas: [],
  diagnostics: [],
  skillsAvailable: false,
  preliminary: true,
}

/** 本域给界面看的稳定错误码（`data-wb-expert-error` 用它，中文只进 message）。 */
export type ExpertErrorCode =
  | 'empty-request'
  | 'no-workspace'
  | 'busy'
  | 'create-unavailable'
  | 'generation-unavailable'
  | 'methodology-unavailable'
  | 'create-failed'
  | 'acquire-failed'
  | 'generation-start-failed'
  | 'prompt-failed'
  | 'open-failed'
  | 'aborted'
  | 'catalog-load-failed'
  | 'auto-summon-save-failed'
  | 'flag-save-failed'
  | 'draft-invalid-payload'
  | 'draft-not-validated'
  | 'install-in-progress'
  | 'version-conflict'
  | 'confirm-failed'
  | 'validate-failed'

export interface ExpertUiError {
  code: ExpertErrorCode
  message: string
}

/** 生成流程的依赖（全部可注入：`node --test` 里换成假实现）。 */
export interface ExpertFlowDeps {
  /** HTTP 调用（默认 `api`；测试注入记录型假实现）。 */
  call: ExpertApiCall
  /** 宿主运行时（`ctx`）。 */
  runtime: unknown
  /** 打开会话要用（`openSessionInMainView` 的 ctx）。 */
  ctx: unknown
  /** 每个 await 之后问一次"实例/面板还在吗"。 */
  isAlive: () => boolean
  /** 非致命的可读提示（例如 `rename` 失败）。 */
  onNotice?: (message: string) => void
}

/** 生成入口的输入。 */
export interface ExpertCreateInput {
  request: string
  workspaceId: string
}

/** 生成流程的**单一结果形状**（成功/失败都返回它，界面不用分叉判断）。 */
export interface ExpertCreateOutcome {
  ok: boolean
  code: ExpertErrorCode | null
  /** 可读原因（失败必填；成功为 null）。 */
  message: string | null
  /** 已经建出来的会话 id —— **失败也保留**，供"打开生成会话"。 */
  sessionId: string | null
  /** 服务端登记的草稿 id（generation-start 成功之后就有）。 */
  draftId: string | null
  draft: DraftView | null
  /** 是否成功切到主视图。 */
  opened: boolean
  /** prompt 是否已经发出去（决定"继续修改"能否直接续着说）。 */
  promptSent: boolean
}

/** 生成流程的控制器：**busy 状态在闭包里**（连点第二次直接拒绝，不发第二次请求）。 */
export interface ExpertGenerationRunner {
  readonly busy: boolean
  /** 最近一次已经建出来的生成会话 id（失败时界面拿它给"打开生成会话"）。 */
  lastSessionId(): string | null
  start(input: ExpertCreateInput): Promise<ExpertCreateOutcome>
}

export interface ExpertValidateOutcome {
  ok: boolean
  code: ExpertErrorCode | null
  message: string | null
  /** 服务端返回的最新草稿（校验后 phase/validation 会变）。 */
  draft: DraftView | null
  /** 校验问题（中文，直接显示）。 */
  problems: string[]
}

export interface ExpertConfirmOutcomeView {
  ok: boolean
  code: ExpertErrorCode | null
  message: string | null
  expert: ExpertInstallResult | null
  replayed: boolean
  /**
   * 失败后重读出来的**最新**草稿：版本冲突时界面拿它刷新预览。
   * 成功时为 `null`（外层会用确认回执里的结果收口）。
   */
  refreshed: DraftView | null
  /** 这次确认实际发出去的两个字段（验收要断言"所见即所确认"）。 */
  sent: { expectedVersion: number; manifestHash: string } | null
}

/** 草稿动作控制器（校验 / 确认；与 React 无关，可注入假 call）。 */
export interface ExpertDraftOps {
  validate(draft: DraftView): Promise<ExpertValidateOutcome>
  confirm(draft: DraftView): Promise<ExpertConfirmOutcomeView>
}

/** 草稿状态 → 按钮/文案（AX-E54 的判定必须是不依赖 DOM 的纯函数）。 */
export interface ExpertDraftButtons {
  phase: ExpertDraftPhase | 'unknown'
  validate: { enabled: boolean; label: string }
  confirm: { enabled: boolean; label: string }
  editWithAi: { enabled: boolean; label: string }
  /** 正在进行的提示（installing 用）。 */
  notice: string | null
  /** 稳定错误码（无错误为 null）。 */
  errorCode: ExpertErrorCode | null
  errorMessage: string | null
}

/**
 * 读出专家草稿 payload 的结果：**判别联合**，让调用点在 `ok === false` 之后
 * 拿到的是"一定有 payload"的那一支（省掉每个调用点的二次判空）。
 */
export type ExpertDraftPayloadRead =
  | { ok: true; payload: ExpertDraftPayload; code: null; message: null }
  | { ok: false; payload: null; code: ExpertErrorCode; message: string }

/** 管理行/选择器共用的展示投影（纯函数：取值、贴标签、**去掉不该显示的东西**）。 */
export interface ExpertRowView {
  id: string
  name: string
  description: string
  group: string
  status: ExpertCatalogStatus
  statusLabel: string
  sourceLabel: string
  /** 来源方式（内置/外部目录/用户库 + 目录名末段，**绝不含绝对路径**）。 */
  sourceKeyLabel: string
  provenanceLabel: string
  /** 每个来源一行：repo · path · commit（未知提交要写明）· 许可。 */
  sourceLines: string[]
  /** 必需/可选技能一行：名字 + 是否可用 + **实际生效的 provider**。 */
  skillLines: string[]
  /** 可读的问题清单（坏文件行必须有内容）。 */
  issueLines: string[]
  /**
   * 能否在选择器里选中（`usable` 才 true）。
   *
   * 行的 status 是**服务端唯一真值**；这里不另算一套（`dependency-unavailable` 等
   * 行仍要显示在管理页，只是不给选）。
   */
  selectable: boolean
  /** 收藏 / 启用（两个 flag 的按钮状态）；管理页的开关直接读它。 */
  favorite: boolean
  enabled: boolean
}

// ---------------------------------------------------------------------------
// 3. 纯函数：形状判定、展示投影、按钮映射、提示词
// ---------------------------------------------------------------------------

/**
 * 角色预检结论的**客户端投影**（`POST /experts/preflight` 的响应）。
 *
 * 为什么单独做一个投影：调用点有两处（AI 会话入口守卫、选择器/命令的手动入口），
 * 它们必须用**同一份**判定 —— 否则"选择器说可用、绑定却报不可用"。
 * 这也是 P7 交接第 6 条要求的口径：展示"身份已变更"时取 preflight 返回的
 * `summary`（**当前值**），不要拿目录里那份可能过期的。
 */
export interface ExpertPreflightView {
  personaId: string
  usable: boolean
  /** 不可用的可读原因（优先服务端 `reason`，其次 `summary`）。 */
  reason: string
  /** 稳定原因码（服务端给才有）。 */
  code: string | null
  /** 服务端摘要（当前值；界面展示优先用它）。 */
  summary: string
  /** 依赖检查是否只是"预检"这一档（HTTP 侧没有 live agent 时为 true）。 */
  preliminary: boolean
  issues: ExpertIssue[]
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function expertIssuesOf(value: unknown): ExpertIssue[] {
  if (!Array.isArray(value)) return []
  const out: ExpertIssue[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const code = textOf(raw.code)
    const message = textOf(raw.message)
    if (code === '' && message === '') continue
    const issue: ExpertIssue = { code, field: textOf(raw.field), message }
    out.push(issue)
  }
  return out
}

/**
 * 把 preflight 的原始响应读成投影；**形状不对返回 `null`**（调用方据此"不拦人"）。
 *
 * 返回 null 的两种真实情况：服务端没有专家模块（旧版本 / 未装配 ⇒ 404/503），
 * 或者响应根本不是 preflight。这两种都**不该**阻断普通角色绑定 ——
 * 普通 persona 的绑定语义一个字都没变（§9.2 只加"明确不可用就拦住"这一条）。
 */
export function readExpertPreflight(raw: unknown, personaId: string): ExpertPreflightView | null {
  if (raw === null || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const rawPersonaId = textOf(body.personaId)
  if (rawPersonaId === '' || rawPersonaId !== personaId) return null
  if (typeof body.usable !== 'boolean') return null
  const issues = expertIssuesOf(body.issues)
  const reason = textOf(body.reason)
  const summary = textOf(body.summary)
  const code = textOf(body.code)
  return {
    personaId,
    usable: body.usable,
    reason: reason !== '' ? reason : summary,
    code: code !== '' ? code : null,
    summary,
    preliminary: body.preliminary === true,
    issues,
  }
}

/**
 * 明确不可用时给出的可读错误；可用（或只能"预检"这一档）返回 `null`。
 *
 * `preliminary` **不**拦人：那是"这次没法看 scope"的降级视角（服务端注释写明
 * 它不是最终证明），真正在绑定/启动时还会再复核一次。
 */
export function expertPersonaPreflightError(view: ExpertPreflightView): string | null {
  if (view.usable) return null
  const detail = view.reason !== '' ? view.reason : '服务端没有给出原因'
  const suffix = view.code !== null ? `（${view.code}）` : ''
  return `角色「${view.personaId}」当前不可用，本次没有发送 prompt${suffix}：${detail}`
}

/**
 * 取一次 preflight 并投影。**传输失败返回 `null`**（降级为"不拦"），
 * 与 `readExpertPreflight` 的形状不符同一处理。
 */
export async function fetchExpertPreflight(
  call: ExpertApiCall,
  input: { sessionId: string; personaId: string },
): Promise<ExpertPreflightView | null> {
  try {
    const raw = await call<unknown>(EXPERTS_PREFLIGHT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: input.sessionId, personaId: input.personaId }),
    })
    return readExpertPreflight(raw, input.personaId)
  } catch {
    /**
     * 刻意**不**把异常往上抛：专家模块缺失（旧服务端 / 未装配）时只是"这次没法预检"，
     * 不该让普通角色绑定整体不可用（P7 交接第 3 条同一口径：目录/预检失败只降级）。
     * 真正的失败仍会由随后的绑定调用自己报出来。
     */
    return null
  }
}

/** 宿主有没有 `sessions.create`（缺能力要**明说**，不静默降级）。 */
export function hasSessionCreate(runtime: unknown): boolean {
  const sessions = (runtime as WorkbenchRuntime | undefined)?.sessions
  return typeof (sessions as { create?: unknown } | undefined)?.create === 'function'
}

const EXPERT_PHASES: readonly ExpertDraftPhase[] = ['editing', 'validated', 'installing', 'install-failed']

/**
 * 把服务端专家草稿的响应**归一化**成流程内部统一使用的 `DraftView` 形状（`id` + `payload`）。
 *
 * 为什么必须有这一层：专家域三件套返回的是 `ExpertDraftView`（**平铺**：`draftId` 在顶层，
 * `contentVersion` / `phase` / `validation` / `files` 也都在顶层），而通用草稿接口
 * （`/api/workbench/drafts*`）返回的是 `DraftView`（`id` + `payload` 嵌套）。本流程内部
 * 一律按 `DraftView` 读写（`draft.id`、`readExpertDraftPayload(draft)` 读 `draft.payload`），
 * 所以两种形状进来都必须先归一化 —— 否则读不到草稿、流程会在拿到草稿之后停住。
 * （2026-10-05 P10 真机验收抓到：`generation-start` 之后第 7 步必失败、提示词永不发出。）
 *
 * 服务端真实形状的出处（改这里之前先看这几处，别只信本注释）：
 * - `src/experts/drafts.ts:156-168` `ExpertDraftView`：平铺字段 + `draftId`，**没有 `id`**；
 * - `src/api/routes/experts.ts:84` generation-start → `{ ok, draft: ExpertDraftView }`；
 * - `src/api/routes/experts.ts:123-139` `GET drafts/:id` 与 `drafts/:id/validate` → 同样是平铺视图；
 * - `src/shared/contracts.ts:116-128` 通用 `DraftView`：`id` + `payload`。
 *
 * 两种形状都认：已经带 `id` + `payload` 的直接放行（专家草稿横幅那条路径给的就是它）；
 * 平铺视图补出 `id`（= `draftId`）、把整份平铺字段放进 `payload`。两个形状都不是就返回
 * `null`，由调用点给稳定 code —— **不猜、不静默降级**。
 */
export function normalizeExpertDraftResponse(raw: unknown): DraftView | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  // 通用草稿形状：`id` + `payload` 都在，直接用。
  if (typeof record.id === 'string' && record.payload !== null && typeof record.payload === 'object') {
    return record as unknown as DraftView
  }
  // 专家域平铺视图：认 `draftId`，其余字段整体进 `payload`。
  const draftId = typeof record.draftId === 'string' ? record.draftId.trim() : ''
  if (draftId === '') return null
  return {
    id: draftId,
    kindCode: 'expert',
    sessionId: null,
    payload: record,
    statusCode: typeof record.statusCode === 'string' ? record.statusCode : '',
    deferredAt: null,
    deferCount: 0,
    createdAt: '',
    updatedAt: '',
  }
}

/**
 * 从 `DraftView.payload` 里**防御性**读出专家草稿 payload。
 *
 * 为什么不信服务端形状：草稿 payload 是 JSONB，历史行/半写行都可能缺字段；
 * 读不出来时必须给稳定 code，而不是让界面崩在 `payload.phase.toUpperCase()` 上。
 */
export function readExpertDraftPayload(draft: DraftView | null | undefined): ExpertDraftPayloadRead {
  const raw = draft?.payload
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { ok: false, payload: null, code: 'draft-invalid-payload', message: '草稿内容为空或不是对象，无法预览。' }
  }
  const record = raw as Partial<ExpertDraftPayload>
  const version = record.contentVersion
  if (typeof version !== 'number' || Number.isInteger(version) === false || version < 0) {
    return { ok: false, payload: null, code: 'draft-invalid-payload', message: '草稿缺少 contentVersion，无法确认版本。' }
  }
  const phase = record.phase
  if (typeof phase !== 'string' || EXPERT_PHASES.includes(phase as ExpertDraftPhase) === false) {
    return { ok: false, payload: null, code: 'draft-invalid-payload', message: `草稿阶段无法识别（${String(phase)}）。` }
  }
  const payload: ExpertDraftPayload = {
    version: 1,
    contentVersion: version,
    expertId: typeof record.expertId === 'string' ? record.expertId : '',
    request: typeof record.request === 'string' ? record.request : '',
    phase: phase as ExpertDraftPhase,
    personaMd: typeof record.personaMd === 'string' ? record.personaMd : '',
    provenance: (record.provenance ?? null) as ExpertProvenance | null,
    skills: Array.isArray(record.skills) ? (record.skills as ExpertDraftPayload['skills']) : [],
    files: Array.isArray(record.files) ? (record.files as ExpertDraftPayload['files']) : [],
    validation: record.validation ?? null,
    lastInstallError: (record.lastInstallError ?? null) as ExpertIssue | null,
    ...(record.confirmResult === undefined ? {} : { confirmResult: record.confirmResult }),
  }
  return { ok: true, payload, code: null, message: null }
}

/**
 * 草稿阶段 → 按钮/文案（AX-E54）。
 *
 * 逐条对应方案 §9.4：
 * - `editing`：确认**禁用** + 「校验」/「继续让 AI 修改」；
 * - `validated`：「确认安装专家」可用；
 * - `installing`：全部禁用 + 「安装中…」；
 * - `install-failed`：显示原因、可重新校验重试；
 * - 阶段读不出来：一律禁用 + 稳定 code；
 * - 界面上已经挂着一条稳定错误码时**不给确认**（先按错误处理：重新校验，或看完刷新后的
 *   预览再决定）——「校验」本身照旧可用，因为那正是从错误里恢复的动作。
 *
 * 这里**永远不出现"创建任务"**（专家草稿不建任务，P8 明确禁止那句假文案）。
 */
export function expertDraftButtons(
  phase: ExpertDraftPhase | 'unknown',
  busy: boolean,
  error: ExpertUiError | null,
): ExpertDraftButtons {
  const blocked = busy
  /** 确认比校验多一道闸门：有稳定错误码时不许装（安装中的 409 也走这里）。 */
  const confirmBlocked = busy || error !== null
  const base: ExpertDraftButtons = {
    phase,
    validate: { enabled: false, label: '校验' },
    confirm: { enabled: false, label: '确认安装专家' },
    editWithAi: { enabled: false, label: '继续让 AI 修改' },
    notice: null,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
  }
  if (phase === 'editing') {
    return {
      ...base,
      validate: { enabled: blocked === false, label: busy ? '校验中…' : '校验' },
      editWithAi: { enabled: blocked === false, label: '继续让 AI 修改' },
    }
  }
  if (phase === 'validated') {
    return {
      ...base,
      validate: { enabled: blocked === false, label: busy ? '校验中…' : '重新校验' },
      confirm: { enabled: confirmBlocked === false, label: busy ? '安装中…' : '确认安装专家' },
      editWithAi: { enabled: blocked === false, label: '继续让 AI 修改' },
    }
  }
  if (phase === 'installing') {
    return { ...base, notice: '安装中…（完成后这里会变成已安装）' }
  }
  if (phase === 'install-failed') {
    return {
      ...base,
      validate: { enabled: blocked === false, label: busy ? '校验中…' : '重新校验并重试' },
      editWithAi: { enabled: blocked === false, label: '继续让 AI 修改' },
      notice: null,
    }
  }
  return {
    ...base,
    errorCode: error?.code ?? 'draft-invalid-payload',
    errorMessage: error?.message ?? '草稿内容无法识别，请联系管理员查看服务端记录。',
  }
}

const SOURCE_LABELS: Record<string, string> = { builtin: '内置', external: '外部目录', user: '用户库' }
/** 状态 → 中文（管理页的"状态筛选"下拉与行标签**共用同一份**，不许再造第二套）。 */
export const EXPERT_STATUS_LABELS: Record<ExpertCatalogStatus, string> = {
  usable: '可用',
  disabled: '已停用',
  invalid: '文件有问题',
  'dependency-unavailable': '依赖技能不可用',
  'installation-incomplete': '安装未完成',
}
const PROVENANCE_LABELS: Record<string, string> = {
  recorded: '来源已登记',
  unrecorded: '来源未登记（可用，但无法追溯上游）',
  invalid: '来源登记损坏',
}

/**
 * 来源方式标签：**绝不回显服务端绝对目录**（方案 §9.3 最后一条）。
 *
 * 外部目录的 `sourceKey` 就是宿主给的绝对路径；界面只能看"这是外部目录 + 目录名"。
 */
export function safeSourceKeyLabel(source: string, sourceKey: string): string {
  const label = SOURCE_LABELS[source] ?? '未知来源'
  if (source !== 'external') return label
  const tail = String(sourceKey ?? '')
    .split(/[\\/]/)
    .filter((part) => part !== '')
    .pop()
  return tail === undefined || tail === '' ? label : `${label} · ${tail}`
}

function skillLine(skill: ExpertCatalogRequiredSkill): string {
  const provider = skill.available ? (skill.provider ?? '已注册（provider 未知）') : '不可用'
  return `${skill.name}：${provider}${skill.preliminary ? '（预检视角）' : ''}`
}

function provenanceLines(provenance: ExpertProvenance | null): string[] {
  if (provenance === null) return []
  return provenance.sources.map((source) => (
    `${source.repository} · ${source.upstreamPath} · ${source.commit === null ? '未知提交（可能有改动风险）' : source.commit} · ${source.license}`
  ))
}

/**
 * 一行的展示投影（列表 + 展开详情都用它）。
 *
 * `selectable` 的口径与服务端一致：**只有 `usable` 能被选去跑**；
 * `dependency-unavailable`（必需技能缺失）等行仍然**可见**（管理页要能看到原因）。
 */
export function expertRowView(row: ExpertCatalogRow): ExpertRowView {
  const sourceLabel = SOURCE_LABELS[row.source] ?? '未知来源'
  const sourceKeyLabel = safeSourceKeyLabel(row.source, row.sourceKey)
  /**
   * 列表那一行只在有信息时显示来源键：内置 / 用户库的 sourceKeyLabel
   * 与 sourceLabel 是同一个词（实测渲染成「内置｜domain｜内置｜…」），
   * 重复一遍既占宽度又像两套来源。外部目录才会给出「外部目录 · <目录名>」。
   */
  const distinctSourceKey = sourceKeyLabel === sourceLabel ? '' : sourceKeyLabel
  /**
   * 内置角色本来就没有上游来源（它们随包发布），把 unrecorded 统一渲染成
   * 「来源未登记（可用，但无法追溯上游）」会让整张列表看起来像在报错。
   * 用户库/外部目录里的 unrecorded 仍然保留这句话（那才是有意义的提示）。
   */
  const provenanceLabel = row.source === 'builtin' && row.provenanceState === 'unrecorded'
    ? ''
    : (PROVENANCE_LABELS[row.provenanceState] ?? '来源状态未知')
  return {
    id: row.id,
    name: row.name !== '' ? row.name : row.id,
    description: row.description,
    group: row.group,
    status: row.status,
    statusLabel: EXPERT_STATUS_LABELS[row.status] ?? row.status,
    sourceLabel,
    sourceKeyLabel: distinctSourceKey,
    provenanceLabel,
    sourceLines: provenanceLines(row.provenance),
    skillLines: row.requiredSkills.map(skillLine),
    issueLines: row.issues.map((issue) => issue.message),
    selectable: row.status === 'usable',
    favorite: row.favorite,
    enabled: row.enabled,
  }
}

/**
 * 管理页的行过滤（纯函数）。
 *
 * ⚠️ **不过滤掉坏行**：`invalid` / `dependency-unavailable` /
 * `installation-incomplete` 都要能按状态筛出来看到原因（AX-E56）。
 */
export function expertAdminRows(
  catalog: ExpertCatalogView,
  query: string,
  status: ExpertCatalogStatus | 'all',
): ExpertCatalogRow[] {
  const needle = query.trim().toLowerCase()
  return catalog.experts.filter((row) => {
    if (status !== 'all' && row.status !== status) return false
    if (needle === '') return true
    return `${row.name}\n${row.description}\n${row.id}\n${row.group}`.toLowerCase().includes(needle)
  })
}

/**
 * 选择器可用的角色（AX-E56："required 缺失行进不了选择器"）。
 *
 * 服务端已经只把 `status==='usable'` 的摘要放进 `personas`，这里是**客户端第二道闸门**：
 * 凡是能在 `experts` 里找到对应行、且该行不是 `usable` 的，一律不进选择器；
 * 找不到对应行的手工角色（旧来源未登记）**不过滤**（AX-E56 要求它仍可选）。
 */
export function expertPickerPersonas(catalog: ExpertCatalogView): PersonaSummary[] {
  const byId = new Map(catalog.experts.map((row) => [row.id, row]))
  return catalog.personas.filter((persona) => {
    const row = byId.get(persona.id)
    return row === undefined || row.status === 'usable'
  })
}

/** 工作区条目形状（`runtime.workspaces.list` 里那段）。 */
export interface WorkspaceChoice {
  workspaceId: string
  path?: string
}

/** 路径归一：统一分隔符、小写盘符、去尾部斜杠（Windows 下大小写不敏感）。 */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 从已有工作区里按"当前会话 cwd"匹配一个（方案 §5.4 第 1 步）。
 *
 * **只匹配，不创建**：匹配不上就让用户自己选（绝不自动建任务资料夹、绝不猜一个）。
 */
export function matchWorkspaceForCwd(items: readonly WorkspaceChoice[], cwd: string): string | null {
  const needle = normalizePath(cwd)
  if (needle === '') return null
  /**
   * 子目录命中要取**最长**的那个前缀：`D:\Code` 与 `D:\Code\x` 同时存在时，
   * 当前会话在 `D:\Code\x\sub` 里属于后者。取第一个命中会让"外层工作区"
   * 抢走本属于内层工作区的会话（用户看到的就是"生成会话跑错目录"）。
   */
  let best: { workspaceId: string; length: number } | null = null
  for (const item of items) {
    if (typeof item.workspaceId !== 'string' || item.workspaceId === '') continue
    const path = normalizePath(String(item.path ?? ''))
    if (path === '') continue
    if (path === needle) return item.workspaceId
    if (needle.startsWith(`${path}/`) && (best === null || path.length > best.length)) {
      best = { workspaceId: item.workspaceId, length: path.length }
    }
  }
  return best === null ? null : best.workspaceId
}

/** 生成会话标题：`新建专家：` + request 前 30 字符（方案 §5.4 第 8 步）。 */
export function expertSessionTitle(request: string): string {
  return `新建专家：${request.trim().slice(0, 30)}`
}

/**
 * 构造这次生成的 prompt：**短上下文 + 方法论全文 + 用户请求**（方案 §5.4 第 7 步）。
 *
 * 刻意不绑定任何任务 persona、不引用旧业务会话 —— 生成会话是一次干净的独立对话。
 */
export function buildExpertGenerationPrompt(input: { request: string; methodology: string }): string {
  return [
    '你在本工作台里负责**新建一位专家角色**（人格文档 + 需要的 skill）。',
    '请只依据下面的方法论与用户请求工作，不要假设还有别的上下文。',
    '',
    '## 方法论（全文）',
    input.methodology.trim(),
    '',
    '## 用户的请求',
    input.request.trim(),
    '',
    '## 交付方式',
    '按方法论把人格文档与需要的 skill 暂存成草稿，然后用暂存工具汇报；',
    '不要自己去写工作台的数据文件，也不要请求用户手动复制文件。',
  ].join('\n')
}

/** 从确认回执里取安装结果（形状不对返回 null，不硬编类型）。 */
export function readExpertInstalledFromOutcome(outcome: unknown): ExpertInstallResult | null {
  const expert = (outcome as { expert?: unknown } | null | undefined)?.expert
  if (expert === null || expert === undefined || typeof expert !== 'object') return null
  return expert as ExpertInstallResult
}

/** 这条草稿是不是专家草稿。 */
export function isExpertDraft(draft: DraftView | null | undefined): boolean {
  return draft?.kindCode === EXPERT_DRAFT_KIND
}

// ---------------------------------------------------------------------------
// 4. 生成流程（方案 §5.4 的 11 步）
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 建一次"独立生成会话"的 runner。
 *
 * 顺序（每一步失败都给出**稳定 code + 可读原因**，并保留已有会话与草稿）：
 * 1. 空请求直接拒绝（按钮也禁用，这里是第二道闸门）；
 * 2. 能力探测：`sessions.create` 不在 → `create-unavailable`（**不降级复用当前会话**）；
 * 3. `GET capabilities` → `generation.available === false` → `generation-unavailable`；
 * 4. `GET methodology` → 读不到正文 → `methodology-unavailable`；
 * 5. `sessions.create({ workspaceId })`（**不传 sessionId**，新身份由宿主给）；
 * 6. `acquireSession` → `finally release()`（引用必须一一配对）；
 * 7. `POST generation-start` → 草稿；
 * 8. `session.rename(...)`（失败只提示，不影响流程）；
 * 9. `session.prompt(..., 'queue')` → `ok === false` 时**保留草稿与会话**报错；
 * 10. `openSessionInMainView`（打开失败也算失败，但会话与草稿都在）；
 * 11. `finally release()`；任何失败都不删除、不归档用户的会话。
 */
export function createExpertGenerationRunner(deps: ExpertFlowDeps): ExpertGenerationRunner {
  let busy = false
  let lastSessionId: string | null = null
  const fail = (
    code: ExpertErrorCode,
    message: string,
    extra?: Partial<ExpertCreateOutcome>,
  ): ExpertCreateOutcome => ({
    ok: false,
    code,
    message,
    sessionId: lastSessionId,
    draftId: null,
    draft: null,
    opened: false,
    promptSent: false,
    ...extra,
  })
  return {
    get busy() {
      return busy
    },
    lastSessionId: () => lastSessionId,
    async start(input: ExpertCreateInput): Promise<ExpertCreateOutcome> {
      const request = input.request.trim()
      if (request === '') return fail('empty-request', '请先写下你想要的新专家（一句话即可）。')
      const workspaceId = input.workspaceId.trim()
      if (busy) return fail('busy', '上一次生成还没结束，请稍等。')
      if (hasSessionCreate(deps.runtime) === false) {
        return fail('create-unavailable', '当前 DSH 不支持新建独立会话（缺 sessions.create），无法生成专家。请升级 DSH 后重试；工作台不会用当前会话冒充新会话。')
      }
      if (workspaceId === '') return fail('no-workspace', '请先选择一个工作区（生成会话要在它下面跑）。')
      busy = true
      try {
        // 3. 服务端能力
        let capabilities: ExpertCapabilities
        try {
          capabilities = await deps.call<ExpertCapabilities>(EXPERTS_CAPABILITIES_PATH)
        } catch (error) {
          return fail('generation-unavailable', `读不到服务端专家能力：${errorText(error)}`)
        }
        if (!deps.isAlive()) return fail('aborted', '面板已关闭，已停止生成。')
        if (capabilities?.generation?.available !== true) {
          return fail('generation-unavailable', capabilities?.generation?.reason === 'methodology-unavailable'
            ? '服务端没有可用的专家方法论，暂时不能生成专家。'
            : `服务端专家生成能力不可用${capabilities?.generation?.reason === undefined || capabilities?.generation?.reason === null ? '' : `（${capabilities.generation.reason}）`}。`)
        }
        // 4. 方法论：**建会话之前**先确认资产读得到
        let methodology = ''
        try {
          const res = await deps.call<{ version?: number; text?: string }>(EXPERTS_METHODOLOGY_PATH)
          methodology = typeof res?.text === 'string' ? res.text : ''
        } catch (error) {
          return fail('methodology-unavailable', `读不到专家方法论：${errorText(error)}`)
        }
        if (!deps.isAlive()) return fail('aborted', '面板已关闭，已停止生成。')
        if (methodology.trim() === '') return fail('methodology-unavailable', '服务端的专家方法论是空的，无法生成。')
        // 5. 独立新会话（不传 sessionId、不读列表、不复用 blank）
        const runtime = deps.runtime as WorkbenchRuntime | undefined
        const sessions = runtime?.sessions
        const create = (sessions as { create?: (opts?: { workspaceId?: string }) => Promise<string> } | undefined)?.create
        let sessionId = ''
        try {
          sessionId = await create!.call(sessions, { workspaceId })
        } catch (error) {
          return fail('create-failed', `新建生成会话失败：${errorText(error)}`)
        }
        if (typeof sessionId !== 'string' || sessionId === '') {
          return fail('create-failed', '新建生成会话没有返回会话 id，已停止（不会复用其它会话）。')
        }
        lastSessionId = sessionId
        if (!deps.isAlive()) return fail('aborted', '面板已关闭，已停止生成。', { sessionId })
        // 6. 取引用（失败时 acquireSession 自己会释放）
        let reference
        try {
          reference = await acquireSession(sessions, sessionId)
        } catch (error) {
          return fail('acquire-failed', `无法使用新建的生成会话：${errorText(error)}。可以在会话列表里手动打开 ${sessionId}。`, { sessionId })
        }
        try {
          if (!deps.isAlive()) return fail('aborted', '面板已关闭，已停止生成。', { sessionId })
          // 7. 登记草稿
          let draft: DraftView
          try {
            const res = await deps.call<{ draft?: unknown }>(EXPERTS_GENERATION_START_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, request, workspaceId }),
            })
            // 服务端这里回的是平铺的 `ExpertDraftView`（`draftId` 在顶层）→ 先归一化再判。
            const normalized = normalizeExpertDraftResponse(res?.draft)
            if (normalized === null) {
              return fail('generation-start-failed', '服务端没有返回草稿，已停止（草稿可在待处理里找回或重试）。', { sessionId })
            }
            draft = normalized
          } catch (error) {
            return fail('generation-start-failed', `登记生成草稿失败：${errorText(error)}。已有会话与内容都还在。`, { sessionId })
          }
          if (!deps.isAlive()) return fail('aborted', '面板已关闭，已停止生成。', { sessionId, draftId: draft.id, draft })
          // 8. 重命名（失败只提示）
          try {
            await reference.session.rename(expertSessionTitle(request))
          } catch (error) {
            deps.onNotice?.(`生成会话改名失败（不影响生成）：${errorText(error)}`)
          }
          if (!deps.isAlive()) return fail('aborted', '面板已关闭，已停止生成。', { sessionId, draftId: draft.id, draft })
          // 9. 发 prompt
          try {
            const sent = await reference.session.prompt(
              [{ type: 'text', text: buildExpertGenerationPrompt({ request, methodology }) }],
              'queue',
            )
            if (sent?.ok === false) {
              return fail('prompt-failed', '生成消息没有发出去（会话与草稿都还在，可以打开生成会话继续）。', {
                sessionId, draftId: draft.id, draft,
              })
            }
          } catch (error) {
            return fail('prompt-failed', `发送生成消息失败：${errorText(error)}。会话与草稿都还在。`, {
              sessionId, draftId: draft.id, draft,
            })
          }
          if (!deps.isAlive()) return fail('aborted', '面板已关闭，已停止生成。', { sessionId, draftId: draft.id, draft, promptSent: true })
          // 10. 切主视图
          try {
            openSessionInMainView(deps.ctx, sessionId)
          } catch (error) {
            return fail('open-failed', `生成已经开始了，但没能在主视图里打开它：${errorText(error)}。可以从待确认草稿里点「打开生成会话」。`, {
              sessionId, draftId: draft.id, draft, promptSent: true,
            })
          }
          return {
            ok: true,
            code: null,
            message: null,
            sessionId,
            draftId: draft.id,
            draft,
            opened: true,
            promptSent: true,
          }
        } finally {
          // 11. 引用必须一一配对释放（release 内部已做幂等）
          reference.release()
        }
      } finally {
        busy = false
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 5. 草稿动作：校验 / 确认
// ---------------------------------------------------------------------------

/**
 * 校验与确认的 runner。
 *
 * 两条硬规则（AX-E54/E55）：
 * - 确认 body 恰好 `{ expectedVersion, manifestHash }`，两个值都取自**被渲染的**那份草稿；
 *   阶段不是 `validated`、或校验快照的版本与 contentVersion 不一致 → **不发请求**直接拒绝。
 * - 确认失败时**重读**草稿：若服务端已经往前走了一版，就把最新草稿作为 `refreshed` 交出去
 *   让界面刷新预览 —— **绝不**拿新版本自动再确认一次。
 */
export function createExpertDraftOps(deps: ExpertFlowDeps): ExpertDraftOps {
  return {
    async validate(draft: DraftView): Promise<ExpertValidateOutcome> {
      const read = readExpertDraftPayload(draft)
      if (read.ok === false) {
        return { ok: false, code: read.code, message: read.message, draft: null, problems: [] }
      }
      if (read.payload.phase === 'installing') {
        return { ok: false, code: 'install-in-progress', message: '正在安装，等它结束再校验。', draft: null, problems: [] }
      }
      try {
        const res = await deps.call<{ draft?: unknown }>(expertDraftValidatePath(draft.id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedVersion: read.payload.contentVersion }),
        })
        // validate 同样回平铺视图（`draftId` + 顶层 `validation`）→ 归一化后再读 payload。
        const next = normalizeExpertDraftResponse(res?.draft)
        const nextRead = readExpertDraftPayload(next)
        const problems = nextRead.ok ? (nextRead.payload.validation?.errors ?? []).map((issue) => issue.message) : []
        return {
          ok: true,
          code: null,
          message: problems.length === 0 ? null : '校验没通过，按下面的问题让 AI 再改一次。',
          draft: next,
          problems,
        }
      } catch (error) {
        return { ok: false, code: 'validate-failed', message: `校验失败：${errorText(error)}`, draft: null, problems: [] }
      }
    },

    async confirm(draft: DraftView): Promise<ExpertConfirmOutcomeView> {
      const read = readExpertDraftPayload(draft)
      if (read.ok === false) {
        return { ok: false, code: read.code, message: read.message, expert: null, replayed: false, refreshed: null, sent: null }
      }
      const payload = read.payload
      if (payload.phase === 'installing') {
        return { ok: false, code: 'install-in-progress', message: '正在安装，请不要重复确认。', expert: null, replayed: false, refreshed: null, sent: null }
      }
      const validation = payload.validation
      if (payload.phase !== 'validated' || validation === null || validation.version !== payload.contentVersion) {
        return {
          ok: false,
          code: 'draft-not-validated',
          message: '这一版还没有通过校验，请先点「校验」，通过后再确认安装。',
          expert: null,
          replayed: false,
          refreshed: null,
          sent: null,
        }
      }
      const sent = { expectedVersion: payload.contentVersion, manifestHash: validation.manifestHash }
      let res: { expert?: ExpertInstallResult; replayed?: boolean }
      try {
        res = await deps.call<{ expert?: ExpertInstallResult; replayed?: boolean }>(expertDraftConfirmPath(draft.id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sent),
        })
      } catch (error) {
        const message = errorText(error)
        // 失败后**只读**一次最新草稿，用版本比对判断"是不是版本冲突"，不猜文案。
        const refreshed = await readLatestDraft(deps, draft.id)
        const refreshedRead = readExpertDraftPayload(refreshed)
        const serverVersion = refreshedRead.ok ? refreshedRead.payload.contentVersion : null
        if (refreshed !== null && serverVersion !== null && serverVersion !== sent.expectedVersion) {
          return {
            ok: false,
            code: 'version-conflict',
            message: '这份草稿在你确认之前又变了一版，预览已刷新，请看完再决定是否安装。',
            expert: null,
            replayed: false,
            refreshed,
            sent,
          }
        }
        return { ok: false, code: 'confirm-failed', message: `安装失败：${message}`, expert: null, replayed: false, refreshed, sent }
      }
      return {
        ok: true,
        code: null,
        message: null,
        expert: (res?.expert ?? null) as ExpertInstallResult | null,
        replayed: res?.replayed === true,
        refreshed: null,
        sent,
      }
    },
  }
}

/** 读一次最新草稿（版本冲突判定与"刷新预览"都用它）；失败返回 null，不抛。 */
async function readLatestDraft(deps: ExpertFlowDeps, draftId: string): Promise<DraftView | null> {
  try {
    const res = await deps.call<{ draft?: unknown }>(expertDraftDetailPath(draftId))
    // `GET /experts/drafts/:id` 回的也是平铺视图（`draftId`）→ 归一化。
    return normalizeExpertDraftResponse(res?.draft)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 6. 目录 store / 7. 自主开关 controller / 8. 安装后刷新
// ---------------------------------------------------------------------------

/** 目录读取器（只有它知道怎么拉目录，界面与 hook 都调它的 `load()`）。 */
export interface ExpertCatalogStore {
  loading(): boolean
  loadCount(): number
  load(): Promise<ExpertCatalogView | null>
}

export interface ExpertCatalogStoreInput {
  call: ExpertApiCall
  onLoaded: (view: ExpertCatalogView) => void
  onError: (error: ExpertUiError) => void
  onLoading?: (loading: boolean) => void
}

/** 目录读取器：`load()` 可重复调用（安装成功后就是靠它重读真实状态）。 */
export function createExpertCatalogStore(input: ExpertCatalogStoreInput): ExpertCatalogStore {
  let loading = false
  let count = 0
  return {
    loading: () => loading,
    loadCount: () => count,
    async load(): Promise<ExpertCatalogView | null> {
      if (loading) return null
      loading = true
      count += 1
      input.onLoading?.(true)
      try {
        const res = await input.call<ExpertCatalogResponse>(EXPERTS_CATALOG_PATH)
        const view: ExpertCatalogView = {
          experts: Array.isArray(res?.experts) ? res.experts : [],
          personas: Array.isArray(res?.personas) ? res.personas : [],
          diagnostics: Array.isArray(res?.diagnostics) ? res.diagnostics : [],
          skillsAvailable: res?.skillsAvailable === true,
          preliminary: res?.preliminary === true,
        }
        input.onLoaded(view)
        return view
      } catch (error) {
        input.onError({ code: 'catalog-load-failed', message: `读不到专家目录：${errorText(error)}` })
        return null
      } finally {
        loading = false
        input.onLoading?.(false)
      }
    },
  }
}

/** 自主召唤开关的控制器（值 = 乐观值 ?? 服务端真值）。 */
export interface AutoSummonController {
  value(): boolean
  error(): ExpertUiError | null
  busy(): boolean
  set(next: boolean): Promise<boolean>
}

export interface AutoSummonControllerInput {
  /** 服务端真值（设置域）。 */
  readServerValue: () => boolean
  /** 保存成功后把真值写回设置域（**同一写入点**，避免两份真值分叉）。 */
  writeServerValue: (next: boolean) => void
  /** 立即保存；抛错 = 失败。 */
  save: (next: boolean) => Promise<void>
}

/**
 * "允许 AI 自主召唤专家"开关（默认关）。
 *
 * 失败时的口径（AX-E57）：**丢掉乐观值**（界面回落到服务端真值）并给出可读错误；
 * 关掉它**不影响**手动 `@` / `/expert`（那两条链路的可用性由 preflight 单独判定）。
 */
export function createAutoSummonController(input: AutoSummonControllerInput): AutoSummonController {
  let pending: boolean | null = null
  let error: ExpertUiError | null = null
  let busy = false
  return {
    value: () => pending ?? input.readServerValue(),
    error: () => error,
    busy: () => busy,
    async set(next: boolean): Promise<boolean> {
      if (busy) return false
      busy = true
      pending = next
      error = null
      try {
        await input.save(next)
        input.writeServerValue(next)
        pending = null
        return true
      } catch (cause) {
        // 回滚：不保留乐观值，界面读到的是服务端真值。
        pending = null
        error = { code: 'auto-summon-save-failed', message: `保存失败，已回到原来的设置：${errorText(cause)}` }
        return false
      } finally {
        busy = false
      }
    },
  }
}

/**
 * 安装成功之后：**重读目录** + 把实际装了什么说出来（AX-E56）。
 *
 * 为什么单独一个函数：草稿确认的回执只说明"这次安装的结果"，而"现在到底有哪些专家可用"
 * 只有重读目录才知道。两件事都要发生，顺序也固定：先重读，再说结果。
 */
export async function refreshExpertCatalogAfterInstall(input: {
  refresh: () => Promise<unknown>
  onNotice: (message: string | null) => void
  expert?: Pick<ExpertInstallResult, 'installedSkills' | 'reusedSkills' | 'warnings'> | null
}): Promise<void> {
  try {
    await input.refresh()
  } catch (cause) {
    input.onNotice(`专家已安装，但刷新专家列表失败：${errorText(cause)}。可以手动点「刷新」。`)
    return
  }
  const installed = input.expert?.installedSkills ?? []
  const reused = input.expert?.reusedSkills ?? []
  const warnings = input.expert?.warnings ?? []
  const parts: string[] = []
  parts.push(installed.length === 0 ? '没有新增 skill' : `新增 skill：${installed.join('、')}`)
  if (reused.length > 0) parts.push(`复用：${reused.join('、')}`)
  if (warnings.length > 0) parts.push(`${warnings.length} 条警告`)
  input.onNotice(`专家已安装（${parts.join('；')}），列表已按真实状态刷新。`)
}

// ---------------------------------------------------------------------------
// 9. React hook（装配与投影；流程全在上面）
// ---------------------------------------------------------------------------

/** 本域会写回设置域的字段（只有这三个；写回走 native Dispatch，见 hook 说明）。 */
export interface WriteSettingsPatch {
  autoSummonExperts?: boolean
  personaFavorites?: string[]
  personaDisabledIds?: string[]
}

export interface UseWorkbenchExpertsInput {
  /** 宿主运行时（`ctx`）。 */
  runtime: unknown
  /** 当前会话 id（拿它的 cwd 去匹配默认工作区；拿不到就要求用户选）。 */
  workspaceChoices: () => readonly WorkspaceChoice[]
  currentCwd: () => string
  settings: { autoSummonExperts: boolean }
  /**
   * 把保存成功的设置写回设置域（native Dispatch 的调用点，见文件头第 5 条）。
   *
   * 为什么必须写回：设置页的「保存设置」会**整份**提交设置域里的字段，
   * 不同步的话，刚点出来的开关/收藏会被下一次「保存设置」悄悄改回旧值。
   */
  writeSettings: (patch: WriteSettingsPatch) => void
  isAlive: () => boolean
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
}

export interface UseWorkbenchExpertsActions {
  openCreate(): void
  closeCreate(): void
  setCreateRequest(text: string): void
  setCreateWorkspace(id: string): void
  startGeneration(): Promise<void>
  refreshCatalog(): Promise<void>
  setAutoEnabled(value: boolean): Promise<void>
  toggleFavorite(id: string): Promise<void>
  toggleDisabled(id: string): Promise<void>
  openGenerationSession(draft: DraftView): void
  /**
   * 打开**当前这次生成**的会话（创建弹窗里的"打开生成会话"）。
   *
   * 与 `openGenerationSession(draft)` 分开，是因为创建失败时还没有 DraftView，
   * 只拿到了 `sessions.create` 返回的 id —— 不该为了调用它去伪造一份草稿。
   */
  openCreateGenerationSession(): void
  /** 校验并**把最新草稿交回调用方**（草稿横幅就地刷新预览）。 */
  validateDraft(draft: DraftView): Promise<ExpertValidateOutcome>
  /** 确认安装；版本冲突时回执里带 `refreshed`（调用方刷新预览，绝不自动再确认）。 */
  confirmDraft(draft: DraftView): Promise<ExpertConfirmOutcomeView>
  /** 草稿确认回执的专家分支（`useWorkbenchDrafts` 注入调用）。 */
  handleExpertConfirmed(expert: ExpertInstallResult | null): void
}

export interface UseWorkbenchExpertsResult {
  catalog: ExpertCatalogView
  catalogLoading: boolean
  catalogError: ExpertUiError | null
  /**
   * 选择器可用的角色（= 目录里 `usable` 的那些，客户端第二道闸门）。
   *
   * 单独给一份，是因为选择器**不该**自己去拉第二份目录（那正是"同一语义两份状态"）。
   */
  pickerPersonas: PersonaSummary[]
  create: {
    open: boolean
    request: string
    workspaceId: string
    busy: boolean
    error: ExpertUiError | null
    /** 失败后仍然可用的"打开生成会话"目标（没有就为 null）。 */
    generationSessionId: string | null
    generationDraftId: string | null
    /** 可选工作区快照（弹窗渲染用；匹配默认值仍在 `openCreate` 里做）。 */
    workspaceChoices: readonly WorkspaceChoice[]
    /** 宿主是否有 `sessions.create`（缺能力要**明说**，不静默降级）。 */
    available: boolean
  }
  autoSummon: { value: boolean; busy: boolean; error: ExpertUiError | null }
  /** 收藏/停用的即时反馈（PersonaAdmin 就地显示，与旧行为一致）。 */
  personaFlags: { busyId: string; notice: string; error: ExpertUiError | null }
  draftActions: {
    busy: boolean
    /** 最近一次草稿动作的稳定错误（校验/确认共用一格）。 */
    error: ExpertUiError | null
  }
  actions: UseWorkbenchExpertsActions
}

/**
 * 专家域 hook：装配 catalog / 生成弹窗 / 自主开关 / 草稿动作四块状态。
 *
 * 本 hook 是这些状态的**唯一所有者**（方案 §12.3）：`PersonaAdmin` 不再自持目录，
 * 装配层（`WorkbenchApp`）也不持有任何一项 —— 它只把结果与 actions 往下传。
 */
export function useWorkbenchExperts(input: UseWorkbenchExpertsInput): UseWorkbenchExpertsResult {
  const [catalog, setCatalog] = useState<ExpertCatalogView>(EMPTY_EXPERT_CATALOG)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<ExpertUiError | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createRequest, setCreateRequest] = useState('')
  const [createWorkspaceId, setCreateWorkspaceId] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<ExpertUiError | null>(null)
  const [generationSessionId, setGenerationSessionId] = useState<string | null>(null)
  const [generationDraftId, setGenerationDraftId] = useState<string | null>(null)
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftError, setDraftError] = useState<ExpertUiError | null>(null)
  /** 自主开关 / 目录重读 / 生成 runner 都要用"最新一次渲染的值"，用 ref 消掉闭包陈旧。 */
  const aliveRef = useRef(input.isAlive)
  aliveRef.current = input.isAlive
  const settingsRef = useRef(input.settings)
  settingsRef.current = input.settings
  const writeSettingsRef = useRef(input.writeSettings)
  writeSettingsRef.current = input.writeSettings
  const cwdRef = useRef(input.currentCwd)
  cwdRef.current = input.currentCwd
  const choicesRef = useRef(input.workspaceChoices)
  choicesRef.current = input.workspaceChoices
  const errorRef = useRef(input.onError)
  errorRef.current = input.onError
  const noticeRef = useRef(input.onNotice)
  noticeRef.current = input.onNotice
  const [autoTick, setAutoTick] = useState(0)

  const deps = useMemo<ExpertFlowDeps>(() => ({
    call: (path, init) => api(path, init),
    runtime: input.runtime,
    ctx: input.runtime,
    isAlive: () => aliveRef.current(),
  }), [input.runtime])
  const depsRef = useRef(deps)
  depsRef.current = deps
  const runnerRef = useRef<ExpertGenerationRunner | null>(null)
  if (runnerRef.current === null) {
    runnerRef.current = createExpertGenerationRunner({
      call: (path, init) => depsRef.current.call(path, init),
      runtime: depsRef.current.runtime,
      ctx: depsRef.current.ctx,
      isAlive: () => depsRef.current.isAlive(),
      onNotice: (message) => noticeRef.current(message),
    })
  }
  const storeRef = useRef<ExpertCatalogStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createExpertCatalogStore({
      call: (path, init) => depsRef.current.call(path, init),
      onLoaded: (view) => { setCatalog(view); setCatalogError(null) },
      onError: (error) => setCatalogError(error),
      onLoading: (loading) => setCatalogLoading(loading),
    })
  }
  const opsRef = useRef<ExpertDraftOps | null>(null)
  if (opsRef.current === null) {
    opsRef.current = createExpertDraftOps({
      call: (path, init) => depsRef.current.call(path, init),
      runtime: depsRef.current.runtime,
      ctx: depsRef.current.ctx,
      isAlive: () => depsRef.current.isAlive(),
    })
  }
  const autoRef = useRef<AutoSummonController | null>(null)
  if (autoRef.current === null) {
    autoRef.current = createAutoSummonController({
      readServerValue: () => settingsRef.current.autoSummonExperts,
      writeServerValue: (next) => writeSettingsRef.current({ autoSummonExperts: next }),
      save: async (next) => {
        await depsRef.current.call(SETTINGS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autoSummonExperts: next }),
        })
      },
    })
  }

  const loadCatalog = useCallback(async (): Promise<void> => {
    await storeRef.current?.load()
  }, [])

  // 首次挂载拉一次目录（唯一的"自动"读取；其余都由用户动作触发）。
  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  const openCreate = useCallback((): void => {
    setCreateError(null)
    const matched = matchWorkspaceForCwd(choicesRef.current(), cwdRef.current())
    setCreateWorkspaceId((prev) => (prev !== '' ? prev : (matched ?? '')))
    setCreateOpen(true)
  }, [])

  const startGeneration = useCallback(async (): Promise<void> => {
    const runner = runnerRef.current
    if (runner === null) return
    if (runner.busy) {
      setCreateError({ code: 'busy', message: '上一次生成还没结束，请稍等。' })
      return
    }
    setCreateBusy(true)
    setCreateError(null)
    try {
      const outcome = await runner.start({ request: createRequest, workspaceId: createWorkspaceId })
      if (!aliveRef.current()) return
      setGenerationSessionId(outcome.sessionId)
      setGenerationDraftId(outcome.draftId)
      if (outcome.ok === false) {
        setCreateError({ code: outcome.code ?? 'generation-start-failed', message: outcome.message ?? '生成失败。' })
        return
      }
      // 成功：关弹窗（草稿由草稿域按 5 秒轮询弹出来，不在这里自己弹）
      setCreateOpen(false)
      setCreateRequest('')
      errorRef.current(null)
      noticeRef.current('生成会话已经开跑，AI 完成后会以草稿形式找你确认。')
    } finally {
      if (aliveRef.current()) setCreateBusy(false)
    }
  }, [createRequest, createWorkspaceId])

  const openGenerationSession = useCallback((draft: DraftView): void => {
    const sessionId = draft.sessionId ?? generationSessionIdRef.current
    if (sessionId === null || sessionId === '') {
      errorRef.current('这份草稿没有关联生成会话，无法打开。')
      return
    }
    try {
      openSessionInMainView(depsRef.current.ctx, sessionId)
    } catch (cause) {
      errorRef.current(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  const generationSessionIdRef = useRef<string | null>(null)
  generationSessionIdRef.current = generationSessionId

  /** 创建弹窗的"打开生成会话"：只用这次 `sessions.create` 出来的 id（见接口注释）。 */
  const openCreateGenerationSession = useCallback((): void => {
    const sessionId = generationSessionIdRef.current
    if (sessionId === null || sessionId === '') {
      errorRef.current('还没有建出生成会话，无法打开。')
      return
    }
    try {
      openSessionInMainView(depsRef.current.ctx, sessionId)
    } catch (cause) {
      errorRef.current(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  /** 草稿动作的重入闸门（**用 ref 而不是 state**：state 在同一 tick 里还看不到，挡不住连点）。 */
  const draftBusyRef = useRef(false)

  /**
   * 校验：返回**完整回执**（草稿横幅要拿 `draft` 就地刷新预览，所以不能只写内部状态）。
   *
   * 刻意不做"要不要刷新"的猜测：`outcome.draft` 非空时界面直接换成服务端那一份。
   */
  const validateDraft = useCallback(async (draft: DraftView): Promise<ExpertValidateOutcome> => {
    if (draftBusyRef.current) {
      return { ok: false, code: 'busy', message: '上一次操作还没结束，请稍等。', draft: null, problems: [] }
    }
    draftBusyRef.current = true
    setDraftBusy(true)
    setDraftError(null)
    try {
      const outcome = await opsRef.current!.validate(draft)
      if (aliveRef.current()) {
        if (outcome.ok === false) {
          setDraftError({ code: outcome.code ?? 'validate-failed', message: outcome.message ?? '校验失败。' })
        } else if (outcome.problems.length > 0) {
          setDraftError({ code: 'draft-not-validated', message: `校验没通过：${outcome.problems.join('；')}` })
        } else {
          noticeRef.current('校验通过，可以确认安装了。')
        }
      }
      return outcome
    } finally {
      draftBusyRef.current = false
      if (aliveRef.current()) setDraftBusy(false)
    }
  }, [])

  /**
   * 确认安装：返回完整回执。
   *
   * ⚠️ 版本冲突（`code === 'version-conflict'`）时**只把最新草稿交出去让界面刷新**，
   * 绝不在这里替用户再确认一次（AX-E55）。
   */
  const confirmDraft = useCallback(async (draft: DraftView): Promise<ExpertConfirmOutcomeView> => {
    if (draftBusyRef.current) {
      return { ok: false, code: 'busy', message: '上一次操作还没结束，请稍等。', expert: null, replayed: false, refreshed: null, sent: null }
    }
    draftBusyRef.current = true
    setDraftBusy(true)
    setDraftError(null)
    try {
      const outcome = await opsRef.current!.confirm(draft)
      if (aliveRef.current() && outcome.ok === false) {
        setDraftError({ code: outcome.code ?? 'confirm-failed', message: outcome.message ?? '安装失败。' })
      }
      return outcome
    } finally {
      draftBusyRef.current = false
      if (aliveRef.current()) setDraftBusy(false)
    }
  }, [])

  const handleExpertConfirmed = useCallback((expert: ExpertInstallResult | null): void => {
    void refreshExpertCatalogAfterInstall({
      refresh: () => storeRef.current?.load() ?? Promise.resolve(null),
      onNotice: (message) => noticeRef.current(message),
      expert,
    })
  }, [])

  const [flagBusyId, setFlagBusyId] = useState('')
  const [flagNotice, setFlagNotice] = useState('')
  const [flagError, setFlagError] = useState<ExpertUiError | null>(null)
  const catalogRef = useRef(catalog)
  catalogRef.current = catalog

  /**
   * 收藏 / 停用：**立即保存**（沿用 PersonaAdmin 既有口径，方案 §9.3）。
   *
   * 三步都不许省：①现读服务端现值 → ②`personaFlagPatch`（与选择器同一处口径）POST 回去
   * → ③**重读目录**把服务端事实显示出来。提示文案用服务端**回写后**的值，不本地推断。
   */
  const writePersonaFlag = useCallback(async (id: string, action: 'toggle-favorite' | 'toggle-disabled'): Promise<void> => {
    const name = catalogRef.current.experts.find((row) => row.id === id)?.name ?? id
    setFlagBusyId(id)
    setFlagNotice('')
    setFlagError(null)
    try {
      const current = await api<{ settings?: { personaFavorites?: string[]; personaDisabledIds?: string[] } }>(SETTINGS_PATH)
      const patch = personaFlagPatch({
        personaFavorites: current?.settings?.personaFavorites ?? [],
        personaDisabledIds: current?.settings?.personaDisabledIds ?? [],
      }, action, id)
      const res = await api<{ settings?: { personaFavorites?: string[]; personaDisabledIds?: string[] } }>(SETTINGS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!aliveRef.current()) return
      writeSettingsRef.current({
        personaFavorites: res?.settings?.personaFavorites ?? [],
        personaDisabledIds: res?.settings?.personaDisabledIds ?? [],
      })
      const nowFavorite = (res?.settings?.personaFavorites ?? []).includes(id)
      const nowDisabled = (res?.settings?.personaDisabledIds ?? []).includes(id)
      setFlagNotice(action === 'toggle-favorite'
        ? `${nowFavorite ? '已收藏' : '已取消收藏'}「${name}」`
        : `${nowDisabled ? '已停用' : '已启用'}「${name}」`)
      await loadCatalog()
    } catch (cause) {
      if (!aliveRef.current()) return
      const message = `保存角色标记失败：${errorText(cause)}`
      setFlagError({ code: 'flag-save-failed', message })
      errorRef.current(message)
    } finally {
      if (aliveRef.current()) setFlagBusyId('')
    }
  }, [loadCatalog])

  const toggleFavorite = useCallback(async (id: string): Promise<void> => {
    await writePersonaFlag(id, 'toggle-favorite')
  }, [writePersonaFlag])
  const toggleDisabled = useCallback(async (id: string): Promise<void> => {
    await writePersonaFlag(id, 'toggle-disabled')
  }, [writePersonaFlag])

  const setAutoEnabled = useCallback(async (value: boolean): Promise<void> => {
    const controller = autoRef.current
    if (controller === null) return
    setAutoTick((tick) => tick + 1)
    const ok = await controller.set(value)
    if (aliveRef.current()) setAutoTick((tick) => tick + 1)
    if (ok === false && aliveRef.current()) {
      const error = controller.error()
      if (error !== null) errorRef.current(error.message)
    }
  }, [])

  // autoTick 只是"让 controller 的 getter 重算"的触发器；值本身仍在控制器里。
  void autoTick
  const autoController = autoRef.current

  return {
    catalog,
    catalogLoading,
    catalogError,
    pickerPersonas: expertPickerPersonas(catalog),
    create: {
      open: createOpen,
      request: createRequest,
      workspaceId: createWorkspaceId,
      busy: createBusy,
      error: createError,
      generationSessionId,
      generationDraftId,
      workspaceChoices: input.workspaceChoices(),
      available: hasSessionCreate(input.runtime),
    },
    autoSummon: {
      value: autoController.value(),
      busy: autoController.busy(),
      error: autoController.error(),
    },
    personaFlags: { busyId: flagBusyId, notice: flagNotice, error: flagError },
    draftActions: { busy: draftBusy, error: draftError },
    actions: {
      openCreate,
      closeCreate: () => { setCreateOpen(false); setCreateError(null) },
      setCreateRequest: (text: string) => { setCreateRequest(text) },
      setCreateWorkspace: (id: string) => { setCreateWorkspaceId(id) },
      startGeneration,
      refreshCatalog: loadCatalog,
      setAutoEnabled,
      toggleFavorite,
      toggleDisabled,
      openGenerationSession,
      openCreateGenerationSession,
      validateDraft,
      confirmDraft,
      handleExpertConfirmed,
    },
  }
}
