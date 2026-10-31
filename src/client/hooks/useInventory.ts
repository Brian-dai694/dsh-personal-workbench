/**
 * 库存补货看板域（2026-10-27 批次 8）—— 原先**整块**在 `views/InventoryView.tsx` 里。
 *
 * ## 为什么搬出来
 *
 * D17 的结构硬门是「视图不许发 HTTP」，而 InventoryView 原先自己发两条
 * （`GET /api/workbench/inventory`、`POST /api/workbench/inventory`），
 * 顺带把"谁负责重拉、失败怎么提示、清哪个 state"也揽在 JSX 里。
 * 结果就是：这份数据没有任何别的消费方，但它也不是一个可复用的域 ——
 * 换一个视图想读库存，只能把 HTTP 再写一遍。
 *
 * ## 搬的时候刻意保持的三件事
 *
 * 1. **行为逐字不变**：仍是「进入视图才拉一次」、仍是 `ingest` 成功后才清空文本框、
 *    仍是 `warn`/`ok`/`error` 三档状态行。
 * 2. **结论不落库**：`analysis` 是 `useMemo` 现算的派生值，参数一改即时重算 ——
 *    这正是"不存结论、隔天不会看到过期断货日"那条设计。
 * 3. **文案不进 hook**：本文件不碰 i18n，所有用户可见文字仍由视图用 `t()` 给。
 *
 * ⚠️ 依赖方向（设计 §3）：纯 `.ts`，只 import 纯模块与共享契约，**不得** import `index.tsx`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { parseUploadFile } from '../parseUpload.js'
import { analyseInventory, inventoryToCsv, parseInventoryCsv } from '../../shared/inventoryForecast.js'
import type { InventoryRow } from '../../shared/inventoryForecast.js'

/** 一份完整盘点（含行数据）：`GET /inventory` 的 `latest` 与 `POST` 的 `snapshot`。 */
export interface InventorySnapshot {
  id: string
  title: string
  countedAt: string
  windowDays: number
  leadTimeDays: number
  safetyDays: number
  rows: InventoryRow[]
}

/** 历史列表里的一条（不含行数据，只够画"最近一次"提示）。 */
export interface InventorySummary {
  id: string
  title: string
  countedAt: string
  windowDays: number
  rowCount: number
}

/** 三档状态行（与拆分前逐字一致：`ok` / `warn` / `error`，`null` = 不显示）。 */
export type InventoryStatus = { level: 'ok' | 'warn' | 'error'; lines: string[] } | null

/** 「今天」：与原视图同口径（模块级常量，避免每次渲染漂移）。 */
const TODAY = new Date().toISOString().slice(0, 10)

export interface UseInventoryInput {
  /**
   * 当前视图。**只在进入 `inventory` 时拉一次** —— 与拆分前"视图挂载时拉"同一时机，
   * 但不会在面板一打开就为没看过的页发请求。
   */
  activeView: string
}

export interface UseInventoryActions {
  setWindowDays: (value: number) => void
  setCountedAt: (value: string) => void
  setLeadTimeDays: (value: number) => void
  setSafetyDays: (value: number) => void
  /** 重新拉最近一次盘点（页面进入时自动调用；也可手动触发）。 */
  loadLatest: () => Promise<void>
  /** 解析并保存一段表格文本（纯文本入口：手写/程序拼出来的行）。 */
  ingest: (raw: string) => Promise<void>
  /**
   * 选文件 → 读成文本 → 交给 `ingest`。
   *
   * 为什么必须在 hook 里：读二进制要经 `/parse-file`（视图不许发 HTTP，D17）。
   * 顺带把 `.xlsx` 变成可用 —— 旧实现用 `file.text()`，Excel 进来就是乱码。
   */
  ingestFile: (file: File) => Promise<void>
  /** 把补货清单复制到剪贴板（人工确认用，不写任何平台）。 */
  copyCsv: () => Promise<void>
}

export interface UseInventoryResult {
  /** 最近一次盘点（含行）；`null` = 还没导入过。 */
  snapshot: InventorySnapshot | null
  /** 历史摘要（最新的在前）。 */
  history: InventorySummary[]
  /** 按当前参数现算的结论；`null` = 没有盘点可算。**不落库**。 */
  analysis: ReturnType<typeof analyseInventory> | null
  windowDays: number
  countedAt: string
  leadTimeDays: number
  safetyDays: number
  status: InventoryStatus
  busy: boolean
  actions: UseInventoryActions
}

export function useInventory(input: UseInventoryInput): UseInventoryResult {
  const { activeView } = input

  const [status, setStatus] = useState<InventoryStatus>(null)
  const [busy, setBusy] = useState(false)
  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null)
  const [history, setHistory] = useState<InventorySummary[]>([])
  const [windowDays, setWindowDays] = useState(30)
  const [countedAt, setCountedAt] = useState(TODAY)
  const [leadTimeDays, setLeadTimeDays] = useState(30)
  const [safetyDays, setSafetyDays] = useState(15)

  const loadLatest = useCallback(async (): Promise<void> => {
    try {
      const data = await api<{ latest: InventorySnapshot | null; snapshots: InventorySummary[] }>('/api/workbench/inventory')
      setHistory(data.snapshots ?? [])
      setSnapshot(data.latest ?? null)
      if (data.latest !== null) {
        setWindowDays(data.latest.windowDays)
        setCountedAt(data.latest.countedAt.slice(0, 10))
        setLeadTimeDays(data.latest.leadTimeDays)
        setSafetyDays(data.latest.safetyDays)
      }
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    }
  }, [])

  useEffect(() => {
    if (activeView === 'inventory') void loadLatest()
  }, [activeView, loadLatest])

  const analysis = useMemo(() => {
    if (snapshot === null) return null
    return analyseInventory(snapshot.rows, {
      windowDays,
      countedAt,
      leadTimeDays,
      safetyDays,
      today: new Date(`${TODAY}T00:00:00Z`),
    })
  }, [snapshot, windowDays, countedAt, leadTimeDays, safetyDays])

  const ingest = useCallback(async (raw: string): Promise<void> => {
    const parsed = parseInventoryCsv(raw)
    if (!parsed.ok) {
      setStatus({ level: 'error', lines: [`导入未通过：${parsed.errors.join('；')}`] })
      return
    }
    if (parsed.windowDays !== null) setWindowDays(parsed.windowDays)
    if (parsed.countedAt !== null) setCountedAt(parsed.countedAt)
    setBusy(true)
    try {
      const created = await api<{ snapshot: InventorySnapshot; snapshots: InventorySummary[] }>('/api/workbench/inventory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `库存盘点 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          countedAt: parsed.countedAt ?? countedAt,
          windowDays: parsed.windowDays ?? windowDays,
          leadTimeDays,
          safetyDays,
          rows: parsed.rows,
        }),
      })
      setSnapshot(created.snapshot)
      setHistory(created.snapshots ?? [])
      const lines = [`已保存 ${parsed.rows.length} 个 SKU 的盘点`]
      if (parsed.warnings.length > 0) lines.push(parsed.warnings.join('；'))
      setStatus({ level: parsed.warnings.length > 0 ? 'warn' : 'ok', lines })
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    } finally {
      setBusy(false)
    }
  }, [countedAt, leadTimeDays, safetyDays, windowDays])

  /**
   * 文件 → 文本 → `ingest`。
   *
   * 忙碌覆盖"读文件 + 解析 + 提交"整段：`.xlsx` 要先走一次服务端转换，
   * 只把按钮转圈留给后半段会让用户以为文件没被接住。
   */
  const ingestFile = useCallback(async (file: File): Promise<void> => {
    setBusy(true)
    try {
      const parsed = await parseUploadFile(file)
      await ingest(parsed.text)
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    } finally {
      setBusy(false)
    }
  }, [ingest])

  const copyCsv = useCallback(async (): Promise<void> => {
    if (analysis === null) return
    try {
      await navigator.clipboard.writeText(inventoryToCsv(analysis.rows))
      setStatus({ level: 'ok', lines: [`已复制 ${analysis.rows.length} 行补货清单（人工确认用，不写任何平台）`] })
    } catch (error) {
      setStatus({ level: 'error', lines: [`复制失败：${error instanceof Error ? error.message : String(error)}`] })
    }
  }, [analysis])

  return {
    snapshot, history, analysis,
    windowDays, countedAt, leadTimeDays, safetyDays,
    status, busy,
    actions: { setWindowDays, setCountedAt, setLeadTimeDays, setSafetyDays, loadLatest, ingest, ingestFile, copyCsv },
  }
}
