import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import * as THREE from 'three'
import { PALETTE } from '../../shared/palette.js'

export interface PackageBoxThreeProps {
  length: number
  width: number
  height: number
  unit?: 'in' | 'cm' | 'mm'
  className?: string
}

const BOX_COLORS = {
  background: PALETTE.boxBackground,
  paper: PALETTE.boxPaper,
  edge: PALETTE.boxEdge,
  edgeLight: PALETTE.boxEdgeLight,
  flute: PALETTE.boxFlute,
  ambient: PALETTE.boxAmbient,
  ambientGround: PALETTE.boxGround,
  keyLight: PALETTE.boxKeyLight,
  fillLight: PALETTE.boxFillLight,
  text: PALETTE.boxText,
  fallback: PALETTE.boxFallback,
} as const
const BOARD_CM = 0.3
const VIEW = 380
const STAGE_STYLE: CSSProperties = { position: 'relative', width: VIEW, height: VIEW, background: BOX_COLORS.fallback, overflow: 'hidden', touchAction: 'none', userSelect: 'none' }
const CANVAS_STYLE: CSSProperties = { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', overflow: 'hidden' }
const BASE_RX = -0.24
const BASE_RY = 0
const LID_DURATION_MS = 500
const DEFAULT_SIZE_CM = { length: 31.5, width: 20.2, height: 6.2 }
const easeInOutCubic = (t: number): number => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

function makePaperTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 380
  canvas.height = 380
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Canvas 2D context unavailable')
  ctx.fillStyle = BOX_COLORS.paper
  ctx.fillRect(0, 0, 380, 380)
  let seed = 4271
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < 19000; i += 1) {
    const alpha = 0.025 + random() * 0.09
    ctx.fillStyle = random() > 0.5 ? `rgba(255,239,208,${alpha})` : `rgba(65,39,18,${alpha})`
    const x = random() * 380
    const y = random() * 380
    ctx.fillRect(x, y, 0.5 + random() * 1.2, 0.5 + random() * 2.8)
  }
  ctx.globalAlpha = 0.11
  ctx.strokeStyle = BOX_COLORS.edge
  ctx.lineWidth = 0.7
  for (let x = 0; x < 380; x += 5) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + Math.sin(x) * 2, 380)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 8
  return texture
}

function panelShape(width: number, depth: number, radius: number, tongue = false): THREE.Shape {
  const w = width / 2
  const d = depth
  const r = Math.min(radius, w / 3, d / 3)
  const shape = new THREE.Shape()
  shape.moveTo(-w + r, 0)
  shape.lineTo(w - r, 0)
  shape.quadraticCurveTo(w, 0, w, r)
  if (tongue) {
    shape.lineTo(w, d * 0.7)
    shape.quadraticCurveTo(w, d * 0.86, w * 0.82, d * 0.86)
    shape.lineTo(w * 0.68, d)
    shape.lineTo(-w * 0.68, d)
    shape.lineTo(-w * 0.82, d * 0.86)
    shape.quadraticCurveTo(-w, d * 0.86, -w, d * 0.7)
  } else {
    shape.lineTo(w, d - r)
    shape.quadraticCurveTo(w, d, w - r, d)
    shape.lineTo(-w + r, d)
    shape.quadraticCurveTo(-w, d, -w, d - r)
  }
  shape.lineTo(-w, r)
  shape.quadraticCurveTo(-w, 0, -w + r, 0)
  return shape
}

function makePanel(shape: THREE.Shape, depth: number, material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8 })
  geometry.translate(0, 0, -depth / 2)
  const mesh = new THREE.Mesh(geometry, [material, material])
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function buildModel(length: number, width: number, height: number, paper: THREE.Texture): { root: THREE.Group; lid: THREE.Group; tuck: THREE.Group; wings: Array<{ mesh: THREE.Mesh; side: number }> } {
  const root = new THREE.Group()
  const matte = new THREE.MeshStandardMaterial({ map: paper, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
  const edge = new THREE.MeshStandardMaterial({ color: BOX_COLORS.edgeLight, roughness: 0.96, side: THREE.DoubleSide })
  const flute = new THREE.MeshStandardMaterial({ color: BOX_COLORS.flute, roughness: 1, side: THREE.DoubleSide })
  const L = length
  const W = width
  const H = height
  const t = BOARD_CM

  const floor = new THREE.Mesh(new THREE.BoxGeometry(L, t, W), [edge, edge, matte, edge, matte, edge])
  floor.position.set(0, t / 2, 0)
  floor.castShadow = floor.receiveShadow = true
  root.add(floor)

  const wall = (w: number, h: number, x: number, y: number, z: number, rotY = 0): void => {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), [edge, edge, matte, flute, edge, flute])
    panel.position.set(x, y, z)
    panel.rotation.y = rotY
    panel.castShadow = panel.receiveShadow = true
    root.add(panel)
    const fluteLines = Math.max(4, Math.floor(w * 2.2))
    for (let i = 0; i <= fluteLines; i += 1) {
      const px = -w / 2 + (w * i) / fluteLines
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.025, h, t * 0.18), flute)
      line.position.set(x + px * Math.cos(rotY), y, z - px * Math.sin(rotY))
      line.rotation.y = rotY
      root.add(line)
    }
  }
  wall(L, H, 0, H / 2 + t, W / 2 - t / 2)
  wall(L, H, 0, H / 2 + t, -W / 2 + t / 2)
  wall(W - 2 * t, H, -L / 2 + t / 2, H / 2 + t, 0, Math.PI / 2)
  wall(W - 2 * t, H, L / 2 - t / 2, H / 2 + t, 0, Math.PI / 2)

  const lid = new THREE.Group()
  lid.position.set(0, H + t, -W / 2 + t / 2)
  root.add(lid)
  const lidPanel = makePanel(panelShape(L, W - t, 0.55), t, matte)
  lidPanel.rotation.x = Math.PI / 2
  lidPanel.position.z = 0
  lid.add(lidPanel)

  const tuck = new THREE.Group()
  tuck.position.set(0, 0, W - t - 0.02)
  const tuckPanel = makePanel(panelShape(L * 0.82, Math.min(H * 0.42, W * 0.3), 0.5, true), t, matte)
  tuckPanel.rotation.x = Math.PI / 2
  tuck.add(tuckPanel)
  lid.add(tuck)
  tuck.visible = false

  const wingShape = (wingWidth: number): THREE.Shape => {
    const s = new THREE.Shape()
    s.moveTo(0, 0); s.lineTo(wingWidth - 0.45, 0); s.quadraticCurveTo(wingWidth, 0, wingWidth, 0.45)
    s.lineTo(wingWidth, H * 0.68); s.lineTo(wingWidth * 0.72, H); s.lineTo(0, H); s.closePath()
    return s
  }
  const wings: Array<{ mesh: THREE.Mesh; side: number }> = []
  for (const side of [-1, 1]) {
    const wingWidth = Math.min(H * 0.78, L * 0.22)
    const wing = makePanel(wingShape(wingWidth), t, matte)
    wing.rotation.x = Math.PI / 2
    wing.position.set(side * (L / 2 - wingWidth), 0, W * 0.12)
    wing.rotation.z = side < 0 ? -0.035 : 0.035
    wing.visible = false
    lid.add(wing)
    wings.push({ mesh: wing, side })
  }

  const crease = (w: number, x: number, z: number): void => {
    const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.018, 0.018), edge)
    line.position.set(x, H + t + 0.015, z)
    root.add(line)
  }
  crease(L, 0, -W / 2 + t)
  crease(L, 0, W / 2 - t)

  return { root, lid, tuck, wings }
}

export function PackageBoxThree({ length, width, height, unit = 'in', className }: PackageBoxThreeProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; model: THREE.Group; lid: THREE.Group; tuck: THREE.Group; wings: Array<{ mesh: THREE.Mesh; side: number }>; paper: THREE.Texture; frame: number; lidAngle: number; lidFrom: number; lidTo: number; lidStart: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number; rx: number; ry: number } | null>(null)
  const [rotation, setRotation] = useState({ x: BASE_RX, y: BASE_RY })
  const [zoom, setZoom] = useState(1)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)
  const unitFactor = unit === 'mm' ? 0.1 : unit === 'in' ? 2.54 : 1
  const inputL = length * unitFactor
  const inputW = width * unitFactor
  const inputH = height * unitFactor
  const valid = Number.isFinite(length + width + height) && length > 0 && width > 0 && height > 0
  const L = valid ? Math.max(1, inputL) : DEFAULT_SIZE_CM.length
  const W = valid ? Math.max(1, inputW) : DEFAULT_SIZE_CM.width
  const H = valid ? Math.max(1, inputH) : DEFAULT_SIZE_CM.height

  useEffect(() => {
    const host = hostRef.current
    if (host === null || !valid) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: 'low-power' })
    } catch {
      setError(true)
      return
    }
    setError(false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(VIEW, VIEW, false)
    renderer.shadowMap.enabled = false
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    host.prepend(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(BOX_COLORS.background)
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200)
    const maxDimension = Math.max(L, W, H)
    camera.position.set(maxDimension * 1.45, maxDimension * 1.2, maxDimension * 1.85)
    camera.lookAt(0, H * 0.42, 0)
    scene.add(new THREE.HemisphereLight(BOX_COLORS.ambient, BOX_COLORS.ambientGround, 2.15))
    const keyLight = new THREE.DirectionalLight(BOX_COLORS.keyLight, 3.1)
    keyLight.position.set(-L, H * 2.8, W * 1.3)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(1024, 1024)
    keyLight.shadow.camera.left = -L; keyLight.shadow.camera.right = L
    keyLight.shadow.camera.top = W; keyLight.shadow.camera.bottom = -W
    scene.add(keyLight)
    const fill = new THREE.DirectionalLight(BOX_COLORS.fillLight, 0.85)
    fill.position.set(L, H, -W)
    scene.add(fill)

    const paper = makePaperTexture()
    const { root: model, lid, tuck, wings } = buildModel(L, W, H, paper)
    scene.add(model)
    const animate = (now = performance.now()): void => {
      const frame = requestAnimationFrame(animate)
      const state = sceneRef.current
      if (state !== null) {
        const progress = Math.min(1, (now - state.lidStart) / LID_DURATION_MS)
        const eased = easeInOutCubic(progress)
        state.lidAngle = state.lidFrom + (state.lidTo - state.lidFrom) * eased
        state.lid.rotation.x = state.lidAngle
        if (state.lidAngle === 0) { state.lid.children.forEach((child, index) => { child.visible = index === 0 }); state.tuck.visible = false; state.wings.forEach(({ mesh }) => { mesh.visible = false }) }
        const openAmount = Math.min(1, Math.abs(state.lidAngle) / (Math.PI / 2))
        const merge = 1 - openAmount
        state.tuck.rotation.x = -merge * Math.PI / 2
        state.tuck.position.z = (W - BOARD_CM - 0.02) * (1 - merge) + (W / 2 - BOARD_CM) * merge
        state.tuck.position.y = -H * 0.45 * merge
        state.tuck.visible = false
        state.wings.forEach(({ mesh, side }) => { mesh.rotation.z = side * (0.035 - merge * (Math.PI / 2 - 0.035)); mesh.position.z = W * (0.12 - merge * 0.08); mesh.visible = true; mesh.scale.setScalar(Math.max(0.001, openAmount)) })
        state.frame = frame
        state.renderer.render(state.scene, state.camera)
      }
    }
    sceneRef.current = { renderer, scene, camera, model, lid, tuck, wings, paper, frame: 0, lidAngle: 0, lidFrom: 0, lidTo: 0, lidStart: performance.now() }
    animate()
    const resize = (): void => {
      const size = Math.min(VIEW, Math.max(240, host.clientWidth))
      renderer.setSize(size, size, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    return () => {
      observer.disconnect()
      const state = sceneRef.current
      if (state !== null) cancelAnimationFrame(state.frame)
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          materials.forEach((material) => material.dispose())
        }
      })
      paper.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      sceneRef.current = null
    }
  }, [L, W, H, valid])

  useEffect(() => {
    const state = sceneRef.current
    if (state === null) return
    state.model.rotation.set(rotation.x, rotation.y, 0)
    state.model.scale.setScalar(zoom)
  }, [rotation, zoom])

  useEffect(() => {
    const state = sceneRef.current
    if (state === null) return
    state.lidFrom = state.lidAngle
    state.lidTo = open ? -Math.PI / 2 : 0
    state.lidStart = performance.now()
  }, [open])

  const reset = (): void => { setRotation({ x: BASE_RX, y: BASE_RY }); setZoom(1); setOpen(false) }
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.wb-pkg3d-actions')) return
    dragRef.current = { x: event.clientX, y: event.clientY, rx: rotation.x, ry: rotation.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null) return
    setRotation({ x: Math.max(-0.85, Math.min(0.35, drag.rx - (event.clientY - drag.y) * 0.008)), y: drag.ry + (event.clientX - drag.x) * 0.009 })
  }
  const onPointerUp = (): void => { dragRef.current = null }
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setZoom((value) => Math.max(0.65, Math.min(1.6, value * Math.exp(-event.deltaY * 0.0015))))
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') { setOpen((value) => !value); event.preventDefault() }
    if (event.key === 'ArrowLeft') setRotation((value) => ({ ...value, y: value.y - 0.08 }))
    if (event.key === 'ArrowRight') setRotation((value) => ({ ...value, y: value.y + 0.08 }))
  }
  const suffix = unit === 'mm' ? 'mm' : unit === 'in' ? 'in' : 'cm'
  const shown = [inputL, inputW, inputH].map((value) => unit === 'mm' ? value * 10 : value)
  return <div className={`wb-pkg3d${className ? ` ${className}` : ''} wb-pkg3d-three`} style={{ width: VIEW, maxWidth: '100%', margin: '0 auto', position: 'relative' }}>
    <div className="wb-pkg3d-stage wb-pkg3d-three-stage" style={STAGE_STYLE} data-open={open} tabIndex={0} role="img"
      aria-label="瓦楞飞机盒刀版实尺寸三维模型，可拖动旋转、滚轮缩放、回车开合盒盖"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel} onKeyDown={onKeyDown} onDoubleClick={reset}>
      <div className="wb-pkg3d-three-canvas" style={CANVAS_STYLE} ref={hostRef} />
      <div className="wb-pkg3d-hud" style={{ color: BOX_COLORS.text }} aria-hidden="true">
        <div className="wb-pkg3d-hud-big">{valid ? `输入 ${shown[0]} × ${shown[1]} × ${shown[2]} ${suffix}` : '尺寸待填'}</div>
        <div className="wb-pkg3d-hud-sub">模型外尺寸约 {(L + 0.1).toFixed(1)} × {(W + 0.45).toFixed(1)} × {(H + 0.1).toFixed(1)} cm · 纸板 3 mm{error ? ' · WebGL 不可用' : ''}</div>
      </div>
      <div className="wb-pkg3d-actions">
        <button className="wb-pkg3d-btn" type="button" aria-pressed={open} onClick={() => setOpen((value) => !value)}>{open ? '合盖' : '开盖'}</button>
        <button className="wb-pkg3d-btn" type="button" onClick={reset}>复位</button>
      </div>
    </div>
  </div>
}
