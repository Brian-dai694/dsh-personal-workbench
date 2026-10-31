/**
 * 选品库「手工维护」的两个弹框（v1.18）：商品、店铺。
 *
 * 为什么是组件而不是写在 `AsinView` 里：视图已经很长，而这两个弹框**不碰数据**
 * （只渲染草稿 + 抛意图回调），放在组件里可以让视图保持"列表 + 状态"。
 *
 * 纪律：
 * - 不做请求、不做乐观更新 —— 存成功后由视图重新拉列表（否则"看起来存了、刷新又回来"）；
 * - ASIN 在编辑态**只读**：它是主键，改它等于换一条记录，应该是"删了再加"；
 * - 所有用户可见文案走 `t()`（英文未翻译时回落中文，见 shared/i18n.ts）。
 */
import { useI18n } from '../i18n.js'
import { Modal } from './Modal.js'
import { ASIN_SITES, type AsinProductDraft, type AsinStoreDraft, type AsinStoreOption } from '../asinManualDraft.js'

export interface AsinProductFormProps {
  mode: 'create' | 'edit'
  draft: AsinProductDraft
  stores: readonly AsinStoreOption[]
  busy: boolean
  error: string
  onChange: (draft: AsinProductDraft) => void
  onSave: () => void
  onClose: () => void
}

export function AsinProductForm({ mode, draft, stores, busy, error, onChange, onSave, onClose }: AsinProductFormProps): JSX.Element {
  const { t } = useI18n()
  const patch = (part: Partial<AsinProductDraft>): void => { onChange({ ...draft, ...part }) }
  const canSave = draft.asin.trim().length > 0 && !busy
  return (
    <Modal
      title={<>{mode === 'create' ? t('添加商品') : t('编辑商品')}</>}
      size="md"
      onClose={onClose}
      footer={<>
        <button className="wb-btn" type="button" onClick={onClose}>{t('取消')}</button>
        <button className="wb-btn primary" type="button" disabled={!canSave} onClick={onSave}>{busy ? t('保存中…') : t('保存')}</button>
      </>}
    >
      <div className="wb-oplog-form">
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('ASIN')}</span>
            <input
              value={draft.asin}
              disabled={mode === 'edit'}
              maxLength={10}
              placeholder="B0XXXXXXXX"
              onChange={(e) => patch({ asin: e.target.value.toUpperCase() })}
            />
          </label>
          <label className="wb-field"><span>{t('站点')}</span>
            <input list="wb-asin-site-options" value={draft.site} placeholder="US" onChange={(e) => patch({ site: e.target.value.toUpperCase() })} />
            <datalist id="wb-asin-site-options">
              {ASIN_SITES.map((site) => <option key={site} value={site} />)}
            </datalist>
          </label>
        </div>
        <label className="wb-field"><span>{t('标题')}</span>
          <input value={draft.title} placeholder={t('商品标题（可留空，之后补）')} onChange={(e) => patch({ title: e.target.value })} />
        </label>
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('店铺')}</span>
            <input
              list="wb-asin-shop-options"
              value={draft.shopName}
              placeholder={t('选已有店铺，或直接输入店名')}
              onChange={(e) => patch({ shopName: e.target.value })}
            />
            <datalist id="wb-asin-shop-options">
              {stores.map((store) => <option key={store.name} value={store.name} />)}
            </datalist>
          </label>
          <label className="wb-field"><span>{t('分类')}</span>
            <input value={draft.category} placeholder={t('例如 Welding torch')} onChange={(e) => patch({ category: e.target.value })} />
          </label>
        </div>
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('价格（$）')}</span>
            <input inputMode="decimal" value={draft.price} placeholder="0.00" onChange={(e) => patch({ price: e.target.value })} />
          </label>
          <label className="wb-field"><span>{t('评分（0–5）')}</span>
            <input inputMode="decimal" value={draft.rating} placeholder="4.5" onChange={(e) => patch({ rating: e.target.value })} />
          </label>
        </div>
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('评论数')}</span>
            <input inputMode="numeric" value={draft.reviews} placeholder="0" onChange={(e) => patch({ reviews: e.target.value })} />
          </label>
          <label className="wb-field"><span>{t('BSR')}</span>
            <input inputMode="numeric" value={draft.bsr} placeholder="0" onChange={(e) => patch({ bsr: e.target.value })} />
          </label>
        </div>
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('商品链接')}</span>
            <input value={draft.url} placeholder="https://www.amazon.com/dp/…" onChange={(e) => patch({ url: e.target.value })} />
          </label>
          <label className="wb-field"><span>{t('图片链接')}</span>
            <input value={draft.imageUrl} placeholder="https://…" onChange={(e) => patch({ imageUrl: e.target.value })} />
          </label>
        </div>
        <label className="wb-field"><span>{t('标签')}<span className="wb-field-note">{t('逗号分隔')}</span></span>
          <input value={draft.tags} placeholder={t('例如 焊接, 蓝海')} onChange={(e) => patch({ tags: e.target.value })} />
        </label>
        <label className="wb-field"><span>{t('备注')}</span>
          <textarea rows={3} value={draft.note} onChange={(e) => patch({ note: e.target.value })} />
        </label>
        <label className="wb-inline-check">
          <input type="checkbox" checked={draft.watch} onChange={(e) => patch({ watch: e.target.checked })} />
          <span>{t('重点关注（列表置顶）')}</span>
        </label>
        {error !== '' && <div className="wb-oplog-error">{error}</div>}
      </div>
    </Modal>
  )
}

export interface AsinStoreFormProps {
  mode: 'create' | 'edit'
  draft: AsinStoreDraft
  busy: boolean
  error: string
  onChange: (draft: AsinStoreDraft) => void
  onSave: () => void
  onClose: () => void
}

export function AsinStoreForm({ mode, draft, busy, error, onChange, onSave, onClose }: AsinStoreFormProps): JSX.Element {
  const { t } = useI18n()
  const patch = (part: Partial<AsinStoreDraft>): void => { onChange({ ...draft, ...part }) }
  const canSave = draft.name.trim().length > 0 && !busy
  return (
    <Modal
      title={<>{mode === 'create' ? t('添加店铺') : t('编辑店铺')}</>}
      size="sm"
      onClose={onClose}
      footer={<>
        <button className="wb-btn" type="button" onClick={onClose}>{t('取消')}</button>
        <button className="wb-btn primary" type="button" disabled={!canSave} onClick={onSave}>{busy ? t('保存中…') : t('保存')}</button>
      </>}
    >
      <div className="wb-oplog-form">
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('店铺名称')}</span>
            <input value={draft.name} placeholder={t('例如 YourBrand')} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="wb-field"><span>{t('站点')}</span>
            <input list="wb-asin-store-sites" value={draft.site} placeholder="US" onChange={(e) => patch({ site: e.target.value.toUpperCase() })} />
            <datalist id="wb-asin-store-sites">
              {ASIN_SITES.map((site) => <option key={site} value={site} />)}
            </datalist>
          </label>
        </div>
        <div className="wb-oplog-form-row">
          <label className="wb-field"><span>{t('Seller ID')}</span>
            <input value={draft.sellerId} placeholder={t('可留空')} onChange={(e) => patch({ sellerId: e.target.value })} />
          </label>
          <label className="wb-field"><span>{t('店铺链接')}</span>
            <input value={draft.url} placeholder="https://…" onChange={(e) => patch({ url: e.target.value })} />
          </label>
        </div>
        <label className="wb-field"><span>{t('备注')}</span>
          <textarea rows={3} value={draft.note} onChange={(e) => patch({ note: e.target.value })} />
        </label>
        <label className="wb-inline-check">
          <input type="checkbox" checked={draft.watch} onChange={(e) => patch({ watch: e.target.checked })} />
          <span>{t('关注这家店铺')}</span>
        </label>
        {error !== '' && <div className="wb-oplog-error">{error}</div>}
      </div>
    </Modal>
  )
}
