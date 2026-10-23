# P11 交接 — 修 `generation-start` 契约形状错配 + 让验收真判「产品自己派发」

- 批次：**P11**（P10 真机验收打出来的产品缺陷修复 + 验收判据补强）
- 前置：`P10-handover.md`（把 3 条模型层 skip 改成走真实会话通道的真检查）、`verification.md §17`
- 一句话结论：**P0 级产品缺陷已修，并在真实独立实例上复验通过** —— 用户点「新建专家 → 开始生成」之后，
  **产品自己**把提示词发给了模型（`findings.dispatchPath="plugin-queued"`，探测到那一刻套件发过 **0** 次真实 prompt），
  真实模型在独立会话里调了 5 个草稿工具、草稿落进目标库并校验通过、确认前正式角色库为空。
- 套件计数：P10 末 `{"passed":33,"failed":0,"skipped":2,"total":35}` → P11 末 `{"passed":34,"failed":0,"skipped":2,"total":36}`
  （**新增的那 1 条**就是 §5 的 `AX-E60 ⭐` 产品派发检查）。
- 状态：**未提交、未 push**（交付物见 §10，提交建议见 §12）。

---

## 1. 缺陷：客户端把服务端草稿视图当"另一种形状"读（P0：入口点了没反应）

**现象**（P10 真机跑出来的）：真浏览器走完「新建专家 → 填请求 → 选工作区 → 点开始生成」，
宿主确实建出独立会话、服务端确实建出 `task_drafts` 行，但页面报
`data-wb-expert-error="generation-start-failed"`，且那个生成会话的 JSONL **永远只有握手事件、一条 `user/message` 都没有**。

**根因**（逐行读源码，非推断）：

| 层 | 事实 | 位置 |
|---|---|---|
| 服务/类型 | `ExpertDraftView` 只有 `draftId`，**没有 `id`** | `src/experts/drafts.ts:156-168`；生产者 `expertDraftView()` 返回 `draftId: draft.id`（`src/experts/drafts.ts:1388-1403`） |
| 路由 | 草稿**嵌在 `draft` 下**：`{ ok: true, draft: ExpertDraftView }` | `src/api/routes/experts.ts:84`（`preview` / `validate` 两处同形状：`:123-127`、`:134-139`） |
| 客户端（修前） | `draft = res.draft as DraftView`，然后判 `typeof draft.id !== 'string'` ⇒ `fail('generation-start-failed', …)` 提前 return | `src/client/hooks/useWorkbenchExperts.ts:767-775`（下游 7 处用 `draft.id`：`:779 :786 :795 :800 :803 :809 :817`） |
| 后果 | 第 7 步判定失败 ⇒ 第 9 步 `session.prompt([...], 'queue')` **根本不执行** | `src/client/hooks/useWorkbenchExperts.ts:789-792` |

**同一根因还静默削弱了另外两条路径**（同一文件 `createExpertDraftOps`）：

- `validate`（修前 `:857-871`）把响应当通用 `DraftView` 读 ⇒ 校验回来的草稿读不出 `payload`；
- `confirm`（`:877-934`）因此被 `draft-invalid-payload` 拒；
- `readLatestDraft`（`:939-947`）读不到 `contentVersion` ⇒ **AX-E55 的版本 CAS 保护退化成摆设**。

**为什么 1289 条单测全绿**：`test/expertClientFlow.test.mjs:99` 的 `makeDraft()` 造的是**通用工作台草稿**
（带 `id` + `payload`），`:246-250` 的 `generationHandlers(draft = makeDraft())` 把它当
`[EXPERTS_GENERATION_START_PATH]: { ok: true, draft }` 返回 ⇒ **假响应与客户端自洽，真服务端的形状从来没被覆盖过**。
教训（已沉淀到工作台知识库）：**手搓假响应＝自洽的假绿；客户端/服务端契约形状错配只有真机验收能抓到。**

**规格自己也不一致**（所以"谁都没错"）：`方案-v0.3.md:337` 写 `{ draft:DraftView }`，
而同文件 `:890-891`/`:895` 的服务接口写 `startGeneration(...): DraftView`、`getDraft/validateDraft(): ExpertDraftView`。

## 2. 修复（产品代码，1 个文件）

`src/client/hooks/useWorkbenchExperts.ts`（本轮唯一产品代码改动，`+62 −?`）：

- 新增 `export function normalizeExpertDraftResponse(raw: unknown): DraftView | null`（放在 `readExpertDraftPayload` 之前）：

```ts
// 已带 id + payload 的原样放行；否则认服务端的 draftId 平铺形状；
// 两种都不是就返回 null（不猜、不造 payload）。
// 平铺分支返回 { id: draftId, kindCode: 'expert', sessionId: null, payload: record,
//                statusCode, deferredAt: null, deferCount: 0, createdAt: '', updatedAt: '' }
```

- 三处读取统一走它：`generation-start`（原 `:767-778`，现判 `normalized === null` 才 fail）、
  `validate`（原 `:857-862`）、`readLatestDraft`（原 `:939-947`，直接 `return normalizeExpertDraftResponse(res?.draft)`）。
- JSDoc 里逐字写了服务端/客户端两套形状的出处行号，避免下次再被"另一种形状"误导。

## 3. 测试改造：假响应改由**产品自己的生产者**生成

`test/expertClientFlow.test.mjs`：

- 新增 `import { expertDraftView } from '../lib/experts/drafts.js'`；
- 新增 fixture `makeServerExpertDraftView(payloadOverrides = {})` =
  `expertDraftView({ id: 'draft-1', statusCode: 'pending', payload: makePayload(payloadOverrides) })`
  ⇒ **假响应不再是手搓的，而是产品真实的视图函数产出的**；
- `generationHandlers(draft = makeServerExpertDraftView())`；AX-E53（isAlive）、AX-E54（validate）、
  AX-E55（两条 detail）全部改用真实平铺形状；
- 新增 3 条 P11 用例：① `normalizeExpertDraftResponse` 两种形状判定；② generation-start 收到平铺视图必须走到
  `promptSent=true`；③ validate/重读草稿认平铺 + 版本冲突仍认得出。用例数 **38 → 41**。

## 4. 规格与措辞更正（本次一并落盘）

- `方案-v0.3.md`：§4.1 三行改成 `{ draft:ExpertDraftView }` / `{ draft:ExpertDraftView, drift }` /
  `{ draft:ExpertDraftView, validation }`；表格下方新增「**专家域草稿响应只有一个形状（2026-10-05 更正）**」
  段落；§8 `startGeneration(...): DraftView` → `ExpertDraftView`。
- `acceptance.md`：AX-E60–E62 的类别 `P9 / real LLM` → `P9 / 真实会话通道`，并新增 §3 口径条
  （"真实模型"指目标实例里真实 DSH 会话中的模型；本插件从不直接调用模型）。
- `implementation-plan.md`：P9 标题加「（模型在 DSH 会话里跑）」，第 3 / 第 9 条改成同一口径。

## 5. 验收套件补强：把「提示词是产品发的」单独判

`scripts/verify/suites/expert.mjs`（**2212 行**，P10 末 2055 行，`+157`）：

1. **产品派发轮询**（`DSH_VERIFY_EXPERT_DISPATCH_MS`，默认 `180000`，轮询 10s）：认下被追踪的生成会话后，
   轮询它自己的 `session.v*.jsonl`，看**产品自己**那条 `user/message` 有没有出现；`findings.pluginDispatch`
   记录 `{budgetMs, intervalMs, waitedMs, dispatched, samples, suiteModelCallsAtDetection}`，其中
   `suiteModelCallsAtDetection = modelCallsMade`（探测到那一刻套件发过的真实 prompt 数，**0 才是"不是人打的"**），
   `findings.pluginFirstUserMessage` 存第一条 user 消息的 `seq/chars/sha256/head/tail`。
2. **派发通道只有一个真值来源**：`findings.dispatchPath = pluginDispatchSeen ? 'plugin-queued' : 'not-dispatched-within-budget'`；
   后面的手工补发兜底仍会把值改写成 `composer-fallback`（保留作证，但会被新检查判红）。
3. **冷启动换会话整段只在"产品自己没派发"时才跑**（原来无条件跑）：
   `if (draftSessionId !== null && findings.dispatchPath !== 'plugin-queued') { … }`。
4. **新增检查**（禁止登记进 `ALLOWED_REQUIRED_SKIPS`）：

```
id: 'AX-E60 ⭐ 点「开始生成」后由产品自己把提示词发给模型（不靠人手补发）'
ok: dispatchPath === 'plugin-queued'   // composer-fallback ⇒ fail；没走到判派发 ⇒ skip + 具体原因
detail 里写明 dispatchPath / expected / manualResendBySuite / dispatchWaitMs /
          dispatchBudgetMs / dispatchSamples / suiteModelCallsAtDetection / firstUserMessage
```

## 6. 命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 干净 |
| `pnpm build` | 0 | client bundle `lib/client.js 597.78 kB / gzip 177.41 kB` |
| `node --test test/expertClientFlow.test.mjs` | 0 | **41 pass / 0 fail** |
| `pnpm test` | 0 | **tests 1292 / pass 1292 / fail 0**（P10 末 1289，+3 条 P11 用例） |
| `node --check scripts/verify/suites/expert.mjs` | 0 | — |
| `node scripts/check-verify-scripts.mjs` | 0 | 现役 11 / 待迁移 0（必需 0）/ 作废 3 / 本地 0 / 嫌疑 0 |
| 单跑 `node scripts/verify/suites/expert.mjs --url http://127.0.0.1:3080 --evidence-dir … --db-path … --target-profile-dir …` | **0** | `{"passed":34,"failed":0,"skipped":2,"total":36}`（skip 只剩 AX-E61/E62 模型后半，预算） |
| `node scripts/dev-verify.mjs`（去 `--dry-run`，全链 11 套件） | 未跑 | 见 §9 |

## 7. 真机验收证据（独立实例 3080，冻结副本**已含修复**）

- **证据目录**：`test-results/workbench-verify/20261006-002551-p11/`
  （`run.log`、`suite-expert.json`、`suite-expert/summary.json`、`suite-expert/expert-readings.json`、
  `model-e60-dispatch.json`、`model-e60-draft-row.json`、`model-e60-first-user-message.json`、
  `model-e60-session.json`、9 张真机截图 `01-面板.png` … `99-收尾.png`）。
- **目标实例**：`http://127.0.0.1:3080`，health = `version 1.16.5 / buildId wb-8181274a3900fe0b / schema 19`。
- **装盘副本**：`C:\Users\<user>\.dsh\profiles\web\node_modules\@dely0\dsh-personal-workbench`
  （`lib/client.js` 597 782 字节，2026/10/6 0:10:50）；来源 `_local-build/current.txt` →
  `dsh-personal-workbench-dev-7dc60f9-20261006-001045.tgz`（2 649 920 字节 / **311 条目**）。
  **修复在包里的直接证据**：该 `lib/client.js` 里 generation-start 处是压缩后的
  `let n=ei((await e.call('/api/workbench/experts/generation-start',{…}))?.draft); if(n===null)return r('generation-start-failed',…);`
  —— `ei` 即被压缩的 `normalizeExpertDraftResponse`，修前那句 `typeof draft.id !== 'string'` 已不存在。
  （health 的 `buildId` 不变属正常：`buildId` 只覆盖服务端构建，不含 client bundle。）
- **派发通道**：`findings.dispatchPath = "plugin-queued"`，`dispatchWaitMs = 0`，
  `suiteModelCallsAtDetection = 0`（套件此时一次真实 prompt 都没发过），`manualResendBySuite = false`。
- **第一条 user 消息**：`seq 9`、`chars 4280`、`sha256 B7CA446004852E6BE15D5261CC73DDB8489241AC60A81E9410DB0C4E4D835CA1`，
  正文就是**插件自己构造的 prompt**（`你在本工作台里负责**新建一位专家角色**…` + `## 方法论（全文）` + `## 用户的请求` +
  `## 交付方式`）⇒ 产品通道真的把提示词发出去了。
- **生成会话**：`session-095ffd03-88f3-4495-b7e6-3446767f47c9`
  （目录 `C:\Users\<user>\.dsh\sessions\--D-Code-<company>-dsh-workbench--\session-095ffd03-…`，
  `cwd = D:\Code\<company>\dsh-workbench`、`parentSession` 空、`delegationDepth = 0`、49 事件 / 0 解压失败 / 4 条 `user/message`），
  模型 `deepseek-official/deepseek-flash`（maxTokens 256000 / reasoningEffort high），
  工具调用序列：`workbench_get_expert_draft` → `workbench_search_knowledge` → `workbench_submit_expert_draft`×3 → `workbench_validate_expert_draft`。
- **目标库草稿行**：`17121124-fb7d-44a3-a461-6bf7d9ee7dc1`（`session_id` = 上面那个会话、`status_code=pending`、
  `content_version=1`、`phase="validated"`、`expert_id=generated/7d4b7460-46e1-4a99-9820-d4b1c30356ad`、
  `persona_chars=653`、`provenance_kind="original"`、validation `manifestHash 6b1bae6f67bb1c20e84438518419e197f61921dd0c676c4d2742b590c91c37e5` / `errors[]` / `warnings[]`）。
- **确认前正式库为空**：`userLibrary = {present:false, rootExists:false, root:"C:\Users\<user>\.dsh\workbench\personas"}`。
- **UI 路径**：套件用**真实点击**走完弹窗（`settingsClick {x=1182,y=26,text=设置,clickChannel=dom-click}` →
  `adminPresent:true` → `createClick:ok` → `typed:true` → 工作区 `{ok:true,value:ef1cf070-c039-4062-b74a-dcb5fd1174b8,label:D:\Code\<company>\dsh-workbench}` →
  `submitState {disabled:false,text:开始生成}` → `clicked {ok:true}`）。
- **包内容检查（AX-E59 全绿）**：311 条目、版本 1.16.5、方法论 `assets/expert-generation/methodology.md` 在、
  `lib/experts/**` 24 个、`lib/**` 280 个、原有 personas 15 篇、三份许可原文齐；
  不该有的（`.pending` / 测试源码 / 证据包 / `_local-build` / 归档 / browser-temp / `src/**` / 日志 / TEMP 痕迹）**全为 0**；
  扫描 300 个文本条目，本机路径/UNC 命中 **[]**。

## 8. 反向注入（修复必要性，第 8 处独立证据）

把 `src/client/hooks/useWorkbenchExperts.ts` 里
`const draftId = typeof record.draftId === 'string' ? record.draftId.trim() : ''` 改成 `const draftId = ''`：

- `pnpm build` **0**（编译不报错 —— 这正是这类 bug 能进主干的机制）；
- `node --test test/expertClientFlow.test.mjs` → **30 pass / 11 fail**
  （3 条 P11 用例 + AX-E52×2 + AX-E53×3 + AX-E54×1 + AX-E55×2）；
- 还原后：`pnpm build` 0、**41/41**、文件 sha256 `41ECA9CFAE28882DF4DF57C61CA71DB17336794B0E08DA6424236B7ABDA05A88`（68 649 字节，**逐字节一致**）。

## 9. 未验证项（如实标注，一律不算通过）

1. **`AX-E61` / `AX-E62` 的模型后半未跑**（真实模型调用预算；本批这条链只跑 AX-E60 一族）。
2. **全链 `node scripts/dev-verify.mjs`（去 `--dry-run`，11 套件）未重跑**：本批以「冻结副本已含修复（§7 的编译产物的
   直接证据）+ 单跑 expert 套件」取得证据；套件在链里的 `required` 语义（带未登记 skip 即不通过）**没有**在链上复核，
   且**没有**动 `ALLOWED_REQUIRED_SKIPS`。
3. **产品级反向注入未做**：要重装 + 重启独立实例才能让"修前的包"重新上机；本批的敏感度证据是
   ①§8 的单测注入（11 条变红）证明修复必要；②新检查的判据是 `dispatchPath === 'plugin-queued'` 一行纯函数，
   而 `dispatchPath` 的两个取值分别对应 P10 记录的手工补发（`composer-fallback`，见 `P10-handover.md` §2.3）与本次的
   `plugin-queued`（真实产物流水）。
4. **未重跑**：卸载/重装/升级路径、macOS/Linux、以及"多个生成会话并发"的时序。
5. 每次真跑都会在目标库留 pending 专家草稿：套件 `finally` 的兜底 abandon 是**必要安全网**
   （本次实测 `收尾兜底放弃遗留草稿 17121124-fb7d-44a3-a461-6bf7d9ee7dc1：HTTP 200`），别删。

## 10. 交付物清单（本轮改动，**未提交**）

| 文件 | 行数 | 字节 | CR | sha256（末次实测） |
|---|---|---|---|---|
| `src/client/hooks/useWorkbenchExperts.ts` | 1556 | 68 649 | 0 | `41ECA9CFAE28882DF4DF57C61CA71DB17336794B0E08DA6424236B7ABDA05A88` |
| `test/expertClientFlow.test.mjs` | 1110 | 56 903 | 0 | `B487D14415C27C39234623EAE0F9A4A11071B103B8F81B829C987FAB31550B75` |
| `scripts/verify/suites/expert.mjs` | 2212 | 134 944 | 0 | `A9D5166DABEA1CE1EFCF8B2CAD765F4AF05EF52BFD7DDA1BFC3B2332F9C7E8C3` |
| `docs/…/方案-v0.3.md` | 954 | 69 235 | 0 | `35B31AD17D56B9EE32A3EE63C46EB8DCCBEF399B23FB6F8B9EE94E765D4E6B43` |
| `docs/…/acceptance.md` | 95 | 11 424 | 0 | `838F010EA103A44061F106BCF809B1264165F0BA755689B51696158B7CC14821` |
| `docs/…/implementation-plan.md` | 353 | 21 563 | 0 | `FB2C69D43B0F7FAF1A973322187A01EE8E1E5EB7BBEFF6CBC447472CA8C10B51` |
| `docs/…/P10-handover.md`（P10 新建，本轮加 P11 前向引用） | — | — | — | 见 P10 报告 |
| `docs/…/P11-handover.md`（本文件） | — | — | 0 | — |
| `docs/…/verification.md`（追加 §18） | 786 → | | 0 | 追加前 `035CE0E4BAF826B54C81844B1EC628A080725DF1834BAF7EDAE849C5553101AB` |
| `docs/…/P9-handover.md`（P10 追加 §13） | 314 | 32 040 | 0 | `99D3EDC74362AD187C4B5514C9FB80E1ECA1F0D86C0B922557AEBB9FB2355503` |
| `docs/…/执行日志.md`（P10 + P11 过程事实） | 229 → | | 0 | 追加前 `8A7C26C5D0C55CB62081CA18A61D78888D9D377C43C2A0318404941ED7EA662F` |

`git diff --stat`（未提交合计）：10 个文件 / **+1832 −409**（其中 `docs/design/2026-10-03-专家市场-调研.md`
是**用户自己的**改动，不提交）。

## 11. 过程事实（如实记录，不当成果）

- 本批**先委派**子代理 `1585ce8c-ee00-499b-9f12-320ae86bcbc4` 做「改套件 + 真机重跑」。它完成了
  `pnpm build → pack（`…-7dc60f9-20261006-001045.tgz`）→ install 到 `web` profile 冻结副本 → 重启 3080`
  与套件改动（`expert.mjs` 2055 → 2212 行），随后**在跑套件时挂了，没有收尾消息**（`failed before it finished`）。
- 主会话接手：现场核查（3080 存活、新包已装、health 正常）→ 核实套件改动（`node --check` 0、
  `check-verify-scripts` 0）→ 亲自跑真机验收（§7）→ 写本文档。
- 边界：**未碰** desktop 实例（19387）；未 `dsh plugin add/remove`；未改 `web` profile 的配置；
  只重启了独立测试实例 3080（P11 用户指令「现在就修，修完重跑真机验收」的范围内）；git 全程只读。
- 用户拍板原话（m02820 区）：修法选 **A「改前端认服务端真实形状」**，下一步选 **「现在就修，修完重跑真机验收」**。

## 12. 后续义务（给下一批 / PR）

1. **提交与 PR**：P10 + P11 两批改动尚未提交（建议拆两个提交：代码+规格一份、文档一份）；push / 建 PR **必须**先得用户确认。
   rebase 前留意 `origin/main` 是否又前进（P9 时 ours-only/theirs-only = 11/3，对方只碰 `.dsh/skills/dsh-release/**` 与 `docs/releases/**`）。
2. **AX-E61 / AX-E62 模型后半**：各需 ≥3 / ≥2 次真实调用，另需一个可自主召唤的 `summon_expert` 场景。
3. **全链复跑**：`node scripts/dev-verify.mjs`（去 `--dry-run`）—— 会重装冻结副本 + 重启 3080，需用户明确同意。
4. **产品级反向注入（可选加固）**：把修前的包重新装一次，确认 `AX-E60 ⭐` 真红（本批只做了单测层注入）。
5. 把 `acceptance.md` 里 AX-E60 一族的结论按本次真机证据回填（"已真跑真绿"），并把 `dispatchPath` 口径写进验收记录。
