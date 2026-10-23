# P4 交接：skill provider / catalog / 运行前依赖预检

- **批次**：P4（`implementation-plan.md:146-180`），前置 P3 已通过。
- **执行日期**：2026-10-05（P4 首次交付 → 主会话复核 → 一轮最小修复 → 主会话独立复跑与独立证据）。
- **批次边界（未做，故意不做）**：**未接生产装配** —— `src/index.ts`、`src/tools.ts`、`src/api/**`、`src/client/**` 一字未动（`git status --porcelain -- src/index.ts src/tools.ts src/api src/client` 为空）。顶层 `ctx.inject(['skills'])` 子 fiber、HTTP 路由、systemPrompt 装配、客户端界面全部属于 P5/P6/P8。
- **P1–P3 文件**：本批**零改动**（`install.ts`/`managed.ts`/`drafts.ts`/`paths.ts`/`expert.ts`/`library.ts` 等均未触碰）。

## 1. 交付物

| 文件 | 行数 | 状态 | 说明 |
|---|---|---|---|
| `src/experts/skill-provider.ts` | 673 | 新增 | 工作台 skill provider（rank 600、`source='bundled'`、`locator={name,packageHash}`） |
| `src/experts/host-adapter.ts` | 404 | 新增 | 软探测 skills 服务 + scope 解析 + 注册表投影 |
| `src/experts/catalog.ts` | 963 | 新增 | 目录行 / preflight / 自主召唤提示区块 |
| `test/expertProvider.test.mjs` | 933 | 新增（18 test） | AX-E24–E28、E49、§7.1、§7.3 |
| `test/expertCatalog.test.mjs` | 780 | 新增（12 test） | AX-E29、E30、E26/E49 传参、提示区块 |
| `test/fixtures/expertSkillFixture.mjs` | 72 | 新增 | 受管技能清单夹具（**真实哈希**，两个测试文件共用） |
| `package.json` | 109 | 修改 | 仅 3 处：peer `@deepseek-ai/dsh-scope: ^0.1.0-rc.1 \|\| ^0.2.0-rc.1`；新建 `peerDependenciesMeta`（**只**把 dsh-scope 标 `optional:true`）；devDependency `@deepseek-ai/dsh-scope: 0.2.0-rc.2` |
| `pnpm-lock.yaml` | 1200 | 修改 | +3 行（对应的 lock 条目） |
| `tsconfig.build.json` | 81 | 修改 | include 追加 3 个新源文件（**显式清单，后续每加源文件都要追加**，否则 `node --test` import `lib/**` 会 `ERR_MODULE_NOT_FOUND`） |
| `docs/tasks/ed644638-…/evidence/p4-provider-real-install.mjs` | 300 行 | 新增 | **独立证据**：真实安装器 → 真实 provider（见 §5） |

`version` / `files` / `scripts` 未改；未新增第三方 DSH 插件；**未**把 `@deepseek-ai/dsh-skill` 写成依赖，也未在任何地方静态 import 宿主 runtime（见 §4）。

## 2. 逐字导出签名（P5 直接照抄）

### `src/experts/skill-provider.ts`

```ts
export const WORKBENCH_SKILL_PROVIDER_NAME = 'personal-workbench'
export const WORKBENCH_SKILL_RANK = 600
export const WORKBENCH_SKILL_SOURCE = 'bundled'
export interface SkillInvocationPolicyLike { readonly modelInvocable: boolean; readonly userInvocable: boolean }
export interface SkillSummaryLike { readonly path?: string; readonly name: string; readonly description: string; readonly whenToUse?: string; readonly invocation: SkillInvocationPolicyLike; readonly source: string; readonly provider: string; readonly resourceBase?: SkillResourceBaseLike }
export interface SkillCandidateLike extends SkillSummaryLike { readonly rank: number; readonly locator: unknown; readonly metadata?: Readonly<Record<string, unknown>> }
export interface SkillDefinitionLike extends SkillSummaryLike { readonly content: string }
export interface SkillLookupOptionsLike { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined }
export interface SkillViewOptionsLike extends SkillLookupOptionsLike { readonly scope?: unknown }
export interface SkillProviderObservationLike { readonly candidates: readonly SkillCandidateLike[]; readonly complete: boolean }
export interface SkillProviderLike { readonly name: string; readonly list: (options: SkillLookupOptionsLike) => Promise<readonly SkillCandidateLike[] | SkillProviderObservationLike>; readonly get: (candidate: SkillCandidateLike, options: SkillLookupOptionsLike) => Promise<SkillDefinitionLike | undefined> }
export interface SkillProviderControlLike { readonly signal: AbortSignal; readonly invalidate: () => void }
export interface SkillRegistrarLike { registerProvider(create: (control: SkillProviderControlLike) => SkillProviderLike): () => void }
export interface SkillsServiceLike { list(options?: SkillViewOptionsLike): Promise<unknown>; get?(name: string, options?: SkillViewOptionsLike): Promise<unknown> }
export interface WorkbenchSkillLocator { readonly name: string; readonly packageHash: string }
export interface WorkbenchSkillDiagnostic extends ExpertIssue { skill?: string; path?: string }
export function readWorkbenchSkillProviderDiagnostics(source: unknown): readonly WorkbenchSkillDiagnostic[]
export interface WorkbenchSkillProviderDeps { skillsDir: string; personasDir: string; platform?: string; allowRootLinkUnder?: string; onDiagnostic?: (diagnostic: WorkbenchSkillDiagnostic) => void }
export function createWorkbenchSkillProvider(deps: WorkbenchSkillProviderDeps): (control: SkillProviderControlLike) => SkillProviderLike
export interface WorkbenchSkillRegistration { readonly providerName: string; readonly active: boolean; invalidateSkills(): boolean; readDiagnostics(): readonly WorkbenchSkillDiagnostic[]; dispose(): void }
export function registerWorkbenchSkillProvider(skills: SkillRegistrarLike, deps: WorkbenchSkillProviderDeps): WorkbenchSkillRegistration
export function invalidateWorkbenchSkills(registration: WorkbenchSkillRegistration | undefined): boolean
```

### `src/experts/host-adapter.ts`

```ts
export function probeExpertSkills(ctx: unknown): SkillsServiceLike | undefined
export interface ScopeHelper { scopeOf(ctx: unknown): unknown }
export type ScopeHelperLoadResult = { ok: true; helper: ScopeHelper } | { ok: false; problem: ExpertIssue }
export type ScopeImporter = (specifier: string) => Promise<unknown>
export async function loadScopeHelper(importer?: ScopeImporter): Promise<ScopeHelperLoadResult>
export interface ScopeResolution { scope: unknown; evaluated: boolean; resolved: boolean; problem?: ExpertIssue }
export function readLiveAgentContext(agent: unknown): unknown | undefined
export function readLiveAgentCwd(agent: unknown): string | undefined
export async function resolveLiveAgentScope(agent: unknown, helper?: ScopeHelper, importer?: ScopeImporter): Promise<ScopeResolution>
export function scopeOfAgent(agent: unknown, helper?: ScopeHelper): Promise<ScopeResolution>
export interface WorkbenchSkillProjectionEntry { name: string; description: string; whenToUse?: string; modelInvocable: boolean; userInvocable: boolean; provider: string; source: string; rank: number | null; locator: unknown; resourceBase?: SkillResourceBaseLike; path?: string }
export interface WorkbenchSkillProjection extends WorkbenchSkillRegistry { available: boolean; preliminary: boolean; entries: WorkbenchSkillProjectionEntry[]; issues: ExpertIssue[]; scope: unknown; complete: boolean; find(name: string): WorkbenchSkillRegistryEntry | undefined; findEntry(name: string): WorkbenchSkillProjectionEntry | undefined }
export function normalizeSkillProjectionEntry(raw: unknown): WorkbenchSkillProjectionEntry | undefined
export function readSkillEntryList(raw: unknown): { items: unknown[]; complete: boolean }
export function createWorkbenchSkillProjection(input: { entries: WorkbenchSkillProjectionEntry[]; available: boolean; preliminary?: boolean; issues?: ExpertIssue[]; scope?: unknown; complete?: boolean }): WorkbenchSkillProjection
export function unavailableSkillProjection(preliminary: boolean, message?: string): WorkbenchSkillProjection
export async function projectWorkbenchSkillRegistry(service: SkillsServiceLike | undefined, options?: ProjectWorkbenchSkillsOptions): Promise<WorkbenchSkillProjection>
```

`import('@deepseek-ai/dsh-scope')` **全仓只出现在本文件的 `defaultScopeImporter`**；第三参 `importer` 只给测试演"模块加载失败"。

### `src/experts/catalog.ts`

```ts
export type ExpertCatalogStatus = 'usable' | 'disabled' | 'invalid' | 'dependency-unavailable' | 'installation-incomplete'
export type ExpertProvenanceState = 'recorded' | 'unrecorded' | 'invalid'
export interface ExpertCatalogRequiredSkill { name: string; available: boolean; provider: string | null; preliminary: boolean }
export interface ExpertCatalogRow { id: string; name: string; description: string; group: string; source: PersonaSourceKind; sourceKey: string; revision: string | null; enabled: boolean; favorite: boolean; status: ExpertCatalogStatus; issues: ExpertIssue[]; provenance: ExpertProvenance | null; provenanceState: ExpertProvenanceState; requiredSkills: ExpertCatalogRequiredSkill[] }
export interface ExpertCatalogSkillContext { projection: WorkbenchSkillProjection; definitions?: ReadonlyMap<string, SkillDefinitionCheck>; scopeProblem?: ExpertIssue }
export interface ExpertCatalogDocument { rows: ExpertCatalogRow[]; personas: PersonaSummary[]; issues: ExpertIssue[]; requirements: Record<string, ExpertSkillRequirement[]>; skillsAvailable: boolean; preliminary: boolean }
export interface ExpertCatalogRootOverrides { personasDir?: string; skillsDir?: string; userDir?: string; externalDir?: string; builtinDir?: string; home?: string; platform?: string }
export interface ExpertCatalogInput { db: DatabaseSync; roots?: ExpertCatalogRootOverrides; skills?: SkillsServiceLike; projection?: WorkbenchSkillProjection; agent?: unknown; signal?: AbortSignal; scopeHelper?: ScopeHelper; verifyDefinitions?: boolean }
export function collectExpertCatalogSources(input: { db: DatabaseSync; roots?: ExpertCatalogRootOverrides }): ExpertCatalogSources
export interface ExpertEffectiveSkill { name: string; required: boolean; action: 'install' | 'reuse'; available: boolean; provider: string | null; source: string | null; modelInvocable: boolean; preliminary: boolean; shadowed: boolean }
export function buildExpertCatalogRows(input: { sources: ExpertCatalogSources; skills?: ExpertCatalogSkillContext; checkSkills?: boolean }): ExpertCatalogDocument
export async function buildExpertCatalogSkillContext(input: ExpertCatalogInput, sources: ExpertCatalogSources): Promise<ExpertCatalogSkillContext>
export async function listExpertCatalog(input: ExpertCatalogInput): Promise<ExpertCatalogDocument>
export interface ExpertPreflightInput extends ExpertCatalogInput { personaId: string }
export interface ExpertPreflightResult { personaId: string; usable: boolean; status: ExpertCatalogStatus; issues: ExpertIssue[]; effectiveSkills: ExpertEffectiveSkill[]; preliminary: boolean; summary: PersonaSummary | null }
export async function preflightExpert(input: ExpertPreflightInput): Promise<ExpertPreflightResult>
export const AUTO_EXPERT_PROMPT_BLOCK_NAME = 'plugin:workbench-experts'
export const AUTO_EXPERT_PROMPT_ORDER = 320
export const AUTO_EXPERT_PROMPT_MAX_ENTRIES = 30
export const AUTO_EXPERT_PROMPT_DESCRIPTION_MAX_CHARS = 80
export const AUTO_EXPERT_PROMPT_MAX_TOTAL_CHARS = 6000
export interface AutoExpertPromptInput { db: DatabaseSync; roots?: ExpertCatalogRootOverrides; maxEntries?: number; maxDescriptionChars?: number; maxTotalChars?: number }
export interface AutoExpertPromptBlock { name: string; order: number; interpolate: false; text: string; listed: number; total: number; truncated: boolean }
export function buildAutoExpertPrompt(input: AutoExpertPromptInput): AutoExpertPromptBlock
```

## 3. 命令与退出码（主会话独立复跑，2026-10-05）

同一条命令里顺序执行（**必须同一条**：外部会话的 `scripts/repro/probe-*-mutations.mjs` 会 `rmSync('lib')`，分开跑会赛跑）：

| 命令 | 退出码 | 输出 |
|---|---|---|
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm build` | 0 | buildId `wb-7fb1c7f63bec2961`（195 个输入文件；client `lib/client.js` 552.64 kB，gzip 163.91 kB） |
| `node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs` | 0 | `ℹ tests 45 / ℹ pass 45 / ℹ fail 0 / ℹ skipped 0`（18 provider + 12 catalog + 15 存量 skills） |
| `node --test`（11 个回归文件：expertInstall/expertRecovery/expertDrafts/expertSkillPackage/expertContracts/expertPaths/expertProvenance/personaLibrary/personaBinding/personaParse/capabilities） | 0 | `ℹ tests 207 / ℹ pass 207 / ℹ fail 0` |
| 独立证据脚本（见 §5） | 0 | `11/11 PASS` |

子代理自报的第一次回归抖动（`test/personaLibrary.test.mjs` 的 AX-R06 报 undici `bad port`）在主会话两次独立复跑中**均未复现**；该文件本批未改。

## 4. 关键实现事实（P5 接线前必须知道）

1. **注册与失效生命周期**：`createWorkbenchSkillProvider(deps)` 产出的工厂**只造一次**；`skills.registerProvider(create)` 的回调里**替换** `control`/`provider` 引用（重挂即弃旧控制器）。`invalidateSkills()` 仅在 `disposed===false && control!==undefined` 时 `try { control.invalidate(); return true } catch { return false }`；`dispose()` 先置 `disposed`、再断引用、最后 `unregister()`（幂等，先断引用再解注册）。`invalidateWorkbenchSkills(reg|undefined)` 是给 P3 `refreshSkills` 的薄封装。
2. **abort 语义**：闭包内读 `control.signal.aborted`；为真时 `list` 返回 `{candidates: [], complete: false}`、`get` 返回 `undefined`（子 fiber 卸载后不再扫盘）。
3. **`list` 的九道复核**（§7.2）：abort → 只扫 `skillsDir` 直接可见项 → 跳过 `.pending` 与 `.` 开头 → 链接 `path-link-forbidden` → 非目录/非法名 `invalid-path` → 受管技能必须 `readManagedSkillInstallState(...).ready===true`（未 ready 记 `installation-incomplete` 并跳过；`managed:false` 的旧手工技能放行）→ 读 `SKILL.md` + `parseWorkbenchSkill` + `name===目录名` → `walkSkillPackage`（拒链接、深度 >4、单文件 >128 KiB、非普通文件）→ `hashSkillPackage`。
4. **清单 hash 复核（本批修复轮新增）**：`src/experts/skill-provider.ts:438` 起，受管且 ready 时把 `walkSkillPackage` 重算的 `packageHash` 与清单 `install.packageHash` 比对；不一致 → `skill-package-invalid`（"已安装的受管技能与安装清单不一致…"）→ **不列出**，`get` 因走同一 `buildCandidate` 也拿不到，且 `getSkill` 既有的 `built === undefined` 分支会 `invalidate(control)`。**可比性依据**：`hashSkillPackage`（`src/experts/skill-package.ts:287-292`）内部按 basename 剔除 `EXPERT_RESERVED_FILE_NAMES`（含 `workbench-install.json`）并按 `path` 排序，而安装器写入清单时的 `packageHash`（`src/experts/install.ts:931-938` → `validated.packageHash`，输入 `stagedForSkill`）同样是"剔除保留名 + 按 path 排序"的同一集合。
5. **包内文件集合口径**：`walkSkillPackage` **不跳过**包内点开头的文件（`src/experts/skill-provider.ts:314-325`）—— 安装器的 `packageHash` 覆盖它写入的每个文件，而 `checkExpertRelativePathShape`（`src/experts/paths.ts:148`）只拒 `.`/`..` **整段**，所以 `.notes.txt` 这类合法暂存文件必须计入，否则合规包会被误判成"被改过"。根级 `.pending`/隐藏项过滤仍在 `listSkills`。
6. **`get` 不信 locator**：只按 `candidate.name` 从 `deps.skillsDir` 重算，重走 ready/真实文件/整包 hash；与 `locator.packageHash` 不符（含 locator 缺失、name 不符）→ `invalidate` + `package-changed` + `undefined`，**绝不返回新版本冒充旧候选**。
7. **诊断出口**：provider 的诊断经 `Symbol.for('dsh.workbench.skillProviderDiagnostics')`（非 enumerable）挂在 provider 实例上，用 `readWorkbenchSkillProviderDiagnostics(provider)` 读回。
8. **catalog 状态优先级**：`src/experts/catalog.ts:575-585`（winner 行：provenance invalid 或诊断含 `installation-incomplete` → `installation-incomplete`；`enabled===false` → `disabled`；必需技能缺 → `dependency-unavailable`；否则 `usable`）与 `:637-640`（诊断行：`installation-incomplete` → `disabled`（全部来自 `duplicate-id-overridden`）→ 否则 `invalid`）。`issues` 始终保留全部原因。
9. **scope 传递**：`buildExpertCatalogSkillContext`（`src/experts/catalog.ts:748-766`）用 `resolveLiveAgentScope(input.agent, input.scopeHelper)`（= `scopeOf(agent.ctx)`）+ `readLiveAgentCwd(agent)`（= `agent.session.header.cwd`）→ `projectWorkbenchSkillRegistry(service, {scope, cwd, signal})`；`verifyDefinitions` 时用同一份 scope/cwd/signal 对"注册表里真有"的需求名做 `skills.get` 复核。HTTP 无 live agent → `evaluated:false, resolved:false`、**无 problem**、`preliminary:true`。
10. **`preliminary` 的确切含义（P5 注意）**：`preliminary` = "这次判定不是权威视角"（无 scope helper、无 live agent、或 `scopeOf` 返回 `undefined`）。**它不是"技能不可用"**，接线时不得据此拒绝调用；拒绝的依据只能是 `usable===false`。
11. **自主提示**：`buildAutoExpertPrompt` 用 `buildExpertCatalogRows({...sources, checkSkills:false})`（**不做**技能预检）、过滤 `usable && enabled`、排序 `favorite` 降序再 `id` 升序、`truncateDescription` 超限 `slice(0,max-1)+'…'`、超总长时逐条减少再整体 slice；`interpolate:false` 是**类型级**约束（`AutoExpertPromptBlock.interpolate: false`）。systemPrompt 现有区块序号 260（knowledge-guide）与 300（knowledge context），本块 320 不冲突。

## 5. 独立证据：真实安装器 → 真实 provider

仓库测试里的 `workbench-install.json` 是**夹具**构造的（用产品自己的 `hashSkillPackage` 算真哈希），因此"健康包被列出"这件事在测试里多少有点自证。为了把"provider 重算的哈希 == 安装器写进清单的哈希"从合成夹具提升为**真实产物字节级**，本批新增独立脚本（**不属于仓库测试**，不进 `test/`，不参与 `pnpm test`）：

`docs/tasks/ed644638-…/evidence/p4-provider-real-install.mjs`（用法：先 `pnpm build`，再 `node <脚本>`），2026-10-05 实跑 `11/11 PASS`、`EXIT=0`、临时根已清理：

1. 用**真实草稿链**（`createExpertDraft` → `submitExpertDraft` → `stageExpertFile`×4 → `validateExpertDraft` → `confirmExpertDraft`）装一个受管人格 + 一个受管技能，包内含子目录许可副本 `sources/demo/LICENSE.txt` 与一个**点开头文件** `.notes.txt`。
2. 清单 `files[]` 三条的 `bytes`/`sha256` 与磁盘真实字节逐条相符（含 `.notes.txt`）。
3. **清单 `packageHash` == provider 候选 `locator.packageHash`（逐字相等）** ← 本批修复 2 的核心可比性，真实产物证明。
4. 候选形状（`rank 600`、`provider='personal-workbench'`、`source='bundled'`、`resourceBase.kind='directory'`）+ `get` 返回去 frontmatter 且 trim 的正文。
5. 手改 `SKILL.md` → list 为空、诊断 `skill-package-invalid`/`与安装清单不一致`；**伪造正确 locator 的 `get` 也拿不到**且恰好 invalidate 一次。
6. 还原 `SKILL.md` 但删掉 `.notes.txt` → 同样拒绝（文件集合变→哈希变）。
7. 全部还原 → 技能重新可见、`locator.packageHash` 仍与清单相等；根外哨兵一个字节未变。

## 6. AX 覆盖

| 断言 | 结论 | 证据 |
|---|---|---|
| AX-E24 未 ready 的受管技能不进 list/get | ✅ | `test/expertProvider.test.mjs:302`（补上 `publication.json` 后同一技能立即可见，证明门判的是当下状态） |
| AX-E24 坏包只记诊断、其余包照旧 | ✅ | 同上 `:354`（YAML 坏 / name 不匹配 / 旧驼峰键 / 链接 / 非目录 / 坏目录名） |
| AX-E24 完整性字段（`complete`、abort） | ✅ | 同上 `:413` |
| **AX-E24 清单 hash 复核（本批新增）** | ✅ | 同上 `:423`（未改动照常列出，含子目录）、`:447`（手改 SKILL.md → 拒 + get undefined + invalidate 一次）、`:479`（增删文件 → 拒）、`:520`（lstat 语义前提）、`:542`（`managed:false` 旧手工技能不受影响）；真实产物证据见 §5 |
| AX-E25 同层 rank 400 胜 600 / 只走 `registerProvider` | ✅ 消费侧 | 同上 `:435`（`registry.registerCalls===0`）、`:476`（只给 `registerProvider` 也能挂；dispose 后注册表只剩 user-skills） |
| AX-E26 真实 `scopeOf` + 跨层胜出 | ✅ SDK 实测 / ⚠️ 仲裁为模拟 | 同上 `:506`（真跑 `@deepseek-ai/dsh-scope`：`scopeOf(scoped.ctx)===key`、`scopeOf(plain)===undefined`）、`:517`（同一 scope 键 + 按 SDK 规则的模拟注册表）；**真实 `SkillRegistry` 仲裁未跑** |
| AX-E27 候选变动后不偷换正文 | ✅ | 同上 `:590`（旧候选 → undefined + invalidate + `package-changed`；重 list 得新 hash/新正文） |
| AX-E28 安装后无需重启即可发现 | ✅ 消费侧 | 同上 `:640`、`:677`（换代后旧 control 作废；dispose 后 `invalidateSkills()===false`） |
| AX-E29 目录行与状态优先级 | ✅ | `test/expertCatalog.test.mjs:268`（坏文件/停用/被压掉/未发布；不可用不进 `personas`）、`:397`（安装草稿丢了也不误判，多一条 `draft-not-found`）、`:421`（`installation-incomplete` 压过 invalid/disabled） |
| AX-E30 运行前依赖预检 | ✅ | 同上 `:442`（无 skills 服务：必需不可用 / 无依赖仍可用 / 可选仅 warning）、`:497`（`modelInvocable=false` 不可用；同名被覆盖 → `skill-shadowed` 且 provider=user-skills）、`:527`（真实 provider + 坏清单 → `dependency-unavailable`）、`:570`（新增：清单一致 → 判可用） |
| AX-E49 scope 前置（helper 缺失/抛错） | ✅ | 同上 `:630` + `test/expertProvider.test.mjs:552`（`skill-scope-unavailable`；无 live agent 不算错；preflight 绝不返回通过） |
| §7.3 投影保真 | ✅ | `test/expertProvider.test.mjs:738`（保留 provider/source/rank/locator；坏条目丢弃 `complete:false`） |
| AX-E48 自主召唤开关 off→on→off | **未验证（P6）** | 本批只交 `buildAutoExpertPrompt`，未注册进 systemPrompt |

## 7. 未验证项（**不得当作通过**）

1. **真实 `@deepseek-ai/dsh-skill` 注册表自身仲裁**（同层 rank 决胜、最近 scope 层胜出、provider 注册序兜底、`invalidate` 的宿主缓存语义）未真跑 —— 本仓没有可跑的宿主注册表，测试用忠实模拟注册表；本批只验证了**我方消费逻辑**。
2. **真实宿主 provider 重挂**：测试的"重挂"是自己再调一次工厂，不是真实子 fiber 卸载/重挂；宿主侧 `control.invalidate()` 的实际效果未验证。
3. **真实 provider 重载**：没有在任何真实 DSH 实例里注册该 provider，"装完技能后宿主注册表刷新"无实例级证据。
4. **HTTP 侧接线全未做**：`GET catalog.personas`、`POST /experts/preflight`、绑定前预检、`workbench_load_persona` 的 required 预检回调（P5/P8）。
5. **顶层 `ctx.inject(['skills'], …)` 子 fiber 未做**（P5）；`buildAutoExpertPrompt` 未进 systemPrompt（P6）；AX-E48 未验证。
6. **真实 live agent 形状**：catalog 测试的 agent 是 `{ctx, session:{header:{cwd}}}` 形状桩，真实 agent 的 `ctx`/`session.header` 未在实例里验证。
7. 本批**未跑全仓** `test/*.test.mjs`；`test/db.test.mjs` 的既有 Windows 清理期 EPERM 未触碰；未用 `--frozen-lockfile` 复验。

## 8. 规格偏差（如实记录）

1. **`duplicate-id-overridden` 的诊断行**给 `status='disabled'` + `enabled:false`：§9.1 的状态枚举没有"被覆盖"档 —— 它解析是好的（给 `invalid` 是撒谎），它又不生效（给 `usable` 也是撒谎）。选 `disabled`+`enabled:false` = "存在但不生效"，`issues` 保留诊断原文。代码内已注明理由。
2. **`invalid` 只可能出现在诊断行**：winner 行按定义来自解析成功且发布门已放行的文档（受管 provenance 坏走 `installation-incomplete`），`buildWinnerRow` 没有 `invalid` 分支。§9.1 的五级优先级在"两类行合起来"的意义上完整成立（AX-E29 优先级用例覆盖）。
3. **`readPendingInstallNote` 直接只读扫 `.pending/*/install-journal.json`**：`src/db/repo/experts.ts` 没有"列出全部 expert 草稿"的函数，所以没走 DB（不改任何东西、失败静默跳过）。人格自身的 `installation-incomplete` 仍完全来自 `discoverPersonas` 发布门。
4. **`sourceKey` 反查**：`PersonaLibrarySource` 类型上不带 `sourceKey`，catalog 用**同一个** `sourceKeyForRoot(source.kind, source.root, platform)` 建 map；反查不到时 `sourceKindOf` 落 `'user'`（理论不可达，代码注明"不凭空造来源类型"）。
5. **`buildAutoExpertPrompt` 走 `checkSkills:false`**：摘要**不是**权限证明，真正执行仍必须走完整异步 `preflightExpert`。这是 §9.2 的分工，已在代码与测试名里写明。
6. **`preliminary` 偏保守**：`scopeOf` 成功但返回 `undefined`（host 层 ctx）时投影记 `preliminary:true`，比 §7.3 更保守。不是谎报权威，但 P5 必须按 §4.10 的方式消费它。

## 9. 给 P5 的接线义务

1. `src/index.ts` **保持顶层 inject 不变**（webServer/systemPrompt/tools/commands），新增**子 fiber** `ctx.inject(['skills'], (ctx) => {…})`，让"宿主没装 skills 服务"不影响插件加载。
2. 子 fiber 内：`probeExpertSkills(ctx)` → 有服务则 `registerWorkbenchSkillProvider(service, { skillsDir: roots.skillsDir, personasDir: roots.personasDir, platform })` + `ctx.effect(() => () => registration.dispose())` 挂释放；无服务只记一条降级，**不注册、不伪造可用**。
3. **启动顺序：先 `recoverExpertInstallations(...)`（P3）再注册 provider。**
4. `refreshSkills` 接 `() => registration.invalidateSkills()`（返回 boolean，兼容 `install.ts` 的 `refreshSkills?: () => void`）；手动刷新按钮走同一入口。**不要**把 registration 存进长期单例让旧引用调 invalidate —— 换代后返回 `false` 是设计。
5. catalog/preflight：工具执行路径传 `agent=exec.agent`、`signal=exec.signal`；HTTP 路由**没有 live agent 就传 `undefined`**（结果 `preliminary:true`，必需技能判不可用 —— 正是 §7.3 要求）。`scopeHelper` 可选（不传就让 `loadScopeHelper` 自己动态 import）。
6. `GET catalog.personas` 直接返回 `document.personas`（已是 `PersonaSummary`、只含 usable）；完整行给 `document.rows`。**不要把 `resourceBase.path`/`path`/`locator` 透到 HTTP**（`WorkbenchSkillProjectionEntry` 有这些字段，下发前剥掉）。
7. `POST /experts/preflight` → `preflightExpert({...})` 回 `{usable, status, issues, effectiveSkills, preliminary}`；`startAISession` 绑定前调**同一个** `preflightExpert`；`workbench_load_persona` 的 required 预检用同一套（可选回调注入），不要另写判定。
8. 自主提示（P6 注册、P5 备好）：`{ name: AUTO_EXPERT_PROMPT_BLOCK_NAME, order: AUTO_EXPERT_PROMPT_ORDER, interpolate: false, text: () => buildAutoExpertPrompt({ db, roots }).text }` —— `text` **必须同步**，别在里面 await；是否注册由 `readExpertSettings(db).autoSummonExperts` 决定。
9. 新加源文件记得追加进 `tsconfig.build.json` 的显式 include。
10. `preliminary` 只表示"视角降级"，不是"不可用"（见 §4.10）。

## 10. 复核与过程事实（如实记录）

- **两轮结构**：第一轮 = provider/host-adapter/catalog + 测试（39 test）；主会话独立复跑（39 + 回归 207）并**逐段读完**三个源文件与两个测试文件；复核发现 **2 个真缺陷**，发回同一子代理做最小修复；第二轮 = 修复 + 夹具真实化（45 test）。两轮都经主会话独立复跑（45 + 回归 207）。
- **真缺陷 1（安全网是空的）**：`isLinkEntry` 的兜底用 `statSync`（会**跟随**链接），对 `Dirent` 没标出的 junction 永远返回 `isSymbolicLink()===false`。改为 `lstatSync`（`src/experts/skill-provider.ts:275-283`），并补一条"lstat 语义前提"用例（`:520`）。**诚实说明**：真实文件系统上造不出"Dirent 说不是链接、实际却是链接"的条目，所以这条**没有**"装回 bug 必红"的反向注入，只有本机语义实测（`Dirent=true` / `lstat=true` / `statSync=false`）+ 代码级论证；原有 junction 用例走的是 `Dirent.isSymbolicLink()` 那一支。
- **真缺陷 2（清单 hash 从未被消费）**：`buildCandidate` 只看 `ready`，`install.packageHash`/`files` 拿到就丢 → 安装后手改/增删受管技能文件，provider 仍会把**改动后的内容**当"工作台装的受管版本"列出并 `get`（只有 list→get 之间改动才因 locator 不一致失效）。修法见 §4.4。**反向注入**（子代理执行，主会话另有真实产物证据）：把 `src/experts/skill-provider.ts:438` 的整条件临时改 `if (false)` → `pnpm build` 退出码 0、`node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs` → `ℹ tests 30 / ℹ pass 28 / ℹ fail 2`（唯一两条红是篡改用例：手改 `SKILL.md`、包内增删文件），合规包与旧手工技能用例仍绿；还原后 45/45 全绿，`if (false)`/`REVERSE-INJECTION` 残留 0。
- **夹具从合成哈希改成真实哈希**（必须同步，否则测的是夹具自己的谎）：`test/expertProvider.test.mjs:126` 原为 `packageHash: HEX`（`'a'.repeat(64)`）、`test/expertCatalog.test.mjs:234-235` 连 `files[].sha256` 都是 `HEX`。新增 `test/fixtures/expertSkillFixture.mjs`（`sha256OfBuffer`/`readSkillPackageFiles`/`writeManagedSkillManifest`，用产品导出的 `parseWorkbenchSkill` + `hashSkillPackage` 算**真实**清单），两个测试文件都改为调它。**原有 24 条用例的断言文本一字未改**，只是构造方式变了（子代理如实确认）。
- **连带发现并修好的一处口径不一致**：`walkSkillPackage` 原来跳过包内点开头的文件，而安装器的 `packageHash` 覆盖它写入的每个文件（`src/experts/paths.ts:148` 只拒 `.`/`..` 整段，`.foo.txt` 的扩展名在文本白名单里 → 合法可暂存）→ 这类合规包会被永久误判成"被改过"。已去掉包内跳过并写明理由；副作用是**更严**（包内多一个隐藏文件也会被拒，与"增删都拒绝"同向）。
- 主会话额外做的检查：`lib/**` 里 `@deepseek-ai/dsh-scope` 只以动态 importer 字符串出现（`lib/experts/host-adapter.js:44`）、无静态 import；`@deepseek-ai/dsh-skill` 只出现在注释；`parseWorkbenchSkill`（`src/experts/skill-package.ts:224`）已对 `frontmatter.bodyLines.join('\n').trim()` 做 trim，所以 `get` 的 `content` 满足"去 frontmatter、trim"；9 个交付文件 CR=0（LF）；`task_drafts` 等 P1–P3 文件零改动。
- **未执行的安装/发布操作**：未 `dsh plugin add/remove`、未改 profile、未重启、未发布 npm、未写 `~/.dsh/workbench`（测试与证据脚本全部在 `mkdtempSync` 目录，`finally` 只删核验过的临时根）。
