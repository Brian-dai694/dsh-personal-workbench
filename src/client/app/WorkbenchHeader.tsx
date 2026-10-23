/**
 * D17 / P7-2：`WorkbenchApp` 的**顶栏** JSX（搬迁前 index.tsx 的第 823–843 行）。
 *
 * 逐字搬出 —— 内层行的缩进一个字没改，只把外层标签挪进本文件的 `return`，
 * 所以拼装出来的 DOM 与拆分前逐层一致（弹窗刻意留在原来的位置上，不改层叠顺序）。
 *
 * 依赖以 `WorkbenchAssembly` 整体注入，这里只**解构自己真正用到的那几个** ——
 * 解构名与入口里的局部名逐个一致（不把 `selected` 改写成 `data.selected`，
 * 既有判据锚的就是这些原文）。
 */
import type { WorkbenchAssembly } from './assembly.js'
import { Icon } from '../components/Icon.js'
import { useI18n } from '../i18n.js'

export function WorkbenchHeader(props: WorkbenchAssembly): JSX.Element {
  const { t } = useI18n()
  const { busy } = props.busyApi
  const { setPendingOpen } = props.draftsApi.actions
  const { view } = props.nav
  const { setView } = props.nav.actions
  const { setShowSettings } = props.prefs.actions
  const { closePanel, collapseAll, forms, openQuickEntry, pendingCount } = props
  return (
    <div className="wb-h">
        <div className="wb-title"><Icon name="calendar" size={19} />{t('个人工作台')}</div>
        <div className="wb-segmented">
          <button className={`wb-seg ${view === 'today' ? 'on' : ''}`} onClick={() => setView('today')}><Icon name="today" />{t('今日')}</button>
          <button className={`wb-seg ${view === 'calendar' ? 'on' : ''}`} onClick={() => setView('calendar')}><Icon name="calendar" />{t('日历')}</button>
          <button className={`wb-seg ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}><Icon name="list" />{t('任务')}</button>
          <button className={`wb-seg ${view === 'knowledge' ? 'on' : ''}`} onClick={() => setView('knowledge')}><Icon name="book" />{t('知识库')}</button>
          <button className={`wb-seg ${view === 'ideas' ? 'on' : ''}`} onClick={() => setView('ideas')}><Icon name="idea" />{t('点子')}</button>
          <button className={`wb-seg ${view === 'amazon' ? 'on' : ''}`} onClick={() => setView('amazon')}><Icon name="chart" />{t('测算')}</button>
          <button className={`wb-seg ${view === 'keywords' ? 'on' : ''}`} onClick={() => setView('keywords')}><Icon name="search" />{t('关键词')}</button>
          <button className={`wb-seg ${view === 'traffic' ? 'on' : ''}`} onClick={() => setView('traffic')}><Icon name="trend" />{t('流量分析')}</button>
        </div>
        <div style={{ flex: 1 }} />
        {pendingCount > 0 && (
          <button className="wb-pending-pill" onClick={() => setPendingOpen(true)} title={t('待你处理的草稿与提醒')}>
            <Icon name="bell" size={13} />{t('待处理')} <span className="count">{pendingCount}</span>
          </button>
        )}
        <button className="wb-btn primary" onClick={openQuickEntry} disabled={busy}><Icon name="sparkles" /><span className="wb-label">{t('快速录入')}</span></button>
        <button className="wb-btn" onClick={() => forms.actions.toggleCreate()}><Icon name="plus" /><span className="wb-label">{t('新建')}</span></button>
        <button className="wb-btn" onClick={() => setShowSettings((v) => !v)}><Icon name="settings" /><span className="wb-label">{t('设置')}</span></button>
        <button className="wb-btn" onClick={collapseAll}><Icon name="list" /><span className="wb-label">{t('收起全部')}</span></button>
        <button className="wb-btn" onClick={() => closePanel()}><Icon name="back" /><span className="wb-label">{t('返回对话')}</span></button>
    </div>
  )
}
