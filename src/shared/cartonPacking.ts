/**
 * 外箱装箱（cartonization）纯函数 —— 服务端存、客户端算，与 3D 预览共用一份结论。
 *
 * ## 为什么只枚举「单一朝向」
 * 六种朝向（内盒三边分别对齐外箱三轴）覆盖了绝大多数电商装箱场景，结果可复核、
 * 可解释。混合摆放（同一箱里两种朝向混排）在数学上属于 3D bin packing，
 * 解不唯一也难向用户解释"为什么是这个数" —— 这里不做，也不假装做了。
 */
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
