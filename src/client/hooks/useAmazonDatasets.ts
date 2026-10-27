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
import type { AmazonDatasetKind, AmazonDatasetRow, AmazonDatasetSummary } from '../../db/repo/amazonDatasets.js'
import type { TrafficRow } from '../../shared/amazonTrafficTools.js'
import { buildLocalAdvice } from '../trafficAdvice.js'
import { buildAbaLookup, type AbaLookupEntry } from '../trafficAbaJoin.js'
import type { AbaAnnotation, AbaKeywordRow } from '../../shared/abaKeywordTable.js'

export interface ImportDatasetInput {
  title: string
  period: string | null
  rows: TrafficRow[]
  sourceCode?: string
  /**
   * 报表类型。搜索词页不传（服务端默认 search_term，与列表查询口径一致）；
   * 报表分析页的其余类型走各自的 hook，不经过这里 —— 避免覆盖本 hook 的 current。
   */
  kindCode?: AmazonDatasetKind
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
  /**
   * 用**本地规则**给当前数据集生成建议（离线，不需要 AI 会话），写回后刷新。
   *
   * 放在 hook 而不是视图：视图不许发 HTTP（D17 结构硬门），
   * 而这条链路要 PATCH 数据集、再把新建议读回来。
   */
  generateLocalAdvice: (options?: { limit?: number; thresholds?: { wasteMinClicks: number; goodAcos: number } }) => Promise<number>
  /**
   * 选中一个词（「当前词」）。
   *
   * 这轮只做状态：流量分析 / 关键词 / 报表分析三页读同一个值，但**不接跳转**
   * （跨页定位留给 T5）。传空串等价于清空。
   */
  setCurrentKeyword: (keyword: string | null) => void
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
  /** ABA 词表查表（搜索词 ↔ 市场分层）：视图只读这个结果，不在视图里发请求。 */
  abaLookup: Map<string, AbaLookupEntry>
  abaSource: string
  /**
   * 「当前词」：三页共享的选中项（T3）。
   *
   * 为什么挂在这个域：它和 `current`（当前数据集）是同一件事的两种粒度 ——
   * 先选报表、再选报表里的某个词。分开两个所有者会出现"数据集切了、词还留着上一张表"。
   */
  currentKeyword: string | null
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
  /** 当前词（T3）：只存一个词，不存"来自哪一页"—— 页面归属是 T5 的事。 */
  const [currentKeyword, setCurrentKeywordState] = useState<string | null>(null)
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
          ...(input.kindCode === undefined ? {} : { kindCode: input.kindCode }),
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

  /** 选中/清空当前词。空串归一成 null，避免"有值但空白"这种第三种状态。 */
  const setCurrentKeyword = useCallback((keyword: string | null): void => {
    const next = keyword === null ? '' : keyword.trim()
    setCurrentKeywordState(next === '' ? null : next)
  }, [])

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

  /**
   * 本地规则建议：算（纯函数）→ PATCH 写回 → 重新读回整份数据集。
   *
   * 只覆盖前 `limit` 个词（按花费降序），因为 1,000+ 行的报表里
   * 后面全是 1 次点击的词，给它们写建议只会把界面淹没。
   */
  const generateLocalAdvice = useCallback(async (options: { limit?: number; thresholds?: { wasteMinClicks: number; goodAcos: number } } = {}): Promise<number> => {
    const target = current
    if (target === null) return 0
    setBusy(true)
    setError(null)
    try {
      const advice = buildLocalAdvice(target.rows, { limit: options.limit ?? 200, thresholds: options.thresholds })
      if (advice.length === 0) return 0
      await api(`/api/workbench/amazon/datasets/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviews: advice }),
      })
      await select(target.id)
      return advice.length
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return 0
    } finally {
      setBusy(false)
    }
  }, [current, select])

  /**
   * ABA 词表查表：读已保存的词表（最多 3 份）压成"词 → 市场判断"。
   * 同样放在 hook：视图不许发 HTTP。
   */
  const [abaLookup, setAbaLookup] = useState<Map<string, AbaLookupEntry>>(new Map())
  const [abaSource, setAbaSource] = useState('')
  useEffect(() => {
    void (async () => {
      try {
        const list = await api<{ sets: Array<{ id: string; title: string }> }>('/api/workbench/aba-keywords')
        const sets = list.sets ?? []
        if (sets.length === 0) return
        const details = await Promise.all(sets.slice(0, 3).map(async (item) => {
          const detail = await api<{ set: { title: string; rows: AbaKeywordRow[]; annotations: AbaAnnotation[] } }>(`/api/workbench/aba-keywords/${encodeURIComponent(item.id)}`)
          return detail.set
        }))
        setAbaLookup(buildAbaLookup(details.map((set) => ({ title: set.title, rows: set.rows, annotations: set.annotations }))))
        setAbaSource(sets.length === 1 ? sets[0].title : `${sets[0].title} 等 ${sets.length} 份`)
      } catch {
        /** ABA 关联是增强项：读不到就让视图不显示这一列，不影响报表本身。 */
      }
    })()
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return {
    datasets,
    current,
    busy,
    error,
    staleServer,
    updateFailed,
    abaLookup,
    abaSource,
    currentKeyword,
    actions: { refresh, importRows, parseUpload, select, remove, generateLocalAdvice, setCurrentKeyword, clearError },
  }
}
