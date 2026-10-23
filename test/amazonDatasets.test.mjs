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
  listAmazonDatasets, saveSearchTermReview,
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
