/**
 * 角色库管理（P8 重写）—— **受控组件**：目录与收藏/停用都由 `useWorkbenchExperts` 拥有。
 *
 * ## 为什么重写（方案 §12.3）
 *
 * P8 之前这里自持一份 `GET /api/workbench/personas` 的列表 state。专家功能上线后，
 * 同一个界面还要展示"来源/状态/依赖技能/安装未完成"这类**只能从 `/experts/catalog`
 * 拿到**的事实。如果这里再保留一份自拉的列表，就会出现"管理器里的角色"与
 * "专家目录里的专家"是两份数据、两个 loading、两个错误 —— 典型的同一语义两处实现
 * （`dsh-plugin-change` §1：**状态所有权要唯一**）。
 *
 * 所以：目录、loading、error、auto 开关、收藏/停用的即时反馈**全部**由专家域 hook 拥有，
 * 本组件只接收 `catalog` / `autoSummon` / `personaFlags` 与 actions。这里保留的本地状态
 * 只有"搜索词"和"状态筛选"两个纯 UI 过滤条件（它们不是数据，不进任何存储）。
 *
 * ## 三条不动的口径
 *
 * 1. **收藏/停用仍然"立即保存"**：`onToggleFavorite` / `onToggleDisabled` 走
 *    hook 里那条"现读服务端现值 → `personaFlagPatch` → POST → 重读目录"的既有链路，
 *    不引入"跟着保存设置一起提交"的新语义（那会让用户点完☆看到的是假状态）。
 * 2. **坏行照列**：`invalid` / `dependency-unavailable` / `installation-incomplete`
 *    都要能在列表里看到并筛出来（AX-E56）。**不**因为"不能用"就藏起来。
 * 3. **不显示的三种东西**：服务端绝对目录（`sourceKeyLabel` 只给目录名末段）、
 *    install journal 内部字段、ticket / 宿主注入细节（方案 §9.3 最后一条）。
 *    也**不提供**本期没设计的同步 / 更新 / 覆盖 / 删除按钮。
 *
 * 稳定选择器（方案 §12.3，逐字）：`data-wb-experts="admin"`、
 * `data-wb-expert-action="create"`、`data-wb-expert-field="auto-summon"`、
 * `data-wb-expert-id="<逻辑 ID>"`、`data-wb-expert-status="<status>"`、
 * `data-wb-expert-draft="<draftId>"`、`data-wb-expert-error="<稳定 code>"`。
 */
import { useMemo, useState } from 'react'
import type { DraftView } from '../../shared/contracts.js'
import { Icon } from './Icon.js'
import { useI18n } from '../i18n.js'
import {
  EXPERT_STATUS_LABELS,
  expertAdminRows,
  expertRowView,
  type ExpertCatalogView,
  type ExpertUiError,
} from '../hooks/useWorkbenchExperts.js'

/** 状态筛选的取值（`all` = 不筛）。 */
type StatusFilter = keyof typeof EXPERT_STATUS_LABELS | 'all'

const STATUS_FILTERS: StatusFilter[] = [
  'all',
  'usable',
  'disabled',
  'invalid',
  'dependency-unavailable',
  'installation-incomplete',
]

export interface PersonaAdminProps {
  /** 设置页正在保存（与旧行为一致：保存期间禁用 flag 按钮）。 */
  saving: boolean
  /** 专家目录（唯一所有者是 `useWorkbenchExperts`）。 */
  catalog: ExpertCatalogView
  loading: boolean
  error: ExpertUiError | null
  /** 自主召唤开关：默认关；关掉也不影响手动 `@` / `/expert`。 */
  autoSummon: { value: boolean; busy: boolean; error: ExpertUiError | null }
  /** 收藏/停用的即时反馈（与旧行为一致，就地显示）。 */
  personaFlags: { busyId: string; notice: string; error: ExpertUiError | null }
  /** 待确认的专家草稿（pending）：不当"已安装"展示，只给入口。 */
  pendingExpertDrafts: readonly DraftView[]
  onRefresh: () => Promise<void>
  onSetAuto: (value: boolean) => Promise<void>
  onToggleFavorite: (id: string) => Promise<void>
  onToggleDisabled: (id: string) => Promise<void>
  /** 「新建专家」：打开创建弹窗（弹窗本身由装配层渲染）。 */
  onCreate: () => void
  /** 打开某份待确认专家草稿的预览（复用草稿横幅那条路）。 */
  onOpenDraft: (draft: DraftView) => void
  /** 「继续修改」：打开它的生成会话。 */
  onEditDraft: (draft: DraftView) => void
}

export function PersonaAdmin(props: PersonaAdminProps): JSX.Element {
  const { t } = useI18n()
  const { catalog, loading, error, autoSummon, personaFlags, saving } = props
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')

  const rows = useMemo(
    () => expertAdminRows(catalog, query, status).map(expertRowView),
    [catalog, query, status],
  )
  const usableCount = useMemo(() => catalog.experts.filter((row) => row.status === 'usable').length, [catalog])
  const favoriteCount = useMemo(() => catalog.experts.filter((row) => row.favorite).length, [catalog])
  const disabledCount = useMemo(() => catalog.experts.filter((row) => row.enabled === false).length, [catalog])
  const flagBusy = personaFlags.busyId !== ''

  return (
    <div className="wb-persona-admin" data-wb-experts="admin">
      <div className="wb-persona-toolbar">
        <button type="button" className="wb-btn" data-wb-expert-action="create" onClick={props.onCreate}>
          {t('新建专家')}
        </button>
        <button type="button" className="wb-btn" disabled={loading} onClick={() => void props.onRefresh()}>
          <Icon name="refresh" size={12} />{t('刷新')}
        </button>
        <input
          className="wb-skill-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索专家（共 {n} 个）', { n: catalog.experts.length })}
          title={t('搜索专家名 / 简介 / 分组（共 {n} 个）', { n: catalog.experts.length })}
        />
        <select
          className="wb-skill-search"
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          title={t('按状态筛选（坏行也会列出来，方便看原因）')}
        >
          {STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === 'all' ? t('全部状态') : t(EXPERT_STATUS_LABELS[value])}
            </option>
          ))}
        </select>
        <span className="wb-persona-source">
          {t('可用 {available}｜★ 已收藏 {favorites}｜停用 {disabled}', { available: usableCount, favorites: favoriteCount, disabled: disabledCount })}
        </span>
      </div>

      {/**
        * 自主召唤开关：**立即保存**（`autoSummonExperts` 是唯一设置值，写法沿用既有
        * `saveIncludeOverdue` 的乐观 + 失败回滚口径）。文案必须说清"关掉也不影响手动入口"——
        * 默认关是刻意的（review-entry：默认关闭自主召唤，关闭时手动 @ /expert 仍能运行）。
        */}
      <label className="wb-switch-row">
        <input
          type="checkbox"
          data-wb-expert-field="auto-summon"
          checked={autoSummon.value}
          disabled={autoSummon.busy || saving}
          onChange={(event) => void props.onSetAuto(event.target.checked)}
        />
        <span className="wb-switch-desc">
          {t('允许 AI 自主召唤专家（默认关闭）')}
          <br />
          {t('关闭时手动 @ 引用专家与 /expert 命令照常可用；打开后 AI 才可能在执行过程中自己挑专家。')}
          {autoSummon.error !== null && (
            <span className="wb-notes-warn" data-wb-expert-error={autoSummon.error.code}>
              {autoSummon.error.message}
            </span>
          )}
        </span>
      </label>

      {error !== null && (
        <div className="wb-skill-problem" role="status" data-wb-expert-error={error.code}>
          <span>{t('专家目录读不到 —— {message}', { message: error.message })}</span>
          <button type="button" className="wb-btn" onClick={() => void props.onRefresh()}><Icon name="refresh" size={12} />{t('重试')}</button>
        </div>
      )}
      {personaFlags.notice !== '' && <div className="wb-hint">{personaFlags.notice}</div>}
      {personaFlags.error !== null && (
        <div className="wb-skill-problem" role="status" data-wb-expert-error={personaFlags.error.code}>
          <span>{personaFlags.error.message}</span>
        </div>
      )}

      {/**
        * 待确认草稿区：**pending 就是 pending**，不许当作"已安装的专家"。
        * 只给两个入口（查看草稿 / 继续修改），确认动作在草稿预览里（那里能看到版本与哈希）。
        */}
      {props.pendingExpertDrafts.length > 0 && (
        <div className="wb-notes">
          <div className="wb-notes-body">
            <b>{t('待确认草稿 {n} 份 —— 还没有安装到你的用户库。', { n: props.pendingExpertDrafts.length })}</b>
          </div>
          <div className="wb-persona-admin-list">
            {props.pendingExpertDrafts.map((draft) => (
              <div className="wb-persona-row" key={draft.id} data-wb-expert-draft={draft.id} data-wb-expert-status="pending">
                <div className="wb-persona-info">
                  <div className="wb-persona-name">{pendingTitle(draft)}</div>
                  <div className="wb-persona-desc">{pendingRequest(draft)}</div>
                  <div className="wb-persona-source">{t('草稿 {id}', { id: draft.id })}</div>
                </div>
                <div className="wb-persona-actions">
                  <button type="button" className="wb-persona-flag" onClick={() => props.onOpenDraft(draft)}>{t('查看草稿')}</button>
                  <button type="button" className="wb-persona-flag" onClick={() => props.onEditDraft(draft)}>{t('继续修改')}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="wb-persona-admin-list">
        {loading && <div className="wb-persona-note">{t('读取专家目录…')}</div>}
        {!loading && rows.length === 0 && (
          <div className="wb-persona-note">
            {catalog.experts.length === 0 ? t('目录为空（内置库没打包进来？）') : t('没有匹配的专家')}
          </div>
        )}
        {!loading && rows.map((row) => (
          <div
            className="wb-persona-row"
            key={row.id}
            data-wb-expert-id={row.id}
            data-wb-expert-status={row.status}
          >
            <div className="wb-persona-info">
              <div className="wb-persona-name" title={row.id}>
                {row.name}
                {row.status !== 'usable' && <span className="wb-persona-off-tag">{t(row.statusLabel)}</span>}
              </div>
              <div className="wb-persona-desc">{row.description === '' ? t('（无简介）') : row.description}</div>
              <div className="wb-persona-source">
                {[t(row.sourceLabel), t(row.group), row.sourceKeyLabel.startsWith('外部目录') ? `${t('外部目录')}${row.sourceKeyLabel.slice('外部目录'.length)}` : t(row.sourceKeyLabel), t(row.provenanceLabel)].filter((part) => part !== '').join('｜')}
              </div>
              {row.issueLines.length > 0 && (
                <div className="wb-notes-warn">{row.issueLines.join('；')}</div>
              )}
              {/**
                * 展开详情：来源登记（repo / path / commit / 许可）与每个 skill **实际生效的 provider**。
                * 这里只有登记信息本身，没有 journal 内部字段、没有 ticket、没有宿主注入细节。
                */}
              {(row.sourceLines.length > 0 || row.skillLines.length > 0) && (
                <details className="wb-notes">
                  <summary>{t('来源与技能')}</summary>
                  <div className="wb-notes-body">
                    {row.sourceLines.length === 0
                      ? <p>{t('没有登记上游来源。')}</p>
                      : <ul className="wb-list">{row.sourceLines.map((line, index) => <li key={`s${index}`}>{line}</li>)}</ul>}
                    {row.skillLines.length > 0 && (
                      <ul className="wb-list">{row.skillLines.map((line, index) => <li key={`k${index}`}>{line}</li>)}</ul>
                    )}
                  </div>
                </details>
              )}
            </div>
            <div className="wb-persona-actions">
              <button
                type="button"
                className={`wb-persona-flag${row.favorite ? ' on' : ''}`}
                disabled={flagBusy || saving}
                onClick={() => void props.onToggleFavorite(row.id)}
                title={row.favorite ? t('取消收藏') : t('收藏（选择器里可用「只看收藏」筛出来）')}
              >
                {row.favorite ? t('★ 已收藏') : t('☆ 收藏')}
              </button>
              <button
                type="button"
                className="wb-persona-flag"
                disabled={flagBusy || saving}
                onClick={() => void props.onToggleDisabled(row.id)}
                title={row.enabled ? t('停用：不再出现在可选列表里（这里仍列出来，可随时启用回来）') : t('重新启用')}
              >
                {row.enabled ? t('停用') : t('启用')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/**
        * 说明块（P8 改写）：旧的"工作台从不写角色文件"与新建专家功能直接矛盾 ——
        * 新建专家**会在用户确认后写用户库**。这里只保留真实口径。
        */}
      <details className="wb-notes">
        <summary>{t('说明（来源与写入范围 / 停用为何仍列出）')}</summary>
        <div className="wb-notes-body">
          <p><b>{t('内置 / 外部角色只读')}</b>：{t('工作台不复制、不修改、不覆盖它们。')}</p>
          <p><b>{t('新建专家只在用户确认后写入用户库')}</b>：{t('AI 先暂存成草稿，确认前不落盘到用户库。')}</p>
          <p><b>{t('停用的角色仍会列在这里')}</b>{t('（否则就启用不回来了），只是不能在选择器中选中。')}</p>
          <p>{t('角色正文与资源由')} <code>workbench_load_persona</code> / <code>workbench_read_persona_resource</code> {t('按需读取，不预先塞进提示词。')}</p>
        </div>
      </details>
    </div>
  )
}

/** 待确认草稿的标题：优先用 payload 里的中文名，其次逻辑 ID（读不出来才用 draft id）。 */
function pendingTitle(draft: DraftView): string {
  const payload = draft.payload as { personaMd?: unknown; expertId?: unknown } | null | undefined
  const personaMd = typeof payload?.personaMd === 'string' ? payload.personaMd : ''
  const name = /(?:^|\n)name:\s*(.+)/.exec(personaMd)?.[1]?.trim()
  if (name !== undefined && name !== '') return name
  return typeof payload?.expertId === 'string' && payload.expertId !== '' ? payload.expertId : '待确认的专家草稿'
}

/** 待确认草稿的简介：拿不到就显示用户当初的请求（比空白有用）。 */
function pendingRequest(draft: DraftView): string {
  const payload = draft.payload as { request?: unknown } | null | undefined
  const request = typeof payload?.request === 'string' ? payload.request.trim() : ''
  return request === '' ? '（没有需求描述）' : request
}
