/**
 * 选品（逆向自「亚马逊选品收藏助手 v3.2.10」）。
 *
 * 搬进来的是**收藏库**这条主线：产品列表 / 价格趋势迷你图 / 分类标签 / 备注 / 店铺。
 * 不搬：页面注入按钮、店铺扫描器、每日自动扫描——它们依赖亚马逊页面上下文，
 * 工作台里没有那个上下文，硬搬等于造假数据。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../api.js'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import { Modal } from '../components/Modal.js'
import { AsinProductForm, AsinStoreForm } from '../components/AsinManualForms.js'
import {
  emptyProductDraft, emptyStoreDraft, productBody, productDraftOf, storeBody, storeDraftOf,
  type AsinProductDraft, type AsinStoreDraft,
} from '../asinManualDraft.js'
import { useAsinLibrary } from '../hooks/useAsinLibrary.js'
import { ASIN_VERDICTS, ASIN_VERDICT_LABELS } from '../../shared/asinJudgment.js'
import type { AsinJudgment, AsinVerdict } from '../../shared/asinJudgment.js'

interface AsinProduct {
  asin: string
  title: string
  currentTitle: string | null
  imageUrl: string | null
  url: string | null
  price: number | null
  rating: number | null
  reviews: number | null
  bsr: number | null
  /** 站点；`null` = 身份未定（needs_site），不得默认 US（P2 合同）。 */
  site: string | null
  identityState?: 'ok' | 'needs_site'
  shopId: string | null
  shopName: string | null
  category: string | null
  note: string | null
  tags: string[]
  watch: boolean
  manualOrder: number | null
  judgment: AsinJudgment
  addedAt: string
  trend: number[]
}

interface AsinStoreRow { id: string; sellerId: string | null; site: string | null; name: string; url: string | null; note: string | null; watch: boolean; lastScannedAt: string | null; productsCount: number; linked: number; watched: number }
interface Facet { value: string; count: number }
interface Facets { categories: Facet[]; shops: Facet[]; tags: Facet[]; verdicts: Facet[]; sites: Facet[]; total: number; watched: number }

const EMPTY: Facets = { categories: [], shops: [], tags: [], verdicts: [], sites: [], total: 0, watched: 0 }

/** 点一下结论就轮转：未判断 → 可做 → 观望 → 放弃 → 未判断。 */
const VERDICT_CYCLE: Record<AsinVerdict, AsinVerdict> = { none: 'do', do: 'watch', watch: 'drop', drop: 'none' }

/** 迷你折线：只画价格序列，无坐标轴（列表里用）。 */
function Sparkline({ values }: { values: number[] }): JSX.Element | null {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const width = 96
  const height = 24
  const points = values.map((v, i) => {
    const x = values.length === 1 ? 0 : (i / (values.length - 1)) * width
    const y = height - ((v - min) / span) * (height - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const down = values[values.length - 1] <= values[0]
  return (
    <svg className="wb-asin-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {/* 走势线的颜色也走令牌（2026-10-28：原先写死墨绿/砖红，是全站最后两处自定色） */}
      <polyline points={points} fill="none" stroke={down ? 'var(--wb-ok)' : 'var(--wb-danger)'} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface AsinViewProps {
  /** 不带身份地打开产品库（页签上的入口）。 */
  onOpenLibrary?: () => void
  /**
   * 带身份地打开产品库（行内入口）：`site + asin` **必须成对**传，
   * 只传 asin 会让落地页在同 ASIN 多站点时搜出两行，看着像定位成功其实要用户再选一次。
   */
  onOpenProducts?: (asin: string, site: string | null) => void
}

export function AsinView({ onOpenLibrary, onOpenProducts }: AsinViewProps): JSX.Element {
  const { t } = useI18n()
  const [products, setProducts] = useState<AsinProduct[]>([])
  const [facets, setFacets] = useState<Facets>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [category, setCategory] = useState('')
  /** 站点筛选（P2）：多站点身份下，不先筛站点就看不清"同一个 ASIN 的两条记录"。 */
  const [site, setSite] = useState('')
  const [shop, setShop] = useState('')
  const [keyword, setKeyword] = useState('')
  const [tag, setTag] = useState('')
  const [watch, setWatch] = useState('all')
  const [verdict, setVerdict] = useState('all')
  const [sort, setSort] = useState('collectedAt')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(50)
  const [total, setTotal] = useState(0)
  const [busyAsin, setBusyAsin] = useState('')
  /** 批量选择的 ASIN（跨页保留：翻页后再回来勾选状态还在，用户不会以为白选了）。 */
  const [picked, setPicked] = useState<Map<string, string | null>>(() => new Map())
  const [batchTag, setBatchTag] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [exportPath, setExportPath] = useState('')
  /** 视图切换：商品库 / 店铺库（同一份数据源，不另开页面）。 */
  const [tab, setTab] = useState<'products' | 'stores'>('products')
  const [stores, setStores] = useState<AsinStoreRow[]>([])
  const [storeBusy, setStoreBusy] = useState('')
  /** 立项弹框的草稿：类型/优先级可改，标题可改（默认「选品立项：商品名」）。 */
  const [taskDraft, setTaskDraft] = useState<{ asin: string; site: string; title: string; typeCode: string; priorityCode: string; dueLocal: string } | null>(null)
  /** 立项可选类型/优先级：来自字典（服务端下发），界面不硬编码 code。 */
  const [typeOptions, setTypeOptions] = useState<Array<{ code: string; name: string }>>([])
  const [priorityOptions, setPriorityOptions] = useState<Array<{ code: string; name: string }>>([])
  /**
   * 手工维护弹框（v1.18）：商品/店铺各一份草稿，`null` = 关着。
   * 保存成败都走 `formError`（不复用列表那条 `error`：否则表单校验失败会显示在背后被遮住）。
   */
  const [productDraft, setProductDraft] = useState<{ mode: 'create' | 'edit'; value: AsinProductDraft } | null>(null)
  /** 店铺的 id 单独带：它是身份，编辑时**不随改名变化**（PATCH 路径要用原 id）。 */
  const [storeDraft, setStoreDraft] = useState<{ mode: 'create' | 'edit'; id: string | null; value: AsinStoreDraft } | null>(null)
  const [formError, setFormError] = useState('')
  /** 写通道在 hook 里（视图不发 HTTP，见 test/viewHttpFence 的棘轮）。 */
  const library = useAsinLibrary()

  /**
   * 写操作的**身份守卫**（P2，2026-10-29）：站点未定就不发请求。
   *
   * 服务端会 400 `site_required`，但在界面这里拦住才能给出可操作的下一步；
   * 直接把 400 文案抛给用户，他并不知道"去哪儿补站点"。
   */
  const identityOf = useCallback((product: AsinProduct): { site: string; asin: string } | null => {
    if (product.site === null || product.site.trim() === '') {
      setError(t('「{asin}」的站点未定（待复核）：先补站点，再操作。', { asin: product.asin }))
      return null
    }
    return { site: product.site, asin: product.asin }
  }, [t])

  /** 409 / 400 的可恢复提示：告诉用户"选站点 / 刷新"，而不是原样抛 message。 */
  const describeWriteError = useCallback((e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.code === 'identity_required') return t('这个 ASIN 在多个站点存在：先按站点筛选，再对该站点操作。')
      if (e.code === 'site_mismatch') return t('站点与记录不一致（可能已被改过）：刷新后重试。')
      if (e.code === 'site_required') return t('缺少站点：写入必须指明站点。')
    }
    return e instanceof Error ? e.message : String(e)
  }, [t])

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (category !== '') params.set('category', category)
    if (site !== '') params.set('site', site)
    if (shop !== '') params.set('shop', shop)
    if (keyword.trim() !== '') params.set('q', keyword.trim())
    if (tag !== '') params.set('tag', tag)
    if (watch !== 'all') params.set('watch', watch)
    if (verdict !== 'all') params.set('verdict', verdict)
    params.set('sort', sort)
    params.set('order', order)
    params.set('page', String(page))
    params.set('size', String(size))
    return params.toString()
  }, [category, site, shop, keyword, tag, watch, verdict, sort, order, page, size])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const data = await api<{ products: AsinProduct[]; total?: number; facets: Facets; stores?: AsinStoreRow[]; taskTypes?: Array<{ code: string; name: string }>; taskPriorities?: Array<{ code: string; name: string }> }>(`/api/workbench/asin${query === '' ? '' : `?${query}`}`)
      setProducts(data.products)
      setTotal(data.total ?? data.products.length)
      setFacets(data.facets)
      setStores(Array.isArray(data.stores) ? data.stores : [])
      setTypeOptions(Array.isArray(data.taskTypes) ? data.taskTypes : [])
      setPriorityOptions(Array.isArray(data.taskPriorities) ? data.taskPriorities : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { void load() }, [load])

  const onImport = useCallback(async (file: File): Promise<void> => {
    setNote('')
    setError('')
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const result = await api<{ inserted: number; snapshots: number; rejected: number; firstReason: string | null }>('/api/workbench/asin/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      })
      setNote(t('已导入 {n} 个 ASIN、{s} 条趋势采样', { n: result.inserted, s: result.snapshots }) + (result.rejected > 0 ? t('，跳过 {m} 条', { m: result.rejected }) : ''))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [load, t])

  const toggleWatch = useCallback(async (product: AsinProduct): Promise<void> => {
    const identity = identityOf(product)
    if (identity === null) return
    setBusyAsin(product.asin)
    setError('')
    try {
      await api(`/api/workbench/asin/${encodeURIComponent(identity.asin)}/watch?site=${encodeURIComponent(identity.site)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watch: !product.watch, site: identity.site }),
      })
      await load()
    } catch (e) {
      setError(describeWriteError(e))
    } finally {
      setBusyAsin('')
    }
  }, [describeWriteError, identityOf, load])

  /** 点结论 chip 轮转判断：只传 verdict，其余判断字段（VOC/评分卡）由服务端沿用原值。 */
  const cycleVerdict = useCallback(async (product: AsinProduct): Promise<void> => {
    const identity = identityOf(product)
    if (identity === null) return
    const next = VERDICT_CYCLE[product.judgment.verdict] ?? 'do'
    setBusyAsin(product.asin)
    setError('')
    try {
      await api(`/api/workbench/asin/${encodeURIComponent(identity.asin)}/judgment?site=${encodeURIComponent(identity.site)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: next, source: 'manual', site: identity.site }),
      })
      await load()
    } catch (e) {
      setError(describeWriteError(e))
    } finally {
      setBusyAsin('')
    }
  }, [describeWriteError, identityOf, load])

  const changeFilter = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLSelectElement>): void => {
    setter(event.target.value)
    setPage(1)
  }

  /** 勾选/取消一个商品：**连站点一起记**（P2 的批量要求 `{site, asin}`）。 */
  const togglePick = useCallback((product: AsinProduct): void => {
    setPicked((prev) => {
      const next = new Map(prev)
      if (next.has(product.asin)) next.delete(product.asin)
      else next.set(product.asin, product.site)
      return next
    })
  }, [])

  /** 全选当前页 / 取消全选当前页（只影响本页，避免误删整库）。 */
  const togglePickPage = useCallback((): void => {
    setPicked((prev) => {
      const allPicked = products.every((product) => prev.has(product.asin))
      const next = new Map(prev)
      for (const product of products) {
        if (allPicked) next.delete(product.asin)
        else next.set(product.asin, product.site)
      }
      return next
    })
  }, [products])

  /**
   * 批量动作：一个请求做完（服务端在事务里执行），失败就整批不生效。
   * 不做乐观更新 —— 批量操作的结果必须来自服务端，否则"看起来已删除、刷新又回来了"。
   */
  const runBatch = useCallback(async (action: 'watch' | 'unwatch' | 'addTag' | 'removeTag' | 'delete'): Promise<void> => {
    if (picked.size === 0) return
    /** 批量必须逐项带站点（P2）：站点未定的先拦住，不许静默跳过或猜一个站点。 */
    const items = [...picked.entries()].map(([asin, site]) => ({ asin, site }))
    const unresolved = items.filter((item) => item.site === null || item.site.trim() === '')
    if (unresolved.length > 0) {
      setError(t('选中的 {n} 个商品站点未定（待复核）：先补站点，再批量操作。', { n: unresolved.length }))
      return
    }
    if (action === 'delete' && !window.confirm(t('删除选中的 {n} 个 ASIN？删除后不可恢复。', { n: picked.size }))) return
    setBatchBusy(true)
    setError('')
    setNote('')
    try {
      const result = await api<{ affected: number; missing: number; tag: string | null }>('/api/workbench/asin/batch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items, action, tag: batchTag }),
      })
      const label = action === 'delete' ? t('删除') : action === 'watch' ? t('设为关注') : action === 'unwatch' ? t('取消关注') : action === 'addTag' ? t('加标签') : t('删标签')
      setNote(t('已{label} {n} 个', { label, n: result.affected }) + (result.missing > 0 ? t('，{m} 个已不存在已跳过', { m: result.missing }) : ''))
      if (action === 'delete') setPicked(new Map())
      await load()
    } catch (e) {
      setError(describeWriteError(e))
    } finally {
      setBatchBusy(false)
    }
  }, [batchTag, describeWriteError, load, picked, t])

  /** 导出：整库或仅选中（服务端写文件并返回真实路径）。选中项同样逐项带站点。 */
  const exportBackup = useCallback(async (onlyPicked: boolean): Promise<void> => {
    setBatchBusy(true)
    setError('')
    setNote('')
    try {
      let query = ''
      if (onlyPicked && picked.size > 0) {
        const items = [...picked.entries()].map(([asin, site]) => ({ asin, site }))
        const unresolved = items.filter((item) => item.site === null || item.site.trim() === '')
        if (unresolved.length > 0) {
          setError(t('选中的 {n} 个商品站点未定（待复核）：先补站点，再导出选中。', { n: unresolved.length }))
          return
        }
        query = `?asins=${encodeURIComponent(JSON.stringify(items))}`
      }
      const result = await api<{ path: string; products: number }>(`/api/workbench/asin/export${query}`)
      setExportPath(result.path)
      setNote(t('已导出 {n} 个 ASIN 到本机', { n: result.products }))
    } catch (e) {
      setError(describeWriteError(e))
    } finally {
      setBatchBusy(false)
    }
  }, [describeWriteError, picked, t])

  /** 关注/取消关注一个店铺（店铺是"扫描记录"，关注只是标记，不影响其商品）。 */
  const toggleStoreWatch = useCallback(async (store: AsinStoreRow): Promise<void> => {
    setStoreBusy(store.id)
    setError('')
    try {
      await api(`/api/workbench/asin/stores/${encodeURIComponent(store.id)}/watch`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watch: !store.watch }),
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStoreBusy('')
    }
  }, [load])

  /** 删除店铺记录。**不删商品** —— 文案里必须说清，否则用户以为商品一起没了。 */
  const removeStore = useCallback(async (store: AsinStoreRow): Promise<void> => {
    if (!window.confirm(t('删除店铺记录「{name}」？只删这条扫描记录，不会删掉它的商品。', { name: store.name }))) return
    setStoreBusy(store.id)
    setError('')
    try {
      await api(`/api/workbench/asin/stores/${encodeURIComponent(store.id)}`, { method: 'DELETE' })
      setNote(t('已删除店铺记录「{name}」（商品保留）', { name: store.name }))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStoreBusy('')
    }
  }, [load, t])

  /** 看这家店的商品：切回商品页并把店铺筛选设成它（复用同一个筛选状态，不另开列表）。 */
  const openStoreProducts = useCallback((store: AsinStoreRow): void => {
    setShop(store.sellerId ?? store.name)
    setTab('products')
    setPage(1)
  }, [])

  /* ------------------------------------------------------------------
   * 手工维护（v1.18）：不依赖旧脚本备份也能建库/改库
   * ------------------------------------------------------------------ */

  const openProductCreate = useCallback((): void => {
    setFormError('')
    setProductDraft({ mode: 'create', value: emptyProductDraft() })
  }, [])

  const openProductEdit = useCallback((product: AsinProduct): void => {
    setFormError('')
    setProductDraft({ mode: 'edit', value: productDraftOf(product) })
  }, [])

  const openStoreCreate = useCallback((): void => {
    setFormError('')
    setStoreDraft({ mode: 'create', id: null, value: emptyStoreDraft() })
  }, [])

  const openStoreEdit = useCallback((store: AsinStoreRow): void => {
    setFormError('')
    setStoreDraft({ mode: 'edit', id: store.id, value: storeDraftOf(store) })
  }, [])

  /**
   * 保存商品：先由 `productBody` 做一次本地转换/校验（数字格式、标签切分），
   * 服务端还会再校验一遍。**不加乐观更新**：成功后重新拉列表，列表才是唯一事实。
   */
  const saveProduct = useCallback(async (): Promise<void> => {
    if (productDraft === null) return
    setFormError('')
    try {
      const body = productBody(productDraft.value, stores)
      if (productDraft.mode === 'create') {
        await library.createProduct(body)
        setNote(t('已添加商品 {asin}', { asin: String(body.asin) }))
      } else {
        await library.updateProduct(productDraft.value.asin, body)
        setNote(t('已保存商品 {asin}', { asin: productDraft.value.asin }))
      }
      setProductDraft(null)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }, [library, load, productDraft, stores, t])

  /** 保存店铺：与商品同一条路径（本地转换 → 服务端校验 → 重新拉列表）。 */
  const saveStore = useCallback(async (): Promise<void> => {
    if (storeDraft === null) return
    setFormError('')
    try {
      const body = storeBody(storeDraft.value)
      if (storeDraft.mode === 'create') {
        await library.createStore(body)
        setNote(t('已添加店铺 {name}', { name: String(body.name) }))
      } else {
        if (storeDraft.id === null) throw new Error('缺少店铺 id，无法保存')
        await library.updateStore(storeDraft.id, body)
        setNote(t('已保存店铺 {name}', { name: String(body.name) }))
      }
      setStoreDraft(null)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }, [library, load, storeDraft, t])

  /**
   * 立项：把这条商品的判断变成一条真实任务。
   *
   * 幂等由服务端保证（同一 ASIN 已有未完成任务就返回 409）。这里**不做**乐观提示：
   * 只有真的拿到 taskId 才说"已立项"，否则用户会以为建了、实际没建。
   */
  /** 打开立项弹框（类型/优先级/标题都在这里确认，避免"隐藏固定参数"）。 */
  /**
   * 按优先级给一个**建议截止**（可改、可清空）。
   *
   * p0 = 今天 18:00，p1 = 三天后 18:00，p2/p3 = 不设（不设 ≠ 没有计划，
   * 只是"还没到排期那一步"，凭空给个日期会污染逾期统计）。
   */
  const suggestDueLocal = useCallback((priorityCode: string): string => {
    if (priorityCode !== 'p0' && priorityCode !== 'p1') return ''
    const d = new Date()
    if (priorityCode === 'p1') d.setDate(d.getDate() + 3)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T18:00`
  }, [])

  /** 打开立项弹框（类型/优先级/截止时间/标题都在这里确认，避免"隐藏固定参数"）。 */
  const openTaskDraft = useCallback((product: AsinProduct): void => {
    const identity = identityOf(product)
    if (identity === null) return
    setError('')
    setNote('')
    setTaskDraft({
      asin: identity.asin,
      site: identity.site,
      title: `选品立项：${product.currentTitle ?? product.title ?? product.asin}`.slice(0, 120),
      typeCode: 'personal',
      priorityCode: 'p2',
      // p2 默认不设截止；用户改优先级时 suggestDueLocal 会补上建议值
      dueLocal: '',
    })
  }, [identityOf])

  const submitTaskDraft = useCallback(async (): Promise<void> => {
    if (taskDraft === null) return
    setBusyAsin(taskDraft.asin)
    setError('')
    try {
      const result = await api<{ taskId: string; title: string }>(`/api/workbench/asin/${encodeURIComponent(taskDraft.asin)}/task?site=${encodeURIComponent(taskDraft.site)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          site: taskDraft.site,
          title: taskDraft.title,
          typeCode: taskDraft.typeCode,
          priorityCode: taskDraft.priorityCode,
          dueAt: taskDraft.dueLocal.trim() === '' ? null : new Date(taskDraft.dueLocal).toISOString(),
        }),
      })
      setNote(t('已立项：{title}（任务 {id}）', { title: result.title, id: result.taskId }))
      setTaskDraft(null)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message.includes('409') ? t('这个 ASIN 已有未完成的立项任务，去任务列表里找它。') : message)
    } finally {
      setBusyAsin('')
    }
  }, [t, taskDraft])

  const totalPages = Math.max(1, Math.ceil(total / size))

  return (
    <div className="wb-asin">
      <div className="wb-segmented wb-asin-tabs" role="tablist" aria-label={t('选品视图')}>
        <button type="button" role="tab" aria-selected={tab === 'products'} className={`wb-seg ${tab === 'products' ? 'on' : ''}`} onClick={() => setTab('products')}>
          {t('商品库')}<span className="wb-asin-tab-count">{facets.total}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'stores'} className={`wb-seg ${tab === 'stores' ? 'on' : ''}`} onClick={() => setTab('stores')}>
          {t('店铺库')}<span className="wb-asin-tab-count">{stores.length}</span>
        </button>
        {/**
         * 跳产品库（P3）：本页只留"怎么判"，"这个商品是什么"去产品库看。
         * 只做跳转，不做第二份产品详情 —— 两份详情必然漂移。
         */}
        {onOpenLibrary !== undefined && (
          <button
            type="button"
            className="wb-seg wb-asin-tab-link"
            onClick={onOpenLibrary}
            title={t('查看商品事实（站点/ASIN/价格/店铺）')}
          >{t('产品库 →')}</button>
        )}
      </div>

      {tab === 'stores' ? (
        <div className="wb-asin-stores">
          <div className="wb-asin-toolbar">
            <div className="wb-asin-filters">
              <button type="button" className="wb-btn" onClick={openStoreCreate}>{t('添加店铺')}</button>
              <span className="wb-asin-batch-hint">{t('店铺只是选品库的归类：删记录不会删掉它下面的商品。')}</span>
            </div>
          </div>
          {stores.length === 0
            ? (
              <div className="wb-empty">
                <div className="wb-empty-title">{t('还没有店铺记录')}</div>
                <div className="wb-empty-desc">{t('点上面的「添加店铺」手工建一家；旧脚本导出的店铺也会随「导入收藏 JSON」进来。每家店会显示库内实际关联的商品数。')}</div>
              </div>
            )
            : stores.map((store) => (
              <div key={store.id} className={`wb-asin-store-row${store.watch ? ' is-on' : ''}`}>
                <button type="button" className={`wb-asin-watch${store.watch ? ' is-on' : ''}`} disabled={storeBusy === store.id} onClick={() => void toggleStoreWatch(store)} aria-label={store.watch ? t('取消关注店铺') : t('关注店铺')} title={store.watch ? t('已关注') : t('关注店铺')}>
                  {store.watch ? '★' : '☆'}
                </button>
                <div className="wb-asin-store-main">
                  <b>{store.name}</b>
                  <div className="wb-asin-store-sub">
                    {store.site !== null && <span className="wb-chip is-neutral">{store.site}</span>}
                    {store.sellerId !== null && <span className="wb-asin-code">{store.sellerId}</span>}
                    <span>{t('库内商品')} {store.linked}</span>
                    {store.watched > 0 && <span>{t('关注')} {store.watched}</span>}
                    {store.productsCount !== store.linked && (
                      <span className="wb-asin-store-drift" title={t('脚本扫描时记录 {a} 个，库内实际 {b} 个', { a: store.productsCount, b: store.linked })}>
                        {t('扫描 {n}', { n: store.productsCount })}
                      </span>
                    )}
                    {store.note !== null && <span className="wb-asin-note">{store.note}</span>}
                  </div>
                </div>
                <div className="wb-asin-store-actions">
                  <button type="button" className="wb-btn" disabled={store.linked === 0} onClick={() => openStoreProducts(store)}>{t('看商品')}</button>
                  <button type="button" className="wb-oplog-card-open" onClick={() => openStoreEdit(store)}>{t('编辑')}</button>
                  <button type="button" className="wb-oplog-card-open" disabled={storeBusy === store.id} onClick={() => void removeStore(store)}>{t('删除记录')}</button>
                </div>
              </div>
            ))}
        </div>
      ) : (
      <>
      <div className="wb-asin-toolbar">
        <div className="wb-asin-filters">
        <select className="wb-oplog-select" value={site} onChange={changeFilter(setSite)} aria-label={t('站点')}>
          <option value="">{t('全部站点')}</option>
          {facets.sites.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
        </select>
        <select className="wb-oplog-select" value={category} onChange={changeFilter(setCategory)} aria-label={t('分类')}>
          <option value="">{t('全部分类')}（{facets.total}）</option>
          {facets.categories.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
        </select>
        <select className="wb-oplog-select" value={shop} onChange={changeFilter(setShop)} aria-label={t('店铺')}>
          <option value="">{t('全部店铺')}</option>
          {facets.shops.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
        </select>
        <select className="wb-oplog-select" value={verdict} onChange={changeFilter(setVerdict)} aria-label={t('判断结论')}>
          <option value="all">{t('全部判断')}</option>
          {ASIN_VERDICTS.map((code) => {
            const count = facets.verdicts.find((f) => f.value === code)?.count
            return <option key={code} value={code}>{t(ASIN_VERDICT_LABELS[code])}{count === undefined ? '' : `（${count}）`}</option>
          })}
        </select>
        <select className="wb-oplog-select" value={tag} onChange={changeFilter(setTag)} aria-label={t('标签')}>
          <option value="">{t('全部标签')}</option>
          {facets.tags.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
        </select>
        <select className="wb-oplog-select" value={watch} onChange={changeFilter(setWatch)} aria-label={t('关注状态')}>
          <option value="all">{t('全部商品')} · {facets.total}</option>
          <option value="watch">{t('重点关注')} · {facets.watched}</option>
          <option value="normal">{t('普通商品')}</option>
        </select>
        <select className="wb-oplog-select" value={sort} onChange={changeFilter(setSort)} aria-label={t('排序方式')}>
          <option value="collectedAt">{t('收藏时间')}</option>
          <option value="updatedAt">{t('最近更新')}</option>
          <option value="price">{t('价格')}</option>
          <option value="rating">{t('评分')}</option>
          <option value="reviews">{t('评论数')}</option>
          <option value="bsr">BSR</option>
        </select>
        <button type="button" className="wb-btn wb-asin-order" onClick={() => { setOrder(order === 'desc' ? 'asc' : 'desc'); setPage(1) }} aria-label={order === 'desc' ? t('降序，点击切换升序') : t('升序，点击切换降序')}>
          {order === 'desc' ? '↓' : '↑'}
        </button>
        <input className="wb-oplog-search" type="search" value={keyword} placeholder={t('搜索 ASIN / 标题 / 备注')} onChange={(e) => { setKeyword(e.target.value); setPage(1) }} />
        </div>
      </div>

      {/**
       * 动作层与筛选层分开（2026-10-29）：原来 6 个筛选控件、排序、搜索和
       * 添加/导入/导出挤在**一行**里，窄屏会折成三层、主操作被埋在后面。
       * 筛选是"看什么"，动作是"改什么" —— 两类意图不该抢同一行。
       */}
      <div className="wb-report-actions">
        <button type="button" className="wb-btn primary" onClick={openProductCreate}>{t('添加商品')}</button>
        <label className="wb-btn wb-oplog-import">
          <Icon name="file" size={13} />{t('导入收藏 JSON')}
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.currentTarget.files?.[0]
              if (file !== undefined) void onImport(file)
              e.currentTarget.value = ''
            }}
          />
        </label>
        <button type="button" className="wb-btn" disabled={batchBusy} onClick={() => void exportBackup(false)}>{t('导出备份 JSON')}</button>
      </div>

      {/* 批量工具条：只在有勾选时出现，避免平时占一行 */}
      {picked.size > 0 && (
        <div className="wb-asin-batch" role="region" aria-label={t('批量操作')}>
          <span className="wb-asin-batch-count">{t('已选 {n} 个', { n: picked.size })}</span>
          <button type="button" className="wb-btn" disabled={batchBusy} onClick={() => void runBatch('watch')}>{t('设为关注')}</button>
          <button type="button" className="wb-btn" disabled={batchBusy} onClick={() => void runBatch('unwatch')}>{t('取消关注')}</button>
          <input
            className="wb-asin-batch-tag"
            value={batchTag}
            placeholder={t('标签名')}
            aria-label={t('批量标签名')}
            onChange={(e) => setBatchTag(e.target.value)}
          />
          <button type="button" className="wb-btn" disabled={batchBusy || batchTag.trim() === ''} onClick={() => void runBatch('addTag')}>{t('加标签')}</button>
          <button type="button" className="wb-btn" disabled={batchBusy || batchTag.trim() === ''} onClick={() => void runBatch('removeTag')}>{t('删标签')}</button>
          <button type="button" className="wb-btn" disabled={batchBusy} onClick={() => void exportBackup(true)}>{t('只导出选中')}</button>
          <button type="button" className="wb-btn wb-asin-batch-danger" disabled={batchBusy} onClick={() => void runBatch('delete')}>{t('删除选中')}</button>
          <button type="button" className="wb-oplog-card-open" onClick={() => setPicked(new Map())}>{t('清空选择')}</button>
        </div>
      )}
      {exportPath !== '' && (
        <div className="wb-oplog-note" role="status">
          {t('备份已写入：')}<code className="wb-amazon-path">{exportPath}</code>
        </div>
      )}

      {note !== '' && <div className="wb-oplog-note">{note}</div>}
      {error !== '' && <div className="wb-oplog-error">{error}</div>}
      {loading && <div className="wb-skill-hint">{t('读取收藏库…')}</div>}

      {/**
       * 空态要给**能点的东西**（2026-10-29）：原来只有一句"点上面的「添加商品」"，
       * 用户得回到工具条里去找；筛选无结果时甚至没有一键复原的入口。
       */ }
      {!loading && products.length === 0 && (
        <div className="wb-empty">
          <div className="wb-empty-title">{facets.total === 0 ? t('收藏库还是空的') : t('没有符合条件的商品')}</div>
          <div className="wb-empty-desc">
            {facets.total === 0
              ? t('手工录入一个 ASIN，或把旧脚本导出的备份（JSON）整库带进来。')
              : t('当前筛选没有命中任何商品。')}
          </div>
          <div className="wb-report-actions" style={{ justifyContent: 'center' }}>
            {facets.total === 0 ? (
              <>
                <button type="button" className="wb-btn primary" onClick={openProductCreate}>{t('添加商品')}</button>
                <label className="wb-btn">
                  <Icon name="file" size={13} />{t('导入收藏 JSON')}
                  <input
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(e) => {
                      const file = e.currentTarget.files?.[0]
                      if (file !== undefined) void onImport(file)
                      e.currentTarget.value = ''
                    }}
                  />
                </label>
              </>
            ) : (
              <button
                type="button"
                className="wb-btn"
                onClick={() => {
                  setCategory(''); setShop(''); setVerdict('all'); setTag(''); setWatch('all'); setKeyword(''); setPage(1)
                }}
              >{t('清空筛选')}</button>
            )}
          </div>
        </div>
      )}

      {!loading && products.length > 0 && (
        <div className="wb-list wb-asin-list">
          <div className="wb-asin-selectall">
            <label>
              <input
                type="checkbox"
                checked={products.length > 0 && products.every((product) => picked.has(product.asin))}
                onChange={togglePickPage}
              />
              {t('全选本页')}
            </label>
            {picked.size > 0 && <span className="wb-asin-batch-hint">{t('已选 {n} 个（可跨页）', { n: picked.size })}</span>}
          </div>
          {products.map((product) => (
            <div key={product.asin} className={`wb-asin-row${picked.has(product.asin) ? ' is-picked' : ''}`}>
              <label className="wb-asin-pick" title={t('选择')}>
                <input type="checkbox" checked={picked.has(product.asin)} onChange={() => togglePick(product)} aria-label={t('选择 {asin}', { asin: product.asin })} />
              </label>
              {product.imageUrl !== null
                ? <img className="wb-asin-thumb" src={product.imageUrl} alt="" loading="lazy" />
                : <span className="wb-asin-thumb is-empty" aria-hidden="true" />}
              <button type="button" className={`wb-asin-watch${product.watch ? ' is-on' : ''}`} disabled={busyAsin === product.asin} onClick={() => void toggleWatch(product)} aria-label={product.watch ? t('取消重点关注') : t('设为重点关注')} title={product.watch ? t('重点关注') : t('设为重点关注')}>
                {product.watch ? '★' : '☆'}
              </button>
              <div className="wb-asin-main">
                <span className="wb-asin-title">{product.currentTitle ?? product.title ?? product.asin}</span>
                <div className="wb-asin-sub">
                  <span className="wb-asin-code">{product.asin}</span>{product.site !== "" && <span className="wb-chip is-neutral">{product.site}</span>}
                  <button
                    type="button"
                    className="wb-asin-copy"
                    onClick={() => { void navigator.clipboard?.writeText(product.asin) }}
                  >{t("复制")}</button>
                  <button type="button" className="wb-asin-copy" onClick={() => openProductEdit(product)}>{t('编辑')}</button>
                  {/**
                   * 只读出口：带 `site + asin` 跳到产品库。
                   * 这里**不放**产品字段的第二份详情 —— 摘要=行内已有的事实，详情归产品库。
                   */}
                  {onOpenProducts !== undefined && (
                    <button
                      type="button"
                      className="wb-asin-copy"
                      onClick={() => onOpenProducts(product.asin, product.site)}
                      title={t('在产品库查看这条商品事实')}
                    >{t('产品库')}</button>
                  )}
                  {product.shopId !== null && <span>{product.shopName ?? product.shopId}</span>}
                  {product.category !== null && <span className="wb-chip is-neutral">{product.category}</span>}
                  <button
                    type="button"
                    className={`wb-asin-judgment is-${product.judgment.verdict}`}
                    disabled={busyAsin === product.asin}
                    onClick={() => void cycleVerdict(product)}
                    title={t('点击切换：未判断 → 可做 → 观望 → 放弃')}
                  >
                    {t(ASIN_VERDICT_LABELS[product.judgment.verdict])}
                    {product.judgment.score !== null && <b> · {product.judgment.score}</b>}
                  </button>
                  {product.judgment.nextAction !== null && <span className="wb-asin-next">{product.judgment.nextAction}</span>}
                  {product.judgment.verdict !== 'none' && (
                    <button
                      type="button"
                      className="wb-asin-task"
                      disabled={busyAsin === product.asin}
                      onClick={() => openTaskDraft(product)}
                      title={t('按这条判断建一条任务（同一 ASIN 只能有一条未完成立项）')}
                    >{t('立项')}</button>
                  )}
                  {product.tags.map((tag) => <span key={tag} className="wb-chip">{tag}</span>)}
                  {product.note !== null && <span className="wb-asin-note">{product.note}</span>}
                </div>
              </div>
              <div className="wb-asin-nums">
                <span className="wb-asin-price">{product.price !== null ? `$${product.price.toFixed(2)}` : '—'}</span>
                <Sparkline values={product.trend} />
              </div>
              <div className="wb-asin-meta">
                <span>{product.rating !== null ? `★${product.rating.toFixed(1)}` : '—'}</span>
                <span>{product.reviews !== null ? `${product.reviews} 评` : ''}</span>
                {product.bsr !== null && <span>BSR {product.bsr}</span>}
                <span className="wb-asin-date">{fmtDate(product.addedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && total > 0 && <div className="wb-asin-pager">
        <span className="wb-asin-count">{t('显示')} {(page - 1) * size + 1}–{Math.min(page * size, total)} / {total}</span>
        <label className="wb-asin-page-size">{t('每页')} <select className="wb-oplog-select" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1) }}>
          {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select></label>
        <button type="button" className="wb-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>{t('上一页')}</button>
        <span className="wb-asin-page">{page} / {totalPages}</span>
        <button type="button" className="wb-btn" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>{t('下一页')}</button>
      </div>}
      </>
      )}

      {taskDraft !== null && (
        <Modal
          title={<>{t('立项为任务')}</>}
          size="sm"
          onClose={() => setTaskDraft(null)}
          footer={<>
            <button className="wb-btn" type="button" onClick={() => setTaskDraft(null)}>{t('取消')}</button>
            <button className="wb-btn primary" type="button" disabled={busyAsin !== '' || taskDraft.title.trim() === ''} onClick={() => void submitTaskDraft()}>{t('创建任务')}</button>
          </>}
        >
          <div className="wb-oplog-form">
            <label className="wb-field"><span>{t('标题')}</span>
              <input value={taskDraft.title} onChange={(e) => setTaskDraft({ ...taskDraft, title: e.target.value })} />
            </label>
            <div className="wb-oplog-form-row">
              <label className="wb-field"><span>{t('类型')}</span>
                <select value={taskDraft.typeCode} onChange={(e) => setTaskDraft({ ...taskDraft, typeCode: e.target.value })}>
                  {typeOptions.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
                </select>
              </label>
              <label className="wb-field"><span>{t('优先级')}</span>
                <select value={taskDraft.priorityCode} onChange={(e) => setTaskDraft({ ...taskDraft, priorityCode: e.target.value, dueLocal: suggestDueLocal(e.target.value) })}>
                  {priorityOptions.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
                </select>
              </label>
            </div>
            <label className="wb-field"><span>{t('截止时间')}<span className="wb-field-note">{t('留空 = 不设截止；有截止会按类型/优先级自动加提醒')}</span></span>
              <input type="datetime-local" value={taskDraft.dueLocal} onChange={(e) => setTaskDraft({ ...taskDraft, dueLocal: e.target.value })} />
            </label>
            <p className="wb-amazon-footnote">{t('任务描述会自动带上这条商品的 ASIN、售价、判断结论、评分卡、VOC 痛点与风险。')}</p>
          </div>
        </Modal>
      )}

      {/* 手工维护弹框（v1.18）：存成功后才关、才重拉列表；失败把服务端文案留在弹框里。 */}
      {productDraft !== null && (
        <AsinProductForm
          mode={productDraft.mode}
          draft={productDraft.value}
          stores={stores}
          busy={library.busy}
          error={formError}
          onChange={(value) => setProductDraft({ mode: productDraft.mode, value })}
          onSave={() => void saveProduct()}
          onClose={() => setProductDraft(null)}
        />
      )}

      {storeDraft !== null && (
        <AsinStoreForm
          mode={storeDraft.mode}
          draft={storeDraft.value}
          busy={library.busy}
          error={formError}
          onChange={(value) => setStoreDraft({ mode: storeDraft.mode, id: storeDraft.id, value })}
          onSave={() => void saveStore()}
          onClose={() => setStoreDraft(null)}
        />
      )}
    </div>
  )
}
