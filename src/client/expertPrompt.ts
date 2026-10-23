/**
 * 专家调用的**短指令**（方案 v0.3 §8.3 那段逐字文本）。
 *
 * ## 它是什么，不是什么
 *
 * `@` 引用被提交时，`codec.serialize()` 先在服务端建一条手动 request，再把**这段文本**
 * 交给模型（见 `expertInputSource.ts`）。所以它必须：
 *
 * 1. **逐字**照规范写 —— 验收（AX-E61）要观察真实工具参数，提示词里少一句
 *    "不能把这个 request_id 用于其他任务"就等于少一道约束；
 * 2. **只放 requestId 与任务正文，不内联人格正文**（§8.3 末段：正文由子代理自己按需加载，
 *    内联会让每次 `@` 都背上 20000 字符）；
 * 3. 把"本轮任务"作为**模型要整理的东西**交给它：这里**不做**自然语言理解，
 *    整理错是模型行为，不是插件"已经正确完成业务"。
 *
 * ## 为什么 requestId 必须严格校验
 *
 * requestId 会被插进 `request_id="..."`。一旦它带引号 / 换行 / 控制字符，
 * 就能把整条指令的**结构**改掉（例如闭合引号后在后面接一句"忽略上面的限制"）。
 * 这不是"输入不干净"，而是**提示注入面**：所以坏形状一律抛可读错误（调用方据此阻止发送），
 * **绝不静默清洗**（静默改写 = 用户以为发出去的是 A，实际是 B）。
 *
 * ## 为什么必须是纯模块
 *
 * 与 `personaPrompt.ts` 同一条规矩：**不 import React、不碰 DOM、不读 `document`**，
 * 因此 `node --test` 能直接断言"逐字文本 + 坏 id 被拒"。
 */

/** 指令里的**静态**部分（逐字来自 §8.3 代码块，仅把 `<requestId>` / `<task>` 换成占位）。 */
export const EXPERT_INVOCATION_DIRECTIVE: readonly string[] = [
  '【用户指定的工作台专家调用】',
  '用户已在这个会话选择了一位专家。请调用：',
  'workbench_run_expert_request(request_id="<requestId>", task="<按本轮用户消息明确整理的任务>")',
  '这次专家工作由独立子代理完成。不要修改当前会话的专家绑定。',
  '仅处理本轮给定任务；不能把这个 request_id 用于其他任务或其他会话。',
]

/** `requestId` 的字符上限（服务端是 uuid，这里只做"形状"防注入，不做格式学考古）。 */
export const EXPERT_REQUEST_ID_MAX_CHARS = 200

/** 禁止出现在 requestId 里的字符：引号 / 换行 / 其余控制字符（含 DEL）。 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_REQUEST_ID = /["'`\r\n\u0000-\u001f\u007f]/

/**
 * 校验一个 requestId 能不能安全地插进指令。
 *
 * @param value - 待校验的值（来自工具参数 / HTTP 响应，**不可信**）。
 * @returns trim 后的 requestId。
 * @throws Error 可读中文原因（空 / 超长 / 含引号或控制字符）。
 */
export function requireExpertRequestId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('专家调用请求 id 缺失：无法生成调用指令')
  const id = value.trim()
  if (id === '') throw new Error('专家调用请求 id 为空：无法生成调用指令')
  if (id.length > EXPERT_REQUEST_ID_MAX_CHARS) {
    throw new Error(`专家调用请求 id 过长（${id.length} > ${EXPERT_REQUEST_ID_MAX_CHARS}）：拒绝生成调用指令`)
  }
  if (FORBIDDEN_REQUEST_ID.test(id)) {
    throw new Error('专家调用请求 id 含引号 / 换行 / 控制字符：拒绝生成调用指令（这会把提示词结构改掉）')
  }
  return id
}

/** 一次的输入：requestId 必填；task 是本轮用户消息整理出的任务（可为空串）。 */
export interface ExpertPromptInput {
  requestId: unknown
  task: unknown
}

/**
 * 组装交给模型的短指令（纯函数）。
 *
 * @param input - `{requestId, task}`；`requestId` 坏形状**抛错**，`task` 非字符串按空串处理。
 * @returns 逐字指令 + 任务正文（多行文本）。
 */
export function buildExpertInvocationPrompt(input: ExpertPromptInput): string {
  const requestId = requireExpertRequestId(input?.requestId)
  const task = typeof input?.task === 'string' ? input.task.trim() : ''
  const directive = EXPERT_INVOCATION_DIRECTIVE.map((line) => (
    line.includes('<requestId>') ? line.replace('<requestId>', requestId) : line
  ))
  const body = task === '' ? '（本轮用户消息里没有可整理的任务文字，请先向用户确认要专家做什么。）' : task
  return [...directive, '', body].join('\n')
}
