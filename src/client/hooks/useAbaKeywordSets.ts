/**
 * ABA 词表域（客户端 T3）：**已保存词表**的唯一状态所有者。
 *
 * 为什么要有它：视图不许发 HTTP（D17 结构硬门），而 ABA 面板原来自己在视图里
 * 发了 7 条请求（列表 / 详情 / 保存 / 打开 / 导出 / 删除 / 自动打开最近一份）。
 * 本 hook 逐条接管，**没有改任何请求形状与参数** —— 只是把调用点从视图挪出来，
 * 所以行为（自动打开最近一份、详情失败不挡列表、删除后回到空态）全部保持原样。
 *
 * 与 `useAmazonDatasets` 的分工：那边管**搜索词报表**（数据集），这边管**ABA 市场词表**。
 * ABA 面板要对照的那份搜索词数据从 `model.current` 读，不在这里再拉一份。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { AbaAnnotation, AbaKeywordRow } from '../../shared/abaKeywordTable.js'

export interface AbaSetSummary {
  id: string
  title: string
  period: string | null
  rowCount: number
  annotationCount: number
  updatedAt: string
}

export interface AbaSet extends AbaSetSummary {
  rows: AbaKeywordRow[]
  annotations: AbaAnnotation[]
}

export interface SaveAbaSetInput {
  title: string
  rows: AbaKeywordRow[]
  sourceCode?: string
}

export interface AbaExportResult {
  path: string
  rows: number
  dataset: string | null
}

export interface UseAbaKeywordSetsActions {
  /** 重新拉列表（保存 / 删除之后）。 */
  refresh: () => Promise<void>
  /** 保存一份新词表，并把它设为当前；失败返回 null（原因写进 error）。 */
  save: (input: SaveAbaSetInput) => Promise<AbaSet | null>
  /** 打开一份词表（含行与回填批注）。 */
  open: (id: string) => Promise<AbaSet | null>
  /** 导出「规则 vs 回填 vs 我们的表现」对照 CSV（服务端写文件）。 */
  exportComparison: (id: string) => Promise<AbaExportResult | null>
  remove: (id: string) => Promise<boolean>
  clearError: () => void
}

export interface UseAbaKeywordSetsResult {
  sets: AbaSetSummary[]
  current: AbaSet | null
  busy: boolean
  error: string | null
  actions: UseAbaKeywordSetsActions
}

export function useAbaKeywordSets(): UseAbaKeywordSetsResult {
  const [sets, setSets] = useState<AbaSetSummary[]>([])
  const [current, setCurrent] = useState<AbaSet | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await api<{ sets: AbaSetSummary[] }>('/api/workbench/aba-keywords')
      if (!alive.current) return
      setSets(Array.isArray(data.sets) ? data.sets : [])
      setError(null)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /**
   * 首次装载：拉列表并**自动打开最近一份**。
   *
   * 不自动打开的话，保存过的词表在重新进页面后仍是一片空白（要用户先点列表里的名字），
   * 看起来就像"什么都没存下来"。详情失败只影响"自动打开"这一半，列表照常显示。
   */
  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ sets: AbaSetSummary[] }>('/api/workbench/aba-keywords')
        if (!alive.current) return
        const list = Array.isArray(data.sets) ? data.sets : []
        setSets(list)
        const first = list[0]
        if (first === undefined) return
        try {
          const detail = await api<{ set: AbaSet }>(`/api/workbench/aba-keywords/${encodeURIComponent(first.id)}`)
          if (!alive.current) return
          setCurrent(detail.set)
        } catch { /* 自动打开失败不影响列表 */ }
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  const save = useCallback(async (input: SaveAbaSetInput): Promise<AbaSet | null> => {
    setBusy(true)
    try {
      const data = await api<{ set: AbaSet }>('/api/workbench/aba-keywords', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: input.title, rows: input.rows, sourceCode: input.sourceCode ?? 'import' }),
      })
      if (!alive.current) return null
      setCurrent(data.set)
      setError(null)
      await refresh()
      return data.set
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const open = useCallback(async (id: string): Promise<AbaSet | null> => {
    setBusy(true)
    try {
      const data = await api<{ set: AbaSet }>(`/api/workbench/aba-keywords/${encodeURIComponent(id)}`)
      if (!alive.current) return null
      setCurrent(data.set)
      setError(null)
      return data.set
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  const exportComparison = useCallback(async (id: string): Promise<AbaExportResult | null> => {
    setBusy(true)
    try {
      const data = await api<AbaExportResult>(`/api/workbench/aba-keywords/${encodeURIComponent(id)}/export`, { method: 'POST' })
      if (alive.current) setError(null)
      return { path: data.path, rows: data.rows, dataset: data.dataset }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setBusy(true)
    try {
      await api(`/api/workbench/aba-keywords/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!alive.current) return true
      setCurrent((prev) => (prev?.id === id ? null : prev))
      setError(null)
      await refresh()
      return true
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const clearError = useCallback(() => setError(null), [])

  return {
    sets,
    current,
    busy,
    error,
    actions: { refresh, save, open, exportComparison, remove, clearError },
  }
}
