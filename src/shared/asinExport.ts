/**
 * 选品导出：生成**旧油猴脚本能直接吃回去**的备份 JSON。
 *
 * ## 为什么要有它
 * 导入只解决了"进来"，没有"出去"就等于是单向黑洞：换机器、重装脚本、清库
 * 都只能靠旧脚本自己再导一次，而工作台里攒的关注/判断/标签全带不走。
 *
 * ## 形状约定（对齐 `shared/asinImport.ts` 的读取口径）
 * ```json
 * { "version": 1, "exportedAt": "...", "products": { "US_B0XXXXXXX": {...} },
 *   "stores": { "US_sellerId": {...} }, "categories": ["..."], "tags": ["..."] }
 * ```
 * 三条纪律：
 * 1. **产品键是 `${site}_${asin}`** —— 导入侧就是这么切的（`splitId`），键写错整批会丢站点；
 * 2. `extraJson` 里的次要字段（deal / coupon / bsrList / bullets / 上架时间…）**摊平回顶层**，
 *    因为导入侧是从顶层读这些字段的，包一层对象就等于没导；
 * 3. 工作台本地字段（`watch` / `verdict` / `score` / `nextAction`）**照写**：旧脚本会忽略它们，
 *    但工作台自己再导入时能恢复关注与判断结论 —— 否则"导出再导入"就是一次静默降级。
 */
import type { AsinProduct, AsinStore } from './asinImport.js'

export interface AsinBackupStoreSource {
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

export interface AsinBackup {
  version: number
  exportedAt: string
  products: Record<string, Record<string, unknown>>
  stores: Record<string, Record<string, unknown>>
  categories: string[]
  tags: string[]
}

/** 产品键：站点 + ASIN；站点未知时用 `UNKNOWN_` 前缀，回导后归为 needs_site，不默认 US。 */
export function productKey(product: Pick<AsinProduct, 'asin' | 'site'>): string {
  const site = (product.site ?? '').trim().toUpperCase()
  return `${site === '' ? 'UNKNOWN' : site}_${product.asin.toUpperCase()}`
}

function extraOf(product: AsinProduct): Record<string, unknown> {
  try {
    const parsed = JSON.parse(product.extraJson) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * 把库里 `extraJson` 的存储形状**翻译回导入器认识的键名**。
 *
 * 这是本模块最容易出错的地方：库内存的是 `boughtMonth` / `firstAvailable` / `bullets` /
 * `deal{...}` 这种"自己的形状"，而导入器读的是 `boughtPastMonth` / `firstAvailableDate` /
 * `bulletPoints` / `dealActive…`。直接摊平 = 键名对不上 = 回导后这些字段全变 null，
 * 而表面上"导入成功"（静默降级）。所以必须逐项映射，映射不到的未知键再原样带走。
 */
const EXTRA_KEY_MAP: Record<string, string> = {
  boughtMonth: 'boughtPastMonth',
  firstAvailable: 'firstAvailableDate',
  bullets: 'bulletPoints',
  longDescription: 'longDescription',
  previousTitle: 'previousTitle',
  titleChangeCount: 'titleChangeCount',
  titleChangedAt: 'titleChangedAt',
  bsrList: 'bsrList',
  manualOrder: 'manualOrder',
}

function flattenExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'deal' || key === 'coupon') continue
    const mapped = EXTRA_KEY_MAP[key] ?? key
    out[mapped] = value
  }
  const deal = extra.deal as Record<string, unknown> | undefined
  if (deal !== undefined && typeof deal === 'object') {
    out.dealActive = deal.active === true
    out.dealType = deal.type ?? null
    out.dealDiscountPercent = deal.discountPercent ?? null
    out.dealPrice = deal.price ?? null
    out.listPrice = deal.listPrice ?? null
  }
  const coupon = extra.coupon as Record<string, unknown> | undefined
  if (coupon !== undefined && typeof coupon === 'object') {
    out.couponActive = coupon.active === true
    out.couponText = coupon.text ?? null
    out.couponDiscountPercent = coupon.discountPercent ?? null
    out.couponDiscountAmount = coupon.discountAmount ?? null
  }
  return out
}

function productRecord(product: AsinProduct): Record<string, unknown> {
  const record: Record<string, unknown> = {
    asin: product.asin.toUpperCase(),
    site: product.site === null || product.site.trim() === '' ? null : product.site.trim().toUpperCase(),
    title: product.title,
    currentTitle: product.currentTitle,
    image: product.imageUrl,
    url: product.url,
    price: product.price,
    currency: product.currency,
    rating: product.rating,
    reviewCount: product.reviews,
    bsr: product.bsr,
    brand: product.brand,
    seller: product.seller,
    shopId: product.shopId,
    shopName: product.shopName,
    category: product.category,
    note: product.note,
    tags: product.tags,
    collectedAt: product.addedAt,
    updatedAt: product.updatedAt,
    /** 工作台本地字段：旧脚本忽略，工作台自己再导入时能恢复。 */
    watch: product.watch === true,
  }
  // 次要字段按导入器的键名摊平回顶层；已在 record 里的键不覆盖（避免 extra 冲掉主字段）
  for (const [key, value] of Object.entries(flattenExtra(extraOf(product)))) {
    if (value === undefined) continue
    if (key in record) continue
    record[key] = value
  }
  /**
   * 判断结论整段带走（v1.26）：只导 `verdict/score/nextAction` 会把评分卡分项、
   * VOC 痛点、商标风险丢掉 —— 那才是复盘时真正要回看的东西。
   *
   * 用**嵌套对象**而不是平铺多个键：判断是一个整体，平铺后再被别的字段撞名
   * （比如某个商品恰好有 `score`）就会串味。旧版导入器只看平铺的
   * `verdict/score/nextAction`，所以那份兼容性由导入侧的回退逻辑负责，不在这里重复写。
   */
  const judgment = product.judgment
  if (judgment !== undefined && judgment.verdict !== 'none') {
    record.judgment = {
      verdict: judgment.verdict,
      score: judgment.score,
      nextAction: judgment.nextAction,
      criteria: judgment.criteria,
      painPoints: judgment.painPoints,
      risk: judgment.risk,
      keywordCount: judgment.keywordCount,
      judgedAt: judgment.judgedAt,
      judgedSource: judgment.judgedSource,
    }
  }
  return record
}

/**
 * 生成备份对象。
 *
 * @param products 要导出的商品（调用方决定是"全部"还是"当前筛选/选中"）
 * @param stores 店铺（原样带上，旧脚本按 `sellerId` 归组）
 * @param now 时间戳（测试注入）
 */
export function buildAsinBackup(products: readonly AsinProduct[], stores: readonly AsinBackupStoreSource[], now: Date = new Date()): AsinBackup {
  const productMap: Record<string, Record<string, unknown>> = {}
  for (const product of products) productMap[productKey(product)] = productRecord(product)

  const storeMap: Record<string, Record<string, unknown>> = {}
  for (const store of stores) {
    const key = store.id !== '' ? store.id : `${(store.site ?? 'US').toUpperCase()}_${store.sellerId ?? store.name}`
    storeMap[key] = {
      sellerId: store.sellerId,
      site: store.site,
      name: store.name,
      url: store.url,
      note: store.note,
      watch: store.watch,
      lastScannedAt: store.lastScannedAt,
      productsCount: store.productsCount,
    }
  }

  const categories = [...new Set(products.map((p) => p.category).filter((value): value is string => value !== null && value !== ''))].sort()
  const tags = [...new Set(products.flatMap((p) => p.tags).filter((value) => value !== ''))].sort()

  return { version: 1, exportedAt: now.toISOString(), products: productMap, stores: storeMap, categories, tags }
}

/** 导出文件名：`asin-backup-YYYYMMDD-HHmm.json`（同分钟重复导出由路由加 (2)）。 */
export function asinBackupFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `asin-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`
}
