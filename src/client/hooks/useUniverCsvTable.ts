/**
 * 表格能力域：把当前页的数据变成可编辑的 `.univer` 草稿，并在本页嵌着看。
 *
 * ## 唯一出口（2026-10-30）
 *
 * 生成表格只走 `POST /api/workbench/amazon/table-preview`（`openTable`）：
 * 调用方给 `columns + rows`，服务端负责校验上限、转 CSV、建 draft、回 `viewerUrl`。
 * 兼容路由待删除；调用方已切换至 `openTable`，
 * 留着只会出现「该前端不再依赖该兼容入口」。
 *
 * 数据集那条 `openDataset` 仍保留：它有**复用**语义（服务端记住 `univer_file`，
 * 文件还在就直接开），和「每次新建草稿」的 `openTable` 不是一回事。
 *
 * ## 纪律
 *
 * 生成物一律是 draft worktree：合并/放弃必须由用户在 Viewer 里点，本域不调用 merge/discard。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { viewerUrlOf } from '../../shared/univerViewer.js'

const AVAILABILITY_PATH = '/api/workbench/univer/availability'
const PREVIEW_PATH = '/api/workbench/amazon/table-preview'

export type UniverTableViewerPhase = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 「能不能读到表格内容」与「装没装」是两件事，界面必须分开说。
 *
 * `unavailable` 只认宿主的明确答复；老宿主没有这个字段时是 `unknown`，
 * 界面**不许**把 `unknown` 渲染成「读不到」—— 那是替宿主下结论。
 */
export type UniverContentReadStatus = 'bundled' | 'unavailable' | 'unknown'

export interface UniverTableViewerState {
  readonly phase: UniverTableViewerPhase
  /** `phase === 'ready'` 时的 iframe 地址。 */
  readonly url: string
  /** 生成出来的 `.univer` 绝对路径（ready 时才有）。 */
  readonly file: string
  /** 给用户看的一句中文说明。 */
  readonly message: string
}

export interface UseUniverCsvTableActions {
  /** 重新探测 Univer 是否可用（用户可能刚装上/卸掉）。 */
  readonly refreshAvailability: () => Promise<void>
  /**
   * 结构化行 → 表格（**唯一预览出口**）。
   *
   * 服务端直接回 `viewerUrl`，所以不需要再走 `/univer-api/state` 取地址；
   * 列数/行数/体积上限也全在服务端校验，前端不重复实现。
   */
  readonly openTable: (columns: string[], rows: Array<Array<string | number | null>>, title?: string) => Promise<void>
  /**
   * 打开**某个数据集**对应的表格（P2-3）。
   *
   * 与 `openTable` 的差别不只是「省掉前端序列化」：服务端会记住 `univer_file`，
   * 文件还在时**直接复用**（`reused: true`），连点两次不会堆两份草稿。
   */
  readonly openDataset: (datasetId: string) => Promise<void>
  /** 收起预览。 */
  readonly close: () => void
}

export interface UseUniverCsvTableResult {
  /** `null` = 还没探到；`false` = 明确没装。 */
  readonly available: boolean | null
  /** 宿主能不能读到表格内容（`availability.unitContent`）；缺字段 = `unknown`。 */
  readonly contentRead: UniverContentReadStatus
  readonly busy: boolean
  readonly viewer: UniverTableViewerState
  readonly actions: UseUniverCsvTableActions
}

export interface UseUniverCsvTableInput {
  readonly sessionId: string
  /** 当前会话工作区：生成的 `.univer` 落在它下面。 */
  readonly workspace: string
}

const IDLE: UniverTableViewerState = { phase: 'idle', url: '', file: '', message: '' }

/**
 * 从 Host 状态里挑一个最该看的 Viewer 地址：草稿优先 → ready 合并预览 → trunk。
 *
 * 实现抽在 `shared/univerViewer.ts`（服务端生成表格后也要返回同一个地址）；
 * 这里只做再导出，保持既有调用方与测试的 import 路径不变。
 */
export { viewerUrlOf }

export function useUniverCsvTable(input: UseUniverCsvTableInput): UseUniverCsvTableResult {
  const { sessionId, workspace } = input
  const [available, setAvailable] = useState<boolean | null>(null)
  const [contentRead, setContentRead] = useState<UniverContentReadStatus>('unknown')
  const [busy, setBusy] = useState(false)
  const [viewer, setViewer] = useState<UniverTableViewerState>(IDLE)
  /** 连点两次（或换数据）时只保留最后一次结果：迟到响应不得覆盖新状态。 */
  const seq = useRef(0)

  const refreshAvailability = useCallback(async (): Promise<void> => {
    try {
      const body = await api<{ available?: boolean; unitContent?: string }>(AVAILABILITY_PATH)
      setAvailable(body.available === true)
      /** 只认宿主明确给出的两个值；其余（含老宿主缺字段）一律 unknown。 */
      setContentRead(
        body.unitContent === 'bundled' || body.unitContent === 'unavailable'
          ? body.unitContent
          : 'unknown',
      )
    } catch {
      /** 探测失败按「不可用」处理：宁可少一个按钮，也不要给一个必然失败的入口。 */
      setAvailable(false)
      setContentRead('unknown')
    }
  }, [])

  const close = useCallback((): void => {
    seq.current += 1
    setViewer(IDLE)
  }, [])

  const openTable = useCallback(async (
    columns: string[],
    rows: Array<Array<string | number | null>>,
    title?: string,
  ): Promise<void> => {
    const ticket = seq.current + 1
    seq.current = ticket
    if (workspace.trim() === '') {
      setViewer({ phase: 'error', url: '', file: '', message: '读不到当前会话的工作区，所以不生成表格文件（不猜一个目录写进去）。' })
      return
    }
    setBusy(true)
    setViewer({ phase: 'loading', url: '', file: '', message: '' })
    try {
      const created = await api<{ file?: string; viewerUrl?: string }>(PREVIEW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          columns,
          rows,
          workspace,
          ...(sessionId.trim() === '' ? {} : { sessionId }),
        }),
      })
      if (seq.current !== ticket) return
      const file = typeof created.file === 'string' ? created.file : ''
      const url = typeof created.viewerUrl === 'string' ? created.viewerUrl : ''
      if (url === '') {
        setViewer({
          phase: 'error',
          url: '',
          file,
          message: file === '' ? '宿主没有返回生成的文件路径。' : `表格已生成（${file}），但宿主没有返回预览地址。`,
        })
        return
      }
      setViewer({ phase: 'ready', url, file, message: '' })
    } catch (cause) {
      if (seq.current !== ticket) return
      setViewer({ phase: 'error', url: '', file: '', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (seq.current === ticket) setBusy(false)
    }
  }, [sessionId, workspace])

  /**
   * 数据集 → 表格：`POST /api/workbench/amazon/datasets/:id/table`。
   *
   * 「生成 / 复用 / 写回 `univer_file`」三件事都由服务端负责；503 表示没装 Univer，
   * `api()` 会把服务端的中文原因原样抛出。
   */
  const openDataset = useCallback(async (datasetId: string): Promise<void> => {
    const ticket = seq.current + 1
    seq.current = ticket
    if (workspace.trim() === '') {
      setViewer({ phase: 'error', url: '', file: '', message: '读不到当前会话的工作区，所以不生成表格文件（不猜一个目录写进去）。' })
      return
    }
    setBusy(true)
    setViewer({ phase: 'loading', url: '', file: '', message: '' })
    try {
      const res = await api<{ file?: string; viewerUrl?: string; reused?: boolean }>(
        `/api/workbench/amazon/datasets/${encodeURIComponent(datasetId)}/table`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace, sessionId }),
        },
      )
      if (seq.current !== ticket) return
      const file = typeof res.file === 'string' ? res.file : ''
      const url = typeof res.viewerUrl === 'string' ? res.viewerUrl : ''
      if (url === '') {
        setViewer({
          phase: 'error',
          url: '',
          file,
          message: file === ''
            ? '宿主没有返回表格文件，可以稍后再点一次。'
            : `表格已就绪（${file}），但宿主没有返回预览地址；可以直接在文件树里打开它。`,
        })
        return
      }
      setViewer({
        phase: 'ready',
        url,
        file,
        message: res.reused === true ? '这是一份已经生成过的表格，直接打开了原文件（没有重复生成）。' : '',
      })
    } catch (cause) {
      if (seq.current !== ticket) return
      setViewer({ phase: 'error', url: '', file: '', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (seq.current === ticket) setBusy(false)
    }
  }, [sessionId, workspace])

  /** 首次挂载探一次可用性；工作区变了也重探（可能换了 profile 环境）。 */
  useEffect(() => {
    void refreshAvailability()
  }, [refreshAvailability, workspace])

  return {
    available,
    contentRead,
    busy,
    viewer,
    actions: { refreshAvailability, openTable, openDataset, close },
  }
}
