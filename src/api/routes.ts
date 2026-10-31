/**
 * /api/workbench/* 路由入口。Loopback-only 保护（同 dsh-ssh 的信任围栏）。
 *
 * 领域路由已拆分到 routes/：tasks / reminders / drafts / ideas / idea-clusters /
 * knowledge / ai-sessions / reports / plans / settings。本文件保留组合入口与跨领域基础端点
 * （workspaces/ensure、bootstrap、maintenance、health）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  ensureRecurringInstances, fireReminder, getDailyPlan, getTask, listDictionaries, listDueReminders, listTasks,
  localDateString, readMeta, repairParentCompletion, taskStatusIndex,
} from '../db/repo.js'
import { makeAiSessionRoutes } from './routes/ai-sessions.js'
import { makeAmazonDatasetRoutes } from './routes/amazon-datasets.js'
import { makeAmazonTablePreviewRoutes } from './routes/amazon-table-preview.js'
import { makeAmazonImportRoutes } from './routes/amazon-import.js'
import { makeUniverOfficeRoutes } from './routes/univer-office.js'
import { makeDraftRoutes } from './routes/drafts.js'
import { makeExpertRoutes } from './routes/experts.js'
import { isLoopbackRequest, readJsonBody, todayRange, writeJson } from './routes/helpers.js'
import { makeIdeaClusterRoutes } from './routes/idea-clusters.js'
import { makeIdeaRoutes } from './routes/ideas.js'
import { makeKnowledgeRoutes } from './routes/knowledge.js'
import { makeKnowledgeRecallRoutes } from './knowledgeRecallRoute.js'
import type { KnowledgeRecallManager } from '../knowledge/recall.js'
import { makeModelModalityRoutes, type LlmModalityProbe } from './routes/model-modalities.js'
import { makeAsinRoutes } from './routes/asin.js'
import { makeProductRoutes } from './routes/products.js'
import { makeInventoryRoutes } from './routes/inventory.js'
import { makeOplogRoutes } from './routes/oplog.js'
import { makeKeywordPlanRoutes } from './routes/keyword-plans.js'
import { makeCalculatorScenarioRoutes } from './routes/calculator-scenarios.js'
import { makeAbaKeywordRoutes } from './routes/aba-keywords.js'
import { makePlanRoutes } from './routes/plans.js'
import { makeSettingsRoutes } from './routes/settings.js'

// 仍对外导出读模型与区间常量（外部/测试曾从本文件取用；实现已搬到 routes/settings.ts）
export { DEFAULT_DAILY_CAPACITY_MINUTES, DEFAULT_SETTINGS_ESTIMATE_MINUTES, MAX_SETTINGS_ESTIMATE_MINUTES, MIN_SETTINGS_ESTIMATE_MINUTES, readDailyCapacityMinutes, readDefaultEstimateMinutes, readRecentWorkspaces, readWorkbenchSettings } from './routes/settings.js'
export type { SettingsRouteDeps } from './routes/settings.js'
import { makePersonaRoutes, type PersonaRouteOptions } from './routes/personas.js'
import { makeQuickAttachmentRoutes } from './routes/quick-attachments.js'
import { makeReminderRoutes, type ReminderRouteDeps } from './routes/reminders.js'
import { makeReportRoutes } from './routes/reports.js'
import { makeTaskRoutes } from './routes/tasks.js'
import type { TeamMemoryService } from '../memory/review-memory.js'
import { teamMemoryAvailable } from '../memory/review-memory.js'
import type { ExpertService } from '../experts/service.js'
import { classifyTaskDay, dayPlacedIds } from '../shared/dailyPlanPolicy.js'
import { isOpenTask } from '../shared/taskProgress.js'

/**
 * 插件版本：直接读包内 package.json，避免再出现"代码已升级、health 还报旧版本"的漂移。
 * lib/api/routes.js 相对包根是 ../../package.json。
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch { return 'unknown' }
})()

/**
 * 构建标识（plan.md V04-B）：读**随包**的 `lib/build-info.json`。
 *
 * lib/api/routes.js 相对包根是 ../../lib/build-info.json —— 与 PACKAGE_VERSION 同一层目录。
 * 它由 scripts/build-info.mjs 在构建时生成，内容哈希来自构建输入（不含时间戳）。
 *
 * 为什么 health 必须报它：版本号在装盘迭代里**根本不变**（本地迭代刻意不改版本号），
 * 只比版本号会把"旧包还在跑"判成通过。验收链同时比对目标包 manifest / host health /
 * 浏览器根属性三者，缺一即失败。
 */
const PACKAGE_BUILD_ID: string = (() => {
  try {
    const info = JSON.parse(readFileSync(new URL('../../lib/build-info.json', import.meta.url), 'utf8')) as { buildId?: string }
    return typeof info.buildId === 'string' && info.buildId !== '' ? info.buildId : 'unknown'
  } catch { return 'unknown' }
})()

export interface WorkbenchRouteDeps extends ReminderRouteDeps {
  /**
   * 团队记忆服务（`dsh-team-memory` 目前**并未** provide 任何服务，所以通常是 undefined）。
   * 软探测拿到时才注入；拿不到就走"本地 Markdown + 队列补传"的等价通道。
   */
  teamMemory?: TeamMemoryService
  /**
   * 宿主 `llm` 服务的**软探测**（v1.15.1）。
   *
   * 只用来回答"某个模型收不收图片"（见 `routes/model-modalities.ts`）。
   * **绝不能写进 `inject`**：它是可选增强，缺了只是少一条提前提示，
   * 写进去会让旧宿主上整个插件 pending（该模式在本仓已复发 3 次）。
   */
  llmModalities?: () => LlmModalityProbe | undefined
  /**
   * 知识库自动召回管理器（v1.15.3）。
   *
   * 由入口（`index.ts`）创建并注入 —— **不是**这里 new 一个：
   * 它同时被 Agent 工具与提示注入钩子使用，单会话开关/已注入集合必须只有一份状态。
   * 未注入（测试里的朴素用法）时这几个端点不注册，其余路由照常。
   */
  knowledgeRecall?: KnowledgeRecallManager
  /**
   * 角色库路由的可注入选项（D11）。
   *
   * **只给测试用**：生产三个根由 `resolvePersonaRoots` 从设置项 + 包内资产 + `homedir()`
   * 算出来。留这个口是因为 `homedir()` 不认环境变量 —— 没有它，"用户库覆盖内置"
   * 这条覆盖顺序只能用假的对象测，而不是真实文件。
   */
  personas?: PersonaRouteOptions
  /**
   * 专家服务（P5）。
   *
   * 由入口（`index.ts`）创建并注入 —— **不是**这里 new 一个：草稿/安装/恢复的
   * 状态所有权只有一份，路由与 5 个生成工具共用同一个实例。
   * 未注入（测试里的朴素用法、或旧宿主）时 `/api/workbench/experts` 整段不注册、
   * 草稿确认的 `expert` 分支也不接管 —— 其余路由照常，插件不会 pending。
   */
  experts?: ExpertService
  /**
   * Univer 软探测（并入 CSV 版块的表格能力）。
   *
   * 传的是 `() => ctx.get('univer')` —— **每次请求现探**，而不是启动时探一次缓存：
   * 用户可能在运行中装上/卸掉 `dsh-univer-office`，缓存会让界面一直说"没装"。
   *
   * 未注入（测试里的朴素用法）时这两条路由不注册，其余路由照常。
   */
  probeUniver?: () => unknown
}

export function makeRoutes(db: DatabaseSync, deps: WorkbenchRouteDeps = {}): WebRoute[] {
  return [
    // ------------------------------------------------------------------ quick attachments
    // PDF/DOCX 正文抽取（护栏见 routes/quick-attachments.ts 的文件头注释）。
    ...makeQuickAttachmentRoutes(),
    // 模型输入能力对照表（客户端用它判断"选了不收图的模型还加了图"）。
    ...makeModelModalityRoutes(() => deps.llmModalities?.()),
    /**
     * 知识库自动召回的可观测端点（日志 / 状态 / 开关，v1.15.3）。
     *
     * 与其余路由一样 loopback-only；`knowledgeRecall` 由入口注入（与 Agent 工具、
     * 提示注入钩子共享同一个管理器实例 → 单会话开关只有一份状态）。
     */
    ...(deps.knowledgeRecall === undefined ? [] : makeKnowledgeRecallRoutes(db, deps.knowledgeRecall)),
    ...makeReminderRoutes(db, {
      channel: deps.channel,
      policy: deps.policy,
      test: deps.test,
      // 优先用调用方注入的实现（入口会带上"策略开关 + 补发窗口"语义）；
      // 未注入时退回朴素版本，供测试等场景直接使用。**不要在这里硬编码覆盖**——
      // 曾经因为硬编码 listDueReminders(db) 把入口注入的策略/窗口语义悄悄吃掉。
      listDue: deps.listDue ?? (() => listDueReminders(db)),
      fire: deps.fire ?? ((id: string) => fireReminder(db, id)),
    }),
    // ------------------------------------------------------------------ personas
    /**
     * 角色库（D11）：摘要列表 + 资源只读读取。
     *
     * 三级来源的**根解析只有一处**（`resolvePersonaRoots`）：外部根读设置项，
     * 用户库在 `~/.dsh/workbench/personas`，内置库在包内 `assets/personas`。
     * `deps.personas` 只用于**测试注入根**（生产不传）。
     */
    ...makePersonaRoutes(db, deps.personas ?? {}),
    // ------------------------------------------------------------------ experts
    /**
     * 专家生成（P5 §4.1）：能力 / catalog / 方法论 / 建草稿 / 草稿详情 / 校验 / 读暂存文件 / preflight。
     *
     * `deps.experts === undefined` 时整段不注册：没有服务就不该有"看起来能用"的端点
     * （能力缺失要按 §10 明确报 503/404，而不是让请求打到空实现上）。
     */
    ...makeExpertRoutes(db, deps.experts),
    // ------------------------------------------------------------------ workspace ensure
    {
      kind: 'exact',
      path: '/api/workbench/workspaces/ensure',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        const path = typeof body?.path === 'string' && body.path.trim() !== '' ? body.path.trim() : undefined
        if (path === undefined) return writeJson(res, 400, { error: 'path is required' })
        try {
          mkdirSync(path, { recursive: true })
          return writeJson(res, 200, { ok: true, path })
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------------ bootstrap
    {
      kind: 'exact',
      path: '/api/workbench/bootstrap',
      handler(req, res) {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const now = new Date()
        const { start, end } = todayRange(now)
        ensureRecurringInstances(db, localDateString(now))
        const tasks = listTasks(db)
        const plan = getDailyPlan(db, localDateString(now))
        /**
         * 统计卡用**与日期面板同一把尺子**（`classifyTaskDay`，日界 = 本地日 00:00）。
         *
         * 旧实现是两把尺子：逾期用 `now`（"今天 09:00 截止、现在 20:00" 算逾期），
         * 今天到期用日界（同一条又算"今天到期"）—— 同一个任务在两张卡上同时计数。
         * 2026-10-02 用户拍板统一（见 ADR0001 口径补充），判定只在共享纯函数里。
         */
        const dayStartMs = Date.parse(start)
        const dayEndMs = Date.parse(end)
        const planTaskIds = new Set((plan?.items ?? []).map((item) => item.taskId))
        /**
         * 「已安排」走 ADR0010 的子树继承口径（`dayPlacedIds`，全项目唯一判定）：
         * 非叶子任务要它子树内的叶子全排了才算已安排。这里虽然当前只用于统计卡的
         * 到期/逾期/进行中，但**判定口径必须与日期面板、候选池同一份** ——
         * 各自再写一遍 `planTaskIds.has(id)` 就是下一个"同一语义两处实现"。
         */
        const placed = dayPlacedIds(tasks, plan?.items ?? [])
        const openFacts = tasks
          .filter((task) => isOpenTask({ statusCode: task.statusCode, archived: task.archived }))
          .map((task) => classifyTaskDay({
            effectiveDueAt: task.effectiveDueAt,
            statusCode: task.statusCode,
            planned: placed.has(task.id),
            dayStartMs,
            dayEndMs,
          }))
        /**
         * 计划视图（T2/D06）：**原样保留**每一项的 `minutes`/`effortDone`/`taskStatusCode`。
         *
         * 旧实现按 `getTask` 过滤掉了"任务已删除"的项 —— 那是静默丢件：用户看到的是
         * "计划里少了一条，又没人说"。现在缺失任务照样返回（`taskStatusCode: 'missing'`），
         * 由界面标注，容量也照它的快照计入已排（requirements §4.2、AX-C04）。
         */
        const planTaskStatus = taskStatusIndex(db)
        const planView = plan === undefined ? null : {
          ...plan,
          items: plan.items.map((item) => ({
            taskId: item.taskId,
            order: item.order,
            title: item.title,
            note: item.note,
            minutes: item.minutes,
            effortDone: item.effortDone,
            taskStatusCode: planTaskStatus.get(item.taskId) ?? 'missing',
          })),
        }
        writeJson(res, 200, {
          ok: true,
          dictionaries: listDictionaries(db),
          stats: {
            overdue: openFacts.filter((facts) => facts.overdue).length,
            todayDue: openFacts.filter((facts) => facts.dueToday).length,
            doing: openFacts.filter((facts) => facts.inProgress).length,
            total: tasks.length,
          },
          todayPlan: planView,
          now: now.toISOString(),
          /**
           * 团队记忆是否可用（v1.14.58）。
           *
           * 它是**内部系统**、不会开源，所以界面必须能知道"这台机器上有没有"：
           * 拿不到就整块不渲染「同步到团队记忆库」，否则开源用户会看到一个永远用不了的勾选框。
           * 判据在 `teamMemoryAvailable()`（看 `~/.dsh/memory` 是否存在，或环境变量显式声明）。
           */
          memoryAvailable: teamMemoryAvailable(),
        })
      },
    },
    ...makeTaskRoutes(db),
    // ------------------------------------------------------------------ maintenance
    {
      kind: 'exact',
      path: '/api/workbench/maintenance/repair-parents',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'GET') !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const changed = repairParentCompletion(db)
          return writeJson(res, 200, { ok: true, changed })
        } catch (error) {
          return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    ...makeDraftRoutes(db, { teamMemory: deps.teamMemory, experts: deps.experts }),
    ...makeIdeaRoutes(db),
    ...makeIdeaClusterRoutes(db),
    ...makeKnowledgeRoutes(db),
    ...makeAmazonDatasetRoutes(db, { probeUniver: deps.probeUniver }),
    // 统一导入（P2-2）：六种报表同一套列校验；旧 datasets 写入路由内部也调它。
    ...makeAmazonImportRoutes(db),
    /**
     * 无持久化表格预览（2026-10-30）：产品库/付款对账这类派生视图的表格出口。
     * **总是注册**（即便没装配探测函数）：这样未装 Univer 时前端收到的是 503 UNIVER_MISSING，
     * 而不是 404 —— 404 会被误读成"接口写错了"。
     */
    ...makeAmazonTablePreviewRoutes(deps.probeUniver),
    // 表格能力桥：CSV -> .univer（并入报表/关键词页的 CSV 出口）。未装配探测函数时整段不注册。
    ...(deps.probeUniver === undefined ? [] : makeUniverOfficeRoutes(deps.probeUniver)),
    ...makeOplogRoutes(db),
    ...makeAsinRoutes(db),
     ...makeProductRoutes(db),
    ...makeInventoryRoutes(db),
    ...makeKeywordPlanRoutes(db),
    ...makeCalculatorScenarioRoutes(db),
    ...makeAbaKeywordRoutes(db),
    ...makeAiSessionRoutes(db),
    ...makeReportRoutes(db),
    ...makePlanRoutes(db),
    ...makeSettingsRoutes(db, { knowledgeRecall: deps.knowledgeRecall, experts: deps.experts }),
    // ------------------------------------------------------------------ health
    {
      kind: 'exact',
      path: '/api/workbench/health',
      handler(_req, res) {
        if (!isLoopbackRequest(_req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const schemaVersion = readMeta(db, 'schema_version')
        writeJson(res, 200, {
          ok: true,
          name: '@dely0/dsh-personal-workbench',
          version: PACKAGE_VERSION,
          buildId: PACKAGE_BUILD_ID,
          db: {
            schemaVersion: schemaVersion ?? 'unknown',
            taskCount: listTasks(db, { includeArchived: true }).length,
            dictionaryCount: listDictionaries(db).length,
          },
        })
      },
    },
  ]
}
