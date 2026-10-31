/**
 * 数据集 → 表格（P2-3）：`POST /api/workbench/amazon/datasets/:id/table`
 *
 * ## 做什么
 * 把库里的数据集行**序列化成 CSV**，交给宿主 `ctx.univer` 变成可编辑的 `.univer`，
 * 把绝对路径写回 `amazon_datasets.univer_file`，并返回 `{ ok, file, viewerUrl, reused }`。
 *
 * ## 两条硬约束
 * 1. **能复用就复用**：`univer_file` 有值且文件还在 → 直接返回它现有的 Viewer 地址，
 *    不新建草稿（`reused: true`）。否则"在表格里打开"点两次就堆两份 draft worktree。
 *    只有文件不在了、或用户显式 `regenerate: true` 才重新生成（`reused: false`）。
 * 2. **viewerUrl 与界面同一份挑选逻辑**：`shared/univerViewer.ts` 的 `viewerUrlOf`
 *    （草稿 → ready 合并 → trunk），再按宿主口径补 `&sessionId=`。两处看到的是同一个版本。
 *
 * ## 没装 Univer 时
 * `503` + 明确中文原因（"这个 profile 没装 dsh-univer-office"），
 * **不伪造路径、不假装生成成功**。
 *
 * ## 文件名
 * 数据集标题来自 `toLocaleString('zh-CN')`，形如 `搜索词报表 2026/10/29 14:56:14` ——
 * 含 `/` 与 `:`，Windows 非法。统一 sanitize：非法字符换 `-`、去结尾点/空格、截 60、
 * 空名回退 `amazon-dataset`，**中文保留不转拼音**。
 */
import { stat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { datasetRowsToCsv } from '../../amazon/import.js'
import { viewerUrlOf, withUniverSession } from '../../shared/univerViewer.js'
import { getAmazonDataset, setAmazonDatasetUniverFile } from '../../db/repo.js'
import type { UniverServiceLike } from './univer-office.js'
import { importCsvAsUniverDraft } from './univer-office.js'

/** 本模块用到的宿主服务：导入三件套 + 读文件状态（`/univer-api/state` 的同一实现）。 */
export interface UniverTableService extends UniverServiceLike {
  fileState(request: { workspace: string; file: string }, signal?: AbortSignal): Promise<unknown>
}

/** 一次请求的结果（由路由负责写响应；抽出来便于单测直接断言）。 */
export interface DatasetTableOutcome {
  readonly status: number
  readonly payload: Record<string, unknown>
}

const FAIL_UNIVER_MISSING = '这个 profile 没装 dsh-univer-office（或没有启用），无法生成 .univer 表格。装好后再点一次即可。'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 从软探测结果里取服务；缺任何一个方法都当"没装"，不硬试。 */
export function readUniverTableService(probe: (() => unknown) | undefined): UniverTableService | null {
  if (probe === undefined) return null
  const value = probe()
  if (!isRecord(value)) return null
  const candidate = value as Partial<UniverTableService>
  if (
    typeof candidate.newFile !== 'function'
    || typeof candidate.worktree !== 'function'
    || typeof candidate.importUnitContent !== 'function'
    || typeof candidate.fileState !== 'function'
  ) return null
  return candidate as UniverTableService
}

/**
 * 数据集标题 → 安全文件名（不含扩展名）。
 *
 * 规则（服务端唯一一处，不要再在别处写第二份）：
 * 1. 去掉 `\ / : * ? " < > |` 与控制字符（换 `-`）；
 * 2. 连续空白压成一个空格；
 * 3. 去掉结尾的点与空格（Windows 会静默吃掉它们）；
 * 4. 截到 60 字符（截断后可能又露结尾点，再修一次）；
 * 5. 空名回退 `amazon-dataset`；中文原样保留。
 */
export function safeDatasetTableName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  const cut = cleaned.slice(0, 60).replace(/[. ]+$/g, '').trim()
  return cut === '' ? 'amazon-dataset' : cut
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** 取 Viewer 地址：拿不到就返回空串（调用方据此提示"已生成但取不到预览"）。 */
export async function resolveViewerUrl(
  univer: UniverTableService,
  workspace: string | null,
  file: string,
  sessionId: string,
): Promise<string> {
  if (workspace === null) return ''
  try {
    const state = await univer.fileState({ workspace, file })
    return withUniverSession(viewerUrlOf(state), sessionId)
  } catch {
    return ''
  }
}

/**
 * 生成 / 复用数据集表格。
 *
 * @param body - `{ workspace?, sessionId?, regenerate? }`
 *   - `workspace`：`.univer` 落点（必须在工作区内，Univer 的授权路径检查要求如此）；
 *   - `sessionId`：附到 viewerUrl 上（宿主靠它做会话作用域）；缺省用数据集记录的 session；
 *   - `regenerate`：用户明确要求重建时才为 true。
 */
export async function createDatasetTable(
  db: DatabaseSync,
  deps: { probeUniver?: () => unknown },
  datasetId: string,
  body: Record<string, unknown>,
): Promise<DatasetTableOutcome> {
  const dataset = getAmazonDataset(db, datasetId)
  if (dataset === undefined) {
    return { status: 404, payload: { code: 'NOT_FOUND', error: `数据集不存在：${datasetId}` } }
  }

  const univer = readUniverTableService(deps.probeUniver)
  if (univer === null) {
    return { status: 503, payload: { code: 'UNIVER_MISSING', error: FAIL_UNIVER_MISSING } }
  }

  const workspace = textOf(body.workspace)
  const sessionId = textOf(body.sessionId) ?? dataset.sessionId ?? ''
  const regenerate = body.regenerate === true

  /** 先复用：文件还在就不新建草稿（这是"点两次不堆草稿"的唯一开关）。 */
  if (!regenerate && dataset.univerFile !== null && await fileExists(dataset.univerFile)) {
    const viewerUrl = await resolveViewerUrl(univer, workspace, dataset.univerFile, sessionId)
    if (viewerUrl !== '') {
      return {
        status: 200,
        payload: { datasetId: dataset.id, file: dataset.univerFile, viewerUrl, reused: true },
      }
    }
    /** 文件在但拿不到预览地址：仍告诉前端文件在哪，别让它重新生成一份。 */
    return {
      status: 200,
      payload: {
        datasetId: dataset.id, file: dataset.univerFile, viewerUrl: '', reused: true,
        code: 'VIEWER_STATE_UNAVAILABLE',
        error: workspace === null
          ? '表格文件已存在，但缺少 workspace，无法取预览地址。'
          : '表格文件已存在，但宿主没有返回预览地址。',
      },
    }
  }

  if (workspace === null) {
    return {
      status: 400,
      payload: { code: 'WORKSPACE_REQUIRED', error: '缺少 workspace：生成 .univer 需要指定一个绝对路径的工作区目录。' },
    }
  }

  const csv = datasetRowsToCsv(dataset.kindCode, dataset.rows)
  const outcome = await importCsvAsUniverDraft({
    univer,
    workspace,
    name: safeDatasetTableName(dataset.title),
    csv,
  })
  if (!outcome.ok) {
    return { status: 502, payload: { code: outcome.failure.code, error: outcome.failure.message } }
  }

  /** 路径写回库：即使随后取不到预览地址，文件也已经生成，不能丢这条记录。 */
  setAmazonDatasetUniverFile(db, dataset.id, outcome.file)
  const viewerUrl = await resolveViewerUrl(univer, workspace, outcome.file, sessionId)
  if (viewerUrl === '') {
    return {
      status: 200,
      payload: {
        datasetId: dataset.id, file: outcome.file, viewerUrl: '', reused: false,
        code: 'VIEWER_STATE_UNAVAILABLE',
        error: '表格已生成，但宿主没有返回预览地址；可以直接在文件树里打开它。',
      },
    }
  }
  return { status: 200, payload: { datasetId: dataset.id, file: outcome.file, viewerUrl, reused: false } }
}
