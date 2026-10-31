/**
 * **仪表盘**（2026-10-27，方案 A）：今日视图的**上半屏**。
 *
 * ## 它取代了什么
 * 原先今日视图顶部是「4 张统计卡 + 容量条」。四张卡只报数、不告诉你该干什么；
 * 而真正要动手的东西（逾期、没排进计划的、完成却没写日志的）散在四个页面里。
 * 现在合成一块**动手清单 + 域快照**，容量面板**原样**搬进右栏（它自带行内编辑和
 * 规则面板，这里一个字都不重画 —— 传进来的是现成的 `capacityPane` 节点）。
 *
 * ## 边界（和项目其他视图同一条）
 * - **不发 HTTP**：所有数字由装配层取好传进来（统计来自 `bootstrap.stats`、
 *   未排入来自 `CapacityLedger`、日志摘要来自 `useOplogDayIndex`）。
 * - **不编数字**：缺数据源显示 `needs_data`，不写 0 —— 0 是「确实是零」，
 *   缺数据是「不知道」，两者在运营判断上完全相反。
 * - **空模块不画空壳**：没有待办就一行说明，没有动态就整块不渲染，
 *   避免把仪表盘做成"占位符收集器"。
 */
import type { ReactNode } from 'react'
import { Icon } from '../components/Icon.js'
import { useI18n } from '../i18n.js'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 本地日键 → 星期文案（用固定表，不依赖宿主 locale）。 */
export function weekdayOf(day: string): string {
  const parsed = new Date(`${day}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return ''
  return WEEKDAYS[parsed.getDay()] ?? ''
}

export interface DashboardStats {
  overdue: number
  todayDue: number
  doing: number
  total: number
}

export interface DashboardAmazonFacts {
  /** 已导入的亚马逊报表数据集份数。 */
  datasetCount: number
  /** 最新一份的数据时间（已格式化；`null` = 没有数据集）。 */
  datasetLatest: string | null
  keywordPlanCount: number
  /** 最新一份关键词计划的词数 / 否词数。 */
  keywordPlanWords: number
  keywordPlanNegatives: number
  /** 库存流水线是否已有真实数据（无 → 显示 needs_data，不显示 0）。 */
  inventoryReady: boolean
}

export type DashboardPaneProps = {
  /** 今日本地日键 `YYYY-MM-DD`。 */
  day: string
  stats: DashboardStats | undefined
  /** 未排入今日计划的候选条数（`CapacityLedger.unscheduledCount`）。 */
  unscheduledCount: number
  /** 今天完成、但还没写进任何日志的任务数。 */
  pendingArchive: number
  oplog: { week: number; month: number; total: number; recent: Array<{ date: string; title: string }> }
  amazon: DashboardAmazonFacts
  /** 最近完成的任务（作为动态流的一半）。 */
  recentDone: Array<{ date: string; title: string }>
  /** 容量面板：**原样传入**现成的 `.wb-cap` 节点，这里只负责把它放进右栏。 */
  capacityPane: ReactNode
  onQuickEntry: () => void
  onNewTask: () => void
  /** 「待我处理」里的任务类项统一跳任务页。 */
  onOpenTasks: () => void
  /** 待归档项跳运营日志。 */
  onOpenOplog: () => void
  onOpenAmazon: () => void
}

export function DashboardPane(props: DashboardPaneProps): JSX.Element {
  const { t } = useI18n()
  const {
    day, stats, unscheduledCount, pendingArchive, oplog, amazon, recentDone, capacityPane,
    onQuickEntry, onNewTask, onOpenTasks, onOpenOplog, onOpenAmazon,
  } = props

  const overdue = stats?.overdue ?? 0
  const todayDue = stats?.todayDue ?? 0
  const doing = stats?.doing ?? 0
  const total = stats?.total ?? 0

  /**
   * 动手清单：**只放"现在需要你动一下"的事**。
   * 为 0 的项不进清单（仪表盘上列一串 0 是最典型的噪声）。
   */
  const queue: Array<{ key: string; n: number; title: string; desc: string; warn: boolean; go: () => void }> = []
  if (overdue > 0) {
    queue.push({
      key: 'overdue', n: overdue, warn: true,
      title: t('逾期任务'),
      desc: t('截止时间已过，先定去留或改期'),
      go: onOpenTasks,
    })
  }
  if (unscheduledCount > 0) {
    queue.push({
      key: 'unscheduled', n: unscheduledCount, warn: false,
      title: t('未排入今日计划'),
      desc: t('排进计划才会进容量账本'),
      go: onOpenTasks,
    })
  }
  if (pendingArchive > 0) {
    queue.push({
      key: 'archive', n: pendingArchive, warn: false,
      title: t('今天完成的还没写日志'),
      desc: t('点开运营日志，用建议条一键预填'),
      go: onOpenOplog,
    })
  }

  /** 动态流：最近完成 + 最近日志，按日期倒序取 6 条。 */
  const timeline = [...recentDone.map((item) => ({ ...item, kind: 'done' as const })),
    ...oplog.recent.map((item) => ({ ...item, kind: 'log' as const }))]
    .filter((item) => item.date !== '')
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6)

  const needsBadge = (): JSX.Element => <span className="wb-needs">needs_data</span>

  return (
    <div className="wb-dash">
      {/* ── 态势条：先给结论，不给一排数字卡 ── */}
      <div className="wb-dash-hero">
        <div className="wb-dash-hero-main">
          <div className="wb-dash-date">{day} · {weekdayOf(day)}</div>
          <div className="wb-dash-line">
            {t('今日到期')} <b>{todayDue}</b>
            <span className="wb-dash-sep">·</span>{t('逾期')} <b className={overdue > 0 ? 'is-warn' : 'is-quiet'}>{overdue}</b>
            <span className="wb-dash-sep">·</span>{t('进行中')} <b className={doing > 0 ? '' : 'is-quiet'}>{doing}</b>
            <span className="wb-dash-sep">·</span>{t('待归档日志')} <b className={pendingArchive > 0 ? '' : 'is-quiet'}>{pendingArchive}</b>
          </div>
        </div>
        <div className="wb-dash-hero-actions">
          <button className="wb-btn primary" onClick={onQuickEntry}><Icon name="sparkles" />{t('快速录入')}</button>
          <button className="wb-btn" onClick={onNewTask}><Icon name="plus" />{t('新建任务')}</button>
        </div>
      </div>

      {/* ── 主区：动手清单 + 今日节奏 ── */}
      <div className="wb-dash-main">
        <section className="wb-card wb-dash-queue-card">
          <h4><Icon name="bell" size={16} />{t('待我处理')}{queue.length > 0 && <span className="count">{queue.length}</span>}</h4>
          {queue.length === 0
            ? <div className="wb-dash-quiet">{t('今天没有需要你处理的事。')}</div>
            : (
              <ul className="wb-dash-queue">
                {queue.map((row) => (
                  <li className="wb-q" key={row.key}>
                    <span className={`wb-q-n${row.warn ? ' is-warn' : ''}`}>{row.n}</span>
                    <span className="wb-q-body">
                      <span className="wb-q-t">{row.title}</span>
                      <span className="wb-q-d">{row.desc}</span>
                    </span>
                    <button className="wb-btn wb-q-go" onClick={row.go}><Icon name="chevron" size={13} />{t('查看')}</button>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section className="wb-card wb-dash-rhythm">
          <h4><Icon name="today" size={16} />{t('今日节奏')}</h4>
          {capacityPane}
        </section>
      </div>

      {/* ── 域快照：缺数据源标 needs_data，不写 0 ── */}
      <div className="wb-dash-domains">
        <section className="wb-card">
          <h4><Icon name="list" size={16} />{t('任务')}</h4>
          <div className="wb-dash-kv"><b>{total}</b><span>{t('总数')}</span></div>
          <div className="wb-dash-sub">
            <span>{t('逾期')} <b>{overdue}</b></span>
            <span>{t('今日')} <b>{todayDue}</b></span>
            <span>{t('进行中')} <b>{doing}</b></span>
          </div>
          <div className="wb-dash-foot">{t('数据时间：刚刚')}</div>
        </section>

        <section className="wb-card">
          <h4><Icon name="report" size={16} />{t('运营日志')}</h4>
          {oplog.total === 0
            ? <div className="wb-dash-quiet">{t('还没有运营日志。')}</div>
            : <div className="wb-dash-kv"><b>{oplog.total}</b><span>{t('累计条数')}</span></div>}
          <div className="wb-dash-sub">
            <span>{t('本周')} <b>{oplog.week}</b></span>
            <span>{t('本月')} <b>{oplog.month}</b></span>
          </div>
          <div className="wb-dash-foot">
            {oplog.recent.length === 0
              ? t('最近：无')
              : `${t('最近')}：${oplog.recent[0].date} · ${oplog.recent[0].title}`}
          </div>
        </section>

        <section className="wb-card">
          <h4><Icon name="chart" size={16} />{t('亚马逊数据')}</h4>
          <div className="wb-dash-sub wb-dash-sub-col">
            <span>{t('搜索词报表')} {amazon.datasetCount === 0 ? needsBadge() : <><b>{amazon.datasetCount}</b> {t('份')}</>}</span>
            <span>{t('关键词计划')} {amazon.keywordPlanCount === 0 ? needsBadge() : <><b>{amazon.keywordPlanCount}</b> {t('份 · {w} 词 / {n} 否词', { w: amazon.keywordPlanWords, n: amazon.keywordPlanNegatives })}</>}</span>
            <span>{t('库存')} {amazon.inventoryReady ? t('已有数据') : needsBadge()}</span>
          </div>
          <div className="wb-dash-foot">
            {amazon.datasetLatest === null ? t('数据时间：无') : `${t('数据时间')}：${amazon.datasetLatest}`}
            <button className="wb-btn wb-dash-foot-go" onClick={onOpenAmazon}>{t('去查看')}</button>
          </div>
        </section>
      </div>

      {/* ── 最近动态：没有就整块不渲染 ── */}
      {timeline.length > 0 && (
        <section className="wb-card">
          <h4><Icon name="book" size={16} />{t('最近动态')}</h4>
          <div className="wb-tl">
            {timeline.map((item) => (
              <div className="wb-tl-item" key={`${item.kind}-${item.date}-${item.title}`}>
                <span className="wb-tl-date">{item.date}</span>
                <span className="wb-tl-kind">{item.kind === 'log' ? t('日志') : t('完成')}</span>
                <span className="wb-tl-text">{item.title}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
