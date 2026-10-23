/**
 * 工作台 skill provider：把 `~/.dsh/workbench/skills` 下的技能包**投影成宿主技能注册表的一层**。
 *
 * ## 为什么是 provider 而不是"逐条 register"
 *
 * 规格 §7.1：下载/安装的技能必须以 **provider**（rank 600、source `bundled`）的形式参与注册表，
 * 而**不能**逐条调 `ctx.skills.register`。两者的差别不是风格：
 *
 * - 逐条 register 是**快照**：注册表里从此多了一条死记录，磁盘上的包被删/被改/发布门退回，
 *   注册表毫无感觉；
 * - provider 是**投影**：每次 list 都重新读盘、重新过发布门，命中"同名更高优先级"
 *   （项目 100/200 / 用户 400）时宿主的合并规则本来就会让用户那份胜出 —— 这正是
 *   规格 §7.3 要的"不强行改名绕过用户覆盖"。
 *
 * ## 结构类型：本模块**不 import 宿主 runtime**
 *
 * `@deepseek-ai/dsh-skill` 是宿主 side 的运行时插件（不是本仓的依赖）。P0 已核对 0.2.0-rc.2 的
 * 公开形状，这里逐字抄成**结构化类型**（`SkillProviderLike` 等）：形状错了 `tsc` 会红，
 * 但打包产物里不会出现 `import '@deepseek-ai/dsh-skill'`，插件在没有该 runtime 的环境里照样加载。
 *
 * ## 发布门是**共用**的，不是 provider 自己发明的
 *
 * 受管技能（目录里有 `workbench-install.json`）能不能被列出来，判据只有一条：
 * `readManagedSkillInstallState(...).ready === true`（= 管理清单形状正确 **且** 它关联的受管人格
 * `publication.json` 已 ready）。它与 P3 安装器、人格发现链用的是**同一个**函数，
 * 所以不会出现"装完了但列表里没有"或"没装完就出现在列表里"。
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'

import {
  EXPERT_PENDING_DIR_NAME,
  EXPERT_RESOURCE_MAX_DEPTH,
  EXPERT_STAGED_FILE_MAX_BYTES,
  isExpertSkillName,
} from '../shared/expert.js'
import type { ExpertErrorCode, ExpertIssue } from '../shared/expert.js'
import { readManagedSkillInstallState } from '../personas/managed.js'
import { hashSkillPackage, parseWorkbenchSkill } from './skill-package.js'
import type { WorkbenchSkillDocument, WorkbenchSkillPackageFile } from './skill-package.js'
import { readExpertTextFile } from './paths.js'

/** provider 名固定（规格 §7.1）：宿主注册表里认的就是这个字符串。 */
export const WORKBENCH_SKILL_PROVIDER_NAME = 'personal-workbench'
/** 工作台技能的 rank（**同一 scope 层内**数字小者胜；600 > 用户 400 > 项目 100/200）。 */
export const WORKBENCH_SKILL_RANK = 600
/** 工作台技能在宿主里的 source 标记（工作台带进来的包）。 */
export const WORKBENCH_SKILL_SOURCE = 'bundled'

// ---------------------------------------------------------------------------
// 宿主 SDK 的结构化形状（只抄形状，不 import）
// ---------------------------------------------------------------------------

/** `SkillInvocationPolicy`。 */
export interface SkillInvocationPolicyLike {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** `SkillResourceBase`（三种基座；本 provider 只产出 `directory`）。 */
export type SkillResourceBaseLike =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** `SkillSummary`。 */
export interface SkillSummaryLike {
  readonly path?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicyLike
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBaseLike
}

/** `SkillCandidate`（`list` 的返回单元）。 */
export interface SkillCandidateLike extends SkillSummaryLike {
  readonly rank: number
  readonly locator: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** `SkillDefinition`（`get` 的返回单元）。 */
export interface SkillDefinitionLike extends SkillSummaryLike {
  readonly content: string
}

/** `SkillLookupOptions`。 */
export interface SkillLookupOptionsLike {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** `SkillViewOptions`（多一个 `scope`）。 */
export interface SkillViewOptionsLike extends SkillLookupOptionsLike {
  readonly scope?: unknown
}

/** `SkillProviderObservation`（provider 可以用它表达"没扫完"）。 */
export interface SkillProviderObservationLike {
  readonly candidates: readonly SkillCandidateLike[]
  readonly complete: boolean
}

/** `SkillProvider`。 */
export interface SkillProviderLike {
  readonly name: string
  readonly list: (options: SkillLookupOptionsLike) => Promise<readonly SkillCandidateLike[] | SkillProviderObservationLike>
  readonly get: (candidate: SkillCandidateLike, options: SkillLookupOptionsLike) => Promise<SkillDefinitionLike | undefined>
}

/** `SkillProviderControl`。 */
export interface SkillProviderControlLike {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

/** 宿主注册表里我们用到的**唯一**方法（`registerProvider` 返回 disposer）。 */
export interface SkillRegistrarLike {
  registerProvider(create: (control: SkillProviderControlLike) => SkillProviderLike): () => void
}

/** 宿主 `skills` 服务（catalog/preflight 只读 `list`，`get` 可选）。 */
export interface SkillsServiceLike {
  list(options?: SkillViewOptionsLike): Promise<unknown>
  get?(name: string, options?: SkillViewOptionsLike): Promise<unknown>
}

/** 候选里那条**只能由本 provider 解释**的定位信息（get 用它复核整包一致性）。 */
export interface WorkbenchSkillLocator {
  readonly name: string
  readonly packageHash: string
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

/** 一条 provider 诊断：坏包/坏目录**不让整个 list 抛**，而是落到这里。 */
export interface WorkbenchSkillDiagnostic extends ExpertIssue {
  /** 出问题的技能目录名（名字本身非法时是条目名，可能为空）。 */
  skill?: string
  /** 出问题的绝对路径（拿得到就给）。 */
  path?: string
}

const DIAGNOSTICS_KEY = Symbol.for('dsh.workbench.skillProviderDiagnostics')

interface ProviderState {
  diagnostics: WorkbenchSkillDiagnostic[]
}

/**
 * 读一个 provider 实例最近一次 list/get 产生的诊断。
 *
 * 传别的对象（或 undefined）返回空数组 —— 调用方不该为了读诊断先做形状判断。
 */
export function readWorkbenchSkillProviderDiagnostics(source: unknown): readonly WorkbenchSkillDiagnostic[] {
  if (typeof source !== 'object' || source === null) return []
  const state = (source as Record<symbol, unknown>)[DIAGNOSTICS_KEY]
  if (typeof state !== 'object' || state === null) return []
  const diagnostics = (state as ProviderState).diagnostics
  return Array.isArray(diagnostics) ? diagnostics : []
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

export interface WorkbenchSkillProviderDeps {
  /** 工作台技能根（`~/.dsh/workbench/skills`）。 */
  skillsDir: string
  /** 工作台人格根（`~/.dsh/workbench/personas`）：受管技能的发布门要对照它。 */
  personasDir: string
  /** 链接判定用的平台（测试可传 `win32`）；缺省 `process.platform`。 */
  platform?: string
  /** 允许链接的祖先目录（与安装器同一语义，只给特殊部署用）。 */
  allowRootLinkUnder?: string
  /** 可选：把诊断外送（P5 可以拿去打日志/落事件）。 */
  onDiagnostic?: (diagnostic: WorkbenchSkillDiagnostic) => void
}

/** 一条候选 + 它解析出来的文档（list 与 get 共用同一条构造路径）。 */
interface BuiltCandidate {
  name: string
  skillDir: string
  skillMdPath: string
  document: WorkbenchSkillDocument
  candidate: SkillCandidateLike
}

/**
 * 造一个 provider 工厂：宿主注册表调它拿到 provider 实例（并把 `control` 交给我们）。
 *
 * 工厂形态（而不是直接返回 provider）是宿主 API 的要求，也是 invalidate 生命周期的锚点：
 * 每次注册都会新建一个实例，旧的实例连同它的 controller 一起作废。
 */
export function createWorkbenchSkillProvider(
  deps: WorkbenchSkillProviderDeps,
): (control: SkillProviderControlLike) => SkillProviderLike {
  return (control: SkillProviderControlLike): SkillProviderLike => {
    const state: ProviderState = { diagnostics: [] }
    /** provider 自己的生命周期信号：注册被拆掉时（子 fiber 卸载）就不要再扫盘了。 */
    const providerAborted = (): boolean => {
      const signal = (control as { signal?: unknown } | undefined)?.signal
      return typeof signal === 'object' && signal !== null && (signal as AbortSignal).aborted === true
    }
    const provider: SkillProviderLike = {
      name: WORKBENCH_SKILL_PROVIDER_NAME,
      list: async (options: SkillLookupOptionsLike) => {
        if (providerAborted()) return { candidates: [], complete: false }
        return listSkills(deps, state, options)
      },
      get: async (candidate: SkillCandidateLike, options: SkillLookupOptionsLike) => {
        if (providerAborted()) return undefined
        return getSkill(deps, state, control, candidate, options)
      },
    }
    Object.defineProperty(provider, DIAGNOSTICS_KEY, { value: state, enumerable: false })
    return provider
  }
}

function report(deps: WorkbenchSkillProviderDeps, state: ProviderState, diagnostic: WorkbenchSkillDiagnostic): void {
  state.diagnostics.push(diagnostic)
  try {
    deps.onDiagnostic?.(diagnostic)
  } catch {
    /** 外送方的异常绝不该影响 provider 的返回（它只是观察者）。 */
  }
}

function issue(code: ExpertErrorCode, field: string, message: string): ExpertIssue {
  return { code, field, message }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted === true
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 读技能根的直接子项。
 *
 * 目录不存在（ENOENT）= "一个工作台技能都没有"，这是**正常状态**（没装过东西的机器），
 * 不是错误；其余读失败（权限等）才记诊断并把 `complete` 标成 false。
 */
function readSkillRoot(deps: WorkbenchSkillProviderDeps, state: ProviderState): { entries: Dirent[]; complete: boolean } {
  try {
    return { entries: readdirSync(deps.skillsDir, { withFileTypes: true }), complete: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], complete: true }
    report(deps, state, {
      ...issue('invalid-path', deps.skillsDir, `技能根读不了，本次列不出任何工作台技能：${deps.skillsDir}（${(error as Error).message}）`),
      path: deps.skillsDir,
    })
    return { entries: [], complete: false }
  }
}

/**
 * 条目是不是链接（`Dirent` 已经给过一次答案，但 Windows junction 不一定标出来）。
 *
 * 兜底必须用 **`lstatSync`**：`statSync` 会**跟随**链接，对一个链接调用它拿到的是目标的
 * 信息，`isSymbolicLink()` 永远 `false` —— 那样这条"兜底"就什么也没兜住。
 * 只有 `lstat` 看的是**条目本身**。
 */
function isLinkEntry(dir: string, entry: Dirent): boolean {
  if (entry.isSymbolicLink()) return true
  try {
    return lstatSync(join(dir, entry.name)).isSymbolicLink()
  } catch {
    /** 读不到就当链接处理：宁可漏一个技能，也不把根外的内容当成包的一部分。 */
    return true
  }
}

// ---------------------------------------------------------------------------
// 整包文件索引
// ---------------------------------------------------------------------------

interface PackageWalk {
  files: WorkbenchSkillPackageFile[]
  problems: ExpertIssue[]
}

/**
 * 扫一个技能目录里的所有文件（相对技能根）。
 *
 * 规则与安装器同一套：
 * - 链接**一律拒绝**（`path-link-forbidden`）——包的一部分指向根外，哈希就不可解释；
 * - 目录深度不超过 `EXPERT_RESOURCE_MAX_DEPTH`；
 * - 单文件不超过 `EXPERT_STAGED_FILE_MAX_BYTES`（安装器写不出更大的文件，出现了就是被改过）。
 */
function walkSkillPackage(skillDir: string, relative: string, depth: number): PackageWalk {
  const files: WorkbenchSkillPackageFile[] = []
  const problems: ExpertIssue[] = []
  const absolute = relative === '' ? skillDir : join(skillDir, relative)
  let entries: Dirent[]
  try {
    entries = readdirSync(absolute, { withFileTypes: true })
  } catch (error) {
    problems.push(issue('invalid-path', relative === '' ? '.' : relative, `目录读不了：${absolute}（${(error as Error).message}）`))
    return { files, problems }
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    /**
     * **不跳过**点子开头的文件：安装器的 `packageHash` 覆盖的是它当时写入的**每**个文件
     * （只排除 `EXPERT_RESERVED_FILE_NAMES`），所以这里也必须走同一集合 —— 否则一个合法包
     * 只要含 `.foo.txt`，重算出来的哈希就会对不上，把好包误判成"被改过"。
     * （根级的 `.pending`/隐藏项过滤在 `listSkills` 里，不在这里。）
     */
    if (isLinkEntry(absolute, entry)) {
      problems.push(issue('path-link-forbidden', child, `技能包里含链接，拒绝把根外内容算进包：${child}`))
      continue
    }
    if (entry.isDirectory()) {
      if (depth + 1 > EXPERT_RESOURCE_MAX_DEPTH) {
        problems.push(issue('invalid-path', child, `技能包目录深度超过 ${EXPERT_RESOURCE_MAX_DEPTH} 层：${child}`))
        continue
      }
      const nested = walkSkillPackage(skillDir, child, depth + 1)
      files.push(...nested.files)
      problems.push(...nested.problems)
      continue
    }
    if (entry.isFile() === false) {
      problems.push(issue('invalid-path', child, `技能包里含非普通文件：${child}`))
      continue
    }
    const filePath = join(absolute, entry.name)
    try {
      const stats = statSync(filePath)
      if (stats.size > EXPERT_STAGED_FILE_MAX_BYTES) {
        problems.push(issue('file-too-large', child, `文件 ${stats.size} 字节，超过单文件上限 ${EXPERT_STAGED_FILE_MAX_BYTES} 字节：${child}`))
        continue
      }
      const buffer = readFileSync(filePath)
      files.push({ path: child, bytes: buffer.length, sha256: sha256Of(buffer) })
    } catch (error) {
      problems.push(issue('invalid-path', child, `文件读不了：${child}（${(error as Error).message}）`))
    }
  }
  return { files, problems }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/**
 * 解析**一个**技能目录 → 候选。
 *
 * 返回 `undefined` 表示这个目录不能被当作技能用（原因已经记进诊断）。
 * `list` 与 `get` 都走这一条路径：这样"列出来的"和"取回来的"不可能是两份不同的解析结果。
 */
function buildCandidate(
  deps: WorkbenchSkillProviderDeps,
  state: ProviderState,
  name: string,
  options: { collect: boolean; signal?: AbortSignal | undefined },
): BuiltCandidate | undefined {
  const skillDir = join(deps.skillsDir, name)
  const skillMdRelative = `${name}/SKILL.md`
  const skillMdPath = join(deps.skillsDir, name, 'SKILL.md')
  const fail = (code: ExpertErrorCode, field: string, message: string): undefined => {
    if (options.collect) report(deps, state, { ...issue(code, field, message), skill: name, path: skillDir })
    return undefined
  }

  /** 发布门（§6.2 末段）：受管技能必须 ready；旧手工技能（`managed:false`）照旧可用。 */
  const install = readManagedSkillInstallState(deps.skillsDir, deps.personasDir, name)
  if (install.ready !== true && install.managed) {
    const problem = install.problem
    return fail(
      problem?.code ?? 'installation-incomplete',
      skillMdRelative,
      problem?.message ?? `技能「${name}」的受管安装状态未就绪，按发布门跳过`,
    )
  }

  const read = readExpertTextFile(deps.skillsDir, skillMdRelative, {
    maxBytes: EXPERT_STAGED_FILE_MAX_BYTES,
    ...(deps.allowRootLinkUnder === undefined ? {} : { allowRootLinkUnder: deps.allowRootLinkUnder }),
  })
  if (read.ok === false || read.text === undefined) {
    const problem = read.problem
    return fail(problem?.code ?? 'skill-package-invalid', skillMdRelative, problem?.message ?? `读不到 ${skillMdRelative}`)
  }

  const parsed = parseWorkbenchSkill(read.text, skillMdRelative)
  if (parsed.ok === false || parsed.skill === undefined) {
    if (options.collect) {
      for (const problem of parsed.errors) {
        report(deps, state, { ...problem, skill: name, path: skillMdPath })
      }
    }
    return undefined
  }
  const document = parsed.skill
  if (document.name !== name) {
    return fail(
      'skill-package-invalid',
      skillMdRelative,
      `SKILL.md 的 name「${document.name}」必须与目录名「${name}」相同`,
    )
  }
  if (options.signal !== undefined && isAborted(options.signal)) return undefined

  const walked = walkSkillPackage(skillDir, '', 0)
  if (walked.problems.length > 0) {
    if (options.collect) {
      for (const problem of walked.problems) {
        report(deps, state, { ...problem, skill: name, path: skillDir })
      }
    }
    return undefined
  }
  const packageHash = hashSkillPackage({ name, metadata: document.metadata, files: walked.files })
  /**
   * §7.2 get：「复核 ready、真实文件、清单 hash」。
   *
   * 受管技能的管理清单（`workbench-install.json`）记着**安装那一刻**的整包哈希；它比对不上
   * 就说明这个目录在装完之后被改过/增删过文件 —— 那不是"工作台装的那份"，不能照常列出来。
   * `walked.files` 与安装器算哈希时的输入是同一集合（`hashSkillPackage` 自己会剔除保留名、
   * 按 path 排序），所以没被改动的包必然相等。
   * 旧手工技能（`managed:false`）没有清单，也就没有可比对的基准，照旧放行。
   */
  if (install.managed === true && install.ready === true && install.packageHash !== packageHash) {
    return fail(
      'skill-package-invalid',
      skillMdRelative,
      '已安装的受管技能与安装清单不一致（安装后被改动或增删过文件），按发布门不列出该技能',
    )
  }

  const candidate: SkillCandidateLike = {
    name,
    description: document.description,
    ...(document.whenToUse === undefined ? {} : { whenToUse: document.whenToUse }),
    invocation: {
      modelInvocable: document.invocation.disableModelInvocation !== true,
      userInvocable: document.invocation.userInvocable,
    },
    source: WORKBENCH_SKILL_SOURCE,
    provider: WORKBENCH_SKILL_PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: skillDir },
    path: skillMdPath,
    rank: WORKBENCH_SKILL_RANK,
    locator: { name, packageHash } satisfies WorkbenchSkillLocator,
    metadata: document.metadata,
  }
  return { name, skillDir, skillMdPath, document, candidate }
}

async function listSkills(
  deps: WorkbenchSkillProviderDeps,
  state: ProviderState,
  options: SkillLookupOptionsLike | undefined,
): Promise<readonly SkillCandidateLike[] | SkillProviderObservationLike> {
  state.diagnostics = []
  if (isAborted(options?.signal)) return { candidates: [], complete: false }
  const root = readSkillRoot(deps, state)
  const candidates: SkillCandidateLike[] = []
  for (const entry of root.entries) {
    if (isAborted(options?.signal)) return { candidates, complete: false }
    /** `.pending` 与隐藏项一律跳过：暂存中的（还没确认的）草稿绝不能露出来。 */
    if (entry.name === EXPERT_PENDING_DIR_NAME || entry.name.startsWith('.')) continue
    if (isLinkEntry(deps.skillsDir, entry)) {
      report(deps, state, {
        ...issue('path-link-forbidden', entry.name, `技能根下的条目是链接，拒绝把根外内容当成技能包：${entry.name}`),
        skill: entry.name,
        path: join(deps.skillsDir, entry.name),
      })
      continue
    }
    if (entry.isDirectory() === false) {
      report(deps, state, {
        ...issue('invalid-path', entry.name, `技能根下只有目录会被当成技能包，忽略：${entry.name}`),
        skill: entry.name,
        path: join(deps.skillsDir, entry.name),
      })
      continue
    }
    if (isExpertSkillName(entry.name) === false) {
      report(deps, state, {
        ...issue('invalid-path', entry.name, `技能目录名必须是小写 kebab-case（1–64 字符）：${entry.name}`),
        skill: entry.name,
        path: join(deps.skillsDir, entry.name),
      })
      continue
    }
    const built = buildCandidate(deps, state, entry.name, { collect: true, signal: options?.signal })
    if (built !== undefined) candidates.push(built.candidate)
  }
  candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { candidates, complete: root.complete }
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

function readLocator(candidate: SkillCandidateLike): WorkbenchSkillLocator | undefined {
  const locator = (candidate as { locator?: unknown }).locator
  if (typeof locator !== 'object' || locator === null) return undefined
  const record = locator as { name?: unknown; packageHash?: unknown }
  if (typeof record.name !== 'string' || typeof record.packageHash !== 'string') return undefined
  return { name: record.name, packageHash: record.packageHash }
}

/**
 * 取正文。
 *
 * 三条不可让步的口径（规格 §7.2 末段）：
 *
 * 1. **不信任 `locator.path`**：候选里的绝对路径只供宿主注册表内部展示，取文件一律按 `name`
 *    从**自己的根**重算（否则伪造一个 locator 就能读到任意路径）；
 * 2. **整包 hash 与候选不一致 → 返回 `undefined` 并 `invalidate()`**：绝不返回新版本
 *    冒充旧候选 —— 那会让宿主缓存里的"旧摘要 + 新正文"配成一对假的一致；
 * 3. 复核发布门与真实文件：list 之后被删/被退回的包，get 也要拿不到。
 */
async function getSkill(
  deps: WorkbenchSkillProviderDeps,
  state: ProviderState,
  control: SkillProviderControlLike,
  candidate: SkillCandidateLike,
  options: SkillLookupOptionsLike | undefined,
): Promise<SkillDefinitionLike | undefined> {
  if (isAborted(options?.signal)) return undefined
  const name = (candidate as { name?: unknown }).name
  if (typeof name !== 'string' || isExpertSkillName(name) === false) return undefined
  const locator = readLocator(candidate)
  if (locator === undefined || locator.name !== name) {
    invalidate(control)
    return undefined
  }
  /** `get` 的诊断追加在最近一次 list 之后（不重置），方便调用方连起来看一次完整交互。 */
  const built = buildCandidate(deps, state, name, { collect: true, signal: options?.signal })
  if (built === undefined) {
    invalidate(control)
    return undefined
  }
  const rebuilt = readLocator(built.candidate)
  if (rebuilt === undefined || rebuilt.packageHash !== locator.packageHash) {
    report(deps, state, {
      ...issue(
        'package-changed',
        `${name}/SKILL.md`,
        `技能「${name}」的内容与候选登记不一致（候选 ${locator.packageHash}，当前 ${rebuilt?.packageHash ?? '无法计算'}）；返回不可用并让注册表失效，绝不返回新版本冒充旧候选`,
      ),
      skill: name,
      path: built.skillDir,
    })
    invalidate(control)
    return undefined
  }
  return {
    name,
    description: built.document.description,
    ...(built.document.whenToUse === undefined ? {} : { whenToUse: built.document.whenToUse }),
    invocation: built.candidate.invocation,
    source: WORKBENCH_SKILL_SOURCE,
    provider: WORKBENCH_SKILL_PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: built.skillDir },
    path: built.skillMdPath,
    content: built.document.body,
  }
}

function invalidate(control: SkillProviderControlLike): void {
  try {
    control.invalidate()
  } catch {
    /** 宿主的 invalidate 抛错不该让 get 变成异常（该返回 undefined 还是 undefined）。 */
  }
}

// ---------------------------------------------------------------------------
// 注册与失效
// ---------------------------------------------------------------------------

export interface WorkbenchSkillRegistration {
  readonly providerName: string
  /** 这次注册是否仍然活着（`dispose()` 之后为 `false`）。 */
  readonly active: boolean
  /**
   * 只在**当前这次注册**仍活着时转发 `control.invalidate()`。
   *
   * 返回是否真的转发了。注册换代（宿主重挂子 fiber / 服务重注册）后旧控制器必须作废：
   * 对着一个已经 dispose 的 controller 调 invalidate 轻则无效、重则在宿主里留下悬挂引用。
   */
  invalidateSkills(): boolean
  /** 最近一次 list/get 的诊断（注册尚未 dispose 时读到的才有意义）。 */
  readDiagnostics(): readonly WorkbenchSkillDiagnostic[]
  /** 解注册并作废控制器（幂等）。 */
  dispose(): void
}

/**
 * 把工作台 provider 注册进宿主技能注册表。
 *
 * 返回的句柄同时承担两件事，P5 接线时**只需**持有这一个对象：
 * - `dispose` 交给宿主 effect 的释放路径（子 fiber 卸载时调用）；
 * - `invalidateSkills` 接 P3 安装器的 `refreshSkills`（安装成功后立刻让注册表重扫）。
 */
export function registerWorkbenchSkillProvider(
  skills: SkillRegistrarLike,
  deps: WorkbenchSkillProviderDeps,
): WorkbenchSkillRegistration {
  const create = createWorkbenchSkillProvider(deps)
  let control: SkillProviderControlLike | undefined
  let provider: SkillProviderLike | undefined
  let disposed = false

  const unregister = skills.registerProvider((given: SkillProviderControlLike): SkillProviderLike => {
    /** 换代：新的 controller 直接替换旧的，旧的不再被引用。 */
    control = given
    provider = create(given)
    return provider
  })

  return {
    providerName: WORKBENCH_SKILL_PROVIDER_NAME,
    get active(): boolean {
      return disposed === false
    },
    invalidateSkills(): boolean {
      if (disposed || control === undefined) return false
      try {
        control.invalidate()
        return true
      } catch {
        return false
      }
    },
    readDiagnostics(): readonly WorkbenchSkillDiagnostic[] {
      return provider === undefined ? [] : readWorkbenchSkillProviderDiagnostics(provider)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      /** 先断引用再解注册：无论 unregister 抛不抛，之后都不会再碰旧控制器。 */
      control = undefined
      provider = undefined
      try {
        unregister()
      } catch {
        /** 解注册失败不该掩盖调用方的原始错误路径。 */
      }
    },
  }
}

/**
 * 显式失效（给 `refreshSkills?: () => void` 这种"只要一个回调"的调用点用）。
 *
 * 句柄不存在/已 dispose 时返回 `false` —— 调用方据此知道"这次失效没有真的送达"，
 * 而不是以为已经生效。
 */
export function invalidateWorkbenchSkills(registration: WorkbenchSkillRegistration | undefined): boolean {
  if (registration === undefined || typeof registration.invalidateSkills !== 'function') return false
  return registration.invalidateSkills()
}
