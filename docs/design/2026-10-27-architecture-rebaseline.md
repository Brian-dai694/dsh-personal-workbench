# 架构重新梳理（2026-10-27）

> 范围：`src/` 全量 254 文件 / 70,550 行、构建产物 `lib/`、测试与脚本链。
> 方法：只读静态分析（分层深读 + 引用统计 + 构建产物核对 + git 状态）。结论全部带 file:line 或实测数字。
> **数字口径**：所有行数为物理行（含空行），快照时间 **2026-10-27 10:54:48**。
> 采集期间该仓库处于活跃开发循环（10:47–10:54 有 6 个 `src/client/**` 文件被改，10:54:28 一次 `pnpm build` 落盘，随后 `pnpm test` 起跑），
> 故行数存在 ±0.1% 级漂移；架构结论与该漂移无关。
> 本文替代 `2026-09-09-architecture-refactor.md` 作为当前架构基线；那份文档描述的是 v1.10 的「拆上帝文件」，当时源码 4.7k 行，现在 70.5k 行（15×），已不足以解释当前形态。

---

## 0. 一句话结论

插件已经从「一个任务工作台」长成「**一个 npm 包里装了两个产品 + 一个 AI 供给层 + 一条验证链**」，
而目录主轴仍然是**按技术层**（db / api / client / shared）。

一域时代这是对的；现在它是错的 —— **域边界无处安放，于是每个新域都从各层"借"地方**。
这不是审美问题，它已经产生了一个真实后果：**宿主的编译产物里混进了 22 个浏览器 UI 组件（235 KB）**（§3.D1）。

---

## 1. 事实基线

### 1.1 体量分布

| 区域 | 文件 | 行数 | 占比 |
|---|---:|---:|---:|
| `src/client/` | 135 | 31,193 | 44.2% |
| `src/experts/` | 12 | 11,269 | 16.0% |
| `src/shared/` | 24 | 7,594 | 10.8% |
| `src/db/` | 32 | 7,316 | 10.4% |
| `src/api/` | 29 | 4,814 | 6.8% |
| **`src/` 根散件** | **8** | **4,985** | **7.1%** |
| `src/personas/` | 6 | 1,940 | 2.7% |
| `src/reminder/` | 6 | 1,265 | 1.8% |
| `src/lib/` | 2 | 174 | 0.2% |
| **合计** | **254** | **70,550** | 100% |

`src/` 根散件 = `knowledge-recall.ts`(1423) + `tools.ts`(1177) + `index.ts`(723) + `amazon-tools.ts`(662)
+ `review-memory.ts`(405) + `knowledge-recall-log.ts`(256) + `knowledge-tools.ts`(244) + `workspace-check.ts`(95) = 4,985。

`client/` 内部分布：根 56 文件 / 11,502 · `hooks/` 24 / 7,151 · `components/` 26 / 6,146 · `views/` 23 / 5,180 · `app/` 6 / 1,214。

### 1.2 周边资产

| 资产 | 数量 | 行数 |
|---|---:|---:|
| `test/` | 128 文件 | 45,957 |
| `scripts/`（含 `scripts/lib` 108 个一次性 `d17-*.py` = 15,657 行） | 187 文件 | 34,065 |
| `docs/` | 113 文件 | 14,107 |

代码 : 测试 ≈ 1 : 0.65。**测试+脚本+文档（94k）比源码本身还大。** 这是资产，也是维护面 —— 任何结构改动都要先承认这 46k 行测试的存在。

### 1.3 构建产物（实测 `lib/`）

| 项 | 数值 |
|---|---:|
| `lib/` 文件总数 | 394（`*.js` **197** = 3,285 KB；`*.d.ts` 196） |
| `lib/client/**/*.js` | **77 文件 / 764 KB**（占宿主 js 产物 23%） |
| 其中 `client/{components,views,app}/*.js` | **22 文件 / 235 KB，宿主运行期从不 import** |
| `lib/client.js`（浏览器 bundle，minified） | **896 KB** |

### 1.4 接口与数据面

- 表 **29** 张，`SCHEMA_VERSION = 34`（`db/schema.ts:7`），34 个**只前向**迁移；其中 Amazon 相关 **10** 张。
- Agent 工具 **36** 个（任务/计划/报告/知识/点子/记忆/角色/专家/Amazon）。
- `WebRoute` 注册对象 **36** 个 ≈ **130** 条端点；`isLoopbackRequest` 覆盖 29 个文件、无端点漏过。

### 1.5 git 状态 —— 架构判断的前提

| 状态 | 内容 |
|---|---|
| 已提交 | `e383d81 baseline: v1.17.0 (schema 20)` + `round1..round5`（纯 UI 令牌化，未动逻辑） |
| **未提交** | **Amazon 域整体：36 改 / 34 新增 / +2,944 −269 / schema 20 → 34** |

⇒ 当前不是「重构一个稳定系统」，而是「**往一个插件里塞第二个产品塞到一半**」。
所以本梳理必须先回答「第二个产品该不该住在这个包里」（§7 决策 1），再谈怎么拆文件。

**并且：采集期间该仓库处于活跃写入状态。** 10:47–10:54 有 6 个 `src/client/**` 文件被修改，
10:54:28 一次 `pnpm build` 落盘，紧接着 `node --test test/*.test.mjs` 起跑（PID 23508）。
⇒ 有另一条会话/编辑器窗口正在同一个工作副本上工作。**批次 0（提交基线）动手前必须先确认没有并发写入**，
否则会把别人正在写的东西一起提交，或让别人的构建读到半改状态。

---

## 2. 现状架构（实际依赖图，不是文档写的那张）

```
DSH 宿主（cordis）
│  inject 硬依赖 4：webServer / systemPrompt / tools / commands        (index.ts:54)
│  软探测：skills(子fiber) / llm / teamMemory / timer / subagents / dsh-scope
│
├─ 装配层   src/index.ts (723)
│           apply → applyDegraded(库打不开就空转) / applyReady
│           建 db、建 knowledgeRecall 单例、建 ExpertService 单例、注册 routes/tools/prompt/commands/调度
│
├─ 服务层   experts(11.3k) · personas(1.9k) · knowledge-recall(1.4k + shared 1.1k)
│           reminder(1.3k) · tools.ts(1.2k) · amazon-tools(662) · review-memory(405)
│
├─ HTTP 层  src/api (4.8k)  21 个 make<Domain>Routes(db) + 5 个内联 exact 端点
│
├─ 数据层   src/db (7.3k)   repo.ts 门面 + 28 领域模块 + schema(919, v34)
│
├─ 契约层   src/shared (7.6k)  24 模块；实测 17 个双端共用、4 个仅宿主、3 个仅客户端
│
└─ 客户端   src/client (31.1k)  index.tsx(2092) + app/(6) + hooks/(24) + views/(23) + components/(26)

构建：tsconfig.build.json（120 行**显式白名单**）+ tsdown → client.js
```

**三条竖切（域）横穿以上每一层：**

| 域 | 内容 | 跨层分布 |
|---|---|---|
| **A 工作台本体** | 任务/日历/计划/报告/提醒/草稿/复盘/知识/点子/记忆 | **19 张表** · 12 工具 · 14 路由文件 · views 9 文件 1,447 行 |
| **B AI 供给** | 专家/角色/技能包/知识召回/工具面 | **0 张表**（用 `task_drafts` + 文件系统）· 12 工具 · experts+personas 13.2k 行 |
| **C Amazon 运营** | ABA/搜索词/关键词/ASIN/库存/对账/运营日志/测算 | **10 张表 · 12 工具 · 7 路由文件（占 api 24.4%）· client 32 文件 5,766 行** |

工具面恒等式：**12 + 12 + 12 = 36**（A 的 12 个在 `tools.ts` 的 14 个工厂里，另 2 个 `load_persona` / `read_persona_resource` 属 B）。
分配依据不是命名，而是「这个工具写的表属于哪个域」—— 这正是 §3.D4 说 `tools.ts` 该按域拆的原因。

C 域在客户端已占 **72%**（views 13 文件 3,733 行 vs 本体 9 文件 1,447 行），**但它仍是未提交的半成品**。

---

## 3. 五条结构性缺陷

### D1 —— 编译容器边界已破（最贵的一条）

**事实**：`api/routes/helpers.ts:37-40` 明确写着「客户端源码不进 `tsconfig.build.json` 的宿主产物，跨容器 import 会把客户端拖进宿主」。
实际 `tsconfig.build.json` 是一份 **120 行显式白名单**，其中含约 **40 个 `src/client/*`**，包括 `.tsx` 组件
（`components/DayPanel.tsx`、`components/TaskList.tsx`、`views/AsinView.tsx`、`views/AmazonToolsView.tsx`、`styles.ts` …）。

**运行期真实反向依赖**（不是 type-only）：

| 宿主侧 | 依赖的客户端代码 |
|---|---|
| `src/index.ts:32` | `client/taskFolder.ts` |
| `src/amazon-tools.ts:3-5` | `client/amazonCalculator.ts`、`client/amazonKeywordTools.ts`、`client/amazonTrafficTools.ts` |
| `src/db/repo/amazonDatasets.ts:13-14` | `client/amazonTrafficTools.ts`（**值**导入 `SEARCH_TERM_ACTIONS`） |
| `src/experts/command.ts:35` | `client/expertPrompt.ts` |

**代价**：22 个 UI 文件 235 KB 随宿主构建产出却永不被宿主 import；同一份逻辑进两个 bundle；
「client 只跑在浏览器 / 宿主只跑在 node」这条约束在结构上已经不成立，只能靠人记。

**根因**：Amazon 域的纯计算出生在 `client/`（因为先做的是面板），而宿主工具也需要它 ⇒ 只能反向 import。

### D2 —— 数据层门面成环 + 43 处绕过

- `db/repo.ts`（314 行）**不是纯 re-export**：`:16` `localDateString` 是实现，`:23-142` 手写 6 个接口，`:5/:7/:10` 还有死导入。
- **17 个 `repo/*` 模块 `from '../repo.js'` 回导门面**（ideas/knowledge/plans/reports/recurring/dictionaries/tasks/status/drafts/task-primitives/persona-bindings/ai-sessions/reminders/reminder-queue/task-sessions/task-memory/experts）
  ⇒ `repo.ts ↔ repo/*.ts` 成环，与 `repo/shared.ts:5`「本文件不依赖任何其他 repo 模块，避免循环依赖」的自述矛盾。
- **43 处直接 import `db/repo/*`**（src 25 / test 14 / scripts 4），src 下 18 个文件，其中 12 处是运行时值导入。

⇒ 「唯一入口」在事实上不存在。改任何一个领域，都要先判断会不会碰到环。

### D3 —— 域轴缺失 ⇒ 跨域渗透

| 越界 | 证据 |
|---|---|
| 任务域 → Amazon 域 | `db/repo/status.ts:11` `import ... from './asin.js'`；完成级联里调 `writeBackAsinOutcome`（`status.ts:20-27,98`） |
| ASIN 语义塞进通用任务表 | `db/repo/tasks.ts:234-248` `findOpenTaskByAsin` |
| Amazon 路由 → 任务域 | `api/routes/asin.ts:24` 反向 `createTask` / `addReminder` |
| 角色域 ↔ 专家域双向 | `personas/managed.ts:36-37` → `experts/provenance`,`experts/paths`；反向见 `experts/catalog.ts:44-51` |
| Web 命名空间 | 只有 `/amazon/datasets` 带域前缀，其余 7 组 Amazon 端点平铺在 `/api/workbench/*`，与 `/tasks`、`/plans` 同级 |

**Amazon 域同时是一套"平行实现"**：7 个 Amazon 路由文件 **100% 内联** `pathSegments`（`aba:31`、`amazon-datasets:97`、`asin:53`、`calculator:40`、`inventory:49`、`keyword-plans:84`、`oplog:49`），
各自定义 `const PREFIX`（8 处，而 `helpers.ts:50-60` 已有 10 个），
返回体是**裸对象无 `{ok}`**（`aba-keywords:33/38`、`asin:117/246`、`oplog:59/81/85`、`keyword-plans:80/85/104`、`calculator-scenarios:42/47`）。
核心域 19/21 个路由文件用 `helpers.ts`，Amazon 域 **0/7**。

### D4 —— 归属混乱：`src/` 根 8 个散件 + `shared/` 成了第四个垃圾桶

- **`src/` 根 4,985 行（7.1%）** 是「单文件子系统」，而 `reminder/`、`experts/`、`personas/` 都有目录。
  `knowledge-recall.ts`(1423) 是其中最典型的：一个**子系统级**的东西仍以散件形态躺在根目录，而它的另外四块分居别处（日志 256 + 工具 244 + `shared/knowledgeRecall.ts` 1058 + 路由 98）。
  同理 `amazon-tools.ts`(662) 与 `tools.ts`(1177) 是**工具面**，按域拆之后也该有各自的家。
- **`shared/` 24 个模块里 7 个错位**（实测引用方向）：

| 模块 | 行数 | 宿主引用 | 客户端引用 | 判定 |
|---|---:|---:|---:|---|
| `knowledgeRecall.ts` | 1,058 | 3 | 0 | 仅宿主 → 应属 `knowledge/` |
| `asinImport.ts` | 335 | 2 | 0 | 仅宿主 → 应属 `amazon/` |
| `asinExport.ts` | 195 | 1 | 0 | 仅宿主 |
| `oplogImport.ts` | 192 | 2 | 0 | 仅宿主 |
| `adReport.ts` | 564 | 0 | 3 | **仅客户端**，且只被当 type 用 |
| `paymentReconciliation.ts` | 260 | 0 | 1 | 仅客户端 |
| `trafficFilter.ts` | 185 | 0 | 2 | 仅客户端 |

  判据应回归一句话：**`shared/` = 双端都 import 的**。实测 17/24 合格。

### D5 —— 单文件超限 23 个；`index.tsx` 自身是两个模块

**>600 行 23 个，>1000 行 11 个**。Top：`client/index.tsx`(2092)、`client/styles.ts`(1986)、`experts/install.ts`(1916)、
`client/hooks/useWorkbenchExperts.ts`(1572)、`knowledge-recall.ts`(1423)、`experts/drafts.ts`(1413)、
`shared/dailyPlanPolicy.ts`(1300)、`experts/invocation.ts`(1284)、`tools.ts`(1177)、`experts/service.ts`(1140)、`shared/knowledgeRecall.ts`(1058)。

两类要分开看：

- **`styles.ts` 1986 行是"大而无害"**：纯 CSS 模板串（`RAW_CSS` / `AMAZON_CSS`），令牌映射、门控规则、z-index 阶梯全部外置在 `client/entryContract.ts` 且被 `test/panelCss.test.mjs` 从**构建产物**断言。它不是上帝文件，不建议为"行数"动它。
- **`client/index.tsx` 是真的两块**：`WorkbenchApp`（102-826，725 行，仅 4 个 `useState` / 10 个 `useEffect` —— hook 化是成功的）
  + **宿主接线**（827-2092，**1265 行**：槽位注册、`apply()`、能力探测、WSL 判定、`ensureStyle`）。
  第二块与 React 无关，应该住在 `app/WorkbenchApp.tsx` + `host/entry.tsx` 两个文件里。

**客户端另一个真问题：自定硬门被破且无人守。** `app/assembly.ts:96` 与 `index.tsx:527` 都写着「视图不许发 HTTP」，
实测在 **4 个视图 / 23 处**被破（`OpsLogView.tsx:402/403/410`、`AsinView.tsx` 9 处 `api(`、`InventoryView.tsx:40/77`、`KnowledgeDetailPane.tsx:49/72`）。
`test/httpFence.test.mjs` 管的是**服务端**围栏，与 views 无关 —— 所以这条纪律目前只写在注释里。

**附带：一个 0 字节墓碑文件** `views/AmazonOperationsView.tsx`（已提交、0 字节、mtime 2026-10-22）。
没有任何模块 import 它；唯一提到它的是 `test/taskDetailWiring.test.mjs:142` —— 那条断言的是
`appBodySource` **不含** `AmazonOperationsView`，即「运营总览已从 WorkbenchBody 移除」的守卫。
所以它是上一轮删除动作留下的墓碑：**删文件不会破测试，但那条断言要留**（否则将来有人又把视图挂回去）。

### D6（附带）—— loopback-only ≠ 文件系统边界

`isLoopbackRequest` 是**信任围栏**，不是权限边界。三处端点把"本机可达"当成了"本机可写"：

| 端点 | 实际能力 | 校验 |
|---|---|---|
| `GET/POST /knowledge/read-local-file` | 读**任意**绝对路径文件（≤1MB，utf8 全文返回） | 仅 `assertValidFileLink`：只校验格式是 `file://` 或绝对路径（`db/repo/knowledge.ts:68-75`），**无目录白名单** |
| `/knowledge/list-local-dir` | 枚举任意目录 + 列出所有盘符 | `localDirRoute.ts:33-43,131` |
| `/workspaces/ensure` | 任意绝对路径 `mkdirSync` | `api/routes.ts:242` |

这是**功能设计使然**（知识条目要引用本地文档），不是可利用的提权链 —— GUI 本身受 loopback + 宿主 token 保护。
但边界应当明说并收紧，否则「loopback-only」会在后续开发里被当成安全承诺来引用。

---

## 4. 目标架构

### 4.1 主轴选择：保留层轴，把「域」变成显式一等公民

不建议整体改成 `src/<域>/<层>/` —— 254 文件 / 70k 行 / 36 工具 / 36 路由的搬动成本，换来的主要是命名整齐。

**建议：层目录不动，只把"越界的地方"按域收口。** 域的边界用**规则 + 测试**表达，而不是用目录深度表达。

### 4.2 四条边界规则（都可写成测试）

| 规则 | 内容 | 现有违反 | 守卫 |
|---|---|---|---|
| **R1** | `shared/` 只放**双端都 import** 的模块 | 7 个错位（D4） | 新增 `test/architecture.test.mjs`：扫描 `shared/*` 的引用方，仅单端引用即失败 |
| **R2** | 宿主产物不得含浏览器 UI；宿主不得 import `client/` 的 UI/渲染相关模块 | `tsconfig.build.json` 白名单含 ~40 个 client 文件；4 处运行期反向依赖（D1） | 构建后断言 `lib/client/{components,views,app}` **不存在**；新增 import 方向断言 |
| **R3** | 域之间不直接 import，只经 `shared/` 类型或回调注入 | `status.ts→asin.ts`、`tasks.ts:findOpenTaskByAsin`、`asin.ts→createTask`（D3） | 按域建 import 白名单表，测试断言 |
| **R4** | `db/repo.ts` 只 re-export，且 `repo/*` 不得回导门面 | 17 处回导 + 140 行实现 + 43 处绕过（D2） | `test/architecture.test.mjs`：禁 `repo/*` import `../repo.js`；门面文件禁 `function`/`const ...=` 定义 |

### 4.3 目标目录（只列要动的部分）

```
src/
├─ index.ts                 只留装配（已基本如此，723 行可再抽 reminder 装配到 reminder/install.ts）
├─ knowledge/               ★ 新建：从 src 根收编
│    recall.ts (1423)  recall-log.ts (256)  tools.ts (244)
├─ amazon/                  ★ 新建：从 src 根收编
│    tools.ts (662)         policy/   ← shared/asinImport|asinExport|oplogImport 归位
├─ tools/                   ★ 拆分 tools.ts (1177) 的 8 个领域
│    task.ts  plan.ts  report.ts  knowledge.ts  idea.ts  memory.ts  persona.ts
├─ assistant/               ★ 可选：experts/ + personas/ 合并命名（二者已双向依赖，D3）
├─ app/                     ★ 新建（宿主侧，非 client）：入口装配拆分后的宿主接线
└─ (client/)
     app/WorkbenchApp.tsx   ← index.tsx:102-826 迁入
     host/entry.tsx         ← index.tsx:827-2092 迁入
```

`shared/` 的 **17 个真正双端模块保持不动**：`dailyPlanPolicy`、`contracts`、`expert`、`persona`、`taskProgress`、
`i18n`、`abaKeywordTable`、`inventoryForecast`、`calculatorScenario`、`keywordAggregate`、`keywordDecision`、
`keywordPlanCsv`、`asinJudgment`、`oplogView`、`quickAttachments`、`quickWorkspaceRecent`、`knowledgeDraftOverwrite`。

### 4.4 明确**不**建议做的事

- **不要把插件拆成多个 npm 包。** 36 个工具、36 条路由、29 张表共享同一份 schema 与同一个 db 文件；拆包立刻变成分布式事务 + 版本矩阵 + 双份 `SCHEMA_VERSION` 对齐，收益远小于成本。
- **不要现在做 domain-first 全量目录重排。** 收益是命名整齐，风险是把 36 条路由与 36 个工具的契约打散，而现有 46k 行测试大量直连具体路径。
- **不要为了行数动 `client/styles.ts` 与 `shared/dailyPlanPolicy.ts`。** 前者是纯样式且逻辑已外置被断言；后者是 ADR0002/ADR0010 冻结口径的实现（容量与"已安排"判定全项目唯一一份），动它等于动产品语义。
- **不要在 §7 决策 1 有答案之前动 D1 的实现方式。** 「Amazon 是本包的一部分」和「Amazon 是独立插件」对应两种完全不同的 D1 解法（下沉 `shared/` vs 拆包各自拥有类型）。

---

## 5. 分批迁移计划（每批独立可验收）

| 批次 | 内容 | 验收 |
|---|---|---|
| **0 基线固化（硬前提）** | 把当前 Amazon 未提交工作落成一次 commit（36 改 + 34 新增，schema 20→34）。**在此之前任何重构都无法用 git 回退。** | `git status` 干净；`pnpm build` 通过 |
| **1 断环（D2）** | 17 处 `from '../repo.js'` 回导改直连 `./shared.js`/`./tasks.js` …；`repo.ts` 的 `localDateString` 抽到 `repo/local-date.ts`；删 3 个死导入 | `tsc --noEmit` 0 error；新增 R4 断言通过；`test/db.test.mjs` 全绿 |
| **2 收回共享（D1）** | 把宿主需要的纯计算从 `client/` 移到 `shared/amazon*`（`amazonCalculator` / `amazonKeywordTools` / `amazonTrafficTools` 的纯函数）；清掉 5 处反向依赖；**`tsconfig.build.json` 由"120 行白名单"改"排除法"**：`include: ["src/**/*"]` + `exclude: ["src/client/**"]`（批次 2 把宿主需要的几个纯函数迁进 `shared/` 后，这个 exclude 才成立 —— 在此之前减不掉） | 断言 `lib/client/{components,views,app}` 不存在；`lib/client/**` 从 764 KB 降到只剩 `lib/client.js` 需要的部分；`test/amazonThreePageWiring` 等全绿 |
| **3 域解耦（D3）** | `status.ts` 摘掉 `asin.ts`（改事件/回调注入）；`findOpenTaskByAsin` 移到 asin 域；`api/routes/asin.ts` 不再直接 `createTask` | 新增 R3 断言；`test/routes` + `test/asinTaskLaunch` 全绿 |
| **4 收编散件（D4）** | `src/knowledge/*`、`src/amazon/*`；`shared/` 7 个错位模块归位 | 新增 R1 断言；无新增循环依赖 |
| **5 拆大文件（D5）** | `tools.ts` → `tools/*`（7 文件）；`index.tsx` → `app/WorkbenchApp.tsx` + `host/entry.tsx`；`experts/{install,drafts,invocation}` 按阶段拆 | 单文件 >800 行数量从 11 降到 ≤3 |
| **6 安全护栏（D6）** | `read-local-file` / `list-local-dir` 加目录白名单（默认：默认工作区 + `~/.dsh/workbench`）；`open-file` 路径校验 | 新增 `test/localFileScope.test.mjs` |
| **7 纪律闭环（D5 客户端）** | 把 `4 个视图 / 23 处` 直连 HTTP 收回 hook；删 0 字节死文件；`test/architecture.test.mjs` 增加「views 不得出现 `api(`」 | 4 个视图改为只拿 domain 结果 |

**排序理由**：0 是硬前提；1/2 修的是**已经从注释里承诺过但没做到**的约束（成本低、收益直接、且能被现有测试文化接住）；
3 是唯一会动业务语义的批次，所以排在有 git 回退之后；4/5 是整理，收益渐进；6/7 是补纪律。

---

## 6. 与既有 ADR 的关系（不动）

本梳理**不推翻任何口径**。ADR0001（今日五口径）、ADR0002（容量读今日计划）、ADR0003（AI 进度不能完成任务）、
ADR0004（进度是显式值）、ADR0007（计划项投入状态）、ADR0010（计划项必须是可执行叶子）全部保持。

架构层面的结论与 ADR 的关系是：**ADR 保证「语义唯一」，本梳理保证「语义恰好有一处承载」**。
目前 `dailyPlanPolicy.ts`（1300 行，双端 11 处引用）与 `taskProgress.ts` 是这条原则执行得最好的样本 ——
建议把它们当作后续拆分的模板：**判定收敛到一个纯函数文件，两端都 import 它，测试跨模块断言**。

---

## 7. 需要决策的三个问题

| # | 问题 | 影响 |
|---|---|---|
| **1** | **Amazon 运营域是这个插件的一部分，还是独立插件？** 现在它是 10 张表 / 12 工具 / 7 路由 / client 32 文件 5,766 行未提交的半成品。 | 决定 D1 的解法：属于本包 → 纯逻辑下沉 `shared/`；独立插件 → 拆包，各自拥有类型与构建产物。**这是唯一会改变其他所有结论的决策。** |
| **2** | **Amazon 端点要不要统一 `{ok:true}` 信封？** 现在 7 个文件返回裸对象。 | 现在改 = 破 7 个文件的响应契约（客户端 3 个 hook + 6 个视图要同步）；不改 = 需要明文宣布「Amazon 域裸对象」为止损线，否则下一个人会以为是遗漏。 |
| **3** | **是否允许新增域级目录（`src/knowledge/`、`src/amazon/`）？** 还是保持"层目录不动、只治越界"？ | 决定批次 4 的存在与否。不改目录也能达成 R1–R4，只是 `src/` 根继续留 8 个散件。 |

---

## 8. 附：值得保留的做法（重构时不要顺手改掉）

1. **`make<Domain>Routes(db)` 的统一形状** —— 21 个领域路由一致，是这次梳理里最干净的边界。
2. **`client/api.ts` 单一出口 + `useWorkbenchPolling` 单一轮询** —— 实测客户端只有 1 处 `fetch(`、1 处 `setInterval(`。
3. **`app/assembly.ts` 整束注入、不用 Context/全局 store** —— 41 个字段显式声明依赖，视图拿意图不拿 setter。
4. **`entryContract.ts` 把逻辑从 CSS 里拔出来，让样式规则可测** —— `styles.ts` 能到 1986 行而不成为缺陷，靠的就是这个。
5. **专家安装链的校验** —— confirm 时重跑完整校验（`install.ts:1469`）、manifestHash 门、contentVersion 门、安装锁、scratch+rename 原子发布、失败回滚、journal 恢复。这是全仓最扎实的一环。
6. **软探测纪律** —— 顶层 `inject` 只有 4 个老服务，其余全部 `ctx.get`/子 fiber；`index.ts:56-68` 的注释记录了这个模式已经复发 3 次事故。**不要因为"少一个 if"把它写回 inject。**
7. **结构测试文化** —— `httpFence` / `clientInvariants` / `panelCss` / `schemaVersionInvariant` / `injectPolicy` / `packageManifest`。本梳理新增的 R1–R4 全部沿用这个模式，不引入新的验证工具。
