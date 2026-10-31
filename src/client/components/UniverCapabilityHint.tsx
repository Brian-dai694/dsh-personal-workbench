/**
 * Univer 能力提示（2026-10-30）：报表 / 库存 / 付款对账 / 产品库**共用一份**。
 *
 * 两种状态必须分开说，而且都不能替宿主下结论：
 *
 * - `available === false`：**没装** → 分析照常，只是没有表格；给「重新检测」；
 * - `available === true && contentRead === 'unavailable'`：装了但**读不到表内容** →
 *   本页只按导入的文件算，不去读 `.univer`；
 * - `contentRead === 'unknown'`（老宿主没这个字段）→ **什么都不说**。
 *
 * 付款对账此前只有"按钮变灰"，没有一句说明；产品库干脆没有提示位。
 */
import { useI18n } from '../i18n.js'
import type { UniverContentReadStatus } from '../hooks/useUniverCsvTable.js'

export interface UniverCapabilityHintProps {
  available: boolean | null
  contentRead: UniverContentReadStatus
  onRetry: () => void
  /** 话术差异：有些页面的分析来源是"导入的文件"，有些是"库里已有数据"。 */
  subject?: 'imported-file' | 'library'
}

export function UniverCapabilityHint({ available, contentRead, onRetry, subject = 'imported-file' }: UniverCapabilityHintProps): JSX.Element | null {
  const { t } = useI18n()
  const missing = available === false
  const unreadable = available === true && contentRead === 'unavailable'
  if (!missing && !unreadable) return null

  return (
    <div className="wb-report-actions">
      <p className="wb-hint" style={{ margin: 0 }}>
        {missing
          ? t('表格功能需要 dsh-univer-office，当前 profile 未检测到。分析不受影响：结论可以复制 CSV 粘进 Excel。')
          : subject === 'library'
            ? t('当前环境读不到表格内容：本页只按产品库里的事实生成表，不会去读 .univer 里的数据。')
            : t('当前环境读不到表格内容：本页只按你导入的文件分析，不会去读 .univer 里的数据。')}
      </p>
      <button type="button" className="wb-btn" onClick={onRetry}>{t('重新检测')}</button>
    </div>
  )
}
