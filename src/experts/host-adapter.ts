/**
 * 专家域 → 宿主能力的**结构化适配层**（skills 服务 + scope 解析）。
 *
 * ## 为什么单独一层（而不是各处 `ctx.get('skills')`）
 *
 * 三件事必须只有一处实现，否则必然漂移：
 *
 * 1. **软探测**：宿主可能根本没装 `@deepseek-ai/dsh-skill`（用户只装工作台），
 *    这时插件必须照常加载、人格生成照常跑，只是 `required` 技能**不得判为可用**（§10）。
 *    任何静态 `inject('skills')` 都会让"没装 skill 服务的机器"整个插件起不来；
 * 2. **投影**：把注册表的原始条目（第三方 provider 可能返回缺字段/类型不对的东西）
 *    归一化成我们敢用的形状，并保留 `provider/source/rank/locator` 供 catalog/preflight 判
 *    "真正生效的是谁"（§7.3）；
 * 3. **scope**：`skills.list` **不会**按 Agent 的 scope 自动筛选，调用方必须显式把
 *    `scopeOf(agent.ctx)` 传进去。`@deepseek-ai/dsh-scope` 是**可选** peer，
 *    生产代码里绝不能在顶层 import —— 拿不到就明确"scope 不可用"，而不是假装全局视角等于
 *    Agent 视角。
 */
import { EXPERT_PROVIDER_CODE, type ExpertErrorCode, type ExpertIssue } from '../shared/expert.js'
import type { WorkbenchSkillRegistry, WorkbenchSkillRegistryEntry } from './skill-package.js'
import type { SkillResourceBaseLike, SkillViewOptionsLike, SkillsServiceLike } from './skill-provider.js'

// ---------------------------------------------------------------------------
// 软探测
// ---------------------------------------------------------------------------

/**
 * 从 DSH 上下文软探测 skills 注册表服务（**唯一**允许的探测方式）。
 *
 * 判定门槛刻意压到最低：只要有 `list` 就当作"服务在"。`get` 是可选能力 —— 拿不到正文
 * 不影响 catalog 判"哪个 provider 生效 / 是否 modelInvocable"，而把门槛抬到"必须两个方法都在"
 * 会让一个能用的服务被误判成不可用（那才是更坏的错误）。
 */
export function probeExpertSkills(ctx: unknown): SkillsServiceLike | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const get = (ctx as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  let service: unknown
  try {
    service = (get as (name: string) => unknown).call(ctx, 'skills')
  } catch {
    return undefined
  }
  if (typeof service !== 'object' || service === null) return undefined
  const candidate = service as { list?: unknown }
  if (typeof candidate.list !== 'function') return undefined
  const withGet = service as { get?: unknown }
  if (withGet.get !== undefined && typeof withGet.get !== 'function') return undefined
  return service as SkillsServiceLike
}

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

/** `@deepseek-ai/dsh-scope` 里我们用到的那个函数。 */
export interface ScopeHelper {
  scopeOf(ctx: unknown): unknown
}

export type ScopeHelperLoadResult =
  | { ok: true; helper: ScopeHelper }
  | { ok: false; problem: ExpertIssue }

/** 动态 import 的注入点（**只给测试**用来演"没装这个模块"；生产调用不传）。 */
export type ScopeImporter = (specifier: string) => Promise<unknown>

/**
 * 运行时加载 scope helper。
 *
 * **只在这里**出现 `import('@deepseek-ai/dsh-scope')`：它是 optional peer，顶层静态 import
 * 会让"没装 dsh-scope 的机器"在加载插件时就炸。缺模块/缺 `scopeOf` 一律返回
 * `skill-scope-unavailable`，由调用方决定怎么降级。
 */
export async function loadScopeHelper(importer: ScopeImporter = defaultScopeImporter): Promise<ScopeHelperLoadResult> {
  let module: unknown
  try {
    module = await importer('@deepseek-ai/dsh-scope')
  } catch (error) {
    return {
      ok: false,
      problem: {
        code: 'skill-scope-unavailable',
        field: 'scopeOf',
        message: `拿不到 @deepseek-ai/dsh-scope（optional peer 未安装或加载失败）：${(error as Error).message}；本次按"scope 不可用"处理，不假装全局视角等于 Agent 视角`,
      },
    }
  }
  if (typeof module !== 'object' || module === null) {
    return {
      ok: false,
      problem: { code: 'skill-scope-unavailable', field: 'scopeOf', message: '@deepseek-ai/dsh-scope 的模块形状不对（不是对象）' },
    }
  }
  const scopeOf = (module as { scopeOf?: unknown }).scopeOf
  if (typeof scopeOf !== 'function') {
    return {
      ok: false,
      problem: {
        code: 'skill-scope-unavailable',
        field: 'scopeOf',
        message: '@deepseek-ai/dsh-scope 没有导出的 scopeOf 函数；本版不猜别的 API',
      },
    }
  }
  return { ok: true, helper: { scopeOf: (ctx: unknown) => (scopeOf as (value: unknown) => unknown)(ctx) } }
}

function defaultScopeImporter(specifier: string): Promise<unknown> {
  return import(specifier)
}

/** 解析结果：`scope` 是 `scopeOf()` 的**原始返回值**（`undefined` 也可能是合法结果）。 */
export interface ScopeResolution {
  scope: unknown
  /** 是否真的调用过 `scopeOf`（`false` = 没 ctx / 没 helper）。 */
  evaluated: boolean
  /** 是否拿到了真实的 scope 层（`evaluated && scope !== undefined`）。 */
  resolved: boolean
  problem?: ExpertIssue
}

/** 从 live agent 上取 ctx（容忍缺字段：HTTP 侧没有 agent 是常态）。 */
export function readLiveAgentContext(agent: unknown): unknown | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const ctx = (agent as { ctx?: unknown }).ctx
  if (typeof ctx !== 'object' || ctx === null) return undefined
  return ctx
}

/** 从 live agent 上取 cwd（`agent.session.header.cwd`）；拿不到返回 `undefined`。 */
export function readLiveAgentCwd(agent: unknown): string | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const session = (agent as { session?: unknown }).session
  if (typeof session !== 'object' || session === null) return undefined
  const header = (session as { header?: unknown }).header
  if (typeof header !== 'object' || header === null) return undefined
  const cwd = (header as { cwd?: unknown }).cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * 解析 live agent 的 scope 层。
 *
 * 语义分三种，调用方据此决定"这次是权威判定还是 preliminary"：
 * - agent 没有 ctx（HTTP 无 live agent）→ `{evaluated:false, resolved:false}`，**无 problem**
 *   （这不是错误，是"这次没法看 scope"，调用方按 preliminary 处理）；
 * - 有 ctx、helper 可用 → 真调 `scopeOf(ctx)`；`scope === undefined` 表示该 ctx 本来就没有
 *   scope 标签（host 级），仍然是权威结果；
 * - 有 ctx、helper 拿不到 → `problem = skill-scope-unavailable`（**不能**退回全局视角假装权威）。
 *
 * @param importer 只给测试注入"模块加载失败"（生产调用不传，走真实动态 import）。
 */
export async function resolveLiveAgentScope(
  agent: unknown,
  helper?: ScopeHelper,
  importer?: ScopeImporter,
): Promise<ScopeResolution> {
  const ctx = readLiveAgentContext(agent)
  if (ctx === undefined) return { scope: undefined, evaluated: false, resolved: false }
  let effective = helper
  if (effective === undefined) {
    const loaded = await loadScopeHelper(importer)
    if (loaded.ok === false) return { scope: undefined, evaluated: false, resolved: false, problem: loaded.problem }
    effective = loaded.helper
  }
  let scope: unknown
  try {
    scope = effective.scopeOf(ctx)
  } catch (error) {
    return {
      scope: undefined,
      evaluated: false,
      resolved: false,
      problem: {
        code: 'skill-scope-unavailable',
        field: 'scopeOf',
        message: `scopeOf(agent.ctx) 抛错：${(error as Error).message}；本次按"scope 不可用"处理`,
      },
    }
  }
  return { scope, evaluated: true, resolved: scope !== undefined }
}

/** 等价于 `resolveLiveAgentScope`（调用点读起来更直白：`scopeOf(agent.ctx)`）。 */
export function scopeOfAgent(agent: unknown, helper?: ScopeHelper): Promise<ScopeResolution> {
  return resolveLiveAgentScope(agent, helper)
}

// ---------------------------------------------------------------------------
// skills 服务投影
// ---------------------------------------------------------------------------

/** 注册表里一条**归一化**的条目（catalog/preflight 与实际执行都用这一份）。 */
export interface WorkbenchSkillProjectionEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** 提供者名：判"真正生效的是不是工作台下载的那份"就靠它（§7.3）。 */
  provider: string
  source: string
  /** 同一 scope 层内的优先级（宿主注册表用；缺省 `null` = 服务没给）。 */
  rank: number | null
  /** 宿主的定位信息（我们只用它做展示，不用它取文件）。 */
  locator: unknown
  resourceBase?: SkillResourceBaseLike
  path?: string
}

/**
 * 一次 `skills.list` 的投影。
 *
 * 同时满足两件事：
 * - **形状**上兼容 `WorkbenchSkillRegistry`（P3 安装器判 `reuse` 技能时只要 `find`）；
 * - 多带上 catalog/preflight 需要的细节（provider/source/preliminary/issues）。
 */
export interface WorkbenchSkillProjection extends WorkbenchSkillRegistry {
  available: boolean
  /** 这次判定是不是"降级视角"（没有 live agent 或没有真实 scope 层）。 */
  preliminary: boolean
  entries: WorkbenchSkillProjectionEntry[]
  issues: ExpertIssue[]
  scope: unknown
  complete: boolean
  find(name: string): WorkbenchSkillRegistryEntry | undefined
  findEntry(name: string): WorkbenchSkillProjectionEntry | undefined
}

export interface ProjectWorkbenchSkillsOptions {
  scope?: unknown
  cwd?: string
  signal?: AbortSignal
}

function issue(code: ExpertErrorCode, field: string, message: string): ExpertIssue {
  return { code, field, message }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readResourceBase(value: unknown): SkillResourceBaseLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { kind?: unknown; path?: unknown; url?: unknown; description?: unknown }
  if (record.kind === 'directory' && typeof record.path === 'string') return { kind: 'directory', path: record.path }
  if (record.kind === 'url' && typeof record.url === 'string') return { kind: 'url', url: record.url }
  if (record.kind === 'opaque' && typeof record.description === 'string') {
    return { kind: 'opaque', description: record.description }
  }
  return undefined
}

/**
 * 归一化一条注册表条目。
 *
 * 防御性口径与 `api/skills.ts` 的 `normalizeSkillEntries` 一致（provider 是第三方代码，
 * 坏条目丢弃而不是让整个列表 500），但这里**多保留** `provider/source/rank/locator`：
 * 少了它们，catalog 就没法解释"为什么我装的技能不是生效的那个"。
 */
export function normalizeSkillProjectionEntry(raw: unknown): WorkbenchSkillProjectionEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = readString(record.name)
  if (name === undefined) return undefined
  const invocation = typeof record.invocation === 'object' && record.invocation !== null
    ? record.invocation as Record<string, unknown>
    : {}
  const rank = typeof record.rank === 'number' && Number.isInteger(record.rank) ? record.rank : null
  const whenToUse = readString(record.whenToUse)
  const resourceBase = readResourceBase(record.resourceBase)
  const path = readString(record.path)
  return {
    name,
    description: readString(record.description) ?? '',
    ...(whenToUse === undefined ? {} : { whenToUse }),
    modelInvocable: invocation.modelInvocable !== false,
    userInvocable: invocation.userInvocable !== false,
    provider: readString(record.provider) ?? 'unknown',
    source: readString(record.source) ?? '',
    rank,
    locator: record.locator,
    ...(resourceBase === undefined ? {} : { resourceBase }),
    ...(path === undefined ? {} : { path }),
  }
}

/** 从任意 `list()` 返回值里取出条目数组（数组 / `{skills}` / `{candidates}` 都认）。 */
export function readSkillEntryList(raw: unknown): { items: unknown[]; complete: boolean } {
  if (Array.isArray(raw)) return { items: raw, complete: true }
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as { candidates?: unknown; skills?: unknown; complete?: unknown }
    const complete = record.complete !== false
    if (Array.isArray(record.candidates)) return { items: record.candidates, complete }
    if (Array.isArray(record.skills)) return { items: record.skills, complete }
  }
  return { items: [], complete: false }
}

/** 用一批**已经取好的**条目造投影（P5 缓存快照 / 测试替身走这条）。 */
export function createWorkbenchSkillProjection(input: {
  entries: readonly WorkbenchSkillProjectionEntry[]
  available: boolean
  preliminary?: boolean
  issues?: ExpertIssue[]
  scope?: unknown
  complete?: boolean
}): WorkbenchSkillProjection {
  const entries = [...input.entries]
  const byName = new Map<string, WorkbenchSkillProjectionEntry>()
  for (const entry of entries) {
    if (byName.has(entry.name) === false) byName.set(entry.name, entry)
  }
  return {
    available: input.available,
    preliminary: input.preliminary ?? false,
    entries,
    issues: input.issues ?? [],
    scope: input.scope,
    complete: input.complete ?? true,
    find(name: string): WorkbenchSkillRegistryEntry | undefined {
      const entry = byName.get(name)
      return entry === undefined ? undefined : { name: entry.name, modelInvocable: entry.modelInvocable }
    },
    findEntry(name: string): WorkbenchSkillProjectionEntry | undefined {
      return byName.get(name)
    },
  }
}

/** 造一个"当前没有 skills 服务"的投影（**绝不**伪造 `available: true`）。 */
export function unavailableSkillProjection(preliminary: boolean, message?: string): WorkbenchSkillProjection {
  return createWorkbenchSkillProjection({
    entries: [],
    available: false,
    preliminary,
    complete: false,
    issues: [issue(
      'skill-service-unavailable',
      'skills',
      message ?? '当前没有可用的 skills 服务（宿主未注册该服务，或本插件拿不到它）；依赖技能的专家无法预检，也不得假装 required 技能可用',
    )],
  })
}

/**
 * 调 `skills.list({scope, cwd, signal})` 并投影。
 *
 * `scope` 必须由调用方显式给出（`scopeOf(agent.ctx)`）：注册表不会替我们按 Agent 过滤。
 * 服务缺失 / 调用失败 / 被 abort 一律返回 `available: false`，并把原因写进 `issues`。
 */
export async function projectWorkbenchSkillRegistry(
  service: SkillsServiceLike | undefined,
  options: ProjectWorkbenchSkillsOptions = {},
): Promise<WorkbenchSkillProjection> {
  const preliminary = options.scope === undefined
  if (service === undefined) return unavailableSkillProjection(preliminary)
  if (options.signal !== undefined && options.signal.aborted === true) {
    return createWorkbenchSkillProjection({
      entries: [],
      available: false,
      preliminary,
      complete: false,
      scope: options.scope,
      issues: [issue('canceled', 'skills.list', '本次 skills.list 在开始前就被取消（abort）')],
    })
  }
  let raw: unknown
  try {
    raw = await service.list({
      scope: options.scope,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    } satisfies SkillViewOptionsLike)
  } catch (error) {
    return createWorkbenchSkillProjection({
      entries: [],
      available: false,
      preliminary,
      complete: false,
      scope: options.scope,
      issues: [issue(
        'skill-service-unavailable',
        'skills.list',
        `skills.list 调用失败，本次按"没有可用技能库"处理（不假装 required 可用）：${(error as Error).message}`,
      )],
    })
  }
  const list = readSkillEntryList(raw)
  const entries: WorkbenchSkillProjectionEntry[] = []
  for (const item of list.items) {
    const entry = normalizeSkillProjectionEntry(item)
    if (entry !== undefined) entries.push(entry)
  }
  return createWorkbenchSkillProjection({
    entries,
    available: true,
    preliminary,
    scope: options.scope,
    complete: list.complete,
  })
}

// ---------------------------------------------------------------------------
// subagents 软探测与 provider 选择（P6 §8.5）
// ---------------------------------------------------------------------------

/**
 * `ctx.subagents` 的**形状最小化**视图。
 *
 * 这里刻意用结构化类型而不是 `import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'`：
 * 该包是**可选**宿主依赖（用户可能只装工作台），静态 import 会让插件在缺它的机器上起不来；
 * 而 `import type` 也会把"本机装了长什么样"写进源码契约。软探测 + 形状校验才是诚实的做法。
 */
export interface SubagentStartRequestLike {
  readonly label?: string
  readonly prompt: readonly { type: 'text'; text: string }[]
  readonly parent: unknown
  readonly signal: AbortSignal
  readonly persona?: string
  readonly maxDepth?: number
  readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
}

export interface SubagentProviderCapabilitiesLike {
  readonly agentOptions?: unknown
  readonly outputSchema?: unknown
  readonly depthLimit?: unknown
  readonly toolFilter?: unknown
  readonly persona?: unknown
}

export interface SubagentProviderLike {
  readonly name?: unknown
  readonly capabilities?: SubagentProviderCapabilitiesLike
  readonly inheritsParentContext?: unknown
}

/**
 * 软探测通过之后**我们敢依赖**的表面：三个函数都由 `probeExpertSubagents` 逐个做过形状校验。
 *
 * `start` 的返回值刻意是 `unknown`：`run` 的字段（`id` / `localAgent` / `result` / `dispose`）
 * 由调用方 `readSubagentRun()` 逐字段校验后再用 —— provider 是第三方实现，形状不符要
 * 走 `adapter-contract-mismatch`，不能靠类型断言假装它一定对。
 */
export interface SubagentServiceLike {
  /** 注册表里的 provider 名。 */
  list(): unknown
  getProvider(name: string): unknown
  start(name: string, request: SubagentStartRequestLike): Promise<unknown>
}

/** `ctx.tools` 里我们唯一需要的能力：按名字问"这个工具真的注册了吗"。 */
export interface ToolRegistryLike {
  get?: unknown
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function probeOptionalService(ctx: unknown, name: string): unknown {
  if (!isObject(ctx)) return undefined
  const get = (ctx as { get?: unknown }).get
  if (!isFunction(get)) return undefined
  try {
    return (get as (key: string) => unknown)(name)
  } catch {
    return undefined
  }
}

/**
 * 软探测 `ctx.subagents`：拿不到 / 形状不对一律 `undefined`（调用方据此说"不可用"）。
 *
 * 形状要求（§8.5 第 3 步）：`list`、`getProvider`、`start` 都是函数。少任何一个都算
 * "不可用"，因为 P6 的调用链三个都要用（能力报告 / provider 选择 / 真正启动）。
 */
export function probeExpertSubagents(ctx: unknown): SubagentServiceLike | undefined {
  const service = probeOptionalService(ctx, 'subagents')
  if (typeof service !== 'object' || service === null) return undefined
  const candidate = service as { start?: unknown; getProvider?: unknown; list?: unknown }
  if (typeof candidate.start !== 'function' || typeof candidate.getProvider !== 'function' || typeof candidate.list !== 'function') {
    return undefined
  }
  return service as SubagentServiceLike
}

/** 软探测 `ctx.tools`（只为校验 deny 名单里没有不存在的工具名）。 */
export function probeExpertTools(ctx: unknown): ToolRegistryLike | undefined {
  const service = probeOptionalService(ctx, 'tools')
  if (typeof service !== 'object' || service === null) return undefined
  if (typeof (service as { get?: unknown }).get !== 'function') return undefined
  return service as ToolRegistryLike
}

/** provider 选择的失败面：原因必须足以让人知道"该装什么/该开什么"。 */
export interface ExpertSubagentUnavailable {
  readonly ok: false
  readonly code: 'expert-subagent-unavailable'
  readonly message: string
}

export type ExpertSubagentSelection =
  | { readonly ok: true; readonly provider: SubagentProviderLike }
  | ExpertSubagentUnavailable

function unavailable(message: string): ExpertSubagentUnavailable {
  return { ok: false, code: 'expert-subagent-unavailable', message }
}

/**
 * 选 provider（§8.5 第 3 步）：**只有** `spawn` 且 `inheritsParentContext === false`、
 * `persona`/`toolFilter`/`depthLimit` 三项能力全为 `true` 才算等价实现。
 *
 * 刻意不把 `fork` / acp / 远程 provider 当替代：
 * - `inheritsParentContext === true` 的 provider 里，子代理根本不是"独立会话"，
 *   「按需加载人格」的整个前提（child session 身份 + 独立上下文）不成立；
 * - 缺 `persona` ⇒ 没法把加载短指令交给子代理；缺 `toolFilter` ⇒ 专家子代理的 deny
 *   失效（等于把草稿写入能力给了子代理）；缺 `depthLimit` ⇒ 无法把委派深度钉死。
 * 任何一条不满足都返回**明确不可用**，绝不降级猜测。
 */
export function selectSpawnProvider(service: SubagentServiceLike | undefined): ExpertSubagentSelection {
  if (service === undefined) {
    return unavailable('宿主没有提供 subagents 服务（@deepseek-ai/dsh-subagent 未安装或未注册）：本机不能启动专家子代理，本次不假装可用')
  }
  if (!isFunction(service.start)) return unavailable('subagents 服务没有 start 函数：不猜 API，本次判为不可用')
  if (!isFunction(service.getProvider)) return unavailable('subagents 服务没有 getProvider：不猜 API，本次判为不可用')
  let provider: unknown
  try {
    provider = (service.getProvider as (name: string) => unknown)(EXPERT_PROVIDER_CODE)
  } catch (error) {
    return unavailable(`subagents.getProvider('${EXPERT_PROVIDER_CODE}') 抛错：${(error as Error).message}`)
  }
  if (!isObject(provider)) {
    return unavailable(`注册表里没有名为「${EXPERT_PROVIDER_CODE}」的子代理 provider：不把 fork / acp / 远程 provider 当作等价实现（§8.5 第 3 步）`)
  }
  const name = provider.name
  if (typeof name === 'string' && name !== EXPERT_PROVIDER_CODE) {
    return unavailable(`getProvider('${EXPERT_PROVIDER_CODE}') 返回了名为「${name}」的 provider：注册名对不上，本次判为不可用`)
  }
  if (provider.inheritsParentContext !== false) {
    return unavailable(`provider「${EXPERT_PROVIDER_CODE}」的 inheritsParentContext 不是 false（会继承父上下文，拿不到独立子会话身份）：按 §8.5 第 3 步拒绝`)
  }
  const capabilities = provider.capabilities
  if (!isObject(capabilities)) {
    return unavailable(`provider「${EXPERT_PROVIDER_CODE}」没有 capabilities：无法确认 persona/toolFilter/depthLimit，本次判为不可用`)
  }
  if (capabilities.persona !== true) {
    return unavailable(`provider「${EXPERT_PROVIDER_CODE}」不支持 persona 参数：无法把"按需加载人格"的短指令交给子代理，本次判为不可用`)
  }
  if (capabilities.toolFilter !== true) {
    return unavailable(`provider「${EXPERT_PROVIDER_CODE}」不支持 toolFilter：专家子代理的工具 deny 无法生效，本次判为不可用`)
  }
  if (capabilities.depthLimit !== true) {
    return unavailable(`provider「${EXPERT_PROVIDER_CODE}」不支持 depthLimit：无法钉死委派深度，本次判为不可用`)
  }
  return { ok: true, provider: provider as SubagentProviderLike }
}
