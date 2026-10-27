/**
 * Amazon 测算（v1.23）：成本盈亏 / 广告位 CPC + **方案库与多方案对比**。
 *
 * ## 为什么要方案库
 * 以往参数只存在浏览器 `localStorage`：换机器就丢、不进备份、也不属于工作台的数据。
 * 更关键的是没法回答"三个定价里哪个更稳" —— 只能反复改参数、记住上一次的结果。
 * 现在的做法：参数可以存成命名方案（落库），并排对比最多四份、标出每份相对基准改了哪些字段。
 *
 * ## 三条纪律（不要放松）
 * 1. **结论一律现算**：方案只存输入，`calculateAmazonEconomics` 是唯一的数学入口；
 * 2. **非法输入不隐藏**：参数不合法的方案照样列出并标出错误数；
 * 3. **不连接广告账户**：这里没有出价下发、没有预算修改，只有可复核的数字与建议。
 */
import { useMemo, useState } from 'react'
import { calculateAmazonBid, calculateAmazonEconomics, type AmazonCalculatorInput } from '../amazonCalculator.js'
import {
  COMPARISON_METRICS, bestColumnId, buildComparison, describeDiffs, formatComparisonValue,
} from '../calculatorCompare.js'
import type { UseCalculatorScenariosResult } from '../hooks/useCalculatorScenarios.js'
import { MAX_COMPARE } from '../hooks/useCalculatorScenarios.js'
import { CALCULATOR_DEFAULTS } from '../../shared/calculatorScenario.js'

const STORAGE_KEY = 'dsh-workbench-amazon-calculator-v1'
type CalculatorMode = 'profit' | 'bid'

/**
 * 默认参数来自共享模块（`shared/calculatorScenario.ts`）：对比表补齐老方案时用的
 * 必须是**同一份**默认值，否则会出现「面板显示 $39.99、对比表里另一个数」。
 */
const DEFAULTS: AmazonCalculatorInput = { ...CALCULATOR_DEFAULTS, calibrationCpc: undefined }

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

export function AmazonToolsView({ onSendToAI, scenarios: model }: { onSendToAI?: (text: string) => void; scenarios?: UseCalculatorScenariosResult } = {}): JSX.Element {
  const [input, setInput] = useState<AmazonCalculatorInput>(loadInput)
  const [mode, setMode] = useState<CalculatorMode>('profit')
  const [bid, setBid] = useState(0.8)
  const [placementPercent, setPlacementPercent] = useState(50)
  const [maxMultiplier, setMaxMultiplier] = useState(2)
  const [saved, setSaved] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== null } catch { return false }
  })
  const [scenarioName, setScenarioName] = useState('')
  const [scenarioNote, setScenarioNote] = useState('')
  const [scenarioMsg, setScenarioMsg] = useState('')
  const result = useMemo(() => calculateAmazonEconomics(input), [input])
  const bidResult = useMemo(() => calculateAmazonBid({ bid, placementPercent, maxMultiplier }), [bid, placementPercent, maxMultiplier])

  const scenarioList = model?.scenarios ?? []
  const compareIds = model?.compareIds ?? []
  const comparison = useMemo(() => {
    if (compareIds.length === 0) return null
    const picked = compareIds
      .map((id) => scenarioList.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
    if (picked.length === 0) return null
    return buildComparison(picked, DEFAULTS)
  }, [compareIds, scenarioList])

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

  /** 保存到方案库；同名时先问，用户确认才覆盖（不静默替换）。 */
  async function saveScenario(): Promise<void> {
    if (model === undefined) return
    const name = scenarioName.trim()
    if (name === '') { setScenarioMsg('先给方案起个名字'); return }
    const record = Object.fromEntries(
      Object.entries(input).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
    )
    const first = await model.actions.save({ name, input: record, note: scenarioNote })
    if (first.conflictId !== null) {
      if (!window.confirm(`已存在同名方案「${name}」，要用当前参数覆盖它吗？`)) {
        setScenarioMsg('已取消覆盖：换个名字保存，或先删掉旧方案')
        return
      }
      const forced = await model.actions.save({ name, input: record, note: scenarioNote, replace: true })
      if (forced.scenario !== null) setScenarioMsg(`已覆盖方案「${forced.scenario.name}」`)
      return
    }
    if (first.scenario !== null) {
      setScenarioMsg(`已保存方案「${first.scenario.name}」`)
      setScenarioName('')
    }
  }

  async function loadScenario(id: string, name: string): Promise<void> {
    if (model === undefined) return
    const target = model.scenarios.find((item) => item.id === id)
    if (target === undefined) return
    setInput({ ...DEFAULTS, ...target.input })
    setScenarioNote(target.note)
    setScenarioName(target.name)
    setScenarioMsg(`已载入「${name}」的参数（未改动库里那份）`)
  }

  async function removeScenario(id: string, name: string): Promise<void> {
    if (model === undefined) return
    if (!window.confirm(`删除测算方案「${name}」？删除后不可恢复。`)) return
    const ok = await model.actions.remove(id)
    if (ok) setScenarioMsg(`已删除「${name}」`)
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

      {/* 方案库：只在"CPC 盈亏"模式下有意义（广告位出价是另一组参数） */}
      {mode === 'profit' && (
        <section className="wb-calc-scenarios" aria-label="测算方案库">
          <header className="wb-calc-scenario-head">
            <h3 className="wb-amazon-section-title">方案库（{scenarioList.length}）</h3>
            <div className="wb-calc-scenario-save">
              <input
                className="wb-calc-scenario-name"
                value={scenarioName}
                placeholder="方案名，如「$39.99 标准成本」"
                aria-label="方案名"
                onChange={(event) => setScenarioName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void saveScenario() }}
              />
              <input
                className="wb-calc-scenario-note"
                value={scenarioNote}
                placeholder="备注（可选）"
                aria-label="方案备注"
                onChange={(event) => setScenarioNote(event.target.value)}
              />
              <button className="wb-btn primary" type="button" disabled={model === undefined || model.busy} onClick={() => void saveScenario()}>存为方案</button>
            </div>
          </header>

          {model !== undefined && model.error !== null && <div className="wb-amazon-warning" role="alert">方案库操作失败：{model.error}</div>}
          {scenarioMsg !== '' && <div className="wb-amazon-note" role="status">{scenarioMsg}</div>}

          {scenarioList.length === 0
            ? <div className="wb-amazon-empty"><strong>还没有保存的方案</strong><span>把当前参数存成方案后，可以并排对比不同定价/成本假设。</span></div>
            : (
              <ul className="wb-calc-scenario-list">
                {scenarioList.map((item) => {
                  const checked = compareIds.includes(item.id)
                  return (
                    <li key={item.id} className={`wb-calc-scenario-item${checked ? ' on' : ''}`}>
                      <label className="wb-calc-scenario-pick" title={checked ? '取消对比' : '加入对比'}>
                        <input type="checkbox" checked={checked} onChange={() => model?.actions.toggleCompare(item.id)} />
                      </label>
                      <div className="wb-calc-scenario-meta">
                        <b>{item.name}</b>
                        <small>
                          {item.input.price === undefined ? '售价未填' : `售价 $${item.input.price.toFixed(2)}`}
                          {item.input.unitCost === undefined ? '' : ` · 采购 $${item.input.unitCost.toFixed(2)}`}
                          {item.asin === null ? '' : ` · ${item.asin}`}
                          {item.note === '' ? '' : ` · ${item.note}`}
                        </small>
                      </div>
                      <div className="wb-calc-scenario-actions">
                        <button className="wb-btn" type="button" disabled={model?.busy === true} onClick={() => void loadScenario(item.id, item.name)}>载入</button>
                        <button className="wb-oplog-card-open" type="button" disabled={model?.busy === true} onClick={() => void removeScenario(item.id, item.name)}>删除</button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

          {compareIds.length > 0 && (
            <div className="wb-calc-compare">
              <header className="wb-calc-compare-head">
                <h4>对比（{compareIds.length}/{MAX_COMPARE}）</h4>
                <button className="wb-btn" type="button" onClick={() => model?.actions.clearCompare()}>清空对比</button>
              </header>
              {compareIds.length < 2
                ? <p className="wb-amazon-footnote">再勾选一份方案就能并排对比（最多 {MAX_COMPARE} 份）。</p>
                : comparison !== null && (
                  <>
                    {comparison.warnings.length > 0 && (
                      <div className="wb-amazon-warning" role="alert">{comparison.warnings.map((line) => <div key={line}>{line}</div>)}</div>
                    )}
                    <div className="wb-amazon-table-wrap">
                      <table className="wb-amazon-table wb-amazon-table-grid">
                        <thead>
                          <tr>
                            <th className="text">指标</th>
                            {comparison.columns.map((column) => <th key={column.id}>{column.name}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {COMPARISON_METRICS.map((metric) => {
                            const bestId = bestColumnId(metric, comparison.columns)
                            return (
                              <tr key={metric.key}>
                                <td className="text">{metric.label}</td>
                                {comparison.columns.map((column) => (
                                  <td key={column.id} className={bestId === column.id ? 'is-best' : undefined}>
                                    {formatComparisonValue(metric.value(column), metric.format)}
                                    {bestId === column.id && <span className="wb-calc-best" title="这一行里更优">优</span>}
                                  </td>
                                ))}
                              </tr>
                            )
                          })}
                          <tr>
                            <td className="text">相对基准差异</td>
                            {comparison.columns.map((column) => (
                              <td key={column.id} className="text wb-calc-diff">{describeDiffs(column, comparison.columns[0].name)}</td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="wb-amazon-footnote">「优」只按数值方向标注（成本越低越好、贡献与利润越高越好），不代表经营结论 —— 转化率与广告后利润仍取决于真实投放数据（unknown）。</p>
                  </>
                )}
            </div>
          )}
        </section>
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
