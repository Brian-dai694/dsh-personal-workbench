/**
 * 亚马逊版块的**唯一数据入口**（2026-10-29，用户要求「导入导出表格这个大框不要了」）。
 *
 * ## 为什么删掉粘贴框
 *
 * 原来流量分析左栏和报表分析页各有一个常驻的大 textarea：占掉首屏，却没说清
 * 「该导哪张报表、从后台哪里导、要哪几列」。用户看到的只是两个空框，
 * 于是反复粘同一份报表（线上库里有 3 份同一天、同为 1243 行的重复数据集）。
 *
 * 现在入口只剩一条：**拖文件 / 选文件**，旁边把报表名、后台位置、必需列讲清楚。
 * 粘贴这条路已按用户决定移除，不再保留「高级」折叠。
 *
 * ## 边界
 *
 * 本组件只做展示与文件拾取：**不发 HTTP、不解析、不落库**。
 * 解析与保存由调用方（视图 → hook）负责 —— `test/clientInvariants` 有这条硬门。
 *
 * 模板用「复制表头到剪贴板」而不是生成下载文件：仓库既有口径是
 * 「不把数据伪装成文件下载」（复制 CSV 那条注释写着原因），模板是固定表头、
 * 不是用户数据，走剪贴板既满足引导又不新开一条下载路径。
 */
import { useRef, useState } from 'react'
import { Icon } from './Icon.js'

export interface DataSourceGuide {
  /** 这张报表叫什么，例如「搜索词报表」。 */
  readonly reportName: string
  /** 从后台哪里导，一句话说清路径。 */
  readonly where: string
  /** 必须包含的列名（顺序即模板表头顺序）。 */
  readonly columns: ReadonlyArray<string>
  /** 额外提醒（例如「.xls 要先另存为 .xlsx」）。 */
  readonly note?: string
}

export interface AmazonDataSourceBarProps {
  readonly guide: DataSourceGuide
  /** 允许的文件后缀串，直接给 `<input accept>`。 */
  readonly accept: string
  readonly busy: boolean
  /** 拾到文件后交给调用方解析；本组件不碰内容。 */
  readonly onFile: (file: File) => void
  /** 最近一份数据集的说明（可选，给人一个「已经导过了」的锚点）。 */
  readonly latest?: string | null
}

export function AmazonDataSourceBar(props: AmazonDataSourceBarProps): JSX.Element {
  const { guide, accept, busy, onFile, latest } = props
  const [over, setOver] = useState(false)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  function take(files: FileList | null): void {
    const file = files?.[0]
    if (file === undefined || busy) return
    onFile(file)
  }

  async function copyTemplate(): Promise<void> {
    try {
      await navigator.clipboard.writeText(guide.columns.join(','))
      setCopied(true)
      globalThis.setTimeout(() => setCopied(false), 1800)
    } catch {
      /** 剪贴板被拒（无权限/非安全上下文）时保持原样，不假装成功。 */
      setCopied(false)
    }
  }

  return (
    <div className="wb-datasource">
      <div
        className={`wb-datasource-drop${over ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
        onDragOver={(event) => { event.preventDefault(); if (!busy) setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => { event.preventDefault(); setOver(false); take(event.dataTransfer.files) }}
      >
        <span className="wb-datasource-icon"><Icon name="upload" size={20} /></span>
        <div className="wb-datasource-copy">
          <strong>{guide.reportName}</strong>
          <span>{over ? '松手就导入' : busy ? '正在解析…' : '把报表文件拖到这里'}</span>
        </div>
        <div className="wb-datasource-actions">
          <button
            type="button"
            className="wb-btn primary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          ><Icon name="file" size={13} />{busy ? '解析中…' : '选择文件'}</button>
          <button type="button" className="wb-btn" disabled={busy} onClick={() => void copyTemplate()}>
            <Icon name="table" size={13} />{copied ? '表头已复制' : '复制模板表头'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => { take(event.currentTarget.files); event.currentTarget.value = '' }}
          />
        </div>
      </div>

      <div className="wb-datasource-guide">
        <div>
          <b><Icon name="folder" size={12} />从哪导</b>
          <span>{guide.where}</span>
        </div>
        <div>
          <b><Icon name="list" size={12} />要哪几列</b>
          <span className="wb-datasource-cols">
            {guide.columns.map((column) => <span key={column} className="wb-amazon-pill">{column}</span>)}
          </span>
        </div>
        {guide.note !== undefined && (
          <div>
            <b><Icon name="check" size={12} />注意</b>
            <span>{guide.note}</span>
          </div>
        )}
        {latest !== undefined && latest !== null && latest !== '' && (
          <div>
            <b><Icon name="archive" size={12} />最近一份</b>
            <span>{latest}</span>
          </div>
        )}
      </div>
    </div>
  )
}
