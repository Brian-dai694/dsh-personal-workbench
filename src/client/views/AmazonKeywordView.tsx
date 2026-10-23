import { useMemo, useState } from 'react'
import { buildKeywordPlan, keywordPlanCsv, type KeywordMatch } from '../amazonKeywordTools.js'

export function AmazonKeywordView(): JSX.Element {
  const [seed, setSeed] = useState('welding gloves')
  const [modifiers, setModifiers] = useState('tig, mig, heat resistant')
  const [selected, setSelected] = useState<KeywordMatch[]>(['exact', 'phrase', 'broad'])
  const rows = useMemo(() => buildKeywordPlan(seed, modifiers, selected), [seed, modifiers, selected])
  async function copyCsv(): Promise<void> {
    await navigator.clipboard.writeText(keywordPlanCsv(rows))
  }
  return <section className="wb-amazon-tools" aria-label="关键词规划">
    <header className="wb-amazon-heading"><div><h2>关键词规划</h2><p>本地生成精准、词组、广泛三层结构；不连接广告账户</p></div><button className="wb-btn" onClick={() => { void copyCsv() }}>复制 CSV</button></header>
    <div className="wb-amazon-keyword-form">
      <label>核心词<input value={seed} onChange={(event) => setSeed(event.target.value)} /></label>
      <label>修饰词（逗号分隔）<input value={modifiers} onChange={(event) => setModifiers(event.target.value)} /></label>
      <div className="wb-amazon-checks">{(['exact', 'phrase', 'broad'] as KeywordMatch[]).map((match) => <label key={match}><input type="checkbox" checked={selected.includes(match)} onChange={() => setSelected((current) => current.includes(match) ? current.filter((item) => item !== match) : [...current, match])} />{match}</label>)}</div>
    </div>
    <div className="wb-amazon-table-wrap"><table className="wb-amazon-table"><thead><tr><th>关键词</th><th>匹配</th><th>建议活动</th><th>理由</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.keyword}-${row.match}-${index}`}><td>{row.keyword}</td><td>{row.match}</td><td>{row.campaign}</td><td>{row.rationale}</td></tr>)}</tbody></table></div>
  </section>
}
