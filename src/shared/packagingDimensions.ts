/**
 * 包装/外箱尺寸记录的**契约**（服务端存、客户端读，浏览器安全，不含 node 内建）。
 *
 * 为什么放在 shared：客户端要显示记录列表与载入尺寸，但浏览器不能 import 宿主仓储模块
 * （架构判据 R5）。类型住这里，服务端仓储再导出同一份，两边不会各写一套字段名。
 */

export interface PackagingDimensionData {
  packageLength: number
  packageWidth: number
  packageHeight: number
  packageWeight: number
  quantity: number
  sizeUnit: 'in' | 'cm'
  weightUnit: 'lb' | 'kg'
  cartonLength: number
  cartonWidth: number
  cartonHeight: number
}

export interface PackagingDimensionRecord {
  id: string
  name: string
  sku: string
  data: PackagingDimensionData
  createdAt: string
  updatedAt: string
}
