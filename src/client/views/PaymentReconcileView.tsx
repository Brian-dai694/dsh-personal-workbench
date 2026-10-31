/**
 * 付款对账（P4）：两份报表 → 差异清单。
 *
 * 无状态：对账是"这一次"的核对，不需要历史表；结论不落库，
 * 避免"昨天对过的结果今天被当成现状"。
 *
 * 2026-10-29（第 3 项）：
 * - 两份报表各一行**紧凑入口**（选文件 / 折叠粘贴），不是两个大卡片；
 * - 文件走 `usePaymentReconcile.parseFile`（服务端按魔数解析，`.xlsx` 可用）；
 * - `sheetCount > 1` 时明确提示"只导入了「哪张」"—— 付款报表最容易多工作表，
 *   静默取第一张会让人拿着错的数去对账；
 * - 超限文案与后端一致（源文件约 7.5MB）：客户端先按大小预判一次，
 *   省掉一次必然失败的上传；最终仍以服务端 413 为准；
 * - 差异结论可生成 `.univer` 草稿并在本页预览（草稿语义，不合并）。
 */
import { useMemo, useState } from 'react'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import { UniverCapabilityHint } from '../components/UniverCapabilityHint.js'
import { UniverPreviewCard } from '../components/UniverPreviewCard.js'
import { parseRangeReport, parseSettlementReport, reconcilePayments, reconcileToCsv } from '../../shared/paymentReconciliation.js'
import { usePaymentReconcile } from '../hooks/usePaymentReconcile.js'
import type { UseUniverCsvTableResult } from '../hooks/useUniverCsvTable.js'

const RANGE_SAMPLE = '订单号\t交易类型\t金额\n111-2222222-3333333\tOrder\t29.99\n111-2222222-4444444\tOrder\t49.90'
const SETTLEMENT_SAMPLE = '结算单号\t交易类型\t订单号\t金额\nS-1001\tOrder Payment\t111-2222222-3333333\t29.99\nS-1001\tCost of Advertising\t\t-12.40\nS-1001\tTransfer\t\t17.59'

/** 与服务端同一句话：超过这个量级就不该再传。 */
const TOO_LARGE_BYTES = 7.5 * 1024 * 1024
const TOO_LARGE_MESSAGE = '文件超过约 7.5MB，请先按月份筛选或拆分后再导入'

type Status = { level: 'ok' | 'warn' | 'error'; lines: string[] } | null

type Side = 'range' | 'settlement'

interface FileMeta {
  name: string
  sheetCount: number
  sheetName: string
  format: string
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

export interface PaymentReconcileViewProps {
  /** 表格能力域：把差异结论落成 `.univer` 草稿并在本页预览。 */
  table: UseUniverCsvTableResult
}

export function PaymentReconcileView({ table }: PaymentReconcileViewProps): JSX.Element {
  const { t } = useI18n()
  const uploads = usePaymentReconcile()
  const [rangeText, setRangeText] = useState('')
  const [settlementText, setSettlementText] = useState('')
  const [adSpend, setAdSpend] = useState('')
  const [status, setStatus] = useState<Status>(null)
  /** 每侧文件元信息：只有从文件来的才有（手贴的没有"工作表"这回事）。 */
  const [meta, setMeta] = useState<Record<Side, FileMeta | null>>({ range: null, settlement: null })
  /** 折叠粘贴：默认收起（主路径是选文件），用户点了才展开。 */
  const [pasteOpen, setPasteOpen] = useState<Record<Side, boolean>>({ range: false, settlement: false })

  const parsedRange = useMemo(() => (rangeText.trim() === '' ? null : parseRangeReport(rangeText)), [rangeText])
  const parsedSettlement = useMemo(() => (settlementText.trim() === '' ? null : parseSettlementReport(settlementText)), [settlementText])

  const result = useMemo(() => {
    if (parsedRange === null || parsedSettlement === null) return null
    if (!parsedRange.ok || !parsedSettlement.ok) return null
    const declared = adSpend.trim() === '' ? null : Number(adSpend)
    return reconcilePayments({
      rangeOrders: parsedRange.rows,
      settlementLines: parsedSettlement.rows,
      adSpendDeclared: Number.isFinite(declared) ? declared : null,
    })
  }, [parsedRange, parsedSettlement, adSpend])

  const copyDiff = async (): Promise<void> => {
    if (result === null) return
    try {
      await navigator.clipboard.writeText(reconcileToCsv(result))
      setStatus({ level: 'ok', lines: [`已复制 ${result.unsettledOrders.length + result.missingFromRangeOrders.length} 条差异（人工确认用）`] })
    } catch (error) {
      setStatus({ level: 'error', lines: [`复制失败：${error instanceof Error ? error.message : String(error)}`] })
    }
  }

  /**
   * 差异清单 → 表格（统一出口 `table-preview`，2026-10-30）。
   *
   * 用**结构化行**而不是先拼 CSV：列名与单元格由服务端校验（行数/列数/体积上限），
   * 前端不再各写一套转义规则。`复制差异 CSV` 仍保留，两者同一份 `result`。
   */
  const openInTable = async (): Promise<void> => {
    if (result === null) {
      setStatus({ level: 'warn', lines: ['还没有对账结果：两份报表都到齐才会出差异清单。'] })
      return
    }
    const rows: Array<Array<string | number | null>> = [
      ...result.unsettledOrders.map((order) => [order.orderId, order.amount, order.kind, '未结算', null]),
      ...result.missingFromRangeOrders.map((order) => [order.orderId, order.amount, null, '结算有、范围无', order.settlementId ?? null]),
    ]
    await table.actions.openTable(
      ['订单号', '金额', '类型', '差异类型', '结算单号'],
      rows,
      '付款对账差异',
    )
  }

  /** 文件 → 文本。超限在客户端先拦一次（同一句话），其余错误原样显示。 */
  const pickFile = async (side: Side, file: File | undefined): Promise<void> => {
    if (file === undefined) return
    if (file.size > TOO_LARGE_BYTES) {
      setStatus({ level: 'error', lines: [TOO_LARGE_MESSAGE] })
      return
    }
    try {
      const parsed = await uploads.actions.parseFile(file)
      if (side === 'range') setRangeText(parsed.text)
      else setSettlementText(parsed.text)
      setMeta((prev) => ({
        ...prev,
        [side]: { name: file.name, sheetCount: parsed.sheetCount, sheetName: parsed.sheetName, format: parsed.format },
      }))
      const lines = [`已读取 ${file.name}`]
      if (parsed.sheetCount > 1) {
        lines.push(t('这份文件有 {n} 个工作表，只导入了「{s}」——其余表未参与对账，需要的话请先另存单独的工作表。', {
          n: parsed.sheetCount,
          s: parsed.sheetName === '' ? t('第一张') : parsed.sheetName,
        }))
      }
      setStatus({ level: parsed.sheetCount > 1 ? 'warn' : 'ok', lines })
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    }
  }

  const renderSide = (
    side: Side,
    title: string,
    hint: string,
    placeholder: string,
    rows: number,
    setter: (value: string) => void,
  ): JSX.Element => {
    const info = meta[side]
    return (
      <div className="wb-report-actions" key={side}>
        <b style={{ minWidth: 96 }}>{title}</b>
        <label className="wb-btn">
          <Icon name="file" size={13} />{t('选择文件')}
          <input
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              void pickFile(side, file)
              event.currentTarget.value = ''
            }}
          />
        </label>
        <button
          type="button"
          className="wb-btn"
          aria-expanded={pasteOpen[side]}
          onClick={() => setPasteOpen((prev) => ({ ...prev, [side]: !prev[side] }))}
        >{pasteOpen[side] ? t('收起粘贴') : t('粘贴')}</button>
        <span className="wb-hint" style={{ margin: 0 }}>
          {info === null
            ? (rows === 0 ? t('未导入') : t('已粘贴 {n} 行', { n: rows }))
            : `${info.name} · ${info.sheetCount > 1
              ? t('{n} 张表中取「{s}」', { n: info.sheetCount, s: info.sheetName === '' ? t('第一张') : info.sheetName })
              : t('单表')} · ${t('已解析 {n} 行', { n: rows })}`}
        </span>
        {pasteOpen[side] && (
          <div style={{ flexBasis: '100%' }}>
            <p className="wb-hint">{hint}</p>
            <textarea
              className="wb-report-textarea"
              rows={5}
              spellCheck={false}
              value={side === 'range' ? rangeText : settlementText}
              placeholder={placeholder}
              onChange={(event) => {
                setter(event.target.value)
                setMeta((prev) => ({ ...prev, [side]: null }))
              }}
            />
          </div>
        )}
      </div>
    )
  }

  const errors = [
    ...(parsedRange !== null && !parsedRange.ok ? parsedRange.errors.map((line) => `日期范围报告：${line}`) : []),
    ...(parsedSettlement !== null && !parsedSettlement.ok ? parsedSettlement.errors.map((line) => `结算报告：${line}`) : []),
  ]

  return (
    <div className="wb-report">
      <div className="wb-amazon-heading">
        <div>
          <h2>{t('付款对账')}</h2>
          <p>{t('日期范围报告 vs 付款/结算报告：列出未结算订单、结算里有但范围里没有的订单，并单独核对代扣广告费。')}</p>
        </div>
        <button type="button" className="wb-btn" disabled={result === null} onClick={() => void copyDiff()}>
          <Icon name="file" size={13} />{t('复制差异 CSV')}
        </button>
        <button
          type="button"
          className="wb-btn primary"
          disabled={result === null || table.available === false || table.busy}
          title={table.available === false ? t('当前 profile 未检测到 dsh-univer-office') : undefined}
          onClick={() => void openInTable()}
        >
          <Icon name="chart" size={13} />{table.busy ? t('生成表格中…') : t('生成表格并预览')}
        </button>
      </div>

      <UniverCapabilityHint
        available={table.available}
        contentRead={table.contentRead}
        onRetry={() => void table.actions.refreshAvailability()}
      />

      {renderSide('range', t('日期范围报告'), t('列：订单号 / 交易类型 / 金额（订单明细导出）'), RANGE_SAMPLE, parsedRange?.rows.length ?? 0, setRangeText)}
      {renderSide('settlement', t('付款/结算报告'), t('列：交易类型 / 金额，可选 订单号、结算单号。广告费与回款行没有订单号是正常的。'), SETTLEMENT_SAMPLE, parsedSettlement?.rows.length ?? 0, setSettlementText)}

      <div className="wb-report-actions">
        <label>{t('本月广告花费（可选）')}
          <input type="number" min={0} value={adSpend} onChange={(event) => setAdSpend(event.target.value)} />
        </label>
      </div>

      {errors.length > 0 && (
        <div className="wb-report-status is-error">{errors.map((line, index) => <div key={index}>{line}</div>)}</div>
      )}
      {status !== null && (
        <div className={`wb-report-status is-${status.level}`}>{status.lines.map((line, index) => <div key={index}>{line}</div>)}</div>
      )}

      {result === null && errors.length === 0 && (
        <div className="wb-empty">
          <div className="wb-empty-title">{t('两份报表都到齐就会自动对账')}</div>
          <div className="wb-empty-desc">
            {t('上方两行各选一个文件即可；也可以点「粘贴」手工贴两份小表。只按订单号与交易类型匹配，对不上就列出来，不按金额硬配。')}
          </div>
        </div>
      )}

      {result !== null && (
        <>
          <div className="wb-stats">
            <div className="wb-stat"><span>{t('日期范围订单')}</span><b>{result.kpi.rangeOrders}</b></div>
            <div className="wb-stat"><span>{t('已结算订单')}</span><b>{result.kpi.settledOrders}</b></div>
            <div className="wb-stat"><span>{t('未结算')}</span><b>{result.kpi.unsettled}</b></div>
            <div className="wb-stat"><span>{t('结算里有、范围无')}</span><b>{result.kpi.missingFromRange}</b></div>
          </div>

          <div className="wb-card">
            <h4><Icon name="chart" size={14} />{t('金额核对')}</h4>
            <table className="wb-report-table">
              <tbody>
                <tr><td>{t('日期范围合计')}</td><td className="is-num">{money(result.kpi.rangeTotal)}</td></tr>
                <tr><td>{t('结算合计')}</td><td className="is-num">{money(result.kpi.settlementTotal)}</td></tr>
                <tr><td>{t('其中代扣广告费')}</td><td className="is-num">{money(result.kpi.adFeeInSettlement)}</td></tr>
                <tr><td>{t('其中回款')}</td><td className="is-num">{money(result.kpi.transferTotal)}</td></tr>
                <tr><td>{t('分类差额（应接近 0）')}</td><td className="is-num">{money(result.kpi.residual)}</td></tr>
                <tr><td>{t('广告费口径差异')}</td><td className="is-num">{result.adSpendDiff === null ? '—' : money(result.adSpendDiff)}</td></tr>
              </tbody>
            </table>
          </div>

          {result.warnings.length > 0 && (
            <div className="wb-report-status is-warn">{result.warnings.map((line, index) => <div key={index}>{line}</div>)}</div>
          )}

          <div className="wb-card">
            <h4><Icon name="list" size={14} />{t('未结算订单')}（{result.unsettledOrders.length}）</h4>
            {result.unsettledOrders.length === 0
              ? <p className="wb-hint">{t('没有未结算订单。')}</p>
              : (
                <table className="wb-report-table">
                  <thead><tr><th>{t('订单号')}</th><th>{t('金额')}</th><th>{t('类型')}</th></tr></thead>
                  <tbody>
                    {result.unsettledOrders.map((order) => (
                      <tr key={order.orderId}><td>{order.orderId}</td><td className="is-num">{money(order.amount)}</td><td>{order.kind}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>

          <div className="wb-card">
            <h4><Icon name="list" size={14} />{t('结算里有、日期范围没有')}（{result.missingFromRangeOrders.length}）</h4>
            {result.missingFromRangeOrders.length === 0
              ? <p className="wb-hint">{t('没有这类订单。')}</p>
              : (
                <table className="wb-report-table">
                  <thead><tr><th>{t('订单号')}</th><th>{t('金额')}</th><th>{t('结算单号')}</th></tr></thead>
                  <tbody>
                    {result.missingFromRangeOrders.map((order) => (
                      <tr key={order.orderId}><td>{order.orderId}</td><td className="is-num">{money(order.amount)}</td><td>{order.settlementId ?? '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </>
      )}

      <UniverPreviewCard table={table} />
    </div>
  )
}
