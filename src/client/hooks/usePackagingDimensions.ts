import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { PackagingDimensionData, PackagingDimensionRecord } from '../../shared/packagingDimensions.js'

const PATH = '/api/workbench/amazon/packaging-dimensions'

export interface PackagingSaveResult {
  ok: boolean
  /** 保存成功时库里的条数（界面据此说"共 N 条"，不靠猜）。 */
  total: number
}

export interface UsePackagingDimensionsResult {
  records: PackagingDimensionRecord[]
  busy: boolean
  error: string | null
  save: (name: string, sku: string, data: PackagingDimensionData, id?: string) => Promise<PackagingSaveResult>
  remove: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

export function usePackagingDimensions(): UsePackagingDimensionsResult {
  const [records, setRecords] = useState<PackagingDimensionRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  /**
   * 写入后要靠**返回值**说"共 N 条"：`records` state 在同一个闭包里还是旧值，
   * 拿它算条数会算出"保存成功但显示 0 条"。
   */
  const load = useCallback(async (): Promise<PackagingDimensionRecord[]> => {
    const result = await api<{ records: PackagingDimensionRecord[] }>(PATH)
    const list = Array.isArray(result.records) ? result.records : []
    if (alive.current) { setRecords(list); setError(null) }
    return list
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try { await load() } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [load])

  useEffect(() => {
    /** 重挂载时必须复位：否则一次 effect 清理之后，列表永远不再更新（保存成功却一直显示 0 条）。 */
    alive.current = true
    void refresh()
    return () => { alive.current = false }
  }, [refresh])

  const save = useCallback(async (name: string, sku: string, data: PackagingDimensionData, id?: string): Promise<PackagingSaveResult> => {
    setBusy(true)
    try {
      await api(id === undefined ? PATH : `${PATH}/${encodeURIComponent(id)}`, {
        method: id === undefined ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, sku, data }),
      })
      const list = await load()
      return { ok: true, total: list.length }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
      return { ok: false, total: 0 }
    } finally { if (alive.current) setBusy(false) }
  }, [load])

  const remove = useCallback(async (id: string) => {
    setBusy(true)
    try { await api(`${PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load() } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (alive.current) setBusy(false) }
  }, [load])

  return { records, busy, error, save, remove, refresh }
}
