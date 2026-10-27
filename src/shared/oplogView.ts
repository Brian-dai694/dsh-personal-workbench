/**
 * 运营日志的展示口径（纯函数，便于测试）。
 *
 * 三项都来自旧应用「亚马逊运营日志 V5」，但在工作台里**只保留口径、不搬样式**：
 * 1. 类型配色：旧应用按类型顺序套一个 8 色调色板（`defaultColors`），这里固定同一组，
 *    保证迁移后同一类型的颜色与旧应用一致；
 * 2. KPI：本周 / 本月 / 本年 / 总计（旧应用四个卡片的原始口径）；
 * 3. 日期分组：今天 / 昨天 / 本周 / 本月 / 更早。
 */

/** 旧应用的 8 色调色板（顺序即类型顺序，不要重排，否则迁移后颜色会变）。 */
export const OPLOG_TYPE_COLORS = [
  '#007bff', '#28a745', '#dc3545', '#ffc107',
  '#17a2b8', '#6f42c1', '#fd7e14', '#6c757d',
] as const

/** 已知类型沿用旧应用顺序；未知类型按名称稳定散列到同一调色板。 */
export function colorForType(type: string, knownOrder: readonly string[] = []): string {
  const index = knownOrder.indexOf(type)
  if (index >= 0) return OPLOG_TYPE_COLORS[index % OPLOG_TYPE_COLORS.length]
  let hash = 0
  for (let i = 0; i < type.length; i += 1) hash = (hash * 31 + type.charCodeAt(i)) >>> 0
  return OPLOG_TYPE_COLORS[hash % OPLOG_TYPE_COLORS.length]
}

export interface OplogKpi {
  week: number
  month: number
  year: number
  total: number
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** 周一为一周起点（与工作台「本周」口径一致）。 */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d)
  const offset = (day.getDay() + 6) % 7
  day.setDate(day.getDate() - offset)
  return day
}

export function oplogKpi(dates: readonly string[], now: Date = new Date()): OplogKpi {
  const weekStart = startOfWeek(now).getTime()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime()
  let week = 0
  let month = 0
  let year = 0
  for (const iso of dates) {
    const t = Date.parse(iso)
    if (Number.isNaN(t)) continue
    if (t >= weekStart) week += 1
    if (t >= monthStart) month += 1
    if (t >= yearStart) year += 1
  }
  return { week, month, year, total: dates.length }
}

export type OplogGroupKey = 'today' | 'yesterday' | 'week' | 'month' | 'earlier'

export const OPLOG_GROUP_LABELS: Record<OplogGroupKey, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周更早',
  month: '本月更早',
  earlier: '更早',
}

/** 按业务日期（YYYY-MM-DD）落组；未提供时兼容旧记录 createdAt。 */
export function groupOf(iso: string, now: Date = new Date()): OplogGroupKey {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso)
  const today = startOfDay(now).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  const ts = startOfDay(t).getTime()
  if (ts >= today) return 'today'
  if (ts >= today - dayMs) return 'yesterday'
  if (ts >= startOfWeek(now).getTime()) return 'week'
  if (ts >= new Date(now.getFullYear(), now.getMonth(), 1).getTime()) return 'month'
  return 'earlier'
}

export function groupEntries<T extends { createdAt: string; logDate?: string }>(entries: readonly T[], now: Date = new Date()): Array<{ key: OplogGroupKey; label: string; items: T[] }> {
  const order: OplogGroupKey[] = ['today', 'yesterday', 'week', 'month', 'earlier']
  const buckets = new Map<OplogGroupKey, T[]>()
  for (const entry of entries) {
    const key = groupOf(entry.logDate ?? entry.createdAt, now)
    const list = buckets.get(key) ?? []
    list.push(entry)
    buckets.set(key, list)
  }
  return order
    .filter((key) => (buckets.get(key)?.length ?? 0) > 0)
    .map((key) => ({ key, label: OPLOG_GROUP_LABELS[key], items: buckets.get(key) ?? [] }))
}
