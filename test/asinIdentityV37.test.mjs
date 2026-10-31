/**
 * P1：schema v37 影子表 + 复核队列的迁移回归。
 *
 * 断言重点是“不猜、不改旧表、可重跑”：
 * 1. 有效 site 才进 v2；缺失/非法 site 只进 migration_review；
 * 2. 孤儿快照只进复核队列，不补建产品；
 * 3. 判断写 asin_judgments 版本 1，不动 v1 行；
 * 4. 第二次回填 0 新增，v1 行数与字段原样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkbenchDb } from '../lib/db/database.js'
import { backfillAsinIdentityV37, normalizeSite } from '../lib/db/asinIdentityV37.js'
import { MIGRATIONS } from '../lib/db/schema.js'

function seed(db) {
  const now = '2026-10-29T00:00:00.000Z'
  const product = db.prepare(`
    INSERT INTO asin_products (asin, title, tags_json, added_at, updated_at, site, verdict, score, judgment_json, judged_at, judged_source)
    VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  product.run('B0AAAAAAAA', 'US 有效品', now, now, 'US', 'do', 82, '{"risk":"low"}', now, 'manual')
  product.run('B0BBBBBBBB', '无站点品', now, now, null, 'none', null, '{}', null, null)
  product.run('B0CCCCCCCC', '坏站点品', now, now, 'USA', 'none', null, '{}', null, null)
  product.run('SHORT', '坏 ASIN', now, now, 'US', 'none', null, '{}', null, null)

  const snapshot = db.prepare('INSERT INTO asin_snapshots (id, asin, captured_at, price) VALUES (?, ?, ?, ?)')
  snapshot.run('s-valid', 'B0AAAAAAAA', '2026-10-01T00:00:00Z', 19.99)
  snapshot.run('s-orphan', 'B0ZZZZZZZZ', '2026-10-01T00:00:00Z', 9.99)

  const log = db.prepare(`
    INSERT INTO oplog_entries (id, log_type, title, created_at, updated_at, asin_json, shop_id, site)
    VALUES (?, '复盘', ?, ?, ?, ?, 'YOBEL', ?)
  `)
  log.run('log-null-site', '无站点日志', now, now, JSON.stringify(['B0AAAAAAAA']), null)
  log.run('log-bad-site', '坏站点日志', now, now, '[]', 'USA')
  log.run('log-us', 'US 日志', now, now, '[]', 'US')
}

test('v37 迁移：只增表、只回填；未知 site 不回填 US', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    /** 迁移跑到最新（现在是 38）；这里只关心 v37 的表已经建好。 */
    assert.equal(
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      String(Math.max(...MIGRATIONS.map((migration) => migration.version))),
    )
    for (const table of ['asin_products_v2', 'asin_snapshots_v2', 'asin_judgments', 'asin_relations', 'asin_skus', 'migration_review']) {
      assert.ok(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(table), `缺表 ${table}`)
    }

    seed(db)
    const first = backfillAsinIdentityV37(db)
    assert.equal(first.products.source, 4)
    assert.equal(first.products.inserted, 1, '只有 US 有效行进 v2')
    assert.equal(first.snapshots.inserted, 1)
    assert.equal(first.judgments.inserted, 1)

    const v2 = db.prepare('SELECT site, asin FROM asin_products_v2 ORDER BY asin').all()
    assert.deepEqual(v2.map((row) => ({ site: row.site, asin: row.asin })), [{ site: 'US', asin: 'B0AAAAAAAA' }])
    assert.equal(db.prepare("SELECT 1 AS x FROM asin_products_v2 WHERE asin = 'B0BBBBBBBB'").get(), undefined, '缺失 site 不得默认 US')

    const reasons = db.prepare('SELECT source_table AS t, source_key AS k, reason AS r FROM migration_review ORDER BY reason, source_key').all()
    const pairs = reasons.map((row) => `${row.t}:${row.k}:${row.r}`)
    assert.ok(pairs.includes('asin_products:B0BBBBBBBB:site_unknown'))
    assert.ok(pairs.includes('asin_products:B0CCCCCCCC:site_unknown'))
    assert.ok(pairs.includes('asin_products:SHORT:asin_invalid'))
    assert.ok(pairs.includes('asin_snapshots:s-orphan:snapshot_orphan'))
    assert.ok(pairs.includes('oplog_entries:log-null-site:site_unknown'))
    assert.ok(pairs.includes('oplog_entries:log-bad-site:site_invalid'))
    assert.equal(pairs.some((pair) => pair.includes('log-us')), false, 'US 日志不该进复核')

    const judged = db.prepare('SELECT site, asin, version, verdict FROM asin_judgments').all()
    assert.deepEqual(judged.map((row) => ({ site: row.site, asin: row.asin, version: row.version, verdict: row.verdict })), [
      { site: 'US', asin: 'B0AAAAAAAA', version: 1, verdict: 'do' },
    ])
  } finally {
    db.close()
  }
})

test('v37 回填幂等：第二次 0 新增，v1 行数与字段不变', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    seed(db)
    backfillAsinIdentityV37(db)
    const before = {
      products: db.prepare('SELECT COUNT(*) AS n FROM asin_products').get().n,
      snapshots: db.prepare('SELECT COUNT(*) AS n FROM asin_snapshots').get().n,
      logs: db.prepare('SELECT COUNT(*) AS n FROM oplog_entries').get().n,
      reviews: db.prepare('SELECT COUNT(*) AS n FROM migration_review').get().n,
      v2: db.prepare('SELECT COUNT(*) AS n FROM asin_products_v2').get().n,
      nullSite: db.prepare("SELECT site FROM asin_products WHERE asin='B0BBBBBBBB'").get().site,
    }
    const second = backfillAsinIdentityV37(db)
    assert.equal(second.products.inserted, 0)
    assert.equal(second.snapshots.inserted, 0)
    assert.equal(second.judgments.inserted, 0)
    assert.equal(second.reviews.added, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_products').get().n, before.products)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_snapshots').get().n, before.snapshots)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entries').get().n, before.logs)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_review').get().n, before.reviews)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_products_v2').get().n, before.v2)
    assert.equal(db.prepare("SELECT site FROM asin_products WHERE asin='B0BBBBBBBB'").get().site, before.nullSite, 'v1 的 NULL site 必须原样保留')
  } finally {
    db.close()
  }
})

test('父子关系与 SKU 表不推断：默认空表，可显式写入且按 site 隔离', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_relations').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_skus').get().n, 0)
    db.prepare(`INSERT INTO asin_relations (id, site, parent_asin, child_asin, relation_type, created_at)
      VALUES ('r1', 'US', 'B0PARENT01', 'B0CHILD001', 'variation', '2026-10-29T00:00:00Z')`).run()
    db.prepare(`INSERT INTO asin_skus (id, site, asin, shop_id, sku, created_at)
      VALUES ('k1', 'US', 'B0CHILD001', 'YOBEL', 'SKU-US-1', '2026-10-29T00:00:00Z')`).run()
    db.prepare(`INSERT INTO asin_skus (id, site, asin, shop_id, sku, created_at)
      VALUES ('k2', 'DE', 'B0CHILD001', 'YOBEL-DE', 'SKU-DE-1', '2026-10-29T00:00:00Z')`).run()
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM asin_skus WHERE asin='B0CHILD001'").get().n, 2)
  } finally {
    db.close()
  }
})

test('站点规范化：只接受两位字母；缺失/非法返回 null，不默认 US', () => {
  assert.equal(normalizeSite('us'), 'US')
  assert.equal(normalizeSite(' DE '), 'DE')
  assert.equal(normalizeSite('USA'), null)
  assert.equal(normalizeSite(''), null)
  assert.equal(normalizeSite(null), null)
  assert.equal(normalizeSite(undefined), null)
})
