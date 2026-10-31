/**
 * Univer 预览卡（2026-10-30）：报表 / 库存 / 付款对账 / 产品库**共用一份**。
 *
 * ## 为什么必须抽出来
 *
 * 在此之前每个页面各写了一份（约 20 行）：iframe + loading/error + 草稿说明 +
 * `prefers-reduced-motion` 降级 + `scrollIntoView`。四份复制品意味着改一句文案要改四处，
 * 漏一处就出现"两页对同一张草稿说法不同"。抽成组件后，`views/` 里**不应再出现**
 * `table.viewer.phase`（测试会钉住这一点）。
 *
 * ## 边界
 *
 * 只是展示：不生成文件、不合并、不判断可用性。生成由 `useUniverCsvTable.openTable` 负责，
 * 可用性由 `UniverCapabilityHint` 负责；合并/放弃永远由用户在 Viewer 里点。
 */
import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n.js'
import { Icon } from './Icon.js'
import type { UseUniverCsvTableResult } from '../hooks/useUniverCsvTable.js'

export interface UniverPreviewCardProps {
  table: UseUniverCsvTableResult
  /** 卡片标题，默认「表格预览」。 */
  title?: string
}

export function UniverPreviewCard({ table, title }: UniverPreviewCardProps): JSX.Element | null {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement | null>(null)

  /**
   * `ready` 才滚：`loading` 时卡片只有一行字，滚过去等于把用户从按钮上拽走。
   * 尊重 `prefers-reduced-motion`：降级时用 `auto`，不替用户开动画。
   */
  useEffect(() => {
    if (table.viewer.phase !== 'ready') return
    const node = ref.current
    if (node === null) return
    const reduce = typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }, [table.viewer.phase])

  if (table.viewer.phase === 'idle') return null

  return (
    <div className="wb-card wb-univer-preview" ref={ref}>
      <h4 className="wb-univer-preview-head">
        <span className="wb-univer-preview-title"><Icon name="chart" size={14} />{title ?? t('表格预览')}</span>
        <button type="button" className="wb-btn wb-univer-close" onClick={table.actions.close}>
          {t('收起')}
        </button>
      </h4>
      <p className="wb-hint">
        {t('这是草稿：在预览里改的内容先留在草稿，点「提交待审阅」再「合并」才进正式表；不合并不会改动已有的表。')}
      </p>
      {table.viewer.phase === 'loading' && <p className="wb-hint">{t('正在生成表格并申请预览地址…')}</p>}
      {table.viewer.phase === 'error' && (
        <>
          <p className="wb-hint">{table.viewer.message}</p>
          {table.viewer.file !== '' && <p className="wb-hint">{`${t('文件已生成：')}${table.viewer.file}`}</p>}
        </>
      )}
      {table.viewer.phase === 'ready' && (
        <iframe
          key={table.viewer.url}
          src={table.viewer.url}
          title={t('Univer 表格预览')}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          style={{ width: '100%', height: 520, border: '0', display: 'block' }}
        />
      )}
    </div>
  )
}
