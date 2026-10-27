/**
 * Amazon 报表数据集路由（v1.18）：`/api/workbench/amazon/datasets`
 *
 * 只服务本机面板与 DSH 工具（loopback-only，与其他域同一条信任围栏）：
 * - `GET    /`            列表（不含行数据）
 * - `POST   /`            导入一份报表（rows 由面板解析后提交）
 * - `GET    /:id`         读整份（行 + 已有词级建议 + 报表级结论 `aiSummary`）
 * - `PATCH  /:id`         AI 写回：`reviews`（词级建议，整份替换）/ `summary`（报表级结论，整份替换），可只传其一
 * - `DELETE /:id`         删除
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import type { TrafficRow } from '../../client/amazonTrafficTools.js'
import { readXlsx, sheetToTsv, sniffKind } from '../../lib/xlsx.js'
import {
  createAmazonDataset, deleteAmazonDataset, getAmazonDataset, isAmazonDatasetKind, listAmazonDatasets,
  saveAmazonDatasetSummary, saveSearchTermReview,
} from '../../db/repo.js'
import type { AmazonDatasetSummaryPayload } from '../../db/repo.js'
import { isLoopbackRequest, readJsonBody, writeJson } from './helpers.js'

const PREFIX = '/api/workbench/amazon/datasets'
/** base64 上限：约 7.5MB 源文件，够一份几千行的搜索词报表。 */
const MAX_FILE_BASE64 = 10 * 1024 * 1024
/**
 * 请求体上限（2026-10-22 修复）。
 *
 * 原先三处都吃 `readJsonBody(req)` 的**默认 256KB**，于是：
 * - `parse-file` 里 `MAX_FILE_BASE64` 那条 10MB 判断**永远到不了**（更大的文件先在读体时就被拒）；
 * - 几千行的搜索词 rows JSON 本身就有数百 KB，同样被拒；
 * - 而拒的理由统一是 `400 invalid JSON body` —— 文案指向"JSON 不合法"，与真实原因（太大）不符。
 *
 * 实测（本机 1.17.0）：98KB 能进处理逻辑，293KB 直接 400 invalid JSON body。
 * 现在按路由分开给上限，并用 `content-length` 预判，超限明确回 413。
 */
const MAX_ROWS_BODY_BYTES = 8 * 1024 * 1024
const MAX_PATCH_BODY_BYTES = 1024 * 1024
/** base64 之外还有 JSON 外壳、filename 等字段的余量。 */
const MAX_PARSE_FILE_BODY_BYTES = MAX_FILE_BASE64 + 2 * 1024 * 1024

/** 按「哪个端点」决定读体上限：同一个 handler 里三种请求的体量差两个数量级。 */
function bodyLimitFor(method: string, segments: string[]): number {
  if (segments[0] === 'parse-file') return MAX_PARSE_FILE_BODY_BYTES
  if (segments.length === 0 && method === 'POST') return MAX_ROWS_BODY_BYTES
  return MAX_PATCH_BODY_BYTES
}

/**
 * 读体之前先用 `content-length` 判一次大小。
 *
 * 为什么要这一步：`readJsonBody` 超限时返回 `undefined`，与"JSON 语法错误"是同一个返回值，
 * 调用方无法区分，只能一律报 400。有了预判，超限能准确回 413 + `too-large`，
 * 前端可以据此提示"筛选或拆分后再导入"而不是让用户去查 JSON。
 * 没有 content-length（chunked）时落到读体上限，仍然安全，只是文案退回 400。
 */
function declaredTooLarge(req: { headers: Record<string, string | string[] | undefined> }, limit: number): boolean {
  const raw = req.headers['content-length']
  if (typeof raw !== 'string') return false
  const declared = Number(raw)
  return Number.isFinite(declared) && declared > limit
}

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
  /** 投放/活动报表多出来的列：带上但不校验（缺了就是 null，不影响三类共用一套指标）。 */
  const optionalText = (input: unknown): string | null => typeof input === 'string' && input.trim() !== '' ? input.trim() : null
  return {
    keyword, impressions, clicks, orders, spend, sales,
    campaign: optionalText(raw.campaign),
    adGroup: optionalText(raw.adGroup),
    matchType: optionalText(raw.matchType),
    budget: numeric(raw.budget),
    status: optionalText(raw.status),
    /** P2：广告位与展示量份额（0–1）；份额越界一律丢弃，不夹取。 */
    placement: optionalText(raw.placement),
    share: typeof raw.share === 'number' && Number.isFinite(raw.share) && raw.share >= 0 && raw.share <= 1 ? raw.share : null,
  } as TrafficRow
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
        const bodyLimit = bodyLimitFor(method, segments)
        if (['POST', 'PATCH'].includes(method) && declaredTooLarge(req, bodyLimit)) {
          return writeJson(res, 413, {
            error: `请求体过大（上限 ${Math.round(bodyLimit / 1024 / 1024)}MB），请先筛选或拆分后再导入`,
            code: 'too-large',
          })
        }
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req, bodyLimit) : undefined

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
                kindCode: isAmazonDatasetKind(body.kindCode) ? body.kindCode : undefined,
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
          const reviewsRaw: unknown[] = Array.isArray(body.reviews) ? body.reviews : []
          const hasReviews = Array.isArray(body.reviews)
          const hasSummary = Object.prototype.hasOwnProperty.call(body, 'summary')
          if (!hasReviews && !hasSummary) {
            return writeJson(res, 400, { error: '需要 reviews 数组（词级建议）或 summary 对象（报表级结论）' })
          }
          /**
           * `summary` 先验后写：
           * - 必须是非空普通对象，或 `null`（清空结论，回到"还没做过"）；
           * - 数组 / 字符串 / 空对象一律拒绝 —— 空对象被读出来就是"报表总额为 0"的假结论。
           * 两段写入都是整份替换且各自原子，先验完再写，避免"建议写进去了、结论被拒"的半份状态。
           */
          let summary: AmazonDatasetSummaryPayload | null = null
          if (hasSummary) {
            const raw = body.summary
            if (raw === null) {
              summary = null
            } else if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
              return writeJson(res, 400, { error: 'summary 必须是非空 JSON 对象，或 null（清空结论）' })
            } else {
              summary = raw as AmazonDatasetSummaryPayload
            }
          }
          try {
            let dataset = getAmazonDataset(db, id)
            if (dataset === undefined) return writeJson(res, 404, { error: 'dataset not found' })
            if (hasReviews) {
              const reviews = reviewsRaw.map((item: unknown) => {
                const raw = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
                return {
                  keyword: typeof raw.keyword === 'string' ? raw.keyword : '',
                  action: typeof raw.action === 'string' ? raw.action : '',
                  reason: typeof raw.reason === 'string' ? raw.reason : '',
                  evidence: typeof raw.evidence === 'string' ? raw.evidence : undefined,
                }
              })
              dataset = saveSearchTermReview(db, id, reviews)
            }
            if (hasSummary) dataset = saveAmazonDatasetSummary(db, id, summary)
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
