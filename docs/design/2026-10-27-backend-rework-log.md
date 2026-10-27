# 后端重构执行记录（2026-10-27）

> **架构判断、目标结构与剩余批次以 [`2026-10-27-architecture-rebaseline.md`](2026-10-27-architecture-rebaseline.md) 为准**；
> 本文只记"这一轮动了什么、为什么动、怎么验的"，属于实施记录（同 `2026-09-09-wechat-reminder-implementation-record.md` 的体裁）。
>
> 同日另起的 `2026-10-27-backend-structure-review.md` 已删除 —— 两份同题文档就是本仓最忌讳的"同一语义两处实现"。

---

## 0. 起点：先修门，再动刀

| 项 | 状态 |
| --- | --- |
| 工作树 | **36 个已修改 + 78 个未跟踪**（v1.18 Amazon 域施工中，含 schema 20→34） |
| `tsc --noEmit` | **红**：`src/client/styles.ts` 4 个语法错 |
| 处理 | 先落一次 WIP 提交 `0b48478` 作为可回滚点，再修阻断 |

**阻断根因**：`styles.ts` 整体是模板字符串，注释里写了反引号（`` `--wb-state-business-primary` ``、`` `--wb-line*` ``、`` `--wb-border*` ``），
提前闭合字面量。文件自己第 776 行就写着"注释中**不能出现反引号**"——规则存在，但没有机制执行。

修复后基线 **tsc = 0 error**，后面三批都以它作为第一道闸。

---

## 1. 批次 A：断开仓储门面环（对应 rebaseline D2 / R4）

提交 `0a2d666`，21 个文件，+266 −184。

**改了什么**

| 动作 | 文件 |
| --- | --- |
| 新增行/输入类型 | `src/db/types.ts`（`TaskInput` `TaskPatch` `TaskRow` `DictionaryEntry` `DraftInput` `TaskSessionLinkInput`） |
| 新增「本地日」叶子模块 | `src/db/repo/local-date.ts`（`localDateString`） |
| 门面收敛为纯 re-export | `src/db/repo.ts`：314 → **199 行**，不再有 `function` / `const … =` 实现 |
| 17 个子模块改为直连 | `ai-sessions` `dictionaries` `ideas` `drafts` `knowledge` `persona-bindings` `plans` `progress` `recurring` `reminders` `reminder-queue` `status` `reports` `tasks` `task-primitives` `task-sessions` `task-memory` |

**为什么不是"改 import 就行"**：这些子模块当初回导门面，是因为类型与 `nowIso` / `localDateString` 都定义在门面里。
只改值不够——类型留在门面，下一个写子模块的人仍会回导。所以类型和本地日一起下沉，环才彻底断。

**验证**：`grep "from '../repo.js'" src/db/repo/` → **0 命中**；`tsc --noEmit` = 0 error。

---

## 2. 批次 B：收编根目录散件（对应 D4）

提交 `46ef287`，48 个文件（含 7 个 rename），+87 −87（纯路径搬迁）。

| 旧位置 | 新位置 | 行数 |
| --- | --- | --- |
| `src/knowledge-recall.ts` | `src/knowledge/recall.ts` | 1,423 |
| `src/knowledge-recall-log.ts` | `src/knowledge/recall-log.ts` | 256 |
| `src/knowledge-tools.ts` | `src/knowledge/tools.ts` | 244 |
| `src/tools.ts` | `src/tools/workbench.ts` | 1,177 |
| `src/amazon-tools.ts` | `src/amazon/tools.ts` | 662 |
| `src/review-memory.ts` | `src/memory/review-memory.ts` | 405 |
| `src/workspace-check.ts` | `src/core/workspace-check.ts` | 95 |

- 同步 **52 处**相对导入（`src` / `test` / `scripts`）+ `tsconfig.build.json` 两条白名单。
- 测试里 4 处"按字符串读源码"的断言（`'src/tools.ts'` 等）一并改到新路径。
- 三个 `scripts/repro/*.mjs` 里硬编码的 `lib/tools.js` / `lib/knowledge-recall.js` 等也改到新位置。

**验证**：tsc 0；`pnpm build` 0；相关 18 个测试文件 **238 项全绿**。

副作用：`src/` 根目录现在只剩 `index.ts`（723 行，装配入口），后端不再有"平铺的子系统"。

---

## 3. 批次 C：纯逻辑下沉 shared（对应 D1 / R2）

| 旧位置 | 新位置 | 谁需要它 |
| --- | --- | --- |
| `src/client/amazonCalculator.ts` | `src/shared/amazonCalculator.ts` | `amazon/tools.ts`（宿主工具）+ 测算面板 |
| `src/client/amazonTrafficTools.ts` | `src/shared/amazonTrafficTools.ts` | 宿主工具 + `db/repo/amazonDatasets.ts`（值导入 `SEARCH_TERM_ACTIONS`） |
| `src/client/amazonKeywordTools.ts` | `src/shared/amazonKeywordTools.ts` | 宿主工具 + 关键词面板 |
| `src/client/expertPrompt.ts` | `src/shared/expertPrompt.ts` | `experts/command.ts`（`/expert` 命令提示词） |
| `src/client/taskFolder.ts` | `src/shared/taskFolder.ts` | `index.ts`（`/workbench` 建任务资料夹） |
| `src/client/workspacePath.ts` | `src/shared/workspacePath.ts` | `taskFolder` + 4 个 client 模块 |

**关键取舍**

- `folderForText`（旧口径的目录名清洗）从 `client/format.ts` 抽到 **`shared/folderName.ts`**，
  `client/format.ts` 改为 `export { folderForText } from '../shared/folderName.js'` —— **不留第二份实现**
  （它是 `taskFolder.ts` 判定历史自动路径的逐字依赖，复制一份就等于把判据分叉）。
- `tsconfig.build.json` 里 6 条 client 白名单改到 shared；`tsdown` 的 client bundle 体积不变（917.98 kB），
  证明这些模块本来就同时进了两个容器 —— 只是以前靠"服务端 import 浏览器目录"实现。

**验证**

```text
边界扫描：非 client 文件 import client/ → 0 处 ✅
tsc --noEmit                          → 0 error
pnpm build                            → 0，lib/client.js 917.98 kB
node --test test/*.test.mjs           → 1531 项全绿（0 fail）
```

---

## 4. 重构后的形状（`src/`，257 文件 / 70,628 行）

```text
src/
├─ index.ts            723      只做装配（DB 降级 / 路由 / 工具 / 命令 / 提醒 / 专家 / 提示词）
├─ api/              4,813      42 个端点，一域一文件
├─ db/               7,381      34 个迁移 / 30 张表；repo.ts 是纯门面，29 个领域模块
├─ experts/         11,269      草稿 → 校验 → 安装 → 调用 → 恢复
├─ shared/           8,473      31 个模块：前后端共享纯逻辑（本轮新增 6 个 + folderName）
├─ knowledge/        1,923      recall / recall-log / tools（原三个根散件）
├─ tools/            1,177      workbench.ts（14 个任务域 Agent 工具）
├─ amazon/             662      tools.ts（12 个 Amazon Agent 工具）
├─ memory/             405      review-memory.ts
├─ personas/         1,940
├─ reminder/         1,265
├─ core/                95      workspace-check.ts
├─ lib/                174      xlsx / ABA 导出
└─ client/          30,328      UI（不再被宿主 import）
```

**三条边界现在成立**

| 规则 | 状态 | 证据 |
| --- | --- | --- |
| 宿主侧不 import `client/` | ✅ 0 处 | 边界扫描脚本 |
| `db/repo/*` 不回导门面 | ✅ 0 处 | grep `from '../repo.js'` |
| 门面不含实现 | ✅ 199 行纯 re-export | 文件结构 |

---

## 5. 截至本轮结束的缺口清单

| 缺口 | 现状 | 状态 |
| --- | --- | --- |
| 直写 SQL 越层 | **1 处**（`experts/install.ts` 的 `PRAGMA database_list`，已在 R7 白名单注明理由） | ✅ 已收 |
| 架构规则测试 | `test/architecture.test.mjs`（R1/R2/R4a/R4b/R5/R6/R7/R8，四条带棘轮） | ✅ 已落 |
| 装配瘦身 | `index.ts` 723 → 33 行（`plugin/*` 六个模块）；设置域拆出 `routes/settings.ts` | ✅ 已落 |
| 域间直接依赖 | `status.ts` 摘掉 `asin.ts`、`findOpenTaskByAsin` 移到 asin 域、Amazon 路由前缀收敛 | ✅ 由并行线完成（`7e2185c`） |
| 大文件 | `experts/install.ts`(1,704) · `knowledge/recall.ts`(1,423) · `experts/drafts.ts`(1,239) · `tools/workbench.ts`(1,177) | ⏳ 待做（批次 5） |
| `tsconfig.build.json` | 已改为继承 `include: ["src"]`，并加 `test/buildOutput.test.mjs`（产物覆盖断言）；lib 267 js / 4.8 MB | ✅ 已收 |
| 本地文件端点 | `read-local-file` / `list-local-dir` / `workspaces/ensure` 无目录白名单（D6） | ⏳ 待做（批次 6） |
| 客户端视图直连 HTTP | 4 个视图 23 处（rebaseline D5 附带发现） | ⏳ 待做（批次 7） |

> 下一步优先级：**大文件拆分（批次 5）** —— `experts/install.ts` 1,704 行是最硬的一块；
> 其次是**客户端视图直连 HTTP 的 23 处**（D5 附带发现，纯纪律问题，改动面小但散）。
> `lib/` 里那 58 个 UI 产物属于 rebaseline D1 的未决项（要不要排除 client 目录），不是 bug。

---

## 6. 第二轮（同日追加）：把边界变成测试 + api 层 SQL 清零

### 6.1 架构护栏：`test/architecture.test.mjs`（8 条规则）

边界写在文档里会烂，写成断言才会活得久。8 条规则，其中 4 条带**棘轮白名单**（只许减少）：

| 规则 | 断言 | 结果 |
| --- | --- | --- |
| R2 | 非 `client/` 文件不得 import `client/` | 0 违规 |
| R4a | `db/repo/*` 不得回导门面 | 0 违规 |
| R4b | 门面 `db/repo.ts` 无实现（逐行判定，多行 `export {}` 放行） | 通过 |
| R1 | `shared/` 必须双端共用（shared→shared **传递闭包**后判定） | 5 条历史遗留，棘轮 |
| R5 | `client/` 不得运行时依赖宿主；type-only 单独登记 | 0 运行时 / 6 条 type-only |
| R6 | `src/` 根只允许 `index.ts` | 通过 |
| R7 | `db.prepare(` 只许在 `db/` | api 层清零，剩 1 处 PRAGMA，棘轮 |
| R8 | `shared/` 不得 import `node:*` | 0 违规 |

> 写完立刻就抓到两件事：① `shared/quickAttachments`、`shared/taskFolder` 被词法漏判成"单端"
> （多行 import 的 `[^'\n]` 假设），改成跨行匹配后恢复正常；② `shared/trafficFilter`
> 在批次 C 之后**已经变成双端共用**（Amazon 工具下沉后宿主也用上了），白名单要删。

### 6.2 `shared/knowledgeRecall.ts` → `knowledge/recall-pure.ts`

它是知识召回的三层里唯一**纯函数**的一层（词频/阈值/注入文本），只被 `knowledge/{recall,recall-log,tools}` 使用，
却住在 `shared/` —— 按 R1 判定为"仅宿主"。搬到 `knowledge/` 后 `shared/` 只剩真正的双端模块。
同步 14 处导入（src / test / scripts）与一处探针脚本的字符串路径。

### 6.3 api 层 SQL 清零（7 处 → 0）

| 原位置 | 收口到 |
| --- | --- |
| `api/routes.ts:447`（health schema_version） | `readMeta(db, 'schema_version')` |
| `api/routes.ts`（bootstrap 计划状态表） | `repo.taskStatusIndex()` —— 与 plans 路由**共用一份** |
| `api/routes/plans.ts`（同上，各写一份） | `repo.taskStatusIndex()` |
| `api/routes/helpers.ts`（报告用事件区间） | `repo.listTaskEventsInRange()`（camelCase 一次转完） |
| `api/routes/drafts.ts` ×2（直接 UPDATE 草稿状态） | `repo.setDraftStatus()` —— 绕过的正是唯一写入口 |
| `api/routes/asin.ts`（立项取产品摘要） | `repo.getAsinTaskSource()` |
| `api/routes/reminders.ts`（提醒存在性） | `repo.reminderExists()` |

三处顺带消掉了"同一语义两处实现"：计划状态表现在计划路由与 bootstrap 共用一份；
草稿确认不再绕过 `setDraftStatus`（它才是带时间戳/事件语义的唯一写入口）。

**验证**：`tsc` 0 error；`pnpm build` 0；`node --test test/*.test.mjs` **1544 项全绿**；
`test/architecture.test.mjs` 8/8 通过。

**剩余越层 SQL：1 处** —— 只剩 `experts/install.ts` 的 `PRAGMA database_list`（装专家时判断用的是哪个库文件，
SQLite 元信息查询，不是业务数据读写），已在 R7 白名单里写明理由。

### 6.4 第三批收口：通知队列 / 召回日志 / 零散查询（28 → 1）

| 原位置 | 收口方式 |
| --- | --- |
| `reminder/draft-notify.ts`（10 处） | 整块**存储层**搬到新模块 `db/repo/draftNotifyQueue.ts`：队列读写 + `task_drafts.notified_at`；`draft-notify.ts` 只留策略判定/静默汇总/发送编排 |
| `knowledge/recall-log.ts`（8 处） | 整文件搬到 `db/repo/knowledgeRecallLog.ts`（日志表读写 + 保留策略 + 会话级覆盖），语义与注释原样保留 |
| `reminder/config.ts`（2 处） | 改走 `repo/meta.ts` 的 `readMeta` / `writeMeta` |
| `reminder/scheduler.ts`（2 处） | 新增 `repo.taskPriorityCode()`（提醒定级）与 `repo.countTaskEventsWithNote()`（30 秒一轮的写事件去重） |
| `memory/review-memory.ts`（2 处） | 新增 `repo.getTaskReviewRecord()`；标题走既有 `repo.getTask()` |
| `knowledge/recall.ts`（2 处） | 全局开关走 `writeMeta`；任务树扩候选集走新增 `repo.listChildIds()` |
| `tools/workbench.ts`（1 处） | 默认投入走 `readMeta(db, 'default_estimate_minutes')` |

**验证**：`tsc` 0 error；`pnpm build` 0；全量 **1544 项测试全绿**；`architecture.test.mjs` 8/8。

> 一个反复出现的坑：`pnpm build` 返回后**立刻**跑全量测试，会偶发 `ERR_MODULE_NOT_FOUND`（刚写出的 `lib/**`
> 还没落地，实测两次、重跑即绿）。验证链应当是「build → 确认 `lib/` 里有新模块 → 再跑测试」，
> 而不是把两条命令塞进同一个管道里赌时序。

---

## 7. ⚠️ 并行施工提示（2026-10-27 11:04–11:08 实测）

本轮进行期间，**同一个工作树**上还有另一条线在改（时间戳证据）：

| 文件 | 时间 | 内容 |
| --- | --- | --- |
| `src/api/http.ts` | 11:04 | 新增 `apiOk` / `apiError` 统一响应信封（rebaseline §7 决策 2） |
| `src/api/routes/{aba-keywords,amazon-datasets,calculator-scenarios,inventory,keyword-plans,oplog}.ts` | 11:05 | 7 个 Amazon 路由改走信封 |
| `test/apiEnvelope.test.mjs` | 11:06 | 信封的新测试 |
| `src/client/styles.ts` | 11:08 | 样式改动（与本轮无关） |
| `docs/design/2026-10-27-architecture-rebaseline.md` | 11:08 | 决策 2 的结论回写 |

两条线在 `api/routes/{asin,drafts,helpers,plans,reminders,routes}.ts` **同文件交错**，
但双方都是用锚定字符串替换 + 追加，实测**两边的改动都还在**（`asin.ts` 同时有 `apiOk` 与 `getAsinTaskSource`），
tsc 与全量测试在合并后的树上通过。

**结论**：同一棵树上并行改代码时，任何 `读-改-写` 脚本都必须锚定唯一字符串并断言命中次数；
本轮 1 次 MISS 就是这么发现的（`product.judgment_json` 缩进不一致）。


## 8. 第四轮：装配瘦身（index.ts 723 → 33 行 + 设置域拆出）

### 8.1 入口拆成 `plugin/`（提交 `0873664`）

| 新模块 | 行数 | 职责 |
| --- | --- | --- |
| `plugin/apply.ts` | 60 | 开库 → 失败走降级 / 成功交给 `ready`（降级是"宿主还能起来"的唯一保证） |
| `plugin/ready.ts` | 412 | 数据库可用时的完整装配；文件头写明 4 条**顺序约束**（知识召回/专家服务先于路由、recover 先于技能 provider、逆序释放） |
| `plugin/commands.ts` | 168 | `/workbench`、`/expert` 两个斜杠命令（命令本体仍单独导出，单测直接驱动） |
| `plugin/prompt.ts` | 35 | 注入模型的常量文本（纯数据） |
| `plugin/probe.ts` | 21 | 可选服务软探测的**唯一实现**（"绝不写进 inject"这条规则的执行点） |
| `plugin/config.ts` | 49 | 配置项与目录覆盖口径 |
| `index.ts` | **33** | 只留对外表面：`name` / `inject` / `apply` / `workbenchCommandDefinition` / `Config` |

配套：新增 `test/_entrySources.mjs`（读"入口面"= index + plugin/*），10 个接线测试改成**读真实 owner**
而不是硬编码 `src/index.ts`。其中 `expertWiring` 的释放次序断言改成"**去注释后**的 ready.ts"——
注释里也会出现 `experts.dispose()` 字样，直接 `indexOf` 会把注释位置当成代码位置。

### 8.2 设置域拆出 `api/routes/settings.ts`（提交 `9fae1c1`）

`api/routes.ts` **463 → 308 行**。搬走的是：读模型 `readWorkbenchSettings` + 三个区间常量/读取器 +
`/settings` 的 GET/POST handler（原先 81 行内联）。

拆法上有一个刻意的选择：**读模型与写入口放在同一个文件**。这个 handler 历史上的 bug 是
"加字段时 GET/POST 只改一边 → 保存后开关自己变回去"，而分开两个文件正是让那件事更容易发生。

配套：`routes.ts` 从新模块 re-export 读模型（外部调用点不变）；`knowledgeRecallRoutes` / `expertWiring`
的判据改读 `routes/settings.ts`；`apiEnvelope` 的 `RAW_WRITEJSON_BASELINE` 278 → 282，
并在注释里补上"**纯搬迁例外**"的规则（默认仍不许上调，因为设置域的 5 处手写响应随文件搬进了被扫描集合）。

**验证**：`tsc` 0 error；`pnpm build` 0；全量 **1544 项测试全绿**。

### 8.3 这一轮暴露的协作问题

同一工作树上有另一条线在并行做 **D3 域解耦**（`status.ts` 摘掉 `asin.ts`、新增
`db/repo/task-completion-hooks.ts`、`findOpenTaskByAsin` 移到 asin 域、Amazon 路由前缀收敛）。
两次撞到的是同一件事：**我跑完验证、准备提交时，对方的半成品已经把 `tsc` 弄红**。

处置：只 `git add` 我自己那 5 个文件（`routes.ts` / `settings.ts` / 两个测试 owner 修正 / 棘轮基线），
对方的文件留给对方提交（他随后提交了 `7e2185c`）。**不要用 `git add -A` 在并行工作树上做"顺手一起提交"。**

---

## 9. 第五轮：构建配置去白名单（提交 `caaa5b4`）

`tsconfig.build.json` 原先是一份 **100 条逐文件白名单**。它的问题不是啰嗦，而是**没有守卫**：
新增模块忘了加一行 → 产物里没有这个文件，而 `tsc --noEmit`（走 `tsconfig.json` 的 `include: ["src"]`）**照样是绿的**。
表现是"本地跑得通、装盘后 ERR_MODULE_NOT_FOUND"。

现在构建配置只保留 emit 选项，`include` 继承基配置的 `["src"]`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "declaration": true, "outDir": "lib", "rootDir": "src" }
}
```

配套 `test/buildOutput.test.mjs` 三条断言：① include 不许回退成逐文件白名单（条目 ≤5 且不以 .ts 结尾）；
② **全部宿主侧源码**（`src/` 下非 `client/`）都有对应 `lib/**/*.js`（这条直接替代了"人记得加一行"）；
③ `lib/index.js` / `lib/client.js` / `lib/build-info.json` 三件套在位。

**代价（要知道）**：`lib/` 产物 209 → **267 个 js**，体积 4.8 MB。多出来的 58 个是此前不在白名单里的
client UI 模块（`client/index.js`、`app/*`、`views/*`）。"UI 该不该进宿主产物"仍是 rebaseline D1 的未决项 ——
现在它从"靠白名单间接控制"变成"显式要决定的事"，要么改代码排除目录并同步改测试的 import 口径，要么承认它只是惰性体积。

**验证**：`tsc` 0 error；`pnpm build` 0；全量 **1552 项测试全绿**。

> 又一次证明"白名单式配置"的代价：这一轮改完，立刻有测试**断言白名单本身**（`taskDetailWiring` 里
> "xlsx 必须在构建清单"），说明当年的设计把"配置写法"当成了契约。判据应该指向**结果**
> （产物在不在），而不是**实现**（有没有那一行）。

---

## 10. 回滚方式

三批各自一次提交，互不依赖：

```powershell
git revert 0a2d666   # 批次 A：断环
git revert 46ef287   # 批次 B：收编散件
git revert 021652f   # 批次 C：下沉 shared
pnpm build           # lib/ 是忽略目录，重新构建即可
```

`0b48478` 是重构前的基线提交（含 v1.18 Amazon 施工中的全部改动 + 修复后的 `styles.ts`）。
