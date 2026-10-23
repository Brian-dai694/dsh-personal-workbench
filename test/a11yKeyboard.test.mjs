/**
 * A：键盘可达性守卫（2026-10-23）。
 *
 * 背景：任务行 / 日历日格 / 文件夹卡 / 点子标题原先只有 `onClick`，
 * 键盘用户 Tab 不到、回车也开不了。现在统一走 `interactiveProps()`
 * （`role="button"` + `tabIndex=0` + Enter/Space）。
 *
 * 本文件守两件事：
 * 1. 助手本身的行为（Enter / Space 触发、其余键不拦、Space 必须 preventDefault）；
 * 2. 源码里**不许再出现"只有 onClick 的 div/span"**——遮罩/蒙层/scrim 与
 *    仅用于 stopPropagation 的容器除外（它们不是交互目标）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { interactiveProps } from '../lib/client/a11y.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const clientDir = join(root, 'src', 'client')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.tsx')) out.push(full)
  }
  return out
}

function fakeEvent(key) {
  return {
    key,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true },
    stopPropagation() { this.stopped = true }
  }
}

test('interactiveProps：Enter 与 Space 触发，且 Space 必须 preventDefault', () => {
  let fired = 0
  const props = interactiveProps(() => { fired += 1 })
  assert.equal(props.role, 'button')
  assert.equal(props.tabIndex, 0)

  const enter = fakeEvent('Enter')
  props.onKeyDown(enter)
  assert.equal(fired, 1, 'Enter 应触发')
  assert.equal(enter.prevented, true)

  const space = fakeEvent(' ')
  props.onKeyDown(space)
  assert.equal(fired, 2, 'Space 应触发')
  assert.equal(space.prevented, true, 'Space 不 preventDefault 会滚动页面')

  const tab = fakeEvent('Tab')
  props.onKeyDown(tab)
  assert.equal(fired, 2, 'Tab 不能被吞（焦点要能走）')
  assert.equal(tab.prevented, false)

  const arrow = fakeEvent('ArrowDown')
  props.onKeyDown(arrow)
  assert.equal(fired, 2, '方向键留给宿主/浏览器')
})

test('interactiveProps：aria 只在显式传入时出现（不塞空属性）', () => {
  const bare = interactiveProps(() => {})
  assert.equal('aria-label' in bare, false)
  assert.equal('aria-pressed' in bare, false)
  assert.equal('aria-current' in bare, false)

  const rich = interactiveProps(() => {}, { label: '打开设置', pressed: false, current: true })
  assert.equal(rich['aria-label'], '打开设置')
  assert.equal(rich['aria-pressed'], false)
  assert.equal(rich['aria-current'], true)
})

test('源码守卫：可点击的 div/span 必须接上键盘（遮罩类除外）', () => {
  const offenders = []
  for (const file of walk(clientDir)) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!/<(div|span)\b[^>]*onClick/.test(line)) continue
      // 标签可能跨行：拼到第一个 '>' 为止
      let tag = line
      for (let j = i; j < Math.min(i + 6, lines.length) && !tag.includes('>'); j += 1) {
        if (j > i) tag += ' ' + lines[j].trim()
      }
      // 遮罩 / 蒙层 / 仅用于 stopPropagation 的容器不是交互目标
      const isChrome = /mask|scrim|overlay|stopPropagation|position:\s*'fixed'/.test(tag)
      const wired = /interactiveProps\(/.test(tag) || /role=/.test(tag) || /tabIndex=/.test(tag)
      if (!isChrome && !wired) {
        offenders.push(`${relative(root, file)}:${i + 1}  ${line.trim().slice(0, 80)}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `以下可点击元素没有键盘通路（用 interactiveProps 接上）：\n${offenders.join('\n')}`)
})

test('源码守卫：有遮罩的组件必须有键盘关闭路径（Esc 或共享 Modal）', () => {
  const offenders = []
  for (const file of walk(clientDir)) {
    const text = readFileSync(file, 'utf8')
    // 遮罩/蒙层：点击关闭是鼠标路径，键盘必须有 Esc（或走共享 Modal，它统一处理 Esc）
    const hasBackdrop = /wb-modal-mask|wb-[\w-]*scrim|position: 'fixed', inset: 0/.test(text)
    if (!hasBackdrop) continue
    const keyboardClose = /Escape/.test(text) || /<Modal\b/.test(text) || /from '\.\/Modal\.js'/.test(text)
    if (!keyboardClose) offenders.push(relative(root, file))
  }
  assert.deepEqual(offenders, [], `以下文件有遮罩但没有键盘关闭路径（Esc 或共享 Modal）：\n${offenders.join('\n')}`)
})
