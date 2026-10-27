/**
 * 运营日志路由（2026-10-23 接入第 1 步）：`/api/workbench/oplog`
 *
 * - `GET  /`        列表（按类型/店铺/站点/关键词筛选）+ 筛选候选值
 * - `POST /import`  导入旧「亚马逊运营日志 V5」导出的 JSON（幂等：同 id 覆盖）
 *
 * 与其它域同一条 loopback 信任围栏；只读 + 导入，不提供编辑/删除。
 *
 * 响应信封（2026-10-27，决策 2）：一律走 `apiOk` / `apiError`。
 * 注意其中「置顶」那条原先回的是 `{ ok: <操作结果> }` —— 字段名恰好与信封同名，
 * 统一后语义更准确：成功 `{ok:true}`、失败 `{ok:false, error}`，客户端读 `.ok` 的代码不受影响。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { createOplogEntry, deleteOplogEntry, deleteOplogType, getOplogEntry, getTask, importOplogEntries, listOplogDayIndex, listOplogEntries, listOplogTaskOptions, listOplogTypes, oplogFacets, oplogKpiCounts, setOplogPinned, updateOplogEntry, upsertOplogType } from '../../db/repo.js'
import type { OplogDraft } from '../../db/repo.js'
import { normalizeOplogImport } from '../../shared/oplogImport.js'
import { apiError, apiOk, isLoopbackRequest, readJsonBody } from './helpers.js'


function readDraft(body: Record<string, unknown>): OplogDraft | string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const title = str(body.title).trim()
  if (title === '') return '标题不能为空'
  const docs = Array.isArray(body.documents) ? body.documents : []
  const documents = docs.slice(0, 5).map((item) => {
    const row = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
    return { name: str(row.name), size: str(row.size), type: str(row.type), dataUrl: str(row.dataUrl) }
  }).filter((d) => d.name !== '')
  return {
    title,
    logType: str(body.logType) || '其它',
    contentText: str(body.content),
    shopId: str(body.shopId) === '' ? null : str(body.shopId),
    site: str(body.site) === '' ? null : str(body.site),
    logDate: str(body.logDate) === '' ? new Date().toISOString().slice(0, 10) : str(body.logDate),
    asins: Array.isArray(body.asins) ? body.asins.filter((x): x is string => typeof x === 'string') : [],
    documents,
    taskId: str(body.taskId).trim() || null,
  }
}

const PREFIX = '/api/workbench/oplog'

export function makeOplogRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = url.pathname.slice(PREFIX.length).split('/').filter((part) => part !== '')
        const action = segments[0] ?? ''

        if (req.method === 'GET' && (action === '' || action === 'list')) {
          const limit = Number(url.searchParams.get('limit') ?? '200')
          const entries = listOplogEntries(db, {
            logType: url.searchParams.get('type') ?? undefined,
            shopId: url.searchParams.get('shop') ?? undefined,
            site: url.searchParams.get('site') ?? undefined,
            logDate: url.searchParams.get('date') ?? undefined,
            keyword: url.searchParams.get('q') ?? undefined,
            limit: Number.isFinite(limit) ? limit : 200,
          })
          return apiOk(res, { entries, facets: oplogFacets(db), kpi: oplogKpiCounts(db), tasks: listOplogTaskOptions(db) })
        }

        if (req.method === 'POST' && action === 'import') {
          // 旧导出常带内嵌截图：7 条日志就能到 ~1MB，默认 256KB 会把整份拒掉
          const body = await readJsonBody(req, 12 * 1024 * 1024)
          if (body === undefined) {
            return apiError(res, 413, '导入文件过大或不是合法 JSON（上限 12MB）')
          }
          const parsed = normalizeOplogImport(body)
          if (parsed.entries.length === 0) {
            return apiError(res, 400, parsed.firstReason ?? '没有可导入的条目', { rejected: parsed.rejected })
          }
          const summary = importOplogEntries(db, parsed.entries, parsed.rejected, parsed.firstReason)
          return apiOk(res, { ...summary, facets: oplogFacets(db) })
        }


        if (req.method === 'GET' && action === 'days') {
          return apiOk(res, { days: listOplogDayIndex(db) })
        }

        if (req.method === 'GET' && action === 'types') {
          return apiOk(res, { types: listOplogTypes(db) })
        }

        if (req.method === 'POST' && action === 'types') {
          const body = await readJsonBody(req, 256 * 1024)
          if (body === undefined) return apiError(res, 400, '请求体不是合法 JSON')
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          const color = typeof body.color === 'string' ? body.color.trim() : ''
          if (name === '' || !/^#[0-9a-fA-F]{6}$/.test(color)) return apiError(res, 400, '类型名或颜色不合法')
          return apiOk(res, { types: listOplogTypes(db), type: upsertOplogType(db, name, color) })
        }

        if (req.method === 'DELETE' && action === 'types' && segments[1] !== undefined) {
          const removed = deleteOplogType(db, decodeURIComponent(segments[1]))
          /** 原实现回 `404 + {types}`（没有 error 字段），统一后 404 必须带可读原因。 */
          return removed ? apiOk(res, { types: listOplogTypes(db) }) : apiError(res, 404, '类型不存在')
        }

        if (req.method === 'POST' && action === '' && segments.length === 0) {
          const body = await readJsonBody(req, 2 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大')
          const draft = readDraft(body)
          if (typeof draft === 'string') return apiError(res, 400, draft)
          const taskId = typeof draft.taskId === 'string' ? draft.taskId.trim() : ''
          if (taskId !== '' && getTask(db, taskId) === undefined) return apiError(res, 400, '关联任务不存在或已删除')
          return apiOk(res, { entry: createOplogEntry(db, draft) })
        }

        if (req.method === 'PATCH' && segments[0] !== undefined && segments[1] === undefined) {
          const body = await readJsonBody(req, 2 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大')
          if (body.pinned !== undefined) {
            const pinned = setOplogPinned(db, segments[0], body.pinned === true)
            /** 成功 `{ok:true}`、失败 `{ok:false,error}`：原字段名与信封同名，客户端按 `.ok` 读不受影响。 */
            return pinned ? apiOk(res) : apiError(res, 404, '日志不存在')
          }
          const draft = readDraft(body)
          if (typeof draft === 'string') return apiError(res, 400, draft)
          const taskId = typeof draft.taskId === 'string' ? draft.taskId.trim() : ''
          if (taskId !== '' && getTask(db, taskId) === undefined) return apiError(res, 400, '关联任务不存在或已删除')
          const entry = updateOplogEntry(db, segments[0], draft)
          return entry === null ? apiError(res, 404, '日志不存在') : apiOk(res, { entry })
        }

        if (req.method === 'DELETE' && segments[0] !== undefined && segments[1] === undefined) {
          return deleteOplogEntry(db, segments[0])
            ? apiOk(res)
            : apiError(res, 404, '日志不存在')
        }

        return apiError(res, 404, 'not found')
      },
    },
  ]
}
