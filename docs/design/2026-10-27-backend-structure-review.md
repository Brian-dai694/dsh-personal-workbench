# 后端结构梳理与重构方案（2026-10-27）

> 范围：`src/` 下**除 `src/client/` 之外**的全部源码（宿主侧 + 前后端共享层），共 **119 个文件 / 36,799 行**。
> 本文只描述"现在是什么形状、哪里在漏、按什么顺序收"，不改行为口径；业务口径见 `CONTEXT.md` 与 `docs/adr/`。

## 0. 结论速览

| # | 判断 | 证据 |
| --- | --- | --- |
| 1 | 分层是**目录约定**，不是**依赖约束** | 服务端 7 处 import `src/client/*`；api 层 7 处直写 SQL；db 子模块 17 处反向 import 门面形成环 |
| 2 | 数据访问没有单一收口 | `db.prepare(` 在 `src/db/` 内 206 处（应然），另在 13 个非仓储文件里 34 处（实然越层） |
| 3 | `shared/` 名不副实 | `shared/knowledgeRecall.ts` 反向依赖 `db/repo/knowledge.ts`，只能被宿主用，却和真正的共享类型同住一屋 |
| 4 | 装配入口在膨胀 | `src/index.ts` 548 行、22 个 import，承担 DB 降级、路由、工具、命令、提醒、专家、技能 provider、提示词 8 件事 |
| 5 | 构建清单是手工白名单 | `tsconfig.build.json` 逐条列 100 个文件；漏加 = 产物缺模块，且没有任何测试会红 |
| 6 | 基线原本是红的 | `src/client/styles.ts` 模板串里注释带反引号 → `tsc --noEmit` 4 个语法错；本次已修，现 **0 error** |

**一句话**：功能面已经闭环，问题集中在**边界没有被机制守住**——靠注释和人的记性维持分层。下一步不是重写，而是把 6 条边界变成可断言的规则，再按批次把越界处搬回去。

---

## 1. 运行链路（宿主侧）

```
dsh 加载插件
  └─ apply(ctx, config)                               src/index.ts:305
       ├─ openWorkbenchDb()                           src/db/database.ts:71
       │    └─ migrate(): 30 张表 / 34 个迁移版本      src/db/schema.ts
       ├─ 失败 → applyDegraded()：只注册一条 systemPrompt 告警，插件空转   index.ts:329
       └─ 成功 → applyReady()                        index.ts:378
            ├─ WechatChannelAdapter（软探测 dshIm）    reminder/adapter.ts
            ├─ ReminderScheduler（软探测 timer）       reminder/scheduler.ts
            ├─ installKnowledgeRecall()               knowledge-recall.ts
            ├─ createExpertService() + recover()      experts/service.ts
            ├─ makeRoutes(db, deps)                   api/routes.ts
            ├─ 注册 36 个 Agent 工具（+1 条件注册）     index.ts:542
            ├─ 专家自动召唤 effect（开关在库）          index.ts:591
            ├─ 技能 provider（ctx.inject(['skills'])） index.ts:631
            ├─ /workbench、/expert 命令                index.ts:683
            ├─ 提醒定时器（ctx.inject(['timer'])）      index.ts:696
            └─ 释放顺序：experts → db（逆序，有注释钉住） index.ts:711
```

四条横切约定（**真实事故换来的，不能碰**）：

1. **可选服务一律 `ctx.get()` 软探测**，绝不写进顶层 `inject`（写进去 = 缺依赖时整个插件 pending，已复发 3 次，见 `index.ts:56-68`）。
2. **数据库比插件新必须降级而不是抛错**（否则宿主起不来，2026-09-12 事故，见 `index.ts:317-350`）。
3. **同一语义只允许一处实现**：HTTP 围栏（`api/http.ts`）、耗时夹取（`api/routes/helpers.ts:42`）、计划日判定（`shared/dailyPlanPolicy.ts`）都由源码扫描测试钉住。
4. **写操作记事件**：`completeTaskCascade` / `setTaskProgress` / `withDraftConfirm` 等是唯一写入口。

---

## 2. 分层地图

| 层 | 目录 | 文件 | 行数 | 现在干什么 | 实际允许的依赖（照代码看） |
| --- | --- | --- | --- | --- | --- |
| 入口/装配 | `src/*.ts` | 8 | 4,743 | 插件装配、Agent 工具、知识召回、Amazon 工具、review-memory | 全部（含 `client/`） |
| HTTP | `src/api/` | 7+22 | 4,598 | 42 个 `/api/workbench/*` 端点 | 全部（含 `client/`、直写 SQL） |
| 仓储 | `src/db/` | 4+28 | 6,801 | schema/迁移、SQL、草稿确认事务 | `shared/`、`client/amazonTrafficTools`、`workspace-check` |
| 专家 | `src/experts/` | 12 | 10,460 | 草稿 → 校验 → 安装 → 调用 → 恢复（最大的一块） | `db/repo`、`personas/*`、`client/expertPrompt` |
| 角色 | `src/personas/` | 6 | 1,840 | 三级角色库解析、绑定、资源读取 | `db/repo`、`experts/paths`、`experts/provenance` |
| 提醒 | `src/reminder/` | 6 | 1,152 | 通道适配、策略、调度、草稿通知 | `db/repo`、直写 SQL |
| 共享 | `src/shared/` | 24 | 7,044 | 只有 20 个真正前后端共用；4 个只服务端用 | 其中 `knowledgeRecall` → `db/repo` |
| 工具库 | `src/lib/` | 2 | 161 | xlsx 读写、ABA 导出 | `db/repo`、`shared/` |
| 浏览器 | `src/client/` | 135 | 29,503 | UI + 若干"纯逻辑"（被服务端复用） | — |

**数字上的两个信号**

- `experts/` 12 个文件 10,460 行 = 后端最大单一子系统（占 28%），其中 `install.ts` 1,704 行、`drafts.ts` 1,239 行、`invocation.ts` 1,134 行。
- `db/repo/` 28 个文件 5,446 行 = 领域最多，但 `repo.ts` 门面 314 行里 ~180 个 re-export，成为**所有层次的中转站**。

---

## 3. 数据面

- **SCHEMA_VERSION = 34**，`MIGRATIONS` 34 段，全部 `up(db)` + 事务 + `meta.schema_version`（`db/database.ts:55`）。
- **30 张表**，按域分组：

| 域 | 表 |
| --- | --- |
| 元数据 | `meta` |
| 字典 | `dictionaries` |
| 任务 | `tasks` `task_events` `task_sessions` `task_reviews` `task_artifacts` `task_memories` `task_reminders` `task_drafts` |
| 计划/报告 | `daily_plans` `task_reports` |
| 提醒 | `reminder_queue` `draft_notify_queue` |
| 知识 | `knowledge_entries` `knowledge_recall_log` |
| 点子 | `ideas` `idea_clusters` `idea_links` |
| 会话 | `ai_session_registry` |
| 专家 | 复用 `task_drafts`（`kind_code = 'expert'`）+ `meta` 存开关；**没有独立的专家表** |
| Amazon | `amazon_datasets` `asin_products` `asin_snapshots` `asin_stores` `keyword_plans` `inventory_snapshots` `calculator_scenarios` `aba_keyword_sets` |
| 运营日志 | `oplog_entries` `oplog_types` |

- **JSON 列偏多**：`items_json` / `rows_json` / `annotations_json` / `payload_json` / `extra`。这是"每天一份快照"的合理选择，代价是**查询只能整份读**（`daily_plans` 全表扫已在迁移 30 里出现过一次）。
- 约束是真约束：`tasks.progress_percent` 有 `CHECK(0–99)`（ADR 0003/0004 的最后防线），`STRICT` 表 + `PRAGMA foreign_keys = ON`。

---

## 4. 接口面

**HTTP：42 个端点**，全部 loopback-only（`api/http.ts:28` 校验 remoteAddress + Host + sec-fetch-site + Origin）。

| 分组 | 端点文件 | 备注 |
| --- | --- | --- |
| 跨域 | `routes.ts`（health / bootstrap / settings / workspaces/ensure / maintenance） | settings 一个 handler 81 行，内联写 9 个 meta 键 |
| 任务域 | tasks / drafts / plans / reminders / reports / ai-sessions | 常规 |
| 内容域 | knowledge / knowledge-recall / ideas / idea-clusters | 常规 |
| 专家/角色 | experts / personas / dict / skills / model-modalities | 依赖注入式（`deps.experts` 未注入则整段不注册） |
| Amazon | amazon-datasets / asin / inventory / keyword-plans / calculator-scenarios / aba-keywords / oplog | v1.18 新增，体量已与任务域相当 |
| 文件 | quick-attachments / local-dir / open-file | `quick-attachments.ts` 432 行里含完整 PDF/DOCX 解析器 |

**AI 工具：36 个常驻 + 1 个条件注册（`summon_expert`）**

| 组 | 数量 | 落点 |
| --- | --- | --- |
| 任务/计划/报告/知识/点子/记忆 | 14 | `src/tools.ts`（1,177 行） |
| Amazon 计算与报表读写 | 12 | `src/amazon-tools.ts`（637 行） |
| 专家生成（草稿五步） | 5 | `experts/tools.ts` |
| 专家调用 | 3 | `experts/tools.ts` |
| 知识召回 | 2 | `knowledge-tools.ts` |

工具返回中文 `error` 而不抛异常（宿主把异常当崩溃），`enumHint()` 会把合法枚举回给模型——这条比多数插件做得好，重构时不要顺手改掉。

---

## 5. 问题清单（按修复价值排序）

### P0-1 基线不可验证：typecheck 红

`src/client/styles.ts` 是模板字符串，注释里写了反引号（`--wb-state-business-primary` / `--wb-line*` 等），提前闭合字面量：

```
styles.ts(784,11): TS1005 ',' expected
styles.ts(793,32): TS1005 ';' expected
```

文件自己第 776 行就写着"注释中**不能出现反引号**"——规则存在，但没有机制执行。
**本次已修**（去掉注释里的反引号），`tsc --noEmit` 现为 **EXIT=0**。
后续建议：加 `test/styleLiteral.test.mjs`，扫描 `styles.ts` 模板串内是否出现反引号。

### P0-2 服务端反向依赖浏览器目录（7 处 / 5 文件）

| 服务端文件 | import | 目标模块实际依赖 |
| --- | --- | --- |
| `index.ts:32` | `client/taskFolder` | `client/format`、`client/workspacePath` |
| `experts/command.ts:35` | `client/expertPrompt` | 无 |
| `amazon-tools.ts:?` | `client/amazonCalculator` | `shared/calculatorScenario` |
| `amazon-tools.ts:?` | `client/amazonTrafficTools` | `shared/trafficFilter`、`keywordAggregate`、`keywordDecision` |
| `amazon-tools.ts:?` | `client/amazonKeywordTools` | 无 |
| `db/repo/amazonDatasets.ts:13` | `client/amazonTrafficTools` | 同上 |
| `api/routes/amazon-datasets.ts:13` | `client/amazonTrafficTools` | 同上 |

后果不是"能跑但不优雅"，而是**构建契约被绕过**：`tsconfig.build.json` 逐条列出这些 client 文件才能编译进宿主产物；一旦有人给 `client/format.ts` 加一个 `window.` 调用，宿主侧会在运行时炸，而 typecheck 不会红。
**修法**：把这 5 个模块搬到 `src/shared/`（它们已经是纯逻辑），服务端改 import；client 侧同步改。之后加测试断言"非 client 目录不得 import client/"。

### P0-3 仓储门面反向 import 形成 17 处环

`db/repo.ts` re-export 28 个子模块；其中 **17 个子模块**又 `import ... from '../repo.js'`（`ai-sessions` `dictionaries` `ideas` `drafts` `knowledge` `persona-bindings` `plans` `progress` `recurring` `reminders` `reminder-queue` `status` `reports` `tasks` `task-primitives` `task-sessions` `task-memory`）。

现在能跑，是因为 ESM 循环里**只调函数、不在模块求值期取用**。任何一次"在顶层算个常量"就会拿到 `undefined`，且报错位置与被改文件无关——这类 bug 平均要花几小时定位。
**修法**：把 `nowIso` / `localDateString` 移到 `db/clock.ts`，行/输入类型移到 `db/types.ts`，子模块改 import 具体模块；门面只 re-export。之后加测试扫描 `db/repo/*` 不得出现 `'../repo.js'`。

### P1-1 api 层越层直写 SQL（7 处）

| 位置 | 内容 |
| --- | --- |
| `api/routes/helpers.ts:153` | `SELECT * FROM task_events ...` |
| `api/routes/drafts.ts:243,283` | 直接 `UPDATE task_drafts SET status_code='confirmed'` |
| `api/routes/asin.ts:192` | `SELECT * FROM asin_products` |
| `api/routes/plans.ts:44` | `SELECT id, status_code, archived FROM tasks` |
| `api/routes/reminders.ts:101` | `SELECT id FROM task_reminders` |
| `api/routes.ts:447` | `SELECT value FROM meta ... schema_version` |

真正危险的是 `drafts.ts` 的两条 UPDATE：它绕过 `setDraftStatus()`，而后者是"确认草稿"唯一带事件/时间戳的写入口。今天两者等价，明天加个副作用就开始分叉。
同类越层还有：`reminder/`（14 处）、`tools.ts`（1 处）、`knowledge-recall*.ts`（10 处）、`review-memory.ts`（2 处）。

### P1-2 `shared/` 里混进只能服务端用的模块

`shared/knowledgeRecall.ts` import `db/repo/knowledge.js`。它和 `shared/contracts.ts`（纯类型、明确禁止运行时依赖）住在同一层，语义相反。
client 侧目前没有 import 它（已验证），所以是隐患而非故障。
**修法**：`shared/` 只留"零 node 依赖的纯类型/纯函数"。实测：24 个模块里 client 用 20 个、服务端用 21 个，**交集只有 17 个**；仅服务端的 4 个是 `asinExport` / `asinImport` / `knowledgeRecall` / `oplogImport`，仅 client 的 3 个是 `adReport` / `paymentReconciliation` / `trafficFilter`——这 3 个其实也该被服务端复用（Amazon 报表解析），说明这层现在既宽又偏。

### P1-3 装配入口承担 8 件事

`src/index.ts` 548 行：54 行 `WORKBENCH_GUIDANCE` 常量、`applyDegraded`、`applyReady` 里依次装配 8 个子系统、两个命令注册函数、`workbenchCommandDefinition` 的 handler 本体。
**修法**：拆 `plugin/prompt.ts`（提示词常量）、`plugin/commands.ts`（两个命令）、`plugin/apply.ts`（装配顺序）。`apply` 保持一行调用，便于测试直接驱动。

### P1-4 settings 是"巨型内联 handler"

`api/routes.ts:250-331`：GET 用 `readWorkbenchSettings()`（已收口，好），POST 在 handler 里逐字段 `typeof` 判断 + 9 次 `writeMeta` + 3 个域设置写入口混排，还转发给 `deps.knowledgeRecall` / `deps.experts`。
**修法**：POST body → `SettingsPatch` 解析（一个函数，返回 `{patch, errors}`）→ `applySettings(db, patch)`；跨服务通知留在 handler 一行。

### P2-1 `tsconfig.build.json` 是手工白名单

100 条 include，混着宿主与 client。漏加一个文件 = 产物缺模块（`lib/` 里没有），只在运行时暴露。
**修法**：改成 `include: ["src/**/*.ts", "src/**/*.tsx"]` + `exclude` 掉不需要的；或至少加一条测试：`src/` 下每个 `.ts` 都在产物里。

### P2-2 同一语义的两份实现（靠测试钉住，仍值得收）

| 语义 | 宿主侧 | client 侧 | 现状 |
| --- | --- | --- | --- |
| 耗时夹取 | `helpers.ts:42` `clampEstimateForStorage` | `client/capacity.ts#clampEstimatedMinutes` | 测试断言等价 |
| 默认耗时 | `routes.ts:93` 30 分钟 | `client/capacity.ts` | 测试断言同值 |
| 计划日判定 | `shared/dailyPlanPolicy.ts` | 同 | 已共享（好） |

前两条在"两份实现 + 一条等价断言"里算合理；真正该盯的是**新增同类逻辑时是否又写了一份**。

### P2-3 单文件体量

后端 Top 8：`experts/install.ts` 1,704 → `knowledge-recall.ts` 1,423 → `experts/drafts.ts` 1,239 → `shared/dailyPlanPolicy.ts` 1,203 → `experts/invocation.ts` 1,134 → `tools.ts` 1,177 → `experts/service.ts` 1,046 → `shared/knowledgeRecall.ts` 1,007（行号含大量设计注释，实际代码比行数少）。
不追求"每个文件 300 行"，但这几个里 `install.ts` / `invocation.ts` / `knowledge-recall.ts` 已有明确的子职责可切（文件系统安装 vs 校验 vs 恢复；子代理生命周期 vs 人格加载；检索 vs 注入 vs 观测）。

---

## 6. 目标结构

原则：**目录 = 依赖方向的声明**，能被一条测试断言。

```
src/
├─ index.ts                 仅 apply(ctx, config)
├─ plugin/
│   ├─ apply.ts             正常装配顺序
│   ├─ degrade.ts           降级空转
│   ├─ routes-registry.ts   路由组合（make* 汇总）
│   ├─ tools-registry.ts    工具注册清单
│   ├─ commands.ts          /workbench、/expert
│   └─ prompt.ts            WORKBENCH_GUIDANCE 等常量
├─ api/
│   ├─ http.ts              唯一围栏
│   ├─ dto/                 请求体解析与校验（纯函数）
│   └─ routes/              一域一文件（保持现状）
├─ domain/                  领域服务：tasks / plans / reminders / knowledge
│   │                       experts / personas / amazon
│   └─ <- 允许依赖 db、shared、core；禁止依赖 api
├─ db/
│   ├─ schema.ts database.ts seed.ts
│   ├─ types.ts             行/输入类型（从 repo.ts 抽出）
│   ├─ clock.ts             nowIso / localDateString（断开环的关键）
│   └─ repo/                纯 SQL，一域一文件；禁止 import '../repo.js'
├─ core/                    paths / ids / 无状态工具
├─ shared/                  仅前后端共享的纯类型与纯函数（零 node 依赖）
└─ client/                  仅浏览器（可 import shared，禁止反向）
```

依赖规则（每条一条测试）：

1. `db/repo/*` 不得 import `../repo.js`、`api/`、`domain/`、`client/`。
2. `api/**` 不得出现 `db.prepare(`。
3. 非 `client/` 目录不得 import `client/`。
4. `shared/**` 不得 import `node:*`、`db/`、`api/`、`domain/`、`client/`。
5. `client/**` 不得 import `domain/`、`api/`、`db/`。

---

## 7. 迁移批次（每批独立可回滚）

| 批次 | 内容 | 改动面 | 验证 |
| --- | --- | --- | --- |
| 0 | 修 `styles.ts` 反引号（**已完成**）；把当前 114 个未提交改动打成一次 WIP 提交，建立可回滚点 | 1 文件 | `tsc --noEmit` = 0 error |
| 1 | 拆 `src/` 根目录：`knowledge/`（recall + tools + log）、`agent-tools/`（tools + amazon-tools）、`memory/`（review-memory）；只改 import | 8 → 3 目录 | tsc + 全量测试 |
| 2 | 断环：新增 `db/clock.ts` + `db/types.ts`，17 个子模块改 import；`repo.ts` 只 re-export | 19 文件 | tsc + `db*`/`progress*`/`draft*` 测试 |
| 3 | 纯逻辑下沉：`client/{amazonCalculator,amazonTrafficTools,amazonKeywordTools,taskFolder,expertPrompt}` → `shared/`（`taskFolder` 连同 `format`/`workspacePath` 的纯函数部分），服务端改 import | 5 移 + ~15 引用 | tsc + `amazonTools` / `taskFolder` 测试 + 规则 3 断言 |
| 4 | SQL 收回仓储：api 6 处、reminder 14 处、`tools.ts` 1 处、`knowledge-recall*` 10 处、`review-memory` 2 处 | ~10 文件 | tsc + 相关域测试 + 规则 2 断言 |
| 5 | 装配瘦身：`plugin/*` 拆分；settings → `dto/settings.ts` + `domain/settings.ts`；`quick-attachments` 解析器 → `lib/document-extract.ts` | 4 新 + 3 改 | tsc + `pluginEntry` / `routes` / `quickAttachments` 测试 |
| 6 | 加护栏：`test/architecture.test.mjs`（上面 5 条规则）+ `test/styleLiteral.test.mjs`；`tsconfig.build.json` 改 glob（或加覆盖测试） | 2 新 + 1 改 | 全量测试 |

**每批的固定动作**：`node node_modules/typescript/bin/tsc --noEmit` → `pnpm build` → `node --test --test-concurrency=1 test/*.test.mjs`。任一步红就停，不叠下一批。

**批次 2 的顺序要求**：`db/clock.ts` 必须先建、先替换所有 `nowIso` 引用，再动类型；否则中途会同时存在两个 `nowIso` 导出。

---

## 8. 需要拍板的点

1. **工作树现状**：36 个已修改 + 78 个未跟踪文件（v1.18 Amazon 页仍在进行）。重构前是否先提交一次 WIP？不提交则任何搬迁都无法用 `git diff` 复核。
2. **批次范围**：只做 1–3（纯结构，零行为变化），还是连 4–5（动 SQL 与装配）一起做？
3. **`shared/` 命名**：保持 `shared/` 承载"共享纯逻辑"，另设 `domain/` 承载服务端领域服务——还是把服务端服务继续留在根目录、只加规则？
4. **`experts/` 是否一并拆**：它是最大子系统（10,460 行），但拆它需要先读 ADR 0009 与交接文档，属于独立一轮。
