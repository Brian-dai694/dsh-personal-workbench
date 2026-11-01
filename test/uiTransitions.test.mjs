/**
 * 交互过渡的三条守卫（2026-11-01 用户要求）：
 *   1. 域 tabs：指示条滑到当前项、未选中降亮度、内容同步切换；
 *   2. 日历：日/周/月三段，选中块平滑移动；
 *   3. 任务/知识库/点子：点条目后亮块移动、旧内容淡出、新内容淡入。
 *
 * 这里只有一条是"纯逻辑"（`withViewTransition` 的降级与一次执行），其余是**接线判据**：
 * 动画本身在浏览器里跑，单测拿不到渲染结果，但可以钉住"接线被拆掉"这种回归 ——
 * 那才是这类改动最常见的失败方式（样式还在、类名还在，就是没人用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WORKBENCH_CSS } from '../lib/client/styles.js'
import { withViewTransition } from '../lib/client/viewTransition.js'

const HEADER = readFileSync(new URL('../src/client/app/WorkbenchHeader.tsx', import.meta.url), 'utf8')
const CALENDAR = readFileSync(new URL('../src/client/views/CalendarView.tsx', import.meta.url), 'utf8')
const DAY_WORKSPACE = readFileSync(new URL('../src/client/hooks/useDayWorkspace.ts', import.meta.url), 'utf8')
const NAVIGATION = readFileSync(new URL('../src/client/hooks/useWorkbenchNavigation.ts', import.meta.url), 'utf8')
const KNOWLEDGE = readFileSync(new URL('../src/client/hooks/useKnowledge.ts', import.meta.url), 'utf8')
const IDEAS = readFileSync(new URL('../src/client/hooks/useIdeas.ts', import.meta.url), 'utf8')
const INDEX = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const TABS_HOOK = readFileSync(new URL('../src/client/hooks/useTabIndicator.ts', import.meta.url), 'utf8')
const css = WORKBENCH_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

test('withViewTransition：不支持就同步执行，支持就只执行一次', () => {
  let ran = 0
  // 没有 document：同步执行，返回 false
  assert.equal(withViewTransition(() => { ran += 1 }, { document: undefined, reducedMotion: false }), false)
  assert.equal(ran, 1)

  // 支持：回调被交给浏览器过渡，仍然只执行一次
  let started = 0
  const doc = { startViewTransition: (callback) => { started += 1; callback() } }
  assert.equal(withViewTransition(() => { ran += 1 }, { document: doc, reducedMotion: false }), true)
  assert.equal(started, 1)
  assert.equal(ran, 2)
})

test('withViewTransition：减少动效时同步执行，不给前庭不适的人放动画', () => {
  let ran = 0
  let started = 0
  const doc = { startViewTransition: (callback) => { started += 1; callback() } }
  assert.equal(withViewTransition(() => { ran += 1 }, { document: doc, reducedMotion: true }), false)
  assert.equal(started, 0)
  assert.equal(ran, 1)
})

test('withViewTransition：过渡启动抛错也不能吞掉更新', () => {
  let ran = 0
  const doc = { startViewTransition: () => { throw new Error('busy') } }
  assert.equal(withViewTransition(() => { ran += 1 }, { document: doc, reducedMotion: false }), false)
  assert.equal(ran, 1, '过渡失败必须退回同步执行，否则这次点击等于没点')
})

test('域 tabs：六项统一一套 pill 选中态（亚马逊风格），未选中降亮度', () => {
  assert.match(HEADER, /data-primary-tabs/, '缺少主域页签容器')
  const list = HEADER.slice(HEADER.indexOf('const PRIMARY_TABS'), HEADER.indexOf('\n]', HEADER.indexOf('const PRIMARY_TABS')))
  assert.equal((list.match(/key: '/g) ?? []).length, 5, '五个固定域由同一份表渲染')
  assert.match(HEADER, /PRIMARY_TABS\.map\(/, '五个域必须由同一份表渲染，别又拆回五个手写按钮')
  /**
   * 2026-11-01 用户要求「域统一采用亚马逊的交互风格」：
   * 亚马逊父项与五个域在**同一个容器**里、共用同一套 .on 选中态；
   * 旧的"分格外框 + 底部指示条"已删除，不允许再长回来（两种选中态并排就是割裂）。
   */
  const group = HEADER.slice(HEADER.indexOf('data-primary-tabs'), HEADER.indexOf('wb-h-actions'))
  assert.match(group, /data-ad-parent/, '亚马逊父项必须与五个域同容器')
  assert.doesNotMatch(css, /\.wb-tabs-primary::after/, '底部指示条已取消，不应再出现')
  assert.doesNotMatch(HEADER, /--wb-tab-i/, '滑动索引已取消')
  // 容器 = 灰底 + 外框 + 胶囊圆角（内层 item 是 999px，外层不同心就会"内圆外方"）
  assert.match(css, /\.wb-tabs-primary\s*\{[^}]*background:\s*var\(--wb-sunk\)/, '页签容器要有灰底')
  assert.match(css, /\.wb-tabs-primary\s*\{[^}]*border:\s*1px solid var\(--wb-border-l2\)/, '页签容器要有外框')
  assert.match(css, /\.wb-tabs-primary\s*\{[^}]*border-radius:\s*999px/, '容器必须与内层胶囊同心（999px）')
  assert.match(css, /\.wb-tabs-primary\s*\{[^}]*padding:\s*3px/, '容器与滑块的内缩要一致（3px）')
  /**
   * 实心块 = 一个独立 span（`.wb-tabs-indicator`），位置与宽度由 useTabIndicator 用
   * **inline style** 写进去；这样六项宽度不等（「亚马逊 · 运营日志」更长）也能滑得准。
   * 用 inline style 而不是 CSS 变量，是为了不碰 clientInvariants I4 的自定义属性白名单。
   */
  assert.match(css, /\.wb-tabs-indicator\s*\{[^}]*position:\s*absolute/, '滑块是独立定位元素')
  assert.match(css, /\.wb-tabs-indicator\s*\{[^}]*transition:\s*transform\s+var\(--wb-dur-3\)[^}]*width\s+var\(--wb-dur-3\)/, '位移与宽度都要过渡（换项会变宽）')
  assert.match(css, /\.wb-tabs-indicator\s*\{[^}]*background:\s*var\(--wb-surface\)/, '滑块是白色实心 pill')
  assert.match(css, /\.wb-tabs-indicator\s*\{[^}]*border-radius:\s*999px/, '滑块自身也是胶囊')
  assert.match(HEADER, /className="wb-tabs-indicator"[\s\S]{0,80}ref=\{tabsSliderRef\}/, '顶栏要渲染滑块并挂 ref')
  assert.match(TABS_HOOK, /slider\.style\.width\s*=/, '测量 hook 要写滑块宽度')
  assert.match(TABS_HOOK, /slider\.style\.transform\s*=\s*`translateX\(\$\{dx\}px\)`/, '测量 hook 要写滑块位移')
  assert.doesNotMatch(TABS_HOOK, /setProperty\(/, '滑块几何不许走自定义属性（I4 白名单之外）')
  // 选中项只换颜色，不自己再画一层实心底（否则出现"双层白块"）
  assert.match(css, /\.wb-tabs-primary\s+\.wb-seg\.on\s*\{[^}]*background:\s*transparent/)
  assert.match(css, /\.wb-tabs-primary\s+\.wb-seg\.on\s+svg\s*\{\s*color:\s*var\(--wb-accent\)/)
  // 未选中降亮度（沿用上一轮口径）
  assert.match(css, /\.wb-tabs-primary\s+\.wb-seg\s*\{[^}]*opacity:\s*\.62/)
  assert.match(css, /\.wb-tabs-primary\s+\.wb-seg\.on\s*\{[^}]*opacity:\s*1/)
  // 接线：顶栏必须挂 ref 并使用测量 hook
  assert.match(HEADER, /useTabIndicator/, '顶栏要用测量 hook')
  assert.match(HEADER, /ref=\{tabsRef\}/, '容器 ref 要挂上')
  assert.match(css, /\.wb-tabs-indicator, \.wb-cal-tabs::before \{ transition: none !important; \}/, '减少动效时滑块也要停')
})

test('日历：日/周/月三段都点得动，选中块用同一套滑动机制，并记住周/月导航', () => {
  assert.match(DAY_WORKSPACE, /useState<'day' \| 'week' \| 'month'>\('week'\)/, 'calMode 必须包含 day')
  assert.match(DAY_WORKSPACE, /setCalMode: \(mode: 'day' \| 'week' \| 'month'\) => void/)
  const modes = CALENDAR.slice(CALENDAR.indexOf('const CAL_MODES'), CALENDAR.indexOf('\n]', CALENDAR.indexOf('const CAL_MODES')))
  for (const key of ["key: 'day'", "key: 'week'", "key: 'month'"]) {
    assert.ok(modes.includes(key), `缺少 ${key} 这一段`)
  }
  assert.match(CALENDAR, /CAL_MODES\.map\(/, '三段必须由同一份表渲染')
  assert.match(CALENDAR, /onCalModeChange\(mode\.key\)/)
  assert.match(CALENDAR, /data-cal-tabs/, '缺少日历分段容器（滑动块挂这里）')
  assert.match(CALENDAR, /'--wb-cal-i'/, '缺少选中索引进样式')
  assert.match(CALENDAR, /calMode === 'day'/, '缺少日视图分支')
  // 样式：三格等宽 + 滑动块
  assert.match(css, /\.wb-cal-tabs\s+\.wb-seg\s*\{[^}]*flex:\s*1 1 0/)
  assert.match(css, /\.wb-cal-tabs::before\s*\{[^}]*transform:\s*translateX\(calc\(var\(--wb-cal-i[^)]*\)\s*\*\s*100%\)\)/)
  assert.match(css, /\.wb-cal-tabs::before\s*\{[^}]*transition:\s*transform\s+var\(--wb-dur-3\)\s+var\(--wb-ease-standard\)/)
})

test('列表→详情：选中的条目与右侧内容区都有过渡名，且接入点真的用了过渡', () => {
  assert.match(css, /\.wb-row\.selected\s*\{[^}]*view-transition-name:\s*wb-picked/)
  assert.match(css, /\.wb-detail\s*\{[^}]*view-transition-name:\s*wb-pane/)
  assert.match(css, /@keyframes\s+wb-vt-out/)
  assert.match(css, /@keyframes\s+wb-vt-in/)
  assert.match(css, /prefers-reduced-motion:\s*reduce[^{]*\{[^}]*::view-transition/, '减少动效时必须关掉过渡动画')
  // 两个真实入口：域页签切换（导航 hook）、打开任务详情（入口）
  assert.match(INDEX, /withViewTransition/, '入口必须用上过渡助手')
  assert.match(INDEX, /const openTask = \(task: Task\): void => \{[\s\S]{0,200}withViewTransition/)
  assert.match(NAVIGATION, /withViewTransition\(\(\) => flushSync\(\(\) => setViewState\(next\)\)\)/, '切视图必须走过渡（并 flushSync）')
  // 知识库 / 点子的选中同样走过渡（同一个 `.wb-detail` 容器，动画才能一致）
  assert.match(KNOWLEDGE, /openEntry: \(entry\) => withViewTransition/, '知识库打开条目必须走过渡')
  assert.match(IDEAS, /const openIdea = useCallback\(\(idea: Idea\): void => \{\n    withViewTransition/, '点子打开必须走过渡')
})
