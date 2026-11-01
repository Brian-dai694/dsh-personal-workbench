/**
 * 外箱重量与亚马逊 23 kg 入仓上限（v1.18.0 补丁）。
 *
 * 这组断言盯四件事：
 * 1. **边界口径**：恰好 23 kg 放行、23.01 kg 报警 —— 用户的原话是「大于 23kg 需要提醒」，
 *    不是「达到 23kg 就提示」；
 * 2. **单位不混也联动**：包裹页可以是 lb，箱材输入跟随它显示，但判定与记录一律折算成 kg ——
 *    切换单位只能换显示口径，不许把「0.5 kg 箱材」悄悄变成「0.5 lb」；
 * 3. **箱材/填充必须计入**：只算商品重量会让"看着合格、实际超重"的箱子出库；
 * 4. **面板真的接了这条结论**：超重要用 `role="alert"` 出提醒，而不是藏在脚注里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AMAZON_CARTON_WEIGHT_LIMIT_KG, checkCartonWeight, fromKg, toKg } from '../lib/shared/cartonPacking.js'
import { openWorkbenchDb } from '../lib/db/database.js'
import { createPackagingDimension, listPackagingDimensions } from '../lib/db/repo.js'

const VIEW = readFileSync(new URL('../src/client/views/AmazonToolsView.tsx', import.meta.url), 'utf8')
const SHARED = readFileSync(new URL('../src/shared/cartonPacking.ts', import.meta.url), 'utf8')

test('23 kg 是硬上限：恰好 23 kg 放行，超出即报警', () => {
  assert.equal(AMAZON_CARTON_WEIGHT_LIMIT_KG, 23)
  const exact = checkCartonWeight({ unitWeight: 23, unit: 'kg', count: 1 })
  assert.equal(exact.totalKg, 23)
  assert.equal(exact.overweight, false)
  assert.match(exact.message, /上限内/)

  const over = checkCartonWeight({ unitWeight: 23.01, unit: 'kg', count: 1 })
  assert.equal(over.overweight, true)
  assert.equal(over.excessKg, 0.01)
  assert.match(over.message, /超过亚马逊 23 kg 上限/)
  assert.match(over.message, /Team Lift/, '超重要给出可执行的处理方式，不只是报错')
  assert.match(over.message, /更小的包裹/, '单件就超重时不能靠「减件数」给假方案')
})

test('磅/公斤不混：包裹页用 lb 时先换算再与 23 kg 比', () => {
  const fifty = checkCartonWeight({ unitWeight: 50, unit: 'lb', count: 1 })
  assert.equal(fifty.totalKg, 22.68)
  assert.equal(fifty.overweight, false)

  const fiftyOne = checkCartonWeight({ unitWeight: 51, unit: 'lb', count: 1 })
  assert.equal(fiftyOne.overweight, true)
  assert.match(fiftyOne.message, /少装几件也解决不了/, '单件本身超重时不能靠减件数误导用户')
  assert.equal(fiftyOne.maxUnitsUnderLimit, 0)
})

test('箱材/填充计入毛重，并反推每箱最多件数', () => {
  const packed = checkCartonWeight({ unitWeight: 2, unit: 'kg', count: 10, packagingWeightKg: 1 })
  assert.equal(packed.totalKg, 21)
  assert.equal(packed.overweight, false)
  assert.equal(packed.maxUnitsUnderLimit, 11)

  const tooHeavy = checkCartonWeight({ unitWeight: 2, unit: 'kg', count: 12, packagingWeightKg: 1 })
  assert.equal(tooHeavy.totalKg, 25)
  assert.equal(tooHeavy.overweight, true)
  assert.equal(tooHeavy.excessKg, 2)
  assert.match(tooHeavy.message, /每箱最多 11 件/, '提醒要顺手给出可行的拆箱件数')
  assert.match(tooHeavy.message, /拆箱/)

  /** 件数为 0（外箱装不下）或重量没填：不给结论，也不假报"合格"。 */
  for (const input of [
    { unitWeight: 2, unit: 'kg', count: 0 },
    { unitWeight: 0, unit: 'kg', count: 5 },
    { unitWeight: Number.NaN, unit: 'lb', count: 5 },
  ]) {
    const unknown = checkCartonWeight(input)
    assert.equal(unknown.overweight, false)
    assert.equal(unknown.totalKg, 0)
    assert.match(unknown.message, /填入单件重量与每箱件数/)
  }
})

test('单位联动：箱材输入跟随包裹页显示，状态与判定始终用 kg', () => {
  assert.equal(toKg(1, 'kg'), 1)
  assert.equal(Math.round(toKg(1, 'lb') * 1000) / 1000, 0.454)
  assert.equal(fromKg(0.45359237, 'lb'), 1)
  /** 0.5 kg 箱材切到磅必须显示 1.1 lb，而不是继续写着 0.5。 */
  assert.equal(Math.round(fromKg(0.5, 'lb') * 10) / 10, 1.1)
  /** 判定只吃 kg：10 lb × 2 件 + 0.5 kg 箱材 = 9.57 kg（没超）。 */
  const check = checkCartonWeight({ unitWeight: 10, unit: 'lb', count: 2, packagingWeightKg: 0.5 })
  assert.equal(check.totalKg, 9.57)
  assert.equal(check.overweight, false)

  const panelStart = VIEW.indexOf('function CartonPanel(')
  const panel = VIEW.slice(panelStart, VIEW.indexOf('\nfunction Field(', panelStart))
  assert.match(panel, /hint=\{weightUnit === 'kg' \? 'kg' : 'lb'\}/, '箱材输入的单位标记必须跟着包裹页')
  assert.match(panel, /const tareDisplay = Math\.round\(fromKg\(tare, weightUnit\) \* 100\) \/ 100/)
  assert.match(panel, /value=\{tareDisplay\}/)
  assert.match(VIEW, /setCartonTare\(toKg\(raw === '' \? 0 : Number\(raw\), packageInput\.weightUnit \?\? 'lb'\)\)/,
    '录入必须折算成 kg 再存，切单位才不会改掉物理重量')
})

test('面板接线：重量输入、23 kg 提醒与单箱毛重指标都在', () => {
  assert.match(SHARED, /export function checkCartonWeight\(/)
  assert.match(SHARED, /export const AMAZON_CARTON_WEIGHT_LIMIT_KG = 23/)
  const panelStart = VIEW.indexOf('function CartonPanel(')
  const panelEnd = VIEW.indexOf('\nfunction Field(', panelStart)
  const panel = VIEW.slice(panelStart, panelEnd)
  assert.match(panel, /checkCartonWeight\(\{ unitWeight, unit: weightUnit, count: pack\.count, packagingWeightKg: tare \}\)/)
  assert.match(panel, /<h4>重量<\/h4>/)
  assert.match(panel, /label="箱材 \+ 填充"/)
  assert.match(panel, /role="alert"/, '超重必须是 alert，不能只是脚注')
  assert.match(panel, /单箱毛重/)
  assert.match(panel, /单箱上限/)
  assert.match(panel, /Team Lift/)
  assert.match(panel, /按重量每箱上限/)
  // 重量必须能从本地缓存与尺寸记录里回来，否则每次打开都要重填
  assert.match(VIEW, /localStorage\.setItem\(CARTON_TARE_STORAGE_KEY, JSON\.stringify\(cartonTare\)\)/)
  assert.match(VIEW, /cartonWeightKg: current\.cartonTare/)
  assert.match(VIEW, /data\.cartonWeightKg/)
})

test('尺寸记录：箱材重量可选（老记录照常），非法值不许静默写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-carton-weight-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try {
    const base = {
      name: 'YB2301-1 标准包装', sku: 'yb2301',
      data: {
        packageLength: 15, packageWidth: 12, packageHeight: 8, packageWeight: 2, quantity: 1,
        sizeUnit: 'in', weightUnit: 'lb',
        cartonLength: 24, cartonWidth: 18, cartonHeight: 12,
      },
    }
    /** 老记录：没有 cartonWeightKg 也能存、也能读回来。 */
    const legacy = createPackagingDimension(db, base)
    assert.equal(legacy.data.cartonWeightKg, undefined)

    const withTare = createPackagingDimension(db, { ...base, name: '带箱材', data: { ...base.data, cartonWeightKg: 0.5 } })
    assert.equal(withTare.data.cartonWeightKg, 0.5)
    assert.equal(listPackagingDimensions(db).length, 2)

    for (const bad of [-1, Number.NaN, '0.5']) {
      assert.throws(
        () => createPackagingDimension(db, { ...base, name: '非法箱材', data: { ...base.data, cartonWeightKg: bad } }),
        /箱材\/填充重量必须是非负有效数字/,
      )
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
