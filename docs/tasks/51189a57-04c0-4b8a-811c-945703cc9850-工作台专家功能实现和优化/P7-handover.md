# P7 交接：手动入口（`@` 引用 / `/expert` 命令 / `POST manual-requests`）

> 给 P8（客户端界面 / 集成验收）与 P9（真实包、真实 SDK、真实 LLM）。
> 本批只做"手动入口"三件：独立 `@` 引用源、`/expert` 宿主命令、HTTP `POST /experts/manual-requests`。
> **三件都只"建请求"，不启动任何专家子代理**；子代理启动仍只能由 P6 的调用主链按需触发。

---

## 1. 交付物

| 文件 | 行数 | CR | sha256 | 状态 |
|---|---|---|---|---|
| `src/experts/command.ts` | 253 | 0 | `A3E1DA683F2A85D2E56CE80FE04EB127882B0F5F0CC43C573E4EC2081A7D4F24` | 新增 |
| `src/client/expertPrompt.ts` | 85 | 0 | `E4675832EDE6F0A20298F3BBE1AA435ED9C84C70C3DA9EE62C7628F98ACF5947` | 新增 |
| `src/client/expertInputSource.ts` | 580 | 0 | `FF3C3F9D11B9988365BB03E1345FF914A00C802BEF068EF1632831ACFFBD8640` | 新增 |
| `test/expertInputSource.test.mjs` | 566 | 0 | `FBE61B16570C1E78D92D11B0FBD5A2E816D3A93FA1D577618D743062444CC55C` | 新增（16 条） |
| `test/expertCommand.test.mjs` | 425 | 0 | `4ACE31C9C4683E7F756B59D1AFD1958DD6084458282127D2D21BE9B288E00B89` | 新增（18 条） |
| `src/api/routes/experts.ts` | 244 | 0 | `C6FFB0B927CEEFE112EFBD14291F16FA5A82A5D5017CBCAD6FFCD537EE9B988A` | 修改 `+31 −2` |
| `src/index.ts` | 713 | 0 | `81734B1E687750DD89027706BF0CF29265F8F91E6D3BFA4B905FC4273C19A110` | 修改 `+45 −2` |
| `src/client/index.tsx` | 1985 | 0 | `454D77A46C73C34656D1891B3EF38C1E1A5E6241180E5C4962AE992CF0434231` | 修改 `+14 −1` |
| `tsconfig.build.json` | 87 | 0 | `0DCC6550004CC6AAC7A740E7BA97D9024F05A76E27104A5A3F19158E4D1FF07C` | 修改 `+3 −0` |

只读、逐字未变（P8 修改前请先核对）：`src/client/capabilities.ts`（133 行，sha256 `0C5326113D5606B9BE0781139999BD20D76EBDD6869B603DB8226818ACC430EF`，`inject` 精确 5 项）与 `src/index.ts:53` 的顶层 `inject` 4 项。

**`src/experts/command.ts` 的 sha256 与子代理自报值不同**：子代理报 `CFF465BA…41D1C` 是修前值；主会话复核时改了 `:232` 一处注释出处（见 §10），本表为修后值，其余四个新文件的哈希与子代理自报前缀一致。

---

## 2. 逐字导出签名（P8 直接照抄）

### `src/experts/command.ts`

```ts
export const EXPERT_COMMAND_USAGE = '/expert <persona-id> -- <任务>'
export const EXPERT_COMMAND_HELP_MAX_IDS = 20
export type ExpertCommandParse =
  | { ok: true; personaId: string; task: string }
  | { ok: false; code: 'empty' | 'missing-separator' | 'missing-persona' | 'missing-task' }
export function parseExpertCommand(rawInput: unknown): ExpertCommandParse
export function expertHelpIds(catalog: { personas?: { id?: unknown }[] } | undefined): string[]
export function expertCommandHelp(ids: readonly string[]): string
export interface ExpertCommandAgentProbe { session?: { id?: unknown }; steer?: unknown }
export interface ExpertCommandInvocationProbe { agent?: unknown; rawInput?: unknown }
export interface ExpertCommandDefinitionProbe { name: string; description: string; input?: unknown; handler: (...) => ... }
export interface ExpertCommandDeps { experts: { preflight(...): ...; createManualRequest(...): ... }; catalog?: ... }
export function expertCommandDefinition(db: unknown, deps: ExpertCommandDeps): ExpertCommandDefinitionProbe
```

- `parseExpertCommand` 只用 `text.indexOf(' -- ')` + `slice(0, at).trim()` / `slice(at + 4).trim()`；**只可能返回 `empty` / `missing-separator`**（`missing-persona` / `missing-task` 是不可达分支，已删；联合里的字面量保留是为了不破坏类型形状）。
- `expertCommandDefinition` handler 顺序（每步失败都返回可读中文 `kind:'error'`，且**失败即不建请求、不 steer**）：
  解析 → 取 `agent.session.id` → 查 `agent.steer` 是函数 → `experts.preflight(personaId, agent)` 取 `summary.sourceKey/revision/name` → `experts.createManualRequest({...})` → `agent.steer(createUserMessage({ content: [{ type:'text', text: buildExpertInvocationPrompt({ requestId, task }) }], source: { kind:'user' } }))` → `{ kind:'success' }`。
- steer 写法**逐字镜像** `/workbench`：`src/index.ts:246-249`；`createUserMessage` 自 `src/index.ts:9` 起就是本插件既有 import（`@deepseek-ai/dsh-llm` 一直只在 devDependencies，**不在** peerDependencies —— 既有事实，非 P7 引入）。

### `src/client/expertPrompt.ts`

```ts
export const EXPERT_INVOCATION_DIRECTIVE: readonly string[]   // 5 行，逐字照 方案-v0.3.md:654-660
export const EXPERT_REQUEST_ID_MAX_CHARS = 200
export function requireExpertRequestId(value: unknown): string
export interface ExpertPromptInput { requestId: string; task: string }
export function buildExpertInvocationPrompt(input: ExpertPromptInput): string
```

`requireExpertRequestId` 三分支：非字符串 / 空 / 超 200 字 / 含 `["'` + `\r\n` + `\u0000-\u001f\u007f]` 一律抛错（防注入进 steer 文本）。正文**不内联人格**（人格由 P6 主链按 ticket 解析）。

### `src/client/expertInputSource.ts`

```ts
export const EXPERT_REFERENCE_SOURCE = 'workbench-expert'
export const EXPERT_TRIGGER_NAME = 'workbench-expert'
export const EXPERT_TRIGGER_ORDER = 20
export const EXPERT_CANDIDATE_PREFIX = 'expert:'
export const EXPERT_REF_VERSION = 1
export const EXPERTS_CATALOG_PATH = '/experts/catalog'            // :48
export const EXPERTS_PREFLIGHT_PATH = '/experts/preflight'        // :49
export const EXPERTS_MANUAL_REQUESTS_PATH = '/experts/manual-requests'  // :50
export const MAX_ID_CHARS = 512
export interface ExpertRef { version: 1; sessionId: string; personaId: string; sourceKey: string; revision: string }
export function encodeExpertRef(ref: ExpertRef): string
export function decodeExpertRef(raw: unknown): ExpertRef | undefined
export function expertClipboardText(personaId: string): string    // '@expert:<personaId>'
export function expertCandidatesFromCatalog(catalog: unknown): InputTriggerCandidate[]
export function filterExpertCandidates(candidates, query): InputTriggerCandidate[]
export function expertCandidatePersonaId(candidate): string | undefined
export function createExpertInputSource(deps): InputTriggerSource
export type ExpertApiCall = (path: string, init?: {...}) => Promise<unknown>
export function createExpertInputSourceFromApi(call: ExpertApiCall = api): InputTriggerSource
export function createExpertInputTriggerRegistrar(host, options?): { register(): void; isRegistered(): boolean; dispose(): void }
export function installExpertInputSource(ctx, createRegistrar?): () => void
```

- source 只声明 `trigger: '@'` / `name` / `order: 20` / `candidates` / `onPick` / `codec`；**没有 `matchSpace` / `matchEnter`**（不能抢文件引用的空格/回车提交），**没有 `lexicon` / `subscribeLexicon` / `warm` / `openReference`**。
- 候选 `name = 'expert:' + personaId`、`label` = 专家名、`description` = 简介、`value` = 严格 JSON（`personaId` / `sourceKey` / `revision`）。
- `onPick` **同步返回** `{ insert: { source, ref, label, clipboardText } }`，不 await、不发 HTTP。
- `codec.serialize(ref)` 顺序：解码 ref（坏 ref → 抛）→ `signal?.aborted` 早拒 → `getPreflight({ personaId, sessionId })` 取**当前** `sourceKey`/`revision`（空 → 抛）→ `postManualRequest`（用 **ref 里的 sessionId**，不读全局当前会话）→ 校验 `requestId` 非空且 ≤ 200 → `buildExpertInvocationPrompt({ requestId, task: '' })`。**任何失败都抛出，绝不回落成普通 `@` 文本**。
- `createExpertInputTriggerRegistrar.register()` 第一行 `if (disposed) return`，随后 `release()` 上一份再注册（恒一份）。
- `installExpertInputSource` 用 `ctx.inject(['inputTriggers'], cb)` 子 fiber 软注入；返回值只交宿主；外层返回幂等 disposer。**`inputTriggers` 绝不进 `capabilities.ts` 的 `inject`**（`test/capabilities.test.mjs` 的 I3 断言精确 5 项）。

### 修改文件里的新增段

- `src/api/routes/experts.ts`：`head === 'manual-requests'` 分支 —— 非 `POST` → `405`；`requireText(body, 'sessionId' | 'personaId' | 'expectedSourceKey' | 'expectedRevision', MAX_ID_CHARS)` → `service.createManualRequest({...})` → `writeJson(res, 200, { ok: true, requestId, expiresAt })`。**只建请求**；ticket 没有任何 HTTP 出口；`expectedSourceKey`/`expectedRevision` 的比对由服务端 `createManualRequest` 自己重 resolve 后再比（不符 → `revision-changed`，一条请求都不建）。
- `src/index.ts`：新增 `registerExpertCommand(ctx, db, experts)`，在 `applyReady` 里紧跟 `registerWorkbenchCommand(ctx, db)` 之后调用；内部 `ctx.inject(['commands'], …)` 软探测（缺服务只 `logger.warn` + `console.warn`，不抛），`ctx.effect(() => commands.register(expertCommandDefinition(db, { experts })), 'dsh-personal-workbench: expert-command')`。另把 `CommandDefinitionProbe.handler` 返回类型放宽为 `CommandResult | Promise<CommandResult>`（宿主 `dsh-commands/lib/types/index.d.ts:54` 就是这么写的），`AgentProbe` 加 `session?: { id?: unknown }`。

---

## 3. 接线点与顺序（主会话逐行复核过 diff）

1. `src/client/index.tsx`：`import { installExpertInputSource } from './expertInputSource'`；客户端启动段里 `const disposeExpertInput = installExpertInputSource(ctx)` + `officialDisposers.push(disposeExpertInput)`。全文件**只有这一处** `ctx.inject(['inputTriggers'])`（在 `expertInputSource.ts` 里；有源码扫描断言锁着，别再写第二段）。
2. `src/index.ts`：`applyReady` 里 `/workbench` 命令注册之后接 `registerExpertCommand(ctx, db, experts)` —— 两个命令同层、各自 `ctx.effect`。
3. `src/api/routes/experts.ts`：`manual-requests` 走既有围栏（`readBody` / `writeJson` / `requireText`），不改写 `head`、不碰 socket。
4. `tsconfig.build.json`：+3 条 include（`src/client/expertPrompt.ts`、`src/client/expertInputSource.ts`、`src/experts/command.ts`）。其中 `src/experts/command.ts` 那条**冗余可删**（`src/index.ts` 静态 import 已把它带入 tsc 依赖图；实测删掉仍 `build 0` 且 `lib/experts/command.js` 仍生成）；两条 client include **不能删**。

---

## 4. 命令与退出码

主会话独立复跑（同一条命令链；子代理自查数字与之一致，仅 buildId 因两次构建而不同）：

| 命令 | 退出码 | 计数 / 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | — |
| `pnpm build` | 0 | buildId `wb-56b6a671db50d923`（203 个输入文件）；`lib\client.js` 559.78 kB / gzip 166.22 kB。子代理那次是 `wb-b0a2050e7ef23c0e`，同 203 输入 |
| `node --test test/expertInputSource.test.mjs test/expertCommand.test.mjs test/capabilities.test.mjs` | 0 | `tests 40 / pass 40 / fail 0` |
| `node --test` 专家域 9 文件（expertRoutes / expertTools / expertWiring / expertProvider / expertCatalog / skills / httpFence / pluginEntry / personaLibrary） | 0 | `tests 146 / pass 146 / fail 0` |
| `node --test test/*.test.mjs`（全仓） | 1 | `tests 1244 / pass 1243 / fail 1`（duration 约 11.2 s） |

全仓唯一失败与 P5/P6 基线同源、**非本批引入**：`test/db.test.mjs` 的 "db migrations, dictionaries and task tree"（单独跑也失败：`tests 9 / pass 8 / fail 1`），错误是 `Error: EPERM, Permission denied: \\?\C:\Users\<user>\AppData\Local\Temp\dsh-personal-workbench-db-KXtbln`（临时目录清理期）。另注：`test/verifySafety.test.mjs:351` 会打出一行带 `✖` 前缀的诊断文本（内容是"拒绝继承 profile 目录…"），但它**不在** failing tests 列表里、不计入 `fail`。

基线推算：P5 `1195 / 1194 / 1` + P6 新增 16 + P7 新增 34 → 期望 1245，实测 1244（差 1 条，未追根因；纯计数差，不影响任何断言结论）。

---

## 5. 独立证据（主会话亲自做的，不是子代理自报）

- **反向注入（另挑一处，非子代理已做过的）**：删掉 `expertInputSource.ts` 里 `register()` 的 `if (disposed) return` 守卫 → `build 0` 但 `node --test test/expertInputSource.test.mjs test/expertCommand.test.mjs` = `tests 33 / pass 31 / fail 2`（两处断言变红）→ 还原后 sha256 = `FF3C3F9D11B9988365BB03E1345FF914A00C802BEF068EF1632831ACFFBD8640`，与注入前逐字节相同（也与子代理自报前缀一致）。⇒ 该生命周期守卫由**会失败的断言**守住，不是源码扫描。
- **diff 逐行读完**（4 个已跟踪文件 `+93 −5`），**三个新模块全文通读**（`expertPrompt.ts` 85 / `command.ts` 253 / `expertInputSource.ts` 580 行）：**未发现功能缺陷，故本批没有修复轮**，只做了 §10 的两处小修。
- **注释引用核对**：`EXPERT_INVOCATION_DIRECTIVE` 5 行与 `方案-v0.3.md:654-660` 逐字一致；`src/index.ts:246-249` 确是 `/workbench` 的 steer；`dsh-commands/lib/types/index.d.ts:54` 确是 `readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>`。
- **静态检查**：两个新测试文件无 `.only` / `.skip`；工作树无探针、无备份、无 `REVERSE-INJECTION` 残留；10 个相关文件 CR=0 且以 LF 结尾。
- **测试真实性**：`expertCommand.test.mjs:24` 真 import `makeExpertRoutes`，`:312-320` 真起 `http.createServer` + `server.listen(0, '127.0.0.1')` + `fetch` 打真端点（不是 mock 围栏）。

---

## 6. AX 对账（P7 部分：AX-E45–E47、AX-E51）

全部 ✅。逐条证据（用例名 = 断言位置）：

**AX-E45（8 条）**
- `test/expertInputSource.test.mjs:165` 两个独立 `@` source 并存：专家源是 `name=workbench-expert` 的另一个 source，不抢文件仲裁
- `:209` codec 异步成功：serialize → preflight → manual-requests → 短指令（严格顺序）
- `:512` 接线：专家 `@` 源只在 entry 里用一行装配（子 fiber 软注入），且 `inputTriggers` 不在 `inject` 里
- `:524` 源模块不认识 fetch / URL / document / React（纯逻辑，可被 `node --test` 直接驱动）
- `:534` ref 编解码：版本化 JSON、四字段非空、坏版本/非 JSON 一律拒绝
- `:547` 候选过滤：按名字/显示名/简介匹配，空查询返回全部且不改顺序
- `test/expertCommand.test.mjs:352` HTTP 契约：`POST manual-requests` 合法 body → `200 {ok:true,requestId,expiresAt}`，且字段原样交给服务
- `test/expertCommand.test.mjs:295` 注册外壳的模块归属：命令解析只在 `src/experts/command.ts`，HTTP 契约点只在 `src/client/expertInputSource.ts`

**AX-E46（7 条）**
- `test/expertInputSource.test.mjs:244` serialize 失败保留输入并阻止发送：preflight 说不可用 ⇒ 抛可读错误、不建任何 request
- `:266` HTTP 失败：`manual-requests` 抛错 ⇒ serialize 抛同一原因，绝不静默返回普通文本
- `:284` 身份变动：目录里的 revision 变了，serialize 用 preflight 的**当前**值
- `:300` 跨会话复制：serialize 只认 ref 里的 `sessionId`，不读"全局当前会话"
- `:315` 坏 ref / 坏候选 / 取消：一律拒绝，且不产生任何请求
- `:341` `inputTriggers` 缺失：源不注册、打一条可读日志、不抛（面板与 `/expert` 照常可用）
- `test/expertCommand.test.mjs:370` 契约：非 POST → 405；缺字段 → 400 `invalid-payload` 且不建请求；身份不符 → 走 `service.projectFailure`；`:415` 既有围栏没被绕过

**AX-E47（11 条，全在 `test/expertCommand.test.mjs`）**
- `:90` parseExpertCommand：第一个 `" -- "` 分隔，左右各自 trim
- `:114` `expertHelpIds` / `expertCommandHelp`：最多 20 条、按 catalog 顺序、空目录有兜底文案
- `:131` 无参数：返回帮助 + 最多 20 条可用 ID，一个请求都不建
- `:140` 缺分隔符（含缺一侧空格 / 缺 ID / 缺任务）：都是 `kind:error` + 格式说明，且**不建 request**
- `:158` 用显示名而不是 ID：报错并提示改用 ID（不猜、不模糊匹配）
- `:167` 合法命令：preflight 取 summary → 同一条 `createManualRequest` → steer → success
- `:199` 无会话身份 / 无 steer：都不建请求（身份与投递通道缺一不可）
- `:211` steer 失败：如实报"请求已建立但送达失败"（不谎报成功、不隐藏 id）
- `:223` 建请求失败（`revision-changed`）：返回可读错误、不 steer 任何东西
- `:234` 目录读不出来不影响合法命令：帮助降级，但按 ID 的命令照常成功
- `:248` 没有专家服务时工厂当场拒绝（不是"注册一个永远报错的命令"）

**AX-E51（3 条）**
- `test/expertInputSource.test.mjs:380` 子 fiber 生命周期（仿 cordis）：注册 3 轮后恒为一份，dispose 后归零
- `:421` 卸载后再触发的异步回调不写上下文：`isRegistered` 一直是"没有东西在册"
- `:436` 入口装配（`installExpertInputSource`）：缺 `ctx.inject` / inject 抛错都只记日志；3 轮装配恒一份、清理归零；另 `test/expertCommand.test.mjs:272` 缺 `commands` 服务：入口必须"软探测 + 可读日志 + 不抛 + 不进 inject"，`:281` 入口源码断言（`/expert` 与 `/workbench` 同层注册、顶层 `inject` 逐字不变）

---

## 7. 规格偏差（逐条：出处 → 实际 → 理由）

1. **`serialize` 在建 request 之前多调一次 `preflight`**（`方案-v0.3.md:644-666` §8.3 的字面顺序是 ref → `manual-requests`）。实际：解码 ref → `preflight` 取**当前** `sourceKey`/`revision` → `manual-requests`。理由：这正是 P6 交接 §9-2 与 AX-E46"身份变动即拒"的要求（`createManualRequest` 会自己重 resolve 并比对，客户端必须转发**当前**值而不是目录里的旧值）。代价：提交时多一次 HTTP 往返。**这是主会话复核时新识别出的偏差，子代理未自报。**
2. **`missing-persona` / `missing-task` 两条分支已删除**：能匹配 `" -- "` ⇒ 左右 trim 后都非空，两条分支不可达。用户可观察行为不变（空输入 / 缺分隔符 / 缺一侧空格三类错输入都返回 `kind:'error'` + 格式说明 + 不建 request）；`ExpertCommandParse` 的 code 联合保留这四个字面量以免破坏类型形状。
3. **`tsconfig.build.json` 里 `src/experts/command.ts` 那条 include 冗余**（原因见 §3-4）。按任务书要求保留；想精简可删，删前请重跑 `pnpm build` 并确认 `lib/experts/command.js` 仍生成。
4. **入口装配收进 `installExpertInputSource` 一行**：`index.tsx` 有"不许再涨"的红线，且时序写进入口后只能靠源码扫描证明；可观察行为与计划一致。

---

## 8. 未验证项（如实标注，一律不算通过）

1. **真实宿主未跑**：没起 19387、没点过 `@` 菜单。源并列、引用胶囊外观、`onPick` 后草稿里的 ref 呈现，全都只对着假 `host` 验过。
2. **宿主在 `codec.serialize` 抛错时的 UI 行为未验证**：`方案-v0.3.md` 说"保留输入并阻止发送"，那是宿主契约；本批只证明"抛错且不回落成文本"。
3. **跨会话复制拒绝未端到端验证**：`manual-request-session-mismatch` 属 P6/服务端（`createManualRequest` 的 session 校验）；客户端侧只证明 serialize 用 ref 的 `sessionId`。
4. **真实 `agent.steer` 未跑**：`CommandInvocation.agent` 的真实形状（`session.id`、steer 投递语义、失败模式）只对着忠实假实现验过。
5. **`pnpm test` 全量脚本未跑**：用的是等价的 `node --test test/*.test.mjs`（本批禁 `pnpm test` 因为会跑 lint/其它脚本）。
6. **`index.tsx` 的"净行数变化"当时无法用 git 核对**（子代理批内禁 git）；主会话已用 `git diff --numstat` 补上：`+14 −1`（1986 → 1985 行含 §10 小修）。
7. **真实 provider / 真 `SubagentRuntime` / 真 LLM 全部未跑**（同 P6 §13.6）。
8. **macOS / Linux 未测**（本机 Windows + DSH 0.2.0-rc.2）。

---

## 9. 给 P8 的接线义务（每条一个动作）

1. 集成验收必须**真起宿主点一次 `@` 菜单**：确认专家源与文件源并列、引用胶囊出现、**发送时才发 HTTP**（`onPick` 不发请求）。
2. 面板接 `childSessionId` 的"打开会话"（P6 已埋 `childSessionId`）。
3. catalog 拉取失败只降级 `/expert` 的帮助，不要让命令整体不可用（`test/expertCommand.test.mjs:234` 已锁这条）。
4. 三个端点常量集中复用 `src/client/expertInputSource.ts:48-50`，不要另写字面量。
5. `tsconfig.build.json`：`src/experts/command.ts` 那条 include 可删，两条 client include 不能删。
6. 展示"身份已变更"时取 `preflight` 返回的 `summary`（当前值），不要拿 catalog 里的旧值。
7. **不要给 `/expert` 加显示名模糊匹配**（AX-E47 明确要求"报错并提示改用 ID"）。
8. 宿主 d.ts 若变了（`InputTriggerSource` / `ReferenceInsert` / `CommandResult`），改动面只应落在 `ExpertInputSourceView` / `createExpertInputSource` 一处。
9. 不要在 `src/client/index.tsx` 写第二段 `ctx.inject(['inputTriggers'], …)`（有源码扫描断言锁着）。
10. 改 `EXPERT_INVOCATION_DIRECTIVE` 正文会撞 `test/expertCommand.test.mjs:194` 的逐字比对。

---

## 10. 复核与修复记录

- **格式修复 ①**：`src/client/index.tsx` 新段之后多一个空行 → 删除（1986 → 1985 行）。修法是删掉多余空行，未改任何代码语义。
- **注释修复 ②**：`src/experts/command.ts:232` 原注释把 steer 镜像出处写成 `src/index.ts:209-212`（那是 handler 的解析段，不是 steer），改为 `src/index.ts:246-249`，并注明 `createUserMessage` 自 `src/index.ts:9` 起就是既有 import 口径。⇒ 该文件 sha256 由 `CFF465BA…41D1C` 变为 `A3E1DA683F2A85D2E56CE80FE04EB127882B0F5F0CC43C573E4EC2081A7D4F24`。
- 修完重跑：`typecheck 0` / `build 0`（buildId `wb-56b6a671db50d923`）/ 三件套 `40/40` / 专家域 9 文件 `146/146` / 两文件 CR=0 且以 LF 结尾。
- **无功能缺陷，本批没有修复轮。**

---

## 11. 过程事实（给后续批次避坑）

1. `pnpm build 2>&1 | Select-Object -Last 3` 会折叠退出码与 `error TS`（看到 "Build complete" 可能是上一次的尾巴）——本批被它骗过一次，改用 `Select-String -Pattern "error TS|buildId|Build complete"` + 单独读 `$LASTEXITCODE`。
2. Node 20+ 用 `execFileSync` 直跑 `.CMD` 抛 `EINVAL`，且 `error.stdout` / `error.stderr` 都是 `undefined` ⇒ 会把"构建根本没跑"误判成成功。必须 `spawnSync(..., { shell: true })` 并单独断言构建状态。
3. 反向注入要防"顺序覆盖"掩盖空壳（子代理 R2b 的修法：round 0 只跑子 fiber 的 disposer，把断言插在两次调用之间）。
4. 解析器不能混用两把尺子：`raw.trim().indexOf` 配 `raw.slice` 会让前导空白错位两位；统一在原文上 `indexOf` + `slice` + 各自 `trim`。
5. `console.warn` 的替身不能转调自己（爆栈），只许推进数组。
6. PowerShell 的 `-replace` + `Set-Content` 会以 ANSI 重写、毁掉中文；改文件一律走 Node 读写或 `edit` 工具。
7. 死代码要删不要留（不可达分支留着会让人以为还有行为）。
8. 已知既有失败：`test/db.test.mjs` 清理临时目录 EPERM —— 不是本批引入，别顺手"修"它。
9. 全仓跑测试时，`✖` 前缀的行不一定是失败（`test/verifySafety.test.mjs:351` 的诊断文本就带 `✖`）；以 `fail` 计数与 "failing tests" 列表为准。
10. 工作树里 `docs/design/2026-10-03-专家市场-调研.md`（用户改动 523 行）与 `docs/tasks/700bd8b2-…-Github-PR与Issue调研合入/`（用户另一个会话的产物）**不是本批内容**，不要提交、不要清理。
