/**
 * ABA 词表导入 → 分层/判垄断 → DSH 比对（v1.30，用户要求）。
 *
 * ## 为什么单独成组件
 * 关键词页原本是"本地生成候选"，ABA 词表是**市场原始证据**，两者数据来源与
 * 可信度口径都不同（observed vs derived）。混在一个组件里，迟早有人把
 * "我们的建议"当"市场数据"。这里单独一块，标题也写明证据来源。
 *
 * ## 流程
 * 1. 选文件 / 粘贴 → 本地解析（`shared/abaKeywordTable.ts`，纯函数）
 * 2. 立刻给出**本地基线**：分层（按搜索排名）+ 垄断判定（按点击集中度）+ 值得投/观察/避开
 * 3. 保存成一份词表（落库，可回看）
 * 4. 「带入 DSH 比对」把整张表交给助手，让它去查 ABA/卖家精灵、回填结论
 *
 * ## 边界
 * - 本地只出**规则结论**，不编造搜索量以外的市场数据；缺列时明确标 unknown；
 * - 不连接广告账户、不创建投放。
 */
import { useMemo, useState } from 'react'
import {
  classifyAbaRow, parseAbaKeywordTable, summarizeAbaTiers,
  type AbaAnnotation, type AbaParseResult, type AbaThresholds,
} from '../../shared/abaKeywordTable.js'
import { describeDivergence, worthLabel } from '../abaDivergence.js'
import { aggregateByKeyword } from '../../shared/keywordAggregate.js'
import type { UseAbaKeywordSetsResult } from '../hooks/useAbaKeywordSets.js'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'

const TIER_LABEL: Record<string, string> = { head: '头部', middle: '中部', tail: '长尾', unknown: '未知' }
const WORTH_LABEL: Record<string, string> = { invest: '值得投', watch: '观察', avoid: '避开', unknown: '未知' }
const MATCH_LABEL: Record<string, string> = { exact: '精准', phrase: '词组', broad: '广泛' }

export interface AmazonAbaKeywordPanelProps {
  onSendToAI?: (text: string) => void
  /** 共享的搜索词数据集：本页不再自己拉 list + detail 两次请求。 */
  model: UseAmazonDatasetsResult
  /** ABA 词表域：列表 / 当前词表 / 保存 / 打开 / 导出 / 删除的请求全部在 hook 里。 */
  aba: UseAbaKeywordSetsResult
}

export function AmazonAbaKeywordPanel({ onSendToAI, model, aba }: AmazonAbaKeywordPanelProps): JSX.Element {
  const [parsed, setParsed] = useState<AbaParseResult | null>(null)
  const [fileName, setFileName] = useState('')
  /**
   * 选了新文件后先看解析结果，不再显示上一份已保存词表。
   * 原先靠 `setCurrent(null)` 达到同样效果；current 已归 hook，这里用显式开关表达。
   */
  const [showParsed, setShowParsed] = useState(false)
  const [note, setNote] = useState('')
  /** 解析失败（本地）与请求失败（hook）分开存，界面仍只显示一条 error。 */
  const [parseError, setParseError] = useState('')
  const [thresholds, setThresholds] = useState<AbaThresholds>({ headMaxRank: 100, middleMaxRank: 1000, monopolyPercent: 0.5, investPurchaseRate: 0.02, maxSpr: 30, maxProducts: 5000 })
  const [linkOn, setLinkOn] = useState(true)
  /** 只看不一致：词多时唯一能用的入口（5 个词看不出价值，5000 个词必须有它）。 */
  const [onlyDiffers, setOnlyDiffers] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const { sets, current, busy } = aba
  /** 词表名：选了文件用文件名，否则跟随当前词表（原先由自动打开的 setFileName 写入）。 */
  const effectiveFileName = fileName !== '' ? fileName : (current?.title ?? '')
  const error = parseError !== '' ? parseError : (aba.error ?? '')

  /**
   * 关联「我们的搜索词表现」：读**共享模型**的 current（三页同一份数据）。
   *
   * 为什么要这一步：ABA 表回答"这个**市场**词值不值得投"，搜索词报表回答
   * "**我们**在这个词上已经表现如何"。两者按词对上，才能看出
   * 「市场好但我们打亏了」「市场差但我们出单了」这类真正要处理的情况。
   * 匹配是**精确词**（大小写不敏感），不做模糊/词根 —— 模糊匹配会把 b07xxx 之类的
   * ASIN 词串到无关词上，得出的花费归因是错的。
   */
  const dataset = model.current
  const searchRows = useMemo(() => {
    const map = new Map<string, { clicks: number; orders: number; spend: number; sales: number }>()
    /**
     * **必须按词聚合后再查表**：报表是「词 × 日/投放单元」的明细，`tig cups` 有 44 行。
     * 逐行 `map.set` 会让后一行覆盖前一行，界面显示 3 次点击，而词级实际是 55 次 ——
     * 这正是"同一个词在三页数字不一致"的来源。
     */
    for (const word of aggregateByKeyword(dataset?.rows ?? [])) {
      map.set(word.keyword.trim().toLowerCase(), { clicks: word.clicks, orders: word.orders, spend: word.spend, sales: word.sales })
    }
    return map
  }, [dataset])
  const searchTitle = dataset?.title ?? ''
  const searchMeta = useMemo(() => {
    if (dataset === null) return null
    const all = dataset.rows
    return {
      id: dataset.id,
      rows: all.length,
      clicks: all.reduce((sum, row) => sum + row.clicks, 0),
      orders: all.reduce((sum, row) => sum + row.orders, 0),
      spend: all.reduce((sum, row) => sum + row.spend, 0),
      sales: all.reduce((sum, row) => sum + row.sales, 0),
      advice: dataset.annotations.length,
    }
  }, [dataset])

  const rows = showParsed ? (parsed?.rows ?? []) : (current?.rows ?? [])
  const annotationOf = useMemo(() => {
    const map = new Map<string, AbaAnnotation>()
    for (const item of current?.annotations ?? []) map.set(item.keyword.toLowerCase(), item)
    return map
  }, [current])

  const linked = searchRows.size > 0
  const classified = useMemo(
    () => rows.map((row) => {
      const base = classifyAbaRow(row, thresholds)
      const note = annotationOf.get(row.keyword.toLowerCase())
      const actual = searchRows.get(row.keyword.trim().toLowerCase())
      const merged = note === undefined
        ? { row, ...base, overridden: false }
        : { row, tier: base.tier, monopolized: base.monopolized, worth: note.worth, suggestedMatch: note.suggestedMatch ?? base.suggestedMatch, reason: note.reason === '' ? base.reason : note.reason, overridden: true, evidence: note.evidence }
      /** 规则原值单独留着：界面要能显示"规则判什么、回填改成什么"。 */
      const divergence = describeDivergence(
        { worth: base.worth, suggestedMatch: base.suggestedMatch },
        { worth: merged.worth, suggestedMatch: merged.suggestedMatch },
        merged.overridden,
      )
      return { ...merged, actual: actual ?? null, divergence }
    }),
    [rows, thresholds, annotationOf, searchRows],
  )
  const matchedCount = useMemo(() => classified.filter((item) => item.actual !== null).length, [classified])
  const tiers = useMemo(() => summarizeAbaTiers(rows, thresholds), [rows, thresholds])
  /** 「只看不一致」：差异行的数量与过滤后的列表（阈值一改会跟着重算）。 */
  const differCount = useMemo(() => classified.filter((item) => item.divergence.differs).length, [classified])
  const shown = useMemo(() => (onlyDiffers ? classified.filter((item) => item.divergence.differs) : classified), [classified, onlyDiffers])
  const counts = useMemo(() => ({
    invest: classified.filter((item) => item.worth === 'invest').length,
    watch: classified.filter((item) => item.worth === 'watch').length,
    avoid: classified.filter((item) => item.worth === 'avoid').length,
  }), [classified])

  async function pickFile(file: File | undefined): Promise<void> {
    if (file === undefined) return
    setParseError(''); aba.actions.clearError(); setNote(''); setShowParsed(true)
    try {
      const text = await file.text()
      const result = parseAbaKeywordTable(text)
      setFileName(file.name)
      setParsed(result)
      if (!result.ok) setParseError(result.errors.join('；'))
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
    }
  }

  async function saveSet(): Promise<void> {
    const source = parsed
    if (source === null || !source.ok) return
    setParseError(''); aba.actions.clearError(); setNote('')
    const saved = await aba.actions.save({
      title: effectiveFileName === '' ? 'ABA 词表' : effectiveFileName,
      rows: source.rows,
      sourceCode: 'import',
    })
    if (saved === null) return
    setParsed(null)
    setShowParsed(false)
    setNote(`已保存词表「${saved.title}」（${saved.rows.length} 个词）`)
  }

  async function openSet(id: string): Promise<void> {
    setParseError(''); aba.actions.clearError(); setNote(''); setParsed(null); setShowParsed(false)
    const opened = await aba.actions.open(id)
    if (opened !== null) setFileName(opened.title)
  }

  /** 导出对照表（服务端写 CSV，含规则/回填/差异/我们自己的表现）。 */
  async function exportComparison(): Promise<void> {
    if (current === null) return
    setParseError(''); aba.actions.clearError(); setNote(''); setExportPath('')
    const data = await aba.actions.exportComparison(current.id)
    if (data === null) return
    setExportPath(data.path)
    setNote(`已导出 ${data.rows} 行到本机${data.dataset === null ? '（还没有搜索词报表，表现列留空）' : `（表现数据来自「${data.dataset}」）`}`)
  }

  async function removeSet(id: string): Promise<void> {
    if (!window.confirm('删除这份 ABA 词表？删除后不可恢复。')) return
    const ok = await aba.actions.remove(id)
    if (ok && current?.id === id) { setShowParsed(false); setParsed(null) }
  }

  /** 把整张表交给 DSH：要求它去查证据再回填，而不是凭空给建议。 */
  function sendToAI(): void {
    if (onSendToAI === undefined || rows.length === 0) return
    const sample = classified.slice(0, 40)
    const lines = [
      'ABA 词表比对（本地已按规则分层，请核对/补充证据后回填）：',
      `共 ${rows.length} 个词；头部 ${tiers.find((t) => t.tier === 'head')?.count ?? 0} / 中部 ${tiers.find((t) => t.tier === 'middle')?.count ?? 0} / 长尾 ${tiers.find((t) => t.tier === 'tail')?.count ?? 0}`,
      `本地判断：值得投 ${counts.invest}、观察 ${counts.watch}、避开（垄断）${counts.avoid}`,
      '',
      '前 40 个词（关键词 | 排名 | 搜索量 | 购买率 | 点击集中度 | 本地分层 | 本地结论 | 建议匹配）：',
      ...sample.map((item) => [
        item.row.keyword,
        item.row.rank ?? '—',
        item.row.searches ?? '—',
        item.row.purchaseRate === null ? '—' : `${(item.row.purchaseRate * 100).toFixed(1)}%`,
        item.row.clickConcentration === null ? '—' : `${(item.row.clickConcentration * 100).toFixed(1)}%`,
        TIER_LABEL[item.tier] ?? item.tier,
        WORTH_LABEL[item.worth] ?? item.worth,
        item.suggestedMatch === null ? '—' : MATCH_LABEL[item.suggestedMatch],
      ].join(' | ')),
      '',
      '请用 ABA / 卖家精灵的只读工具核对这些词（市场容量、点击/转化集中度、竞品 ASIN），',
      '把需要修正的词按 JSON 数组回填到 PATCH /api/workbench/aba-keywords/{id}/annotations：',
      '[{ "keyword": "...", "worth": "invest|watch|avoid|unknown", "suggestedMatch": "exact|phrase|broad|null", "reason": "...", "evidence": "observed|derived|unknown" }]',
      '没有证据的字段标 unknown，不要用演示值填充。',
    ]
    onSendToAI(lines.join('\n'))
  }

  return (
    <section className="wb-aba" aria-label="ABA 词表">
      <header className="wb-aba-head">
        <div>
          <h3>ABA 词表比对</h3>
          <p>导入亚马逊后台 / 卖家精灵的 ABA 搜索词表 → 本地分层与判垄断 → 交给 DSH 核对证据后回填</p>
        </div>
        <div className="wb-aba-actions">
          <label className="wb-btn">
            选择词表（CSV / TSV）
            <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; void pickFile(f); e.currentTarget.value = '' }} />
          </label>
          <button className="wb-btn" type="button" disabled={parsed === null || !parsed.ok || busy} onClick={() => void saveSet()}>保存词表</button>
          <label className={`wb-aba-link${differCount === 0 ? ' is-disabled' : ''}`} title={differCount === 0 ? '当前没有不一致的行' : `只看规则与回填不一致的行（${differCount} 条）`}>
            <input type="checkbox" checked={onlyDiffers} disabled={differCount === 0} onChange={(e) => setOnlyDiffers(e.target.checked)} />
            只看不一致{differCount > 0 ? `（${differCount}）` : ''}
          </label>
          <button className="wb-btn" type="button" disabled={current === null || busy} onClick={() => void exportComparison()}>导出对照表</button>
          <button className="wb-btn primary" type="button" disabled={rows.length === 0 || onSendToAI === undefined} onClick={sendToAI}>带入 DSH 比对</button>
        </div>
      </header>

      {error !== '' && <div className="wb-amazon-warning" role="alert">{error}</div>}
      {note !== '' && (
        <div className="wb-amazon-note" role="status">
          <div>{note}</div>
          {exportPath !== '' && <div>文件：<code className="wb-amazon-path">{exportPath}</code></div>}
        </div>
      )}

      {parsed !== null && (
        <div className={parsed.ok ? 'wb-amazon-note' : 'wb-amazon-warning'} role="status">
          <div>{fileName} · 表头在第 {parsed.headerRow ?? '?'} 行 · 识别到 {parsed.rows.length} 个词（分隔符 {parsed.delimiter === '\t' ? 'Tab' : '逗号'}）</div>
          {parsed.mapping !== undefined && <div>列映射：{Object.entries(parsed.mapping).map(([key, name]) => `${key}→${name}`).join('，')}</div>}
          {parsed.warnings.map((line) => <div key={line}>提示：{line}</div>)}
        </div>
      )}

      {/**
        * 关联状态带：**永远显示**。
        *
        * 之前只有"两侧都有数据"才出现关联控件，于是没有 ABA 词表时界面上
        * 完全看不出这两块是能对上的 —— 用户只会觉得"还是相互独立"。
        * 空态也要说清缺哪一侧、以及去哪里补。
        */}
      {/**
        * 报表摘要卡：**没有 ABA 词表也要显示**。
        * 用户的真实反馈是"导入成功了，但关键词页什么都没出现" ——
        * 因为原来这一页只有 ABA 表，没有 ABA 表就整页空白。这里先给出报表自身的结论。
        */}
      {searchMeta !== null && (
        <div className="wb-aba-report" role="status">
          <div className="wb-aba-report-head">
            <b>{searchTitle}</b>
            <span>{searchMeta.rows.toLocaleString('en-US')} 个词 · 点击 {searchMeta.clicks.toLocaleString('en-US')} · 订单 {searchMeta.orders} · 花费 ${searchMeta.spend.toFixed(2)} · 销售额 ${searchMeta.sales.toFixed(2)} · ACOS {searchMeta.sales > 0 ? `${((searchMeta.spend / searchMeta.sales) * 100).toFixed(1)}%` : '—'}</span>
          </div>
          <div className="wb-aba-report-foot">
            已写回建议 <b>{searchMeta.advice}</b> 条
            {searchMeta.advice === 0 && <em>（去「报表分析 · 搜索词」点「生成本地建议」，或用下面的「带入 DSH 比对」让助手用市场证据写回）</em>}
            {searchRows.size > 0 && searchMeta !== null && <span> · 与本页词表可匹配 {searchMeta.rows > 0 ? `（词表 ${rows.length} 个）` : ''}</span>}
          </div>
        </div>
      )}
      <div className="wb-aba-linkstate" role="status">
        <span className={`wb-aba-linkstate-item${searchTitle === '' ? ' is-missing' : ''}`}>
          搜索词报表：{searchTitle === '' ? '未导入（去「报表分析 · 搜索词」导入一份）' : `${searchTitle} · ${searchRows.size} 个词`}
        </span>
        <span className={`wb-aba-linkstate-item${sets.length === 0 ? ' is-missing' : ''}`}>
          ABA 词表：{sets.length === 0 ? '尚未保存（选文件导入后点「保存词表」）' : `${sets.length} 份`}
        </span>
        <label className={`wb-aba-link${linked ? '' : ' is-disabled'}`} title={linked ? '' : '先导入搜索词报表才能关联'}>
          <input type="checkbox" checked={linkOn && linked} disabled={!linked} onChange={(e) => setLinkOn(e.target.checked)} />
          关联搜索词表现{linked && rows.length > 0 ? `（匹配 ${matchedCount} / ${rows.length}）` : ''}
        </label>
      </div>
      {sets.length > 0 && (
        <div className="wb-aba-sets">
          <span className="wb-aba-sets-title">已保存（{sets.length}）</span>
          {sets.map((item) => (
            <span key={item.id} className={`wb-aba-set${current?.id === item.id ? ' on' : ''}`}>
              <button type="button" className="wb-aba-set-open" onClick={() => void openSet(item.id)}>{item.title}<small>{item.rowCount} 词 · 回填 {item.annotationCount}</small></button>
              <button type="button" className="wb-oplog-card-open" onClick={() => void removeSet(item.id)}>删除</button>
            </span>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="wb-aba-tiers">
            {tiers.map((tier) => (
              <span key={tier.tier} className={`wb-aba-tier is-${tier.tier}`}>
                {TIER_LABEL[tier.tier] ?? tier.tier}<b>{tier.count}</b>
                <small>搜索量 {tier.searches.toLocaleString('en-US')}{tier.monopolized > 0 ? ` · 垄断 ${tier.monopolized}` : ''}</small>
              </span>
            ))}
            <span className="wb-aba-tier is-worth">值得投<b>{counts.invest}</b><small>观察 {counts.watch} · 避开 {counts.avoid}</small></span>
          </div>

          <div className="wb-aba-thresholds">
            <label>头部门槛<input type="number" min="1" value={thresholds.headMaxRank} onChange={(e) => setThresholds({ ...thresholds, headMaxRank: Number(e.target.value) || 100 })} /></label>
            <label>中部门槛<input type="number" min="1" value={thresholds.middleMaxRank} onChange={(e) => setThresholds({ ...thresholds, middleMaxRank: Number(e.target.value) || 1000 })} /></label>
            <label>垄断线 %<input type="number" min="1" max="100" value={Math.round(thresholds.monopolyPercent * 100)} onChange={(e) => setThresholds({ ...thresholds, monopolyPercent: (Number(e.target.value) || 50) / 100 })} /></label>
            <label>值得投购买率 %<input type="number" min="0" max="100" step="0.1" value={Math.round(thresholds.investPurchaseRate * 1000) / 10} onChange={(e) => setThresholds({ ...thresholds, investPurchaseRate: (Number(e.target.value) || 2) / 100 })} /></label>
            <label>SPR 上限<input type="number" min="1" value={thresholds.maxSpr} onChange={(e) => setThresholds({ ...thresholds, maxSpr: Number(e.target.value) || 30 })} /></label>
            <label>商品数上限<input type="number" min="1" step="100" value={thresholds.maxProducts} onChange={(e) => setThresholds({ ...thresholds, maxProducts: Number(e.target.value) || 5000 })} /></label>

          </div>

          <div className="wb-amazon-table-wrap">
            <table className="wb-amazon-table">
              <thead>
                <tr><th className="text">关键词</th><th>排名</th><th>搜索量</th><th>购买率</th><th>点击集中度</th><th>SPR</th><th>商品数</th><th>分层</th><th>结论</th><th>建议匹配</th><th>规则 vs 回填</th>{linked && linkOn && <><th>我们的花费</th><th>订单</th><th>ACOS</th><th>投放状态</th></>}<th className="text">理由</th></tr>
              </thead>
              <tbody>
                {shown.slice(0, 300).map((item) => (
                  <tr key={item.row.keyword}>
                    <td className="text">{item.row.keyword}</td>
                    <td>{item.row.rank ?? '—'}</td>
                    <td>{item.row.searches === null ? '—' : item.row.searches.toLocaleString('en-US')}</td>
                    <td>{item.row.purchaseRate === null ? '—' : `${(item.row.purchaseRate * 100).toFixed(1)}%`}</td>
                    <td>{item.row.clickConcentration === null ? '—' : `${(item.row.clickConcentration * 100).toFixed(1)}%`}</td>
                    <td>{item.row.spr === null ? '—' : item.row.spr}</td>
                    <td>{item.row.products === null ? '—' : item.row.products.toLocaleString('en-US')}</td>
                    <td>{TIER_LABEL[item.tier] ?? item.tier}</td>
                    <td className={`wb-aba-worth is-${item.worth}`}>{worthLabel(item.worth)}{item.overridden ? '·回填' : ''}</td>
                    <td>{item.suggestedMatch === null ? '—' : MATCH_LABEL[item.suggestedMatch]}</td>
                    <td className={`wb-aba-diverge${item.divergence.differs ? ' is-differs' : ''}`}>{item.divergence.text}</td>
                    {linked && linkOn && (() => {
                      const actual = item.actual
                      if (actual === null) return <><td>—</td><td>—</td><td>—</td><td className="wb-aba-untouched">未投放</td></>
                      const acos = actual.sales > 0 ? actual.spend / actual.sales : null
                      const status = actual.orders > 0 ? (acos !== null && acos <= 0.3 ? '有单·达标' : '有单·ACOS 高') : actual.spend > 0 ? '有花费无单' : '有点击无花费'
                      return (
                        <>
                          <td>${actual.spend.toFixed(2)}</td>
                          <td>{actual.orders}</td>
                          <td>{acos === null ? '—' : `${(acos * 100).toFixed(1)}%`}</td>
                          <td className={`wb-aba-status${actual.spend > 0 && actual.orders === 0 ? ' is-waste' : ''}`}>{status}</td>
                        </>
                      )
                    })()}
                    <td className="text wb-aba-reason">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > 300 && <p className="wb-amazon-footnote">表里只显示前 300 个词（当前筛选 {shown.length} 个，全部 {classified.length} 个）；「导出对照表」包含全部。</p>}
          <p className="wb-amazon-footnote">「规则 vs 回填」列：一致就写「一致」，不一致会显示「规则值 → 回填值」（红色）—— 这些行正是规则前提不成立、需要人看一眼的地方。</p>
          <p className="wb-amazon-footnote">分层按搜索排名、垄断按点击集中度、值得投＝购买率达标且 SPR/商品数在限内（缺 SPR 与商品数时**不给**「值得投」，只判观察）—— 都是**本地规则**（derived）。搜索量与集中度本身来自你导入的表（observed）；缺列的地方标「—」，不猜。</p>
          {linked && linkOn && (
            <p className="wb-amazon-footnote">右边的花费/订单/ACOS 来自**你导入的搜索词报表**（observed），按词精确匹配（大小写不敏感）。「未投放」= 报表里没有这个词，不代表没投过；匹配不到就先别用它下结论。</p>
          )}
        </>
      )}
    </section>
  )
}
