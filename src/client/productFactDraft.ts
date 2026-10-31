/**
 * 产品库「手动录入」表单草稿（v1.19）。
 *
 * ## 为什么单独一个模块
 *
 * 输入框里是**字符串**，接口要的是数字/`null`。这层转换若写进视图，
 * `ProductLibraryView` 会同时管渲染、管校验、管报文，三件事混在一起没法单测；
 * 写进 hook 又会让 hook 认识"表单字段"这种纯界面概念。
 *
 * ## 口径（与 `db/repo/products.ts` 的 normalize 逐条对齐）
 *
 * - 站点：两位字母，统一大写。**不替用户默认成 US** —— 未知站点被静默回填是历史缺陷；
 * - ASIN：5–20 位字母数字（允许连字符），统一大写；编辑态只读（它是身份）；
 * - 价格：空串 → `null`（= 没填/清空），`0` 是合法价格，不当作"没填"；
 * - 标题允许为空（还没维护标题是合法状态），店铺/分类空串 → `null`。
 */
import { ASIN_SITES } from './asinManualDraft.js'

/** 站点输入提示（复用选品那份列表，不另写一份会漂的白名单）。 */
export { ASIN_SITES }

export interface ProductFactDraft {
  asin: string
  site: string
  title: string
  price: string
  shopName: string
  category: string
}

/** 与 `ProductFact`（hook 投影）结构上兼容的最小输入。 */
export interface ProductFactLike {
  asin: string
  site: string | null
  title: string
  price: number | null
  shopName: string | null
  category: string | null
}

const DEFAULT_SITE = 'US'

export function emptyProductFactDraft(): ProductFactDraft {
  return { asin: '', site: DEFAULT_SITE, title: '', price: '', shopName: '', category: '' }
}

export function productFactDraftOf(fact: ProductFactLike): ProductFactDraft {
  return {
    asin: fact.asin,
    site: fact.site ?? '',
    title: fact.title,
    price: fact.price === null ? '' : String(fact.price),
    shopName: fact.shopName ?? '',
    category: fact.category ?? '',
  }
}

function textOrNull(raw: string): string | null {
  const value = raw.trim()
  return value === '' ? null : value
}

function priceOf(raw: string): number | null {
  const value = raw.trim()
  if (value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('价格必须是不小于 0 的数字')
  if (parsed > 10_000_000) throw new Error('价格不能超过 10000000')
  return parsed
}

/** 身份校验：录入前就拦住，不用等一次往返才看到"ASIN 格式无效"。 */
export function identityOf(draft: ProductFactDraft): { site: string; asin: string } {
  const site = draft.site.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(site)) throw new Error('站点必须是两位字母，例如 US / DE')
  const asin = draft.asin.trim().toUpperCase()
  if (!/^[A-Z0-9-]{5,20}$/.test(asin)) throw new Error('ASIN 格式无效（5–20 位字母数字）')
  return { site, asin }
}

/**
 * 草稿 → **新建**请求体。身份字段一并带上（新建时必须）；
 * 编辑时不要用它 —— 编辑只发事实字段，避免把身份写回服务端（那会被 400 拒绝）。
 */
export function createBody(draft: ProductFactDraft): Record<string, unknown> {
  const identity = identityOf(draft)
  const title = draft.title.trim()
  if (title.length > 300) throw new Error('标题不超过 300 个字符')
  const shopName = textOrNull(draft.shopName)
  if (shopName !== null && shopName.length > 120) throw new Error('店铺不超过 120 个字符')
  const category = textOrNull(draft.category)
  if (category !== null && category.length > 120) throw new Error('分类不超过 120 个字符')
  return { site: identity.site, asin: identity.asin, title, price: priceOf(draft.price), shopName, category }
}

/** 草稿 → **编辑**请求体：只有事实字段（标题/价格/店铺/分类）。 */
export function updateBody(draft: ProductFactDraft): Record<string, unknown> {
  const title = draft.title.trim()
  if (title.length > 300) throw new Error('标题不超过 300 个字符')
  const shopName = textOrNull(draft.shopName)
  if (shopName !== null && shopName.length > 120) throw new Error('店铺不超过 120 个字符')
  const category = textOrNull(draft.category)
  if (category !== null && category.length > 120) throw new Error('分类不超过 120 个字符')
  return { title, price: priceOf(draft.price), shopName, category }
}
