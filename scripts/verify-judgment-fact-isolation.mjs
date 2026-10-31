/**
 * P3 验收 B2：写选品判断**不得改动产品事实字段**。
 *
 * 背景：`setAsinJudgment` 原先顺带 `UPDATE ... updated_at = ?`，用户在选品页点一下结论，
 * 产品库里的「更新时间」就变了 —— 等于选品改了主档。修完后用这个脚本逐字段对比证明。
 *
 * 硬纪律：
 * - 默认在**临时文件库**里造数据（走与线上同一套迁移，schema 37），不连接正本；
 * - 传 `--db` 时先做 realpath 比对，命中 `~/.dsh/workbench/workbench.db` 直接退出 2；
 * - 只读正本的 mtime 作为旁证，不打开它。
 *
 * 用法：
 *   node scripts/verify-judgment-fact-isolation.mjs [--out test-results\/p3-b2-judgment-isolation.json]
 *   node scripts/verify-judgment-fact-isolation.mjs --db <副本.db>
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { openWorkbenchDb } from '../lib/db/database.js'
import { importAsinProducts, setAsinJudgment } from '../lib/db/repo/asin.js'

const LIVE_DB = join(homedir(), '.dsh', 'workbench', 'workbench.db')

function canonical(path) {
  try { return realpathSync.native(path).toLowerCase() } catch { return resolve(path).toLowerCase() }
}

function parseArgs(argv) {
  const options = { db: null, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--db' && argv[index + 1] !== undefined) { options.db = resolve(argv[index + 1]); index += 1 }
    else if (arg === '--out' && argv[index + 1] !== undefined) { options.out = resolve(argv[index + 1]); index += 1 }
  }
  return options
}

function liveMtime() {
  try {
    const stats = statSync(LIVE_DB)
    return { mtimeUtc: stats.mtime.toISOString(), length: stats.size }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const FACT_COLUMNS = ['updated_at', 'title', 'price', 'shop_id', 'shop_name', 'site']
const JUDGMENT_COLUMNS = ['verdict', 'score', 'judged_at', 'judged_source', 'judgment_json']

function snapshot(db, asin) {
  const row = db.prepare(`SELECT ${[...FACT_COLUMNS, ...JUDGMENT_COLUMNS].join(', ')} FROM asin_products WHERE asin = ?`).get(asin)
  if (row === undefined) throw new Error(`商品不存在：${asin}`)
  const facts = {}
  const judgment = {}
  for (const key of FACT_COLUMNS) facts[key] = row[key]
  for (const key of JUDGMENT_COLUMNS) judgment[key] = row[key]
  return { facts, judgment }
}

function seed(db) {
  const at = '2026-10-01T00:00:00.000Z'
  importAsinProducts(db, [{
    asin: 'B0B2PROOF1',
    site: 'US',
    identityState: 'ok',
    title: '气密焊枪（B2 夹具）',
    currentTitle: null,
    imageUrl: null,
    url: null,
    price: 19.9,
    currency: 'USD',
    rating: 4.5,
    reviews: 100,
    bsr: 1000,
    brand: 'YOBEL',
    seller: 'YOBEL',
    shopId: 'SHOP1',
    shopName: 'YOBEL 官方店',
    category: '焊枪',
    note: null,
    tags: [],
    extraJson: '{}',
    addedAt: at,
    updatedAt: at,
  }], [], 0, null)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  let tempDir = null
  let dbPath = options.db
  if (dbPath !== null) {
    if (canonical(dbPath) === canonical(LIVE_DB)) {
      console.error(`refused: ${dbPath} 是正在使用的正本数据库`)
      process.exit(2)
    }
  } else {
    tempDir = mkdtempSync(join(tmpdir(), 'wb-b2-'))
    dbPath = join(tempDir, 'workbench.db')
  }

  const liveBefore = liveMtime()
  const db = openWorkbenchDb({ dbPath })
  const report = { dbPath, schemaVersion: null, checks: [], pass: false, liveBefore }
  try {
    report.schemaVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null
    seed(db)
    const before = snapshot(db, 'B0B2PROOF1')

    setAsinJudgment(db, 'B0B2PROOF1', {
      verdict: 'do',
      score: 82,
      nextAction: '先做 20 件小批量验证气密性',
      criteria: [{ name: '需求', value: '7/10' }],
      painPoints: [{ label: '气体保护失效', count: 8 }],
      risk: { level: 'low', note: '未查到近似商标' },
      keywordCount: 37,
      source: 'manual',
    }, 'US')
    const afterFirst = snapshot(db, 'B0B2PROOF1')

    /** 只改结论（界面点 chip 的场景）：事实仍不能动。 */
    setAsinJudgment(db, 'B0B2PROOF1', { verdict: 'watch' }, 'US')
    const afterSecond = snapshot(db, 'B0B2PROOF1')

    const factsEqualFirst = FACT_COLUMNS.every((key) => before.facts[key] === afterFirst.facts[key])
    const factsEqualSecond = FACT_COLUMNS.every((key) => before.facts[key] === afterSecond.facts[key])
    const verdictUpdated = afterFirst.judgment.verdict === 'do' && afterSecond.judgment.verdict === 'watch'
    const scoreUpdated = afterFirst.judgment.score === 82
    const judgedAtSet = typeof afterFirst.judgment.judged_at === 'string' && afterFirst.judgment.judged_at !== ''

    report.checks.push({
      name: '判断写入不改产品事实字段',
      columns: FACT_COLUMNS,
      before: before.facts,
      afterFirst,
      afterSecond: afterSecond.facts,
      pass: factsEqualFirst && factsEqualSecond,
    }, {
      name: '判断字段正常更新',
      first: afterFirst.judgment,
      second: afterSecond.judgment,
      pass: verdictUpdated && scoreUpdated && judgedAtSet,
    })
    report.pass = factsEqualFirst && factsEqualSecond && verdictUpdated && scoreUpdated && judgedAtSet
  } finally {
    db.close()
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true })
  }

  report.liveAfter = liveMtime()
  report.liveUntouched = report.liveBefore.mtimeUtc === report.liveAfter.mtimeUtc
    && report.liveBefore.length === report.liveAfter.length
  report.pass = report.pass && report.liveUntouched

  console.log(JSON.stringify(report, null, 2))
  if (options.out !== null) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.exit(report.pass ? 0 : 1)
}

main()
