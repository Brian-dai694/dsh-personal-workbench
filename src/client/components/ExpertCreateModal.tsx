/**
 * 新建专家弹窗（P8 / 方案 §5.4 第 1–3 步 + 第 10–11 步的界面侧）。
 *
 * 本组件是**纯展示**：它不建会话、不发请求、不判断能力 —— 全部由
 * `useWorkbenchExperts` 的 `create` 状态与 `actions` 驱动（方案 §12.3：
 * `WorkbenchApp` 只装配，业务状态归本域 hook 所有）。
 *
 * 三条不可动摇的约定：
 * 1. **文本为空禁用提交**；重复点击由本域 busy 拒绝（AX-E52）——按钮禁用只是
 *    界面礼貌，真正的闸门在 `createExpertGenerationRunner` 的闭包 busy 上。
 * 2. 工作区**必须选一个**：默认值由装配层按"当前会话 cwd 匹配已有工作区"给出，
 *    匹配不上就留空让用户选（方案 §5.4 第 1 步：绝不自动创建任务资料夹）。
 * 3. 缺 `sessions.create` 时**明说缺能力**（`create-unavailable`），
 *    不静默降级成"复用当前会话"（方案 §10 降级表）。
 *
 * 稳定选择器（方案 §12.3，逐字）：`data-wb-experts="create-modal"`、
 * `data-wb-expert-field="request"` / `"workspace"`、
 * `data-wb-expert-action="start-generation"`、`data-wb-expert-error="<code>"`。
 */
import type { ReactNode } from 'react'
import { EXPERT_REQUEST_MAX_CHARS } from '../../shared/expert.js'
import { Modal } from './Modal.js'
import type { ExpertUiError, WorkspaceChoice } from '../hooks/useWorkbenchExperts.js'
import { useI18n } from '../i18n.js'

/** 缺能力时的可读原因（三处共用同一句，避免"同一个失败两套说法"）。 */
export const EXPERT_CREATE_UNAVAILABLE_MESSAGE =
  '当前宿主没有提供 sessions.create，无法新开一个独立的生成会话。浏览与使用已有专家不受影响。'

export interface ExpertCreateModalProps {
  open: boolean
  request: string
  workspaceId: string
  /** 可选择的工作区（来自装配层的 `workspaceChoices`）。 */
  workspaceChoices: readonly WorkspaceChoice[]
  busy: boolean
  error: ExpertUiError | null
  /** 宿主是否提供 `sessions.create`（`hasSessionCreate()` 的结果）。 */
  createAvailable: boolean
  /** 上一次流程已经建出来的生成会话（失败后给"打开生成会话"用；没有则 null）。 */
  generationSessionId: string | null
  generationDraftId: string | null
  onChangeRequest: (text: string) => void
  onChangeWorkspace: (workspaceId: string) => void
  onStart: () => void
  onClose: () => void
  /** 打开生成会话（复用草稿横幅那条 `openSessionInMainView` 路径）。 */
  onOpenSession: () => void
}

export function ExpertCreateModal(props: ExpertCreateModalProps): ReactNode {
  const { t } = useI18n()
  if (props.open === false) return null
  const { busy, error, createAvailable } = props
  const emptyRequest = props.request.trim() === ''
  const noWorkspace = props.workspaceId.trim() === ''
  const blocked = busy || createAvailable === false || emptyRequest || noWorkspace
  const reason = createAvailable === false
    ? t(EXPERT_CREATE_UNAVAILABLE_MESSAGE)
    : (noWorkspace ? t('先选一个工作区：生成会话只能开在已有工作区里，工作台不会替你新建目录。') : null)

  return (
    <Modal
      title={t('新建专家')}
      size="lg"
      onClose={props.onClose}
      footer={(
        <div className="wb-modal-actions">
          <button className="wb-btn" onClick={props.onClose} disabled={busy}>{t('取消')}</button>
          <button
            className="wb-btn"
            data-wb-expert-action="start-generation"
            disabled={blocked}
            onClick={props.onStart}
          >
            {busy ? t('生成中…') : t('开始生成')}
          </button>
        </div>
      )}
    >
      <div className="wb-field" data-wb-experts="create-modal">
        <div className="wb-hint">
          {t('说明你想要的专家：它负责什么、什么场景用它、有没有必须沿用的上游人格或 skill。AI 会按工作台的方法论生成一份草稿，由你确认后才会安装到你的用户库里。')}
        </div>

        <div className="wb-field">
          <label htmlFor="wb-expert-create-request">{t('需求')}</label>
          <textarea
            id="wb-expert-create-request"
            className="wb-draft-field-v"
            data-wb-expert-field="request"
            rows={5}
            maxLength={EXPERT_REQUEST_MAX_CHARS}
            value={props.request}
            disabled={busy}
            placeholder={t('例如：帮我做一个「接口联调排障」专家，先看设备日志再定位，必须能复用已有的 tcdebug skill。')}
            onChange={(event) => props.onChangeRequest(event.target.value)}
          />
          <div className="wb-field-note">
            {t('{n}/{max} 字符（服务端上限，超出会被拒）。', { n: props.request.trim().length, max: EXPERT_REQUEST_MAX_CHARS })}
          </div>
        </div>

        <div className="wb-field">
          <label htmlFor="wb-expert-create-workspace">{t('工作区')}</label>
          <select
            id="wb-expert-create-workspace"
            data-wb-expert-field="workspace"
            value={props.workspaceId}
            disabled={busy || props.workspaceChoices.length === 0}
            onChange={(event) => props.onChangeWorkspace(event.target.value)}
          >
            <option value="">{t('请选择…')}</option>
            {props.workspaceChoices.map((choice) => (
              <option key={choice.workspaceId} value={choice.workspaceId}>
                {choice.path === undefined || choice.path === '' ? choice.workspaceId : choice.path}
              </option>
            ))}
          </select>
          <div className="wb-field-note">
            {t('生成会话开在这个工作区里（与任务资料夹无关，工作台不会替你建目录）。')}
          </div>
        </div>

        {reason !== null && (
          <div
            className="wb-notes wb-notes-warn"
            data-wb-expert-error={createAvailable === false ? 'create-unavailable' : 'no-workspace'}
          >
            <div className="wb-notes-body">{reason}</div>
          </div>
        )}

        {error !== null && (
          <div className="wb-notes wb-notes-warn" data-wb-expert-error={error.code}>
            <div className="wb-notes-body">{error.message}</div>
          </div>
        )}

        {props.generationSessionId !== null && props.generationSessionId !== '' && (
          <div className="wb-notes">
            <div className="wb-notes-body">
              {t('这次生成会话已经建出来了（{id}…）。可以打开它继续让 AI 修改；草稿不会被删掉，改完仍会回来找你确认。', { id: props.generationSessionId.slice(0, 8) })}
              {props.generationDraftId === null ? '' : ` ${t('草稿 id：{id}', { id: props.generationDraftId })}`}
            </div>
            <div className="wb-detail-actions">
              <button className="wb-btn" onClick={props.onOpenSession}>{t('打开生成会话')}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
