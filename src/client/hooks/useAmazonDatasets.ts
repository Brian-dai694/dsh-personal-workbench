/**
 * Amazon 数据集域（客户端）：面板导入的搜索词报表的**唯一状态所有者**。
 *
 * 为什么要有它：视图不许发 HTTP（D17 结构硬门），而"导入 / 读取 / 读回 AI 写回的建议"
 * 是三条真实请求。放在 hook 里，视图只拿结果与意图（`importRows` / `select` / `refresh`），
 * 与任务详情、知识库等域的接法一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { WORKBENCH_BUILD_ID } from '../buildId.js'
import type { AmazonDatasetRow, AmazonDatasetSummary } from '../../db/repo/amazonDatasets.js'
import type { TrafficRow } from '../amazonTrafficTools.js'

export interface ImportDatasetInput {
  title: string
  period: string | null
  rows: TrafficRow[]
  sourceCode?: string
}

export interface UseAmazonDatasetsActions {
  /** 重新拉列表（打开面板、导入完成、删除之后）。 */
  refresh: () => Promise<void>
  /** 导入一份报表并把它设为当前数据集；失败返回 null（错误写进 error）。 */
  importRows: (input: ImportDatasetInput) => Promise<AmazonDatasetRow | null>
  /**
   * 读一个用户选的文件，返回**文本**（TSV/CSV 原文）。
   *
   * 为什么放在 hook 而不是视图：视图不许发 HTTP（D17 结构硬门）。
   * 文本类扩展名本机 `file.text()`；`.xlsx/.xls` 一律交给服务端按魔数解析 ——
   * 二进制文件用 `readAsText` 读会得到乱码，正是"第 657 行 clicks 不是数字"的成因。
   */
  parseUpload: (file: File) => Promise<string>
  /** 切到某个已导入的数据集（含 AI 最新写回的建议）。 */
  select: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clearError: () => void
}

export interface UseAmazonDatasetsResult {
  datasets: AmazonDatasetSummary[]
  current: AmazonDatasetRow | null
  busy: boolean
  error: string | null
  /**
   * 宿主服务端与本页客户端不是同一个构建时的提示（2026-10-22 真实事故）。
   *
   * 现象：客户端 bundle 在每次打开页面时重新加载，而插件**服务端代码只在桌面端启动时
   * 加载一次**。于是"装了新包但没重启"会得到：界面是新的、接口是旧的 → `GET /datasets` 404，
   * 用户只看到一句裸 404，以为功能坏了。这里拿 health 的 buildId 与页面内联的 buildId 对一次，
   * 不一致就明说"请完全退出桌面端再启动"。
   */
  staleServer: string | null
  /** 接口整体不可用（例如服务端还没有这个路由）：视图据此隐藏"导入"这类会 404 的操作。 */
  updateFailed: boolean
  actions: UseAmazonDatasetsActions
}

type ListResponse = { datasets: AmazonDatasetSummary[] }
type OneResponse = { dataset: AmazonDatasetRow }

export function useAmazonDatasets(): UseAmazonDatasetsResult {
  const [datasets, setDatasets] = useState<AmazonDatasetSummary[]>([])
  const [current, setCurrent] = useState<AmazonDatasetRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [staleServer, setStaleServer] = useState<string | null>(null)
  const [updateFailed, setUpdateFailed] = useState(false)
  /** 卸载后不许再 setState（与插件其他域同一条纪律）。 */
  const alive = useRef(true)
  /** 当前数据集 id 的即时读数：refresh 要用它判断"要不要自动载入"，但不能进依赖（否则自激）。 */
  const currentIdRef = useRef('')
  useEffect(() => () => { alive.current = false }, [])

  const loadOne = useCallback(async (id: string): Promise<AmazonDatasetRow | null> => {
    try {
      const res = await api<OneResponse>(`/api/workbench/amazon/datasets/${encodeURIComponent(id)}`)
      if (!alive.current) return null
      currentIdRef.current = res.dataset.id
      setCurrent(res.dataset)
      setError(null)
      return res.dataset
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  /**
   * 探测"服务端是不是本页这一版"：插件服务端代码只在桌面端启动时加载一次，
   * 而客户端 bundle 每次开页面都是新的 —— 装了新包没重启就是这个组合。
   */
  const probeServer = useCallback(async (): Promise<void> => {
    try {
      const health = await api<{ buildId?: string }>('/api/workbench/health')
      if (!alive.current) return
      const serverBuild = typeof health.buildId === 'string' ? health.buildId : ''
      const mismatch = serverBuild !== '' && WORKBENCH_BUILD_ID !== 'unknown' && serverBuild !== WORKBENCH_BUILD_ID
      setStaleServer(mismatch ? serverBuild : null)
    } catch {
      /** health 拿不到不算"落后"，别把网络抖动说成版本不一致。 */
      if (alive.current) setStaleServer(null)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await api<ListResponse>('/api/workbench/amazon/datasets?kind_code=search_term')
      if (!alive.current) return
      setDatasets(res.datasets)
      setError(null)
      setUpdateFailed(false)
      /**
       * 只有"还没有当前数据集"时才自动读最近一份：否则用户手动选过旧数据集后，
       * 任何一次刷新都会把他弹回最新那份（界面行为会显得不受控）。
       */
      if (currentIdRef.current === '' && res.datasets.length > 0) await loadOne(res.datasets[0].id)
    } catch (e) {
      if (!alive.current) return
      setError(e instanceof Error ? e.message : String(e))
      setUpdateFailed(true)
      await probeServer()
    }
  }, [loadOne, probeServer])

  const importRows = useCallback(async (input: ImportDatasetInput): Promise<AmazonDatasetRow | null> => {
    setBusy(true)
    try {
      const res = await api<OneResponse>('/api/workbench/amazon/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          period: input.period,
          rows: input.rows,
          sourceCode: input.sourceCode ?? 'paste',
        }),
      })
      if (!alive.current) return null
      currentIdRef.current = res.dataset.id
      setCurrent(res.dataset)
      setError(null)
      await refresh()
      return res.dataset
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const select = useCallback(async (id: string): Promise<void> => {
    setBusy(true)
    try { await loadOne(id) } finally { if (alive.current) setBusy(false) }
  }, [loadOne])

  const remove = useCallback(async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await api(`/api/workbench/amazon/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!alive.current) return
      if (currentIdRef.current === id) currentIdRef.current = ''
      setCurrent((prev) => (prev?.id === id ? null : prev))
      setError(null)
      await refresh()
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const clearError = useCallback(() => setError(null), [])

  const parseUpload = useCallback(async (file: File): Promise<string> => {
    const lower = file.name.toLowerCase()
    if (/\.(csv|tsv|txt)$/.test(lower)) return await file.text()
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunk = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
    }
    const res = await api<{ ok: boolean; tsv: string }>('/api/workbench/amazon/datasets/parse-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, base64: btoa(binary) }),
    })
    if (typeof res.tsv !== 'string' || res.tsv === '') throw new Error('这个文件里没有可用的表格数据')
    return res.tsv
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return {
    datasets,
    current,
    busy,
    error,
    staleServer,
    updateFailed,
    actions: { refresh, importRows, parseUpload, select, remove, clearError },
  }
}
