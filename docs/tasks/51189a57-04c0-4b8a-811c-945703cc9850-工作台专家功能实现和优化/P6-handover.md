# P6 交接：专家调用主链（请求 / 子代理按需人格 / 回传与释放）

- 任务：`ed644638-f9a0-45cf-a32f-90df7d060dda`「工作台专家功能实现和优化」，批次 **P6**。
- 前置：P5 已提交 `146992f`（专家服务 / 生成工具 / HTTP 路由 / 首次生产装配）。
- 施工入口：`implementation-plan.md:217-247`（P6 段 13 步）；规格：`方案-v0.3.md` §8.1/§8.2/§8.5/§8.6/§8.7、§12.1/§12.2。
- 覆盖断言：**AX-E36–E44、AX-E48、AX-E49**（AX-E49 的一条"真实 skills 服务根因"如实标未验证）。
- 独立性：全部命令由**主会话**在子代理停工后重新跑过（§4）；反向注入由主会话**亲自**另做一次（§5）。
- **本批不碰** `src/api/**`（`POST /experts/manual-requests` 属 **P7**）、不碰 `src/client/**`、不加依赖、不改 `SCHEMA_VERSION`、顶层 `inject` 逐字未变。

## 1. 交付物

| 文件 | 行数 | 新增/修改 | 作用 |
|---|---|---|---|
| `src/experts/invocation.ts` | 1284 | 新增 | 调用主链状态机：request 表 / ticket 表 / 并发位 / 子代理启动与回传 / 清理 |
| `test/expertInvocation.test.mjs` | 1150 | 新增 | 16 条用例覆盖 AX-E36–E44 / E48 / E49（忠实假 subagents 服务，不 import 宿主包、不调真实 LLM） |
| `src/experts/host-adapter.ts` | 564（405 → +160） | 修改 | `probeExpertSubagents` / `probeExpertTools` / `selectSpawnProvider` + 形状最小化视图 |
| `src/experts/service.ts` | 1140（994 → +146） | 修改 | 补齐 §8.1 五个方法（全部委托 invocation）、能力如实探测、子代理守卫、开关订阅、dispose 接管 |
| `src/experts/tools.ts` | 959（576 → +383） | 修改 | 3 个常驻调用工具 + 条件注册的 `summon_expert`；**仍然没有任何确认/安装工具** |
| `src/index.ts` | 670（618 → +52） | 修改 | 常驻调用工具入注册表；按开关 + 能力动态注册/注销 `summon_expert` 与自主提示区块 |
| `tsconfig.build.json` | 84（+1） | 修改 | include 追加 `src/experts/invocation.ts`（显式清单，漏了会 `ERR_MODULE_NOT_FOUND`） |

越界核查：按 mtime 扫描（12h 窗口）只有上表 7 个文件被改；`src/client/**`、`src/api/**`、`src/experts/{drafts,install,paths,skill-package,catalog}.ts`、`src/personas/**`、`src/shared/**`、`package.json`、`pnpm-lock.yaml` 均未动。7 个文件 **CR=0（全 LF）且都以换行结尾**。

## 2. 逐字导出签名（P7 直接照抄）

### `src/experts/invocation.ts`

```ts
export const EXPERT_TASK_MAX_CHARS = 12000          // 任务文本上限（§8.5 第 1 步）
export const EXPERT_REQUEST_TABLE_MAX = 256         // 进程内 request 表上限（§8.6）
export function expertPersonaInstruction(ticket: string): string   // §8.5 第 6 步的静态短句（唯一可变 = hex ticket）
export const EXPERT_TASK_OUTPUT_REQUIREMENTS: readonly string[]
export const EXPERT_LOAD_BOUNDARY: readonly string[]
export interface ExpertInvocationExec { readonly agent?: unknown; readonly signal?: AbortSignal; readonly callId?: string }
export type ExpertStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
export type ExpertInvocationFailureCode = ExpertErrorCode | PersonaResolveFailure | PersonaResourceFailure
export interface ExpertInvocationResult { ok: boolean; requestId: string; personaId: string; sourceKey: string; revision: string; childSessionId: string; stopReason: ExpertStopReason; personaLoaded: boolean; text: string; truncated: boolean; warnings: ExpertIssue[]; code?: string; field?: string; message?: string }
export interface ExpertLoadResult { ok: true; personaId: string; name: string; description: string; sourceKey: string; revision: string; body: string; resources: Array<{ path: string; bytes: number }>; skills: Array<{ name: string; required: boolean; action: string; available: boolean }>; boundary: string; warnings: ExpertIssue[] }
export interface ExpertResourceResult { ok: true; personaId: string; path: string; text: string; bytes: number; characters: number; revision: string; resources: Array<{ path: string; bytes: number }>; diagnostics: ExpertIssue[] }
export interface CreateManualRequestInput { sessionId: string; personaId: string; expectedSourceKey: string; expectedRevision: string }
export interface CreateManualRequestResult { requestId: string; expiresAt: string }
export interface ExpertInvocationStats { requests: number; tickets: number; activeSessions: number; activeTotal: number; running: number }
export interface ExpertInvocationService {
  createManualRequest(input: CreateManualRequestInput): CreateManualRequestResult
  runManual(requestId: string, task: string, exec: ExpertInvocationExec): Promise<ExpertInvocationResult>
  runAuto(personaId: string, task: string, exec: ExpertInvocationExec): Promise<ExpertInvocationResult>
  loadForChild(ticket: string, exec: ExpertInvocationExec): Promise<ExpertLoadResult>
  readForChild(ticket: string, path: string, exec: ExpertInvocationExec): Promise<ExpertResourceResult>
  dispose(): Promise<void>
  stats(): ExpertInvocationStats          // 诊断用，只在本模块（不进 ExpertService）
}
export interface ExpertInvocationDeps { db: DatabaseSync; roots: ExpertRoots; platform?: string; probeSubagents: () => SubagentServiceLike | undefined; probeTools?: () => ToolRegistryLike | undefined; preflight: (personaId: string, agent: unknown) => Promise<ExpertPreflightResult>; deniedToolNames: readonly string[]; conditionalDeniedToolNames?: readonly string[]; sanitizeMessage?: (text: string) => string; now?: () => string; timeoutMs?: number; randomTicket?: () => string; resolvePersona?: typeof resolvePersona; readPersonaResource?: typeof readPersonaResource; listPersonaResources?: typeof listPersonaResources }
export class ExpertInvocationError extends Error { readonly code: ExpertInvocationFailureCode; readonly field: string }
export function isSubagentChildAgent(agent: unknown): boolean
export function delegationDepth(agent: unknown): number      // max(header.delegationDepth ?? 0, options.subagentDepth ?? 0)，坏值抛
export function childMaxDepth(agent: unknown): number        // 父深度 + 1（须仍是安全整数）
export function taskHashOf(task: string): string             // 规范化任务的 sha256
export function readStopReason(value: unknown): ExpertStopReason   // 未知值按 'error'，不假装 completed
export function extractText(output: unknown): string         // 只拼 text block，其余忽略
export function readSubagentRun(value: unknown): RunView     // run 四字段逐字段校验（缺 result/dispose 不抛，返回空位）
export function createExpertInvocation(deps: ExpertInvocationDeps): ExpertInvocationService
```

### `src/experts/host-adapter.ts`（新增段）

```ts
export interface SubagentStartRequestLike { readonly label?: string; readonly prompt: readonly { type: 'text'; text: string }[]; readonly parent: unknown; readonly signal: AbortSignal; readonly persona?: string; readonly maxDepth?: number; readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } }
export interface SubagentProviderCapabilitiesLike { readonly agentOptions?: unknown; readonly outputSchema?: unknown; readonly depthLimit?: unknown; readonly toolFilter?: unknown; readonly persona?: unknown }
export interface SubagentProviderLike { readonly name?: unknown; readonly capabilities?: SubagentProviderCapabilitiesLike; readonly inheritsParentContext?: unknown }
export interface SubagentServiceLike { list(): unknown; getProvider(name: string): unknown; start(name: string, request: SubagentStartRequestLike): Promise<unknown> }
export interface ToolRegistryLike { get?: unknown }
export function probeExpertSubagents(ctx: unknown): SubagentServiceLike | undefined
export function probeExpertTools(ctx: unknown): ToolRegistryLike | undefined
export interface ExpertSubagentUnavailable { readonly ok: false; readonly code: 'expert-subagent-unavailable'; readonly message: string }
export type ExpertSubagentSelection = { readonly ok: true; readonly provider: SubagentProviderLike } | ExpertSubagentUnavailable
export function selectSpawnProvider(service: SubagentServiceLike | undefined): ExpertSubagentSelection
```

`start` 的返回刻意是 `unknown`：run 的形状由 `readSubagentRun()` 校验（provider 是第三方实现，形状不符走 `adapter-contract-mismatch`，不做类型断言）。

### `src/experts/service.ts`（新增/扩展成员）

```ts
export interface LiveExpertExec { readonly agent?: unknown; readonly signal?: AbortSignal; readonly callId?: string }
// ExpertService 新增成员：
createManualRequest(input: CreateManualRequestInput): CreateManualRequestResult
runManual(requestId: string, task: string, exec: LiveExpertExec): Promise<ExpertInvocationResult>
runAuto(personaId: string, task: string, exec: LiveExpertExec): Promise<ExpertInvocationResult>
loadForChild(ticket: string, exec: LiveExpertExec): Promise<ExpertLoadResult>
readForChild(ticket: string, path: string, exec: LiveExpertExec): Promise<ExpertResourceResult>
autoSummonEnabled(): boolean
onAutoSummonChange(listener: (enabled: boolean) => void): () => void
```

### `src/experts/tools.ts`（新增段）

```ts
export function runExpertRequestTool(service: ExpertService)          // workbench_run_expert_request（始终注册）
export function loadInvokedExpertTool(service: ExpertService)         // workbench_load_invoked_expert（始终注册）
export function readInvokedExpertResourceTool(service: ExpertService) // workbench_read_invoked_expert_resource（始终注册）
export function summonExpertTool(service: ExpertService)              // summon_expert（仅开关打开且能力可用时注册）
export function expertInvocationTools(service: ExpertService): ReturnType<typeof defineTool>[]
export const RUN_EXPERT_REQUEST_TOOL_NAME = 'workbench_run_expert_request'
export const LOAD_INVOKED_EXPERT_TOOL_NAME = 'workbench_load_invoked_expert'
export const READ_INVOKED_EXPERT_RESOURCE_TOOL_NAME = 'workbench_read_invoked_expert_resource'
export const SUMMON_EXPERT_TOOL_NAME = 'summon_expert'
export const EXPERT_INVOCATION_TOOL_NAMES = [RUN_EXPERT_REQUEST_TOOL_NAME, LOAD_INVOKED_EXPERT_TOOL_NAME, READ_INVOKED_EXPERT_RESOURCE_TOOL_NAME] as const
```

工具参数（snake_case，**没有** session_id / root / 绝对路径）：`workbench_run_expert_request{request_id, task}`、`workbench_load_invoked_expert{ticket}`、`workbench_read_invoked_expert_resource{ticket, path}`、`summon_expert{persona_id, task}`。

## 3. 接线点与顺序（我逐行复核过 diff）

- `src/index.ts`：工具数组里 `...expertGenerationTools(experts)` 之后加 `...expertInvocationTools(experts)`（3 个常驻工具）；新增一个 `ctx.effect(..., 'dsh-personal-workbench: experts-auto')`，其 `sync()` = 先 `release()` 上一轮 disposer → `experts.autoSummonEnabled()` 为假就返回 → `selectSpawnProvider(probeExpertSubagents(ctx)).ok` 为假就返回 → 注册 `summon_expert` 与 `ctx.systemPrompt.section({ name: AUTO_EXPERT_PROMPT_BLOCK_NAME, order: AUTO_EXPERT_PROMPT_ORDER, interpolate: false, text: () => buildAutoExpertPrompt({...}).text })`；`experts.onAutoSummonChange(() => sync())` 驱动重同步；effect 的清理函数先退订再 `release()`。**顶层 `inject` 一行字符未变**（`expertWiring.test.mjs` 断言运行时数组 + 源码那一行）。
- `src/experts/service.ts`：`preflightPersona(personaId, agent)` 是 `preflight` 方法与 invocation deps 的**同一份**实现（§7.3 最近生效者不重复）；`assertNotExpertChild(exec, action)` 只挂在 4 条**写入**路径上（`submitDraft` :862、`stageFile` :881、`removeFile` :907、`validateDraft` :926），load/read 刻意不挂；`capabilities()` 的 `manualSummon/autoSummon.available` 由 `selectSpawnProvider(probeExpertSubagents(ctx))` 真实决定；`setAutoEnabled` 写库后逐个通知监听者（监听者抛错只吞掉，不回滚库）；`dispose()` = `skillInvalidator = undefined` → `autoSummonListeners.clear()` → `await invocation.dispose()`（取消自己拥有的运行并等它们静止），**不关 db、不关别人的 service**。
- `src/experts/invocation.ts` 的执行顺序（§8.5 第 4 步）：探测 + 选 spawn provider → **取并发位** → 建 timer / abort 桥 → `await deps.preflight(personaId, exec.agent)`（不可用就抛，**一个子代理都不启动**）→ 比对记录里的 sourceKey/revision → `resolvePersona` + `assertPinned` → 建 deny → **发 ticket** → `start()`。`persona` 参数只放 `expertPersonaInstruction(ticket)`；任务文本只放 `prompt`；`maxDepth = 父深度 + 1`；`toolFilter = { deny }`。
- `finally`（同一条清理路径，四条不变式之一）：撤销 ticket → 清 `record.cancel` → `clearTimeout` → 摘 `exec.signal` 监听 → `await disposeRun()`（`disposedRun` 守卫保证恰好一次，失败只进 warnings）→ 释放并发位。

## 4. 命令与退出码（主会话独立复跑，同一条命令链）

```
$ pnpm typecheck                                             → TYPECHECK=0
$ pnpm build                                                 → BUILD=0（client lib\client.js 552.64 kB；buildId wb-fc290c643d3d895a，200 个输入文件）
$ node --test test/expertInvocation.test.mjs test/expertWiring.test.mjs test/personaBinding.test.mjs
  ℹ tests 33 / suites 0 / pass 33 / fail 0 / cancelled 0 / skipped 0 / todo 0   → TEST3=0
$ node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs test/expertRoutes.test.mjs test/expertTools.test.mjs test/httpFence.test.mjs
  ℹ tests 80 / suites 0 / pass 80 / fail 0                                      → TESTEXPERT=0
```

分文件计数（与子代理自报一致）：`expertInvocation` 16、`expertWiring` 8、`personaBinding` 9。**未跑**全仓套件（P5 时全仓 `1195 tests / 1194 pass / 1 fail`，唯一失败是既有 `test/db.test.mjs` 清理期 EPERM）；本批新增 16 条，故全仓预期 `1211 / 1210 pass / 1 fail`——**这是推算，不是本轮实测**。

## 5. 独立证据（主会话亲自做的）

1. **主会话自己的反向注入**（与子代理挑的不是同一处）：把 `src/experts/invocation.ts` 里 `acquireSlot` 的上限判定 `if (perSession >= EXPERT_MAX_CONCURRENT_PER_SESSION || total >= EXPERT_MAX_CONCURRENT_TOTAL)` 改成 `if (perSession >= 999 || total >= 999)` → `pnpm build` + 只跑 `test/expertInvocation.test.mjs`：
   ```
   ✖ AX-E44 同父第二个与实例第三个 → expert-busy；完成后释放位（不排队、不重复跑） (60107.39ms)
   ℹ tests 16 / pass 15 / fail 1
   ```
   → 还原后文件 SHA256 与注入前**逐字节相同**（`29BC8900ADA9445FC341AE14AA3FCB26ADE3EC3780EE4057FF271740AE0950B2`），CR 计数 0。结论：并发上限是被**会失败的断言**钉住的，不是靠源码扫描。
2. **子代理的反向注入**（它报告里的原始输出）：拿掉 `requireTicket` 的 `parentSession` 校验 → `✖ AX-E39 …`（`actual: 'ticket-child-mismatch'` ≠ `expected: 'ticket-invalid'`），`tests 1 / pass 0 / fail 1`；还原后 33/33。
3. **主会话修的一处格式**（唯一由主会话直接改的文件内容）：`src/experts/host-adapter.ts` 结尾缺换行 + 新段前多一个空行 → 已补（`565 + 尾空行` → 564 行、CR=0、以 LF 结尾）。
4. **没有**真实 provider 证据：本机 `@deepseek-ai/dsh-subagent-spawn-in-process` 是 cordis 插件（只导出 `Config/apply/inject/name`），要跑起来得先造一个真宿主 + 真 LLM，属 P9 的隔离实例验收范围。因此"真实 SDK 形状"仍按 §8 标未验证。

## 6. AX 对账（P6 部分）

| AX | 结果 | 证据（用例名，全部在 `test/expertInvocation.test.mjs`） |
|---|---|---|
| AX-E36 | ✅ | `AX-E36 手动请求起独立子代理：父绑定逐字不变、persona 只有静态句+ticket、prompt 是任务文本` |
| AX-E37 | ✅ | `AX-E37 过期 / 跨会话 / 换任务都被明确拒绝；同请求同任务只启动一次`（`fake.state.starts.length===1`） |
| AX-E38 | ✅ | `AX-E38 fake start 在返回前跑 loader：claim 成功、run.id 一致、顺序可证`（顺序数组 `['load:ok','run:completed']`） |
| AX-E39 | ✅ | `AX-E39 父/普通会话/别的父的 child/第二个 child 都拿不到票；合法 child 能读；结束后票失效` |
| AX-E40 | ✅ | `AX-E40 运行中改人格文件或换来源 → load/read 拒绝新修订；父绑定行逐字不变` |
| AX-E41 | ✅ | `AX-E41 error/aborted/max-tokens/start reject/result reject…`（dispose 计数 1/2/3/3/4、`stats()` 全 0）+ `AX-E41 超时与 exec.signal 取消…` |
| AX-E42 | ✅ | `AX-E42 空输出 / 未加载人格 / 超 12000 截断：不许伪造成功，childSessionId 是真实 run id` |
| AX-E43 | ✅ | `AX-E43 专家子代理再发起调用或写专家草稿 → 服务守卫拒绝；deny 名单不含不存在的工具名`（含"注册表里有 `summon_expert` 时才进 deny"的反向组） |
| AX-E44 | ✅ | `AX-E44 同父第二个与实例第三个 → expert-busy；完成后释放位（不排队、不重复跑）` |
| AX-E48 | ✅ | `AX-E48 off→on→off：summon_expert 与 plugin:workbench-experts 按开关出现/消失；关闭后新启动被拒、已启动的仍完成`（真 `plugin.apply()` + 真 `POST /api/workbench/settings`） |
| AX-E49 | ✅（1 条根因未验证） | `AX-E49 缺 subagents / 只有 fork / 缺 persona|toolFilter|depthLimit…`、`AX-E49 服务层能力如实…`、`AX-E49 运行前依赖预检不可用…`（`starts.length===0`）、`AX-E49 打开开关但没有合格 spawn provider…`、`AX-E49 完全没有 subagents 服务…`；⚠️ **真实 skills 服务导致的 `skill-scope-unavailable` 根因未验证**（拒绝路径真实，触发源是注入的假 preflight） |

## 7. 规格偏差（逐条：出处 → 实际 → 理由）

1. **§8.5 第 11 步的"钉住身份"提前到建请求时**：`createManualRequest` 当场 `resolvePersona` 并比对 `expectedSourceKey`/`expectedRevision`，不符则 `revision-changed`（不发请求）。→ 让 P7 的"面板显示 → 用户点"之间的人格变更不可能被静默放过。
2. **运行前预检之外再多一道"发起后变化"检查**：`execute` 里比对记录与 `preflight.summary` 的 sourceKey/revision，不符 → `revision-changed`（不启动）。
3. **非 `completed` 的失败码映射**：`aborted` → `canceled`；`error` → `expert-subagent-unavailable`；**`max-tokens` / `refusal` 的 `code` 直接取宿主 stopReason 字面值**（§12.1 封闭枚举里没有对应码，且本批不允许改 `src/shared/**`）。三种情形都同时带**真实 `stopReason`** 与 `message`，绝不冒充成功。→ 宁可露出宿主的词，也不把它错报成"子代理不可用"。
4. **"子代理压根没 claim"不算 `adapter-contract-mismatch`**：只有 `run.id` 与已 claim 的 child 不一致、或缺 `id`/`localAgent`/`result` 才算 provider 契约错；"完成了但没加载人格"仍按 §8.6 报 `expert-persona-not-loaded`。→ 否则"子代理偷懒不加载"会被错报成"adapter 坏"。
5. **deny 名单的条件项**：`summon_expert` 只在 `ctx.tools.get('summon_expert')` 真的返回对象时才进 `deny`（SDK 对不存在的工具名 loud 拒绝，写错会让**所有**专家调用起不来）；`load/read` 两个工具**必须不进** deny（否则子代理永远加载不了人格）。
6. **`src/index.ts` 的自主注册多一道"能力可用"门**（`selectSpawnProvider().ok`）：开关打开但没有合格 `spawn` provider 时不注册 `summon_expert`/提示区块。→ 不给模型一个必然失败的工具；AX-E49 的两条用例固定该行为。
7. **两个常量落在 `invocation.ts`**：`EXPERT_TASK_MAX_CHARS = 12000`（§8.5 第 1 步）与 `EXPERT_REQUEST_TABLE_MAX = 256`（§8.6）；`src/shared/expert.ts` 里只有另外一个量（`EXPERT_REQUEST_MAX_CHARS = 2000`，指请求字段），且本批不可改 shared。→ 建议 P7/后续上提到 shared。
8. **子代理守卫用既有封闭码 `expert-disabled`**：§12.1 没有"该身份被禁止再发起"的码；服务侧守卫对 `runManual`/`runAuto`/`submitDraft`/`stageFile` 一律回 `expert-disabled`，AX-E43 把这条钉住。
9. **`stats()` 只在 `ExpertInvocationService`**：测试要靠它证明"无残留运行 / ticket / 并发位"；`ExpertService` 不多开一个生产 API。
10. **auto 去重的两个副作用**：①同一 `(sessionId, callId)` 换任务会复用 `manual-request-task-changed` 这个 manual 语义的码；②`exec.callId` 缺失时退化为随机 `anon-<hex>` 身份 ⇒ **不去重**（同一工具执行重复分派会各起一次）。
11. **失败结果也会被缓存**：`record.completed` 一旦写入，同请求同任务再调用返回**同一份失败**（不重启子代理）。这是 §8.6"同 request 同进程返回同一 Promise"的必然结果；用户要重试必须先建新请求。
12. **run 形状校验额外要求 `localAgent` 非空**：`SubagentRun.localAgent` 在宿主类型里是 `Agent | undefined`，但本批只用 `spawn`（本地 run 契约要求它存在），缺它按 `adapter-contract-mismatch` 处理。

## 8. 未验证项（如实标注，一律不算通过）

1. **真实宿主 provider / 真 `SubagentRuntime` / 真 LLM：全部未验证。** 全部 provider 交互只跑在忠实假实现上，因此以下只是"对着假实现验证过"：真 `startInProcessRun` 的"resolve 前先跑第一轮"时序、真 `run.dispose()` 幂等性、真 provider 的 `stopReason` 取值、真 child 的 `header.origin/parentSession/delegationDepth`、真 `persona` 参数的严格 `{{…}}` 插值、真 `ToolRuntime` 对 deny 里未知名字的 loud 拒绝（本批用 `ctx.tools.get()` 自查 + 假注册表代替）。
2. **真实 skills 服务导致的 `skill-scope-unavailable` 根因**未验证（拒绝路径用注入的假 preflight 跑通）。
3. **真 cordis 热重载未验证**：`ctx.effect` 的注册/注销只在假宿主里验证过（disposer 真的摘掉注册）。
4. **真实 `~/.dsh/workbench` 现场与 19387 实例**未跑（按纪律本轮不碰当前实例）。
5. **`subagents` 服务"晚到"**：装配时不可用、之后才注册的场景下本批不会重同步（只在设置变化时 `sync()`）；真实宿主通常启动即有，未验证。
6. **P7 的客户端 UI / `@` / `/expert`** 未做（本批不含 `src/client/**`、`src/api/**`）。
7. **macOS / Linux 平台差异**未测（全批在 Windows 上跑）。
8. **真实"模型不调用 loader"场景**：AX-E42 只证明"未加载就被正确判定"，真实模型是否会照做属 P9。

## 9. 给 P7 的接线义务（每条一个动作）

1. `POST /api/workbench/experts/manual-requests` → `service.createManualRequest({ sessionId: <界面真实会话>, personaId, expectedSourceKey, expectedRevision })`。
2. `expectedSourceKey` / `expectedRevision` **必须**取自 `service.preflight(personaId, liveAgent).summary`（不要取目录列表里的值，否则运行时必 `revision-changed`）。
3. ticket **只走工具参数**：不要给 `loadForChild`/`readForChild` 开 HTTP 入口（P6 已刻意不提供），也不要把它塞进 UI 请求体。
4. **不要重复注册工具**：3 个常驻调用工具已由 `...expertInvocationTools(experts)` 注册；P7 只加 UI/命令，不加注册点。
5. `summon_expert` 与 `plugin:workbench-experts` **只**由 `src/index.ts` 里那一个 `ctx.effect('dsh-personal-workbench: experts-auto')` 按 `autoSummonEnabled()` + `onAutoSummonChange` 动态增删；P7 不要另开注册路径。
6. `@` / `/expert` 的触发必须走 `service.runManual / service.runAuto`（不要直接持 invocation 实例：请求表、开关复查、并发位都是单份的）。
7. 面板可用性一律读 `service.capabilities()` 的 `manualSummon.available` / `autoSummon.{available,enabled}`，不硬编码、不从设置页猜。
8. 失败投影复用 `service.projectFailure`（已含 `ExpertInvocationError` → `expertErrorStatus`），不自造错误码；`ExpertInvocationResult.code` 可能是宿主 stopReason 字面值（`max-tokens`/`refusal`），投影时别假设它一定在 §12.1 里。
9. 结果里的 `childSessionId` 是**真实** run id（截断时也保留），UI 应提供"打开真实子会话"。
10. `EXPERT_TASK_MAX_CHARS` / `EXPERT_REQUEST_TABLE_MAX` 目前在本模块导出；若 P7 需要在 HTTP 层复用同一个上限，**引用这两个常量**，不要各写一个字面量。

## 10. 复核与修复记录

- 子代理 7 文件零越界；`inject` 逐字未变；未加依赖；未执行 git。
- 主会话逐段读完 `invocation.ts`（1284 行全部）+ `service.ts`/`tools.ts`/`index.ts` 的 diff + `host-adapter.ts` 新段 + 测试的 AX-E43/E44/E48 三个用例体。
- 发现并修：`host-adapter.ts` 缺尾换行 + 段前多空行（§5.3）。**未发现功能缺陷**，故本轮没有"修复轮"。
- 报告口径纠正一处：子代理报告 §6-1 写"非 completed 的 error/max-tokens/refusal **统一**映射成 `expert-subagent-unavailable`"，与代码不符（实际见 §7-3）。以本文件为准。
- 主会话另做一处独立反向注入（§5.1），并复核了子代理的注入原始输出。
- P5 交接稿的 `methodology()` 签名漂移已改正（`P5-handover.md:40`：同步 `ExpertMethodology`，不是 `Promise`）。

## 11. 过程事实（给后续批次避坑）

1. **`start` 真的可能在返回前跑完第一轮**（本机 `startInProcessRun`：创建后立即 drive）：ticket 必须**先**登记、claim 不能要求 run 已存在、run 返回后还要与已 claim 的 child 对账。AX-E38 就是照这个时序写的。
2. **一次调用一张表**：service 层与直连 invocation 各有一份 request/ticket 表，测试里"用 A 建请求、用 B 跑调用"必然 `manual-request-not-found` / `ticket-invalid`。生产只有一份（service 内部持有）。
3. **假 provider 里 hook 抛错会被吞成"启动失败"**：断言失败会被映射成 `ok:false, code:'expert-subagent-unavailable', message:'启动专家子代理失败：<原始断言>'`；写用例时 `assert.equal(result.ok, true, ...)` 必须带 `JSON.stringify(result)`，否则排查全靠猜。
4. **dispose 必须恰好一次**：契约错配 / 超时 / 取消 / `finally` 四条路径都会想 dispose，靠 `disposedRun` 守卫；AX-E41 的计数断言（1/2/3/3/4）就是它的哨兵。清理失败只进 `warnings`，不许遮盖原结果。
5. **`readForChild` 只 claim 不置 `loaded`**：只读不加载的调用最终以 `expert-persona-not-loaded` 收尾，这是规范行为，别当 bug。
6. **失败用例可能很慢**：我注入并发上限 bug 后 AX-E44 挂了 **60s** 才失败（等位/等超时）；正常路径该用例 ~154ms。看到"某用例忽慢"先怀疑是不是刚好撞上被注入的打桩。
7. **deny 名单要对着当前注册表构建**：`summon_expert` 是条件注册的，SDK 对未知名字 loud 拒绝；装配级用例里的假 `tools.get` 必须像真 `ToolRuntime` 一样反映 `register()` 之后的注册表，否则"名单里没有不存在的名字"会假绿。
