/**
 * dsh-personal-workbench — host half.
 * V1/V1.5 能力已闭环；V2 起提供每日 AI 智能排序（daily_plans）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { makeDictionaryRoute } from './api/dictionaryRoute.js'
import { makeLocalDirRoute } from './api/localDirRoute.js'
import { makeOpenFileRoute } from './api/openFileRoute.js'
import { makeRoutes } from './api/routes.js'
import type { LlmModalityProbe } from './api/routes/model-modalities.js'
import { normalizeHostPath } from './api/routes/helpers.js'
import { makeSkillRoutes } from './api/routes/skills.js'
import { probeSkills } from './api/skills.js'
import { openWorkbenchDb, SchemaTooNewError, type WorkbenchDbConfig } from './db/database.js'
import { seedDictionaries } from './db/seed.js'
import { installKnowledgeRecall } from './knowledge/recall.js'
import { knowledgeRecallControlTool, searchKnowledgeTool } from './knowledge/tools.js'
import { countFiredRemindersSince, countQueue, enqueueReminder, listDueRemindersInWindow, listQueue, markQueueAttempt, readMeta, removeQueueEntry, skipStaleReminders } from './db/repo.js'
import { probeDshIm, WechatChannelAdapter } from './reminder/adapter.js'
import { readReminderPolicy, writeReminderPolicy } from './reminder/config.js'
import { ReminderScheduler } from './reminder/scheduler.js'
import { readWeixinInboundCount } from './reminder/weixin-status.js'
import type { TeamMemoryService } from './memory/review-memory.js'
import { taskWorkspaceFolderName } from './client/taskFolder.js'
import { loadPersonaTool, proposeDailyPlanTool, proposeIdeaClustersTool, proposeSubtasksTool, readPersonaResourceTool, requestCompletionTool, saveTaskMemoryTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitReviewTool, submitTaskTool, updateProgressTool, updateTaskTool, type PersonaDependencyPreflight } from './tools/workbench.js'
import { AUTO_EXPERT_PROMPT_BLOCK_NAME, AUTO_EXPERT_PROMPT_ORDER, buildAutoExpertPrompt } from './experts/catalog.js'
import { expertCommandDefinition } from './experts/command.js'
import { probeExpertSkills, probeExpertSubagents, selectSpawnProvider } from './experts/host-adapter.js'
import { createExpertService, type ExpertService } from './experts/service.js'
import { registerWorkbenchSkillProvider, type SkillRegistrarLike, type WorkbenchSkillRegistration } from './experts/skill-provider.js'
import { expertGenerationTools, expertInvocationTools, summonExpertTool } from './experts/tools.js'
import { amazonBidCalculatorTool, amazonCpcBreakevenTool, amazonKeywordCombinerTool, amazonKeywordPlannerTool, amazonKeywordStrategyTool, amazonSearchTermVolatilityTool, amazonTrafficAnalyzerTool, readAsinJudgmentsTool, readSearchTermsTool, saveAsinJudgmentTool, saveSearchTermReviewTool, saveSearchTermSummaryTool } from './amazon/tools.js'

export const name = 'personal-workbench'

/**
 * 插件依赖。
 *
 * `commands`（v1.15.1，`/workbench` 斜杠命令）是**必需前置**：
 * 命令注册没有它根本不成立；而 `@deepseek-ai/dsh-commands` 从 `0.1.5-rc.1`
 * （= 本仓 `MIN_HOST_VERSION`）起就有，所以放进 `inject` 不会把支持范围内的宿主挡在外面。
 *
 * ⚠️ 与它相对的是 `llm`（模型输入能力查询）：那是**可选增强**，
 * 一律 `ctx.get` 软探测，**绝不放进 inject**（缺了只是少一条"这个模型不收图"的提前提示）。
 */
export const inject = ['webServer', 'systemPrompt', 'tools', 'commands']

/**
 * 软探测一个可选服务。
 *
 * **可选服务一律 `ctx.get()` 软探测，绝不放进 `inject`、绝不直接 `ctx.x`** ——
 * 这条规则是被真实事故逼出来的：cordis 的 inject 语义是"缺一个就整个插件 pending"，
 * 把 0.1.5 才有的服务写进去，旧宿主上直接 `Failed to load plugins`
 * （已复发 3 次：v1.10.1 的 uiWorkspace、v1.13.0 的 runtime.slots、v1.13.3 根治）。
 */
function probeService<T>(ctx: unknown, name: string): T | undefined {
  const getter = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  try { return getter.call(ctx, name) as T | undefined } catch { return undefined }
}

const WORKBENCH_GUIDANCE = [
  '本机已安装 dsh-personal-workbench 插件（个人工作台）：侧边栏「工作台」入口；',
  'V1 能力：日历 + 任务列表、自然语言快速录入与 AI 澄清、子任务拆解（AI 提案 + 用户确认）、任务关联多个 Harness 会话。',
  'V1.5 已提供任务“执行”：任意节点（含父任务）均可执行，执行会话完成后应调用 workbench_request_completion 提交验收申请，由用户验收后完成；父任务验收通过时未完成子任务会级联完成。AI 不得直接把任务标记为完成/取消。',
  '任务进度（进度是显式值，不由子任务比例派生）：执行过程中**阶段性推进后请主动调用 workbench_update_progress 报一次进度**（0–99 直接生效，不需要用户确认）；这部分工作全部做完时调用 workbench_update_progress progress=100 并给出 summary —— 100 不是可存储的进度，它等同于提交完成验收申请（与 workbench_request_completion 同一条路径），AI 永远不能直接把任务标记为已完成/已取消。咨询/拆解/排序会话不得被这条提示诱导去执行任务。',
  '任务共享记忆：执行/拆解/咨询过程中有关键上下文、阶段性结论或决策时，请调用 workbench_save_task_memory 保存到任务共享记忆；同一任务/子树下的后续会话会自动加载这些记忆。',
  'V2 AI 智能排序：请调用 workbench_propose_daily_plan(plan_date, summary, items) 提交指定日期的执行顺序提案（只写草稿，用户确认后生效），不要修改任务字段；只能排可执行叶子（下面没有未完成子任务的节点）—— 父任务本身不是计划项，提案里出现它会整份被拒绝。',
  'V2 日报/周报：请在报告会话中调用 workbench_submit_report(period_code, period_start, title, summary_md) 提交报告草稿，用户确认后才保存。',
  'V2 提醒：任务到期提醒由工作台自动弹出页面横幅与桌面通知；不要用其他方式重复提醒。',
  '知识库：值得沉淀的经验教训/决策/笔记请调用 workbench_submit_knowledge 提交知识草稿（kind_code/tags）；如来自本地文档，应同时传入 file_link（file:// 或绝对路径）用于追溯；用户确认后入库；复盘时优先考虑。注意本工具按会话去重：一个会话只产生 1 条知识草稿，不带 draft_id 的重复提交是覆盖（回执会写明"已更新本会话已有草稿"，请照实转述，不要说成新建）；要在同一会话沉淀多条，走 POST /api/workbench/drafts。',
  '知识库自动召回（v1.15.3）：会话里会自动按你的提问检索知识库，命中的条目以「【工作台知识库】…」出现在上下文里（零命中时不插占位）。四个时机请主动调用 workbench_search_knowledge 再查一次：开工前 / 报错时 / 写码前 / 验收复盘前。用到了哪几条请调用 workbench_knowledge_recall_control(action=report_usage, entry_ids=[...]) 回报；本会话不想被自动检索就 action=turn_off。',
  '点子/点子王：关联点子请调用 workbench_propose_idea_clusters；头脑风暴落地请调用 workbench_submit_idea_tasks。都只写草稿，用户确认后才生效。',
  '/workbench 是个人工作台“快速录入新任务”的专用命令：当用户消息以 /workbench 开头时，只把后续文字理解为新任务线索，按 workbench-intake 规范澄清，并且只能调用 workbench_submit_task 写入 pending 任务草稿；不要执行、拆解、生成计划/报告/知识/点子/复盘，也不要处理微信提醒。',
  '任务资料夹：每个任务的文件请放在提示词里声明的“任务资料夹”（形如 <任务ID>-<标题片段>）里，不要在工作区根目录散放文件。',
  '用户提到「工作台 / 任务 / 日历 / 提醒 / 子任务 / 计划 / 日报周报」时即指本插件，请据此协作。',
  'Amazon 测算面板与对话工具共用本地成本模型 workbench_cpc_breakeven；仓储、移除/弃置、促销摊销必须纳入输入。不得声称与外部 amztoolbox/cpc-compass 已校准；没有对照输出时标记 calibration unknown。',
  'Amazon 市场数据联动：本机已配置 Sellersprite MCP（serverName=mylevis-hub）。涉及 ABA、关键词市场容量、购买率、商品数、点击/转化垄断度、竞品 ASIN 反查时，优先调用已注册的 `mcp__mylevis-hub__*` 只读工具，并在回答中标记 observed（MCP 返回）/derived（本地计算）/unknown（缺口）。不要把 ABA/Sellersprite 市场数据当成账户花费、ACoS、订单归因、库存或利润事实。',
  'ABA 与工作台联动：先用 Sellersprite MCP 获取市场证据，再调用 amazon_classify_keyword_strategy、amazon_build_keyword_plan 或 amazon_analyze_search_term_volatility 做本地分层/组合/比较；如果缺少 ABA 或 MCP 结果，返回 needs_data，不用演示值替代。广告预算、出价、否词、Listing 和 Bulk 修改仍只输出人工确认清单，不执行。',
].join('')

const SECTION_ORDER = 150

/**
 * `/workbench` 命令送给模型的澄清指令。
 *
 * 为什么在**服务端**也写一份提示词（客户端已经有一份）：斜杠命令是**宿主原生**入口 ——
 * 用户在官方输入框里打 `/workbench 周五接待客户`，命令处理器直接 steer 一条用户消息，
 * **完全不经过工作台面板**，所以拿不到客户端那份提示词。
 */
const WORKBENCH_INTAKE_COMMAND_PROMPT = [
  '你是“个人工作台”的任务澄清助手。请按 workbench-intake 规范执行。',
  '用户通过 /workbench 请求创建一个新的个人工作台任务。',
  '只处理新任务的澄清与提交：先一次询问一个主题、最多澄清 5 轮；信息足够后只能调用 workbench_submit_task 写入 pending 任务草稿。',
  '不要执行任务本身，不要拆解任务，不要生成计划、报告、知识、点子、复盘，也不要处理微信提醒。',
].join('\n')

/**
 * `ctx.commands` 的**最小本地形状**（只声明 `register`）。
 *
 * 与 `@deepseek-ai/dsh-commands` 的真实 d.ts 保持结构一致；用它而不是 `import type {} from`
 * 是因为那个包会牵出 `dsh-agent` / `dsh-brand` / `dsh-invariants` / `dsh-scope` / `dsh-session`
 * 一整串宿主包，而我们只用到一个 `register`。
 * 本仓对"只需要形状"的宿主能力一贯这么做（`capabilities.ts` 的 `SlotsProbe`）。
 *
 * 版本对齐由 `package.json` 的 peerDependencies 表达（`^0.1.5-rc.1`，= `MIN_HOST_VERSION`）。
 */
interface CommandsProbe {
  readonly register: (definition: CommandDefinitionProbe) => () => void
}

interface CommandDefinitionProbe {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
  /**
   * 真实 d.ts 是 `(invocation: CommandInvocation) => CommandResult | Promise<CommandResult>`
   * （`@deepseek-ai/dsh-commands` 0.2.0-rc.2 的 `types/index.d.ts:54`）。
   *
   * `/workbench` 的 handler 仍然**同步**返回（行为逐字未变）；`/expert` 需要
   * `await service.preflight(...)` 才能拿到建请求要用的 `sourceKey`/`revision`（§8.4 + P6 交接 §9-2），
   * 所以这里把返回类型放宽到与宿主一致 —— 不放宽的话 `/expert` 会因类型不符而编译不过。
   */
  readonly handler: (invocation: { readonly agent?: AgentProbe; readonly rawInput?: string }) =>
    { readonly kind: 'success' | 'error'; readonly text: string }
    | Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>
}

/** `dsh-agent` 的 Agent 上我们只用到 `session.id`（身份）与 `steer`（把一条用户消息送进当前会话）。 */
interface AgentProbe {
  readonly session?: { readonly id?: unknown }
  readonly steer?: (message: unknown) => void
}

/**
 * 注册 `/workbench` 斜杠命令（v1.15.1）。
 *
 * ## 关键取舍
 *
 * - **用宿主 `ctx.commands.register`，不自建 DOM 补全浮层**：宿主注册的命令**本来就会进原生 `/` 菜单**
 *   （`dsh-client-ui-commands`），fork 那份 `installWorkbenchSlashMenu()` 在 `document` 上捕获一堆事件、
 *   手动定位 `textarea[data-phase]` 再预填 —— 是重复实现，而且定位/主题都易碎。
 * - 命令**不把输入当普通消息执行**：handler 里显式 steer 一条带澄清指令的用户消息，
 *   并回一条 success 文案让用户知道"已经进入澄清流程"。
 * - **先建任务资料夹再交给 AI**（与客户端同一套规矩）：资料夹名 = `<任务ID>-<标题片段>`，
 *   任务 ID 也一并写进提示词，AI 提交草稿时必须带上同一个 `task_id`。
 *   默认根目录没配置时**不编一个**（fork 写死 `~/Documents/aitasks`，本仓不抄），只是不声明资料夹。
 */
function registerWorkbenchCommand(ctx: Context, db: DatabaseSync): void {
  const commands = probeService<CommandsProbe>(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    // inject 保证了它存在；真拿不到也**不静默**：打一条可读日志，命令只是不可用。
    const notice = '[dsh-personal-workbench] 未注册 /workbench 命令：宿主没有提供 commands 服务。'
    ctx.logger?.warn?.(notice)
    console.warn(notice)
    return
  }
  ctx.effect(() => commands.register(workbenchCommandDefinition(db)), 'dsh-personal-workbench: command')
}

/**
 * 注册 `/expert` 斜杠命令（P7 / §8.4）。
 *
 * 与 `registerWorkbenchCommand` **同一层、同一写法**：`ctx.effect` 包住
 * `commands.register(...)` 的 disposer，因此热重载 / 卸载时注册会被完整摘掉
 * （AX-E51 的"命令只有一份、disposer 完整"）。拿不到 `commands` 时打一条可读日志、
 * **不抛**：`/workbench` 与其它功能照常可用。
 *
 * 命令本体在 `src/experts/command.ts`（纯解析 + 工厂），这里只是装配外壳 ——
 * 与 `/workbench` 的分工完全一致（`workbenchCommandDefinition` 也是单独导出给单测直接驱动的）。
 */
function registerExpertCommand(ctx: Context, db: DatabaseSync, experts: ExpertService): void {
  const commands = probeService<CommandsProbe>(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    const notice = '[dsh-personal-workbench] 未注册 /expert 命令：宿主没有提供 commands 服务。'
    ctx.logger?.warn?.(notice)
    console.warn(notice)
    return
  }
  ctx.effect(
    () => commands.register(expertCommandDefinition(db, { experts })),
    'dsh-personal-workbench: expert-command',
  )
}

/**
 * `/workbench` 的**命令定义本体**。
 *
 * 单独导出是为了能被单测**直接驱动** —— 注册外壳需要 cordis 上下文，
 * 而 handler 才是真正有语义、也真正该被钉住的部分
 * （见 `test/pluginEntry.test.mjs`；本仓对"能测的语义"一贯不留"只靠读代码"的角落）。
 *
 * 行为约定：
 * - 空输入 → `kind: 'error'` + 可读提示（**不** steer 一条空消息）；
 * - 有输入 → 先建任务资料夹（默认根目录没配置就跳过，**不编一条路径**），
 *   再 `agent.steer` 一条带 `task_id` / `workspace_path` 的用户消息；
 * - `agent.steer` 不可用 → 返回 error 而不是抛异常（宿主 UI 会把 error 当结果渲染）。
 */
export function workbenchCommandDefinition(db: DatabaseSync): CommandDefinitionProbe {
  return {
    name: 'workbench',
    description: '快速录入个人工作台新任务',
    input: { hint: '<任务文字>' },
    handler: ({ agent, rawInput }) => {
      const taskText = (rawInput ?? '').trim()
      if (taskText === '') return { kind: 'error', text: '请在 /workbench 后输入任务文字，例如：/workbench 周五 10:30 接待重要客户' }
      const taskId = randomUUID()
      const folderName = taskWorkspaceFolderName(taskId, taskText)
      const root = (readMeta(db, 'ai_default_workspace') ?? '').trim()
      let folderPath = ''
      if (root !== '') {
        /**
         * ⚠️ 必须过 `normalizeHostPath`（fresh-eyes 审查 F5）。
         *
         * 客户端那条链路会做 WSL 归一化（`normalizeWindowsPathToWsl`），
         * 而 `node:path.join` 只会把 `D:\DSHWorkspace` 与资料夹名拼起来 ——
         * 在一台"宿主跑在 WSL、设置里填的是 Windows 路径"的机器上，
         * `mkdirSync('D:\DSHWorkspace\x')` 会在当前目录建出一个名叫 `D:\DSHWorkspace` 的
         * **单层目录**，任务执行会话随后拿到一个不存在的 `workspace_path`。
         * 这里复用 `helpers.toNativePath`（既有的唯一实现），不再另写一套平台判断。
         */
        folderPath = normalizeHostPath(join(root, folderName))
        try {
          mkdirSync(folderPath, { recursive: true })
        } catch (error) {
          return { kind: 'error', text: `无法创建任务资料夹 ${folderPath}：${error instanceof Error ? error.message : String(error)}。请检查「工作台 → 设置」里的默认 AI 工作区是否可写。` }
        }
      }
      const context = [
        `当前时间：${new Date().toISOString()}`,
        `本次预分配任务 id：${taskId}`,
        folderPath === '' ? '任务资料夹：未配置默认 AI 工作区，本次不指定资料夹。' : `任务资料夹：${folderPath}`,
        folderPath === '' ? '' : `任务资料夹相对路径：./${folderName}/`,
        '',
        `提交草稿时必须传入 task_id="${taskId}"${folderPath === '' ? '' : `、workspace_path="${folderPath}"`}。`,
        folderPath === '' ? '' : '如需创建或修改本任务相关文件，请放在上述任务资料夹里，不要在工作区根目录散放文件。',
        '',
      ].filter((line) => line !== '').join('\n')
      if (typeof agent?.steer !== 'function') {
        return { kind: 'error', text: '当前会话不能接收命令转发（agent.steer 不可用），请改用工作台面板的「快速录入」。' }
      }
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `${WORKBENCH_INTAKE_COMMAND_PROMPT}\n${context}${taskText}` }],
        source: { kind: 'user' },
      }))
      return {
        kind: 'success',
        text: folderPath === ''
          ? '已将任务线索送入当前会话，开始按 workbench-intake 规范澄清。'
          : `已将任务线索送入当前会话，任务资料夹：${folderPath}`,
      }
    },
  }
}

export interface Config extends WorkbenchDbConfig {
  announceToAgent?: boolean
  /**
   * 工作台主目录覆盖（**只给测试/多机部署**）。
   *
   * 设了它，`~/.dsh/workbench` 整体挪到 `<home>/.dsh/workbench`：数据库、专家库、
   * 角色用户库都跟着走 —— 测试因此可以在临时目录里跑完整 `apply()`，
   * **不会读写用户真实的工作台数据**。缺省（undefined）= `homedir()`，生产行为不变。
   */
  home?: string
  /** 提醒调度器扫描间隔（毫秒），缺省 30s；测试可调小 */
  reminderScanIntervalMs?: number
  /** 知识库自动召回：全局缺省开关（不传则读 meta，缺省**开**）。 */
  knowledgeRecallEnabled?: boolean
  /**
   * 知识库自动召回的阈值 —— **原始权重分**口径（缺省 0.34，见 `RECALL_DEFAULTS`）。
   *
   * ⚠️ 这个数字不是界面上看到的"相关度"：展示层做了归一化
   * （`relevance = 原始分 / 0.55`），所以 0.34 对应界面上的 **0.62**。
   * 填之前想清楚用的是哪把尺子（工具参数 `min_score` 用的是归一化口径，两处刻意不同：
   * 配置是调试公式用的，工具参数是给模型看着输出里的数字填的）。
   */
  knowledgeRecallMinScore?: number
  /** 知识库自动召回的单回合条数上限（缺省 3）。 */
  knowledgeRecallMaxEntries?: number
}

/**
 * `config.home` 的覆盖口径（只给测试/多机部署）：把**默认**数据库目录挪到
 * `<home>/.dsh/workbench`。显式 `dataDir`/`dbPath` 仍然优先。
 */
function workbenchDbConfigFor(config: Config): WorkbenchDbConfig {
  if (typeof config.home !== 'string' || config.home.trim() === '') return config
  return { dataDir: join(config.home, '.dsh', 'workbench'), ...config }
}

/** 角色/专家两套目录的共同覆盖项：生产不传（`{}` ⇒ 宿主目录约定）。 */
function homeRootOverride(config: Config): { home: string } | Record<string, never> {
  return typeof config.home === 'string' && config.home.trim() !== '' ? { home: config.home } : {}
}

export function apply(ctx: Context, config: Config = {}): void {
  let db: DatabaseSync
  try {
    db = openWorkbenchDb(workbenchDbConfigFor(config))
    seedDictionaries(db)
  } catch (error) {
    applyDegraded(ctx, error, config)
    return
  }
  applyReady(ctx, db, config)
}

/**
 * 数据库打不开时的降级路径：**保证 DSH 仍然能起来**。
 *
 * 为什么必须有这条路：`apply` 抛错会让 cordis 把整个 patch 行事务组回滚，
 * 宿主直接拒绝启动、GUI 都进不去（2026-09-12 的真实事故：工作台被 pnpm 回退到
 * 1.12.1，读不了已迁到 schema 15 的库，整个 DSH 起不来）。
 * 数据库比插件新属于运维常态，不该等于宿主不可用。
 *
 * 降级语义：不注册任何路由/工具/提醒调度（数据不可信，宁可什么都不做），
 * 但**照常注册 systemPrompt 告警**——这样 AI 会话里能直接看到"工作台已停用 + 怎么修"，
 * 用户不必去翻日志。
 */
function applyDegraded(ctx: Context, error: unknown, config: Config): void {
  const detail = error instanceof SchemaTooNewError
    ? `数据库 schema 版本 ${error.dbVersion} 比当前插件支持的 ${error.supportedVersion} 新`
    : `无法打开数据库：${String(error)}`
  const notice = `[dsh-personal-workbench] 已降级为空转：${detail}。`
    + '插件本体已加载但未注册路由/工具/提醒，工作台功能不可用。'
    + '修复：把 @dely0/dsh-personal-workbench 升级到与数据库 schema 匹配的版本'
    + '（如 `dsh plugin --profile web add @dely0/dsh-personal-workbench@latest`），然后重启 dsh web。'
    + '请勿降级数据库 schema——那会丢数据语义。'
  ctx.logger?.error?.(notice)
  // 控制台兜底：logger 未必被宿主接管，而这条信息决定用户能不能自救。
  console.error(notice)
  if ((config.announceToAgent ?? true) === false) return
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:workbench',
    order: SECTION_ORDER,
    text: `本机 dsh-personal-workbench 插件当前处于**降级空转**状态，工作台功能全部不可用。`
      + `原因：${detail}。`
      + '请告知用户：升级该插件到与数据库 schema 匹配的版本后重启 dsh web 即可恢复；'
      + '不要试图降级数据库，也不要调用任何 workbench_* 工具（它们未注册）。',
  }), 'dsh-personal-workbench: degraded-prompt')
}

/** 数据库正常可用时的完整装配（原 apply 主体）。 */
/**
 * §9.2：把专家服务的 preflight 结论翻成"普通 `workbench_load_persona` 能不能加载"。
 *
 * 判据只有一个：**`usable === false` 才拒绝**。`preliminary` 只表示"视角降级"
 * （HTTP/无 scope 时的预检），**不是**"不可用" —— 拿它当拒绝依据会把一批本来能用的
 * 角色挡在门外。
 *
 * `agent` 必须**原样**来自工具执行上下文（`exec.agent`）：预检要按 live agent 的真实
 * scope 判定"最近层同名技能胜出"（§7.3）。少了它，预检会退回全局视角，
 * 与执行时看到的技能库可能不是同一个 —— 那正是"预检说行、跑起来找不到"的成因。
 */
async function personaDependencyPreflight(service: ExpertService, personaId: string, agent?: unknown): Promise<PersonaDependencyPreflight> {
  const result = await service.preflight(personaId, agent)
  if (result.usable) return { ok: true }
  const missing = result.effectiveSkills
    .filter((skill) => skill.required === true && skill.available === false)
    .map((skill) => skill.name)
  const parts = [
    `预检状态 ${result.status}`,
    missing.length === 0 ? '' : `缺失的必需技能：${missing.join('、')}`,
    ...result.issues.slice(0, 3).map((issue) => `${issue.code}：${issue.message}`),
  ].filter((part) => part !== '')
  return { ok: false, message: parts.join('；') }
}

function applyReady(ctx: Context, db: DatabaseSync, config: Config): void {
  /**
   * 角色库/专家库的目录覆盖（`config.home`，只给测试/多机部署）。
   * 生产是 `{}` ⇒ `resolveExpertRoots({})` / `resolvePersonaRoots(db, {})` 走宿主目录约定。
   */
  const rootOptions = homeRootOverride(config)

  // 微信提醒通道适配层：ctx.get('dshIm') 软探测，未安装时静默降级。
  const adapter = new WechatChannelAdapter({
    db,
    probe: () => probeDshIm(ctx),
    readConfiguredTarget: () => ({
      botId: readMeta(db, 'reminder_bot_id') ?? null,
      targetId: readMeta(db, 'reminder_target_id') ?? null,
    }),
    queue: {
      enqueue: (entry, nextAttemptAt) => { enqueueReminder(db, { ...entry, nextAttemptAt }) },
      listDue: (nowIso) => listQueue(db).filter((entry) => entry.nextAttemptAt <= nowIso),
      remove: (id) => { removeQueueEntry(db, id) },
      markAttempt: (id, error, nextAttemptAt) => { markQueueAttempt(db, id, error, nextAttemptAt) },
      count: () => countQueue(db),
      statsSince: (iso) => countFiredRemindersSince(db, iso),
    },
  })

  const scheduler = new ReminderScheduler({
    db,
    adapter,
    /**
     * 通道是否就绪。
     *
     * 不能直接读 `adapter.status().configured` —— 它读的是适配层内存缓存 `cachedTarget`，
     * 而该缓存只在 `resolveTarget()` 里填充。进程刚启动（或插件热重载）时缓存为空，
     * 调度器会在 `channelReady` 处早退，把包括启动补发在内的**所有任务提醒静默跳过**，
     * 直到有人手动保存一次提醒设置页。
     * （草稿通知侧早已绕开这一点，见 reminder/draft-notify.ts 的注释；任务提醒侧漏修。）
     *
     * 两级判定：**缓存命中 → 数据库有显式绑定**。两者都不成立时返回 false
     * （维持"不尝试投递、不写 fired_at、留给前端"的既有语义）。
     *
     * ⚠️ **不要**在这里用 `adapter.available()` 兜底（即"装了 dsh-im 就放行"）：
     * 那会让**从未绑定过投递目标**的用户，每条到期提醒都去尝试投递 → 失败
     * （`reason: 'not-configured'`）→ 入队退避，并反复写 `reminder_channel_unavailable`
     * 事件 —— 把"安静地不做事"变成"安静地反复失败"。
     * 而 PR 原稿正是这么写的（`return adapter.available()`），本轮合入时收紧了。
     *
     * 另外注意 `resolveTarget()` 是**异步**的：这里的 `void` 调用只是顺手补一次缓存，
     * 不影响本次返回值 —— 所以"没显式绑、但恰好只有一个 bot + 一个 user target"
     * 这种自动发现场景，第一次仍返回 false（下一轮 tick 缓存命中后即恢复），
     * 这是刻意的保守取舍：宁可晚一轮，也不要给没绑目标的用户制造噪声。
     */
    isTargetConfigured: () => {
      if (adapter.status().configured) return true
      const botId = readMeta(db, 'reminder_bot_id')
      const targetId = readMeta(db, 'reminder_target_id')
      if (typeof botId === 'string' && botId.trim() !== '' && typeof targetId === 'string' && targetId.trim() !== '') return true
      // 没绑过：顺手补一次解析（可能自动发现到目标），但本次按"未就绪"处理。
      void adapter.resolveTarget().catch(() => { })
      return false
    },
    readInboundCount: () => readWeixinInboundCount(ctx),
    log: (message) => { ctx.logger?.info?.(message) },
  })

  /**
   * 知识库自动召回（v1.15.3）。
   *
   * 创建顺序很重要：必须在 `makeRoutes` **之前**拿到实例（路由要注入它），
   * 也必须与 Agent 工具、提示注入钩子共享**同一个**实例 ——
   * 单会话开关、已注入集合只有一份状态，否则"关掉了还在注入"这类矛盾必现。
   */
  const knowledgeRecall = installKnowledgeRecall(ctx, db, {
    enabled: config.knowledgeRecallEnabled,
    minScore: config.knowledgeRecallMinScore,
    maxEntries: config.knowledgeRecallMaxEntries,
  })

  /**
   * 专家服务（P5）：草稿 / 暂时文件 / 安装 / 恢复的**唯一**状态所有权。
   *
   * 必须在 `makeRoutes` **之前**建好：HTTP 路由与 5 个生成工具共用同一个实例
   * （"一份 service"是 AX-E50 的判据）。生产不传 `roots`/`now`/`failpoint` ——
   * 它们由宿主目录约定决定，**绝不**从 HTTP 请求里取。
   */
  const experts = createExpertService({ db, ctx, roots: rootOptions })

  /**
   * 启动恢复：清扫上次中断的安装（journal + `.pending`）。
   *
   * 顺序是硬要求（P3/P4 交接）：**必须在注册技能 provider 之前**跑。
   * 下面所有用到它的地方都 `await`（或 `.then`）这个 promise，所以即使将来
   * `recover()` 变成真正异步的，顺序也不会被悄悄破坏。
   * 恢复发现的问题**不阻止插件启动**：`repair-required` 只影响那一个专家。
   */
  const expertRecovery = experts.recover()
  void expertRecovery.then((issues) => {
    if (issues.length === 0) return
    ctx.logger?.warn?.(
      `[dsh-personal-workbench] 专家安装恢复发现 ${issues.length} 条待处理问题：`
      + issues.map((issue) => `${issue.code}(${issue.field})`).join('、'),
    )
  }).catch((error) => {
    const notice = `[dsh-personal-workbench] 专家安装恢复失败（插件继续加载）：${error instanceof Error ? error.message : String(error)}`
    ctx.logger?.error?.(notice)
    console.error(notice)
  })

  const routes = makeRoutes(db, {
    knowledgeRecall,
    /**
     * 角色库根覆盖（同上）：与 `loadPersonaTool` 用**同一份**覆盖项，
     * 否则"路由里选中的角色"和"工具加载的角色"会指向两套目录。
     */
    personas: rootOptions,
    /** 专家服务：路由与草稿确认/放弃分支共用（未装配时那一段整体不注册）。 */
    experts,
    /**
     * 团队记忆服务：**软探测**（`dsh-team-memory` 目前只注册 AI 工具、没有 provide 服务，
     * 所以这里通常拿不到 → 走"本地 Markdown + 队列补传"的等价通道）。
     * 绝不能把可选依赖写进 inject：那会让没装它的机器上整个插件 pending。
     */
    teamMemory: probeService<TeamMemoryService>(ctx, 'teamMemory') ?? probeService<TeamMemoryService>(ctx, 'dshTeamMemory'),
    /**
     * 宿主 `llm` 服务：只用来回答"某个模型收不收图片"（`/api/workbench/model-modalities`）。
     *
     * **软探测**，绝不进 `inject` —— 缺了只是少一条提前提示，
     * 而宿主的原生兜底（把图片换成占位文字）照常生效。
     */
    llmModalities: () => probeService<LlmModalityProbe>(ctx, 'llm'),
    channel: {
      status: () => adapter.status(),
      listOptions: () => adapter.listOptions(),
      resolveTarget: () => adapter.resolveTarget(),
    },
    policy: { read: () => readReminderPolicy(db), write: (raw) => writeReminderPolicy(db, raw) },
    /**
     * 页内提醒（前端轮询）的两条语义修正：
     * 1. **策略关闭时不返回任何提醒** —— 用户关掉提醒就该真的不弹（原先前端照旧弹）。
     * 2. **只返回窗口内的提醒** —— 超过 catchupWindowHours 的先落成终态（skipped_at），
     *    不再永久挂在「待处理」计数里；窗口内正常返回。
     */
    listDue: () => {
      const policy = readReminderPolicy(db)
      if (!policy.enabled) return []
      skipStaleReminders(db, policy.catchupWindowHours)
      return listDueRemindersInWindow(db, policy.catchupWindowHours)
    },
    test: async () => {
      const outcome = await adapter.send({ title: '工作台 · 微信提醒测试', body: `如果你在手机上看到这条消息，说明微信提醒已打通。\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}` })
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason }
    },
  })
  // 独立路由文件：保证热重载时新增/修复的“选择文件”“打开文件”“字典管理”“技能目录”接口能随入口模块一起重新加载。
  // 技能目录每次请求实时探测宿主 skills 注册表（未安装时返回空列表，前端隐藏选择器）。
  routes.unshift(makeDictionaryRoute(db), makeLocalDirRoute(), makeOpenFileRoute(), ...makeSkillRoutes({ probe: () => probeSkills(ctx) }))

  ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-personal-workbench: routes',
  )

  ctx.effect(
    () => {
      const disposers = [
        submitTaskTool(db), proposeSubtasksTool(db), proposeDailyPlanTool(db), submitReportTool(db), submitKnowledgeTool(db),
        // Amazon 计算与运营工具直接注册到 DSH 对话；测算面板与 workbench_cpc_breakeven 共用本地成本模型。
        amazonBidCalculatorTool(), amazonCpcBreakevenTool(), amazonKeywordCombinerTool(), amazonKeywordStrategyTool(), amazonKeywordPlannerTool(), amazonSearchTermVolatilityTool(), amazonTrafficAnalyzerTool(),
        // 搜索词报表的读写通道：面板导入 → agent 读原始行（含按词聚合视图）→ 词级建议 / 报表级结论写回面板（只写建议，不改广告账户）
        readSearchTermsTool(db), saveSearchTermReviewTool(db), saveSearchTermSummaryTool(db),
        // 选品判断的读写通道：技能结论落库 → 面板按结论筛选（只写判断，不改事实字段）
        readAsinJudgmentsTool(db), saveAsinJudgmentTool(db),
        proposeIdeaClustersTool(db), submitIdeaTasksTool(db), updateTaskTool(db), updateProgressTool(db), requestCompletionTool(db), submitReviewTool(db), saveTaskMemoryTool(db),
        /**
         * 角色（persona）两个工具（D12/S11）：只按**执行上下文真实 sessionId** 的绑定读，
         * 不接受任何 session/角色 id 入参（越权面在结构上不存在）。
         * 生产不注入根覆盖：三级根由设置项 + 包内资产 + 用户主目录算出来。
         */
        loadPersonaTool(db, rootOptions, (personaId, exec) => personaDependencyPreflight(experts, personaId, exec?.agent)), readPersonaResourceTool(db, rootOptions),
        // 知识库回流：模型主动查 + 自动召回的开关/引用回报（与钩子共用同一个管理器）。
        searchKnowledgeTool(knowledgeRecall), knowledgeRecallControlTool(knowledgeRecall),
        /**
         * 专家**生成通道**的 5 个工具（§5.1）：只写到 validate，正式库要等用户确认。
         * 这里**不注册任何确认/安装工具**（AX-E34）—— 那是用户在界面上的动作。
         */
        ...expertGenerationTools(experts),
        /**
         * 专家**调用主链**的 3 个工具（§8.2）：始终注册。
         * `workbench_run_expert_request` 给父会话按请求发起调用；
         * `workbench_load_invoked_expert` / `workbench_read_invoked_expert_resource`
         * 是**专家子代理自己**用的入口 —— 它们必须可用，否则子代理永远加载不了人格。
         */
        ...expertInvocationTools(experts),
      ].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    },
    'dsh-personal-workbench: tools',
  )

  /**
   * 自主专家（§8.2 + AX-E48）：`summon_expert` 工具与 `plugin:workbench-experts`
   * 提示区块**按开关动态注册 / 注销**，两者同一个 effect、各自一个 disposer。
   *
   * 三条为什么这样写：
   * 1. **开关真值只在库里**（`expert_auto_summon` 这一个 meta 键）：这里既不缓存也不猜，
   *    每次同步都重新 `autoSummonEnabled()`；HTTP 改设置 → `setAutoEnabled` → 通知 → 重同步。
   * 2. **能力也要真**：`selectSpawnProvider` 不通过（没有 `spawn`、只有 fork/远程、缺
   *    persona/toolFilter/depthLimit）时**不注册** —— 宁可少一个入口，也不给模型一个必然失败的工具。
   * 3. dispose 只摘自己注册的东西：先退订监听，再跑本轮的 disposer；**不碰 db**
   *    （`text` 回调只在提示构建时读库，不在释放期读）。
   */
  ctx.effect(
    () => {
      let disposers: Array<() => void> = []
      const release = () => {
        for (const dispose of disposers) dispose()
        disposers = []
      }
      const sync = () => {
        release()
        if (!experts.autoSummonEnabled()) return
        if (!selectSpawnProvider(probeExpertSubagents(ctx)).ok) return
        disposers.push(ctx.tools.register(summonExpertTool(experts)))
        disposers.push(ctx.systemPrompt.section({
          name: AUTO_EXPERT_PROMPT_BLOCK_NAME,
          order: AUTO_EXPERT_PROMPT_ORDER,
          /** 自主专家清单由本插件自己渲染，**不要**让宿主再插值（`{{...}}` 会误伤正文）。 */
          interpolate: false,
          text: () => buildAutoExpertPrompt({
            db,
            roots: { personasDir: experts.roots.personasDir, skillsDir: experts.roots.skillsDir, ...rootOptions, platform: process.platform },
          }).text,
        }))
      }
      const unsubscribe = experts.onAutoSummonChange(() => sync())
      sync()
      return () => {
        unsubscribe()
        release()
      }
    },
    'dsh-personal-workbench: experts-auto',
  )

  /**
   * 技能 provider（P4 的 `registerWorkbenchSkillProvider`）：**可选增量**。
   *
   * `skills` 是可选服务：一律走 `ctx.inject([...])` 子 fiber + `probeExpertSkills` 软探测，
   * **绝不能**写进顶层 `inject` —— 缺一个依赖就整个插件 pending（本仓已复发 3 次）。
   * 宿主没装 skills 时只记一条降级日志：不注册 provider，也不伪造"技能可用"。
   */
  ctx.inject(['skills'], (skillsCtx) => {
    let registration: WorkbenchSkillRegistration | undefined
    let disposed = false
    void expertRecovery.then(() => {
      if (disposed) return
      const skills = probeExpertSkills(skillsCtx)
      if (skills === undefined) {
        skillsCtx.logger?.warn?.(
          '[dsh-personal-workbench] 宿主没有 skills 服务：专家技能 provider 未注册'
          + '（依赖检查降级为 skill-service-unavailable，其余功能照常）。',
        )
        return
      }
      /**
       * `probeExpertSkills` 只保证宿主技能服务有 `list`；注册 provider 还需要
       * `registerProvider`。这里按"用到什么就检查什么"再确认一次，缺它就降级
       * （记日志、不注册），**不伪造**一个注册表。
       */
      const registerProvider = (skills as { registerProvider?: SkillRegistrarLike['registerProvider'] }).registerProvider
      if (typeof registerProvider !== 'function') {
        skillsCtx.logger?.warn?.(
          '[dsh-personal-workbench] 宿主的 skills 服务没有 registerProvider：专家技能 provider 未注册'
          + '（依赖检查降级为 skill-service-unavailable，其余功能照常）。',
        )
        return
      }
      const registrar: SkillRegistrarLike = { registerProvider: registerProvider.bind(skills) }
      registration = registerWorkbenchSkillProvider(registrar, {
        skillsDir: experts.roots.skillsDir,
        personasDir: experts.roots.personasDir,
        platform: process.platform,
      })
      /**
       * 安装器改完正式库后要刷新宿主注册表：接到**这份** registration 上
       * （只活在这个子 fiber 的生命周期里，**不当**长期单例存）。
       */
      experts.setSkillInvalidator(() => registration?.invalidateSkills() ?? false)
      skillsCtx.logger?.info?.(`[dsh-personal-workbench] 专家技能 provider「${registration.providerName}」已注册。`)
    }).catch((error) => {
      skillsCtx.logger?.warn?.(
        `[dsh-personal-workbench] 注册专家技能 provider 失败（插件继续加载）：${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return () => {
      disposed = true
      experts.setSkillInvalidator(undefined)
      registration?.dispose()
      registration = undefined
    }
  })

  // `/workbench` 斜杠命令：走宿主原生命令注册（→ 原生 `/` 菜单），不自建 DOM 补全浮层。
  registerWorkbenchCommand(ctx, db)
  /**
   * `/expert` 斜杠命令（P7 / §8.4）：与 `/workbench` **同一层**注册。
   * 语法 ` /expert <persona-id> -- <任务>`；它只建**同一条**手动 request 并把指令 steer 进本会话，
   * 真正的执行仍由模型调 `workbench_run_expert_request` → `runManual`（不另开 start 路径）。
   */
  registerExpertCommand(ctx, db, experts)

  // 提醒调度：用 ctx.interval（随 fiber 自动销毁）。
  // 注意：ctx.interval 由 @deepseek-ai/cordis-plugin-timer 提供，且**必须声明 inject** 才能访问
  // （cordis Proxy 未声明时直接抛 cannot get property "timer" without inject）。
  // 这里用 ctx.inject([...]) 把依赖限定在子 fiber：timer 不在时只有提醒调度不启动，
  // 工作台本体照常加载——保持"可选增量"这条底线。
  ctx.inject(['timer'], (timerCtx) => {
    const dispose = scheduler.start(timerCtx)
    void scheduler.catchup().catch((error) => { timerCtx.logger?.warn?.(`[workbench-reminder] catchup failed: ${String(error)}`) })
    return dispose
  })

  ctx.effect(() => {
    if ((config.announceToAgent ?? true) === false) return () => {}
    return ctx.systemPrompt.section({
      name: 'plugin:workbench',
      order: SECTION_ORDER,
      text: WORKBENCH_GUIDANCE,
    })
  }, 'dsh-personal-workbench: prompt')

  ctx.effect(() => () => { db.close() }, 'dsh-personal-workbench: db')

  /**
   * 专家服务的释放：**注册在 db 那条 effect 之后是有意的**。
   *
   * cordis 在同一个 fiber 里按注册**逆序**释放（`DisposableList.clear()` 会 `reverse()`，
   * 见 `@deepseek-ai/cordis/lib/index.js` 的 `_unload`），所以"写在后面 ⇒ 先执行"：
   * `experts.dispose()` 一定跑在 `db.close()` **之前** —— 先释放本服务拥有的东西
   * （解挂技能刷新钩子、取消自己拥有的运行），最后才关库。
   * 它**不关**别人的 service，也**不关** db。
   */
  ctx.effect(() => () => experts.dispose(), 'dsh-personal-workbench: experts')
}
