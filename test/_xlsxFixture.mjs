import * as XLSX from 'xlsx'

/** 通过同一解析库生成结构完整的临时 xlsx（测试 fixture，不是生产解析路径）。 */
export function buildXlsx(rows, sheetName = 'Search Terms') {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName)
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
}

/** 多工作表 xlsx：验证 `parse-file` 的 sheetCount / 只取第一张口径。 */
export function buildXlsxMulti(sheets) {
  const workbook = XLSX.utils.book_new()
  for (const { name, rows } of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
}

/** 生成真实 BIFF8 .xls 字节，覆盖旧版 Excel 的兼容链。 */
export function buildXls(rows, sheetName = 'Search Terms') {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName)
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }))
}

/** 旧版 .xls（复合文档）魔数开头，用于异常格式测试。 */
export function buildFakeCfb(size = 4096) {
  const buffer = Buffer.alloc(size)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buffer, 0)
  return buffer
}
