/**
 * `@` 专家引用源（方案 v0.3 §8.3）：**注册一个独立的 `@` source**，不复用、不覆盖内置文件/会话引用。
 *
 * ## 与内置 `@` 文件引用的关系（AX-E45）
 *
 * 内置的文件路径引用是**另一个 source**：本模块只声明 `trigger='@'` + `name='workbench-expert'`，
 * 不实现 `matchSpace` / `matchEnter`（那两个钩子才是"抢文件路径快捷仲裁"的入口），
 * 也不读 `document`。于是"两个独立 source 并存"是结构上的事实，不是靠约定。
 *
 * ## 同步 onPick + 异步 codec（§8.3 硬要求）
 *
 * - `onPick` **必须同步**：它只把 `pick.session.sessionId` 与候选身份组成版本化 JSON ref，
 *   立刻返回 `{insert}`。绝不能在这里 `await` HTTP —— 那会让菜单选中卡在一次网络往返上，
 *   而"选中"这个动作本身不需要服务端参与。
 * - `codec.serialize` **才是**异步的那一步：严格解析 ref → 建手动 request → 输出短指令。
 *   失败**抛可读错误**（调用方据此阻止本次发送），**绝不回落到普通 `@` 文本** ——
 *   静默降级会让用户以为"专家已经被叫来了"，实际只是发了一条普通消息。
 *
 * ## 身份只认 ref 里的 sessionId（§8.3 末段）
 *
 * 复制到另一个会话的旧 ref 不能在那里执行：`serialize` 用 **ref 自带的 sessionId** 建请求，
 * 执行时由服务端比对真实执行会话并回 `manual-request-session-mismatch`。
 * 这里**绝不**读"全局当前会话"替换 ref 身份 —— 那正是"跨会话复制悄悄生效"的来源。
 *
 * ## 纯逻辑（可被 `node --test` 直接驱动）
 *
 * 不 import React、不碰 DOM、不读 `document`；所有宿主访问（catalog / preflight /
 * manual-requests）都是注入的四个函数。注册外壳 `createExpertInputTriggerRegistrar`
 * 也只依赖一个 7 行形状的 host，便于在测试里连"热重载只有一份注册"一起钉住（AX-E51）。
 */
import { api } from './api.js'
import { optionalService } from './runtimeServices.js'
import { buildExpertInvocationPrompt, EXPERT_REQUEST_ID_MAX_CHARS } from '../shared/expertPrompt.js'

/** `ReferenceInsert.source`：本源的稳定名字（也是 `InputTriggerSource.name`）。 */
export const EXPERT_REFERENCE_SOURCE = 'workbench-expert'
/** 菜单里的分组标题（§8.3：order=20、独立 source）。 */
export const EXPERT_TRIGGER_NAME = 'workbench-expert'
export const EXPERT_TRIGGER_ORDER = 20
/** 候选名前缀（§8.3：`'expert:' + personaId`）。 */
export const EXPERT_CANDIDATE_PREFIX = 'expert:'
/** ref 的版本号（形状变了才 +1；解码端对不上版本一律拒绝）。 */
export const EXPERT_REF_VERSION = 1
/** 会话 / 角色 id / 来源键 / revision 的长度上限（与服务端同一口径：只防"超长值到处流"）。 */
const MAX_ID_CHARS = 512

/** `serialize` 用的两个 HTTP 端点（服务端 §4.1 的既有前缀 + P7 新增的一条）。 */
export const EXPERTS_CATALOG_PATH = '/api/workbench/experts/catalog'
export const EXPERTS_PREFLIGHT_PATH = '/api/workbench/experts/preflight'
export const EXPERTS_MANUAL_REQUESTS_PATH = '/api/workbench/experts/manual-requests'

// ---------------------------------------------------------------------------
// ref 编解码（纯）
// ---------------------------------------------------------------------------

/** ref 的**严格**形状：版本化 JSON。 */
export interface ExpertRef {
  version: number
  sessionId: string
  personaId: string
  sourceKey: string
  revision: string
}

export interface ExpertRefParts {
  sessionId: unknown
  personaId: unknown
  sourceKey?: unknown
  revision?: unknown
}

function requireRefText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > MAX_ID_CHARS) {
    throw new Error(`专家引用缺少 ${field}（或超长）：拒绝生成引用`)
  }
  return value.trim()
}

/**
 * 编成版本化 JSON（严格、稳定字段序）。
 *
 * @param parts - 会话 / 角色 / 来源身份。
 * @returns `JSON.stringify({version:1,...})`。
 * @throws Error 任一字段缺失或超长（**不静默补空**）。
 */
export function encodeExpertRef(parts: ExpertRefParts): string {
  return JSON.stringify({
    version: EXPERT_REF_VERSION,
    sessionId: requireRefText(parts?.sessionId, 'sessionId'),
    personaId: requireRefText(parts?.personaId, 'personaId'),
    sourceKey: requireRefText(parts?.sourceKey, 'sourceKey'),
    revision: requireRefText(parts?.revision, 'revision'),
  })
}

/**
 * 解出 ref；**坏形状 / 坏版本 / 非 JSON 一律拒绝**。
 *
 * 返回 `undefined` 而不是抛错：调用方（`clipboardText` / 粘贴、`serialize` 的预检）
 * 大多只想"能不能用"这一个答案，让 UI 路径不必为每个坏 ref 包一层 try。
 * 真正需要"可读原因"的 `serialize` 自己再抛一句中文。
 *
 * @param raw - 来源不可信的字符串（可能被用户手改过）。
 * @returns 解析结果，或 `undefined`。
 */
export function decodeExpertRef(raw: string): ExpertRef | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '' || text.length > 8192) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record.version !== EXPERT_REF_VERSION) return undefined
  const fields: Array<keyof ExpertRef> = ['sessionId', 'personaId', 'sourceKey', 'revision']
  const out: Partial<Record<keyof ExpertRef, string>> = {}
  for (const field of fields) {
    const value = record[field]
    if (typeof value !== 'string' || value.trim() === '' || value.trim().length > MAX_ID_CHARS) return undefined
    out[field] = value.trim()
  }
  return {
    version: EXPERT_REF_VERSION,
    sessionId: out.sessionId as string,
    personaId: out.personaId as string,
    sourceKey: out.sourceKey as string,
    revision: out.revision as string,
  }
}

/** 人可读的剪贴板文本（§8.3：`@expert:<personaId>`）。 */
export function expertClipboardText(ref: string): string {
  const decoded = decodeExpertRef(ref)
  if (decoded === undefined) throw new Error('专家引用已损坏（无法解析）：请重新从 @ 菜单选择专家')
  return `@expert:${decoded.personaId}`
}

// ---------------------------------------------------------------------------
// 候选（纯）
// ---------------------------------------------------------------------------

/** `GET /experts/catalog` 里我们真正用到的两块（宿主响应更宽，这里只声明需求）。 */
export interface ExpertPersonaSummaryLike {
  id: string
  name: string
  description?: string
  sourceKey: string
  revision?: string
}
export interface ExpertCatalogLike {
  personas?: ExpertPersonaSummaryLike[]
}

/** 菜单候选：名字 / 显示名 / 简介 / 不透明 value。 */
export interface ExpertCandidateView {
  name: string
  label: string
  description: string
  value: string
}

/**
 * catalog 摘要 → 菜单候选（纯函数）。
 *
 * `value` 放**严格 JSON** 的 personaId/sourceKey/revision（§8.3）。注意
 * `revision` 在 catalog 的 `PersonaSummary` 里是**可选**的（HTTP 摘要可能不带），
 * 它只用于"选中那一刻的展示身份"；**建请求用的 sourceKey/revision 一定重新 preflight**
 * （P6 交接 §9-2：拿目录里的值建请求，运行前必然 `revision-changed`）。
 */
export function expertCandidatesFromCatalog(catalog: ExpertCatalogLike | undefined): ExpertCandidateView[] {
  const personas = Array.isArray(catalog?.personas) ? catalog.personas : []
  const out: ExpertCandidateView[] = []
  for (const persona of personas) {
    if (typeof persona?.id !== 'string' || persona.id.trim() === '') continue
    const personaId = persona.id.trim()
    if (typeof persona.sourceKey !== 'string' || persona.sourceKey.trim() === '') continue
    const label = typeof persona.name === 'string' && persona.name.trim() !== '' ? persona.name.trim() : personaId
    out.push({
      name: `${EXPERT_CANDIDATE_PREFIX}${personaId}`,
      label,
      description: typeof persona.description === 'string' ? persona.description : '',
      value: JSON.stringify({
        personaId,
        sourceKey: persona.sourceKey.trim(),
        revision: typeof persona.revision === 'string' ? persona.revision.trim() : '',
      }),
    })
  }
  return out
}

/** 菜单查询过滤：空查询返回全部（顺序 = catalog 顺序，不在客户端重排）。 */
export function filterExpertCandidates(candidates: readonly ExpertCandidateView[], query: unknown): ExpertCandidateView[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle === '') return [...candidates]
  return candidates.filter((candidate) => (
    candidate.name.toLowerCase().includes(needle)
    || candidate.label.toLowerCase().includes(needle)
    || candidate.description.toLowerCase().includes(needle)
  ))
}

/** 从候选的 `value` 里取 personaId（坏值 → 抛错，不猜）。 */
export function expertCandidatePersonaId(candidate: { name?: unknown; value?: unknown }): string {
  const raw = typeof candidate?.value === 'string' ? candidate.value : ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('专家候选数据已损坏（value 不是 JSON）：请重新打开 @ 菜单')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('专家候选数据已损坏（value 形状不对）：请重新打开 @ 菜单')
  }
  const personaId = (parsed as { personaId?: unknown }).personaId
  if (typeof personaId !== 'string' || personaId.trim() === '') {
    throw new Error('专家候选数据已损坏（缺 personaId）：请重新打开 @ 菜单')
  }
  return personaId.trim()
}

// ---------------------------------------------------------------------------
// 源工厂（依赖注入，可测）
// ---------------------------------------------------------------------------

/** `POST /experts/preflight` 的请求体。 */
export interface ExpertPreflightRequest { personaId: string; sessionId: string }
/** `POST /experts/preflight` 的响应里我们真正用到的部分（`summary` 是 P6 交接 §9-2 指定的唯一取处）。 */
export interface ExpertPreflightResponseLike {
  ok?: boolean
  usable?: boolean
  summary?: { sourceKey?: string; revision?: string } | null
}
/** `POST /experts/manual-requests` 的请求体。 */
export interface ExpertManualRequestInput {
  sessionId: string
  personaId: string
  expectedSourceKey: string
  expectedRevision: string
}
/** `POST /experts/manual-requests` 的响应。 */
export interface ExpertManualRequestResponseLike {
  ok?: boolean
  requestId?: string
  expiresAt?: string
}

/**
 * 四个宿主访问点 —— 全部注入，测试拿假实现即可覆盖全部失败分支。
 *
 * `signal` 一路透传给 `fetch`：用户取消 / 菜单关闭后**不能**再建出一条 request
 * （建了也没人执行，只会在请求表里留一条垃圾）。
 */
export interface ExpertInputSourceDeps {
  getCatalog(signal?: AbortSignal): Promise<ExpertCatalogLike>
  getPreflight(input: ExpertPreflightRequest, signal?: AbortSignal): Promise<ExpertPreflightResponseLike>
  postManualRequest(input: ExpertManualRequestInput, signal?: AbortSignal): Promise<ExpertManualRequestResponseLike>
  /** 可选的日志口（源缺失 / 发送被阻止时留一条可观测记录）；缺省不打。 */
  warn?(message: string): void
}

/** 宿主注入触发器的**最小形状**（照 `capabilities.ts` 的 `SlotsProbe` 风格，不 import 宿主包）。 */
export interface InputTriggerServiceProbe {
  readonly registerSource?: (source: unknown) => (() => void) | undefined
}

/** `createExpertInputSource` 的返回：`InputTriggerSource` 的结构子集（宿主类型是逐字这一套）。 */
export interface ExpertInputSourceView {
  readonly trigger: '@'
  readonly name: typeof EXPERT_TRIGGER_NAME
  readonly order: typeof EXPERT_TRIGGER_ORDER
  candidates(session: { sessionId?: unknown }, req: { query?: unknown; signal?: AbortSignal }): Promise<ExpertCandidateView[]>
  onPick(pick: {
    candidate?: { name?: unknown; label?: unknown; value?: unknown }
    session?: { sessionId?: unknown }
  }): unknown
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal?: AbortSignal): Promise<string>
  }
}

function requireSessionId(session: { sessionId?: unknown } | undefined, what: string): string {
  const id = session?.sessionId
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`拿不到${what}的会话身份：请重新打开对话后再试`)
  }
  return id.trim()
}

/**
 * 造一个 `@` 专家引用源。
 *
 * @param deps - 四个宿主访问点（+ 可选 warn）。
 * @returns `InputTriggerSource` 的结构子集；`codec` 一定在（本源只产 insert 结果）。
 */
export function createExpertInputSource(deps: ExpertInputSourceDeps): ExpertInputSourceView {
  if (deps === undefined || deps === null || typeof deps.getCatalog !== 'function'
    || typeof deps.getPreflight !== 'function' || typeof deps.postManualRequest !== 'function') {
    throw new Error('创建专家 @ 引用源失败：缺少 catalog / preflight / manual-requests 访问点')
  }
  return {
    trigger: '@',
    name: EXPERT_TRIGGER_NAME,
    order: EXPERT_TRIGGER_ORDER,

    async candidates(session, req) {
      /**
       * `session.sessionId` 在这里只用来**尽早失败**（拿不到会话就不必发请求）；
       * 它**不被缓存**，也不参与 ref（ref 用的是 pick 那一刻的会话投影，§8.3）。
       */
      requireSessionId(session, ' @ 候选')
      const catalog = await deps.getCatalog(req?.signal)
      return filterExpertCandidates(expertCandidatesFromCatalog(catalog), req?.query)
    },

    /**
     * **同步**返回 insert（§8.3）：这里一个 `await` 都不能有 —— 菜单选中卡在网络往返上，
     * 用户看到的是"点了没反应"。真正的网络动作在 `codec.serialize`。
     */
    onPick(pick) {
      const sessionId = requireSessionId(pick?.session, '专家引用')
      const personaId = expertCandidatePersonaId(pick?.candidate ?? {})
      const value = JSON.parse(String(pick?.candidate?.value)) as { sourceKey?: unknown; revision?: unknown }
      const ref = encodeExpertRef({
        sessionId,
        personaId,
        sourceKey: value.sourceKey,
        revision: value.revision,
      })
      const label = typeof pick?.candidate?.label === 'string' && pick.candidate.label.trim() !== ''
        ? pick.candidate.label.trim()
        : personaId
      return {
        insert: {
          source: EXPERT_REFERENCE_SOURCE,
          ref,
          label,
          appearance: 'session' as const,
          clipboardText: `@expert:${personaId}`,
        },
      }
    },

    codec: {
      clipboardText: expertClipboardText,

      /**
       * 提交路径：严格解析 ref → 重新 preflight 拿**当前** sourceKey/revision →
       * 建手动 request → 输出短指令。
       *
       * 三个"为什么"：
       * 1. **重新 preflight**（P6 交接 §9-2）：目录/候选里那份身份是"菜单打开那一刻"的，
       *    而用户可能几分钟后才按发送；拿陈旧值建请求，服务端当场 `revision-changed`（400）。
       * 2. **用 ref 的 sessionId**（§8.3 末段）：跨会话复制来的 ref 必须失败，
       *    不能"顺手替换成当前会话"。
       * 3. **失败抛可读错误**：返回值就是模型要看到的文本，没有别的通道告诉调用方"失败了"。
       *    抛出 = 阻止发送（宿主的行为），静默降级成普通文本 = 谎报成功。
       */
      async serialize(ref, signal) {
        const decoded = decodeExpertRef(ref)
        if (decoded === undefined) {
          throw new Error('专家引用已损坏或版本不符：本次不发送，请重新从 @ 菜单选择专家')
        }
        if (signal?.aborted === true) throw new Error('已取消：没有为这次专家引用创建调用请求')
        const preflight = await deps.getPreflight(
          { personaId: decoded.personaId, sessionId: decoded.sessionId },
          signal,
        )
        const summary = preflight?.summary
        const sourceKey = typeof summary?.sourceKey === 'string' ? summary.sourceKey.trim() : ''
        const revision = typeof summary?.revision === 'string' ? summary.revision.trim() : ''
        if (sourceKey === '' || revision === '') {
          throw new Error(`专家「${decoded.personaId}」当前不可用（已不在角色库里或身份读不到）：请重新选择专家`)
        }
        const created = await deps.postManualRequest(
          {
            sessionId: decoded.sessionId,
            personaId: decoded.personaId,
            expectedSourceKey: sourceKey,
            expectedRevision: revision,
          },
          signal,
        )
        const requestId = typeof created?.requestId === 'string' ? created.requestId.trim() : ''
        if (requestId === '' || requestId.length > EXPERT_REQUEST_ID_MAX_CHARS) {
          throw new Error('服务端没有返回可用的专家调用请求 id：本次不发送')
        }
        return buildExpertInvocationPrompt({ requestId, task: '' })
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 运行时依赖装配（唯一把 api() 接到源上的地方）
// ---------------------------------------------------------------------------

/** `api()` 的注入形状（测试替身只需实现它）。 */
export type ExpertApiCall = <T>(path: string, init?: RequestInit) => Promise<T>

function withSignal(init: RequestInit | undefined, signal: AbortSignal | undefined): RequestInit | undefined {
  if (signal === undefined) return init
  return { ...(init ?? {}), signal }
}

/**
 * 生产装配：把 `client/api.ts` 的 `api()` 接到源的四个访问点上。
 *
 * @param call - 缺省用真实的 `api`（带瞬时故障重试）；测试注入替身。
 */
export function createExpertInputSourceFromApi(call: ExpertApiCall = api): ExpertInputSourceView {
  return createExpertInputSource({
    getCatalog: (signal) => call<ExpertCatalogLike>(EXPERTS_CATALOG_PATH, withSignal(undefined, signal)),
    getPreflight: (input, signal) => call<ExpertPreflightResponseLike>(EXPERTS_PREFLIGHT_PATH, withSignal({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }, signal)),
    postManualRequest: (input, signal) => call<ExpertManualRequestResponseLike>(EXPERTS_MANUAL_REQUESTS_PATH, withSignal({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }, signal)),
    warn: (message) => { console.warn?.(`[workbench] ${message}`) },
  })
}

// ---------------------------------------------------------------------------
// 注册外壳（子 fiber 软注入用；纯逻辑，可在假 host 上直接跑，AX-E51）
// ---------------------------------------------------------------------------

/** 注册用的最小 host 形状：只声明 `optionalService` 与 `logger?.warn`（都是软访问）。 */
export interface ExpertTriggerHostProbe {
  readonly optionalService?: (name: string) => unknown
  readonly logger?: { readonly warn?: (message: string) => void }
}

/** `createExpertInputTriggerRegistrar` 的入参。 */
export interface ExpertInputTriggerRegistrarOptions {
  /** `ctx.optionalService('inputTriggers')`；缺省走注入的 `host.optionalService`。 */
  readonly service?: InputTriggerServiceProbe
  /** 源工厂：缺省用真实 `api()` 的那份。 */
  readonly createSource?: () => ExpertInputSourceView
}

export interface ExpertInputTriggerRegistrar {
  /** 注册（幂等：重复调用只是替换自己那一份，绝不叠加）。已 `dispose()` 后是 no-op。 */
  register(): void
  /** 当前是否真的注册着一份（诊断 / 断言用：热重载后必须恒为 `true` 或恒为 `false`，不许叠加）。 */
  isRegistered(): boolean
  /** 注销（幂等）。子 fiber 清理时调用；此后任何状态变化都会拒绝。 */
  dispose(): void
}

/**
 * 注册专家 `@` 源（**唯一实现**）。
 *
 * 三条硬要求都落在这里：
 * 1. **热重载只有一份**：重复 `register()` 先 `release()` 上一份，而不是再注册一份
 *    （宿主对 `(trigger,name)` 重复注册是**抛错**的，第二份会让整个源失效）；
 * 2. **卸载后不再写入失效上下文**：`dispose()` 置 `disposed`，之后 `register()` 是 no-op，
 *    清理期间抛出的错只记日志、不冒泡（卸载阶段炸在用户控制台是最没用的噪音）；
 * 3. **缺能力如实降级**：拿不到 `inputTriggers` 就打一条可读日志、**不抛** ——
 *    `/expert` 命令与其它功能照常可用（AX-E46 的"降级可用"）。
 */
export function createExpertInputTriggerRegistrar(
  host: ExpertTriggerHostProbe,
  options: ExpertInputTriggerRegistrarOptions = {},
): ExpertInputTriggerRegistrar {
  const warn = (message: string): void => {
    try { host?.logger?.warn?.(`[workbench] ${message}`) } catch { /* 日志口自己坏了不影响主流程 */ }
  }
  let unregister: (() => void) | undefined
  let disposed = false

  const release = (): void => {
    const current = unregister
    unregister = undefined
    if (current === undefined) return
    try { current() } catch (error) {
      warn(`注销专家 @ 引用源失败（忽略）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    isRegistered(): boolean { return unregister !== undefined },

    register(): void {
      if (disposed) return
      release()
      const service = options.service
        ?? (typeof host?.optionalService === 'function'
          ? host.optionalService('inputTriggers') as InputTriggerServiceProbe | undefined
          : undefined)
      const registerSource = service?.registerSource
      if (typeof registerSource !== 'function') {
        warn('宿主没有提供 inputTriggers 服务：专家 @ 引用未注册（/expert 命令与其它功能照常可用）。')
        return
      }
      try {
        const disposer = registerSource.call(service, (options.createSource ?? createExpertInputSourceFromApi)())
        if (typeof disposer === 'function') unregister = disposer
        else unregister = () => {}
      } catch (error) {
        warn(`注册专家 @ 引用源失败（插件继续加载）：${error instanceof Error ? error.message : String(error)}`)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      release()
    },
  }
}

/**
 * 入口用的**一行装配**：走宿主子 fiber 软注入，注册专家 `@` 源，并返回一个幂等清理函数。
 *
 * 为什么要有这个函数（而不是让 `src/client/index.tsx` 自己写这段）：
 * `index.tsx` 是本仓最大的文件，红线是"**不许再涨**"；而且"子 fiber + 清理时要注销"
 * 这套时序写在入口里就**只能靠源码扫描**证明。把它收进本模块之后：
 * - 入口只剩 `const disposeExpertInput = installExpertInputSource(ctx)` 一行；
 * - 时序（注册一次、清理一次、重复 apply 不叠加）可以用假 ctx **直接测**。
 *
 * 三条边界与 `createExpertInputTriggerRegistrar` 完全一致，另外：
 * - `ctx.inject` 本身**不存在**（老版本宿主）⇒ 只打一条可读日志并返回 no-op；
 * - `inject` 调用抛错 ⇒ 同样只记日志：`@` 源是**可选增强**，绝不能拖垮面板加载。
 *
 * @param ctx - 客户端插件上下文（只用到 `inject`）。
 * @param createRegistrar - 测试替身注入点（缺省就是真实注册器）。
 * @returns 清理函数（幂等；卸载阶段不再触碰失效上下文）。
 */
export function installExpertInputSource(
  ctx: unknown,
  createRegistrar: (childCtx: unknown) => ExpertInputTriggerRegistrar = (childCtx) => createExpertInputTriggerRegistrar({
    optionalService: (name: string) => optionalService(childCtx, name),
    logger: { warn: (message: string) => { console.warn(message) } },
  }),
): () => void {
  let registrar: ExpertInputTriggerRegistrar | undefined
  const injector = (ctx as { inject?: (names: readonly string[], callback: (childCtx: unknown) => unknown) => unknown } | undefined)?.inject
  if (typeof injector !== 'function') {
    console.warn('[workbench] 宿主没有 ctx.inject：专家 @ 引用源未注册（/expert 与其它功能照常可用）。')
    return () => {}
  }
  try {
    /**
     * `ctx.inject` 的**返回值是子 fiber 的清理函数**（cordis 语义），由宿主/协调器负责调用；
     * 这里刻意不把它存起来重复调用 —— 第二次清理跑在"上下文已失效"之后，正是 AX-E51 要避免的。
     */
    injector.call(ctx, ['inputTriggers'], (childCtx: unknown) => {
      registrar = createRegistrar(childCtx)
      registrar.register()
      /**
       * 子 fiber 被宿主单独清理时（热重载 / 插件卸载）要能**只由自己**摘掉那一份注册。
       * 这里返回的是**幂等**清理：先置空再 dispose，重复调用与"外面已经 dispose 过"都无害。
       * `test/expertInputSource.test.mjs` 会把这份返回值抓出来、连调两次，证明它自成一体。
       */
      return () => {
        const owned = registrar
        registrar = undefined
        owned?.dispose()
      }
    })
  } catch (error) {
    console.warn(`[workbench] 注册专家 @ 引用源失败（面板照常可用）：${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
  return () => {
    /** 子 fiber 归宿主管：这里只保证**自己那份**注册被摘掉（重复调用是 no-op）。 */
    registrar?.dispose()
    registrar = undefined
  }
}
