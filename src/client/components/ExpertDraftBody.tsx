/**
 * 专家草稿预览（P8 / 方案 §9.4）。
 *
 * 为什么单独一个组件：DraftBanner 对 task / knowledge / report 那些 kind 用的是
 * `describeDraft` 那套"标题 + 正文 + 三按钮"，而专家草稿要展示的是**完全另一套东西**
 * —— 生成方式、逐条来源登记（含未知 commit 警告）、必需/可选 skill 与安装/复用决策、
 * 校验错误 —— 并且按钮的可用性由**草稿阶段**决定。
 *
 * 本组件是**纯展示**：不拉目录、不发请求、不判断阶段。阶段 → 按钮/文案的映射在纯函数
 * `expertDraftButtons()` 里（`test/expertClientFlow.test.mjs` 直接驱动它，不渲染 React）。
 *
 * 稳定选择器（方案 §12.3，逐字）：
 * - 根：`data-wb-expert-draft="<draftId>"` + `data-wb-expert-version="<contentVersion>"`
 * - `data-wb-expert-action="validate"` / `"confirm"`
 * - 错误：`data-wb-expert-error="<稳定 code>"`
 * 这些属性只用于定位，界面上不显示。
 * ⚠️「继续让 AI 修改」刻意**不带** `data-wb-expert-action` —— §12.3 的 action 枚举
 * 只有 `create|start-generation|validate|confirm` 四个值，多造一个值就是自造契约。
 *
 * ⚠️ 这里**永远不出现"创建任务"**：专家草稿不建任务（方案 §9.4 明确禁止那句假文案）。
 */
import type { DraftView } from '../../shared/contracts.js'
import type { ExpertIssue, ExpertSkillRequirement, ExpertSource } from '../../shared/expert.js'
import type { ExpertDraftButtons, ExpertDraftPayloadRead } from '../hooks/useWorkbenchExperts.js'
import { useI18n } from '../i18n.js'

const CREATION_KIND_LABELS: Record<string, string> = {
  translated: '译文（来自上游人格）',
  adapted: '改编（来自上游人格）',
  merged: '合并（多个上游来源）',
  original: '原创（无上游来源）',
}

const SKILL_ACTION_LABELS: Record<ExpertSkillRequirement['action'], string> = {
  install: '本次安装',
  reuse: '复用已安装',
}

/**
 * 取人格正文 frontmatter 里的中文名称/简介（界面上"叫什么"比 UUID 有用得多）。
 *
 * 只认最朴素的 `key: value` 行；解析不出来就返回空串（界面回落到 `expertId`），
 * **不猜、不补**。刻意不复用 `src/personas/parse.ts`：那个模块在客户端没有使用点，
 * 且它绑定了库侧的诊断口径（P8 只需要展示）。
 */
function frontmatterOf(personaMd: string): { name: string; description: string } {
  const text = String(personaMd ?? '')
  if (text.startsWith('---') === false) return { name: '', description: '' }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { name: '', description: '' }
  let name = ''
  let description = ''
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    if (match[1] === 'name' && name === '') name = value
    if (match[1] === 'description' && description === '') description = value
  }
  return { name, description }
}

/** 一条来源一行：仓库 · 上游路径 · 提交（未知要写明）· 许可。 */
function sourceLine(source: ExpertSource): string {
  const commit = source.commit === null ? '未知提交（无法核对上游）' : source.commit
  return `${source.repository} · ${source.upstreamPath} · ${commit} · ${source.license}`
}

/** 一条 skill 一行：必需/可选 + 名字 + 安装还是复用。 */
function skillLine(skill: ExpertSkillRequirement): string {
  return `${skill.required ? '必需' : '可选'} · ${skill.name} · ${SKILL_ACTION_LABELS[skill.action] ?? skill.action}`
}

function issueLine(issue: ExpertIssue): string {
  return issue.field === '' ? issue.message : `${issue.message}（${issue.field}）`
}

export interface ExpertDraftBodyProps {
  draft: DraftView
  /** `readExpertDraftPayload()` 的结果（读不出来时给稳定 code，不炸在渲染里）。 */
  payload: ExpertDraftPayloadRead
  /** `expertDraftButtons()` 的结果（阶段 → 按钮/文案的唯一判定处）。 */
  buttons: ExpertDraftButtons
  /** 正在进行的草稿动作（校验/确认）—— 用于禁用按钮，不改变 `buttons` 的语义。 */
  busy: boolean
  onValidate: () => void
  onConfirm: () => void
  /** 「继续让 AI 修改 / 打开生成会话」：复用外层 `DraftBanner.openSession`（保住那条顺序断言）。 */
  onOpenSession: () => void
}

export function ExpertDraftBody(props: ExpertDraftBodyProps): JSX.Element {
  const { t } = useI18n()
  const { draft, payload, buttons, busy } = props
  const version = payload.ok ? payload.payload.contentVersion : 0
  const errorCode = payload.ok ? buttons.errorCode : payload.code
  const errorMessage = payload.ok ? buttons.errorMessage : payload.message
  if (payload.ok === false) {
    return (
      <div
        className="wb-notes wb-notes-warn"
        data-wb-expert-draft={draft.id}
        data-wb-expert-version={String(version)}
        data-wb-expert-error={payload.code}
      >
        <div className="wb-notes-body">{payload.message}</div>
      </div>
    )
  }
  const expert = payload.payload
  const front = frontmatterOf(expert.personaMd)
  const creation = expert.provenance === null
    ? '未登记生成方式'
    : (CREATION_KIND_LABELS[expert.provenance.creationKind] ?? expert.provenance.creationKind)
  const sources = expert.provenance?.sources ?? []
  const unknownCommit = sources.filter((source) => source.commit === null).length
  const requiredSkills = expert.skills.filter((skill) => skill.required)
  const optionalSkills = expert.skills.filter((skill) => skill.required === false)
  const errors = expert.validation?.errors ?? []
  const warnings = expert.validation?.warnings ?? []
  const failed = expert.phase === 'install-failed'
  const installSkills = expert.skills.filter((skill) => skill.action === 'install')
  const reuseSkills = expert.skills.filter((skill) => skill.action === 'reuse')

  return (
    /**
     * ⚠️ 根**不能**复用 `.wb-draft-field`：那一类是"`label + value` 一对"的 flex 行。
     * 本组件把多对字段直接排在根上，复用会让 5 对字段变成 5 个并排的 flex 项
     * （2026-10-18 实测：正文被压成一字一行、横向溢出，整块不可读）。
     * 两列网格定义在 `styles.ts` 的 `.wb-expert-draft`。
     */
    <div
      className="wb-expert-draft"
      data-wb-expert-draft={draft.id}
      data-wb-expert-version={String(expert.contentVersion)}
      {...(errorCode === null ? {} : { 'data-wb-expert-error': errorCode })}
    >
      <div className="wb-draft-field-k">{t('新建专家')}</div>
      <div className="wb-draft-field-v">
        <div className="wb-row-title">{front.name === '' ? expert.expertId : front.name}</div>
        {front.description !== '' && <div className="wb-expert-note">{front.description}</div>}
        <div className="wb-expert-note">
          {t('逻辑 ID：{id} · 版本 v{version} · {draft}', { id: expert.expertId, version: expert.contentVersion, draft: draft.id })}
        </div>
      </div>

      <div className="wb-draft-field-k">{t('用户需求')}</div>
      <div className="wb-draft-field-v">{expert.request === '' ? '（空）' : expert.request}</div>

      <div className="wb-draft-field-k">{t('生成方式')}</div>
      <div className="wb-draft-field-v">
        {t(creation)}
        {expert.provenance !== null && expert.provenance.references.length > 0 && (
          <div className="wb-expert-note">{t('背景引用 {n} 条（未复制原文）', { n: expert.provenance.references.length })}</div>
        )}
      </div>

      <div className="wb-draft-field-k">{t('来源')}</div>
      <div className="wb-draft-field-v">
        {sources.length === 0
          ? <div className="wb-expert-note">{t('没有复制任何上游素材（原创）。')}</div>
          : (
            <ul className="wb-list">
              {sources.map((source) => <li key={source.id}>{sourceLine(source)}</li>)}
            </ul>
          )}
        {unknownCommit > 0 && (
          <div className="wb-notes-warn">
            {t('有 {n} 条来源拿不到具体提交，无法核对你拿到的是哪一版上游内容。', { n: unknownCommit })}
          </div>
        )}
        {sources.length > 0 && (
          <div className="wb-expert-note">
            {t('许可原文与版权声明会一起保存到人格附件里（不代替许可原文）。')}
          </div>
        )}
      </div>

      <div className="wb-draft-field-k">{t('技能')}</div>
      <div className="wb-draft-field-v">
        {expert.skills.length === 0
          ? <div className="wb-expert-note">{t('不需要任何 skill。')}</div>
          : (
            <ul className="wb-list">
              {[...requiredSkills, ...optionalSkills].map((skill) => (
                <li key={skill.name} title={skill.reason}>
                  {t('{required} · {name} · {action}', { required: t(skill.required ? '必需' : '可选（非必需）'), name: skill.name, action: t(SKILL_ACTION_LABELS[skill.action] ?? skill.action) })}
                  {skill.packageFiles.length > 0 && <span className="wb-expert-note"> · {t('{n} 个文件', { n: skill.packageFiles.length })}</span>}
                </li>
              ))}
            </ul>
          )}
        <div className="wb-expert-note">
          {t('安装 {install} 个 · 复用 {reuse} 个', { install: installSkills.length, reuse: reuseSkills.length })}
          {expert.files.length > 0 && <> · {t('暂存附件 {n} 个', { n: expert.files.length })}</>}
        </div>
      </div>

      {expert.validation !== null && (
        <div className="wb-draft-field-k">{t('校验')}</div>
      )}
      {expert.validation !== null && (
        <div className="wb-draft-field-v">
          <div className="wb-expert-note">
            {t('校验的是 v{v}（当前 v{current}）· {time}', { v: expert.validation.version, current: expert.contentVersion, time: expert.validation.checkedAt })}
            {expert.validation.version === expert.contentVersion ? '' : ` ⚠️ ${t('草稿已改动，需要重新校验')}`}
          </div>
          {errors.length === 0 && <div className="wb-expert-note">{t('没有错误。')}</div>}
          {errors.length > 0 && (
            <ul className="wb-list">
              {errors.map((issue, index) => <li key={`e${index}`}>{issueLine(issue)}</li>)}
            </ul>
          )}
          {warnings.length > 0 && (
            <div className="wb-notes-warn">
              {t('警告：{items}', { items: warnings.map((issue) => issueLine(issue)).join('；') })}
            </div>
          )}
        </div>
      )}

      {failed && expert.lastInstallError !== null && (
        <div className="wb-notes wb-notes-warn">
          <div className="wb-notes-body">{t('上次安装失败：{message}', { message: issueLine(expert.lastInstallError) })}</div>
        </div>
      )}
      {errorCode === null || errorMessage === null ? null : (
        <div className="wb-notes wb-notes-warn" data-wb-expert-error={errorCode}>
          <div className="wb-notes-body">{errorMessage}</div>
        </div>
      )}
      {buttons.notice !== null && <div className="wb-hint">{buttons.notice}</div>}

      <div className="wb-detail-actions">
        <button
          className="wb-btn"
          data-wb-expert-action="validate"
          disabled={buttons.validate.enabled === false || busy}
          onClick={props.onValidate}
        >
          {t(buttons.validate.label)}
        </button>
        <button
          className="wb-btn"
          data-wb-expert-action="confirm"
          disabled={buttons.confirm.enabled === false || busy}
          onClick={props.onConfirm}
        >
          {t(buttons.confirm.label)}
        </button>
        <button
          className="wb-btn"
          disabled={buttons.editWithAi.enabled === false || busy}
          onClick={props.onOpenSession}
        >
          {t(buttons.editWithAi.label)}
        </button>
      </div>
    </div>
  )
}
