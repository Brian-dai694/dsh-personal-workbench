/**
 * 广告报表域（客户端 T3）：**非搜索词**类型的本地状态所有者。
 *
 * 为什么单独一个 hook：报表分析页支持 6 种报表，其中 `search_term` 必须与
 * 流量分析 / 关键词页读**同一份** current（`useAmazonDatasets`），不能在这里再存一份；
 * 其余 5 种（投放 / 活动 / 广告位 / 预算 / 份额）暂时没有跨页用途，留在本地。
 *
 * 即便如此，"本地"也不等于"视图自己发 HTTP"（D17 结构硬门）：
 * 列表、详情、导入三条请求全部收在本 hook 里，视图只拿 current / history 与意图。
 *
 * 类型上**排除 `search_term`**：这里根本收不到它，也就不存在"覆盖共享 current"的路径。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { AdReportKind, AdReportRow } from '../../shared/adReport.js'

/** 只有这些类型归本 hook；搜索词归 `useAmazonDatasets`。 */
export type LocalAdReportKind = Exclude<AdReportKind, 'search_term'>

export interface AdReportDatasetSummary {
  id: string
  kindCode: string
  title: string
  period: string | null
  rowCount: number
  createdAt: string
}

export interface AdReportDatasetDetail {
  id: string
  kindCode: string
  title: string
  period: string | null
  rows: AdReportRow[]
}

export interface ImportAdReportInput {
  title: string
  period: string | null
  rows: AdReportRow[]
  sourceCode?: string
}

export interface UseAdReportDatasetsActions {
  /** 读某一类型的最近一份（切换页签时）。 */
  loadLatest: (kind: LocalAdReportKind) => Promise<void>
  /** 导入一份报表并设为当前；失败返回 null（原因写进 error）。 */
  importRows: (kind: LocalAdReportKind, input: ImportAdReportInput) => Promise<AdReportDatasetDetail | null>
  clearError: () => void
}

export interface UseAdReportDatasetsResult {
  current: AdReportDatasetDetail | null
  history: AdReportDatasetSummary[]
  busy: boolean
  error: string | null
  actions: UseAdReportDatasetsActions
}

export function useAdReportDatasets(): UseAdReportDatasetsResult {
  const [current, setCurrent] = useState<AdReportDatasetDetail | null>(null)
  const [history, setHistory] = useState<AdReportDatasetSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const loadLatest = useCallback(async (kind: LocalAdReportKind): Promise<void> => {
    try {
      const list = await api<{ datasets: AdReportDatasetSummary[] }>(`/api/workbench/amazon/datasets?kind_code=${kind}`)
      if (!alive.current) return
      const items = list.datasets ?? []
      setHistory(items)
      const latest = items[0]
      if (latest === undefined) { setCurrent(null); setError(null); return }
      const detail = await api<{ dataset: AdReportDatasetDetail }>(`/api/workbench/amazon/datasets/${encodeURIComponent(latest.id)}`)
      if (!alive.current) return
      setCurrent(detail.dataset)
      setError(null)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const importRows = useCallback(async (kind: LocalAdReportKind, input: ImportAdReportInput): Promise<AdReportDatasetDetail | null> => {
    setBusy(true)
    try {
      const created = await api<{ dataset: AdReportDatasetDetail }>('/api/workbench/amazon/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kindCode: kind,
          title: input.title,
          period: input.period,
          rows: input.rows,
          sourceCode: input.sourceCode ?? 'paste',
        }),
      })
      if (!alive.current) return null
      setCurrent(created.dataset)
      setError(null)
      await loadLatest(kind)
      return created.dataset
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [loadLatest])

  const clearError = useCallback(() => setError(null), [])

  return { current, history, busy, error, actions: { loadLatest, importRows, clearError } }
}
