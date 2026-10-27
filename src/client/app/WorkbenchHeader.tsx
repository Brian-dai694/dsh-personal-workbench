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

/**
 * 亚马逊组（原「广告组」，2026-10-24 用户要求改名）：测算 / 关键词 / 流量分析 从 8 个一级页签收成 1 个父项。
 *
 * 三条约束：
 * 1. **`view` 联合类型不动** —— 仍是原样 8 个值，只是入口少了两个；
 * 2. 父项常驻显示当前子项名（`广告 · 关键词`），否则收起后用户以为功能没了；
 * 3. 记住上次进入的子项（`localStorage`，纯客户端偏好，不写工作台设置、不写库）。
 *
 * round7：8 个子页签**分两组**，各占一个独立的分段控件（比"一条 8 格长条"好扫），
 * 并给每项配语义图标 —— 原先 3 个 `chart`、2 个 `list`、2 个 `search` 复用同一图形，
 * 图标等于没有信息量（"选品"和"关键词"长得一样）。
 */
type AdView = 'amazon' | 'keywords' | 'traffic' | 'reports' | 'inventory' | 'payments' | 'oplog' | 'asin'

/** 组内同一工作节奏，组间是不同节奏：① 看广告与流量，② 看商品与经营。 */
const AD_GROUPS: ReadonlyArray<{
  label: string
  views: ReadonlyArray<{ key: AdView; label: string; icon: string }>
}> = [
  {
    label: '广告分析',
    views: [
      { key: 'amazon', label: '测算', icon: 'calculator' },
      { key: 'keywords', label: '关键词', icon: 'search' },
      { key: 'traffic', label: '流量分析', icon: 'trend' },
      { key: 'reports', label: '报表分析', icon: 'report' },
    ],
  },
  {
    label: '商品与经营',
    views: [
      { key: 'asin', label: '选品', icon: 'target' },
      { key: 'inventory', label: '库存', icon: 'package' },
      { key: 'payments', label: '付款对账', icon: 'receipt' },
      { key: 'oplog', label: '运营日志', icon: 'journal' },
    ],
  },
]
const AD_VIEWS = AD_GROUPS.flatMap((group) => group.views)
const AD_LAST_KEY = 'wb-ad-last-view'
const AD_DEFAULT: AdView = 'amazon'

function readLastAdView(): AdView {
  try {
    const saved = globalThis.localStorage?.getItem(AD_LAST_KEY)
    if (saved === 'amazon' || saved === 'keywords' || saved === 'traffic' || saved === 'reports' || saved === 'inventory' || saved === 'payments' || saved === 'oplog' || saved === 'asin') return saved
  } catch {
    // localStorage 被禁用（隐私模式/宿主限制）时退回默认，不影响功能
  }
  return AD_DEFAULT
}

function writeLastAdView(view: AdView): void {
  try { globalThis.localStorage?.setItem(AD_LAST_KEY, view) } catch { /* 同上，失败不影响切页 */ }
}

export function WorkbenchHeader(props: WorkbenchAssembly): JSX.Element {
  const { t } = useI18n()
  const { busy } = props.busyApi
  const { setPendingOpen } = props.draftsApi.actions
  const { view } = props.nav
  const { setView } = props.nav.actions
  const { setShowSettings } = props.prefs.actions
  const { closePanel, collapseAll, forms, openQuickEntry, pendingCount } = props
  const adView = AD_VIEWS.find((entry) => entry.key === view)
  const inAds = adView !== undefined
  const lastAd = inAds ? adView.key : readLastAdView()
  const lastAdLabel = AD_VIEWS.find((entry) => entry.key === lastAd)?.label ?? '测算'
  return (
    <>
    <div className="wb-h">
        <div className="wb-title"><Icon name="calendar" size={19} />{t('个人工作台')}</div>
        <div className="wb-segmented" data-primary-tabs>
          <button className={`wb-seg ${view === 'today' ? 'on' : ''}`} onClick={() => setView('today')}><Icon name="today" />{t('今日')}</button>
          <button className={`wb-seg ${view === 'calendar' ? 'on' : ''}`} onClick={() => setView('calendar')}><Icon name="calendar" />{t('日历')}</button>
          <button className={`wb-seg ${view === 'list' ? 'on' : ''}`} onClick={() => setView('list')}><Icon name="list" />{t('任务')}</button>
          <button className={`wb-seg ${view === 'knowledge' ? 'on' : ''}`} onClick={() => setView('knowledge')}><Icon name="book" />{t('知识库')}</button>
          <button className={`wb-seg ${view === 'ideas' ? 'on' : ''}`} onClick={() => setView('ideas')}><Icon name="idea" />{t('点子')}</button>
          {/* 父项：常驻显示当前子项名；点它就是回到上次进的子项 */}
          <button
            className={`wb-seg ${inAds ? 'on' : ''}`}
            data-ad-parent
            title={t('亚马逊：广告分析（测算 / 关键词 / 流量分析 / 报表分析）· 商品与经营（选品 / 库存 / 付款对账 / 运营日志）')}
            onClick={() => setView(lastAd)}
          ><Icon name="chart" />{inAds ? `${t('亚马逊')} · ${t(adView.label)}` : t('亚马逊')}</button>
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
    {inAds && (
      <div className="wb-h wb-h-sub" data-ad-subtabs>
        {AD_GROUPS.map((group) => (
          <div
            key={group.label}
            className="wb-segmented wb-sub-segmented"
            data-ad-group={group.label}
            role="group"
            aria-label={t(group.label)}
          >
            {group.views.map((entry) => (
              <button
                key={entry.key}
                className={`wb-seg ${view === entry.key ? 'on' : ''}`}
                data-ad-tab={entry.key}
                onClick={() => { writeLastAdView(entry.key); setView(entry.key) }}
              ><Icon name={entry.icon} />{t(entry.label)}</button>
            ))}
          </div>
        ))}
      </div>
    )}
    </>
  )
}
