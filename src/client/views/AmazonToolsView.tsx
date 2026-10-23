import { useMemo, useState } from 'react'
import { calculateAmazonBid, calculateAmazonEconomics, type AmazonCalculatorInput } from '../amazonCalculator.js'

const STORAGE_KEY = 'dsh-workbench-amazon-calculator-v1'
type CalculatorMode = 'profit' | 'bid'

const DEFAULTS: AmazonCalculatorInput = {
  price: 39.99,
  unitCost: 8,
  freight: 3,
  fbaFee: 6,
  referralFee: 6,
  storageFee: 0,
  removalFee: 0,
  promotionCost: 0,
  returnRate: 0.03,
  returnLoss: 2,
  otherCosts: 0,
  targetAcos: 0.25,
  conversionRate: 0.1,
  adOrderShare: 0.6,
  marketCpc: 1.2,
  calibrationCpc: undefined,
}

const COST_FIELDS: Array<{ key: keyof AmazonCalculatorInput; label: string; hint?: string; percent?: boolean }> = [
  { key: 'price', label: '售价', hint: 'USD / 件' },
  { key: 'unitCost', label: '采购成本', hint: 'USD / 件' },
  { key: 'freight', label: '头程运费', hint: 'USD / 件' },
  { key: 'fbaFee', label: 'FBA 配送费', hint: 'USD / 件' },
  { key: 'referralFee', label: '销售佣金', hint: 'USD / 件' },
  { key: 'storageFee', label: '仓储费摊销', hint: 'USD / 件' },
  { key: 'removalFee', label: '移除 / 弃置摊销', hint: 'USD / 件' },
  { key: 'promotionCost', label: '促销成本摊销', hint: 'USD / 件' },
  { key: 'returnRate', label: '退货率', percent: true },
  { key: 'returnLoss', label: '退货额外损失', hint: 'USD / 笔' },
  { key: 'otherCosts', label: '其他单件费用', hint: 'USD / 件' },
]

function loadInput(): AmazonCalculatorInput {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return { ...DEFAULTS, ...JSON.parse(saved) as Partial<AmazonCalculatorInput> }
  } catch { /* Invalid or unavailable local storage falls back to defaults. */ }
  return DEFAULTS
}

const money = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `$${value.toFixed(2)}`
const percent = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(2)}%`

export function AmazonToolsView({ onSendToAI }: { onSendToAI?: (text: string) => void }): JSX.Element {
  const [input, setInput] = useState<AmazonCalculatorInput>(loadInput)
  const [mode, setMode] = useState<CalculatorMode>('profit')
  const [bid, setBid] = useState(0.8)
  const [placementPercent, setPlacementPercent] = useState(50)
  const [maxMultiplier, setMaxMultiplier] = useState(2)
  const [saved, setSaved] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== null } catch { return false }
  })
  const result = useMemo(() => calculateAmazonEconomics(input), [input])
  const bidResult = useMemo(() => calculateAmazonBid({ bid, placementPercent, maxMultiplier }), [bid, placementPercent, maxMultiplier])

  function update(key: keyof AmazonCalculatorInput, raw: string): void {
    const value = raw === '' && key === 'calibrationCpc' ? undefined : raw === '' ? 0 : Number(raw)
    setInput((current) => ({ ...current, [key]: value }))
  }

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(input))
      setSaved(true)
    } catch {
      setSaved(false)
    }
  }

  function sendResult(): void {
    const summary = mode === 'profit'
      ? [
          'Amazon CPC / 单件盈亏测算（derived，本机模型；未连接广告账户）',
          `售价：${money(input.price)}；有效单件贡献：${money(result.effectiveProfit)}；贡献率：${percent(result.marginRate)}`,
          `盈亏平衡 ACOS：${percent(result.breakEvenAcos)}；盈亏平衡 CPC：${money(result.breakEvenCpc)}；目标 ACOS CPC：${money(result.suggestedCpc)}`,
          `成本合计（不含退货期望损失）：${money(result.totalVariableCost)}，包含采购、头程、FBA、佣金、仓储、移除、促销与其他费用。`,
          `广告账户实际 ACOS/CPC/归因：unknown。外部计算器差值：${result.calibrationCpcGap === null ? 'unknown（未提供同条件 CPC）' : money(result.calibrationCpcGap)}。`,
        ].join('\n')
      : [
          'Amazon 广告位最高 CPC 测算（derived，仅建议）',
          `基础 Bid：${money(bid)}；广告位加价：${placementPercent.toFixed(1)}%；最高倍数：${maxMultiplier.toFixed(2)}×`,
          `最高 CPC：${money(bidResult.highestCpc)}。公式：Bid × (1 + 广告位加价/100) × 最高倍数。`,
          '实际竞价、广告位表现、ACOS 和订单归因：unknown；请核对账户报表后人工确认。',
        ].join('\n')
    onSendToAI?.(summary)
  }

  return (
    <section className="wb-amazon-tools" aria-label="Amazon 测算">
      <header className="wb-amazon-heading">
        <div><h2>Amazon 测算</h2><p>成本盈亏与广告位 CPC · 本地计算，不修改广告账户</p></div>
        <button className="wb-btn" type="button" onClick={save}>保存参数</button>
      </header>

      <div className="wb-segmented wb-amazon-mode" role="tablist" aria-label="计算模式">
        <button className={`wb-seg ${mode === 'profit' ? 'on' : ''}`} type="button" role="tab" aria-selected={mode === 'profit'} onClick={() => setMode('profit')}>CPC 盈亏</button>
        <button className={`wb-seg ${mode === 'bid' ? 'on' : ''}`} type="button" role="tab" aria-selected={mode === 'bid'} onClick={() => setMode('bid')}>广告位出价</button>
      </div>

      {mode === 'profit' ? (
        <>
          <div className="wb-amazon-native-layout">
            <div className="wb-amazon-inputs">
              <h3 className="wb-amazon-section-title">产品成本与转化</h3>
              {COST_FIELDS.map(({ key, label, hint, percent: isPercent }) => (
                <label className="wb-amazon-field" key={key}>
                  <span>{label}{hint && <small>{hint}</small>}</span>
                  <span className="wb-amazon-input-wrap">
                    <input aria-label={label} type="number" min="0" max={isPercent ? 100 : undefined} step={isPercent ? 0.1 : 0.01}
                      value={input[key] === undefined ? '' : isPercent ? input[key] * 100 : input[key]}
                      onChange={(event) => update(key, isPercent ? String(Number(event.target.value) / 100) : event.target.value)} />
                    {isPercent && <b>%</b>}
                  </span>
                </label>
              ))}
              <h3 className="wb-amazon-section-title">投放参数</h3>
              <Field label="目标 ACOS" percent value={input.targetAcos * 100} onChange={(v) => update('targetAcos', String(Number(v) / 100))} />
              <Field label="转化率" percent value={input.conversionRate * 100} onChange={(v) => update('conversionRate', String(Number(v) / 100))} />
              <Field label="广告订单占比" percent value={input.adOrderShare * 100} onChange={(v) => update('adOrderShare', String(Number(v) / 100))} />
              <Field label="市场参考 CPC" hint="USD，仅供比较" value={input.marketCpc} onChange={(v) => update('marketCpc', v)} />
              <Field label="外部盈亏 CPC" hint="USD，用于校准" value={input.calibrationCpc ?? ''} onChange={(v) => update('calibrationCpc', v)} />
              <button className="wb-btn" type="button" onClick={() => { setInput(DEFAULTS); setSaved(false) }}>恢复默认值</button>
              <p className="wb-amazon-save-state" role="status">{saved ? '参数已保存在本机浏览器' : '参数尚未保存'}</p>
            </div>
            <div className="wb-amazon-results" aria-live="polite">
              {!result.valid && <div className="wb-amazon-warning" role="alert">请检查输入：{result.errors.join('；')}</div>}
              {result.effectiveProfit <= 0 && <div className="wb-amazon-warning" role="status">有效单件贡献不为正，没有保本投放空间。</div>}
              <div className="wb-amazon-result-head"><div><span>盈亏平衡 CPC</span><strong>{money(result.breakEvenCpc)}</strong></div><div><span>有效贡献率</span><strong>{percent(result.marginRate)}</strong></div></div>
              <div className="wb-amazon-metrics">
                <Metric label="有效单件贡献" value={money(result.effectiveProfit)} />
                <Metric label="盈亏平衡 ACOS" value={percent(result.breakEvenAcos)} />
                <Metric label="目标 ACOS CPC" value={money(result.suggestedCpc)} />
                <Metric label="盈亏 CPC 安全值 (80%)" value={money(result.breakEvenCpc === null ? null : result.breakEvenCpc * 0.8)} />
                <Metric label="目标 ACOS 下广告后利润" value={money(result.profitAfterAds)} />
                <Metric label="市场 CPC 差值" value={result.marketCpcGap === null ? '未提供' : money(result.marketCpcGap)} />
                <Metric label="外部计算器差值" value={result.calibrationCpcGap === null ? '未校准' : money(result.calibrationCpcGap)} />
                <Metric label="单件成本合计" value={money(result.totalVariableCost)} />
              </div>
              <div className="wb-amazon-note">外部校准：<b>unknown</b>。录入相同输入下 cpc-compass 的盈亏 CPC 才可比较；当前没有可验证对照样本。</div>
              <p className="wb-amazon-footnote">预期贡献 = 售价 − 单件成本 − 退货期望损失。盈亏平衡 CPC = 预期贡献 × 转化率；目标 ACOS CPC = 售价 × 转化率 × 目标 ACOS。实际费用按站点、尺寸、库龄及促销规则核验。</p>
              <div className="wb-amazon-result-actions"><button className="wb-btn primary" type="button" disabled={!result.valid || !onSendToAI} onClick={sendResult}>带入 AI 协助</button></div>
            </div>
          </div>
        </>
      ) : (
        <div className="wb-amazon-native-layout wb-amazon-bid-layout">
          <div className="wb-amazon-inputs">
            <h3 className="wb-amazon-section-title">广告位参数</h3>
            <Field label="基础 Bid" hint="USD" value={bid} onChange={(v) => setBid(Number(v))} />
            <Field label="广告位加价" percent value={placementPercent} onChange={(v) => setPlacementPercent(Number(v))} />
            <Field label="最高倍数" hint="×" value={maxMultiplier} onChange={(v) => setMaxMultiplier(Number(v))} />
          </div>
          <div className="wb-amazon-results" aria-live="polite">
            <div className="wb-amazon-result-head"><div><span>最高 CPC</span><strong>{money(bidResult.highestCpc)}</strong></div><div><span>最高倍数</span><strong>{maxMultiplier.toFixed(2)}×</strong></div></div>
            <p className="wb-amazon-footnote">公式：Bid × (1 + 广告位加价 ÷ 100) × 最高倍数。只计算最高 CPC，不读取或修改广告账户。</p>
            <div className="wb-amazon-result-actions"><button className="wb-btn primary" type="button" disabled={!bidResult.valid || !onSendToAI} onClick={sendResult}>带入 AI 协助</button></div>
          </div>
        </div>
      )}
    </section>
  )
}

function Field({ label, value, onChange, hint, percent: isPercent }: { label: string; value: number | string; onChange: (value: string) => void; hint?: string; percent?: boolean }): JSX.Element {
  return <label className="wb-amazon-field"><span>{label}{hint && <small>{hint}</small>}</span><span className="wb-amazon-input-wrap"><input aria-label={label} type="number" min="0" step="0.01" value={value} onChange={(event) => onChange(event.target.value)} />{isPercent && <b>%</b>}</span></label>
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="wb-amazon-metric"><span>{label}</span><strong>{value}</strong></div>
}
