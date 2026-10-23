/**
 * 键盘可达性：把"鼠标专用"的 div / span 变成可聚焦、可回车触发的控件。
 *
 * 为什么需要它：工作台里有一批整行/整格可点的元素（任务行、日历日格、文件夹、
 * 点子标题）。用 `<button>` 重写会撞两件事：① 行内已经有按钮（展开、排入今日），
 * 嵌套 button 是非法 HTML；② `wb-row` / `wb-day` 的布局依赖 div 的盒模型。
 * 所以走"div + role=button + tabIndex + Enter/Space"这条路径，并且**显式管理焦点环**。
 *
 * 纪律：Enter 与 Space 都要触发；Space 必须 preventDefault（否则页面会滚动）；
 * 其余按键不拦截（Tab / 方向键留给宿主与浏览器）。
 */
import type { KeyboardEvent } from 'react'

export interface InteractiveOptions {
  /** 无可读文本时才需要（纯图标）；有文字就让它自己当名字 */
  label?: string
  /** 可切换/可选中状态（如文件夹选中、日格选中） */
  pressed?: boolean
  /** 当前项语义（列表里"正在看的这一条"） */
  current?: boolean | 'page' | 'step' | 'location' | 'date' | 'time' | 'true' | 'false'
}

export interface InteractiveProps {
  role: 'button'
  tabIndex: number
  'aria-label'?: string
  'aria-pressed'?: boolean
  'aria-current'?: InteractiveOptions['current']
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export function interactiveProps(onActivate: () => void, options: InteractiveOptions = {}): InteractiveProps {
  const props: InteractiveProps = {
    role: 'button',
    tabIndex: 0,
    onKeyDown: (event) => {
      // Spacebar 是旧浏览器/旧测试环境里的名字，一并认
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
      event.preventDefault()
      event.stopPropagation()
      onActivate()
    },
  }
  if (options.label !== undefined) props['aria-label'] = options.label
  if (options.pressed !== undefined) props['aria-pressed'] = options.pressed
  if (options.current !== undefined) props['aria-current'] = options.current
  return props
}
