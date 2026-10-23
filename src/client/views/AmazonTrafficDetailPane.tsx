/**
 * 搜索词页右侧「分析结果」区（v1.19，用户要求：结果放到另外一边）。
 *
 * 职责边界：本文件**不解析、不落库、不发请求** —— 它只读 `useAmazonDatasets` 的
 * `current`（左栏导入后就是它），把行数据换算成指标表并显示 AI 写回的建议。
 * 于是"左栏导入 / 右栏看结果"共用同一份 current，不会出现两边行数不一致。
 */
import { useMemo } from 'react'
import { analyseTraffic, summarizeTrafficForAI, type SearchTermAction } from '../amazonTrafficTools.js'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'

const ACTION_LABEL: Record<SearchTermAction, string> = {
  add_exact: '加精准',
  add_phrase: '加词组',
  negative_exact: '否精准',
  negative_phrase: '否词组',
  watch: '观察',
  none: '不动',
}

export interface AmazonTrafficDetailPaneProps {
  model: UseAmazonDatasetsResult
  onSendToAI?: (text: string) => void
}

export function AmazonTrafficDetailPane({ model, onSendToAI }: AmazonTrafficDetailPaneProps): JSX.Element {
  const dataset = model.current
  const metrics = useMemo(() => analyseTraffic(dataset?.rows ?? []), [dataset])
  const annotations = useMemo(() => new Map((dataset?.annotations ?? []).map((item) => [item.keyword, item])), [dataset])
  const totals = useMemo(() => metrics.reduce((acc, row) => ({
    impressions: acc.impressions + row.impressions,
    clicks: acc.clicks + row.clicks,
    orders: acc.orders + row.orders,
    spend: acc.spend + row.spend,
    sales: acc.sales + row.sales,
  }), { impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 }), [metrics])

  if (dataset === null || metrics.length === 0) {
    return (
      <div className="wb-amazon-result-pane">
        <div className="wb-amazon-empty">
          <strong>左侧导入搜索词报表后，这里显示分析结果</strong>
          <span>支持 CSV / TSV（可直接从 Excel 粘贴）。解析成功会自动落库，随后 AI 才能读到全部原始行并把分层建议写回这张表。</span>
        </div>
      </div>
    )
  }

  function sendToAI(): void {
    if (dataset === null) return
    onSendToAI?.(summarizeTrafficForAI({
      datasetId: dataset.id,
      title: dataset.title,
      period: dataset.period,
      rows: dataset.rows,
    }))
  }

  return (
    <section className="wb-amazon-result-pane" aria-label="搜索词分析结果">
      <header className="wb-amazon-result-head-bar">
        <div>
          <h4>{dataset.title}</h4>
          <p>{dataset.period ?? '周期未提供（unknown）'} · {metrics.length} 行 · 建议 {dataset.annotations.length} 条</p>
        </div>
        <div className="wb-amazon-result-head-actions">
          <button className="wb-btn" type="button" disabled={model.busy} onClick={() => void model.actions.select(dataset.id)}>刷新 AI 建议</button>
          <button className="wb-btn primary" type="button" disabled={!onSendToAI} onClick={sendToAI}>带入 AI 协助</button>
        </div>
      </header>

      <div className="wb-amazon-summary">
        <Summary label="曝光" value={totals.impressions.toLocaleString('en-US')} />
        <Summary label="点击" value={totals.clicks.toLocaleString('en-US')} />
        <Summary label="订单" value={String(totals.orders)} />
        <Summary label="花费" value={`$${totals.spend.toFixed(2)}`} />
        <Summary label="销售额" value={`$${totals.sales.toFixed(2)}`} />
        <Summary label="整体 ACOS" value={totals.sales > 0 ? `${((totals.spend / totals.sales) * 100).toFixed(1)}%` : '—'} />
      </div>

      <div className="wb-amazon-table-wrap">
        <table className="wb-amazon-table wb-amazon-table-grid">
          <thead>
            <tr>
              <th className="text">搜索词</th><th>ACOS</th><th>点击</th><th>订单</th><th>花费</th><th className="text">AI 建议</th>
              <th>曝光</th><th>销售额</th><th>CTR</th><th>CVR</th><th>CPC</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((row) => {
              const note = annotations.get(row.keyword)
              return (
                <tr key={row.keyword}>
                  <td className="text" title={row.keyword}>{row.keyword}</td>
                  <td>{formatPercent(row.acos)}</td>
                  <td>{row.clicks.toLocaleString('en-US')}</td>
                  <td>{row.orders}</td>
                  <td>{`$${row.spend.toFixed(2)}`}</td>
                  <td className="text">
                    {note === undefined
                      ? <span className="wb-amazon-action none">待分析</span>
                      : <span className={`wb-amazon-action ${note.action.replace(/_/g, '-')}`} title={note.reason || '（AI 未写理由）'}>{ACTION_LABEL[note.action]}</span>}
                  </td>
                  <td>{row.impressions.toLocaleString('en-US')}</td>
                  <td>{`$${row.sales.toFixed(2)}`}</td>
                  <td>{formatPercent(row.ctr)}</td>
                  <td>{formatPercent(row.cvr)}</td>
                  <td>{formatMoney(row.cpc)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="wb-amazon-footnote">列序按「先决策、后明细」：搜索词 → ACOS → 点击/订单/花费 → AI 建议，其余（曝光、销售额、CTR、CVR、CPC）右滚可见。</p>
      <p className="wb-amazon-footnote">诊断规则：点击 ≥ 8 且订单 0 → 优先查相关性/Listing/价格；有单且 ACOS ≤ 30% → 可人工评估扩量；有曝光无点击 → 查主图与竞价。</p>
      <p className="wb-amazon-footnote">否词口径（按投放单元归因）：同一个词在不同广告组可能一边亏一边出单，所以「否定只加在最差的那个广告组」，不加活动级/账户级；报表不含广告组与匹配类型时，词级 0 单不足以定否词。</p>
    </section>
  )
}

function Summary({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="wb-amazon-summary-item"><span>{label}</span><strong>{value}</strong></div>
}

const formatPercent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`
const formatMoney = (value: number | null) => value === null ? '—' : `$${value.toFixed(2)}`
