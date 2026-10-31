/**
 * P0 只读审计：选品/产品身份（site + ASIN）迁移前盘点。
 *
 * 目标：在**不改库**的前提下，把迁移前必须知道的事实一次性跑出来——
 * - 产品 `site` 缺失/非法、ASIN 非法、同 ASIN 重复（当前主键下应为 0，属结构性异常）；
 * - 快照孤儿（`asin_snapshots.asin` 不在产品库）；
 * - `tasks.extra.asin` 没有 site（立项幂等会跨站点互堵）；
 * - `keyword_plans` / `calculator_scenarios` 的裸 ASIN 弱关联；
 * - 运营日志 `asin_json` 的扁平关联清单、库外 ASIN、非法 ASIN。
 *
 * 纪律：
 * 1. 只开 `readOnly` 连接、只跑 SELECT；不建表、不写 meta、不迁移；
 * 2. 输出稳定 JSON（`--out`），可反复跑、可 diff；
 * 3. 缺表/缺列不抛整份失败，按 `available:false` 降级——旧库也能跑。
 *
 * 用法：
 *   node scripts/audit-asin-identity.mjs --db <workbench.db> [--out <report.json>] [--fail-on-findings]
 * 缺省库：`%USERPROFILE%\.dsh\workbench\workbench.db`（可用 DSH_WORKBENCH_DB 覆盖）。
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ASIN_RE = /^[A-Z0-9]{10}$/
const SITE_RE = /^[A-Z]{2}$/

function tableExists(db, name) {
  return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !== undefined
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => String(row.name))
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw) } catch { return fallback }
}

function asinInvalid(value) {
  return typeof value !== 'string' || !ASIN_RE.test(value.trim().toUpperCase())
}

function siteState(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'missing'
  return SITE_RE.test(value.trim()) ? 'ok' : 'invalid'
}

function pushFinding(findings, code, severity, count, detail, samples = []) {
  if (count <= 0) return
  findings.push({ code, severity, count, detail, samples: samples.slice(0, 20) })
}

/** 对一份已打开的库做只读审计（测试可直接注入内存库）。 */
export function auditAsinIdentity(db) {
  const findings = []
  const schemaVersion = (() => {
    if (!tableExists(db, 'meta')) return null
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    return row === undefined ? null : String(row.value)
  })()

  // ---------------- 产品库 ----------------
  const productColumns = tableExists(db, 'asin_products') ? columnNames(db, 'asin_products') : []
  const productsAvailable = productColumns.length > 0
  const productSiteColumn = productColumns.includes('site')
  const productRows = productsAvailable
    ? db.prepare(`SELECT asin${productSiteColumn ? ', site' : ''} FROM asin_products`).all()
    : []
  const productAsins = new Set(productRows.map((row) => String(row.asin).trim().toUpperCase()))

  const siteMissing = productRows.filter((row) => productSiteColumn && siteState(row.site) === 'missing')
  const siteInvalid = productRows.filter((row) => productSiteColumn && siteState(row.site) === 'invalid')
  const asinInvalidProducts = productRows.filter((row) => asinInvalid(row.asin))
  const duplicateAsins = productsAvailable
    ? db.prepare('SELECT asin, COUNT(*) AS n FROM asin_products GROUP BY asin HAVING n > 1').all()
    : []
  /**
   * “同 ASIN 多站点”在当前 schema 下**结构上不可能**（PK 只有 asin），
   * 但仍显式查一次：一旦有人先改了主键却没迁移好，这份报告要能看见。
   */
  const sameAsinMultiSite = productsAvailable && productSiteColumn
    ? db.prepare(`SELECT asin, COUNT(DISTINCT COALESCE(NULLIF(site, ''), '?')) AS sites
        FROM asin_products GROUP BY asin HAVING sites > 1`).all()
    : []
  const siteDistribution = productSiteColumn
    ? db.prepare("SELECT COALESCE(NULLIF(site, ''), '(missing)') AS site, COUNT(*) AS n FROM asin_products GROUP BY site ORDER BY n DESC").all()
    : []

  pushFinding(findings, 'products_site_missing', 'warn', siteMissing.length, '产品行 site 为空；迁移只能作为候选值，不能静默确认 US', siteMissing)
  pushFinding(findings, 'products_site_invalid', 'warn', siteInvalid.length, '产品行 site 不是两位大写字母；需进入复核队列', siteInvalid)
  pushFinding(findings, 'products_asin_invalid', 'warn', asinInvalidProducts.length, '产品行 ASIN 不是 10 位字母数字', asinInvalidProducts)
  pushFinding(findings, 'products_duplicate_asin', 'warn', duplicateAsins.length, '同一 ASIN 出现多行；当前主键下不应发生，属结构性异常', duplicateAsins)
  pushFinding(findings, 'products_same_asin_multi_site', 'warn', sameAsinMultiSite.length, '同一 ASIN 出现在多个站点（当前 schema 本不该允许）', sameAsinMultiSite)
  if (productsAvailable && !productSiteColumn) {
    pushFinding(findings, 'products_site_column_missing', 'warn', 1, '产品表没有 site 列，无法按站点区分', [])
  }

  // ---------------- 快照 ----------------
  const snapshotsAvailable = tableExists(db, 'asin_snapshots')
  const snapshotColumns = snapshotsAvailable ? columnNames(db, 'asin_snapshots') : []
  const snapshotTotal = snapshotsAvailable
    ? Number(db.prepare('SELECT COUNT(*) AS n FROM asin_snapshots').get().n)
    : 0
  const orphanSnapshots = snapshotsAvailable && productsAvailable
    ? db.prepare(`SELECT s.asin, s.captured_at FROM asin_snapshots s
        WHERE NOT EXISTS (SELECT 1 FROM asin_products p WHERE p.asin = s.asin)
        LIMIT 50`).all()
    : []
  const snapshotSiteColumn = snapshotColumns.includes('site')

  pushFinding(findings, 'snapshots_orphan', 'warn', orphanSnapshots.length, '快照的 ASIN 不在产品库；迁移时不能自动补建产品', orphanSnapshots)
  if (snapshotsAvailable && !snapshotSiteColumn) {
    pushFinding(findings, 'snapshots_site_column_missing', 'info', 1, '快照表没有 site 列：趋势当前按裸 ASIN 关联，跨站点会串', [])
  }

  // ---------------- 任务 extra.asin ----------------
  const tasksAvailable = tableExists(db, 'tasks') && columnNames(db, 'tasks').includes('extra')
  const taskRows = tasksAvailable
    ? db.prepare("SELECT id, extra FROM tasks WHERE extra LIKE '%\"asin\"%' LIMIT 500").all()
    : []
  const taskWithoutSite = []
  const taskInvalidAsin = []
  for (const row of taskRows) {
    const extra = safeJson(row.extra, null)
    if (extra === null || typeof extra !== 'object') continue
    const asin = typeof extra.asin === 'string' ? extra.asin.trim().toUpperCase() : ''
    if (asin === '') continue
    if (asinInvalid(asin)) taskInvalidAsin.push({ taskId: row.id, asin })
    if (typeof extra.site !== 'string' || extra.site.trim() === '') taskWithoutSite.push({ taskId: row.id, asin })
  }
  pushFinding(findings, 'tasks_asin_without_site', 'warn', taskWithoutSite.length, 'tasks.extra.asin 没有 site：两个站点的同一 ASIN 立项会互堵', taskWithoutSite)
  pushFinding(findings, 'tasks_asin_invalid', 'warn', taskInvalidAsin.length, 'tasks.extra.asin 不是 10 位字母数字', taskInvalidAsin)

  // ---------------- 弱关联：keyword_plans / calculator_scenarios ----------------
  const weakLinks = []
  const weakLinkByTable = {}
  for (const table of ['keyword_plans', 'calculator_scenarios']) {
    if (!tableExists(db, table)) {
      const missing = { table, available: false, totalRows: null, rows: 0, emptyAsin: null, siteColumn: false }
      weakLinks.push(missing)
      weakLinkByTable[table] = missing
      continue
    }
    const columns = columnNames(db, table)
    const hasAsin = columns.includes('asin')
    const totalRows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
    const rows = hasAsin
      ? db.prepare(`SELECT id, asin FROM ${table} WHERE asin IS NOT NULL AND asin != '' LIMIT 200`).all()
      : []
    const emptyAsin = hasAsin ? totalRows - rows.length : null
    const link = {
      table,
      available: true,
      totalRows,
      rows: rows.length,
      emptyAsin,
      siteColumn: columns.includes('site'),
      bareAsin: !columns.includes('site'),
      samples: rows.slice(0, 20),
    }
    weakLinks.push(link)
    weakLinkByTable[table] = link
    if (rows.length > 0 && !columns.includes('site')) {
      pushFinding(findings, `${table}_bare_asin`, 'info', rows.length, `${table}.asin 是裸 ASIN 弱关联，无 site 列；迁移只能标 unknown，不能猜站点`, rows)
    }
    if (emptyAsin !== null && emptyAsin > 0) {
      pushFinding(findings, `${table}_empty_asin`, 'info', emptyAsin, `${table} 有 ${emptyAsin} 行 asin 为空：本来就没有身份，P4 只能标 unknown`, [])
    }
  }

  // ---------------- 运营日志关联 ----------------
  const oplogAvailable = tableExists(db, 'oplog_entries') && columnNames(db, 'oplog_entries').includes('asin_json')
  const oplogRows = oplogAvailable
    ? db.prepare("SELECT id, asin_json, shop_id, site FROM oplog_entries ORDER BY created_at DESC").all()
    : []
  const oplogSiteDistribution = oplogAvailable
    ? db.prepare("SELECT COALESCE(NULLIF(site, ''), '(missing)') AS site, COUNT(*) AS n FROM oplog_entries GROUP BY site ORDER BY n DESC").all()
    : []
  const oplogSiteMissing = oplogRows.filter((row) => typeof row.site !== 'string' || row.site.trim() === '')
  const oplogSiteInvalid = oplogRows.filter((row) => typeof row.site === 'string' && row.site.trim() !== '' && siteState(row.site) === 'invalid')
  const oplogTypesAvailable = tableExists(db, 'oplog_types')
  const oplogTypesTotal = oplogTypesAvailable
    ? Number(db.prepare('SELECT COUNT(*) AS n FROM oplog_types').get().n)
    : null
  const oplogEntries = []
  const oplogDistinctAsins = new Set()
  const oplogInvalidAsins = []
  const oplogAsinSites = new Map()
  let oplogWithAsins = 0
  let oplogWithoutAsins = 0
  let oplogMultiAsin = 0
  for (const row of oplogRows) {
    const asins = safeJson(row.asin_json, [])
    const list = Array.isArray(asins) ? asins.filter((item) => typeof item === 'string') : []
    if (list.length === 0) oplogWithoutAsins += 1
    else oplogWithAsins += 1
    if (list.length > 1) oplogMultiAsin += 1
    for (const raw of list) {
      const asin = raw.trim().toUpperCase()
      oplogDistinctAsins.add(asin)
      if (asinInvalid(asin)) oplogInvalidAsins.push({ entryId: row.id, asin })
      if (typeof row.site === 'string' && row.site.trim() !== '') {
        const bucket = oplogAsinSites.get(asin) ?? new Set()
        bucket.add(row.site.trim().toUpperCase())
        oplogAsinSites.set(asin, bucket)
      }
    }
    oplogEntries.push({ entryId: row.id, site: row.site ?? null, shopId: row.shop_id ?? null, asins: list })
  }
  const oplogAsinSiteConflicts = [...oplogAsinSites.entries()]
    .filter(([, sites]) => sites.size > 1)
    .map(([asin, sites]) => ({ asin, sites: [...sites].sort() }))
  const oplogAsinsNotInProducts = [...oplogDistinctAsins].filter((asin) => !productAsins.has(asin))

  pushFinding(findings, 'oplog_asin_invalid', 'warn', oplogInvalidAsins.length, '日志 asin_json 里有非法 ASIN', oplogInvalidAsins)
  pushFinding(findings, 'oplog_site_missing', 'info', oplogSiteMissing.length, '日志 site 为空：P4 必须保持 NULL，不得默认回填 US', oplogSiteMissing.map((row) => ({ entryId: row.id })))
  pushFinding(findings, 'oplog_site_invalid', 'warn', oplogSiteInvalid.length, '日志 site 不是两位大写字母', oplogSiteInvalid.map((row) => ({ entryId: row.id, site: row.site })))
  pushFinding(findings, 'oplog_asin_multi_site_conflict', 'warn', oplogAsinSiteConflicts.length, '同一 ASIN 在日志里挂在多个站点：迁移关联前必须人工确认', oplogAsinSiteConflicts)
  pushFinding(findings, 'oplog_flat_asins_without_relation', 'info', oplogMultiAsin, '日志多 ASIN 是扁平数组：没有父/子/SKU 角色，迁移只能标 unknown', [])
  pushFinding(findings, 'oplog_asins_not_in_library', 'info', oplogAsinsNotInProducts.length, '日志引用的 ASIN 不在产品库；不许在迁移时顺手补录', oplogAsinsNotInProducts)

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion,
    counts: {
      products: productRows.length,
      snapshots: snapshotTotal,
      tasksWithAsin: taskRows.length,
      oplogEntries: oplogRows.length,
      oplogWithAsins,
      oplogWithoutAsins,
      oplogMultiAsin,
      oplogSiteMissing: oplogSiteMissing.length,
      oplogTypes: oplogTypesTotal,
      distinctOplogAsins: oplogDistinctAsins.size,
      keywordPlans: weakLinkByTable.keyword_plans?.totalRows ?? null,
      keywordPlansWithAsin: weakLinkByTable.keyword_plans?.rows ?? null,
      calculatorScenarios: weakLinkByTable.calculator_scenarios?.totalRows ?? null,
      calculatorScenariosWithAsin: weakLinkByTable.calculator_scenarios?.rows ?? null,
      calculatorScenariosEmptyAsin: weakLinkByTable.calculator_scenarios?.emptyAsin ?? null,
    },
    structure: {
      productsAvailable,
      productSiteColumn,
      productsCompositeKey: false,
      snapshotsAvailable,
      snapshotSiteColumn,
      oplogAvailable,
      /**
       * 同 ASIN 多站点：当前 PK 只有 asin，结构上不允许；
       * 这里仍给显式结果，避免报告“没提”被读成“没问题”。
       */
      sameAsinMultiSite: {
        possibleUnderCurrentSchema: false,
        count: sameAsinMultiSite.length,
        rows: sameAsinMultiSite,
      },
      weakLinks,
    },
    siteDistribution,
    oplog: {
      entries: oplogEntries,
      truncated: oplogRows.length > 200,
      distinctAsins: [...oplogDistinctAsins].sort(),
      notInProductLibrary: oplogAsinsNotInProducts.sort(),
      asinSiteConflicts: oplogAsinSiteConflicts,
    },
    /** 六类清单：P0 验收按这六项逐条对数字。 */
    checklists: {
      siteMissingOrInvalid: {
        productsMissing: siteMissing.length,
        productsInvalid: siteInvalid.length,
        oplogMissing: oplogSiteMissing.length,
        oplogInvalid: oplogSiteInvalid.length,
        samples: {
          products: [...siteMissing, ...siteInvalid].slice(0, 20),
          oplog: [...oplogSiteMissing, ...oplogSiteInvalid].slice(0, 20).map((row) => ({ entryId: row.id, site: row.site ?? null })),
        },
      },
      sameAsinMultiSite: {
        count: sameAsinMultiSite.length,
        possibleUnderCurrentSchema: false,
        rows: sameAsinMultiSite,
      },
      orphanSnapshots: {
        count: orphanSnapshots.length,
        samples: orphanSnapshots,
      },
      tasksAsinWithoutSite: {
        count: taskWithoutSite.length,
        samples: taskWithoutSite,
      },
      weakAsinLinks: {
        keywordPlans: weakLinkByTable.keyword_plans ?? null,
        calculatorScenarios: weakLinkByTable.calculator_scenarios ?? null,
      },
      oplogAssociations: {
        total: oplogRows.length,
        withAsins: oplogWithAsins,
        withoutAsins: oplogWithoutAsins,
        multiAsin: oplogMultiAsin,
        siteDistribution: oplogSiteDistribution,
        asinsNotInProductLibrary: oplogAsinsNotInProducts.sort(),
        entries: oplogEntries,
        truncated: oplogRows.length > 200,
      },
    },
    findings,
    verdict: findings.some((finding) => finding.severity === 'warn') ? 'needs_review' : 'clean',
  }
}

function defaultDbPath() {
  return process.env.DSH_WORKBENCH_DB ?? join(homedir(), '.dsh', 'workbench', 'workbench.db')
}

function parseArgs(argv) {
  const options = { db: defaultDbPath(), out: null, failOnFindings: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--db' && argv[index + 1] !== undefined) { options.db = resolve(argv[index + 1]); index += 1 }
    else if (arg === '--out' && argv[index + 1] !== undefined) { options.out = resolve(argv[index + 1]); index += 1 }
    else if (arg === '--fail-on-findings') options.failOnFindings = true
  }
  return options
}

function isMain() {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  const options = parseArgs(process.argv.slice(2))
  const db = new DatabaseSync(options.db, { readOnly: true })
  try {
    const report = { dbPath: options.db, ...auditAsinIdentity(db) }
    const text = JSON.stringify(report, null, 2)
    if (options.out !== null) {
      mkdirSync(dirname(options.out), { recursive: true })
      writeFileSync(options.out, `${text}\n`, 'utf8')
      console.log(`audit: schema=${report.schemaVersion} products=${report.counts.products} logs=${report.counts.oplogEntries} findings=${report.findings.length} verdict=${report.verdict} -> ${options.out}`)
    } else {
      console.log(text)
    }
    const warnings = report.findings.filter((finding) => finding.severity === 'warn')
    if (warnings.length > 0) console.error(`warnings: ${warnings.map((item) => `${item.code}=${item.count}`).join(', ')}`)
    if (options.failOnFindings && warnings.length > 0) process.exitCode = 1
  } finally {
    db.close()
  }
}
