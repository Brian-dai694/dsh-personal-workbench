# 专家功能 · 证据与验证状态

本文件分清“已经核对的设计依据”和“产品实现后的验收”。**截至本版写作，专家功能未施工，AX-E01–E62 均未作产品验收。**

规格：[方案 v0.3](方案-v0.3.md)。实施：[implementation-plan.md](implementation-plan.md)。断言：[acceptance.md](acceptance.md)。

## 1. 本轮已核对的仓库基线

| 项 | 核对结果 | 本地复核入口 |
|---|---|---|
| HEAD | 216bb36（开始细化文档时） | git rev-parse HEAD；后续施工必须重新记录 |
| package | @dely0/dsh-personal-workbench 1.16.3 | package.json |
| schema | 19 | src/db/schema.ts / SCHEMA_VERSION |
| host inject | webServer、systemPrompt、tools、commands | src/index.ts / inject |
| client inject | sessions、workspaces、connection、slots、layout | src/client/capabilities.ts / inject |
| 普通绑定 | 同身份幂等；不同角色 409；工具不接角色 ID | src/personas/binding.ts、src/tools.ts |
| 草稿确认 | SQLite BEGIN/COMMIT/ROLLBACK，不能回滚 FS | src/db/repo/shared.ts / withDraftConfirm |
| 草稿路由 | 无 expert kind 处理 | src/api/routes/drafts.ts；此项是待新增能力 |
| 种子 | INSERT OR IGNORE，支持已有 DB 补项 | src/db/seed.ts / seedDictionaries |
| 角色管理 | 来源未登记、解析无效行的丰富视图尚未实现 | src/client/components/PersonaAdmin.tsx |
| ADR 编号 | 0008 已用于 WorkbenchApp 出口判据 | docs/adr/0008-workbenchapp-exit-criteria.md |

## 2. 本轮已核对的本机 SDK 契约

以下为源码/类型核对，**不是运行验证**。基目录为 `<本机家目录>/.dsh/profiles/node_modules/@deepseek-ai`；主 SDK 取证版本为 0.2.0-rc.2。P0 要在真正执行环境重新读版本。

| 契约 | 已核对内容 | 可复核文件/符号 |
|---|---|---|
| 命令身份 | CommandInvocation.agent 是 live Agent，signal 为取消通道，handler 可以 Promise | dsh-commands/lib/types/index.d.ts |
| @ source | onPick 同步，codec.serialize 异步；source 自己提供序列化 | dsh-client-ui-input-trigger/lib/types/types.d.ts |
| 引用插入 | insert.source/ref/label/appearance/clipboardText | dsh-client-ui-reference/lib/client.js |
| 连接工作区 | connectWorkspace 会 reuseOrCreateBlank | dsh-client-ui-workspace/lib/client.js / connectWorkspace |
| 新会话 | sessions.create({workspaceId})，不传旧 sessionId | dsh-api-session-controller/lib/types/client/contract/sessions.d.ts |
| provider 注册 | registerProvider(control 工厂)，有 invalidate 和 effect disposer | dsh-skill/lib/types/index.d.ts |
| rank | 较小 rank 优先；用户 DSH 400；runtime 250；bundled 600 | dsh-skill/lib/index.js、dsh-skill-filesystem/lib/index.js |
| scope | 最近 scope 层先胜出；root list 不自动使用 Agent scope | dsh-skill/lib/index.js / collect |
| 公共 scope helper | scopeOf(ctx)，不能猜内部 tag | dsh-scope 的公开 exports |
| spawn | providerName 默认 spawn，inheritsParentContext=false，persona/toolFilter/depthLimit=true | dsh-subagent-spawn-in-process/lib/index.js |
| 开始与结果 | start(name,request)，run.localAgent/id/result/dispose；stopReason 不等 completed 时输出可能部分 | dsh-subagent/lib/types/index.d.ts、types.d.ts |
| 初始时序 | startInProcessRun 内创建后直接 drivePublishedRun；不能等 start 返回才绑定人格 | dsh-subagent-in-process-driver/lib/index.js |
| persona | child scoped persona-prefix，严格模板插值；完整正文直填可能误插值 | dsh-subagent/lib/types/child-agent.js |
| child 身份 | header.origin='subagent'，parentSession，delegationDepth | dsh-subagent/lib/types/child-agent.js |
| depth | max(header.delegationDepth??0, options.subagentDepth??0) | dsh-subagent/lib/types/depth.js / delegationDepthOf |
| YAML | 宿主安装 yaml 2.9.1；用于 SKILL.md frontmatter | node_modules/yaml/package.json |
| skill invocation | disable-model-invocation、user-invocable；legacy key 拒绝；字符串布尔要解析 | dsh-skill-filesystem/lib/index.js / parseInvocationPolicy |
| prompt 字段 | section.text 可动态函数，interpolate:false 可保留文字 | dsh-system-prompt/lib/types/index.d.ts / PromptSection |

本方案选择公开服务形状 + 可选 scope helper；不把这些本机绝对 SDK 文件路径写进产品或打包产物。

## 3. K-Dense 长度勘误（已复算）

- 上游 commit：98c7fae46648724e1a43a1f2b207b0c82fcc462e。
- AGENTS.md 数量：503；总字节：9,872,867。
- 整文件字节数 >20000：227。
- 原始 UTF-16 文本长度 >20000：219。
- 归一化后的整文本长度 >20000：198。
- 去标题/元信息后的正文长度 >20000：**196 / 503 = 39.0%**。
- 将标题改为短测试名以隔离“名称 ≤40”后，实际 parsePersonaDocument 复算：307 通过、196 oversized-body、0 其他错误。
- 改短标题仅用于长度复核；不能据此说未适配的原始人格全部能直接导入。

v0.2 的 227/45.1% 实际对应字节数，不能当成解析器的正文字符计数。方案转向的依据为用户定位与维护成本，不要求通过长度或镜像统计证明唯一选择。

已有本机克隆位置为 `<本机临时目录>/probe-kdense-1dr6ay`。该路径不是长期证据依赖；其他机器可在独立临时目录取得相同 commit。

可复算命令（仓库 cwd；先有本次 src 对应的 lib。仅统计，不写用户库）：

~~~powershell
$env:EXPERT_PROBE_ROOT = '<本机临时目录>/probe-kdense-1dr6ay/scientific-agents'
git -C (Split-Path $env:EXPERT_PROBE_ROOT) rev-parse HEAD
@'
import fs from 'node:fs';
import path from 'node:path';
import { parsePersonaDocument } from './lib/personas/parse.js';
const root = process.env.EXPERT_PROBE_ROOT;
const counts = { total:0, totalBytes:0, over20kBytes:0, valid:0, oversizedBody:0, otherErrors:0 };
for (const entry of fs.readdirSync(root, { withFileTypes:true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(root, entry.name, 'AGENTS.md');
  if (!fs.existsSync(file)) continue;
  const bytes = fs.readFileSync(file);
  counts.total++; counts.totalBytes += bytes.length;
  if (bytes.length > 20000) counts.over20kBytes++;
  const raw = bytes.toString('utf8').replace(/^# [^\r\n]*/, '# 校验名称');
  const result = parsePersonaDocument(raw);
  if (result.ok) counts.valid++;
  else if (result.diagnostics.some(d => d.code === 'oversized-body')) counts.oversizedBody++;
  else counts.otherErrors++;
}
console.log(JSON.stringify(counts));
'@ | node --input-type=module
~~~

镜像候选 19 个失败只说明这轮未确认可用镜像，不说明镜像不存在或必然只能自建。本期不实现镜像功能，因此不以 V5 网络结果作为实施出口。

## 4. 旧 V1–V6 的用途

| 旧项目 | 本期用途 | 能否代替新产品验收 |
|---|---|---|
| V1 会话 ID | /expert 识别真实来源 | 不能证明子代理人格生效；不能中途换绑父会话 |
| V2 四文件差异 | 说明素材形态/归档可追溯 | 不能证明安装/许可/恢复成功 |
| V3 codec | @ 文本序列化设计依据 | 不能证明模型实际启动了正确子代理 |
| V4 inject | 软注入与能力降级 | 不能仅根据版本号宣称所有宿主支持 |
| V5 镜像 | 历史调研，已非主路径 | 不能阻塞本期 |
| V6 会话通道 | 生成流程不直接 ctx.llm.stream | 不能证明模型能可靠取源/提交草稿 |
| 第三方 peerDeps | 可选兼容调查 | 非本期前置或验收硬门 |

旧完整原始取证仍在 TEMP；重要结论已归纳为本文件的可复核契约和固定 commit。未来需要长期原始附件时，只保存相关短片段与工具版本，不复制整个 node_modules。

## 5. 产品验收记录（执行后填写）

本轮文档自身检查已完成：六份文档的本地链接目标存在、Markdown 围栏配对、无 TODO/TBD/FIXME、AX-E01–E62 连续且无重复。§5.3 人格模板用现有 lib/personas/parse.js 实际解析通过，并核对名称/简介/工作模式及 frontmatter group。这里只证明规格引用和模板格式，不算产品断言通过。

初始状态如下。不要因为规格文档存在而勾选完成。

| 阶段 | 状态 | 证据/实际结果 |
|---|---|---|
| P0 目标执行环境重新核对 | ✅ 2026-10-05 已执行 | 见 §7；HEAD 50d85b9、SDK 0.2.0-rc.2、依赖的公开接口全部存在。原状态“未执行（本轮只核对了本机设计环境）”保留于此 |
| P1 类型/设置/字典种子/路径与来源校验 | ✅ 2026-10-05 已执行 | 见 §8；typecheck 0 / build 0 / expert 三件套 43 pass / 回归 80 pass，AX-E01–E06 全 pass。原状态“未实现”保留于此 |
| P2 草稿提交/分文件暂存/整包校验 | ✅ 2026-10-05 已执行 | 见 §9；typecheck 0 / build 0 / P2 三件套 77 pass / 回归 105 pass，AX-E07–E14 全 pass。原状态“未实现”保留于此 |
| P3 安装/受管发布门/中断恢复 | ✅ 2026-10-05 已执行 | 见 §10；typecheck 0 / build 0 / 11 个测试文件 207 pass 0 fail，AX-E15–E23 全 pass；含 17 个故障点矩阵与 4 例跨进程真崩溃。原状态“未实现”保留于此 |
| P4 skill provider / catalog / 运行前依赖预检 | ✅ 2026-10-05 已执行 | 见 §11；typecheck 0 / build 0 / P4 三件套 45 pass / 回归 207 pass，AX-E24–E30 与 AX-E49 的 scope 前置全 pass；另有真实安装器 → 真实 provider 的独立字节级证据。原状态“未实现”保留于此 |
| P5 生成会话与调用接线 | ✅ 2026-10-05 已执行 | 见 §12；typecheck 0 / build 0 / P5 四件套 43 pass / 专家域回归 45 pass / 全仓 1195 tests 1194 pass 1 fail（唯一失败是既有 db.test.mjs 清理期 EPERM）、AX-E31–E35 与 AX-E50 全 pass；另有真实 HTTP 全链独立证据 38/38 与 `pnpm pack` 产物核验。原状态“未实现”保留于此 |
| P6 专家调用主链（请求 / 子代理按需人格 / 回传与释放） | ✅ 2026-10-05 已执行 | 见 §13；typecheck 0 / build 0 / P6 三件套 33 pass / 专家域回归 80 pass，AX-E36–E44、E48 全 pass，AX-E49 通过但其中"真实 skills 服务根因"标未验证；主会话另做并发位反向注入（AX-E44 变红）。原状态"未实现"保留于此 |
| P7 手动入口（`@` / `/expert` / `POST manual-requests`） | ✅ 2026-10-05 已执行 | 见 §14；typecheck 0 / build 0 / P7 三件套 40 pass / 专家域回归 146 pass / 全仓 1244 tests 1243 pass 1 fail（唯一失败是既有 db.test.mjs 清理期 EPERM，单跑亦失败）、AX-E45–E47 与 E51 全 pass；主会话另做 disposed 守卫反向注入（2 条断言变红，还原后逐字节一致）。真实宿主里的 `@` 菜单点击与 serialize 抛错时宿主 UI 行为**未验证**（留 P8/集成验收）。原状态"未实现"保留于此 |
| P8 客户端界面（生成入口 / 专家管理 / 专家草稿横幅） | ✅ 2026-10-05 已执行 | 见 §15；typecheck 0 / build 0 / P8 四件套 56 pass / 全仓 1282 tests 1281 pass 1 fail（唯一失败是既有 db.test.mjs 清理期 EPERM）、AX-E52–E58 全 pass；主会话另做 picker 第二道闸门反向注入（AX-E56 变红，还原后逐字节一致）。**无浏览器结果**：DOM 渲染、点击、真实宿主 `sessions.create`、真实 LLM 与真实安装落地全部未验（留 P9）。原状态"未实现"保留于此 |
| P9 包/真实 SDK/真实 LLM | 🔶 2026-10-05 拟交付（**未提交**） | 见 §16；新建白名单套件 `scripts/verify/suites/expert.mjs`（**1115 行** / sha256 `C569DFAC…E65D`，CRLF=0）覆盖 AX-E59–E62 并补齐 P8 的 B 层（AX-E52–E58 真实浏览器 DOM/点击），`expert` 已登记 `active` + `required:true`。单跑 **29 pass / 0 fail / 3 skip**（3 条 skip 全是真实模型层）；`check-verify-scripts` 0；`pnpm test` 0（tests 1289 / pass 1289 / fail 0）；真实链 13 阶段跑到 suites（health `1.16.5 / buildId wb-8181274a3900fe0b / schema 19`）。**真实模型链路未验证**（本机无可用 web-profile headless 入口，如实 skip、不伪造），按口径 `required + skipped` ⇒ **链在 suites 阶段判不通过**。**主会话独立复核**：单跑复现 29/0/3；独立清点 tgz（311 条目 / 2 648 241 字节 / methodology 1 / `lib/experts/**` 24 / `lib/**` 280 / personas 15 / 许可 3 / 禁止项 0 / 真实本机路径泄漏 0）；对 `_local-build/current.tgz` 做**反向注入**（抽掉 `assets/expert-generation/methodology.md` 后重打包）⇒ AX-E59-a 变红，还原后 sha256 逐字节一致；缺 `--db-path` 误调用时 H 层真读 SQLite 并如实报错（`no such table: task_drafts`）而非假绿。原状态“未执行 / 不以 fake provider 代替”保留于此 |

每批追加日期、git/build ID、命令、退出码、AX-E 编号、pass/fail/unverified/blocked 与证据路径。不要改写此前失败记录来伪装连续通过。

### 5.1 同步到 origin/main（2026-10-05 已完成，rebase 改写提交哈希）

用户指令后（原话 m02387：「那就先同步，然后开始P9」）先同步再开 P9。`git fetch origin` 0 → `git branch backup/p8-pre-rebase 3db046c` → `git rebase --autostash origin/main` **0（9/9 干净、零冲突）**；`origin/main` 当时为 `39baf4e8c2dcfa1c2ec3a94d9f7e04993455e99a`，分支相对它是 **9 ahead / 0 behind**（未 push）。

**哈希映射（旧 → 新；本文档与各 handover 里引用的旧值以此表为准）**：P1 `a63b6cb`→`30a9b58`、P2 `7bf40a5`→`33866cb`、P3 `4db0310`→`bf94e67`、P4 `0ca0a6d`→`b4e06d0`、P5 `146992f`→`a424d4e`、P6 `74e5b27`→`900d3d2`、P7 `0bdd80a`→`2e98177`、P8 `3db046c`→`7089d4b`、分叉文档 `7342c42`→`a327aa8`。

rebase 后主会话独立复跑：`pnpm typecheck` **0**、`pnpm build` **0**（buildId **`wb-8181274a3900fe0b`**，206 输入）、全仓 `node --test test/*.test.mjs` = **tests 1289 / pass 1289 / fail 0**（上游修掉 `test/db.test.mjs` EPERM，P5–P8 的唯一失败消失）。**§8–§15 里引用的旧 buildId（`wb-d130ed707d64a654` 等）已被 rebase 作废**；`git diff --stat backup/p8-pre-rebase..HEAD` 证明 P1–P8 代码内容逐行未变。完整过程见 [执行日志](ed644638-f9a0-45cf-a32f-90df7d060dda-工作台专家功能实现和优化/执行日志.md) 的「同步到 origin/main」一节。

## 6. 独立研发实例命令与授权边界

遵守 ADR 0006：只允许已核验的独立测试实例。当前用户实例永不作为重启目标。不要拿历史 PID 当运行配置。

先从真实环境取得目标 profile 绝对目录和独立 DB，再运行：

~~~powershell
node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir '<实际独立测试 profile 绝对路径>' --db-path '<实际独立 DB 绝对路径>' --dry-run
~~~

尖括号是运行环境参数，不是设计待定项；执行模型必须从实际配置核对，不替用户猜路径。本轮文档工作不执行装盘、重启或发布。

dry-run 通过、目标不等于当前实例且任务已有测试实例授权后，用相同实参去掉 --dry-run。套件 expert.mjs 必须先创建并登记 required/active；缺文件不能静默跳过。

真实 LLM 验证费用、模型选择和环境按测试实例现有配置；不要为了得到绿色结果换成假 provider 或伪造模型响应。

## 7. P0 施工基线记录（2026-10-05 执行）

执行任务：ed644638-f9a0-45cf-a32f-90df7d060dda「工作台专家功能实现和优化」（用户要求执行阶段 1–3，P0 为前置基线）。

### 7.1 目标执行环境事实（命令退出码均为 0）

| 项 | 实测值 | 复核命令 |
|---|---|---|
| git HEAD | `50d85b9aeffee3a23929e32ddb44567a82e89e61` | `git rev-parse HEAD` |
| package | `@dely0/dsh-personal-workbench` **1.16.4**（工作树内为未提交的版本号提升；HEAD 内为 1.16.3） | `git diff package.json` |
| schema | `SCHEMA_VERSION = 19`（`src/db/schema.ts:7`） | `node --test test/db.test.mjs` 属后续批次 |
| host inject | `['webServer', 'systemPrompt', 'tools', 'commands']`（`src/index.ts:47`） | 源码 |
| client inject | `['sessions', 'workspaces', 'connection', 'slots', 'layout']`（`src/client/capabilities.ts:35`） | `test/capabilities.test.mjs` |
| 基线 typecheck | `pnpm typecheck` → 退出码 0（node v24.19.0 / pnpm 11.7.0） | 已执行 |

工作树内另有**用户未提交改动**：`README.md`、`docs/design/2026-10-03-专家市场-调研.md`、`package.json`（版本号 1.16.3→1.16.4）、未跟踪 `docs/releases/v1.16.4.md`、未跟踪 `docs/design/20261003-工作台专家功能调研.txt`、未跟踪 `scripts/lib/_p2_left_body.txt`。这些不属于本任务施工成果，各批提交只显式指定本批文件。

### 7.2 真实 SDK 契约核对（0.2.0-rc.2，基目录 `<本机家目录>/.dsh/profiles/node_modules/@deepseek-ai`）

**结论：方案 v0.3 依赖的公开接口在本机目标环境全部存在，与 §2 设计取证版本一致，无差异需要记录，P1–P3 不因契约缺失而停止。**

| 契约 | 实测符号（文件） | 结论 |
|---|---|---|
| 新建会话 | `create(opts?: { workspaceId?; cwd?; sessionId? }): Promise<SessionId>`（`dsh-api-session-controller/lib/types/client/sessions/service.d.ts:179`；契约声明 `.../contract/sessions.d.ts:80`） | ✅ 不传旧 sessionId |
| subagents | `list(): string[]`、`getProvider(name): SubagentProvider \| undefined`、`start(name, request): Promise<SubagentRun>`（`dsh-subagent/lib/types/index.d.ts:282/287/300`） | ✅ |
| spawn provider | `depthLimit: true`、`toolFilter: true`、`persona: true`、`inheritsParentContext = false`、providerName 缺省 `spawn`（`dsh-subagent-spawn-in-process/lib/index.js`） | ✅ 四个能力位齐 |
| run | `SubagentRun.localAgent: Agent \| undefined`、`dispose(): Promise<void>`（`dsh-subagent/lib/types/types.d.ts:304/317`） | ✅ |
| 深度 | `delegationDepthOf(agent): number` 由 `dsh-subagent/lib/types/index.d.ts` 公开导出（实现 `.../types/depth.d.ts`） | ✅ 按官方语义，不猜 header 字段 |
| skills provider | `registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void`（`dsh-skill/lib/types/index.d.ts:247`）、`SkillProviderControl.invalidate`（同文件 :192） | ✅ |
| candidate | `SkillCandidate.rank`（:65）、`SkillCandidate.resourceBase: SkillResourceBase`（:60） | ✅ rank 600 / resourceBase 可用 |
| scope helper | `scopeOf(ctx: Context): ScopeKey \| undefined`（`dsh-scope/lib/index.js:312`，`lib/types/index.d.ts:84`） | ✅ `dsh-scope@0.2.0-rc.2` 已装盘 |
| @ 引用源 | `InputTriggerSource.onPick(pick): PickOutcome`（同步）、`ReferenceCodec.clipboardText(ref): string`、`serialize(ref, signal): Promise<string>`（`dsh-client-ui-input-trigger/lib/types/types.d.ts:161/124/126`） | ✅ 同步 pick + 异步 serialize |
| 引用插入 | `ReferenceInsert` 由 `@deepseek-ai/dsh-client-ui-conversation/client` 再导出（`dsh-client-ui-input-trigger/lib/types/types.d.ts:11,14`） | ✅ 形状照 §8.3 |

### 7.3 本批新增的产品事实与约束

- **本项目 devDependencies 里没有** `dsh-skill` / `dsh-subagent` / `dsh-scope` / 客户端 UI 包（只有 cordis、dsh-commands、dsh-host-webserver、dsh-llm、dsh-system-prompt、dsh-tools）。因此 P4/P6/P7 的适配层**只能按结构化 Probe 接口写形状探测**，不能 `import` 宿主 runtime；`@deepseek-ai/dsh-scope` 的开发依赖按 P4 计划再加。
- 客户端 `sessions.create` 与宿主 controller 的 `create` 是两层同名接口，形状一致（`workspaceId` / `cwd` / `sessionId` 全可选），P8 的 `WorkbenchRuntime.sessions` 可选方法形状按此声明（**P8 已按此落地**：`src/client/viewTypes.ts:217` 的 `create?(input?: {...}): Promise<string>`，见 §15）。

### 7.4 未验证项（如实标注，不填通过）

- 本批**没有**运行任何真实宿主服务调用（未注册 provider、未起子代理、未建生成会话）；仅为**源码/类型契约核对**，不是运行验证。
- `connectWorkspace` 的 `reuseOrCreateBlank` 行为沿用设计取证结论（`dsh-client-ui-workspace/lib/client.js`），本批未复跑。
- AX-E01–E62 仍全部**未做产品验收**（生产库、真实宿主、真实 LLM 均未跑）。

## 8. P1 施工记录（2026-10-05 执行）

**批次**：P1 类型、设置、字典种子与纯路径/来源校验。完整交接（导出签名、路径负例清单、未接线事实、逐条断言覆盖）见 [P1-handover.md](P1-handover.md)。

### 8.1 命令与退出码（主会话独立复跑，2026-10-05 12:0x–12:2x）

| 命令 | 退出码 | 实际结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 干净（Node v24.19.0 / pnpm 11.7.0） |
| `pnpm build` | 0 | `buildId wb-a6d365e4dc01c490`，188 个输入文件 |
| `node --test --test-concurrency=1 test/expertContracts.test.mjs test/expertPaths.test.mjs test/expertProvenance.test.mjs` | 0 | `tests 43 / pass 43 / fail 0` |
| `node --test --test-concurrency=1 test/personaParse.test.mjs test/personaLibrary.test.mjs test/capabilities.test.mjs` | 0 | `tests 80 / pass 80 / fail 0` |
| `node --test --test-concurrency=1 test/db.test.mjs` | 1 | `tests 9 / pass 8 / fail 1`：仅 `finally` 的 `removeTempDir` EPERM（`test/db.test.mjs:35`），**仓库既有 Windows 清理期问题**（v1.16.0.md:134、docs/issues/2026-10-05-clear-plan-does-not-refresh.md:60），非本批回归 |
| `node docs/tasks/ed644638-…/evidence/p1-settings-http.mjs` | 0 | 真实 HTTP GET/POST 6/6（补 P1 无路由测试的缺口） |

### 8.2 AX-E01–E06

| 断言 | 结论 | 证据 |
|---|---|---|
| AX-E01（seed 两个 expert 种子 + 旧 schema 库补种 + 版本不变） | ✅ pass | `test/expertContracts.test.mjs` |
| AX-E02（设置缺失/脏值/`'false'` 字符串 → 关；真 boolean 后 GET 一致） | ✅ pass | `test/expertContracts.test.mjs` + `evidence/p1-settings-http.mjs` |
| AX-E03（同 session 去重 / 不同 request 冲突 / 不动其他域草稿） | ✅ pass | `test/expertContracts.test.mjs` |
| AX-E04（同旧版本并发 CAS 只一个成功、不丢新内容） | ✅ pass | `test/expertContracts.test.mjs` |
| AX-E05（路径负例全部拒 + 根外无写入） | ✅ pass | `test/expertPaths.test.mjs` |
| AX-E06（根/父目录/目标文件是链接均拒 + 哨兵逐字不变） | ✅ pass | `test/expertPaths.test.mjs` |

### 8.3 未验证项（如实标注）

- 本批只有**单元/仓储层**证据：未起真实宿主、未注册 skill provider、未起子代理、未调真实 LLM（P4/P6/P9 范围）。
- 设置页 **UI 开关未加**（§9.3，属 P5/P8）；本批只保证服务端读写与 GET/POST 接线。
- 暂存/提交/校验/确认/放弃/安装器/恢复/catalog/手动 request/子代理调用**全部未实现**（P2+）；`~/.dsh/workbench/personas`、`skills` 仍为空，未写入任何文件。
- 来源许可只做本地结构校验，不联网核验仓库/commit（设计如此）。

### 8.4 规格偏差与复核修复

- 偏差 1：`src/api/routes.ts` 超出 P1 清单接了设置 GET/POST（P5 复核并补 `service.setAutoEnabled`）。
- 偏差 2：读开关接受 `'1'` 为真值标记（写入只写 `'true'`/`'false'`），AX-E02 的「脏值」不含 `'1'`。
- 偏差 3：根是链接时 fail-closed，需显式 `allowRootLinkUnder`（P2/P3 生产安装器必须传）。
- 复核修复 4 处（主会话提出、子代理只改这 4 处并复跑全绿）：①`assertNoLinksInPaths` 不再在「根是链接且边界允许」时提前返回（并按规格补中间级链接测试，反向注入后该测试确实变红 `pass 15 / fail 1`）；②`validateStagedFileContent` 默认只判字节、字符上限改为显式 `maxChars`（否则「归档原件超 20000 字符只给 warning」不可达）；③锁记录补 `draftId`；④删除注释里「V8 RegExp 漏 `$` 校验」的错判（`/^a+$/.test('aa') === true` 是正确行为，实现零改动）。

### 8.5 环境事实（外部会话干扰，不当作本批成果）

- 仓库内**另一个会话**正在跑 `release-preflight.mjs` 与 `scripts/repro/probe-*-mutations.mjs`：会删 `lib/`、改源文件再还原 → `pnpm build` 与 `node --test` 必须写在同一条命令里。
- 检出并还原了一处**探针遗留变异**：`probe-listview-mutations.mjs` 被中途终止后，`src/client/components/KnowledgeList.tsx` 的 `knowledgeFilterActive` 留在 `return false`（正是该探针第 12 个变异）；主会话用 `git checkout` 还原，该文件不属于本批改动。

## 9. P2 施工记录（2026-10-05 执行）

**批次**：P2 草稿提交、分文件暂存与整包校验。完整交接（导出签名、错误码清单、接线义务、未验证项）见 [P2-handover.md](P2-handover.md)。

### 9.1 命令与退出码（主会话独立复跑）

| 命令 | 退出码 | 实际结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 干净 |
| `pnpm build` | 0 | `buildId wb-13288ff8e36523c8`，190 个输入文件 |
| `node --test --test-concurrency=1 test/expertDrafts.test.mjs test/expertSkillPackage.test.mjs test/personaParse.test.mjs` | 0 | `tests 77 / pass 77 / fail 0` |
| `node --test --test-concurrency=1`（expertContracts/expertPaths/expertProvenance/personaLibrary/personaBinding/capabilities） | 0 | `tests 105 / pass 105 / fail 0` |
| `node --test --test-concurrency=1 test/db.test.mjs` | 1 | `tests 9 / pass 8 / fail 1`：仅 `removeTempDir` EPERM（`test/db.test.mjs:35`），仓库既有 Windows 清理期问题，非本批回归 |

`SUMMARY typecheck=0 build=0 p2=0 regression=0 dbtest=1`。

### 9.2 AX-E07–E14

| 断言 | 结论 | 证据 |
|---|---|---|
| AX-E07（正文 20000/20001 UTF-16 单元；CRLF/BOM/emoji 计数与现有 parser 一致） | ✅ pass | `test/expertDrafts.test.mjs`（2 条） |
| AX-E08（白名单外 frontmatter/空正文/超长名称 → 提交失败且旧草稿不损坏，不放宽 parser） | ✅ pass | 同上（2 条） |
| AX-E09（translated 无来源、merged 单来源、MIT 缺版权/全文；commit 缺失只警告） | ✅ pass | 同上（3 条） |
| AX-E10（含 CRLF 与原版权的许可文本按输入字节保存） | ✅ pass | 同上 |
| AX-E11（他会话草稿、无真实 session、伪造参数 session 一律拒绝） | ✅ pass | 同上（3 条） |
| AX-E12（单件/总量/数量/skill 数越界；不留超限索引） | ✅ pass | `test/expertDrafts.test.mjs`（4 条）+ `test/expertSkillPackage.test.mjs`（多条） |
| AX-E13（validate 后 stage 改文件 → version 增、validation 清空、旧 hash 失效） | ✅ pass | 同上（2 条 + 步骤 5 的 `staged-file-changed`） |
| AX-E14（坏 YAML/重复 key/缺 name·description/目录名不符/legacy 键/字符串 false/metadata 保留） | ✅ pass | `test/expertSkillPackage.test.mjs`（10 条） |

### 9.3 交付物与接线义务

- 新增 `src/experts/skill-package.ts`、`src/experts/drafts.ts` + 两个测试；`package.json`/`pnpm-lock.yaml` 增加普通运行时依赖 `yaml 2.9.1`；`tsconfig.build.json` 增两条 include。P1 文件零改动。
- **P5 接线义务（复核中发现，必须遵守）**：①五个工具的 `sessionId` 必须来自执行上下文 `exec.agent.session.id`，**不得作为工具参数暴露**；②`validateExpertDraft` 的 HTTP 路径靠"不传 `sessionId` 键"区分，工具路径必须传真实会话 id；③`context.failpoint` 只给测试，生产入口不得暴露；④`context.skills` 的生产注入点在 P4/P5 补。
- **P3 注意**：`manifestHash` 来自 DB 索引（已与磁盘核对），confirm 必须重读磁盘自行复算后比对，不能只信库里的值。

### 9.4 未验证项（如实标注）

- 中断/回滚用注入 `failpoint` 模拟，不是真杀进程；跨进程恢复属 P3（install journal + `.install.lock`）。
- 未接真实 skills 服务/DSH runtime；reuse 判定只对 fake registry 验过。
- 未跑全仓 75 个测试文件（只跑 P2 三个 + 回归六个）；未用 `--frozen-lockfile` 复验锁文件。
- `~/.dsh/workbench/personas`、`~/.dsh/workbench/skills` **仍不存在**：本批未写任何正式目录，无可安装专家。

### 9.5 规格偏差与过程事实

- 偏差 1：`ExpertOperationFailure.code` 放宽为 `ExpertErrorCode | PersonaDiagnosticCode`（仅人格正文失败路径，AX-E07/E08 要求原码透出）。
- 偏差 2：`rootForArea()`（P1）只认 `'persona' | 'skill'`，`drafts.ts` 内部用 `areaRoot()` 显式映射，未改 P1。
- 偏差 3：skill 包单件超限只报 `file-too-large`，不多报 `skill-package-invalid`。
- 过程事实：实施子代理在写完两个源文件后中断（无收尾消息，`pnpm typecheck` 退出码 2：`drafts.ts:64` 模块导入错、失败对象 `code` 类型过宽、`:1183` area 类型不匹配）；主会话诊断后发回修复清单，补测并全绿。本批是**跨轮续作**，不是一次成功，如实记录。
- 仓库本地 `core.autocrlf` 被外部改成 `false`，而 HEAD blob 全为 LF、工作树多为 CRLF → 直接把改动 `git add` 会产生整文件 CRLF churn；本批文件已统一成 LF 后再提交（`git diff --stat` 只显示真实改动 +51/−3）。

## 10. P3 施工记录（2026-10-05 执行）

完整交接（导出签名逐字、故障点矩阵、接线义务、偏差清单）见同目录 [`P3-handover.md`](./P3-handover.md)；这里只记录**证据**。

### 10.1 命令与退出码（主会话独立复跑，非只读子代理报告）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm build` | 0 | 客户端 `lib/client.js` 552.64 kB |
| `node --test --test-concurrency=1`（expertInstall + P1/P2 回归 + persona 系，共 10 个文件） | 0 | `tests 194 / pass 194 / fail 0`（第一轮复核） |
| `node --test --test-concurrency=1`（再加 `test/expertRecovery.test.mjs`，共 11 个文件） | 0 | `tests 207 / pass 207 / fail 0`（第二轮复核，`duration_ms 15590`） |

`SUMMARY typecheck=0 build=0 p3plusregression=0`（194）→ `SUMMARY typecheck=0 build=0 recovery_full=0`（207）。`build` 与 `node --test` 同一条命令：外部会话的 `probe-*-mutations.mjs` 会删 `lib/`。

### 10.2 AX-E15–E19 / E23（第一轮：install.ts + managed.ts）

| 断言 | 结论 | 证据 |
|---|---|---|
| AX-E15 原创无技能确认 | ✅ | DB `confirmed` + `publication.ready` + catalog 可取 + 附件字节比对 |
| AX-E16 MIT + 两 skill，ready 前不可发现 | ✅ | 4 个 failpoint 快照：`discoverPersonas`/`resolvePersona` 均读不到且给 `installation-incomplete` |
| AX-E17 重复确认/并发 | ✅ | 同 `expertId`/`confirmResult`、文件数不增；重入 → `install-in-progress` |
| AX-E18 不同 hash 同名 skill | ✅ | 两例（提交期 + 确认时重新校验）；旧 skill 字节不变、无正式入口 |
| AX-E19 同 hash ready skill 复用 | ✅ | 记 `reusedPaths`、字节不变；补偿只撤本次 `createdPaths` |
| AX-E23 锁三档 | ✅ | 活→`install-busy`；同机死→回收；不明/别主机→`install-lock-owner-unknown` 不强删；不释放别人的锁 |

另有 §6.2 坏 `publication.json` 三种形态、§6.5 两条补偿路径、§6.3 跨 DB 跳过的额外用例。

### 10.3 AX-E20–E22（第二轮：真崩溃 + 故障矩阵）

| 断言 | 结论 | 证据 |
|---|---|---|
| AX-E20 发布点失败（DB 未确认） | ✅ | 17 个 failpoint 的进程内补偿矩阵（每个点断言 DB/FS/可见性/journal 终态/`.build*` 清理/**暂存 sha256 不变**/同版本重试成功） |
| AX-E20 真崩溃 | ✅ | 子进程跑产品代码自身的 stage→validate→confirm，在目标点 `process.exit(97)`（`spawnSync` 断言 `status=97` + marker 存在），父进程在同一 dbPath 重开新实例恢复：`@prepared`、`@files-published` 两例 |
| AX-E21 COMMIT 后中断 | ✅ | 5 个提交后 failpoint + 真崩溃 `@db-committed`/`@ready`：`completed-publication`（只多一个 `publication.json`）/`already-ready`，重复确认幂等，`generated/` 逐字节不变 |
| AX-E22 外部修改/日志损坏/他库日志 | ✅ | 主坏+备份好 → `degraded:true` 并用**备份**决策补偿；两份都坏 → `repair-required` 且同轮健康草稿仍 `already-ready`（`scanned=2`）；`ownerDbKey` 缺失/null/空串 → `skipped-owner-unknown`，异库 → `skipped-foreign-owner`（四种都不动文件、日志字节不变）；两 DB 共享一根的最小端到端 |

### 10.4 反向注入验证（主会话亲自执行）

`src/experts/install.ts` 的 `parseJournal` 修复（非字符串 `ownerDbKey` 归一为 `''`）由主会话独立反向注入确认：

- 装回 bug 后：`pnpm build` 退出码 0，`node --test --test-concurrency=1 test/expertRecovery.test.mjs` → `ℹ tests 13 / ℹ pass 12 / ℹ fail 1`，失败原文 `actual: 'repair-required', expected: 'skipped-owner-unknown'`。
- 还原后：`ℹ tests 13 / ℹ pass 13 / ℹ fail 0`，源码内 `REVERSE-INJECTION PROBE` 残留 0 处，`CR-count 0`（LF）。

### 10.5 交付物与接线义务

- 新增 `src/experts/install.ts`（1916）、`src/personas/managed.ts`（350）、`test/expertInstall.test.mjs`（1027，12 test）、`test/expertRecovery.test.mjs`（1276，13 test）；修改 `src/personas/library.ts`、`src/shared/persona.ts`、`src/shared/expert.ts`、`src/experts/paths.ts`、`src/experts/drafts.ts`、`src/db/repo/experts.ts`、`tsconfig.build.json`。**未改** `src/index.ts` / `src/tools.ts` / `src/api/**`。
- **后续接线义务**：①启动时**先** `recoverExpertInstallations` **再**注册技能 provider，`repair-required` 不得阻止启动；②`confirmExpertDraft` 只把 `InstallFailure`/`ExpertRepoError` 转成 `ok:false`，**其它异常会抛出** → HTTP/工具层必须 try/catch 且不透出原始日志/绝对路径；③`sessionId` 取 `exec.agent.session.id`，HTTP 路径不传该键；④`context.failpoint` 只给测试；⑤P4 注册 provider 时 `refreshSkills` 接 `control.invalidate`，list/get 用 `readManagedSkillInstallState` 判 ready。

### 10.6 未验证项（如实标注，不填通过）

- 生产启动接线未做（`recoverExpertInstallations` 无调用点）；真实 provider 未注册（`refreshSkills` 仍是注入 hook）。
- 字节撕裂（SIGKILL/断电打断 `fsync`/`rename` 中间态）未测 —— §6.3 末段明确排除。
- 无真实 dsh 实例级端到端；`~/.dsh/workbench/{personas,skills}` **仍不存在**（本批只在 `mkdtempSync` 目录写文件）。
- 恢复路径下的 `reusedPaths` 未单独测；`repair-required` 之后的人工修复流程未测；多条同时中断未测。
- 未跑全仓 `test/*.test.mjs`；`test/db.test.mjs:35` 的既有 Windows 清理期 EPERM 未触碰（非本批回归）；未用 `--frozen-lockfile` 复验。

### 10.7 规格偏差与过程事实

- 偏差 1【已修+反向注入】：`parseJournal` 把 `ownerDbKey` 缺失判成日志损坏，与 §6.3/AX-E22 矛盾（见 10.4）。
- 偏差 2【记录未改】：已提交分支的补偿把日志钉成 `db-committed`，`install.after-ready-journal` 抛错会把日志从 `ready` 降级为 `db-committed`；仅测试可达，恢复只看 DB + publication → 仍 `already-ready`，无功能影响。
- 偏差 3【记录未改】：publication 已就绪时的幂等回放不重写日志（停在 `db-committed`）；规格未要求。
- 偏差 4：`install.after-validation` 的异常原样抛给调用方（该点在补偿 try 之外，磁盘/DB 零改动）→ 强化了 10.5 的接线义务 ②。
- 偏差 5：未预期异常统一回 `install-repair-required`；中断型补偿 `lastInstallError.code='canceled'`。
- 过程事实：P3 由**同一子代理分两轮**完成（第一轮 1914 行 install.ts + managed.ts + 12 test；第二轮 +13 test 与 1 处缺陷修复），两轮都经主会话独立复跑（194 → 207）与逐段源码复核。第一轮过程中撞到两个真缺陷（draft mutex 重入被自己挡住导致 11 例全红；外层 catch 漏认 `InstallFailure`），均已修；测试侧另有 3 处用例自身问题（sessionId 复用串味、journal 目录未建、漏 import），如实记录。

## 11. P4 施工记录（2026-10-05 执行）

### 11.1 命令与退出码（主会话独立复跑）

同一条命令内顺序执行（外部会话的 `scripts/repro/probe-*-mutations.mjs` 会 `rmSync('lib')`，分开跑会赛跑）：

| 命令 | 退出码 | 输出 |
|---|---|---|
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm build` | 0 | buildId `wb-7fb1c7f63bec2961`（195 输入文件；client 552.64 kB） |
| `node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs` | 0 | `ℹ tests 45 / pass 45 / fail 0 / skipped 0`（18 provider + 12 catalog + 15 存量） |
| `node --test`（11 个回归文件） | 0 | `ℹ tests 207 / pass 207 / fail 0` |
| `node <evidence/p4-provider-real-install.mjs>` | 0 | `11/11 PASS`、临时根已清理 |

子代理曾自报一次回归抖动（`test/personaLibrary.test.mjs` AX-R06 报 undici `bad port`），主会话两次独立复跑均**未复现**，该文件本批未改。

### 11.2 AX-E24–E30 / E49 对账

| 断言 | 结论 | 证据 |
|---|---|---|
| AX-E24 未 ready 受管技能不进 list/get；补 publication 后立即可见 | ✅ | `test/expertProvider.test.mjs:302` |
| AX-E24 坏包只记诊断（YAML 坏/name 不符/旧驼峰键/链接/非目录/坏目录名） | ✅ | 同上 `:354` |
| AX-E24 完整性字段（`complete`、abort 立即返回空） | ✅ | 同上 `:413` |
| **AX-E24 清单 hash 复核（本批修复轮新增）** | ✅ | 同上 `:423`/`:447`/`:479`/`:520`/`:542` + 真实安装产物证据（11.4） |
| AX-E25 同层 rank 400 胜 600、只走 `registerProvider` | ✅ 消费侧 | 同上 `:435`/`:476` |
| AX-E26 真实 `scopeOf` 解析 / 跨层胜出 | ✅ SDK 实测 + ⚠️ 仲裁为模拟注册表 | 同上 `:506`/`:517` |
| AX-E27 候选变动 → get undefined + invalidate，不偷换正文 | ✅ | 同上 `:590` |
| AX-E28 安装后无需重启即可发现 / 换代后旧控制器作废 | ✅ 消费侧 | 同上 `:640`/`:677` |
| AX-E29 目录行与状态优先级（含 installation-incomplete 压过 invalid/disabled） | ✅ | `test/expertCatalog.test.mjs:268`/`:397`/`:421` |
| AX-E30 依赖预检三例 + 坏清单 + 清单一致判可用 | ✅ | 同上 `:442`/`:497`/`:527`/`:570` |
| AX-E49 scope 前置（helper 缺失/抛错 → `skill-scope-unavailable`，preflight 绝不判通过） | ✅ | 同上 `:630` + `test/expertProvider.test.mjs:552` |
| §7.3 投影保真（provider/source/rank/locator；坏条目丢弃） | ✅ | 同上 `:738` |
| AX-E48 自主召唤开关 off→on→off | 未验证（P6 范围） | 本批只交 `buildAutoExpertPrompt`，未注册进 systemPrompt |

### 11.3 交付物

新增 `src/experts/skill-provider.ts`（673）、`src/experts/host-adapter.ts`（404）、`src/experts/catalog.ts`（963）、`test/expertProvider.test.mjs`（933，18 test）、`test/expertCatalog.test.mjs`（780，12 test）、`test/fixtures/expertSkillFixture.mjs`（72）；修改 `package.json`（peer + `peerDependenciesMeta` optional + devDependency `@deepseek-ai/dsh-scope` 0.2.0-rc.2）、`pnpm-lock.yaml`（+3 行）、`tsconfig.build.json`（include +3）。**未改** `src/index.ts` / `src/tools.ts` / `src/api/**` / `src/client/**`；P1–P3 源文件零改动。逐字签名与接线义务见 `P4-handover.md` §2 与 §9。

### 11.4 独立证据：真实安装器 → 真实 provider

仓库测试的 `workbench-install.json` 是夹具构造的（用产品自己的 `hashSkillPackage` 算真哈希），所以"健康包被列出"在测试里带自证成分。`docs/tasks/ed644638-…/evidence/p4-provider-real-install.mjs`（**不属于仓库测试**）用真实草稿链（create → submit → stage×4 → validate → confirm）装一个含子目录许可副本与点开头文件 `.notes.txt` 的受管技能，再喂给真实 provider：**清单 `packageHash` 与候选 `locator.packageHash` 逐字相等**；清单 `files[]` 的 bytes/sha256 与磁盘真实字节相符；手改 `SKILL.md` → list 空 + `skill-package-invalid` + 伪造 locator 的 get 也拿不到（invalidate 恰好 1 次）；删掉 `.notes.txt` → 同样拒绝；全部还原 → 重新可见；根外哨兵未变。实跑 `11/11 PASS`、退出码 0。

### 11.5 规格偏差与过程事实

- 偏差 1【记录未改】：`duplicate-id-overridden` 的诊断行给 `status='disabled'`+`enabled:false`（§9.1 状态枚举无"被覆盖"档，两个方向都是撒谎，取"存在但不生效"并保留 issues 原文）。
- 偏差 2【记录未改】：`invalid` 只可能出现在诊断行（winner 行来自解析成功且发布门已放行的文档）；五级优先级在两类行合起来的意义上完整成立。
- 偏差 3【记录未改】：`readPendingInstallNote` 只读扫 `.pending/*/install-journal.json`（仓库没有"列出全部 expert 草稿"的函数），失败静默跳过。
- 偏差 4【记录未改】：`sourceKey` 反查复用 `sourceKeyForRoot`，反查不到落 `'user'`（理论不可达）。
- 偏差 5【记录未改】：`buildAutoExpertPrompt` 走 `checkSkills:false` —— 摘要不是权限证明，真正执行仍走完整异步 `preflightExpert`。
- 偏差 6【记录未改】：`scopeOf` 成功但返回 `undefined` 时投影记 `preliminary:true`（比 §7.3 更保守）；**P5 不得把 `preliminary` 当"不可用"**。
- **过程事实 1（真缺陷，已修）**：`isLinkEntry` 兜底用 `statSync`（跟随链接）→ 对 `Dirent` 未标出的 junction 永远 `false`，安全网为空；改 `lstatSync` 并补语义前提用例。此条**无反向注入**（真实文件系统造不出该形状），只有本机实测 `Dirent=true / lstat=true / statSync=false` + 代码论证。
- **过程事实 2（真缺陷，已修 + 反向注入）**：受管技能的清单 hash 从未被消费 → 安装后手改/增删文件仍会被当受管版本列出与 get。已加比对（`src/experts/skill-provider.ts:438`）。反向注入把该条件改 `if (false)`：`tests 30 / pass 28 / fail 2`，只有两条篡改用例红；还原后 45/45，探针残留 0。
- **过程事实 3（连带口径不一致，已修）**：`walkSkillPackage` 原跳过包内点开头文件，而安装器的 `packageHash` 覆盖它写入的每个文件（`src/experts/paths.ts:148` 只拒 `.`/`..` 整段）→ 含 `.foo.txt` 的**合规**包会被永久误判；已去掉包内跳过（副作用：更严）。
- **过程事实 4（夹具必须同步）**：两个测试文件的 `workbench-install.json` 原用合成哈希（`packageHash: HEX`，catalog 连 `files[].sha256` 也是 `HEX`）；修复后会被正确判成"被改过"。新增 `test/fixtures/expertSkillFixture.mjs`（真实哈希）后，**原有 24 条用例的断言文本一字未改**。
- **过程事实 5**：P4 由**同一子代理分两轮**完成（第一轮三源文件 + 39 test；第二轮两项修复 + 夹具真实化 → 45 test），两轮都经主会话独立复跑与逐段源码复核；未接生产装配（属 P5/P8），未执行安装/重启/发布。

## 12. P5 施工记录（2026-10-05 执行）

### 12.1 命令与退出码（主会话独立复跑，同一条命令链）

| 命令 | 退出码 | 输出要点 |
|---|---|---|
| `pnpm typecheck` | 0 | `tsc --noEmit` 无输出 |
| `pnpm build` | 0 | client 552.64 kB（gzip 163.91 kB），Build complete in 78ms |
| `node --test test/expertRoutes.test.mjs test/expertTools.test.mjs test/expertWiring.test.mjs test/httpFence.test.mjs` | 0 | `ℹ tests 43 / pass 43 / fail 0`（16+14+8+5） |
| `node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs` | 0 | `ℹ tests 45 / pass 45 / fail 0`（18+12+15） |
| `node --test test/*.test.mjs` | 1 | `ℹ tests 1195 / pass 1194 / fail 1`；唯一失败 `db migrations, dictionaries and task tree` 为**清理期 EPERM**（既有问题，`docs/releases/v1.16.0.md:134`） |
| 独立证据 `evidence/p5-http-e2e.mjs` | 0 | `P5 HTTP 端到端证据：38/38 PASS，响应样本 23 条` |
| `pnpm pack`（`prepare` 会重建 lib，单独跑） | 0 | tarball 299 条目；含 `assets/expert-generation/methodology.md` + 全部新 lib 模块 + 3 个 LICENSE |

本批 14 个文件 CR 全 0（LF）；`REVERSE-INJECTION` 在 `src/**`、`test/**` 残留 0。

### 12.2 AX-E31–E35 / E50 对账

| 断言 | 结论 | 证据（测试文件:用例 / 独立证据） |
|---|---|---|
| AX-E31 | ✅ 测试内（真实 19387 宿主未跑） | `test/expertRoutes.test.mjs` 非回环 403 / 坏 JSON 400 / 声明超长 413；`test/expertWiring.test.mjs` 真发 300KiB body → 413 且草稿零行；`evidence/p5-http-e2e.mjs` 全链泄漏扫描（无临时根、`install-journal`、`ticket`） |
| AX-E32 | ✅ | `test/expertRoutes.test.mjs` 旧 version / 错 hash → 409 且正式库零写入；`evidence/p5-http-e2e.mjs` pending 草稿三条负例 + 已确认草稿幂等回放 |
| AX-E33 | ✅ | `test/expertRoutes.test.mjs` 首次 `replayed:false` → 再次 200 `replayed:true`；旧任务 kind 返回结构不变 |
| AX-E34 | ✅ | `test/expertTools.test.mjs` 只注册 5 个生成工具、无确认/安装工具、无 `session_id`/`root`/`absolute_path` 参数 |
| AX-E35 | ✅ | `test/expertRoutes.test.mjs` abandon 只清自己的暂存；installing → 409 且草稿仍 pending；其他草稿不受影响 |
| AX-E50 | ✅ **仅 fake ctx 内**（真实宿主未跑） | `test/expertWiring.test.mjs` 6 条：inject 逐字未变、一份 service 三处共用、skills 缺失不 pending、子 fiber + effect 范式、live agent 的 scope/cwd 原样传到 `skills.list`、settings POST 真 boolean 恰好转发一次 |

### 12.3 交付物

14 个文件（8 新增 + 6 修改）与逐字导出签名见 `P5-handover.md` §1/§2。

### 12.4 独立证据：真实 HTTP 全链 + 真实 provider 挂载

`docs/tasks/ed644638-…/evidence/p5-http-e2e.mjs`（**不属于仓库测试**）：真实 `http.createServer` + `makeRoutes(db, { experts })` + 真服务（`roots={home:<临时根>}`，与生产 `config.home` 同口径），走完 `capabilities → methodology → generation-start → 5 个工具 → validate → file → confirm → catalog → 再次 confirm → 负例 → abandon`。

三条最有价值的真实行为：①**无 skills 服务时**，受管发布被 `catalog` 真的发现（`source:'user'`、`provenanceState:'recorded'`、`enabled:true`）但如实降级为 `dependency-unavailable` + `skill-service-unavailable`，且不进 `personas` 可选摘要；②把**真实 P4 provider** 包进假 skills 服务后，同一行翻成 `usable`、`requiredSkills[0].available===true`、`preliminary===true`（无 live agent ⇒ 不假装已按 scope 仲裁），`preflight.usable===true`；③AX-E32 的"旧 version → 409"必须打在 **pending** 草稿上——已确认草稿的 confirm 走**幂等回放**（`src/experts/install.ts:1407-1413`，replay 优先于版本校验，这是设计）。

### 12.5 规格偏差、复核与修复

7 条规格偏差逐条列在 `P5-handover.md` §7（其中 ②`validateDraft` 第三参、③`Config.home`、⑥把 P1/P3 缺口在接线层补偿，明确标注为**子代理/主会话的判断偏差**）。

主会话逐文件复核后发出 3 处修复请求并已落地：①preflight 回调漏传 `exec` → 永远无 scope 全局视角（真问题，+11 行 + 反向注入）；②`setAutoEnabled` 转发只靠源码扫描 → 改可注入桩断言；③413 只靠声明式长度 → 补真发超限 body 用例。修复轮后 `tests 330 / pass 330 / fail 0`，反向注入（接线点传 `undefined`）→ `tests 8 / pass 7 / fail 1`（`actual: undefined` vs `expected: {label:'wiring-agent-scope'}`），还原后全绿。

### 12.6 未验证项（如实标注，不填通过）

8+1−1 条见 `P5-handover.md` §8，其中与 §12.2 直接相关的是：**真实 19387 宿主实例未跑**（未重启、未装盘，需用户明确授权）、**真实宿主 skills 服务未跑**（全程 fake/桩）、**"最近层同名技能胜出"的合并语义未在真实注册表验证**（只证明了 scope/cwd 原样传入）。

---

## 13. P6 施工记录（2026-10-05 执行）

### 13.1 命令与退出码（主会话独立复跑，同一条命令链）

| 命令 | 退出码 | 计数 / 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | — |
| `pnpm build` | 0 | client `lib\client.js` 552.64 kB；buildId `wb-fc290c643d3d895a`（200 个输入文件） |
| `node --test test/expertInvocation.test.mjs test/expertWiring.test.mjs test/personaBinding.test.mjs` | 0 | `tests 33 / pass 33 / fail 0`（16 + 8 + 9） |
| `node --test test/expertProvider.test.mjs test/expertCatalog.test.mjs test/skills.test.mjs test/expertRoutes.test.mjs test/expertTools.test.mjs test/httpFence.test.mjs` | 0 | `tests 80 / pass 80 / fail 0` |

全仓套件本批**未跑**；按 P5 基线（`1195 / 1194 pass / 1 fail`，唯一失败为既有 `test/db.test.mjs` 清理期 EPERM）+ 新增 16 条推算为 `1211 / 1210 / 1` —— 推算不等于实测。

### 13.2 AX-E36–E44 / E48 / E49

逐条证据（用例名）见 `P6-handover.md` §6。结论：**AX-E36–E44 与 AX-E48 全 ✅**；**AX-E49** 的 5 条用例通过（缺 subagents / 只有 fork / 缺 `persona|toolFilter|depthLimit` / 开关打开但无合格 provider / 完全无 subagents 服务），但其中"真实 skills 服务导致的 `skill-scope-unavailable`"**根因未验证**（拒绝路径真实，触发源是注入的假 preflight）。

### 13.3 交付物

新增 `src/experts/invocation.ts`（1284 行）、`test/expertInvocation.test.mjs`（1150 行，16 条）；修改 `src/experts/host-adapter.ts`（405 → 564）、`src/experts/service.ts`（994 → 1140）、`src/experts/tools.ts`（576 → 959）、`src/index.ts`（618 → 670）、`tsconfig.build.json`（+1 include）。全部 CR=0 且以 LF 结尾。顶层 `inject` 逐字未变；未加依赖；未改 `SCHEMA_VERSION`；`src/api/**` 与 `src/client/**` 未动（`POST /experts/manual-requests` 属 P7）。

### 13.4 独立证据（主会话亲自执行）

- **反向注入（主会话另挑一处）**：`acquireSlot` 的 `perSession >= 1 || total >= 2` 闸门改成 `>= 999` → `✖ AX-E44 … (60107.39ms)`、`tests 16 / pass 15 / fail 1`；还原后 SHA256 与注入前逐字节相同（`29BC8900ADA9445FC341AE14AA3FCB26ADE3EC3780EE4057FF271740AE0950B2`），CR=0。→ 并发上限由**会失败的断言**守住，不是源码扫描。
- **子代理的反向注入**：拿掉 `requireTicket` 的 `parentSession` 校验 → `✖ AX-E39 …`（`'ticket-child-mismatch'` ≠ `'ticket-invalid'`）、`tests 1 / pass 0 / fail 1`；还原后 33/33。
- **格式修复**：`src/experts/host-adapter.ts` 缺尾换行 + 新段前多一个空行 → 已补（564 行、CR=0）。
- **无真实 provider 证据**：本机 spawn provider 是 cordis 插件（只导出 `Config/apply/inject/name`），要跑需真宿主 + 真 LLM，属 P9 隔离实例验收范围 → §13.6 如实标未验证。

### 13.5 规格偏差、复核与修复

12 条规格偏差逐条列在 `P6-handover.md` §7（其中"非 completed 的失败码映射"、"没 claim ≠ 契约错配"、"多一道能力可用门"、"两个常量落本模块"、"子代理守卫用 `expert-disabled`"明确标注为**判断/解释**）。

主会话逐段读完 `invocation.ts` 全文与 4 个修改文件的 diff，**未发现功能缺陷，故本批没有修复轮**（只做了一处格式修复）。口径纠正一处：子代理报告 §6-1 称"error/max-tokens/refusal 统一映射成 `expert-subagent-unavailable`"，实际是 `error` → `expert-subagent-unavailable`、`aborted` → `canceled`、`max-tokens`/`refusal` → 直接使用宿主 stopReason 字面值作为 `code`（§12.1 无对应码），以 `P6-handover.md` §7-3 为准。另修正 `P5-handover.md:40` 的 `methodology()` 签名漂移（同步 `ExpertMethodology`，不是 `Promise`）。

### 13.6 未验证项（如实标注，不填通过）

8 条见 `P6-handover.md` §8，核心是：**真实宿主 provider / 真 `SubagentRuntime` / 真 LLM 全部未跑**（时序、dispose 幂等、stopReason 取值、child header 字段、`persona` 严格插值、`ToolRuntime` 对未知 deny 名的 loud 拒绝都只对着忠实假实现验证过）；**真实 skills 服务的 `skill-scope-unavailable` 根因未验证**；**真 cordis 热重载未验证**；**`subagents` 服务"晚到"不会重同步**（只在设置变化时 `sync()`）；**P7 UI 与真实 19387 实例未跑**；macOS/Linux 未测。

---

## 14. P7 施工记录（2026-10-05 执行）

### 14.1 命令与退出码（主会话独立复跑，同一条命令链）

| 命令 | 退出码 | 计数 / 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | — |
| `pnpm build` | 0 | buildId `wb-56b6a671db50d923`（203 个输入文件）；`lib\client.js` 559.78 kB / gzip 166.22 kB |
| `node --test test/expertInputSource.test.mjs test/expertCommand.test.mjs test/capabilities.test.mjs` | 0 | `tests 40 / pass 40 / fail 0` |
| `node --test` 专家域 9 文件 | 0 | `tests 146 / pass 146 / fail 0` |
| `node --test test/*.test.mjs`（全仓） | 1 | `tests 1244 / pass 1243 / fail 1`（duration 约 11.2 s） |

全仓唯一失败与 P5/P6 基线同源、非本批引入：`test/db.test.mjs` 的 "db migrations, dictionaries and task tree"，单独跑也失败（`tests 9 / pass 8 / fail 1`），错误为 `Error: EPERM, Permission denied: \\?\C:\Users\ADMINI~1\AppData\Local\Temp\dsh-personal-workbench-db-KXtbln`（临时目录清理期）。`test/verifySafety.test.mjs:351` 会打一行带 `✖` 前缀的诊断文本，但它不在 failing tests 列表、不计入 `fail`。基线推算 P5 `1195 / 1194 / 1` + P6 16 + P7 34 = 期望 1245，实测 1244（差 1 条纯计数差，未追根因，不影响断言结论）。

### 14.2 AX-E45–E47 / E51

逐条证据（用例名与行号）见 `P7-handover.md` §6。结论：**AX-E45（8 条）、AX-E46（7 条）、AX-E47（11 条）、AX-E51（3 条）全 ✅**。其中 AX-E45/E46 的"源不抢文件仲裁"、"inputTriggers 缺失不注册"、"跨会话只认 ref 的 sessionId"、"serialize 失败绝不回落成普通文本"都各有会失败的断言守着；`expertCommand.test.mjs:312-320` 真起 `http.createServer` + `server.listen(0,'127.0.0.1')` + `fetch` 打真端点验 `POST /experts/manual-requests` 契约。

### 14.3 交付物

新增 `src/experts/command.ts`（253 行）、`src/client/expertPrompt.ts`（85 行）、`src/client/expertInputSource.ts`（580 行）、`test/expertInputSource.test.mjs`（566 行，16 条）、`test/expertCommand.test.mjs`（425 行，18 条）；修改 `src/api/routes/experts.ts`（`+31 −2`，新增 `manual-requests` 分支）、`src/index.ts`（`+45 −2`，新增 `registerExpertCommand`）、`src/client/index.tsx`（`+14 −1`，一行装配）、`tsconfig.build.json`（`+3` include）。10 个相关文件全部 CR=0 且以 LF 结尾。顶层 `inject` 逐字未变（4 项），`src/client/capabilities.ts` 逐字未变（5 项，sha256 `0C5326113D5606B9BE0781139999BD20D76EBDD6869B603DB8226818ACC430EF`）；未加任何依赖；ticket 无 HTTP 出口；`SCHEMA_VERSION` 未动。

### 14.4 独立证据（主会话亲自执行）

- **反向注入（主会话另挑一处）**：删掉 `src/client/expertInputSource.ts` 里 `register()` 的 `if (disposed) return` 守卫 → `build 0` 但 `node --test` 两文件 = `tests 33 / pass 31 / fail 2`；还原后 sha256 = `FF3C3F9D11B9988365BB03E1345FF914A00C802BEF068EF1632831ACFFBD8640`（与注入前逐字节相同，也与子代理自报前缀一致）。→ 生命周期守卫由**会失败的断言**守住。
- **diff 逐行读完**（4 个已跟踪文件合计 `+93 −5`），**三个新模块全文通读**（85 + 253 + 580 行）：未发现功能缺陷，故本批没有修复轮，只做 §14.5 的两处小修。
- **注释引用核对**：`EXPERT_INVOCATION_DIRECTIVE` 5 行与 `方案-v0.3.md:654-660` 逐字一致；`src/index.ts:246-249` 确是 `/workbench` 的 steer 调用点；`dsh-commands/lib/types/index.d.ts:54` 确是 `readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>`。

### 14.5 规格偏差、复核与修复

5 条偏差逐条列在 `P7-handover.md` §7（其中 **`serialize` 先 `preflight` 再 `manual-requests`** 是主会话复核时新识别的：超出 §8.3 字面顺序，但正是 P6 交接 §9-2 与 AX-E46"身份变动即拒"的要求，代价是提交时多一次 HTTP 往返；另 4 条为"两条不可达分支删除"、"`command.ts` 的 tsconfig include 冗余但保留"、"入口装配收进一行"、"端点常量集中一处"）。

两处小修（均为格式/注释，无行为变更）：①`src/client/index.tsx` 新段后多余空行删除（1986 → 1985 行）；②`src/experts/command.ts:232` 注释的 steer 出处由 `src/index.ts:209-212` 更正为 `src/index.ts:246-249`，并注明 `createUserMessage` 自 `src/index.ts:9` 起即既有 import 口径（⇒ 该文件 sha256 由 `CFF465BA…41D1C` 变为 `A3E1DA683F2A85D2E56CE80FE04EB127882B0F5F0CC43C573E4EC2081A7D4F24`）。修完重跑全绿（`typecheck 0` / `build 0` / 三件套 40/40 / 专家域 146/146）。

### 14.6 未验证项（如实标注，不填通过）

8 条见 `P7-handover.md` §8，核心是：**真实宿主未跑**（未起 19387、未点 `@` 菜单，源并列/引用胶囊/`onPick` 后的 ref 呈现只对着假 `host` 验过）；**`codec.serialize` 抛错时宿主的 UI 行为未验证**（"保留输入并阻止发送"属宿主契约）；**跨会话复制的拒绝未端到端验证**（`manual-request-session-mismatch` 属 P6/服务端）；**真实 `agent.steer` 与 `CommandInvocation.agent` 真实形状未跑**；**`pnpm test` 全量脚本未跑**（用等价 `node --test test/*.test.mjs`）；**真实 provider / 真 `SubagentRuntime` / 真 LLM 全部未跑**（同 P6）；**macOS/Linux 未测**。

---

## 15. P8 施工记录（2026-10-05 执行）

### 15.1 命令与退出码（主会话独立复跑，同一条命令链）

| 命令 | 退出码 | 计数 / 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | `tsc --noEmit`（`tsconfig.json` 的 `include: ["src"]` + `strict: true`，**确实覆盖 `src/client/**`**） |
| `pnpm build` | 0 | buildId `wb-d130ed707d64a654`（206 个输入文件）；`lib\client.js` 597.32 kB / gzip 177.29 kB |
| `node --test test/expertClientFlow.test.mjs test/clientInvariants.test.mjs test/capabilities.test.mjs test/draftBannerSessionJump.test.mjs` | 0 | `tests 56 / pass 56 / fail 0` |
| `node --test test/*.test.mjs`（全仓） | 1 | `tests 1282 / pass 1281 / fail 1`（duration 约 12 s） |

全仓唯一失败与 P5/P6/P7 基线同源、非本批引入：`test/db.test.mjs` 的 "db migrations, dictionaries and task tree"（临时目录清理期 `EPERM`）。**收尾复核补充**：`origin/main` 已前进到 `7980493`，其中 `05fea07` 与 `7980493` 正是修这条（"清理临时目录不再抛错，避免 finally 顶替真正的断言失败"）⇒ 本批的"1 fail"是**本地基线**的真实状态，P9 rebase 到新 `origin/main` 后预期归零。计数核对：P7 基线 1244 + 本批新增 38（`test/expertClientFlow.test.mjs` 全部用例）= **1282** ✓。子代理首轮曾报"全仓连跑第二次会多出 4 条假失败"（AX-E48 / AX-R04 / draft defer-resume-abandon API / PATCH `/tasks/:id`），主会话复跑时未复现；那 4 个文件本批一个未碰。

### 15.2 AX-E52–E58

逐条证据（用例名与行号，主会话逐条打开核对过）见 `P8-handover.md` §6。结论：**AX-E52（4 条）、AX-E53（6 条）、AX-E54（6 条）、AX-E55（3 条）、AX-E56（5 条）、AX-E57（4 条）、AX-E58（10 条）全 ✅**。其中"不复用 blank 会话"（`:258` 断言 `sessions.create` 新身份 + `connectWorkspace` 调用数 = 0）、"确认 body 恰好两字段且等于所见版本"（`:505`）、"版本冲突后没有第二次确认"（`:593`）、"安装成功后重读目录"（`:649`）、"required 缺失行可见但选择器不可选"（`:710`）、"`WorkbenchApp` 体内零 `useState`/零网络/零定时器"（`:886`）都各有会失败的断言守着（见 §15.4 的 6 处反向注入）。

### 15.3 交付物

新增 `src/client/hooks/useWorkbenchExperts.ts`（1510 行）、`src/client/components/ExpertCreateModal.tsx`（154 行）、`src/client/components/ExpertDraftBody.tsx`（253 行）、`test/expertClientFlow.test.mjs`（1018 行，38 条）；修改 `src/client/viewTypes.ts`（`+15 −0`，`sessions.create?`）、`src/client/index.tsx`（`+65 −2`，装配 hook + 惰性转发 ref）、`src/client/components/SettingsModal.tsx`（`+57 −3`）、`src/client/components/PersonaAdmin.tsx`（`+244 −143`，改受控组件）、`src/client/components/PersonaPicker.tsx`（`+32 −52`）、`src/client/hooks/useWorkbenchAISessions.ts`（`+21 −0`，绑定前同一份 preflight 守卫）、`src/client/hooks/useWorkbenchDrafts.ts`（`+32 −1`）、`src/client/components/DraftBanner.tsx`（`+189 −22`）、`src/client/app/{assembly.ts,WorkbenchBody.tsx,WorkbenchOverlays.tsx,WorkbenchDialogs.tsx}`（合计 `+44 −4`，纯传参）、`test/personaWiring.test.mjs`（`+17 −4`，写入口径重定向 + 补"受控界面不许留第二份写入口"）、`tsconfig.build.json`（`+1 −0`）。18 个文件全部 CR=0、无 BOM、以 LF 结尾（逐字节统计）。客户端 `inject` 5 项与顶层 `inject` 4 项**逐字未变**；`package.json` / `pnpm-lock.yaml` / `src/client/styles.ts` / `SCHEMA_VERSION` / 迁移 / `src/experts/**` 未动。

### 15.4 独立证据（主会话亲自执行）

- **反向注入 6 处**（5 处子代理 + 1 处主会话自选，全部真红、还原后 SHA256 逐字节一致）：① 删 busy 守卫 → 37/1（AX-E52）；② `manifestHash` 换常量 → 37/1（AX-E54）；③ `create` 改复用 blank 会话 → 32/6（AX-E52 + 5 条 AX-E53）；④ auto 保存失败不回滚 → 37/1（AX-E57）；⑤ 版本冲突后自动确认新版本 → 37/1（AX-E55）；⑥ **主会话自选**：`src/client/hooks/useWorkbenchExperts.ts:579` 的 picker 第二道闸门改成 `return true` → `pnpm build` 0 但 `tests 38 / pass 37 / fail 1`（AX-E56「required 缺失的行：选择器不可选」），还原后 `build 0` + `38/38`，sha256 回到 `DEF610758C5882D2556F2744FB07AF5C6383609EDFBA8B9D2F757BABD044F6DD`。
- **diff 通读 + 逐条核对 38 个用例锚点**：14 个已跟踪文件 diff 全读，`test/expertClientFlow.test.mjs` 的 38 个行号逐条打开核对（每一行确实是所述行为的用例开头）。**未发现功能缺陷；本批没有修复轮，主会话未改动任何一行源码**。
- **真实宿主契约核对**：在 `C:\Users\<user>\.dsh\profiles\node_modules\@deepseek-ai\` 下读到 `ISessions.create(opts?: { workspaceId?; cwd?; sessionId? }): Promise<SessionId>`、失败抛 `SessionCreateError`、`SessionSummary.blank`、`uiWorkspace.openSession(target)` 均真实存在，与 `viewTypes.ts` 注释所述一致。

### 15.5 规格偏差、复核与修复

11 条逐条列在 `P8-handover.md` §7。前 10 条为施工方自报（确认走既有 `POST /drafts/:id/confirm` 而非计划里的 `/experts/.../confirm`；`api()` 不暴露状态码 ⇒ 409 靠重读草稿比对版本；真实 preflight 无 `reason`/`code`；`sessions.create` 按真实 d.ts 声明为可选能力、缺能力不静默降级；工作区必须取带 id 的宿主快照；白名单外 4 个装配管道文件 + 1 个既有测试；`matchWorkspaceForCwd` 改最长前缀；"真值未定时禁用确认"标判断；"全仓 LF"任务书与实况不符）。

**第 11 条是主会话复核时新识别的**：设置页专家列表**不再有分组章节标题**——HEAD 的 `PersonaAdmin.tsx` 用 `groupPersonas(personaPickerList(...))` 渲染分组章节与计数（2026-10-01 用户反馈"层级不明显"后的设计），P8 版改成扁平行（行内显示 `来源｜分组｜登记来源`，另加状态标签与"来源与技能"折叠详情），分组顺序也不再受控。依据 `方案-v0.3.md:785` 只要求"列表展示名称、简介、分组、三级来源、状态、来源方式"，未要求章节，**故按规格不算偏差**；`PersonaPicker` 的分组章节仍保留（`personaPicker.ts:174`）。这是一次相对 HEAD 的可见布局变化，且本批无浏览器验证 ⇒ P9 真机视觉核对项（`P8-handover.md` §9-9）。

**一处观察，未改**：`src/client/index.tsx:711` 的 `if (sessionId === null) return ''` 在 `currentSessionIdOf(runtime): string` 下是恒假分支（`strict: true` 下 TS 也未报错，下一行 `?? ''` 已覆盖空串）；行为无害，按"只接线不改既有语义"未动它。

### 15.6 未验证项（如实标注，不填通过）

8 条见 `P8-handover.md` §8，核心是：**无真浏览器/GUI**（DOM 渲染、点击、弹窗视觉、真实 DOM 里的 `data-wb-expert-*` 取值只做源码级唯一性断言）；**无真实宿主**（`sessions.create` / `acquireSession` / `uiWorkspace.openSession` 全用假 runtime，`SessionCreateError` 的真实抛法未跑）；**无真实 LLM**（generation-start / validate / confirm 全用假 HTTP 响应）；**无真实安装落地**（journal / publication / 文件写入 / skill provider 生效属 P5–P6 覆盖）；**未起宿主点 `@` 菜单与 `/expert`**（P7 遗留）；**auto 开关对自主召唤行为的真实影响未验**（只验了值写对与失败回滚）；**未重启实例**；**macOS/Linux 未测**。

## 16. P9 施工记录：出口批次（真实打包产物 / 独立宿主 / 真实 HTTP 与浏览器）

### 16.1 交付物（**未提交、未 push**；只碰 3 个验证脚本 + 3 个文档）

| 文件 | 状态 | 行数 | sha256（大写） |
|---|---|---|---|
| `scripts/verify/suites/expert.mjs` | 新增 | 1115 | `C569DFAC6BBB416FA2B7AF3BC35F80871167225B9911C44A428A7B97E7F5E65D` |
| `scripts/verify/suites.json` | 修改（`+14 −0`） | 221 | `A75345861925F21238803EB69D69D8757FD4A08D0B23D335C2CA0537F67AD48F` |
| `scripts/verify/suites/progress.mjs` | 修改（`+53 −1`，**只加诊断**） | 341 | `A8FCF8299A2B53228237776DAE71DE9C69E997393EFD51E08C6CEFD1972BFAC6` |

三个文件全部 `CRLF=0`、无 BOM、LF 结尾。**没有改**：`src/**`、`test/**`、`package.json`、`pnpm-lock.yaml`、
`scripts/dev-verify.mjs`、`scripts/verify/runtime.mjs`、`scripts/verify/suites/_harness.mjs`、`docs/adr/**`
（`0009-*.md` 仍为 **proposed**）。

### 16.2 套件分层与 AX 覆盖

`expert` 已登记进 `scripts/verify/suites.json`（`active` + `required:true` + `axIds:["AX-E59","AX-E60","AX-E61","AX-E62"]`，列表**末位**）。

- **U 层（包与静态）**：AX-E59 —— 本次 tgz 的条目清单、包内版本、该有的都有（方法论 / `lib/experts/**` 24 个 / `lib/**` 280 个 / personas 15 篇 / 3 份许可）、不该有的都没有（`.pending`/`test`/`test-results`/`_local-build`/`_local-archive`/`browser-temp`/`src`/`*.log`）、300 个文本条目的绝对路径与 UNC 泄漏扫描 0 命中。
- **H 层（真实 HTTP + 跨进程 DB 真值）**：AX-E60 的草稿生命周期（capabilities / methodology / generation-start / drafts 读回 / **直读 `task_drafts` 证明 pending 且正式库零新增** / abandon 带版本 CAS）；AX-E61 的 preflight + manual-requests（200 建请求 / 身份不符 **400 `revision-changed` + `expected_source_key`**）；AX-E54/E55 的 validate（真跑 + 过期版本 **409**）；AX-E56 的 catalog 形状。
- **B 层（真实浏览器 DOM 与点击）**：AX-E52（`create` 入口 → 真实点开 `create-modal` → 空文本禁用 → **清空工作区**后禁用且出 `data-wb-expert-error="no-workspace"` → 选回解禁）、AX-E54（无「创建任务」假文案）、AX-E56（`data-wb-experts="admin"` 可见 + 15 行都带 `data-wb-expert-id`/`status`）、AX-E57（auto 开关字段）、AX-E58（点弹窗自己的「取消」→ DOM 卸载但管理根与 catalog 状态仍在）。7 张截图证据在 `<runId>/suite-expert/`。
- **模型层**：AX-E60（模型落库那一半）/ AX-E61（子代理 loader + 父绑定不变）/ AX-E62（自主召唤开关因果）**如实 skip**。

### 16.3 独立实例证据（真实链，退出码 1）

最终一次链（**去掉 `--dry-run`**，实参见 §6 的三段命令）：证据包
`test-results/workbench-verify/20261005-212614-a85655/`（195798ms，11 份 `suite-*.json`）。

- health：**`版本 1.16.5 / buildId wb-8181274a3900fe0b / schema 19`**；`buildIdentity` 三方一致、`matched:true`、`mismatches:[]`。
- 每套件：verify-safety 20/0/0、legacy-acceptance 18/0/0、legacy-final-2 9/0/0、legacy-sidebar-collapse 6/0/0、legacy-duplicate-task 11/0/0、progress 13/0/0、daily-effort 13/0/0、day-panel 11/0/0、workspace-picker 8/0/0、persona 12/0/1、**expert 29/0/3**。
- `sideEffects`：`{"installed":true,"restarted":true,"dbWrites":0,"browsersOpened":0,"tempDirsRemoved":1}`。
- **退出码 1 的唯一原因**逐字：`必需套件 expert 有 3 项被跳过且未登记：AX-E60…｜AX-E61…｜AX-E62…`（`scripts/dev-verify.mjs:455-494` 的 required-skip 规则；`ALLOWED_REQUIRED_SKIPS` 在 `:74-80`，当前只有 persona 一条）。**按 P9 第 1 条「不许新增隐式 skip 白名单」刻意不登记**。
- 同一条链的另一轮（`…/20261005-212017-46dbe5/`，模型层口径修正前）逐套件计数**逐条相同**；另有 **2 次**在 `legacy-acceptance` 被浏览器层掐断（`…/20261005-211823-3cc7dc/`：45s 内没渲染出侧栏入口；`…/20261005-212429-c6d805/`：`Page.captureScreenshot` 30s 超时），单跑该套件立刻 18/18 ⇒ 与本批无关的冷启动竞态，已列未验证项。

### 16.4 包清单核验（逐字计数）

`_local-build/dsh-personal-workbench-dev-a327aa8-20261005-212021.tgz`，**2648241 字节 / 311 条目**，包内版本 `1.16.5`。
三次链打出的 tgz 字节数完全一致（2648241）⇒ 打包是输入决定的。该有的：方法论 `assets/expert-generation/methodology.md`、`lib/experts/**` **24**、`lib/**` **280**、personas **15**、许可 **3**；不该有的：`.pending`/`test`/`test-results`/`_local-build`/`_local-archive`/`browser-temp`/`src`/`*.log` **全部 0**；泄漏扫描 **300 个文本条目、0 命中**。

### 16.5 规格偏差、复核与修复

- **本批修的全是"我的断言错"**（4 轮）：`draft.id`→`draftId`；manual-requests 身份不符 **400** 不是 409；点「设置」要限定 `.wb-h button`（全局文案匹配命中了宿主侧栏的设置）；「填了文本仍禁用」在真机假红（工作区下拉初值非空）⇒ 改三步判。
- **一条我自己造成的跨套件污染（已修）**：`POST /api/workbench/drafts/:id/abandon` **必须带 body**（`src/api/routes/drafts.ts:291-346`：无 body → 400 `invalid-json`，缺 `expectedVersion` → 400 `invalid-payload`），旧写法恒 400 ⇒ 专家草稿永远 pending ⇒ `DraftBanner`（`DraftBanner.tsx:669`，5 秒轮询）弹出「待确认：新建专家」盖住**同一条链后面** `progress` 套件的进度卡（偶发 2 条假红；诊断 `preClick.hitAtCenter="HEADER:待确认：新建专家"`、`hitIsTheButton:false`；截图 `%TEMP%\p9-flake1-evidence\suite-progress\03-详情-点25后.png`）。修法：带 `{expectedVersion}` + 判据「200 且 DB 复读已不是 pending 且正式库零新增」+ `finally` 安全网。修完 `progress` 13/13。
- **模型层口径修正**：第一版用 `DSH_VERIFY_EXPERT_MODEL !== '1'` 直接返回"未开启" ⇒ 等于用环境变量把必需套件的关键层**静默关掉**（P9 明令禁止隐式 skip 白名单）。已改为**默认就去尝试**，只有"没给目标 profile / 找不到 dsh bin"才提前返回；最终链证据里因此留下了真机结论（见 16.6）。
- **`progress.mjs` 的 `+53 −1` 全是诊断字段**（`report.after25`），判定与阈值未改。
- **反向注入**：本批**没有**做产品源码的反向注入（没改产品代码），真红来自"断言口径写错时链真的红"（§16.5 第 1 条与跨套件污染那条都是先真红再修的）。

### 16.6 未验证项（如实标注，一律不算通过）

1. **真实模型链路**：最终链里套件默认执行了 spawn，真机结论逐字 —— `probed[0]={"kind":"dsh headless","profile":"web","code":1,"stdoutBytes":0,"stderrTail":"error: unknown option '--json'\n"}`，`reason`：「本机没有可用的 web-profile headless 入口（退出码 1；stderr: error: unknown option '--json'）：`headless` 在本机 DSH 里是 profile 名而非 web profile 的子命令，真实模型链路需走目标实例自己的会话 API，本次未实现」。证据：`<runId>/suite-expert/model-run-stderr.txt`（31 字节）、`model-run-stdout.txt`（0 字节）。⇒ 结论按施工计划第 9 条：**实现检查通过、模型链路未验证**。
2. AX-E53 五条失败路径在**真实链**上未跑（P8 注入式单测覆盖）。
3. auto 开关对真实自主召唤行为的**因果**未验（只验了渲染与语义）。
4. 生成内容质量（原创专家人格正文是否可用）未验。
5. 卸载/重装/升级路径、macOS/Linux 未测。
6. 链的稳定性：4 次真实链里 2 次被浏览器冷启动竞态掐断（§16.3），未定位确定性根因。

---

## 17. P10 施工记录（模型层三项：从 skip 改成真实会话通道的真检查）

> 本批**只改 `scripts/verify/suites/expert.mjs` + 文档**，未改任何产品源码（`src/**` / `test/**` / `package.json` 一行未动）。
> 详细交接（机制、证据位置、后续义务）见同目录 `P10-handover.md`。**§17 不重复 §16 的结论，也不改 §16 的措辞。**

### 17.1 任务口径（用户已确认，逐条照办）

1. 「生成专家」的通道**不是**插件直接调 LLM，而是：插件客户端新建一个**独立 DSH 会话**，把请求当普通用户消息发进去，
   该会话自己的 AI 再调用插件注册的 5 个草稿工具完成生成。证据位置：`src/client/hooks/useWorkbenchExperts.ts:746`
   （`sessions.create({ workspaceId })`）、`:789-792`（`session.prompt([...], 'queue')`）、`:630-645`（prompt 构造）、
   `src/experts/tools.ts:559-576`（5 个生成工具）、`src/index.ts:555`（装配）。**用户明确要求这条通道保持现状。**
2. 因此模型层验收**必须通过真实 DSH 会话**完成：**禁止**换假 provider、**禁止**伪造模型响应、**禁止**新增隐式 skip 白名单。
3. 本批把 P9 在 `scripts/verify/suites/expert.mjs` 里写成 skip 的 3 条模型层断言（原 `:1037` / `:1044` / `:1051`）换成真跑，
   AX id 原样保留（AX-E60 / AX-E61 / AX-E62），层名按 P9 既有口径记 `B`。
4. 任一步骤若因环境或宿主行为**无法确定性完成**：写 `skip` + **具体阻塞原因 + 收集到的原始证据**，**绝不假通过**，
   也**不往** `scripts/dev-verify.mjs` 的 `ALLOWED_REQUIRED_SKIPS` 加白名单。

### 17.2 交付物（**未提交、未 push**）

| 文件 | 行数 / sha256（P10 收工时） | 改动 |
|---|---|---|
| `scripts/verify/suites/expert.mjs` | 2055 行 / `8C3BD6D16D5705D10BE4FCF19F55150970AC5609D5E84089B89B93164C0AFDD0`（`git diff --numstat` = `+1054 −114`，CR 字节 0） | 3 条模型层 skip → 真检查；新增会话 JSONL 读取 / 草稿行复读 / 正式库反查 / 真实 composer 派发 / 冷启动换会话 |
| `docs/tasks/51189a57-…/P10-handover.md` | 274 行（新增） | 本批交接（机制、逐条结果、命令与退出码、偏差、未验证项、后续义务） |
| `docs/tasks/51189a57-…/verification.md` | 追加 §17 | 本记录 |
| `docs/tasks/51189a57-…/P9-handover.md` | 只在末尾追加 §13（`+16 −0`） | 只指到 P10，不动既有内容 |
| `docs/tasks/ed644638-…/执行日志.md` | 追加「P10 过程事实」段 | 过程事实 |

**未改**（按边界）：`acceptance.md`、`implementation-plan.md`、`src/**`、`test/**`、`package.json`、`pnpm-lock.yaml`、`.github/**`、`docs/releases/**`、`docs/adr/**`。
工作区里 `acceptance.md` / `implementation-plan.md` / `docs/design/2026-10-03-专家市场-调研.md` 的既有改动**来自其他会话**，本批未触碰。

### 17.3 施工内容（`scripts/verify/suites/expert.mjs`）

| 位置 | 改动 |
|---|---|
| 头部表 | 删掉「M 层（真实模型）… 未实现」，改成 **B 层**：「真浏览器走 UI 开生成会话 + 读会话 JSONL 判模型真调了哪些工具 + 目标库复读草稿行；拿不到就如实 skip + 原始证据」 |
| import | `+ node:crypto createHash`、`+ node:zlib zstdDecompressSync` |
| 删除 | 旧的 `tryObserveModelToolCalls()`（P9 那条 `dsh headless --json` 死路，实测 `error: unknown option '--json'`）与旧的三条 `skip` `checkModelLayer()` |
| 新增 | `MODEL_CALL_BUDGET = 6` + `modelCallsMade` / `modelCallLog`；`EXPERT_GENERATION_TOOL_NAMES`（5 个工具名**逐字副本**，刻意不 import 产品源码，好让口径漂移能独立变红） |
| 新增 | `sendModelMessage()`：真实点击 composer + `Input.insertText` + `Input.dispatchKeyEvent`(Enter)，记 `{label,sessionId,startedAt,typedPrefix,ok}` 并累计预算 |
| 新增 | `snapshotSessionDirs()` / `sessionDirOf()` / `readSessionEvents()`（**多帧 zstd 逐帧解压**）/ `sessionSummary()`（`cwd/parentSession/delegationDepth/titles/toolsOffered/toolCalls/toolResults/userMessages/frames`） |
| 新增 | `readPluginGenerationPrompt()`：从 `src/client/hooks/useWorkbenchExperts.ts` 抽 `buildExpertGenerationPrompt` 的**字面量**拼回同一份 prompt（要求恰好替换 2 处插值），只作 composer 兜底 |
| 新增 | `readExpertDraftRow()`（`node:sqlite` 只读打开 `--db-path` 读 `payload_json`）、`listPendingExpertDraftSessionIds()`、`readRecentExpertDraftRows()`、`sessionDirBySessionId()`、`expertInUserLibrary()`（递归查 `~/.dsh/workbench/personas`） |
| 新增 | `startGenerationViaUi()`（真浏览器四步，工作区按 `<option>` 的 `textContent` 归一化匹配、找不到就如实报 `no-matching-workspace`）、`runExpertGenerationProbe()`、`probeExpertMentionChannel()` |
| 关键实现 | **换会话 = 关掉当前浏览器实例 + 冷启动一个新实例**（`BROWSER_PATH`），再读 SPA 自己的 `localStorage['dsh.sessions.current']` 判定；同一实例里整页重载**不会**换（实测），`?session=` 对 SPA 也无效。`DSH_VERIFY_EXPERT_SWITCH_MS`（默认 300000）是这条循环的预算 |
| 关键实现 | 会话 JSONL 是**多帧 zstd 拼接**：`zstdDecompressSync` 只解第一帧，必须扫 `28 b5 2f fd` 偏移逐帧解压再拼（run 14 实测 30 帧 / 0 失败） |
| 关键实现 | 会话发现**以磁盘为准**（先按项目键 / `session` 事件 `cwd` 认目录，再用它的 id 去 DB 认草稿行）；项目键规则 = 路径里 `:` 直接删、`\` 与 `.` 换 `-`、两端加 `--` |
| 新判据 | `AX-E60-b`：生成会话 `request/header` 的 `tools[]` 里 5 个生成工具**逐个到位**；`AX-E61-a`：真实 HTTP catalog 有可引用专家 **且** 页面 composer 在位；`AX-E62-a`：`GET /experts/capabilities` 的 `autoSummon.{available,enabled}` 可读且是 boolean |

### 17.4 规格偏差（如实记录）

1. **AX-E60 走的是「真实 UI 开店 + 真实 composer 补发」**，不是「插件排队的那条 prompt 自己派发」。原因是一条**真机产品缺陷**（§17.5），
   详见 `P10-handover.md` §2.3。`report.layers.model.generation.findings.dispatchPath` 如实写 `plugin-queued` 或 `composer-fallback`
   （run 14 实测是 `composer-fallback`），两者在台账里**分开写**，不合并成一句「走真实会话通道」。
2. **换会话用「关浏览器 + 冷启动新实例」**：实测只有全新进程冷启动才会让 SPA 把 `dsh.sessions.current` 解析成最新那个会话
   （`?session=` 对 SPA 无效；工作台面板打开时 composer 不存在；侧栏列不出"还没有任何消息"的会话）。
   这是**用宿主自己的状态**判定，没有伪造任何模型输出，也没有新增 skip 白名单。
3. 模型层 AX id 从 3 条扩到 6 条（`AX-E60`、`AX-E60-b`、`AX-E61-a`、`AX-E61`、`AX-E62-a`、`AX-E62` 各自独立可失败），原 id 与语义未变，只是把"通道前置"单列成会真红的项。
4. AX-E61 / AX-E62 的端到端模型后半**仍记 skip**，阻塞原因是**真实模型调用预算**（≤6 次，本批累计 5 次，见 §17.6），不是"环境不具备"。

### 17.5 P10 实测发现的**产品缺陷**（本批只记录，边界内不许改产品代码）

**现象**：真浏览器走完「新建专家 → 填请求 → 选工作区 → 点开始生成」后：

- 宿主**确实**新建了独立会话；服务端**确实**建出 `task_drafts` 行（`kind_code='expert'`、`status_code='pending'`、`session_id` = 那个新会话）；
- 但页面报 `data-wb-expert-error="generation-start-failed"`（「服务端没有返回草稿，已停止…」）；
- 那个生成会话的 JSONL **永远只有 4 条事件**（`session` / `permission/preset` / `sandbox/mode` / `approval/policy`），
  一条 `user/message` 都没有 —— 前端在第 7 步就 return，第 8 步 `session.prompt([...], 'queue')`（`useWorkbenchExperts.ts:789-792`）**根本不执行**。

**根因（真实 HTTP 复现，非推断）**：`POST /api/workbench/experts/generation-start` 的真实响应是

```json
{"ok":true,"draft":{"draftId":"d051b42d-…","statusCode":"pending","contentVersion":0,"phase":"editing","expertId":"generated/534363a4-…","request":"P10 形状探针（可放弃）","personaMd":"","provenance":null,"skills":[],"files":[],"validation":null}}
```

服务端 `expertDraftView()` 给的是 **`draftId`**（`lib/experts/drafts.js:1083-1098`；路由 `lib/api/routes/experts.js:42-52`），
前端读的是 **`res.draft.id`**（`lib/client/hooks/useWorkbenchExperts.js:549-551`）⇒ `typeof draft.id !== 'string'` ⇒ 提前 return。

**P9 交接 §11 第 1 条记录过一次同源修正（"`draft.id` → `draftId`"），但那一处修的是套件断言，产品侧这条路径没有修。**

**影响**：走 UI 的「新建专家 → 开始生成」永远无法让模型真的开跑（草稿只能手动打开生成会话再补发消息）。
本批按"如实记录 + 绕过去取证"处理，**未改产品代码**。

### 17.6 真实模型调用台账（上限 6 次）

> `report.layers.model.calls` 里逐条记 `{label, sessionId, startedAt, typedPrefix, ok}`；下表是汇总口径。

| # | 用途 | 会话 | 发起方式 | 结果 |
|---|---|---|---|---|
| 1 | P10 侦察：手工 composer 发 `回复就绪`（**不是**本批套件调用，用于验证通道可用） | `session-cf3547c1-683d-4f4d-9549-8e1cb5745380` | 真浏览器 `Input.insertText` + Enter | 成功（14:06:40 建会话 → 14:13:39 跑完；`request/header` 58 个工具含 5 个生成工具） |
| 2 | P10 派发探针：打开生成会话 → 静置 90s → 真实 composer 发一条短消息 | `session-2d5b4da8-31f9-4d84-acbf-78dfca0912fe` | 真浏览器 `Input.insertText` + Enter | 成功：**+20s 就 `turn/start`**，23 事件、`request/header` 57 个工具（证明"通道可用，只是新会话要先被认领"） |
| 3 | run 7 的 composer 兜底（换会话还没摸清，发岔了） | `session-a7ec0626-f46b-40cf-ac37-3b36fca998d5` | 真浏览器 composer | 成功：该会话收到 4280 字符插件 prompt 并调 `workbench_get_expert_draft` |
| 4 | run 9 的 composer 兜底（同样发岔） | `session-f4d437a3-00cc-4b73-8fd4-7b438d32e2a0` | 真浏览器 composer | 成功：`get` → `submit`×3 → `validate`（0 错 0 警）→ `render_ui` |
| 5 | **run 14 的 composer 兜底（发进被追踪的会话）** | `session-8c32e4b8-e9c6-4a41-ad1d-f5a792e143b9` | 真浏览器 composer（冷启动换会话后） | 成功：**AX-E60 / AX-E60-b 转绿**；本层记账 `1 次 / 上限 6`，本批累计 5 次 |

> 第 3、4 次的"发岔"发生在换会话机制摸清之前 —— 它们其实已经**真实验证了生成通道端到端可用**，
> 只是当时套件追踪的是另一个会话，所以判成 `toolCalls:[]`。


本批套件自身**最多**会发起 1 次真实调用（AX-E60 的生成 prompt，composer 兜底那条），run 14 实测记账 `1 次`；
`AX-E61` 端到端还需 ≥3 次（父轮 + 子代理轮 + 复核父绑定轮），`AX-E62` 还需 2 轮 + 1 个子代理
⇒ 在本批 ≤6 次预算下**装不下**（本批累计已用 5 次），因此这两条的模型后半如实记 skip（原因写进 `skippedChecks`）。

### 17.7 命令与退出码（真跑）

| # | 命令 | 退出码 | 结果 |
|---|---|---|---|
| 1 | `node --check scripts/verify/suites/expert.mjs` | **0** | 语法通过 |
| 2 | `node scripts/check-verify-scripts.mjs` | **0** | 现役 11 / 待迁移 0 / 作废 3；`expert` 在册 |
| 3 | `node scripts/verify/suites/expert.mjs --url http://127.0.0.1:3080 --db-path 'C:\Users\<user>\.dsh\workbench\verify-web.db' --target-profile-dir 'C:\Users\<user>\.dsh\profiles\web' --evidence-dir "$env:TEMP\p10-suite-evidence"` | **1** | 第一次：30/35（failed 1 / skipped 4）。fail = `AX-E61-a`（**套件自身的形状读错**：只认 `body.entries`，而该端点真实形状是 `{ok,experts,personas,…}` ⇒ 15 位可引用专家被读成 0）。E60 的 skip 原因是**套件自身的门槛写错**：要求 `events > 4`，而宿主建出的会话只有 4 条握手事件 ⇒ 把产品缺陷误报成"没建会话"。两处都已修（§17.3），**不是环境问题** |
| 4 | 同上（`--evidence-dir "$env:TEMP\p10-suite-evidence4"`）…run 12 | **0** | 修完套件自身缺陷后：`31/35`（failed 0 / skipped 4）。E60 仍 skip：SPA 的 `dsh.sessions.current` 在 300s 整页重载里始终停在旧会话，消息**根本没发进被追踪的那个会话**（`toolCalls:[]` 是误判） |
| 5 | 同上（run 13） | **0** | 套件崩在 `afterReloadLoop` 变量名残留（`Cannot read properties of undefined (reading 'current')`）⇒ `28/28` 后中断。已修变量名 + 给换会话段加 try/catch 兜底（一条探针不再能打断整套件），并改成「关浏览器 + 冷启动新实例」 |
| 5b | 同上（**run 14，最终一次**，`--evidence-dir "$env:TEMP\p10-suite-evidence14"`） | **0** | **`{"passed":33,"failed":0,"skipped":2,"total":35}`** —— **AX-E60 与 AX-E60-b 转绿**（真实会话 + 真实工具调用 + 草稿 `contentVersion=1`/`phase=validated` + 确认前正式角色库为空），skip 只剩 `AX-E61` / `AX-E62` |
| 6 | `pnpm test` | **0** | `tests 1289 / pass 1289 / fail 0 / skipped 0`，`duration_ms ≈ 11998`（含 `pnpm build`，buildId `wb-8181274a3900fe0b`） |
| 7 | `node scripts/dev-verify.mjs …`（去掉 `--dry-run`） | **未跑** | 见 §17.8 第 3 条：它会 `dev-install` 重装冻结副本 + `restartTarget` 重启 3080，本轮以「已冻结装盘副本 + 单跑套件」取得 AX-E60 真证据，故不做重装/重启 |

**AX 逐条（run 14）**：`AX-E60` pass（会话 `session-8c32e4b8-e9c6-4a41-ad1d-f5a792e143b9`，53 事件 / 30 帧 / 0 解压失败；
工具调用 `workbench_get_expert_draft` → `workbench_search_knowledge` → `workbench_submit_expert_draft`×3 → `workbench_validate_expert_draft`；
草稿行 `e7162d58-4af4-4c33-8729-3206d43876a9`，`contentVersion=1`、`phase="validated"`、`provenanceKind="original"`、
validation `errors[] / warnings[]`）· `AX-E60-b` pass（`request/header` 实测 57 个工具，5 个生成工具逐个在位）·
`AX-E61-a` pass（catalog 200 / 15 位可引用内置角色 + composer 在位）· `AX-E62-a` pass（`autoSummon.{available:true,enabled:false}`）·
`AX-E61` / `AX-E62` skip（真实调用预算：本批累计 5 次 / 上限 6，明细见 §17.6 与 P10-handover §4.1）。

**规格偏差（P10 最终口径）**：① AX-E60 的 prompt 不是插件自己排进去的那条，而是逐字复刻后经**真实 composer** 发进**宿主本次真建出的会话**，
`findings.dispatchPath = composer-fallback`（产品缺陷见 §17.5）；② 换会话用「**关浏览器 + 冷启动新实例**」——
实测 `?session=` 对 SPA 无效、侧栏列不出"零消息"会话、同一实例整页重载不换会话，**只有全新进程冷启动**
才会把 `dsh.sessions.current` 解析成最新会话；这是用宿主自己的状态判定，没有伪造任何模型输出；
③ 只有"JSONL 真出现工具调用 + 草稿行真推进 + 确认前正式库真为空"三条同时成立才 pass，否则 skip + 具体原因。

**行尾（CRLF 陷阱）复核**：`git diff --numstat` 对 `scripts/verify/suites/expert.mjs` 是 **+1054 −114**（不是整文件翻倍），
文件内 **CR 字节数 = 0**（LF-only，与 `git show HEAD:` 版本同口径）。

### 17.8 未验证项与后续义务

1. **未跑**：`AX-E61` / `AX-E62` 的模型后半（预算已用尽：各至少还要 3 次 / 2 次真实调用）。
2. **未跑**：`node scripts/dev-verify.mjs`（去掉 `--dry-run`）—— 它会重装冻结副本并重启 3080 实例；
   本批以「已冻结装盘副本（`_local-build/dsh-personal-workbench-dev-a327aa8-20261005-212618.tgz`）+ 单跑套件」
   取得 AX-E60 真证据，故不做重装/重启。套件在真实链里的 `required` 语义（带未登记 skip 即不通过）未在链上复核，
   且**没有**动 `ALLOWED_REQUIRED_SKIPS`。
3. **产品缺陷未修**（`res.draft.id` → `draftId`，§17.5）：修掉后 `dispatchPath` 应变成 `plugin-queued`，
   套件里两条通道都保留着，届时不必改判据。
4. **未定论**：宿主"什么时候把新会话收录进会话列表"的节奏（本轮证据：冷启动会认领最新会话；
   run 14 在建会话后 ~1 分钟内即认领；更早几轮的滞后十几分钟未深挖）。
5. 每次真跑都会在目标库留 pending 专家草稿：套件 `finally` 的兜底 abandon 是**必要安全网**
   （run 14 实测 `收尾兜底放弃遗留草稿 e7162d58-…：HTTP 200`），别删。

## 18. P11 施工记录（产品缺陷修复 + 派发判据补强，真机复验通过）

P10 §17.5 只**记录**了产品缺陷（边界内不许改产品代码）。P11 由用户拍板修掉它，并把「提示词是产品发的」
从 AX-E60 里拆出来单独判。完整交接见 `P11-handover.md`。

### 18.1 缺陷与修复（P0 级：入口点了没反应）

- 根因（逐行）：`ExpertDraftView` 只有 `draftId` 没有 `id`（`src/experts/drafts.ts:156-168`，生产者
  `expertDraftView()` 见 `:1388-1403`）；路由把草稿嵌在 `draft` 下（`src/api/routes/experts.ts:84`，
  `preview`/`validate` 同形状 `:123-127`/`:134-139`）；客户端修前读 `res.draft` 后判
  `typeof draft.id !== 'string'` 并 `fail('generation-start-failed', …)` 提前 return
  （`src/client/hooks/useWorkbenchExperts.ts:767-775`）⇒ **第 9 步 `session.prompt([...], 'queue')` 永不执行**。
  同一根因还让 `validate` / `readLatestDraft` 读不出 payload 与 `contentVersion`（AX-E55 的 CAS 退化）。
- 修复（唯一产品代码改动，`src/client/hooks/useWorkbenchExperts.ts`）：新增
  `normalizeExpertDraftResponse(raw: unknown): DraftView | null`，两种形状都认（已带 `id`+`payload` 原样放行；
  否则按 `draftId` 平铺形状包成 `DraftView`；都不是返回 `null` 不猜），三处读取统一走它。
- 为什么 1289 条单测没抓到：`test/expertClientFlow.test.mjs` 的 `makeDraft()` 手搓的是通用工作台草稿（带 `id`），
  假响应与客户端自洽 ⇒ **真服务端形状从未被覆盖**（教训已沉淀进工作台知识库）。
- 测试改造：fixture 改为 `makeServerExpertDraftView()` = 产品真实的 `expertDraftView({…})` 产出；
  AX-E53/E54/E55 全部换真实平铺形状；新增 3 条 P11 用例（形状判定 / 平铺必须走到 `promptSent` / 版本冲突仍认得出）。
  用例 38 → 41。规格更正：`方案-v0.3.md` §4.1 三处响应形状 + §8 签名统一成 `ExpertDraftView`；
  另在 `acceptance.md` / `implementation-plan.md` 把「real LLM」措辞改成「真实会话通道」。

### 18.2 命令与退出码（主会话亲自跑，非只读子代理报告）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 干净 |
| `pnpm build` | 0 | client bundle `597.78 kB / gzip 177.41 kB` |
| `node --test test/expertClientFlow.test.mjs` | 0 | 41 pass / 0 fail |
| `pnpm test` | 0 | **tests 1292 / pass 1292 / fail 0**（P10 末 1289 + 3） |
| `node --check scripts/verify/suites/expert.mjs` | 0 | 语法 |
| `node scripts/check-verify-scripts.mjs` | 0 | 现役 11 / 待迁移 0（必需 0）/ 作废 3 / 本地 0 / 嫌疑 0 |
| 单跑 `expert.mjs`（3080，见 18.3） | **0** | `{"passed":34,"failed":0,"skipped":2,"total":36}` |

### 18.3 独立实例真机验收（3080，冻结副本已含修复）

- 证据目录 `test-results/workbench-verify/20261006-002551-p11/`（`run.log`、`suite-expert.json`、
  `suite-expert/{summary,expert-readings}.json`、`model-e60-{dispatch,draft-row,first-user-message,session}.json`、
  9 张截图）；目标 health `1.16.5 / wb-8181274a3900fe0b / schema 19`；包 = `current.txt` →
  `dsh-personal-workbench-dev-7dc60f9-20261006-001045.tgz`（2 649 920 字节 / 311 条目）。
- **修复确实在跑的包里**：装盘副本 `…\profiles\web\node_modules\@dely0\dsh-personal-workbench\lib\client.js`
  （597 782 字节，2026/10/6 0:10:50）里 generation-start 处是压缩后的
  `let n=ei((await e.call('/api/workbench/experts/generation-start',{…}))?.draft); if(n===null)return r('generation-start-failed',…)`，
  修前的 `typeof draft.id !== 'string'` 已不在（`ei` = 被压缩的 `normalizeExpertDraftResponse`）。
- **派发判据**：`dispatchPath = "plugin-queued"`、`dispatchWaitMs = 0`、`suiteModelCallsAtDetection = 0`、
  `manualResendBySuite = false`；第一条 user 消息 `seq 9 / chars 4280 / sha256 B7CA4460…35CA1`，
  正文即插件构造的 prompt（含「## 方法论（全文）」「## 用户的请求」「## 交付方式」）。
- **生成会话**：`session-095ffd03-88f3-4495-b7e6-3446767f47c9`（`cwd` = 仓库根、`parentSession` 空、
  `delegationDepth = 0`；49 事件 / 0 解压失败 / 4 条 `user/message`），模型 `deepseek-official/deepseek-flash`，
  工具序列 `workbench_get_expert_draft` → `workbench_search_knowledge` → `workbench_submit_expert_draft`×3 →
  `workbench_validate_expert_draft`。
- **目标库草稿行** `17121124-fb7d-44a3-a461-6bf7d9ee7dc1`：`session_id` = 上面那个会话、`status_code=pending`、
  `content_version=1`、`phase="validated"`、`expert_id=generated/7d4b7460-…`、`persona_chars=653`、
  `provenance_kind="original"`、validation `manifestHash 6b1bae6f…37e5`、`errors[]`/`warnings[]`；
  **确认前正式角色库 `rootExists:false`**。
- 包内容检查（AX-E59 全绿）：311 条目 / 版本 1.16.5 / 方法论在 / `lib/experts/**` 24 / `lib/**` 280 /
  personas 15 / 三份许可齐；不该有的全为 0；扫 300 个文本条目，本机路径命中 `[]`。

### 18.4 反向注入（修复必要性，第 8 处独立证据）

`useWorkbenchExperts.ts` 里 `const draftId = typeof record.draftId === 'string' ? record.draftId.trim() : ''`
改成 `const draftId = ''` ⇒ `pnpm build` **0**（编译不报错）但单测 **30 pass / 11 fail**
（3 条 P11 + AX-E52×2 + AX-E53×3 + AX-E54×1 + AX-E55×2）；还原后 build 0 / 41 pass，
文件 sha256 `41ECA9CFAE28882DF4DF57C61CA71DB17336794B0E08DA6424236B7ABDA05A88` **逐字节一致**。

### 18.5 AX 对账（本次单跑）

AX-E52 / E54 / E55 / E56 / E57 / E58 / E59 / E60（含新增的 `AX-E60 ⭐` 产品派发）/ AX-E60-b / AX-E61-a / AX-E62-a
**全部 pass**；仅 `AX-E61 ⭐ 模型链路` 与 `AX-E62 ⭐ 模型链路` 记 **skip（预算）**，`failedChecks` 为空。

### 18.6 未验证项（如实标注，不算通过）

1. `AX-E61` / `AX-E62` 的模型后半（真实调用预算）。
2. 全链 `node scripts/dev-verify.mjs`（去 `--dry-run`）**未重跑**（会重装冻结副本 + 重启 3080，需用户明确同意）；
   套件在链里的 `required` 语义未在链上复核，**没有**动 `ALLOWED_REQUIRED_SKIPS`。
3. **产品级反向注入未做**（要重装 + 重启才能把修前的包重新上机）；敏感度证据 = 18.4 的单测注入 + 新检查判据
   `dispatchPath === 'plugin-queued'`（一行纯函数，两个取值分别对应 P10 的 `composer-fallback` 与本次的 `plugin-queued`）。
4. 卸载/重装/升级路径、macOS/Linux、多生成会话并发时序未测。
5. 过程事实：本批先委派子代理 `1585ce8c-ee00-499b-9f12-320ae86bcbc4`，它做完 `build → pack → install → 重启 3080`
   与套件改动后在跑套件时挂掉、无收尾消息；主会话接手现场核查 + 亲自跑真机验收 + 写文档。

