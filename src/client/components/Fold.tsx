/**
 * 折叠段（2026-10-23 快速录入重构）。
 *
 * 为什么需要它：技能/角色选择器各自带搜索框 + 十几行列表，直接铺在弹窗里
 * 会把「一句话输入」这件事埋掉——用户打开快速录入，第一屏应该只有输入框。
 * 用原生 `<details>`：无状态、可键盘操作、折叠时列表不进无障碍树。
 */
import type { ReactNode } from 'react'

export function Fold({ title, meta, defaultOpen = false, children }: {
  title: ReactNode
  /** 右侧摘要：已选几项 / 当前角色名。折叠状态下这是唯一线索 */
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <details className="wb-fold" {...(defaultOpen ? { open: true } : {})}>
      <summary className="wb-fold-sum">
        <span className="wb-fold-title">{title}</span>
        {meta !== undefined && <span className="wb-fold-meta">{meta}</span>}
      </summary>
      <div className="wb-fold-body">{children}</div>
    </details>
  )
}
