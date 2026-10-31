/**
 * v1.18：搜索词「agent 完全读写」的端到端证据。
 *
 * 这条链是三段，缺一段"读写"就是空话，所以一次全测：
 *   1. 面板导入 → `POST /api/workbench/amazon/datasets`（界面走的那条）
 *   2. agent 读   → `workbench_read_search_terms`（读**落库的原始行**，不是提示词里的摘要）
 *   3. agent 写   → `workbench_save_search_term_review`（写回建议，面板随后 GET 得到）
 *
 * 失败信息要能指出是哪一段：所以每段单独断言，不写一个"整体 ok"的大断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { readSearchTermsTool, saveSearchTermReviewTool, saveSearchTermSummaryTool } from '../lib/amazon/tools.js'
import { buildFakeCfb, buildXls, buildXlsx, buildXlsxMulti } from './_xlsxFixture.mjs'

/** 真实报表行（本地 DB 导出后摘出来的），用来验"按词聚合"在工具层真的生效。 */
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/keyword-aggregate.golden.json', import.meta.url), 'utf8'))

const ROWS = [
  { keyword: 'tig torch cup', impressions: 1200, clicks: 18, orders: 2, spend: 9.5, sales: 45 },
  { keyword: 'mig gloves', impressions: 300, clicks: 0, orders: 0, spend: 0, sales: 0 },
]

function startServer() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
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
  return { db, server }
}

async function withServer(fn) {
  const { db, server } = startServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close(); db.close()
    throw new Error(`测试服务器没有拿到端口（address=${String(address)}）`)
  }
  const base = `http://127.0.0.1:${address.port}`
  const request = async (method, path, body) => {
    const init = body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const res = await fetch(`${base}${path}`, init)
    const text = await res.text()
    let parsed
    try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text } }
    return { status: res.status, body: parsed }
  }
  try { await fn({ db, request }) } finally { server.close(); db.close() }
}

test('导入 → agent 读 → agent 写回 → 面板再读：全链路闭环', async () => {
  await withServer(async ({ db, request }) => {
    // 1. 面板导入
    const created = await request('POST', '/api/workbench/amazon/datasets', {
      kindCode: 'search_term',
      title: 'US 搜索词 10/11-10/17',
      period: '2026-10-11~2026-10-17',
      rows: ROWS,
      sourceCode: 'paste',
    })
    assert.equal(created.status, 201)
    const datasetId = created.body.dataset.id
    assert.equal(created.body.dataset.rows.length, 2)

    const list = await request('GET', '/api/workbench/amazon/datasets?kind_code=search_term')
    assert.equal(list.status, 200)
    assert.equal(list.body.datasets.length, 1)
    assert.equal(list.body.datasets[0].rowCount, 2)

    // 2. agent 读：必须看到全部原始行与派生指标
    const readTool = readSearchTermsTool(db)
    const read = await readTool.execute({}, {})
    assert.match(read, /tig torch cup/)
    assert.match(read, /mig gloves/)
    assert.match(read, /\| 21\.11% \|/, 'ACOS 必须由本地计算给出（9.5/45）')
    assert.match(read, /数据集：US 搜索词/)

    // 3. agent 写回
    const writeTool = saveSearchTermReviewTool(db)
    const written = await writeTool.execute({
      dataset_id: datasetId,
      reviews: [
        { keyword: 'tig torch cup', action: 'add_exact', reason: '有单且 ACOS 低', evidence: 'derived' },
        { keyword: 'mig gloves', action: 'negative_exact', reason: '300 曝光 0 点击', evidence: 'observed' },
      ],
    }, {})
    assert.match(written, /建议条数：2/)

    // 4. 面板再读：建议已经出现在同一份数据集上
    const reread = await request('GET', `/api/workbench/amazon/datasets/${datasetId}`)
    assert.equal(reread.status, 200)
    const annotations = reread.body.dataset.annotations
    assert.equal(annotations.length, 2)
    assert.equal(annotations.find((item) => item.keyword === 'mig gloves')?.action, 'negative_exact')
    assert.equal(reread.body.dataset.rows.length, 2, '写建议不得改行数据')

    // agent 再读时能看到自己上次的结论（避免"每轮都从零开始分析"）
    const second = await readTool.execute({ dataset_id: datasetId }, {})
    assert.match(second, /negative_exact/)
  })
})

test('非法建议动作被拒且不留脏数据；未知数据集返回 needs_data', async () => {
  await withServer(async ({ db, request }) => {
    const created = await request('POST', '/api/workbench/amazon/datasets', { kindCode: 'search_term', title: 't', rows: ROWS })
    const id = created.body.dataset.id

    const bad = await request('PATCH', `/api/workbench/amazon/datasets/${id}`, {
      reviews: [{ keyword: 'mig gloves', action: 'pause_campaign' }],
    })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /review\.action 非法/)

    const after = await request('GET', `/api/workbench/amazon/datasets/${id}`)
    assert.equal(after.body.dataset.annotations.length, 0)

    const missing = await readSearchTermsTool(db).execute({ dataset_id: 'nope' }, {})
    assert.match(missing, /needs_data/)

    const emptyDb = readSearchTermsTool(openWorkbenchDb({ dbPath: ':memory:' }))
    assert.match(await emptyDb.execute({}, {}), /needs_data/)
  })
})

test('导入非法行整体拒绝（不做部分导入）', async () => {
  await withServer(async ({ request }) => {
    const bad = await request('POST', '/api/workbench/amazon/datasets', {
      kindCode: 'search_term',
      title: 't',
      rows: [{ keyword: 'ok', impressions: 1, clicks: 1, orders: 0, spend: 0, sales: 0 }, { keyword: '', impressions: 1, clicks: 1, orders: 0, spend: 0, sales: 0 }],
    })
    assert.equal(bad.status, 400)
    // P2-2 起错误信息精确到"第几行哪一列"，不再是一句笼统的"不合法的行"
    assert.match(bad.body.error, /第 2 行的「搜索词」为空/)
    assert.equal(bad.body.code, 'invalid-rows')
    const list = await request('GET', '/api/workbench/amazon/datasets')
    assert.equal(list.body.datasets.length, 0, '拒绝时不得留下半份数据')
  })
})

/**
 * schema 34：报表级结论走 `PATCH { summary }`，`GET` 回 `aiSummary`。
 * 老数据集（导入后没做过结论）必须是 `null`，不能是空对象 —— 空 totals 会被读成"总额 0"。
 * `summary` 与 `reviews` 可以同一次提交（词级建议 + 报表级结论），互不覆盖。
 */
const SUMMARY = {
  version: 1,
  totals: { impressions: 1500, clicks: 18, orders: 2, spend: 9.5, sales: 45, acos: 0.2111 },
  rows: 2,
  uniqueKeywords: 2,
  distribution: { negative: 1, add: 0, watch: 1 },
  negativeSpend: 0,
  notes: ['报表缺广告组/匹配类型，否词需按投放单元复核'],
}

test('PATCH summary：整份替换、GET 回 aiSummary、非法形状被拒', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/amazon/datasets', { kindCode: 'search_term', title: 't', rows: ROWS })
    const id = created.body.dataset.id
    const path = `/api/workbench/amazon/datasets/${id}`
    assert.equal(created.body.dataset.aiSummary, null, '刚导入时 aiSummary 必须是 null')

    const written = await request('PATCH', path, { summary: SUMMARY })
    assert.equal(written.status, 200)
    assert.deepEqual(written.body.dataset.aiSummary, SUMMARY)

    const reread = await request('GET', path)
    assert.deepEqual(reread.body.dataset.aiSummary, SUMMARY)
    assert.equal(reread.body.dataset.rows.length, 2, '写结论不得动行数据')

    // 整份替换：上一次的 totals / notes 不能残留
    const next = { version: 1, rows: 2, uniqueKeywords: 1 }
    const replaced = await request('PATCH', path, { summary: next })
    assert.deepEqual(replaced.body.dataset.aiSummary, next)
    assert.equal('totals' in replaced.body.dataset.aiSummary, false)

    // 词级建议与报表级结论可以同一次提交，互不覆盖
    const both = await request('PATCH', path, {
      reviews: [{ keyword: 'mig gloves', action: 'negative_exact', reason: '300 曝光 0 点击' }],
      summary: SUMMARY,
    })
    assert.equal(both.status, 200)
    assert.equal(both.body.dataset.annotations.length, 1)
    assert.deepEqual(both.body.dataset.aiSummary, SUMMARY)

    // 非法形状：数组 / 字符串 / 空对象一律 400，且不破坏已有结论
    for (const bad of [[], 'x', {}]) {
      const rejected = await request('PATCH', path, { summary: bad })
      assert.equal(rejected.status, 400, `summary=${JSON.stringify(bad)} 应被拒绝`)
    }
    assert.deepEqual((await request('GET', path)).body.dataset.aiSummary, SUMMARY, '被拒的写入不得留下脏数据')

    // 空 body：既不传 reviews 也不传 summary
    assert.equal((await request('PATCH', path, {})).status, 400)
    // 未知数据集
    assert.equal((await request('PATCH', '/api/workbench/amazon/datasets/nope', { summary: SUMMARY })).status, 404)
  })
})

/**
 * T7 · 工具层：`workbench_read_search_terms` 必须带**按词聚合视图**。
 *
 * 用黄金夹具里的真实行（tig cups 44 行 / tig torch 19 行）—— 报表里没有任何一行
 * 到 8 点击，只有按词合并后 `tig torch` 才是 23 点击 0 单。agent 自己聚合就会出现
 * 两套口径，所以聚合必须由工具给。
 */
test('read 工具返回按词聚合视图：词级行数与合计来自真实行', async () => {
  await withServer(async ({ db, request }) => {
    const cups = GOLDEN.cases.find((item) => item.name === '重复词合并').input
    const torch = GOLDEN.cases.find((item) => item.name === '无单词合并').input
    const created = await request('POST', '/api/workbench/amazon/datasets', { kindCode: 'search_term', title: 'T7 聚合', rows: [...cups, ...torch] })
    assert.equal(created.status, 201)
    const datasetId = created.body.dataset.id

    const out = await readSearchTermsTool(db).execute({ dataset_id: datasetId, limit: 5, keyword_limit: 10 }, {})
    assert.match(out, new RegExp(`dataset_id=${datasetId}`), '必须回显 dataset_id')
    assert.match(out, /原始行数：63；唯一词：2/, '1243 行报表里这两个词各占 44 / 19 行')
    assert.match(out, /按词聚合（derived/)

    // 聚合行 = 7 列（逐行明细是 11 列），按花费降序：56.84 > 23.31
    const aggregateLines = out.split('\n').filter((line) => line.startsWith('tig ') && line.split(' | ').length === 7)
    assert.deepEqual(aggregateLines, [
      'tig cups | 3291 | 55 | 4 | $56.84 | $115.87 | 44',
      'tig torch | 982 | 23 | 0 | $23.31 | $0.00 | 19',
    ])

    // keyword_limit 只截聚合视图，不影响合计与逐行明细
    const capped = await readSearchTermsTool(db).execute({ dataset_id: datasetId, limit: 5, keyword_limit: 1 }, {})
    assert.match(capped, /已显示词：1/)
    assert.equal(capped.split('\n').filter((line) => line.startsWith('tig ') && line.split(' | ').length === 7).length, 1)
  })
})

test('summary 工具：写回 ai_summary（整份替换、金额收到分、dataset_id 回显与校验）', async () => {
  await withServer(async ({ db, request }) => {
    const created = await request('POST', '/api/workbench/amazon/datasets', { kindCode: 'search_term', title: 'T7 结论', rows: ROWS })
    const datasetId = created.body.dataset.id
    const path = `/api/workbench/amazon/datasets/${datasetId}`
    const tool = saveSearchTermSummaryTool(db)

    const summary = {
      version: 1,
      dataset_id: datasetId,
      totals: { impressions: 1500, clicks: 18, orders: 2, spend: 9.5000000001, sales: 45, acos: 0.2111 },
      rows: 2,
      uniqueKeywords: 2,
      distribution: { negative: 1, add: 0, watch: 1 },
      negativeSpend: 97.92999999999999,
      topRisks: [{ keyword: 'tig torch', clicks: 23, orders: 0, spend: 23.309999999999999, reason: '23 次点击 0 单' }],
      topOpportunities: [{ keyword: 'tig cups', orders: 4, acos: 0.21, sales: 115.8700000001 }],
      notes: ['报表缺广告组，否词需按投放单元复核'],
      evidence: 'derived',
      session_id: 'session-1',
    }
    const out = await tool.execute({ dataset_id: datasetId, summary }, {})
    assert.match(out, /已写回工作台/)
    assert.match(out, new RegExp(`dataset_id=${datasetId}`), '必须回显 dataset_id')
    assert.match(out, /否词 1 · 加词 0 · 观察 1/)
    assert.match(out, /否词花费 \$97\.93/)
    // 本地真实分层是 negative 0 / add 1（tig torch cup ACOS 21%）/ watch 1 —— 与 agent 给的不一致要出声
    assert.match(out, /distribution 与本地复算不一致/)

    const reread = await request('GET', path)
    const stored = reread.body.dataset.aiSummary
    assert.equal(stored.dataset_id, datasetId)
    assert.equal(stored.totals.spend, 9.5, '金额在写回边界收到分')
    assert.equal(stored.negativeSpend, 97.93)
    assert.equal(stored.topRisks[0].spend, 23.31)
    assert.equal(stored.topOpportunities[0].sales, 115.87)
    assert.equal(reread.body.dataset.rows.length, 2, '写结论不得动行数据')

    // 整份替换：第二次写不带 totals，旧 totals 不能残留；distribution 缺失时由本地口径补全
    const second = await tool.execute({ dataset_id: datasetId, summary: { rows: 2 } }, {})
    assert.match(second, /未提供的字段/)
    assert.match(second, /distribution 缺失，已按本地口径补全/)
    const replaced = (await request('GET', path)).body.dataset.aiSummary
    assert.equal('totals' in replaced, false)
    assert.deepEqual(replaced.distribution, { negative: 0, add: 1, watch: 1, none: 0 }, '本地补全的分层与真实行一致')

    // summary.dataset_id 与参数不一致：拒绝（不许把 A 报表的结论写到 B 上）
    assert.match(await tool.execute({ dataset_id: datasetId, summary: { ...summary, dataset_id: 'other' } }, {}), /invalid_input/)
    // summary 缺 dataset_id：自动回填参数值
    const { dataset_id: _omitted, ...withoutId } = summary
    await tool.execute({ dataset_id: datasetId, summary: withoutId }, {})
    assert.equal((await request('GET', path)).body.dataset.aiSummary.dataset_id, datasetId)
    // 非法入参
    assert.match(await tool.execute({ dataset_id: datasetId, summary: [] }, {}), /invalid_input/)
    assert.match(await tool.execute({ dataset_id: '', summary }, {}), /invalid_input/)
    assert.match(await tool.execute({ dataset_id: 'nope', summary }, {}), /invalid_input/)
  })
})

/**
 * v1.20：Excel 走 `/parse-file` —— 服务端只把文件转成 TSV，
 * 列名解释仍由客户端的 `parseTrafficCsv` 负责（粘贴与选文件同一条闸门）。
 */
test('parse-file：xlsx → TSV；旧版 xls 返回可操作提示', async () => {
  await withServer(async ({ request }) => {
    const xlsx = buildXlsx([
      ['广告搜索词报告'],
      ['2026-10-11 至 2026-10-17'],
      ['用户搜索词', '曝光', '点击', '广告订单', '广告花费', '广告销售额'],
      ['tig torch cup', 1200, 18, 2, 9.5, 45],
    ])
    const ok = await request('POST', '/api/workbench/amazon/datasets/parse-file', {
      filename: '报表.xlsx',
      base64: xlsx.toString('base64'),
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.format, 'xlsx')
    assert.equal(ok.body.sheetCount, 1, 'sheetCount 必须留在响应里：付款对账靠它判断“只导入了第一张”')
    assert.equal(ok.body.sheetName, 'Search Terms')
    assert.match(ok.body.tsv, /用户搜索词\t曝光\t点击/)
    assert.match(ok.body.tsv, /tig torch cup\t1200\t18\t2\t9\.5\t45/)

    const xls = buildXls([
      ['广告搜索词报告'],
      ['用户搜索词', '曝光', '点击', '广告订单', '广告花费', '广告销售额'],
      ['tig torch cup', 1200, 18, 2, 9.5, 45],
    ])
    const legacy = await request('POST', '/api/workbench/amazon/datasets/parse-file', {
      filename: '旧报表.xls',
      base64: xls.toString('base64'),
    })
    assert.equal(legacy.status, 200)
    assert.equal(legacy.body.format, 'xlsx', '路由将 xls/xlsx 统一归一为表格文本')
    assert.match(legacy.body.tsv, /tig torch cup\t1200\t18\t2\t9\.5\t45/)

    // 非 Excel 的 CFB / 加密文件仍明确拒绝，不当文本误读
    const invalid = await request('POST', '/api/workbench/amazon/datasets/parse-file', {
      filename: '损坏.xls',
      base64: buildFakeCfb().toString('base64'),
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.code, 'unreadable')

    // 纯文本（CSV 伪装成未知扩展名）也走同一条路，直接原样返回
    const textRes = await request('POST', '/api/workbench/amazon/datasets/parse-file', {
      filename: 'weird.dat',
      base64: Buffer.from('keyword,impressions\nfoo,10', 'utf8').toString('base64'),
    })
    assert.equal(textRes.status, 200)
    assert.equal(textRes.body.format, 'text')
  })
})

test('parse-file：多 sheet 时保留 sheetCount，前端据此提示“只导入了第一张”', async () => {
  await withServer(async ({ request }) => {
    const multi = buildXlsxMulti([
      { name: '日期范围报告', rows: [['订单号', '金额'], ['111-222', '29.99']] },
      { name: '结算报告', rows: [['结算单号', '金额'], ['S-1', '-12.40']] },
    ])
    const res = await request('POST', '/api/workbench/amazon/datasets/parse-file', {
      filename: '付款报表.xlsx',
      base64: multi.toString('base64'),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.sheetCount, 2, '多 sheet 的数量必须如实回传，不能被“只取第一张”顺手优化掉')
    assert.equal(res.body.sheetName, '日期范围报告')
    assert.match(res.body.tsv, /订单号\t金额/)
    assert.doesNotMatch(res.body.tsv, /结算单号/, '当前口径只返回第一张 sheet，前端负责提示用户')
  })
})

/**
 * 回归（2026-10-22）：请求体上限必须按端点区分。
 *
 * 旧实现三处都吃 `readJsonBody` 的默认 256KB，于是：
 * - 几百 KB 的 CSV 经 base64 后进不了 `parse-file`，`MAX_FILE_BASE64`(10MB) 形同虚设；
 * - 几千行搜索词 rows（本身就数百 KB）同样进不了 `POST /`；
 * - 两者都被拒成 `400 invalid JSON body`，文案指向"JSON 不合法"，与真实原因（太大）不符。
 *
 * 实测（本机 1.17.0）：98KB 可进处理逻辑，293KB 直接 `400 invalid JSON body`。
 */
test('大报表不再被 256KB 默认上限误杀；超限明确回 413', async () => {
  await withServer(async ({ request }) => {
    // 1) 约 300KB 的 CSV → base64 约 400KB，旧实现必然 400 invalid JSON body
    const csv = 'keyword,clicks,orders,spend,sales\n' + 'tig torch cup padded,1,0,0.5,0\n'.repeat(9000)
    const bigText = await request('POST', '/api/workbench/amazon/datasets/parse-file', {
      filename: 'big.csv',
      base64: Buffer.from(csv, 'utf8').toString('base64'),
    })
    assert.equal(bigText.status, 200, '几百 KB 的文本 CSV 应能通过 parse-file')
    assert.equal(bigText.body.format, 'text')

    // 2) 4000 行 rows JSON 约 400KB，旧实现同样被拒
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      keyword: `keyword-${i}`,
      impressions: 100,
      clicks: 2,
      orders: 0,
      spend: 0.5,
      sales: 0,
    }))
    const created = await request('POST', '/api/workbench/amazon/datasets', { kindCode: 'search_term', title: '大报表', rows })
    assert.equal(created.status, 201, '几百 KB 的 rows 应能导入')
    assert.equal(created.body.dataset.rows.length, 4000)

    // 3) 真正超限：PATCH 上限 1MB，1.2MB 的体在读体前就被 413 拦下
    const tooLarge = await request('PATCH', `/api/workbench/amazon/datasets/${created.body.dataset.id}`, {
      summary: { blob: 'x'.repeat(1200 * 1024) },
    })
    assert.equal(tooLarge.status, 413, '超限应是 413，不是 400 invalid JSON body')
    assert.equal(tooLarge.body.code, 'too-large')
  })
})

test('parse-file 的超限预判按“源文件约 7.5MB”口径，不提示 12MB', async () => {
  await withServer(async ({ request }) => {
    /**
     * 构造 > 10MB base64 的请求体。旧实现用 12MB 的读体上限做预判，
     * 这个体量会因为"上限 12MB"文案被拒 —— 用户看到的数字与 7.5MB 的真实门槛对不上。
     */
    const hugeBase64 = 'A'.repeat(10 * 1024 * 1024 + 128 * 1024)
    const res = await request('POST', '/api/workbench/amazon/datasets/parse-file', {
      filename: 'huge.xlsx',
      base64: hugeBase64,
    })
    assert.equal(res.status, 413)
    assert.equal(res.body.code, 'too-large')
    assert.match(res.body.error, /7\.5MB/, '文案必须说源文件约 7.5MB')
    assert.doesNotMatch(res.body.error, /12MB/, '不得再出现 12MB 这类读体上限口径')
  })
})

test('kind 守卫：缺 kind 拒绝写入；非搜索词报表不能被当搜索词读或写', async () => {
  await withServer(async ({ db, request }) => {
    // 1) 缺 kind：新老两个入口都 400 missing-kind，且不落库
    const missingLegacy = await request('POST', '/api/workbench/amazon/datasets', { title: '无类型', rows: ROWS })
    assert.equal(missingLegacy.status, 400)
    assert.equal(missingLegacy.body.code, 'missing-kind')
    const missingImport = await request('POST', '/api/workbench/amazon/import', { title: '无类型', rows: ROWS })
    assert.equal(missingImport.status, 400)
    assert.equal(missingImport.body.code, 'missing-kind')
    assert.equal((await request('GET', '/api/workbench/amazon/datasets')).body.datasets.length, 0, '被拒的写入不得落库')

    // 2) 建一份 campaign 数据集（核心六列即可，无额外必填列）
    const campaign = await request('POST', '/api/workbench/amazon/import', {
      kind_code: 'campaign',
      title: '活动报表',
      rows: ROWS,
    })
    assert.equal(campaign.status, 201)
    const id = campaign.body.dataset.id

    // 3) 读工具按 id 不得把 campaign 当搜索词分析
    const read = await readSearchTermsTool(db).execute({ dataset_id: id }, {})
    assert.match(read, /invalid_input/)
    assert.match(read, /campaign/)

    // 4) reviews / summary 写入必须拒绝，且不留半份数据
    const review = await request('PATCH', `/api/workbench/amazon/datasets/${id}`, {
      reviews: [{ keyword: 'tig torch cup', action: 'negative_exact' }],
    })
    assert.equal(review.status, 400)
    assert.match(review.body.error, /kind_mismatch/)

    const summary = await request('PATCH', `/api/workbench/amazon/datasets/${id}`, { summary: SUMMARY })
    assert.equal(summary.status, 400)
    assert.match(summary.body.error, /kind_mismatch/)

    const after = await request('GET', `/api/workbench/amazon/datasets/${id}`)
    assert.deepEqual(after.body.dataset.annotations, [], '被拒的 reviews 不得写入')
    assert.equal(after.body.dataset.aiSummary, null, '被拒的 summary 不得写入')
  })
})
