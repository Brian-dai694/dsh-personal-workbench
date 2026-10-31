/**
 * 知识库**右侧详情区**（D17 / P1）—— 从入口 `wb-detail` 里的 `view === 'knowledge'` 分支搬出
 * （拆分前在 `index.tsx` 第 3677–3730 行，是那条巨型嵌套三元里的第二段）。
 *
 * 三种形态（与拆分前完全一致，顺序也一样）：
 * 1. `draft !== null` → 新建/编辑表单；
 * 2. 否则 `selected !== null` → 详情卡（含"打开文件"与"跳到关联任务"）；
 * 3. 否则空态。
 *
 * ⚠️ 判定不在这里：
 * - 「哪些字典可选」由入口给；
 * - 「跳到关联任务」走入口注入的 `openTaskById`（它会 `setView('list')`，这是既有行为，原样保留）。
 * - 编辑表单直接读写域模型里的 `draft`（拆分前就是受控的 `setKnowledgeDraft(prev => …)`），
 *   不额外留一份本地副本 —— 两份可写状态就是下一个"改了一处另一处不动"。
 *
 * ⚠️ 2026-10-27 批次 8：本文件**不再直接发 HTTP**。保存与删除原先写在这里的
 * `void api(...)` 里（连"保存后关草稿 + 重拉列表"这组状态变更也散在 JSX 中），
 * 已搬进 `useKnowledge` 的 `saveDraft()` / `removeEntry()`。视图只喊意图、只给文案。
 */
import { Badge } from '../components/TaskList.js'
import { Icon } from '../components/Icon.js'
import { MarkdownText } from '../components/MarkdownText.js'
import type { Dict, Task } from '../viewTypes.js'
import type { KnowledgeDictFn, UseKnowledgeResult } from '../hooks/useKnowledge.js'
import { useI18n } from '../i18n.js'

export interface KnowledgeDetailPaneProps {
  /** 知识域模型（草稿、编辑态与 `startEdit` / `closeDraft` / `openKnowledgeFile` 都在里面）。 */
  model: UseKnowledgeResult
  /** 全部任务（"关联任务"显示标题用；判定不在这里）。 */
  tasks: Task[]
  dictOf: KnowledgeDictFn
  setError: (message: string) => void
  setNotice: (message: string) => void
  /** 点"关联任务"→ 打开该任务（既有语义：会切到任务视图）。 */
  openTaskById: (taskId: string) => void
}

export function KnowledgeDetailPane(props: KnowledgeDetailPaneProps): JSX.Element {
  const { t } = useI18n()
  const { model, tasks, dictOf, setError, setNotice, openTaskById } = props
  const { draft, selected } = model

  if (draft !== null) {
    return (
      <form className="wb-form" onSubmit={(e) => {
        e.preventDefault()
        if (draft.title.trim() === '') return
        const isEdit = model.editId !== null
        void model.saveDraft().then((ok) => {
          if (ok) setNotice(isEdit ? t('知识条目已更新') : t('知识条目已创建'))
        })
      }}>
        <h4 className="full" style={{ margin: 0 }}>{model.editId === null ? t('新建知识条目') : t('编辑知识条目')}</h4>
        <label className="full">{t('标题')}<input value={draft.title} onChange={(e) => model.patchDraft({ title: e.target.value })} placeholder={t('可检索的标题')} /></label>
        <label>{t('分类')}<select value={draft.kindCode} onChange={(e) => model.patchDraft({ kindCode: e.target.value })}>{dictOf('knowledge_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
        <label>{t('标签')}<input value={draft.tags} onChange={(e) => model.patchDraft({ tags: e.target.value })} placeholder={t('用逗号/空格分隔，如 TTS, 踩坑')} /></label>
        <label className="full">{t('本地文件链接（可选）')}<input value={draft.fileLink} onChange={(e) => model.patchDraft({ fileLink: e.target.value })} placeholder={t('file:// 或绝对路径，如 D:\\docs\\方案.md、/mnt/d/docs/方案.md')} /></label>
        <label className="full">{t('关联任务 id（可选）')}<input value={draft.sourceTaskId} onChange={(e) => model.patchDraft({ sourceTaskId: e.target.value })} placeholder={t('留空表示不关联')} /></label>
        <label className="full">{t('正文（Markdown）')}<textarea rows={12} value={draft.contentMd} onChange={(e) => model.patchDraft({ contentMd: e.target.value })} /></label>
        <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />{t('保存')}</button><button className="wb-btn" type="button" onClick={model.closeDraft}>{t('取消')}</button></div>
      </form>
    )
  }

  if (selected !== null) {
    const fileLink = selected.fileLink
    return (
      <div className="wb-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h4 style={{ flex: 1, margin: 0 }}>{selected.title}</h4>
          <button className="wb-btn" onClick={() => model.startEdit(selected)}><Icon name="edit" />{t('编辑')}</button>
          <button className="wb-btn" onClick={() => { if (window.confirm(t('删除这条知识？'))) { void model.removeEntry(selected.id).then((ok) => { if (ok) setNotice(t('已删除')) }) } }}><Icon name="trash" />{t('删除')}</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
          <Badge dict={dictOf('knowledge_kind')} code={selected.kindCode} />
          {selected.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: 'var(--wb-ink-2)' }}>#{tag}</span>)}
        </div>
        {fileLink !== null && fileLink !== '' && (
          <div style={{ margin: '8px 0', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{t('📎 本地文件：')}</span>
            <span className="wb-file-chip"><Icon name="file" size={12} /><code>{fileLink}</code></span>
            <button className="wb-btn" onClick={() => { void model.openKnowledgeFile(fileLink) }}><Icon name="file" />{t('打开文件')}</button>
          </div>
        )}
        {selected.sourceTaskId !== null && (
          <div style={{ margin: '8px 0', fontSize: 13 }}>
            {t('🔗 关联任务：')}
            <button className="wb-btn" onClick={() => openTaskById(selected.sourceTaskId as string)}>
              {tasks.find((t) => t.id === selected.sourceTaskId)?.title ?? selected.sourceTaskId}
            </button>
          </div>
        )}
        <MarkdownText text={selected.contentMd} />
      </div>
    )
  }

  return <div className="wb-empty">{t('← 从左侧选择或新建知识条目')}</div>
}
