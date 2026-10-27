/**
 * 两个斜杠命令：`/workbench`（快速录入）与 `/expert`（专家调用）。
 *
 * 两者都是**宿主原生命令**（`ctx.commands.register`），所以命令本体单独导出：
 * 注册外壳需要 cordis 上下文，而 handler 才是真正有语义、也真正该被单测直接驱动的部分
 * （见 `test/pluginEntry.test.mjs`）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeHostPath } from '../api/routes/helpers.js'
import { readMeta } from '../db/repo.js'
import { expertCommandDefinition } from '../experts/command.js'
import type { ExpertService } from '../experts/service.js'
import { taskWorkspaceFolderName } from '../shared/taskFolder.js'
import { probeService } from './probe.js'
import { WORKBENCH_INTAKE_COMMAND_PROMPT } from './prompt.js'

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
export function registerWorkbenchCommand(ctx: Context, db: DatabaseSync): void {
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
export function registerExpertCommand(ctx: Context, db: DatabaseSync, experts: ExpertService): void {
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
