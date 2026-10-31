/**
 * 产品库数据域（v1.19）：**独立产品事实表**的读写通道。
 *
 * ## 只暴露事实，不暴露判断
 *
 * 投影 `ProductFact` 里没有结论、评分、VOC、下一步这些字段 —— 它们属于选品库
 * （`asin_products`）。这里连字段都不带，渲染层就漏不出来（`test/productLibraryBoundary`）。
 *
 * ## 为什么读写都在 hook 里
 *
 * `test/viewHttpFence` 是一条棘轮：`views/*.tsx` 里出现 `api(` 就红。所以视图只拿
 * "数据 + 意图"，请求生命周期（谁重拉、失败怎么提示、清哪个 state）全在这里。
 *
 * ## 落到产品库的「定位」意图
 *
 * 从选品页跳过来时带 `q + site`。产品库是**另一张表**，多半没有这条 —— 所以
 * `focus` 只负责把筛选条件带上，命中与否由视图处理（命中就显示，没命中给"录入这条"）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { createBody, updateBody, type ProductFactDraft } from '../productFactDraft.js'

/** 产品库列表项：**刻意不含**任何评估字段（见文件头）。 */
export interface ProductFact {
  /** 服务端主键 `站点_ASIN`；PATCH / DELETE 用它定位，不用拆开拼。 */
  id: string
  asin: string
  /** `null` = 身份未定；界面显示"站点待补"，不显示成 US。 */
  site: string | null
  identityState: 'ok' | 'needs_site'
  title: string
  price: number | null
  shopName: string | null
  category: string | null
  updatedAt: string
}

interface Facet { value: string; count: number }

export interface ProductFacets {
  sites: Facet[]
  shops: Facet[]
  categories: Facet[]
  total: number
}

export interface ProductLibraryFilter {
  site: string
  shop: string
  category: string
  q: string
  page: number
  size: number
}

export interface UseProductLibraryResult {
  items: ProductFact[]
  total: number
  facets: ProductFacets
  filter: ProductLibraryFilter
  loading: boolean
  /** 有写请求在途（录入/编辑/删除共用一个标志：一次只可能开一个弹框）。 */
  busy: boolean
  error: string
  actions: {
    setFilter: (patch: Partial<ProductLibraryFilter>) => void
    reload: () => Promise<void>
    /** 手动录入一条；服务端 409（重复键）原样抛给视图。 */
    create: (draft: ProductFactDraft) => Promise<void>
    /** 改事实字段（身份不可改）；无实质变化时服务端不动 `updated_at`。 */
    update: (product: ProductFact, draft: ProductFactDraft) => Promise<void>
    remove: (product: ProductFact) => Promise<void>
    /** 当前筛选的全部结果（不分页），供「生成表格并预览」使用。 */
    fetchAll: () => Promise<ProductFact[]>
  }
}

const EMPTY_FACETS: ProductFacets = { sites: [], shops: [], categories: [], total: 0 }

const DEFAULT_FILTER: ProductLibraryFilter = { site: '', shop: '', category: '', q: '', page: 1, size: 50 }

/** 导出上限：再多就不是"看一眼"的场景了，提示缩小筛选。 */
const MAX_EXPORT_ROWS = 2000

const PREFIX = '/api/workbench/products'

interface ListResponse {
  products?: Array<{
    id?: unknown
    asin?: unknown
    site?: unknown
    title?: unknown
    price?: unknown
    shopName?: unknown
    category?: unknown
    updatedAt?: unknown
  }>
  facets?: { sites?: Facet[]; shops?: Facet[]; categories?: Facet[]; total?: number }
  total?: number
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toFact(row: NonNullable<ListResponse['products']>[number]): ProductFact | null {
  const asin = asString(row.asin)
  if (asin === '') return null
  const site = typeof row.site === 'string' && row.site !== '' ? row.site : null
  return {
    /** 老响应可能没有 id：用同一条规则（站点_ASIN）兜底，别让按钮因此失效。 */
    id: asString(row.id) === '' ? `${site ?? 'UNKNOWN'}_${asin}` : asString(row.id),
    asin,
    site,
    identityState: site === null ? 'needs_site' : 'ok',
    title: asString(row.title),
    price: typeof row.price === 'number' ? row.price : null,
    shopName: typeof row.shopName === 'string' ? row.shopName : null,
    category: typeof row.category === 'string' ? row.category : null,
    updatedAt: asString(row.updatedAt),
  }
}

/**
 * 落地意图（从选品页跳过来时）：**q 与 site 必须成对**。
 *
 * 只带 q 的后果很具体：产品库跨站点允许同 ASIN 各一条，只按 q 搜会"搜出两行" ——
 * 看起来像定位成功，实际是让人自己再选一次。
 */
export interface ProductLibraryFocus {
  q: string
  site: string
}

function queryOf(filter: ProductLibraryFilter, size: number, page: number): string {
  const params = new URLSearchParams()
  if (filter.site !== '') params.set('site', filter.site)
  if (filter.shop !== '') params.set('shop', filter.shop)
  if (filter.category !== '') params.set('category', filter.category)
  if (filter.q.trim() !== '') params.set('q', filter.q.trim())
  params.set('page', String(page))
  params.set('size', String(size))
  return params.toString()
}

export function useProductLibrary(focus?: ProductLibraryFocus): UseProductLibraryResult {
  const [filter, setFilterState] = useState<ProductLibraryFilter>(() => ({
    ...DEFAULT_FILTER,
    q: focus?.q ?? '',
    site: focus?.site ?? '',
  }))
  const [items, setItems] = useState<ProductFact[]>([])
  const [total, setTotal] = useState(0)
  const [facets, setFacets] = useState<ProductFacets>(EMPTY_FACETS)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)

  /**
   * 取**当前筛选的全部**结果（不分页），给「生成表格并预览」用。
   *
   * 页面只显示一页，导出却只给一页，就会变成"看到的和导出的不一样"。
   */
  const fetchAll = useCallback(async (): Promise<ProductFact[]> => {
    const data = await api<ListResponse>(`${PREFIX}?${queryOf(filter, MAX_EXPORT_ROWS, 1)}`)
    return (data.products ?? []).map(toFact).filter((item): item is ProductFact => item !== null)
  }, [filter])

  const reload = useCallback(async (): Promise<void> => {
    const ticket = seq.current + 1
    seq.current = ticket
    setLoading(true)
    setError('')
    try {
      const data = await api<ListResponse>(`${PREFIX}?${queryOf(filter, filter.size, filter.page)}`)
      /** 迟到响应不许覆盖新结果（切筛选时很常见）。 */
      if (seq.current !== ticket) return
      const next = (data.products ?? []).map(toFact).filter((item): item is ProductFact => item !== null)
      setItems(next)
      setTotal(typeof data.total === 'number' ? data.total : next.length)
      setFacets({
        sites: data.facets?.sites ?? [],
        shops: data.facets?.shops ?? [],
        categories: data.facets?.categories ?? [],
        total: data.facets?.total ?? next.length,
      })
    } catch (e) {
      if (seq.current !== ticket) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq.current === ticket) setLoading(false)
    }
  }, [filter])

  useEffect(() => { void reload() }, [reload])

  /**
   * 落地意图**变了**要重新落地（不只是首次挂载）。
   *
   * `useState` 的初始化函数只跑一次：从选品行 A 跳到产品库、再回选品点行 B 时，
   * 视图是重新挂载的，但装配层传下来的 `focus` 是个新对象 —— 若只认首次初始化，
   * 第二次跳转会**沿用上一次的筛选**，看起来像"点了没反应"。
   */
  const focusKey = `${focus?.q ?? ''}\u0000${focus?.site ?? ''}`
  const landedFocus = useRef(focusKey)
  useEffect(() => {
    if (landedFocus.current === focusKey) return
    landedFocus.current = focusKey
    setFilterState((prev) => ({ ...prev, q: focus?.q ?? '', site: focus?.site ?? '', page: 1 }))
  }, [focusKey, focus?.q, focus?.site])

  const setFilter = useCallback((patch: Partial<ProductLibraryFilter>): void => {
    /** 改筛选一律回到第 1 页：否则会停在一个空页上，看起来像"没数据"。 */
    setFilterState((prev) => ({ ...prev, ...patch, page: patch.page ?? 1 }))
  }, [])

  /** 四个写动作共用一个 busy：它们都只能从同一个弹框触发，分开计数只会让界面更复杂。 */
  const send = useCallback(async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      await api(path, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      await reload()
    } finally {
      setBusy(false)
    }
  }, [reload])

  const create = useCallback((draft: ProductFactDraft): Promise<void> => send(PREFIX, 'POST', createBody(draft)), [send])
  const update = useCallback((product: ProductFact, draft: ProductFactDraft): Promise<void> => send(`${PREFIX}/${encodeURIComponent(product.id)}`, 'PATCH', updateBody(draft)), [send])
  const remove = useCallback((product: ProductFact): Promise<void> => send(`${PREFIX}/${encodeURIComponent(product.id)}`, 'DELETE'), [send])

  return useMemo(
    () => ({ items, total, facets, filter, loading, busy, error, actions: { setFilter, reload, create, update, remove, fetchAll } }),
    [items, total, facets, filter, loading, busy, error, setFilter, reload, create, update, remove, fetchAll],
  )
}
