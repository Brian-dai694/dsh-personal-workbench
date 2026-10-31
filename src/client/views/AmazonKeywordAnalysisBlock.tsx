/**
 * 流量分析右侧：**关键词分层分析块**（T5）。
 *
 * 位置契约：放在汇总条下面、筛选栏上面 —— 先给"这份表整体的结论"，
 * 再让用户用筛选去下钻。反过来会变成"先筛再看结论"，用户永远不知道全量长什么样。
 *
 * 职责边界：本组件是**纯展示**。聚合与判定都在 `client/keywordAnalysis.ts`
 * （它再回调 `shared/keywordAggregate.ts` / `shared/keywordDecision.ts`），
 * 阈值一处都不在这里写。
 */
import type { KeywordAnalysis } from '../keywordAnalysis.js'

const money = (value: number): string => `$${value.toFixed(2)}`
const pct = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`
const count = (value: number): string => value.toLocaleString('en-US')

export function AmazonKeywordAnalysisBlock({ analysis }: { analysis: KeywordAnalysis }): JSX.Element {
  const { rowCount, wordCount, spend, acos, buckets, risks, opportunities, missingPlacement, placementGap } = analysis

  return (
    <section className="wb-kw-analysis" aria-label="关键词分层分析">
      <header className="wb-kw-analysis-head">
        <h5>词级分析</h5>
        <span>{count(rowCount)} 行 → <b>{count(wordCount)}</b> 词</span>
      </header>

      <div className="wb-kw-overview">
        <div className="wb-kw-overview-item"><span>唯一词数</span><strong>{count(wordCount)}</strong></div>
        <div className="wb-kw-overview-item"><span>合计花费</span><strong>{money(spend)}</strong></div>
        <div className="wb-kw-overview-item"><span>ACOS</span><strong>{pct(acos)}</strong></div>
      </div>

      <div className="wb-kw-buckets" role="list" aria-label="结论分布">
        {buckets.map((bucket) => (
          <div key={bucket.code} className={`wb-kw-bucket is-${bucket.code}`} role="listitem">
            <b>{bucket.label}<span className="wb-kw-bucket-count">{count(bucket.count)}</span></b>
            <span>花费 {money(bucket.spend)}</span>
          </div>
        ))}
      </div>

      <div className="wb-kw-tops">
        <div className="wb-kw-top">
          <h6>Top 5 风险 · 否定（按花费）</h6>
          {risks.length === 0
            ? <p className="wb-kw-empty">没有词达到否词门槛</p>
            : (
              <table>
                <thead><tr><th className="text">搜索词</th><th>花费</th><th>点击</th><th>订单</th></tr></thead>
                <tbody>
                  {risks.map((row) => (
                    <tr key={row.keyword}>
                      <td className="text" title={row.keyword}>{row.keyword}</td>
                      <td>{money(row.spend)}</td>
                      <td>{count(row.clicks)}</td>
                      <td>{row.orders}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        <div className="wb-kw-top">
          <h6>Top 5 机会 · 加词（按销售额）</h6>
          {opportunities.length === 0
            ? <p className="wb-kw-empty">没有词达到加词门槛</p>
            : (
              <table>
                <thead><tr><th className="text">搜索词</th><th>销售额</th><th>订单</th><th>花费</th></tr></thead>
                <tbody>
                  {opportunities.map((row) => (
                    <tr key={row.keyword}>
                      <td className="text" title={row.keyword}>{row.keyword}</td>
                      <td>{money(row.sales)}</td>
                      <td>{row.orders}</td>
                      <td>{money(row.spend)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </div>

      {/**
       * 两种缺列原因分开说（2026-10-29）：
       * 「文件里没有该列」是用户侧动作（回后台按投放单元导出），
       * 「旧数据没这三列」是我们历史格式，重新导入即可带上 —— 不说清用户只能猜。
       */}
      {missingPlacement && (
        <p className="wb-kw-footnote">
          {placementGap === 'legacy-rows'
            ? '否词需按投放单元复核：这份数据是旧格式导入的，没有广告组/匹配类型列。重新导入同一份报表即可带上这两列（会存进数据集，刷新后仍在）。'
            : '否词需按投放单元复核：报表里没有广告组/匹配类型（或整列为空）。去广告后台按「投放单元」维度重新导出，再导入即可精确定位。'}
        </p>
      )}
    </section>
  )
}
