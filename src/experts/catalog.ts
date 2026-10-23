/**
 * 专家目录（catalog）与运行前预检（preflight）。
 *
 * ## 这个模块解决的两个问题
 *
 * 1. **"界面上到底有哪些专家、能不能用"**：角色库（三级目录）里既有解析成功的人格，也有
 *    读坏的文件、被同名盖掉的文档、受管安装还没确认的 `generated/*`。catalog 把它们**全部**
 *    变成一行一行可解释的记录（每行带状态与原因），而不是"列表里少了一个人，用户不知道为什么"。
 * 2. **"真的绑上去跑之前，它要的技能在不在"**：预检必须按**调用者所在的 scope 层**问注册表
 *    （`skills.list` 不会替我们筛 scope），并且只说事实：技能缺失就是缺失、
 *    被更高优先级的同名技能盖住就是被盖住（`skill-shadowed`）、拿不到 scope 就是拿不到。
 *
 * ## 三类降级，三种不同的诚实
 *
 * | 情形 | 结论 |
 * | --- | --- |
 * | skills 服务缺失 | `required` 技能**不可用**（§10）；无依赖人格照常 `usable` |
 * | 没有 live agent（HTTP） | 只给"全局视角"，`preliminary: true` —— 不是最终证明 |
 * | 有 live agent 但拿不到 scope helper | `skill-scope-unavailable`，**不拿全局视角冒充权威** |
 *
 * ## 与 P3 安装器的共用面
 *
 * 受管人格的技能需求存在它的**安装草稿**里（`publication.json.installationId` → `task_drafts`）。
 * 这里只读不写：草稿行读不到时给人格加一条说明，**绝不**因此把已经装好的人格判成不可用。
 *
 * ## 行序约定（调用方可以依赖）
 *
 * `rows` 里**同一 id 的第一行是生效行**（`discoverPersonas` 的胜者），其余是"被同名盖住的
 * 合法文档"或"读坏/未发布的文档"，各自成行、**不合并成一份假摘要**。诊断行按
 * `(id, sourceKey)` 排序，保证同一状态下输出稳定。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  EXPERT_INSTALL_JOURNAL_FILE_NAME,
  EXPERT_PENDING_DIR_NAME,
  EXPERT_PROVENANCE_FILE_NAME,
} from '../shared/expert.js'
import type { ExpertDraftPayload, ExpertIssue, ExpertProvenance, ExpertSkillRequirement } from '../shared/expert.js'
import { personaCompareKey } from '../shared/persona.js'
import type { PersonaDiagnostic, PersonaSourceKind, PersonaSummary } from '../shared/persona.js'
import { discoverPersonas, personaGroupForId, sourceKeyForRoot } from '../personas/library.js'
import type { PersonaDiscovery, PersonaLibraryOptions } from '../personas/library.js'
import {
  isManagedPersonaId,
  managedPersonaDirectoryPath,
  readManagedPersonaPublication,
} from '../personas/managed.js'
import { personaLookupOptions } from '../personas/roots.js'
import { getExpertDraft } from '../db/repo/experts.js'
import { readExpertTextFile, resolveExpertRoots } from './paths.js'
import type { ExpertRoots } from './paths.js'
import { parseExpertProvenance } from './provenance.js'
import {
  projectWorkbenchSkillRegistry,
  readLiveAgentCwd,
  resolveLiveAgentScope,
} from './host-adapter.js'
import type { ScopeHelper, WorkbenchSkillProjection, WorkbenchSkillProjectionEntry } from './host-adapter.js'
import type { SkillsServiceLike } from './skill-provider.js'
import { WORKBENCH_SKILL_PROVIDER_NAME } from './skill-provider.js'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ExpertCatalogStatus =
  | 'usable'
  | 'disabled'
  | 'invalid'
  | 'dependency-unavailable'
  | 'installation-incomplete'

export type ExpertProvenanceState = 'recorded' | 'unrecorded' | 'invalid'

/** 一行里的一条 `required` 技能需求（可选技能的问题只进 `issues`）。 */
export interface ExpertCatalogRequiredSkill {
  name: string
  available: boolean
  /** 实际生效的那个实现（**不是**我们想用的那个；`null` = 注册表里没有）。 */
  provider: string | null
  /** 这次判定是不是降级视角（没有 live agent / 没有真实 scope 层）。 */
  preliminary: boolean
}

/** 专家目录里的一行（`id + sourceKey` 唯一）。 */
export interface ExpertCatalogRow {
  id: string
  name: string
  description: string
  group: string
  source: PersonaSourceKind
  sourceKey: string
  /** 生效行的内容指纹；诊断行（读坏/被盖住/未发布）没有指纹，给 `null`。 */
  revision: string | null
  enabled: boolean
  favorite: boolean
  status: ExpertCatalogStatus
  /** 全部原因（不是只有决定状态的那条）。 */
  issues: ExpertIssue[]
  provenance: ExpertProvenance | null
  provenanceState: ExpertProvenanceState
  requiredSkills: ExpertCatalogRequiredSkill[]
}

/** 技能定义的复核结果（`skills.get(name)` 拿不到定义 = 这条技能加载不了）。 */
export type SkillDefinitionCheck = { ok: true } | { ok: false; message: string }

/** 一次判定用的技能上下文（投影 + 可选的 `get` 复核结果 + scope 硬错误）。 */
export interface ExpertCatalogSkillContext {
  projection: WorkbenchSkillProjection
  /** 名字 → 定义复核结果；缺 = 没查（服务没有 `get`，或调用方关掉了复核）。 */
  definitions?: ReadonlyMap<string, SkillDefinitionCheck>
  /** 有 live agent 但拿不到 scope 层（`skill-scope-unavailable`）。 */
  scopeProblem?: ExpertIssue
}

/** 目录构建的**原料**：一次发现 + 每个受管人格声明的技能需求。 */
export interface ExpertCatalogSources {
  roots: ExpertRoots
  library: PersonaLibraryOptions
  discovery: PersonaDiscovery
  /** 按人格 id 归并的技能需求（只有受管、已发布的人格才有）。 */
  requirements: Record<string, ExpertSkillRequirement[]>
  /** 来源级问题（根读不了、跳过 N 项、数量/深度上限……没有具体 id 的那些）。 */
  issues: ExpertIssue[]
}

export interface ExpertCatalogDocument {
  /**
   * 全部行。**同一 id 的第一行是生效行**（其余是被盖掉/读坏的同名文档，各自成行）。
   */
  rows: ExpertCatalogRow[]
  /** 生效用法摘要：`status === 'usable'` 的那些（既有 `PersonaSummary` 形状，直接给界面）。 */
  personas: PersonaSummary[]
  /** 来源级问题（不含行内问题）。 */
  issues: ExpertIssue[]
  /** 每个生效人格声明的技能需求（按 id），供 preflight 复用同一套解析。 */
  requirements: Record<string, ExpertSkillRequirement[]>
  skillsAvailable: boolean
  preliminary: boolean
}

export interface ExpertCatalogRootOverrides {
  /** 工作台人格根（受管专家正式位置）。 */
  personasDir?: string
  /** 工作台技能根。 */
  skillsDir?: string
  /** 三级角色库覆盖（不给就用 `personasDir` / 包内资产 / 设置项）。 */
  userDir?: string
  externalDir?: string
  builtinDir?: string
  /** 用户主目录（只给测试）。 */
  home?: string
  /** 大小写口径（只给测试）。 */
  platform?: string
}

export interface ExpertCatalogSourcesInput {
  db: DatabaseSync
  roots?: ExpertCatalogRootOverrides
}

export interface ExpertCatalogRowsInput {
  sources: ExpertCatalogSources
  skills?: ExpertCatalogSkillContext
  /** 是否用技能上下文判 `required` 技能可用性；`false` = 只算结构性状态（自主召唤提示用）。 */
  checkSkills?: boolean
}

export interface ExpertCatalogInput extends ExpertCatalogSourcesInput {
  /** 软探测得到的 skills 服务（`probeExpertSkills(ctx)`）。 */
  skills?: SkillsServiceLike
  /** 已经取好的投影（P5 缓存/snapshot）；给了就不再调 `list`。 */
  projection?: WorkbenchSkillProjection
  /** live agent（HTTP 无 → `undefined`，判定标 `preliminary`）。 */
  agent?: unknown
  signal?: AbortSignal
  /** 已加载的 scope helper（每请求加载一次后传进来，避免重复动态 import）。 */
  scopeHelper?: ScopeHelper
  /** 是否再用 `skills.get` 复核定义（缺省 `true`；服务没有 `get` 时自动跳过）。 */
  verifyDefinitions?: boolean
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function issue(code: string, field: string, message: string): ExpertIssue {
  return { code, field, message }
}

function diagnosticToIssue(diagnostic: PersonaDiagnostic, field: string): ExpertIssue {
  return { code: diagnostic.code, field, message: diagnostic.message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function resolveCatalogRoots(db: DatabaseSync, overrides: ExpertCatalogRootOverrides = {}): {
  roots: ExpertRoots
  library: PersonaLibraryOptions
} {
  const roots = resolveExpertRoots({
    home: overrides.home,
    personasDir: overrides.personasDir,
    skillsDir: overrides.skillsDir,
  })
  /**
   * 复用角色域的**唯一**根解析（设置项 + 用户主目录 + 包内资产），只把工作台人格根接成
   * 用户根缺省值 —— 受管专家正是装在那里，两处各算一遍必然漂移。
   */
  const library = personaLookupOptions(db, {
    builtinDir: overrides.builtinDir,
    userDir: overrides.userDir ?? roots.personasDir,
    home: overrides.home,
    platform: overrides.platform,
  })
  if (overrides.externalDir !== undefined) library.externalDir = overrides.externalDir
  return { roots, library }
}

// ---------------------------------------------------------------------------
// 原料收集
// ---------------------------------------------------------------------------

/** 只接受形状完整的技能需求（草稿里的坏条目不能变成"人格要一个不存在的技能"）。 */
function readSkillRequirement(raw: unknown): ExpertSkillRequirement | undefined {
  if (isPlainObject(raw) === false) return undefined
  const name = readString(raw.name)
  if (name === undefined) return undefined
  const action = raw.action === 'reuse' ? 'reuse' : raw.action === 'install' ? 'install' : undefined
  if (action === undefined) return undefined
  return {
    name,
    required: raw.required === true,
    action,
    sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : null,
    packageFiles: Array.isArray(raw.packageFiles)
      ? raw.packageFiles.filter((item): item is string => typeof item === 'string')
      : [],
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  }
}

interface ManagedPersonaInfo {
  requirements: ExpertSkillRequirement[]
  issues: ExpertIssue[]
}

/**
 * 读一个受管人格的发布记录并取它声明的技能需求。
 *
 * 读不到草稿行**不是**"人格不可用"：人格已经装好、发布门已就绪，只是我们没法复核技能需求。
 * 所以这种情况只给一条说明（`draft-not-found`），不影响状态。
 */
function readManagedPersonaInfo(db: DatabaseSync, personasDir: string, expertId: string): ManagedPersonaInfo {
  const publication = readManagedPersonaPublication(personasDir, expertId)
  if (publication.ok === false) return { requirements: [], issues: [] }
  const draftId = publication.publication.installationId
  const draft = getExpertDraft(db, draftId)
  if (draft === undefined) {
    return {
      requirements: [],
      issues: [issue(
        'draft-not-found',
        expertId,
        `受管人格「${expertId}」的安装草稿（installationId=${draftId}）已不在库里，无法复核它声明的技能需求；人格本身仍按已发布处理`,
      )],
    }
  }
  const payload = draft.payload as unknown as ExpertDraftPayload
  const raw = Array.isArray(payload?.skills) ? payload.skills : []
  const requirements: ExpertSkillRequirement[] = []
  const problems: ExpertIssue[] = []
  let dropped = 0
  for (const item of raw) {
    const requirement = readSkillRequirement(item)
    if (requirement === undefined) {
      dropped += 1
      continue
    }
    requirements.push(requirement)
  }
  if (dropped > 0) {
    problems.push(issue(
      'invalid-payload',
      'expert.skills',
      `受管人格「${expertId}」的技能需求里有 ${dropped} 条形状不对，已忽略（不拿坏条目去判可用性）`,
    ))
  }
  return { requirements, issues: problems }
}

/**
 * 读来源登记（`generated/<uuid>/provenance.json`）。
 *
 * 只对**受管 id** 生效：内置/外部/手工放进用户根的角色没有这份文件，也**不该有** ——
 * 它们是 `unrecorded`（不补猜上游），不是 `invalid`。
 *
 * @param installIncomplete 该文档的发布门本来就没就绪：这时来源登记读不到是**预期**的，
 *   不再多给一条问题（上面已经有一条 `installation-incomplete` 说明为什么）。
 */
function readProvenance(
  personasDir: string,
  expertId: string,
  installIncomplete: boolean,
): { provenance: ExpertProvenance | null; state: ExpertProvenanceState; issues: ExpertIssue[] } {
  if (isManagedPersonaId(expertId) === false) return { provenance: null, state: 'unrecorded', issues: [] }
  const relativePath = `${managedPersonaDirectoryPath(expertId)}/${EXPERT_PROVENANCE_FILE_NAME}`
  const read = readExpertTextFile(personasDir, relativePath, { maxBytes: 64 * 1024 })
  if (read.ok === false || read.text === undefined) {
    return {
      provenance: null,
      state: 'invalid',
      issues: installIncomplete
        ? []
        : [issue(
          'installation-incomplete',
          relativePath,
          `受管人格「${expertId}」的来源登记读不到（${read.problem?.message ?? '未知原因'}）：这份文档的来源无法追溯，按未完成安装处理`,
        )],
    }
  }
  const parsed = parseExpertProvenance(read.text)
  if (parsed.ok === false) {
    return {
      provenance: null,
      state: 'invalid',
      issues: installIncomplete
        ? []
        : parsed.errors.map((problem) => issue('installation-incomplete', relativePath, problem.message)),
    }
  }
  return {
    provenance: parsed.provenance,
    state: 'recorded',
    issues: parsed.warnings.map((problem) => issue(problem.code, relativePath, problem.message)),
  }
}

/** 草稿正在装、或上次装失败时给一条人能读懂的补充说明（只读，绝不据此改动任何东西）。 */
function readPendingInstallNote(personasDir: string, expertId: string): string | undefined {
  const pendingDir = join(personasDir, EXPERT_PENDING_DIR_NAME)
  let entries: string[]
  try {
    entries = readdirSync(pendingDir)
  } catch {
    return undefined
  }
  for (const name of entries) {
    let raw: string
    try {
      raw = readFileSync(join(pendingDir, name, EXPERT_INSTALL_JOURNAL_FILE_NAME), 'utf8')
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(raw) as { expertId?: unknown; phase?: unknown }
      if (parsed.expertId !== expertId) continue
      return `；待确认的安装草稿 ${name} 当前阶段 ${String(parsed.phase ?? '未知')}`
    } catch {
      continue
    }
  }
  return undefined
}

/** 收集一次目录构建所需的全部原料（发现 + 需求 + 来源级问题）。 */
export function collectExpertCatalogSources(input: ExpertCatalogSourcesInput): ExpertCatalogSources {
  const { roots, library } = resolveCatalogRoots(input.db, input.roots)
  const discovery = discoverPersonas(library)
  const requirements: Record<string, ExpertSkillRequirement[]> = {}
  const issues: ExpertIssue[] = []
  for (const diagnostic of discovery.diagnostics) {
    if (diagnostic.id !== undefined) continue
    issues.push(diagnosticToIssue(diagnostic, diagnostic.path ?? diagnostic.sourceKey ?? 'persona'))
  }
  for (const summary of discovery.personas) {
    if (summary.source !== 'user' || isManagedPersonaId(summary.id) === false) continue
    const info = readManagedPersonaInfo(input.db, roots.personasDir, summary.id)
    requirements[summary.id] = info.requirements
    for (const problem of info.issues) issues.push(problem)
  }
  return { roots, library, discovery, requirements, issues }
}

// ---------------------------------------------------------------------------
// 技能判定
// ---------------------------------------------------------------------------

/** 一条技能需求的判定结果（预检与目录共用）。 */
export interface ExpertEffectiveSkill {
  name: string
  required: boolean
  action: 'install' | 'reuse'
  available: boolean
  /** 实际生效的实现（`null` = 没有）。 */
  provider: string | null
  /** 实际生效实现的来源（`null` = 没有）。 */
  source: string | null
  modelInvocable: boolean
  preliminary: boolean
  /** 生效的不是工作台下载的那一份（用户/项目里的同名技能盖住了它）。 */
  shadowed: boolean
}

interface RequirementEvaluation {
  effective: ExpertEffectiveSkill[]
  issues: ExpertIssue[]
  /** 有 `required` 技能不可用（决定 `dependency-unavailable`）。 */
  missingRequired: boolean
}

function isWorkbenchVersion(entry: WorkbenchSkillProjectionEntry | undefined): boolean {
  return entry !== undefined && entry.provider === WORKBENCH_SKILL_PROVIDER_NAME
}

/** 没做技能判定时的空结果（**不是**"技能不可用"）。 */
const SKIPPED_EVALUATION: RequirementEvaluation = { effective: [], issues: [], missingRequired: false }

function evaluateRequirements(
  requirements: readonly ExpertSkillRequirement[],
  skills: ExpertCatalogSkillContext | undefined,
  checkSkills = true,
): RequirementEvaluation {
  if (checkSkills === false) return SKIPPED_EVALUATION
  const effective: ExpertEffectiveSkill[] = []
  const issues: ExpertIssue[] = []
  let missingRequired = false
  /**
   * scope 拿不到就**整批**判不可用：全局视角可能漏掉 Agent 层的覆盖，
   * 拿它当权威正是"预检通过、执行时找不到技能"的成因。
   */
  const scopeProblem = skills?.scopeProblem
  for (const requirement of requirements) {
    const name = requirement.name
    const field = `skill.${name}`
    const entry = skills?.projection.findEntry(name)
    const definition = skills?.definitions?.get(name)
    const modelInvocable = entry?.modelInvocable === true
    const preliminary = scopeProblem !== undefined
      || skills === undefined
      || skills.projection.preliminary
    const shadowed = requirement.action === 'install' && entry !== undefined && isWorkbenchVersion(entry) === false
    let available = false
    let reason: ExpertIssue | undefined
    if (scopeProblem !== undefined) {
      reason = issue(scopeProblem.code, field, `${scopeProblem.message}（技能「${name}」的可用性无法按 Agent scope 判定）`)
    } else if (skills === undefined || skills.projection.available === false) {
      const detail = skills?.projection.issues[0]?.message
      reason = issue(
        'skill-service-unavailable',
        field,
        `当前没有可用的 skills 服务，无法确认技能「${name}」是否存在${detail === undefined ? '' : `（${detail}）`}`,
      )
    } else if (entry === undefined) {
      reason = issue('required-skill-unavailable', field, `技能库当前 scope 下没有技能「${name}」`)
    } else if (modelInvocable === false) {
      reason = issue('required-skill-unavailable', field, `技能「${name}」不允许模型调用（modelInvocable=false），不能作为专家技能`)
    } else if (definition !== undefined && definition.ok === false) {
      reason = issue('required-skill-unavailable', field, `技能「${name}」的正文取不回来：${definition.message}`)
    } else {
      available = true
    }
    if (available && shadowed) {
      issues.push(issue(
        'skill-shadowed',
        field,
        `技能「${name}」当前生效的是 ${String(entry?.provider ?? '未知')} 的实现（工作台装的那份被更高优先级的同名技能盖住）；不强行改名绕过用户覆盖`,
      ))
    }
    if (available === false && reason !== undefined) {
      /**
       * `required` 不可用是错误（挡执行）；可选技能只警告 —— 可选技能缺失不该让整个专家变成
       * 不可用（那会把"少一个辅助能力"说成"这个人不能用"）。
       */
      const fatal = requirement.required === true
      if (fatal) missingRequired = true
      issues.push({
        code: reason.code,
        field: reason.field,
        message: fatal ? reason.message : `${reason.message}（可选技能，仅提示）`,
      })
    }
    effective.push({
      name,
      required: requirement.required === true,
      action: requirement.action,
      available,
      provider: entry?.provider ?? null,
      source: entry?.source ?? null,
      modelInvocable,
      preliminary,
      shadowed,
    })
  }
  return { effective, issues, missingRequired }
}

// ---------------------------------------------------------------------------
// 行构建
// ---------------------------------------------------------------------------

interface RowContext {
  sources: ExpertCatalogSources
  skills?: ExpertCatalogSkillContext
  /**
   * 是否**真的**做技能判定。
   *
   * 这一位和"`skills` 是不是 undefined"是两件事：
   * - `checkSkills: false`（自主召唤提示）：没查过技能，**不能**把"没查"当"不可用"；
   * - `checkSkills: true` 且 `skills === undefined`（没有 skills 服务）：那才是真的不可用。
   */
  checkSkills: boolean
  /** `key = sourceKey \u0000 id` → 该文档的全部诊断。 */
  byDocument: Map<string, PersonaDiagnostic[]>
  sourceKindByKey: Map<string, PersonaSourceKind>
  disabledKeys: Set<string>
  favoriteKeys: Set<string>
  platform: string
}

function documentKey(sourceKey: string, id: string): string {
  return `${sourceKey}\u0000${id}`
}

function sourceKindOf(context: RowContext, sourceKey: string): PersonaSourceKind {
  /**
   * 理论上不可达：诊断只可能来自 `discoverPersonas` 已登记的来源。
   * 真出现就落到 `user`（唯一可能带受管发布门的来源），而不是凭空造一个来源类型。
   */
  return context.sourceKindByKey.get(sourceKey) ?? 'user'
}

/** 显示名：读坏的文件用**相对文件名**（用户能按名字找到那个文件）。 */
function displayNameForDiagnostics(context: RowContext, diagnostic: PersonaDiagnostic, id: string): string {
  const path = diagnostic.path
  if (path === undefined) return id
  /**
   * `PersonaLibrarySource` 不带 sourceKey（那是发现时为每个根算出来的），所以这里用**同一个**
   * `sourceKeyForRoot` 反查根 —— 自己拼一份 key 必然与发现链漂移。
   */
  const sourceRoot = context.sources.discovery.sources
    .find((source) => sourceKeyForRoot(source.kind, source.root, context.platform) === diagnostic.sourceKey)?.root
  if (sourceRoot !== undefined) {
    const relativePath = relative(resolve(sourceRoot), resolve(path))
    if (relativePath !== '' && relativePath.startsWith('..') === false) {
      return relativePath.split(sep).join('/')
    }
  }
  return basename(path)
}

function buildWinnerRow(context: RowContext, summary: PersonaSummary): ExpertCatalogRow {
  const managed = summary.source === 'user' && isManagedPersonaId(summary.id)
  const diagnostics = context.byDocument.get(documentKey(summary.sourceKey, summary.id)) ?? []
  const issues: ExpertIssue[] = diagnostics.map((diagnostic) => diagnosticToIssue(diagnostic, summary.sourceKey))
  const provenance = managed
    ? readProvenance(context.sources.roots.personasDir, summary.id, false)
    : { provenance: null, state: 'unrecorded' as ExpertProvenanceState, issues: [] as ExpertIssue[] }
  issues.push(...provenance.issues)
  const requirements = context.sources.requirements[summary.id] ?? []
  const evaluation = evaluateRequirements(requirements, context.skills, context.checkSkills)
  issues.push(...evaluation.issues)

  /** 状态优先级（§9.1）：installation-incomplete → invalid → disabled → dependency-unavailable → usable。 */
  let status: ExpertCatalogStatus = 'usable'
  if (
    provenance.state === 'invalid'
    || diagnostics.some((diagnostic) => diagnostic.code === 'installation-incomplete')
  ) {
    status = 'installation-incomplete'
  } else if (summary.enabled === false) {
    status = 'disabled'
  } else if (evaluation.missingRequired) {
    status = 'dependency-unavailable'
  }
  return {
    id: summary.id,
    name: summary.name,
    description: summary.description,
    group: summary.group,
    source: summary.source,
    sourceKey: summary.sourceKey,
    revision: summary.revision,
    enabled: summary.enabled,
    favorite: summary.favorite,
    status,
    issues,
    provenance: provenance.provenance,
    provenanceState: provenance.state,
    requiredSkills: evaluation.effective
      .filter((skill) => skill.required)
      .map((skill) => ({
        name: skill.name,
        available: skill.available,
        provider: skill.provider,
        preliminary: skill.preliminary,
      })),
  }
}

function buildDiagnosticRow(
  context: RowContext,
  id: string,
  sourceKey: string,
  diagnostics: PersonaDiagnostic[],
): ExpertCatalogRow {
  const incomplete = diagnostics.some((diagnostic) => diagnostic.code === 'installation-incomplete')
  const overridden = diagnostics.every((diagnostic) => diagnostic.code === 'duplicate-id-overridden')
  const issues = diagnostics.map((diagnostic) => diagnosticToIssue(diagnostic, sourceKey))
  if (incomplete) {
    /** 受管安装没就绪时顺手说清楚"装到哪一步了"（只读 journal，不改任何东西）。 */
    const note = readPendingInstallNote(context.sources.roots.personasDir, id)
    if (note !== undefined) {
      for (const problem of issues) {
        if (problem.code === 'installation-incomplete') problem.message = `${problem.message}${note}`
      }
    }
  }
  const managed = sourceKindOf(context, sourceKey) === 'user' && isManagedPersonaId(id)
  const provenance = managed
    ? readProvenance(context.sources.roots.personasDir, id, incomplete)
    : { provenance: null, state: 'unrecorded' as ExpertProvenanceState, issues: [] as ExpertIssue[] }
  issues.push(...provenance.issues)
  const key = personaCompareKey(id, context.platform)
  const enabled = context.disabledKeys.has(key) === false && overridden === false

  let status: ExpertCatalogStatus
  if (incomplete || provenance.state === 'invalid') status = 'installation-incomplete'
  else if (overridden) status = 'disabled'
  else status = 'invalid'

  const named = diagnostics.find((diagnostic) => diagnostic.path !== undefined)
  return {
    id,
    name: named === undefined ? id : displayNameForDiagnostics(context, named, id),
    description: '',
    group: personaGroupForId(id),
    source: sourceKindOf(context, sourceKey),
    sourceKey,
    revision: null,
    enabled,
    favorite: context.favoriteKeys.has(key),
    status,
    issues,
    provenance: provenance.provenance,
    provenanceState: provenance.state,
    requiredSkills: [],
  }
}

/**
 * 由原料构造全部行（**同步**：自主召唤提示的 text 回调必须是同步的）。
 *
 * `checkSkills === false` 时不看技能上下文：那条路径（提示词摘要）本身不做技能预检，
 * 也就**不能**把"没查过"当成"不可用"。
 */
export function buildExpertCatalogRows(input: ExpertCatalogRowsInput): ExpertCatalogDocument {
  const { sources } = input
  const platform = sources.library.platform ?? process.platform
  const skills = input.checkSkills === false ? undefined : input.skills
  const byDocument = new Map<string, PersonaDiagnostic[]>()
  for (const diagnostic of sources.discovery.diagnostics) {
    if (diagnostic.id === undefined) continue
    const key = documentKey(diagnostic.sourceKey ?? '', diagnostic.id)
    const list = byDocument.get(key)
    if (list === undefined) byDocument.set(key, [diagnostic])
    else list.push(diagnostic)
  }
  const context: RowContext = {
    sources,
    skills,
    checkSkills: input.checkSkills !== false,
    byDocument,
    sourceKindByKey: new Map(sources.discovery.sources
      .map((source) => [sourceKeyForRoot(source.kind, source.root, platform), source.kind] as const)),
    disabledKeys: new Set((sources.library.disabledIds ?? []).map((id) => personaCompareKey(id, platform))),
    favoriteKeys: new Set((sources.library.favorites ?? []).map((id) => personaCompareKey(id, platform))),
    platform,
  }

  const rows: ExpertCatalogRow[] = []
  const personas: PersonaSummary[] = []
  const covered = new Set<string>()
  for (const summary of sources.discovery.personas) {
    const row = buildWinnerRow(context, summary)
    rows.push(row)
    covered.add(documentKey(summary.sourceKey, summary.id))
    if (row.status === 'usable') personas.push(summary)
  }

  const diagnosticRows: ExpertCatalogRow[] = []
  for (const [key, diagnostics] of byDocument) {
    if (covered.has(key)) continue
    const separator = key.indexOf('\u0000')
    const sourceKey = key.slice(0, separator)
    const id = key.slice(separator + 1)
    diagnosticRows.push(buildDiagnosticRow(context, id, sourceKey, diagnostics))
  }
  diagnosticRows.sort((left, right) => {
    if (left.id !== right.id) return left.id < right.id ? -1 : 1
    return left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0
  })
  rows.push(...diagnosticRows)

  return {
    rows,
    personas,
    issues: sources.issues,
    requirements: sources.requirements,
    skillsAvailable: skills?.projection.available ?? false,
    preliminary: skills === undefined
      ? true
      : skills.scopeProblem !== undefined || skills.projection.preliminary,
  }
}

// ---------------------------------------------------------------------------
// 异步层：拿 skills 服务 / scope / 定义复核
// ---------------------------------------------------------------------------

function distinctRequirementNames(sources: ExpertCatalogSources): string[] {
  const names = new Set<string>()
  for (const requirements of Object.values(sources.requirements)) {
    for (const requirement of requirements) names.add(requirement.name)
  }
  return [...names].sort()
}

/**
 * 构造本次判定用的技能上下文。
 *
 * 四处关键口径：
 * 1. `scope` 一律来自 `scopeOf(agent.ctx)`（有 live agent 时），**不是**省略 scope 的全局调用；
 * 2. `cwd` 来自 `agent.session.header.cwd`；`signal` 原样透传（可取消的调用必须真能取消）；
 * 3. 服务没有 `get` 就**跳过**定义复核（不把"这个服务没实现 get"判成技能不存在）；
 * 4. 定义复核只对**注册表里真有**的名字做（列表里没有的名字已经判不可用了）。
 */
export async function buildExpertCatalogSkillContext(
  input: ExpertCatalogInput,
  sources: ExpertCatalogSources,
): Promise<ExpertCatalogSkillContext> {
  if (input.projection !== undefined) {
    return withDefinitions(input, sources, { projection: input.projection })
  }
  const scope = await resolveLiveAgentScope(input.agent, input.scopeHelper)
  const cwd = readLiveAgentCwd(input.agent)
  const projection = await projectWorkbenchSkillRegistry(input.skills, {
    scope: scope.scope,
    ...(cwd === undefined ? {} : { cwd }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  return withDefinitions(input, sources, {
    projection,
    ...(scope.problem === undefined ? {} : { scopeProblem: scope.problem }),
  })
}

async function withDefinitions(
  input: ExpertCatalogInput,
  sources: ExpertCatalogSources,
  base: { projection: WorkbenchSkillProjection; scopeProblem?: ExpertIssue },
): Promise<ExpertCatalogSkillContext> {
  const service = input.skills
  const getDefinition = service?.get
  if (input.verifyDefinitions === false || typeof getDefinition !== 'function') return base
  if (base.projection.available === false) return base
  const definitions = new Map<string, SkillDefinitionCheck>()
  for (const name of distinctRequirementNames(sources)) {
    if (base.projection.findEntry(name) === undefined) continue
    try {
      const definition = await getDefinition.call(service, name, scopedOptions(input, base.projection.scope))
      definitions.set(name, definition === undefined || definition === null
        ? { ok: false, message: '注册表里有这条技能，但 get(name) 取不到定义' }
        : { ok: true })
    } catch (error) {
      definitions.set(name, { ok: false, message: `get(name) 调用失败：${(error as Error).message}` })
    }
  }
  return { ...base, definitions }
}

function scopedOptions(input: ExpertCatalogInput, scope: unknown): {
  scope?: unknown
  cwd?: string
  signal?: AbortSignal
} {
  const cwd = readLiveAgentCwd(input.agent)
  return {
    scope,
    ...(cwd === undefined ? {} : { cwd }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
}

/** 列专家目录（HTTP `GET catalog` 走这条）。 */
export async function listExpertCatalog(input: ExpertCatalogInput): Promise<ExpertCatalogDocument> {
  const sources = collectExpertCatalogSources(input)
  const skills = await buildExpertCatalogSkillContext(input, sources)
  return buildExpertCatalogRows({ sources, skills, checkSkills: true })
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

export interface ExpertPreflightInput extends ExpertCatalogInput {
  personaId: string
}

export interface ExpertPreflightResult {
  personaId: string
  /** 能不能绑上去跑（`status === 'usable'` 且**所有 required 技能确实可用**）。 */
  usable: boolean
  status: ExpertCatalogStatus
  issues: ExpertIssue[]
  /** 这次预检涉及的技能（含可选），带实际生效的 provider/source。 */
  effectiveSkills: ExpertEffectiveSkill[]
  /** 判定视角降级（没有 live agent / 没有真实 scope 层）时为 `true`。 */
  preliminary: boolean
  /** 生效行的摘要（绑定/展示要用的那份）。找不到对应行时为 `null`。 */
  summary: PersonaSummary | null
}

/**
 * 运行前预检：人格在不在、可不可用、它要的技能此刻在不在。
 *
 * 与 catalog **共用同一套解析**（发现 + 受管需求 + 状态判定），只是额外把每个技能需求的
 * 实际情况摊开（`effectiveSkills`）。必需技能不可用 → `usable: false`（绝不返回"通过"）。
 */
export async function preflightExpert(input: ExpertPreflightInput): Promise<ExpertPreflightResult> {
  const sources = collectExpertCatalogSources(input)
  const skills = await buildExpertCatalogSkillContext(input, sources)
  const document = buildExpertCatalogRows({ sources, skills, checkSkills: true })
  /** 同一 id 的第一行是生效行（见模块头部的行序约定）。 */
  const row = document.rows.find((candidate) => candidate.id === input.personaId)
  const preliminary = skills.scopeProblem !== undefined || skills.projection.preliminary
  if (row === undefined) {
    return {
      personaId: input.personaId,
      usable: false,
      status: 'invalid',
      issues: [issue('expert-not-found', input.personaId, `角色库里没有 id 为「${input.personaId}」的专家（已发现的都不可用或不存在）`)],
      effectiveSkills: [],
      preliminary,
      summary: null,
    }
  }
  const requirements = document.requirements[row.id] ?? []
  const evaluation = evaluateRequirements(requirements, skills)
  const summary = sources.discovery.personas
    .find((candidate) => candidate.id === row.id && candidate.sourceKey === row.sourceKey) ?? null
  return {
    personaId: input.personaId,
    usable: row.status === 'usable' && evaluation.missingRequired === false,
    status: row.status,
    issues: row.issues,
    effectiveSkills: evaluation.effective,
    preliminary,
    summary,
  }
}

// ---------------------------------------------------------------------------
// 自主召唤提示
// ---------------------------------------------------------------------------

export const AUTO_EXPERT_PROMPT_BLOCK_NAME = 'plugin:workbench-experts'
export const AUTO_EXPERT_PROMPT_ORDER = 320
/** 提示里最多列出多少个专家。 */
export const AUTO_EXPERT_PROMPT_MAX_ENTRIES = 30
/** 每条简介最多多少个字符。 */
export const AUTO_EXPERT_PROMPT_DESCRIPTION_MAX_CHARS = 80
/** 提示区块总文本上限（字符）。 */
export const AUTO_EXPERT_PROMPT_MAX_TOTAL_CHARS = 6000

export interface AutoExpertPromptInput {
  db: DatabaseSync
  roots?: ExpertCatalogRootOverrides
  maxEntries?: number
  maxDescriptionChars?: number
  maxTotalChars?: number
}

/** 提示区块（`interpolate: false` 是**类型级**约束：调用点写不出 `true`）。 */
export interface AutoExpertPromptBlock {
  name: string
  order: number
  interpolate: false
  text: string
  /** 实际列出多少条 / 候选总数（便于测试与日志；不影响宿主行为）。 */
  listed: number
  total: number
  truncated: boolean
}

function truncateDescription(description: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (description.length <= maxChars) return description
  if (maxChars === 1) return '…'
  return `${description.slice(0, maxChars - 1)}…`
}

/**
 * 造"可召唤专家"提示区块。
 *
 * 规则（§8.2）：
 * - **每次 assemble 重读**（这里同步读盘，绝不缓存摘要 —— 缓存会让刚装的专家直到重启才出现）；
 * - 收藏优先、再按 ID 排序，最多 `maxEntries`（缺省 30）条；
 * - 每条简介截到 `maxDescriptionChars`（缺省 80）字符，总文本不超过 `maxTotalChars`（缺省 6000）；
 * - 明确写出"仅列出前 N 条 / 共 M 条，更多由用户 @ 指定"；
 * - `interpolate: false`：专家名称/简介里的花括号或标签**不得**被当成模板变量。
 *
 * 这份摘要**不是**权限或技能可用性的最终证明（这里不做技能预检）：真正的执行仍走
 * `preflightExpert`。P6 负责按 `readExpertSettings(db).autoSummonExperts` 决定要不要注册这个区块。
 */
export function buildAutoExpertPrompt(input: AutoExpertPromptInput): AutoExpertPromptBlock {
  const maxEntries = input.maxEntries ?? AUTO_EXPERT_PROMPT_MAX_ENTRIES
  const maxDescriptionChars = input.maxDescriptionChars ?? AUTO_EXPERT_PROMPT_DESCRIPTION_MAX_CHARS
  const maxTotalChars = input.maxTotalChars ?? AUTO_EXPERT_PROMPT_MAX_TOTAL_CHARS
  const sources = collectExpertCatalogSources(input)
  const document = buildExpertCatalogRows({ sources, checkSkills: false })
  const candidates = document.rows.filter((row) => row.status === 'usable' && row.enabled)
  candidates.sort((left, right) => {
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const total = candidates.length
  const selected = candidates.slice(0, Math.max(0, maxEntries))
  const head = `下面是可以召唤的专家角色（收藏优先；最多列出 ${maxEntries} 条，每行「名称（id）」后附简介）。`
  const lines = selected.map((row) => `- ${row.name}（${row.id}）：${truncateDescription(row.description, maxDescriptionChars)}`)
  const footer = (listed: number): string =>
    `\n仅列出前 ${listed} 条 / 共 ${total} 条；更多角色可由用户用 @ 显式指定。`

  let listed = lines.length
  let text = `${head}\n${lines.join('\n')}${footer(listed)}`
  while (listed > 0 && text.length > maxTotalChars) {
    listed -= 1
    text = `${head}\n${lines.slice(0, listed).join('\n')}${footer(listed)}`
  }
  if (text.length > maxTotalChars) {
    /** 极端配置（上限比头部还小）：截到上限，宁可少说也不超限。 */
    text = text.slice(0, Math.max(0, maxTotalChars))
  }
  return {
    name: AUTO_EXPERT_PROMPT_BLOCK_NAME,
    order: AUTO_EXPERT_PROMPT_ORDER,
    interpolate: false,
    text,
    listed,
    total,
    truncated: listed < total,
  }
}
