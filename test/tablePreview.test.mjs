/**
 * 无持久化表格预览（P2 体验统一）：入参契约 + 路由行为。
 *
 * 守四件事：
 * 1. **不落库**：成功响应里没有 datasetId，SQLite 也不参与（路由签名里就没有 db）；
 * 2. **边界明确**：行数/列数/单元格数超限拒绝，行比表头长拒绝（不静默截断），
 *    重复列名拒绝；数字保持裸值（Univer 才能当数字）；
 * 3. **能力缺失可区分**：未装 dsh-univer-office → 503 `UNIVER_MISSING`；
 * 4. **写入仍走 draft**：返回 worktreeId，文件名带时间戳不覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTablePreview, tableRowsToCsv } from '../lib/api/tablePreview.js'
import { makeAmazonTablePreviewRoutes } from '../lib/api/routes/amazon-table-preview.js'

const PREFIX = '/api/workbench/amazon/table-preview'

function fakeService(options = {}) {
  const calls = []
  return {
    calls,
    service: {
      async newFile(request) {
        calls.push(['newFile', request])
        return { ok: true, operation: 'new', result: { created: true } }
      },
      async worktree(request) {
        calls.push(['worktree', request])
        return { ok: true, operation: 'worktree', result: { action: 'create', worktreeId: 'wt-preview' } }
      },
      async importUnitContent(request) {
        calls.push(['importUnitContent', request])
        return { ok: true, operation: 'import', result: { unitId: 'unit-preview' } }
      },
      async fileState() {
        calls.push(['fileState'])
        return { viewerUrl: '/univer-viewer/?file=preview', worktrees: [] }
      },
    },
  }
}

async function withRoutes(probe, fn) {
  const routes = makeAmazonTablePreviewRoutes(probe)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
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
  try { return await fn({ request }) } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('入参契约：补齐短行、数字裸值、CSV 转义与标题缺省', () => {
  const parsed = parseTablePreview({
    title: '',
    columns: ['站点', 'ASIN', '价格'],
    rows: [['US', 'B0AAAAAAA1', 19.9], ['DE']],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.title, '表格预览')
  assert.deepEqual(parsed.data.rows, [['US', 'B0AAAAAAA1', '19.9'], ['DE', '', '']])
  assert.equal(parsed.data.csv, '站点,ASIN,价格\nUS,B0AAAAAAA1,19.9\nDE,,\n')
  assert.equal(tableRowsToCsv(['a'], [['x,y"z']]), 'a\n"x,y""z"\n')
})

test('入参契约：重复列名 / 行比表头长 / 非法单元格 一律 400', () => {
  const dup = parseTablePreview({ columns: ['a', 'a'], rows: [] })
  assert.equal(dup.ok, false)
  assert.equal(dup.status, 400)
  assert.match(dup.message, /列名重复/)

  const wider = parseTablePreview({ columns: ['a'], rows: [['x', 'y']] })
  assert.equal(wider.ok, false)
  assert.match(wider.message, /超过表头/)

  const badCell = parseTablePreview({ columns: ['a'], rows: [[{ nested: true }]] })
  assert.equal(badCell.ok, false)
  assert.match(badCell.message, /非法单元格/)

  const notObject = parseTablePreview('nope')
  assert.equal(notObject.ok, false)
})

test('入参契约：行数/单元格总数超限 → 413，不"尽力而为"', () => {
  const tooManyRows = parseTablePreview({ columns: ['a'], rows: Array.from({ length: 5001 }, () => ['x']) })
  assert.equal(tooManyRows.ok, false)
  assert.equal(tooManyRows.status, 413)

  const tooManyCells = parseTablePreview({
    columns: Array.from({ length: 40 }, (_, index) => `c${index}`),
    rows: Array.from({ length: 1300 }, () => Array.from({ length: 40 }, () => 'x')),
  })
  assert.equal(tooManyCells.ok, false)
  assert.equal(tooManyCells.status, 413)
  assert.match(tooManyCells.message, /单元格总数/)
})

test('路由：未装 Univer → 503 UNIVER_MISSING；GET → 405', async () => {
  await withRoutes(undefined, async ({ request }) => {
    const res = await request('POST', PREFIX, { columns: ['a'], rows: [['x']] })
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'UNIVER_MISSING')

    const notPost = await request('GET', PREFIX)
    assert.equal(notPost.status, 405)
  })
})

test('路由：非法入参 400，不触发任何 Univer 调用', async () => {
  const { calls, service } = fakeService()
  await withRoutes(() => service, async ({ request }) => {
    const res = await request('POST', PREFIX, { columns: ['a', 'a'], rows: [] })
    assert.equal(res.status, 400)
    assert.equal(calls.length, 0)
  })
})

test('路由：成功生成 draft 并回 Viewer 地址（带 sessionId），不落数据集', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'wb-preview-'))
  try {
    const { calls, service } = fakeService()
    await withRoutes(() => service, async ({ request }) => {
      const res = await request('POST', PREFIX, {
        title: '产品库筛选结果',
        columns: ['站点', 'ASIN', '标题'],
        rows: [['US', 'B0AAAAAAA1', '焊枪']],
        workspace,
        sessionId: 'sess-1',
      })
      assert.equal(res.status, 200)
      assert.equal(res.body.ok, true)
      assert.equal(res.body.rows, 1)
      assert.equal(res.body.columns, 3)
      assert.equal(res.body.worktreeId, 'wt-preview')
      assert.match(res.body.file, /产品库筛选结果-\d{8}-\d{6}\.univer$/)
      assert.match(res.body.viewerUrl, /sessionId=sess-1$/)
      assert.equal(res.body.datasetId, undefined, '预览不生成数据集')
      assert.deepEqual(calls.map(([name]) => name), ['newFile', 'worktree', 'importUnitContent', 'fileState'])
    })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('路由：缺 workspace / 相对路径 → 400，且不建文件', async () => {
  const { calls, service } = fakeService()
  await withRoutes(() => service, async ({ request }) => {
    for (const workspace of [undefined, 'relative/dir']) {
      const res = await request('POST', PREFIX, { columns: ['a'], rows: [], workspace })
      assert.equal(res.status, 400)
    }
    assert.equal(calls.length, 0)
  })
})
