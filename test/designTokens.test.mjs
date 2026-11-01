/**
 * 视觉三件套的守卫（2026-11-01 用户定案）：
 *
 *   1. **圆角 = 短边 × 18%** —— 方得看清边界、圆得够轻的平衡点；
 *   2. **间距横向 16 / 纵向 24，两个方向严格分开** —— 错落感才有呼吸；
 *   3. **画布与卡片差一档灰度** —— 卡片才浮得起来。
 *
 * 为什么值得写死：这三条一旦被"顺手改回 8px 圆角、12px 四向 padding、纯白卡片"，
 * 观感会悄悄退回原样，而没人会为此报错。测试盯的是**口径**，不是像素值本身：
 * 圆角只要还是"短边 × 18%"的表达式，短边从 28 调到 32 不算违规。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKBENCH_CSS } from '../lib/client/styles.js'

const css = WORKBENCH_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 按选择器取第一条规则体（本仓库的规则都是单层，够用）。
 * 选择器必须**作为一条规则的开头**（行首或逗号后）出现，
 * 否则 `.wb-dialog` 会先命中 `.wb-dock > .wb-dialog` 那种组合选择器。
 */
function body(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`))
  return match === null ? null : match[1]
}

/** 3D 包装示意图里的圆角是**画出来的几何**（箱盖折片、阴影），不是 UI 组件圆角。 */
const ILLUSTRATION = /\.wb-(pkg3d|carton3d)-/

test('圆角：四个刻度都是「短边 × 18%」的比例表达式', () => {
  const scale = {
    '--wb-r-1': /calc\(24px \* \.18\)/,
    '--wb-r-2': /calc\(var\(--wb-ctl-h\) \* \.18\)/,
    '--wb-r-3': /calc\(40px \* \.18\)/,
    '--wb-r-4': /calc\(56px \* \.18\)/,
  }
  for (const [token, expected] of Object.entries(scale)) {
    const decl = css.match(new RegExp(`${token}:\\s*([^;]+);`))
    assert.ok(decl !== null, `缺少圆角刻度 ${token}`)
    assert.match(decl[1], expected, `${token} 必须写成「短边 × 18%」的比例表达式，而不是观感像素值`)
  }
  // 大面板短边可达数百像素：同一比例 + 封顶，别让对话框变成球角
  assert.match(css, /--wb-r-card:\s*min\(calc\(120px \* \.18\), 24px\)/)
  assert.match(css, /--wb-r-sheet:\s*min\(calc\(240px \* \.18\), 28px\)/)
})

test('圆角：卡片与对话框吃到各自档位，不许再出现字面圆角', () => {
  assert.match(body('.wb-card') ?? '', /border-radius:\s*var\(--wb-r-card\)/)
  assert.match(body('[data-dsh-personal-workbench-view] .wb-card') ?? '', /border-radius:\s*var\(--wb-r-card\)/)
  assert.match(body('.wb-stat') ?? '', /border-radius:\s*var\(--wb-r-card\)/)
  assert.match(body('.wb-dialog') ?? '', /border-radius:\s*var\(--wb-r-sheet\)/)
  assert.match(body('.wb-modal') ?? '', /border-radius:\s*var\(--wb-r-sheet\)/)

  const allowed = new Set(['999px', '50%', '0'])
  const violations = [...css.matchAll(/([^{}]*)\{([^{}]*border-radius:\s*([^;{}]+);)/g)]
    .map((m) => ({ selector: m[1].trim().split('\n').pop().trim(), value: m[3].trim() }))
    .filter((item) => !item.value.startsWith('var('))
    .filter((item) => !allowed.has(item.value))
    .filter((item) => !ILLUSTRATION.test(item.selector))
  assert.deepEqual(violations, [],
    `这些圆角还是字面值，应改用 --wb-r-* 刻度：\n  - ${violations.map((v) => `${v.selector}: ${v.value}`).join('\n  - ')}`)
})

/**
 * 「横竖有别」（用户 2026-11-01 给的图）：
 *   横向 —— 多列卡片左右**一律 16**，不允许例外，「组合感」全靠这个固定值；
 *   纵向 —— **灵活取 16 或 24**：同一列卡片上下 16，分区之间 24，「分层感」来自这一档之差。
 *
 * 所以判据不是"纵向必须是 24"，而是"横向只能是 16，纵向只能在 16/24 这两档里选"，
 * 而且要**两个方向分开写**（一个 gap 管两方向的写法已经全部拆掉）。
 */
test('间距：横向严格 16，纵向只允许 16 或 24（两档都要真有使用）', () => {
  assert.match(css, /--wb-space-x:\s*16px/, '横向令牌必须是 16')
  assert.match(css, /--wb-space-y-tight:\s*16px/, '纵向紧档必须是 16')
  assert.match(css, /--wb-space-y:\s*24px/, '纵向松档必须是 24')

  /** 纵向上出现过的值：只许这两档，第三档一律违规。 */
  const vertical = [...css.matchAll(/(?:row-gap|margin-bottom|margin-top|margin):\s*var\((--wb-space-y[^)]*)\)/g)].map((m) => m[1])
  const offenders = vertical.filter((token) => token !== '--wb-space-y' && token !== '--wb-space-y-tight')
  assert.deepEqual(offenders, [], `纵向间距出现了第三档：${offenders.join(', ')}`)
  assert.ok(vertical.includes('--wb-space-y'), '24 这一档必须真的在用（分区之间）')
  assert.ok(vertical.includes('--wb-space-y-tight'), '16 这一档必须真的在用（同一列卡片）')

  const surfaces = [
    '.wb-card', '.wb-stat', '.wb-banner', '.wb-empty',
    '[data-dsh-personal-workbench-view] .wb-card',
    '[data-dsh-personal-workbench-view] .wb-stat',
    '[data-dsh-personal-workbench-view] .wb-cap',
    '[data-dsh-personal-workbench-view] .wb-folder',
    '.wb-dialog-body',
  ]
  for (const selector of surfaces) {
    const rule = body(selector)
    assert.ok(rule !== null, `找不到 ${selector} 的样式`)
    assert.match(rule, /padding:\s*var\(--wb-space-(?:y|y-tight)\)\s*var\(--wb-space-x\)/,
      `${selector} 的内边距必须是「纵向 16 或 24 / 横向 16」，且两个方向分开写`)
    assert.doesNotMatch(rule, /padding:[^;]*var\(--wb-sp-/, `${selector} 的横向间距不许退回行内细刻度`)
  }
})

test('间距：同一列卡片用 16 收拢，分区之间才用 24', () => {
  for (const selector of ['.wb-card', '.wb-form-panel', '[data-dsh-personal-workbench-view] .wb-card', '[data-dsh-personal-workbench-view] .wb-cap']) {
    const rule = body(selector)
    assert.ok(rule !== null, `找不到 ${selector} 的样式`)
    assert.match(rule, /margin-bottom:\s*var\(--wb-space-y-tight\)/, `${selector} 与下一块的间距必须是 16（同一列卡片）`)
  }
})

test('间距：页面级网格用 column-gap / row-gap 分开，横向只能是 16', () => {
  const gridRowGap = new Map([
    // 页面模块之间用 section（40，苹果口径的"留白撑场面"）；网格内的卡片族仍是 tight（16）
    ['.wb-dash', '--wb-space-section'],
    ['.wb-dash-domains', '--wb-space-y-tight'],
    ['.wb-amazon-layout', '--wb-space-y-tight'],
    ['.wb-package-layout', '--wb-space-y-tight'],
    ['.wb-settings', '--wb-space-y-tight'],
    ['.wb-form', '--wb-space-y-tight'],
  ])
  for (const [selector, expectedRowGap] of gridRowGap) {
    const rule = body(selector)
    assert.ok(rule !== null, `找不到 ${selector} 的样式`)
    assert.match(rule, /column-gap:\s*var\(--wb-space-x\)/, `${selector} 的横向间距必须是 16`)
    assert.match(rule, new RegExp(`row-gap:\\s*var\\(${expectedRowGap}\\)`), `${selector} 的纵向间距档位不对`)
    assert.doesNotMatch(rule, /(?:^|;)\s*gap:/, `${selector} 不许再用单个 gap 同时管两个方向`)
  }
})

test('底色：画布比卡片低一档，且两者都从宿主底色派生', () => {
  const canvas = css.match(/--wb-canvas:\s*([^;]+);/)
  assert.ok(canvas !== null, '缺少 --wb-canvas（画布色）')
  assert.match(canvas[1], /light-dark\(color-mix\(in srgb, var\(--wb-bg-base\) 96%, var\(--wb-ink-1\)\), var\(--wb-bg-base\)\)/,
    '画布必须由宿主底色混出一档灰，而不是另挑一个色号')
  assert.doesNotMatch(canvas[1], /#[0-9a-fA-F]{3,8}/, '画布里不许出现自造色号（宿主换肤时会跟丢）')

  assert.match(body('.wb-app') ?? '', /background:\s*var\(--wb-canvas\)/, '页面底色必须是画布')
  assert.match(body('[data-dsh-personal-workbench-view] .wb-card') ?? '', /background:\s*var\(--wb-surface\)/, '卡片底色必须是 surface')
  assert.match(css, /--wb-surface:\s*var\(--wb-bg-layer-1\)/, 'surface 必须仍指向宿主的卡片层，不要自己造白')
})
