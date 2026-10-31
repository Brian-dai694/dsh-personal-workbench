/**
 * 无持久化表格预览（2026-10-30，产品库/付款对账统一体验）。
 *
 * `POST /api/workbench/amazon/table-preview`：
 * 入参 `{ title?, columns[], rows[][], workspace, sessionId? }`，把派生视图（产品库当前筛选、
 * 付款对账结果这类**没有 dataset 记录**的数据）生成 `.univer` 草稿并回 Viewer 地址。
 *
 * 三条边界：
 * 1. **不落库**：不写 `amazon_datasets`、不分配 datasetId —— 这是"看一眼"的出口，
 *    不是报表档案。要留档的场景仍走数据集导入。
 * 2. **不造路径**：`workspace` 必填且必须是已存在的绝对目录（Univer 授权路径要求）；
 *    文件名沿用 `safeTableName + 时间戳`，重复点击只多文件、不覆盖。
 * 3. **能力缺失说清楚**：未装 `dsh-univer-office` → 503 + `UNIVER_MISSING`；
 *    生成失败按桥接返回码回 502，不谎称成功。
 *
 * 写操作仍进 draft worktree；合并必须由用户在 Viewer 里操作，本接口不做合并。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { parseTablePreview } from '../tablePreview.js'
import { readUniverTableService, resolveViewerUrl } from './amazon-dataset-table.js'
import { ensureWorkspaceDir, importCsvAsUniverDraft } from './univer-office.js'
import { AMAZON_TABLE_PREVIEW_PREFIX as PREFIX, apiError, apiOk, isLoopbackRequest, readJsonBody } from './helpers.js'

/** 请求体上限：rows 已限 5000×40，2MB 足够；再大说明调用方用错了场景。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export function makeAmazonTablePreviewRoutes(probeUniver?: () => unknown): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        if ((req.method ?? 'GET') !== 'POST') return apiError(res, 405, 'method not allowed')

        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (body === undefined) {
          return apiError(res, 400, '请求体不是合法 JSON，或超过 2MB。', { code: 'INVALID_REQUEST' })
        }

        const parsed = parseTablePreview(body)
        if (!parsed.ok) return apiError(res, parsed.status, parsed.message, { code: parsed.code })

        const univer = readUniverTableService(probeUniver)
        if (univer === null) {
          return apiError(res, 503, '这个 profile 没装 dsh-univer-office（或没有启用），无法生成 .univer 表格。', {
            code: 'UNIVER_MISSING',
          })
        }

        const workspace = await ensureWorkspaceDir(body.workspace)
        if (typeof workspace !== 'string') {
          return apiError(res, 400, workspace.message, { code: workspace.code })
        }

        const outcome = await importCsvAsUniverDraft({
          univer,
          workspace,
          name: parsed.data.title,
          csv: parsed.data.csv,
        })
        if (!outcome.ok) return apiError(res, 502, outcome.failure.message, { code: outcome.failure.code })

        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const viewerUrl = await resolveViewerUrl(univer, workspace, outcome.file, sessionId)
        return apiOk(res, {
          file: outcome.file,
          worktreeId: outcome.worktreeId,
          unitId: outcome.unitId,
          viewerUrl,
          rows: parsed.data.rows.length,
          columns: parsed.data.columns.length,
        })
      },
    },
  ]
}
