/**
 * v1.18：搜索词数据集的持久化与 AI 写回。
 *
 * 为什么要专门测仓储：这份数据是「UI 导入 → agent 读 → agent 写回 → UI 显示」的
 * **唯一载体**。如果写回能悄悄把非法 action 落库、或者重新导入把旧建议冲掉，
 * 界面看起来一切正常，但 AI 的结论已经对不上了 —— 这类错误只能靠仓储级断言抓。
 *
 * 迁移只碰内存库（`:memory:`），绝不拿用户真库试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import {
  createAmazonDataset, deleteAmazonDataset, getAmazonDataset, getLatestAmazonDataset,
  listAmazonDatasets, saveAmazonDatasetSummary, saveSearchTermReview,
} from '../lib/db/repo.js'

function openMemoryDb() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  seedDictionaries(db)
  return db
}

const ROWS = [
  { keyword: 'tig torch cup', impressions: 1200, clicks: 18, orders: 2, spend: 9.5, sales: 45 },
  { keyword: 'mig gloves', impressions: 300, clicks: 0, orders: 0, spend: 0, sales: 0 },
]

test('schema 与迁移表一致，且迁移可重复执行（幂等）', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
  const db = openMemoryDb()
  migrate(db)
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='amazon_datasets'").get()
  assert.equal(table?.name, 'amazon_datasets')
})

test('导入 → 读取 → 列表：行数据原样保存，不带派生指标', () => {
  const db = openMemoryDb()
  const created = createAmazonDataset(db, { title: 'US 搜索词 10/11-10/17', period: '2026-10-11~2026-10-17', rows: ROWS })
  assert.equal(created.rows.length, 2)
  assert.equal(created.rows[0].keyword, 'tig torch cup')
  assert.equal('ctr' in created.rows[0], false, '库里不存派生指标（算法变了旧快照就是假数据）')

  const latest = getLatestAmazonDataset(db)
  assert.equal(latest?.id, created.id)
  const list = listAmazonDatasets(db)
  assert.equal(list.length, 1)
  assert.equal(list[0].rowCount, 2)
  assert.equal(list[0].annotationCount, 0)
})

test('AI 写回建议：非法 action 被拒，同词后者覆盖前者', () => {
  const db = openMemoryDb()
  const dataset = createAmazonDataset(db, { title: 't', rows: ROWS })

  assert.throws(
    () => saveSearchTermReview(db, dataset.id, [{ keyword: 'mig gloves', action: 'delete_campaign' }]),
    /review\.action 非法/,
  )
  assert.equal(getAmazonDataset(db, dataset.id)?.annotations.length, 0, '被拒的写回不得留下半条脏数据')

  const updated = saveSearchTermReview(db, dataset.id, [
    { keyword: 'mig gloves', action: 'watch', reason: '曝光低', evidence: 'derived' },
    { keyword: 'mig gloves', action: 'negative_exact', reason: '300 曝光 0 点击先否精准', evidence: 'observed' },
  ])
  assert.equal(updated.annotations.length, 1)
  assert.equal(updated.annotations[0].action, 'negative_exact')
  assert.equal(updated.annotations[0].evidence, 'observed')
})

test('保存建议不覆盖行数据；重新导入不影响已存数据集', () => {
  const db = openMemoryDb()
  const first = createAmazonDataset(db, { title: '第一批', rows: ROWS })
  saveSearchTermReview(db, first.id, [{ keyword: 'tig torch cup', action: 'add_exact', reason: '有单低 ACOS' }])
  const second = createAmazonDataset(db, { title: '第二批', rows: ROWS })

  assert.equal(getAmazonDataset(db, first.id)?.rows.length, 2, '写回建议不得动 rows_json')
  assert.equal(getAmazonDataset(db, second.id)?.annotations.length, 0, '新导入的数据集不该继承上一份建议')
  assert.equal(getLatestAmazonDataset(db)?.id, second.id)
  assert.equal(listAmazonDatasets(db).length, 2)
})

test('删除数据集后不再出现在列表与最近一份里', () => {
  const db = openMemoryDb()
  const dataset = createAmazonDataset(db, { title: 't', rows: ROWS })
  assert.equal(deleteAmazonDataset(db, dataset.id), true)
  assert.equal(deleteAmazonDataset(db, dataset.id), false)
  assert.equal(getAmazonDataset(db, dataset.id), undefined)
  assert.equal(listAmazonDatasets(db).length, 0)
  assert.equal(getLatestAmazonDataset(db), undefined)
})

/**
 * schema 34：报表级结论（`ai_summary`）。
 *
 * 这一列**必须整份替换**：结论里的条数、花费、总额来自同一次分析，
 * 逐字段 merge 会拼出"上次的条数 + 这次的花费"这种不可能同时成立的组合。
 */
const SUMMARY_A = {
  version: 1,
  totals: { impressions: 1500, clicks: 18, orders: 2, spend: 9.5, sales: 45, acos: 0.2111 },
  rows: 2,
  uniqueKeywords: 2,
  distribution: { negative: 0, add: 1, watch: 1 },
  negativeSpend: 0,
  notes: ['报表缺广告组，否词需按投放单元复核'],
}
const SUMMARY_B = { version: 1, rows: 2, uniqueKeywords: 1, notes: ['重新分析后的结论'] }

test('报表级结论：整份替换，不碰行数据与词级建议', () => {
  const db = openMemoryDb()
  const dataset = createAmazonDataset(db, { title: 't', rows: ROWS })
  assert.equal(dataset.aiSummary, null, '刚导入时没有报表级结论')
  saveSearchTermReview(db, dataset.id, [{ keyword: 'mig gloves', action: 'watch', reason: '先观察' }])

  const withA = saveAmazonDatasetSummary(db, dataset.id, SUMMARY_A)
  assert.deepEqual(withA.aiSummary, SUMMARY_A)
  assert.equal(withA.rows.length, 2, '写结论不得动 rows_json')
  assert.equal(withA.annotations.length, 1, '写结论不得动词级建议')

  // 第二次写：整份替换，A 里的 totals/distribution 不能残留
  const withB = saveAmazonDatasetSummary(db, dataset.id, SUMMARY_B)
  assert.deepEqual(withB.aiSummary, SUMMARY_B)
  assert.equal('totals' in withB.aiSummary, false, '整份替换不能 merge 出旧字段')

  // null = 清空结论（回到"还没做过"），与老行语义一致
  assert.equal(saveAmazonDatasetSummary(db, dataset.id, null).aiSummary, null)
  assert.throws(() => saveAmazonDatasetSummary(db, 'missing', SUMMARY_A), /dataset not found/)
})

test('老行与坏 JSON 都按 null 处理，不迁移数据也不抛错', () => {
  const db = openMemoryDb()
  const created = createAmazonDataset(db, { title: 't', rows: ROWS })
  // 模拟 schema 34 之前写入的行：不指定 ai_summary，取列默认值 NULL
  db.prepare(`INSERT INTO amazon_datasets
    (id, kind_code, title, period, rows_json, annotations_json, source_code, session_id, created_at, updated_at)
    VALUES (?, 'search_term', '老报表', NULL, ?, '[]', 'paste', NULL, ?, ?)`)
    .run('legacy', JSON.stringify(ROWS), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
  assert.equal(getAmazonDataset(db, 'legacy')?.aiSummary, null, '老行读出来是 null，不是空对象')

  for (const broken of ['{oops', '[]', '"text"']) {
    db.prepare('UPDATE amazon_datasets SET ai_summary = ? WHERE id = ?').run(broken, created.id)
    assert.equal(getAmazonDataset(db, created.id)?.aiSummary, null, `坏值 ${broken} 应降级为 null`)
  }
})
