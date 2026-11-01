/**
 * 视觉系统的"可抄值"守卫（2026-11-01）：
 *   ① 颜色：画布/卡片/文字/语义色都是宿主令牌派生，且**量化表在文档里能查到**；
 *   ② 三大规则：留白（横 16 / 纵 16 或 24）、字重四档、过渡四档 + 两条缓动；
 *   ③ 字体搭配：Inter 管拉丁、思源黑体管中文，字重档位对齐（含 VF 说明）。
 *
 * 这些值写死在文档里没用 —— 必须有测试钉住"代码里真的只剩这几档"，
 * 否则半年后又会冒出 550 / 650 与第 13 种 transition 时长。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WORKBENCH_CSS } from '../lib/client/styles.js'

const css = WORKBENCH_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const CONTRACT = readFileSync(new URL('../src/client/entryContract.ts', import.meta.url), 'utf8')
const DOC = readFileSync(new URL('../docs/design/dsh-visual-system.md', import.meta.url), 'utf8')

test('字体：Inter 管拉丁、思源黑体管中文，等宽另起一条栈', () => {
  const font = CONTRACT.match(/const FONT_FAMILY = '([^']+)'/)
  assert.ok(font !== null, '找不到 FONT_FAMILY')
  const stack = font[1]
  const order = ['"Inter"', '"Source Han Sans SC"', '"Noto Sans SC"', '"PingFang SC"', 'system-ui', 'sans-serif']
  let cursor = -1
  for (const family of order) {
    const at = stack.indexOf(family)
    assert.ok(at > cursor, `字体栈顺序不对：${family} 必须在上一项之后（拉丁 → 中文 → 系统兜底）`)
    cursor = at
  }
  const mono = CONTRACT.match(/const FONT_MONO = '([^']+)'/)
  assert.ok(mono !== null, '缺少等宽字体栈 FONT_MONO')
  assert.ok(mono[1].startsWith('ui-monospace'), `等宽栈必须以 ui-monospace 起头：${mono[1]}`)
  assert.match(CONTRACT, /--wb-font-mono: \$\{FONT_MONO\}/, '等宽栈必须真的被输出成 --wb-font-mono')
  assert.match(CONTRACT, /--wb-font: var\(--dsw-font-family, /, '宿主给了字体就以宿主为准')
})

test('字重：只剩四档，且 CSS 里不再出现裸数字', () => {
  const scale = { '--wb-fw-body': '400', '--wb-fw-emphasis': '500', '--wb-fw-heading': '600', '--wb-fw-display': '700' }
  for (const [token, value] of Object.entries(scale)) {
    assert.match(css, new RegExp(`${token}:\\s*${value};`), `缺少字重令牌 ${token}: ${value}`)
  }
  const bare = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1])
  assert.deepEqual(bare, [], `这些 font-weight 还在写裸数字（只允许 var(--wb-fw-*)）：${bare.join(', ')}`)
  /** 半档（550 / 650）不允许再出现：两套字体里都分辨不出来，只会让层级变糊 */
  assert.doesNotMatch(css, /--wb-fw-\w+:\s*5?50;/, '550 不许成为令牌')
  assert.doesNotMatch(css, /font-weight:\s*(550|650)/, '550 / 650 一律归并到 500 / 600')
})

test('留白与行高：横 16 / 纵 16 或 24，行高三档', () => {
  assert.match(css, /--wb-space-x:\s*16px/)
  assert.match(css, /--wb-space-y-tight:\s*16px/)
  assert.match(css, /--wb-space-y:\s*24px/)
  for (const [token, value] of Object.entries({ '--wb-lh-tight': '1.35', '--wb-lh-snug': '1.45', '--wb-lh-body': '1.6', '--wb-lh-meta': '1.75' })) {
    assert.match(css, new RegExp(`${token}:\\s*${value.replace('.', '\\.')}`), `缺少行高令牌 ${token}`)
  }
  for (const [token, value] of Object.entries({ '--wb-fs-1': '12px', '--wb-fs-2': '13px', '--wb-fs-3': '14px', '--wb-fs-4': '16px', '--wb-fs-5': '20px', '--wb-fs-6': '24px' })) {
    assert.match(css, new RegExp(`${token}:\\s*${value}`), `字号刻度 ${token} 必须是 ${value}`)
  }
})

test('过渡：四档时长 + 两条缓动，位移用 --wb-dur-3', () => {
  for (const [token, value] of Object.entries({ '--wb-dur-1': '120ms', '--wb-dur-2': '180ms', '--wb-dur-3': '260ms', '--wb-dur-4': '320ms' })) {
    assert.match(css, new RegExp(`${token}:\\s*${value};`), `缺少时长令牌 ${token}`)
  }
  assert.match(css, /--wb-ease-standard:\s*cubic-bezier\(\.4, 0, \.2, 1\)/)
  assert.match(css, /--wb-ease-enter:\s*cubic-bezier\(\.2, \.8, \.2, 1\)/)
  /**
   * 域页签 2026-11-01 改成"六项统一 pill"后不再有位移动画（底部指示条已删），
   * 位移动画只剩日历的选中块：它必须吃 --wb-dur-3，不许再写裸时长。
   */
  assert.match(css, /\.wb-cal-tabs::before\s*\{[^}]*var\(--wb-dur-3\)/)
  assert.doesNotMatch(css, /\.wb-tabs-primary::after/, '域页签的底部指示条已取消')
})

test('颜色：画布/卡片/语义色都是派生值，量化表在文档里', () => {
  assert.match(css, /--wb-canvas:\s*light-dark\(color-mix\(in srgb, var\(--wb-bg-base\) 96%, var\(--wb-ink-1\)\)/)
  assert.match(css, /--wb-surface:\s*var\(--wb-bg-layer-1\)/)
  assert.match(css, /--wb-warn-ink:\s*light-dark\(color-mix\(in srgb, var\(--wb-warn\) 50%, #27241f\)/)
  // 文档里必须能查到具体色值，否则"量化"只是口号
  for (const hex of ['#F5F5F6', '#FFFFFF', '#0F1115', '#61666B', '#4176E6', '#EC1313', '#F59E0B', '#22C55E']) {
    assert.ok(DOC.includes(hex), `视觉文档缺少量化色值 ${hex}`)
  }
  for (const kw of ['--wb-fw-heading', '--wb-space-y-tight', '--wb-dur-3', 'Source Han Sans SC', 'Noto Sans SC', '可变字体']) {
    assert.ok(DOC.includes(kw), `视觉文档缺少 ${kw} 的口径说明`)
  }
})

/**
 * 2026-11-01 第二轮：界面排版的三条要求（层级落差 / 呼吸感 / 基准线）。
 * 判据都落在"这两层之间是否有尺寸+字重的差"和"间距是否都在 4px 网格上"，
 * 而不是"某个 class 看起来好看"。
 */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`))
  return match === null ? null : match[1]
}

/** 同一选择器可能有多条规则（基准 + 皮肤层覆盖）：只要有一条声明了就满足。 */
function hasDecl(selector, pattern) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const all = [...css.matchAll(new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`, 'g'))]
  return all.some((match) => pattern.test(match[1]))
}

test('① 层级落差：四档尺寸 + 字重成对出现，正文/元信息只再降颜色一档', () => {
  // 四档字号必须是 16 / 14 / 13 / 12，相邻差 1 档（16 是面板标题，往下每档只掉 1–2px）
  assert.match(css, /--wb-type-panel:\s*var\(--wb-fs-4\)/)
  assert.match(css, /--wb-type-card:\s*var\(--wb-fs-3\)/)
  assert.match(css, /--wb-type-body:\s*var\(--wb-fs-2\)/)
  assert.match(css, /--wb-type-meta:\s*var\(--wb-fs-1\)/)
  for (const [token, value] of Object.entries({ '--wb-fs-1': '12px', '--wb-fs-2': '13px', '--wb-fs-3': '14px', '--wb-fs-4': '16px' })) {
    assert.match(css, new RegExp(`${token}:\\s*${value}`), `字号刻度 ${token} 不对`)
  }
  // 尺寸与字重必须同向递进：标题更重、正文更轻，颜色只在正文/元信息之间换
  const roles = [
    // 面板标题走"苹果大标题"口径：16px + Light 300（层级靠字号与重量反差，不靠加粗堆叠）
    ['.wb-title', '--wb-type-panel', '--wb-fw-light'],
    ['[data-dsh-personal-workbench-view] .wb-card h4', '--wb-type-card', '--wb-fw-heading'],
    ['.wb-row-title', '--wb-type-body', '--wb-fw-heading'],
    ['.wb-row-meta', '--wb-type-meta', '--wb-fw-body'],
  ]
  for (const [selector, sizeToken, weightToken] of roles) {
    assert.ok(
      hasDecl(selector, new RegExp(`font-size:\\s*var\\(${sizeToken}\\)`)),
      `${selector} 的字号应吃 ${sizeToken}`,
    )
    assert.ok(
      hasDecl(selector, new RegExp(`font-weight:\\s*var\\(${weightToken}\\)`)),
      `${selector} 的字重应吃 ${weightToken}`,
    )
  }
  // 正文与元信息用灰度降级（而不是缩到 11px 以下）
  assert.match(rule('.wb-row-meta') ?? '', /color:\s*var\(--wb-label-tertiary\)/)
  assert.match(rule('.wb-notes-body') ?? '', /color:\s*var\(--wb-ink-2\)/)
})

test('② 呼吸感：行距按版面三档、段距用同一个 16，长文限宽', () => {
  // 默认 1.6；窄面板 1.65（换行更频繁，要松）；宽面板 1.55（一行更长，要收）
  assert.match(css, /--wb-lh-body:\s*1\.6/)
  assert.match(css, /@container \(max-width: 560px\)\s*\{[^}]*--wb-lh-body:\s*1\.65/)
  assert.match(css, /@container \(min-width: 900px\)\s*\{[^}]*--wb-lh-body:\s*1\.55/)
  // 长文吃行距令牌与可读宽度；段与段之间用同一个呼吸值
  assert.match(rule('.wb-notes-body') ?? '', /line-height:\s*var\(--wb-lh-body\)/)
  assert.match(rule('.wb-notes-body') ?? '', /max-width:\s*var\(--wb-measure\)/)
  assert.match(css, /\.wb-notes-body p \+ p\s*\{\s*margin-top:\s*var\(--wb-gap-para\)/)
  assert.match(css, /--wb-gap-para:\s*var\(--wb-space-x\)/)
  assert.match(css, /--wb-measure:\s*68ch/)
})

test('③ 基准线：所有间距（含行内细刻度）都落在 4px 网格上，左右留白对称', () => {
  assert.match(css, /--wb-base:\s*4px/)
  /**
   * 2026-11-01 第二轮：行内细刻度也从 2/6/10 迁到 4/8/12（只动了令牌值，改了 380+ 处观感但不改引用）。
   * 现在**全部**间距令牌都必须是 4 的整数倍 —— 唯一例外是 0（无间距）。
   */
  const tokens = [...css.matchAll(/--wb-(sp-1|sp-2|sp-3|sp-4|sp-5|sp-6|sp-7|space-x|space-y|space-y-tight|space-section):\s*(\d+)px/g)]
    .map((m) => ({ token: m[1], value: Number(m[2]) }))
  assert.ok(tokens.length >= 9, `间距令牌太少（${tokens.length}），检查是否被改名`)
  const offGrid = tokens.filter((item) => item.value % 4 !== 0)
  assert.deepEqual(offGrid, [], `这些间距不落在 4px 网格上：${offGrid.map((i) => `${i.token}=${i.value}`).join(', ')}`)
  // 行内细刻度迁移后的具体值（写死是为了防止悄悄回退）
  assert.match(css, /--wb-sp-1:\s*4px/)
  assert.match(css, /--wb-sp-2:\s*8px/)
  assert.match(css, /--wb-sp-4:\s*12px/)
  // 左右留白对称：两栏容器的横向内边距都只用 space-x
  assert.match(rule('.wb-nav') ?? '', /padding:\s*0 var\(--wb-space-x\) var\(--wb-space-y\)/)
  assert.match(rule('.wb-detail') ?? '', /padding:\s*var\(--wb-space-y\) var\(--wb-space-x\)/)
})

/**
 * 2026-11-01 第三轮（苹果口径里能迁移的部分）：
 *   粗细极致对比（Light/Heavy 两端）、字越小行距越大、左文右数、数据区不画框线、
 *   半边换色、模块 40 留白。不能迁移的（40pt 正文、7% 文字、6–8% 页边距）写在文档里，
 *   这里只钉住"已落地的部分没有被悄悄改回去"。
 */
test('字重两端：Light / Heavy 存在，Light 只许配 ≥16px 的字号', () => {
  assert.match(css, /--wb-fw-light:\s*300;/)
  assert.match(css, /--wb-fw-heavy:\s*800;/)
  /**
   * Light 配小字在中文里会糊成虚线。阈值定在 **16px**（面板标题那一档）：
   * 12–14px 的正文/元信息一律常规字重，只有标题级才允许 300。
   */
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--wb-fw-light\)[^{}]*)\}/g)]
  for (const [, selector, body] of rules) {
    const size = (body.match(/font-size:\s*var\((--wb-fs-\d|--wb-type-panel|--wb-type-card)\)/) ?? [])[1]
    assert.ok(
      size === undefined || size === '--wb-fs-4' || size === '--wb-fs-5' || size === '--wb-fs-6' || size === '--wb-type-panel',
      `${selector.trim()} 用了 Light 300 但字号只有 ${String(size)}：Light 只允许配 16px 以上`,
    )
  }
  // 极细体真的用在面板标题上（苹果大标题做法），且窄版空间不足时回到常规字重
  assert.ok(hasDecl('.wb-title', /font-weight:\s*var\(--wb-fw-light\)/), '面板标题要用 Light 300')
  assert.ok(hasDecl('.wb-title', /font-size:\s*var\(--wb-type-panel\)/), '面板标题保持 16px（Light 的下限）')
  assert.ok(hasDecl('.wb-h .wb-title', /font-weight:\s*var\(--wb-fw-heading\)/), '窄版标题回到常规字重，不硬扛 Light')
})

test('字越小行距越大：12px 元信息 1.75，且真的吃到了令牌', () => {
  assert.match(css, /--wb-lh-meta:\s*1\.75;/)
  assert.ok(hasDecl('.wb-row-meta', /line-height:\s*var\(--wb-lh-meta\)/), '.wb-row-meta 要吃到元信息行距')
  assert.ok(hasDecl('.wb-amazon-footnote', /line-height:\s*var\(--wb-lh-meta\)/), '脚注要吃到元信息行距')
})

test('左文右数 + 数据区不画框线：数字 Heavy、标签浅灰细体、卡片去边框投影', () => {
  assert.ok(hasDecl('[data-dsh-personal-workbench-view] .wb-stat b', /font-weight:\s*var\(--wb-fw-heavy\)/), 'KPI 数字要 Heavy')
  assert.ok(hasDecl('[data-dsh-personal-workbench-view] .wb-stat b', /letter-spacing:\s*var\(--wb-ls-display\)/), '大数字要收紧字距')
  assert.ok(hasDecl('[data-dsh-personal-workbench-view] .wb-stat span', /line-height:\s*var\(--wb-lh-meta\)/), 'KPI 标签要吃到元信息行距')
  const statRule = rule('.wb-stat') ?? ''
  assert.match(statRule, /border:\s*0/, '数据区不画多余框线：KPI 卡片不应有边框')
  assert.doesNotMatch(statRule, /box-shadow/, '数据区不画多余框线：KPI 卡片不应有投影')
})

test('半边换色与模块留白：核心结论上色、页面模块之间 40', () => {
  assert.ok(hasDecl('.wb-amazon-result-head strong', /color:\s*var\(--wb-accent\)/), '核心结论要上强调色（半边换色）')
  assert.match(css, /--wb-space-section:\s*40px/)
  assert.ok(hasDecl('.wb-dash', /row-gap:\s*var\(--wb-space-section\)/), '页面模块之间用 40 留白')
})

/**
 * 模块化分区（2026-11-01 用户要求「使用卡片形式做模块化分区」）：
 * 平铺区块统一成卡片外壳，但**不许卡中卡** —— 已经是 .wb-card 的容器不再收录。
 */
test('模块化分区：平铺区块统一卡片外壳，且不含会形成"卡中卡"的容器', () => {
  const block = css.match(/\.wb-package-inputs,\n\.wb-package-results,[\s\S]*?margin-bottom: var\(--wb-space-y-tight\);/)
  assert.ok(block !== null, '缺少模块卡片块（.wb-package-inputs / .wb-package-results 起头的那组）')
  const text = block[0]
  for (const selector of ['.wb-package-inputs', '.wb-package-results', '.wb-pkg-records', '.wb-calc-scenarios', '.wb-amazon-result-pane', '.wb-oplog-group', '.wb-aba', '.wb-kw-analysis', '.wb-ai-summary', '.wb-settings > section']) {
    assert.ok(text.includes(selector), `${selector} 必须收录进模块卡清单`)
  }
  assert.match(text, /background:\s*var\(--wb-surface\)/, '模块卡用卡片底色')
  assert.match(text, /border:\s*0/, '模块卡不画框线（与 KPI 同口径）')
  assert.match(text, /border-radius:\s*var\(--wb-r-card\)/, '模块卡用卡片圆角')
  assert.match(text, /padding:\s*var\(--wb-space-y\) var\(--wb-space-x\)/, '模块卡内边距 24/16')
  assert.match(text, /box-shadow:\s*var\(--wb-sh-1\)/, '模块卡只有一档微投影')
  // .wb-amazon-tools 是页面容器，收进来就会出现"卡中卡"（它的子块已经是卡片）
  assert.ok(!text.includes('.wb-amazon-tools'), '页面容器不许再套一层卡片')
})

/**
 * 2026-11-01：亚马逊「CPC 盈亏 / 广告位出价 / 包裹运费 / 外箱装箱」四段标签条要**视觉对齐**——
 * 铺满内容宽度、四等分。以前是 width: max-content，标签条只到文字宽，右边接不上下面两栏内容。
 */
test('亚马逊计算模式：四段等分铺满，左右缘与内容网格对齐', () => {
  const bar = rule('.wb-amazon-mode') ?? ''
  assert.match(bar, /display:\s*flex/, '标签条要用 flex 才能等分')
  assert.match(bar, /width:\s*100%/, '标签条要铺满内容宽度')
  assert.doesNotMatch(bar, /width:\s*max-content/, '不再用内容宽度（那样右边永远对不齐）')
  const item = rule('.wb-amazon-mode .wb-seg') ?? ''
  assert.match(item, /flex:\s*1 1 0/, '四段必须等分')
  assert.match(item, /justify-content:\s*center/, '文字居中')
  assert.match(item, /min-height:\s*var\(--wb-ctl-h\)/, '与顶栏控件同高')
})

/**
 * 2026-11-01：CPC 盈亏 / 广告位出价 的**左右两栏内部**要视觉对齐。
 * 病根是左边是卡（边框 + 16 内边距）、右边是裸列（无内边距、首块自带 1px 外框），
 * 于是两栏首行基线与左右缘各差一截。判据：两栏必须共享同一套"卡几何"。
 */
test('亚马逊两栏内部对齐：左右同卡几何、结论双格不套框', () => {
  const pair = css.match(/\.wb-amazon-inputs,\s*\.wb-amazon-results \{([^}]*)\}/)
  assert.ok(pair !== null, '缺少两栏共享的卡片几何声明')
  const body = pair[1]
  assert.match(body, /padding:\s*var\(--wb-space-y\) var\(--wb-space-x\)/, '两栏内边距必须同为 24/16')
  assert.match(body, /border:\s*0/, '两栏都不画框线')
  assert.match(body, /border-radius:\s*var\(--wb-r-card\)/, '两栏同圆角')
  assert.match(body, /background:\s*var\(--wb-surface\)/, '两栏同为卡片底')
  assert.match(body, /box-shadow:\s*var\(--wb-sh-1\)/, '两栏同投影')
  // 纵向节奏一致
  assert.match(css, /\.wb-amazon-inputs \{ gap: var\(--wb-space-y-tight\) var\(--wb-space-x\); \}/)
  assert.match(css, /\.wb-amazon-results \{ gap: var\(--wb-space-y-tight\); \}/)
  // 首个子元素不许带外边距（否则首行错位）
  assert.match(css, /\.wb-amazon-inputs > :first-child,\s*\.wb-amazon-results > :first-child \{ margin-top: 0; \}/)
  // 结论双格在卡片里不再画自己的框与底
  assert.match(css, /\.wb-amazon-results \.wb-amazon-result-head \{[^}]*border: 0; background: transparent;/)
})

/**
 * 2026-11-01 第三轮：**栏内**对齐。
 * 输入框的提示（<small>USD / 件</small>）原本是块级、会换行，把该字段的输入框往下顶一行，
 * 同一行的两个输入框因此错位；右栏"结论双格"与"核对明细"也是两套几何（gap vs 1px 表格）。
 */
test('栏内对齐：提示与 label 同行、输入框回到同一 baseline、右栏两张表同一几何', () => {
  // 提示必须与 label 在同一行（flex + baseline），不许再 display:block 换行
  assert.match(css, /\.wb-amazon-field > span:first-child \{[^}]*display: flex;[^}]*align-items: baseline;/, 'label 行要 flex + baseline')
  assert.match(css, /\.wb-amazon-field small \{[^}]*display: inline; margin-top: 0;/, '提示改为行内，不再顶下一行')
  assert.match(css, /\.wb-amazon-field small \{[^}]*text-overflow: ellipsis;/, '长提示省略而不是换行')
  // 右栏：结论双格与核对明细统一 gap 16、去框、去内边距
  assert.match(css, /\.wb-amazon-results \.wb-amazon-metrics \{[^}]*border: 0;[^}]*gap: var\(--wb-space-y-tight\) var\(--wb-space-x\);/, '指标表与结论同几何')
  assert.match(css, /\.wb-amazon-results \.wb-amazon-metric \{ border: 0; padding: 0; \}/, '指标单元去框去内边距')
  // 卡片首尾留白对称
  assert.match(css, /\.wb-amazon-inputs > :last-child,\s*\.wb-amazon-results > :last-child \{ margin-bottom: 0; \}/)
})
