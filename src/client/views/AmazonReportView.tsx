/**
 * 广告报表分析（P1）：搜索词 / 投放 / 广告活动。
 *
 * 为什么单独一个视图，而不是塞进「流量分析」：
 * 流量分析是**搜索词单表**的分析面（行 → 建议 → AI 写回），
 * 这三类报表是**多表统一处理**（同一套指标 + 同一套规则 + 人工确认清单），
 * 塞在一起会让两边都变形。共用的是下面这套纯函数（`shared/adReport`）。
 *
 * 边界：这里只做只读分析，产出「给人照着改的清单」，**不写广告账户**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import {
  AD_ACTION_LABELS, DEFAULT_RULES, actionsToCsv, analyseAdReport, parseAdReportCsv,
} from '../../shared/adReport.js'
import type { AdAnalysis, AdReportKind, AdReportRow, RuleConfig } from '../../shared/adReport.js'
import { KEYWORD_RULES } from '../../shared/keywordDecision.js'
import { DECISION_LABEL, buildKeywordAnalysis } from '../keywordAnalysis.js'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'
import type { AdReportDatasetSummary, UseAdReportDatasetsResult } from '../hooks/useAdReportDatasets.js'

const KINDS: ReadonlyArray<{ key: AdReportKind; label: string; hint: string; placeholder: string }> = [
  { key: 'search_term', label: '搜索词', hint: '搜索词报表：客户搜索词 + 曝光/点击/花费/销售/订单', placeholder: '客户搜索词\t曝光量\t点击量\t花费\t销售额\t订单\nwelding gloves\t1000\t32\t24\t0\t0\ntig gloves\t800\t18\t14\t120\t3' },
  { key: 'targeting', label: '投放', hint: '投放报表：投放词/商品 + 匹配类型 + 广告活动 + 指标', placeholder: '投放\t匹配类型\t广告活动名称\t曝光量\t点击量\t花费\t销售额\t订单\ntig torch cup\t广泛\tSP-A\t1200\t40\t32\t90\t2' },
  { key: 'campaign', label: '广告活动', hint: '广告活动报表：活动 + 预算 + 指标（预算使用率用来判加/降预算）', placeholder: '广告活动名称\t预算\t曝光量\t点击量\t花费\t销售额\t订单\nSP-A\t50\t12000\t240\t180\t600\t12' },
  { key: 'placement', label: '广告位', hint: '广告位报表：活动 × 广告位（搜索结果顶部 / 商品页面 / 其余位置），用来逐活动调加价', placeholder: '广告位\t广告活动名称\t曝光量\t点击量\t花费\t销售额\t订单\n搜索结果顶部\tSP-A\t5000\t60\t48\t150\t4\n商品页面\tSP-A\t7000\t40\t30\t0\t0' },
  { key: 'budget', label: '预算', hint: '预算报表：活动 + 预算 + 花费（预算使用率 < 低水位=钱没花掉，> 打满线=被卡住）', placeholder: '广告活动名称\t预算\t花费\t曝光量\t点击量\t销售额\t订单\nSP-A\t50\t48\t20000\t200\t300\t10\nSP-B\t100\t20\t900\t9\t0\t0' },
  { key: 'impression_share', label: '搜索词份额', hint: '搜索词展示量份额报表：份额越低、ACOS 越达标，越是「低份额高效」机会词', placeholder: '客户搜索词\t曝光份额\t曝光量\t点击量\t花费\t销售额\t订单\ntig torch cup\t6.5%\t3000\t45\t30\t120\t3' },
]

type Status = { level: 'ok' | 'warn' | 'error'; lines: string[] } | null

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

/** CSV 单元格：含逗号/引号/换行时按标准转义，避免复制出去错列。 */
function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export interface AmazonReportViewProps {
  /**
   * 共享数据集模型（T3）：`search_term` 一路的 current / 列表 / 导入都读它，
   * 与流量分析、关键词页是**同一个** `amazonData`。
   */
  amazon: UseAmazonDatasetsResult
  /** 其余 5 种报表的本地状态：请求全在 hook 里（视图不发 HTTP）。 */
  reports: UseAdReportDatasetsResult
}

export function AmazonReportView({ amazon, reports }: AmazonReportViewProps): JSX.Element {
  const { t } = useI18n()
  const [kind, setKind] = useState<AdReportKind>('search_term')
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)
  const [rules, setRules] = useState<RuleConfig>(DEFAULT_RULES)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const kindMeta = KINDS.find((item) => item.key === kind) ?? KINDS[0]!

  /**
   * 数据源分两路，但**只有一份 current 属于搜索词**：
   * - `search_term` → 共享模型（切换类型不会覆盖它）；
   * - 其余类型 → 报表域 hook 的本地 current。
   */
  const rows: AdReportRow[] = kind === 'search_term' ? (amazon.current?.rows ?? []) : (reports.current?.rows ?? [])
  const history: AdReportDatasetSummary[] = kind === 'search_term' ? amazon.datasets : reports.history

  /** 其余 5 种类型：切页签时读该类型的最近一份（搜索词不在这里拉，共享模型自己管）。 */
  const { loadLatest } = reports.actions
  useEffect(() => {
    if (kind === 'search_term') return
    void loadLatest(kind)
  }, [kind, loadLatest])

  /** 其余类型的读取失败仍要可见（原先由 loadLatest 直接写 status，现在错误归 hook）。 */
  useEffect(() => {
    if (reports.error !== null) setStatus({ level: 'error', lines: [reports.error] })
  }, [reports.error])

  /**
   * 搜索词：与流量分析 / 关键词页**同一份**词级结论。
   *
   * 这里不再调用 `analyseAdReport`（它是按行、按另一套阈值），否则同一份 1243 行报表
   * 会在报表页显示「建议 1 条」、在流量页显示「否定 7 / 加词 3」—— 用户无法判断信谁。
   */
  const keywordAnalysis = useMemo(
    () => kind === 'search_term' && rows.length > 0 ? buildKeywordAnalysis(rows) : null,
    [kind, rows],
  )
  /** 其余 5 种报表：沿用多表统一规则（投放 / 活动 / 广告位 / 预算 / 份额）。 */
  const adAnalysis: AdAnalysis | null = useMemo(
    () => kind !== 'search_term' && rows.length > 0 ? analyseAdReport(rows, kind, rules) : null,
    [rows, kind, rules],
  )
  /** 需要人处理的词（否词 + 加词），报表页的清单与 CSV 都基于它。 */
  const wordActions = useMemo(
    () => keywordAnalysis === null ? [] : keywordAnalysis.words.filter((word) => word.code === 'negative' || word.code === 'add'),
    [keywordAnalysis],
  )
  const adActions = adAnalysis?.actions ?? []
  const actionCount = kind === 'search_term' ? wordActions.length : adActions.length
  /** 非搜索词一路沿用旧渲染块；搜索词走下面的词级块，避免两套结论同时出现。 */
  const analysis = adAnalysis

  const ingest = useCallback(async (raw: string, source: string): Promise<void> => {
    const parsed = parseAdReportCsv(raw, kind)
    if (!parsed.ok) {
      setStatus({ level: 'error', lines: [`导入未通过：${parsed.errors.join('；')}`] })
      return
    }
    setBusy(true)
    try {
      const title = `${kindMeta.label}报表 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
      const saved = kind === 'search_term'
        ? await amazon.actions.importRows({ title, period: parsed.period, rows: parsed.rows, sourceCode: source })
        : await reports.actions.importRows(kind, { title, period: parsed.period, rows: parsed.rows, sourceCode: source })
      if (saved === null) {
        const reason = (kind === 'search_term' ? amazon.error : reports.error) ?? '未知原因'
        setStatus({ level: 'error', lines: [`解析成功，但保存到工作台失败（${reason}）`] })
        return
      }
      setText('')
      const lines = [`已导入 ${parsed.rows.length} 行${parsed.period === null ? '' : ` · ${parsed.period}`}`]
      if (parsed.warnings.length > 0) lines.push(parsed.warnings.join('；'))
      setStatus({ level: parsed.warnings.length > 0 ? 'warn' : 'ok', lines })
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    } finally {
      setBusy(false)
    }
  }, [kind, kindMeta.label, amazon.actions, amazon.error, reports.actions, reports.error])

  const pickFile = (file: File | undefined): void => {
    if (file === undefined) return
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      setStatus({ level: 'warn', lines: ['暂不支持 Excel 直读：请在表格里另存为 CSV/TSV 后导入（Excel 支持在下一批）'] })
      return
    }
    void (async () => {
      setBusy(true)
      try {
        await ingest(await file.text(), file.name)
      } catch (error) {
        setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
      } finally {
        setBusy(false)
      }
    })()
  }

  /**
   * 导出 = **复制 CSV 到剪贴板**。
   *
   * 仓库有两条硬约束：客户端只允许 `MarkdownText` 里出现 `<a>`；
   * 也不允许把数据当成文件下载（避免"看起来导出了、其实没落地"的歧义）。
   * 关键词规划页（`AmazonKeywordView`）已经是"复制 CSV"的口径，这里保持一致：
   * 复制出去可直接粘进 Excel / 广告后台的批量表格。
   */
  const copyCsv = async (): Promise<void> => {
    let csv = ''
    let copied = 0
    if (kind === 'search_term') {
      if (keywordAnalysis === null || wordActions.length === 0) return
      const lines = ['搜索词,结论,点击,订单,花费,销售额,ACOS,原始行数']
      for (const word of wordActions) {
        lines.push([
          word.keyword,
          DECISION_LABEL[word.code],
          word.clicks,
          word.orders,
          word.spend.toFixed(2),
          word.sales.toFixed(2),
          word.acos === null ? '' : `${(word.acos * 100).toFixed(1)}%`,
          word.rowCount,
        ].map(csvCell).join(','))
      }
      csv = lines.join('\n')
      copied = wordActions.length
    } else {
      if (adAnalysis === null) return
      csv = actionsToCsv(adAnalysis.actions, kind)
      copied = adAnalysis.actions.length
    }
    try {
      await navigator.clipboard.writeText(csv)
      setStatus({ level: 'ok', lines: [`已复制 ${copied} 条建议到剪贴板（人工确认清单，未修改广告账户）`] })
    } catch (error) {
      setStatus({ level: 'error', lines: [`复制失败：${error instanceof Error ? error.message : String(error)}`] })
    }
  }

  const switchKind = (next: AdReportKind): void => {
    setKind(next)
    setStatus(null)
    setText('')
  }

  return (
    <div className="wb-report">
      <div className="wb-amazon-heading">
        <div>
          <h2>{t('广告报表分析')}</h2>
          <p>{t('导入后台导出的报表，按同一套规则出「加/否词、提/降价、加/降预算」的人工确认清单；只读分析，不碰账户。')}</p>
        </div>
        <button type="button" className="wb-btn" disabled={actionCount === 0} onClick={() => void copyCsv()}>
          <Icon name="file" size={13} />{t('复制建议 CSV')}
        </button>
      </div>

      <div className="wb-report-tabs" role="tablist">
        {KINDS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={kind === item.key}
            className={`wb-report-tab${kind === item.key ? ' on' : ''}`}
            onClick={() => switchKind(item.key)}
          >{t(item.label)}</button>
        ))}
      </div>

      <div className="wb-card">
        <h4><Icon name="list" size={14} />{t('导入报表')}</h4>
        <p className="wb-hint">{t(kindMeta.hint)}</p>
        <div className="wb-report-actions">
          <button type="button" className="wb-btn" disabled={busy || text.trim() === ''} onClick={() => void ingest(text, 'paste')}>
            {t('解析并导入')}
          </button>
          <label className="wb-btn">
            <Icon name="file" size={13} />{t('选择 CSV / TSV')}
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                pickFile(file)
                event.currentTarget.value = ''
              }}
            />
          </label>
          {history.length > 0 && (
            <span className="wb-hint" style={{ margin: 0 }}>
              {t('最近一份：')}{history[0]!.title}（{history[0]!.rowCount} 行）
            </span>
          )}
        </div>
        <textarea
          className="wb-report-textarea"
          value={text}
          spellCheck={false}
          placeholder={kindMeta.placeholder}
          onChange={(event) => setText(event.target.value)}
          rows={6}
        />
      </div>

      {status !== null && (
        <div className={`wb-report-status is-${status.level}`}>
          {status.lines.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}

      <div className="wb-card">
        <h4><Icon name="chart" size={14} />{t('规则阈值')}</h4>
        {kind === 'search_term' ? (
          <p className="wb-hint">
            搜索词统一口径（与流量分析、关键词页同一份）：点击 ≥ {KEYWORD_RULES.negativeMinClicks} 且 0 单 = 否定；订单 ≥ {KEYWORD_RULES.addMinOrders} 且 ACOS ≤ {Math.round(KEYWORD_RULES.addMaxAcos * 100)}% = 加词。此处不可单独修改。
          </p>
        ) : (
        <div className="wb-report-rules">
          <label>{t('目标 ACOS')}
            <input type="number" min={1} max={200} value={Math.round(rules.targetAcos * 100)}
              onChange={(event) => setRules({ ...rules, targetAcos: Math.max(1, Number(event.target.value) || 1) / 100 })} />%
          </label>
          <label>{t('最小点击样本')}
            <input type="number" min={1} value={rules.minClicks}
              onChange={(event) => setRules({ ...rules, minClicks: Math.max(1, Number(event.target.value) || 1) })} />
          </label>
          <label>{t('加词最小订单')}
            <input type="number" min={1} value={rules.minOrders}
              onChange={(event) => setRules({ ...rules, minOrders: Math.max(1, Number(event.target.value) || 1) })} />
          </label>
          <label>{t('产品阶段')}
            <select className="wb-oplog-select" value={rules.stage} onChange={(event) => setRules({ ...rules, stage: event.target.value === 'mature' ? 'mature' : 'growth' })}>
              <option value="growth">{t('成长期（放宽样本）')}</option>
              <option value="mature">{t('成熟期（收紧 ACOS）')}</option>
            </select>
          </label>
          <label>{t('预算低使用率')}
            <input type="number" min={1} max={100} value={Math.round(rules.lowBudgetUsage * 100)}
              onChange={(event) => setRules({ ...rules, lowBudgetUsage: Math.max(1, Number(event.target.value) || 1) / 100 })} />%
          </label>
          <label>{t('预算打满线')}
            <input type="number" min={1} max={100} value={Math.round(rules.highBudgetUsage * 100)}
              onChange={(event) => setRules({ ...rules, highBudgetUsage: Math.max(1, Number(event.target.value) || 1) / 100 })} />%
          </label>
          {kind === 'impression_share' && (
            <label>{t('低份额线')}
              <input type="number" min={1} max={100} value={Math.round(rules.lowShare * 100)}
                onChange={(event) => setRules({ ...rules, lowShare: Math.max(1, Number(event.target.value) || 1) / 100 })} />%
            </label>
          )}
        </div>
        )}
        {kind !== 'search_term' && (
          <p className="wb-hint">{t('阈值只影响建议，不会改动任何账户数据；同一份报表改阈值会即时重算。')}</p>
        )}
      </div>

      {rows.length === 0 && (
        <div className="wb-empty">
          <div className="wb-empty-title">{t('还没有 {k} 报表', { k: kindMeta.label })}</div>
          <div className="wb-empty-desc">{t('从亚马逊广告后台导出对应报表（CSV/TSV），粘贴到上面或选文件导入。')}</div>
        </div>
      )}

      {kind === 'search_term' && keywordAnalysis !== null && (
        <>
          <div className="wb-stats">
            <div className="wb-stat"><span>花费</span><b>{money(keywordAnalysis.spend)}</b></div>
            <div className="wb-stat"><span>销售额</span><b>{money(keywordAnalysis.sales)}</b></div>
            <div className="wb-stat"><span>ACOS</span><b>{pct(keywordAnalysis.acos)}</b></div>
            <div className="wb-stat"><span>无单花费占比</span><b>{pct(keywordAnalysis.zeroOrderSpendShare)}</b></div>
            <div className="wb-stat"><span>唯一词</span><b>{keywordAnalysis.wordCount.toLocaleString('en-US')}</b></div>
          </div>

          <div className="wb-card">
            <h4><Icon name="trend" size={14} />建议清单（{wordActions.length}）</h4>
            <div className="wb-report-quadrants">
              {keywordAnalysis.buckets.map((bucket) => <span key={bucket.code} className="wb-chip is-neutral">{bucket.label} · {bucket.count}</span>)}
            </div>
            {wordActions.length === 0
              ? <p className="wb-hint">按统一口径没有需要处理的词。</p>
              : (
                <div className="wb-report-tablewrap">
                  <table className="wb-report-table">
                    <thead>
                      <tr><th>优先级</th><th>搜索词</th><th>动作</th><th>理由</th></tr>
                    </thead>
                    <tbody>
                      {wordActions.map((word) => (
                        <tr key={`${word.code}-${word.keyword}`}>
                          <td><span className={`wb-report-prio p${word.code === 'negative' ? 1 : 2}`}>P{word.code === 'negative' ? 1 : 2}</span></td>
                          <td>{word.keyword}</td>
                          <td><span className="wb-chip">{DECISION_LABEL[word.code]}</span></td>
                          <td className="is-reason">
                            {word.code === 'negative'
                              ? `${word.clicks} 次点击 / 0 单 / $${word.spend.toFixed(2)}`
                              : `${word.orders} 单 / ACOS ${word.acos === null ? '—' : `${(word.acos * 100).toFixed(1)}%`}`}
                            {keywordAnalysis.missingPlacement ? '（否词需按投放单元复核）' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>

          <div className="wb-card">
            <h4><Icon name="list" size={14} />明细（{keywordAnalysis.wordCount} 词，按花费排序）</h4>
            <p className="wb-hint">{keywordAnalysis.rowCount.toLocaleString('en-US')} 行原始报表按词合并为 {keywordAnalysis.wordCount.toLocaleString('en-US')} 个词；与流量分析、关键词页同一份结果。</p>
            <div className="wb-report-tablewrap">
              <table className="wb-report-table">
                <thead>
                  <tr><th>搜索词</th><th>结论</th><th>花费</th><th>销售额</th><th>ACOS</th><th>点击</th><th>订单</th><th>行数</th></tr>
                </thead>
                <tbody>
                  {keywordAnalysis.words.slice(0, 100).map((word) => (
                    <tr key={word.keyword}>
                      <td>{word.keyword}</td>
                      <td><span className="wb-chip is-neutral">{DECISION_LABEL[word.code]}</span></td>
                      <td className="is-num">{money(word.spend)}</td>
                      <td className="is-num">{money(word.sales)}</td>
                      <td className="is-num">{pct(word.acos)}</td>
                      <td className="is-num">{word.clicks}</td>
                      <td className="is-num">{word.orders}</td>
                      <td className="is-num">{word.rowCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {keywordAnalysis.words.length > 100 && <p className="wb-hint">只显示前 100 个词，共 {keywordAnalysis.wordCount.toLocaleString('en-US')} 个。</p>}
          </div>
        </>
      )}

      {analysis !== null && (
        <>
          <div className="wb-stats">
            <div className="wb-stat"><span>{t('花费')}</span><b>{money(analysis.kpi.spend)}</b></div>
            <div className="wb-stat"><span>{t('销售额')}</span><b>{money(analysis.kpi.sales)}</b></div>
            <div className="wb-stat"><span>ACOS</span><b>{pct(analysis.kpi.acos)}</b></div>
            <div className="wb-stat"><span>{t('无单花费占比')}</span><b>{pct(analysis.kpi.wastedSpendShare)}</b></div>
          </div>

          <div className="wb-card">
            <h4><Icon name="trend" size={14} />{t('建议清单')}（{analysis.actions.length}）</h4>
            {analysis.actions.length === 0
              ? <p className="wb-hint">{t('按当前阈值没有需要处理的项——不是没数据，是这批数据没触发规则。')}</p>
              : (
                <div className="wb-report-tablewrap">
                  <table className="wb-report-table">
                    <thead>
                      <tr><th>{t('优先级')}</th><th>{t('主体')}</th><th>{t('广告活动')}</th><th>{t('动作')}</th><th>{t('理由')}</th></tr>
                    </thead>
                    <tbody>
                      {analysis.actions.map((action, index) => (
                        <tr key={`${action.entity}-${action.campaign ?? ''}-${action.code}-${index}`}>
                          <td><span className={`wb-report-prio p${action.priority}`}>P{action.priority}</span></td>
                          <td>{action.entity}</td>
                          <td>{action.campaign ?? '—'}</td>
                          <td><span className="wb-chip">{AD_ACTION_LABELS[action.code]}</span></td>
                          <td className="is-reason">{action.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>

          <div className="wb-card">
            <h4><Icon name="list" size={14} />{t('明细')}（{analysis.rows.length} 行，按花费排序）</h4>
            <div className="wb-report-quadrants">
              {Object.entries(analysis.quadrantCounts).map(([name, count]) => (
                <span key={name} className="wb-chip is-neutral">{name} · {count}</span>
              ))}
            </div>
            <div className="wb-report-tablewrap">
              <table className="wb-report-table">
                <thead>
                  <tr>
                    <th>{t('主体')}</th>
                    {kind === 'impression_share' && <th>{t('份额')}</th>}
                    <th>{t('花费')}</th><th>{t('销售额')}</th><th>ACOS</th>
                    <th>{t('点击')}</th><th>{t('订单')}</th><th>{t('象限')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...analysis.rows].sort((a, b) => b.spend - a.spend).slice(0, 80).map((row) => (
                    <tr key={`${row.keyword}-${row.campaign ?? ''}`}>
                      <td>{row.keyword}</td>
                      {kind === 'impression_share' && <td className="is-num">{pct(row.share ?? null)}</td>}
                      <td className="is-num">{money(row.spend)}</td>
                      <td className="is-num">{money(row.sales)}</td>
                      <td className="is-num">{pct(row.acos)}</td>
                      <td className="is-num">{row.clicks}</td>
                      <td className="is-num">{row.orders}</td>
                      <td><span className="wb-chip is-neutral">{row.quadrant}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
