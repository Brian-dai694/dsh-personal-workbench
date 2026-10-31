/**
 * ABA 词表：解析 → 分层/判垄断 → 回填（纯函数 + 仓储 + HTTP）。
 *
 * 口径是本模块的**核心资产**，所以测试重点放在边界而不是"能不能跑"：
 * - 列名别名（中文/英文/带括号单位）都能认出来，且不会把「间接订单」之类认成「关键词」；
 * - 百分比歧义：`3.5%` / `3.5` / `0.035` 必须都读成 0.035（差 100 倍是致命误判）；
 * - 分层按排名、垄断按集中度、值得投按购买率 —— 三者互不越权；
 * - 回填是**合并**：DSH 只回填三个词，不能把人工标过的其它词清掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  createAbaKeywordSet, deleteAbaKeywordSet, getAbaKeywordSet, listAbaKeywordSets, setAbaAnnotations,
} from '../lib/db/repo.js'
import {
  classifyAbaRow, parseAbaKeywordTable, sanitizeAbaRows, summarizeAbaTiers,
} from '../lib/shared/abaKeywordTable.js'

const CSV = [
  '关键词,搜索排名,搜索量,点击,购买率,点击集中度',
  'welding gloves,42,"12,400",180,4.2%,62%',
  'tig welding gloves,860,8100,96,3.1,25',
  'silly long tail word,15800,120,3,0.8%,12%',
  'no rank here,,500,2,1.5%,10%',
].join('\n')

test('解析：中文表头 + 千分位 + 百分比两种写法都读对', () => {
  const parsed = parseAbaKeywordTable(CSV)
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.rows.length, 4)
  assert.equal(parsed.headerRow, 1)
  const first = parsed.rows[0]
  assert.equal(first.keyword, 'welding gloves')
  assert.equal(first.rank, 42)
  assert.equal(first.searches, 12400, '带引号的千分位要读成数字')
  assert.equal(first.purchaseRate, 0.042, '4.2% → 0.042')
  assert.equal(first.clickConcentration, 0.62, '62% → 0.62')
  const second = parsed.rows[1]
  assert.equal(second.purchaseRate, 0.031, '3.1（无百分号）→ 0.031')
  assert.equal(second.clickConcentration, 0.25, '25 → 0.25')
  const third = parsed.rows[2]
  assert.equal(third.purchaseRate, 0.008, '0.8%（带百分号）→ 0.008，不能读成 0.8')
  assert.equal(parsed.rows[3].rank, null, '空排名 → null，不是 0')
})

test('解析：英文表头与 Tab 分隔也认；缺列给 warning 不报错', () => {
  const tsv = ['Keyword\tSearch Rank\tSearches', 'abc gloves\t120\t900'].join('\n')
  const parsed = parseAbaKeywordTable(tsv)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.delimiter, '\t')
  assert.equal(parsed.rows[0].rank, 120)
  assert.equal(parsed.rows[0].purchaseRate, null)
  assert.ok(parsed.warnings.some((w) => w.includes('购买率')), '缺购买率必须提示，不能默默按 worth 判断')

  const withBom = '\uFEFF关键词,搜索排名\n手套,10'
  assert.equal(parseAbaKeywordTable(withBom).rows.length, 1, 'BOM 要去掉')
  const noKeyword = parseAbaKeywordTable('a,b\n1,2')
  assert.equal(noKeyword.ok, false)
  assert.match(noKeyword.errors[0], /关键词/)
})

test('解析：重复关键词去重并提示（行数与词数一致才能对账）', () => {
  const parsed = parseAbaKeywordTable(['关键词,搜索排名', 'dup,1', 'DUP,2', 'other,3'].join('\n'))
  assert.equal(parsed.rows.length, 2)
  assert.ok(parsed.warnings.some((w) => w.includes('重复')))
})

test('分层：按搜索排名分头/中/长尾，未知排名单列', () => {
  const rows = [
    { keyword: 'a', rank: 100, searches: 10, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 500 },
    { keyword: 'b', rank: 101, searches: 10, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 500 },
    { keyword: 'c', rank: 1000, searches: 10, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 500 },
    { keyword: 'd', rank: 1001, searches: 10, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 500 },
    { keyword: 'e', rank: null, searches: 10, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 500 },
  ]
  assert.deepEqual(rows.map((row) => classifyAbaRow(row).tier), ['head', 'middle', 'middle', 'tail', 'unknown'])
})

test('判垄断与值得投：阈值边界是闭区间，垄断优先于购买率', () => {
  const base = { keyword: 'x', rank: 50, searches: 100, clicks: 10, purchaseRate: 0.05, clickConcentration: null, spr: 5, products: 500 }
  // 集中度恰好等于 50% → 垄断（闭区间）
  assert.equal(classifyAbaRow({ ...base, clickConcentration: 0.5 }).monopolized, true)
  assert.equal(classifyAbaRow({ ...base, clickConcentration: 0.49 }).monopolized, false)
  // 垄断 + 高购买率：仍判回避（正面打精准不划算），但理由要说清
  const monopolized = classifyAbaRow({ ...base, clickConcentration: 0.7, purchaseRate: 0.09 })
  assert.equal(monopolized.worth, 'avoid')
  // 非垄断 + 购买率恰好 2% → 值得投（闭区间）
  assert.equal(classifyAbaRow({ ...base, clickConcentration: 0.1, purchaseRate: 0.02 }).worth, 'invest')
  assert.equal(classifyAbaRow({ ...base, clickConcentration: 0.1, purchaseRate: 0.019 }).worth, 'watch')
  // 两个指标都缺 → unknown（不许凭排名下结论）
  assert.equal(classifyAbaRow({ ...base, clickConcentration: null, purchaseRate: null }).worth, 'unknown')
})

test('建议匹配方式跟着分层走；未知排名不给建议', () => {
  const base = { keyword: 'x', searches: 1, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 500 }
  assert.equal(classifyAbaRow({ ...base, rank: 10 }).suggestedMatch, 'exact')
  assert.equal(classifyAbaRow({ ...base, rank: 500 }).suggestedMatch, 'phrase')
  assert.equal(classifyAbaRow({ ...base, rank: 5000 }).suggestedMatch, 'broad')
  assert.equal(classifyAbaRow({ ...base, rank: null }).suggestedMatch, null)
})

test('分层汇总：词数/搜索量/垄断数按层聚合，空层不出现', () => {
  const summary = summarizeAbaTiers([
    { keyword: 'a', rank: 10, searches: 100, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.8, spr: 1, products: 100 },
    { keyword: 'b', rank: 20, searches: 200, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 1, products: 100 },
    { keyword: 'c', rank: 5000, searches: 50, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 1, products: 100 },
  ])
  assert.deepEqual(summary.map((item) => item.tier), ['head', 'tail'])
  assert.equal(summary[0].count, 2)
  assert.equal(summary[0].searches, 300)
  assert.equal(summary[0].monopolized, 1)
})

test('服务端清洗：不可信输入被丢弃或夹取，不整表拒绝', () => {
  const rows = sanitizeAbaRows([
    { keyword: 'ok', rank: '12', purchaseRate: 3.5, clickConcentration: -1 },
    { keyword: '', rank: 1 },
    { keyword: 'dup' },
    { keyword: 'DUP' },
    null,
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].rank, null, '字符串数字不收（客户端应已转好）')
  assert.equal(rows[0].purchaseRate, 1, '3.5 夹到 1，不丢行')
  assert.equal(rows[0].clickConcentration, 0, '负数夹到 0')
})

function withDb(run) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  try { return run(db) } finally { db.close() }
}

test('仓储：存证据不存结论；回填按关键词合并（不清掉别的词）', () => withDb((db) => {
  const set = createAbaKeywordSet(db, { title: '焊接手套 ABA', rows: parseAbaKeywordTable(CSV).rows })
  assert.equal(set.rows.length, 4)
  assert.deepEqual(set.annotations, [])

  const once = setAbaAnnotations(db, set.id, [{ keyword: 'welding gloves', worth: 'avoid', suggestedMatch: 'broad', reason: '集中度 62%', evidence: 'observed' }])
  assert.equal(once.annotations.length, 1)
  const twice = setAbaAnnotations(db, set.id, [{ keyword: 'tig welding gloves', worth: 'invest', suggestedMatch: 'phrase', reason: '购买率 3.1%', evidence: 'derived' }])
  assert.equal(twice.annotations.length, 2, '第二次回填不能清掉第一次那条')

  // 非法 worth 被丢弃，不写脏数据
  const bad = setAbaAnnotations(db, set.id, [{ keyword: 'x', worth: '可以做', reason: '' }])
  assert.equal(bad.annotations.length, 2)

  // 关键词大小写不同视为同一个词（覆盖而非新增）
  const recase = setAbaAnnotations(db, set.id, [{ keyword: 'WELDING GLOVES', worth: 'watch', reason: '改判' }])
  assert.equal(recase.annotations.length, 2)
  assert.equal(recase.annotations.find((item) => item.keyword.toLowerCase() === 'welding gloves').worth, 'watch')

  const [summary] = listAbaKeywordSets(db)
  assert.equal(summary.rowCount, 4)
  assert.equal(summary.annotationCount, 2)
  assert.equal(deleteAbaKeywordSet(db, set.id), true)
  assert.equal(getAbaKeywordSet(db, set.id), null)
}))

async function withServer(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db)
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
  if (address === null || typeof address === 'string') { server.close(); db.close(); throw new Error('no port') }
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try { await fn({ request }) } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('路由：导入 → 列表 → 读回 → 回填 → 删除；空表 400', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/aba-keywords', { title: '焊接手套', rows: parseAbaKeywordTable(CSV).rows })
    assert.equal(created.status, 200)
    assert.equal(created.body.set.rows.length, 4)

    const list = await request('GET', '/api/workbench/aba-keywords')
    assert.equal(list.body.sets.length, 1)
    assert.equal(list.body.sets[0].rowCount, 4)

    const filled = await request('PATCH', `/api/workbench/aba-keywords/${created.body.set.id}/annotations`, {
      annotations: [{ keyword: 'welding gloves', worth: 'avoid', suggestedMatch: 'broad', reason: '头部垄断', evidence: 'observed' }],
    })
    assert.equal(filled.status, 200)
    assert.equal(filled.body.set.annotations.length, 1)
    assert.equal(filled.body.set.annotations[0].worth, 'avoid')

    assert.equal((await request('POST', '/api/workbench/aba-keywords', { title: '空表', rows: [] })).status, 400)
    assert.equal((await request('DELETE', `/api/workbench/aba-keywords/${created.body.set.id}`)).status, 200)
    assert.equal((await request('GET', '/api/workbench/aba-keywords')).body.sets.length, 0)
  })
})

/**
 * 关键词 ↔ 搜索词 关联：这是**跨两张表**的联接，必须由行为证明而不是"看着有列"。
 * 用真实 HTTP：先导入搜索词报表（amazon_datasets），再导入 ABA 词表，
 * 断言按词精确匹配、大小写不敏感、未匹配的词不会串到别的行上。
 */
test('关联：ABA 词表与搜索词报表按词精确联接（大小写不敏感、不模糊串词）', async () => {
  await withServer(async ({ request }) => {
    // 1) 先落一份搜索词报表（走到真实导入路由）
    const dataset = await request('POST', '/api/workbench/amazon/datasets', {
      kindCode: 'search_term',
      title: '搜索词报表 自检',
      period: '2026-10-01~2026-10-21',
      sourceCode: 'paste',
      rows: [
        { keyword: 'Welding Gloves', impressions: 1000, clicks: 40, orders: 0, spend: 18.5, sales: 0 },
        { keyword: 'tig welding gloves', impressions: 500, clicks: 20, orders: 3, spend: 9.2, sales: 60 },
      ],
    })
    assert.equal(dataset.status, 201, '数据集导入用 201 Created（不是 200）')

    // 2) 最新一份可被列表拿到、详情能读回行
    const list = await request('GET', '/api/workbench/amazon/datasets?kind_code=search_term')
    assert.equal(list.status, 200)
    assert.ok(list.body.datasets.length >= 1)
    const detail = await request('GET', `/api/workbench/amazon/datasets/${list.body.datasets[0].id}`)
    assert.equal(detail.status, 200)
    const byKeyword = new Map(detail.body.dataset.rows.map((row) => [row.keyword.trim().toLowerCase(), row]))

    // 3) ABA 词表里大小写不同的同一个词必须能对上
    assert.equal(byKeyword.get('welding gloves').orders, 0)
    assert.equal(byKeyword.get('tig welding gloves').sales, 60)
    // 4) 不存在的词不能"就近"匹配到别的行（防模糊串词）
    assert.equal(byKeyword.get('welding glove'), undefined, '少一个字母不能算命中')
  })
})

/**
 * 反向关联（搜索词 → ABA）：多份词表压成查表时的取优规则是**唯一**易错点。
 * 同一个词在不同周期导出里排名会变，取排名更靠前的那份；
 * 人工/DSH 回填的结论优先于规则算出来的结论。
 */
test('查表：同词多份取排名更靠前的那份；回填结论优先；空排名不挤掉有排名的', async () => {
  const { buildAbaLookup, lookupAba, abaBadgeText } = await import('../lib/client/trafficAbaJoin.js')
  const lookup = buildAbaLookup([
    {
      title: '旧表',
      rows: [{ keyword: 'Welding Gloves', rank: 900, searches: 100, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.2, spr: 5, products: 500 }],
    },
    {
      title: '新表',
      rows: [
        { keyword: 'welding gloves', rank: 40, searches: 500, clicks: 5, purchaseRate: 0.06, clickConcentration: 0.7, spr: 5, products: 500 },
        { keyword: 'no rank word', rank: null, searches: 10, clicks: 0, purchaseRate: null, clickConcentration: null, spr: null, products: null },
      ],
    },
    { title: '更旧', rows: [{ keyword: 'no rank word', rank: 3000, searches: 5, clicks: 0, purchaseRate: 0.01, clickConcentration: 0.1, spr: 3, products: 300 }] },
  ])
  const hit = lookupAba(lookup, '  WELDING GLOVES ')
  assert.equal(hit.tier, 'head', '应取排名 40 那份（头部），不是排名 900 那份')
  assert.equal(hit.monopolized, true)
  assert.equal(hit.fromSet, '新表')
  assert.equal(lookupAba(lookup, '不存在的词'), null)
  assert.equal(abaBadgeText(hit), '头部 · 已垄断')
  assert.equal(abaBadgeText(null), '')

  // 回填优先：同一份词表里带 annotation 时覆盖 worth
  const withNote = buildAbaLookup([{ title: 'x', rows: [{ keyword: 'k', rank: 50, searches: 1, clicks: 1, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 500 }], annotations: [{ keyword: 'K', worth: 'avoid', suggestedMatch: null, reason: '人工改判', evidence: 'derived', updatedAt: '' }] }])
  const k = lookupAba(withNote, 'k')
  assert.equal(k.worth, 'avoid')
  assert.equal(k.overridden, true)
})

/**
 * 进入成本两道闸（2026-10-24 由真实回填倒逼）：只看购买率会把 SPR 88 的大词
 * 和 SPR 6 的词判成一样"值得投"。这里钉死：SPR / 商品数任一超限 → 观察；
 * 两者都没有 → **不许给值得投**（购买率只说明有人买，不说明我们挤得进去）。
 */
test('值得投的三维口径：SPR 与商品数超限降级，缺证据不给"值得投"', () => {
  const row = { keyword: 'k', rank: 50, searches: 1000, clicks: 10, purchaseRate: 0.05, clickConcentration: 0.1, spr: 5, products: 1000 }
  assert.equal(classifyAbaRow(row).worth, 'invest')
  assert.equal(classifyAbaRow({ ...row, spr: 31 }).worth, 'watch', 'SPR 超过上限 → 观察')
  assert.equal(classifyAbaRow({ ...row, spr: 30 }).worth, 'invest', 'SPR 恰好等于上限 → 仍可投（闭区间）')
  assert.equal(classifyAbaRow({ ...row, products: 5001 }).worth, 'watch', '商品数超过上限 → 观察')
  assert.equal(classifyAbaRow({ ...row, products: 5000 }).worth, 'invest', '商品数恰好等于上限 → 仍可投')
  const noEvidence = classifyAbaRow({ ...row, spr: null, products: null })
  assert.equal(noEvidence.worth, 'watch', '缺 SPR 与商品数：不给值得投')
  assert.match(noEvidence.reason, /进入成本未知/)
  // 只有一项也够（允许部分证据）
  assert.equal(classifyAbaRow({ ...row, spr: 5, products: null }).worth, 'invest')
  // 阈值可调
  assert.equal(classifyAbaRow({ ...row, spr: 60 }, { maxSpr: 80 }).worth, 'invest')
})

test('解析：SPR 与商品数列的别名能认出来（卖家精灵/后台两种表头）', () => {
  const csv = ['关键词,搜索排名,SPR,商品数', 'tig cups,120,2,1123'].join('\n')
  const parsed = parseAbaKeywordTable(csv)
  assert.equal(parsed.ok, true, parsed.errors.join('；'))
  assert.equal(parsed.rows[0].spr, 2)
  assert.equal(parsed.rows[0].products, 1123)
  const english = parseAbaKeywordTable(['Keyword,Products,SPR', 'abc,900,7'].join('\n'))
  assert.equal(english.rows[0].products, 900)
  assert.equal(english.rows[0].spr, 7)
  // 缺列 → null，不臆造 0
  const missing = parseAbaKeywordTable(['关键词,搜索排名', 'x,10'].join('\n'))
  assert.equal(missing.rows[0].spr, null)
  assert.equal(missing.rows[0].products, null)
})

/**
 * 「规则 vs 回填」差异文案：回填会覆盖规则值，覆盖后界面只剩一个值，
 * 人就分不清"这条是规则判的还是被证据改过的"。差异列必须说清变的是哪一维。
 */
test('差异文案：一致/仅匹配变更/仅结论变更/两者都变，四种情况文案不同', async () => {
  const { describeDivergence } = await import('../lib/client/abaDivergence.js')
  const rule = { worth: 'invest', suggestedMatch: 'broad' }
  assert.equal(describeDivergence(rule, rule, false).text, '一致（规则）')
  assert.equal(describeDivergence(rule, rule, true).text, '一致（回填确认）')
  assert.equal(describeDivergence(rule, rule, false).differs, false)

  const matchOnly = describeDivergence(rule, { worth: 'invest', suggestedMatch: 'phrase' }, true)
  assert.equal(matchOnly.differs, true)
  assert.equal(matchOnly.worthChanged, false)
  assert.equal(matchOnly.matchChanged, true)
  assert.equal(matchOnly.text, '广泛 → 词组')

  const worthOnly = describeDivergence(rule, { worth: 'watch', suggestedMatch: 'broad' }, true)
  assert.equal(worthOnly.text, '值得投 → 观察')

  const both = describeDivergence(rule, { worth: 'avoid', suggestedMatch: null }, true)
  assert.equal(both.worthChanged, true)
  assert.equal(both.matchChanged, true)
  assert.equal(both.text, '值得投 → 避开 · 广泛 → —')
})

/**
 * 三件事的回归：只看不一致的筛选数据源、导出 CSV 的列与口径、按自己数据校准阈值。
 */
test('导出：列齐全、规则值与回填值分列、差异标出、按词联接报表表现', async () => {
  const { buildAbaComparisonCsv, ABA_EXPORT_COLUMNS } = await import('../lib/lib/abaExport.js')
  const set = {
    id: 'aba-x', title: 't', period: null, sourceCode: 'test', createdAt: '', updatedAt: '',
    rows: [
      { keyword: 'tig cups', rank: 616137, searches: 2454, clicks: null, purchaseRate: 0.0315, clickConcentration: 0.3064, spr: 2, products: 1123 },
      { keyword: 'tig cup kit', rank: 1684564, searches: 658, clicks: null, purchaseRate: 0.0277, clickConcentration: 0.512, spr: 1, products: 465 },
    ],
    annotations: [
      { keyword: 'tig cups', worth: 'invest', suggestedMatch: 'phrase', reason: '', evidence: 'observed', updatedAt: '' },
    ],
  }
  const lookup = { get: (kw) => (kw === 'tig cups' ? { clicks: 1, orders: 1, spend: 2.01, sales: 39.94 } : undefined) }
  const { csv, rows } = buildAbaComparisonCsv(set, lookup)
  assert.equal(rows, 2)
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n')
  assert.equal(lines[0], ABA_EXPORT_COLUMNS.join(','))
  const header = lines[0].split(',')
  // 规则与回填必须各占一列（否则导出后就分不清哪个是证据改过的）
  assert.ok(header.includes('规则结论') && header.includes('回填结论'))
  const tig = lines[1].split(',')
  assert.equal(tig[0], 'tig cups')
  assert.equal(tig[header.indexOf('规则结论')], '值得投')
  assert.equal(tig[header.indexOf('回填结论')], '值得投')
  // 长尾 word 的规则匹配是「广泛」，回填改成了「词组」→ 匹配维度不一致
  assert.equal(tig[header.indexOf('一致?')], '否')
  assert.match(tig[header.indexOf('差异')], /广泛 → 词组/)
  assert.equal(tig[header.indexOf('我们的点击')], '1')
  assert.equal(tig[header.indexOf('投放状态')], '有单·达标')
  const kit = lines[2].split(',')
  assert.equal(kit[header.indexOf('投放状态')], '未投放', '报表里没有的词要写未投放，不是 0')
  assert.equal(kit[header.indexOf('我们的点击')], '')
})

test('校准：出单词 <5 时拒绝给阈值；足够时按点击中位数与 ACOS 75 分位反推', async () => {
  const { deriveAdviceThresholds } = await import('../lib/client/adviceCalibration.js')
  const few = deriveAdviceThresholds([
    { keyword: 'a', clicks: 3, orders: 1, spend: 1, sales: 10 },
    { keyword: 'b', clicks: 4, orders: 1, spend: 2, sales: 10 },
  ])
  assert.equal(few.ok, false)
  assert.equal(few.thresholds, null)
  assert.match(few.rationale, /至少需要 5 个/)

  const rows = [
    { keyword: 'w1', clicks: 2, orders: 1, spend: 1, sales: 20 },
    { keyword: 'w2', clicks: 4, orders: 1, spend: 2, sales: 20 },
    { keyword: 'w3', clicks: 4, orders: 1, spend: 4, sales: 20 },
    { keyword: 'w4', clicks: 6, orders: 2, spend: 6, sales: 20 },
    { keyword: 'w5', clicks: 8, orders: 1, spend: 8, sales: 20 },
    // 无单词点击明显更高（12 次）：两组可分，才允许校准
    ...Array.from({ length: 20 }, (_, i) => ({ keyword: `l${i}`, clicks: 12, orders: 0, spend: 3, sales: 0 })),
  ]
  const ok = deriveAdviceThresholds(rows)
  assert.equal(ok.ok, true)
  assert.equal(ok.winners, 5)
  assert.equal(ok.thresholds.wasteMinClicks, 6, '出单词点击 P75 = 6（且 ≥ 下限 3）')
  // ACOS: 0.05,0.1,0.2,0.3,0.4 → 75 分位 = 0.325 → 取 5% 档 = 0.35
  assert.equal(ok.thresholds.goodAcos, 0.3)
  assert.match(ok.rationale, /点击中位数 4/)
  assert.match(ok.rationale, /\$60\.00/, '要把浪费的钱数说出来（20 个无单词 × $3）')
})
