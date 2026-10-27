/**
 * 选品判断库（migration 30）仓储级测试。
 *
 * 为什么要测仓储：
 * - 判断结论要能被**筛选**（`verdict` 提成列）与**局部更新**（点一下结论不该抹掉 VOC）；
 * - 技能回写是机器调用，非法值必须在写库前拒绝，而不是静默变成一个怪状态；
 * - 这些错在界面上都表现为"看起来有数据"，只有断言能抓住。
 * 迁移只碰内存库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../lib/db/database.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import {
  asinFacets, importAsinProducts, listAsinJudgments, queryAsinPage, setAsinJudgment,
} from '../lib/db/repo.js'

function openMemoryDb() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

function product(asin, overrides = {}) {
  return {
    asin, site: 'US', title: `夹具 ${asin}`, currentTitle: null, imageUrl: null, url: null,
    price: 19.9, currency: 'USD', rating: 4.5, reviews: 100, bsr: 1000,
    brand: 'YOBEL', seller: 'YOBEL', shopId: 'SHOP1', shopName: 'YOBEL 官方店',
    category: '焊枪', note: null, tags: [], extraJson: '{}',
    addedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function seed(db) {
  importAsinProducts(db, [product('B0JUDGE001'), product('B0JUDGE002')], [], 0, null)
}

test('迁移到 30 后，asin_products 有判断字段且默认是未判断', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
  const db = openMemoryDb()
  const columns = db.prepare('PRAGMA table_info(asin_products)').all().map((row) => row.name)
  for (const name of ['verdict', 'score', 'judgment_json', 'judged_at', 'judged_source']) {
    assert.ok(columns.includes(name), `缺列 ${name}`)
  }
  seed(db)
  const page = queryAsinPage(db)
  assert.equal(page.items[0].judgment.verdict, 'none')
  assert.equal(page.items[0].judgment.score, null)
})

test('写入判断后可按结论筛选，且 facet 给出各结论条数', () => {
  const db = openMemoryDb()
  seed(db)
  setAsinJudgment(db, 'B0JUDGE001', {
    verdict: 'do', score: 82, nextAction: '先做 20 件小批量验证气密性',
    criteria: [{ name: '需求', value: '7/10' }],
    painPoints: [{ label: '气体保护失效', count: 8 }],
    risk: { level: 'low', note: '未查到近似商标' },
    keywordCount: 37, source: 'amazon-selection-human-plus',
  })
  setAsinJudgment(db, 'B0JUDGE002', { verdict: 'drop', score: 28, source: 'manual' })

  assert.equal(queryAsinPage(db, { verdict: 'do' }).total, 1)
  assert.equal(queryAsinPage(db, { verdict: 'drop' }).total, 1)
  assert.equal(queryAsinPage(db, { verdict: 'none' }).total, 0)

  const row = queryAsinPage(db, { verdict: 'do' }).items[0]
  assert.equal(row.judgment.score, 82)
  assert.equal(row.judgment.criteria.length, 1)
  assert.equal(row.judgment.painPoints[0].label, '气体保护失效')
  assert.equal(row.judgment.judgedSource, 'amazon-selection-human-plus')
  assert.ok(row.judgment.judgedAt !== null)

  const facets = asinFacets(db)
  const byVerdict = new Map(facets.verdicts.map((f) => [f.value, f.count]))
  assert.equal(byVerdict.get('do'), 1)
  assert.equal(byVerdict.get('drop'), 1)
})

test('只改结论不会抹掉已有的 VOC / 评分卡 / 风险 / 覆盖词数', () => {
  const db = openMemoryDb()
  seed(db)
  setAsinJudgment(db, 'B0JUDGE001', {
    verdict: 'do', score: 82,
    criteria: [{ name: '壁垒', value: '气密性' }],
    painPoints: [{ label: '用不了', count: 41 }],
    risk: { level: 'medium', note: '图形近似' },
    keywordCount: 37,
  })
  // 界面上点一下 chip：只传 verdict
  setAsinJudgment(db, 'B0JUDGE001', { verdict: 'watch' })
  const row = queryAsinPage(db, { verdict: 'watch' }).items[0]
  assert.equal(row.judgment.score, 82)
  assert.equal(row.judgment.criteria[0].value, '气密性')
  assert.equal(row.judgment.painPoints[0].count, 41)
  assert.equal(row.judgment.risk.level, 'medium')
  assert.equal(row.judgment.keywordCount, 37)
})

test('非法写入被拒绝：结论枚举 / 分数越界 / 负词数 / 不存在的 ASIN', () => {
  const db = openMemoryDb()
  seed(db)
  assert.throws(() => setAsinJudgment(db, 'B0JUDGE001', { verdict: 'maybe' }), /verdict 非法/)
  assert.throws(() => setAsinJudgment(db, 'B0JUDGE001', { verdict: 'do', score: 101 }), /score 必须是 0–100/)
  assert.throws(() => setAsinJudgment(db, 'B0JUDGE001', { verdict: 'do', keywordCount: -1 }), /keywordCount/)
  assert.throws(() => setAsinJudgment(db, 'B0NOPE0001', { verdict: 'do' }), /asin not found/)
})

test('agent 读通道：按结论倒序取判断，未判断的不出现在结果里', () => {
  const db = openMemoryDb()
  seed(db)
  setAsinJudgment(db, 'B0JUDGE001', { verdict: 'do', score: 60 })
  setAsinJudgment(db, 'B0JUDGE002', { verdict: 'do', score: 90 })
  const rows = listAsinJudgments(db, 'do')
  assert.deepEqual(rows.map((row) => row.asin), ['B0JUDGE002', 'B0JUDGE001'])
  assert.equal(listAsinJudgments(db, 'watch').length, 0)
})
