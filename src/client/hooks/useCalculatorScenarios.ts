/**
 * 测算方案域（客户端）：已保存方案 + 对比选择的唯一状态所有者。
 *
 * 视图不发 HTTP（D17 结构硬门）；本 hook 只管持久化与"选中哪几列对比"，
 * **不算数** —— 数学只在 `client/amazonCalculator.ts`（结论一律现算）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { CalculatorScenario } from '../../db/repo/calculatorScenarios.js'
import type { CalculatorInputRecord } from '../../shared/calculatorScenario.js'

export interface SaveCalculatorScenarioInput {
  name: string
  input: CalculatorInputRecord
  note?: string
  asin?: string | null
  /** true = 同名覆盖（界面在收到 409 后由用户确认再调）。 */
  replace?: boolean
}

export interface UseCalculatorScenariosActions {
  refresh: () => Promise<void>
  /** 保存；同名且未确认覆盖时返回 `{ conflict: true }`，由界面提示。 */
  save: (input: SaveCalculatorScenarioInput) => Promise<{ scenario: CalculatorScenario | null; conflictId: string | null }>
  patch: (id: string, patch: Partial<SaveCalculatorScenarioInput>) => Promise<CalculatorScenario | null>
  remove: (id: string) => Promise<boolean>
  toggleCompare: (id: string) => void
  clearCompare: () => void
  clearError: () => void
}

export interface UseCalculatorScenariosResult {
  scenarios: CalculatorScenario[]
  /** 参与对比的方案 id（按点选顺序；最多 4 个）。 */
  compareIds: string[]
  busy: boolean
  error: string | null
  actions: UseCalculatorScenariosActions
}

/** 对比最多四列：再多表就横向滚到看不清，且没有决策价值。 */
export const MAX_COMPARE = 4

export function useCalculatorScenarios(): UseCalculatorScenariosResult {
  const [scenarios, setScenarios] = useState<CalculatorScenario[]>([])
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await api<{ scenarios: CalculatorScenario[] }>('/api/workbench/calculator-scenarios')
      if (!alive.current) return
      const list = Array.isArray(res.scenarios) ? res.scenarios : []
      setScenarios(list)
      /** 已被删除的方案不能继续留在对比里（否则对比表出现空白列）。 */
      setCompareIds((prev) => prev.filter((id) => list.some((item) => item.id === id)))
      setError(null)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const save = useCallback(async (input: SaveCalculatorScenarioInput): Promise<{ scenario: CalculatorScenario | null; conflictId: string | null }> => {
    setBusy(true)
    try {
      const res = await api<{ scenario: CalculatorScenario }>('/api/workbench/calculator-scenarios', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!alive.current) return { scenario: null, conflictId: null }
      setError(null)
      await refresh()
      return { scenario: res.scenario, conflictId: null }
    } catch (e) {
      if (!alive.current) return { scenario: null, conflictId: null }
      const message = e instanceof Error ? e.message : String(e)
      /**
       * 409 冲突不是"错误"，是"需要用户决定"：把已有 id 带回去，
       * 界面提示「已存在同名方案，要覆盖吗」，用户确认后再带 `replace: true` 调一次。
       */
      const conflict = /409/.exec(message)
      if (conflict !== null) {
        try {
          const list = await api<{ scenarios: CalculatorScenario[] }>('/api/workbench/calculator-scenarios')
          const existing = list.scenarios.find((item) => item.name === input.name.trim())
          if (existing !== undefined) return { scenario: null, conflictId: existing.id }
        } catch { /* 拿不到就不提示覆盖，交给用户改名 */ }
      }
      setError(message)
      return { scenario: null, conflictId: null }
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const patch = useCallback(async (id: string, patchBody: Partial<SaveCalculatorScenarioInput>): Promise<CalculatorScenario | null> => {
    setBusy(true)
    try {
      const res = await api<{ scenario: CalculatorScenario }>(`/api/workbench/calculator-scenarios/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patchBody),
      })
      if (!alive.current) return null
      setError(null)
      await refresh()
      return res.scenario
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
      await api(`/api/workbench/calculator-scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!alive.current) return true
      setCompareIds((prev) => prev.filter((item) => item !== id))
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

  const toggleCompare = useCallback((id: string): void => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id)
      if (prev.length >= MAX_COMPARE) return prev
      return [...prev, id]
    })
  }, [])

  const clearCompare = useCallback(() => setCompareIds([]), [])
  const clearError = useCallback(() => setError(null), [])

  useEffect(() => { void refresh() }, [refresh])

  return { scenarios, compareIds, busy, error, actions: { refresh, save, patch, remove, toggleCompare, clearCompare, clearError } }
}
