/**
 * 外箱（RSC 开槽箱）装箱 3D 预览 —— 纯 CSS 3D，零依赖。
 *
 * ## 它回答的问题
 * 「我这个外箱能装几个飞机盒、怎么排」。所以默认状态就是**开箱 + 透视**：
 * 摇盖翻在外侧、箱壁半透明，一眼看到里面的阵列，而不是先给一个"封好的箱子"。
 *
 * ## 结构
 * 底板 + 四面箱壁 + 顶部四片摇盖（前后主摇盖盖住中部，左右副摇盖压在下层）。
 * 内盒阵列由 `packCarton` 的结论直接生成 —— 数量与预览永远同源，不会"算 4 件画 6 件"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { packCarton, type CartonSize } from '../../shared/cartonPacking.js'

export interface CartonBox3DProps {
  /** 内盒（飞机盒）外形尺寸 */
  inner: CartonSize
  /** 外箱外形尺寸 */
  outer: CartonSize
  className?: string
}

type Vec3 = readonly [number, number, number]

const LIMIT = 380
/**
 * 俯角抬到 -40°：箱壁是实心纸板，机位不够高就看不见"装了几件"。
 * 这一档是"材质"和"信息"的折中 —— 再低就只剩一个纸箱壳。
 */
const BASE_RX = -40
const BASE_RY = -34
const RX_MIN = -48
const RX_MAX = 12
/** 开箱时摇盖的最终角度；相对初始 90° 平铺状态，向外下翻约 10° */
const FLAP_OPEN = 260
/** 内盒渲染上限：再多就是 DOM 拖累，而不是信息量 */
const MAX_RENDER = 240

function cartonPoints(outer: CartonSize, open: boolean): Vec3[] {
  const hx = outer.length / 2
  const hy = outer.height / 2
  const hz = outer.width / 2
  const points: Vec3[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) points.push([sx * hx, sy * hy, sz * hz])
    }
  }
  if (open) {
    const majorAngle = (FLAP_OPEN * Math.PI) / 180
    const sideAngle = ((FLAP_OPEN + 5) * Math.PI) / 180
    const majorOut = -Math.sin(majorAngle)
    const majorRise = Math.cos(majorAngle)
    const sideOut = -Math.sin(sideAngle)
    const sideRise = Math.cos(sideAngle)
    const majorDepth = hz
    const sideDepth = outer.length * 0.3
    for (const sign of [-1, 1]) {
      for (const x of [-hx, hx]) {
        points.push([x, -hy + majorRise * majorDepth, sign * (hz + majorOut * majorDepth)])
      }
      for (const z of [-hz, hz]) {
        points.push([sign * (hx + sideOut * sideDepth), -hy + sideRise * sideDepth, z])
      }
    }
  }
  return points
}

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

function safeSize(size: CartonSize): CartonSize {
  const pick = (value: number, fallback: number): number => (Number.isFinite(value) && value > 0 ? value : fallback)
  return {
    length: pick(size.length, 1),
    width: pick(size.width, 1),
    height: pick(size.height, 1),
  }
}

export function CartonBox3D({ inner, outer, className }: CartonBox3DProps): JSX.Element {
  const [open, setOpen] = useState(true)
  /** 默认透视：先看装载排列，需要看箱体外观再切回实体 */
  const [xray, setXray] = useState(true)
  const [rx, setRx] = useState(BASE_RX)
  const [ry, setRy] = useState(BASE_RY)
  const [zoom, setZoom] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [scale, setScale] = useState(1)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; rx: number; ry: number; moved: boolean } | null>(null)

  const O = safeSize(outer)
  const pack = useMemo(() => packCarton(O, safeSize(inner)), [O.length, O.width, O.height, inner.length, inner.width, inner.height])

  useEffect(() => {
    const node = wrapRef.current
    if (node === null) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 400
      setScale(Math.max(0.5, Math.min(1, width / 400)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => {
    const s = fitScale(cartonPoints(O, open && pack.count > 0))
    return {
      s,
      cw: O.length * s,
      ch: O.height * s,
      cd: O.width * s,
      // 盒壁尺寸用来算内盒的像素位置
      iw: pack.fitLength * s,
      ih: pack.fitHeight * s,
      id: pack.fitWidth * s,
    }
  }, [O, open, pack])

  const boxes = useMemo(() => {
    if (pack.count === 0) return []
    const list: Array<{ x: number; y: number; z: number; alt: boolean }> = []
    const total = Math.min(pack.count, MAX_RENDER)
    for (let j = 0; j < pack.ny && list.length < total; j += 1) {
      for (let k = 0; k < pack.nz && list.length < total; k += 1) {
        for (let i = 0; i < pack.nx && list.length < total; i += 1) {
          list.push({
            x: -layout.cw / 2 + layout.iw / 2 + i * layout.iw,
            y: layout.ch / 2 - layout.ih / 2 - j * layout.ih,
            z: -layout.cd / 2 + layout.id / 2 + k * layout.id,
            alt: (i + j + k) % 2 === 1,
          })
        }
      }
    }
    return list
  }, [pack, layout])

  const reset = useCallback(() => {
    setRx(BASE_RX)
    setRy(BASE_RY)
    setZoom(1)
  }, [])

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
    if ((event.target as HTMLElement).closest('.wb-carton3d-actions') !== null) return
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

  const style = {
    '--cw': `${layout.cw.toFixed(2)}px`,
    '--ch': `${layout.ch.toFixed(2)}px`,
    '--cd': `${layout.cd.toFixed(2)}px`,
    '--rx': `${rx}deg`,
    '--ry': `${ry}deg`,
    '--s': String(zoom),
  } as unknown as CSSProperties

  const empty = pack.count === 0

  return (
    <div className={className === undefined ? 'wb-carton3d' : `wb-carton3d ${className}`} ref={wrapRef} style={{ height: `${400 * scale}px` }}>
      <div
        className={`wb-carton3d-stage${dragging ? ' is-dragging' : ''}`}
        data-open={open}
        data-xray={xray}
        style={{ ...style, transform: `scale(${scale})` }}
        ref={stageRef}
        tabIndex={0}
        role="img"
        aria-label="外箱装箱三维示意图：可拖动旋转、滚轮缩放、回车开箱"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
      >
        <div className="wb-carton3d-frame" aria-hidden="true"><span>380 × 380</span></div>

        <div className="wb-carton3d-pan" aria-hidden="true">
          <div className="wb-carton3d-world">
            <div className="wb-carton3d-rig">
              <div className="wb-carton3d-carton">
                <div className="wb-carton3d-shadow" />
                <div className="wb-carton3d-wall back" />
                <div className="wb-carton3d-wall left" />
                <div className="wb-carton3d-wall right" />
                <div className="wb-carton3d-wall front" />
                <div className="wb-carton3d-wall bottom" />

                <div className="wb-carton3d-items">
                  {boxes.map((box, index) => (
                    <div
                      className={`wb-carton3d-ibox${box.alt ? ' alt' : ''}`}
                      key={`${index}-${box.x.toFixed(1)}-${box.y.toFixed(1)}-${box.z.toFixed(1)}`}
                      style={{
                        '--iw': `${layout.iw.toFixed(2)}px`,
                        '--ih': `${layout.ih.toFixed(2)}px`,
                        '--id': `${layout.id.toFixed(2)}px`,
                        '--tx': `${box.x.toFixed(2)}px`,
                        '--ty': `${box.y.toFixed(2)}px`,
                        '--tz': `${box.z.toFixed(2)}px`,
                      } as unknown as CSSProperties}
                    >
                      <i className="f-back" /><i className="f-left" /><i className="f-right" />
                      <i className="f-front" /><i className="f-top" />
                    </div>
                  ))}
                </div>

                <div className="wb-carton3d-flap-root back"><div className="wb-carton3d-flap back" /></div>
                <div className="wb-carton3d-flap-root front"><div className="wb-carton3d-flap front" /></div>
                <div className="wb-carton3d-flap-root right"><div className="wb-carton3d-flap right" /></div>
                <div className="wb-carton3d-flap-root left"><div className="wb-carton3d-flap left" /></div>
              </div>
            </div>
          </div>
        </div>

        <div className="wb-carton3d-hud" aria-hidden="true">
          <div className="wb-carton3d-hud-big">{empty ? '装不下' : `装 ${pack.count} 件`}</div>
          <div className="wb-carton3d-hud-sub">
            {empty ? '内盒任一尺寸超过外箱' : `排列 ${pack.nx} × ${pack.ny} × ${pack.nz} · 装载率 ${Math.round(pack.fillRate * 100)}%`}
          </div>
        </div>

        <div className="wb-carton3d-actions">
          <button className="wb-carton3d-btn" type="button" aria-pressed={open} onClick={() => setOpen((v) => !v)}>{open ? '关箱' : '开箱'}</button>
          <button className="wb-carton3d-btn" type="button" aria-pressed={xray} onClick={() => setXray((v) => !v)}>透视</button>
          <button className="wb-carton3d-btn" type="button" onClick={reset}>复位</button>
        </div>
      </div>
    </div>
  )
}
