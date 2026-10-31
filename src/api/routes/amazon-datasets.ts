/**
 * Amazon 报表数据集路由（v1.18）：`/api/workbench/amazon/datasets`
 *
 * 只服务本机面板与 DSH 工具（loopback-only，与其他域同一条信任围栏）：
 * - `GET    /`            列表（不含行数据）
 * - `POST   /`            导入一份报表（P2-2 起内部 delegate 到 `amazon-import.ts` 的同一实现）
 * - `GET    /:id`         读整份（行 + 已有词级建议 + 报表级结论 `aiSummary` + 表格路径 `univerFile`）
 * - `PATCH  /:id`         AI 写回：`reviews`（词级建议，整份替换）/ `summary`（报表级结论，整份替换），可只传其一
 * - `POST   /:id/table`   生成/复用 `.univer` 表格（P2-3）：未装 Univer → 503
 * - `DELETE /:id`         删除
 *
 * 响应信封（2026-10-27，决策 2）：一律走 `apiOk` / `apiError`。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { readXlsx, sheetToTsv, sniffKind } from '../../lib/xlsx.js'
import {
  deleteAmazonDataset, getAmazonDataset, listAmazonDatasets,
  saveAmazonDatasetSummary, saveSearchTermReview,
} from '../../db/repo.js'
import type { AmazonDatasetSummaryPayload } from '../../db/repo.js'
import { importAmazonDataset } from './amazon-import.js'
import { createDatasetTable } from './amazon-dataset-table.js'
import { AMAZON_DATASETS_PREFIX as PREFIX, apiError, apiOk, isLoopbackRequest, pathSegments, readJsonBody } from './helpers.js'


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
/**
 * `parse-file` 的**预判**上限：base64 10MB + 64KB JSON 外壳。
 *
 * 为什么不复用 `MAX_PARSE_FILE_BODY_BYTES`（12MB）：那是**读体**上限，拿来当用户可见的预判口径
 * 会提示"上限 12MB"，可源文件约 7.5MB 就已经被拒 —— 两个数字对不上，用户会以为还能再大一点。
 * 预判只负责"早拒绝、说对话"；读体仍用 12MB，让略超 10MB 的请求能进到 base64 校验并拿到同一句文案。
 */
const MAX_PARSE_FILE_DECLARED_BYTES = MAX_FILE_BASE64 + 64 * 1024

/** 文件过大的唯一文案：预判与 base64 校验共用，前端按"源文件约 7.5MB"渲染。 */
const PARSE_FILE_TOO_LARGE_MESSAGE = '文件过大（超过约 7.5MB），请先筛选或拆分后再导入'

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

export function makeAmazonDatasetRoutes(db: DatabaseSync, deps: { probeUniver?: () => unknown } = {}): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        const url = new URL(req.url ?? '/', 'http://localhost')
        const segments = pathSegments(url, PREFIX)
        const method = req.method ?? 'GET'
        const bodyLimit = bodyLimitFor(method, segments)
        /**
         * 预判口径：`parse-file` 按"源文件约 7.5MB"（base64 10MB + 64KB 外壳），其余端点仍按读体上限。
         * 两种超限都回 413 + `too-large`，只是文案不同；行数据那道 8MB 不动。
         */
        const isParseFile = segments[0] === 'parse-file'
        const declaredLimit = isParseFile ? MAX_PARSE_FILE_DECLARED_BYTES : bodyLimit
        if (['POST', 'PATCH'].includes(method) && declaredTooLarge(req, declaredLimit)) {
          return isParseFile
            ? apiError(res, 413, PARSE_FILE_TOO_LARGE_MESSAGE, { code: 'too-large' })
            : apiError(res, 413, `请求体过大（上限 ${Math.round(bodyLimit / 1024 / 1024)}MB），请先筛选或拆分后再导入`, { code: 'too-large' })
        }
        const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req, bodyLimit) : undefined

        if (segments.length === 0) {
          if (method === 'GET') {
            return apiOk(res, { datasets: listAmazonDatasets(db, url.searchParams.get('kind_code') ?? 'search_term') })
          }
          if (method === 'POST') {
            if (body === undefined) return apiError(res, 400, 'invalid JSON body')
            /**
             * 旧写入路径**不再是第二份实现**：与 `POST /api/workbench/amazon/import`
             * 调同一个 `importAmazonDataset()`（按 kind 做列校验）。
             * 兼容旧 body 的 `kindCode`，`kind` 优先。
             */
            const outcome = importAmazonDataset(db, body)
            if (!outcome.ok) {
              return apiError(res, outcome.status, outcome.error, {
                code: outcome.code,
                ...outcome.missing === undefined ? {} : { missing: outcome.missing },
              })
            }
            return apiOk(res, { dataset: outcome.dataset, datasetId: outcome.dataset.id, duplicate: outcome.duplicate }, outcome.duplicate ? 200 : 201)
          }
          return apiError(res, 405, 'method not allowed')
        }

        const id = segments[0]
        /**
         * `POST /parse-file`：把一个 Excel / CSV 二进制转成 TSV 文本。
         *
         * 只做"文件 → 文本"，**不做列名解释**：表头定位与别名打分全在客户端的
         * `parseTrafficCsv` 里，保证"粘贴"和"选文件"走同一条校验路径。
         */
        if (id === 'parse-file' && method === 'POST') {
          if (body === undefined) return apiError(res, 400, 'invalid JSON body')
          const base64 = typeof body.base64 === 'string' ? body.base64 : ''
          if (base64 === '') return apiError(res, 400, 'base64 不能为空')
          if (base64.length > MAX_FILE_BASE64) return apiError(res, 413, PARSE_FILE_TOO_LARGE_MESSAGE, { code: 'too-large' })
          const filename = typeof body.filename === 'string' ? body.filename : ''
          let buffer: Buffer
          try {
            buffer = Buffer.from(base64, 'base64')
          } catch {
            return apiError(res, 400, '文件内容不是有效的 base64', { code: 'bad-base64' })
          }
          const kind = sniffKind(buffer)
          if (kind === 'text') {
            return apiOk(res, { format: 'text', tsv: buffer.toString('utf8'), filename })
          }
          const parsed = readXlsx(buffer)
          if (!parsed.ok) {
            return apiError(res, 400, parsed.errors.join('；'), { code: 'unreadable', filename })
          }
          const sheet = parsed.sheets[0]
          return apiOk(res, {
            format: 'xlsx',
            filename,
            sheetName: sheet.name,
            sheetCount: parsed.sheets.length,
            tsv: sheetToTsv(sheet),
          })
        }

        /**
         * `POST /:id/table`（P2-3）：数据集 → `.univer` 表格。
         * 已生成过且文件还在就复用（`reused: true`），不再堆草稿。
         * Univer 没装时由 `createDatasetTable` 回 503 + 中文原因。
         */
        if (segments.length === 2 && segments[1] === 'table' && method === 'POST') {
          if (body === undefined) return apiError(res, 400, 'invalid JSON body')
          const outcome = await createDatasetTable(db, deps, id, body)
          const { error, ...extra } = outcome.payload
          if (outcome.status >= 400) {
            return apiError(res, outcome.status, typeof error === 'string' ? error : '生成表格失败', extra)
          }
          return apiOk(res, outcome.payload, outcome.status)
        }

        if (method === 'GET' && segments.length === 1) {          const dataset = getAmazonDataset(db, id)
          return dataset === undefined ? apiError(res, 404, 'dataset not found') : apiOk(res, { dataset })
        }
        if (method === 'PATCH' && segments.length === 1) {
          if (body === undefined) return apiError(res, 400, 'invalid JSON body')
          const reviewsRaw: unknown[] = Array.isArray(body.reviews) ? body.reviews : []
          const hasReviews = Array.isArray(body.reviews)
          const hasSummary = Object.prototype.hasOwnProperty.call(body, 'summary')
          if (!hasReviews && !hasSummary) {
            return apiError(res, 400, '需要 reviews 数组（词级建议）或 summary 对象（报表级结论）')
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
              return apiError(res, 400, 'summary 必须是非空 JSON 对象，或 null（清空结论）')
            } else {
              summary = raw as AmazonDatasetSummaryPayload
            }
          }
          try {
            let dataset = getAmazonDataset(db, id)
            if (dataset === undefined) return apiError(res, 404, 'dataset not found')
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
            return apiOk(res, { dataset })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return message === 'dataset not found'
              ? apiError(res, 404, message)
              : apiError(res, 400, message)
          }
        }
        if (method === 'DELETE' && segments.length === 1) {
          return deleteAmazonDataset(db, id)
            ? apiOk(res)
            : apiError(res, 404, 'dataset not found')
        }
        return apiError(res, 405, 'method not allowed')
      },
    },
  ]
}
