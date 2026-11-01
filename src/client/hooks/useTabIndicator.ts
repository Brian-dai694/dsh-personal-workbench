/**
 * 域页签的"实心块滑动"（2026-11-01 用户要求：滑块从当前项滑到下一项）。
 *
 * ## 为什么不用 CSS 变量
 * 本仓有一条不变式（`clientInvariants` I4）：**写自定义属性必须走白名单**，
 * 因为往根元素写变量会影响别人的样式。滑块的位移属于"面板内部的几何计算"，
 * 不该混进那个白名单，所以这里**直接写滑块的 inline style**（transform / width），
 * 不碰任何 `--wb-*` 变量的定义权。
 *
 * ## 为什么用 getBoundingClientRect 而不是 offsetLeft
 * offsetLeft 的口径（相对 padding box 还是 border box）在不同定位上下文里有差异，
 * 这里两个矩形都取视口坐标做差，再把容器左边框减掉，结果确定。
 *
 * ## 边界
 * - 只在 `activeKey` 变化时重量；容器尺寸变化（窗口缩放、字体加载完）用 ResizeObserver 兜一次；
 * - 不存 state：写的是 DOM 上的 inline style，不触发 React 重渲染。
 */
import { useEffect, useRef, type RefObject } from 'react'

export interface TabIndicatorRefs {
  /** 页签容器（滑块的定位父级）。 */
  containerRef: RefObject<HTMLDivElement>
  /** 滑块本体（绝对定位在容器里）。 */
  sliderRef: RefObject<HTMLSpanElement>
}

export function useTabIndicator(activeKey: string): TabIndicatorRefs {
  const containerRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const slider = sliderRef.current
    if (container === null || slider === null) return

    const measure = (): void => {
      const active = container.querySelector<HTMLElement>('[aria-selected="true"]')
      if (active === null) return
      const box = container.getBoundingClientRect()
      const target = active.getBoundingClientRect()
      /** 绝对定位元素的 left: 0 落在容器 padding box 上，所以只减左边框宽度。 */
      const dx = target.left - box.left - container.clientLeft
      slider.style.width = `${target.width}px`
      slider.style.transform = `translateX(${dx}px)`
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [activeKey])

  return { containerRef, sliderRef }
}
