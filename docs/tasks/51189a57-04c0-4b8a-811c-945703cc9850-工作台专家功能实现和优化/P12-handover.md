# P12 交接 — 角色库/专家 UI 缺陷修复、issue #14 浮层、issue #12 英文界面

- 日期：2026-10-18
- 分支：`feat/workbench-experts`（未提交）
- 目标实例：`http://127.0.0.1:3080`（web profile，独立库 `verify-web.db`）
- 当前装盘构建：`wb-5c8bccfcff272866`（1.16.5，本地开发构建，未改公开版本号）

---

## 1. 修了什么

### 1.1 专家草稿预览排版（用户反馈的核心 UI 问题）

**现象**：点「新建专家 → 开始生成」后，草稿弹窗里的正文被压成一字一行、横向溢出 615px，基本不可读。

**根因**（实测，不是推断）：
- `ExpertDraftBody` 根节点复用了 `.wb-draft-field`，而那个类本意是"一对 label/value 的 flex 行"；
- 组件把 6 组字段直接排在根上 ⇒ 6 组 label/value 变成 6 个并排 flex 项，每列被压到 0–76px。

**修法**：
- 根类改为 `.wb-expert-draft`，在 `styles.ts` 定义两列网格（76px + minmax(0,1fr)），说明/按钮行横跨两列；
- 同时发现正文里还复用了任务行的四列元数据网格 `.wb-row-meta`（68/46/56/88px），把长句塞进 68px 第一列；改为专用 `.wb-expert-note`；
- 回归测试：`test/expertClientFlow.test.mjs` 新增源码判据（根类、grid、非字段行跨列、UI 不出现 `**`）。

### 1.2 设置页「继续修改」看起来没反应 / 「查看草稿」被设置弹窗挡住

**现象**：设置 → 角色库 → 点「继续修改」后，`localStorage['dsh.sessions.current']` 已经切到生成会话，但设置弹窗仍盖在上面；「查看草稿」也一样被同 z-index、后渲染的设置弹窗盖住。

**修法**：
- `WorkbenchBody` 的 `onOpenExpertDraft` / `onEditExpertDraft` 先 `setShowSettings(false)`；「继续修改」同时 `dismissDraft`；
- `.wb-dock` z-index 从 300 提到 305（高于设置弹窗、低于模型选择等嵌套浮层），生成完成时草稿卡在设置页也看得见。

### 1.3 界面里的 Markdown 标记（`**` 与反引号）

清理了会原样显示星号/反引号的纯文本位置：PersonaAdmin、ExpertCreateModal、DraftBanner、CapacityRulePanel、WorkbenchOverlays 重名告警、SettingsModal 使用说明；服务端诊断消息（personas/library.ts 等）也去掉 `**`。新增源码扫描测试守住回归。

### 1.4 角色列表可读性

- 每行曾显示「内置｜domain｜内置｜来源未登记（可用，但无法追溯上游）」：来源键与来源名重复、内置角色像报错；
- 现在 `expertRowView` 在 `sourceKeyLabel === sourceLabel` 时不再重复，内置角色的 `unrecorded` 不再显示"无法追溯上游"；
- 外部目录仍显示「外部目录 · 目录名」；用户库手工角色的来源未登记提示保留。

### 1.5 issue #14：宿主 overlay 层 z-index 压过 body 浮层

**根因**：桌面端 `[data-shell-overlay]` 层自身 z-index:1000；插件所有 portal 挂 body（z-index 300），弹窗/模型列表被面板盖住。

**修法**：
- 新增纯模块 `src/client/overlayMount.ts`：优先挂宿主 overlay 层；宿主层带 transform/filter/perspective/contain/will-change 时退回 body（避免 fixed 包含块变化导致坐标漂移）；
- 六个 portal 调用点统一走 `overlayMountContainer()`：Modal / ModelPicker / LocalDocModal / Toast / TagFilter / IdeaCardGrid；
- 给 `.wb-overlay` / `.wb-modal-mask` / `.wb-model-scrim` / `.wb-model-menu` 补 `pointer-events:auto`（宿主层 pointer-events:none 会继承）；
- 新增 `test/overlayMount.test.mjs`（决策表 + 六处 portal 源码扫描）；web 真机确认挂载父节点是 `[data-shell-overlay]` 且可点击；workspace-picker 套件 8/8。

### 1.6 issue #12：英文界面

**机制**：
- `src/shared/i18n.ts`：`UiLocale = auto | zh-CN | en-US`、`resolveLocale()`、`t(key,args)`（中文原文即 key，未翻译原样回中文）、`formatCount()`；
- `src/client/i18n.tsx`：React Context + `useI18n()`；
- `WorkbenchSettings.uiLocale` 落库（meta `ui_locale`），设置 → 通用 → 语言可选 自动 / 中文 / English；
- `WorkbenchApp` 顶层包 `I18nProvider`，切换语言即时生效；保存后重启仍保留（已实测）。

**已翻译范围**：顶栏与主导航、设置页分区/语言/通用/容量、角色库管理、新建专家弹窗、专家草稿预览、角色选择器、快速录入（附件/工作区/技能/角色）、任务新建/编辑表单、模型选择器、工作区/技能选择器、今日统计与容量、日期面板页签、任务列表工具栏/空态、知识库工具栏/分页/标签筛选/空态/详情编辑表单、DraftBanner 按钮。

**未覆盖（如实）**：任务详情正文/点子/提醒/字典管理等深层文案、服务端工具描述与诊断消息仍是中文；英文界面属于"顶层 chrome 优先"的增量迁移，未翻译的 key 会原样显示中文（不会空白）。列表排序仍固定 `zh-Hans-CN` collation（避免跨 locale 改变既有稳定顺序），数字格式化已跟随界面语言。

---

## 2. 验证

### 2.1 静态与单测

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 0 |
| `pnpm build` | 0（client 628.12 kB / gzip 190.31 kB） |
| `pnpm test` | **1303 pass / 0 fail**（新增 i18n、overlayMount、专家 UI 回归用例） |

### 2.2 真机套件（3080）

| 套件 | 结果 |
|---|---|
| legacy-acceptance | 18/18 |
| legacy-duplicate-task | 11/11 |
| legacy-final-2 | 9/9 |
| legacy-sidebar-collapse | 6/6 |
| progress | 13/13 |
| verify-safety | 20/20 |
| persona | 12/13（1 skip：真实模型链路） |
| workspace-picker | 8/8 |
| day-panel | 11/11 |
| daily-effort | 13/13 |
| **合计（非 expert）** | **121 pass / 0 fail / 1 skip** |
| expert | **34/36（0 fail / 2 skip：E61/E62 模型预算）**；AX-E60 真机：`dispatchPath=plugin-queued`、草稿 validated、确认前正式库为空 |

> 说明：非 expert 的 121 条由「一次被中断的 chain（6 套件 77 条）+ 单独重跑 4 套件 44 条」拼齐；中断原因是外层调用超时，不是套件失败。最终构建重启后又单独复跑 workspace-picker 8/8、persona 12/13（1 条模型 skip），确认装盘产物一致。

### 2.3 手动 UI 证据

- 专家草稿修复后：`test-results/manual/persona-21/01-fixed.png`（修复前后对比在 persona-16/18/20）；
- 英文界面：`test-results/manual/i18n-01/`、`i18n-final/`、`i18n-final2/`、`i18n-expert-draft/`；
- 语言持久化：`test-results/manual/i18n-persist/`（en-US 保存 → reload 仍是英文）；
- overlay 挂载：`test-results/manual/overlay-01/`（父节点 `[data-shell-overlay]`、pointer-events auto、点击角色库成功）。

### 2.4 环境事实

- 3080 当前 health = 1.16.5 / `wb-5c8bccfcff272866` / schema 19（最终构建重启后）；
- 重启前已通过 `check-installed-version.mjs --db-path verify-web.db`；
- 未碰 4049/桌面实例；未升级 DSH 本体（当前 0.2.x 已满足；用户提议的 0.2.1-rc.2 升级**未执行**，因为本次修复不依赖它）；
- 测试产生的专家草稿已 abandon、用户库 `generated/` 已清理；库里仅保留验收套件自己的合成任务。

---

## 3. 未验证 / 后续

1. **桌面端 Electron 上的 issue #14 修复只做了代码级 + Web 实测**：web 宿主 overlay 层 z-index 是 20，桌面端是 1000；`overlayMount` 的决策表覆盖了桌面形态，但没有在桌面 DSH 上真机点一遍。
2. **E61/E62 模型后半**仍按预算 skip（父绑定 @ 子代理、自主召唤两轮），与 P10/P11 一致。
3. 英文界面是增量覆盖，深层文案仍未翻译；后续新增 UI 请继续用 `t('中文原文')` 并往 `EN_MESSAGES` 补条目。
4. 已按用户要求随 `v1.17.0` 公开发布；发布记录见 [`docs/releases/v1.17.0.md`](../../../docs/releases/v1.17.0.md)。

## 4. 关键文件

- `src/client/components/ExpertDraftBody.tsx`、`src/client/components/PersonaAdmin.tsx`、`src/client/components/ExpertCreateModal.tsx`
- `src/client/styles.ts`（`.wb-expert-draft` / `.wb-expert-note` / `.wb-dock` / pointer-events）
- `src/client/overlayMount.ts`、`src/client/i18n.tsx`、`src/shared/i18n.ts`
- `src/client/app/WorkbenchBody.tsx`、`src/client/views/TaskFormModal.tsx`、`src/client/app/WorkbenchDialogs.tsx`
- `src/api/routes.ts`、`src/shared/contracts.ts`、`src/client/hooks/useWorkbenchSettings.ts`、`src/client/settingsFallback.ts`
- 测试：`test/i18n.test.mjs`、`test/overlayMount.test.mjs`、`test/expertClientFlow.test.mjs`、`test/listViewWiring.test.mjs`
