/**
 * 外箱装箱（cartonization）纯函数 —— 服务端存、客户端算，与 3D 预览共用一份结论。
 *
 * ## 为什么只枚举「单一朝向」
 * 六种朝向（内盒三边分别对齐外箱三轴）覆盖了绝大多数电商装箱场景，结果可复核、
 * 可解释。混合摆放（同一箱里两种朝向混排）在数学上属于 3D bin packing，
 * 解不唯一也难向用户解释"为什么是这个数" —— 这里不做，也不假装做了。
 *
 * ## 重量口径
 * 换算只有一份实现，住在 `shared/packageCalculator.ts`（`toKg` / `fromKg`）。
 * 这里转出同一对函数，让外箱面板与包裹页共用一把尺子。
 */
import { fromKg, toKg, type PackageWeightUnit } from './packageCalculator.js'

export { fromKg, toKg }

export interface CartonSize {
  length: number
  width: number
  height: number
}

export interface CartonPacking {
  /** 可装件数；0 表示这个外箱连一件都放不下 */
  count: number
  /** 长向 / 高向 / 宽向 各排几件 */
  nx: number
  ny: number
  nz: number
  /** 摆好之后的单件占位：长向 / 宽向 / 高向 */
  fitLength: number
  fitWidth: number
  fitHeight: number
  /** 内盒总体积 ÷ 外箱体积（0–1） */
  fillRate: number
  /** 三个方向各剩多少（与输入同单位），用于判断能不能再塞填充物 */
  restLength: number
  restWidth: number
  restHeight: number
}

const EPSILON = 1e-9

function usable(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * 亚马逊入仓**单箱毛重上限：23 kg**（≈50.7 lb）。
 *
 * 这条线不是"建议"：超过 23 kg 的箱子在收货端要么被拒收、要么必须贴 Team Lift（多人搬运）
 * 标签并走超重处理，退货/滞仓的成本远高于多拆一箱。所以面板把它做成硬提醒，
 * 而且**恰好等于 23 kg 仍然放行**（口径是 "超 23 kg 才提醒"）。
 */
export const AMAZON_CARTON_WEIGHT_LIMIT_KG = 23

/** 外箱面板的重量单位口径与包裹页一致（`lb | kg`），换算走 `shared/packageCalculator.ts`。 */
export type CartonWeightUnit = PackageWeightUnit

export interface CartonWeightInput {
  /** 单件重量，单位见 `unit`（一般直接取包裹页的重量） */
  unitWeight: number
  unit: CartonWeightUnit
  /** 每箱件数（一般取 `packCarton().count`） */
  count: number
  /**
   * 箱材 + 填充物重量，**规范值 kg**（界面按包裹页单位显示，用 `toKg` / `fromKg` 换算）。
   * 23 kg 这条线本身是 kg 口径，所以判定只吃 kg，不再跟着磅走。
   */
  packagingWeightKg?: number
}

export interface CartonWeightCheck {
  /** 单箱毛重（kg） */
  totalKg: number
  /** 单箱毛重（lb），给习惯磅的人看 */
  totalLb: number
  limitKg: number
  limitLb: number
  /** true = 超过 23 kg，需要提醒 */
  overweight: boolean
  /** 超出上限的公斤数；没超时为 0 */
  excessKg: number
  /** 在上限内每箱最多能装几件；0 表示单件本身就超重 */
  maxUnitsUnderLimit: number
  /** 一句话结论，直接给界面用（不超重时也明确说"在上限内"） */
  message: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 单箱毛重判定：件数 × 单件重量 + 箱材/填充，再与 23 kg 上限比。
 *
 * 为什么单独成一个函数：3D 预览、面板结论、导出的尺寸记录都要说同一句话，
 * 各算各的迟早会出现「面板写超重、记录里写合格」。
 */
export function checkCartonWeight(input: CartonWeightInput): CartonWeightCheck {
  const limitKg = AMAZON_CARTON_WEIGHT_LIMIT_KG
  const limitLb = round2(fromKg(limitKg, 'lb'))
  const packagingWeightKg = Number.isFinite(input.packagingWeightKg) && (input.packagingWeightKg ?? 0) > 0
    ? input.packagingWeightKg as number
    : 0
  const unknown: CartonWeightCheck = {
    totalKg: 0, totalLb: 0, limitKg, limitLb, overweight: false, excessKg: 0, maxUnitsUnderLimit: 0,
    message: `填入单件重量与每箱件数后才能核对单箱重量（亚马逊上限 ${limitKg} kg）`,
  }
  if (!usable(input.unitWeight) || !usable(input.count)) return unknown

  const unitKg = toKg(input.unitWeight, input.unit)
  const totalKg = round2(unitKg * input.count + packagingWeightKg)
  const totalLb = round2(fromKg(totalKg, 'lb'))
  const overweight = totalKg > limitKg + EPSILON
  const excessKg = overweight ? round2(totalKg - limitKg) : 0
  const maxUnitsUnderLimit = Math.max(0, Math.floor((limitKg - packagingWeightKg) / unitKg + EPSILON))
  const message = overweight
    ? `单箱毛重 ${totalKg} kg（≈${totalLb} lb）超过亚马逊 ${limitKg} kg 上限 ${excessKg} kg：${maxUnitsUnderLimit > 0
      ? `请拆箱（按当前单件重量与箱材，每箱最多 ${maxUnitsUnderLimit} 件），或贴 Team Lift（多人搬运）标签并按超重流程处理`
      : '单件（含箱材）本身已超过上限，少装几件也解决不了 —— 需要把商品拆成更小的包裹，或贴 Team Lift（多人搬运）标签走超重流程'}`
    : `单箱毛重 ${totalKg} kg（≈${totalLb} lb），在亚马逊单箱 ${limitKg} kg 上限内`
  return { totalKg, totalLb, limitKg, limitLb, overweight, excessKg, maxUnitsUnderLimit, message }
}

export function packCarton(outer: CartonSize, inner: CartonSize): CartonPacking {
  const empty: CartonPacking = {
    count: 0, nx: 0, ny: 0, nz: 0,
    fitLength: inner.length, fitWidth: inner.width, fitHeight: inner.height,
    fillRate: 0, restLength: outer.length, restWidth: outer.width, restHeight: outer.height,
  }
  if (!usable(outer.length) || !usable(outer.width) || !usable(outer.height)) return empty
  if (!usable(inner.length) || !usable(inner.width) || !usable(inner.height)) return empty

  const sides = [inner.length, inner.width, inner.height] as const
  // 六种「哪条内盒边对齐外箱长/高/宽」的枚举
  const permutations: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]

  let best = empty
  for (const [i0, i1, i2] of permutations) {
    const fitLength = sides[i0]
    const fitHeight = sides[i1]
    const fitWidth = sides[i2]
    const nx = Math.floor(outer.length / fitLength + EPSILON)
    const ny = Math.floor(outer.height / fitHeight + EPSILON)
    const nz = Math.floor(outer.width / fitWidth + EPSILON)
    const count = nx * ny * nz
    if (count <= best.count) continue
    const used = count * inner.length * inner.width * inner.height
    best = {
      count, nx, ny, nz,
      fitLength, fitWidth, fitHeight,
      fillRate: used / (outer.length * outer.width * outer.height),
      restLength: outer.length - nx * fitLength,
      restWidth: outer.width - nz * fitWidth,
      restHeight: outer.height - ny * fitHeight,
    }
  }
  return best
}
