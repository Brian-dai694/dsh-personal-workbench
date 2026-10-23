# P5 交接：服务 / 生成工具 / HTTP 路由 / 主链装配

- **批次**：P5（`implementation-plan.md:181-215`），前置 P4 已通过（commit `0ca0a6d`）。
- **执行日期**：2026-10-05（P5 首次交付 → 主会话逐文件复核 → 一轮最小修复 → 主会话独立复跑 + 独立 HTTP 端到端证据 + `pnpm pack` 核验）。
- **本批性质**：**第一次接生产装配** —— 改动了 `src/index.ts` / `src/api/routes.ts` / `src/api/routes/drafts.ts` / `src/tools.ts`。
- **批次边界（未做，故意不做）**：客户端 UI（P7/P8）、P6 的 manual/auto invocation 与 ticket、真实实例重启与装盘（需用户明确指令）。**`src/client/**` 一字未动**。
- **硬边界遵守**：`src/index.ts` 的顶层 `inject` 数组**逐字未变**（`['webServer','systemPrompt','tools','commands']`，证据见 §5「顶层 inject 逐字未变」）；未加任何第三方 DSH 插件依赖；未改 `SCHEMA_VERSION`；未写 `~/.dsh/workbench`；所有本批文件为 **LF**（CR=0）。

## 1. 交付物

| 文件 | 行数 | 状态 | 说明 |
|---|---|---|---|
| `src/experts/service.ts` | 994 | 新增 | `createExpertService`：能力、方法论、草稿、校验、确认、放弃、catalog、preflight + 错误投影 |
| `src/experts/tools.ts` | 576 | 新增 | §5.1 的 5 个生成工具（execute 只调服务，**没有**确认/安装工具） |
| `src/api/routes/experts.ts` | 216 | 新增 | `/api/workbench/experts` 域路由（capabilities/catalog/methodology/generation-start/drafts/validate/file/preflight） |
| `assets/expert-generation/methodology.md` | 161 | 新增 | 方法论资产（version 1，13 步），随包发布 |
| `test/expertRoutes.test.mjs` | 634 | 新增（16 test） | AX-E31/E32/E33/E35 + HTTP 契约 |
| `test/expertTools.test.mjs` | 515 | 新增（14 test） | AX-E34 + 工具参数/输出契约 + owner 守卫 |
| `test/expertWiring.test.mjs` | 733 | 新增（8 test） | AX-E50 装配断言（含修复轮新增 3 条） |
| `src/index.ts` | 618 | 修改 | 服务装配 → 启动恢复 → 路由/生成工具 → `ctx.inject(['skills'])` 子 fiber → `load_persona` 注入 preflight → dispose |
| `src/api/routes.ts` | 444 | 修改 | `WorkbenchRouteDeps.experts`；专家路由挂载；settings POST 唯一读写接线（落库 + `setAutoEnabled`）；`makeDraftRoutes` 透传 `experts` |
| `src/api/routes/drafts.ts` | 379 | 修改 | expert 的 confirm / abandon 分支**插在既有 `statusCode !== 'pending'` 闸门之前**（见 §3） |
| `src/tools.ts` | 1178 | 修改 | `loadPersonaTool(db, roots, preflight?)`：既有 load 成功之后再跑依赖预检，失败不返回正文 |
| `tsconfig.build.json` | 84 | 修改 | include 追加 `src/experts/service.ts`、`src/experts/tools.ts`、`src/api/routes/experts.ts` |
| `package.json` | 110 | 修改 | `files` 追加 `assets/expert-generation` |
| `docs/tasks/ed644638-…/evidence/p5-http-e2e.mjs` | 663 | 新增 | **独立证据**：真实 HTTP 全链 + 真实 provider 挂载（见 §5） |

`version` / `scripts` / 依赖未改；`pnpm-lock.yaml` 未改（本批无新依赖）。

## 2. 逐字导出签名（P6 直接照抄）

### `src/experts/service.ts`

```ts
export function createExpertService(deps: ExpertServiceDeps): ExpertService
export interface ExpertServiceDeps { db: WorkbenchDb; ctx: unknown; roots?: PersonaRootOptions; now?: () => string; failpoint?: ExpertInstallFailpoint }
export interface ExpertCapabilities { generation: ExpertCapability; skills: ExpertCapability; manualSummon: ExpertCapability; autoSummon: ExpertCapability & { enabled: boolean }; providerName: string }
export interface ExpertService {
  capabilities(): Promise<ExpertCapabilities>
  methodology(): ExpertMethodology        // 同步（P6 复核时改正：P5 交接稿曾误写成 Promise）
  startGeneration(input): Promise<ExpertDraftView>
  getDraft(draftId): Promise<ExpertDraftView | undefined>
  currentPendingDraft(sessionId: string): Promise<ExpertDraftView | undefined>   // 附加（§12.2 无）
  previewDraft(draftId): Promise<ExpertDraftView | undefined>                    // 附加
  submitDraft(draftId, expectedVersion, input): Promise<ExpertDraftView>
  stageFile(draftId, expectedVersion, file): Promise<ExpertDraftView>
  removeFile(draftId, expectedVersion, ref): Promise<{ changed: boolean; view: ExpertDraftView }>
  validateDraft(draftId, expectedVersion, exec?): Promise<ExpertDraftView>       // 第三参是附加
  confirmDraft(draftId, input): Promise<ExpertInstallResult>
  confirmDraftDetailed(draftId, input): Promise<ExpertInstallSuccess>            // 附加（带 replayed）
  abandonDraft(draftId): Promise<{ removed: string[]; warnings: string[] }>
  readStagedFile(draftId, ref): Promise<{ text: string; bytes: number; archivedOnly: boolean }>
  catalog(input?): Promise<ExpertCatalogDocument | /* 相关投影 */ unknown>
  preflight(personaId, agent?): Promise<ExpertPreflightResult>
  setAutoEnabled(enabled: boolean): void
  setSkillInvalidator(fn: (() => boolean) | undefined): void                    // 附加
  invalidateSkills(): boolean
  recover(): Promise<ExpertRecoveryReport>
  dispose(): void
  projectFailure(error: unknown): { status: number; body: unknown }             // 附加
  readonly roots: ExpertRoots
  // P6 未实现（刻意不声明）：createManualRequest / runManual / runAuto / loadForChild / readForChild
}
export class ExpertServiceError extends Error { code: ExpertErrorCode | PersonaDiagnosticCode; field: string; errors?: ExpertIssue[]; currentVersion?: number }
export function expertErrorStatus(code: string): number   // 413/404/503/409/403 五组，其余 400
export function projectExpertMessage(message: string, roots): string
export function projectExpertField(field: string): string
export function projectExpertIssues(issues, roots): ExpertIssue[]
export function methodologyAssetPath(moduleUrl?: string): string
```

### `src/experts/tools.ts`

```ts
export const EXPERT_GENERATION_TOOL_NAMES: readonly string[]  // 就是 §5.1 那 5 个名字，逐字
export function getExpertDraftTool(service: ExpertService): Tool
export function submitExpertDraftTool(service: ExpertService): Tool
export function stageExpertFileTool(service: ExpertService): Tool
export function removeExpertStagedFileTool(service: ExpertService): Tool
export function validateExpertDraftTool(service: ExpertService): Tool
export function expertGenerationTools(service: ExpertService): Tool[]
export interface ExpertToolExec { agent?: unknown; signal?: AbortSignal }
```

工具名（逐字，宿主可见）：`workbench_get_expert_draft`、`workbench_submit_expert_draft`、`workbench_stage_expert_file`、`workbench_remove_expert_staged_file`、`workbench_validate_expert_draft`。**没有**任何确认/安装工具（AX-E34）。

### `src/api/routes/experts.ts`

```ts
export const EXPERTS_PREFIX = '/api/workbench/experts'
export function makeExpertRoutes(db: WorkbenchDb, service: ExpertService | undefined): WebRoute[]   // undefined → []
```

### `src/tools.ts`（本批唯一导出面变化）

```ts
export interface PersonaDependencyPreflight { ok: boolean; message?: string }
export type PersonaDependencyPreflightCallback = (personaId: string, exec: PersonaToolExec) => Promise<PersonaDependencyPreflight>
export function loadPersonaTool(db: WorkbenchDb, roots?: PersonaRootOptions, preflight?: PersonaDependencyPreflightCallback): Tool
```

## 3. 接线点与顺序（我逐行复核过 `git --no-pager diff`）

`src/index.ts`（`applyReady`）：

1. `createExpertService({ db, ctx, roots: rootOptions })`
2. `const expertRecovery = experts.recover()` —— **不阻塞启动**，只把 warn/error 记日志
3. `makeRoutes(db, { …, personas: rootOptions, experts })`
4. 工具数组：`loadPersonaTool(db, rootOptions, (personaId, exec) => personaDependencyPreflight(experts, personaId, exec?.agent))` + `...expertGenerationTools(experts)`
5. `ctx.inject(['skills'], (skillsCtx) => { … })` 子 fiber：等 `expertRecovery` → `probeExpertSkills(skillsCtx)` → 再确认 `registerProvider` 存在 → `registerWorkbenchSkillProvider(registrar, { skillsDir: experts.roots.skillsDir, personasDir: experts.roots.personasDir, platform: process.platform })` → `experts.setSkillInvalidator(() => registration?.invalidateSkills() ?? false)`；返回 disposer（置 `disposed` → 解挂 invalidator → `registration.dispose()`）
6. `personaDependencyPreflight` **只在 `result.usable === false` 时拒绝**（`preliminary` 不当拒绝依据）
7. `ctx.effect(() => () => experts.dispose())` 注册在 db 那条 effect **之后** —— cordis `DisposableList.clear()` 会 `reverse()`，**后注册先执行** ⇒ `experts.dispose()` 先于 `db.close()`
8. 新增 `Config.home` + `workbenchDbConfigFor(config)` + `homeRootOverride(config)`（生产 `{}`，缺省 `homedir()`；显式 `dataDir`/`dbPath` 优先）

`src/api/routes.ts`：`WorkbenchRouteDeps.experts?: ExpertService`；`...makeExpertRoutes(db, deps.experts)` 插在 personas 之后；settings POST 在 `writeExpertSettings(...)` 之后 `if (body.autoSummonExperts === true || === false) deps.experts?.setAutoEnabled(...)`，响应仍是 `readWorkbenchSettings(db)`；`makeDraftRoutes(db, { teamMemory, experts: deps.experts })`。

`src/api/routes/drafts.ts`（**本批最容易写错的点**）：expert 的 confirm 分支紧跟 task 幂等分支，**落在 `if (draft.statusCode !== 'pending') return 400` 之前**（AX-E33 要求已确认草稿能幂等回放），返回 `{ ok: true, expert: success.result, replayed: success.replayed }`，异常在本地走 `experts.projectFailure(error)`（**不冒到外层那个把 `error.message` 直接回 400 的 catch**）；abandon 的 expert 分支同样在闸门之前（`installing` → 409，清理暂存失败只回 warning）。

`src/tools.ts`：preflight 在**既有 load 成功之后**跑；不传回调时行为逐字不变。

## 4. 命令与退出码（主会话独立复跑，同一条命令链）

```text
pnpm typecheck                                      → 0
pnpm build                                          → 0（client 552.64 kB）
node --test test/expertRoutes.test.mjs test/expertTools.test.mjs test/expertWiring.test.mjs test/httpFence.test.mjs
                                                    → 0（tests 43 / pass 43 / fail 0：16+14+8+5）
node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs
                                                    → 0（18+12+15=45 / pass 45）
node --test test/*.test.mjs                         → 1（tests 1195 / pass 1194 / fail 1）
```

全仓那 1 条失败 = `db migrations, dictionaries and task tree`（`test/db.test.mjs`）在 **`finally` 清理期**的已知 EPERM（`Error: EPERM, Permission denied: \\?\C:\Users\ADMINI~1\AppData\Local\Temp\dsh-personal-workbench-db-…`），仓库既有问题（`docs/releases/v1.16.0.md:134`、`docs/issues/2026-10-05-clear-plan-does-not-refresh.md:60`），**不是本批回归**。

CR 检查（本批 14 个文件）全为 **CR=0**；`REVERSE-INJECTION` 在 `src/**`、`test/**` 残留 **0**。

`pnpm pack` 核验（`prepare` 会重建 lib，故在测试之后单独跑）：

```text
tarball 299 条目；package/assets/expert-generation/methodology.md        OK
package/lib/experts/{service,tools,skill-provider,install,drafts,catalog,host-adapter,skill-package}.js  OK
package/lib/api/routes/experts.js / package/lib/personas/managed.js / package/lib/build-info.json        OK
personas 资产条目 >0；LICENSE* 条目 3（LICENSE / LICENSE-novotnyllc-dotnet-artisan / LICENSE-K-Dense-scientific-agents）
```

## 5. 独立证据：`docs/tasks/ed644638-…/evidence/p5-http-e2e.mjs`

**不属于仓库测试**；最先 `pnpm build`，真实 `http.createServer` + `makeRoutes(db, { experts })` + 真服务（`createExpertService({ db, ctx: { get: () => undefined }, roots: { home: <临时根> }, now })`，与生产 `config.home` 同口径），驱动链 = `GET capabilities` → `GET methodology` → `POST generation-start` → 5 个生成工具（模型路径）→ `POST drafts/:id/validate` → `GET drafts/:id/file` → `POST drafts/:id/confirm` → `GET catalog` → 再次 confirm → 负例草稿 → abandon → 泄漏扫描。

```text
P5 HTTP 端到端证据：38/38 PASS，响应样本 23 条      EXIT=0
```

最有价值的三条真实行为（不是设计文档抄来的，是跑出来才看见的）：

1. **无 skills 服务时，受管发布被真的发现但如实降级**：确认安装后 `GET catalog` 出现 `id='generated/<uuid>'`、`source:'user'`、`provenanceState:'recorded'`、`enabled:true`，但 `status:'dependency-unavailable'`、`issues:[{code:'skill-service-unavailable', field:'skill.demo-skill'}]`，且**不进** `catalog.personas` 可选摘要。符合 §9.1/§10"禁止假装 required 技能可用"。
2. **同一份发布挂上真实 P4 provider 后翻成可用**：把 `createWorkbenchSkillProvider({skillsDir, personasDir, platform})` 包进一个假 skills 服务（`list` 解包 `observation.candidates`、`get` 按 name 找 candidate 再转发）→ `capabilities().skills.available===true`、`providerName==='personal-workbench'`、catalog 该行 → `status:'usable'` + `requiredSkills[0].available===true` + `preliminary===true`（无 live agent ⇒ 只给初步结论）、`preflight.usable===true`。
3. **AX-E32 的负例必须打在 pending 草稿上**：已确认草稿 + 旧 version 仍走**幂等回放**（`replayed:true`，`install.ts:1407-1413` 的 replay 分支在版本校验之前）—— 这是设计（客户端丢响应也能恢复）；"旧 version / 错 hash → 409" 验证在 **pending** 草稿上：未过校验 → 409、旧 version → 409 `draft-version-conflict`、版本对但 hash 不符 → 409，且三次被拒后 `personas/**` 与拒绝前快照逐字相等。

## 6. AX 对账（P5 部分）

| 断言 | 结论 | 证据 |
|---|---|---|
| AX-E31 | ✅（真宿主未跑） | `test/expertRoutes.test.mjs`「非回环 403（复用既有 `isLoopbackRequest`，无第二套围栏）」「坏 JSON → 400 `invalid-json`；声明超 body → 413」；`test/expertWiring.test.mjs`「真发 >`EXPERT_HTTP_BODY_MAX_BYTES` 的 body（content-length 正确）→ 413 且 `task_drafts` 零行」；证据脚本「全链泄漏扫描：响应体不含临时根/`install-journal`/`ticket`」+ 路由数量断言 |
| AX-E32 | ✅ | `test/expertRoutes.test.mjs`「旧 version / 错 hash 的 confirm → 409（`draft-version-conflict` 带 `currentVersion` / `package-changed`），正式库零写入」；证据脚本 3 条 pending 负例 + 已确认幂等回放 |
| AX-E33 | ✅ | `test/expertRoutes.test.mjs`「首次 `replayed:false` → 再次 200 `replayed:true`，`expert` 字段结构不变」「旧任务草稿 confirm 返回结构一个字没变」；证据脚本同断言 |
| AX-E34 | ✅ | `test/expertTools.test.mjs`「注册表就是那 5 个生成工具，无确认/安装工具」「参数只有 snake_case 域字段，无 `session_id`/`root`/`absolute_path`」「源码里工具层不引用确认/安装入口」；证据脚本「工具注册表 + 确认前正式库零写入」 |
| AX-E35 | ✅ | `test/expertRoutes.test.mjs`「abandon 只清自己那份草稿的暂存（`.pending/<A>` 消失、`<B>` 保留）；installing → 409 且仍 pending」；证据脚本「abandon → 409 再放弃」 |
| AX-E50 | ✅ **仅 fake ctx 内**（真宿主未跑） | `test/expertWiring.test.mjs` 6 条：inject 逐字未变（运行时数组 + 源码行）、一份 service 被路由/工具/子 fiber 共用、skills 缺失时不崩不 pending、provider 注册与释放走"子 fiber + effect"、`load_persona` 把 live agent 原样传下去（真实 `createScope`/`scopeOf`，断言 `scope` 对象身份 + `cwd`）、settings POST 真 boolean 恰好转发一次且六种脏值一次都不调；证据脚本「顶层 inject 逐字未变」 |

## 7. 规格偏差（7 条，逐条给出处 → 实际 → 理由）

| # | 出处 | 实际做法 | 判定 |
|---|---|---|---|
| ① | §12.2 `ExpertService` 方法面 | 追加 `currentPendingDraft` / `previewDraft` / `confirmDraftDetailed` / `setSkillInvalidator` / `projectFailure` / `readonly roots` | 必要扩展：`workbench_get_expert_draft` 无参必须按执行会话找草稿；§4.1 要求"实际暂存清单 + 漂移诊断"；AX-E33 要区分回放；P4 义务④禁止把 registration 存成长期单例 |
| ② | §12.2 `validateDraft(id, expectedVersion)` 两参 | 加**可选**第三参 `exec?` | **我的接口扩展**：工具路径要复用同一 owner 守卫、HTTP 路径不能传 sessionId |
| ③ | §11/§12.2 无此配置 | `src/index.ts` 新增 `Config.home` 覆盖钩子 | **我的偏差**：AX-E50 要用临时目录跑 `apply()`，而任务书禁止写真实 `~/.dsh/workbench` |
| ④ | §12.2 `setAutoEnabled(enabled): void` | 只转发 `writeExpertSettings`，`capabilities()` 重读同一 meta 键（无独立内存态） | 不是偏差（单一权威源）；代价：P5 里删掉转发不可观测（原 RI-2a 诚实负结果），已改由可注入桩断言守住 |
| ⑤ | 任务书硬边界"本批文件全 LF" vs 仓库 60+ 既有文件是 CRLF | `src/index.ts` / `src/tools.ts` 等整文件转 LF，行数不变 | 遵任务书、违仓库现状（diff 里会看到 EOL 变化） |
| ⑥ | 硬边界"不改 P0–P4 已交付语义" | P1/P3 的两处缺口在**接线层**补偿：`ensureAreaRoot()`；`expertDraftCurrentVersion` 补 `currentVersion` | **我的判断偏差**：根因在 P1/P3，已列为给 P6 的义务⑦ |
| ⑦ | §5.1「output schema 必须真实对应返回值」 | `get`/`validate` 的 schema 补 `currentVersion` | 不是偏差（`additionalProperties:false` 下漏声明会运行时炸） |

## 8. 未验证项（修复轮后 8+1−1，如实标注）

1. **真实 19387 宿主实例**：未重启、未装盘 → 需要用户明确授权 + 装盘后 `check-installed-version.mjs` 通过。
2. **真实模型/LLM 生成一篇专家**：无真实 LLM 会话 → 需真机开生成会话、真调 5 个工具。
3. **客户端 UI**：属 P7/P8。
4. **P6 invocation（manual/auto summon、ticket）**：未实现。
5. **`recover()` 对真实 `~/.dsh/workbench` 的半成品现场**：只做了"`.pending` 垃圾不中断装配"冒烟。
6. **`pnpm pack` 产物**：~~未验证~~ → **本轮已补验**（见 §4；tarball 含 methodology + 全部新 lib 模块 + 既有 persona/license）。
7. **真实宿主 skills 服务（非 fake）**：全程用 fake/桩。
8. **macOS/Linux**：只在 Windows 跑过。
- 修复轮变化：**−1**（"`setAutoEnabled` 转发不可观测"已由可注入桩用例关闭）；**+1**（"最近层同名技能胜出"的合并语义仍未在真实宿主注册表里跑 —— 修复只证明 `scopeOf(agent.ctx)`/`cwd` 原样传到了 `skills.list`）。

## 9. 给 P6 的接线义务（7+1 条）

1. `ExpertService` 补 `createManualRequest` / `runManual` / `runAuto` / `loadForChild` / `readForChild`，并**翻转** `manualSummon` / `autoSummon.available`（现在恒 `false` + `expert-subagent-unavailable`）。
2. 注册 systemPrompt 区块：`{ name: AUTO_EXPERT_PROMPT_BLOCK_NAME, order: AUTO_EXPERT_PROMPT_ORDER(320), interpolate: false, text: () => buildAutoExpertPrompt({ db, roots }).text }`（`text` 必须同步）——P5 未注册。
3. `makeExpertRoutes` 加 `POST manual-requests` 与 ticket 端点，沿用同一个 `projectFailure`。
4. 注册 `summon_expert` 工具；同时保持"没有确认/安装工具"。
5. 若调度器需要内存态，让 `setAutoEnabled` 落服务侧状态（现在只是转发写库）。
6. `dispose()` 接管"取消自己拥有的运行"（现在只解挂技能刷新钩子）。
7. 任何绕过 service 直接调 `stageExpertFile` 的路径必须先确保 area 根存在（P1 缺口未在源头修）。
8. **（修复轮新增）** P6 的 manual/auto summon 必须复用**同一个** `preflight(personaId, agent)` 并把 live agent 原样传进去（§7.3 最近层胜出）；不要各写一份依赖预检。

## 10. 复核与修复记录

主会话逐文件复核了 `src/index.ts` / `src/api/routes.ts` / `src/api/routes/drafts.ts` / `src/tools.ts` 的 diff（结论见 §3，全部合格），并发出**三处修复请求**：

1. **真问题**：preflight 回调只收 personaId → `service.preflight(personaId)` → `resolveLiveAgentScope(undefined)`，永远走无 scope 全局视角（违反 §7.3/§9.2）。修法：回调加第二参 `exec`，接线点传 `exec?.agent`（`src/tools.ts` +7 行、`src/index.ts` +4 行）。
2. AX-E50 的"设置转发"原本只靠源码扫描守 → 改用**可注入桩 service** 做真实断言（真 boolean 恰好转发、六种脏值一次都不调、响应是重读设置）。
3. 413 原本只靠声明式 content-length → 补"真发 300KiB body（content-length 正确）→ 413 且 `task_drafts` 零行"用例（挡在路由自己的声明长度预检那层，未读 body）。

修复轮改动：`src/tools.ts` 1170→1177、`src/index.ts` 613→617、`test/expertWiring.test.mjs` 563→732（+3 用例）；其余文件零改动。**反向注入**：把接线点改回传 `undefined` → 新用例变红（`actual: undefined` / `expected: {label:'wiring-agent-scope'}`，`tests 8 / pass 7 / fail 1`），还原后 330/330 全绿，残留 0。

子代理自己"用测试赚回一个真 bug"：abandon 清理暂存时把**相对路径**喂给 `isInsideExpertRoot`（内部 resolve 到 cwd）→ 清理被静默跳过；同时补了"全新机器上 area 根不存在 → 首次暂存 ENOENT"（`ensureAreaRoot`）。

## 11. 过程事实（给后续批次避坑）

- **`capabilities()` 是 async**，返回 Promise（`src/experts/service.ts:679`）——直调忘 `await` 会得到 `undefined.skills`。
- **expert confirm 的 body 必须有 `manifestHash`**：缺了会被路由层判 `400 invalid-payload`（`manifestHash 必填`），不是 409。
- **已确认草稿的 confirm 走 replay 优先于版本校验**（`src/experts/install.ts:1407-1413`）；AX-E32 负例必须打在 pending 草稿上。
- **catalog 行的 `source` 是 `PersonaSourceKind`**（`builtin|external|user`，`src/experts/catalog.ts:535-540` 的 `sourceKindOf` 兜 `'user'`）：受管生成专家落在 `personasDir` ⇒ `source:'user'`、`sourceKey:'user:<hash>'`，**受管身份只看 `id` 前缀 `generated/`**（`:629` 的 `isManagedPersonaId`）。用 `source==='generated'` 找它一定找不到。
- **`readJsonBody`（`src/api/http.ts:57-71`）**在读流中 `size > maxBytes` 即返回 `undefined`（与坏 JSON 同形）⇒ 413 只能靠**声明长度**预检，真发超限 body 会被挡在那一层。
- `probeExpertSkills(ctx)`（`src/experts/host-adapter.ts`）只要求 `ctx.get('skills')` 返回的对象有 `list` 函数（`get` 可选，若有必须是函数）。
- cordis `DisposableList.clear()` 会 `reverse()` ⇒ **后注册的 effect 先执行**；`experts.dispose()` 必须注册在 `db.close()` 之后才能先跑。
- `pnpm pack` 会触发 `prepare: pnpm build`（删 `lib` 重建）⇒ **不要与正在跑测试的进程并发**；`pnpm pack --ignore-scripts` 不被支持。
