/**
 * 付款对账（P4）：两份报表贴进来 → 差异清单。
 *
 * 无状态：对账是"这一次"的核对，不需要历史表；结论不落库，
 * 避免"昨天对过的结果今天被当成现状"。
 */
import { useMemo, useState } from 'react'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import { parseRangeReport, parseSettlementReport, reconcilePayments, reconcileToCsv } from '../../shared/paymentReconciliation.js'

const RANGE_SAMPLE = '订单号\t交易类型\t金额\n111-2222222-3333333\tOrder\t29.99\n111-2222222-4444444\tOrder\t49.90'
const SETTLEMENT_SAMPLE = '结算单号\t交易类型\t订单号\t金额\nS-1001\tOrder Payment\t111-2222222-3333333\t29.99\nS-1001\tCost of Advertising\t\t-12.40\nS-1001\tTransfer\t\t17.59'

type Status = { level: 'ok' | 'warn' | 'error'; lines: string[] } | null

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

export function PaymentReconcileView(): JSX.Element {
  const { t } = useI18n()
  const [rangeText, setRangeText] = useState('')
  const [settlementText, setSettlementText] = useState('')
  const [adSpend, setAdSpend] = useState('')
  const [status, setStatus] = useState<Status>(null)

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
      </div>

      <div className="wb-card">
        <h4><Icon name="list" size={14} />{t('日期范围报告')}</h4>
        <p className="wb-hint">{t('列：订单号 / 交易类型 / 金额（订单明细导出）')}</p>
        <textarea className="wb-report-textarea" rows={5} spellCheck={false} value={rangeText}
          placeholder={RANGE_SAMPLE} onChange={(event) => setRangeText(event.target.value)} />
      </div>

      <div className="wb-card">
        <h4><Icon name="list" size={14} />{t('付款/结算报告')}</h4>
        <p className="wb-hint">{t('列：交易类型 / 金额，可选 订单号、结算单号。广告费与回款行没有订单号是正常的。')}</p>
        <textarea className="wb-report-textarea" rows={5} spellCheck={false} value={settlementText}
          placeholder={SETTLEMENT_SAMPLE} onChange={(event) => setSettlementText(event.target.value)} />
        <div className="wb-report-actions">
          <label>{t('本月广告花费（可选）')}
            <input type="number" min={0} value={adSpend} onChange={(event) => setAdSpend(event.target.value)} />
          </label>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="wb-report-status is-error">{errors.map((line, index) => <div key={index}>{line}</div>)}</div>
      )}
      {status !== null && (
        <div className={`wb-report-status is-${status.level}`}>{status.lines.map((line, index) => <div key={index}>{line}</div>)}</div>
      )}

      {result === null && errors.length === 0 && (
        <div className="wb-empty">
          <div className="wb-empty-title">{t('两份报表都贴上来就会自动对账')}</div>
          <div className="wb-empty-desc">{t('只按订单号与交易类型匹配；对不上就列出来，不按金额硬配。')}</div>
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
    </div>
  )
}
