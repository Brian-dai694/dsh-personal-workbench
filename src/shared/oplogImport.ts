/**
 * 运营日志导入：把旧「亚马逊运营日志 V5」的导出归一成工作台可存的行。
 *
 * 旧数据形状（V5 导出）：
 *   { logs: [{ id, shopId, shopName, site, asinList:[{value}], logType, title,
 *              content(HTML，可能内嵌 <img src="data:image/...">), documents[],
 *              createdAt(ms), updatedAt }], config: { shops, logTypes, ... } }
 *
 * 四条纪律：
 * 1. **不存 HTML**：正文剥成纯文本（XSS 面），块级标签转换行。
 * 2. **内嵌图片是内容，不是装饰**：从 content 里抽出来单独存 `images`，
 *    正文位置留「[图片]」。不抽 = 用户截图全丢（真实发生过一次）。
 * 3. **附件只留元信息**：documents[].data（dataURL）不进库，只留 name/size/type。
 * 4. **不静默丢件**：坏条目计数 + 第一条原因。
 */

export interface OplogImage {
  /** MIME（image/png 等） */
  mime: string
  /** dataURL 原文，前端直接放进 <img src> */
  dataUrl: string
}

import { colorForType } from './oplogView.js'

export interface OplogImportEntry {
  id: string
  logType: string
  title: string
  contentText: string
  asins: string[]
  images: OplogImage[]
  documents: Array<{ name: string; size: string; type: string }>
  shopId: string | null
  shopName: string | null
  site: string | null
  /** 旧应用调色板里的颜色，迁移后与旧界面一致 */
  typeColor: string
  /** 旧应用的业务日期（YYYY-MM-DD）；没有就用 createdAt 的日期 */
  logDate: string
  createdAt: string
  updatedAt: string
}

export interface OplogImportResult {
  entries: OplogImportEntry[]
  rejected: number
  /** 第一条拒绝原因（给界面显示，不刷屏） */
  firstReason: string | null
  /** 因过大被跳过的图片数（正文里仍留 [图片] 占位） */
  skippedImages: number
}

/** 单张图片上限 2.5MB；整条正文的图片总量上限 12MB。 */
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024
const MAX_IMAGES_TOTAL = 12 * 1024 * 1024

const IMG_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"(data:image\/[a-zA-Z0-9.+-]+;base64,[^"]+)"|'(data:image\/[a-zA-Z0-9.+-]+;base64,[^']+)')[^>]*>/gi

const BLOCK_RE = /<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi

/** 富文本 → 纯文本：块级标签转换行，其余标签剥掉，实体还原常用四个。 */
export function htmlToText(input: string): string {
  return input
    .replace(BLOCK_RE, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 抽出内嵌图片，正文里换成「[图片]」占位；返回剩余 HTML 与图片列表。 */
export function extractInlineImages(html: string): { rest: string; images: OplogImage[]; skipped: number } {
  const images: OplogImage[] = []
  let skipped = 0
  let total = 0
  const rest = html.replace(IMG_RE, (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
    const dataUrl = doubleQuoted ?? singleQuoted ?? ''
    const mimeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl)
    if (mimeMatch === null) { skipped += 1; return '\n[图片]\n' }
    const bytes = Math.floor((dataUrl.length * 3) / 4)
    if (bytes > MAX_IMAGE_BYTES || total + bytes > MAX_IMAGES_TOTAL) { skipped += 1; return '\n[图片]\n' }
    total += bytes
    images.push({ mime: mimeMatch[1], dataUrl })
    return '\n[图片]\n'
  })
  return { rest, images, skipped }
}

function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readAsins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const value = typeof item === 'string' ? item : (typeof item === 'object' && item !== null ? asString((item as Record<string, unknown>).value) : '')
    const trimmed = value.trim().toUpperCase()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

function readDocuments(raw: unknown): OplogImportEntry['documents'] {
  if (!Array.isArray(raw)) return []
  const out: OplogImportEntry['documents'] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const doc = item as Record<string, unknown>
    const name = asString(doc.name)
    if (name === '') continue
    out.push({ name, size: asString(doc.size), type: asString(doc.type) })
  }
  return out
}

/**
 * 接受三种输入：数组、`{ logs }`、`{ entries }` / `{ items }`。
 * 旧 V5 导出的外壳是 `{ logs, config }` —— config 不参与导入（不是日志内容）。
 */
export function normalizeOplogImport(raw: unknown): OplogImportResult {
  let list: unknown = raw
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    list = Array.isArray(obj.logs) ? obj.logs : Array.isArray(obj.entries) ? obj.entries : Array.isArray(obj.items) ? obj.items : null
  }
  if (!Array.isArray(list)) {
    return { entries: [], rejected: 0, firstReason: '导入文件里没有 logs / entries / items 数组', skippedImages: 0 }
  }

  const knownTypes = (() => {
    const config = (raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      ? ((raw as Record<string, unknown>).config as Record<string, unknown> | undefined)
      : undefined
    const list = config?.logTypes
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  })()

  const entries: OplogImportEntry[] = []
  let rejected = 0
  let firstReason: string | null = null
  let skippedImages = 0

  for (const item of list) {
    if (typeof item !== 'object' || item === null) { rejected += 1; firstReason ??= '条目不是对象'; continue }
    const row = item as Record<string, unknown>
    const contentRaw = asString(row.content)
    const { rest, images, skipped } = extractInlineImages(contentRaw)
    skippedImages += skipped

    const title = asString(row.title) || htmlToText(rest).slice(0, 40)
    if (title === '') { rejected += 1; firstReason ??= '条目缺少标题且内容为空'; continue }
    const createdAt = toIso(row.createdAt) ?? toIso(row.updatedAt)
    if (createdAt === null) { rejected += 1; firstReason ??= '条目时间无法解析'; continue }
    const updatedAt = toIso(row.updatedAt) ?? createdAt

    entries.push({
      id: asString(row.id) !== '' ? asString(row.id) : `oplog-${createdAt}-${entries.length}`,
      logType: asString(row.logType) || '未分类',
      title,
      contentText: htmlToText(rest),
      asins: readAsins(row.asinList),
      images,
      documents: readDocuments(row.documents),
      shopId: asString(row.shopId) !== '' ? asString(row.shopId) : null,
      shopName: asString(row.shopName) !== '' ? asString(row.shopName) : null,
      site: asString(row.site) !== '' ? asString(row.site) : null,
      typeColor: colorForType(asString(row.logType) || '未分类', knownTypes),
      logDate: asString(row.date) !== '' ? asString(row.date) : createdAt.slice(0, 10),
      createdAt,
      updatedAt,
    })
  }

  return { entries, rejected, firstReason, skippedImages }
}
