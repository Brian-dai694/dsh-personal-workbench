/**
 * 无持久化表格预览的入参契约（P2 体验统一，2026-10-30）。
 *
 * 产品库/付款对账这类**派生视图**没有 `amazon_datasets` 记录，却要复用「生成表格并预览」。
 * 与其给它们硬塞一条报表数据集（那会污染 `kind_code` 的 6 种广告报表语义），
 * 不如加一个不落库的出口：前端给列 + 行，服务端拼 CSV、生成 `.univer` 草稿、回 Viewer 地址。
 *
 * 这里只做**纯校验与序列化**（无 IO），路由负责 Univer 与工作区；这样单测不需要 Gateway。
 */

export const TABLE_PREVIEW_LIMITS = {
  /** 与数据集列表量级对齐：超过就属于"该走数据集"的场景。 */
  maxRows: 5000,
  maxColumns: 40,
  maxCells: 50_000,
  maxCellChars: 500,
  maxTitleChars: 60,
} as const

export interface TablePreviewData {
  readonly title: string
  readonly columns: string[]
  readonly rows: string[][]
  readonly csv: string
}

export type TablePreviewParse =
  | { readonly ok: true; readonly data: TablePreviewData }
  | { readonly ok: false; readonly status: 400 | 413; readonly code: 'INVALID_REQUEST' | 'PAYLOAD_TOO_LARGE'; readonly message: string }

function failure(status: 400 | 413, code: 'INVALID_REQUEST' | 'PAYLOAD_TOO_LARGE', message: string): TablePreviewParse {
  return { ok: false, status, code, message }
}

/** CSV 单元格：含分隔符/引号/换行才加引号；空值写空串。 */
export function tableCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? String(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 拼 CSV（首行表头，`\n` 换行，UTF-8 无 BOM，与数据集导出同一口径）。 */
export function tableRowsToCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [columns.map((column) => tableCsvCell(column)).join(',')]
  for (const row of rows) lines.push(columns.map((_, index) => tableCsvCell(row[index] ?? '')).join(','))
  return `${lines.join('\n')}\n`
}

function normalizeCell(raw: unknown): string | null {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null
  if (typeof raw === 'string') return raw.slice(0, TABLE_PREVIEW_LIMITS.maxCellChars)
  return null
}

/**
 * 校验并生成 CSV。
 *
 * 规则（前端按此构造请求）：
 * - `title` 可省，缺省「表格预览」，超长截断；
 * - `columns` 1..40 个非空字符串，**不允许重名**（重名列会让"第几列"说不清）；
 * - `rows` 不超过 5000 行；每行长度不得超过列数（多了直接拒绝，不静默截断）；
 *   不足的补空串；单元格只接受 string/number/null；数值保留裸值（Univer 才能识别为数字）；
 * - 总单元格数 > 50000 或任何非法结构 → 拒绝，不"尽力而为"。
 */
export function parseTablePreview(raw: unknown): TablePreviewParse {
  if (raw === null || typeof raw !== 'object') return failure(400, 'INVALID_REQUEST', '请求体必须是对象')
  const source = raw as Record<string, unknown>

  const rawColumns = source.columns
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    return failure(400, 'INVALID_REQUEST', 'columns 必须是非空数组')
  }
  if (rawColumns.length > TABLE_PREVIEW_LIMITS.maxColumns) {
    return failure(400, 'INVALID_REQUEST', `columns 最多 ${TABLE_PREVIEW_LIMITS.maxColumns} 列`)
  }
  const columns: string[] = []
  const seen = new Set<string>()
  for (const item of rawColumns) {
    if (typeof item !== 'string' || item.trim() === '') return failure(400, 'INVALID_REQUEST', '列名必须是非空字符串')
    const label = item.trim()
    if (seen.has(label)) return failure(400, 'INVALID_REQUEST', `列名重复：${label}`)
    seen.add(label)
    columns.push(label)
  }

  const rawRows = source.rows
  if (!Array.isArray(rawRows)) return failure(400, 'INVALID_REQUEST', 'rows 必须是数组')
  if (rawRows.length > TABLE_PREVIEW_LIMITS.maxRows) {
    return failure(413, 'PAYLOAD_TOO_LARGE', `rows 最多 ${TABLE_PREVIEW_LIMITS.maxRows} 行`)
  }
  if (rawRows.length * columns.length > TABLE_PREVIEW_LIMITS.maxCells) {
    return failure(413, 'PAYLOAD_TOO_LARGE', `单元格总数超过 ${TABLE_PREVIEW_LIMITS.maxCells}`)
  }

  const rows: string[][] = []
  for (const [index, rawRow] of rawRows.entries()) {
    if (!Array.isArray(rawRow)) return failure(400, 'INVALID_REQUEST', `第 ${index + 1} 行必须是数组`)
    if (rawRow.length > columns.length) {
      return failure(400, 'INVALID_REQUEST', `第 ${index + 1} 行有 ${rawRow.length} 列，超过表头的 ${columns.length} 列`)
    }
    const cells: string[] = []
    for (const rawCell of rawRow) {
      const cell = normalizeCell(rawCell)
      if (cell === null) return failure(400, 'INVALID_REQUEST', `第 ${index + 1} 行含非法单元格（只支持文本/数字/空值）`)
      cells.push(cell)
    }
    while (cells.length < columns.length) cells.push('')
    rows.push(cells)
  }

  const titleRaw = typeof source.title === 'string' ? source.title.trim() : ''
  const title = (titleRaw === '' ? '表格预览' : titleRaw).slice(0, TABLE_PREVIEW_LIMITS.maxTitleChars)

  return { ok: true, data: { title, columns, rows, csv: tableRowsToCsv(columns, rows) } }
}
