/**
 * Amazon 报表数据集路由（v1.18）：`/api/workbench/amazon/datasets`
 *
 * 只服务本机面板与 DSH 工具（loopback-only，与其他域同一条信任围栏）：
 * - `GET    /`            列表（不含行数据）
 * - `POST   /`            导入一份报表（rows 由面板解析后提交）
 * - `GET    /:id`         读整份（行 + 已有建议）
 * - `PATCH  /:id`         AI 写回建议（整份替换）
 * - `DELETE /:id`         删除
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import type { TrafficRow } from '../../client/amazonTrafficTools.js'
import { readXlsx, sheetToTsv, sniffKind } from '../../lib/xlsx.js'
import {
  createAmazonDataset, deleteAmazonDataset, getAmazonDataset, listAmazonDatasets, saveSearchTermReview,
} from '../../db/repo.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './helpers.js'

const PREFIX = '/api/workbench/amazon/datasets'
/** base64 上限：约 7.5MB 源文件，够一份几千行的搜索词报表。 */
const MAX_FILE_BASE64 = 10 * 1024 * 1024

function readRow(value: unknown): TrafficRow | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const numeric = (input: unknown): number | null => typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null
  const keyword = typeof raw.keyword === 'string' ? raw.keyword.trim() : ''
  const impressions = numeric(raw.impressions)
  const clicks = numeric(raw.clicks)
  const orders = numeric(raw.orders)
  const spend = numeric(raw.spend)
  const sales = numeric(raw.sales)
  if (keyword === '' || impressions === null || clicks === null || orders === null || spend === null || sales === null) return null
  return { keyword, impressions, clicks, orders, spend, sales }
}

export function makeAmazonDatasetRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = url.pathname.slice(PREFIX.length).split('/').filter((part) => part !== '')
        const method = req.method ?? 'GET'
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined

        if (segments.length === 0) {
          if (method === 'GET') {
            return writeJson(res, 200, { ok: true, datasets: listAmazonDatasets(db, url.searchParams.get('kind_code') ?? 'search_term') })
          }
          if (method === 'POST') {
            if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
            try {
              const rows = Array.isArray(body.rows) ? body.rows.map(readRow) : []
              const valid = rows.filter((row): row is TrafficRow => row !== null)
              if (Array.isArray(body.rows) && valid.length !== body.rows.length) {
                return writeJson(res, 400, { error: 'rows 中存在不合法的行（关键词为空或指标不是非负数字）' })
              }
              const dataset = createAmazonDataset(db, {
                title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title : '搜索词报表',
                period: typeof body.period === 'string' && body.period.trim() !== '' ? body.period.trim() : null,
                rows: valid,
                sourceCode: typeof body.sourceCode === 'string' ? body.sourceCode : 'paste',
                sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
              })
              return writeJson(res, 201, { ok: true, dataset })
            } catch (error) {
              return writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            }
          }
          return writeJson(res, 405, { error: 'method not allowed' })
        }

        const id = segments[0]
        /**
         * `POST /parse-file`：把一个 Excel / CSV 二进制转成 TSV 文本。
         *
         * 只做"文件 → 文本"，**不做列名解释**：表头定位与别名打分全在客户端的
         * `parseTrafficCsv` 里，保证"粘贴"和"选文件"走同一条校验路径。
         */
        if (id === 'parse-file' && method === 'POST') {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          const base64 = typeof body.base64 === 'string' ? body.base64 : ''
          if (base64 === '') return writeJson(res, 400, { error: 'base64 不能为空' })
          if (base64.length > MAX_FILE_BASE64) return writeJson(res, 413, { error: '文件过大（超过约 7.5MB），请先筛选或拆分后再导入', code: 'too-large' })
          const filename = typeof body.filename === 'string' ? body.filename : ''
          let buffer: Buffer
          try {
            buffer = Buffer.from(base64, 'base64')
          } catch {
            return writeJson(res, 400, { error: '文件内容不是有效的 base64', code: 'bad-base64' })
          }
          const kind = sniffKind(buffer)
          if (kind === 'text') {
            return writeJson(res, 200, { ok: true, format: 'text', tsv: buffer.toString('utf8'), filename })
          }
          const parsed = readXlsx(buffer)
          if (!parsed.ok) {
            return writeJson(res, 400, { error: parsed.errors.join('；'), code: 'unreadable', filename })
          }
          const sheet = parsed.sheets[0]
          return writeJson(res, 200, {
            ok: true,
            format: 'xlsx',
            filename,
            sheetName: sheet.name,
            sheetCount: parsed.sheets.length,
            tsv: sheetToTsv(sheet),
          })
        }

        if (method === 'GET' && segments.length === 1) {
          const dataset = getAmazonDataset(db, id)
          return writeJson(res, dataset === undefined ? 404 : 200, dataset === undefined ? { error: 'dataset not found' } : { ok: true, dataset })
        }
        if (method === 'PATCH' && segments.length === 1) {
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          try {
            const reviews = Array.isArray(body.reviews) ? body.reviews.map((item) => {
              const raw = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
              return {
                keyword: typeof raw.keyword === 'string' ? raw.keyword : '',
                action: typeof raw.action === 'string' ? raw.action : '',
                reason: typeof raw.reason === 'string' ? raw.reason : '',
                evidence: typeof raw.evidence === 'string' ? raw.evidence : undefined,
              }
            }) : []
            const dataset = saveSearchTermReview(db, id, reviews)
            return writeJson(res, 200, { ok: true, dataset })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return writeJson(res, message === 'dataset not found' ? 404 : 400, { error: message })
          }
        }
        if (method === 'DELETE' && segments.length === 1) {
          return deleteAmazonDataset(db, id)
            ? writeJson(res, 200, { ok: true })
            : writeJson(res, 404, { error: 'dataset not found' })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
  ]
}
