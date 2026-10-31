import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('../src/client/views/AmazonToolsView.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
const model = readFileSync(new URL('../src/client/components/PackageBoxThree.tsx', import.meta.url), 'utf8')
const panelStart = view.indexOf('function PackageCalculatorPanel(')
const panelEnd = view.indexOf('\nfunction Field(', panelStart)
const panel = view.slice(panelStart, panelEnd)
const cssStart = styles.indexOf('.wb-package-layout')
const cssEnd = styles.indexOf('/* 关键词库', cssStart)
const packageCss = styles.slice(cssStart, cssEnd)

test('Three.js 刀版预览接入包裹测算并保留可见厚度参数', () => {
  assert.match(panel, /<PackageBoxThree /)
  assert.match(model, /const BOARD_CM = 0\.3/)
  assert.match(model, /DEFAULT_SIZE_CM = \{ length: 31\.5, width: 20\.2, height: 6\.2 \}/)
  assert.match(model, /const L = valid \? Math\.max\(1, inputL\)/)
  assert.match(model, /const W = valid \? Math\.max\(1, inputW\)/)
  assert.match(model, /const H = valid \? Math\.max\(1, inputH\)/)
  assert.match(model, /WebGL 不可用/)
})

test('包裹计算保留尺寸、重量、计费输入和结果展示', () => {
  for (const field of ['length', 'width', 'height']) assert.ok(panel.includes(`'${field}'`), `保留 ${field} 输入`)
  assert.match(panel, /<h4>尺寸<\/h4>/)
  assert.match(panel, /<h4>重量<\/h4>/)
  assert.match(panel, /<h4>计费参数<\/h4>/)
  assert.match(panel, /calculatePackage/)
  assert.match(panel, /wb-package-fee-head/)
  assert.match(panel, /result\.shippingFee/)
  assert.match(panel, /result\.totalShippingFee/)
  assert.match(panel, /result\.monthlyStorageFee/)
  assert.match(panel, /result\.warnings\.map/)
})

test('包装和外箱参数统一显式保存并在下次打开时恢复', () => {
  assert.match(view, /const PACKAGE_STORAGE_KEY = 'dsh-workbench-amazon-package-v1'/)
  assert.match(view, /function loadPackageInput\(\)/)
  assert.match(view, /function loadCartonOuter\(\)/)
  assert.match(view, /localStorage\.setItem\(PACKAGE_STORAGE_KEY, JSON\.stringify\(packageInput\)\)/)
  assert.match(view, /localStorage\.setItem\(CARTON_STORAGE_KEY, JSON\.stringify\(cartonOuter\)\)/)
  assert.match(view, /保存所有参数/)
  assert.match(view, /保存失败：浏览器存储不可用/)
  const updateCarton = view.slice(view.indexOf('function updateCartonOuter('), view.indexOf('\n  function update(', view.indexOf('function updateCartonOuter(')))
  assert.doesNotMatch(updateCarton, /localStorage\.setItem/)
})

test('包裹计算面板与样式不再包含 3D 纸盒或交互残留', () => {
  assert.doesNotMatch(panel, /wb-package-visual|wb-package-box|wb-package-cube|wb-package-airmail/)
  assert.doesNotMatch(panel, /visualScale|rotation|isFolded|dragRef|suppressClickRef|handlePointer|handleBoxKeyDown/)
  assert.doesNotMatch(packageCss, /wb-package-visual|wb-package-box|wb-package-cube|wb-package-airmail|wb-package-zoom-controls/)
})

test('删除预览不影响包裹输入、费用和指标样式', () => {
  for (const selector of ['.wb-package-layout', '.wb-package-inputs', '.wb-package-results', '.wb-package-dimension-grid', '.wb-package-inline-grid', '.wb-package-fee-head', '.wb-package-metrics', '.wb-package-alerts']) {
    assert.ok(packageCss.includes(selector), `保留 ${selector}`)
  }
})

test('窄容器 560px 内单列，面板和指标保持可收缩', () => {
  assert.match(packageCss, /@container wb-calc \(max-width: 560px\)\s*\{[^}]*\.wb-package-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/s)
  assert.match(packageCss, /\.wb-package-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, \.86fr\) minmax\(0, 1\.14fr\)/s)
  assert.match(packageCss, /\.wb-package-fee-head\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(packageCss, /\.wb-package-fee-head strong\s*\{[^}]*overflow-wrap:\s*anywhere/s)
})
