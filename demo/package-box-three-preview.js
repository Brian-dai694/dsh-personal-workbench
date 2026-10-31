import * as THREE from 'three'

const host = document.querySelector('#view')
const scene = new THREE.Scene()
scene.background = new THREE.Color('#fff')
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.08
renderer.shadowMap.enabled = false
host.prepend(renderer.domElement)

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 500)
scene.add(new THREE.HemisphereLight('#fffdf8', '#745637', 2))
const key = new THREE.DirectionalLight('#fff7e9', 3.4)
key.position.set(-34, 54, 42)
key.castShadow = true
key.shadow.mapSize.set(1536, 1536)
scene.add(key)
const fill = new THREE.DirectionalLight('#e4ebf6', 0.9)
fill.position.set(40, 20, -35)
scene.add(fill)

const textureCanvas = document.createElement('canvas')
textureCanvas.width = textureCanvas.height = 380
const ctx = textureCanvas.getContext('2d')
ctx.fillStyle = '#b68a59'
ctx.fillRect(0, 0, 380, 380)
let seed = 4271
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
for (let i = 0; i < 20000; i += 1) {
  ctx.fillStyle = random() > 0.5 ? `rgba(255,239,208,${0.025 + random() * 0.1})` : `rgba(65,39,18,${0.025 + random() * 0.1})`
  ctx.fillRect(random() * 380, random() * 380, 0.5 + random() * 1.3, 0.5 + random() * 2.8)
}
ctx.globalAlpha = 0.12
ctx.strokeStyle = '#694927'
for (let x = 0; x < 380; x += 5) {
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + Math.sin(x) * 2, 380); ctx.stroke()
}
ctx.globalAlpha = 1
const texture = new THREE.CanvasTexture(textureCanvas)
texture.colorSpace = THREE.SRGBColorSpace
texture.wrapS = texture.wrapT = THREE.RepeatWrapping
texture.anisotropy = 8
const paper = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.94, side: THREE.DoubleSide })
const edge = new THREE.MeshStandardMaterial({ color: '#8b6741', roughness: 1, side: THREE.DoubleSide })
const flute = new THREE.MeshStandardMaterial({ color: '#d8bf9e', roughness: 1, side: THREE.DoubleSide })
const model = new THREE.Group()
const lidPivot = new THREE.Group()
scene.add(model)
model.add(lidPivot)
let L = 31.5, W = 20.2, H = 6.2
const thickness = 0.3

function disposeGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child)
    child.traverse((object) => {
      if (!object.isMesh) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) if (material !== paper && material !== edge && material !== flute) material.dispose()
    })
  }
}
function addBox(group, w, h, d, x, y, z, rotationY = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [edge, edge, paper, flute, edge, flute])
  mesh.position.set(x, y, z)
  mesh.rotation.y = rotationY
  mesh.castShadow = mesh.receiveShadow = true
  group.add(mesh)
}
function panelShape(width, depth, radius, tongue = false) {
  const half = width / 2
  const r = Math.min(radius, half / 3, depth / 3)
  const shape = new THREE.Shape()
  shape.moveTo(-half + r, 0); shape.lineTo(half - r, 0); shape.quadraticCurveTo(half, 0, half, r)
  if (tongue) {
    shape.lineTo(half, depth * 0.68); shape.quadraticCurveTo(half, depth * 0.82, half * 0.84, depth * 0.84)
    shape.lineTo(half * 0.68, depth); shape.lineTo(-half * 0.68, depth); shape.lineTo(-half * 0.84, depth * 0.84)
    shape.quadraticCurveTo(-half, depth * 0.82, -half, depth * 0.68)
  } else {
    shape.lineTo(half, depth - r); shape.quadraticCurveTo(half, depth, half - r, depth)
    shape.lineTo(-half + r, depth); shape.quadraticCurveTo(-half, depth, -half, depth - r)
  }
  shape.lineTo(-half, r); shape.quadraticCurveTo(-half, 0, -half + r, 0)
  return shape
}
function addPanel(group, shape) {
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 10 })
  geometry.translate(0, 0, -thickness / 2)
  const mesh = new THREE.Mesh(geometry, paper)
  mesh.castShadow = mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}
function buildModel() {
  model.remove(lidPivot)
  disposeGroup(model)
  disposeGroup(lidPivot)
  model.add(lidPivot)
  addBox(model, L, thickness, W, 0, thickness / 2, 0)
  addBox(model, L, H, thickness, 0, H / 2 + thickness, W / 2 - thickness / 2)
  addBox(model, L, H, thickness, 0, H / 2 + thickness, -W / 2 + thickness / 2)
  addBox(model, W - 2 * thickness, H, thickness, -L / 2 + thickness / 2, H / 2 + thickness, 0, Math.PI / 2)
  addBox(model, W - 2 * thickness, H, thickness, L / 2 - thickness / 2, H / 2 + thickness, 0, Math.PI / 2)
  lidPivot.position.set(0, H + thickness, -W / 2 + thickness / 2)
  const lid = addPanel(lidPivot, panelShape(L, W - thickness, 0.55))
  lid.rotation.x = Math.PI / 2
  const tuck = new THREE.Group()
  tuck.position.z = W - thickness - 0.02
  const tongue = addPanel(tuck, panelShape(L * 0.82, Math.min(H * 0.42, W * 0.3), 0.5, true))
  tongue.rotation.x = Math.PI / 2
  lidPivot.add(tuck)
  tuck.visible = false
  const wings = []
  for (const side of [-1, 1]) {
    const wingWidth = Math.min(H * 0.78, L * 0.22)
    const shape = new THREE.Shape()
    shape.moveTo(0, 0); shape.lineTo(wingWidth - 0.45, 0); shape.quadraticCurveTo(wingWidth, 0, wingWidth, 0.45)
    shape.lineTo(wingWidth, H * 0.68); shape.lineTo(wingWidth * 0.72, H); shape.lineTo(0, H); shape.closePath()
    const wing = addPanel(lidPivot, shape)
    wing.rotation.x = Math.PI / 2
    wing.rotation.z = side * 0.035
    wing.position.set(side * (L / 2 - wingWidth), 0, W * 0.12)
    wing.visible = false
    wings.push({ mesh: wing, side })
  }
  return { wings, tuck }
}
let { wings, tuck } = buildModel()
window.__boxDebug = { model, lidPivot, wings, tuck }

const BASE_RX = -0.36
const BASE_RY = -0.48
let rx = BASE_RX, ry = BASE_RY, zoom = 1, dragging = null, opened = false
let lidAngle = 0, lidFrom = 0, lidTo = 0, lidStart = performance.now()
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
function fitCamera() {
  const span = Math.max(L, W, H)
  camera.position.set(span * 1.45, span * 1.2, span * 1.85)
  camera.lookAt(0, H * 0.42, 0)
  const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.length()
  zoom = Math.min(1, Math.min(host.clientWidth, host.clientHeight) / (viewHeight * 0.82))
}
fitCamera()
function render(now = performance.now()) {
  requestAnimationFrame(render)
  const t = Math.min(1, (now - lidStart) / 500)
  lidAngle = lidFrom + (lidTo - lidFrom) * ease(t)
  model.rotation.set(rx, ry, 0)
  model.scale.setScalar(zoom)
  lidPivot.rotation.x = lidAngle
  if (lidAngle === 0) { lidPivot.children.forEach((child, index) => { child.visible = index === 0 }); tuck.visible = false; wings.forEach(({ mesh }) => { mesh.visible = false }) }
  const openAmount = Math.min(1, Math.abs(lidAngle) / (Math.PI / 2))
  const merge = 1 - openAmount
  tuck.rotation.x = -merge * Math.PI / 2
  tuck.position.z = (W - thickness - 0.02) * (1 - merge) + (W / 2 - thickness) * merge
  tuck.position.y = -H * 0.45 * merge
  tuck.visible = false
  wings.forEach(({ mesh, side }) => { mesh.rotation.z = side * (0.035 - merge * (Math.PI / 2 - 0.035)); mesh.position.z = W * (0.12 - merge * 0.08); mesh.visible = true; mesh.scale.setScalar(Math.max(0.001, openAmount)) })
  renderer.render(scene, camera)
}
render()
function resize() {
  const width = host.clientWidth, height = host.clientHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  fitCamera()
}
new ResizeObserver(resize).observe(host)
resize()
function updateSize(length, width, height) {
  if (![length, width, height].every((value) => Number.isFinite(value) && value >= 1)) return
  L = length; W = width; H = height
  ({ wings, tuck } = buildModel()); fitCamera()
  document.querySelector('.hud b').textContent = `外尺寸约 ${(L + 0.1).toFixed(1)} × ${(W + 0.45).toFixed(1)} × ${(H + 0.1).toFixed(1)} cm`
  document.querySelector('.dims').textContent = `刀版输入 ${L.toFixed(1)} × ${W.toFixed(1)} × ${H.toFixed(1)} cm`
  lidAngle = opened ? -Math.PI / 2 : 0; lidFrom = lidTo = lidAngle; lidStart = performance.now()
}
document.querySelector('#dimensions').addEventListener('submit', (event) => {
  event.preventDefault()
  const data = new FormData(event.currentTarget)
  updateSize(Number(data.get('length')), Number(data.get('width')), Number(data.get('height')))
})
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.controls')) return
  dragging = { x: event.clientX, y: event.clientY, rx, ry }
  renderer.domElement.setPointerCapture(event.pointerId)
})
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!dragging) return
  rx = Math.max(-0.85, Math.min(0.35, dragging.rx - (event.clientY - dragging.y) * 0.008))
  ry = dragging.ry + (event.clientX - dragging.x) * 0.009
})
renderer.domElement.addEventListener('pointerup', () => { dragging = null })
renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault()
  zoom = Math.max(0.5, Math.min(1.6, zoom * Math.exp(-event.deltaY * 0.0015)))
}, { passive: false })
document.querySelector('#lid').addEventListener('click', (event) => {
  opened = !opened; lidFrom = lidAngle; lidTo = opened ? -Math.PI / 2 : 0; lidStart = performance.now()
  event.currentTarget.textContent = opened ? '合上盒盖' : '打开盒盖'
})
document.querySelector('#reset').addEventListener('click', () => { rx = BASE_RX; ry = BASE_RY; opened = false; lidFrom = lidAngle; lidTo = 0; lidStart = performance.now(); document.querySelector('#lid').textContent = '打开盒盖'; fitCamera() })
