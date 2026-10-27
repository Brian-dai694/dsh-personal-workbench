/**
 * `/expert` 斜杠命令（方案 v0.3 §8.4）：`/expert <persona-id> -- <任务>`。
 *
 * ## 为什么是**宿主原生命令**而不是自建菜单
 *
 * 与 `/workbench`（v1.15.1）同一条理由：`ctx.commands.register` 注册的命令**本来就会进
 * 宿主原生 `/` 菜单**，自建 DOM 补全浮层要手动定位工作台输入框、还要自己处理主题与定位，
 * 是重复实现且易碎（本仓明确禁止，见 `pluginEntry.test.mjs` 的源码级扫描）。
 *
 * ## 语法要点（§8.4，逐条都有 AX-E47 用例）
 *
 * 1. 以**第一个** `" -- "` 分隔（空格 + 两个半角连字符 + 空格）；
 * 2. 左边 `trim()` 是**完整逻辑 ID**，右边 `trim()` 是任务；
 * 3. **不按显示名模糊匹配**：`/expert 需求审查专家 -- …` 必须失败并提示用 ID ——
 *    显示名可以重复、可以改，拿它当身份会让"同名不同 ID"静默选错（本仓夹具有这一例）；
 * 4. 无参数 → `kind:'error'` + 帮助 + 最多 20 条可用 ID；
 * 5. 缺任务（有 `--` 但右侧为空，或压根没有分隔符）→ `kind:'error'` 且**不创建 request**。
 *
 * ## 执行路径**只有一条**（§8.4 末条）
 *
 * handler 只做三件事：建同一条手动 request（`service.createManualRequest`）→
 * `agent.steer(createUserMessage(...))` 把"含 requestId + 任务的指令"送进父会话 →
 * 回 success。**绝不**在这里直接 `start` 子代理：真正的执行永远由模型调
 * `workbench_run_expert_request` → `service.runManual`（并发位、请求表、开关复查都是单份的）。
 *
 * ## 为什么可测
 *
 * 解析是纯函数（`parseExpertCommand`）；命令定义是工厂 `expertCommandDefinition(db, { experts })`，
 * 测试直接驱动 `handler`，无需 cordis 上下文。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { DatabaseSync } from 'node:sqlite'

import type { ExpertCatalogResponse, ExpertService } from './service.js'
import { buildExpertInvocationPrompt } from '../shared/expertPrompt.js'

/** 菜单里显示的帮助头（也用于两个错误分支的提示）。 */
export const EXPERT_COMMAND_USAGE = '/expert <persona-id> -- <任务>'
/** 帮助里最多列出的可用 ID 条数（§8.4）。 */
export const EXPERT_COMMAND_HELP_MAX_IDS = 20

/** 解析结果：`ok:true` 一定带非空 `personaId`；`code` 给调用方决定文案与是否建请求。 */
export type ExpertCommandParse =
  | { ok: true; personaId: string; task: string }
  | { ok: false; code: 'empty' | 'missing-separator' | 'missing-persona' | 'missing-task' }

/**
 * 纯解析（§8.4）：按**第一个** `" -- "` 分隔，左右两侧 `trim()` 后分别是逻辑 ID 与任务。
 *
 * 为什么是"整串 `trim()` 之后**只**判一次空"：
 * - 宿主传进来的 `rawInput` 常常带一个前导空格（`/expert ID -- 任务` 里命令名后面那个），
 *   不先去掉就会让左侧 ID 多一个字符；尾随空白同样要去掉（`ID -- 任务   ` 才是干净的 task）。
 * - 分隔符严格是"空格 + 两个连字符 + 空格"。因此 `ID --任务`、`ID-- 任务`、`ID --    `
 *   （右侧只有空白时整串 trim 会连分隔符右侧的空格一起吃掉）、`   -- 任务`（左侧同理）
 *   全都落到 `missing-separator`：它们都是"格式不对"。
 * - 于是 **`missing-persona` / `missing-task` 这两个 code 不可达**（`" -- "` 能匹配上 ⇒
 *   分隔符左右各自至少有一个字符），所以这里**不再写那两个分支** —— 写了也没有任何输入能走到，
 *   只会让后来的读者以为"有一条被测过的缺 ID 路径"。真实用户输入 `/expert -- 任务` 得到的是
 *   帮助 + "缺少专家 ID" 的提示文案（见 `failureText`），那才是他要的信息。
 *
 * @param rawInput - 命令名之后、原样的输入（含分隔空白）。
 * @returns 解析结果；失败只可能是 `empty`（要帮助）或 `missing-separator`（格式不对）。
 */
export function parseExpertCommand(rawInput: unknown): ExpertCommandParse {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text === '') return { ok: false, code: 'empty' }
  const at = text.indexOf(' -- ')
  if (at < 0) return { ok: false, code: 'missing-separator' }
  return { ok: true, personaId: text.slice(0, at).trim(), task: text.slice(at + 4).trim() }
}

/** 帮助里列的可用 ID（纯函数）：沿用 catalog 顺序，最多 20 条。 */
export function expertHelpIds(catalog: ExpertCatalogResponse | undefined): string[] {
  const personas = Array.isArray(catalog?.personas) ? catalog.personas : []
  const ids: string[] = []
  for (const persona of personas) {
    if (typeof persona?.id !== 'string' || persona.id.trim() === '') continue
    ids.push(persona.id.trim())
    if (ids.length >= EXPERT_COMMAND_HELP_MAX_IDS) break
  }
  return ids
}

/** 帮助正文（纯函数）：用法 + 一个例子 + 至多 20 条可用 ID。 */
export function expertCommandHelp(ids: readonly string[]): string {
  const head = `用法：${EXPERT_COMMAND_USAGE}\n例：/expert generated/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa -- 审查这份需求的遗漏`
  if (ids.length === 0) return `${head}\n当前没有可用的专家 ID（先在「工作台 → 专家」里生成或启用一个专家）。`
  return `${head}\n可用专家 ID（最多列 ${EXPERT_COMMAND_HELP_MAX_IDS} 条）：\n${ids.map((id) => `- ${id}`).join('\n')}`
}

/** 宿主命令定义里我们用到的**最小**形状（与 `@deepseek-ai/dsh-commands` 的 d.ts 结构一致）。 */
export interface ExpertCommandAgentProbe {
  /** 真实运行时身份：`agent.session.id`（本仓 16 处同口径；`session.header` 由 invocation 再校验）。 */
  readonly session?: { readonly id?: unknown }
  readonly steer?: (message: unknown) => void
}

export interface ExpertCommandInvocationProbe {
  readonly agent?: ExpertCommandAgentProbe
  readonly rawInput?: string
}

/** `handler` 允许同步或异步（真实 d.ts：`CommandResult | Promise<CommandResult>`）。 */
export interface ExpertCommandDefinitionProbe {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
  readonly handler: (invocation: ExpertCommandInvocationProbe) =>
    { readonly kind: 'success' | 'error'; readonly text: string }
    | Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>
}

export interface ExpertCommandDeps {
  /** 专家服务（唯一状态所有权：请求表 / 并发位 / 开关都在它后面）。 */
  readonly experts: ExpertService
  /**
   * 目录读取失败时**不阻断命令**：帮助退化成"没有可用 ID"，
   * 而合法命令仍会走 preflight（真正的可用性判据在那一层）。
   */
  readonly catalog?: (query?: string) => Promise<ExpertCatalogResponse>
}

/**
 * 可读的失败文案（一处产出）。
 *
 * `missing-separator` 这条**故意写得覆盖面大一点**：`/expert ID -- 任务` 里少一个空格、
 * 少 ID、少任务，用户拿到的都是这一条。理由是解析层能可靠区分的只有"分隔符在不在"
 * （见 `parseExpertCommand` 的注释），把三种"猜"写成三种文案只是假装分得清；
 * 而帮助里已经把正确格式和一个真实例子都列出来了。
 */
function failureText(parse: Extract<ExpertCommandParse, { ok: false }>, help: string): string {
  if (parse.code === 'missing-separator') {
    return `缺少分隔符（或分隔符两侧不完整）：格式是 ${EXPERT_COMMAND_USAGE}，`
      + `即"空格 + 两个连字符 + 空格"两侧都要有内容（ID 与任务）。\n${help}`
  }
  /** 只剩 `empty`：用户其实是想看帮助（宿主把它按"参数错"呈现，所以仍然是 error）。 */
  return help
}

/**
 * 造 `/expert` 命令定义。
 *
 * @param db - 工作台库（保留入参以便与 `/workbench` 同形：命令常驻不需要额外状态）。
 * @param deps - `{experts, catalog?}`。
 */
export function expertCommandDefinition(db: DatabaseSync, deps: ExpertCommandDeps): ExpertCommandDefinitionProbe {
  void db
  const experts = deps?.experts
  if (experts === undefined || typeof experts.createManualRequest !== 'function') {
    throw new Error('注册 /expert 命令失败：没有专家服务（命令会建不出请求）')
  }
  const readCatalog = typeof deps.catalog === 'function'
    ? deps.catalog
    : (query?: string) => experts.catalog(query)

  const loadHelp = async (): Promise<string> => {
    try {
      return expertCommandHelp(expertHelpIds(await readCatalog()))
    } catch {
      /** 目录读不出来不影响"合法命令照常可用"：帮助退化成一份无 ID 的用法说明。 */
      return expertCommandHelp([])
    }
  }

  return {
    name: 'expert',
    description: '按 ID 指定专家执行本轮任务（/expert <persona-id> -- <任务>）',
    input: { hint: '<persona-id> -- <任务>' },

    async handler({ agent, rawInput }) {
      const parse = parseExpertCommand(rawInput)
      if (parse.ok === false) {
        /** 空输入是"要帮助"，不算错；其余是用法错（都不建 request）。 */
        const help = await loadHelp()
        return { kind: 'error', text: failureText(parse, help) }
      }

      const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id.trim() : ''
      if (sessionId === '') {
        return { kind: 'error', text: '当前会话拿不到真实会话身份（agent.session.id 不可用），/expert 无法建立专家调用请求；请改用工作台面板的专家入口。' }
      }
      if (typeof agent?.steer !== 'function') {
        return { kind: 'error', text: '当前会话不能接收命令转发（agent.steer 不可用），/expert 无法把专家指令送入本会话；请改用工作台面板的专家入口。' }
      }

      /**
       * §4.2 + P6 交接 §9-2：`expectedSourceKey` / `expectedRevision` **只能**取
       * `service.preflight(personaId, liveAgent).summary` —— 目录列表里的值在运行时必然
       * `revision-changed`。这里用的是**本次命令带入的真实 live agent**（不是 HTTP 预检）。
       */
      let sourceKey = ''
      let revision = ''
      let expertName = parse.personaId
      try {
        const preflight = await experts.preflight(parse.personaId, agent)
        sourceKey = typeof preflight?.summary?.sourceKey === 'string' ? preflight.summary.sourceKey.trim() : ''
        revision = typeof preflight?.summary?.revision === 'string' ? preflight.summary.revision.trim() : ''
        if (typeof preflight?.summary?.name === 'string' && preflight.summary.name.trim() !== '') {
          expertName = preflight.summary.name.trim()
        }
        if (sourceKey === '' || revision === '') {
          const detail = preflight?.issues?.map((issue) => issue.message).join('；') ?? ''
          return {
            kind: 'error',
            text: `专家「${parse.personaId}」当前不可用${detail === '' ? '' : `：${detail}`}。请用 ${EXPERT_COMMAND_USAGE} 里的 ID 重试（无参数可以看到可用 ID 列表）。`,
          }
        }
      } catch (error) {
        return {
          kind: 'error',
          text: `预检专家「${parse.personaId}」失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }

      let requestId = ''
      try {
        const created = experts.createManualRequest({
          sessionId,
          personaId: parse.personaId,
          expectedSourceKey: sourceKey,
          expectedRevision: revision,
        })
        requestId = created.requestId
      } catch (error) {
        return {
          kind: 'error',
          text: `创建专家调用请求失败：${error instanceof Error ? error.message : String(error)}。请求没有建立，本轮没有调用任何专家。`,
        }
      }

      /**
       * steer 的写法**逐字镜像** `/workbench`（`src/index.ts:246-249` 的 steer 调用；`createUserMessage` 本身从 `src/index.ts:9` 起就已是本插件的既有 import 口径）：`createUserMessage` +
       * `source:{kind:'user'}`。不自创消息形状 —— 自创的那份迟早与宿主/其它入口不一致。
       */
      try {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: buildExpertInvocationPrompt({ requestId, task: parse.task }) }],
          source: { kind: 'user' },
        }))
      } catch (error) {
        return {
          kind: 'error',
          text: `专家调用请求已建立（request id ${requestId}），但把指令送入会话失败：${error instanceof Error ? error.message : String(error)}。请重试或改用工作台面板入口。`,
        }
      }

      return {
        kind: 'success',
        text: `已把专家「${expertName}」的调用指令送入当前会话（request id ${requestId}）；请让本轮任务以独立子代理执行。`,
      }
    },
  }
}
