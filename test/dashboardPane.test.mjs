/**
 * 仪表盘（2026-10-27，方案 A）：今日视图上半屏。
 *
 * 这里锁的是**这次重构的四条口径**，不是像素：
 * 1. 统计卡已被吸收 —— `TodayPane` 不许再自己渲染 `.wb-stats`（否则就是两份数字）；
 * 2. 容量面板只有一份实现 —— 由 `TodayPane` 传入 `capacityPane`，`DashboardPane` 不重画；
 * 3. 视图不发 HTTP（D17 结构硬门）—— 所有数字由装配层传进来；
 * 4. 空态与缺口口径 —— 没有动态就整块不渲染；缺数据源标 `needs_data`，不写 0。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WORKBENCH_CSS } from '../lib/client/styles.js'

const read = (path) => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
const dashboard = read('views/DashboardPane.tsx')
const today = read('views/TodayPane.tsx')
const oplogHook = read('hooks/useOplogDayIndex.ts')
const css = WORKBENCH_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

test('布局：宽屏 2:1 + 域卡三等分，940px 以下单列', () => {
  assert.match(css, /\.wb-dash-main \{[^}]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(0,\s*1fr\)/,
    '主区必须是 2:1 两栏（动手清单 : 今日节奏）')
  assert.match(css, /\.wb-dash-domains \{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    '域快照必须三等分')
  assert.match(css, /@media \(max-width: 940px\)[\s\S]{0,220}\.wb-dash-main \{\s*grid-template-columns:\s*1fr/,
    '窄屏必须退回单列')
  // 域卡等高 + 脚注贴底（否则三张卡底部参差，截图实测过）
  assert.match(css, /\.wb-dash-domains > \.wb-card \{[^}]*display:\s*flex[^}]*flex-direction:\s*column/,
    '域卡要能撑满行高')
  assert.match(css, /\.wb-dash-domains > \.wb-card > \.wb-dash-foot \{[^}]*margin-top:\s*auto/,
    '脚注必须贴底')
})

test('动手清单：标题与说明各自成块（inline 会被挤成一句读不出来）', () => {
  assert.match(css, /\.wb-q-t \{[^}]*display:\s*block/, '标题必须 display:block')
  assert.match(css, /\.wb-q-d \{[^}]*display:\s*block/, '说明必须 display:block')
})

test('统计卡已被吸收：TodayPane 不再自己渲染 .wb-stats', () => {
  assert.equal(/className="wb-stats/.test(today), false,
    'TodayPane 里的 4 张统计卡必须已经删掉 —— 数字现在只在仪表盘里出现一次')
  assert.match(today, /<DashboardPane/, 'TodayPane 必须渲染 DashboardPane')
})

test('容量面板只有一份实现：由 TodayPane 传入，DashboardPane 不重画', () => {
  assert.match(today, /const capacityPane = \(/, 'TodayPane 里那个现成的 .wb-cap 节点要作为 capacityPane 传下去')
  assert.match(dashboard, /capacityPane\s*\}/, 'DashboardPane 必须直接渲染传入的 capacityPane')
  // 反向：仪表盘里不许自己出现 wb-cap-bar / wb-cap-legend 的结构（那说明它重画了一份）
  assert.equal(/wb-cap-bar/.test(dashboard), false, 'DashboardPane 不许自己画容量条')
  assert.equal(/wb-cap-legend/.test(dashboard), false, 'DashboardPane 不许自己画容量图例')
})

test('视图不发 HTTP（D17 结构硬门）', () => {
  for (const [name, source] of [['DashboardPane.tsx', dashboard], ['TodayPane.tsx', today]]) {
    assert.equal(/\bapi\s*[<(]/.test(source), false, `${name} 不许调用 api()`)
    assert.equal(/\bfetch\s*\(/.test(source), false, `${name} 不许调用 fetch()`)
  }
})

test('空态：没有动态就整块不渲染；缺数据源标 needs_data 而不是 0', () => {
  assert.match(dashboard, /timeline\.length > 0 &&/, '最近动态必须条件渲染，不能画空壳')
  assert.match(dashboard, /wb-needs/, '缺数据源要用 needs_data 徽标')
  // 缺口行不许退化成写死 0
  assert.equal(/inventoryReady \? 0/.test(dashboard), false, '库存缺口不能写成 0')
  // 清单为空时给一句说明，而不是把 0 当成一条待办
  assert.match(dashboard, /today没有需要你处理的事|今天没有需要你处理的事/, '清单为空要给一句说明')
  assert.match(dashboard, /if \(overdue > 0\)/, '为 0 的项不许进动手清单')
})

test('运营日志摘要：一次并发拉三份，且各自独立降级', () => {
  assert.match(oplogHook, /completion-candidates/, '待归档数来自 completion-candidates')
  assert.match(oplogHook, /oplog\?limit=5/, '最近几条来自 /oplog?limit=5')
  const catches = (oplogHook.match(/\.catch\(\(\) => null\)/g) ?? []).length
  assert.equal(catches, 3, '三个请求必须各自 catch —— 任一失败不该把另外两个拖下水')
})
