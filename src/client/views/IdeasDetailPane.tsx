/**
 * D17 / P2：点子页右侧详情区 —— 点子编辑表单 / 点子王（文件夹）详情 / 点子详情 / 空态。
 *
 * 三种形态的判定与数据全部来自 `hooks/useIdeas.ts`；本文件不持有状态、不发请求。
 * `startAISession` 与 `busy` 属 AI 会话域，按设计 §5 由入口转发进来（这里只调用）。
 * 删除点子那句 `window.confirm('删除这个点子？')` 的文案与位置逐字保留（行为修复不混进重构）。
 */
import { Badge } from '../components/TaskList.js'
import { interactiveProps } from '../a11y.js'
import { MarkdownText } from '../components/MarkdownText.js'
import { Icon } from '../components/Icon.js'
import type { KnowledgeDictFn, StartAISessionFn } from '../hooks/useKnowledge.js'
import type { UseIdeasResult } from '../hooks/useIdeas.js'

export type IdeasDetailPaneProps = {
  model: UseIdeasResult
  dictOf: KnowledgeDictFn
  busy: boolean
  startAISession: StartAISessionFn
}

export function IdeasDetailPane({ model, dictOf, busy, startAISession }: IdeasDetailPaneProps): JSX.Element {
  const { selectedIdea, selectedCluster, draft: ideaDraft, folderForm } = model

  /**
   * 文件夹的「新建 / 重命名」表单。
   *
   * 这一段原先**根本不存在**：`useIdeas#setFolderForm` 会被三个按钮写入（顶栏「新建文件夹」、
   * 文件夹网格的「+ 新建空文件夹」、文件夹详情的「重命名」），但没有任何组件读 `folderForm`，
   * 于是那三个按钮全是"点了没反应"。表单放在这里（而不是弹窗）是为了与点子表单同一处理方式：
   * 右栏展开由 `WorkbenchBody#detailOpen` 负责（它已把 `folderForm` 计入判据）。
   */
  if (folderForm !== null) {
    const isCreate = folderForm.mode === 'create'
    return (
  <form className="wb-form" onSubmit={(e) => { e.preventDefault(); model.actions.saveFolder() }}>
    <h4 className="full" style={{ margin: 0 }}>{isCreate ? '新建文件夹' : '重命名文件夹'}</h4>
    <label className="full">名称<input value={folderForm.title} onChange={(e) => model.patchFolderForm({ title: e.target.value })} placeholder="一句话概括这个文件夹的主题" /></label>
    <label className="full">总结（可选，Markdown）<textarea rows={6} value={folderForm.summaryMd} onChange={(e) => model.patchFolderForm({ summaryMd: e.target.value })} /></label>
    <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={() => model.setFolderForm(null)}>取消</button></div>
  </form>
    )
  }

  if (ideaDraft !== null) {
    return (
  <form className="wb-form" onSubmit={(e) => {
    e.preventDefault()
    const title = ideaDraft.title.trim()
    if (title === '') return
    const tags = ideaDraft.tags.split(/[,#，\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 20)
    // 标题非空与标签切分留在视图里判定（与拆分前的写法逐字一致）；请求本体在 hook 里。
    model.actions.saveDraft({ title, contentMd: ideaDraft.contentMd, kindCode: ideaDraft.kindCode, tags })
  }}>
    <h4 className="full" style={{ margin: 0 }}>{model.editId === null ? '记个点子' : '编辑点子'}</h4>
    <label className="full">标题<input value={ideaDraft.title} onChange={(e) => model.actions.patchDraft({ title: e.target.value })} placeholder="一句话说清这个点子" /></label>
    <label>类型<select value={ideaDraft.kindCode} onChange={(e) => model.actions.patchDraft({ kindCode: e.target.value })}>{dictOf('idea_kind').map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}</select></label>
    <label>标签<input value={ideaDraft.tags} onChange={(e) => model.actions.patchDraft({ tags: e.target.value })} placeholder="逗号/空格分隔，如 AI, 语音" /></label>
    <label className="full">内容（可选，Markdown）<textarea rows={10} value={ideaDraft.contentMd} onChange={(e) => model.actions.patchDraft({ contentMd: e.target.value })} /></label>
    <div className="full" style={{ display: 'flex', gap: 8 }}><button className="wb-btn primary" type="submit"><Icon name="check" />保存</button><button className="wb-btn" type="button" onClick={() => model.actions.closeDraft()}>取消</button></div>
  </form>
    )
  }

  if (selectedCluster !== null) {
    return (
  <div className="wb-card">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <h4 style={{ flex: 1, margin: 0, minWidth: 120 }}><Icon name="folder" />{selectedCluster.title}</h4>
      <button className="wb-btn" onClick={() => model.setFolderForm({ mode: 'rename', id: selectedCluster.id, title: selectedCluster.title, summaryMd: selectedCluster.summaryMd })}><Icon name="edit" />重命名</button>
      {model.clusters.length > 1 && (
        <select
          className="wb-plan-add"
          value=""
          title="合并到…（把本文件夹的成员挂到目标文件夹，然后删除本文件夹）"
          onChange={(e) => { const target = e.target.value; if (target !== '') model.actions.mergeFolderInto(selectedCluster.id, target) }}
        >
          <option value="">合并到…</option>
          {model.clusters.filter((cluster) => cluster.id !== selectedCluster.id).map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.title}</option>)}
        </select>
      )}
      <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `cluster:${selectedCluster.id}`)}>AI 头脑风暴</button>
      <button className="wb-btn" onClick={() => model.actions.deleteFolder(selectedCluster.id)}><Icon name="trash" />删除</button>
    </div>
    <MarkdownText text={selectedCluster.summaryMd || '（暂无总结，可在重命名里补充）'} />
    <div style={{ marginTop: 10 }}>
      <b>包含点子（{selectedCluster.ideas.length}）</b>
      {selectedCluster.ideas.map((idea) => (
        <div key={idea.id} className="wb-member">
          <span className="t" onClick={() => model.actions.openIdea(idea)} {...interactiveProps(() => model.actions.openIdea(idea))} style={{ cursor: 'pointer' }}>{idea.title}</span>
          <Badge dict={dictOf('idea_kind')} code={idea.kindCode} />
          <button className="wb-icon-btn" title="移出文件夹" onClick={() => model.actions.unfileIdeaFrom(idea.id, selectedCluster.id)}><Icon name="back" size={12} /></button>
        </div>
      ))}
      {selectedCluster.ideas.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '8px 2px' }}>空文件夹。可以从下方「未归类」的点子上点「归入文件夹」。</div>
      )}
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
      <button className="wb-btn" disabled={busy} onClick={() => void startAISession('idea_association', null, selectedCluster.ideas.map((idea) => idea.id).sort().join(','))}>AI 继续补充关联</button>
      <button className="wb-btn" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `cluster:${selectedCluster.id}`)}>整体转成任务树</button>
    </div>
  </div>
    )
  }

  if (selectedIdea !== null) {
    return (
  <div className="wb-card">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <h4 style={{ flex: 1, margin: 0 }}>{selectedIdea.title}</h4>
      <button className="wb-btn primary" disabled={busy} onClick={() => void startAISession('idea_brainstorm', null, `idea:${selectedIdea.id}`)}>AI 头脑风暴</button>
      <button className="wb-btn" onClick={() => model.actions.startEdit(selectedIdea)}><Icon name="edit" />编辑</button>
      <button className="wb-btn" onClick={() => { if (window.confirm('删除这个点子？')) model.actions.deleteIdea(selectedIdea.id) }}><Icon name="trash" />删除</button>
    </div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
      <Badge dict={dictOf('idea_kind')} code={selectedIdea.kindCode} />
      {selectedIdea.tags.map((tag) => <span key={tag} style={{ fontSize: 12, color: 'var(--wb-ink-2)' }}>#{tag}</span>)}
    </div>
    <MarkdownText text={selectedIdea.contentMd || '（暂无内容）'} />
  </div>
    )
  }

  return <div className="wb-empty">← 从左侧选择一个点子/点子王，或点“记个点子”</div>
}
