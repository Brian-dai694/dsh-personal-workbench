/**
 * P1 演练：在**独立副本或内存库**上运行 schema v37 影子表 + 复核队列迁移。
 *
 * 硬纪律：绝不连接正在使用的正本 `~/.dsh/workbench/workbench.db`。
 * 传入 `--db` 时会先做路径比对（含 realpath），命中正本直接退出 2。
 *
 * 用法：
 *   node scripts/rehearse-asin-identity-p1.mjs --memory [--out report.json]
 *   node scripts/rehearse-asin-identity-p1.mjs --db <副本.db> [--out report.json]
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { openWorkbenchDb } from '../lib/db/database.js'
import { MIGRATIONS } from '../lib/db/schema.js'
import { backfillAsinIdentityV37 } from '../lib/db/asinIdentityV37.js'

const LIVE_DB = join(homedir(), '.dsh', 'workbench', 'workbench.db')

function canonical(path) {
  try { return realpathSync.native(path).toLowerCase() } catch { return resolve(path).toLowerCase() }
}

function isLiveDb(path) {
  return canonical(path) === canonical(LIVE_DB)
}

function parseArgs(argv) {
  const options = { memory: false, fixtureBaseline: false, db: null, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--memory') options.memory = true
    else if (arg === '--fixture-baseline') options.fixtureBaseline = true
    else if (arg === '--db' && argv[index + 1] !== undefined) { options.db = resolve(argv[index + 1]); index += 1 }
    else if (arg === '--out' && argv[index + 1] !== undefined) { options.out = resolve(argv[index + 1]); index += 1 }
  }
  return options
}

/** 在全新文件里造一个“v36 基线库”：只跑到 36，日志 8 条（7 US + 1 NULL）。 */
function createV36BaselineFixture(path) {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    for (const migration of MIGRATIONS.filter((item) => item.version <= 36)) {
      db.exec('BEGIN')
      try {
        migration.up(db)
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(migration.version))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    const now = '2026-10-29T00:00:00.000Z'
    const insert = db.prepare(`
      INSERT INTO oplog_entries (id, log_type, title, created_at, updated_at, asin_json, shop_id, site)
      VALUES (?, '复盘', ?, ?, ?, ?, 'YOBEL', ?)
    `)
    for (let index = 1; index <= 8; index += 1) {
      insert.run(`fixture-log-${index}`, `演练日志 ${index}`, now, now, JSON.stringify([`B0FIXTURE${String(index).padStart(2, '0')}`]), index === 8 ? null : 'US')
    }
    return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value
  } finally {
    db.close()
  }
}

function seedFixture(db) {
  const now = new Date().toISOString()
  const product = db.prepare(`
    INSERT INTO asin_products (asin, title, tags_json, added_at, updated_at, site, verdict, score, judgment_json, judged_at, judged_source)
    VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  /** 有效站点 + 判断：应进 v2 + asin_judgments。 */
  product.run('B0AAAAAAAA', 'US 有效品', now, now, 'US', 'do', 82, '{"risk":"low"}', now, 'manual')
  /** 站点缺失：只进复核队列，禁止回填 US。 */
  product.run('B0BBBBBBBB', '无站点品', now, now, null, 'none', null, '{}', null, null)

  const snapshot = db.prepare('INSERT INTO asin_snapshots (id, asin, captured_at, price) VALUES (?, ?, ?, ?)')
  snapshot.run('s-valid', 'B0AAAAAAAA', '2026-10-01T00:00:00Z', 19.99)
  snapshot.run('s-orphan', 'B0ZZZZZZZZ', '2026-10-01T00:00:00Z', 9.99)

  const log = db.prepare(`
    INSERT INTO oplog_entries (id, log_type, title, created_at, updated_at, asin_json, shop_id, site)
    VALUES (?, '复盘', ?, ?, ?, ?, ?, ?)
  `)
  log.run('log-null-site', '无站点日志', now, now, JSON.stringify(['B0AAAAAAAA']), 'YOBEL', null)
  log.run('log-us', 'US 日志', now, now, JSON.stringify(['B0AAAAAAAA']), 'YOBEL', 'US')
}

function summarize(db) {
  const one = (sql) => db.prepare(sql).get()
  return {
    schemaVersion: one("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? null,
    productsV2: one('SELECT COUNT(*) AS n FROM asin_products_v2')?.n ?? 0,
    snapshotsV2: one('SELECT COUNT(*) AS n FROM asin_snapshots_v2')?.n ?? 0,
    judgments: one('SELECT COUNT(*) AS n FROM asin_judgments')?.n ?? 0,
    relations: one('SELECT COUNT(*) AS n FROM asin_relations')?.n ?? 0,
    skus: one('SELECT COUNT(*) AS n FROM asin_skus')?.n ?? 0,
    reviews: one('SELECT COUNT(*) AS n FROM migration_review')?.n ?? 0,
    reviewRows: db.prepare('SELECT source_table AS sourceTable, source_key AS sourceKey, reason FROM migration_review ORDER BY source_table, reason').all(),
    v1Products: one('SELECT COUNT(*) AS n FROM asin_products')?.n ?? 0,
    v1Snapshots: one('SELECT COUNT(*) AS n FROM asin_snapshots')?.n ?? 0,
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.db !== null && isLiveDb(options.db)) {
  console.error(`refused: ${options.db} 是正在使用的正本数据库，P1 只允许副本/内存库`)
  process.exit(2)
}
if (options.db === null && !options.memory) {
  console.error('refused: 必须显式指定 --memory 或 --db <副本>；不会默认打开正本')
  process.exit(2)
}
if (options.fixtureBaseline && options.db === null) {
  console.error('refused: --fixture-baseline 需要 --db <新文件路径>')
  process.exit(2)
}
if (options.fixtureBaseline && existsSync(options.db)) {
  console.error(`refused: fixture 目标已存在，拒绝覆盖：${options.db}`)
  process.exit(2)
}

let db
try {
  let mode = options.memory ? 'memory-fixture' : `copy:${options.db}`
  if (options.fixtureBaseline) {
    mkdirSync(dirname(options.db), { recursive: true })
    const baselineVersion = createV36BaselineFixture(options.db)
    mode = `v36-baseline-fixture:${options.db}`
    db = openWorkbenchDb({ dbPath: options.db })
    const first = backfillAsinIdentityV37(db)
    const second = backfillAsinIdentityV37(db)
    const state = summarize(db)
    const report = {
      mode,
      baselineVersion,
      liveDbRefused: LIVE_DB,
      first,
      second,
      state,
      idempotent: second.products.inserted === 0
        && second.snapshots.inserted === 0
        && second.judgments.inserted === 0
        && second.reviews.added === 0,
      reviewsExactlyBaselineNullSite: state.reviews === 1
        && state.reviewRows.length === 1
        && state.reviewRows[0].sourceTable === 'oplog_entries'
        && state.reviewRows[0].reason === 'site_unknown',
    }
    emit(report, options.out)
    if (!report.idempotent || !report.reviewsExactlyBaselineNullSite) process.exitCode = 1
  } else if (options.memory) {
    db = openWorkbenchDb({ dbPath: ':memory:' })
    seedFixture(db)
    const first = backfillAsinIdentityV37(db)
    const second = backfillAsinIdentityV37(db)
    emit({ mode, liveDbRefused: LIVE_DB, first, second, state: summarize(db), idempotent: second.reviews.added === 0 }, options.out)
  } else {
    if (!existsSync(options.db)) {
      console.error(`refused: 副本不存在：${options.db}`)
      process.exit(2)
    }
    db = openWorkbenchDb({ dbPath: options.db })
    const first = backfillAsinIdentityV37(db)
    const second = backfillAsinIdentityV37(db)
    emit({ mode, liveDbRefused: LIVE_DB, first, second, state: summarize(db), idempotent: second.reviews.added === 0 }, options.out)
  }
} finally {
  try { db?.close() } catch { /* 关闭失败不覆盖原始错误 */ }
}

function emit(report, out) {
  const text = JSON.stringify(report, null, 2)
  if (out !== null) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${text}\n`, 'utf8')
    const state = report.state
    console.log(`P1 rehearsal: mode=${report.mode} schema=${state.schemaVersion} v2_products=${state.productsV2} v2_snapshots=${state.snapshotsV2} judgments=${state.judgments} reviews=${state.reviews} idempotent=${report.idempotent} -> ${out}`)
  } else {
    console.log(text)
  }
}
