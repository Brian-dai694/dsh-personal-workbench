/**
 * Excel (.xls / .xlsx) 读取：服务端统一转 TSV，客户端再用 parseTrafficCsv 走 SOP 表头校验。
 *
 * 直接支持 legacy BIFF `.xls`，不能把旧版 Excel 当文本读（那会变成乱码并报数字校验错误）。
 * 解析只在 loopback API 内执行；返回文本，不执行表格公式，也不向外传送原文件。
 */
import * as XLSX from 'xlsx'

export interface XlsxSheet {
  name: string
  grid: string[][]
}

export interface XlsxReadResult {
  ok: boolean
  sheets: XlsxSheet[]
  errors: string[]
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_LOCAL_HEADER = 0x04034b50

export function sniffKind(buffer: Buffer): 'zip' | 'cfb' | 'text' | 'unknown' {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL_HEADER) return 'zip'
  if (buffer.length >= 8 && CFB_MAGIC.every((byte, index) => buffer[index] === byte)) return 'cfb'
  const head = buffer.subarray(0, Math.min(buffer.length, 1024))
  return head.includes(0) ? 'unknown' : 'text'
}

export function readXlsx(buffer: Buffer): XlsxReadResult {
  const kind = sniffKind(buffer)
  if (kind === 'text') return { ok: false, sheets: [], errors: ['文件内容是文本，不是 Excel 工作簿'] }
  if (kind === 'unknown') return { ok: false, sheets: [], errors: ['文件不是有效的 .xls / .xlsx 工作簿'] }
  try {
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: false,
      raw: false,
      bookVBA: false,
      WTF: false,
    })
    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name]
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
      }).map((row) => row.map((cell) => String(cell ?? '').trim()))
      return { name, grid }
    }).filter((sheet) => sheet.grid.some((row) => row.some((cell) => cell !== '')))
    if (sheets.length === 0) return { ok: false, sheets: [], errors: ['工作簿中没有非空工作表'] }
    return { ok: true, sheets, errors: [] }
  } catch (error) {
    return { ok: false, sheets: [], errors: [`Excel 解析失败：${error instanceof Error ? error.message : String(error)}`] }
  }
}

/** 把选中的 sheet 转成 TSV；单元格内换行/制表符转空格，避免列结构被破坏。 */
export function sheetToTsv(sheet: XlsxSheet): string {
  return sheet.grid
    .map((row) => row.map((cell) => cell.replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim()).join('\t'))
    .filter((line) => line.replace(/\t/g, '').trim() !== '')
    .join('\n')
}
