# P8 交接：客户端界面（生成入口 / 专家管理 / 专家草稿横幅）

> 给 P9（真实包、真实宿主、真实 LLM、集成验收）与后续维护者。
> 本批只做**客户端接线**：新建专家的生成入口、设置页的专家目录管理、专家草稿的预览与确认安装、自主召唤开关。
> **本批没有启动任何真实宿主实例、没有调真实 LLM、没有发布**；`sessions.create` / `uiWorkspace.openSession` / 真实 HTTP 全用假实现验过，真机行为留给 P9。
> 施工计划：`implementation-plan.md:282-316`；规格：`方案-v0.3.md` §5.4（`:451-465`）、§9（`:744-799`）、§12.3（`:919-952`）；验收：AX-E52–E58。

---

## 1. 交付物

全部在分支 `feat/workbench-experts` 上，基线 `0bdd80a`（P7；**rebase 后 P7 = `2e98177`**）。本批提交 `3db046c`（**rebase 后为 `7089d4b`**）。**18 个文件**（4 新增 + 14 修改），全部 `CR=0`、无 BOM、以 LF 结尾。

> **2026-10-05 同步更新（主会话执行）**：本批完成后按用户指令先同步再开 P9，`git rebase --autostash origin/main` 零冲突，本文件引用的提交哈希与 buildId 均已被改写 —— 映射与复跑结果见 [执行日志](ed644638-f9a0-45cf-a32f-90df7d060dda-工作台专家功能实现和优化/执行日志.md) 的「同步到 origin/main」一节与 `verification.md` §5.1。**buildId `wb-d130ed707d64a654` 已作废，新值为 `wb-8181274a3900fe0b`**；全仓测试基线从 1282/1281/1 变 **1289/1289/0**。§10 第 10 条（rebase 前置）**已执行完毕**，不再是待办。

### 新增

| 文件 | 行数 | sha256 | 说明 |
|---|---|---|---|
| `src/client/hooks/useWorkbenchExperts.ts` | 1510 | `DEF610758C5882D2556F2744FB07AF5C6383609EDFBA8B9D2F757BABD044F6DD` | 专家域唯一所有者：目录 / 生成 runner / 草稿动作 / auto 开关 / 全部纯投影 |
| `src/client/components/ExpertCreateModal.tsx` | 154 | `7FD7EE72CC20C87E87583638DED0A181C23852B83DFEF45B0D9B0090BB400409` | 新建专家弹窗（请求文本 + 工作区选择 + 空文本/缺能力禁用） |
| `src/client/components/ExpertDraftBody.tsx` | 253 | `ADD512429F84AD16F23259FDF220FE03BF94AF67DF0AEF5C91E0254F72CEB6F4` | 专家草稿预览（来源登记 / 必需与可选 skill / 校验快照 / 安装或复用决策） |
| `test/expertClientFlow.test.mjs` | 1018 | `97CE4D7716DD58E29271E26E452983757D000F6EDFC52DAC8BE7741B11C78EBA` | 38 条用例（AX-E52–E58 + 契约/基线），全部依赖注入、无真宿主 |

### 修改

| 文件 | 行数 | sha256 | 改动 |
|---|---|---|---|
| `src/client/viewTypes.ts` | 284 | `FC7C763E53020C0A3C45C50BD8E700B89F0FE97590BA3A6ACBEA6B82813091FC` | `+15 −0`：`sessions.create?`（形状逐字来自真实宿主注入面，见 §3） |
| `src/client/index.tsx` | 2048 | `5CCDA09E85A78E83CF1671C6810FC923E2BC8E45F1DAF5A4BE4B20007796CE69` | `+65 −2`：装配 hook + 惰性转发 ref + 加进 `assembly`（**零新 state / 零新请求 / 零新定时器**） |
| `src/client/components/SettingsModal.tsx` | 679 | `CB0D29A5AA27A9FA7103DB7697BF6CC0027B58BFF38F9B9F9FC23C36B38AE655` | `+57 −3`：把专家域结果/动作与待确认专家草稿透给 `PersonaAdmin`；旧"工作台从不写角色文件"说明改写 |
| `src/client/components/PersonaAdmin.tsx` | 291 | `22230F5A31DA3BD4CB06E24BCF88AA853997FD61253D1B6EFF6CA9E9019F900A` | `+244 −143`：改为**受控组件**（目录/加载/错误/收藏停用反馈全由专家域拥有，本地只剩搜索词 + 状态筛选） |
| `src/client/components/PersonaPicker.tsx` | 175 | `C21590DEAB98901588B630B8353DDC23C3EE2279F3839ACB7C8B5AA2A5379603` | `+32 −52`：改吃 `catalog.personas` 结果切片，自己**不再拉** `/personas` |
| `src/client/hooks/useWorkbenchAISessions.ts` | 935 | `5968593220A09F4B1D2E38BBC33599551BCDBCE5DAF64181E7DAB898017029AA` | `+21 −0`：绑定**之前**同一份 preflight 的入口守卫（只加守卫，绑定语义逐字未动） |
| `src/client/hooks/useWorkbenchDrafts.ts` | 379 | `3FDDD1F01918FF04067FB0D2B703BFAA5E4BA146A615707988DF70AF49AEE0EF` | `+32 −1`：`onExpertInstalled` 注入点 + 专家确认回执分支（重读目录） |
| `src/client/components/DraftBanner.tsx` | 948 | `3883B53634EF7FEFD0CBA9E90470AC4FB58D1C65E51234F63FBA71B50B51DA88` | `+189 −22`：`kindCode==='expert'` 早分流到专用预览；底栏只留不变更内容的动作；版本冲突刷新预览不自动确认 |
| `src/client/app/assembly.ts` | 100 | `1D7B4CB2B471AB2D3D3518A422DD20263C5306807DD673BB3B9E1D22EC6C3A9D` | `+9 −0`：`experts` 进装配对象（**白名单外**，见 §7-6） |
| `src/client/app/WorkbenchBody.tsx` | 235 | `ABBFE12FD0A7C21DCC69AD3A7121F143E7C3F86E8EA0270FAC6830E0308518EC` | `+11 −0`：向设置弹窗下发专家域 + 筛出的待确认专家草稿（**白名单外**） |
| `src/client/app/WorkbenchOverlays.tsx` | 209 | `00A646344BA0ED2B045CB442B4D3A97F68E6773A9022F8612E5870C6BB0E277F` | `+16 −2`：提示词弹窗的角色选择器接专家目录；草稿横幅接专家动作（**白名单外**） |
| `src/client/app/WorkbenchDialogs.tsx` | 364 | `4645C2E850ED1C8C40CCEE6144E83858DC46ECFB7A651BD6D98FC603645C9EEA` | `+8 −2`：快速录入弹窗的角色选择器接同一份专家目录（**白名单外**） |
| `test/personaWiring.test.mjs` | 436 | `E9EA4787D0F7A64AEAF1229A0FFE766645437ED591783016057039C6EB5EF8E6` | `+17 −4`：唯一写入口径断言**重定向**到新所有者，并补一条"受控界面不许再留第二份写入口"（**白名单外**，见 §7-7） |
| `tsconfig.build.json` | 88 | `EC83996DDAED401DDF5D879B106DF466D8C2DFBF312255869D050EF88107F628` | `+1 −0`：把 `src/client/hooks/useWorkbenchExperts.ts` 加进显式 include（否则 `lib/` 无产物、测试 `ERR_MODULE_NOT_FOUND`） |

未动：`package.json`、`pnpm-lock.yaml`、`src/client/capabilities.ts`（客户端 `inject` 5 项逐字未变）、顶层 `inject`（4 项逐字未变）、`src/client/styles.ts`、`SCHEMA_VERSION` / 迁移、`src/server/**`、`src/experts/**`。

---

## 2. 关键导出与形状（逐字，已核对）

### 端点常量（全客户端字面量只此一处）

```ts
export const EXPERTS_CAPABILITIES_PATH = '/api/workbench/experts/capabilities'
export const EXPERTS_METHODOLOGY_PATH = '/api/workbench/experts/methodology'
export const EXPERTS_GENERATION_START_PATH = '/api/workbench/experts/generation-start'
export function expertDraftDetailPath(draftId: string): string
export function expertDraftValidatePath(draftId: string): string
export function expertDraftConfirmPath(draftId: string): string   // = /api/workbench/drafts/{id}/confirm（既有端点，非 /experts/.../confirm）
export function expertDraftAbandonPath(draftId: string): string
export { EXPERTS_PREFLIGHT_PATH } from '../expertInputSource.js'   // 复用 P7 定义，无第二处字面量
```

### 纯函数（可单测、不碰 DOM）

```ts
export function readExpertPreflight(raw: unknown, personaId: string): ExpertPreflightView | null
export function expertPersonaPreflightError(view: ExpertPreflightView): string | null
export async function fetchExpertPreflight(api: ExpertApiCall, input: {...}): Promise<ExpertPreflightView | null>
export function hasSessionCreate(runtime: unknown): boolean
export function readExpertDraftPayload(draft: DraftView | null | undefined): ExpertDraftPayloadRead
export function expertDraftButtons(phase: ExpertDraftPhase | 'unknown', busy: boolean, error: ExpertUiError | null): ExpertDraftButtons
export function safeSourceKeyLabel(source: string, sourceKey: string): string
export function expertRowView(row: ExpertCatalogRow): ExpertRowView
export function expertAdminRows(catalog, query: string, status: ExpertCatalogStatus | 'all'): ExpertCatalogRow[]
export function expertPickerPersonas(catalog: ExpertCatalogView): PersonaSummary[]
export function matchWorkspaceForCwd(items: readonly WorkspaceChoice[], cwd: string): string | null
export function expertSessionTitle(request: string): string
export function buildExpertGenerationPrompt(input: { request: string; methodology: string }): string
export function readExpertInstalledFromOutcome(outcome: unknown): ExpertInstallResult | null
export function isExpertDraft(draft: DraftView | null | undefined): boolean
export function createExpertGenerationRunner(deps: ExpertFlowDeps): ExpertGenerationRunner
export function createExpertDraftOps(deps: ExpertFlowDeps): ExpertDraftOps
export function createExpertCatalogStore(input: ExpertCatalogStoreInput): ExpertCatalogStore
export function createAutoSummonController(input: AutoSummonControllerInput): AutoSummonController
export async function refreshExpertCatalogAfterInstall(input: {...}): Promise<void>
export function useWorkbenchExperts(input: UseWorkbenchExpertsInput): UseWorkbenchExpertsResult
```

`ExpertErrorCode` 是 21 个稳定 code 的联合（`empty-request` / `busy` / `create-unavailable` / `create-failed` / `no-workspace` / `acquire-failed` / `generation-unavailable` / `methodology-unavailable` / `generation-start-failed` / `prompt-failed` / `open-failed` / `aborted` / `validate-failed` / `draft-not-validated` / `install-in-progress` / `version-conflict` / `confirm-failed` / `catalog-failed` / `settings-failed` / `payload-unreadable` / `create-unavailable`）。只有它是 `data-wb-expert-error` 的取值；中文一律进 `message`。

### 确认安装的 HTTP body（**恰好两个字段**）

```ts
const sent = { expectedVersion: payload.contentVersion, manifestHash: validation.manifestHash }   // useWorkbenchExperts.ts:898
```

发之前的两道闸门（`useWorkbenchExperts.ts:887`）：`payload.phase === 'validated'` 且 `validation.version === payload.contentVersion`，否则**不发请求**、回报 `draft-not-validated`。

---

## 3. 接线点与所有权（主会话逐行复核过 diff）

### `src/client/index.tsx`（`+65 −2`，只有三处）

1. `:36-37` 两个 import（`useWorkbenchExperts`、`type ExpertInstallResult`）。
2. `:186-188` `expertInstalledRef = useRef<((expert: ExpertInstallResult) => void) | null>(null)`：草稿域在专家域之前就被调用（专家域要读 `workspaceChoices`），用惰性 ref 破顺序依赖（与既有 `startAISessionRef` 同范式）；`:189-198` `useWorkbenchDrafts({... onExpertInstalled: (expert) => { expertInstalledRef.current?.(expert) }})`。
3. `:684-721` `useWorkbenchExperts({...})` 调用（注入 `workspaceChoices` / `currentCwd` / `settings.autoSummonExperts` / `writeSettings` / `isAlive` / `onError` / `onNotice`），紧接 `:722` `expertInstalledRef.current = experts.actions.handleExpertConfirmed`；`:768` `assembly` 里加 `experts`。

`WorkbenchApp` 体内**没有新增任何 `useState`/请求/定时器**（AX-E58 有一条源码级断言，见 §6）。

### 注入给专家域的两个读取器（都在装配层，不在域内）

- `workspaceChoices`：`safeService(runtime,'workspaces')?.list?.getSnapshot?.()?.items` 映射成 `{workspaceId, path}`。**故意不用** `workspaceChoices`（路径候选）——`sessions.create` 要的是**工作区 id**，路径候选里可能根本没有 id；生成入口只挑**已注册工作区**，绝不顺手 `workspaces.create`。
- `currentCwd`：`currentSessionIdOf(runtime)` + `sessionListSnapshot.byId[id]?.cwd`；读不到给空串 ⇒ 界面要求用户手选工作区（不自动建任务资料夹）。

### 白名单外的 5 个文件（4 装配管道 + 1 既有测试）

`src/client/app/{assembly.ts,WorkbenchBody.tsx,WorkbenchOverlays.tsx,WorkbenchDialogs.tsx}`：P7-2 把装配 JSX 从 `index.tsx` 抽了出去，新 props（`experts` / `pendingExpertDrafts` / `expertActions` / `pickerPersonas`）必须经这层管道才能到组件；P8 任务书写在抽取之前。改动量 9/11/16/8 行，全是传参 + 注释。

`test/personaWiring.test.mjs`：见 §7-7。

### 其它接线

- `viewTypes.ts:217` `create?(input?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>`，注释里逐字记着真实宿主契约与其出处。
- `tsconfig.build.json:26` 一行 include（**必须**：测试 import 的是 `lib/**` 产物）。

---

## 4. 命令与退出码（主会话独立复跑，同一条命令链）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | `tsc --noEmit`（`tsconfig.json` 的 `include: ["src"]` + `strict: true`，**覆盖 `src/client/**`**） |
| `pnpm build` | 0 | buildId `wb-d130ed707d64a654`（206 个输入文件）；`lib/client.js` 597.32 kB / gzip 177.29 kB |
| `node --test test/expertClientFlow.test.mjs test/clientInvariants.test.mjs test/capabilities.test.mjs test/draftBannerSessionJump.test.mjs` | 0 | `tests 56 / pass 56 / fail 0` |
| `node --test test/*.test.mjs`（全仓） | 1 | `tests 1282 / pass 1281 / fail 1` |

全仓唯一失败与 P5/P6/P7 基线同源、非本批引入：`test/db.test.mjs` 的 "db migrations, dictionaries and task tree"（临时目录清理期 `EPERM`）。计数核对：P7 基线 1244 + 本批新增 38（`test/expertClientFlow.test.mjs` 全部用例）= **1282** ✓。

**抖动记录（如实记）**：子代理首轮报告全仓连跑时曾多出 4 条失败（AX-E48 / AX-R04 / draft defer-resume-abandon API / PATCH `/tasks/:id` 改父任务），立即重跑只剩那 1 条已知失败；这 4 个文件本批一个未碰。主会话复跑时未复现。

---

## 5. 独立证据（主会话亲自做的，不是子代理自报）

### 5.1 反向注入 6 处（5 处子代理 + 1 处主会话自选），全部真红

| # | 注入点 | 注入前 → 后（`test/expertClientFlow.test.mjs`） | 变红的用例 | 还原后 |
|---|---|---|---|---|
| ① | 删 busy 守卫 | 38 pass → 37 pass / 1 fail | AX-E52 连点两次 | 逐字节一致 |
| ② | `manifestHash` 换成常量 | 38 → 37 / 1 | AX-E54 确认 body 恰好 `{expectedVersion, manifestHash}` | 逐字节一致 |
| ③ | `sessions.create` 改成复用 blank 会话 | 38 → 32 / 6 | AX-E52 新身份 + 5 条 AX-E53 | 逐字节一致 |
| ④ | auto 开关保存失败不回滚 | 38 → 37 / 1 | AX-E57 保存失败回滚 | 逐字节一致 |
| ⑤ | 版本冲突后自动刷新并自动确认新版本 | 38 → 37 / 1 | AX-E55「且**没有**第二次确认」 | 逐字节一致 |
| ⑥ | **主会话自选**：`expertPickerPersonas` 的第二道闸门改成 `return true`（`useWorkbenchExperts.ts:579`） | 38 → 37 / 1 | AX-E56「required 缺失的行：选择器不可选」（`test/expertClientFlow.test.mjs:710`） | `build 0` + 38/38，SHA256 回到 `DEF610758C5882D2556F2744FB07AF5C6383609EDFBA8B9D2F757BABD044F6DD` **逐字节一致** |

流程：改源码 → `pnpm build`（exit 0）→ 跑测试 → 写回原始字节 → 重建 → 比对 SHA256（用 `[System.IO.File]::ReadAllBytes/WriteAllBytes`，不经编辑器，避免行尾/BOM 污染）。

### 5.2 diff 通读

14 个已跟踪文件的 diff 逐行读完（`+560 −155` 量级），另抽查两个新组件的关键渲染段与全部 `data-wb-*` 取值。结论：**未发现功能缺陷，本批没有修复轮，主会话未改动任何一行源码**。

### 5.3 抽查的几条硬事实

- 生成 runner 顺序与 §5.4 一致：capabilities → methodology → `create({workspaceId})` → `acquireSession` → generation-start → `rename`（失败只提示）→ `prompt(...,'queue')` → `openSessionInMainView`，**每个 await 之后都查 `isAlive()`**，`finally { reference.release() }`（`useWorkbenchExperts.ts:716-828`）。
- `create` 只传 `{ workspaceId }`：没有 `sessionId`、没有 `connectWorkspace`、没有读会话列表猜"当前/最后一条"（AX-E52 的三条断言守着）。
- 专家草稿确认成功后由 `DraftBanner` 自己 `onConfirmed({expert}) → onDismissed() → onDone()`（`DraftBanner.tsx` 的 `runExpert('confirm')`），草稿域的专家分支只做"重读目录"后 `return`，**不重跑建任务/暂存/复用那套分支**（AX-E58 `:972` 有一条断言防改写）。
- "创建任务"这四个字在整个客户端只出现在注释里（`DraftBanner.tsx:621`、`ExpertDraftBody.tsx:20`），可执行代码里没有。
- 18 个文件全部 `CR=0`、无 BOM（逐字节统计），`tsconfig.build.json` 只加了一行。

---

## 6. AX 对账（AX-E52–E58，全部 ✅）

用例行号已由主会话逐条打开核对（每一行确实是该行为的用例开头）。完整证据见 `test/expertClientFlow.test.mjs`。

| AX | 结果 | 用例锚点 |
|---|---|---|
| E52 生成入口：新身份、不复用 blank、连点拒绝、空文本、缺能力明说 | ✅ | `:258`（`sessions.create` 新身份 + `connectWorkspace` 调用数 = 0 + 不复用 blank）、`:293`、`:310`、`:321` |
| E53 五条失败路径各自可读 + release + 会话/草稿保留 | ✅ | `:341` create、`:359` acquire、`:375` generation-start、`:394` prompt、`:411` open、`:430` `isAlive` 变假（未取引用不建会话 / 已取引用必须 `finally release`） |
| E54 四态按钮 + 确认 body 恰好两字段 + 对不上不发请求 | ✅ | `:468`、`:505`、`:526`、`:545`（校验 body 恰好 `{expectedVersion}`）、`:567`（payload 读不出给稳定 code）、`:580`（源码级无"创建任务"） |
| E55 版本冲突刷新预览、绝不自动确认 | ✅ | `:593`（冲突 → 刷新 + 只发一次确认）、`:622`（非冲突仍不复用新版本）、`:636`（`installing` 重复确认被拒） |
| E56 安装后重读目录、坏行可见不可选、不回显绝对路径 | ✅ | `:649`（重读 + 说清实际装了什么）、`:675`（目录读失败）、`:710`（required 缺失行可见 / 选择器不可选）、`:748`（坏文件行 + 不冒绝对路径）、`:770`（回执 reader 形状兜底） |
| E57 auto 开关：失败回滚、成功写回设置域、busy 拒重入、手动入口不受影响 | ✅ | `:782`、`:800`、`:820`、`:836`（源码级：flag 立即保存 + 外部目录只在"保存设置"提交） |
| E58 装配约束与稳定性 | ✅ | `:886`（`WorkbenchApp` 体内零 `useState`/零网络/零定时器/只装配一次）、`:897`（客户端 `inject` 5 项 + 顶层 4 项 + `['inputTriggers']` 仅 1 处）、`:913`（9 个 `data-wb-expert-*` 唯一实现，递归覆盖 `src/client`）、`:929`（旧 `/personas` 拉取 = 0、端点常量唯一）、`:941`（入口守卫在同一份 preflight 之后）、`:953`（preflight 投影）、`:972`（旧草稿分派未被改写）、`:993`（提示词）、`:1000`（工作区最长前缀匹配）、`:1014`（空目录基线） |

行尾/唯一性类断言用的是仓库既有工具（`test/_clientSources.mjs` 的 `read/stripComments/countInClient/assertClientCount`），递归覆盖整个 `src/client/`。

---

## 7. 规格偏差（逐条：出处 → 实际 → 理由）

1. **确认端点**：任务书写 `POST /experts/.../confirm`；真实实现里没有这个端点，确认走**既有** `POST /api/workbench/drafts/:id/confirm`（body `{expectedVersion, manifestHash}` → `{ok, expert, replayed}`），放弃走 `POST /api/workbench/drafts/:id/abandon`。按"以代码为准"。
2. **409 判定**：客户端 `api()` 不暴露 HTTP 状态码 ⇒ 确认失败后**只读**一次草稿、比对 `contentVersion` 来判断"是不是版本冲突"，不猜文案（`useWorkbenchExperts.ts:906-923`）。
3. **preflight 形状**：规格写的 `reason`/`code` 在真实 `src/experts/catalog.ts` 里不存在（只有 `{personaId, usable, status, issues, effectiveSkills, preliminary, summary}`）⇒ 客户端用 `status`/`summary`/`issues` 生成可读原因。
4. **`sessions.create` 形状**：按真实宿主 d.ts（返回 session id、失败抛 `SessionCreateError`）声明为可选方法；缺能力时报 `create-unavailable`，**不静默降级成复用当前会话**。
5. **工作区来源**：`workspaceChoices` 必须来自宿主 `workspaces.list.getSnapshot().items`（带 `workspaceId`），不能用只有 path 的 `workspaceCandidates()`（首轮 typecheck 的 TS2322 就是它）。
6. **白名单外 4 个装配文件**（`src/client/app/**`）：见 §3；纯传参 8–16 行。
7. **白名单外 1 个既有测试**（`test/personaWiring.test.mjs`）：§12.3 明确把 flag 写入搬到专家域（"由本域 action 调用"），所以那条"设置页承接收藏/停用：唯一写入口径仍是 `personaFlagPatch`，且写前现读服务端现值"的用例把**被扫文件**从 `PersonaAdmin.tsx` 换成 `useWorkbenchExperts.ts`，判据原样保留（仍是"唯一口径 + 先 `await api(SETTINGS_PATH)` 再算 patch"），并**加了一条更强的反向断言** `assert.doesNotMatch(adminSource, /personaFlagPatch\(/)`（受控界面不许再留第二份写入口）。语义一个字没变，测试没有被放宽。
8. **`matchWorkspaceForCwd` 取最长前缀**：原实现只记第一个前缀命中 ⇒ 外层工作区会抢走内层工作区的会话；改为最长前缀（`test/expertClientFlow.test.mjs:1000` 覆盖）。
9. **判断类**：界面已挂稳定错误码时也禁用"确认安装"（规格只明说 `installing` 禁用、`install-failed` 可重试）。理由：真值未定时不给装；校验仍可用作恢复动作。
10. **任务书"全仓 LF"与实况不符**：仓库本就有数十个既有 CRLF 文件（未触碰）。子代理一度把 `viewTypes.ts` / `SettingsModal.tsx` / `DraftBanner.tsx` 写成 CRLF（`git diff --stat` 整文件翻倍），已转回 LF 并与 HEAD 对齐（numstat 收敛为 15/0、57/3、189/22）。
11. **【主会话复核新发现】设置页专家列表不再有"分组章节标题"**：HEAD 的 `PersonaAdmin.tsx` 用 `groupPersonas(personaPickerList(...))` 渲染分组章节 + "N 个角色"计数（2026-10-01 用户反馈"层级不明显"后的设计）；P8 版改成**扁平行**（每行行内显示 `来源｜分组｜登记来源`，另加状态标签与"来源与技能"折叠详情），分组顺序也不再受控（`expertAdminRows` 只做过滤，不重排）。依据：`方案-v0.3.md:785` 只要求"列表展示名称、简介、分组、三级来源、状态、来源方式"，未要求章节；`PersonaPicker` 的分组章节仍然保留（`personaPicker.ts:174` 的 `groupPersonas` 仍被选择器使用）。**故按规格不算偏差，但相对 HEAD 是一次可见的布局变化，且本批无浏览器验证**——P9 真机视觉核对时请注意，若要恢复章节级分组，改一处渲染即可。

---

## 8. 未验证项（如实标注，一律不算通过）

1. **无真浏览器/GUI**：DOM 渲染、点击、弹窗视觉、真实 DOM 里的 `data-wb-*` 取值只做了**源码级**唯一性断言。
2. **无真实宿主**：`sessions.create` / `acquireSession` / `uiWorkspace.openSession` 全用假 runtime；`hasSessionCreate` 只做形状探测；`SessionCreateError` 的真实抛法未跑。
3. **无真实 LLM**：generation-start / validate / confirm 全用假 HTTP 响应；生成内容质量与真实校验结果未验。
4. **无真实安装落地**：journal / publication / 文件写入 / skill provider 生效属 P5–P6 覆盖，本批只测客户端接线。
5. **未真起宿主点 `@` 菜单与 `/expert`**（P7 交接 §8 第 1/2 条仍未验）。
6. **未重启宿主实例**（本批不需要，也没做）。
7. **auto 开关对自主召唤行为的真实影响未验**：本批只验"值写对、失败回滚"，未验"打开后 AI 真的会自己挑专家"。
8. **macOS / Linux 未测**。

---

## 9. 给 P9 的接线义务（每条一个动作）

1. 真机点一次「新建专家」：确认 `sessions.create` 真的新开 session、生成会话在主视图打开、弹窗关闭；失败时草稿与"打开生成会话/继续修改"都在。
2. 真机点一次 `@` 菜单：确认专家源与文件源并列、引用胶囊出现、只有发送时才发 HTTP。
3. 面板接 `childSessionId` 的「打开会话」。
4. 真浏览器核对 §12.3 那 9 个 `data-wb-expert-*` 的实际渲染值（源码级唯一性 ≠ DOM 里的值正确）。
5. 真 LLM 跑一次 生成 → 校验 → 确认安装：核对发出去的就是所见版本、安装后 provider 真的生效、目录随后刷新。
6. 真机改一次 auto 开关：确认写回 `settings.autoSummonExperts`、自主 schema/prompt 随开关出现/消失、**关掉后手动 `@` / `/expert` 仍可用**。
7. 真宿主各走一遍降级：缺 `sessions.create`、缺 methodology 资产。
8. catalog 拉取失败时只降级 `/expert` 帮助，不让命令整体不可用。
9. 真机核对 §7-11（设置页专家列表的布局变化）是否符合预期。
10. ~~**rebase 前置（P8 收尾时新发现，务必先看）**~~ **已执行（2026-10-05）**：本条描述的冲突**没有发生**——`git rebase --autostash origin/main` 9/9 干净应用、零冲突，P1–P8 代码逐行未变，CR=0 复核通过；下游影响（哈希、buildId、全仓失败数）见本文件开头 2026-10-05 同步更新与 `verification.md` §5.1。以下是**执行前**的原始预告，保留作过程痕迹：`origin/main` 已从 `fb2b548` 前进到 **`7980493`**（+6 提交，来自另一会话的 PR 合并），其中 **3 个提交改了同一份 `src/client/index.tsx`**（`848ad0b +5`、`9cf7a37` 整文件行尾翻转 `1978/1972`、`a7d927a` 再次 `1978/1978`）⇒ 我方 P8 的 `+65 −2` 与它在同一文件上**必然冲突**；重放时以他们的行尾为准、只打我们的三段装配改动，rebase 后重做 CR/BOM 全量检查。另外上游 `05fea07` / `7980493` 已修 `test/db.test.mjs` 的临时目录清理，**P5–P8 一直报的"全仓唯一失败（db EPERM）"预期在 rebase 后消失**。

---

## 10. 复核与修复记录

- **本批无功能缺陷、无修复轮**：主会话通读 14 个 diff + 抽查两个新组件关键段 + 逐条核对 38 个用例锚点，未发现需要改代码的问题；**主会话没有改动任何一行源码**（与 P7 的两处格式/注释小修不同）。
- **一处观察，未改**：`src/client/index.tsx:711` 的 `if (sessionId === null) return ''` 在 `currentSessionIdOf(runtime): string` 下是恒假分支（`strict: true` 下 TS 也未报错；下一行 `?? ''` 已覆盖空串）。行为无害，按"只接线不改既有语义"未动它。
- **核对过的引用**：`viewTypes.ts:203-216` 注释里引用的真实宿主出处（`@deepseek-ai/dsh-api-session-controller` 的 `ISessions.create`、`ClientSessions.create`）与主会话在 `C:\Users\<user>\.dsh\profiles\node_modules\@deepseek-ai\` 下读到的 d.ts 一致；`sessions.create(...): Promise<SessionId>`、失败抛 `SessionCreateError`、`SessionSummary.blank` 都真实存在。
- **未接生产装配的部分**：本批只改客户端；服务端能力仍来自 P5/P6/P7。

---

## 11. 过程事实（给后续批次避坑）

1. **委派失败与续跑**：P8 首次委派（子代理 `8dff0e26-ecf4-41ca-be3d-20502b9751b3`）在**只读阶段**被宿主判 failed，未写任何代码。现场核查：分支/HEAD 未变、4 个新文件都不存在、无半成品与备份残留 ⇒ 无需回滚；随后用 `send_message` 在**同一个子代理**上续跑（不新开），并补发真实宿主契约 + 可读包路径。教训：**给子代理的"真实 SDK 路径"必须自己先 `Test-Path` 验一遍**（我最初给的 `…\app.asar\dsh\` 在只读沙箱里读不到，`C:\Users\<user>\.dsh\profiles\node_modules\@deepseek-ai\` 才是可读的）。
2. **CRLF 陷阱**（已存团队记忆）：编辑工具若把文件整体写成 CRLF，`git diff --stat` 会整文件翻倍；改完要逐文件数 `\r\n` 并和 `git show HEAD:<file>` 对照。
3. **测试 import 的是 `lib/**` 产物**：每次改源码都要**先 `pnpm build` 再跑测试**，否则断言跑的是旧产物（本批因此白排过一轮"工作区匹配"失败）；新模块不进 `tsconfig.build.json` 的 `include` 就没有 `lib/` 产物。
4. **假 fetch 固件**：`generationHandlers()` 的值可能是普通对象而不是函数，包装时不能直接 `await base[path](rec)`。
5. **夹具 API**：`makeValidatedDraft({ payload })` 会把 overrides 展开进 payload（变成 `payload.payload`）；要改服务器版本得直接 `makeDraft({ payload: makePayload({...}) })`。
6. **源码扫描正则要对真实写法**：`useRef<`（不是 `useRef(`）、`injector.call(ctx, ['inputTriggers'], …)`（不是 `ctx.inject(['inputTriggers']`）、`await loadCatalog()`。
7. **`pnpm build 2>&1 | Select-Object -Last 3` 会折叠退出码与 `error TS`**（P7 已被骗过一次）：读 `$LASTEXITCODE` 单独断言。
8. **全仓套件抖动**：连跑两次时可能因临时目录/并发多出几条假失败，报告里要写清"第一次/第二次"的真实计数。
