/**
 * 路由层**唯一的** HTTP 请求围栏与响应工具（v1.15.1）。
 *
 * ## 为什么要有这个文件（真实事故的防复发）
 *
 * `isLoopbackRequest` / `writeJson` / `readJsonBody` 原先在**四处**各有一份逐字相同的副本：
 * `src/api/dictionaryRoute.ts`、`localDirRoute.ts`、`openFileRoute.ts`、`src/api/routes/helpers.ts`。
 * 调研（`docs/2026-09-15-fork-survey.md` 3.5）逐字比对确认：当时它们**完全相同、尚未漂移**，
 * 所以这是"防未来漂移"的卫生改进 —— 但这类"多份同一语义"正是本项目最大的 bug 类别
 * （第 0 节：同一个语义被独立计算多次）：只要有人给其中一处加一条安全头或改一次 origin 判定，
 * 另外三处就悄悄落后，而**没有任何测试会红**。
 *
 * 现在只有一份实现，并由 `test/httpFence.test.mjs` 做源码级扫描钉住"不存在第二处实现"。
 *
 * ## 两个安全头
 *
 * 所有 `/api/workbench/*` 响应都带 `cache-control: no-store` 与
 * `x-content-type-options: nosniff`：
 *
 * - `no-store`：这些接口返回的是任务/知识/点子等**用户私有数据**，不能被浏览器或中间层缓存；
 * - `nosniff`：禁止浏览器按内容猜 MIME（返回体是 `application/json`，不猜就不会被当成可执行内容）。
 *
 * `referrer-policy: no-referrer` 是原有头，保留。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 只接受回环请求（同 dsh-ssh 的信任围栏）。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let url: URL
  try { url = new URL(`http://${host}`) } catch { return false }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === url.host } catch { return false }
}

/** 所有工作台接口共用的响应头（单一来源：新增安全头只需改这里）。 */
export function workbenchResponseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, workbenchResponseHeaders())
  res.end(JSON.stringify(body))
}

/**
 * 统一**成功**信封：`{ ok: true, ...payload }`（2026-10-27，决策 2）。
 *
 * ## 为什么要收口，而不是让每个 handler 自己写 `{ ok: true, ... }`
 *
 * 收口前 `/api/workbench/*` 的响应有**两套写法**：核心域手写 `{ ok: true, ... }`，
 * Amazon 域（7 个路由文件）返回**裸对象**。实测 134 个 `writeJson` 调用点里：
 * 成功响应 14 处带 `ok`、**17 处不带**；错误响应 1 处带、**82 处不带**。
 *
 * 「同一语义两处实现」是本项目最大的 bug 类别（见本文件头注释），所以这里不逐个补字段，
 * 而是让信封**结构上不可能漏**：成功一律走 `apiOk`、失败一律走 `apiError`。
 *
 * ## 为什么这是**纯增量**改动（不是破坏性变更）
 *
 * 客户端 `client/api.ts` 只读 **HTTP 状态码**（`res.ok`）与 **`body.error`**，
 * **从不读 `body.ok`**（全仓实测：客户端 14 处 `.ok` 读的都是专家草稿 / 会话驱动等别的载荷）。
 * 所以补 `ok` 字段不会影响任何现有消费者；它存在是为了让信封可被测试断言。
 *
 * @param res - 响应对象。
 * @param payload - 附加字段（展开到顶层，保持既有字段名不变）。
 * @param status - HTTP 状态码，缺省 200。**创建类接口应显式传 201**（语义正确，不要为"统一"退回 200）。
 */
export function apiOk(res: ServerResponse, payload: Record<string, unknown> = {}, status = 200): void {
  writeJson(res, status, { ok: true, ...payload })
}

/**
 * 统一**错误**信封：`{ ok: false, error, ...extra }`（2026-10-27，决策 2）。
 *
 * `error` 保持在**顶层**：客户端 `client/api.ts:84` 读的就是 `body.error`，
 * 嵌套一层（如 `{ ok:false, error:{ message } }`）会让现有全部错误提示变成 `HTTP 4xx（path）`。
 *
 * @param res - 响应对象。
 * @param status - HTTP 状态码（4xx / 5xx）。
 * @param error - 面向用户的中文可读文案。
 * @param extra - 附加字段（如 `code`、`existingId`），展开到顶层。
 */
export function apiError(res: ServerResponse, status: number, error: string, extra?: Record<string, unknown>): void {
  writeJson(res, status, { ok: false, error, ...extra })
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}
