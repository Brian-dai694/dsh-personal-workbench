/**
 * 测算方案路由（2026-10-24）：`/api/workbench/calculator-scenarios`
 *
 * - `GET    /`      列表（含完整输入：对比表要现算，所以不能只给摘要）
 * - `POST   /`      新建（同名视为"覆盖那一份"？不 —— 这里返回 409，让用户决定改名还是覆盖）
 * - `PATCH  /:id`   局部更新（改名 / 换参数 / 改备注 / 关联 ASIN）
 * - `DELETE /:id`   删除
 *
 * 只读写本地 SQLite；不连接广告账户、不改价、不改预算。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  createCalculatorScenario, deleteCalculatorScenario, findCalculatorScenarioByName,
  getCalculatorScenario, listCalculatorScenarios, updateCalculatorScenario,
} from '../../db/repo.js'
import { normalizeScenarioName } from '../../shared/calculatorScenario.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './helpers.js'

const PREFIX = '/api/workbench/calculator-scenarios'

function readPatch(body: Record<string, unknown>): { name?: string; input?: unknown; note?: string; asin?: string | null } {
  const patch: { name?: string; input?: unknown; note?: string; asin?: string | null } = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (body.input !== undefined) patch.input = body.input
  if (typeof body.note === 'string') patch.note = body.note
  if (body.asin === null) patch.asin = null
  else if (typeof body.asin === 'string') patch.asin = body.asin
  return patch
}

export function makeCalculatorScenarioRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = url.pathname.slice(PREFIX.length).split('/').filter((part) => part !== '')
        const method = req.method ?? 'GET'
        const id = segments[0] === undefined ? '' : decodeURIComponent(segments[0])

        if (method === 'GET' && segments.length === 0) {
          return writeJson(res, 200, { scenarios: listCalculatorScenarios(db) })
        }

        if (method === 'GET' && segments.length === 1) {
          const scenario = getCalculatorScenario(db, id)
          return scenario === null ? writeJson(res, 404, { error: '方案不存在' }) : writeJson(res, 200, { scenario })
        }

        if (method === 'POST' && segments.length === 0) {
          const body = await readJsonBody(req, 512 * 1024)
          if (body === undefined) return writeJson(res, 413, { error: '请求体不是合法 JSON 或过大' })
          const name = normalizeScenarioName(body.name)
          if (name === '') return writeJson(res, 400, { error: '方案名不能为空' })
          /**
           * 同名**不静默覆盖**：覆盖会让"我明明存了两份假设"变成只剩一份，
           * 而用户完全看不出发生了什么。返回 409 + 已有那份的 id，由界面提示改名或显式替换。
           */
          const existing = findCalculatorScenarioByName(db, name)
          if (existing !== null && body.replace !== true) {
            return writeJson(res, 409, { error: `已存在同名方案「${name}」`, existingId: existing.id })
          }
          try {
            /** `readPatch` 负责类型收窄：`note` 只接受字符串、`asin` 只接受字符串或 null。 */
            const patch = readPatch(body)
            const scenario = existing !== null && body.replace === true
              ? updateCalculatorScenario(db, existing.id, { name, input: patch.input, note: patch.note, asin: patch.asin })
              : createCalculatorScenario(db, { name, input: patch.input, note: patch.note, asin: patch.asin })
            return writeJson(res, 200, { scenario })
          } catch (error) {
            return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }

        if (method === 'PATCH' && segments.length === 1) {
          const body = await readJsonBody(req, 512 * 1024)
          if (body === undefined) return writeJson(res, 413, { error: '请求体不是合法 JSON 或过大' })
          const scenario = updateCalculatorScenario(db, id, readPatch(body))
          return scenario === null ? writeJson(res, 404, { error: '方案不存在或方案名为空' }) : writeJson(res, 200, { scenario })
        }

        if (method === 'DELETE' && segments.length === 1) {
          return writeJson(res, deleteCalculatorScenario(db, id) ? 200 : 404, { ok: true })
        }

        return writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}
