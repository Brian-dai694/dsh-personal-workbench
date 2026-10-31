/**
 * 飞机盒 3D 预览 —— 严格按刀版重做（v2，2026-10-30）。
 *
 * ## 依据
 * 刀版实测：**315 × 202 × 62 mm**。盖、底各一片 315×202，中间 62 夹带（后壁），
 * 前端一片带圆角耳的插舌，四角 45° 斜切，侧翼带锁舌。
 *
 * ## 与 v1 的差别（v1 有几处是按想象画的，已删）
 * 1. 盖面板是**光板**，v1 加在盖两侧的"防尘襟片"不存在；
 * 2. 前壁**没有横向锁口** —— 闭合靠盖两端"飞机翼"下折夹住底盒侧壁；
 * 3. 默认比例改扁：真实盒高只有长度的 20%，v1 默认是 53%；
 * 4. 补上四角 45° 斜折线（对应刀版上的斜切角）。
 *
 * ## 质感
 * 瓦楞竖纹 + SVG feTurbulence 纸纹 + 逐面受光 + 切边高光，全部纯 CSS，零资源文件。
 * 1px 边框在 3D 旋转面上会被栅格化成"缝线"锯齿，所以面板一律不用 border。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

export interface PackageBox3DProps {
  /** 长（外层尺寸，单位与 unit 一致） */
  length: number
  /** 宽（= 盒深） */
  width: number
  /** 高 */
  height: number
  /** 输入单位，只影响读数文案，不影响几何比例 */
  unit?: 'in' | 'cm' | 'mm'
  className?: string
}

type Vec3 = readonly [number, number, number]

const LIMIT = 380
const BASE_RX = -24
const BASE_RY = -32
const RX_MIN = -34
const RX_MAX = 16
/**
 * 盖沿比盒体大多少 —— **按盒子自身尺寸取相对值**，不能写死常数。
 *
 * 历史 bug：这里原先是 `const OVER = 2`，含义是"2 个输入单位"。英制下是 2 英寸、
 * 公制下就是每边大 2 cm —— 25×15 cm 的盒体配出 29×17 的盖，看起来像"大盖子扣小托盘"，
 * 两侧机翼还悬在盒壁外面。真实瓦楞厚度约 3 mm，取最长边的 0.6% 才对得上刀版。
 */
/** 开盖：盖绕后沿翻到接近水平（书本式摊开） */
const OPEN_DEG = 262

/** 盒体（以及打开时的盖 + 插舌）的顶点集，用于反解适配比例 */
function modelPoints(length: number, width: number, height: number, open: boolean, lidW: number, lidD: number, tongueLen: number): Vec3[] {
  const hx = length / 2
  const hy = height / 2
  const hz = width / 2
  const points: Vec3[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) points.push([sx * hx, sy * hy, sz * hz])
    }
  }
  const tuckLen = tongueLen

  if (open) {
    const a = (OPEN_DEG * Math.PI) / 180
    const dy = Math.cos(a)
    const dz = Math.sin(a)
    for (const sx of [-1, 1]) {
      points.push([sx * lidW, -hy + lidD * dy, -hz + lidD * dz])
      points.push([sx * lidW, -hy + (lidD + tuckLen) * dy, -hz + (lidD + tuckLen) * dz])
      points.push([sx * (lidW + height), -hy + lidD * dy, -hz + lidD * dz])
      points.push([sx * (lidW + height), -hy + (lidD + height) * dy, -hz + (lidD + height) * dz])
    }
  } else {
    for (const sx of [-1, 1]) {
      points.push([sx * lidW, -hy, -hz])
      points.push([sx * lidW, -hy, -hz + lidD])
    }
  }
  return points
}

/** 正交投影的包围盒 */
function project(points: readonly Vec3[], rxDeg: number, ryDeg: number): { x0: number; x1: number; y0: number; y1: number; w: number; h: number } {
  const rx = (rxDeg * Math.PI) / 180
  const ry = (ryDeg * Math.PI) / 180
  const cR = Math.cos(ry)
  const sR = Math.sin(ry)
  const cX = Math.cos(rx)
  const sX = Math.sin(rx)
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const [x, y, z] of points) {
    const xr = x * cR + z * sR
    const zr = -x * sR + z * cR
    const yr = y * cX - zr * sX
    if (xr < x0) x0 = xr
    if (xr > x1) x1 = xr
    if (yr < y0) y0 = yr
    if (yr > y1) y1 = yr
  }
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 }
}

/** 整圈水平角扫一遍取最大投影，再反解出 px/单位（旋转时不"呼吸"） */
function fitScale(points: readonly Vec3[]): number {
  let mw = 0
  let mh = 0
  for (let ryDeg = -180; ryDeg < 180; ryDeg += 5) {
    const level = project(points, BASE_RX, ryDeg)
    if (level.w > mw) mw = level.w
    for (const rxDeg of [RX_MIN, BASE_RX, RX_MAX]) {
      const tilted = project(points, rxDeg, ryDeg)
      if (tilted.h > mh) mh = tilted.h
    }
  }
  return Math.min(LIMIT / mw, LIMIT / mh) * 0.93
}

function safe(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 单位只决定**label 和小数位**，绝不换算数值。
 *
 * 历史 bug：这里曾把 cm 写成 `factor: 2.54`，而父组件传进来的长宽高**已经是所选单位**，
 * 于是 25 cm 被显示成 63.5 cm。数值换算是父组件的职责，组件只负责画。
 */
const UNIT_TEXT: Record<'in' | 'cm' | 'mm', { suffix: string; digits: number }> = {
  in: { suffix: 'in', digits: 1 },
  cm: { suffix: 'cm', digits: 1 },
  mm: { suffix: 'mm', digits: 0 },
}

export function PackageBox3D({ length, width, height, unit = 'in', className }: PackageBox3DProps): JSX.Element {
  const L = safe(length)
  const W = safe(width)
  const H = safe(height)
  const geoReady = L > 0 && W > 0 && H > 0

  const [open, setOpen] = useState(false)
  const [rx, setRx] = useState(BASE_RX)
  const [ry, setRy] = useState(BASE_RY)
  const [zoom, setZoom] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [scale, setScale] = useState(1)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; rx: number; ry: number; moved: boolean } | null>(null)

  useEffect(() => {
    const node = wrapRef.current
    if (node === null) return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 400
      setScale(Math.max(0.5, Math.min(1, w / 400)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => {
    if (!geoReady) return null
    const unitScale = unit === 'cm' ? 1 : unit === 'mm' ? 10 : 1 / 2.54
    const t = 0.3 * unitScale
    const c = 0.1 * unitScale
    /* 当前可见形态按刀版折成常规长方体；翼片在盖合时收于侧壁内侧。 */
    const lidW = L / 2
    const lidD = W
    const tongueLen = H * 0.32
    const points = modelPoints(L, W, H, open, lidW, lidD, tongueLen)
    const s = fitScale(points)
    const base = project(points, BASE_RX, BASE_RY)
    return {
      bw: L * s,
      bd: W * s,
      bh: H * s,
      /* 外形尺寸保持输入值；纸板厚度按真实 3 mm 换算到当前单位。 */
      lw: L * s,
      ld: W * s,
      wg: H * s,
      tk: tongueLen * s,
      tkIn: (t + c) * s,
      board: t * s,
      px: -((base.x0 + base.x1) / 2) * s,
      py: -((base.y0 + base.y1) / 2) * s,
    }
  }, [geoReady, L, W, H, open, unit])

  const reset = useCallback(() => {
    setRx(BASE_RX)
    setRy(BASE_RY)
    setZoom(1)
  }, [])

  /* 滚轮缩放：必须非 passive，否则 preventDefault 不生效、整页跟着滚 */
  useEffect(() => {
    const node = stageRef.current
    if (node === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      setZoom((current) => Math.max(0.6, Math.min(1.7, current * Math.exp(-event.deltaY * 0.0016))))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.wb-pkg3d-actions') !== null) return
    dragRef.current = { x: event.clientX, y: event.clientY, rx, ry, moved: false }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true
    if (!drag.moved) return
    setRy(drag.ry + dx * 0.55)
    setRx(Math.max(RX_MIN, Math.min(RX_MAX, drag.rx - dy * 0.45)))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* 指针已释放 */
    }
    if (!drag.moved) setOpen((current) => !current)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 12 : 5
    switch (event.key) {
      case 'ArrowLeft': setRy((v) => v - step); break
      case 'ArrowRight': setRy((v) => v + step); break
      case 'ArrowUp': setRx((v) => Math.min(RX_MAX, v + step)); break
      case 'ArrowDown': setRx((v) => Math.max(RX_MIN, v - step)); break
      case 'Enter':
      case ' ': setOpen((v) => !v); break
      default: return
    }
    event.preventDefault()
  }

  const u = UNIT_TEXT[unit]
  const text = geoReady
    ? `${L.toFixed(u.digits)} × ${W.toFixed(u.digits)} × ${H.toFixed(u.digits)} ${u.suffix}`
    : '尺寸待填'

  const style = {
    '--bw': `${(layout?.bw ?? 0).toFixed(2)}px`,
    '--bd': `${(layout?.bd ?? 0).toFixed(2)}px`,
    '--bh': `${(layout?.bh ?? 0).toFixed(2)}px`,
    '--lw': `${(layout?.lw ?? 0).toFixed(2)}px`,
    '--ld': `${(layout?.ld ?? 0).toFixed(2)}px`,
    '--wg': `${(layout?.wg ?? 0).toFixed(2)}px`,
    '--tk': `${(layout?.tk ?? 0).toFixed(2)}px`,
    '--tk-in': `${(layout?.tkIn ?? 0).toFixed(2)}px`,
    '--board': `${(layout?.board ?? 0).toFixed(2)}px`,
    '--px': `${(layout?.px ?? 0).toFixed(2)}px`,
    '--py': `${(layout?.py ?? 0).toFixed(2)}px`,
    '--rx': `${rx}deg`,
    '--ry': `${ry}deg`,
    '--s': String(zoom),
  } as unknown as CSSProperties

  return (
    <div className={className === undefined ? 'wb-pkg3d' : `wb-pkg3d ${className}`} ref={wrapRef} style={{ height: `${400 * scale}px` }}>
      <div
        className={`wb-pkg3d-stage${dragging ? ' is-dragging' : ''}`}
        data-open={open}
        style={{ ...style, transform: `scale(${scale})` }}
        ref={stageRef}
        tabIndex={0}
        role="img"
        aria-label="飞机盒三维模型：可拖动旋转、滚轮缩放、回车开合盒盖"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      >
        <div className="wb-pkg3d-frame" aria-hidden="true"><span>380 × 380</span></div>

        <div className="wb-pkg3d-pan" aria-hidden="true">
          <div className="wb-pkg3d-world">
            <div className="wb-pkg3d-rig">
              <div className="wb-pkg3d-box">
                <div className="wb-pkg3d-shadow" />

                <div className="wb-pkg3d-board back" />
                <div className="wb-pkg3d-board left">
                  <i className="wb-pkg3d-miter a" /><i className="wb-pkg3d-miter b" />
                </div>
                <div className="wb-pkg3d-board right">
                  <i className="wb-pkg3d-miter a" /><i className="wb-pkg3d-miter b" />
                </div>
                <div className="wb-pkg3d-board front" />
                <div className="wb-pkg3d-board bottom" />

                <div className="wb-pkg3d-liner back" />
                <div className="wb-pkg3d-liner left" />
                <div className="wb-pkg3d-liner right" />
                <div className="wb-pkg3d-liner front" />
                <div className="wb-pkg3d-liner bottom" />

                <div className="wb-pkg3d-lidroot">
                  <div className="wb-pkg3d-lid">
                    <div className="wb-pkg3d-lid-under" />
                    <div className="wb-pkg3d-lid-skin" />
                    <span className="wb-pkg3d-lid-edge" />
                    <div className="wb-pkg3d-wing l"><div className="wb-pkg3d-wing-skin" /><i className="wb-pkg3d-wing-edge" /></div>
                    <div className="wb-pkg3d-wing r"><div className="wb-pkg3d-wing-skin" /><i className="wb-pkg3d-wing-edge" /></div>
                    <div className="wb-pkg3d-tuck"><i className="wb-pkg3d-tuck-edge" /></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="wb-pkg3d-hud" aria-hidden="true">
          <div className="wb-pkg3d-hud-big">{text}</div>
          <div className="wb-pkg3d-hud-sub">
            {geoReady ? `飞机盒刀版 · 纸板厚 ${unit === 'cm' ? '0.3' : unit === 'mm' ? '3' : '0.1'} ${u.suffix}` : '填齐长宽高后生成模型'}
          </div>
        </div>

        <div className="wb-pkg3d-actions">
          <button className="wb-pkg3d-btn" type="button" aria-pressed={open} onClick={() => setOpen((v) => !v)}>{open ? '合盖' : '开盖'}</button>
          <button className="wb-pkg3d-btn" type="button" onClick={reset}>复位</button>
        </div>
      </div>
    </div>
  )
}
