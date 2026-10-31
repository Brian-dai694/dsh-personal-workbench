import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { PackagingDimensionData, PackagingDimensionRecord } from '../../shared/packagingDimensions.js'

export type { PackagingDimensionData, PackagingDimensionRecord } from '../../shared/packagingDimensions.js'

interface RawRow {
  id: string
  name: string
  sku: string
  data_json: string
  created_at: string
  updated_at: string
}

export interface PackagingDimensionInput {
  name: string
  sku?: string
  data: PackagingDimensionData
}

function toRecord(row: RawRow): PackagingDimensionRecord {
  return { id: row.id, name: row.name, sku: row.sku, data: JSON.parse(row.data_json) as PackagingDimensionData, createdAt: row.created_at, updatedAt: row.updated_at }
}

/** 参与数值校验的字段：只列数值项，单位单独校验（拿 `Object.values` 会把单位当数字判错）。 */
const NUMERIC_FIELDS: ReadonlyArray<keyof PackagingDimensionData> = [
  'packageLength', 'packageWidth', 'packageHeight', 'packageWeight', 'quantity',
  'cartonLength', 'cartonWidth', 'cartonHeight',
]

function validate(input: PackagingDimensionInput): void {
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.trim().length > 100) throw new Error('名称必填且不超过 100 个字符')
  if (input.sku !== undefined && input.sku.length > 80) throw new Error('SKU 不超过 80 个字符')
  if (input.data === null || typeof input.data !== 'object') throw new Error('尺寸数据格式无效')
  for (const field of NUMERIC_FIELDS) {
    const value = (input.data as unknown as Record<string, unknown>)[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('尺寸和重量必须是非负有效数字')
  }
  if (!['in', 'cm'].includes(input.data.sizeUnit) || !['lb', 'kg'].includes(input.data.weightUnit)) throw new Error('尺寸或重量单位无效')
}

export function listPackagingDimensions(db: DatabaseSync): PackagingDimensionRecord[] {
  return (db.prepare('SELECT * FROM packaging_dimensions ORDER BY updated_at DESC, name COLLATE NOCASE').all() as unknown as RawRow[]).map(toRecord)
}

export function createPackagingDimension(db: DatabaseSync, input: PackagingDimensionInput, at = new Date().toISOString()): PackagingDimensionRecord {
  validate(input)
  const record: PackagingDimensionRecord = {
    id: `pkg-${randomUUID().slice(0, 8)}`, name: input.name.trim(), sku: input.sku?.trim() ?? '', data: input.data, createdAt: at, updatedAt: at,
  }
  db.prepare('INSERT INTO packaging_dimensions (id,name,sku,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(record.id, record.name, record.sku, JSON.stringify(record.data), at, at)
  return record
}

export function updatePackagingDimension(db: DatabaseSync, id: string, input: PackagingDimensionInput, at = new Date().toISOString()): PackagingDimensionRecord | null {
  validate(input)
  const result = db.prepare('UPDATE packaging_dimensions SET name=?, sku=?, data_json=?, updated_at=? WHERE id=?')
    .run(input.name.trim(), input.sku?.trim() ?? '', JSON.stringify(input.data), at, id)
  if (result.changes === 0) return null
  const row = db.prepare('SELECT * FROM packaging_dimensions WHERE id=?').get(id) as unknown as RawRow | undefined
  return row === undefined ? null : toRecord(row)
}

export function deletePackagingDimension(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM packaging_dimensions WHERE id=?').run(id).changes > 0
}
