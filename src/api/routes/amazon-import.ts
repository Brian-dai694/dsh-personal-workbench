/**
 * 统一导入端点（P2-2）：`POST /api/workbench/amazon/import`
 *
 * ## 为什么要有它
 * 亚马逊版块原先有两条互不相干的写入路径（流量分析写 datasets、报表页也写 datasets，
 * 各自只认识自己那种报表）。加一个"选类型 → 按类型校验 → 落库"的入口后，
 * 六种报表只有一套校验口径，界面不必再各写一份。
 *
 * ## 兼容旧调用
 * 旧路由（`POST /api/workbench/amazon/datasets`）**保留**，内部调同一个
 * `importAmazonDataset()`。所以前端同批改成新端点的过程中，两种请求都能用，
 * 且行为（校验、默认值、落库字段）完全一致。
 * 旧 body 里的 `kindCode` 也照旧接受，`kind` 优先。
 *
 * ## 失败语义
 * - 缺列 / 行不合法 → **400 + 中文原因**（说明缺哪一列、第几行哪一列不对），绝不存半份；
 * - 请求体过大 → 413（按 `content-length` 预判，避免只报"JSON 不合法"）；
 * - 非 loopback → 403。
 *
 * 只写"用户导入的报表原值"，不产生任何账户数据，也不触发广告账户操作。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DatabaseSync } from 'node:sqlite'
import { AMAZON_DATASET_KINDS, AMAZON_KIND_LABELS, isAmazonDatasetKind, validateAmazonImportRows } from '../../amazon/import.js'
import { createAmazonDataset, findDuplicateAmazonDataset } from '../../db/repo.js'
import type { AmazonDatasetRow } from '../../db/repo.js'
import { AMAZON_IMPORT_PREFIX, apiError, apiOk, isLoopbackRequest, readJsonBody } from './helpers.js'

/** 行数据上限：与 datasets 路由同一量级（几千行搜索词报表约数百 KB）。 */
export const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024

export type AmazonImportOutcome =
  | {
    readonly ok: true
    readonly dataset: AmazonDatasetRow
    /** true = 命中同 kind_code + 同 period + 同行数的既有数据集，没有新增行。 */
    readonly duplicate: boolean
  }
  | {
    readonly ok: false
    readonly status: number
    readonly error: string
    /** 机器可读分类：invalid-kind / missing-columns / invalid-rows / invalid-body */
    readonly code: string
    readonly missing?: string[]
  }

function failure(status: number, error: string, code: string, missing?: string[]): AmazonImportOutcome {
  return missing === undefined ? { ok: false, status, error, code } : { ok: false, status, error, code, missing }
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 导入核心：**新老路由共用这一份**。
 *
 * @param body - 请求体（`kind_code` **必填**，不再有缺省；兼容旧字段 `kind` / `kindCode`；
 *   其余：title、period、rows、sourceCode、sessionId、univerFile）
 */
export function importAmazonDataset(db: DatabaseSync, body: Record<string, unknown>): AmazonImportOutcome {
  const kindRaw = body.kind_code ?? body.kind ?? body.kindCode
  /**
   * 缺 kind **必须报错**，不再静默默认 `search_term`。
   *
   * 为什么：campaign/placement 等报表漏传 kind 会被写成搜索词，之后“合法”进入搜索词判定并写回建议，
   * 而且从数据上根本看不出来写错了。宁可让旧调用方在这里报错暴露出来，也不接受安静地写错口径。
   */
  if (kindRaw === undefined || kindRaw === null || kindRaw === '') {
    return failure(400, 'kind_code 必填：不允许再默认 search_term（缺类型会写错报表口径）', 'missing-kind')
  }
  if (!isAmazonDatasetKind(kindRaw)) {
    return failure(400, `kind_code 非法：${String(kindRaw)}（允许 ${AMAZON_DATASET_KINDS.join(' / ')}）`, 'invalid-kind')
  }

  const validation = validateAmazonImportRows(kindRaw, body.rows)
  if (!validation.ok) {
    return failure(
      400,
      validation.message,
      validation.missing.length > 0 ? 'missing-columns' : 'invalid-rows',
      validation.missing.length > 0 ? validation.missing : undefined,
    )
  }

  const title = textOf(body.title) ?? AMAZON_KIND_LABELS[kindRaw]
  const period = textOf(body.period)
  /** 重复导入识别：同类型 + 同周期 + 同行数 → 返回既有那份（不新增行）。 */
  const duplicate = findDuplicateAmazonDataset(db, kindRaw, period, validation.rows.length)
  if (duplicate !== undefined) return { ok: true, dataset: duplicate, duplicate: true }

  try {
    const dataset = createAmazonDataset(db, {
      kindCode: kindRaw,
      title,
      period,
      rows: validation.rows,
      sourceCode: textOf(body.sourceCode) ?? 'paste',
      sessionId: textOf(body.sessionId),
      univerFile: textOf(body.univerFile),
    })
    return { ok: true, dataset, duplicate: false }
  } catch (error) {
    return failure(400, error instanceof Error ? error.message : String(error), 'invalid-body')
  }
}

/** `content-length` 预判：超限直接 413，而不是让读体阶段返回"JSON 不合法"。 */
function declaredTooLarge(headers: Record<string, string | string[] | undefined>, limit: number): boolean {
  const raw = headers['content-length']
  if (typeof raw !== 'string') return false
  const declared = Number(raw)
  return Number.isFinite(declared) && declared > limit
}

export function makeAmazonImportRoutes(db: DatabaseSync): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: AMAZON_IMPORT_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        if ((req.method ?? 'GET') !== 'POST') return apiError(res, 405, 'method not allowed')
        if (declaredTooLarge(req.headers, MAX_IMPORT_BODY_BYTES)) {
          return apiError(res, 413, `请求体过大（上限 ${Math.round(MAX_IMPORT_BODY_BYTES / 1024 / 1024)}MB），请先筛选或拆分后再导入`, { code: 'too-large' })
        }
        const body = await readJsonBody(req, MAX_IMPORT_BODY_BYTES)
        if (body === undefined) return apiError(res, 400, 'invalid JSON body', { code: 'invalid-body' })

        const outcome = importAmazonDataset(db, body)
        if (!outcome.ok) {
          return apiError(res, outcome.status, outcome.error, {
            code: outcome.code,
            ...outcome.missing === undefined ? {} : { missing: outcome.missing },
          })
        }
        return apiOk(res, { dataset: outcome.dataset, datasetId: outcome.dataset.id, duplicate: outcome.duplicate }, outcome.duplicate ? 200 : 201)
      },
    },
  ]
}
