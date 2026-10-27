/**
 * ABA 词表路由（migration 33）：`/api/workbench/aba-keywords`
 *
 * - `GET    /`               列表（摘要）
 * - `POST   /`               导入（body 里的 rows 会被**再次清洗**，不信任客户端）
 * - `GET    /:id`            整份（含回填）
 * - `PATCH  /:id/annotations` DSH / 人工回填（按关键词合并，不清空其它词）
 * - `DELETE /:id`            删除
 *
 * 只读写本地 SQLite；不连接广告账户、不创建投放。
 *
 * 响应信封（2026-10-27，决策 2）：一律走 `apiOk` / `apiError`，不再手写 `{ ok: … }`。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import {
  createAbaKeywordSet, deleteAbaKeywordSet, getAbaKeywordSet, listAbaKeywordSets, setAbaAnnotations,
} from '../../db/repo.js'
import { ABA_KEYWORDS_PREFIX as PREFIX, apiError, apiOk, isLoopbackRequest, pathSegments, readJsonBody } from './helpers.js'
import { writeAbaComparisonCsv } from '../../lib/abaExport.js'
import { getLatestAmazonDataset } from '../../db/repo.js'


export function makeAbaKeywordRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, PREFIX)
        const method = req.method ?? 'GET'
        const id = segments[0] === undefined ? '' : decodeURIComponent(segments[0])

        if (method === 'GET' && segments.length === 0) {
          return apiOk(res, { sets: listAbaKeywordSets(db) })
        }

        if (method === 'GET' && segments.length === 1) {
          const set = getAbaKeywordSet(db, id)
          return set === null ? apiError(res, 404, '词表不存在') : apiOk(res, { set })
        }

        if (method === 'POST' && segments.length === 0) {
          // 一张 ABA 词表可能上万行，256KB 不够
          const body = await readJsonBody(req, 8 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大（上限 8MB）')
          try {
            const set = createAbaKeywordSet(db, {
              title: typeof body.title === 'string' ? body.title : 'ABA 词表',
              period: typeof body.period === 'string' ? body.period : null,
              rows: body.rows,
              sourceCode: typeof body.sourceCode === 'string' ? body.sourceCode : 'import',
            })
            return apiOk(res, { set })
          } catch (error) {
            return apiError(res, 400, error instanceof Error ? error.message : String(error))
          }
        }

        /**
         * 导出对照表：写本地 CSV（含规则/回填/差异/我们自己的表现）。
         * 表现数据取**最新一份搜索词报表**，按词精确匹配 —— 与界面口径完全一致。
         */
        if (method === 'POST' && segments.length === 2 && segments[1] === 'export') {
          const set = getAbaKeywordSet(db, id)
          if (set === null) return apiError(res, 404, '词表不存在')
          const latest = getLatestAmazonDataset(db, 'search_term')
          const map = new Map<string, { clicks: number; orders: number; spend: number; sales: number }>()
          for (const row of latest?.rows ?? []) {
            map.set(row.keyword.trim().toLowerCase(), { clicks: row.clicks, orders: row.orders, spend: row.spend, sales: row.sales })
          }
          try {
            const result = writeAbaComparisonCsv(set, { get: (keyword: string) => map.get(keyword.trim().toLowerCase()) })
            return apiOk(res, { path: result.path, rows: result.rows, dataset: latest?.title ?? null })
          } catch (error) {
            return apiError(res, 500, error instanceof Error ? error.message : String(error))
          }
        }

        if (method === 'PATCH' && segments.length === 2 && segments[1] === 'annotations') {
          const body = await readJsonBody(req, 2 * 1024 * 1024)
          if (body === undefined) return apiError(res, 413, '请求体不是合法 JSON 或过大')
          const set = setAbaAnnotations(db, id, body.annotations)
          return set === null ? apiError(res, 404, '词表不存在') : apiOk(res, { set })
        }

        if (method === 'DELETE' && segments.length === 1) {
          /**
           * ⚠️ 信封修正（批次 3）：原实现是
           * `writeJson(res, deleted ? 200 : 404, { ok: true })` —— 删不掉时回的是
           * **404 状态码 + `ok: true`**，两个字段互相矛盾，客户端据 `ok` 判断就会误判成功。
           * 统一信封后必须拆成两条：删成功 `apiOk`，没找到 `apiError(404, …)`。
           */
          if (!deleteAbaKeywordSet(db, id)) return apiError(res, 404, '词表不存在')
          return apiOk(res)
        }

        return apiError(res, 404, 'not found')
      },
    },
  ]
}
