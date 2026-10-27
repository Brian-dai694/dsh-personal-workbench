import { useRef, useState } from 'react'
import { parseTrafficCsv } from '../../shared/amazonTrafficTools.js'
import { WORKBENCH_BUILD_ID } from '../buildId.js'
import { AmazonSopCard } from '../components/AmazonSopCard.js'
import type { UseAmazonDatasetsResult } from '../hooks/useAmazonDatasets.js'

const SAMPLE = '用户搜索词,曝光,点击,广告订单,广告花费,广告销售额\nwelding gloves,1000,32,0,24,0\ntig gloves,800,18,3,14,120\nmig gloves,500,0,0,0,0'

type Status = { level: 'error' | 'warn' | 'ok'; lines: string[] } | null

/**
 * 搜索词页**左栏**（v1.20）：接入表格与数据集选择；分析结果在右侧详情区。
 *
 * v1.20 起支持 Excel：`.xlsx/.xls` 由服务端解析成 TSV 再交给同一套
 * `parseTrafficCsv` 校验；文件字节不会在浏览器中当文本处理。
 * 读文件这一步在 `model.actions.parseUpload` 里（视图不发 HTTP）。
 */
export function AmazonTrafficView({ model }: { model: UseAmazonDatasetsResult }): JSX.Element {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [showPaste, setShowPaste] = useState(true)
  const [reading, setReading] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  /** 统一的"接没接进来"流程：文本 → 校验 → 落库。 */
  async function ingest(rawText: string, sourceCode: string): Promise<void> {
    const parsed = parseTrafficCsv(rawText)
    if (!parsed.ok) {
      setStatus({ level: 'error', lines: [`输入未通过校验：${parsed.errors.join('；')}`] })
      return
    }
    setShowPaste(false)
    const saved = await model.actions.importRows({
      title: `搜索词报表 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      period: parsed.period ?? null,
      rows: parsed.rows,
      sourceCode,
    })
    const lines = [`已接入 ${parsed.rows.length} 行${parsed.period === undefined ? '' : ` · ${parsed.period}`}，结果在右侧`]
    if (parsed.warnings.length > 0) lines.push(`容错提示：${parsed.warnings.join('；')}`)
    if (saved === null) {
      setStatus({ level: 'error', lines: [`解析成功，但保存到工作台失败（${model.error ?? '未知原因'}）—— 右侧读不到这份数据`] })
      return
    }
    setStatus({ level: parsed.warnings.length > 0 ? 'warn' : 'ok', lines })
  }

  function pickFile(file: File | undefined): void {
    if (file === undefined) return
    setReading(`正在解析 ${file.name}…`)
    void (async () => {
      try {
        await ingest(await model.actions.parseUpload(file), file.name)
      } catch (error) {
        setStatus({ level: 'error', lines: [error instanceof Error ? error.message : String(error)] })
      } finally {
        setReading('')
      }
    })()
  }

  const levelClass = status === null ? '' : status.level === 'error' ? 'wb-amazon-warning' : 'wb-amazon-note'

  return (
    <section className="wb-amazon-tools" aria-label="搜索词接入">
      <header className="wb-amazon-heading">
        <div><h2>搜索词分析</h2><p>导入报表 → 右侧看指标与 AI 建议</p></div>
        <div className="wb-amazon-heading-actions">
          <button className="wb-btn" type="button" disabled={reading !== ''} onClick={() => fileRef.current?.click()}>导入文件</button>
          <button className="wb-btn" type="button" onClick={() => setShowPaste((value) => !value)}>{showPaste ? '收起粘贴框' : '粘贴数据'}</button>
          <input ref={fileRef} type="file" hidden tabIndex={-1} aria-hidden="true"
            accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={(event) => { pickFile(event.target.files?.[0]); event.target.value = '' }} />
        </div>
      </header>

      {showPaste && (
        <div className="wb-amazon-import">
          <textarea className="wb-amazon-csv" value={text} onChange={(event) => setText(event.target.value)}
            placeholder={'粘贴报表内容，或直接点「导入文件」选 Excel / CSV\n支持：.xlsx（推荐）、.csv、.tsv；旧版 .xls 请先另存为 .xlsx\n列名：用户搜索词、曝光、点击、广告订单、广告花费、广告销售额'}
            aria-label="粘贴报表内容" />
          <div className="wb-amazon-import-actions">
            <button className="wb-btn primary" type="button" disabled={model.busy || reading !== ''} onClick={() => void ingest(text, 'paste')}>导入数据表</button>
            <button className="wb-btn" type="button" onClick={() => setText(SAMPLE)}>填入示例</button>
          </div>
        </div>
      )}

      {model.staleServer !== null && (
        <div className="wb-amazon-warning" role="alert">
          <div><b>宿主服务端仍是 {model.staleServer}</b>，本页界面已是 {WORKBENCH_BUILD_ID}。</div>
          <div>插件服务端只在桌面端「启动时」加载一次，刷新页面不会更新它 —— 请完全退出桌面端再重新打开，否则导入会返回 404。</div>
        </div>
      )}

      {reading !== '' && <div className="wb-amazon-note" role="status">{reading}</div>}
      {status !== null && levelClass !== '' && (
        <div className={levelClass} role={status.level === 'error' ? 'alert' : 'status'}>
          {status.lines.map((line) => <div key={line}>{line}</div>)}
        </div>
      )}
      {model.error !== null && model.staleServer === null && <div className="wb-amazon-warning" role="alert">保存失败：{model.error}</div>}

      {model.datasets.length > 0 ? (
        <div className="wb-amazon-dataset-list">
          <h3 className="wb-amazon-section-title">已导入的数据表（点一行在右侧查看）</h3>
          {model.datasets.map((item) => (
            <button key={item.id} type="button" className={`wb-amazon-dataset-item ${model.current?.id === item.id ? 'on' : ''}`}
              disabled={model.busy}
              onClick={() => void model.actions.select(item.id)}>
              <span>{item.title}</span>
              <small>{item.period ?? '周期未知'} · {item.rowCount} 行 · 建议 {item.annotationCount} 条</small>
            </button>
          ))}
        </div>
      ) : (
        <div className="wb-amazon-empty">
          <strong>还没有接入数据表</strong>
          <span>点「导入文件」选 Excel / CSV，或把内容粘贴到上面的框里再点「导入数据表」。</span>
        </div>
      )}

      <AmazonSopCard tool="traffic" />
    </section>
  )
}
