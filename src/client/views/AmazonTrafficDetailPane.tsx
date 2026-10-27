/**
 * 搜索词页右侧「分析结果」区（v1.19，用户要求：结果放到另外一边；v1.22 加筛选/排序）。
 *
 * 职责边界：本文件**不解析、不落库、不发请求** —— 它只读 `useAmazonDatasets` 的
 * `current`（左栏导入后就是它），把行数据换算成指标表并显示 AI 写回的建议。
 * 于是"左栏导入 / 右栏看结果"共用同一份 current，不会出现两边行数不一致。
 *
 * ## 为什么要有筛选/排序（v1.22）
 * 报表动辄几百行，日审真正要处理的是其中十几行。没有筛选时用户只能肉眼扫、
 * 或者把整份丢给 AI；筛选把"高花费无单 / ACOS 超阈 / 有曝光无点击"变成一次点击，
 * 并且**同时显示这一片占了多少花费** —— 那才是决策要的数字，不是行数。
 *
 * 口径唯一实现：`shared/trafficFilter.ts`（按钮角标、表格内容、汇总条共用同一份判定）。
 */
import { useEffect, useMemo, useState } from 'react'
import { abaBadgeText, lookupAba, type AbaLookupEntry } from '../trafficAbaJoin.js'
import { deriveAdviceThresholds, type CalibrationResult } from '../adviceCalibration.js'
import { analyseTraffic, summarizeTrafficForAI, type SearchTermAction } from '../../shared/amazonTrafficTools.js'
import { summariseSliceForCopy } from '../trafficCopy.js'
import {
  DEFAULT_TRAFFIC_FILTER, TRAFFIC_PRESETS, TRAFFIC_SORT_KEYS, countByPreset, filterTrafficRows,
  normalizeTrafficFilter, sortTrafficRows, summarizeTrafficSlice,
  type TrafficFilterState, type TrafficPreset, type TrafficSortKey,
} from '../../shared/trafficFilter.js'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'
import { buildKeywordAnalysis } from '../keywordAnalysis.js'
import { AmazonKeywordAnalysisBlock } from './AmazonKeywordAnalysisBlock.js'
import { AmazonAiSummaryBlock } from './AmazonAiSummaryBlock.js'

const ACTION_LABEL: Record<SearchTermAction, string> = {
  add_exact: '加精准',
  add_phrase: '加词组',
  negative_exact: '否精准',
  negative_phrase: '否词组',
  watch: '观察',
  none: '不动',
}

const PRESET_LABEL: Record<TrafficPreset, string> = {
  all: '全部',
  waste: '高花费无单',
  acos_over: 'ACOS 超阈',
  no_click: '有曝光无点击',
  good: '低 ACOS 有单',
}

const SORT_LABEL: Record<TrafficSortKey, string> = {
  spend: '花费',
  clicks: '点击',
  orders: '订单',
  impressions: '曝光',
  sales: '销售额',
  acos: 'ACOS',
  ctr: 'CTR',
  cvr: 'CVR',
  cpc: 'CPC',
}

export interface AmazonTrafficDetailPaneProps {
  model: UseAmazonDatasetsResult
  onSendToAI?: (text: string) => void
  /** 跳到关键词页并定位到这个搜索词（T12 联动）。 */
  onOpenKeyword?: (keyword: string) => void
}

export function AmazonTrafficDetailPane({ model, onSendToAI, onOpenKeyword }: AmazonTrafficDetailPaneProps): JSX.Element {
  const dataset = model.current
  const metrics = useMemo(() => analyseTraffic(dataset?.rows ?? []), [dataset])
  const annotations = useMemo(() => new Map((dataset?.annotations ?? []).map((item) => [item.keyword, item])), [dataset])
  const totals = useMemo(() => summarizeTrafficSlice(metrics), [metrics])
  /**
   * 词级结论（T5）：聚合 + 分层都是 shared/ 的纯函数，视图只做装配。
   * 放在汇总条与筛选栏之间 —— 先看整份表的分层，再用筛选下钻。
   */
  const keywordAnalysis = useMemo(() => buildKeywordAnalysis(dataset?.rows ?? []), [dataset])

  const [filter, setFilter] = useState<TrafficFilterState>(DEFAULT_TRAFFIC_FILTER)
  const [sortKey, setSortKey] = useState<TrafficSortKey>('spend')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [copyNote, setCopyNote] = useState('')
  /** 跨页联动：关键词页带过来的"当前词"自动落成筛选条件，不用用户再手打一遍。 */
  useEffect(() => {
    const keyword = model.currentKeyword ?? null
    if (keyword === null || keyword.trim() === '') return
    setFilter((prev) => normalizeTrafficFilter({ ...prev, query: keyword }))
  }, [model.currentKeyword])
  /**
   * ABA 市场判断（反向关联）：读**已保存**的 ABA 词表，按词精确匹配到本报表。
   *
   * 为什么放在这里：报表只能说明"这个词我们花了多少、有没有单"；
   * 要不要继续争取决于市场结构。一个头部已垄断的词，结论是换打法，
   * 而不是继续优化同一个词 —— 这两条信息分开看会得出相反的建议。
   */
  /**
   * ABA 查表由 hook 提供（视图不许发 HTTP），这里只读。
   * 缺字段时按「没关联」处理 —— 旧 model 形状不该把整页打崩。
   */
  const abaLookup = model.abaLookup ?? new Map<string, AbaLookupEntry>()
  const abaSource = model.abaSource ?? ''
  const [showAba, setShowAba] = useState(true)
  const [adviceBusy, setAdviceBusy] = useState(false)
  const [adviceNote, setAdviceNote] = useState('')
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null)

  const presetCounts = useMemo(
    () => countByPreset(metrics, filter),
    [metrics, filter.acosThreshold, filter.minClicks],
  )
  const visible = useMemo(
    () => sortTrafficRows(filterTrafficRows(metrics, filter), sortKey, sortDir),
    [metrics, filter, sortKey, sortDir],
  )
  const slice = useMemo(() => summarizeTrafficSlice(visible, metrics), [visible, metrics])
  const filtered = filter.preset !== 'all' || filter.query.trim() !== ''

  /**
   * 一键用**本地规则**生成建议（离线，不需要 AI 会话）。
   *
   * 之前「AI 建议」列只在有人写过建议时才有内容，新导入的报表整列是「待分析」，
   * 看起来像功能坏了。这个按钮让报表在**导入后立刻**有可执行的结论；
   * 「带入 AI 协助」仍然保留，用于需要市场证据的深挖。
   */
  /**
   * 本地规则建议：请求在 hook 里（视图只表达意图）。
   * 若已按你的数据校准过阈值，就用校准值，而不是默认的 8 次 / 30%。
   */
  /** 用你自己的报表反推阈值（纯本地计算，不发请求）。 */
  function calibrate(): void {
    const result = deriveAdviceThresholds(metrics)
    setCalibration(result)
    setAdviceNote(result.rationale)
  }

  async function generateAdvice(): Promise<void> {
    if (model === null || dataset === null) return
    setAdviceBusy(true)
    setAdviceNote('')
    try {
      const before = dataset.annotations.length
      const generate = model.actions.generateLocalAdvice
      if (generate === undefined) throw new Error('当前版本不支持本地建议（请重启桌面端加载新构建）')
      const thresholds = calibration?.thresholds ?? null
      const count = await generate(thresholds === null ? {} : { thresholds })
      const scope = thresholds === null
        ? '默认口径（8 次点击 / 30% ACOS）'
        : `按你的数据校准（${thresholds.wasteMinClicks} 次点击 / ${(thresholds.goodAcos * 100).toFixed(0)}% ACOS）`
      setAdviceNote(count === 0
        ? '没有需要处理的词（可能已经生成过，或所有行都在门槛之下）'
        : `已生成 ${count} 条本地建议并写回（此前 ${before} 条）。口径：${scope}，证据等级 derived。`)
    } catch (e) {
      setAdviceNote(`生成失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAdviceBusy(false)
    }
  }
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

  /** 复制当前筛选结果（TSV，可直接粘进 Excel）。口径与表格一致，不另算一份。 */
  async function copyVisible(): Promise<void> {
    const text = summariseSliceForCopy(visible, annotations)
    try {
      await navigator.clipboard.writeText(text)
      setCopyNote(`已复制 ${visible.length} 行`)
    } catch {
      setCopyNote('复制失败：浏览器拒绝了剪贴板权限')
    }
  }

  function pickPreset(preset: TrafficPreset): void {
    setFilter((prev) => ({ ...prev, preset }))
  }

  return (
    <section className="wb-amazon-result-pane" aria-label="搜索词分析结果">
      <header className="wb-amazon-result-head-bar">
        <div>
          <h4>{dataset.title}</h4>
          <p>{dataset.period ?? '周期未提供（unknown）'} · {metrics.length} 行 · 建议 {dataset.annotations.length} 条</p>
        </div>
        <div className="wb-amazon-result-head-actions">
          <button className="wb-btn" type="button" disabled={model.busy} onClick={() => void model.actions.select(dataset.id)}>刷新</button>
          <button className="wb-btn" type="button" disabled={metrics.length === 0} onClick={calibrate}>按我的数据校准</button>
          <button className="wb-btn primary" type="button" disabled={model.busy || adviceBusy || metrics.length === 0} onClick={() => void generateAdvice()}>生成本地建议</button>
          <button className="wb-btn" type="button" disabled={!onSendToAI} onClick={sendToAI}>带入 AI 协助</button>
        </div>
      </header>

      {adviceNote !== '' && <div className="wb-amazon-note" role="status">{adviceNote}</div>}
      {(model.currentKeyword ?? '') !== '' && (
        <div className="wb-amazon-note" role="status">
          正在定位搜索词：<b>{model.currentKeyword}</b>
          <button
            className="wb-oplog-card-open"
            type="button"
            style={{ marginLeft: 8 }}
            onClick={() => {
              model.actions.setCurrentKeyword?.(null)
              setFilter((prev) => ({ ...prev, query: '' }))
            }}
          >清除定位</button>
        </div>
      )}
      <div className="wb-amazon-summary">
        <Summary label="曝光" value={totals.impressions.toLocaleString('en-US')} />
        <Summary label="点击" value={totals.clicks.toLocaleString('en-US')} />
        <Summary label="订单" value={String(totals.orders)} />
        <Summary label="花费" value={`$${totals.spend.toFixed(2)}`} />
        <Summary label="销售额" value={`$${totals.sales.toFixed(2)}`} />
        <Summary label="整体 ACOS" value={totals.acos === null ? '—' : `${(totals.acos * 100).toFixed(1)}%`} />
      </div>

      <AmazonKeywordAnalysisBlock analysis={keywordAnalysis} />

      {/**
        * AI 报表结论（T4）：`aiSummary` 为空 = 待分析，一个按钮把带 dataset_id 的交接
        * 交给 agent；结论写回后由「刷新」重新读 `current`。
        */}
      <AmazonAiSummaryBlock summary={dataset.aiSummary} onAnalyse={onSendToAI === undefined ? undefined : () => sendToAI()} />

      <div className="wb-traffic-bar" role="group" aria-label="搜索词筛选">
        <div className="wb-traffic-presets">
          {TRAFFIC_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`wb-traffic-preset${filter.preset === preset ? ' on' : ''}`}
              aria-pressed={filter.preset === preset}
              onClick={() => pickPreset(preset)}
            >
              {PRESET_LABEL[preset]}
              <span className="wb-traffic-preset-count">{presetCounts[preset]}</span>
            </button>
          ))}
        </div>
        <div className="wb-traffic-controls">
          <input
            className="wb-traffic-search"
            type="search"
            value={filter.query}
            placeholder="搜索词包含…"
            aria-label="按搜索词过滤"
            onChange={(event) => setFilter((prev) => normalizeTrafficFilter({ ...prev, query: event.target.value }))}
          />
          <label className="wb-traffic-threshold">
            ACOS 阈值
            <input
              type="number" min="0" max="100" step="1"
              value={Math.round(filter.acosThreshold * 100)}
              aria-label="ACOS 阈值（百分比）"
              onChange={(event) => setFilter((prev) => normalizeTrafficFilter({ ...prev, acosThreshold: Number(event.target.value) / 100 }))}
            />
            <b>%</b>
          </label>
          <label className="wb-traffic-threshold">
            点击门槛
            <input
              type="number" min="1" max="9999" step="1"
              value={filter.minClicks}
              aria-label="高花费无单的点击门槛"
              onChange={(event) => setFilter((prev) => normalizeTrafficFilter({ ...prev, minClicks: Number(event.target.value) }))}
            />
            <b>次</b>
          </label>
          <select
            className="wb-oplog-select"
            value={sortKey}
            aria-label="排序字段"
            onChange={(event) => setSortKey(event.target.value as TrafficSortKey)}
          >
            {TRAFFIC_SORT_KEYS.map((key) => <option key={key} value={key}>{SORT_LABEL[key]}</option>)}
          </select>
          <button type="button" className="wb-btn" onClick={() => setSortDir((dir) => (dir === 'desc' ? 'asc' : 'desc'))} title={sortDir === 'desc' ? '当前降序，点击切升序' : '当前升序，点击切降序'}>
            {sortDir === 'desc' ? '降序 ↓' : '升序 ↑'}
          </button>
          <button type="button" className="wb-btn" onClick={() => { void copyVisible() }}>复制结果</button>
          {abaLookup.size > 0 ? (
            <label className="wb-aba-link" title={`ABA 来源：${abaSource}`}>
              <input type="checkbox" checked={showAba} onChange={(e) => setShowAba(e.target.checked)} />
              ABA 分层
            </label>
          ) : (
            <span className="wb-aba-link is-disabled" title="在「关键词」页导入并保存一份 ABA 词表后，这里会显示每个词的市场分层">
              未关联 ABA 词表（去「关键词」页导入）
            </span>
          )}
          {filtered && <button type="button" className="wb-btn" onClick={() => setFilter((prev) => ({ ...DEFAULT_TRAFFIC_FILTER, acosThreshold: prev.acosThreshold, minClicks: prev.minClicks }))}>清空筛选</button>}
        </div>
      </div>

      <p className="wb-traffic-slice" role="status">
        {filtered ? `筛出 ${slice.rows} / ${metrics.length} 行` : `共 ${slice.rows} 行`}
        {' · '}花费 <b>${slice.spend.toFixed(2)}</b>
        {slice.spendShare === null ? '' : `（占整份 ${(slice.spendShare * 100).toFixed(1)}%）`}
        {' · '}订单 <b>{slice.orders}</b>
        {' · '}ACOS <b>{slice.acos === null ? '—' : `${(slice.acos * 100).toFixed(1)}%`}</b>
        {copyNote !== '' && <span className="wb-traffic-copy-note">{copyNote}</span>}
      </p>

      <div className="wb-amazon-table-wrap">
        <table className="wb-amazon-table wb-amazon-table-grid">
          <thead>
            <tr>
              <th className="text">搜索词</th>{abaLookup.size > 0 && showAba && <th>ABA 市场</th>}<th>ACOS</th><th>点击</th><th>订单</th><th>花费</th><th className="text">AI 建议</th>
              <th>曝光</th><th>销售额</th><th>CTR</th><th>CVR</th><th>CPC</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, rowIndex) => {
              const note = annotations.get(row.keyword)
              return (
                <tr key={`${row.keyword}#${rowIndex}`}>
                  <td className="text" title={row.keyword}>
                    {onOpenKeyword === undefined
                      ? row.keyword
                      : (
                        <button
                          className="wb-keyword-link"
                          type="button"
                          title="在关键词页查看这个词"
                          onClick={() => onOpenKeyword(row.keyword)}
                        >{row.keyword}</button>
                      )}
                  </td>
                  {abaLookup.size > 0 && showAba && (() => {
                    const entry = lookupAba(abaLookup, row.keyword)
                    const text = abaBadgeText(entry)
                    return <td className={`wb-aba-market${entry?.monopolized === true ? ' is-monopoly' : ''}`} title={entry === null ? 'ABA 词表里没有这个词' : `${text} · 建议 ${entry.worth}`}>{text === '' ? '—' : text}</td>
                  })()}
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
            {visible.length === 0 && (
              <tr><td className="text" colSpan={abaLookup.size > 0 && showAba ? 12 : 11}>当前筛选没有命中任何搜索词 —— 放宽阈值或点「清空筛选」。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="wb-amazon-footnote">列序按「先决策、后明细」：搜索词 → ACOS → 点击/订单/花费 → AI 建议，其余（曝光、销售额、CTR、CVR、CPC）右滚可见。</p>
      {abaLookup.size > 0 && showAba && (
        <p className="wb-amazon-footnote">「ABA 市场」来自你保存的 ABA 词表（{abaSource}）：分层按搜索排名、垄断按点击集中度。词表里没有的词显示「—」—— 不代表市场没这个词，只是这次没导进来。</p>
      )}
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
