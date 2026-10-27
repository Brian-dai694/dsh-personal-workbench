/**
 * 回归守卫（2026-10-23 首次，2026-10-27 补齐）：弹窗/浮层被 portal 出面板子树，
 * 一旦令牌只挂在面板根节点上，那些浮层里所有 var(--wb-*) 取不到值 →
 * 内边距/间距/圆角/阴影整条声明被浏览器丢弃（真实发生过：弹窗挤成一团）。
 *
 * 2026-10-27 的补充：上一版只盯了 `.wb-overlay / .wb-dock / .wb-dialog`。
 * 但 `ModelPicker` / `TagFilter` / `IdeaCardGrid` / `ToastHost` 走的是
 * `createPortal(menu, overlayMountContainer())`，落点是 `[data-shell-overlay]` 或
 * `document.body` —— 与面板是**兄弟节点**，同样继承不到令牌。历史上它们只能写死
 * 字面阴影，正是因为漏在了作用域外。这四条现在一起盯。
 *
 * ⚠️ 断言前必须先**剥掉注释**：令牌块上方那段说明文字里就写着这些类名，
 * 不剥的话选择器匹配会把注释一起吞进去，测试变成永远通过的空断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKBENCH_CSS } from '../lib/client/styles.js'
import { Z_LAYERS } from '../lib/client/entryContract.js'

/** 所有会 portal 出去、因而必须自己带上令牌层的根节点。 */
const PORTAL_ROOTS = [
  '.wb-overlay',
  '.wb-dock',
  '.wb-dialog',
  '.wb-modal-mask',
  '.wb-model-menu',
  '.wb-tagmenu',
  '.wb-idea-foldmenu',
  '.wb-toasts',
]

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function tokenScopeSelector() {
  const css = stripComments(WORKBENCH_CSS)
  const match = css.match(/\[data-dsh-personal-workbench-view\][^{]*\{[^}]*--wb-accent/)
  assert.ok(match, '找不到令牌层选择器（`[data-...-view] … { --wb-accent … }`）')
  return match[0].slice(0, match[0].indexOf('{'))
}

test('portal 出去的浮层根节点必须拿到 --wb-* 令牌', () => {
  const selector = tokenScopeSelector()
  for (const portalRoot of PORTAL_ROOTS) {
    assert.ok(
      selector.includes(portalRoot),
      `令牌层选择器缺少 ${portalRoot}：该浮层 portal 出去后 var(--wb-*) 会失效（阴影/间距整条丢）。` +
      `当前选择器：${selector.replace(/\s+/g, ' ').trim()}`
    )
  }
})

test('弹窗关键布局规则引用的令牌，在 portal 场景下也有值', () => {
  // 抽查三条：内边距、圆角、投影阶梯。它们都只用 --wb-*，令牌缺失时会被整条丢弃
  assert.match(WORKBENCH_CSS, /\.wb-dialog-body\s*\{[^}]*padding:\s*var\(--wb-sp-6\)/)
  assert.match(WORKBENCH_CSS, /\.wb-dialog\s*\{[^}]*border-radius:\s*var\(--wb-r-4\)/)
  assert.match(WORKBENCH_CSS, /\.wb-dialog\s*\{[^}]*box-shadow:\s*var\(--wb-sh-5\)/)
})

/**
 * 投影阶梯（第三轮）：13 种外投影字面量收成 5 档。这条守的是"别又长出第 6 档"——
 * 一旦有人在 CSS 里直接写 `box-shadow: 0 3px 9px rgba(0,0,0,.2)`，令牌层就名存实亡。
 *
 * 判据：`box-shadow` 的值里出现**字面颜色**（`rgba(`）且不是 `inset` 起头 → 违规。
 * `inset …` 是状态条（左侧/底部标记条），是描边不是投影，单独一轮处理，这里放行。
 * 令牌定义本身写成 `--wb-sh-1: … rgba(…)`，不是 `box-shadow:` 声明，不会被误判。
 */
test('样式表里不得再出现字面外投影（只能用 --wb-sh-*）', () => {
  const css = stripComments(WORKBENCH_CSS)
  const violations = [...css.matchAll(/box-shadow\s*:\s*([^;{}]+)/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((v) => /rgba?\(/.test(v) && !v.startsWith('inset'))
  assert.deepEqual(violations, [],
    `这些 box-shadow 还在写字面投影，应该改用 --wb-sh-1..5：\n  - ${violations.join('\n  - ')}`)
})

/**
 * 状态语义色（第三轮）：琥珀 9 色、红 5 色、绿 3 色、信息蓝 2 色 —— 共 115 处字面值，
 * 收成 `--wb-warn/-warn-ink`、`--wb-danger/-danger-ink`、`--wb-ok/-ok-ink`、
 * `--wb-info`、`--wb-neutral`。
 *
 * 这条守卫只允许这些色号出现在**令牌定义行**（属性名以 `--wb-` 开头）。
 * 别处再随手写 `color: #f5b83d`，就等于绕过整套语义层、重新长出第 10 种琥珀。
 */
const STATUS_HEXES = [
  '#f5b83d', '#e74c3c', '#2e9b7b', '#8fa8c8', '#8a9aa8',
  '#9a6b12', '#c24a3f', '#1f7a5c', '#b4552f', '#2e6e9b',
]

/**
 * 层级阶梯（round7）：`z-index` 从散落的 12 个数字收成 `Z_LAYERS` 具名表（`entryContract.ts`）。
 *
 * 数值是**冻结**的，所以这两条测试守的不是"数字好不好看"，而是：
 *   1. 层与层之间的**顺序约束**（谁必须压住谁）—— 这是"看得见点不到"事故的唯一防线；
 *   2. 层值不许再写成裸数字 —— 否则下一个人又会在某个角落里塞 `z-index: 999`。
 */
test('层级阶梯：顺序必须满足这几条硬约束', () => {
  const z = (name) => Z_LAYERS[`z-${name}`]
  for (const name of ['sticky', 'actions', 'panel', 'content', 'popover', 'dialog', 'dock', 'dialog-mask', 'toast', 'scrim', 'top']) {
    assert.equal(typeof z(name), 'number', `Z_LAYERS 里缺少 z-${name}`)
  }
  assert.ok(z('content') > z('panel'), '面板内容节点必须压住面板宿主')
  assert.ok(z('popover') >= z('content'), '面板内浮层至少要在内容节点同层（DOM 在后才算压住）')
  assert.ok(z('actions') < z('panel'), '详情操作条是面板内部 sticky，不该跑到面板宿主之上')
  assert.ok(z('sticky') < z('actions'), '统计条 sticky 要低于详情操作条（后者是后出现的粘性条）')
  assert.ok(z('dialog') > z('popover'), '对话框遮罩必须压住面板内的一切浮层')
  assert.ok(z('dock') > z('dialog'), 'dock 要压住普通对话框遮罩')
  assert.ok(z('dialog-mask') > z('dock'), '对话框内二级遮罩要压住 dock')
  assert.ok(z('scrim') > z('dialog-mask'), '点外面关掉的透明层要在二级遮罩之上')
  assert.ok(z('top') > z('scrim'), '顶层浮层（模型菜单）要压住 scrim，否则点不到')
})

test('层值不许再写裸数字（表格内堆叠的 1/2/3 除外，且必须写明理由）', () => {
  const css = stripComments(WORKBENCH_CSS)
  const ALLOWED_BARE = new Set(['1', '2', '3', 'auto']) // 1/2/3 = 表格内堆叠；auto = 作用域内重置
  const offenders = []
  for (const match of css.matchAll(/z-index\s*:\s*([^;}]+)/g)) {
    const value = match[1].trim()
    if (ALLOWED_BARE.has(value)) continue
    if (/^var\(\s*--wb-z-[a-z0-9-]+\s*\)$/.test(value)) continue
    offenders.push(value)
  }
  assert.deepEqual(offenders, [],
    `这些 z-index 还在写裸值，应改用 Z_LAYERS 里的 --wb-z-*：\n  - ${offenders.join('\n  - ')}`)
})

test('状态语义色只允许出现在令牌定义行（别处一律 var(--wb-*)）', () => {
  const css = stripComments(WORKBENCH_CSS)
  const offenders = []
  // 属性名要允许数字：`--wb-prio-p1-bg` 这类名字里带 1/2，用 [a-z-]+ 会从 "-bg" 开始截断
  for (const match of css.matchAll(/(--?[a-z0-9-]+)\s*:\s*([^;{}]*)/g)) {
    const [, prop, value] = match
    if (prop.startsWith('--wb-')) continue // 令牌定义行：这里本来就该是字面色
    const lower = value.toLowerCase()
    for (const hex of STATUS_HEXES) {
      if (lower.includes(hex)) { offenders.push(`${prop}: ${value.replace(/\s+/g, ' ').trim()}`); break }
    }
  }
  assert.deepEqual(offenders, [],
    `这些声明还在用状态色的字面色，应改用 --wb-warn / --wb-danger / --wb-ok / --wb-info / --wb-neutral：\n  - ${offenders.join('\n  - ')}`)
})
