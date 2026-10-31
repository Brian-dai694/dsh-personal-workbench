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
import { calculateAmazonBid, calculateAmazonEconomics, type AmazonCalculatorInput } from '../../shared/amazonCalculator.js'
import {
  COMPARISON_METRICS, bestColumnId, buildComparison, describeDiffs, formatComparisonValue,
} from '../calculatorCompare.js'
import type { UseCalculatorScenariosResult } from '../hooks/useCalculatorScenarios.js'
import { MAX_COMPARE } from '../hooks/useCalculatorScenarios.js'
import { CALCULATOR_DEFAULTS, REFERRAL_FEE_RATE, withFixedReferralFee } from '../../shared/calculatorScenario.js'
import { calculatePackage, type PackageCalculatorInput, type PackageSizeUnit, type PackageWeightUnit } from '../../shared/packageCalculator.js'
import { packCarton, type CartonSize } from '../../shared/cartonPacking.js'
import { PackageBoxThree } from '../components/PackageBoxThree.js'
import { CartonBox3D } from '../components/CartonBox3D.js'

const STORAGE_KEY = 'dsh-workbench-amazon-calculator-v1'
type CalculatorMode = 'profit' | 'bid' | 'package' | 'carton'

/** 外箱默认值：24×18×12 in 是北美最通用的搬家/整箱规格，改一次就存在本机 */
const CARTON_STORAGE_KEY = 'dsh-workbench-carton-outer-v1'
const CARTON_DEFAULT: CartonSize = { length: 24, width: 18, height: 12 }

/**
 * 默认参数来自共享模块（`shared/calculatorScenario.ts`）：对比表补齐老方案时用的
 * 必须是**同一份**默认值，否则会出现「面板显示 $39.99、对比表里另一个数」。
 */
const DEFAULTS: AmazonCalculatorInput = { ...CALCULATOR_DEFAULTS, calibrationCpc: undefined }

/**
 * 成本栏的字段与顺序。`readonly` 的项不是"禁用"，而是**由售价推导**：
 * 销售佣金固定 15%（见 shared/calculatorScenario.ts 的 REFERRAL_FEE_RATE），
 * 用户改售价即改佣金，改不了佣金本身 —— 少一个能和售价脱钩的数。
 */
const COST_FIELDS: Array<{ key: keyof AmazonCalculatorInput; label: string; hint?: string; percent?: boolean; readonly?: boolean }> = [
  { key: 'price', label: '售价', hint: 'USD / 件' },
  { key: 'unitCost', label: '采购成本', hint: 'USD / 件' },
  { key: 'freight', label: '头程运费', hint: 'USD / 件' },
  { key: 'fbaFee', label: 'FBA 配送费', hint: 'USD / 件' },
  { key: 'referralFee', label: '销售佣金', hint: `固定 ${REFERRAL_FEE_RATE * 100}% · 随售价自动计算`, readonly: true },
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
  const [packageInput, setPackageInput] = useState<PackageCalculatorInput>({ length: 15, width: 12, height: 8, weight: 2, quantity: 1, sizeUnit: 'in', weightUnit: 'lb' })
  /**
   * 外箱尺寸：跟着本机存。
   * 内盒不单独存 —— 内盒**就是**包裹尺寸，两边各存一份必然出现"预览装 4 件、面板算 6 件"。
   */
  const [cartonOuter, setCartonOuter] = useState<CartonSize>(() => {
    try {
      const saved = localStorage.getItem(CARTON_STORAGE_KEY)
      if (saved !== null) {
        const parsed = JSON.parse(saved) as Partial<CartonSize>
        if (typeof parsed.length === 'number' && typeof parsed.width === 'number' && typeof parsed.height === 'number') {
          return { length: parsed.length, width: parsed.width, height: parsed.height }
        }
      }
    } catch { /* 本机存储不可用时回落默认值 */ }
    return CARTON_DEFAULT
  })
  const [saved, setSaved] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== null } catch { return false }
  })
  const [scenarioName, setScenarioName] = useState('')
  const [scenarioNote, setScenarioNote] = useState('')
  const [scenarioMsg, setScenarioMsg] = useState('')
  /**
   * 真正参与计算的输入：佣金恒等于「售价 × 15%」。状态里仍保留 referralFee 字段
   * （本地缓存与老方案存过它），但计算、保存、带入 AI 一律用这份推导值 ——
   * 否则"载入的老方案佣金"和界面上的 15% 会各说各话。
   */
  const calcInput = useMemo(() => withFixedReferralFee(input), [input])
  const result = useMemo(() => calculateAmazonEconomics(calcInput), [calcInput])
  const bidResult = useMemo(() => calculateAmazonBid({ bid, placementPercent, maxMultiplier }), [bid, placementPercent, maxMultiplier])
  const packageResult = useMemo(() => calculatePackage(packageInput), [packageInput])

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

  function updatePackage(key: keyof PackageCalculatorInput, raw: string): void {
    if (key === 'sizeUnit' || key === 'weightUnit') {
      setPackageInput((current) => ({ ...current, [key]: raw }))
      return
    }
    setPackageInput((current) => ({ ...current, [key]: raw === '' ? 0 : Number(raw) }))
  }

  /** 外箱尺寸改动：空值沿用上一次，避免清空输入框时预览塌成 1 单位 */
  function updateCartonOuter(key: keyof CartonSize, raw: string): void {
    const value = raw === '' ? 0 : Number(raw)
    setCartonOuter((current) => {
      const next: CartonSize = { ...current, [key]: value > 0 ? value : current[key] }
      try { localStorage.setItem(CARTON_STORAGE_KEY, JSON.stringify(next)) } catch { /* 存不了就不存 */ }
      return next
    })
  }

  function update(key: keyof AmazonCalculatorInput, raw: string): void {
    const value = raw === '' && key === 'calibrationCpc' ? undefined : raw === '' ? 0 : Number(raw)
    setInput((current) => ({ ...current, [key]: value }))
  }

  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(calcInput))
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
      Object.entries(calcInput).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
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
          `售价：${money(calcInput.price)}；销售佣金：${money(calcInput.referralFee)}（固定 ${REFERRAL_FEE_RATE * 100}%）；有效单件贡献：${money(result.effectiveProfit)}；贡献率：${percent(result.marginRate)}`,
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
        <button className="wb-btn" type="button" onClick={save}>保存到本机</button>
      </header>

      <div className="wb-segmented wb-amazon-mode" role="tablist" aria-label="计算模式">
        <button className={`wb-seg ${mode === 'profit' ? 'on' : ''}`} type="button" role="tab" aria-selected={mode === 'profit'} onClick={() => setMode('profit')}>CPC 盈亏</button>
        <button className={`wb-seg ${mode === 'bid' ? 'on' : ''}`} type="button" role="tab" aria-selected={mode === 'bid'} onClick={() => setMode('bid')}>广告位出价</button>
        <button className={`wb-seg ${mode === 'package' ? 'on' : ''}`} type="button" role="tab" aria-selected={mode === 'package'} onClick={() => setMode('package')}>包裹运费</button>
        <button className={`wb-seg ${mode === 'carton' ? 'on' : ''}`} type="button" role="tab" aria-selected={mode === 'carton'} onClick={() => setMode('carton')}>外箱装箱</button>
      </div>

      {mode === 'profit' ? (
        <>
          <div className="wb-amazon-native-layout">
            <div className="wb-amazon-inputs">
              <h3 className="wb-amazon-section-title">产品成本与转化</h3>
              {COST_FIELDS.map(({ key, label, hint, percent: isPercent, readonly }) => {
                /**
                 * 后缀只有两种含义：百分比字段是 `%`；只读的销售佣金**不是百分比字段** ——
                 * 它是"售价 × 15%"算出来的**金额**。以前这里固定渲染 `15%`，于是输入框里是
                 * 金额（6.00）、右边写着 15%，同一个字段两套口径。
                 */
                const suffix = readonly === true ? null : isPercent ? '%' : null
                return (
                  <label className={`wb-amazon-field${readonly === true ? ' wb-amazon-field-fixed' : ''}`} key={key}>
                    <span>{label}{hint && <small>{hint}</small>}</span>
                    <span className={`wb-amazon-input-wrap${suffix === null ? '' : ' has-suffix'}`}>
                      <input aria-label={label} type="number" min="0" max={isPercent ? 100 : undefined} step={isPercent ? 0.1 : 0.01}
                        readOnly={readonly === true}
                        value={readonly === true
                          ? Number(calcInput[key]).toFixed(2)
                          : input[key] === undefined ? '' : isPercent ? input[key] * 100 : input[key]}
                        onChange={(event) => update(key, isPercent ? String(Number(event.target.value) / 100) : event.target.value)} />
                      {/* 单位不 aria-hidden：读屏要能听到"退货率 3 %"，不然数字没有量纲。 */}
                      {suffix !== null && <b>{suffix}</b>}
                    </span>
                  </label>
                )
              })}
              <h3 className="wb-amazon-section-title">投放参数</h3>
              <Field label="目标 ACOS" percent value={input.targetAcos * 100} onChange={(v) => update('targetAcos', String(Number(v) / 100))} />
              <Field label="转化率" percent value={input.conversionRate * 100} onChange={(v) => update('conversionRate', String(Number(v) / 100))} />
              <Field label="广告订单占比" percent value={input.adOrderShare * 100} onChange={(v) => update('adOrderShare', String(Number(v) / 100))} />
              <Field label="市场参考 CPC" hint="USD，仅供比较" value={input.marketCpc} onChange={(v) => update('marketCpc', v)} />
              <Field label="外部盈亏 CPC" hint="USD，用于校准" value={input.calibrationCpc ?? ''} onChange={(v) => update('calibrationCpc', v)} />
              {/**
               * 输入卡的收尾动作：**保存状态与被重置放在同一行**。
               * 原来"恢复默认值"占满整行（`grid-column: 1/-1` 的 .wb-btn），
               * 在视觉上比真正的主按钮还显眼，而它其实是个破坏性动作。
               */}
              <div className="wb-amazon-input-actions">
                <p className="wb-amazon-save-state" role="status">{saved ? '已保存在本机浏览器' : '参数尚未保存'}</p>
                <button className="wb-btn" type="button" onClick={() => { setInput(DEFAULTS); setSaved(false) }}>恢复默认值</button>
              </div>
            </div>
            <div className="wb-amazon-results" aria-live="polite">
              {!result.valid && <div className="wb-amazon-warning" role="alert">请检查输入：{result.errors.join('；')}</div>}
              {result.effectiveProfit <= 0 && <div className="wb-amazon-warning" role="status">有效单件贡献不为正，没有保本投放空间。</div>}
              <div className="wb-amazon-result-head"><div><span>盈亏平衡 CPC</span><strong>{money(result.breakEvenCpc)}</strong></div><div><span>有效贡献率</span><strong>{percent(result.marginRate)}</strong></div></div>
              {/**
               * 指标分两层：上面 4 个是**结论**（拿去做决策的数），下面 4 个是**核对用明细**
               * （安全值、成本合计、与外部数字的差值）。原来 8 个一样大，等于没有重点。
               */}
              <div className="wb-amazon-metrics">
                <Metric label="有效单件贡献" value={money(result.effectiveProfit)} />
                <Metric label="目标 ACOS CPC" value={money(result.suggestedCpc)} />
                <Metric label="盈亏平衡 ACOS" value={percent(result.breakEvenAcos)} />
                <Metric label="目标 ACOS 下广告后利润" value={money(result.profitAfterAds)} />
              </div>
              <div className="wb-amazon-metrics-caption">核对明细</div>
              <div className="wb-amazon-metrics wb-amazon-metrics-detail">
                <Metric label="盈亏 CPC 安全值 (80%)" value={money(result.breakEvenCpc === null ? null : result.breakEvenCpc * 0.8)} />
                <Metric label="单件成本合计" value={money(result.totalVariableCost)} />
                <Metric label="市场 CPC 差值" value={result.marketCpcGap === null ? '未提供' : money(result.marketCpcGap)} />
                <Metric label="外部计算器差值" value={result.calibrationCpcGap === null ? '未校准' : money(result.calibrationCpcGap)} />
              </div>
              <div className="wb-amazon-note">外部校准：<b>unknown</b>。录入相同输入下 cpc-compass 的盈亏 CPC 才可比较；当前没有可验证对照样本。</div>
              {/**
               * 计算口径默认收起：它是要"查得到"的依据，不是每次都要读的正文。
               * 展开而不是删除 —— 口径本身就是结论可信度的一部分。
               */}
              <details className="wb-amazon-disclosure">
                <summary>计算口径</summary>
                <p className="wb-amazon-footnote">预期贡献 = 售价 − 单件成本 − 退货期望损失。销售佣金固定按售价 {REFERRAL_FEE_RATE * 100}% 计（已含在单件成本里），改售价即重算佣金。盈亏平衡 CPC = 预期贡献 × 转化率；目标 ACOS CPC = 售价 × 转化率 × 目标 ACOS。实际费用按站点、尺寸、库龄及促销规则核验。</p>
              </details>
              <div className="wb-amazon-result-actions"><button className="wb-btn primary" type="button" disabled={!result.valid || !onSendToAI} onClick={sendResult}>带入 AI 协助</button></div>
            </div>
          </div>
        </>
      ) : mode === 'bid' ? (
        <div className="wb-amazon-native-layout wb-amazon-bid-layout">
          <div className="wb-amazon-inputs">
            <h3 className="wb-amazon-section-title">广告位参数</h3>
            <Field label="基础 Bid" hint="USD" value={bid} onChange={(v) => setBid(Number(v))} />
            <Field label="广告位加价" percent value={placementPercent} onChange={(v) => setPlacementPercent(Number(v))} />
            <Field label="最高倍数" hint="×" value={maxMultiplier} onChange={(v) => setMaxMultiplier(Number(v))} />
          </div>
          <div className="wb-amazon-results" aria-live="polite">
            <div className="wb-amazon-result-head"><div><span>最高 CPC</span><strong>{money(bidResult.highestCpc)}</strong></div><div><span>最高倍数</span><strong>{maxMultiplier.toFixed(2)}×</strong></div></div>
            <details className="wb-amazon-disclosure">
              <summary>计算口径</summary>
              <p className="wb-amazon-footnote">公式：Bid × (1 + 广告位加价 ÷ 100) × 最高倍数。只计算最高 CPC，不读取或修改广告账户。</p>
            </details>
            <div className="wb-amazon-result-actions"><button className="wb-btn primary" type="button" disabled={!bidResult.valid || !onSendToAI} onClick={sendResult}>带入 AI 协助</button></div>
          </div>
        </div>
      ) : mode === 'package' ? (
        <PackageCalculatorPanel input={packageInput} result={packageResult} update={updatePackage} />
      ) : (
        <CartonPanel
          inner={{ length: packageInput.length, width: packageInput.width, height: packageInput.height }}
          outer={cartonOuter}
          unit={packageInput.sizeUnit ?? 'in'}
          onOuter={updateCartonOuter}
        />
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

function PackageCalculatorPanel({ input, result, update }: { input: PackageCalculatorInput; result: ReturnType<typeof calculatePackage>; update: (key: keyof PackageCalculatorInput, value: string) => void }): JSX.Element {
  return <div className="wb-package-layout">
    <section className="wb-package-inputs" aria-labelledby="package-input-title">
      <div className="wb-package-section-head">
        <div><span className="wb-package-kicker">输入参数</span><h3 id="package-input-title">包裹尺寸与计费</h3></div>
        <span className="wb-package-unit-note">结果随输入更新</span>
      </div>
      <div className="wb-package-input-group">
        <h4>尺寸</h4>
        <div className="wb-package-dimension-grid">
          {(['length', 'width', 'height'] as const).map((key) => <Field key={key} label={{ length: '长', width: '宽', height: '高' }[key]} hint={input.sizeUnit === 'cm' ? 'cm' : 'in'} value={input[key]} onChange={(v) => update(key, v)} />)}
        </div>
        <label className="wb-amazon-field"><span>尺寸单位</span><select value={input.sizeUnit} onChange={(e) => update('sizeUnit', e.target.value as PackageSizeUnit)}><option value="in">英寸</option><option value="cm">厘米</option></select></label>
      </div>
      <div className="wb-package-input-group">
        <h4>重量</h4>
        <div className="wb-package-inline-grid">
          <Field label="重量" hint={input.weightUnit === 'kg' ? 'kg' : 'lb'} value={input.weight} onChange={(v) => update('weight', v)} />
          <label className="wb-amazon-field"><span>重量单位</span><select value={input.weightUnit} onChange={(e) => update('weightUnit', e.target.value as PackageWeightUnit)}><option value="lb">磅</option><option value="kg">千克</option></select></label>
        </div>
      </div>
      <div className="wb-package-input-group">
        <h4>计费参数</h4>
        <div className="wb-package-inline-grid">
          <Field label="箱数" value={input.quantity ?? 1} onChange={(v) => update('quantity', v)} />
          <Field label="售价" hint="可选，低于 $10 使用轻小调整" value={input.salePrice ?? ''} onChange={(v) => update('salePrice', v)} />
        </div>
      </div>
    </section>
    <section className="wb-package-results" aria-labelledby="package-result-title" aria-live="polite">
      {/* 飞机盒 3D 预览：尺寸一变就跟着变；只做可视化，不参与任何费用计算 */}
      <div className="wb-package-preview">
        <PackageBoxThree length={input.length} width={input.width} height={input.height} unit={input.sizeUnit ?? 'in'} />
      </div>
      <div className="wb-package-section-head"><div><span className="wb-package-kicker">计算结果</span><h3 id="package-result-title">配送与仓储</h3></div><span className="wb-package-class">{result.packageClass ?? '待核验'}</span></div>
      <div className="wb-package-alerts">
        {!result.valid && <div className="wb-amazon-warning" role="alert">请检查输入：{result.errors.join('；')}</div>}
        {result.warnings.map((warning) => <div className="wb-amazon-warning" role="status" key={warning}>{warning}</div>)}
      </div>
      <div className="wb-package-fee-head"><div><span>配送费 / 箱</span><strong>{result.shippingFee === null ? '待核验' : money(result.shippingFee)}</strong></div><div><span>总配送费</span><strong>{result.totalShippingFee === null ? '待核验' : money(result.totalShippingFee)}</strong></div></div>
      <div className="wb-package-metrics">
        <Metric label="计费重量" value={`${result.billableWeightLb.toFixed(2)} lb`} />
        <Metric label="尺寸分段" value={result.packageClass ?? '—'} />
        <Metric label="体积" value={`${result.volumeIn3.toFixed(2)} in³`} />
        <Metric label="月仓储费" value={money(result.monthlyStorageFee)} />
      </div>
      <p className="wb-amazon-footnote">配送费由共享纯函数计算；费率按 Excel 结构复刻，尚未与 F9 重算副本逐项对照。</p>
    </section>
  </div>
}

/**
 * 外箱装箱面板。
 *
 * 内盒**直接取包裹尺寸**，不另存一份 —— 否则「预览装 4 件、面板算 6 件」这种
 * 两张表两个结论的事故迟早会发生。单位也跟随包裹页。
 */
function CartonPanel({ inner, outer, unit, onOuter }: {
  inner: CartonSize
  outer: CartonSize
  unit: PackageSizeUnit
  onOuter: (key: keyof CartonSize, value: string) => void
}): JSX.Element {
  const pack = packCarton(outer, inner)
  const u = unit === 'cm' ? 'cm' : 'in'
  return <div className="wb-package-layout">
    <section className="wb-package-inputs" aria-labelledby="carton-input-title">
      <div className="wb-package-section-head">
        <div><span className="wb-package-kicker">装箱输入</span><h3 id="carton-input-title">外箱尺寸</h3></div>
        <span className="wb-package-unit-note">单位 {u}</span>
      </div>
      <div className="wb-package-input-group">
        <h4>外箱（RSC 开槽箱）</h4>
        <div className="wb-package-dimension-grid">
          {(['length', 'width', 'height'] as const).map((key) => (
            <Field key={key} label={{ length: '长', width: '宽', height: '高' }[key]} hint={u} value={outer[key]} onChange={(v) => onOuter(key, v)} />
          ))}
        </div>
      </div>
      <div className="wb-package-input-group">
        <h4>内盒（= 包裹尺寸）</h4>
        <p className="wb-amazon-footnote">
          取自「包裹运费」页：{inner.length} × {inner.width} × {inner.height} {u}。改包裹尺寸，装箱结果会同步变。
        </p>
      </div>
      <p className="wb-amazon-footnote">数量按 <b>单一朝向</b>枚举 6 种摆放取最大；同一箱里混排两种朝向不做 —— 那类结果没法向人解释清楚。</p>
    </section>

    <section className="wb-package-results" aria-labelledby="carton-result-title">
      <div className="wb-package-preview">
        <CartonBox3D inner={inner} outer={outer} />
      </div>
      <div className="wb-package-section-head">
        <div><span className="wb-package-kicker">装箱结果</span><h3 id="carton-result-title">每箱件数</h3></div>
        <span className="wb-package-class">{pack.count > 0 ? `${pack.nx} × ${pack.ny} × ${pack.nz}` : '装不下'}</span>
      </div>
      <div className="wb-package-fee-head">
        <div><span>每箱可装</span><strong>{pack.count} 件</strong></div>
        <div><span>装载率</span><strong>{Math.round(pack.fillRate * 100)}%</strong></div>
      </div>
      <div className="wb-package-metrics">
        <Metric label="单件占位" value={pack.count > 0 ? `${pack.fitLength} × ${pack.fitWidth} × ${pack.fitHeight}` : '—'} />
        <Metric label="长向余量" value={`${pack.restLength.toFixed(1)} ${u}`} />
        <Metric label="宽向余量" value={`${pack.restWidth.toFixed(1)} ${u}`} />
        <Metric label="高向余量" value={`${pack.restHeight.toFixed(1)} ${u}`} />
      </div>
      <p className="wb-amazon-footnote">装载率 = 内盒体积 × 件数 ÷ 外箱体积，剩下的就是填充物与空隙。余量是三个方向分别剩的净空。</p>
    </section>
  </div>
}

/**
 * 通用数值字段。百分比后缀挂在输入框**内部**右缘（`has-suffix`），
 * 而不是让它被 flex 推到整列最右边 —— 后者在宽面板里离数字 200px 远，读起来像两个不相干的元素。
 */
function Field({ label, value, onChange, hint, percent: isPercent }: { label: string; value: number | string; onChange: (value: string) => void; hint?: string; percent?: boolean }): JSX.Element {
  return (
    <label className="wb-amazon-field">
      <span>{label}{hint && <small>{hint}</small>}</span>
      <span className={`wb-amazon-input-wrap${isPercent === true ? ' has-suffix' : ''}`}>
        <input aria-label={label} type="number" min="0" step="0.01" value={value} onChange={(event) => onChange(event.target.value)} />
        {isPercent === true && <b>%</b>}
      </span>
    </label>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="wb-amazon-metric"><span>{label}</span><strong>{value}</strong></div>
}
