/**
 * 运营日志 v3：可写（新建/编辑/删除/置顶）+ 类型管理 + 附件上传。
 *
 * 与旧应用对齐：类型（含颜色）、店铺/站点、业务日期、正文、附件、置顶。
 * 不搬：富文本编辑器（工作台用纯文本 + 图片，避免 XSS 面）与提醒（另立项）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import { Modal } from '../components/Modal.js'
import { colorForType, groupEntries } from '../../shared/oplogView.js'
import type { Task } from '../viewTypes.js'

interface OplogDoc { name: string; size: string; type: string; dataUrl?: string }
interface OplogEntry {
  id: string
  logType: string
  title: string
  contentText: string
  asins: string[]
  images: Array<{ mime: string; dataUrl: string }>
  documents: OplogDoc[]
  shopId: string | null
  shopName: string | null
  site: string | null
  typeColor: string
  logDate: string
  createdAt: string
  updatedAt: string
  pinned: boolean
  taskId: string | null
}
interface OplogTask { id: string; title: string; statusCode: string; dueAt: string | null }
interface OplogType { name: string; color: string; sort: number }
interface Facet { value: string; count: number }
interface Facets { types: Facet[]; shops: Facet[]; sites: Facet[]; total: number }
interface Kpi { week: number; month: number; year: number; total: number }

const EMPTY_FACETS: Facets = { types: [], shops: [], sites: [], total: 0 }
const EMPTY_KPI: Kpi = { week: 0, month: 0, year: 0, total: 0 }

function fmtDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface Draft {
  id: string | null
  title: string
  logType: string
  content: string
  shopId: string
  site: string
  logDate: string
  asins: string
  documents: OplogDoc[]
  taskId: string
}

function emptyDraft(types: OplogType[]): Draft {
  return { id: null, title: '', logType: types[0]?.name ?? '其它', content: '', shopId: '', site: '', logDate: fmtDay(new Date().toISOString()), asins: '', documents: [], taskId: '' }
}

export function OpsLogView(props: {
  tasks?: Task[]
  onOpenTask?: (id: string) => void
  onChanged?: () => void
  /**
   * 从日历点「N 条日志」跳过来时带上的那一天（YYYY-MM-DD）。
   * 只作为**初始**筛选值：用户随后可以在工具条里改或清掉。
   */
  focusDate?: string
  /** `focusDate` 变化的版本号：同一天再点一次也要重新生效（否则第二次点击没反应）。 */
  focusSeq?: number
} = {}): JSX.Element {
  const { t } = useI18n()
  const { tasks = [], onOpenTask, onChanged } = props
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const [entries, setEntries] = useState<OplogEntry[]>([])
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS)
  const [kpi, setKpi] = useState<Kpi>(EMPTY_KPI)
  const [types, setTypes] = useState<OplogType[]>([])
  const [taskOptions, setTaskOptions] = useState<OplogTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [type, setType] = useState('')
  const [shop, setShop] = useState('')
  const [site, setSite] = useState('')
  const [keyword, setKeyword] = useState('')
  const [day, setDay] = useState(props.focusDate ?? '')
  const [open, setOpen] = useState<OplogEntry | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [typeOpen, setTypeOpen] = useState(false)
  const [newTypeName, setNewTypeName] = useState('')
  const [newTypeColor, setNewTypeColor] = useState('#007bff')

  /**
   * 日历再点一次"同一天"时把日期重新套上。
   * 依赖 `focusSeq`（每次点击自增）而不是 `focusDate`：否则连点同一天第二次没有反应。
   */
  useEffect(() => {
    if (props.focusDate !== undefined && props.focusDate !== '') setDay(props.focusDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusSeq])

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (type !== '') params.set('type', type)
    if (shop !== '') params.set('shop', shop)
    if (site !== '') params.set('site', site)
    if (day !== '') params.set('date', day)
    if (keyword.trim() !== '') params.set('q', keyword.trim())
    return params.toString()
  }, [type, shop, site, day, keyword])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const [data, typeData] = await Promise.all([
        api<{ entries: OplogEntry[]; facets: Facets; kpi: Kpi; tasks?: OplogTask[] }>(`/api/workbench/oplog${query === '' ? '' : `?${query}`}`),
        api<{ types: OplogType[] }>('/api/workbench/oplog/types'),
      ])
      setEntries(data.entries)
      setTaskOptions(data.tasks ?? [])
      setFacets(data.facets)
      setKpi(data.kpi)
      setTypes(typeData.types)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async (): Promise<void> => {
    if (draft === null) return
    const body = {
      title: draft.title,
      logType: draft.logType,
      content: draft.content,
      shopId: draft.shopId,
      site: draft.site,
      logDate: draft.logDate,
      asins: draft.asins.split(/[\s,，]+/).filter((x) => x.trim() !== ''),
      documents: draft.documents,
      taskId: draft.taskId || null,
    }
    try {
      if (draft.id === null) {
        await api('/api/workbench/oplog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        setNote(t('日志已创建'))
      } else {
        await api(`/api/workbench/oplog/${encodeURIComponent(draft.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        setNote(t('日志已保存'))
      }
      setDraft(null)
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [draft, load, t, onChanged])

  const remove = useCallback(async (entry: OplogEntry): Promise<void> => {
    if (!window.confirm(t('删除这条日志？删除后不可恢复：{title}', { title: entry.title }))) return
    await api(`/api/workbench/oplog/${encodeURIComponent(entry.id)}`, { method: 'DELETE' })
    setOpen(null)
    await load()
    onChanged?.()
  }, [load, t, onChanged])

  const togglePin = useCallback(async (entry: OplogEntry): Promise<void> => {
    await api(`/api/workbench/oplog/${encodeURIComponent(entry.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: !entry.pinned }) })
    await load()
  }, [load])

  const onImport = useCallback(async (file: File): Promise<void> => {
    setNote(''); setError('')
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const result = await api<{ inserted: number; rejected: number; firstReason: string | null; skippedImages: number }>('/api/workbench/oplog/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed),
      })
      setNote(t('已导入 {n} 条', { n: result.inserted }) + (result.rejected > 0 ? t('，跳过 {m} 条', { m: result.rejected }) : ''))
      await load()
      onChanged?.()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [load, t, onChanged])

  const colorByType = useMemo(() => new Map(types.map((x) => [x.name, x.color])), [types])
  const groups = useMemo(() => groupEntries(entries), [entries])

  const pickFiles = (files: FileList): void => {
    const max = Math.min(files.length, 5)
    for (let i = 0; i < max; i += 1) {
      const file = files[i]
      if (file.size > 2 * 1024 * 1024) { setError(t('单个附件不能超过 2MB：{name}', { name: file.name })); continue }
      const reader = new FileReader()
      reader.onload = () => {
        setDraft((prev) => prev === null ? prev : { ...prev, documents: [...prev.documents, { name: file.name, size: `${Math.round(file.size / 1024)}KB`, type: file.type, dataUrl: String(reader.result) }] })
      }
      reader.readAsDataURL(file)
    }
  }

  return (
    <div className="wb-oplog">
      <div className="wb-stats wb-oplog-kpi">
        {([['week', t('本周')], ['month', t('本月')], ['year', t('本年')], ['total', t('总计')]] as Array<[keyof Kpi, string]>).map(([key, label]) => (
          <div key={key} className="wb-stat"><b>{kpi[key]}</b><span>{label}</span></div>
        ))}
      </div>

      <div className="wb-oplog-bar">
        <div className="wb-oplog-types" role="group" aria-label={t('日志类型')}>
          <button type="button" className={`wb-oplog-type${type === '' ? ' on' : ''}`} onClick={() => setType('')}>{t('全部')}<span className="wb-oplog-type-count">{facets.total}</span></button>
          {facets.types.map((facet) => (
            <button key={facet.value} type="button" className={`wb-oplog-type${type === facet.value ? ' on' : ''}`}
              style={{ '--dot': colorByType.get(facet.value) ?? colorForType(facet.value) } as React.CSSProperties}
              onClick={() => setType(type === facet.value ? '' : facet.value)}>
              <i className="wb-oplog-type-dot" aria-hidden="true" />{facet.value}<span className="wb-oplog-type-count">{facet.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="wb-oplog-bar">
        <select className="wb-oplog-select" value={shop} onChange={(e) => setShop(e.target.value)} aria-label={t('店铺')}>
          <option value="">{t('全部店铺')}</option>
          {facets.shops.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
        </select>
        <select className="wb-oplog-select" value={site} onChange={(e) => setSite(e.target.value)} aria-label={t('站点')}>
          <option value="">{t('全部站点')}</option>
          {facets.sites.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
        </select>
        <input className="wb-oplog-search" type="search" value={keyword} placeholder={t('搜索标题或内容')} onChange={(e) => setKeyword(e.target.value)} />
        <label className={`wb-oplog-day${day !== '' ? ' is-on' : ''}`}>
          <Icon name="calendar" size={13} />
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label={t('按业务日期筛选')} />
        </label>
        {day !== '' && <button type="button" className="wb-oplog-card-open" onClick={() => setDay('')}>{t('清除日期')}</button>}
        <button type="button" className="wb-btn primary" onClick={() => { setDraft(emptyDraft(types)); setError('') }}>{t('新建')}</button>
        <button type="button" className="wb-btn" onClick={() => setTypeOpen(true)}>{t('类型')}</button>
        <label className="wb-btn wb-oplog-import"><Icon name="file" size={13} />{t('导入 JSON')}
          <input type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f !== undefined) void onImport(f); e.currentTarget.value = '' }} />
        </label>
      </div>

      {note !== '' && <div className="wb-oplog-note">{note}</div>}
      {error !== '' && <div className="wb-oplog-error">{error}</div>}
      {loading && <div className="wb-skill-hint">{t('读取运营日志…')}</div>}

      {!loading && entries.length === 0 && (
        <div className="wb-empty">
          <div className="wb-empty-title">{t('还没有运营日志')}</div>
          <div className="wb-empty-desc">{t('点「新建」写一条，或用「导入 JSON」把旧应用导出的数据导进来。')}</div>
        </div>
      )}

      {!loading && groups.map((group) => (
        <section key={group.key} className="wb-oplog-group">
          <h4 className="wb-oplog-group-title">{group.label}<span className="wb-oplog-group-count">{group.items.length}</span></h4>
          <div className="wb-oplog-cards">
            {group.items.map((entry) => (
              <article key={entry.id} className={`wb-oplog-card${entry.pinned ? ' is-pinned' : ''}`}>
                <header className="wb-oplog-card-head">
                  <i className="wb-oplog-type-dot" style={{ '--dot': entry.typeColor } as React.CSSProperties} aria-hidden="true" />
                  <span className="wb-oplog-card-type">{entry.logType}</span>
                  <h3 className="wb-oplog-card-title">{entry.title}</h3>
                  <span className="wb-oplog-card-date">{entry.logDate}</span>
                  <button type="button" className="wb-oplog-card-open" onClick={() => void togglePin(entry)}>{entry.pinned ? t('取消置顶') : t('置顶')}</button>
                  <button type="button" className="wb-oplog-card-open" onClick={() => {
                    setDraft({
                      id: entry.id, title: entry.title, logType: entry.logType, content: entry.contentText,
                      shopId: entry.shopId ?? '', site: entry.site ?? '', logDate: entry.logDate,
                      asins: entry.asins.join(' '), documents: entry.documents, taskId: entry.taskId ?? '',
                    })
                  }}>{t('编辑')}</button>
                  <button type="button" className="wb-oplog-card-open" onClick={() => setOpen(entry)}>{t('详情')}</button>
                </header>
                {entry.taskId !== null && taskById.has(entry.taskId) && <button type="button" className="wb-oplog-task-link" onClick={() => { if (entry.taskId) onOpenTask?.(entry.taskId) }}>{t('关联任务')}：{taskById.get(entry.taskId)!.title}</button>}
                {entry.contentText !== '' && <p className="wb-oplog-card-text">{entry.contentText}</p>}
                {entry.images.length > 0 && (
                  <div className="wb-oplog-card-images">
                    {entry.images.map((img, index) => <img key={`${entry.id}-thumb-${index}`} src={img.dataUrl} alt={t('日志截图')} loading="lazy" />)}
                  </div>
                )}
                <footer className="wb-oplog-card-foot">
                  {(entry.shopName !== null || entry.shopId !== null) && <span className="wb-oplog-meta">{entry.shopName ?? entry.shopId}{entry.site !== null ? ` · ${entry.site}` : ''}</span>}
                  {entry.asins.map((asin) => <span key={asin} className="wb-chip">{asin}</span>)}
                  {entry.documents.map((doc) => <span key={doc.name} className="wb-oplog-doc">{doc.name}{doc.size !== '' ? ` · ${doc.size}` : ''}</span>)}
                </footer>
              </article>
            ))}
          </div>
        </section>
      ))}

      {open !== null && (
        <Modal title={<>{open.title}</>} size="lg" onClose={() => setOpen(null)}
          footer={<>
            <button className="wb-btn" type="button" onClick={() => void remove(open)}>{t('删除')}</button>
            <div style={{ flex: 1 }} />
            <button className="wb-btn" type="button" onClick={() => setOpen(null)}>{t('关闭')}</button>
          </>}>
          <div className="wb-oplog-detail-meta">
            <span className="wb-chip">{open.logType}</span>
            {open.shopName !== null && <span className="wb-oplog-meta">{open.shopName}</span>}
            {open.site !== null && <span className="wb-oplog-meta">{open.site}</span>}
            <span className="wb-oplog-meta">{open.logDate}</span>
          </div>
          {open.taskId !== null && (
            taskById.has(open.taskId)
              ? <button type="button" className="wb-oplog-task-link" onClick={() => { const id = open.taskId; setOpen(null); if (id) onOpenTask?.(id) }}>{t('打开关联任务')}：{taskById.get(open.taskId)!.title}</button>
              : <span className="wb-oplog-meta">{t('关联任务已不存在')}</span>
          )}
          {open.contentText !== '' && <div className="wb-oplog-text">{open.contentText}</div>}
          {open.images.length > 0 && (
            <div className="wb-oplog-images">
              {open.images.map((img, index) => <img key={`${open.id}-${index}`} src={img.dataUrl} alt={t('日志截图')} loading="lazy" />)}
            </div>
          )}
          {open.asins.length > 0 && <div className="wb-oplog-asins">{open.asins.map((asin) => <span key={asin} className="wb-chip">{asin}</span>)}</div>}
          {open.documents.length > 0 && (
            <div className="wb-oplog-docs">{open.documents.map((doc) => <span key={doc.name} className="wb-oplog-doc">{doc.name}{doc.size !== '' ? ` · ${doc.size}` : ''}</span>)}</div>
          )}
        </Modal>
      )}

      {draft !== null && (
        <Modal title={<>{draft.id === null ? t('新建日志') : t('编辑日志')}</>} size="md" onClose={() => setDraft(null)}
          footer={<>
            <button className="wb-btn" type="button" onClick={() => setDraft(null)}>{t('取消')}</button>
            <button className="wb-btn primary" type="button" disabled={draft.title.trim() === ''} onClick={() => void save()}>{t('保存')}</button>
          </>}>
          <div className="wb-oplog-form">
            <label className="wb-field"><span>{t('标题')}</span>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={t('这条日志在记什么')} />
            </label>
            <div className="wb-oplog-form-row">
              <label className="wb-field"><span>{t('类型')}</span>
                <select value={draft.logType} onChange={(e) => setDraft({ ...draft, logType: e.target.value })}>
                  {types.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                </select>
              </label>
              <label className="wb-field"><span>{t('日期')}</span>
                <input type="date" value={draft.logDate} onChange={(e) => setDraft({ ...draft, logDate: e.target.value })} />
              </label>
            </div>
            <div className="wb-oplog-form-row">
              <label className="wb-field"><span>{t('店铺')}</span>
                <input value={draft.shopId} onChange={(e) => setDraft({ ...draft, shopId: e.target.value })} placeholder="YOBEL" />
              </label>
              <label className="wb-field"><span>{t('站点')}</span>
                <input value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })} placeholder="US" />
              </label>
            </div>
            <label className="wb-field"><span>{t('关联任务')}</span>
              <select value={draft.taskId} onChange={(e) => setDraft({ ...draft, taskId: e.target.value })}>
                <option value="">{t('不关联任务')}</option>
                {taskOptions.map((task) => <option key={task.id} value={task.id}>{task.title}{task.dueAt ? ` · ${task.dueAt.slice(0, 10)}` : ''}</option>)}
              </select>
            </label>
            <label className="wb-field"><span>{t('正文')}</span>
              <textarea rows={6} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder={t('发生了什么、做了什么、下一步')} />
            </label>
            <label className="wb-field"><span>{t('ASIN（空格或逗号分隔）')}</span>
              <input value={draft.asins} onChange={(e) => setDraft({ ...draft, asins: e.target.value })} placeholder="B0FY5677XC B0FM7GWXYN" />
            </label>
            <div className="wb-field">
              <span>{t('附件')}<span className="wb-field-note">{t('单个 ≤ 2MB，最多 5 个')}</span></span>
              <input type="file" multiple onChange={(e) => { if (e.currentTarget.files !== null) pickFiles(e.currentTarget.files); e.currentTarget.value = '' }} />
              {draft.documents.length > 0 && (
                <div className="wb-oplog-docs">
                  {draft.documents.map((doc, index) => (
                    <span key={`${doc.name}-${index}`} className="wb-oplog-doc">{doc.name} · {doc.size}
                      <button type="button" className="wb-oplog-card-open" onClick={() => setDraft({ ...draft, documents: draft.documents.filter((_, i) => i !== index) })}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {typeOpen && (
        <Modal title={<>{t('类型管理')}</>} size="sm" onClose={() => setTypeOpen(false)}
          footer={<button className="wb-btn" type="button" onClick={() => setTypeOpen(false)}>{t('关闭')}</button>}>
          <div className="wb-oplog-typelist">
            {types.map((x) => (
              <div key={x.name} className="wb-oplog-typerow">
                <i className="wb-oplog-type-dot" style={{ '--dot': x.color } as React.CSSProperties} aria-hidden="true" />
                <span>{x.name}</span>
                <input type="color" value={x.color} onChange={(e) => { void (async () => { await api('/api/workbench/oplog/types', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: x.name, color: e.target.value }) }); await load() })() }} />
                <button type="button" className="wb-oplog-card-open" onClick={() => { void (async () => { await api(`/api/workbench/oplog/types/${encodeURIComponent(x.name)}`, { method: 'DELETE' }); await load() })() }}>{t('删除')}</button>
              </div>
            ))}
          </div>
          <div className="wb-oplog-typerow">
            <input value={newTypeName} onChange={(e) => setNewTypeName(e.target.value)} placeholder={t('新类型名')} />
            <input type="color" value={newTypeColor} onChange={(e) => setNewTypeColor(e.target.value)} />
            <button type="button" className="wb-btn" disabled={newTypeName.trim() === ''} onClick={() => { void (async () => { await api('/api/workbench/oplog/types', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: newTypeName, color: newTypeColor }) }); setNewTypeName(''); await load() })() }}>{t('添加')}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
