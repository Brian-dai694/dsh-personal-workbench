/**
 * 产品库（v1.19 重做）：独立产品事实表的**可维护**视图。
 *
 * ## 与「选品」的分工
 *
 * - 产品库回答"这个商品是什么"：站点 / ASIN / 标题 / 价格 / 店铺 / 类目 / 更新时间；
 * - 选品回答"我这次怎么判它"：结论、评分、VOC、下一步（都在 `asin_products`）。
 *
 * 两张表**互不写入**：本页的录入/编辑/删除只碰 `products`，判断字段在这里连投影都不带。
 *
 * ## 这一版为什么改了布局
 *
 * 旧版只有"编辑"、空库时没有任何入口 —— 用户打开页面看到的是"去选品页收藏"，
 * 而选品页并不产出产品库的数据。现在：
 *
 * 1. 标题栏给**手动录入**（主按钮），空态再给一次 CTA（两条路都能开始）；
 * 2. 顶部一行统计（产品/站点/店铺/类目）回答"我现在有多少东西"；
 * 3. 工具栏顺序固定为「搜索 → 站点 → 店铺 → 类目 → 清空」，与选品页同一套控件；
 * 4. 行内操作常显（编辑/删除），不再靠 hover 才发现（触屏没有 hover）；
 * 5. 分页带上区间与每页条数，和选品页口径一致。
 */
import { useState } from 'react'
import { useI18n } from '../i18n.js'
import { Icon } from '../components/Icon.js'
import { Modal } from '../components/Modal.js'
import { ProductFactForm } from '../components/ProductFactForm.js'
import { UniverCapabilityHint } from '../components/UniverCapabilityHint.js'
import { UniverPreviewCard } from '../components/UniverPreviewCard.js'
import { useProductLibrary } from '../hooks/useProductLibrary.js'
import type { ProductFact, ProductLibraryFocus } from '../hooks/useProductLibrary.js'
import type { UseUniverCsvTableResult } from '../hooks/useUniverCsvTable.js'
import { emptyProductFactDraft, productFactDraftOf, type ProductFactDraft } from '../productFactDraft.js'

/**
 * 导出列 7 列：与产品库能维护的事实字段一一对应（站点/ASIN/标题/价格/店铺/类目/更新时间）。
 * 界面上店铺与类目挤在标题下面是为了省宽，导出不必省 —— 导出的表是要被透视和筛选的。
 */
const EXPORT_HEADER = ['站点', 'ASIN', '标题', '价格', '店铺', '类目', '更新时间'] as const

const PAGE_SIZES = [25, 50, 100] as const

/** 结构化行交给 `table-preview`：列名/单元格上限由服务端校验，前端不拼 CSV。 */
function toRows(rows: ReadonlyArray<ProductFact>): Array<Array<string | number | null>> {
  return rows.map((row) => [
    row.site ?? '—',
    row.asin,
    row.title === '' ? '—' : row.title,
    row.price === null ? '—' : row.price,
    row.shopName ?? '—',
    row.category ?? '—',
    day(row.updatedAt),
  ])
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

function day(value: string): string {
  if (value === '') return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 弹框状态：新建与编辑共用一份草稿（只有身份字段的可编辑性不同）。 */
interface FormState {
  mode: 'create' | 'edit'
  /** 编辑时的目标行（新建为 null）。 */
  target: ProductFact | null
  value: ProductFactDraft
}

export interface ProductLibraryViewProps {
  /** 表格能力域：把当前筛选结果变成 `.univer` 草稿并预览。 */
  table: UseUniverCsvTableResult
  /** 从选品页跳过来的定位意图（`q + site` 成对）。 */
  focus?: ProductLibraryFocus
}

export function ProductLibraryView({ table, focus }: ProductLibraryViewProps): JSX.Element {
  const { t } = useI18n()
  const model = useProductLibrary(focus)
  const { items, total, facets, filter, loading, busy, error, actions } = model
  const [exporting, setExporting] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ProductFact | null>(null)
  const [deleteError, setDeleteError] = useState('')

  const filtered = filter.site !== '' || filter.shop !== '' || filter.category !== '' || filter.q.trim() !== ''
  const totalPages = Math.max(1, Math.ceil(total / filter.size))
  const from = total === 0 ? 0 : (filter.page - 1) * filter.size + 1
  const to = Math.min(filter.page * filter.size, total)

  const openCreate = (prefill?: Partial<ProductFactDraft>): void => {
    setFormError('')
    setForm({ mode: 'create', target: null, value: { ...emptyProductFactDraft(), ...prefill } })
  }

  const openEdit = (row: ProductFact): void => {
    setFormError('')
    setForm({ mode: 'edit', target: row, value: productFactDraftOf(row) })
  }

  const submit = async (): Promise<void> => {
    if (form === null) return
    setFormError('')
    try {
      if (form.mode === 'create') await actions.create(form.value)
      else if (form.target !== null) await actions.update(form.target, form.value)
      setForm(null)
    } catch (e) {
      /** 服务端文案可读（重复键 / 校验失败），原样留在弹框里，不做二次包装。 */
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return
    setDeleteError('')
    try {
      await actions.remove(pendingDelete)
      setPendingDelete(null)
      /**
       * 删掉的是本页最后一条而且不在第一页 → 回退一页。
       * 否则会停在一个空页上，看起来像"删除把整页数据删没了"。
       */
      if (items.length === 1 && filter.page > 1) actions.setFilter({ page: filter.page - 1 })
    } catch (e) {
      /** 失败留在删除弹框里：关掉弹框再报错，用户会不知道刚才那一下到底删没删。 */
      setDeleteError(e instanceof Error ? e.message : String(e))
    }
  }

  const openInTable = async (): Promise<void> => {
    setExporting(true)
    try {
      const rows = await actions.fetchAll()
      if (rows.length === 0) return
      await table.actions.openTable([...EXPORT_HEADER], toRows(rows), '产品库筛选结果')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="wb-asin wb-products">
      <div className="wb-amazon-heading">
        <div>
          <h2>{t('产品库')}</h2>
          <p>{t('商品事实：站点、ASIN、标题、价格、店铺、类目。可手动录入与维护，选品判断保持独立。')}</p>
        </div>
        <div className="wb-amazon-heading-actions">
          <button type="button" className="wb-btn primary" onClick={() => openCreate()} disabled={busy}>
            <Icon name="plus" size={13} />{t('手动录入')}
          </button>
          <button type="button" className="wb-btn" disabled={loading} onClick={() => void actions.reload()}>
            <Icon name="refresh" size={13} />{loading ? t('读取中…') : t('刷新')}
          </button>
          <button
            type="button"
            className="wb-btn"
            disabled={total === 0 || table.available === false || table.busy || exporting}
            title={table.available === false ? t('当前 profile 未检测到 dsh-univer-office') : undefined}
            onClick={() => void openInTable()}
          >
            <Icon name="table" size={13} />{table.busy || exporting ? t('生成表格中…') : t('生成表格并预览')}
          </button>
        </div>
      </div>

      <UniverCapabilityHint
        available={table.available}
        contentRead={table.contentRead}
        onRetry={() => void table.actions.refreshAvailability()}
        subject="library"
      />

      <div className="wb-products-stats">
        <span className="wb-products-stat"><b>{facets.total}</b>{t('个产品')}</span>
        <span className="wb-products-stat"><b>{facets.sites.length}</b>{t('个站点')}</span>
        <span className="wb-products-stat"><b>{facets.shops.length}</b>{t('个店铺')}</span>
        <span className="wb-products-stat"><b>{facets.categories.length}</b>{t('个类目')}</span>
      </div>

      <div className="wb-asin-toolbar">
        <div className="wb-asin-filters">
          <input
            className="wb-oplog-search"
            type="search"
            value={filter.q}
            placeholder={t('搜索 ASIN / 标题')}
            aria-label={t('搜索 ASIN / 标题')}
            onChange={(e) => actions.setFilter({ q: e.target.value })}
          />
          <select className="wb-oplog-select" value={filter.site} onChange={(e) => actions.setFilter({ site: e.target.value })} aria-label={t('站点')}>
            <option value="">{t('全部站点')}</option>
            {facets.sites.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
          </select>
          <select className="wb-oplog-select" value={filter.shop} onChange={(e) => actions.setFilter({ shop: e.target.value })} aria-label={t('店铺')}>
            <option value="">{t('全部店铺')}</option>
            {facets.shops.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
          </select>
          <select className="wb-oplog-select" value={filter.category} onChange={(e) => actions.setFilter({ category: e.target.value })} aria-label={t('类目')}>
            <option value="">{t('全部类目')}</option>
            {facets.categories.map((f) => <option key={f.value} value={f.value}>{f.value}（{f.count}）</option>)}
          </select>
          {filtered && (
            <button
              type="button"
              className="wb-btn"
              onClick={() => actions.setFilter({ site: '', shop: '', category: '', q: '' })}
            >{t('清空筛选')}</button>
          )}
        </div>
      </div>

      {error !== '' && <div className="wb-oplog-error" role="alert">{error}</div>}
      {/* 只有在"还没有任何行"时才让位给加载提示：已有数据时重拉不该把整张表撤掉（会闪）。 */}
      {loading && items.length === 0 && <div className="wb-skill-hint">{t('读取产品库…')}</div>}

      {!loading && items.length === 0 && (
        <div className="wb-empty">
          <div className="wb-empty-title">{facets.total === 0 ? t('产品库还是空的') : t('没有符合条件的产品')}</div>
          <div className="wb-empty-desc">
            {facets.total === 0
              ? t('这里放你自己的产品清单。手动录入一条，或批量导入后就能按站点/店铺/类目查看与维护。')
              : t('当前筛选没有命中任何产品。')}
          </div>
          <div className="wb-empty-actions">
            {/**
             * 从选品页带着 `q` 跳过来却查无此条时，直接把 ASIN / 站点填进录入弹框 ——
             * 否则这个跳转就是一个死胡同（用户还得自己回选品页抄 ASIN）。
             */}
            {filtered && filter.q.trim() !== '' && (
              <button type="button" className="wb-btn primary" onClick={() => openCreate({ asin: filter.q.trim().toUpperCase(), site: filter.site || emptyProductFactDraft().site })}>
                <Icon name="plus" size={13} />{t('把「{q}」录入产品库', { q: filter.q.trim().toUpperCase() })}
              </button>
            )}
            <button type="button" className={`wb-btn${facets.total === 0 ? ' primary' : ''}`} onClick={() => openCreate()}>
              <Icon name="plus" size={13} />{facets.total === 0 ? t('录入第一个产品') : t('手动录入')}
            </button>
            {filtered && (
              <button type="button" className="wb-btn" onClick={() => actions.setFilter({ site: '', shop: '', category: '', q: '' })}>{t('清空筛选')}</button>
            )}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className={`wb-list wb-product-facts${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>
            <div className="wb-product-head" role="row">
              <span>{t('站点')}</span>
              <span>ASIN</span>
              <span>{t('标题')}</span>
              <span className="wb-product-price-head">{t('价格')}</span>
              <span className="wb-asin-date">{t('更新时间')}</span>
              <span className="wb-product-actions-head">{t('操作')}</span>
            </div>
            {items.map((row) => (
              <div key={row.id} className="wb-product-row" role="row">
                <span>
                  {row.identityState === 'needs_site'
                    ? <span className="wb-chip is-neutral" title={t('站点未知：请补站点')}>{t('待补')}</span>
                    : <span className="wb-chip">{row.site}</span>}
                </span>
                <span className="wb-asin-code">{row.asin}</span>
                {/**
                 * 标题列是**两行**：第一行标题，第二行店铺与类目。
                 * 为什么不再各占一列：七列固定宽度合计 ~630px，窄面板会横向溢出；
                 * 而店铺/类目是"看一眼"的元信息，压在标题下面既省宽也更容易连带读。
                 */}
                <span className="wb-product-title-cell">
                  <span className="wb-product-title-stack">
                    <span className={`wb-asin-title${row.title === '' ? ' is-empty' : ''}`}>{row.title === '' ? t('（未填标题）') : row.title}</span>
                    <span className="wb-product-meta">
                      <span className="wb-product-shop">{row.shopName ?? t('无店铺')}</span>
                      {row.category !== null && <span className="wb-chip is-neutral">{row.category}</span>}
                    </span>
                  </span>
                </span>
                <span className="wb-asin-price">{money(row.price)}</span>
                <span className="wb-asin-date">{day(row.updatedAt)}</span>
                <span className="wb-product-row-actions">
                  <button type="button" className="wb-asin-copy" onClick={() => openEdit(row)} aria-label={t('编辑 {asin}', { asin: row.asin })}>
                    <Icon name="edit" size={12} /><span>{t('编辑')}</span>
                  </button>
                  <button type="button" className="wb-asin-copy is-danger" onClick={() => setPendingDelete(row)} aria-label={t('删除 {asin}', { asin: row.asin })}>
                    <Icon name="trash" size={12} /><span>{t('删除')}</span>
                  </button>
                </span>
              </div>
            ))}
          </div>

          <div className="wb-asin-pager">
            <span className="wb-asin-count">{t('显示 {a}–{b} / 共 {n} 个产品', { a: from, b: to, n: total })}</span>
            <label className="wb-asin-page-size">{t('每页')}
              <select
                className="wb-oplog-select"
                value={filter.size}
                aria-label={t('每页条数')}
                onChange={(e) => actions.setFilter({ size: Number(e.target.value) })}
              >
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" className="wb-btn" disabled={filter.page <= 1} onClick={() => actions.setFilter({ page: filter.page - 1 })}>{t('上一页')}</button>
            <span className="wb-asin-page">{filter.page} / {totalPages}</span>
            <button type="button" className="wb-btn" disabled={filter.page >= totalPages} onClick={() => actions.setFilter({ page: filter.page + 1 })}>{t('下一页')}</button>
          </div>
        </>
      )}

      <UniverPreviewCard table={table} />

      {form !== null && (
        <ProductFactForm
          mode={form.mode}
          draft={form.value}
          busy={busy}
          error={formError}
          onChange={(value) => setForm({ ...form, value })}
          onSave={() => void submit()}
          onClose={() => { if (!busy) setForm(null) }}
        />
      )}

      {pendingDelete !== null && (
        <Modal
          title={t('删除产品')}
          size="sm"
          onClose={() => { if (!busy) { setPendingDelete(null); setDeleteError('') } }}
          footer={<>
            <button type="button" className="wb-btn" disabled={busy} onClick={() => { setPendingDelete(null); setDeleteError('') }}>{t('取消')}</button>
            <button type="button" className="wb-btn danger" disabled={busy} onClick={() => void confirmDelete()}>{busy ? t('删除中…') : t('确认删除')}</button>
          </>}
        >
          <p className="wb-product-delete-note">
            {t('将从产品库删除 {site} / {asin}。选品库里的判断不受影响。', { site: pendingDelete.site ?? '待补', asin: pendingDelete.asin })}
          </p>
          {pendingDelete.title !== '' && <p className="wb-amazon-footnote">{pendingDelete.title}</p>}
          {deleteError !== '' && <div className="wb-oplog-error" role="alert">{deleteError}</div>}
        </Modal>
      )}
    </div>
  )
}
