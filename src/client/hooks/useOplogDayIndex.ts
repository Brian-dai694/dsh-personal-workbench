/**
 * 运营日志 × 日历：**每天有几条日志**的唯一所有者。
 *
 * ## 为什么需要它
 * 日历格子要显示「这天写过运营日志」的标记，而 D17 结构硬门规定视图不许发 HTTP
 * （`CalendarView` 是纯渲染）。所以这份数据必须由一个 hook 拉取、经装配层注入。
 *
 * ## 边界
 * - 只读一个极小的索引（日期 + 条数），不拉日志正文/图片/附件 —— 那些是运营日志
 *   自己的列表页才需要的东西，日历只画点。
 * - 失败**不抛给用户**：日历少一个装饰点不影响任何既有功能，静默留空即可；
 *   真正的日志读取错误在运营日志页自身显示。
 * - 刷新时机由调用方决定（`refresh()`）：日志新建/编辑/删除后调用一次，
 *   切到日历不会看到过期索引。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

interface OplogDayIndexEntry { date: string; count: number }

export interface UseOplogDayIndexActions {
  /** 重新拉取索引（日志写操作成功后调用）。失败静默，保留上一次结果。 */
  refresh: () => Promise<void>
}

export interface UseOplogDayIndexResult {
  /** 有日志的日期 → 条数。日历渲染时按本地日期键查表。 */
  counts: Map<string, number>
  /** 有日志的日期列表（含重复日期，每次出现一次），直接喂给 CalendarView。 */
  dates: string[]
  actions: UseOplogDayIndexActions
}

export function useOplogDayIndex(): UseOplogDayIndexResult {
  const [days, setDays] = useState<OplogDayIndexEntry[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await api<{ days?: OplogDayIndexEntry[] }>('/api/workbench/oplog/days')
      setDays(Array.isArray(data.days) ? data.days : [])
    } catch {
      // 索引是装饰性数据：旧宿主没有这条路由时保持空，日历照常可用。
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const counts = new Map<string, number>()
  const dates: string[] = []
  for (const entry of days) {
    if (typeof entry.date !== 'string' || entry.date === '') continue
    counts.set(entry.date, entry.count)
    for (let i = 0; i < entry.count; i += 1) dates.push(entry.date)
  }
  return { counts, dates, actions: { refresh } }
}
