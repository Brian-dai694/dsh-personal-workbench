/**
 * 关键词页 · 搜索词表现块（T10）：把流量分析那份报表的词级结论搬到本页。
 *
 * ## 为什么放在关键词页
 * 用户的主线是「流量分析导入 → 看词 → 决定加/否」。关键词页原来的职责只有
 * 本地候选生成与 ABA 对照，于是导入完成后这里几乎是空的 —— 看起来像"没联动"。
 * 这一块让关键词页直接读到同一份数据集、同一份判定（`shared/keywordDecision.ts`），
 * 并且能一键跳到流量分析看这个词的明细。
 *
 * ## 边界
 * - 不发请求：数据来自共享的 `amazon` 模型（T3），判定来自 `keywordAnalysis`；
 * - 不写建议：这里只读，写回仍走 agent / 本地建议按钮；
 * - 与流量页共用同一个 `KeywordAnalysis`，数字不可能两边不一致。
 */
import { useMemo } from 'react'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'
import { buildKeywordAnalysis, DECISION_LABEL } from '../keywordAnalysis.js'
import { AmazonKeywordAnalysisBlock } from './AmazonKeywordAnalysisBlock.js'

const money = (value: number): string => `$${value.toFixed(2)}`
const pct = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`
const count = (value: number): string => value.toLocaleString('en-US')

export interface AmazonSearchTermWordsBlockProps {
  model: UseAmazonDatasetsResult
  /** 跳到流量分析并定位到这个搜索词。 */
  onOpenTraffic?: (keyword: string) => void
  /** 清除"当前词"定位。 */
  onClearKeyword?: () => void
  /** 把这个搜索词加入关键词库（生成一条精准候选方案）。 */
  onAddToLibrary?: (keyword: string) => void
}

export function AmazonSearchTermWordsBlock({ model, onOpenTraffic, onClearKeyword, onAddToLibrary }: AmazonSearchTermWordsBlockProps): JSX.Element {
  const dataset = model.current
  const analysis = useMemo(() => buildKeywordAnalysis(dataset?.rows ?? []), [dataset])
  const current = model.currentKeyword ?? null
  const words = useMemo(() => {
    if (current === null || current.trim() === '') return analysis.words
    const needle = current.trim().toLowerCase()
    return analysis.words.filter((word) => word.keyword.trim().toLowerCase() === needle)
  }, [analysis, current])

  if (dataset === null) {
    return (
      <section className="wb-amazon-empty" aria-label="搜索词表现">
        <strong>还没有搜索词报表</strong>
        <span>去「报表分析 · 搜索词」导入一份，导入完成后这里会直接显示词级结论。</span>
        {onOpenTraffic !== undefined && (
          <button className="wb-btn" type="button" style={{ marginTop: 8 }} onClick={() => onOpenTraffic('')}>去报表分析导入</button>
        )}
      </section>
    )
  }

  return (
    <div className="wb-searchterm-block" aria-label="搜索词表现">
      <div className="wb-amazon-note" role="status">
        <div>
          当前报表：<b>{dataset.title}</b> · {dataset.period ?? '周期 unknown'} · {count(dataset.rows.length)} 行
          {current !== null && current.trim() !== '' && (
            <span className="wb-current-keyword"> · 定位：<b>{current}</b>
              {onClearKeyword !== undefined && <button className="wb-oplog-card-open" type="button" onClick={onClearKeyword}>清除</button>}
            </span>
          )}
        </div>
        <div>结论与「报表分析 · 搜索词」同一份计算，阈值在「设置 → 搜索词阈值」里改，改完这里同时生效。</div>
      </div>

      <AmazonKeywordAnalysisBlock analysis={analysis} />

      <div className="wb-amazon-table-wrap">
        <table className="wb-amazon-table">
          <thead>
            <tr>
              <th className="text">搜索词</th><th>结论</th><th>点击</th><th>订单</th><th>花费</th><th>销售额</th><th>ACOS</th><th>行数</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {words.slice(0, 200).map((word) => (
              <tr key={word.keyword} className={current !== null && word.keyword.toLowerCase() === current.trim().toLowerCase() ? 'is-current-keyword' : undefined}>
                <td className="text" title={word.keyword}>
                  {onOpenTraffic === undefined
                    ? word.keyword
                    : <button className="wb-keyword-link" type="button" title="在报表分析里查看这个词" onClick={() => onOpenTraffic(word.keyword)}>{word.keyword}</button>}
                </td>
                <td><span className={`wb-kw-decision is-${word.code}`}>{DECISION_LABEL[word.code]}</span></td>
                <td>{count(word.clicks)}</td>
                <td>{word.orders}</td>
                <td>{money(word.spend)}</td>
                <td>{money(word.sales)}</td>
                <td>{pct(word.acos)}</td>
                <td>{word.rowCount}</td>
                <td>
                  {onAddToLibrary === undefined
                    ? '—'
                    : <button className="wb-btn sm" type="button" title="生成一条精准候选并保存到关键词库" onClick={() => onAddToLibrary(word.keyword)}>添加为关键词库</button>}
                </td>
              </tr>
            ))}
            {words.length === 0 && (
              <tr><td className="text" colSpan={9}>没有匹配的搜索词 —— 点「清除」看全部 {count(analysis.wordCount)} 个词。</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {words.length > 200 && <p className="wb-amazon-footnote">只显示前 200 个词（按花费降序），共 {count(words.length)} 个。</p>}
    </div>
  )
}
