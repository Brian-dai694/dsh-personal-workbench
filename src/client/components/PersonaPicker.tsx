/**
 * 角色选择器（D13-B / requirements §6.3、AX-R07；P8 §9.2 改数据源）。
 *
 * ## 一个组件、两个入口
 *
 * "快速录入"弹窗与"共享提示词"弹窗**用同一个组件、同一套选择逻辑**
 * （需求 §6.3）。所以本组件只吃 props、把选择回调出去，自己**不判**"要不要新建会话" ——
 * 那是纯函数 `personaPicker.ts#decidePersonaReuse` 的事。
 *
 * ## 形态对齐「加载 Skill」（2026-10-01 按用户带截图的反馈重做）
 *
 * 1. **搜索框常驻**；2. **全部角色铺在同一页**靠滚动看（没有「更多角色」按钮）；
 * 3. **收藏 / 停用搬去设置页**，选择器只留「只看收藏」筛选。
 *
 * ## 状态所有权（P8 改）
 *
 * 旧实现自己 `GET /api/workbench/personas` 再自持一份列表 —— P8 起**不再自己拉**：
 * 角色来源改为**专家目录**（`/experts/catalog` 的 `personas`，服务端只放 `usable` 的），
 * 由 `useWorkbenchExperts` 拥有并作为 `personas` prop 传进来（方案 §9.2 与 §12.3）。
 *
 * 这么做不是为了省一次请求，而是为了**只有一份"哪些角色能用"的判定**：
 * required 依赖技能缺失的角色在目录里是 `dependency-unavailable`，客户端第二道闸门由
 * `expertPickerPersonas()` 统一剔除；选择器若自己再读旧接口，就会出现
 * "管理页说不可用、选择器还能选"的分叉（AX-E56 要防的正是这个）。
 *
 * 本组件保留的本地状态只有"搜索词"与"只看收藏"两个纯 UI 过滤条件。
 */
import { useMemo, useState } from 'react'
import type { PersonaSummary } from '../../shared/persona.js'
import {
  INHERIT_PERSONA, NO_PERSONA, groupPersonas, personaPickerList,
  personaSelectionFor, personaSelectionLabel, personaSourceLabel,
  type PersonaSelection,
} from '../personaPicker.js'
import { Icon } from './Icon.js'
import { useI18n } from '../i18n.js'

export interface PersonaPickerProps {
  value: PersonaSelection
  onChange: (next: PersonaSelection) => void
  disabled?: boolean
  /**
   * 可选角色（**唯一来源**：专家目录里 `usable` 的那些，已过 `expertPickerPersonas()`）。
   * 手工角色来源未登记也在这里（`provenanceState='unrecorded'` 仍可用）。
   */
  personas: readonly PersonaSummary[]
  /** 目录是否还在读（装配层给 `experts.catalogLoading`）。 */
  loading?: boolean
  /** 读目录失败的可读原因（装配层给 `experts.catalogError?.message`）。 */
  problem?: string
  /** 重试（装配层给 `experts.actions.refreshCatalog`）。 */
  onRetry?: () => void
}

export function PersonaPicker({ value, onChange, disabled = false, personas, loading = false, problem = '', onRetry }: PersonaPickerProps): React.ReactNode {
  const { t, count } = useI18n()
  const [query, setQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const favoriteCount = useMemo(() => personas.filter((persona) => persona.favorite).length, [personas])
  const enabledCount = useMemo(() => personas.filter((persona) => persona.enabled).length, [personas])
  const disabledCount = personas.length - enabledCount
  /**
   * 列表口径**只有一处**：`personaPickerList()`（纯函数，有单测）。
   * 组件不自己写第二份 filter —— 本项目为"同一语义多处实现"付过 15 小时的代价。
   */
  const visible = useMemo(() => personaPickerList(personas, query, { favoritesOnly }), [personas, query, favoritesOnly])
  const groups = useMemo(() => groupPersonas(visible), [visible])
  /** 当前选中的角色：即使被筛掉也要让头部说得出选了谁（头部本来就读 value）。 */
  const selectedMissing = value.mode === 'persona'
    && visible.some((persona) => persona.id === value.personaId) === false

  const pickClass = (on: boolean, extra = ''): string => `wb-persona-item${on ? ' on' : ''}${extra === '' ? '' : ` ${extra}`}`

  return (
    <div className="wb-persona-picker">
      <div className="wb-persona-head">
        <span><Icon name="ai" size={13} />{t('角色（专家人格）')}</span>
        <span className="wb-persona-current">{t(personaSelectionLabel(value, personas))}</span>
      </div>

      {problem !== '' && (
        <div className="wb-skill-problem" role="status">
          <span><Icon name="ai" size={13} /> {t('角色库暂不可用 —— {message}', { message: problem })}</span>
          {onRetry !== undefined && (
            <button type="button" className="wb-btn" onClick={onRetry}><Icon name="refresh" size={12} />{t('重试')}</button>
          )}
        </div>
      )}

      {/* 搜索常驻（与「加载 Skill」同形）：过滤全部角色，不做分页/截断 */}
      <div className="wb-persona-toolbar">
        <input
          className="wb-skill-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索角色名 / 简介 / 分组 / 工作模式（共 {n} 个）', { n: personas.length })}
        />
        <button
          type="button"
          className={`wb-btn${favoritesOnly ? ' primary' : ''}`}
          onClick={() => setFavoritesOnly((prev) => !prev)}
          title={favoriteCount === 0
            ? '还没有收藏角色 —— 可以在「设置 → 角色库」里收藏'
            : '只看已收藏的角色'}
        >
          {favoritesOnly ? t('★ 只看收藏') : t('☆ 只看收藏')}
        </button>
      </div>

      <div className="wb-persona-list">
        <button
          type="button"
          className={pickClass(value.mode === 'inherit')}
          disabled={disabled}
          onClick={() => onChange(INHERIT_PERSONA)}
        >
          <span className="wb-persona-name">{t('未指定（沿用该会话原有角色）')}</span>
          <span className="wb-persona-desc">{t('复用型会话继续用原来的角色；新会话等于无角色')}</span>
        </button>
        <button
          type="button"
          className={pickClass(value.mode === 'none')}
          disabled={disabled}
          onClick={() => onChange(NO_PERSONA)}
        >
          <span className="wb-persona-name">{t('无角色')}</span>
          <span className="wb-persona-desc">{t('明确不带人格（与"复用会话原有角色"不同：那会新建会话）')}</span>
        </button>

        {loading && <div className="wb-skill-hint">{t('读取角色库…')}</div>}
        {!loading && groups.length === 0 && (
          <div className="wb-skill-hint">
            {personas.length === 0
              ? t('角色库为空（内置库没打包进来？）。不影响本会话继续使用。')
              : favoritesOnly && favoriteCount === 0
                ? t('还没有收藏角色 —— 在「设置 → 角色库（专家人格）」里点☆收藏，收藏后这里就能筛出来。')
                : t('没有匹配的角色')}
          </div>
        )}
        {!loading && selectedMissing && (
          <div className="wb-skill-hint">{t('当前选中的角色不在筛选结果里（改一下搜索或关掉「只看收藏」就能看到它）。')}</div>
        )}
        {!loading && groups.map((group) => (
          <div className="wb-persona-group" key={group.group}>
            <div className="wb-persona-group-name">
              {t(group.label)}
              <span className="wb-persona-group-count">{group.items.length} 个</span>
            </div>
            {group.items.map((persona) => (
              <button
                type="button"
                key={`${persona.sourceKey}:${persona.id}`}
                className={pickClass(value.mode === 'persona' && value.personaId === persona.id && value.sourceKey === persona.sourceKey, persona.enabled ? '' : 'off')}
                disabled={disabled || persona.enabled === false}
                onClick={() => onChange(personaSelectionFor(persona.id, persona.sourceKey))}
                title={persona.enabled
                  ? `${persona.id}｜${personaSourceLabel(persona.source)}${persona.favorite ? '｜已收藏' : ''}`
                  : `${persona.id}（已停用，需先在设置里启用）`}
              >
                <span className="wb-persona-name">{persona.emoji === '' ? '' : `${persona.emoji} `}{persona.name}{persona.favorite ? ' ★' : ''}{persona.enabled ? '' : t('（已停用）')}</span>
                <span className="wb-persona-desc">{persona.description === '' ? t('（无简介）') : persona.description}</span>
                <span className="wb-persona-source">{t(personaSourceLabel(persona.source))}{persona.mode === '' ? '' : `｜${persona.mode}`}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="wb-persona-foot">
        {t('共 {n} 个可用角色（当前显示 {shown} 个；启用 {enabled}{disabledPart}）', { n: personas.length, shown: visible.length, enabled: enabledCount, disabledPart: disabledCount > 0 ? ` / ${t('停用')} ${disabledCount}` : '' })}
        · {t('依赖技能缺失的角色不出现在这里（在「设置 → 角色库」里能看到原因）')}
        · {t('收藏与停用在设置里改 · 角色正文由 AI 按需加载，不写进提示词')}
      </div>
    </div>
  )
}
