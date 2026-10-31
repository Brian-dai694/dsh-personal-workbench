/**
 * P2-3：数据集 → `.univer` 表格（`POST /api/workbench/amazon/datasets/:id/table`）。
 *
 * 用**假 Univer 服务**测编排，不起真 Gateway：
 * - 没装 → 503 + 中文原因（不伪造路径）；
 * - 生成 → 文件名 sanitize（中文保留、`/` `:` 换 `-`）、写回 `univer_file`、
 *   返回值带 `viewerUrl`（草稿优先，附 sessionId）；
 * - **复用**：第二次点不新建草稿（`reused: true`）；文件被删 / `regenerate` 才重建；
 * - `viewerUrl` 挑选顺序与 `shared/univerViewer.ts` 一致，客户端 hook 的导出与它同源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { getAmazonDataset } from '../lib/db/repo.js'
import { safeDatasetTableName } from '../lib/api/routes/amazon-dataset-table.js'
import { viewerUrlOf, withUniverSession } from '../lib/shared/univerViewer.js'
import { viewerUrlOf as clientViewerUrlOf } from '../lib/client/hooks/useUniverCsvTable.js'
import { datasetRowsToCsv } from '../lib/amazon/import.js'

const ROWS = [
  { keyword: 'tig torch', impressions: 100, clicks: 23, orders: 0, spend: 23.31, sales: 0 },
  { keyword: 'tig cups', impressions: 200, clicks: 55, orders: 4, spend: 56.84, sales: 115.87 },
]

/** 假服务：记录调用，newFile 真的落一个空文件（复用判断要 stat 真实文件）。 */
function fakeUniver(state) {
  const calls = []
  return {
    calls,
    service: {
      async newFile(request) {
        calls.push(['newFile', request.file])
        await writeFile(request.file, '', 'utf8')
        return { ok: true, result: { created: true } }
      },
      async worktree(request) {
        calls.push(['worktree', request.file])
        return { ok: true, result: { worktreeId: `wt-${calls.length}` } }
      },
      async importUnitContent(request) {
        calls.push(['importUnitContent', request.file])
        return { ok: true, result: {} }
      },
      async fileState(request) {
        calls.push(['fileState', request.file])
        return state(request)
      },
    },
  }
}

function startServer(probeUniver) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db, probeUniver === undefined ? {} : { probeUniver })
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

async function withServer(probeUniver, fn) {
  const { db, server } = startServer(probeUniver)
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

async function withWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-dataset-table-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const DRAFT_STATE = () => ({
  ok: true,
  viewerUrl: '/univer-viewer/?file=trunk',
  worktrees: [
    { status: 'draft', worktreeUrl: '/univer-viewer/draft?wt=1' },
    { status: 'ready', mergeUrl: '/univer-viewer/merge?wt=2' },
  ],
})

async function createDataset(request, title = '搜索词报表 2026/10/29 14:56:14') {
  const created = await request('POST', '/api/workbench/amazon/import', {
    kind_code: 'search_term',
    title,
    period: '2026-10-18~2026-10-24',
    rows: ROWS,
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.dataset.id
}

test('未装 dsh-univer-office → 503 + 明确中文原因（不伪造路径）', async () => {
  await withServer(undefined, async ({ request }) => {
    const id = await createDataset(request)
    const res = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, { workspace: 'C:\\any' })
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'UNIVER_MISSING')
    assert.match(res.body.error, /没装 dsh-univer-office/)
    assert.equal(res.body.file, undefined, '不能编一个文件路径')
  })
})

test('探测返回不完整服务（缺 fileState）也当没装', async () => {
  await withServer(() => ({ newFile: async () => ({ ok: true }), worktree: async () => ({ ok: true }), importUnitContent: async () => ({ ok: true }) }), async ({ request }) => {
    const id = await createDataset(request)
    const res = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, { workspace: 'C:\\any' })
    assert.equal(res.status, 503)
    assert.equal(res.body.code, 'UNIVER_MISSING')
  })
})

test('生成表格：文件名 sanitize、写回 univer_file、viewerUrl 取草稿 + sessionId', async () => {
  await withWorkspace(async (workspace) => {
    const fake = fakeUniver(DRAFT_STATE)
    await withServer(() => fake.service, async ({ db, request }) => {
      const id = await createDataset(request)

      const res = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, { workspace, sessionId: 's-1' })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.reused, false)
      assert.equal(res.body.datasetId, id)
      assert.ok(res.body.file.startsWith(workspace), '文件必须落在给定工作区里')
      const fileName = res.body.file.slice(workspace.length + 1)
      assert.match(fileName, /^搜索词报表 2026-10-29 14-56-14-\d{8}-\d{6}\.univer$/, `文件名要 sanitize：${fileName}`)
      assert.equal((await stat(res.body.file)).isFile(), true)
      assert.match(res.body.viewerUrl, /\/univer-viewer\/draft/, '草稿优先')
      assert.match(res.body.viewerUrl, /sessionId=s-1$/, 'viewerUrl 要带 sessionId')
      assert.deepEqual(fake.calls.map(([name]) => name), ['newFile', 'worktree', 'importUnitContent', 'fileState'])

      const stored = getAmazonDataset(db, id)
      assert.equal(stored?.univerFile, res.body.file, '路径要写回库')
    })
  })
})

test('复用：第二次点不再新建草稿；文件被删或 regenerate 才重建', async () => {
  await withWorkspace(async (workspace) => {
    const fake = fakeUniver(DRAFT_STATE)
    await withServer(() => fake.service, async ({ request }) => {
      const id = await createDataset(request)
      const first = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, { workspace })
      assert.equal(first.body.reused, false)
      const createdCalls = fake.calls.filter(([name]) => name === 'newFile').length

      const second = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, { workspace })
      assert.equal(second.status, 200)
      assert.equal(second.body.reused, true)
      assert.equal(second.body.file, first.body.file, '复用同一个文件')
      assert.equal(fake.calls.filter(([name]) => name === 'newFile').length, createdCalls, '复用不得新建文件')
      assert.equal(fake.calls.filter(([name]) => name === 'worktree').length, 1, '复用不得新建草稿')

      // 文件被删 → 重新生成（同一秒内可能复用同一个文件名，这里只断言"真的重建了"）
      await unlink(first.body.file)
      const before = fake.calls.filter(([name]) => name === 'newFile').length
      const third = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, { workspace })
      assert.equal(third.body.reused, false)
      assert.equal(fake.calls.filter(([name]) => name === 'newFile').length, before + 1)
      assert.equal((await stat(third.body.file)).isFile(), true)

      // 明确点"重新生成" → 即使文件在也新建（不返回 reused）
      const beforeRegen = fake.calls.filter(([name]) => name === 'newFile').length
      const fourth = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, { workspace, regenerate: true })
      assert.equal(fourth.body.reused, false)
      assert.equal(fake.calls.filter(([name]) => name === 'newFile').length, beforeRegen + 1)
    })
  })
})

test('生成时需要 workspace；缺了 400，不猜一个目录写进去', async () => {
  await withServer(() => fakeUniver(DRAFT_STATE).service, async ({ request }) => {
    const id = await createDataset(request)
    const res = await request('POST', `/api/workbench/amazon/datasets/${id}/table`, {})
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'WORKSPACE_REQUIRED')
    assert.match(res.body.error, /workspace/)
  })
})

test('未知数据集 404', async () => {
  await withServer(() => fakeUniver(DRAFT_STATE).service, async ({ request }) => {
    const res = await request('POST', '/api/workbench/amazon/datasets/nope/table', { workspace: 'C:\\any' })
    assert.equal(res.status, 404)
  })
})

test('viewerUrl 挑选顺序与 hook 同源：草稿 → ready 合并 → trunk', () => {
  const draft = DRAFT_STATE()
  assert.equal(viewerUrlOf(draft), '/univer-viewer/draft?wt=1')
  assert.equal(viewerUrlOf({ viewerUrl: '/trunk', worktrees: [{ status: 'ready', mergeUrl: '/merge' }] }), '/merge')
  assert.equal(viewerUrlOf({ viewerUrl: '/trunk', worktrees: [] }), '/trunk')
  assert.equal(viewerUrlOf(null), '')
  // 客户端 hook 的导出必须与服务端用的是同一份实现（不是各写一份）
  for (const state of [draft, { viewerUrl: '/trunk' }, { worktrees: [{ status: 'ready', worktreeUrl: '/wt' }] }, null]) {
    assert.equal(clientViewerUrlOf(state), viewerUrlOf(state))
  }
  assert.equal(withUniverSession('/u?file=a', 's 1'), '/u?file=a&sessionId=s%201')
  assert.equal(withUniverSession('', 's'), '')
})

test('文件名净化：中文保留，非法字符换 -，结尾点/空格去掉，长名截断', () => {
  assert.equal(safeDatasetTableName('搜索词报表 2026/10/29 14:56:14'), '搜索词报表 2026-10-29 14-56-14')
  assert.equal(safeDatasetTableName('a\\b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
  assert.equal(safeDatasetTableName('报表...  '), '报表')
  assert.equal(safeDatasetTableName('   '), 'amazon-dataset')
  assert.equal(safeDatasetTableName('长'.repeat(80)).length, 60)
})

test('CSV：中文表头、数字裸值、按 kind 取列', () => {
  const csv = datasetRowsToCsv('search_term', ROWS)
  const [header, first] = csv.trimEnd().split('\n')
  assert.equal(header, '搜索词,曝光,点击,订单,花费,销售额')
  assert.equal(first, 'tig torch,100,23,0,23.31,0', '数字不能加引号（否则 Univer 当文本）')
  const share = datasetRowsToCsv('impression_share', [{ ...ROWS[0], share: 0.12 }]).trimEnd().split('\n')
  assert.equal(share[0], '搜索词,曝光,点击,订单,花费,销售额,曝光份额')
  assert.equal(share[1], 'tig torch,100,23,0,23.31,0,0.12')
  // 含逗号的词必须按 CSV 规则转义
  assert.match(datasetRowsToCsv('search_term', [{ ...ROWS[0], keyword: 'a,b' }]), /"a,b",100/)
})
