/**
 * 库存补货测算 + 快照仓储测试（migration 31）。
 *
 * 为什么这些断言重要：
 * - 断货日是**给采购下单用的日期**，用过期盘点算出来的日期比不给更危险；
 * - 在途/计划到仓如果被当成库存，会直接导致"以为够卖、实际断货"；
 * - 负库存是进销存不闭合的信号，静默夹到 0 就再也看不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../lib/db/database.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import {
  STALE_DAYS, analyseInventory, inventoryToCsv, parseInventoryCsv,
} from '../lib/shared/inventoryForecast.js'
import {
  createInventorySnapshot, deleteInventorySnapshot, getLatestInventorySnapshot, listInventorySnapshots,
} from '../lib/db/repo.js'

const TODAY = new Date('2026-10-24T00:00:00Z')

function row(overrides = {}) {
  return { sku: 'TIG-CUP-9', onHandStart: 600, arrivals: 200, sold: 450, inboundPlanned: 0, dailyTarget: null, ...overrides }
}

test('在手 = 期初 + 已到仓 − 销量；可售天数与断货日按今天算', () => {
  const result = analyseInventory([row()], { windowDays: 30, countedAt: '2026-10-20', leadTimeDays: 30, safetyDays: 15, today: TODAY })
  const metric = result.rows[0]
  assert.equal(metric.currentStock, 350)
  assert.equal(metric.dailyRate, 15)
  assert.equal(metric.daysOfCover, 23.33)
  // 2026-10-24 + 23.33 天 ≈ 2026-11-16
  assert.equal(metric.stockoutDate, '2026-11-16')
  assert.equal(result.stale, false)
})

test('在途不算库存：只从补货缺口里扣', () => {
  const without = analyseInventory([row({ inboundPlanned: 0 })], { windowDays: 30, countedAt: '2026-10-20', leadTimeDays: 30, safetyDays: 15, today: TODAY })
  const withInbound = analyseInventory([row({ inboundPlanned: 300 })], { windowDays: 30, countedAt: '2026-10-20', leadTimeDays: 30, safetyDays: 15, today: TODAY })
  assert.equal(without.rows[0].currentStock, withInbound.rows[0].currentStock) // 在手不变
  assert.equal(withInbound.rows[0].replenishQty, Math.max(0, without.rows[0].replenishQty - 300))
})

test('数据过期（> 30 天）就不给断货日，但保留可售天数', () => {
  const staleDate = '2026-08-01'
  const result = analyseInventory([row()], { windowDays: 30, countedAt: staleDate, leadTimeDays: 30, safetyDays: 15, today: TODAY })
  assert.equal(result.stale, true)
  assert.equal(result.rows[0].stockoutDate, null)
  assert.equal(result.rows[0].daysOfCover, 23.33)
  assert.ok(result.rows[0].gaps.includes('数据过期'))
  assert.equal(STALE_DAYS, 30)
})

test('负库存被标记而不是夹到 0；无销量时不给可售天数', () => {
  const result = analyseInventory([
    row({ sku: 'NEG', onHandStart: 10, arrivals: 0, sold: 50 }),
    row({ sku: 'NOSALE', onHandStart: 100, arrivals: 0, sold: 0 }),
  ], { windowDays: 30, countedAt: '2026-10-20', leadTimeDays: 30, safetyDays: 15, today: TODAY })
  const neg = result.rows[0]
  assert.equal(neg.currentStock, -40)
  assert.ok(neg.gaps.includes('负库存'))
  const noSale = result.rows[1]
  assert.equal(noSale.daysOfCover, null)
  assert.equal(noSale.stockoutDate, null)
  assert.ok(noSale.gaps.includes('无销量'))
  assert.equal(result.kpi.outOfStock, 1)
})

test('解析：中英别名、自动读统计天数与盘点日期、缺列拒绝', () => {
  const text = [
    '统计天数: 30',
    '盘点日期: 2026-10-01',
    'SKU\t期初库存\t期间到货\t期间销量\t在途',
    'TIG-CUP-9\t600\t200\t450\t100',
  ].join('\n')
  const parsed = parseInventoryCsv(text)
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.windowDays, 30)
  assert.equal(parsed.countedAt, '2026-10-01')
  assert.equal(parsed.rows[0].inboundPlanned, 100)

  const missing = parseInventoryCsv('SKU\t期初库存\nA\t1')
  assert.equal(missing.ok, false)
  assert.ok(missing.errors[0].includes('期间销量'), missing.errors[0])
})

test('导出补货 CSV：缺口列可读，含逗号会转义', () => {
  const result = analyseInventory([row({ sku: 'A,B' })], { windowDays: 30, countedAt: '2026-10-20', leadTimeDays: 30, safetyDays: 15, today: TODAY })
  const csv = inventoryToCsv(result.rows)
  assert.equal(csv.split('\n')[0], 'SKU,ASIN,在手,日均,可售天数,断货日,建议补货,缺口')
  assert.ok(csv.includes('"A,B"'))
})

test('快照仓储：迁移 31 建表、写入/读取/列表/删除，参数越界拒绝', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const created = createInventorySnapshot(db, {
    title: '10 月盘点', countedAt: '2026-10-20', windowDays: 30, leadTimeDays: 30, safetyDays: 15, rows: [row()],
  })
  assert.equal(created.rows.length, 1)
  assert.equal(getLatestInventorySnapshot(db)?.id, created.id)
  assert.equal(listInventorySnapshots(db)[0].rowCount, 1)
  assert.throws(() => createInventorySnapshot(db, { title: 'x', countedAt: '2026-10-20', windowDays: 0, rows: [row()] }), /windowDays/)
  assert.throws(() => createInventorySnapshot(db, { title: 'x', countedAt: 'not-a-date', windowDays: 30, rows: [row()] }), /countedAt/)
  assert.equal(deleteInventorySnapshot(db, created.id), true)
  assert.equal(getLatestInventorySnapshot(db), undefined)
})
