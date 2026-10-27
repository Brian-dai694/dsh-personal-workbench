/**
 * 关键词库域（客户端）：**已保存方案**的唯一状态所有者。
 *
 * 为什么要有它：视图不许发 HTTP（D17 结构硬门），而「保存 / 载入 / 改名 / 删除 / 解绑 ASIN」
 * 是五条真实请求。生成逻辑（`buildKeywordPlan`）是纯函数、留在视图侧；
 * 这里只管**持久化**，两者职责不重叠。
 *
 * 失败口径：所有动作都把原因写进 `error` 并把结果返回 `null`/`false`，
 * 不抛给调用方 —— 视图只需"看结果 + 显示 error"，不会因为一次 404 把整页打挂。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { KeywordPlan, KeywordPlanSummary } from '../../db/repo/keywordPlans.js'
import type { KeywordMatch } from '../../shared/amazonKeywordTools.js'

export interface SaveKeywordPlanInput {
  title: string
  seed: string
  modifiers: string[]
  matchTypes: KeywordMatch[]
  negatives: string[]
  rows: Array<{ keyword: string; match: KeywordMatch; campaign: string; rationale: string }>
  asin: string | null
}

export interface UseKeywordPlansActions {
  refresh: () => Promise<void>
  /** 保存新方案；失败返回 null（原因写进 error）。 */
  save: (input: SaveKeywordPlanInput) => Promise<KeywordPlan | null>
  /** 载入一份方案全文（选中态）。 */
  open: (id: string) => Promise<KeywordPlan | null>
  /** 局部更新（改名 / 改否定词 / 改 ASIN 关联）。 */
  patch: (id: string, patch: Partial<SaveKeywordPlanInput> & { note?: string }) => Promise<KeywordPlan | null>
  remove: (id: string) => Promise<boolean>
  /**
   * 把方案导出成本机 CSV（服务端按库里行生成 → 写到 `~/.dsh/workbench/exports/`）。
   *
   * 为什么不在浏览器里做下载：客户端有结构硬门（不许自建 `<a>`、不许 `location.*`），
   * 而且"导出的内容"应当等于"库里的方案"，让服务端重新生成才不会有第二份真相。
   */
  exportCsv: (id: string) => Promise<{ path: string; rows: number } | null>
  /** 用系统默认程序打开刚导出的文件（复用知识库的 open-file 路由）。 */
  openExportedFile: (path: string) => Promise<boolean>
  clearError: () => void
}

export interface UseKeywordPlansResult {
  plans: KeywordPlanSummary[]
  current: KeywordPlan | null
  busy: boolean
  error: string | null
  actions: UseKeywordPlansActions
}

export function useKeywordPlans(): UseKeywordPlansResult {
  const [plans, setPlans] = useState<KeywordPlanSummary[]>([])
  const [current, setCurrent] = useState<KeywordPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await api<{ plans: KeywordPlanSummary[] }>('/api/workbench/keyword-plans')
      if (!alive.current) return
      setPlans(Array.isArray(res.plans) ? res.plans : [])
      setError(null)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const open = useCallback(async (id: string): Promise<KeywordPlan | null> => {
    try {
      const res = await api<{ plan: KeywordPlan }>(`/api/workbench/keyword-plans/${encodeURIComponent(id)}`)
      if (!alive.current) return null
      setCurrent(res.plan)
      setError(null)
      return res.plan
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  const save = useCallback(async (input: SaveKeywordPlanInput): Promise<KeywordPlan | null> => {
    setBusy(true)
    try {
      const res = await api<{ plan: KeywordPlan }>('/api/workbench/keyword-plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!alive.current) return null
      setCurrent(res.plan)
      setError(null)
      await refresh()
      return res.plan
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const patch = useCallback(async (id: string, patchBody: Partial<SaveKeywordPlanInput> & { note?: string }): Promise<KeywordPlan | null> => {
    setBusy(true)
    try {
      const res = await api<{ plan: KeywordPlan }>(`/api/workbench/keyword-plans/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patchBody),
      })
      if (!alive.current) return null
      setCurrent((prev) => (prev?.id === res.plan.id ? res.plan : prev))
      setError(null)
      await refresh()
      return res.plan
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setBusy(true)
    try {
      await api(`/api/workbench/keyword-plans/${encodeURIComponent(id)}`, { method: 'DELETE' })
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

  const exportCsv = useCallback(async (id: string): Promise<{ path: string; rows: number } | null> => {
    setBusy(true)
    try {
      const res = await api<{ path: string; rows: number }>(`/api/workbench/keyword-plans/${encodeURIComponent(id)}/export`, { method: 'POST' })
      if (alive.current) setError(null)
      return { path: res.path, rows: res.rows }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  const openExportedFile = useCallback(async (path: string): Promise<boolean> => {
    try {
      await api('/api/workbench/knowledge/open-file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      return true
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return { plans, current, busy, error, actions: { refresh, save, open, patch, remove, exportCsv, openExportedFile, clearError } }
}
