/**
 * 产品库「录入 / 编辑」弹框（v1.19）。
 *
 * ## 为什么在组件里而不是视图里
 *
 * 视图只该有"列表 + 状态"，弹框是**纯渲染 + 意图回调**（不碰数据、不做乐观更新）。
 * 把它抽出来，`ProductLibraryView` 才能保持"一屏看得完"。
 *
 * ## 纪律
 *
 * - **不做请求**：存成功后由 hook 重拉列表（否则会出现"看着存了、刷新又回来"）；
 * - **ASIN / 站点在编辑态只读**：它们是产品身份，改它等于换一条记录，应该删了再录；
 * - 文案全部走 `t()`，英文未翻译时回落中文（见 `shared/i18n.ts`）。
 */
import { useI18n } from '../i18n.js'
import { Modal } from './Modal.js'
import { ASIN_SITES, type ProductFactDraft } from '../productFactDraft.js'

export interface ProductFactFormProps {
  mode: 'create' | 'edit'
  draft: ProductFactDraft
  busy: boolean
  error: string
  onChange: (draft: ProductFactDraft) => void
  onSave: () => void
  onClose: () => void
}

export function ProductFactForm({ mode, draft, busy, error, onChange, onSave, onClose }: ProductFactFormProps): JSX.Element {
  const { t } = useI18n()
  const patch = (part: Partial<ProductFactDraft>): void => { onChange({ ...draft, ...part }) }
  const editing = mode === 'edit'
  const canSave = draft.asin.trim().length > 0 && draft.site.trim().length === 2 && !busy
  return (
    <Modal
      title={<>{editing ? t('编辑产品') : t('手动录入产品')}</>}
      size="md"
      onClose={onClose}
      footer={<>
        <button className="wb-btn" type="button" onClick={onClose}>{t('取消')}</button>
        <button className="wb-btn primary" type="button" disabled={!canSave} onClick={onSave}>{busy ? t('保存中…') : t('保存')}</button>
      </>}
    >
      <div className="wb-oplog-form">
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('ASIN')}<span className="wb-field-note">{editing ? t('身份字段，不可改') : t('必填')}</span></span>
            <input
              value={draft.asin}
              disabled={editing}
              maxLength={20}
              placeholder="B0XXXXXXXX"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ asin: e.target.value.toUpperCase() })}
            />
          </label>
          <label className="wb-field"><span>{t('站点')}<span className="wb-field-note">{editing ? t('身份字段，不可改') : t('例如 US / DE')}</span></span>
            <input
              list="wb-product-sites"
              value={draft.site}
              disabled={editing}
              maxLength={2}
              placeholder="US"
              autoComplete="off"
              onChange={(e) => patch({ site: e.target.value.toUpperCase() })}
            />
            <datalist id="wb-product-sites">
              {ASIN_SITES.map((site) => <option key={site} value={site} />)}
            </datalist>
          </label>
        </div>

        <label className="wb-field"><span>{t('标题')}<span className="wb-field-note">{t('可留空，之后补')}</span></span>
          <input value={draft.title} maxLength={300} placeholder={t('商品标题')} onChange={(e) => patch({ title: e.target.value })} />
        </label>

        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('价格（$）')}</span>
            <input inputMode="decimal" value={draft.price} placeholder="0.00" autoComplete="off" onChange={(e) => patch({ price: e.target.value })} />
          </label>
          <label className="wb-field"><span>{t('店铺')}</span>
            <input value={draft.shopName} maxLength={120} placeholder={t('例如 YourBrand')} onChange={(e) => patch({ shopName: e.target.value })} />
          </label>
        </div>

        <label className="wb-field"><span>{t('分类')}</span>
          <input value={draft.category} maxLength={120} placeholder={t('例如 Welding torch')} onChange={(e) => patch({ category: e.target.value })} />
        </label>

        <p className="wb-amazon-footnote">
          {editing
            ? t('这里只改产品事实（标题 / 价格 / 店铺 / 分类）。要换站点或 ASIN，请删除后重新录入。')
            : t('录入后这条就出现在产品库里；选品判断仍在「选品」页单独维护，两边互不写入。')}
        </p>
        {error !== '' && <div className="wb-oplog-error" role="alert">{error}</div>}
      </div>
    </Modal>
  )
}
