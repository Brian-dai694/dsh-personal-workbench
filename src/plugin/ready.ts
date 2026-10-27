/**
 * 数据库可用时的**完整装配**（原 `apply` 主体）。
 *
 * 顺序是有约束的，不要随手调：
 * 1. 知识召回实例必须在 `makeRoutes` **之前**建好（路由与工具、提示钩子共用同一份状态）；
 * 2. 专家服务同理（HTTP 路由与 5 个生成工具共用一份状态所有权）；
 * 3. 专家恢复（`recover()`）必须在注册技能 provider **之前**启动；
 * 4. 释放顺序靠 cordis 同 fiber **逆序**释放：`experts.dispose()` 写在 `db.close()` 之后 ⇒ 先执行。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { makeDictionaryRoute } from '../api/dictionaryRoute.js'
import { makeLocalDirRoute } from '../api/localDirRoute.js'
import { makeOpenFileRoute } from '../api/openFileRoute.js'
import { makeRoutes } from '../api/routes.js'
import type { LlmModalityProbe } from '../api/routes/model-modalities.js'
import { makeSkillRoutes } from '../api/routes/skills.js'
import { probeSkills } from '../api/skills.js'
import { countFiredRemindersSince, countQueue, enqueueReminder, listDueRemindersInWindow, listQueue, markQueueAttempt, readMeta, removeQueueEntry, skipStaleReminders } from '../db/repo.js'
import { installKnowledgeRecall } from '../knowledge/recall.js'
import { knowledgeRecallControlTool, searchKnowledgeTool } from '../knowledge/tools.js'
import { probeDshIm, WechatChannelAdapter } from '../reminder/adapter.js'
import { readReminderPolicy, writeReminderPolicy } from '../reminder/config.js'
import { ReminderScheduler } from '../reminder/scheduler.js'
import { readWeixinInboundCount } from '../reminder/weixin-status.js'
import type { TeamMemoryService } from '../memory/review-memory.js'
import { loadPersonaTool, proposeDailyPlanTool, proposeIdeaClustersTool, proposeSubtasksTool, readPersonaResourceTool, requestCompletionTool, saveTaskMemoryTool, submitIdeaTasksTool, submitKnowledgeTool, submitReportTool, submitReviewTool, submitTaskTool, updateProgressTool, updateTaskTool, type PersonaDependencyPreflight } from '../tools/workbench.js'
import { amazonBidCalculatorTool, amazonCpcBreakevenTool, amazonKeywordCombinerTool, amazonKeywordPlannerTool, amazonKeywordStrategyTool, amazonSearchTermVolatilityTool, amazonTrafficAnalyzerTool, readAsinJudgmentsTool, readSearchTermsTool, saveAsinJudgmentTool, saveSearchTermReviewTool, saveSearchTermSummaryTool } from '../amazon/tools.js'
import { AUTO_EXPERT_PROMPT_BLOCK_NAME, AUTO_EXPERT_PROMPT_ORDER, buildAutoExpertPrompt } from '../experts/catalog.js'
import { probeExpertSkills, probeExpertSubagents, selectSpawnProvider } from '../experts/host-adapter.js'
import { createExpertService, type ExpertService } from '../experts/service.js'
import { registerWorkbenchSkillProvider, type SkillRegistrarLike, type WorkbenchSkillRegistration } from '../experts/skill-provider.js'
import { expertGenerationTools, expertInvocationTools, summonExpertTool } from '../experts/tools.js'
import { homeRootOverride, type Config } from './config.js'
import { probeService } from './probe.js'
import { registerExpertCommand, registerWorkbenchCommand } from './commands.js'
import { WORKBENCH_GUIDANCE, SECTION_ORDER } from './prompt.js'

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

export function applyReady(ctx: Context, db: DatabaseSync, config: Config): void {
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
