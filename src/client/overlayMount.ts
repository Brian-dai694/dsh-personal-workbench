/**
 * 浮层挂载点（issue #14）：**优先挂到宿主 overlay 层，而不是 body**。
 *
 * ## 为什么要这样
 *
 * 桌面端宿主的 `[data-shell-overlay]` 层自带 `z-index`（实测 1000）并形成层叠上下文；
 * 工作台面板、官方对话框都在这一层里。插件过去把所有 portal 落到 `document.body`，
 * 于是"body 上的 300"和"overlay 层里的 1000"比较时永远输 —— 设置弹窗、模型列表、
 * 知识库标签菜单都会被面板盖住（issue #14 的实测根因）。
 *
 * 挂到同一个 overlay 层后，插件浮层与面板处于**同一个层叠上下文**，
 * 原来的 `z-index:300 > 55` 直接生效，不需要跟宿主抢数字。
 *
 * ## 什么情况退回 body
 *
 * 宿主 overlay 层若带 `transform` / `filter` / `perspective` / `contain` /
 * `will-change: transform`，它就会成为 `position:fixed` 后代的**包含块**，
 * 挂进去会让浮层坐标漂移。这类宿主上保持原行为（body），宁可层级旧一点，
 * 也不能把弹窗挂到错误位置。
 *
 * 判定抽成 `shouldMountOnOverlayHost()` 纯函数，`overlayMountContainer()` 只负责取现场事实。
 */

/** 宿主 overlay 层的稳定选择器（issue #14 作者实测的宿主属性）。 */
export const SHELL_OVERLAY_SELECTOR = '[data-shell-overlay]'

/** 判定所需的最小事实集（纯函数入参；测试不需要 DOM）。 */
export interface OverlayHostFacts {
  /** 元素是否仍在文档里（React 热重载/宿主重渲染时可能已脱离）。 */
  connected: boolean
  /** 是否真的是 body 的后代（别把另一个文档/影子树里的节点当挂载点）。 */
  inBody: boolean
  /** computed display（`none` = 当前不可见，挂进去等于把弹窗藏起来）。 */
  display: string
  /** computed transform / filter / perspective / contain / will-change。 */
  transform: string
  filter: string
  perspective: string
  contain: string
  willChange: string
}

const NONE = 'none'

/**
 * 是否可以把浮层挂到宿主 overlay 层。
 *
 * 返回 `false` 的每一种情况都对应一个可解释的风险（见文件头），
 * 不是"探测失败随便选一条腿"。
 */
export function shouldMountOnOverlayHost(facts: OverlayHostFacts): boolean {
  if (!facts.connected || !facts.inBody) return false
  if (facts.display === NONE) return false
  if (facts.transform !== NONE) return false
  if (facts.filter !== NONE) return false
  if (facts.perspective !== NONE) return false
  if (facts.contain !== NONE) return false
  const willChange = facts.willChange.trim().toLowerCase()
  if (willChange.includes('transform') || willChange.includes('filter') || willChange.includes('perspective')) return false
  return true
}

/**
 * 取宿主 overlay 层；不满足条件时退回 `document.body`（修复前行为，不会更糟）。
 *
 * @param doc 浏览器 document；测试可注入假对象。
 */
export function overlayMountContainer(doc: Document = document): HTMLElement {
  const body = doc.body
  if (body === null) return doc.documentElement as HTMLElement
  const host = doc.querySelector(SHELL_OVERLAY_SELECTOR)
  if (host === null) return body
  const view = doc.defaultView
  if (view === null) return body
  const style = view.getComputedStyle(host)
  const facts: OverlayHostFacts = {
    connected: host.isConnected,
    inBody: body.contains(host),
    display: style.display,
    transform: style.transform === '' ? NONE : style.transform,
    filter: style.filter === '' ? NONE : style.filter,
    perspective: style.perspective === '' ? NONE : style.perspective,
    contain: style.contain === '' ? NONE : style.contain,
    willChange: style.willChange === '' ? NONE : style.willChange,
  }
  return shouldMountOnOverlayHost(facts) ? host as HTMLElement : body
}
