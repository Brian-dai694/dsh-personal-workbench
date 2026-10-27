/**
 * 选品导入 v2：对齐 v3.2.19 的导出形状（逆向报告）。
 *
 * 导出 JSON：{ version, products, stores, categories, tags, configs }
 *  - products 可能是对象（key = `${site}_${asin}`）或数组
 *  - 产品含 deal / coupon / bsrList / firstAvailableDate / bulletPoints / history
 *  - stores 是对象（key = `${site}_${sellerId}`）
 *
 * 纪律：复杂结构原样存 JSON；ASIN+站点是身份；history 转趋势；坏条目计数不静默丢。
 */
import { emptyJudgment, isAsinRiskLevel, isAsinVerdict, normalizeJudgmentInput, type AsinRiskLevel } from './asinJudgment.js'

export interface AsinProduct {
  asin: string
  site: string
  title: string
  currentTitle: string | null
  imageUrl: string | null
  url: string | null
  price: number | null
  currency: string | null
  rating: number | null
  reviews: number | null
  bsr: number | null
  brand: string | null
  seller: string | null
  shopId: string | null
  shopName: string | null
  category: string | null
  note: string | null
  tags: string[]
  watch?: boolean
  manualOrder?: number | null
  /** 判断结果（migration 30）：导入的旧备份里没有，缺省由仓储补 `none`。 */
  judgment?: import('./asinJudgment.js').AsinJudgment
  /** deal/coupon/bsr/bullets/上架时间等次要字段：原样 JSON，避免为每个加一列 */
  extraJson: string
  addedAt: string
  updatedAt: string
}

export interface AsinStore {
  id: string
  sellerId: string | null
  site: string | null
  name: string
  url: string | null
  note: string | null
  watch: boolean
  lastScannedAt: string | null
  productsCount: number
}

export interface AsinSnapshot {
  asin: string
  capturedAt: string
  price: number | null
  monthlySales: number | null
  reviews: number | null
  rating: number | null
  bsrMajor: number | null
  bsrMinor: number | null
}

export interface AsinImportResult {
  products: AsinProduct[]
  stores: AsinStore[]
  snapshots: AsinSnapshot[]
  categories: string[]
  tags: string[]
  rejected: number
  firstReason: string | null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.\-]/g, '')
    if (cleaned !== '' && cleaned !== '-' && cleaned !== '.') {
      const parsed = Number(cleaned)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}
function iso(value: unknown): string | null {
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : NaN)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  const d = new Date(parsed)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
}

function splitId(id: string, raw: Record<string, unknown>): { asin: string; site: string } {
  const site = str(raw.site).toUpperCase()
  const asin = str(raw.asin).toUpperCase()
  if (/^[A-Z0-9]{10}$/.test(asin)) return { asin, site: site || 'US' }
  const match = /^([A-Z]{2})_([A-Z0-9]{10})$/i.exec(id)
  if (match !== null) return { asin: match[2].toUpperCase(), site: site || match[1].toUpperCase() }
  if (/^[A-Z0-9]{10}$/i.test(id)) return { asin: id.toUpperCase(), site: site || 'US' }
  return { asin: '', site: site || 'US' }
}

function bsrRank(raw: unknown): number | null {
  if (!Array.isArray(raw)) return null
  for (const item of raw) {
    if (item !== null && typeof item === 'object') {
      const rank = num((item as Record<string, unknown>).rank)
      if (rank !== null) return rank
    }
  }
  return null
}

function historyOf(raw: unknown, asin: string): AsinSnapshot[] {
  if (!Array.isArray(raw)) return []
  const out: AsinSnapshot[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const capturedAt = iso(row.at) ?? iso(row.capturedAt) ?? iso(row.time) ?? iso(row.date)
    if (capturedAt === null) continue
    out.push({
      asin,
      capturedAt,
      price: num(row.price),
      monthlySales: num(row.boughtPastMonth) ?? num(row.monthlySales),
      reviews: num(row.reviewCount) ?? num(row.reviews),
      rating: num(row.rating),
      bsrMajor: num(row.bsr) ?? bsrRank(row.bsrList),
      bsrMinor: num(row.bsrMinor),
    })
  }
  return out
}

function productOf(id: string, raw: unknown): AsinProduct | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const { asin, site } = splitId(id, row)
  if (asin === '') return null
  const addedAt = iso(row.collectedAt) ?? iso(row.addedAt) ?? iso(row.updatedAt) ?? new Date().toISOString()
  const extra = {
    currency: str(row.currency) || null,
    deal: { active: row.dealActive === true, type: str(row.dealType) || null, discountPercent: num(row.dealDiscountPercent), price: num(row.dealPrice), listPrice: num(row.listPrice) },
    coupon: { active: row.couponActive === true, text: str(row.couponText) || null, discountPercent: num(row.couponDiscountPercent), discountAmount: num(row.couponDiscountAmount) },
    bsrList: Array.isArray(row.bsrList) ? row.bsrList : [],
    boughtMonth: num(row.boughtPastMonth) ?? num(row.boughtNum),
    firstAvailable: iso(row.firstAvailableDate) ?? (str(row.firstAvailableDate) || null),
    bullets: strings(row.bulletPoints),
    longDescription: str(row.longDescription) || null,
    previousTitle: str(row.previousTitle) || null,
    titleChangeCount: num(row.titleChangeCount),
    titleChangedAt: iso(row.titleChangedAt),
    manualOrder: num(row.manualOrder),
  }
  return {
    asin,
    site,
    title: str(row.title) || str(row.currentTitle),
    currentTitle: str(row.currentTitle) !== '' ? str(row.currentTitle) : null,
    imageUrl: str(row.image) || str(row.imageUrl) || null,
    url: str(row.url) || str(row.link) || null,
    price: num(row.price),
    currency: str(row.currency) || null,
    rating: num(row.rating),
    reviews: num(row.reviewCount) ?? num(row.reviews),
    bsr: bsrRank(row.bsrList) ?? num(row.bsrRank) ?? num(row.bsr),
    brand: str(row.brand) || null,
    seller: str(row.seller) || null,
    shopId: str(row.shopId) || str(row.storeId) || null,
    shopName: str(row.shopName) || str(row.storeName) || null,
    category: str(row.category) || null,
    note: str(row.note) || null,
    tags: strings(row.tags),
    extraJson: JSON.stringify(extra),
    addedAt,
    updatedAt: iso(row.updatedAt) ?? addedAt,
    /**
     * 工作台本地字段（旧脚本会忽略、但工作台**自己的导出**会带上）：
     * 读回来才能让「导出 → 重新导入」恢复关注与判断结论，而不是静默降级。
     */
    watch: row.watch === true || row.watch === 1 ? true : undefined,
    judgment: judgmentOf(row),
  }
}

/**
 * 从备份里还原判断结论（只在 verdict 合法且非 none 时给）。
 *
 * 为什么不整段 `judgment` 直接信：备份是**外部文件**，里面的分数可能越界、
 * verdict 可能被手改成自由文本。这里只取封闭枚举与数值，其余交给
 * `setAsinJudgment` 的校验（它在路由里落库时会再夹一次 0–100）。
 */
function judgmentOf(row: Record<string, unknown>): AsinProduct['judgment'] {
  /** 新版备份：判断是一个嵌套对象（含评分卡分项/VOC/风险），优先读它。 */
  const nested = row.judgment
  if (nested !== null && typeof nested === 'object') {
    const raw = nested as Record<string, unknown>
    const verdict = str(raw.verdict)
    if (!isAsinVerdict(verdict) || verdict === 'none') return undefined
    try {
      const checked = normalizeJudgmentInput({
        verdict,
        score: typeof raw.score === 'number' ? raw.score : null,
        nextAction: str(raw.nextAction) || null,
        criteria: Array.isArray(raw.criteria) ? raw.criteria as Array<{ name: string; value: string }> : [],
        painPoints: Array.isArray(raw.painPoints) ? raw.painPoints as Array<{ label: string; count: number }> : [],
        risk: raw.risk !== null && typeof raw.risk === 'object' && isAsinRiskLevel((raw.risk as { level?: unknown }).level)
          ? raw.risk as { level: AsinRiskLevel; note: string }
          : { level: 'unknown', note: '' },
        keywordCount: typeof raw.keywordCount === 'number' ? raw.keywordCount : null,
        source: str(raw.judgedSource) || 'import',
      })
      return {
        ...emptyJudgment(),
        verdict,
        score: checked.score ?? null,
        nextAction: checked.nextAction ?? null,
        criteria: checked.criteria ?? [],
        painPoints: checked.painPoints ?? [],
        risk: checked.risk ?? { level: 'unknown', note: '' },
        keywordCount: checked.keywordCount ?? null,
        judgedAt: iso(raw.judgedAt),
        judgedSource: checked.source ?? 'import',
      }
    } catch {
      /**
       * 备份是**外部文件**：某一条判断的分数越界 / 分项结构不对时，
       * 丢这条判断、商品照常导入 —— 不能因为一个坏分数让整份备份导入失败。
       */
      return undefined
    }
  }

  /** 旧版备份：判断是平铺的三个键（verdict/score/nextAction）。 */
  const verdict = str(row.verdict)
  if (!isAsinVerdict(verdict) || verdict === 'none') return undefined
  const score = num(row.score)
  return {
    ...emptyJudgment(),
    verdict,
    score: score === null ? null : Math.min(100, Math.max(0, Math.round(score))),
    nextAction: str(row.nextAction) || null,
    judgedAt: iso(row.judgedAt),
    judgedSource: str(row.judgedSource) || 'import',
  }
}

function storeOf(id: string, raw: unknown): AsinStore | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const sellerId = str(row.sellerId) || null
  const site = str(row.site).toUpperCase() || null
  const name = str(row.name) || sellerId || id
  if (name === '') return null
  const products = row.products
  const count = products !== null && typeof products === 'object' ? Object.keys(products as Record<string, unknown>).length : 0
  return {
    id: id !== '' ? id : `${site ?? 'US'}_${sellerId ?? name}`,
    sellerId,
    site,
    name,
    url: str(row.url) || null,
    note: str(row.note) || null,
    watch: row.watch === true,
    lastScannedAt: iso(row.lastScannedAt),
    productsCount: count,
  }
}

export function normalizeAsinImport(raw: unknown): AsinImportResult {
  const result: AsinImportResult = { products: [], stores: [], snapshots: [], categories: [], tags: [], rejected: 0, firstReason: null }
  const reject = (why: string): void => { result.rejected += 1; result.firstReason ??= why }

  const pushProduct = (id: string, item: unknown): void => {
    const product = productOf(id, item)
    if (product === null) { reject('缺少合法 ASIN（10 位字母数字）'); return }
    result.products.push(product)
    if (item !== null && typeof item === 'object') {
      const raw = item as Record<string, unknown>
      result.snapshots.push(...historyOf(raw.history ?? raw.snapshots ?? raw.trend, product.asin))
    }
  }

  if (Array.isArray(raw)) {
    for (const item of raw) pushProduct('', item)
    return result
  }
  if (raw === null || typeof raw !== 'object') {
    result.firstReason = '导入文件不是对象或数组'
    return result
  }

  const obj = raw as Record<string, unknown>
  const products = obj.products ?? obj.items ?? obj.data
  if (Array.isArray(products)) {
    for (const item of products) pushProduct('', item)
  } else if (products !== null && typeof products === 'object') {
    for (const [id, item] of Object.entries(products as Record<string, unknown>)) pushProduct(id, item)
  } else if (Array.isArray(obj.ids)) {
    for (const id of obj.ids) {
      const { asin, site } = splitId(str(id), {})
      if (asin === '') { reject('ASIN 列表里有非法值'); continue }
      result.products.push({
        asin, site, title: '', currentTitle: null, imageUrl: null, url: null, price: null, currency: null,
        rating: null, reviews: null, bsr: null, brand: null, seller: null, shopId: null, shopName: null,
        category: null, note: null, tags: [], extraJson: '{}', addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
    }
  }

  const stores = obj.stores
  if (Array.isArray(stores)) {
    for (const item of stores) {
      const store = storeOf(str((item as Record<string, unknown> | null)?.id), item)
      if (store !== null) result.stores.push(store)
    }
  } else if (stores !== null && typeof stores === 'object') {
    for (const [id, item] of Object.entries(stores as Record<string, unknown>)) {
      const store = storeOf(id, item)
      if (store !== null) result.stores.push(store)
    }
  }

  result.categories = strings(obj.categories)
  result.tags = strings(obj.tags)
  if (result.products.length === 0 && result.rejected === 0 && result.stores.length === 0) result.firstReason = '找不到 products / stores / ids'
  return result
}
