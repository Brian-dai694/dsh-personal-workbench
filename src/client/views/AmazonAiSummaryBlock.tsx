/**
 * 流量分析右侧：**AI 报表结论**块（T4）。
 *
 * 为什么单独一块、不并进词级分析：两者的证据等级不同。
 * 词级分析是本地面板按 `KEYWORD_RULES` 算出来的（derived，可复算）；
 * 这块是 agent 写回 `aiSummary` 的结论（可能引用市场证据，也可能是它读表后的归纳）。
 * 混排会让人分不清"哪个数是机器算的、哪个是模型说的"。
 *
 * 边界：本组件**不解析结构、不发请求** —— `aiSummary` 是任意 JSON，读取全部走
 * `readAiSummary()`（缺字段安静降级）；"交给 agent"只是把点击转成回调。
 */
import { readAiSummary } from '../aiSummaryView.js'

const money = (value: number | null): string => value === null ? '—' : `$${value.toFixed(2)}`
const pct = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`
const num = (value: number | null): string => value === null ? '—' : value.toLocaleString('en-US')

export interface AmazonAiSummaryBlockProps {
  /** 数据集的 `aiSummary`（`null` = 尚未分析）。 */
  summary: Record<string, unknown> | null
  /** 「交给 agent 分析 / 重新分析」；未注入时按钮禁用（例如没有会话入口）。 */
  onAnalyse?: () => void
  /** 触发中（会话正在打开）时禁用按钮。 */
  busy?: boolean
}

export function AmazonAiSummaryBlock({ summary, onAnalyse, busy = false }: AmazonAiSummaryBlockProps): JSX.Element {
  const view = readAiSummary(summary)
  const action = onAnalyse === undefined ? null : (
    <button className="wb-btn" type="button" disabled={busy} onClick={onAnalyse}>
      {view === null ? '交给 agent 分析' : '重新分析'}
    </button>
  )

  if (view === null) {
    return (
      <section className="wb-ai-summary is-pending" aria-label="AI 报表结论">
        <header className="wb-ai-summary-head">
          <h5>AI 结论</h5>
          <span className="wb-ai-summary-state">待分析</span>
        </header>
        <p className="wb-ai-summary-pending">
          这份报表还没有 agent 结论。交给 agent 后会按词聚合复核，并把报表级结论写回这里（dataset_id 随提示词带出）。
        </p>
        {action !== null && <div className="wb-ai-summary-actions">{action}</div>}
      </section>
    )
  }

  return (
    <section className="wb-ai-summary" aria-label="AI 报表结论">
      <header className="wb-ai-summary-head">
        <h5>AI 结论</h5>
        <span className="wb-ai-summary-evidence" title="observed=表里直接可证；derived=按规则算出；unknown=没有证据">
          证据 {view.evidence ?? 'unknown'}
        </span>
      </header>

      <p className="wb-ai-summary-line">
        行 {num(view.rows)} · 词 {num(view.uniqueKeywords)}
        {' · '}花费 {money(view.totals.spend)} · 销售额 {money(view.totals.sales)} · ACOS {pct(view.totals.acos)}
      </p>
      <p className="wb-ai-summary-line">
        否定 {num(view.distribution.negative)} · 加词 {num(view.distribution.add)} · 观察 {num(view.distribution.watch)} · 不动 {num(view.distribution.none)}
        {' · '}否词花费 {money(view.negativeSpend)}
      </p>

      {(view.topRisks.length > 0 || view.topOpportunities.length > 0) && (
        <div className="wb-ai-summary-tops">
          {view.topRisks.length > 0 && (
            <p><b>风险</b>{view.topRisks.map((item) => `${item.keyword}（${money(item.spend)}）`).join('、')}</p>
          )}
          {view.topOpportunities.length > 0 && (
            <p><b>机会</b>{view.topOpportunities.map((item) => `${item.keyword}（${money(item.sales)}）`).join('、')}</p>
          )}
        </div>
      )}

      {view.notes.length > 0 && (
        <ul className="wb-ai-summary-notes">
          {view.notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}

      <div className="wb-ai-summary-actions">
        <span>结论写回后点右上「刷新」可见最新值。</span>
        {action}
      </div>
    </section>
  )
}
