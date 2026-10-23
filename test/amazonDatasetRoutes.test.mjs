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
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { readSearchTermsTool, saveSearchTermReviewTool } from '../lib/amazon-tools.js'
import { buildFakeCfb, buildXls, buildXlsx } from './_xlsxFixture.mjs'

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
    const created = await request('POST', '/api/workbench/amazon/datasets', { title: 't', rows: ROWS })
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
      title: 't',
      rows: [{ keyword: 'ok', impressions: 1, clicks: 1, orders: 0, spend: 0, sales: 0 }, { keyword: '', impressions: 1, clicks: 1, orders: 0, spend: 0, sales: 0 }],
    })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /不合法的行/)
    const list = await request('GET', '/api/workbench/amazon/datasets')
    assert.equal(list.body.datasets.length, 0, '拒绝时不得留下半份数据')
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
