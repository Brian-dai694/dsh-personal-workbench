/**
 * 关键词库（v1.21）：本地生成投放候选 + **可保存复用**的方案库。
 *
 * ## 边界（三条，不要放松）
 * 1. **不编造搜索量**：本页只做"核心词 × 修饰词 × 匹配方式"的组合与路由，
 *    不出现月搜索量/竞争度/点击集中度这类**必须来自 ABA 或卖家精灵**的数字。
 *    真要那些数字，走导入报表或 MCP 只读工具，并标 observed。
 * 2. **不连广告账户**：不创建活动、不上传 Bulk、不改出价；导出物是给人复核的 CSV。
 * 3. **方案是快照**：载入历史方案只回填输入，不自动重算覆盖（重算会悄悄改写用户的历史结论）。
 *
 * ## 为什么导出走服务端写文件
 * 客户端有两条结构硬门：全仓只允许一个 `<a>`（在 MarkdownText 里，href 必须来自 token），
 * 且不许 `location.*`。所以"下载文件"不能自己造锚点 —— 改成服务端按库里的行生成 CSV
 * 写到 `~/.dsh/workbench/exports/`，界面显示真实路径并可一键用系统程序打开。
 * 附带好处：导出的内容**一定等于**库里那份方案，不会出现"预览一份、导出另一份"。
 */
import { useMemo, useState } from 'react'
import { buildKeywordPlan, type KeywordMatch } from '../amazonKeywordTools.js'
import { keywordPlanCsv } from '../../shared/keywordPlanCsv.js'
import type { KeywordPlan, KeywordPlanSummary } from '../../db/repo/keywordPlans.js'
import type { UseKeywordPlansResult } from '../hooks/useKeywordPlans.js'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'
import type { UseAbaKeywordSetsResult } from '../hooks/useAbaKeywordSets.js'
import { AmazonAbaKeywordPanel } from './AmazonAbaKeywordPanel.js'
import { AmazonSearchTermWordsBlock } from './AmazonSearchTermWordsBlock.js'

const MATCHES: Array<{ code: KeywordMatch; label: string }> = [
  { code: 'exact', label: '精准' },
  { code: 'phrase', label: '词组' },
  { code: 'broad', label: '广泛' },
]

const WORD_SPLIT = /[\s,，、;；|]+/

function splitWords(value: string): string[] {
  return [...new Set(value.split(WORD_SPLIT).map((item) => item.trim().toLowerCase()).filter((item) => item !== ''))]
}

function fmtDay(iso: string): string {
  return iso.slice(0, 10)
}

export interface AmazonKeywordViewProps {
  model?: UseKeywordPlansResult
  /** 三页共享的 Amazon 数据集模型（T3）：搜索词对照与当前词都读这一份。 */
  amazon: UseAmazonDatasetsResult
  /** ABA 词表域（D17）：请求在 hook 里，视图只拿列表与意图。 */
  aba: UseAbaKeywordSetsResult
  onSendToAI?: (text: string) => void
  /** 跳到流量分析并定位到这个搜索词（T12 联动）。 */
  onOpenTraffic?: (keyword: string) => void
}

export function AmazonKeywordView({ model, amazon, aba, onSendToAI, onOpenTraffic }: AmazonKeywordViewProps): JSX.Element {
  const [seed, setSeed] = useState('welding gloves')
  const [modifiers, setModifiers] = useState('tig, mig, heat resistant')
  const [negatives, setNegatives] = useState('cheap, free')
  const [selected, setSelected] = useState<KeywordMatch[]>(['exact', 'phrase', 'broad'])
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [asin, setAsin] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [pickedId, setPickedId] = useState('')
  /**
   * 关键词页两级视图：**ABA 词表是主流程**（市场证据 → 分层 → 搜索词对照 → 回填），
   * 本地生成放第二级。之前两块竖着排在一页，ABA 被压到最底部，
   * 用户滚不到就只看到"本地生成"，自然觉得两块没打通。
   */
  const [tab, setTab] = useState<'aba' | 'local'>('aba')
  /** 每行"关联 ASIN"的输入草稿：受控但按 id 分开存，避免一次输入把整表重渲染成同一份值。 */
  const [asinDraft, setAsinDraft] = useState<Record<string, string>>({})

  const rows = useMemo(() => buildKeywordPlan(seed, modifiers, selected), [seed, modifiers, selected])
  const negativeList = useMemo(() => splitWords(negatives), [negatives])
  /** 预览用 CSV（含否词段）：让用户复制走，与导出文件同一份生成规则。 */
  const csv = useMemo(() => keywordPlanCsv(rows, negativeList), [rows, negativeList])
  /** 已导出文件的本机路径（导出成功后显示，可一键用系统程序打开）。 */
  const [exportedPath, setExportedPath] = useState('')

  const plans = model?.plans ?? []
  const current = model?.current ?? null

  function toggleMatch(code: KeywordMatch): void {
    setSelected((list) => (list.includes(code) ? list.filter((item) => item !== code) : [...list, code]))
  }

  async function savePlan(): Promise<void> {
    if (model === undefined) return
    const name = title.trim() === '' ? `${seed} 方案` : title.trim()
    const plan = await model.actions.save({
      title: name, seed, modifiers: splitWords(modifiers), matchTypes: selected,
      negatives: negativeList, rows, asin: asin.trim() === '' ? null : asin.trim(),
    })
    if (plan !== null) {
      setPickedId(plan.id)
      setSavedNote(`已保存到词库：${plan.title}（${plan.rows.length} 行）`)
    }
  }

  async function loadPlan(id: string): Promise<void> {
    if (model === undefined) return
    const plan: KeywordPlan | null = await model.actions.open(id)
    if (plan === null) return
    setPickedId(plan.id)
    setTitle(plan.title)
    setSeed(plan.seed)
    setModifiers(plan.modifiers.join(', '))
    setNegatives(plan.negatives.join(', '))
    setSelected(plan.matchTypes)
    setAsin(plan.asin ?? '')
    setNote(plan.note)
    setSavedNote(`已载入「${plan.title}」。改完输入后生成的是新候选，不会覆盖这份方案。`)
  }

  async function removePlan(id: string, name: string): Promise<void> {
    if (model === undefined) return
    if (!window.confirm(`删除关键词方案「${name}」？删除后不可恢复。`)) return
    const ok = await model.actions.remove(id)
    if (ok) {
      if (pickedId === id) { setPickedId(''); setSavedNote('') }
    }
  }

  async function linkAsin(id: string, value: string): Promise<void> {
    if (model === undefined) return
    await model.actions.patch(id, { asin: value.trim() === '' ? null : value.trim() })
    setSavedNote(value.trim() === '' ? '已解除 ASIN 关联' : `已关联到 ${value.trim().toUpperCase()}`)
  }

  /**
   * 把搜索词页的一个词**加进关键词库**（用户要求：操作列就叫这个）。
   *
   * 每次生成一条独立的精准候选方案：seed = 该词、无修饰词、只留 exact。
   * 不合并进已有方案 —— 合并要改他人方案的行，语义比"新建一条"重得多。
   */
  async function addWordToLibrary(keyword: string): Promise<void> {
    if (model === undefined) { setSavedNote('关键词库模型未就绪，请重启桌面端后再试'); return }
    const seed = keyword.trim()
    if (seed === '') return
    const rows = buildKeywordPlan(seed, '', ['exact'])
    const plan = await model.actions.save({
      title: `${seed}（搜索词）`, seed, modifiers: [], matchTypes: ['exact'], negatives: [], rows, asin: null,
    })
    if (plan !== null) setSavedNote(`已加入关键词库：${plan.title}（1 条精准候选）`)
  }

  /**
   * 导出当前**已保存**方案的 CSV。
   *
   * 只导已保存的那份：未保存的输入还在改，导出的东西会和"库里的方案"对不上，
   * 下次回看无法复现。按钮在 `current === null` 时禁用，并直接提示去保存。
   */
  async function exportPlan(): Promise<void> {
    if (model === undefined || current === null) return
    const result = await model.actions.exportCsv(current.id)
    if (result === null) return
    setExportedPath(result.path)
    setSavedNote(`已导出「${current.title}」共 ${result.rows} 行到本机`)
  }

  return (
    <section className="wb-amazon-tools" aria-label="关键词规划">
      <header className="wb-amazon-heading">
        <div>
          <h2>关键词库</h2>
          <p>本地生成精准 / 词组 / 广泛三层候选并可保存复用 · 不连接广告账户</p>
        </div>
        <div className="wb-amazon-heading-actions" hidden={tab !== 'local'}>
          <button className="wb-btn" type="button" onClick={() => { void navigator.clipboard.writeText(csv).then(() => setSavedNote(`已复制 ${rows.length} 行 CSV 到剪贴板`)) }}>复制 CSV</button>
          <button className="wb-btn" type="button" disabled={model === undefined || model.busy || current === null} onClick={() => void exportPlan()}>导出到本机</button>
          <button className="wb-btn primary" type="button" disabled={model === undefined || model.busy || rows.length === 0} onClick={() => void savePlan()}>保存到词库</button>
        </div>
      </header>

      <div className="wb-segmented wb-asin-tabs" role="tablist" aria-label="关键词视图">
        <button type="button" role="tab" aria-selected={tab === 'aba'} className={`wb-seg ${tab === 'aba' ? 'on' : ''}`} onClick={() => setTab('aba')}>ABA 词表 · 搜索词对照</button>
        <button type="button" role="tab" aria-selected={tab === 'local'} className={`wb-seg ${tab === 'local' ? 'on' : ''}`} onClick={() => setTab('local')}>本地生成候选</button>
      </div>

      {model !== undefined && model.error !== null && <div className="wb-amazon-warning" role="alert">词库操作失败：{model.error}</div>}
      {savedNote !== '' && <div className="wb-amazon-note" role="status">{savedNote}</div>}
      {exportedPath !== '' && (
        <div className="wb-amazon-note" role="status">
          <div>已导出到：<code className="wb-amazon-path">{exportedPath}</code></div>
          <button className="wb-btn" type="button" style={{ marginTop: 6 }} onClick={() => void model?.actions.openExportedFile(exportedPath)}>用系统程序打开</button>
        </div>
      )}

      {tab === 'local' && (<><div className="wb-amazon-keyword-form">
        <label>核心词<input value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="welding gloves" /></label>
        <label>修饰词（逗号分隔）<input value={modifiers} onChange={(event) => setModifiers(event.target.value)} placeholder="tig, mig, heat resistant" /></label>
        <label>否词（逗号分隔）<input value={negatives} onChange={(event) => setNegatives(event.target.value)} placeholder="cheap, free" /></label>
        <label>方案名<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="留空则用核心词命名" /></label>
        <div className="wb-amazon-checks">
          {MATCHES.map(({ code, label }) => (
            <label key={code}>
              <input type="checkbox" checked={selected.includes(code)} onChange={() => toggleMatch(code)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      {rows.length === 0
        ? <div className="wb-amazon-empty"><strong>还没有候选</strong><span>填一个核心词（如 welding gloves）就会生成三层匹配候选。</span></div>
        : (
          <div className="wb-amazon-table-wrap">
            <table className="wb-amazon-table">
              <thead><tr><th>关键词</th><th>匹配</th><th>建议活动</th><th>理由</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.keyword}-${row.match}`}>
                    <td>{row.keyword}</td>
                    <td>{row.match}</td>
                    <td>{row.campaign}</td>
                    <td>{row.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {negativeList.length > 0 && (
        <div className="wb-amazon-negatives">
          <h3 className="wb-amazon-section-title">否词清单（{negativeList.length}）</h3>
          <div className="wb-amazon-chips">{negativeList.map((word) => <span key={word} className="wb-chip is-neutral">{word}</span>)}</div>
          <p className="wb-amazon-footnote">否词只作为人工复核线索：本页不读取搜索词报表，不判断某个词是否真的该否。</p>
        </div>
      )}

      <div className="wb-amazon-dataset-list">
        <h3 className="wb-amazon-section-title">我的词库（{plans.length}）</h3>
        {plans.length === 0
          ? <div className="wb-amazon-empty"><strong>词库还是空的</strong><span>生成候选后点「保存到词库」，下次可以直接载入改参数。</span></div>
          : plans.map((plan: KeywordPlanSummary) => (
            <div key={plan.id} className={`wb-amazon-keyword-plan${pickedId === plan.id ? ' on' : ''}`}>
              <button type="button" className="wb-amazon-keyword-plan-open" disabled={model?.busy === true} onClick={() => void loadPlan(plan.id)}>
                <span>{plan.title}</span>
                <small>{plan.seed || '无核心词'} · {plan.rowCount} 条候选 · 否词 {plan.negativeCount} · {fmtDay(plan.updatedAt)}{plan.asin === null ? '' : ` · ${plan.asin}`}</small>
              </button>
              <div className="wb-amazon-keyword-plan-actions">
                <input
                  className="wb-amazon-keyword-asin"
                  value={asinDraft[plan.id] ?? plan.asin ?? ''}
                  placeholder="关联 ASIN"
                  aria-label={`为「${plan.title}」关联 ASIN`}
                  onChange={(event) => setAsinDraft((prev) => ({ ...prev, [plan.id]: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Enter') void linkAsin(plan.id, asinDraft[plan.id] ?? plan.asin ?? '') }}
                />
                <button type="button" className="wb-btn" disabled={model?.busy === true} onClick={() => void linkAsin(plan.id, asinDraft[plan.id] ?? plan.asin ?? '')}>关联</button>
                <button type="button" className="wb-oplog-card-open" disabled={model?.busy === true} onClick={() => void removePlan(plan.id, plan.title)}>删除</button>
              </div>
            </div>
          ))}
      </div>

      {current !== null && current.note !== '' && <div className="wb-amazon-note">方案备注：{current.note}</div>}
      <p className="wb-amazon-footnote">
        搜索量 / 竞争度 / 点击集中度：<b>unknown</b>（本页不产出市场数据）。需要这些证据时，导入 ABA 搜索词报表或调用卖家精灵只读工具，并标注 observed。
      </p>
      <label className="wb-amazon-field">
        <span>备注<small>随方案一起保存</small></span>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="这批词是给哪个产品/阶段用的" />
      </label>
      {current !== null && (
        <div className="wb-amazon-result-actions">
          <button className="wb-btn" type="button" disabled={model?.busy === true} onClick={() => void model?.actions.patch(current.id, { note })}>保存备注到当前方案</button>
        </div>
      )}
      </>)}
      {tab === 'aba' && (
        <>
          <AmazonSearchTermWordsBlock
            model={amazon}
            onOpenTraffic={onOpenTraffic}
            onClearKeyword={() => amazon.actions.setCurrentKeyword(null)}
            onAddToLibrary={(keyword) => void addWordToLibrary(keyword)}
          />
          <AmazonAbaKeywordPanel onSendToAI={onSendToAI} model={amazon} aba={aba} />
        </>
      )}
    </section>
  )
}
