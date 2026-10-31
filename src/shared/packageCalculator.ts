/** Shared FBA workbook formulas confirmed in non-apparel, apparel, and dangerous-goods sheets. */
export type PackageSizeUnit = 'in' | 'cm'
export type PackageWeightUnit = 'lb' | 'kg'
export type PackageClass = 'small_standard' | 'large_standard' | 'large_bulky' | 'oversize'

export interface PackageCalculatorInput {
  length: number; width: number; height: number; sizeUnit?: PackageSizeUnit
  weight: number; weightUnit?: PackageWeightUnit; quantity?: number; salePrice?: number
  category?: 'non_apparel' | 'apparel' | 'dangerous_goods'
}
export interface PackageCalculatorResult {
  valid: boolean; supported: boolean; errors: string[]; warnings: string[]
  dimensionsIn: { length: number; width: number; height: number }; weightLb: number
  volumeIn3: number; dimensionalWeightLb: number; billableWeightLb: number; billableWeightOz: number
  packageClass: PackageClass | null; shippingFee: number | null; lightSmallFee: number | null
  disposalFee: number | null; returnFee: number | null; monthlyStorageFee: number
  totalShippingFee: number | null
}
const CM_PER_IN = 2.54
const KG_PER_LB = 0.45359237
const EPSILON = 1e-10
function roundup(value: number, digits: number): number { const factor = 10 ** digits; return Math.ceil((value - EPSILON) * factor) / factor }
function ceiling(value: number, step: number): number { return Math.ceil((value - EPSILON) / step) * step }
function positive(value: number): boolean { return Number.isFinite(value) && value > 0 }
function classify(v: number, w: number, x: number, y: number, i: number, t: number): PackageClass {
  if (v <= 15 && w <= 12 && x <= 0.75 && t <= 1) return 'small_standard'
  if (v <= 18 && w <= 14 && x <= 8 && i <= 20 && t <= 20) return 'large_standard'
  if (v <= 59 && w <= 33 && x <= 33 && y <= 130 && i <= 50 && t <= 50) return 'large_bulky'
  return 'oversize'
}
function billableWeight(t: number, i: number, cls: PackageClass): { lb: number; oz: number } {
  if ((cls === 'small_standard' || cls === 'large_standard') && t > i && t <= 1) return { lb: roundup(t * 16, 0) / 16, oz: roundup(t * 16, 0) }
  if (cls === 'oversize' && t > 150) { const lb = roundup(t, 0); return { lb, oz: lb * 16 } }
  if (t > i) {
    if (t <= 3) { const lb = roundup(t, 1); return { lb, oz: lb * 16 } }
    if ((cls === 'small_standard' || cls === 'large_standard') && t <= 20) { const lb = ceiling(t, 0.25); return { lb, oz: lb * 16 } }
    const lb = roundup(t, 0); return { lb, oz: lb * 16 }
  }
  if (i <= 1) return { lb: roundup(i * 16, 0) / 16, oz: roundup(i * 16, 0) }
  if (i < 3) { const lb = roundup(i, 1); return { lb, oz: lb * 16 } }
  if ((cls === 'small_standard' || cls === 'large_standard') && i <= 20) { const lb = ceiling(i, 0.25); return { lb, oz: lb * 16 } }
  const lb = roundup(i, 0); return { lb, oz: lb * 16 }
}
export function calculateWorkbookShippingFee(cls: PackageClass, t: number, i: number, j: number): number {
  if (cls === 'small_standard') {
    const bands = [3.25, 3.34, 3.44, 3.53, 3.64, 3.74, 3.82, 3.87]
    if (j <= 2) return bands[0]; if (j <= 4) return bands[1]; if (j <= 6) return bands[2]; if (j <= 8) return bands[3]
    if (j <= 10) return bands[4]; if (j <= 12) return bands[5]; if (j <= 14) return bands[6]; if (j <= 16) return bands[7]
  }
  if (cls === 'large_standard' && t <= 1 && i <= 1) {
    if (j <= 4) return 3.92; if (j <= 8) return 4.16; if (j <= 12) return 4.43; if (j <= 16) return 4.84
  }
  if (cls === 'large_standard' && (t > 1 || i > 1)) {
    if (j > 1 && j <= 1.25) return 5.29; if (j > 1.25 && j <= 1.5) return 5.68; if (j > 1.5 && j <= 1.75) return 5.84; if (j > 1.75 && j <= 2) return 6.1
    if (j > 2 && j <= 2.25) return 6.24; if (j > 2.2575 && j <= 2.5) return 6.44; if (j > 2.5 && j <= 2.75) return 6.61; if (j > 2.75 && j <= 3) return 7.03
    if (j > 3 && j <= 20) return 7.46 + 0.32 * (j - 3)
  }
  if (cls === 'large_bulky') return 10.65 + 0.38 * (j - 1)
  if (cls === 'oversize') {
    if (j > 0 && j <= 50) return 29.06 + 0.38 * (j - 1)
    if (j > 50 && j <= 70) return 42.93 + 0.75 * (j - 51)
    if (j > 70 && j <= 150) return 59.23 + 0.75 * (j - 71)
    if (j > 150) return 203.46 + 0.19 * (j - 151)
  }
  return 0
}
function disposalFee(cls: PackageClass, t: number): number {
  const r = Math.ceil(t - EPSILON)
  if (cls === 'small_standard' || cls === 'large_standard') { if (t <= 0.5) return 0.97; if (t <= 1) return 1.46; if (r <= 2) return 2.2; return 2.83 + 1.06 * (r - 2) }
  if (t <= 1) return 3.12; if (r <= 2) return 4.07; if (r <= 4) return 5.56; if (r <= 10) return 9.43; return 13.05 + 1.06 * (r - 10)
}
export function calculateWorkbookReturnFee(cls: PackageClass, t: number, i: number, j: number): number {
  if (cls === 'small_standard') { const b = [1.78, 1.84, 1.9, 1.96, 2.02, 2.08, 2.14, 2.21]; if (j <= 2) return b[0]; if (j <= 4) return b[1]; if (j <= 6) return b[2]; if (j <= 8) return b[3]; if (j <= 10) return b[4]; if (j <= 12) return b[5]; if (j <= 14) return b[6]; if (j <= 16) return b[7] }
  if (cls === 'large_standard' && t <= 1 && i <= 1) { if (j <= 4) return 2.36; if (j <= 8) return 2.7; if (j <= 12) return 3.05; if (j <= 16) return 3.39 }
  if (cls === 'large_standard' && (t > 1 || i > 1)) { if (j > 1 && j <= 1.25) return 3.7; if (j > 1.25 && j <= 1.5) return 4.01; if (j > 1.5 && j <= 1.75) return 4.32; if (j > 1.75 && j <= 2) return 4.63; if (j > 2 && j <= 2.25) return 4.66; if (j > 2.2575 && j <= 2.5) return 4.68; if (j > 2.5 && j <= 2.75) return 4.71; if (j > 2.75 && j <= 3) return 4.73; if (j > 3 && j <= 20) return 5 + 0.2 * (j - 3) }
  if (cls === 'large_bulky') return 6.74 + 0.32 * (j - 1)
  if (cls === 'oversize') { if (j > 0 && j <= 50) return 26.33 + 0.38 * (j - 1); if (j > 50 && j <= 70) return 40.12 + 0.75 * (j - 51); if (j > 70 && j <= 150) return 52.45 + 0.75 * (j - 71); if (j > 150) return 157.35 + 0.19 * (j - 151) }
  return 0
}
export function calculatePackage(input: PackageCalculatorInput): PackageCalculatorResult {
  const errors: string[] = []; const warnings: string[] = []
  const category = input.category ?? 'non_apparel'; const supported = category === 'non_apparel' || category === 'apparel' || category === 'dangerous_goods'
  if (!supported) warnings.push('未识别的计算类别，当前按非服装类公式计算')
  const factor = input.sizeUnit === 'cm' ? 1 / CM_PER_IN : 1; const weightFactor = input.weightUnit === 'kg' ? 1 / KG_PER_LB : 1
  const v = input.length * factor; const w = input.width * factor; const x = input.height * factor; const t = input.weight * weightFactor
  for (const [name, value] of [['长', v], ['宽', w], ['高', x], ['重量', t]] as const) if (!positive(value)) errors.push(`${name}必须是大于 0 的数字`)
  const volume = v * w * x; const i = volume / 139; const y = v + 2 * (w + x); const cls = errors.length === 0 ? classify(v, w, x, y, i, t) : null
  const bill = cls === null ? { lb: 0, oz: 0 } : billableWeight(t, i, cls); const j = cls === null ? 0 : (cls === 'small_standard' || (t <= 1 && i <= 1) ? bill.oz : bill.lb)
  if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity < 1)) errors.push('箱数必须是大于 0 的整数')
  const quantity = input.quantity ?? 1; const k = supported && cls !== null ? calculateWorkbookShippingFee(cls, t, i, j) : null; const l = k !== null && input.salePrice !== undefined && input.salePrice < 10 ? k - 0.77 : null
  const n = supported && cls !== null ? disposalFee(cls, t) : null; const o = supported && cls !== null ? calculateWorkbookReturnFee(cls, t, i, j) : null
  const monthly = volume > 0 ? volume / 1728 * (cls === 'small_standard' || cls === 'large_standard' ? 2.4 : 1.4) : 0
  if (cls === 'large_standard' && Math.max(t, i) > 2.25 && Math.max(t, i) <= 2.2575) warnings.push('保留 Excel 原公式 2.2575 空档')
  if (cls !== null && k === 0) warnings.push('保留 Excel 未命中分支返回 0')
  if (cls !== null && t > 1 && i <= 1 && j <= 1) warnings.push('保留 Excel 大号标准缺失分支返回 0')
  return { valid: errors.length === 0, supported, errors, warnings, dimensionsIn: { length: v, width: w, height: x }, weightLb: t, volumeIn3: volume, dimensionalWeightLb: i, billableWeightLb: bill.lb, billableWeightOz: bill.oz, packageClass: cls, shippingFee: k, lightSmallFee: l, disposalFee: n, returnFee: o, monthlyStorageFee: monthly, totalShippingFee: k === null ? null : k * quantity }
}
