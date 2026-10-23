/**
 * 专家生成 HTTP（方案 v0.3 §4.1 / §4.2；P5 只做"生成 → 暂存 → 校验 → 交用户确认"这一段）。
 *
 * | 方法 | 路径 | 说明 |
 * |---|---|---|
 * | GET | `/api/workbench/experts/capabilities` | 四项能力 + 唯一设置真值（`enabled`） |
 * | GET | `/api/workbench/experts/catalog` | 管理行 + 可选择的角色摘要 + 诊断（可选 `query`） |
 * | GET | `/api/workbench/experts/methodology` | 随包方法论全文（`version: 1`） |
 * | POST | `/api/workbench/experts/generation-start` | `{sessionId, request, workspaceId}` → 草稿 |
 * | GET | `/api/workbench/experts/drafts/:id` | 草稿 + 暂存清单 + 与实际文件的漂移诊断 |
 * | POST | `/api/workbench/experts/drafts/:id/validate` | `{expectedVersion}` → 草稿 + validation |
 * | GET | `/api/workbench/experts/drafts/:id/file` | `area` / `path` 查询参数 → 该草稿索引里的一个文本文件 |
 * | POST | `/api/workbench/experts/preflight` | `{personaId, sessionId?}` → 可用性预检 |
 * | POST | `/api/workbench/experts/manual-requests` | `{sessionId, personaId, expectedSourceKey, expectedRevision}` → 手动调用请求（P7） |
 *
 * **P6 的 `POST /experts/manual-requests` 当时刻意不在这里**：P5 没有子代理调用，
 * 端点若存在就必须"看起来可用"，那正是 §10 降级口径失真的来源。P7 补上它 ——
 * 但**只建请求、不执行**：`runManual` 依然只由工具执行上下文触发（§4.1 首段的
 * "HTTP 只能查看/编辑/确认，不直接启动专家子代理"）。
 *
 * **`loadForChild` / `readForChild` 永远没有 HTTP 入口**（P6 交接 §9-3）：ticket 只走工具参数，
 * 任何响应体里都不出现它。
 *
 * ## 硬约束
 *
 * - **只用既有围栏**（`isLoopbackRequest` / `readJsonBody` / `writeJson`）：本文件不解析 socket、
 *   不自己判 host/origin，也不另写一套 CORS/令牌 —— 第二套围栏迟早与第一套不一致；
 * - **响应里没有服务端绝对路径**：失败一律走 `service.projectFailure(error)`（唯一投影口），
 *   catalog/preflight 的诊断在服务层已经投影过；
 * - 未知 id 404、坏 JSON 400、超 body 413、版本/冲突/安装中 409、能力缺失 503（§4.2）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import { EXPERT_HTTP_BODY_MAX_BYTES, EXPERT_REQUEST_MAX_CHARS, type ExpertFileArea } from '../../shared/expert.js'
import { ExpertServiceError, type ExpertService } from '../../experts/service.js'
import { pathSegments, isLoopbackRequest, readJsonBody, writeJson } from './helpers.js'

export const EXPERTS_PREFIX = '/api/workbench/experts'
/** 会话 id / 角色 id 的长度上限（与 `/personas` 同一口径：只防"用超长 id 打库"）。 */
const MAX_ID_CHARS = 512
/** 工作区路径的长度上限（只做非空与长度校验；不落库、不回显）。 */
const MAX_WORKSPACE_CHARS = 4096

const FILE_AREAS: readonly ExpertFileArea[] = ['persona-resource', 'skill']

type Res = Parameters<WebRoute['handler']>[1]
type Req = Parameters<WebRoute['handler']>[0]

export function makeExpertRoutes(db: DatabaseSync, service: ExpertService | undefined): WebRoute[] {
  if (service === undefined) return []
  return [
    {
      kind: 'prefix',
      path: EXPERTS_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, EXPERTS_PREFIX)
        const [head, second, third] = segments
        try {
          if (head === 'capabilities') {
            if (method !== 'GET') return methodNotAllowed(res)
            return writeJson(res, 200, { ok: true, ...(await service.capabilities()) })
          }
          if (head === 'catalog') {
            if (method !== 'GET') return methodNotAllowed(res)
            const query = url.searchParams.get('query') ?? ''
            return writeJson(res, 200, { ok: true, ...(await service.catalog(query)) })
          }
          if (head === 'methodology') {
            if (method !== 'GET') return methodNotAllowed(res)
            const methodology = service.methodology()
            return writeJson(res, 200, { ok: true, version: methodology.version, text: methodology.text })
          }
          if (head === 'generation-start') {
            if (method !== 'POST') return methodNotAllowed(res)
            const body = await readBody(req, res)
            if (body === undefined) return
            const sessionId = requireText(body, 'sessionId', MAX_ID_CHARS)
            const request = requireText(body, 'request', EXPERT_REQUEST_MAX_CHARS)
            const workspaceId = requireText(body, 'workspaceId', MAX_WORKSPACE_CHARS)
            return writeJson(res, 200, { ok: true, draft: service.startGeneration({ sessionId, request, workspaceId }) })
          }
          if (head === 'preflight') {
            if (method !== 'POST') return methodNotAllowed(res)
            const body = await readBody(req, res)
            if (body === undefined) return
            const personaId = requireText(body, 'personaId', MAX_ID_CHARS)
            /**
             * `sessionId` 只做形状校验、**不参与判定**（§4.2）：HTTP 侧没有 live agent，
             * 拿到的只是"预检"这一档结论（`preliminary: true`）；真正的会话绑定预检
             * 会在启动生成会话时按真实 scope/cwd 复核。
             */
            optionalText(body, 'sessionId', MAX_ID_CHARS)
            const result = await service.preflight(personaId)
            return writeJson(res, 200, { ok: true, ...result })
          }
          /**
           * `POST /experts/manual-requests`（P7 / §4.1）：**只建请求，不执行**。
           *
           * 为什么 `expectedSourceKey` / `expectedRevision` 是必填：`createManualRequest`
           * 建请求时当场比对**当前**人格身份（§8.5 第 11 步），不符就 `revision-changed` 且
           * **一条请求都不建**。让浏览器端先拿 preflight 的 `summary` 再提交，是为了把
           * "面板显示 → 用户点发送"这段时间里的人格变更变成一次**显式失败**，
           * 而不是让用户以为叫来的是他刚才看到的那个专家。
           *
           * 身份入参一律走既有 `requireText`（trim 后 1–512）：长度/空值口径与其它端点一致，
           * 失败抛服务层同一个 `ExpertServiceError`（`invalid-payload` → 400，唯一投影口）。
           */
          if (head === 'manual-requests') {
            if (method !== 'POST') return methodNotAllowed(res)
            const body = await readBody(req, res)
            if (body === undefined) return
            const sessionId = requireText(body, 'sessionId', MAX_ID_CHARS)
            const personaId = requireText(body, 'personaId', MAX_ID_CHARS)
            const expectedSourceKey = requireText(body, 'expectedSourceKey', MAX_ID_CHARS)
            const expectedRevision = requireText(body, 'expectedRevision', MAX_ID_CHARS)
            const created = service.createManualRequest({ sessionId, personaId, expectedSourceKey, expectedRevision })
            return writeJson(res, 200, { ok: true, requestId: created.requestId, expiresAt: created.expiresAt })
          }
          if (head === 'drafts' && typeof second === 'string' && second !== '') {
            if (third === undefined) {
              if (method !== 'GET') return methodNotAllowed(res)
              const preview = service.previewDraft(second)
              return writeJson(res, 200, { ok: true, draft: preview.draft, drift: preview.drift })
            }
            if (third === 'validate') {
              if (method !== 'POST') return methodNotAllowed(res)
              const body = await readBody(req, res)
              if (body === undefined) return
              const expectedVersion = requireVersion(body, 'expectedVersion')
              const draft = await service.validateDraft(second, expectedVersion)
              /**
               * §4.1：**有错误也 200/ok:true**（`validation.errors` 非空、`phase` 留在 `editing`）。
               * 校验失败不是 HTTP 失败：它是"草稿可以给用户看了，但还不能装"。
               */
              return writeJson(res, 200, { ok: true, draft, validation: draft.validation })
            }
            if (third === 'file') {
              if (method !== 'GET') return methodNotAllowed(res)
              const area = (url.searchParams.get('area') ?? '').trim()
              const path = url.searchParams.get('path') ?? ''
              if (FILE_AREAS.includes(area as ExpertFileArea) === false) {
                return writeJson(res, 400, {
                  ok: false,
                  code: 'invalid-payload',
                  field: 'area',
                  error: 'area 必填，且只能是 persona-resource 或 skill',
                })
              }
              if (path === '') {
                return writeJson(res, 400, { ok: false, code: 'invalid-path', field: 'path', error: 'path 必填（相对该草稿的路径）' })
              }
              const file = service.readStagedFile(second, area as ExpertFileArea, path)
              return writeJson(res, 200, {
                ok: true,
                draftId: file.draftId,
                area: file.area,
                path: file.path,
                text: file.text,
                bytes: file.bytes,
                sha256: file.sha256,
                archivedOnly: file.archivedOnly,
              })
            }
            return writeJson(res, 404, { ok: false, code: 'draft-not-found', error: `未知的专家草稿接口：${third}` })
          }
          return writeJson(res, 404, { ok: false, code: 'draft-not-found', error: `未知的专家接口：${segments.join('/')}` })
        } catch (error) {
          return fail(res, service, error)
        }
      },
    },
  ]
}

function methodNotAllowed(res: Res): void {
  writeJson(res, 405, { error: 'method not allowed' })
}

/**
 * 读请求体：**坏 JSON 400 / 超 body 413**（§4.2）。
 *
 * 读取本身仍走既有 `readJsonBody`（唯一入口，限值来自 `EXPERT_HTTP_BODY_MAX_BYTES`）；
 * 这里只多一步"长度声明预检" —— 因为 `readJsonBody` 对"超限"和"坏 JSON"都给 `undefined`，
 * 而 §4.2 要求两者给不同状态码。声明缺失（chunked）时按坏 JSON 处理：宁可 400 不误报 413。
 */
async function readBody(req: Req, res: Res): Promise<Record<string, unknown> | undefined> {
  const declared = Number(req.headers['content-length'] ?? '')
  if (Number.isFinite(declared) && declared > EXPERT_HTTP_BODY_MAX_BYTES) {
    writeJson(res, 413, {
      ok: false,
      code: 'package-too-large',
      error: `请求体超过上限 ${EXPERT_HTTP_BODY_MAX_BYTES} 字节`,
    })
    return undefined
  }
  const body = await readJsonBody(req, EXPERT_HTTP_BODY_MAX_BYTES)
  if (body === undefined) {
    writeJson(res, 400, { ok: false, code: 'invalid-json', error: 'invalid JSON body' })
    return undefined
  }
  return body
}

/** 失败一律走服务层的**唯一**投影（含状态码映射与绝对路径投影）。 */
function fail(res: Res, service: ExpertService, error: unknown): void {
  const projection = service.projectFailure(error)
  writeJson(res, projection.status, { ok: false, ...projection.body })
}

/**
 * 必填字符串字段（trim 后 1–max）。
 *
 * 失败时抛**服务层同一个** `ExpertServiceError`：这样 `fail()` 的投影、状态码映射
 * （`invalid-payload` → 400）与域内失败完全一致 —— 路由不再维护第二套错误载体。
 */
function requireText(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) {
    throw new ExpertServiceError('invalid-payload', field, `${field} 必填（trim 后 1–${max} 字符）`)
  }
  return value.trim()
}

/** 可选字符串字段：缺省/`null` 当"没给"；给了就必须是非空且不超长的字符串。 */
function optionalText(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) {
    throw new ExpertServiceError('invalid-payload', field, `${field} 必须是非空字符串且不超过 ${max} 字符`)
  }
  return value.trim()
}

function requireVersion(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || Number.isInteger(value) === false || value < 0) {
    throw new ExpertServiceError('invalid-payload', field, `${field} 必填，且必须是非负整数`)
  }
  return value
}
