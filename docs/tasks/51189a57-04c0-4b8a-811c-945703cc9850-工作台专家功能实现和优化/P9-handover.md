# P9 交接：出口批次（真实打包产物 / 独立宿主 / 真实 HTTP 与真实浏览器 / 模型链路如实未验证）

> 给后续批次与维护者。
> 本批做的是**出口验证**，不写产品代码：把 P1–P8 的成果放进**本次真实打包产物**与**独立宿主实例**里，用一条新的白名单套件
> `scripts/verify/suites/expert.mjs` 覆盖 **AX-E59–E62**，并把 P8 遗留的 **B 层**（AX-E52–E58 的真实浏览器 DOM/点击）一并补齐。
> 施工计划：`implementation-plan.md:318-342`；硬规则：`docs/adr/0006-dev-verify-chain.md`；上游交接：`P8-handover.md`（其 §9 的 10 条接线义务是本批的输入）。
> **本批不改任何产品源码**（`src/**`、`test/**`、`package.json`、`pnpm-lock.yaml` 全部零改动），只新增/修改 3 个验证脚本 + 3 个文档。

---

## 1. 交付物

分支 `feat/workbench-experts`，**未提交、未 push**（`git rev-list --left-right --count origin/main...HEAD` = `2  9`：本批期间 `origin/main` 被另一会话推进了 2 个提交，我方 9 ahead；按边界要求**不 rebase、不 push**）。

| 文件 | 状态 | 行数 | 字节 | sha256（大写） | 说明 |
|---|---|---|---|---|---|
| `scripts/verify/suites/expert.mjs` | **新增** | 1115 | 67709 | `C569DFAC6BBB416FA2B7AF3BC35F80871167225B9911C44A428A7B97E7F5E65D` | 出口套件：AX-E59–E62 + P8 的 B 层。U/H/B 三层 + 1 条 N 层自检 |
| `scripts/verify/suites.json` | 修改 | 221 | 7813 | `A75345861925F21238803EB69D69D8757FD4A08D0B23D335C2CA0537F67AD48F` | `+14 −0`：新增 `expert` 条（`active` / `required:true` / `axIds:[AX-E59,E60,E61,E62]`），排在 `persona` 之后（**列表末位**） |
| `scripts/verify/suites/progress.mjs` | 修改 | 341 | 20641 | `A8FCF8299A2B53228237776DAE71DE9C69E997393EFD51E08C6CEFD1972BFAC6` | `+53 −1`：**只加永久诊断**（`report.after25`），判定与阈值一个字没改 —— 取证用，见 §11-3 |

三个文件全部 **CRLF=0**、无 BOM、以 LF 结尾（`crlf=0` / `loneLf=1108|221|341` 逐字节统计）。

**没有改的**（这条比改了什么都重要）：`src/**`、`test/**`、`package.json`、`pnpm-lock.yaml`、`scripts/dev-verify.mjs`、`scripts/verify/runtime.mjs`、`scripts/verify/suites/_harness.mjs`、`scripts/check-verify-scripts.mjs`、`docs/adr/**`（`0009-*.md` 仍是 **proposed**，按 P9 第 7 条不动）。

---

## 2. 关键导出与形状（逐字，已核对）

本套件**完全走 `_harness.mjs` 既有契约**，没有新造机制：

- `startSuite({ id, title, url, evidenceDir, legacyIds, axIds })` → `suite`；判定统一走
  `suite.check({ id, axId, layer, ok, detail, skipped, skipReason })` —— **只有 `ok === true` 才算 pass**；
  前置缺失一律 `suite.require(entry)`（**记 fail，不记 skip**；文案逐字「前置缺失一律记失败（不许条件少测）」）。
- `parseSuiteArgs()`：`--evidence-dir` / `--user-data-root` / `--target-profile` / `--target-profile-dir` / `--db-path`；
  **token 只从环境变量 `DSH_VERIFY_TOKEN` 读**（故意不进 argv、绝不写盘）。
  注意 `_harness.mjs:54-65` 的两组参数**不是一回事**：`options.profile` 来自环境变量 `DSH_PROFILE`（= **当前会话所在实例**，本机是 `desktop`），
  目标实例必须用 `options.targetProfile` / `options.targetProfileDir`。
- 真实 HTTP：`createApi(url, { token })` + 本套件自带的 `sessionApi` 包装。**本机宿主的认证真相**：
  `GET /?token=<t>` → `303` 且 `Set-Cookie: dsh-auth-*`；**裸 `Authorization: Bearer` 一律 401**
  （health 路由豁免）。所以 `login()` 先拿 cookie（`response.headers.getSetCookie()`），后续请求同时带 cookie 与 bearer。
  cookie **只在进程内存**，绝不进证据。
- 真实浏览器：`launchSuiteBrowser({ url, token, userDataRoot, browserPath, headless })` + `ensureWorkbenchPanel(browser, …)`；
  独立 `user-data-dir`（否则 CDP 会静默转发给已有实例：**什么都不发生还 exit 0**）；侧栏「工作台」入口是**开关**，必须先读 `data-open`。
- **跨进程真值**：`node:sqlite` 的 `new DatabaseSync(dbPath, { readOnly: true })` 直读 `task_drafts` 表，
  用来证明「用户确认前正式库为空」/「放弃后确实不是 pending」——**不是读接口自报**。
- 层名只用 `CHECK_LAYERS = new Set(['U','H','W','B','N'])`（**没有 'M'**）；3 条真实模型断言按
  `scripts/verify/suites/persona.mjs:230` 的同口径记 `layer:'B'`。

`scripts/verify/suites.json` 里新增的条目逐字：

```json
{
  "id": "expert",
  "kind": "new",
  "required": true,
  "status": "active",
  "repoPath": "scripts/verify/suites/expert.mjs",
  "axIds": ["AX-E59", "AX-E60", "AX-E61", "AX-E62"],
  "reason": "…"
}
```

---

## 3. 接线点与所有权

- **白名单是唯一入口**：`scripts/verify/suites.json` 决定链里跑什么；`node scripts/check-verify-scripts.mjs` 是门禁
  （现役 11 / 待迁移 0 / 作废 3，退出码 **0**）。新套件不登记就永远不会被链跑到。
- **`required: true` 的真实含义**（`scripts/dev-verify.mjs:455-494`）：套件 `failed>0` 或分数 0 或 `status!==0` → 链 fail；
  更狠的一条是 `required === true && skipped > 0` → **只有出现在 `ALLOWED_REQUIRED_SKIPS` 里的跳过条目才被放过**
  （该名单在 `scripts/dev-verify.mjs:74-80`，当前**只有 persona 一条**）。
  按 P9 第 1 条「**不允许新增隐式 skip 白名单**」，本套件的 3 条真实模型跳过**没有登记** ⇒ 链在 suites 阶段判**不通过**。
  这是**设计好的诚实口径**，不是待修的 bug（见 §8-1、§9-1）。
- **链的阶段与副作用**：`scripts/dev-verify.mjs` 13 阶段；本批所有真实执行都指向 **3080 / profile `web` / DB `verify-web.db`**（预授权范围），
  **从未**指向当前会话实例的 19387 / `desktop`（ADR 0006 硬规则），也从未写它的 DB。
- **`test-results/workbench-verify/<runId>/`** 是链的证据根；每套件自己的证据在 `<runId>/suite-<id>/`。

---

## 4. 命令与退出码（全部实际执行过）

| # | 命令 | 退出码 | 说明 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | 本批没改 `src/**`，属基线复跑 |
| 2 | `pnpm build` | **0** | buildId `wb-8181274a3900fe0b`（206 个输入） |
| 3 | `node scripts/check-verify-scripts.mjs` | **0** | 现役 11 / 待迁移 0 / 作废 3 |
| 4 | `pnpm test` | **0** | `pnpm build && node --test test/*.test.mjs` ⇒ `tests 1289 / pass 1289 / fail 0 / skipped 0`（与 rebase 后基线一致，**新增失败 0**） |
| 5 | `node scripts/verify/suites/expert.mjs …`（单跑） | **0** | `{"passed":29,"failed":0,"skipped":3,"total":32}` |
| 6 | `node scripts/verify/suites/legacy-acceptance.mjs …`（单跑复核） | **0** | `18/18`（用于定性链里那次抖动，见 §11-2） |
| 7 | `node scripts/dev-verify.mjs …`（**真实链，去 `--dry-run`**） | 见 §5 | 实参逐字：`--url http://127.0.0.1:3080 --profile web --profile-dir 'C:\Users\<user>\.dsh\profiles\web' --db-path 'C:\Users\<user>\.dsh\workbench\verify-web.db'` |

`pnpm test` 的逐字计数：`tests 1289 / suites 0 / pass 1289 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 12111.87`。

---

## 5. 独立证据（真实链实跑）

### 5.1 两次被**浏览器层抖动**掐断的链（不是断言失败，也不是本批引入）

同一份代码、同一条命令链一共跑了 4 次，其中 **2 次**在 `legacy-acceptance`（链里第 2 个套件）被浏览器掐断：

| 链 | 证据包 | `legacy-acceptance` 结果 | 逐字现象 |
|---|---|---|---|
| 第 3 次 | `test-results/workbench-verify/20261005-211823-3cc7dc/` | `1 pass / 2 fail / 0 skip`（48652ms） | `可见=0 明细=[]`；note：`等待 45s 仍无可见入口，快照：{"sidebarFound":false,"rows":[],"dataOpen":null}` |
| 第 5 次 | `test-results/workbench-verify/20261005-212429-c6d805/` | `8 pass / 0 fail / 0 skip` + `fatal` | `CDP 调用超时（30000ms，方法 Page.captureScreenshot）—— 页面可能被对话框/挂起阻塞` |

- **定性**：两次都是「宿主刚 `restart` 完，Edge 用**全新 user-data-dir** 冷启动，首屏/截图跟不上 30–45s 的窗口」。
  同一条 3080 实例上**单跑** `legacy-acceptance.mjs` 立刻 **18/18 / exit 0**（§4 第 6 行）；
  第 4、6 次链里该套件是 **18/0/0（13531ms / 13537ms）**。
- **不是本批引入**：本批只碰 3 个验证脚本，`legacy-acceptance` 连一行都没改；且失败发生在 `expert` 套件之前。
- **链的语义**：第一个失败/致命的套件会 `stop()`，所以这两次后面的套件（含 `expert`）**没有跑到**。
- 已列入 §9-6 / §10-2，交给后续批次定位（怀疑与冷启动/首屏渲染竞态有关）。

### 5.2 最终一次链（第 6 次）：**11 个套件全部跑到**，`expert` 29/0/3

`node scripts/dev-verify.mjs --url http://127.0.0.1:3080 --profile web --profile-dir 'C:\Users\<user>\.dsh\profiles\web' --db-path 'C:\Users\<user>\.dsh\workbench\verify-web.db'`
（**去掉 `--dry-run`**，实参与 §4 第 7 行逐字相同）

- **退出码 1**，证据包 `test-results/workbench-verify/20261005-212614-a85655/`（195798ms，另有 11 份 `suite-*.json` + 11 个同名证据目录）。
- **health**：`版本 1.16.5 / buildId wb-8181274a3900fe0b / schema 19`。
  `buildIdentity` 三方一致、`matched:true`、`mismatches:[]`：
  `package {version 1.16.5, buildId wb-8181274a3900fe0b}` / `health {1.16.5, wb-8181274a3900fe0b, schema 19}` / `client wb-8181274a3900fe0b`（`clientSource: suite-legacy-acceptance.json`）。
- `sideEffects`：`{"installed":true,"restarted":true,"dbWrites":0,"browsersOpened":0,"tempDirsRemoved":1}`。
- 每套件计数（逐字来自 `summary.md` 的「套件」表）：

| 套件 | 结论 | 通过 | 失败 | 跳过 | 耗时 |
|---|---|---|---|---|---|
| verify-safety | pass | 20 | 0 | 0 | 6464ms |
| legacy-acceptance | pass | 18 | 0 | 0 | 13537ms |
| legacy-final-2 | pass | 9 | 0 | 0 | 6549ms |
| legacy-sidebar-collapse | pass | 6 | 0 | 0 | 17491ms |
| legacy-duplicate-task | pass | 11 | 0 | 0 | 16242ms |
| progress | pass | 13 | 0 | 0 | 21461ms |
| daily-effort | pass | 13 | 0 | 0 | 39155ms |
| day-panel | pass | 11 | 0 | 0 | 14273ms |
| workspace-picker | pass | 8 | 0 | 0 | 16172ms |
| persona | pass | 12 | 0 | 1 | 9239ms |
| **expert（本批新增）** | **pass** | **29** | **0** | **3** | 16517ms |

- **链为什么还是 fail**（逐字）：`✖ [suites] 必需套件 expert 有 3 项被跳过且未登记：AX-E60 ⭐ 真实模型调用专家草稿提交工具并落库（模型链路）｜AX-E61 ⭐ 真实模型：父绑定 A 时 @ 专家 B，子代理走专用 loader 且父仍为 A（模型链路）｜AX-E62 ⭐ 真实模型：auto=true 自主召唤、关闭后该轮无自主 schema/prompt（模型链路）`。
  `expert` 套件自身 `exitCode: 0`（`{"passed":29,"failed":0,"skipped":3,"total":32}`）——
  fail 完全来自「`required:true` + 有未登记的跳过」这条链级规则。**这是 P9 要的诚实口径**（§8-1）。
- **模型层这一次真的发车了**（不再是"没开开关"）：套件默认就去 spawn，链证据里留下了真机结论 ——
  `suite-expert/expert-readings.json` 的 `layers.model.findings.probed[0]`：
  `{"kind":"dsh headless","profile":"web","code":1,"stdoutBytes":0,"stderrTail":"error: unknown option '--json'\n"}`，
  `reason` 逐字「本机没有可用的 web-profile headless 入口（退出码 1；stderr: error: unknown option '--json'）：`headless` 在本机 DSH 里是 profile 名而非 web profile 的子命令，真实模型链路需走目标实例自己的会话 API，本次未实现」；
  另有 `suite-expert/model-run-stderr.txt`（31 字节）、`model-run-stdout.txt`（0 字节）。
- **B 层的图片证据**（`<runId>/suite-expert/`）：`01-面板.png`、`02-设置.png`、`03-专家管理.png`、`04-新建专家弹窗.png`、
  `05-已输入.png`、`06-已选工作区.png`、`99-收尾.png`（另 `expert-readings.json` 9727 字节 / `summary.json` 14467 字节）。
- **同一条链的第 4 次**（`…/20261005-212017-46dbe5/`）在**改模型层口径之前**也跑满了 11 个套件，
  逐套件计数与本次**逐条相同**（expert 同为 29/0/3，只是那次的模型层 reason 是旧文案「未开启真实模型链路」）——
  可作为"计数可复现"的旁证。

---

## 6. 包清单核验（AX-E59，对**本次**真实打包产物）

本次链自己打出来的包（`_local-build/current.txt` 指向它）：

- 文件：`_local-build/dsh-personal-workbench-dev-a327aa8-20261005-212021.tgz`（**2648241 字节 / 311 个 tar 条目**；包内版本 `1.16.5`）。
- 本次三次链的 tgz 字节数完全一致（`…-20261005-210809` / `…-211827` / `…-212021` 都是 2648241），说明打包是**输入决定**的（与 buildId `wb-8181274a3900fe0b` 的内容哈希口径一致）。

**该有的都有**（逐类计数，逐字来自 `<runId>/suite-expert.json`）：

| 类别 | 计数 | 判据 |
|---|---|---|
| 随包方法论文档 `assets/expert-generation/methodology.md` | 在 | 生成入口的前置资产（H 层 `GET /experts/methodology` 返回 4047 字符正文） |
| 新 `lib/experts/**`（P1–P6 的编译产物） | **24 个文件** | 证明 P1–P6 的源码真的进了产物，不是只留在 git 里 |
| `lib/**` 总量（含 `lib/client.js` / `lib/index.js`） | **280 个文件** | 客户端与服务端入口都在 |
| 原有 personas `assets/personas/**/*.md` | **15 篇** | 新增专家功能没有把原有角色挤掉 |
| 许可原文 | **3 份** | `LICENSE` / `LICENSE-novotnyllc-dotnet-artisan` / `LICENSE-K-Dense-scientific-agents` |

**不该有的都没有**（全部计数为 0）：暂存区 `.pending/**`、测试源码 `test/**`、证据包 `test-results/**`、
开发打包产物 `_local-build/**`、历史存档 `_local-archive/**`、浏览器临时目录 `browser-temp/**`、
源码 `src/**`（包只发 `lib`）、日志 `*.log`、临时目录名里的 `verify` 痕迹。

**泄漏扫描**：扫描包内 **300 个文本条目**，本机绝对路径（`C:\Users\<name>…`）与 UNC（`\\<host>\<share>`）
命中 **0**。（这条判据第一版是**假红**的：它命中了 `src/personas/resources.ts:16` 注释里的 `拒绝 UNC（\\host\share）`
与 `:81` 的正则源码 —— 修法是先 `stripComments` 再扫，并把模式收窄到"真实路径形状"，不是放宽到"什么都不查"。）


---

## 7. AX 对账（AX-E59–E62 + P8 的 E52–E58）

行号均为 `scripts/verify/suites/expert.mjs` 里 `suite.check` / `suite.require` 的**起始行**（本批复核时逐条打开核对过）。

| AX | 层 | 结果 | 断言行号 | 判据要点 |
|---|---|---|---|---|
| **E59** 包内容/无泄漏 | U | ✅ | `:207` `:222` `:242` `:264` `:292` `:321` | 找到本次链真实打出的 tgz → gzip 解压 → 条目非空且包内版本与 `package.json` 一致 → **该有的都有**（方法论文档 / 新 `lib/**` / 原有 personas / 三份许可，逐类计数）→ **不该有的都没有**（`.pending` / 测试数据 / TEMP 证据 / 源码 / 日志）→ 包内文本无本机绝对路径与 UNC 泄漏 |
| **E60** 生成草稿 + 确认前正式库为空 | H | ✅ | `:370` `:380` `:390` `:460` `:470`(require) `:510` `:519` `:528` `:547` `:580` | capabilities 四项都带 `available/reason`；`generation.available=true`；methodology 返回真实全文；`POST /experts/generation-start` 建出 `statusCode=pending / phase=editing / contentVersion` 为数字的草稿；**直读 SQLite** 证明新草稿只落在 `task_drafts(pending)`、`generated/` 与 personas 正式根零新增；`GET /experts/drafts/:id` 读回 `draftId/phase/contentVersion/drift` |
| **E61** 手动入口 + 身份 CAS | H | ✅ | `:588`(require) `:593` `:631` `:638` | `POST /experts/preflight` 给可用性预检（HTTP 侧如实 `preliminary:true`，**不假装权威**）；`POST /experts/manual-requests` 身份按 catalog 逐字传 → 200 带 `requestId/expiresAt`；**身份对不上 → 400 `revision-changed` 且 `field='expected_source_key'`，且不建请求**（这条是本套件唯一能真红的 CAS 判据，见 §11-4） |
| **E62** auto 开关 | B | ⏭ skip | `:746` `:1051` | H/B 层已证开关渲染与状态；**「auto=true 时模型自主召唤、关闭后该轮无 schema/prompt」需要真实模型链路**，本机不可用 ⇒ 如实 `skip` |
| E52 生成入口 | H+B | ✅ | `:674`(require) `:683`(require) `:717`(require) `:741` `:755`(require) `:768` `:791` `:832` `:854` | 真实浏览器：发现浏览器 → 打开工作台面板 → 点「设置」→ 专家管理里有 `data-wb-expert-action="create"` → **真实鼠标点**「新建专家」→ 弹出 `data-wb-experts="create-modal"` 且含 `request`/`workspace` 两字段 → 空文本禁用 → **清空工作区后即使有文本也禁用**且出现 `data-wb-expert-error="no-workspace"` → 选回工作区解禁 |
| E53 生成失败路径 | H | ⏭ skip | （模型链路） | 五条失败路径的**假 runtime**覆盖在 P8（`test/expertClientFlow.test.mjs:341` 起）；真实链上要跑它们必须能驱动一次真实生成，本机不可用 |
| E54 四态按钮 + 校验 | H+B | ✅ | `:528` `:547` `:776` | `GET /experts/drafts/:id` + `POST /drafts/:id/validate` 真跑校验（200/`ok:true`/`validation.errors` 是数组/有 `manifestHash`）；真实 DOM 里弹窗**没有**「创建任务」假文案 |
| E55 版本 CAS | H | ✅ | `:538` | 用过期的 `expectedVersion` 打 `validate` → **409**（版本 CAS 真的在拦，不是只写在文档里） |
| E56 目录/坏行/行列选择器 | H+B | ✅ | `:418` `:736` `:902` | `catalog` 200 且 `experts`（管理行）与 `personas`（可选择摘要）都在、每行带 `id/source/status`；真实 DOM 里 `data-wb-experts="admin"` 可见、**15 行**每行都带 `data-wb-expert-id` + `data-wb-expert-status` |
| E57 auto 开关渲染 | B | ✅ | `:746` | 真实 DOM 渲染出 `data-wb-expert-field="auto-summon"` |
| E58 卸载/状态保留 | B | ✅ | `:880`(require) `:897` | 点 create-modal **自己**的「取消」（限定作用域，见 §11-5）→ modal 从 DOM 卸载，而专家管理根与它的 catalog 状态**仍在**（`rows=15`） |
| — | — | ✅ | `:1073` | N 层自检：本套件用到的层名都在 `CHECK_LAYERS` 口径内 |

**真实模型相关的 3 条**（AX-E60 的落库那一半、AX-E61 的子代理 loader、AX-E62 的自主召唤）**全部如实 `skip`**，
`skipReason` 写明「本机没有可用的 web-profile headless 入口（退出码 1；stderr: `error: unknown option '--json'`）：
`headless` 在本机 DSH 里是 profile 名而非 web profile 的子命令，真实模型链路需走目标实例自己的会话 API，本次未实现」。
结论按施工计划第 9 条如实写：**实现检查通过、模型链路未验证**。

---

## 8. 规格偏差（逐条：出处 → 实际 → 理由）

1. **`required:true` 的套件带 3 条 skip ⇒ 链判不通过**。出处：P9 第 1 条「拿不到真实模型就如实 skip（required+skipped 由链判不通过）」。
   实际：`expert` 未登记进 `ALLOWED_REQUIRED_SKIPS`，链在 suites 阶段 fail。
   理由：**刻意如此**。P9 明令不许新增隐式 skip 白名单；把 3 条模型断言登记成「允许跳过」等于把未验证伪装成通过。
2. **AX-E53 / 部分 E54 的「真实链」覆盖改由 H 层 + P8 单测承担**。出处：AX 表要求 E53 五条失败路径。
   实际：真实链上跑这五条需要能驱动一次真实生成（模型），本机不可用；P8 已用注入式假 runtime 覆盖到每一个 await 之后。
   理由：不为凑覆盖去伪造模型响应。**E53 在本套件里没有 ✅**，如实记未验证（§9）。
3. **`generation-start` 只写 DB 行、不建暂存目录**。出处：AX-E60 要求「草稿待确认」。
   实际：`POST /experts/generation-start` 只落 `task_drafts`；`.pending/<draftId>/` 要等 `stageFile` 才落盘。
   理由：判据改成「DB 行是 pending + 正式库零新增」这条**真会失败**的判据，「暂存目录存在」只作弱判据并注明起步时可以是空目录。
4. **`manual-requests` 的陈旧身份是 400 不是 409**。出处：P8/规格口径写 409。
   实际：真机 `400 + revision-changed + field=expected_source_key`；`src/client/expertInputSource.ts:358` 逐字「服务端当场 `revision-changed`（400）」。
   理由：以代码为准（首轮我按 409 写，链里真红，是**我的断言错**，已改）。
5. **层名没有 'M'**。出处：P9 第 1 条写的层次口径含 M（真实模型）。
   实际：`CHECK_LAYERS` 只有 `U/H/W/B/N`；`persona.mjs:230` 的真实模型断言也记 `layer:'B'`。
   理由：跟既有口径，不新造层名。
6. **`options.profile` ≠ 目标实例**。出处：我以为 `--profile` 会给套件目标 profile。
   实际：`options.profile` 来自环境变量 `DSH_PROFILE`（= 当前会话实例 `desktop`）；目标实例在 `options.targetProfile`。
   理由：`_harness.mjs:54-65` 逐字区分了两组；第一次探测因此拿到 `error: profile "desktop" is managed exclusively by the Electron application`，已改。
7. **`progress.mjs` 被本批改了一行判定之外的东西**。出处：P9 只要求新增 `expert.mjs` + 登记。
   实际：`+53 −1` 全是**诊断字段**（点击前坐标/命中元素/点击通道/之后的重读）。
   理由：链上出现过 2 条偶发假红，没有诊断就无法定性（§11-3）；判定与阈值未改，回归数字不变。

---

## 9. 未验证项（如实标注，一律不算通过）

1. **真实模型链路**（AX-E62 全部、AX-E60 的「模型提交草稿并落库」、AX-E61 的「子代理走专用 loader 且父绑定仍是 A」）：
   本机没有可用的 web-profile headless 入口，套件如实 `skip`，链因此不通过。
2. **AX-E53 五条失败路径**在**真实链**上未跑（P8 注入式单测覆盖，见 §8-2）。
3. **auto 开关对真实自主召唤行为的因果**未验（只验了开关的渲染/取值与 H 层语义）。
4. **生成内容质量**（原创专家的人格正文是否可用）未验。
5. **卸载/重装/升级路径**、**macOS / Linux** 未测。
6. **链的稳定性**：本批 4 次真实链里有 **2 次**被浏览器层掐断（同一套件 `legacy-acceptance`、同一条 3080 实例：
   一次「45s 内没渲染出侧栏入口」、一次「`Page.captureScreenshot` 30s 超时」），单跑立刻 18/18；未定位到确定性根因（§5.1）。

---

## 10. 给后续批次/用户的接线义务

1. **让 3 条模型断言真跑起来**（这是本批唯一「不通过」的原因）：走**目标实例自己的会话 API** 驱动一次真实会话，
   或给 `headless` 单独叠插件层后按会话日志取证；拿到证据后把 `expert` 的模型层从 `skip` 改成 `pass`。
   **不要**为了变绿去登记 `ALLOWED_REQUIRED_SKIPS`。
2. 复核 §5.1 的浏览器首屏抖动：若再现，在 `legacy-acceptance` 的等待窗口里加「先等一次 reload / 等 client bundle 就绪」的证据。
3. 真机核对 P8 §7-11（设置页专家列表由分组章节改扁平行）是否符合预期。
4. 提交与 push 由用户/主会话决定：本批**停在交接**，未 `git add`、未 commit、未 push。

---

## 11. 复核与修复记录

- **本批修的全部是「我的断言错」，不是产品缺陷**，共 4 轮：
  1. `draft.id` → `draftId`（专家草稿视图字段名）；
  2. `manual-requests` 陈旧身份 409 → **400**；
  3. 点「设置」用全局 `button` 选择器命中了**宿主侧栏**的设置 ⇒ 限定 `.wb-h button`；
  4. 「填了文本仍禁用」在真机假红（工作区下拉初值非空）⇒ 改成**三步判**：空文本禁用 → **清空工作区**后禁用且出 `data-wb-expert-error="no-workspace"` → 选回工作区解禁。
- **一条真实产品/工具链 bug（我的套件造成的跨套件污染，已修）**：放弃专家草稿时 `POST /api/workbench/drafts/:id/abandon`
  **必须带 body**（`src/api/routes/drafts.ts:291-346`：`body===undefined` → 400 `invalid-json`；缺 `expectedVersion` → 400 `invalid-payload`）。
  旧写法恒 400 ⇒ 草稿永远 pending ⇒ `DraftBanner` 每 5 秒轮询把它弹成「待确认：新建专家」横幅（`DraftBanner.tsx:669`）
  ⇒ **同一条链上后面的 `progress` 套件被横幅盖住进度卡**，偶发 2 条假红。修法：带 `{expectedVersion}` + 判据收紧为
  「200 且 DB 复读已不是 pending 且正式库零新增」+ `finally` 安全网。修完 `progress` 13/13、后续链上不再复现。
- **主会话的边界内复核**：`git status` / `git diff --numstat` 确认只碰了上述 3 个文件；`pnpm test` 1289/1289/0。

### 11.1 主会话独立复核（2026-10-05，本文件交付后由主会话亲自执行；上面 4 条是子代理自述）

1. **静态对齐**：6 个交付文件的 sha256 / 字节 / 行数逐项对齐（`expert.mjs` 1115 行 / `C569DFAC…E65D`、`suites.json` 221 行 / `A7534586…D48F`、`progress.mjs` 341 行 / `A8FCF829…FAC6`、本文件 287 行 / `E571728B…C496`、`verification.md` 638 行 / `DCF8C04A…EDAA`、`执行日志.md` 198 行 / `74D089C0…CB81`），全部 CR=0、无 BOM。`git status --porcelain -- src test package.json pnpm-lock.yaml docs/adr scripts/dev-verify.mjs scripts/verify/runtime.mjs` **为空** ⇒ 产品源码、既有链实现、ADR 全未被碰。
2. **diff 审读**：`suites.json` = 仅 `+14 −0`（`active` + `required:true` + `axIds` AX-E59–E62）；`progress.mjs` = `+53 −1`，被删的**只有 1 行**（`report.after25 = { api: …, dom: … }` 换成更宽的诊断对象），新增行里**没有任何** `passed/failed/skipped/total/assert/exitCode` 相关改动 ⇒「只加诊断、判定与阈值未改」属实。
3. **命令复跑**：`node scripts/check-verify-scripts.mjs` = **0**（现役 11 / 待迁移 0 / 作废 3）；`pnpm test` = **tests 1289 / pass 1289 / fail 0**、退出码 **0**。
4. **套件独立复跑**：取 `%TEMP%\dsh-server-3080.log` 里**最后一个** `token=` 自己登录，`--db-path` / `--target-profile-dir` 齐备时复现 **29 pass / 0 fail / 3 skip**（退出码 0，`failedChecks: []`）。**故意漏传 `--db-path`** 的那次得到 **27/2** 并把 `no such table: task_drafts` 报成失败 —— 这同时证明 H 层的 ⭐ 判据**真的在读目标 SQLite**（不是假绿），也暴露一条诊断改进项：缺 `--db-path` / `WORKBENCH_EXPECTED_DB_PATH` 时应直说"缺目标 DB 路径"，而不是让错误表现为"表不存在"（已记入接线义务）。
5. **独立清点 tgz**（不看子代理结论）：`_local-build/current.tgz` = **2 648 241 字节 / 311 条目**；`assets/expert-generation/methodology.md` 1、`package/lib/experts/**` 24、`package/lib/**` 280、`assets/personas/**.md` 15、LICENSE 3、禁止项（`.pending/` / `test/` / `test-results/` / `src/` / `*.log` / `_local-build/`）**0**。解包后对 **302** 个文本条目扫真实本机路径（`<user>` / `.dsh\profiles` / `<company>` / `AppData\Local\Temp`）命中 **0**；另有 10 处是**注释里的通用示例路径**（如 `D:\Code\my-repo`、`D:\code\my-project`），非本机泄漏、与本批无关。
6. **反向注入（主会话自选，第 7 处独立证据）**：把 `current.tgz` 里的 `assets/expert-generation/methodology.md` 抽掉后用 bsdtar 重打成新的 `current.tgz`，同时把 `_local-build/current.txt` 让位，单跑套件 ⇒ **AX-E59-a「包内该有的都有」变红**（28 pass / 1 fail / 3 skip、退出码 1）。还原 `current.tgz` 后 **sha256 `04EC5648…39A0` 与原值逐字节一致**、`current.txt` 原样（`_local-build/` 是派生物，未进 git）。**口径说明**：该变异包是 bsdtar 重打的（333 条目 vs 出厂 311），所以同批变红的另外 3 条 U 层判据（可解压/不该有的/无泄漏）**不能**单独算作那 3 条的灵敏度证据 —— 本注入只证明「该有的都有」这条真的会失败，且 U 层对异常归档 **fail-closed**（不假绿）。
7. **链证据独立读数**：`test-results/workbench-verify/20261005-212614-a85655/summary.json` 的 `buildIdentity.matched=true`、`sideEffects={"installed":true,"restarted":true,"dbWrites":0,"browsersOpened":0,"tempDirsRemoved":1}`、11 个套件计数与报告逐条一致（`persona 12/0/1`、`expert 29/0/3`）。直接问 `http://127.0.0.1:3080/api/workbench/health` = **`1.16.5` / `wb-8181274a3900fe0b` / schema 19**（确认真机确实在跑我们的构建，不是旧包）。
8. **文档笔误修正**：`verification.md` §5 的 P9 行原写「`expert.mjs`（1108 行）」，实为 **1115 行**，已由主会话改正并补上 sha256 与本次复核结论。

---

## 12. 过程事实（给下一个执行模型）

1. **「改源码 → 必须先 `pnpm build` 再跑测试」**：测试 import 的是 `lib/**` 产物。
2. **`pnpm build 2>&1 | Select-Object -Last 3` 会吞掉退出码与 `error TS`**：退出码单独读 `$LASTEXITCODE`。
3. **本机宿主认证是 cookie 不是 bearer**：`GET /?token=<t>` 拿 `Set-Cookie: dsh-auth-*`；裸 bearer 401（health 豁免）。
4. **动态 import 本地 `.mjs` 必须用 URL**：Windows 绝对路径会被 ESM loader 拒（`Only URLs with a scheme in: file, data, and node are supported … Received protocol 'd:'`）⇒ 用 `pathToFileURL(p).href`。
5. **真实浏览器的坑**：点侧栏入口是**开关**（先读 `data-open`）；CDP 必须独立 `user-data-dir`（否则静默转发给已有实例、什么都不发生还 exit 0）；`launchSuiteBrowser` 必须显式给 `browserPath`（先 `discoverBrowser()`）。
6. **点击要用限定作用域**：宿主侧栏自己也有「设置」「取消」，全局文案匹配会点错（本批踩过两次：设置入口、取消按钮）。
7. **`scripts/` 下临时脚本的相对 import 是 `./verify/...`**（写 `../verify/...` ⇒ `ERR_MODULE_NOT_FOUND`）。
8. **数失败一律用 node 自己的 `fail n` 计数**，不要 grep `✖`（`✔`/`✖` 会出现在用例名与说明文本里）。
9. **临时脚本**：本批用过 2 个探针（`scripts/probe-expert-http.mjs`、`scripts/probe-progress-click.mjs`），**交接前已删**。
10. **链的首个失败套件会 `stop()`**：排在后面的套件不会跑 —— 想拿全套件计数，先保证前面的绿。

---

## 13. 后续批次指针（P10，只追加、不改上面任何内容）

P10（2026-10-05，`feat/workbench-experts` 分支）接在本文件之后，专做 P9 里那 3 条**模型层 skip** 的转正：
把 `scripts/verify/suites/expert.mjs` 的 `AX-E60` / `AX-E61` / `AX-E62` 从 `skip` 改成走**真实 DSH 会话通道**
（插件客户端新建独立会话 → `session.prompt(..., 'queue')` → 该会话自己的 AI 调 5 个生成工具）的真检查，
并如实补齐本文件 §11.4「链证据」与 §12 之外的过程事实。

- **完整交接**：同目录 [`P10-handover.md`](./P10-handover.md)（目标、机制代码位置、AX 逐条结果与证据、
  命令与退出码、规格偏差、未验证项、给后续的义务）。
- **施工记录**：同目录 [`verification.md`](./verification.md) 的 **§17**。
- **过程事实**：`docs/tasks/ed644638-f9a0-45cf-a32f-90df7d060dda-工作台专家功能实现和优化/执行日志.md` 的 **P10 过程事实**段。
- **本文件不需要回改**：P10 若发现本文件某条结论与实测不符（例如「`@` 源造不出 AX-E61」），
  一律在 P10 的文档里更正并注明"更正 P9 §x"，**不回写本文件**，以便保留 P9 当时的判断现场。