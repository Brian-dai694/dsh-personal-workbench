/**
 * 选品库的写通道（v1.18）。
 *
 * ## 为什么写进 hook 而不是视图
 *
 * `test/viewHttpFence.test.mjs` 是一条**棘轮**：`views/*.tsx` 里 `api(` 的处数只许减少。
 * `AsinView` 已登记 9 处，手工录入若再在视图里发请求，棘轮当场变红（那正是它存在的意义）。
 * 所以新增的两个写动作放在这里，视图只拿"意图"。
 *
 * ## 为什么不搬整个 AsinView 的读逻辑
 *
 * 那是一次大迁移（列表/筛选/分页/导入导出/批量/立项共 9 处），与本次需求无关。
 * 这里只收**新加**的写动作：保持改动面可审，同时不欠新债。
 *
 * ## 纪律
 *
 * - **不碰 i18n**：错误文案来自服务端（可读中文），成功文案由视图给；
 * - `busy` 是四个动作共享的一个标志：一次只可能开一个弹框，分开计数只会让界面变复杂；
 * - 失败**原样抛出**：视图用同一个 error 行显示，不做二次包装（避免"HTTP 400"盖掉真正的校验文案）。
 */
import { useCallback, useMemo, useState } from 'react'
import { api } from '../api.js'

const PREFIX = '/api/workbench/asin'

export interface AsinLibraryWriter {
  /** 有写请求在途（四个动作共用一个标志）。 */
  busy: boolean
  createProduct: (body: Record<string, unknown>) => Promise<void>
  updateProduct: (asin: string, body: Record<string, unknown>) => Promise<void>
  createStore: (body: Record<string, unknown>) => Promise<void>
  updateStore: (id: string, body: Record<string, unknown>) => Promise<void>
}

export function useAsinLibrary(): AsinLibraryWriter {
  const [busy, setBusy] = useState(false)

  const send = useCallback(async (path: string, method: 'POST' | 'PATCH', body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      await api(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * P2 合同：写操作的身份以 **query `site` 优先**（body 里的 site 仍兼容）。
   * 这里统一把 body.site 提到 query，避免创建/更新与 watch/judgment 两套写法不一致。
   */
  const withSite = useCallback((path: string, body: Record<string, unknown>): string => {
    const site = typeof body.site === 'string' ? body.site.trim() : ''
    return site === '' ? path : `${path}${path.includes('?') ? '&' : '?'}site=${encodeURIComponent(site)}`
  }, [])

  const createProduct = useCallback((body: Record<string, unknown>): Promise<void> => send(withSite(PREFIX, body), 'POST', body), [send, withSite])
  const updateProduct = useCallback((asin: string, body: Record<string, unknown>): Promise<void> => send(withSite(`${PREFIX}/${encodeURIComponent(asin)}`, body), 'PATCH', body), [send, withSite])
  const createStore = useCallback((body: Record<string, unknown>): Promise<void> => send(`${PREFIX}/stores`, 'POST', body), [send])
  const updateStore = useCallback((id: string, body: Record<string, unknown>): Promise<void> => send(`${PREFIX}/stores/${encodeURIComponent(id)}`, 'PATCH', body), [send])

  /** 稳定引用：调用方会把它放进 `useCallback` 依赖，每次渲染换新对象会让回调反复重建。 */
  return useMemo(() => ({ busy, createProduct, updateProduct, createStore, updateStore }), [busy, createProduct, updateProduct, createStore, updateStore])
}
