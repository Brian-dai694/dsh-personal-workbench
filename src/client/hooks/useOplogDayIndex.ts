/**
 * 运营日志 × 工作台：**日历标记 + 今日摘要**的唯一所有者。
 *
 * ## 为什么需要它
 * 日历格子要显示「这天写过运营日志」的标记，仪表盘要显示「本周/本月条数、最近几条、
 * 今天的任务有没有待归档的日志」—— 而 D17 结构硬门规定视图不许发 HTTP
 * （`CalendarView` / `DashboardPane` 都是纯渲染）。所以这份数据必须由一个 hook 拉取、
 * 经装配层注入。
 *
 * ## 边界
 * - 只拉**索引级**数据：日期+条数、最近 5 条的「日期+标题」、待归档**条数**。
 *   日志正文/图片/附件仍只在运营日志页自己拉 —— 仪表盘不需要，拉了就是浪费。
 * - 失败**不抛给用户**：日历少一个装饰点、仪表盘少一张卡，都不影响主流程；
 *   真正的日志读取错误在运营日志页自身显示。
 * - 刷新时机由调用方决定（`refresh()`）：日志新建/编辑/删除后调用一次。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

interface OplogDayIndexEntry { date: string; count: number }

/** 最近一条日志的最小投影（仪表盘「最近动态」用）。 */
export interface OplogRecentEntry { date: string; title: string }

/** 本周 / 本月 / 累计条数 —— 与运营日志页顶部那张 KPI 同源（都来自 `/oplog`）。 */
export interface OplogKpi { week: number; month: number; year: number; total: number }

const EMPTY_KPI: OplogKpi = { week: 0, month: 0, year: 0, total: 0 }

export interface UseOplogDayIndexActions {
  /** 重新拉取索引与摘要（日志写操作成功后调用）。失败静默，保留上一次结果。 */
  refresh: () => Promise<void>
}

export interface UseOplogDayIndexResult {
  /** 有日志的日期 → 条数。日历渲染时按本地日期键查表。 */
  counts: Map<string, number>
  /** 有日志的日期列表（含重复日期，每次出现一次），直接喂给 CalendarView。 */
  dates: string[]
  /** 本周 / 本月 / 累计条数。 */
  kpi: OplogKpi
  /** 最近 5 条（只含日期与标题）。 */
  recent: OplogRecentEntry[]
  /**
   * 今天完成、但还没写进任何日志的任务数（`oplog/completion-candidates`）。
   * 仪表盘「待我处理」用；为 0 时整项不渲染。
   */
  pendingArchive: number
  actions: UseOplogDayIndexActions
}

export function useOplogDayIndex(): UseOplogDayIndexResult {
  const [days, setDays] = useState<OplogDayIndexEntry[]>([])
  const [kpi, setKpi] = useState<OplogKpi>(EMPTY_KPI)
  const [recent, setRecent] = useState<OplogRecentEntry[]>([])
  const [pendingArchive, setPendingArchive] = useState(0)

  const refresh = useCallback(async (): Promise<void> => {
    /**
     * 三个请求并发，**每个都独立降级**：任何一个失败都不该把另外两个拖下水
     * （旧宿主可能还没有 `completion-candidates` 这条路由）。
     */
    const [daysRes, listRes, candRes] = await Promise.all([
      api<{ days?: OplogDayIndexEntry[] }>('/api/workbench/oplog/days').catch(() => null),
      api<{ kpi?: OplogKpi; entries?: Array<{ logDate?: string; title?: string }> }>('/api/workbench/oplog?limit=5').catch(() => null),
      api<{ candidates?: unknown[] }>('/api/workbench/oplog/completion-candidates').catch(() => null),
    ])

    if (daysRes !== null) setDays(Array.isArray(daysRes.days) ? daysRes.days : [])
    if (listRes !== null) {
      setKpi(listRes.kpi ?? EMPTY_KPI)
      setRecent((listRes.entries ?? []).flatMap((entry) => (
        typeof entry.title === 'string' && entry.title !== ''
          ? [{ date: typeof entry.logDate === 'string' ? entry.logDate : '', title: entry.title }]
          : []
      )))
    }
    if (candRes !== null && Array.isArray(candRes.candidates)) setPendingArchive(candRes.candidates.length)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const counts = new Map<string, number>()
  const dates: string[] = []
  for (const entry of days) {
    if (typeof entry.date !== 'string' || entry.date === '') continue
    counts.set(entry.date, entry.count)
    for (let i = 0; i < entry.count; i += 1) dates.push(entry.date)
  }
  return { counts, dates, kpi, recent, pendingArchive, actions: { refresh } }
}
