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
import { AmazonDataSourceBar } from '../components/AmazonDataSourceBar.js'
import { UniverCapabilityHint } from '../components/UniverCapabilityHint.js'
import { UniverPreviewCard } from '../components/UniverPreviewCard.js'
import { AmazonTrafficDetailPane } from './AmazonTrafficDetailPane.js'
import {
  AD_ACTION_LABELS, DEFAULT_RULES, actionsToCsv, analyseAdReport, parseAdReportCsv,
} from '../../shared/adReport.js'
import type { AdAnalysis, AdReportKind, AdReportRow, RuleConfig } from '../../shared/adReport.js'
import { thresholdsFromSettings } from '../../shared/keywordDecision.js'
import { parseTrafficCsv, analyseTraffic } from '../../shared/amazonTrafficTools.js'
import type { AmazonKeywordThresholds } from '../../shared/contracts.js'
import type { UseUniverCsvTableResult } from '../hooks/useUniverCsvTable.js'
import { buildKeywordAnalysis } from '../keywordAnalysis.js'
import { summariseSliceForCopy, trafficCopyTable } from '../trafficCopy.js'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'
import type { AdReportDatasetSummary, UseAdReportDatasetsResult } from '../hooks/useAdReportDatasets.js'

/**
 * 六种报表的**导入引导**（2026-10-29 改）。
 *
 * 原来这里是 `placeholder` 示例文本，塞进一个 6 行的 textarea 里 —— 那个框已按
 * 用户要求删掉。示例文本本身有价值（它说明了列名），所以改造成结构化引导：
 * 「从哪导 + 要哪几列」，由 `AmazonDataSourceBar` 渲染成可读的引导块。
 */
const KINDS: ReadonlyArray<{
  key: AdReportKind
  label: string
  where: string
  columns: ReadonlyArray<string>
}> = [
  { key: 'search_term', label: '搜索词', where: '亚马逊广告后台 → 广告报告 → 搜索词报告（Search Term Report）', columns: ['客户搜索词', '曝光量', '点击量', '花费', '销售额', '订单'] },
  { key: 'targeting', label: '投放', where: '亚马逊广告后台 → 广告报告 → 投放报告（Targeting Report）', columns: ['投放', '匹配类型', '广告活动名称', '曝光量', '点击量', '花费', '销售额', '订单'] },
  { key: 'campaign', label: '广告活动', where: '亚马逊广告后台 → 广告报告 → 广告活动报告（Campaign Report）', columns: ['广告活动名称', '预算', '曝光量', '点击量', '花费', '销售额', '订单'] },
  { key: 'placement', label: '广告位', where: '亚马逊广告后台 → 广告报告 → 广告位报告（Placement Report）', columns: ['广告位', '广告活动名称', '曝光量', '点击量', '花费', '销售额', '订单'] },
  { key: 'budget', label: '预算', where: '亚马逊广告后台 → 广告报告 → 预算报告（Budget Report）', columns: ['广告活动名称', '预算', '花费', '曝光量', '点击量', '销售额', '订单'] },
  { key: 'impression_share', label: '搜索词份额', where: '亚马逊广告后台 → 广告报告 → 搜索词展示量份额报告（Search Term Impression Share）', columns: ['客户搜索词', '曝光份额', '曝光量', '点击量', '花费', '销售额', '订单'] },
]

type Status = { level: 'ok' | 'warn' | 'error'; lines: string[] } | null

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

export interface AmazonReportViewProps {
  /**
   * 共享数据集模型（T3）：`search_term` 一路的 current / 列表 / 导入都读它，
   * 与流量分析、关键词页是**同一个** `amazonData`。
   */
  amazon: UseAmazonDatasetsResult
  /** 其余 5 种报表的本地状态：请求全在 hook 里（视图不发 HTTP）。 */
  reports: UseAdReportDatasetsResult
  /**
   * 表格能力（并入 CSV 版块）：把当前结论生成 `.univer` 表格并在本页嵌着看。
   *
   * 与「复制 CSV」同一个数据口径 —— 不是第二条导出逻辑，只是把
   * "复制出去粘进 Excel" 换成 "直接得到一张能加公式/图表的真表格"。
   * 生成物是**草稿**：合并/放弃由用户在 Viewer 里点，这里不替用户拍板。
   */
  table: UseUniverCsvTableResult
  /**
   * 搜索词判定阈值（Step 0/2）：账号级设置，`null` = 默认。
   *
   * 必须由装配层传入、两页读同一个值；视图**不许**再自己引用 `KEYWORD_RULES` 做判定。
   */
  thresholds: AmazonKeywordThresholds | null
  /** 把当前搜索词情况交给 AI（由装配层注入会话入口）。 */
  onSendToAI?: (text: string) => void
  /** 跳到关键词页并定位到某个词（由装配层注入导航）。 */
  onOpenKeyword?: (keyword: string) => void
}

export function AmazonReportView({ amazon, reports, table, thresholds, onSendToAI, onOpenKeyword }: AmazonReportViewProps): JSX.Element {
  const { t } = useI18n()
  const [kind, setKind] = useState<AdReportKind>('search_term')
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)
  const [rules, setRules] = useState<RuleConfig>(DEFAULT_RULES)

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
  /** 设置域 → 判定阈值（`null` 走默认）：判定与文案都用这一份，避免两处各算一次。 */
  const keywordThresholds = useMemo(() => thresholdsFromSettings(thresholds), [thresholds])
  const keywordAnalysis = useMemo(
    () => kind === 'search_term' && rows.length > 0
      ? buildKeywordAnalysis(rows, { thresholds: keywordThresholds })
      : null,
    [kind, rows, keywordThresholds],
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
    /**
     * 解析器统一（Step ①，2026-10-29）：**搜索词只有一个解析器** —— `parseTrafficCsv`。
     *
     * 判据是"更宽"而不是"哪页在用"：它能跳过 Reporting Range 之类的元数据行、
     * 在前 6 行里认出表头、引号不闭合时容错重解析、坏行跳过并报数（一坏行不再整份拒绝）。
     * `parseAdReportCsv` 保留给另外五类报表（它们需要投放/活动/广告位这些列）。
     *
     * 代价与保障：`parseTrafficCsv` 现在也会读 campaign / adGroup / matchType，
     * 所以「否词需按投放单元复核」的判断不会因为换解析器而永远为真。
     */
    if (kind === 'search_term') {
      const parsed = parseTrafficCsv(raw)
      if (!parsed.ok) {
        setStatus({ level: 'error', lines: [`导入未通过：${parsed.errors.join('；')}`] })
        return
      }
      setBusy(true)
      try {
        const title = `${kindMeta.label}报表 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
        const saved = await amazon.actions.importRows({
          title,
          period: parsed.period ?? null,
          rows: parsed.rows,
          sourceCode: source,
        })
        if (saved === null) {
          setStatus({ level: 'error', lines: [`解析成功，但保存到工作台失败（${amazon.error ?? '未知原因'}）`] })
          return
        }
        const lines = [`已导入 ${parsed.rows.length} 行${parsed.period === undefined ? '' : ` · ${parsed.period}`}`]
        if (parsed.warnings.length > 0) lines.push(parsed.warnings.join('；'))
        setStatus({ level: parsed.warnings.length > 0 ? 'warn' : 'ok', lines })
      } catch (error) {
        setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
      } finally {
        setBusy(false)
      }
      return
    }

    const parsed = parseAdReportCsv(raw, kind)
    if (!parsed.ok) {
      setStatus({ level: 'error', lines: [`导入未通过：${parsed.errors.join('；')}`] })
      return
    }
    setBusy(true)
    try {
      const title = `${kindMeta.label}报表 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
      const saved = await reports.actions.importRows(kind, { title, period: parsed.period, rows: parsed.rows, sourceCode: source })
      if (saved === null) {
        setStatus({ level: 'error', lines: [`解析成功，但保存到工作台失败（${reports.error ?? '未知原因'}）`] })
        return
      }
      const lines = [`已导入 ${parsed.rows.length} 行${parsed.period === null ? '' : ` · ${parsed.period}`}`]
      if (parsed.warnings.length > 0) lines.push(parsed.warnings.join('；'))
      setStatus({ level: parsed.warnings.length > 0 ? 'warn' : 'ok', lines })
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    } finally {
      setBusy(false)
    }
  }, [kind, kindMeta.label, amazon.actions, amazon.error, reports.actions, reports.error])

  /**
   * 拾到文件 → 读文本 → 解析 → 落库。
   *
   * 2026-10-29：`readFile` 从 `file.text()` 换成 `reports.actions.parseUpload`，
   * 让 `.xlsx` 也能用（原来只有流量页能吃 Excel，同一份报表两页行为不一致）。
   */
  const pickFile = (file: File | undefined): void => {
    if (file === undefined) return
    void (async () => {
      setBusy(true)
      try {
        const parsed = await reports.actions.parseUpload(file)
        await ingest(parsed.text, file.name)
      } catch (error) {
        setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
      } finally {
        setBusy(false)
      }
    })()
  }

  /**
   * 当前结论 → 导出文本（**唯一构造口径**）。
   *
   * 2026-10-29 收尾：搜索词不再有自己那份 8 列 CSV —— 它和右栏「复制结果」
   * 现在用**同一个函数、同一组列、同一套空值写法**（11 列 TSV，`—` 表示无数据）。
   * 同一页两个导出对不上，比少几列更糟：用户会以为其中一份是错的。
   *
   * 行粒度仍是"当前可见行"：报表页这里是全量，右栏是筛选后的子集 —— 那是筛选
   * 功能的语义，不是两套口径。
   */
  const buildCsv = (): { csv: string; count: number } => {
    if (kind === 'search_term') {
      if (amazon.current === null || rows.length === 0) return { csv: '', count: 0 }
      const annotations = new Map(amazon.current.annotations.map((item) => [item.keyword, item]))
      return {
        csv: summariseSliceForCopy(analyseTraffic(rows), annotations),
        count: rows.length,
      }
    }
    if (adAnalysis === null) return { csv: '', count: 0 }
    return { csv: actionsToCsv(adAnalysis.actions, kind), count: adAnalysis.actions.length }
  }

  /**
   * 导出 = **复制 CSV 到剪贴板**（既有口径，保留）。
   *
   * 仓库有两条硬约束：客户端只允许 `MarkdownText` 里出现 `<a>`；
   * 也不允许把数据当成文件下载（避免"看起来导出了、其实没落地"的歧义）。
   * 关键词规划页（`AmazonKeywordView`）已经是"复制 CSV"的口径，这里保持一致：
   * 复制出去可直接粘进 Excel / 广告后台的批量表格。
   */
  const copyCsv = async (): Promise<void> => {
    const { csv, count } = buildCsv()
    if (count === 0) return
    try {
      await navigator.clipboard.writeText(csv)
      setStatus({ level: 'ok', lines: [`已复制 ${count} 条建议到剪贴板（人工确认清单，未修改广告账户）`] })
    } catch (error) {
      setStatus({ level: 'error', lines: [`复制失败：${error instanceof Error ? error.message : String(error)}`] })
    }
  }

  /**
   * 在 Univer 表格里打开当前结论。
   *
   * 为什么补这一条：上面那条导出只到剪贴板，"落地成文件、还能加公式图表"要用户自己完成。
   * 这里把**同一份 CSV** 直接变成 `.univer` 草稿，并在本页嵌着看；合并/放弃仍由用户在
   * Viewer 里点（生成物是草稿，不是已确认版本）。
   */
  const openInTable = async (): Promise<void> => {
    const { csv, count } = buildCsv()
    if (csv === '' || count === 0) {
      setStatus({ level: 'warn', lines: ['当前没有可导出的结论行，先生成分析结果。'] })
      return
    }
    const tableData = kind === 'search_term'
      ? trafficCopyTable(analyseTraffic(rows), new Map(amazon.current!.annotations.map((item) => [item.keyword, item])))
      : (() => {
        const campaignOnly = kind === 'campaign' || kind === 'budget'
        const columns = campaignOnly
          ? ['广告活动', '建议动作', '优先级', '理由']
          : [kind === 'targeting' ? '投放' : '广告位', '广告活动', '建议动作', '优先级', '理由']
        return {
          columns,
          rows: (adAnalysis?.actions ?? []).map((action) => {
            const label = AD_ACTION_LABELS[action.code]
            return campaignOnly
              ? [action.entity, label, action.priority, action.reason]
              : [action.entity, action.campaign ?? '', label, action.priority, action.reason]
          }),
        }
      })()
    await table.actions.openTable(
      tableData.columns,
      tableData.rows,
      kind === 'search_term' ? '搜索词结论' : '广告建议',
    )
  }

  /**
   * 当前数据集（两种来源合成一条：搜索词走共享 `amazon.current`，其余走 `reports.current`）。
   *
   * 2026-10-30 补：`openDataset`（数据集 → `.univer`，服务端带 `univer_file` 复用）
   * 之前只有实现、没有任何按钮触发 —— 流量页左栏退休后那个入口一起没了。
   * 它和上面「生成表格并预览」不是一回事：那条把**结论**做成表，这条把**原始数据**做成表。
   */
  const currentDataset = kind === 'search_term'
    ? (amazon.current === null ? null : { id: amazon.current.id, title: amazon.current.title, rows: amazon.current.rows.length })
    : (reports.current === null ? null : { id: reports.current.id, title: reports.current.title, rows: reports.current.rows.length })

  const switchKind = (next: AdReportKind): void => {
    setKind(next)
    setStatus(null)
  }

  return (
    <div className="wb-report">
      <div className="wb-amazon-heading">
        <div>
          <h2>{t('广告报表分析')}</h2>
          <p>{t('导入后台导出的报表，按同一套规则出「加/否词、提/降价、加/降预算」的人工确认清单；只读分析，不碰账户。')}</p>
        </div>
        {/**
         * 搜索词不再给本页的「复制建议 CSV」：右栏组件自带「复制结果」（11 列 TSV，含筛选）。
         * 两个复制按钮同时存在，就是两个口径并存 —— 宁可少一个按钮。
         * 非搜索词五类报表仍用这一条（8 列结论 CSV）。
         */}
        {kind !== 'search_term' && (
          <button type="button" className="wb-btn" disabled={actionCount === 0} onClick={() => void copyCsv()}>
            <Icon name="file" size={13} />{t('复制建议 CSV')}
          </button>
        )}
        {/**
         * 落地那一半：同一份 CSV → `.univer` 草稿 → 本页嵌着看。
         * 不可用时**禁用并说明原因**（而不是点下去才报错），因为"没装 Univer"
         * 是环境问题，用户看到按钮变灰比看到失败弹窗更容易理解。
         */}
        <button
          type="button"
          className="wb-btn primary"
          /** 搜索词的导出是**全量 11 列**（不再依赖"有几条否词/加词"），所以判据是行数。 */
          disabled={(kind === 'search_term' ? rows.length === 0 : actionCount === 0) || table.available === false || table.busy}
          title={table.available === false ? t('当前 profile 未检测到 dsh-univer-office') : undefined}
          onClick={() => void openInTable()}
        >
          <Icon name="chart" size={13} />{table.busy ? t('生成表格中…') : t('生成表格并预览')}
        </button>
      </div>

      {/* 能力提示（A/D 两态 + 重新检测）由共用组件负责，四页同一句口径。 */}
      <UniverCapabilityHint
        available={table.available}
        contentRead={table.contentRead}
        onRetry={() => void table.actions.refreshAvailability()}
      />

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

      {/**
       * 数据入口（2026-10-29 改）：粘贴框按用户要求彻底删除，只剩拖文件 / 选文件。
       * 引导（从哪导、要哪几列）由 `AmazonDataSourceBar` 统一渲染，六种报表各说各的列。
       */}
      <AmazonDataSourceBar
        guide={{
          reportName: `${kindMeta.label}报表`,
          where: kindMeta.where,
          columns: kindMeta.columns,
          note: 'CSV / Excel 均可；表头保持首行。',
        }}
        accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        busy={busy}
        latest={history.length > 0 ? `${history[0]!.title}（${history[0]!.rowCount} 行）` : null}
        onFile={pickFile}
      />

      {/**
       * 当前数据集 → 原始数据表。与上面「生成表格并预览」分工：
       * 这里给的是**导入的那份数据本身**（服务端会记住 `univer_file`，
       * 文件还在就复用，不会每点一次多一份草稿）；上面给的是**分析结论**。
       */}
      {currentDataset !== null && (
        <div className="wb-amazon-dataset-bar">
          <div>
            <strong>{currentDataset.title}</strong>
            <span>{currentDataset.rows.toLocaleString('en-US')} 行 · {kindMeta.label}</span>
          </div>
          <div className="wb-amazon-dataset-actions">
            <button
              type="button"
              className="wb-btn"
              disabled={table.busy || table.available === false}
              title={table.available === false ? t('当前 profile 未检测到 dsh-univer-office') : t('把这份原始数据做成表格打开（已生成过就复用，不会重复生成）')}
              onClick={() => void table.actions.openDataset(currentDataset.id)}
            ><Icon name="table" size={13} />{table.busy ? t('打开中…') : t('原始数据在表格里打开')}</button>
          </div>
        </div>
      )}

      {status !== null && (
        <div className={`wb-report-status is-${status.level}`}>
          {status.lines.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}

      <div className="wb-card">
        <h4><Icon name="chart" size={14} />{t('规则阈值')}</h4>
        {kind === 'search_term' ? (
          <p className="wb-hint">
            {t('搜索词统一口径（与流量分析、关键词页同一份）：点击 ≥ {c} 且 0 单 = 否定；订单 ≥ {o} 且 ACOS ≤ {a}% = 加词。在「设置 → 搜索词阈值」里修改，改完两页同时生效。', {
              c: keywordThresholds.negativeMinClicks,
              o: keywordThresholds.addMinOrders,
              a: Math.round(keywordThresholds.addMaxAcos * 100),
            })}
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

      {/**
       * 没数据时的引导（2026-10-29）：原来只有一句"粘贴到上面或选文件导入"，
       * 而粘贴框已经删了，那句话指向不存在的入口 —— 空态等于死路。
       * 现在三步都指向**页面上真实存在的控件**，不写没有的按钮。
       */}
      {rows.length === 0 && (
        <div className="wb-empty">
          <div className="wb-empty-title">{t('还没有 {k} 报表', { k: kindMeta.label })}</div>
          <div className="wb-empty-desc">{t('三步就能出结论：')}</div>
          <ol className="wb-hint" style={{ display: 'inline-block', margin: '0 auto', textAlign: 'left', lineHeight: 1.8 }}>
            <li>{t('在亚马逊广告后台导出这张报表：')}{kindMeta.where}{t('（CSV / Excel 均可）。')}</li>
            <li>{t('点上面的「选择文件」，或把文件拖进虚线框。')}</li>
            <li>{t('解析完成后本页直接给出「词级分析」与指标表；要一张能加公式、图表的表，再点右上「生成表格并预览」。')}</li>
          </ol>
          <div className="wb-hint">
            {t('每导入一次会新建一张表（文件名带时间戳），不会覆盖上一张。')}
          </div>
        </div>
      )}

      {/**
       * 搜索词右栏（Step ③，2026-10-29）：**直接复用 `AmazonTrafficDetailPane`**，
       * 不是把它的 JSX 复制过来。这样筛选预设、ABA 分层、AI 报表结论、
       * 11 列指标表与「复制结果」都只有一份实现，"两页一致"是结构保证而不是靠自觉。
       *
       * 本页原先的 KPI 条、词级块、「明细」100 行表在这里一并撤掉 ——
       * 它们要么被组件覆盖（指标/分层/表格），要么就是重复的第二套口径。
       * 只在**有当前数据集**时渲染：没数据时上面的三步引导负责说话，
       * 否则会出现两个空态。
       */}
      {kind === 'search_term' && amazon.current !== null && (
        <AmazonTrafficDetailPane
          model={amazon}
          thresholds={thresholds}
          onSendToAI={onSendToAI}
          onOpenKeyword={onOpenKeyword}
        />
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

      {/**
       * 生成后的就地预览：草稿语义、iframe 与滚动都由共用组件负责（2026-10-30）。
       * 四页各写一份时，改一句「提交待审阅」要改四处，漏一处就两页说法不同。
       */}
      <UniverPreviewCard table={table} />
    </div>
  )
}
