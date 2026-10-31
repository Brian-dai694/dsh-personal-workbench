/**
 * 选品库手工维护的表单草稿（v1.18）。
 *
 * ## 为什么单独一个模块
 *
 * 弹框里的值必须是**字符串**（输入框里就是文本），而接口要的是数字/`null`。
 * 这层转换与校验放在视图里会让 `AsinView` 继续膨胀（它已经 630 行、还欠着 hook 迁移），
 * 放在组件里又会让两个弹框各写一份"价格怎么转"。
 *
 * ## 口径
 *
 * - 空串 → `null`（清空该字段），这是编辑时"把价格删掉"的唯一表达；
 * - 数字不合法当场抛可读中文，**不静默转 0**（0 元是有效的价格，不能被当成"没填"）；
 * - 标签按中英文逗号切分、去重、去空白；服务端会再校验一次上限。
 */
export interface AsinProductDraft {
  asin: string
  title: string
  site: string
  /** 店铺名（自由文本，可从未维护的店铺列表里选）。 */
  shopName: string
  category: string
  price: string
  rating: string
  reviews: string
  bsr: string
  url: string
  imageUrl: string
  /** 逗号分隔的标签。 */
  tags: string
  note: string
  watch: boolean
}

export interface AsinStoreDraft {
  name: string
  sellerId: string
  site: string
  url: string
  note: string
  watch: boolean
}

/** 店铺下拉候选（只取弹框需要的两个字段，避免把整条 store 拖进来）。 */
export interface AsinStoreOption {
  name: string
  sellerId: string | null
}

/** 商品列表里的一条（结构性子集，`AsinProduct` 可直接传进来）。 */
export interface AsinProductLike {
  asin: string
  title: string
  currentTitle: string | null
  /** P2：`null` = 站点未定（needs_site）。编辑时**不许**替用户默认成 US。 */
  site: string | null
  shopName: string | null
  category: string | null
  price: number | null
  rating: number | null
  reviews: number | null
  bsr: number | null
  url: string | null
  imageUrl: string | null
  tags: string[]
  note: string | null
  watch: boolean
}

export interface AsinStoreLike {
  name: string
  sellerId: string | null
  site: string | null
  url: string | null
  note: string | null
  watch: boolean
}

const DEFAULT_SITE = 'US'

/** 亚马逊常见站点（只作输入提示，不构成白名单 —— 服务端只校验"两位字母"）。 */
export const ASIN_SITES = ['US', 'UK', 'DE', 'JP', 'CA', 'FR', 'IT', 'ES', 'AU', 'MX', 'NL', 'SE', 'PL', 'BE', 'TR', 'AE', 'SA', 'SG', 'IN', 'BR'] as const

export function emptyProductDraft(): AsinProductDraft {
  return {
    asin: '', title: '', site: DEFAULT_SITE, shopName: '', category: '',
    price: '', rating: '', reviews: '', bsr: '', url: '', imageUrl: '',
    tags: '', note: '', watch: false,
  }
}

export function productDraftOf(product: AsinProductLike): AsinProductDraft {
  return {
    asin: product.asin,
    title: product.currentTitle ?? product.title ?? '',
    /**
     * 站点不替用户默认（P2）：`null` 保持空串，逼用户显式选。
     * 以前这里把 `''` 兜底成 US —— 那正是"未知站点被静默回填"的入口。
     */
    site: product.site ?? '',
    shopName: product.shopName ?? '',
    category: product.category ?? '',
    price: product.price === null ? '' : String(product.price),
    rating: product.rating === null ? '' : String(product.rating),
    reviews: product.reviews === null ? '' : String(product.reviews),
    bsr: product.bsr === null ? '' : String(product.bsr),
    url: product.url ?? '',
    imageUrl: product.imageUrl ?? '',
    tags: product.tags.join(', '),
    note: product.note ?? '',
    watch: product.watch,
  }
}

export function emptyStoreDraft(): AsinStoreDraft {
  return { name: '', sellerId: '', site: DEFAULT_SITE, url: '', note: '', watch: false }
}

export function storeDraftOf(store: AsinStoreLike): AsinStoreDraft {
  return {
    name: store.name,
    sellerId: store.sellerId ?? '',
    site: store.site ?? DEFAULT_SITE,
    url: store.url ?? '',
    note: store.note ?? '',
    watch: store.watch,
  }
}

function textOrNull(raw: string): string | null {
  const value = raw.trim()
  return value === '' ? null : value
}

function numberOf(raw: string, label: string): number | null {
  const value = raw.trim()
  if (value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}必须是不小于 0 的数字`)
  return parsed
}

function integerOf(raw: string, label: string): number | null {
  const parsed = numberOf(raw, label)
  if (parsed !== null && !Number.isInteger(parsed)) throw new Error(`${label}必须是整数`)
  return parsed
}

function ratingOf(raw: string): number | null {
  const parsed = numberOf(raw, '评分')
  if (parsed !== null && parsed > 5) throw new Error('评分必须在 0–5 之间')
  return parsed
}

export function tagsOf(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[,，]/)) {
    const tag = piece.trim()
    if (tag === '') continue
    if (!out.includes(tag)) out.push(tag)
  }
  return out
}

/**
 * 草稿 → 请求体。**空的数字字段一律 `null`**（= 清空），
 * 因为编辑弹框提交的是"整张表单"，而不是"改过的字段"。
 */
export function productBody(draft: AsinProductDraft, stores: readonly AsinStoreOption[]): Record<string, unknown> {
  const shopName = draft.shopName.trim()
  const matched = stores.find((store) => store.name.trim() === shopName)
  const site = draft.site.trim().toUpperCase()
  return {
    asin: draft.asin.trim().toUpperCase(),
    title: draft.title.trim(),
    site: site === '' ? null : site,
    shopName: shopName === '' ? null : shopName,
    shopId: matched?.sellerId ?? null,
    category: textOrNull(draft.category),
    price: numberOf(draft.price, '价格'),
    rating: ratingOf(draft.rating),
    reviews: integerOf(draft.reviews, '评论数'),
    bsr: integerOf(draft.bsr, 'BSR'),
    url: textOrNull(draft.url),
    imageUrl: textOrNull(draft.imageUrl),
    tags: tagsOf(draft.tags),
    note: textOrNull(draft.note),
    watch: draft.watch,
  }
}

export function storeBody(draft: AsinStoreDraft): Record<string, unknown> {
  const name = draft.name.trim()
  if (name === '') throw new Error('店铺名称不能为空')
  return {
    name,
    sellerId: textOrNull(draft.sellerId),
    site: textOrNull(draft.site)?.toUpperCase() ?? null,
    url: textOrNull(draft.url),
    note: textOrNull(draft.note),
    watch: draft.watch,
  }
}
