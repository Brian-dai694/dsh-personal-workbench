# dsh-personal-workbench

[![npm version](https://img.shields.io/npm/v/@dely0/dsh-personal-workbench)](https://www.npmjs.com/package/@dely0/dsh-personal-workbench)
[![license](https://img.shields.io/npm/l/@dely0/dsh-personal-workbench)](./LICENSE)
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

DSH（DeepSeek Harness）个人工作台插件。它在 DSH 里提供日历、层级任务和 AI 助手：用自然语言录入任务，AI 负责澄清、拆解、执行和复盘，数据都保存在本机。

[English](#english) · 简体中文

> 仓库里的界面截图只用于开发参考，不随 npm 包发布，也不应包含真实任务、知识条目、账户信息或本地路径。

## 功能

- **日历与任务**：周/月日历配树状任务列表。「今日」「日历」「任务」三个视图支持组合筛选和排序，父子层级保持完整。
- **自然语言录入**：说一句话就能录入任务，AI 澄清后生成任务。支持贴图和 PDF/DOCX 附件，接收不了的文件会逐条说明原因。
- **任务级 AI 会话**：每个任务可以关联多个 AI 会话，分别用于澄清、咨询、拆解、执行和复盘。
- **专家人格**：角色库有三级来源（用户库 > 外部目录 > 内置 15 篇）。会话前选定角色，正文按需加载，不会写进提示词。
- **完成验收**：AI 只能申请完成，最终由用户验收。进度是显式值，AI 不能通过修改进度把任务标记为完成（ADR 0003/0004）。
- **每日计划与容量**：AI 先给出排序提案，用户确认后才生效。「今日投入结束」不等于任务完成（ADR 0007）。
- **亚马逊操作区**：一个父项下有 8 个页签，分别是测算、关键词库、选品、报表分析（含流量分析）、库存、产品库、付款对账、运营日志。广告和搜索词 CSV 在本地解析，缺数据时标 `needs_data`，不编造数字。
- **测算与装箱**：按真实成本计算有效毛利、盈亏平衡 ACOS/CPC、建议 CPC 和广告后利润，支持多方案对比。飞机盒的 3D 预览用 three.js，需要 WebGL；外箱装箱用纯 CSS 3D 预览。
- **产品库与选品**：产品库保存产品事实（站点、ASIN、标题、价格、店铺、类目），支持手动录入和单条增删改；选品只保存判断（结论、评分、VOC、下一步）。两张表互不写入。
- **会话配置**：每次 AI 会话前可以选择 Skill、模型和角色，提示词会自动加入「加载这些技能」。
- **到期提醒**：页内横幅和系统通知，也可以通过 `@xmanrui/dsh-im` 使用微信提醒。
- **界面语言**：支持自动、中文和 English（设置 → 语言）。顶栏、设置、角色库、快速录入、任务表单、知识库和选择器已支持英文，更深的说明文案还在逐步翻译。
- **视觉系统**：字号、圆角、间距、颜色和动效都使用令牌，颜色由宿主 DSH 主题派生（ADR 0011）。深浅两套主题与宿主一致，不另外定义一套颜色。
- **本地存储**：数据只保存在 `~/.dsh/workbench`，不上传到任何服务器。

## 安装

要求 DSH ≥ `0.1.5-rc.1`（Web 版）、Node `^22.19.0` 或 `>=24.0.0`、pnpm `>=11.7.0 <12`。

```sh
dsh plugin --profile web add @dely0/dsh-personal-workbench
# 或者从 GitHub 源码安装
dsh plugin --profile web add git+https://github.com/Brian-dai694/dsh-personal-workbench.git
```

> 装完必须重启 `dsh web`，只刷新浏览器不够。客户端 bundle 由宿主在启动时读进内存，刷新拿到的还是旧代码；升级和回退也一样。

## 快速上手

1. 在侧栏点击「工作台」打开面板。
2. 在「快速录入」里说一句话，AI 澄清后确认建任务。
3. 在任务详情点「AI 执行」，到会话里干活，完成后回面板验收。
4. 在「今日」查看待办和容量，需要时点「AI 智能排序」安排今天的顺序；在「日历」按天回看和排期。
5. 「亚马逊」父项下有测算、关键词库、选品、报表分析、库存、产品库、付款对账和运营日志。

## 兼容性

| 项 | 要求 | 拿不到时 |
|---|---|---|
| 面板本体（官方槽位 + `layout.selectPanel`） | DSH `0.1.5-rc.1+` | 面板整块不启动，并打一条可读日志（刻意不降级） |
| 服务端能力：任务、日历、知识库、点子、提醒、日报周报、`workbench_*` 工具 | `0.1.0-rc.6+` | — |
| 会话绑定 `sessions.retain()` | `0.1.7-rc.2+` | 旧宿主自动回落到 `sessions.binding()` |
| Skill 选择器 | 宿主 `skills` 注册表 | 选择器隐藏 |
| 微信提醒 | 可选插件 `@xmanrui/dsh-im` | 静默降级为页内提醒和系统通知 |

最低支持版本是 `0.1.5-rc.1`，这是硬边界。低于它时为什么选择「明确不启动」而不是降级，以及 0.2.0 引入的插件兼容性预检（peer 区间为什么写成并列区间），见 [`docs/releases/v1.15.8.md`](docs/releases/v1.15.8.md) 与 [`docs/design/2026-09-13-client-architecture-official-only.md`](docs/design/2026-09-13-client-architecture-official-only.md)。

## 开发

```sh
git clone https://github.com/Brian-dai694/dsh-personal-workbench.git
cd dsh-personal-workbench
pnpm install
pnpm check                 # 类型检查 + 构建
pnpm test                  # 全量回归（跑构建产物）
pnpm build && pnpm dev:install   # 装盘到本机 profile（装完重启 dsh web）
```

| 文档 | 用途 |
|---|---|
| [`.dsh/skills/dsh-plugin-change/`](.dsh/skills/dsh-plugin-change/SKILL.md) | 改代码前先读：架构硬约束、编码规范与回归防线 |
| [`.dsh/skills/dsh-release/`](.dsh/skills/dsh-release/SKILL.md) | 发版前先读：公开发布的硬门禁与命令序列（范围表、变异探针、PII 两面、tag/npm/Release、发布成功判据） |
| [`docs/release-checklist.md`](docs/release-checklist.md) | 发版前自检清单 |
| [`scripts/release-preflight.mjs`](scripts/release-preflight.mjs) | 发布门禁一键跑：typecheck → 单测 → 全探针（每步 build）→ PII 两面 → 版本/文档；`--phase post` 做 tarball 与 sha1 对账、用户视角安装、Release 复核 |
| [`scripts/dev-verify.mjs`](scripts/dev-verify.mjs) | 研发版本验收链：构建 → 装盘 → 隔离实例重启 → 浏览器套件 → 证据包 |
| [`docs/issues/`](docs/issues/) | 滚动维护的已知问题与待办 |
| [`docs/adr/`](docs/adr/) | 已冻结的口径决策（容量、进度、角色、验收链、每日投入、色系跟随 DSH） |
| [`docs/design/dsh-visual-system.md`](docs/design/dsh-visual-system.md) | 视觉系统令牌口径（字号、间距、圆角、颜色、动效），改界面前先读 |

## 版本历史

| 版本 | 要点 |
|---|---|
| 1.18.0 | 装箱 3D、产品库手动录入和包装尺寸，另修了两处「点了没反应」。飞机盒的 3D 预览用 three.js，需要 WebGL；外箱装箱用纯 CSS 3D 预览，按单一朝向枚举 6 种摆法取最大。产品库支持手动录入，并改用独立的 `products` 表（migration 39，与选品库 `asin_products` 互不写入），行内始终显示「编辑 / 删除」，空库时给出预填 ASIN 和站点的录入入口。测算页重排了信息层级：4 条结论加「核对明细」，单位跟在数字后面，计算口径收进 `<details>`。新增包装尺寸记录（migration 40）。修掉知识库「新建知识」和点子「记个点子」「新建 / 重命名文件夹」点了没反应的问题。schema 40。详见 [v1.18.0 Release](https://github.com/Brian-dai694/dsh-personal-workbench/releases/tag/v1.18.0) |
| 1.17.0 | 角色库和专家界面可用性、英文界面（i18n）、宿主浮层挂载。修掉专家草稿预览一字一行和横向溢出、设置页点「继续修改」后弹窗不关、「查看草稿」被设置弹窗遮挡、界面露出 `**`、角色来源标签重复等问题；设置新增语言选项（自动 / 中文 / English），顶栏、设置、角色库、快速录入、任务表单和知识库等顶层界面支持英文，语言保存后重启仍然保留；浮层改为优先挂到宿主 `[data-shell-overlay]` 层并补上 `pointer-events`，修复桌面端设置弹窗和模型列表被面板盖住的问题（[issue #14](https://github.com/Dely0/dsh-personal-workbench/issues/14)）。英文界面见 [issue #12](https://github.com/Dely0/dsh-personal-workbench/issues/12)。详见 [`docs/releases/v1.17.0.md`](docs/releases/v1.17.0.md) |
| 1.16.5 | 合入外部贡献：工作台样式节点丢失后的自愈（[issue #9](https://github.com/Dely0/dsh-personal-workbench/issues/9) / [PR #10](https://github.com/Dely0/dsh-personal-workbench/pull/10)，[@SnowNight777](https://github.com/SnowNight777)）。插件活动期间，`style[data-dsh-personal-workbench-style]` 被删掉后约 600ms 内会自动重建，面板不会再出现无样式弹出并覆盖界面的情况。观察者挂在插件实例上，而不是模块级；`cleanup()` 先设置 `disposed = true`，再调用 `disconnect()`。同版还修掉 main 上连续 33 次失败的 CI：`test/db.test.mjs` 里「同链计划项」那条断言的场景从 2026-10-01 起就写错了，而且 `finally` 里的清理异常会覆盖断言失败，这也是它长期被误读成「Windows EPERM 假失败」的原因。CI run #84 两项检查都通过。详见 [`docs/releases/v1.16.5.md`](docs/releases/v1.16.5.md) |
| 1.16.4 | 「排入今日」的父子规则定案：计划项必须是可执行叶子。在父任务上点一次，会按树序展开它下面所有未完成叶子，各自带上自己的投入；父任务自己不是计划项，在「计划」页签里作为分组行显示（「已排 N / 共 M 个子任务 · 合计 X 分钟」）。候选池只收叶子，AI 侧也同步为「只排可执行叶子」，包含父任务的提案会被整份拒绝。同版修掉「清除今日计划不刷新」和两处验收链测试误报。规则见 [`docs/adr/0010-plan-items-are-executable-leaves.md`](docs/adr/0010-plan-items-are-executable-leaves.md)，详见 [`docs/releases/v1.16.4.md`](docs/releases/v1.16.4.md) |
| 1.16.3 | 客户端入口拆分：`src/client/index.tsx` 从 5725 行降到 1972 行，`WorkbenchApp` 从 4197 行降到 631 行；117 个 state 按功能域收进 16 个 hook，五个视图和任务详情区各自成组件（`hooks/`、`views/`、`app/` 四段装配）。ADR-0008 的结构硬性约束（组件体内 `useState`/`api`/`fetch`/定时器为 0，单个顶层块不超过 80 行）已经落成扫描判据。这是纯结构重构，没有行为变化。详见 [`docs/releases/v1.16.3.md`](docs/releases/v1.16.3.md) |
| 1.16.2 | 日期面板补了「逾期」和「未排期」两个任务页签。没有截止时间、没有排期、也不在进行中的任务有了归属；「未排期」是补集，三个页签合起来正好覆盖全部未完成任务。这两个页签的行内都加了「排入今日」。统计卡里「逾期」的算法统一到当日 00:00，和页签用同一个判断标准。详见 [`docs/releases/v1.16.2.md`](docs/releases/v1.16.2.md) |
| 1.16.1 | AI 会话工作区支持双模式（已有工作区下拉和文件夹弹框）；「今日」与「日历」合并为同一个日期面板，分为计划、已完成、报告三个页签，树口径是当日到期、当日计划项和进行中的并集，每条任务标明来源；构建期类型源对齐 DSH `0.2.0-rc.2`。详见 [`docs/releases/v1.16.1.md`](docs/releases/v1.16.1.md) |
| 1.16.0 | 任务进度改为显式值，AI 不能靠进度把任务标记为完成；新增专家人格角色库（三级来源，内置 15 篇）和研发版本验收链。schema 18 → 19。详见 [`docs/releases/v1.16.0.md`](docs/releases/v1.16.0.md) |
| 1.15.8 | 适配 DSH `0.2.0-rc.1` 的插件兼容性预检：peer 依赖改为并列区间，下界不变。 |
| 1.15.7 | 修复快速录入模型选择死锁，以及 rc.2 上系统通知失败被吞掉的两个 P0 问题。 |
| 1.15.6 | 补齐 `0.1.7-rc.2` 上读取「当前会话」时出现的三处静默 `undefined`。 |
| 1.15.5 | 适配 `0.1.7-rc.2`：会话绑定和打开、标题栏让位、侧栏宽度计算、工作区静默丢件。 |
| 1.15.3 | 合入社区的三项修复：提醒漏建、投递目标缓存、复用会话时的陈旧引用。 |
| 1.15.2 | 修复模型浮层遮挡、默认工作区被任务污染的问题；容量账本透明化；知识库改为 Tab 布局；知识自动召回。 |
| 1.15.1 | 任务资料夹改为 `<任务ID>-<标题片段>`；快速录入支持附件（图片、PDF/DOCX）；新增模型选择器和 `/workbench` 命令。 |
| 1.14.57 | 架构重构：面板可见性只有一个权威来源；删除 DOM 降级路径；能力门槛改为「明确不启动」。 |
| 更早 | 完整发行说明见 [`docs/releases/`](docs/releases/) |

> `main` 上还有一批尚未发版的改动：界面视觉系统统一（字号、圆角、间距、颜色、动效令牌化，见 [`docs/design/dsh-visual-system.md`](docs/design/dsh-visual-system.md)）和公开文档的路径清理。

## 路线图

- [ ] 任务拖拽排序、数据导入导出
- [ ] 定时自动化、多端同步（各自单独立项）

## 致谢

- [@Guojing6](https://github.com/Guojing6)：v1.15.1 的多项能力来自其 fork [`Guojing6/dsh-workbench`](https://github.com/Guojing6/dsh-workbench)，包括任务资料夹改用任务 ID、快速录入附件、模型选择器、`/workbench` 斜杠命令和请求围栏加固；还帮我们定位了两个长期存在的 bug。
- [@SnowNight777](https://github.com/SnowNight777)：v1.15.3 的三项修复来自其报告（issue [#4](https://github.com/Dely0/dsh-personal-workbench/issues/4) / [#5](https://github.com/Dely0/dsh-personal-workbench/issues/5) / [#7](https://github.com/Dely0/dsh-personal-workbench/issues/7) 与 PR [#6](https://github.com/Dely0/dsh-personal-workbench/pull/6) / [#8](https://github.com/Dely0/dsh-personal-workbench/pull/8)）。v1.16.5 的工作台样式自愈也来自其 issue [#9](https://github.com/Dely0/dsh-personal-workbench/issues/9)（含故障注入最小复现和只读状态采集脚本）与 PR [#10](https://github.com/Dely0/dsh-personal-workbench/pull/10)（样式节点丢失后的自动恢复、生命周期清理和 7 例回归）。v1.17.0 的宿主浮层挂载修复（issue [#14](https://github.com/Dely0/dsh-personal-workbench/issues/14)）提供了真实测量、`elementFromPoint` 证据和可以直接落地的方案。
- [@Chewbacca96](https://github.com/Chewbacca96)：v1.17.0 的 UI localization（issue [#12](https://github.com/Dely0/dsh-personal-workbench/issues/12)）需求与边界定义。
- [@tujunwenjie](https://github.com/tujunwenjie)、[@lhmhz](https://github.com/lhmhz)：issue 诊断报告。
- 内置角色库包含两个采用 MIT 协议的上游项目（`novotnyllc/dotnet-artisan`、`K-Dense-AI/scientific-agents`），完整署名和我们做的修改见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 免责声明

社区项目，与 DeepSeek 官方无关，不提供任何担保。安装即表示你信任该代码会以你的 DSH 用户权限在本机运行；执行类 AI 操作可能修改工作区文件、消耗 API 额度，请先阅读代码并谨慎使用。

## License

[MIT](./LICENSE)。部分 DOM 挂载模式与客户端构建包装参考了 `dsh-task-board`（BSD-3-Clause）与 `dsh-genui`（MIT），详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

# English

A personal workbench plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It adds a calendar, a hierarchical task list and an AI assistant to DSH: describe a task in natural language, and AI clarifies, breaks down, executes and reviews it. All data stays on your machine.

## Features

- **Calendar and tasks**: week/month calendar plus a tree task list. The Today, Calendar and Tasks views support combined filtering and sorting while keeping the parent-child structure.
- **Quick capture**: describe it in natural language, and AI clarifies it and creates the task. Images and PDF/DOCX attachments are supported; files that cannot be accepted are reported one by one with a reason.
- **AI sessions per task**: each task can be linked to multiple AI sessions for clarification, consultation, breakdown, execution and review.
- **Personas**: a three-tier library (user > external directory > 15 built-ins). Pick a persona before a session; the body is loaded on demand and never inlined into the prompt.
- **Completion hand-off**: AI can only request completion; you accept it. Progress is an explicit value, and AI cannot complete a task by changing progress (ADR 0003/0004).
- **Daily plan and capacity**: AI proposes an order, which applies only after you confirm it. "Done for today" is not the same as task completed (ADR 0007).
- **Amazon operations area**: one entry with eight tabs: calculator, keyword library, product scouting, report analysis (including traffic), inventory, product library, payment reconciliation and operations log. Ad and search-term CSVs are parsed locally; missing data is marked `needs_data` instead of being made up.
- **Calculator and packing**: effective margin, break-even ACOS/CPC, suggested CPC and post-ad profit calculated from real costs, with multi-scenario comparison. The mailer-box preview uses three.js and needs WebGL; carton packing uses a pure CSS 3D preview.
- **Product library and scouting**: the product library holds product facts (site, ASIN, title, price, store, category) and supports manual entry with inline add/edit/delete; scouting holds judgment (conclusion, score, VOC, next step). The two tables never write to each other.
- **Session setup**: choose Skill, model and persona before each AI session; the prompt automatically includes a "load these skills" instruction.
- **Due reminders**: in-panel banner and system notification, plus an optional WeChat channel through `@xmanrui/dsh-im`.
- **UI language**: auto / Chinese / English (Settings → Language). Top-level chrome, settings, personas/experts, quick capture, task forms, knowledge view and pickers are translated; deeper copy is still being translated.
- **Visual system**: typography, radius, spacing, color and motion use tokens. Colors are derived from the host DSH theme (ADR 0011), and both light and dark themes match the host instead of defining a separate palette.
- **Local storage**: data stays in `~/.dsh/workbench` and is not uploaded to any server.

## Install

Requires DSH ≥ `0.1.5-rc.1` (web), Node `^22.19.0` or `>=24.0.0`, and pnpm `>=11.7.0 <12`.

```sh
dsh plugin --profile web add @dely0/dsh-personal-workbench
# or install from GitHub source
dsh plugin --profile web add git+https://github.com/Brian-dai694/dsh-personal-workbench.git
```

> You must restart `dsh web` after installing. The client bundle is read into memory when the host starts, so a browser refresh keeps serving the old code. Upgrades and rollbacks work the same way.

## Compatibility

| Item | Requirement | If missing |
|---|---|---|
| Panel (official slots + `layout.selectPanel`) | DSH `0.1.5-rc.1+` | The panel refuses to start and logs a readable reason (deliberately not degraded) |
| Server-side features (tasks, calendar, knowledge base, ideas, reminders, daily/weekly reports, `workbench_*` tools) | `0.1.0-rc.6+` | — |
| Session binding via `sessions.retain()` | `0.1.7-rc.2+` | Falls back to `sessions.binding()` on older hosts |
| Skill picker | host `skills` registry | Picker is hidden |
| WeChat reminders | optional `@xmanrui/dsh-im` | Falls back silently to in-panel and system notifications |

## Development

```sh
pnpm install && pnpm check && pnpm test
```

Read [`.dsh/skills/dsh-plugin-change/`](.dsh/skills/dsh-plugin-change/SKILL.md) before changing code, and [`.dsh/skills/dsh-release/`](.dsh/skills/dsh-release/SKILL.md) before publishing. A tick-box version of the release checklist is in [`docs/release-checklist.md`](docs/release-checklist.md), and the automated verification chain is in [`scripts/dev-verify.mjs`](scripts/dev-verify.mjs).

## Credits & License

Community project, not affiliated with DeepSeek; provided as-is. External contributions and the bundled MIT-licensed persona sources are listed in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). Licensed under [MIT](./LICENSE).
