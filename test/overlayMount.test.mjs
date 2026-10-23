/**
 * issue #14：浮层挂载点回归。
 *
 * 两层判据：
 * 1. **纯决策表**：宿主 overlay 层带 transform/filter/contain/will-change 时**必须退回 body**
 *    （否则 fixed 后代的包含块变了，弹窗会漂到错误位置）；
 * 2. **源码扫描**：六个 portal 调用点必须统一走 `overlayMountContainer()`，
 *    不许再有 `createPortal(..., document.body)` 的裸挂载（那就是本 issue 的根因）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { read, stripComments } from './_clientSources.mjs'
import { shouldMountOnOverlayHost, SHELL_OVERLAY_SELECTOR } from '../lib/client/overlayMount.js'

function facts(overrides = {}) {
  return {
    connected: true,
    inBody: true,
    display: 'block',
    transform: 'none',
    filter: 'none',
    perspective: 'none',
    contain: 'none',
    willChange: 'auto',
    ...overrides,
  }
}

test('overlay 挂载决策：干净宿主才用，任何会改变 fixed 包含块的事实都退回 body', () => {
  assert.equal(SHELL_OVERLAY_SELECTOR, '[data-shell-overlay]')
  assert.equal(shouldMountOnOverlayHost(facts()), true)
  assert.equal(shouldMountOnOverlayHost(facts({ connected: false })), false, '已脱离文档')
  assert.equal(shouldMountOnOverlayHost(facts({ inBody: false })), false, '不在 body 里')
  assert.equal(shouldMountOnOverlayHost(facts({ display: 'none' })), false, '当前不可见')
  assert.equal(shouldMountOnOverlayHost(facts({ transform: 'matrix(1,0,0,1,0,0)' })), false, 'transform 会成为包含块')
  assert.equal(shouldMountOnOverlayHost(facts({ filter: 'blur(2px)' })), false, 'filter 会成为包含块')
  assert.equal(shouldMountOnOverlayHost(facts({ perspective: '1000px' })), false, 'perspective 会成为包含块')
  assert.equal(shouldMountOnOverlayHost(facts({ contain: 'paint' })), false, 'contain 会成为包含块')
  assert.equal(shouldMountOnOverlayHost(facts({ willChange: 'transform, opacity' })), false, 'will-change 预声明')
  assert.equal(shouldMountOnOverlayHost(facts({ willChange: 'opacity' })), true, '只改 opacity 不影响 fixed 包含块')
})

test('六个 portal 调用点统一走 overlayMountContainer，不再裸挂 document.body（issue #14 根因）', () => {
  const files = [
    'src/client/components/Modal.tsx',
    'src/client/components/ModelPicker.tsx',
    'src/client/components/LocalDocModal.tsx',
    'src/client/components/Toast.tsx',
    'src/client/components/TagFilter.tsx',
    'src/client/components/IdeaCardGrid.tsx',
  ]
  const offenders = []
  for (const file of files) {
    const source = stripComments(read(file))
    if (source.includes('overlayMountContainer') === false) offenders.push(`${file}: 没有走 overlayMountContainer`)
    if (/createPortal\([^)]*document\.body/.test(source)) offenders.push(`${file}: 仍有裸挂 document.body`)
  }
  assert.deepEqual(offenders, [])
})
