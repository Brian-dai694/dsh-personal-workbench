# 架构 v2：域运行时 + 组合根（2026-10-29）

> 前置：`2026-10-27-architecture-rebaseline.md`（下称 **R1 文档**）已把「层」这层修好了 ——
> 宿主不 import 客户端（实测 0 处）、`db/repo.ts` 186 行纯 re-export（`export function|const` = 0）、
> `test/architecture.test.mjs` 落 R1/R2/R4a/R4b/R5/R6/R7/R8 八条守卫。
> **本文不推翻那些结论，也不再修同一批问题。** 本文解决的是它们修不到的那一层：**域这一层没有契约**。
>
> 方法：只读静态分析（目录/文件计数、import 扫描、构建配置、测试清单）。所有数字为本机实测，口径见各表注。

---

## 0. 一句话结论

R1 文档建立了「**层**」的边界（谁能 import 谁），但没有建立「**域**」的边界（谁能读谁的表、谁能改谁的装配文件）。
结果是：**加一个域要动 5 个共享文件**（`api/routes.ts`、`plugin/ready.ts`、`client/app/assembly.ts`、
`client/app/contracts.ts`、`client/app/WorkbenchBody.tsx`），而域之间的数据边界只靠人记。

架构 v2 = **把「域」升级成可装配的一等公民**：一个域 = 一份描述符（数据所有权 + 路由 + 工具 + 迁移 + 提示 + 生命周期），
由**唯一组合根**装配。不改包结构、不拆 npm 包、不重排目录。

---

## 1. 事实基线（2026-10-29 实测）

### 1.1 体量

| 区域 | 文件 | 行数 | 备注 |
|---|---:|---:|---|
| `src/` 合计 | **280** | 63,696 | 行数为 PowerShell 物理行计数；与 R1 文档 70,628 口径不同，差值未追，不影响结论 |
| `client/` | **137** | 27,612 | 根 52 / hooks 28 / components 28 / views 23 / app 6 |
| `experts/` | 12 | 9,821 | 草稿 → 校验 → 安装 → 调用 → 恢复 |
| `db/` | 37 | 7,127 | `repo/` 32 模块 + 门面 + schema |
| `shared/` | 32 | 6,465 | |
| `api/` | 33 | 4,911 | `routes/` **24** 个 `make*Routes` 工厂 |
| 其余 | 9 目录 | ~6,000 | amazon / knowledge / tools / personas / reminder / plugin / memory / core / lib |

### 1.2 契约面

| 项 | 实测 |
|---|---|
| 表 | **29** 张，`SCHEMA_VERSION = 36`（`src/db/schema.ts:8`） |
| Agent 工具 | **36** 个（`tools/workbench.ts` / `amazon/tools.ts` / `knowledge/tools.ts` / `experts/tools.ts`） |
| 路由工厂 | 24 个，全部经 `src/api/routes.ts` 这一处组合（该文件 323 行） |
| 视图 | `WorkbenchView` 联合类型 **13** 个值；`views/` 23 个 tsx（含 9 个块级组件） |
| 装配对象 | `client/app/assembly.ts` **46 个字段**，四段 JSX 共用 |
| 浏览器产物 | `lib/client.js` **974 KB**（minified，单入口单 chunk） |
| 客户端拉取 | 仅 1 处 `fetch(`（`client/api.ts`）；1 处 `setInterval` 群：**5 s**（草稿+提醒）+ **15 s**（任务全量 `refresh`） |
| 测试 | **138** 个 `test/*.test.mjs` |
| 工作副本 | 采集时 **106 个未提交文件**（活跃开发中，任何结构性改动前必须先固化基线） |

### 1.3 变更热点（这是本次要解决的核心证据）

「新增一个域」当前必需改动的文件，全部是**所有域共享**的：

| 文件 | 当前规模 | 为什么每次都要动 |
|---|---:|---|
| `src/api/routes.ts` | 323 行 | 24 个工厂的 import + 调用 + 依赖注入 |
| `src/plugin/ready.ts` | 318 行 | 建服务、注册工具/命令/提示/调度 |
| `src/client/app/assembly.ts` | 165 行（46 字段） | 域 hook 的返回值整束注入 |
| `src/client/app/contracts.ts` | 类型 | `WorkbenchView` 联合类型 |
| `src/client/app/WorkbenchBody.tsx` | — | 视图分支 |

R1 文档 §0.5 记录的并行会话事故（`asin.ts`、`helpers.ts` 两个文件双方都改过）就是这个结构的必然产物：
**域边界不落在目录上，就必然落在 5 个共享文件的同一段 diff 上。**

### 1.4 域归属现状（29 张表按域）

| 域 | 表 | 路由工厂 | 工具 | 视图 |
|---|---|---:|---:|---:|
| 任务本体 | tasks, task_events, task_reminders, task_drafts, task_sessions, task_reviews, task_artifacts, dictionaries, task_memories | 5 | 12 | 5（today/calendar/list/detail/form） |
| 计划 | daily_plans | 1 | 3 | （并入 today/plan 面板） |
| 报告 | task_reports | 1 | 1 | — |
| 知识 | knowledge_entries, knowledge_recall_log | 2 | 4 | 2 |
| 点子 | ideas, idea_clusters, idea_links | 2 | 3 | 2 |
| 提醒/通知 | reminder_queue, draft_notify_queue | 1 | 0 | （并入壳） |
| AI 会话登记 | ai_session_registry | 1 | 2 | （并入壳） |
| 角色/专家 | **0 张表**（用 `task_drafts` + 文件系统） | 2 | 4 | 1（设置内） |
| Amazon | 10 张（asin_products/snapshots/stores, oplog_entries/types, keyword_plans, inventory_snapshots, calculator_scenarios, aba_keyword_sets, amazon_datasets） | 7 | 12 | 10 |

**两条可测的越界**（不是猜测，是结构位置决定的）：

1. **Amazon 域借了任务本体的表**：`task_drafts` 同时承载「任务澄清草稿」「专家草稿」「知识草稿」「点子草稿」；
   `task_events` 同时记录任务与 ASIN 立项。⇒ 四个域共写一张表，`owns` 无法声明。
2. **角色/专家域没有自己的表**：`ai_session_registry` 与文件系统各存一半状态。

---

## 2. 目标与非目标

### 2.1 目标（每条都有验收）

| # | 目标 | 验收（可执行） |
|---|---|---|
| G1 | **加域只改 2 处**：新增域目录 + 组合根注册一行 | 造一个只读 demo 域，`git diff --stat` 触碰的共享文件数 ≤ 1；全套测试绿 |
| G2 | **数据所有权可验证**：每个域声明 `owns: Table[]`，越界由测试拦下 | 新守卫 R9 通过；现存越界进白名单且只许减少 |
| G3 | **单域降级不拖垮全机**：一个域迁移/初始化失败 → 该域 503 + 视图隐藏，其余域照常 | 注入一个必失败迁移，宿主仍能起、任务域可用 |
| G4 | **客户端首屏不为 Amazon 付费** | 首帧 Network 只出现 `client.js`，**不出现** `client.amazon.js`；打开亚马逊视图时才请求它（机制见 §6.4，已探明） |
| G5 | **视图可寻址 + 只刷可见域** | `#/wb/amazon/aba` 可直接打开；面板隐藏时定时器暂停（`visibilityState`） |

### 2.2 非目标（明确不做，理由见 §9）

- ❌ 拆成多个 npm 包（R1 文档决策 1 已锁「本包的一部分」，本文沿用）。
- ❌ 全量 domain-first 目录重排（138 个测试大量直连具体路径，成本 ≫ 收益）。
- ❌ 拆数据库（多库 = 跨库事务 + 双份迁移 + 双份备份，收益不成立）。
- ❌ 动 `client/styles.ts`（2,190 行纯样式，逻辑已外置 `entryContract.ts` 并被 `panelCss` 断言）。
- ❌ 重写 R1 文档已落地的 R1–R8。

---

## 3. 目标架构

### 3.1 一张图

```
DSH 宿主 (cordis)
│  inject 硬依赖 4：webServer / systemPrompt / tools / commands（软探测其余）
│
└─ 插件
   ├─ core/                       ← 宿主无关的地基（不含域语义）
   │    db(executor, executor 级事务, schema runner)
   │    http(apiOk/apiError/loopback 围栏)
   │    settings, health, buildInfo, workspace-check
   │
   ├─ registry/domains.ts         ★ 唯一组合根：域清单（本文件定义"插件有哪些域"）
   │    defineDomain({ id, owns, migrations, routes, tools, prompt, setup, ready })
   │    → 按清单顺序：跑迁移 → 建设置 → 注册 routes/tools/prompt/commands → 起 setup
   │    → 产出 DomainStatus[]（每域 loaded / degraded / disabled）
   │
   ├─ domains（逻辑归属，物理仍在原层目录）
   │    tasks · plans · reports · knowledge · ideas · reminders · drafts · assistant · amazon
   │    每个域 = 一份描述符 + 现有实现（routes/、db/repo/、tools/、client/views/ 各处）
   │
   ├─ db/ports/<domain>.ts        ★ 跨域唯一合法入口（窄接口，单向）
   │
   └─ client/
        app/viewRegistry.ts      ★ 视图清单（nav 由它派生，不再手改 contracts/WorkbenchBody）
        app/domainHandles.ts     ★ useDomain(id) 取代 46 字段整束注入
        shell/                   ★ 槽位注册、能力探测、WSL 判定、ensureStyle（与 React 无关）
```

**关键取舍：物理目录不动。** 域在**装配层**（`registry/domains.ts`）显式化，而不是靠目录深度表达。
这样 138 个直连路径的测试全部不受影响，G1 却已经成立。

### 3.2 域描述符（唯一新契约）

```ts
// src/registry/domain.ts
export interface WorkbenchDomain {
  readonly id: DomainId
  /** 本域**独占写入**的表；测试据此拦越界（R9）。 */
  readonly owns: readonly TableName[]
  /** 本域只读使用的他域表 → 必须经 db/ports/<域>.ts，且在此登记（R10）。 */
  readonly reads?: readonly TableName[]
  /** 前向迁移；全局 SCHEMA_VERSION 仍单值，域只贡献自己的切片。 */
  readonly migrations?: readonly DomainMigration[]
  readonly routes?: (deps: WorkbenchDeps) => WebRoute[]
  readonly tools?: (deps: WorkbenchDeps) => AgentTool[]
  readonly prompt?: (deps: WorkbenchDeps) => string
  /** 定时器/订阅；返回 dispose，宿主卸载时统一调用。 */
  readonly setup?: (deps: WorkbenchDeps) => (() => void) | void
  /** 软依赖探测：无 univer / 无 llm / 无 teamMemory 时该域降级为 disabled，而不是抛错。 */
  readonly ready?: (deps: WorkbenchDeps) => boolean
}
```

组合根只做四件事：**排序、跑迁移、注册、报状态**。它不含任何业务判断 —— 一旦它开始出现 `if (domain === 'amazon')`，就说明该规则放错了层。

### 3.3 与「D17 装配」的关系

R1 文档 §8 明确保留的两条（单一 `client/api.ts` 出口、整束注入不用 Context）**都保留**。
本设计只替换「整束」的粒度：从 **46 个字段一个桶**，变成 **13 个域句柄**。
理由不是审美 —— 46 字段桶导致「任一域加一个字段，四段 JSX 的 props 类型都变」，这是 G1 在客户端一侧的同一病根。

---

## 4. 新增守卫（沿用 `test/architecture.test.mjs` 风格，不引入新工具）

| 规则 | 内容 | 动机 |
|---|---|---|
| **R9 域所有权** | `db/repo/<A>*.ts` 的 SQL 中出现 `INSERT/UPDATE/DELETE <table>` ⇒ `table ∈ owns(A)`，否则失败 | 拦「Amazon 借任务表」这类越界 |
| **R10 跨域只走端口** | `db/repo/<A>` 不得 import `db/repo/<B>`；只允许 import `db/ports/<B>` | 现有 R1–R8 只约束层，不约束域 |
| **R11 组合根唯一** | `api/routes.ts` / `plugin/ready.ts` 不得出现域级分支；域清单只在 `registry/domains.ts` | 保 G1 |
| **R12 路由命名空间** | 域路由必须以 `/api/workbench/<id>/` 开头（旧平铺路径登记为别名，只许减少） | 让 URL 能回答"这是谁的接口" |
| **R13 视图注册表唯一** | `WorkbenchView` 联合类型由 `viewRegistry` 推导；禁止手写字面量联合 | 保 G1 客户端侧 |

R9–R13 全部带**债务棘轮**：首版基线 = 现存违反数，只许下降。
这沿用 R1 文档 §4.5 已验证有效的做法（`apiEnvelope` 棘轮先例）。

---

## 5. 数据边界与迁移

### 5.1 两条决定

1. **表不拆、库不拆，但所有权必须声明。** 29 张表里 `task_drafts` / `task_events` 现在是多域共写，
   §8 给出收口方案（草稿表按 `kind` 拆成 4 张，或加 `owner_domain` 列）。**先声明再收口**，
   不声明就永远说不清"谁能写"。
2. **迁移按域分段，但 `SCHEMA_VERSION` 保持单值。** 新增 `schema_domain_state(domain, version, applied_at)`，
   记录每域已应用到第几片。全局版本仍用于「太新即降级」判断（`SchemaTooNewError` 路径不动）。
   好处：域级失败可定位、可重试；坏处：多一张表与一段 runner 逻辑（约 80 行）。

### 5.2 域级降级（G3）

启动顺序固定为：`open db → 跑全部迁移（每域一个事务）→ 逐域 ready → 注册`。

| 失败点 | 现状 | v2 |
|---|---|---|
| 库打不开 | 全体空转（`applyDegraded`） | 不变 |
| 某域迁移抛错 | 整机起不来 | 该域回滚 + `degraded`，其余域正常注册 |
| 某域软依赖缺失（univer/llm/teamMemory） | 端点条件注册 | 统一由 `ready()` 表达，`health` 可见 |
| 某域运行时抛错 | 500 | 该域 `degraded` 并计数，`health` 报 |

`health` 从「一个版本号 + buildId」升级为「版本 + buildId + `domains[]`」，这样"哪个域坏了"不再靠翻日志。

---

## 6. 客户端 v2

### 6.1 三层拆分（对应 G1/G5）

| 层 | 内容 | 现状 |
|---|---|---|
| **shell** | 槽位注册、能力探测、WSL 判定、`ensureStyle`、closePanel | 与 React 无关，却混在 `client/index.tsx`（1,487 行）里 |
| **viewRegistry** | `{ id, title, group, load }[]`，nav / 左栏 / 深链全部由它派生 | 现为 13 值联合类型 + 手写分支 |
| **domainHandles** | `useDomain(id)` → `{ state, actions, revision }` | 现为 46 字段整束 |

### 6.2 深链（G5）

`#/wb/<domain>/<view>`（如 `#/wb/amazon/aba`、`#/wb/tasks/detail/<taskId>`）。
收益不是"好看"：**提醒横幅、AI 会话回链、知识条目引用任务** 现在都只能打开面板、不能定位。
代价：`useWorkbenchNavigation` 增加 hash 同步（约 40 行），`setView` 语义不变。
**不引入路由器库** —— 13 个视图不需要。

### 6.3 轮询（G5）

现状：5 s（草稿+提醒）+ 15 s（任务全量 `refresh`），无论面板是否可见、无论当前在哪个视图。

v2 分两步，**第一步不改协议**：

1. `document.visibilityState` 门控 + 只刷「当前视图所属域」；保留单定时器、单 `catch`、串行顺序（`useWorkbenchPolling` 的四条逐字保持不动）。
2. 若第 1 步实测仍不够（例如 Amazon 大表），再加 `GET /api/workbench/revisions` → 每域一个计数，只拉变化的域。
   **第 2 步需要证据才做**，不预先实现。

**推送能力已探明（observed，供第 2 步备用）**：`@deepseek-ai/dsh-host-webserver` 的 `WebRoute.handler`
明确「owns the full response lifecycle (may hold the response open, e.g. SSE)」，且 `lib/index.js:113`
对 `content-type: text/event-stream` 单独放行（不做 gzip/缓冲）；另提供 `registerUpgrade` 走 HTTP upgrade
（WebSocket 那条路）。⇒ 需要真推送时不必换服务器，也不必新增依赖。
**但 SSE 只在"必须秒级"的场景才值得**：它带来长连接与断线重连、以及 host 重启后的重订阅，
而当前工作台的时效要求是"5–15 秒感知"，轮询足够。**默认仍走轮询**。

### 6.4 打包（G4）—— **已探明：宿主支持包内懒加载 chunk**

现状：`tsdown` 单入口 `client.js`，974 KB 一个 CJS 包，首帧全量下载并执行。

**探测结论（observed）**：宿主 client module system 内置两级懒加载，不是"只能一个文件"。

证据（`<DSH 安装目录>\resources\app.asar` → `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`，
搜索 `CLIENT_CHUNK` / `require.async` / `registration.chunk`）：

| 机制 | 实测契约 |
|---|---|
| **包内 chunk 命名** | `const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` → `client.amazon.js` 合法 |
| **注册方式** | `__ModuleLoader__.load({ id, chunk: 'client.amazon.js', factory })`；`registration.chunk` 校验后按 `chunkId(ownerId, fileName)` 入表 |
| **触发方式** | factory 收到的 `require` 带 `require.async`：`await require.async('./client.amazon.js')` → `importChunk(ownerId, fileName)` → 用 `chunkUrl(row, fileName, rev)` 拼出同源 URL → `loadBundle(url)` 插 `<script>` → 等注册 |
| **缓存与并发** | 同 URL 只请求一次（`pendingArrival` / `executedBundleUrls`）；失败进 `failedBundleUrls`；成功后进 `loadCache` |
| **版本与重载** | URL 带 `rev`；`invalidate(id, rev)` 换 rev 重取，`generation` 变更时丢弃旧 chunk 重试 |
| **入口层级** | `dsh.client.immediately`（boolean，`parseDshClient` 校验）；只有 `immediately` 的插件在启动时 `prefetch`，其余按需拉起 |

**落地方式（P5）**：

```ts
// src/client/index.tsx 侧：视图注册表里的 load 不再是静态 import
{ id: 'amazon', title: '亚马逊', load: () => require.async('./client.amazon.js') }
```

```ts
// tsdown.config.ts：多入口，产物落 lib/
entry: { client: 'src/client/index.tsx', 'client.amazon': 'src/client/chunks/amazon.tsx', … }
```

- 首屏只含 `today / calendar / list / 详情 / 设置`，Amazon 系（ABA/搜索词/关键词/库存/对账/日志/测算）、
  知识、点子各成 chunk，**首次打开该视图时才下载**。
- **derived 估算**：按文件名可识别的 Amazon 客户端代码 5,254 行 / 客户端 27,613 行 ≈ **19%**，
  实际更高（未含 `use*` 钩子与 `shared/` 里的 Amazon 纯逻辑）。**精确体积以第一次拆分后的构建产物为准，不预付承诺。**

**仍需验证的一点（不是阻塞项）**：非 `immediately` 的插件入口何时被拉起（对"整个面板懒加载"才有意义），
**本设计不使用该开关**：侧边栏入口必须在启动时就注册，否则用户看不到「工作台」这一项。

#### 6.4.1 尖刺记录（2026-10-29，已跑通并已撤回）

切了一个 `client.probe.js`（0.31 kB）+ 主包 `require.async('./client.probe.js')`，实测：

| 检查项 | 结果 |
|---|---|
| 构建产出 | `lib/client.probe.js` 0.31 kB；`lib/client.js` 974.30 kB（= 基线 974.03 + 0.27 kB 尖刺代码） |
| chunk 自注册 | 产物 banner 为 `factory:e=>{… chunk:`client.probe.js` …}`，`id` 与主包一致 |
| 懒加载保留 | 主包里是 `t.async(`./${e}`)`（`t` = factory 收到的 `require`），**属性调用未被改写**，`require.async` 命中 1 处 |
| 未内联 | 主包里搜不到 chunk 的 `workbench-chunk-probe-v1`；chunk 里搜得到 |
| 注册语义 | Node 侧用最小 harness 执行 chunk：注册键 `client.probe.js`、`id` 正确、`factory()` 返回 `{ PROBE_MARKER, probeChunk }`，`probeChunk().marker` 对得上 |
| 回归 | `tsc` 0 error；`buildOutput` + `architecture` 11/11 绿 |

**一个必须记住的坑（本次实测）**：`tsdown` 的 `banner` **不是原样前置拼接** —— 它会被 rolldown 当代码一起压缩/改写
（`factory: (require) => {` 出去变成 `factory:e=>{`）。所以 ① banner 里必须是**合法代码**，不能写注释或用保留字技巧；
② 校验"注册字段对不对"只能**读产物**，不能读配置文本。

**仍未做真实浏览器验证**：本机 GUI 加载的是已安装副本，验证"首帧 Network 里没有 chunk、点开视图才出现"
需要装盘 + 重启宿主，属发布动作，留到 P5 正式实施时一并做。


---

## 7. 分批实施（每批独立可回滚）

| 批 | 内容 | 改动面（实测基线） | 验收 | 回滚 |
|---|---|---|---|---|
| **P0 基线** | 固化 106 个未提交文件 | — | `git status` 干净；`pnpm build; node --test --test-concurrency=1 test/*.test.mjs` 绿 | `git reset --hard` |
| **P1 组合根** | 新增 `registry/domain.ts` + `registry/domains.ts`，把 24 个工厂/36 个工具/9 域迁进清单；`routes.ts`、`ready.ts` 退化为调用组合根 | 5 个共享文件 −（约 500 行），新增约 400 行 | R11 通过；端点/工具**逐个对比注册结果一致**（脚本导出两版 `{path,method}` 与工具名集合做 diff）；全套测试绿 | 组合根是纯新增，删一个 import 即回滚 |
| **P2 所有权** | 每域声明 `owns` / `reads`；R9/R10 棘轮；`task_drafts` 与 `task_events` 的共写白名单 | 9 份描述符 + 1 个测试 | R9/R10 通过；白名单条数只许下降 | 测试可整体回退，无数据变更 |
| **P3 域级降级** | `schema_domain_state` + runner 分段 + `health.domains[]` | `db/schema.ts` 拆 `db/migrations/<domain>.ts`（36 → 9 片）+ 80 行 runner | 注入必失败迁移：宿主起、他域可用（G3） | 迁移表只增不删；runner 可退回单一事务 |
| **P4 客户端注册表** | `viewRegistry` + `domainHandles` + `shell/` 抽出；深链 | `assembly.ts` 46 → 13 句柄；`index.tsx` 1,487 → 两个文件 | R13 通过；13 个视图逐个可打开；深链直达 | 句柄与整束可共存一个版本，按视图切换 |
| **P5 分块加载** | `tsdown` 多入口（`client` + `client.amazon` + `client.knowledge` + `client.ideas`）；视图注册表 `load: () => require.async('./client.<x>.js')`；`visibilityState` 门控轮询 | `entry` 1 → 4；新增 3 个 chunk 入口文件（薄壳，只做 re-export）；`viewRegistry` 由静态 import 改懒引用 | 首帧只请求 `client.js`（G4）；打开亚马逊视图后出现 `client.amazon.js` 且功能不变；面板隐藏时定时器数为 0。**机制已在 §6.4.1 尖刺验证，本条只剩真实浏览器验收** | `entry` 改回单入口 + `load` 改回静态 import |

**排序理由**：P1 是纯结构、零行为变化，先把「共享文件 hotspot」消掉，后面每批的冲突面都变小；
P2/P3 是数据层，必须在 P1 之后（描述符是它们的载体）；P4/P5 是客户端，风险独立可拖后。

**总成本量级（derived）**：P1 ≈ 2–3 人日，P2 ≈ 1–2，P3 ≈ 2–3，P4 ≈ 3–5，P5 ≈ 1–2（不含探测失败的重设计）。
P1+P2 完成后 G1/G2 成立，这是本次的**最小可交付架构**。

---

## 8. 已知越界与收口方案（不在 P1–P5 内自动解决）

| 越界 | 现状 | 建议 |
|---|---|---|
| `task_drafts` 四域共写（任务/专家/知识/点子） | 一张表 + `kind` 列 | 加 `owner_domain` 列（+ 索引），先只读分离，再考虑拆表。**拆表有数据迁移成本，留待单独决策** |
| `task_events` 记录 ASIN 立项 | 通用事件表 | 事件载荷已带 `kind`，建议 `owns` 登记为 shared 并加 R9 例外白名单；不要为一条事件拆表 |
| 角色/专家域 0 张表 | `task_drafts` + 文件系统 | `registry/` 里让它 `owns: []` 并显式标注「文件系统为真实存储」，`health` 报根目录可用性 |
| 本地文件端点无目录白名单（R1 文档 D6 / 批次 6 未做） | `read-local-file` / `list-local-dir` / `workspaces/ensure` | **本文不改变结论**：这是独立安全决策，等用户拍板严格模式 |

---

## 9. 风险与取舍

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| P1 组合根改造引入"注册顺序"差异（如工具名冲突、路由遮蔽） | 中/高 | 注册结果做**集合 diff**（不是人工目测）；端点顺序不变的断言 |
| 域清单成为新的单点上帝文件 | 中/中 | 描述符只能声明、不能写分支（R11）；每域实现仍在自己目录 |
| R9 SQL 静态扫描误报（字符串拼接、动态表名） | 中/低 | 棘轮白名单 + 只扫 `db/repo/**` 字面量 INSERT/UPDATE/DELETE |
| 迁移分段让"全局版本"与"域版本"不一致 | 中/中 | `SCHEMA_VERSION` 仍是唯一升级判据；`schema_domain_state` 只做定位与重试 |
| 客户端句柄化期间两套 props 并存 | 高/低 | 允许共存一个版本，逐视图迁移，末版本删旧桶 |
| 分块机制虽被宿主支持，但 `require.async` 可能被 `tsdown` 改写 | 中/中 | P5 第一步只切 1 个 chunk 验证；不通就退回延迟挂载（弱 G4），不重做架构 |
| 并行会话改同一工作副本（R1 文档已发生两次） | 高/高 | 每批**独占窗口**且必须先 `build` 再 `test` |

---

## 10. 待用户拍板的决策

| # | 决策 | 选项 | 架构师的建议 |
|---|---|---|---|
| D1 | 是否引入「域描述符 + 组合根」 | 是 / 否（继续手工维护 5 处） | **是**。这是 G1/G2 的唯一载体，且 P1 零行为变化 |
| D2 | 路由是否加域命名空间 `/api/workbench/<domain>/` | 加（旧路径留别名）/ 不加 | **加**。否则 URL 无法回答归属，R12 也无从守卫 |
| D3 | 迁移是否按域分段 + 域级降级 | 是 / 否 | **是**，但排在 P3；P1/P2 不依赖它 |
| D4 | `task_drafts` / `task_events` 多域共写 | 先加 `owner_domain` 列 / 直接拆表 / 暂不动 | **先加列**。拆表要迁移 4 类草稿的历史数据，风险不对称 |
| D5 | 专家/角色域是否单列为「宿主能力层」 | 单列（`assistant/`，仍在本包）/ 保持现状 | 单列**逻辑边界**即可；**不拆包**，等出现第二个消费者再谈 |

---

## 11. unknown 清单（不得当成事实使用）

> 2026-10-29 探测已关闭两条（分块加载、SSE 推送），结论与证据见 §6.4 / §6.3。

1. ~~宿主 `__ModuleLoader__` 是否支持按需 chunk~~ → **已探明：支持**，契约 `require.async('./client.<name>.js')`。
2. ~~DSH `webServer` 是否提供 SSE~~ → **已探明：支持**（`WebRoute` 可持响应；`text/event-stream` 不被压缩）。
3. ~~`require.async` 能否穿过 `tsdown` 打包~~ → **已探明：能**（§6.4.1 尖刺），且宿主按 `/plugins/<pkg>/client.<name>.js?rev=` 按需供给。
4. 非 `immediately` 插件入口的拉起时机 —— **仍未知**，本设计不依赖它（侧边栏入口必须启动即注册）。
5. 真实浏览器里"首帧无 chunk 请求"尚未验证 —— 需装盘 + 重启宿主，留给 P5 正式实施。
6. `lib/` 中 `client/` 产物是否应继续保留（R1 文档 §4.2 已更正为「由测试导入清单决定」，本文沿用）。

---

## 12. 保留清单（改造时不要顺手改掉）

沿用 R1 文档 §8 全部七条，本文另有两条：

8. **`make<Domain>Routes(db)` 统一形状** —— 它是本设计的现成接缝，描述符直接复用它。
9. **`test/architecture.test.mjs` 的棘轮文化** —— R9–R13 必须写成同一形态，禁止引入新的验证框架。
