/**
 * P4-B（schema v38）：运营日志 0..n 结构化关联。
 *
 * 守四件事：
 * 1. **只增不改**：`oplog_entries` 的 `asin_json` 逐字节不变，存量 role 一律 `unknown`；
 * 2. **身份前置、不猜**：站点缺失保持 NULL 并进 `migration_review`，不回填 US；
 *    父子/SKU 只能由调用方显式给，不从字符串推断；
 * 3. **0..n 与顺序**：关联按输入顺序回填/写入，重复身份去重，删日志一并清关联；
 * 4. **旧路径不坏**：只传 `asins` 的客户端照旧可用；schema 37 的库没有关联表也能读日志。
 *
 * 全部在内存库/临时库跑，不连接正本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { migrate, openWorkbenchDb } from '../lib/db/database.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'
import { backfillOplogAssociationsV38 } from '../lib/db/oplogAssociationsV38.js'
import {
  createOplogEntry,
  deleteOplogEntry,
  getOplogEntry,
  listOplogDayIndex,
  listOplogEntries,
  updateOplogEntry,
} from '../lib/db/repo.js'
import { makeRoutes } from '../lib/api/routes.js'

const NOW = '2026-10-29T00:00:00.000Z'

/** 跑到 v37 为止的库：用来验证 v38 的回填（关联表这时还不存在）。 */
function openAtV37() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  for (const migration of MIGRATIONS.filter((item) => item.version <= 37)) {
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(migration.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return db
}

function insertLog(db, id, asins, site, logDate = '2026-10-20') {
  db.prepare(`INSERT INTO oplog_entries (id, log_type, title, content_text, asin_json, images_json, documents_json,
    shop_id, shop_name, site, type_color, log_date, created_at, updated_at, pinned, task_id)
    VALUES (?, '复盘', ?, '', ?, '[]', '[]', 'SHOP1', 'YOBEL', ?, '#007bff', ?, ?, ?, 0, NULL)`)
    .run(id, `日志 ${id}`, JSON.stringify(asins), site, logDate, NOW, NOW)
}

/** 在 v37 身份阴影表里登记一个已解析身份（关联的前置条件）。 */
function addIdentity(db, site, asin) {
  db.prepare(`INSERT INTO asin_products_v2 (site, asin, title, added_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(site, asin) DO NOTHING`).run(site, asin, `${site} ${asin}`, NOW, NOW)
}

function asinJsonSnapshot(db) {
  const rows = db.prepare('SELECT id, asin_json FROM oplog_entries ORDER BY id').all()
  return new Map(rows.map((row) => [row.id, row.asin_json]))
}

async function withServer(db, fn) {
  const routes = makeRoutes(db, {})
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') { server.close(); throw new Error('no port') }
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? {} : JSON.parse(text) }
  }
  try { await fn({ request }) } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('v38 迁移：建表 + 按 asin_json 顺序回填；asin_json 逐字节不变；未知站点进复核', () => {
  const db = openAtV37()
  try {
    insertLog(db, 'log-us', ['B0AAAAAAA1', 'b0aaaaaaa2'], 'US', '2026-10-20')
    insertLog(db, 'log-null', ['B0AAAAAAA3'], null, '2026-10-21')
    /** 两条 US 身份已存在 → 可以建关联；无站点那条没有身份 → 只进复核。 */
    addIdentity(db, 'US', 'B0AAAAAAA1')
    addIdentity(db, 'US', 'B0AAAAAAA2')
    const before = asinJsonSnapshot(db)
    /** 预存的复核记录：回填不得清理/覆盖它（复核队列只能追加，不能删）。 */
    db.prepare(`INSERT INTO migration_review (id, source_table, source_key, reason, payload_json, status, created_at)
      VALUES ('review-pre', 'oplog_entries', 'legacy-pre', 'site_unknown', '{}', 'pending', ?)`).run(NOW)

    migrate(db)
    assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((migration) => migration.version)))
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION))
    assert.ok(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='oplog_entry_associations'").get())

    const rows = db.prepare(`
      SELECT entry_id, ordinal, role, site, asin, listing_id, source
      FROM oplog_entry_associations ORDER BY entry_id, ordinal
    `).all()
    assert.equal(rows.length, 2, '只有身份表里查得到的才有资格建关联')
    assert.deepEqual(rows.map((row) => [row.entry_id, row.ordinal, row.asin, row.site, row.role, row.source]), [
      ['log-us', 0, 'B0AAAAAAA1', 'US', 'unknown', 'legacy'],
      ['log-us', 1, 'B0AAAAAAA2', 'US', 'unknown', 'legacy'],
    ])
    assert.deepEqual(rows.map((row) => row.listing_id), ['US_B0AAAAAAA1', 'US_B0AAAAAAA2'])

    /** 旧列一个字节都不能动。 */
    assert.deepEqual(asinJsonSnapshot(db), before)

    /** 无站点那条在复核队列里，且没有被回填成 US、也没有关联行。 */
    const reviews = db.prepare("SELECT source_key, reason FROM migration_review WHERE reason LIKE 'association_%' ORDER BY source_key").all()
    assert.deepEqual(reviews.map((row) => [row.source_key, row.reason]), [['log-null#0', 'association_site_unknown']])

    /** 幂等：第二次回填 0 新增，且**复核队列不再增长**（重复只计数、不进队列）。 */
    const reviewCount = () => db.prepare("SELECT COUNT(*) AS n FROM migration_review WHERE reason LIKE 'association_%'").get().n
    const reviewsAfterFirst = reviewCount()
    assert.equal(reviewsAfterFirst, 1, '只有那条真正无站点的关联进队列')

    for (let round = 2; round <= 4; round += 1) {
      const again = backfillOplogAssociationsV38(db)
      assert.equal(again.inserted, 0, `第 ${round} 次回填不应新增关联`)
      assert.equal(again.duplicates, 2, `第 ${round} 次回填的重复数应如实计数`)
      assert.equal(reviewCount(), reviewsAfterFirst, `第 ${round} 次回填后复核队列行数必须稳定`)
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migration_review WHERE reason = 'association_duplicate'").get().n, 0,
      '重复关联不进复核队列（那只是报告指标，不是待办）')
    /** 预存记录仍在，且没有被新回填顶掉。 */
    assert.ok(
      db.prepare("SELECT 1 AS x FROM migration_review WHERE id = 'review-pre' AND source_key = 'legacy-pre'").get(),
      '回填不得删除或覆盖已有复核记录',
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_review').get().n, 2, '总数 = 预存 1 + 真实未解析 1')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entry_associations').get().n, 2)
  } finally {
    db.close()
  }
})

test('新写：associations 优先、按顺序落库、重复身份去重；asins 由它派生', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    addIdentity(db, 'US', 'B0AAAAAAA1')
    addIdentity(db, 'DE', 'B0AAAAAAA2')
    addIdentity(db, 'US', 'B0AAAAAAA2')
    const entry = createOplogEntry(db, {
      title: '多关联日志',
      logType: 'Listing',
      contentText: '',
      shopId: 'SHOP1',
      site: 'US',
      logDate: '2026-10-22',
      asins: [],
      associations: [
        { asin: 'B0AAAAAAA1', role: 'parent' },
        { asin: 'B0AAAAAAA2', role: 'child', site: 'DE' },
        { asin: 'B0AAAAAAA1', role: 'parent' },
        { asin: 'B0AAAAAAA2', role: 'sku', sku: 'SKU-YOBEL-1' },
      ],
      documents: [],
    })
    assert.deepEqual(entry.asins, ['B0AAAAAAA1', 'B0AAAAAAA2'], 'asins 从关联派生并去重')
    assert.equal(entry.associations.length, 3, '重复的 parent 身份被去重，sku 角色是另一条')
    assert.deepEqual(entry.associations.map((row) => [row.ordinal, row.asin, row.role, row.site, row.sku]), [
      [0, 'B0AAAAAAA1', 'parent', 'US', null],
      [1, 'B0AAAAAAA2', 'child', 'DE', null],
      [2, 'B0AAAAAAA2', 'sku', 'US', 'SKU-YOBEL-1'],
    ])
    assert.deepEqual(entry.associations.map((row) => row.listingId), ['US_B0AAAAAAA1', 'DE_B0AAAAAAA2', 'US_B0AAAAAAA2'])

    const reread = getOplogEntry(db, entry.id)
    assert.deepEqual(reread.associations, entry.associations)

    /** 编辑整组替换：把 child 去掉后不应残留。 */
    const updated = updateOplogEntry(db, entry.id, {
      title: entry.title,
      logType: entry.logType,
      contentText: '',
      shopId: entry.shopId,
      site: entry.site,
      logDate: entry.logDate,
      asins: [],
      associations: [{ asin: 'B0AAAAAAA1', role: 'parent' }],
      documents: [],
    })
    assert.deepEqual(updated.associations.map((row) => row.asin), ['B0AAAAAAA1'])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entry_associations').get().n, 1)
  } finally {
    db.close()
  }
})

test('旧客户端只传 asins：落成 role=unknown、站点继承日志，不猜父子', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    addIdentity(db, 'US', 'B0AAAAAAA9')
    const entry = createOplogEntry(db, {
      title: '旧写法',
      logType: '其它',
      contentText: '',
      shopId: null,
      site: 'us',
      logDate: '2026-10-22',
      asins: ['b0aaaaaaa9'],
      documents: [],
    })
    assert.deepEqual(entry.asins, ['B0AAAAAAA9'])
    assert.equal(entry.associations.length, 1)
    assert.equal(entry.associations[0].role, 'unknown')
    assert.equal(entry.associations[0].site, 'US')
    assert.equal(entry.associations[0].listingId, 'US_B0AAAAAAA9')
  } finally {
    db.close()
  }
})

test('身份不存在 / 站点缺失 / 显式非法站点：都不建关联，只进复核', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    /** 影子表里 B0AAAAAAA5 只有 DE。 */
    addIdentity(db, 'DE', 'B0AAAAAAA5')

    /** 1) 日志没有站点、ASIN 也没身份 → 不建关联。 */
    const unknown = createOplogEntry(db, {
      title: '无站点', logType: '其它', contentText: '', shopId: null, site: null,
      logDate: '2026-10-22', asins: [], associations: [{ asin: 'B0AAAAAAA4' }], documents: [],
    })
    assert.deepEqual(unknown.associations, [], '站点未知不允许建关联')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migration_review WHERE reason = 'association_site_unknown'").get().n, 1)

    /** 2) 站点有、但该 (site,asin) 在身份表里不存在 → 悬空关联必须被拦住。 */
    const dangling = createOplogEntry(db, {
      title: '无身份', logType: '其它', contentText: '', shopId: null, site: 'US',
      logDate: '2026-10-22', asins: [], associations: [{ asin: 'B0AAAAAAA6' }], documents: [],
    })
    assert.deepEqual(dangling.associations, [], '身份表查不到就不能产出 listing_id')
    const missing = db.prepare("SELECT payload_json FROM migration_review WHERE reason = 'association_identity_missing'").get()
    assert.ok(missing !== undefined)
    assert.deepEqual(JSON.parse(missing.payload_json).candidates, [])

    /** 3) 站点与已知身份冲突（只有 DE）→ 不建关联，候选站点进复核。 */
    const mismatch = createOplogEntry(db, {
      title: '站点冲突', logType: '其它', contentText: '', shopId: null, site: 'US',
      logDate: '2026-10-22', asins: [], associations: [{ asin: 'B0AAAAAAA5' }], documents: [],
    })
    assert.deepEqual(mismatch.associations, [], '站点对不上不允许建关联')
    const review = db.prepare("SELECT payload_json FROM migration_review WHERE reason = 'association_site_mismatch'").get()
    assert.ok(review !== undefined, '冲突必须进复核队列')
    assert.deepEqual(JSON.parse(review.payload_json).candidates, ['DE'])

    /** 4) 显式非法/空站点：不得继承日志站点（US）。 */
    for (const badSite of ['USA', '', null]) {
      const entry = createOplogEntry(db, {
        title: `非法站点 ${String(badSite)}`, logType: '其它', contentText: '', shopId: null, site: 'US',
        logDate: '2026-10-22', asins: [],
        associations: [{ asin: 'B0AAAAAAA5', site: badSite }],
        documents: [],
      })
      assert.deepEqual(entry.associations, [], `显式站点 ${String(badSite)} 不能被日志站点兜底`)
    }
    assert.ok(
      db.prepare("SELECT COUNT(*) AS n FROM migration_review WHERE reason = 'association_site_invalid'").get().n >= 3,
      '每种非法站点都要留复核记录',
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entry_associations').get().n, 0)
  } finally {
    db.close()
  }
})

test('身份表为空时（真实库形态）旧日志一条都不补录，原 asin_json 保留', () => {
  const db = openAtV37()
  try {
    /** 真实库正是这样：8 条日志、产品身份表 0 行。 */
    for (let index = 1; index <= 8; index += 1) {
      insertLog(db, `log-${index}`, [`B0LEGACY0${index}`.slice(0, 10)], index === 8 ? null : 'US', '2026-10-20')
    }
    const before = asinJsonSnapshot(db)
    migrate(db)

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asin_products_v2').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entry_associations').get().n, 0, '身份表 0 行 → 关联 0 行')
    assert.deepEqual(asinJsonSnapshot(db), before, '旧列逐字节不变')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migration_review WHERE reason = 'association_identity_missing'").get().n, 7)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migration_review WHERE reason = 'association_site_unknown'").get().n, 1)

    /** 只加 1 个身份，只有对应那条能关联。 */
    addIdentity(db, 'US', 'B0LEGACY01')
    const again = backfillOplogAssociationsV38(db)
    assert.equal(again.inserted, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entry_associations').get().n, 1)
    assert.equal(db.prepare("SELECT asin FROM oplog_entry_associations").get().asin, 'B0LEGACY01')
  } finally {
    db.close()
  }
})

test('同一身份反复保存只留一条复核（按身份做 key，不按序号）', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    addIdentity(db, 'US', 'B0AAAAAAA8')
    const draft = {
      title: '反复保存', logType: '其它', contentText: '', shopId: null, site: 'US',
      logDate: '2026-10-22', asins: [],
      associations: [{ asin: 'B0AAAAAAA8', role: 'grandparent' }],
      documents: [],
    }
    const created = createOplogEntry(db, draft)
    assert.equal(created.associations.length, 1)
    assert.equal(created.associations[0].role, 'unknown', '非法角色降级 unknown，不中断保存')
    const count = () => db.prepare("SELECT COUNT(*) AS n FROM migration_review WHERE reason = 'association_role_invalid'").get().n
    assert.equal(count(), 1)

    for (let round = 0; round < 3; round += 1) {
      updateOplogEntry(db, created.id, draft)
      assert.equal(count(), 1, '重复保存不得堆复核噪音')
    }
  } finally {
    db.close()
  }
})

test('删日志一并清关联；按 listing 反查只命中对应站点', () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    addIdentity(db, 'US', 'B0AAAAAAA1')
    addIdentity(db, 'DE', 'B0AAAAAAA1')
    const us = createOplogEntry(db, {
      title: 'US', logType: '其它', contentText: '', shopId: null, site: 'US', logDate: '2026-10-22',
      asins: ['B0AAAAAAA1'], documents: [],
    })
    createOplogEntry(db, {
      title: 'DE', logType: '其它', contentText: '', shopId: null, site: 'DE', logDate: '2026-10-22',
      asins: ['B0AAAAAAA1'], documents: [],
    })

    assert.deepEqual(listOplogEntries(db, { listingId: 'US_B0AAAAAAA1' }).map((entry) => entry.title), ['US'])
    assert.deepEqual(listOplogEntries(db, { listingId: 'DE_B0AAAAAAA1' }).map((entry) => entry.title), ['DE'])

    assert.equal(deleteOplogEntry(db, us.id), true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oplog_entry_associations').get().n, 1, '只删该日志的关联')
  } finally {
    db.close()
  }
})

test('日期口径不变：日历计数与回填前一致', () => {
  const db = openAtV37()
  try {
    insertLog(db, 'log-a', ['B0AAAAAAA1'], 'US', '2026-10-20')
    insertLog(db, 'log-b', [], 'US', '2026-10-20')
    insertLog(db, 'log-c', ['B0AAAAAAA2'], null, '2026-10-21')
    const before = listOplogDayIndex(db)
    migrate(db)
    assert.deepEqual(listOplogDayIndex(db), before)
    assert.deepEqual(listOplogEntries(db, { logDate: '2026-10-20' }).map((entry) => entry.id).sort(), ['log-a', 'log-b'])
  } finally {
    db.close()
  }
})

test('schema 37 的库没有关联表也能读：associations 为空，反查退回 asin_json', () => {
  const db = openAtV37()
  try {
    insertLog(db, 'log-old', ['B0AAAAAAA7'], 'US', '2026-10-20')
    const entries = listOplogEntries(db)
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0].associations, [])
    assert.deepEqual(entries[0].asins, ['B0AAAAAAA7'])
    assert.deepEqual(listOplogEntries(db, { listingId: 'US_B0AAAAAAA7' }).map((entry) => entry.id), ['log-old'])
  } finally {
    db.close()
  }
})

test('路由：POST 收 associations，asins 同时传 400，GET 支持 listing 反查', async () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try {
    addIdentity(db, 'US', 'B0AAAAAAA1')
    addIdentity(db, 'US', 'B0AAAAAAA2')
    await withServer(db, async ({ request }) => {
      const created = await request('POST', '/api/workbench/oplog', {
        title: '路由新写法',
        logType: 'Listing',
        site: 'US',
        associations: [{ asin: 'B0AAAAAAA1', role: 'parent' }, { asin: 'B0AAAAAAA2', role: 'sku', sku: 'S1' }],
      })
      assert.equal(created.status, 200)
      assert.equal(created.body.entry.associations.length, 2)
      assert.deepEqual(created.body.entry.asins, ['B0AAAAAAA1', 'B0AAAAAAA2'])

      const conflict = await request('POST', '/api/workbench/oplog', {
        title: '两边都传',
        asins: ['B0AAAAAAA1'],
        associations: [{ asin: 'B0AAAAAAA2' }],
      })
      assert.equal(conflict.status, 400)
      assert.match(conflict.body.error, /只能传一个/)

      const badRole = await request('POST', '/api/workbench/oplog', {
        title: '非法角色',
        associations: [{ asin: 'B0AAAAAAA1', role: 'grandparent' }],
      })
      assert.equal(badRole.status, 400)
      assert.match(badRole.body.error, /关联角色/)

      const badSite = await request('POST', '/api/workbench/oplog', {
        title: '非法站点',
        associations: [{ asin: 'B0AAAAAAA1', site: 'USA' }],
      })
      assert.equal(badSite.status, 400)
      assert.match(badSite.body.error, /两位字母/)

      /** 显式空串同样 400：不能悄悄变成"继承日志站点 US"。 */
      const emptySite = await request('POST', '/api/workbench/oplog', {
        title: '空站点',
        site: 'US',
        associations: [{ asin: 'B0AAAAAAA1', site: '' }],
      })
      assert.equal(emptySite.status, 400)
      assert.match(emptySite.body.error, /要么省略/)

      /** 身份不存在：200 保存日志，但关联为 0（原始 asins 仍在）。 */
      const dangling = await request('POST', '/api/workbench/oplog', {
        title: '无身份关联',
        site: 'US',
        associations: [{ asin: 'B0AAAAAAA9' }],
      })
      assert.equal(dangling.status, 200)
      assert.deepEqual(dangling.body.entry.associations, [])
      assert.deepEqual(dangling.body.entry.asins, ['B0AAAAAAA9'])

      const listed = await request('GET', '/api/workbench/oplog?listing=US_B0AAAAAAA1')
      assert.equal(listed.status, 200)
      assert.deepEqual(listed.body.entries.map((entry) => entry.title), ['路由新写法'])
    })
  } finally {
    db.close()
  }
})
