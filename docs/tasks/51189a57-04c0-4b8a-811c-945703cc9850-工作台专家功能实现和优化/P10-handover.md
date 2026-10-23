# P10 交接：模型层三项（AX-E60–E62）改走**真实 DSH 会话通道**的真检查

> 给后续批次与维护者。
> 本批做的是**验收脚本的模型层**：把 P9 留在 `scripts/verify/suites/expert.mjs` 里的 3 条模型层 `skip`
> （AX-E60/E61/E62）换成**真跑**——不再试图自己起 headless 进程调模型，而是**走产品自己的那条通道**：
> 插件客户端新建一个**独立 DSH 会话**，把请求当普通用户消息发进去，该会话自己的 AI 再调用插件注册的
> 5 个草稿工具完成生成；判据取自**那个会话的 JSONL 工具调用记录** + **目标库草稿行**。
> **本批不改任何产品源码**（`src/**`、`test/**`、`package.json`、`pnpm-lock.yaml` 全部零改动），
> 只改 1 个验证脚本 + 4 个文档。
> 上游交接：`P9-handover.md`（其 §10-1「让 3 条模型断言真跑起来」是本批的输入）。

---

## 1. 本批目标（逐字来自用户口径）

1. 「生成专家」的通道**不是**插件直接调 LLM，而是**独立 DSH 会话 + 普通用户消息 + 该会话自己的 AI 调 5 个草稿工具**。
   用户明确要求这条通道**保持现状**。
2. 因此模型层验收必须**通过真实 DSH 会话**完成：**禁止**换假 provider、**禁止**伪造模型响应、
   **禁止**新增隐式 skip 白名单（`scripts/dev-verify.mjs` 的 `ALLOWED_REQUIRED_SKIPS` 一个字不许加）。
3. P9 那 3 条模型断言（`expert.mjs` 约 `:1037` `:1044` `:1051`）必须换成真跑；
   跑不动就 `skip` + **具体阻塞原因 + 收集到的原始证据**，**绝不假通过**。
4. 真实模型调用总计 **≤6 次**，记录每次耗时与结果；原始证据（截图 / JSONL 摘录 / SQL 输出）落到 `--evidence-dir`。

---

## 2. 机制（真实会话通道，含代码位置）

**通道逐级（这就是"生成专家"真正怎么走）**：

| 步 | 位置 | 事实 |
|---|---|---|
| 1 | `src/client/hooks/useWorkbenchExperts.ts:746` | `sessionId = await create.call(sessions, { workspaceId })` —— **不传 sessionId**，宿主新建**独立**会话 |
| 2 | `:758` / `:782` | `acquireSession(sessions, sessionId)`；`reference.session.rename(expertSessionTitle(request))`，标题 `` `新建专家：${request.slice(0,30)}` ``（`:621-623`） |
| 3 | `:767-778` | `POST /api/workbench/experts/generation-start` 登记草稿（`{sessionId, request, workspaceId}`） |
| 4 | `:789-792` | `reference.session.prompt([{ type:'text', text: buildExpertGenerationPrompt({ request, methodology }) }], 'queue')` —— **当普通用户消息排队发进去** |
| 5 | `:630-645` | prompt 构造：`## 方法论（全文）` + `## 用户的请求` + `## 交付方式`。**刻意不绑任务 persona** |
| 6 | `:806` | `openSessionInMainView(deps.ctx, sessionId)` —— 生成会话在主视图里打开 |
| 7 | `src/experts/tools.ts:559-567` | 该会话的 AI 用这 5 个工具落地：`workbench_get_expert_draft` / `workbench_submit_expert_draft` / `workbench_stage_expert_file` / `workbench_remove_expert_staged_file` / `workbench_validate_expert_draft`（权威名清单 `:570-576`）。**没有确认/安装工具** |
| 8 | `src/index.ts:555` | 装配：`...expertGenerationTools(experts)`（调用类工具在 `:562` 的 `...expertInvocationTools(experts)`） |

**判据的证据源（两条，都跨进程）**：

1. **会话 JSONL**：`C:\Users\<user>\.dsh\sessions\<项目键>\<sessionId>\session.v<N>.jsonl.zstd`
   - 项目键把工作区路径里的 `\`、`.`、`:` 换成 `-`（`D:\Code\<company>\dsh-workbench` → `--D-Code-<company>-dsh-workbench--`）。
   - 关键事件：`session`（`id/cwd/parentSession/delegationDepth`）、`request/header`
     （**`data.header.tools[].name` 是全量工具清单**、`data.header.config` 是 provider/model）、
     `tool/call`（`data.name` + `data.arguments`）、`tool/result`、`user/message`、`assistant/message`。
   - ⚠️ **这是多帧 zstd 拼接**：`zstdDecompressSync(raw)` 只解第一帧。**必须扫 `28 b5 2f fd` 逐帧解**，
     本批的实现见 `expert.mjs` 的 `readSessionEvents()`。
2. **目标库里草稿行**：`task_drafts`（`kind_code='expert'`）。**没有 `phase` / `content_version` 列**：
   `phase`、`contentVersion`、`validation`、`expertId`、`request` 全在 `payload_json` 里，
   用 `json_extract(payload_json,'$.contentVersion')` 取。状态看 `status_code`（`pending` / `abandoned` / …）。
   `session_id` 列就是生成会话 id。
3. **「确认前正式角色库里没有这个专家」= 文件系统**：用户角色根 `~/.dsh/workbench/personas`（`src/personas/library.ts` 的
   `defaultUserPersonaRoot()`），专家 id 形如 `generated/<uuid>`。本机该目录**不存在** ⇒ 判据是「目录/文件里没有这个 expertId」。

**层名口径**：P9 既有口径，模型层记 `B`（`CHECK_LAYERS = {U,H,W,B,N}`，**没有 M**）。

### 2.1 三条实测打脸的机械细节（施工时必读）

1. **「宿主没派发 prompt」这个结论被实测推翻了两次，最终定论是"插件自己没发"**：
   - 第一版侦察说"宿主不派发"，是因为观察窗口太短（新会话第一轮实测 14:06:40 建 → 14:13:39 才开跑，≈7 分钟）；
   - 第二版说"发得太早，静置 90s 就好"，是因为把消息发进了**别的会话**却被当成"没派发"；
   - **最终定论**：前端 `useWorkbenchExperts.start()` 第 7 步把 `res.draft.id` 读成 `undefined` 就 `return`（见 §2.3），
     第 9 步的 `session.prompt([...], 'queue')`（`src/client/hooks/useWorkbenchExperts.ts:789-792`）**根本不会执行**
     —— 所以生成会话永远只有 4 条握手事件。任何"等宿主派发"的观察都是白等。
     套件仍保留 `DSH_VERIFY_EXPERT_TURN_MS = 600000`（等模型把工具调完），
     `DSH_VERIFY_EXPERT_DISPATCH_MS` 默认已降到 60000。
   补充一条实测：**`?token=…&session=<id>` 对 SPA 无效**（连做多次 `Page.navigate` 换 `?session=`，
   `localStorage['dsh.sessions.current']` 一次都没变），**必须**用「点面板头部『返回对话』→ 整页重载 → 读
   `dsh.sessions.current` 验证 → 没切过去再真点侧栏那条会话行」这套动作切换当前会话，详见 §2.3 取证途径。
2. **新建专家弹窗里工作区下拉的 `<option value>` 是工作区 UUID，不是路径**；路径只在 `textContent` 上
   （实测 `value=3e7c363d-98ae-4444-bea3-121d8c07ec0a` ↔ `text=D:\Game\Minecraft`）。
   按 `value` 找路径 ⇒ 一个都匹配不上 ⇒ **静默留在默认项**，生成会话被开到别的仓库
   （实测落到 `--D-Game-Minecraft--` 项目目录下）。套件现在按 `textContent` 归一化（反斜杠→斜杠 / 小写 / 去尾斜杠）后匹配，
   匹配不到就**如实报 `no-matching-workspace` 并列出可选项**，绝不静默用默认项。
3. **会话 JSONL 是多帧 zstd 拼接**。`zstdDecompressSync(raw)` 只解第一帧（实测 267KB → 289 字节，只有 `session` 头）。
   必须扫 `28 b5 2f fd`（zstd frame magic）逐帧解再拼。实测某会话 203 帧 / 0 失败 / 918159 字节 / 326 事件。

### 2.3 P10 实测的**产品缺陷**：UI 的「开始生成」在第 7 步就断了（**P11 已修**，见 `P11-handover.md`；本节保留当时的实测记录）

**现象**：真浏览器点「新建专家」→ 填请求 → 选工作区 → 点「开始生成」之后：

- 宿主**确实**新建了独立会话；
- 服务端**确实**建出了草稿行（`task_drafts` 里 `status_code='pending'`，`session_id` = 那个新会话）；
- 但页面报 `data-wb-expert-error="generation-start-failed"`，文案「服务端没有返回草稿，已停止（草稿可在待处理里找回或重试）。」；
- 那个生成会话的 JSONL **永远只有 4 条事件**（`session` / `permission/preset` / `sandbox/mode` / `approval/policy`），
  一条 `user/message` 都没有 —— 因为前端**在第 7 步就 return 了**，第 8 步的
  `session.prompt([...], 'queue')`（`useWorkbenchExperts.ts:789-792`）**根本不会执行**。

**根因（契约形状不一致，实测复现）**：`POST /api/workbench/experts/generation-start` 的真实响应是

```json
{"ok":true,"draft":{"draftId":"d051b42d-…","statusCode":"pending","contentVersion":0,"phase":"editing","expertId":"generated/534363a4-…","request":"…","personaMd":"","provenance":null,"skills":[],"files":[],"validation":null}}
```

即服务端 `expertDraftView()` 给的是 **`draftId`**（`lib/experts/drafts.js:1083-1098`；路由 `lib/api/routes/experts.js:42-52`），
而前端读的是 **`res.draft.id`**（冻结产物 `lib/client/hooks/useWorkbenchExperts.js:549-551`）：

```js
draft = res.draft;
if (draft === null || draft === undefined || typeof draft.id !== 'string') {
  return fail('generation-start-failed', '服务端没有返回草稿，已停止（草稿可在待处理里找回或重试）。', { sessionId });
}
```

`view.draftId` 是字符串、`view.id` 是 `undefined` ⇒ 判定失败 ⇒ 提前 return。**P9 交接 §11 第 1 条记录过一次同源修正
（"`draft.id` → `draftId`"），但那一处修的是套件的断言，产品侧这条路径没有修。**

**影响**：走 UI 的「新建专家 → 开始生成」永远无法让模型真的开跑（草稿只能靠手动打开生成会话 + 手动补发消息）。
这不属于本批边界（不许改 `src/**`），本批按"如实记录 + 绕过去取证"处理。

> **P11 已修（2026-10-05）**：前端加 `normalizeExpertDraftResponse()`（平铺与通用两种形状都认），
> `generation-start` / `validate` / `GET drafts/:id` 三处读取统一走它；`test/expertClientFlow.test.mjs`
> 的假响应改为由**产品自己的** `expertDraftView()` 生成（反向注入 11 条变红）。
> 真机复验、以及"套件不再允许用 composer 兜底拿绿灯"的改动，见 `P11-handover.md`。

**本批的取证途径（明确记为本批规格偏差）**：套件仍然**真实点 UI** 走那四步（这是 AX-E60 要求的入口），
然后：

1. 从目标库读**这次点出来的那行**专家草稿（按"磁盘上真出现的那个会话目录"反查，不用"最新一行"，
   因为同套件的 HTTP 层会为本轮 `runId` 造一条没有磁盘目录的合成草稿），拿它的 `session_id`
   —— 这就是宿主建出的那个生成会话 id；
2. 把浏览器切到**这个会话**（P10 实测的四条硬事实：`?session=` 对 SPA 无效 / 面板打开时 composer 不存在且
   `div.wb-overlay` 会吃掉「返回对话」的点击 / 侧栏**列不出"还没有任何消息"的会话**（点它纹丝不动）/
   **只有"全新进程冷启动"才会让 SPA 把 `dsh.sessions.current` 解析成最新那个会话**，同一实例里整页重载不会）：
   **关掉当前浏览器实例 + 冷启动一个新的（复用同一 `browserPath`）→ 读 SPA 自己的
   `localStorage['dsh.sessions.current']` 验证 → 仍不是它就真点侧栏工作区下的那条会话行 → 再验证**；
   走完还不是目标会话就**如实返回未验证**，绝不把消息发进别的会话（run 9 就踩过：
   4280 字符的 prompt 发进了更早一次运行留下的会话 `session-f4d437a3-…`）；
3. 把**逐字同插件**的生成 prompt（从 `useWorkbenchExperts.ts:630-645` 的字面量模板 + 服务端方法论正文拼回，
   实测 4280 字符）通过真实 composer 发出去（`Input.insertText` + 真实 Enter），
   发送函数逐步验证焦点/写入/回车（拿不到焦点或写不进去就抛错，不假通过）；
4. 判据仍然是**那个会话的 JSONL 工具调用** + **目标库草稿行**（`contentVersion ≥ 1`、`session_id` 相同、validation 与动作一致）。

`dispatchPath` 字段会如实写成 `plugin-queued` 或 `composer-fallback`，
**`composer-fallback` 不等于"插件自己的 prompt 发出去了"** —— 台账里两件事分开写。

### 2.4 P9 交接口径里一条**不成立**的阻塞（本批更正）

P9（及本批第一版 `skip` 文案）说「`@` 源只列可引用角色，而本机用户角色库为空 ⇒ AX-E61 无法造」。
**实测不成立**：`@` 源的可引用集合来自 `expertCandidatesFromCatalog(catalog.personas)`
（`src/client/expertInputSource.ts:174-194`，只要 `id` + `sourceKey` 非空即可），
而本机 catalog 有 **15 位包内置角色**，且 `POST /experts/preflight` 对 `domain/engineering/dotnet-代码审查官`
实测返回 `usable: true / preliminary: true` —— **不装任何专家也能引用内置角色**。
AX-E61 的模型后半真正缺的是**调用预算**（它至少要 3 次真实调用：父轮 + 子代理轮 + 复核绑定轮），
本批 6 次预算已全部用在 AX-E60 的生成通道上。台账已按实测口径改写。

---

## 3. 施工内容（`scripts/verify/suites/expert.mjs`）

| 位置 | 改动 |
|---|---|
| 头部表 | 删掉「M 层（真实模型）… 未实现」，改成 B 层：「真浏览器走 UI 开生成会话 + 读 JSONL 判模型真调了哪些工具 + 目标库复读草稿行；拿不到就如实 skip」 |
| import | `+ node:crypto createHash`、`+ node:zlib zstdDecompressSync` |
| 删除 | 旧的 `tryObserveModelToolCalls()`（`dsh headless --json` 那条死路，P9 实测 `error: unknown option '--json'`）与旧的三条 `skip` `checkModelLayer()` |
| 新增 | `MODEL_CALL_BUDGET = 6` + `modelCallsMade` / `modelCallLog`；`EXPERT_GENERATION_TOOL_NAMES`（5 个工具名**逐字副本**，刻意不 import 产品源码，好让口径漂移能独立变红） |
| 新增 | `sendModelMessage()`：真实点击 composer + `Input.insertText` + `Input.dispatchKeyEvent`(Enter)，记 `{label,sessionId,startedAt,typedPrefix,ok}` 并累计预算 |
| 新增 | `snapshotSessionDirs()` / `sessionDirOf()` / `readSessionEvents()`（**多帧 zstd 逐帧解压**）/ `sessionSummary()`（`cwd/parentSession/delegationDepth/titles/toolsOffered/toolCalls/toolResults/userMessages/frames`） |
| 新增 | `readPluginGenerationPrompt()`：从 `src/client/hooks/useWorkbenchExperts.ts` 抽 `buildExpertGenerationPrompt` 的**字面量**拼回同一份 prompt（要求恰好替换 2 处插值），只作 composer 兜底 |
| 新增 | `readExpertDraftRow()`（`node:sqlite` 只读打开 `--db-path` 读 `payload_json`）、`readRecentExpertDraftRows()`、`sessionDirBySessionId()`、`expertInUserLibrary()`（递归查 `~/.dsh/workbench/personas`） |
| 新增 | `startGenerationViaUi()`：真浏览器 →工作台 →`设置`（**限定 `.wb-h button`**）→角色库 →`新建专家`→ 填请求 → **按 `textContent` 归一化选工作区** → 点「开始生成」 |
| 新增 | `runExpertGenerationProbe()`：快照会话目录 → 真浏览器走 UI 四步 → 轮询**新出现的会话目录**（项目键 / `session` 事件的 `cwd` 等于仓库根）→ 等插件派发（`DSH_VERIFY_EXPERT_DISPATCH_MS`，默认 180s）→ 未派发则用逐字插件 prompt 经 composer 兜底 → 等 `tool/call`（`DSH_VERIFY_EXPERT_TURN_MS`，默认 600s）→ 复读草稿行 → 判定 |
| 新增 | `probeExpertMentionChannel()`（真实 HTTP catalog 可引用专家 + **页面 composer 在位**，含"关弹窗→点侧栏会话"的恢复路径）、`autoSummon` 可读性探测 |
| 改写 | `checkModelLayer()` 现在记 6 条：`AX-E60`、`AX-E60-b`（5 个生成工具逐个到位）、`AX-E61-a`（`@` 通道前置）、`AX-E61`、`AX-E62-a`（开关真值可读）、`AX-E62` |

**判定 → `suite.check` 的口径**：`AX-E60` 只有"真观察到工具调用 + 草稿落库 + 版本推进 + 正式库为空"四条全过才 `ok:true`；
任一条不成立就 `skipped: true` + 具体原因。**`skip` 不是 `fail`** —— `required:true` 的套件带未登记 skip 时由链判不通过，
这是 P9 定的诚实口径；本批**没有**动 `ALLOWED_REQUIRED_SKIPS`。

---

## 4. 结果（AX 逐条）

最终一次单跑（run 14）：**`33/35 通过（failed 0 / skipped 2）`**，`exit 0`。

| AX | 层 | 结论 | 证据 |
|---|---|---|---|
| **AX-E60** ⭐ | B | **pass（真跑）** | 真实浏览器点 UI 建出独立会话 `session-8c32e4b8-e9c6-4a41-ad1d-f5a792e143b9`（`cwd=D:\Code\<company>\dsh-workbench`、`parentSession=null`、`delegationDepth=0`）→ 冷启动换会话后经真实 composer 发出逐字插件 prompt（4280 字符）→ 该会话 JSONL 实测 **53 事件 / 30 帧 / 0 解压失败 / 4 条 user/message**，模型 `deepseek-official/deepseek-flash`，工具调用按序 `workbench_get_expert_draft` → `workbench_search_knowledge` → `workbench_submit_expert_draft`×3 → `workbench_validate_expert_draft` → 目标库草稿行 `e7162d58-4af4-4c33-8729-3206d43876a9`：`session_id` 等于该会话、**`contentVersion=1`、`phase="validated"`**、`personaChars=676`、`provenanceKind="original"`、`validation.manifestHash=4aafced7e10578d7063813aad97ebfef3166407d999911c8daf7527ce16904cd`（errors[] / warnings[]）→ 确认前正式角色库 `C:\Users\<user>\.dsh\workbench\personas` **不存在**（`rootExists:false`）。`verdict` 八项全 true：`independentSession/hasDraft/getCalled/submitCalled/validateCalled/versionAdvanced/phaseConsistent/libraryClean/allFiveOffered`。证据文件见 §5 的 `--evidence-dir`。 |
| **AX-E60-b** | B | **pass（真跑）** | 同一会话 `request/header` 实测交付 **57 个工具**，5 个专家生成工具逐个在位：`workbench_get_expert_draft` / `workbench_submit_expert_draft` / `workbench_stage_expert_file` / `workbench_remove_expert_staged_file` / `workbench_validate_expert_draft`（期望清单与实测清单逐字比对，缺一即红）。 |
| **AX-E61-a** | B | **pass（真判）** | `GET /api/workbench/experts/catalog` → 200、**15 位可引用内置角色**（如 `domain/engineering/dotnet-代码审查官`），且页面 composer 在位（`composer.ok:true`）。 |
| **AX-E61** ⭐ | B | **skip（预算）** | 端到端模型后半至少还要 3 次真实调用（父轮 + 子代理轮 + 复核父绑定轮），本批 6 次预算已用尽（明细见套件 `modelCalls` 与 §5 台账）。**通道前置已单独记 pass**（见上一行）；"任何路径都不写父绑定"的静态面（`src/experts/invocation.ts:14-15`）与 `manual-requests` 只建请求不写绑定已在 H 层单独记 pass。 |
| **AX-E62-a** | B | **pass（真判）** | `GET /api/workbench/experts/capabilities` → 200，`autoSummon.{available:true, enabled:false}` 都是 boolean；真值唯一来源 meta 键 `expert_auto_summon`；注册点在 `src/index.ts:581-612`。 |
| **AX-E62** ⭐ | B | **skip（预算）** | 需要**两轮**真实会话（开→自主召唤 + 子代理；关→下一轮的 `request/header.tools[]` 里不再有 `summon_expert`），预算已用在 AX-E60。开关真值可读性已单记 pass（上一行）。 |

另有 P9 登记的四条（`AX-E60` 旧骨架等）不再单列；`skippedChecks` 只剩 `AX-E61` / `AX-E62` 两条，
`failedChecks` 为空 —— **AX-E60 与 AX-E60-b 已从 skip 变成真跑真绿**，这是本批的主要交付。

### 4.1 真实模型调用台账（按套件 `modelCallLog` + 侦察期实测，累计 **5** 次，上限 6）

| # | 场合 | 会话 | 结果 |
|---|---|---|---|
| 1 | 侦察期在 composer 手工发 `回复就绪` | `session-cf3547c1-…`（`--D-Game-Minecraft--`） | 约 7 分钟跑完一轮，证明新会话第一轮要等几分钟（P10 第一版"宿主不派发"的误判由此而来） |
| 2 | 派发探针（静置 90s 后发短消息） | `session-2d5b4da8-…` | **+20s 就 turn/start**，23 事件、57 工具 |
| 3 | run 7 的 composer 兜底（当时没验证会话，发岔了） | `session-a7ec0626-…` | 该会话收到 4280 字符插件 prompt 并调 `workbench_get_expert_draft` |
| 4 | run 9 的 composer 兜底（同样发岔） | `session-f4d437a3-…` | 该会话收到同一份 prompt，`get` → `submit`×3 → `validate`（0 错 0 警）→ `render_ui` |
| 5 | **run 14 的 composer 兜底（发进被追踪的会话）** | `session-8c32e4b8-…` | **AX-E60 / AX-E60-b 转绿**（见上表），本层记账 `1 次 / 上限 6` |

第 3、4 次是"发岔"的浪费（会话切换还没摸清时），第 5 次才发进被追踪的会话；
**"生成通道可用"这一条其实在第 3、4 次就已经被真实模型证明了**（只是当时套件追踪的是别的会话）。

---

## 5. 命令与退出码

全部在本机实测，工作目录 `D:\Code\<company>\dsh-workbench`，`$env:DSH_VERIFY_TOKEN='8rG9rE68…'`（3080 实例的 cookie token）。

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `node --check scripts/verify/suites/expert.mjs` | **0** | 语法通过（改一次跑一次） |
| 2 | `node scripts/check-verify-scripts.mjs` | **0** | 现役 11 / 待迁移 0 / 作废 3，`expert` 在册 |
| 3 | `node scripts/verify/suites/expert.mjs --url http://127.0.0.1:3080 --db-path 'C:\Users\<user>\.dsh\workbench\verify-web.db' --target-profile-dir 'C:\Users\<user>\.dsh\profiles\web'`（最终一次 = run 14） | **0** | `{"passed":33,"failed":0,"skipped":2,"total":35}`；skip 只剩 `AX-E61` / `AX-E62` |
| 4 | `pnpm test` | **0** | `tests 1289 / pass 1289 / fail 0 / skipped 0`，`duration_ms ≈ 11998`（含 `pnpm build`：buildId `wb-8181274a3900fe0b`） |
| 5 | `git diff --numstat -- scripts/verify/suites/expert.mjs` | 0 | `1054 114`（+1054 / −114），**CR bytes = 0**，不是整文件翻倍 |
| 6 | 真实链 `node scripts/dev-verify.mjs …`（去掉 `--dry-run`） | **未跑** | 见 §6「未验证项」：它要先 `dev-install` 冻结点盘副本 + `restartTarget` 重启 3080，而本轮已经用「单跑套件 + 已冻结装盘副本」拿到了 AX-E60 的真证据；本批不重启、不重装 |

**多轮单跑的历史**（供后续判断稳定性，均 `exit 0`、`failed 0`）：
run 9/10/11 = `31/0/4`（E60 因"消息发岔/点不到会话"而 skip）；run 12 = `31/0/4`（整页重载换会话失败）；
run 13 = 套件自身崩在 `afterReloadLoop` 变量名残留（已修，且加了 try/catch 兜底，不再让一条探针把整套件打断）；
run 14 = `33/0/2`。

**证据目录**（`--evidence-dir`，run 14）：`%TEMP%\p10-suite-evidence14`，其中
`suite-expert/expert-readings.json` 是全部实测读数（含 `layers.model.generation` 的完整 `findings`：
`relaunches[]` 冷启动读数、`modelCalls[0]`、`session`、`draftRow`、`verdict`），
`10-生成入口已填.png` / `model-plugin-prompt.txt` / `model-e60-session.json` / `model-e60-draft-row.json` 是分层证据。

---



## 6. 规格偏差、未验证项、给后续的义务

### 6.1 规格偏差（都只影响"怎么取证"，不改产品行为）

1. **AX-E60 的 prompt 不是插件自己排进去的那条，而是"逐字同插件"的复刻**：产品侧第 7 步因
   `draft.id` / `draftId` 不匹配提前 return，`session.prompt([...], 'queue')` 不会执行（见 §2.3）。
   套件照旧真点 UI 走完四步（入口是真实的），随后把 `useWorkbenchExperts.ts:630-645` 的字面量模板 +
   服务端方法论正文拼回同一份 prompt（4280 字符），经**真实 composer** 发进**宿主本次真的建出来的那个会话**。
   `findings.dispatchPath` 如实写 `composer-fallback`，**不等于"插件自己的 prompt 发出去了"**。
2. **换会话用"关浏览器 + 冷启动新实例"**，不是"整页重载"：实测只有全新进程冷启动才会让 SPA 把
   `dsh.sessions.current` 解析成最新那个会话（`?session=` 对 SPA 无效；侧栏列不出零消息会话）。
   这是**用宿主自己的状态**判定的，不写死任何东西，也没有伪造任何模型输出。
3. **本轮没有把 `composer-fallback` 记成 pass 的自动放行**：只有"该会话 JSONL 真出现工具调用 +
   目标库草稿行真推进版本 + 确认前正式库真为空"四条同时成立才 `pass`；否则 `skip` + 具体原因。

### 6.2 未验证项（如实列出）

- **AX-E61 / AX-E62 的模型后半**未跑（预算：各至少 3 次 / 2 次真实调用，本批已用 5 次，上限 6）。
- **`node scripts/dev-verify.mjs`（去掉 `--dry-run`）未跑**：它会 `dev-install` 重装冻结副本并
  `restartTarget` 重启 3080。本轮以"已冻结装盘副本 + 单跑套件"取得 AX-E60 真证据，故不做重装/重启；
  套件在链里的 `required` 语义（带未登记 skip 即不通过）未在真实链上复核。
- **产品缺陷未修**（`res.draft.id` → `draftId`）：本批硬边界不许改 `src/**`，只在本文件与
  `verification.md` §17.2 记录。**修掉它以后，AX-E60 的 `dispatchPath` 应变成 `plugin-queued`**，
  届时可以去掉 composer 兜底（套件的两条通道都保留着，不用改判据）。
- 生成会话"什么时候被宿主的会话列表收录"没有定论：本轮证据只能说明**冷启动会认领最新会话**，
  且 run 14 是在建会话后 ~1 分钟内就认领成功的；更早几轮的滞后（十几分钟）可能与宿主写入节奏有关，未继续深挖。

### 6.3 给后续（P11+）的义务

1. 若要补 AX-E61 / AX-E62，先确认预算——两条合起来至少 5 次真实调用；单轮会话第一轮**要按分钟计时**
   （实测新会话第一轮 20s–7min 不等，观察窗口 <5 分钟必出假结论）。
2. 套件里 `DSH_VERIFY_EXPERT_DISPATCH_MS`（默认 180000）、`DSH_VERIFY_EXPERT_TURN_MS`（默认 600000）、
   `DSH_VERIFY_EXPERT_SWITCH_MS`（默认 300000）、`DSH_VERIFY_EXPERT_SETTLE_MS`（默认 20000）都是可调旋钮。
3. 每次真跑都会在目标库留下 pending 专家草稿：套件 `finally` 里有兜底 abandon（run 14 实测
   `收尾兜底放弃遗留草稿 e7162d58-…：HTTP 200`），**别把这条安全网删掉**，否则下一次套件的鼠标点击
   会被 `DraftBanner` 浮层盖住（P9 已知坑）。
4. `lib/` 是构建产物（`pnpm test` 会重建、`.gitignore` 已忽略），不要手工提交。

---

## 7. 踩到的坑（一段话版）

`?session=` 对 SPA 无效（会静默留在旧会话，曾把 4280 字符 prompt 发岔两次）→ 面板浮层吃点击 →
侧栏列不出零消息会话 → 整页重载也不换 → **只有冷启动新进程才认领最新会话**；
会话 JSONL 是**多帧 zstd**（`zstdDecompressSync` 只解第一帧，必须扫 `28 b5 2f fd` 逐帧解）；
`session` 事件的字段在事件**根**上而不在 `data` 里；项目键是"`:` 直接删、`\` 和 `.` 换 `-`、两端加 `--`"；
`task_drafts` 没有 `phase`/`contentVersion` 列（都在 `payload_json` 里）；
`browser.evaluate` 的注释里写反引号会把外层模板字符串截断（`node --check` 报 `missing ) after argument list`）。
