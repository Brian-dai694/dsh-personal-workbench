/**
 * 库存补货看板（P3）：期初 + 期间到货 − 期间销量 → 可售天数 / 断货日 / 补货量。
 *
 * ## 与"直接抄一个断货日"的区别
 * - **只存输入**（盘点行 + 统计天数 + 到货天数），结论每次按"今天"现算；
 *   存结论的话，隔天看板上的断货日就是过期的，而且看不出来。
 * - **数据过期就不给断货日**：盘点超过 30 天只给可售天数的相对判断并标黄，
 *   不拿旧盘点抄一个精确日期。
 * - **在途不算库存**：`在途/计划` 只从补货缺口里扣，不参与"当前在手"。
 *
 * ⚠️ 2026-10-27 批次 8：本文件**不再直接发 HTTP**。数据、参数、忙碌与三档状态行
 * 全部搬进 `hooks/useInventory.ts`（`GET`/`POST /api/workbench/inventory` 也在那里），
 * 视图只剩渲染 + 意图 + 文案。派生结论 `analysis` 仍由 hook 用 `useMemo` 现算 —— 不落库。
 *
 * 2026-10-29：按报表页同一口径改造 ——
 * 1. 撤掉「导入盘点」大卡片与粘贴框，入口交给 `AmazonDataSourceBar`；
 * 2. 文件读取走 `actions.ingestFile`（hook 内调 `/parse-file`），`.xlsx` 因此可用；
 * 3. 补货明细可生成 `.univer` 草稿并在本页预览（与「复制补货 CSV」同一个 CSV 口径）。
 */
import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import { AmazonDataSourceBar } from '../components/AmazonDataSourceBar.js'
import { UniverCapabilityHint } from '../components/UniverCapabilityHint.js'
import { UniverPreviewCard } from '../components/UniverPreviewCard.js'
import type { UseInventoryResult } from '../hooks/useInventory.js'
import type { UseUniverCsvTableResult } from '../hooks/useUniverCsvTable.js'

/** `parse-file` 接受的类型：文本类本地读，二进制交给服务端按魔数解析。 */
const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,text/csv,text/tab-separated-values,text/plain,'
  + 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel'

export interface InventoryViewProps {
  /** 库存域模型（数据、参数、派生结论与动作都在里面）。 */
  model: UseInventoryResult
  /** 表格能力域：把补货清单落成 `.univer` 草稿并在本页嵌着看。 */
  table: UseUniverCsvTableResult
}

export function InventoryView(props: InventoryViewProps): JSX.Element {
  const { t } = useI18n()
  const { model, table } = props
  const { snapshot, history, analysis, windowDays, countedAt, leadTimeDays, safetyDays, status, busy, actions } = model

  /** 滚动与草稿说明已收进 `UniverPreviewCard`（2026-10-30），本页不再持有 viewer 状态。 */
  const openInTable = async (): Promise<void> => {
    if (analysis === null) return
    const columns = ['SKU', 'ASIN', '在手', '日均', '可售天数', '断货日', '建议补货', '缺口']
    const rows = analysis.rows.map((row) => [
      row.sku,
      row.asin ?? '',
      row.currentStock,
      row.dailyRate === null ? '' : row.dailyRate,
      row.daysOfCover === null ? '' : row.daysOfCover,
      row.stockoutDate ?? '',
      row.replenishQty === null ? '' : row.replenishQty,
      row.gaps.join(' / '),
    ])
    await table.actions.openTable(columns, rows, '补货清单')
  }

  return (
    <div className="wb-report">
      <div className="wb-amazon-heading">
        <div>
          <h2>{t('库存补货看板')}</h2>
          <p>{t('期初 + 已到仓 − 销量 → 可售天数与补货量；盘点超过 30 天不给断货日，在途不算库存。')}</p>
        </div>
        <button type="button" className="wb-btn" disabled={analysis === null} onClick={() => void actions.copyCsv()}>
          <Icon name="file" size={13} />{t('复制补货 CSV')}
        </button>
        <button
          type="button"
          className="wb-btn primary"
          disabled={analysis === null || table.available === false || table.busy}
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

      <AmazonDataSourceBar
        guide={{
          reportName: t('盘点表'),
          where: t('卖家平台 → 库存 → 库存报告，或你自己的进销存导出'),
          columns: ['SKU', '期初库存', '期间到货', '期间销量', '在途'],
          note: t('表头前可写「统计天数: 30」「盘点日期: 2026-10-01」；CSV / Excel 均可。'),
        }}
        accept={ACCEPT}
        busy={busy}
        latest={history.length > 0 ? `${history[0]!.title}（${history[0]!.rowCount} 个 SKU）` : null}
        onFile={(file) => void actions.ingestFile(file)}
      />

      <div className="wb-card">
        <h4><Icon name="chart" size={14} />{t('测算参数')}</h4>
        <div className="wb-report-rules">
          <label>{t('统计天数')}
            <input type="number" min={1} max={365} value={windowDays} onChange={(event) => actions.setWindowDays(Math.max(1, Number(event.target.value) || 1))} />
          </label>
          <label>{t('盘点日期')}
            <input type="date" value={countedAt} onChange={(event) => actions.setCountedAt(event.target.value)} />
          </label>
          <label>{t('到仓天数')}
            <input type="number" min={0} max={365} value={leadTimeDays} onChange={(event) => actions.setLeadTimeDays(Math.max(0, Number(event.target.value) || 0))} />
          </label>
          <label>{t('安全库存天数')}
            <input type="number" min={0} max={365} value={safetyDays} onChange={(event) => actions.setSafetyDays(Math.max(0, Number(event.target.value) || 0))} />
          </label>
        </div>
        <p className="wb-hint">{t('改参数即时重算；结论不落库，避免隔天还看着「导入那天算的断货日」。')}</p>
      </div>

      {status !== null && (
        <div className={`wb-report-status is-${status.level}`}>
          {status.lines.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}

      {/**
       * 空态（2026-10-29）：原来写"把进销存表粘进来，或在表格里另存为 CSV" ——
       * 粘贴框已按用户要求删除，这句话指向不存在的入口，且把 Excel 用户赶去另存。
       */}
      {snapshot === null && (
        <div className="wb-empty">
          <div className="wb-empty-title">{t('还没有盘点数据')}</div>
          <div className="wb-empty-desc">{t('三步就能出补货结论：')}</div>
          <ol className="wb-hint" style={{ display: 'inline-block', margin: '0 auto', textAlign: 'left', lineHeight: 1.8 }}>
            <li>{t('导出盘点表：至少含 SKU / 期初库存 / 期间到货 / 期间销量，可加「在途」。')}</li>
            <li>{t('点上面的「选择文件」，或把文件拖进虚线框（CSV / Excel 均可）。')}</li>
            <li>{t('解析后上面的参数可继续调，下面直接出「补货明细」；要能加公式的表，再点右上「生成表格并预览」。')}</li>
          </ol>
          <div className="wb-hint">{t('盘点超过 30 天时只给相对判断、不给断货日——用旧盘点算日期比不给更危险。')}</div>
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

      {/**
       * 就地预览：草稿语义与滚动行为都由共用组件负责（2026-10-30 抽出），
       * 本页不再自己写一份 iframe —— 四页各写一份时，文案一定会分叉。
       */}
      <UniverPreviewCard table={table} />
    </div>
  )
}
