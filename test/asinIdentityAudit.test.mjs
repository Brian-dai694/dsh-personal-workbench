/**
 * P0 审计脚本的回归：用内存库造出每一类需要复核的数据，断言报告能点名。
 *
 * 这里只测 `auditAsinIdentity()`（纯读），不测 CLI 参数解析；
 * CLI 的真实库运行由交付命令单独给出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { auditAsinIdentity } from '../scripts/audit-asin-identity.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE asin_products (asin TEXT PRIMARY KEY, site TEXT);
    CREATE TABLE asin_snapshots (id TEXT PRIMARY KEY, asin TEXT NOT NULL, captured_at TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, extra TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE keyword_plans (id TEXT PRIMARY KEY, asin TEXT);
    CREATE TABLE calculator_scenarios (id TEXT PRIMARY KEY, asin TEXT);
    CREATE TABLE oplog_entries (id TEXT PRIMARY KEY, asin_json TEXT NOT NULL DEFAULT '[]', shop_id TEXT, site TEXT, created_at TEXT NOT NULL);
    CREATE TABLE oplog_types (name TEXT PRIMARY KEY, color TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
  `)
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '36')").run()
  const product = db.prepare('INSERT INTO asin_products (asin, site) VALUES (?, ?)')
  product.run('B0AAAAAAAA', 'US')
  product.run('B0BBBBBBBB', null)
  product.run('B0CCCCCCCC', 'us')
  product.run('SHORT', 'US')
  const snap = db.prepare('INSERT INTO asin_snapshots (id, asin, captured_at) VALUES (?, ?, ?)')
  snap.run('s1', 'B0AAAAAAAA', '2026-10-01T00:00:00Z')
  snap.run('s2', 'B0ZZZZZZZZ', '2026-10-01T00:00:00Z')
  const task = db.prepare('INSERT INTO tasks (id, extra) VALUES (?, ?)')
  task.run('t1', JSON.stringify({ asin: 'B0AAAAAAAA' }))
  task.run('t2', JSON.stringify({ asin: 'B0BBBBBBBB', site: 'DE' }))
  db.prepare('INSERT INTO keyword_plans (id, asin) VALUES (?, ?)').run('k1', 'B0AAAAAAAA')
  db.prepare('INSERT INTO calculator_scenarios (id, asin) VALUES (?, ?)').run('c1', 'B0BBBBBBBB')
  db.prepare('INSERT INTO calculator_scenarios (id, asin) VALUES (?, ?)').run('c2', null)
  const type = db.prepare('INSERT INTO oplog_types (name, color, sort) VALUES (?, ?, ?)')
  type.run('复盘', '#28a745', 0)
  type.run('其它', '#6c757d', 1)
  const log = db.prepare('INSERT INTO oplog_entries (id, asin_json, shop_id, site, created_at) VALUES (?, ?, ?, ?, ?)')
  log.run('o1', JSON.stringify(['B0AAAAAAAA', 'B0ZZZZZZZZ']), 'YOBEL', 'US', '2026-10-01T00:00:00Z')
  log.run('o2', '[]', null, null, '2026-10-02T00:00:00Z')
  return db
}

test('审计能点名 site 缺失/非法、孤儿快照、任务缺 site、裸 ASIN、库外 ASIN', () => {
  const db = fixture()
  try {
    const report = auditAsinIdentity(db)
    assert.equal(report.schemaVersion, '36')
    assert.deepEqual(report.counts, {
      products: 4,
      snapshots: 2,
      tasksWithAsin: 2,
      oplogEntries: 2,
      oplogWithAsins: 1,
      oplogWithoutAsins: 1,
      oplogMultiAsin: 1,
      oplogSiteMissing: 1,
      oplogTypes: 2,
      distinctOplogAsins: 2,
      keywordPlans: 1,
      keywordPlansWithAsin: 1,
      calculatorScenarios: 2,
      calculatorScenariosWithAsin: 1,
      calculatorScenariosEmptyAsin: 1,
    })
    assert.equal(report.structure.productsCompositeKey, false)
    assert.equal(report.structure.snapshotSiteColumn, false)
    assert.equal(report.structure.sameAsinMultiSite.count, 0, '当前 PK 下同 ASIN 多站点应为 0')
    assert.deepEqual(report.oplog.asinSiteConflicts, [], 'fixture 的日志站点一致')

    const byCode = new Map(report.findings.map((finding) => [finding.code, finding]))
    assert.equal(byCode.get('products_site_missing')?.count, 1, 'NULL site 必须点名')
    assert.equal(byCode.get('products_site_invalid')?.count, 1, '小写 us 必须点名')
    assert.equal(byCode.get('products_asin_invalid')?.count, 1, 'SHORT 必须点名')
    assert.equal(byCode.get('snapshots_orphan')?.count, 1)
    assert.equal(byCode.get('tasks_asin_without_site')?.count, 1)
    assert.equal(byCode.get('keyword_plans_bare_asin')?.count, 1)
    assert.equal(byCode.get('calculator_scenarios_bare_asin')?.count, 1)
    assert.equal(byCode.get('snapshots_site_column_missing')?.severity, 'info')
    assert.equal(byCode.get('oplog_flat_asins_without_relation')?.count, 1)
    assert.deepEqual(report.oplog.notInProductLibrary, ['B0ZZZZZZZZ'])
    const siteCheck = report.checklists.siteMissingOrInvalid
    assert.equal(siteCheck.productsMissing, 1)
    assert.equal(siteCheck.productsInvalid, 1)
    assert.equal(siteCheck.oplogMissing, 1)
    assert.equal(siteCheck.oplogInvalid, 0)
    assert.deepEqual(siteCheck.samples.products.map((row) => ({ asin: row.asin, site: row.site })), [
      { asin: 'B0BBBBBBBB', site: null },
      { asin: 'B0CCCCCCCC', site: 'us' },
    ])
    assert.deepEqual(siteCheck.samples.oplog, [{ entryId: 'o2', site: null }])
    assert.equal(report.checklists.sameAsinMultiSite.count, 0)
    assert.equal(report.checklists.orphanSnapshots.count, 1)
    assert.equal(report.checklists.tasksAsinWithoutSite.count, 1)
    assert.equal(report.checklists.weakAsinLinks.calculatorScenarios.totalRows, 2)
    assert.equal(report.checklists.weakAsinLinks.calculatorScenarios.emptyAsin, 1)
    assert.equal(report.checklists.oplogAssociations.total, 2)
    assert.deepEqual(report.checklists.oplogAssociations.siteDistribution.map((row) => ({ site: row.site, n: row.n })), [
      { site: 'US', n: 1 },
      { site: '(missing)', n: 1 },
    ])
    assert.equal(report.verdict, 'needs_review')
  } finally {
    db.close()
  }
})

test('审计只读：不改行数、不改数据', () => {
  const db = fixture()
  try {
    const before = {
      products: db.prepare('SELECT COUNT(*) AS n FROM asin_products').get().n,
      logs: db.prepare('SELECT COUNT(*) AS n FROM oplog_entries').get().n,
      types: db.prepare('SELECT COUNT(*) AS n FROM keyword_plans').get().n,
    }
    auditAsinIdentity(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_products').get().n, before.products)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entries').get().n, before.logs)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM keyword_plans').get().n, before.types)
  } finally {
    db.close()
  }
})

test('同 ASIN 多站点与日志跨站点冲突都能被点名（模拟 PK 被改过的库）', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE asin_products (asin TEXT NOT NULL, site TEXT);
      CREATE TABLE asin_snapshots (id TEXT PRIMARY KEY, asin TEXT NOT NULL, captured_at TEXT NOT NULL);
      CREATE TABLE oplog_entries (id TEXT PRIMARY KEY, asin_json TEXT NOT NULL DEFAULT '[]', shop_id TEXT, site TEXT, created_at TEXT NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    `)
    const product = db.prepare('INSERT INTO asin_products (asin, site) VALUES (?, ?)')
    product.run('B0AAAAAAAA', 'US')
    product.run('B0AAAAAAAA', 'DE')
    const log = db.prepare('INSERT INTO oplog_entries (id, asin_json, site, created_at) VALUES (?, ?, ?, ?)')
    log.run('o1', JSON.stringify(['B0AAAAAAAA']), 'US', '2026-10-01T00:00:00Z')
    log.run('o2', JSON.stringify(['B0AAAAAAAA']), 'DE', '2026-10-02T00:00:00Z')

    const report = auditAsinIdentity(db)
    assert.equal(report.structure.sameAsinMultiSite.count, 1)
    assert.equal(report.oplog.asinSiteConflicts.length, 1)
    assert.deepEqual(report.oplog.asinSiteConflicts[0], { asin: 'B0AAAAAAAA', sites: ['DE', 'US'] })
    const codes = report.findings.map((finding) => finding.code)
    assert.ok(codes.includes('products_same_asin_multi_site'))
    assert.ok(codes.includes('oplog_asin_multi_site_conflict'))
  } finally {
    db.close()
  }
})
