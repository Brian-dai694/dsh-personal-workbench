/**
 * 库存补货看板（P3）：期初 + 期间到货 − 期间销量 → 可售天数 / 断货日 / 补货量。
 *
 * ## 与"直接抄一个断货日"的区别
 * - **只存输入**（盘点行 + 统计天数 + 到货天数），结论每次按"今天"现算；
 *   存结论的话，隔天看板上的断货日就是过期的，而且看不出来。
 * - **数据过期就不给断货日**：盘点超过 30 天只给可售天数的相对判断并标黄，
 *   不拿旧盘点抄一个精确日期。
 * - **在途不算库存**：`在途/计划` 只从补货缺口里扣，不参与"当前在手"。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import { analyseInventory, inventoryToCsv, parseInventoryCsv } from '../../shared/inventoryForecast.js'
import type { InventoryRow } from '../../shared/inventoryForecast.js'

interface Snapshot { id: string; title: string; countedAt: string; windowDays: number; leadTimeDays: number; safetyDays: number; rows: InventoryRow[] }
interface Summary { id: string; title: string; countedAt: string; windowDays: number; rowCount: number }

const SAMPLE = 'SKU\t期初库存\t期间到货\t期间销量\t在途\nTIG-CUP-9\t600\t200\t450\t0\nTIG-CUP-20\t120\t0\t300\t200'
const TODAY = new Date().toISOString().slice(0, 10)

type Status = { level: 'ok' | 'warn' | 'error'; lines: string[] } | null

export function InventoryView(): JSX.Element {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [history, setHistory] = useState<Summary[]>([])
  const [windowDays, setWindowDays] = useState(30)
  const [countedAt, setCountedAt] = useState(TODAY)
  const [leadTimeDays, setLeadTimeDays] = useState(30)
  const [safetyDays, setSafetyDays] = useState(15)

  const loadLatest = useCallback(async (): Promise<void> => {
    try {
      const data = await api<{ latest: Snapshot | null; snapshots: Summary[] }>('/api/workbench/inventory')
      setHistory(data.snapshots ?? [])
      setSnapshot(data.latest ?? null)
      if (data.latest !== null) {
        setWindowDays(data.latest.windowDays)
        setCountedAt(data.latest.countedAt.slice(0, 10))
        setLeadTimeDays(data.latest.leadTimeDays)
        setSafetyDays(data.latest.safetyDays)
      }
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    }
  }, [])

  useEffect(() => { void loadLatest() }, [loadLatest])

  const analysis = useMemo(() => {
    if (snapshot === null) return null
    return analyseInventory(snapshot.rows, {
      windowDays,
      countedAt,
      leadTimeDays,
      safetyDays,
      today: new Date(`${TODAY}T00:00:00Z`),
    })
  }, [snapshot, windowDays, countedAt, leadTimeDays, safetyDays])

  const ingest = useCallback(async (raw: string): Promise<void> => {
    const parsed = parseInventoryCsv(raw)
    if (!parsed.ok) {
      setStatus({ level: 'error', lines: [`导入未通过：${parsed.errors.join('；')}`] })
      return
    }
    if (parsed.windowDays !== null) setWindowDays(parsed.windowDays)
    if (parsed.countedAt !== null) setCountedAt(parsed.countedAt)
    setBusy(true)
    try {
      const created = await api<{ snapshot: Snapshot; snapshots: Summary[] }>('/api/workbench/inventory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: `库存盘点 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          countedAt: parsed.countedAt ?? countedAt,
          windowDays: parsed.windowDays ?? windowDays,
          leadTimeDays,
          safetyDays,
          rows: parsed.rows,
        }),
      })
      setSnapshot(created.snapshot)
      setHistory(created.snapshots ?? [])
      setText('')
      const lines = [`已保存 ${parsed.rows.length} 个 SKU 的盘点`]
      if (parsed.warnings.length > 0) lines.push(parsed.warnings.join('；'))
      setStatus({ level: parsed.warnings.length > 0 ? 'warn' : 'ok', lines })
    } catch (error) {
      setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
    } finally {
      setBusy(false)
    }
  }, [countedAt, leadTimeDays, safetyDays, windowDays])

  const copyCsv = async (): Promise<void> => {
    if (analysis === null) return
    try {
      await navigator.clipboard.writeText(inventoryToCsv(analysis.rows))
      setStatus({ level: 'ok', lines: [`已复制 ${analysis.rows.length} 行补货清单（人工确认用，不写任何平台）`] })
    } catch (error) {
      setStatus({ level: 'error', lines: [`复制失败：${error instanceof Error ? error.message : String(error)}`] })
    }
  }

  return (
    <div className="wb-report">
      <div className="wb-amazon-heading">
        <div>
          <h2>{t('库存补货看板')}</h2>
          <p>{t('期初 + 已到仓 − 销量 → 可售天数与补货量；盘点超过 30 天不给断货日，在途不算库存。')}</p>
        </div>
        <button type="button" className="wb-btn" disabled={analysis === null} onClick={() => void copyCsv()}>
          <Icon name="file" size={13} />{t('复制补货 CSV')}
        </button>
      </div>

      <div className="wb-card">
        <h4><Icon name="list" size={14} />{t('导入盘点')}</h4>
        <p className="wb-hint">{t('列：SKU / 期初库存 / 期间到货 / 期间销量（可选 在途、日均目标）。统计天数与盘点日期可在表头前用「统计天数: 30」「盘点日期: 2026-10-01」写。')}</p>
        <div className="wb-report-actions">
          <button type="button" className="wb-btn" disabled={busy || text.trim() === ''} onClick={() => void ingest(text)}>
            {t('解析并保存')}
          </button>
          <label className="wb-btn">
            <Icon name="file" size={13} />{t('选择 CSV / TSV')}
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file !== undefined) {
                  void (async () => {
                    setBusy(true)
                    try { await ingest(await file.text()) } finally { setBusy(false) }
                  })()
                }
                event.currentTarget.value = ''
              }}
            />
          </label>
          {history.length > 0 && <span className="wb-hint" style={{ margin: 0 }}>{t('最近一次：')}{history[0]!.title}（{history[0]!.rowCount} 个 SKU）</span>}
        </div>
        <textarea
          className="wb-report-textarea"
          rows={5}
          value={text}
          spellCheck={false}
          placeholder={SAMPLE}
          onChange={(event) => setText(event.target.value)}
        />
      </div>

      <div className="wb-card">
        <h4><Icon name="chart" size={14} />{t('测算参数')}</h4>
        <div className="wb-report-rules">
          <label>{t('统计天数')}
            <input type="number" min={1} max={365} value={windowDays} onChange={(event) => setWindowDays(Math.max(1, Number(event.target.value) || 1))} />
          </label>
          <label>{t('盘点日期')}
            <input type="date" value={countedAt} onChange={(event) => setCountedAt(event.target.value)} />
          </label>
          <label>{t('到仓天数')}
            <input type="number" min={0} max={365} value={leadTimeDays} onChange={(event) => setLeadTimeDays(Math.max(0, Number(event.target.value) || 0))} />
          </label>
          <label>{t('安全库存天数')}
            <input type="number" min={0} max={365} value={safetyDays} onChange={(event) => setSafetyDays(Math.max(0, Number(event.target.value) || 0))} />
          </label>
        </div>
        <p className="wb-hint">{t('改参数即时重算；结论不落库，避免隔天还看着「导入那天算的断货日」。')}</p>
      </div>

      {status !== null && (
        <div className={`wb-report-status is-${status.level}`}>
          {status.lines.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}

      {snapshot === null && (
        <div className="wb-empty">
          <div className="wb-empty-title">{t('还没有盘点数据')}</div>
          <div className="wb-empty-desc">{t('把进销存表按上面五列粘进来，或在表格里另存为 CSV 后导入。')}</div>
        </div>
      )}

      {analysis !== null && (
        <>
          {analysis.stale && (
            <div className="wb-report-status is-warn">
              {t('盘点日期距今超过 30 天：只给可售天数的相对判断，**不给断货日**——用旧盘点算日期比不给更危险。')}
            </div>
          )}
          <div className="wb-stats">
            <div className="wb-stat"><span>{t('SKU 数')}</span><b>{analysis.kpi.rows}</b></div>
            <div className="wb-stat"><span>{t('需在到仓期内补')}</span><b>{analysis.kpi.urgent}</b></div>
            <div className="wb-stat"><span>{t('已断货/负库存')}</span><b>{analysis.kpi.outOfStock}</b></div>
            <div className="wb-stat"><span>{t('结论有缺口')}</span><b>{analysis.kpi.withGaps}</b></div>
          </div>

          <div className="wb-card">
            <h4><Icon name="list" size={14} />{t('补货明细')}（{analysis.rows.length}）</h4>
            <div className="wb-report-tablewrap">
              <table className="wb-report-table">
                <thead>
                  <tr>
                    <th>SKU</th><th>{t('在手')}</th><th>{t('日均')}</th><th>{t('可售天数')}</th>
                    <th>{t('断货日')}</th><th>{t('建议补货')}</th><th>{t('缺口')}</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.rows.map((row) => (
                    <tr key={row.sku}>
                      <td>{row.sku}{row.asin === null || row.asin === undefined ? '' : ` · ${row.asin}`}</td>
                      <td className={`is-num${row.currentStock <= 0 ? ' is-negative' : ''}`}>{row.currentStock}</td>
                      <td className="is-num">{row.dailyRate ?? '—'}</td>
                      <td className="is-num">{row.daysOfCover ?? '—'}</td>
                      <td className="is-num">{row.stockoutDate ?? t('不给')}</td>
                      <td className="is-num">{row.replenishQty ?? '—'}</td>
                      <td>{row.gaps.length === 0 ? '—' : row.gaps.map((gap) => <span key={gap} className="wb-chip is-neutral">{gap}</span>)}</td>
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
