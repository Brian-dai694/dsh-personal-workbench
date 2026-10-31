/**
 * 商品选择器（P4 预备，2026-10-29）：**只做组件边界，尚未接入**。
 *
 * ## 为什么现在只做边界
 *
 * 运营日志的「关联商品」现在是一个自由文本输入框（`OpsLogView` 里写 `asin_json`）。
 * 改成选择器必须先有两条东西：
 * 1. `{site, asin}` 的身份列表（P2 合同已就绪，读取接口可复用 `/api/workbench/asin`）；
 * 2. 日志关联的持久化形状（`oplog_entry_associations` 还在设计，未落地）。
 *
 * 在 (2) 落地前把选择器接进去，只能继续写自由文本 —— 等于把"看起来选过"的假象
 * 塞进旧字段。所以这里先交付**受控组件**：不取数、不发请求、不写库，
 * 由未来的 hook 提供 options，等关联表就绪后一次性接上。
 *
 * ## 契约
 *
 * - 纯展示 + 受控：`value` 是已选项，`onChange` 回新数组；
 * - 站点未知（`site: null`）的项**可选但会标注**，不静默当成 US；
 * - 不在这里做搜索过滤（那是取数层的事，避免两处各写一套匹配规则）。
 */
import { useI18n } from '../i18n.js'
import { Icon } from './Icon.js'

export interface ProductPickerOption {
  asin: string
  /** `null` = 站点未定。 */
  site: string | null
  title: string
}

export interface ProductPickerProps {
  /** 可选商品（已由调用方按关键词筛过）。 */
  options: ReadonlyArray<ProductPickerOption>
  /** 已选（顺序即展示顺序）。 */
  value: ReadonlyArray<ProductPickerOption>
  onChange: (next: ProductPickerOption[]) => void
  /** 读取中：禁用交互但保留已选。 */
  loading?: boolean
}

export function ProductPicker({ options, value, onChange, loading }: ProductPickerProps): JSX.Element {
  const { t } = useI18n()
  const picked = new Set(value.map((item) => `${item.site ?? ''}|${item.asin}`))

  const toggle = (option: ProductPickerOption): void => {
    const key = `${option.site ?? ''}|${option.asin}`
    if (picked.has(key)) onChange(value.filter((item) => `${item.site ?? ''}|${item.asin}` !== key))
    else onChange([...value, option])
  }

  return (
    <div className="wb-product-picker">
      {value.length > 0 && (
        <div className="wb-report-quadrants" aria-label={t('已选商品')}>
          {value.map((item) => (
            <span key={`${item.site ?? ''}|${item.asin}`} className="wb-chip">
              {item.site === null ? t('待补') : item.site} · {item.asin}
            </span>
          ))}
        </div>
      )}
      <div className="wb-list" role="listbox" aria-busy={loading === true}>
        {options.length === 0 && (
          <p className="wb-hint">{loading === true ? t('读取商品…') : t('没有匹配的商品。')}</p>
        )}
        {options.map((option) => {
          const key = `${option.site ?? ''}|${option.asin}`
          const on = picked.has(key)
          return (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={on}
              className={`wb-amazon-dataset-item${on ? ' on' : ''}`}
              disabled={loading === true}
              onClick={() => toggle(option)}
            >
              <span>
                <Icon name="table" size={12} />{' '}
                {option.site === null ? t('待补站点') : option.site} · {option.asin}
              </span>
              <small>{option.title}</small>
            </button>
          )
        })}
      </div>
    </div>
  )
}
