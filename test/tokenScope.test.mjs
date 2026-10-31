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
import { readdirSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * 顶栏横向对齐（2026-10-28）：同一行里控件**必须等高**。
 *
 * 实测（面板 990px、真实头部结构）：待处理胶囊 23px、页签 27.6px、
 * 图标按钮 29px、主按钮 29.6px —— 四种高度并排，肉眼就是"没对齐"。
 * 现在统一到 `--wb-ctl-h`，并且图标按钮收成正方形。
 *
 * 另一条：右侧动作簇必须是**一个整体**（`.wb-h-actions`），否则面板变窄时
 * 会拆成"胶囊在第一行右端、按钮掉到第二行"，看起来像错位。
 */
test('顶栏：控件等高 + 动作簇整簇换行', () => {
  const css = stripComments(WORKBENCH_CSS)
  assert.match(css, /--wb-ctl-h:\s*\d+px/, '缺少顶栏控件高度令牌 --wb-ctl-h')
  // 三类控件都要吃到这个高度（少一个就又出现两种高度）
  for (const sel of ['.wb-h .wb-btn', '.wb-h .wb-seg', '.wb-h .wb-pending-pill']) {
    const rule = css.split('}').find((block) => block.includes(sel))
    assert.ok(rule !== undefined, `找不到 ${sel} 的规则`)
  }
  const heightRule = css.match(/\.wb-h \.wb-btn[^{]*\{[^}]*height:\s*var\(--wb-ctl-h\)/)
  assert.ok(heightRule !== null, '顶栏按钮必须用 height: var(--wb-ctl-h) 与页签/胶囊等高')
  assert.match(css, /\.wb-h-actions\s*\{[^}]*display:\s*flex/, '动作簇容器 .wb-h-actions 必须是 flex（整簇换行、靠右）')
  assert.match(css, /\.wb-h-actions\s*\{[^}]*margin-left:\s*auto/, '.wb-h-actions 要靠右（替代原来那个 flex:1 占位）')
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
 * 状态语义色（第三轮，2026-10-28 换色系后再收紧）：工作台原先自带一套
 * 琥珀 9 色、红 5 色、绿 3 色、信息蓝 2 色 —— 共 115 处字面值。现在全部改成
 * **从宿主语义别名派生**（--wb-state-warn/-error/-success-primary、--wb-link、
 * --wb-label-tertiary），只剩"往宿主深中性里压一档"的几个色号留在令牌定义行里。
 *
 * 这条守卫只允许这些色号出现在**令牌定义行**（属性名以 `--wb-` 开头）：
 * 别处再随手写 `color: #f59e0b`，就等于绕过整套语义层、重新长出第二种琥珀。
 * 名单同时保留 2026-10-28 之前的老色号 —— 只要有人把它们写回规则里，同样算违规。
 */
const STATUS_HEXES = [
  // 现行（DSH 色阶）——只应出现在 --wb-* 令牌定义行
  '#f59e0b', '#ec1313', '#f25a5a', '#22c55e', '#4176e6', '#7aaaff', '#dd8629',
  // 历史私有色板（已全部下线，写回来即违规）
  '#f5b83d', '#e74c3c', '#2e9b7b', '#8fa8c8', '#8a9aa8',
  '#9a6b12', '#c24a3f', '#1f7a5c', '#b4552f', '#2e6e9b',
]

/**
 * 「与 DSH 统一一个色系」的**判据**（2026-10-28）。
 *
 * 这条不是审美偏好，是用户明确要求：「工作台和 dsh 统一一个色系」。
 * 以前的失败形态是可验证的：强调色写死成墨绿 `color-mix(#2E9B7B 62%, #14493A)`，
 * 而环线/选中/表单聚焦引用的是宿主蓝 —— 同一个界面里两套强调色并存；
 * 优先级 p2 又是第三个蓝 `#3498DB`，ABA 分层还有个宿主调色板里根本不存在的紫。
 *
 * 现在只有**一个源**：强调色 = 宿主品牌色，状态色 = 宿主语义别名。
 * 守卫用两条断言钉住：
 *   1. `--wb-accent` 必须**恰好**是 `var(--wb-state-business-primary)`（换色只改这一行）；
 *   2. 五类状态色 + 分层色必须引用宿主语义令牌（不许再写字面色）。
 */
test('强调色必须直接取宿主品牌色（换色只改一行，不许自带一套）', () => {
  const css = stripComments(WORKBENCH_CSS)
  const match = css.match(/\n\s*--wb-accent\s*:\s*([^;{}]+);/)
  assert.ok(match, '找不到 --wb-accent 的定义')
  assert.equal(match[1].trim(), 'var(--wb-state-business-primary)',
    '强调色必须是 var(--wb-state-business-primary)（宿主品牌色）。' +
    '若确实要换回自定色，请连同这条守卫一起改，并说明为什么工作台不再跟随 DSH 色系')
})

test('状态色 / 分层色必须从宿主语义别名派生（不许写字面色）', () => {
  const css = stripComments(WORKBENCH_CSS)
  const derive = (name) => {
    // 定界符要接受换行 / 分号 / 左花括号：多个令牌常写在同一行（如 `--wb-p0: …; --wb-p1: …;`）
    const match = css.match(new RegExp(`(?:^|[\\n;{])\\s*${name}\\s*:\\s*([^;{}]+);`))
    assert.ok(match, `找不到 ${name} 的定义`)
    return match[1].trim()
  }
  const EXPECTED = {
    '--wb-warn': '--wb-state-warn-primary',
    '--wb-danger': '--wb-state-error-primary',
    '--wb-ok': '--wb-state-success-primary',
    '--wb-info': '--wb-link',
    '--wb-neutral': '--wb-label-tertiary',
    '--wb-tier-middle': '--wb-accent',
    '--wb-tier-tail': '--wb-neutral',
  }
  const problems = []
  for (const [name, host] of Object.entries(EXPECTED)) {
    const value = derive(name)
    if (value !== `var(${host})`) problems.push(`${name}: ${value}（应为 var(${host})）`)
  }
  assert.deepEqual(problems, [],
    `这些语义色没有跟随宿主色系：\n  - ${problems.join('\n  - ')}`)
})

/**
 * 硬化守卫：**样式表里除令牌定义行外，不得出现任何字面色**。
 *
 * 令牌化做了一轮又一轮，每次都是"把字面色收成令牌"，然后下一轮又长回来 ——
 * 因为没有任何东西禁止在规则里直接写 `#f59e0b`。这条把口子彻底封上：
 * 规则里只允许 `var(--wb-*)`、`color-mix(...)`、以及 `#fff` / `#000` 这两个
 * "纯白/纯黑"（`color:#fff` 压在强调色按钮上、`color-mix(…, #000)` 压暗，都不是色系的一部分）。
 *
 * 为什么放行 `#fff`/`#000`：它们不参与色系（任何主题下都是绝对黑/白），
 * 而且引入 `--wb-on-accent` 之类的令牌只会多一层间接。真要改，连这条一起改。
 */
test('规则里不得再出现字面色（只允许 #fff / #000 与 --wb-* 令牌）', () => {
  const css = stripComments(WORKBENCH_CSS)
  const ALLOWED = new Set(['#fff', '#000', '#ffffff', '#000000'])
  const offenders = []
  for (const match of css.matchAll(/(--?[a-z0-9-]+)\s*:\s*([^;{}]*)/g)) {
    const [, prop, value] = match
    if (prop.startsWith('--wb-')) continue // 令牌定义行：回退值本来就该是字面色
    for (const hex of value.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
      if (!ALLOWED.has(hex.toLowerCase())) {
        offenders.push(`${prop}: ${value.replace(/\s+/g, ' ').trim().slice(0, 90)}`)
        break
      }
    }
  }
  assert.deepEqual(offenders, [],
    `这些规则还在写字面色，应改用 --wb-* 令牌：\n  - ${offenders.join('\n  - ')}`)
})

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

/**
 * 「状态主色只做填充/边框，当文字一律用 -ink」——这条是**看图看出来的**，不是洁癖。
 *
 * 琥珀 `#f5b83d` 当文字压在 14% 琥珀底上，对比度约 1.8:1（`待验收` 徽标肉眼发灰）；
 * `--wb-ok`(#2E9B7B) / `--wb-danger`(#E74C3C) 当小字也只有 3.5~3.9:1。所以状态色分两档：
 * 主色负责"是什么"（底/边/进度条），ink 负责"读得清"（文字）。
 *
 * `(?<![-\w])` 是为了只命中真正的 `color:`，不误伤 `border-color:` / `background-color:` /
 * `accent-color:` —— 那三类本来就该用主色。
 */
test('状态主色不得直接当文字色（color: 要用 -ink）', () => {
  const css = stripComments(WORKBENCH_CSS)
  const offenders = []
  for (const match of css.matchAll(/(?<![-\w])color\s*:\s*([^;}]+)/g)) {
    const value = match[1].replace(/\s+/g, ' ').trim()
    // 只禁"整条值就是状态主色"。`color-mix(… var(--wb-ok) 70%, label-primary)` 这类
    // 是刻意往深/往浅调过的派生色，不在禁止范围。
    if (/^var\(--wb-(warn|danger|ok|info|neutral)\)$/.test(value)) offenders.push(value)
  }
  assert.deepEqual(offenders, [],
    `这些 color: 还在用状态主色（浅底上读不清），应改用 --wb-warn-ink / --wb-danger-ink / --wb-ok-ink / --wb-info-ink：\n  - ${offenders.join('\n  - ')}`)
})

/**
 * 2026-10-28「与 DSH 统一一个色系」的**最后一道口子**：内联样式里的字面色。
 *
 * 令牌化只管 `styles.ts`；组件里的 `style={{ color: '#d9a03f' }}` 完全绕过令牌层
 * —— 本轮就清出 12 处（`#4f8ef7`、`#d9a03f`、`#e0645c`、`#8a9aa8`、`#E74C3C`…），
 * 以及一批 `var(--dsw-alias-x, <旧深色>)`：那层的回退值**不会**被 toWorkbenchTokens 改写
 * （改写只发生在样式表字符串上），所以宿主令牌一缺就是深黑。
 *
 * 判据：`src/client` 下的 .ts/.tsx 里不允许出现 `#rrggbb`，只有两个令牌层文件例外
 * （`styles.ts` 的回退值、`entryContract.ts` 的 TOKENS）。字典数据色不在此列 ——
 * 它们在 `src/shared/palette.ts`（两端共用），客户端要兜底就 import PALETTE。
 */
test('客户端源码里不得出现字面色（令牌层两个文件除外）', () => {
  const dirUrl = new URL('../src/client/', import.meta.url)
  const TOKEN_LAYER = new Set(['styles.ts', 'entryContract.ts'])
  const files = readdirSync(fileURLToPath(dirUrl), { recursive: true, encoding: 'utf8' })
    .filter((rel) => /\.tsx?$/.test(rel))
    .filter((rel) => !TOKEN_LAYER.has(basename(rel)))
  assert.ok(files.length > 30, `扫描面太小（${files.length} 个文件），守卫形同虚设`)
  const offenders = []
  for (const rel of files) {
    const source = stripComments(readFileSync(new URL(rel.split('\\').join('/'), dirUrl), 'utf8'))
    for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      offenders.push(`${rel} → ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [],
    `这些地方还在写字面色，应改用 --wb-* 令牌（字典数据色用 PALETTE）：\n  - ${offenders.join('\n  - ')}`)
})

/**
 * `styles.ts` 的两段 CSS 都在**模板字符串**里：注释里出现反引号会提前闭合字面量。
 *
 * 2026-10-27 记过一次，2026-10-28 又踩了一次（顶栏动作簇那条注释写了 `.wb-h`，
 * tsc 报的却是 `styles.ts(915,35): error TS1005: ',' expected` —— 错误行号指向
 * 注释本身，很容易误判成选择器语法问题）。这条守卫把"注释里的反引号"当场点名，
 * 免得下次再靠读 tsc 的错误位置去猜。
 */
test('styles.ts 的 CSS 注释里不得出现反引号（会提前闭合模板字符串）', () => {
  const lines = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n').split('\n')
  const offenders = []
  let inside = false
  for (const [index, line] of lines.entries()) {
    if (/^const (RAW_CSS|AMAZON_CSS) = `/.test(line)) { inside = true; continue }
    if (inside && line.trim() === '`') { inside = false; continue }
    if (!inside) continue
    const isComment = /^\s*(\/\*|\*|\/\/)/.test(line)
    if (isComment && line.includes('`')) offenders.push(`第 ${index + 1} 行：${line.trim().slice(0, 90)}`)
  }
  assert.deepEqual(offenders, [],
    `CSS 注释里出现反引号，会提前闭合模板字符串（tsc 会报在选择器上，极难定位）：\n  - ${offenders.join('\n  - ')}`)
})
