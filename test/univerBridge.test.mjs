/**
 * 表格能力桥（CSV -> .univer）的编排测试：**不依赖真实 Univer Gateway**。
 *
 * 为什么必须用假服务：真链路要起 Gateway、建 sqlite、跑 Chromium 档次的进程，
 * 不适合放进单测；而这层桥最容易错的地方恰恰是**顺序**与**清理**：
 * 先 newFile 再建草稿再导入，中间 CSV 必须删掉。
 *
 * 断言的是外部可观察行为（调用序列、文件系统终态、返回值形状），不是实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importCsvAsUniverDraft,
  makeUniverOfficeRoutes,
  safeTableName,
  tableStamp,
} from '../lib/api/routes/univer-office.js'

async function withWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-univer-bridge-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 记录调用顺序的假服务；返回值形状对齐 `GatewayUniverService`。 */
function fakeService(options = {}) {
  const calls = []
  const service = {
    async newFile(request) {
      calls.push(['newFile', request])
      if (options.failNewFile === true) return { ok: false, reason: 'GATEWAY_UNAVAILABLE' }
      return { ok: true, operation: 'new', file: request.file, result: { created: true } }
    },
    async worktree(request) {
      calls.push(['worktree', request])
      if (options.noWorktreeId === true) return { ok: true, operation: 'worktree', result: { action: 'create' } }
      return { ok: true, operation: 'worktree', result: { action: 'create', worktreeId: 'wt-1' } }
    },
    async importUnitContent(request) {
      calls.push(['importUnitContent', request])
      if (options.failImport === true) return { ok: false, reason: 'UNIT_IMPORT_FAILED' }
      if (options.noUnitId === true) return { ok: true, operation: 'import', result: {} }
      return { ok: true, operation: 'import', result: { unitId: 'unit-1' } }
    },
  }
  return { calls, service }
}

/** 起一个只挂表格桥路由的本地服务（回环判定要求 127.0.0.1）。 */
async function withRoutes(probe, fn) {
  const routes = makeUniverOfficeRoutes(probe)
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
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error(`测试服务器没有拿到端口（address=${String(address)}）`)
  }
  const base = `http://127.0.0.1:${address.port}`
  const request = async (method, path, body) => {
    const init = body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const res = await fetch(`${base}${path}`, init)
    const text = await res.text()
    return { status: res.status, body: text === '' ? {} : JSON.parse(text) }
  }
  try {
    return await fn({ request })
  } finally {
    server.close()
  }
}

test('顺序：新建文件 -> 建草稿 -> 导入 CSV，且返回 file/worktreeId/unitId', async () => {
  await withWorkspace(async (workspace) => {
    const { calls, service } = fakeService()
    const outcome = await importCsvAsUniverDraft({
      univer: service,
      workspace,
      name: '搜索词结论',
      csv: '搜索词,结论\nfoo,add\n',
      now: new Date('2026-10-29T10:20:30'),
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(calls.map(([name]) => name), ['newFile', 'worktree', 'importUnitContent'])
    assert.equal(calls[0][1].file, outcome.file)
    assert.match(outcome.file, /搜索词结论-\d{8}-\d{6}\.univer$/)
    assert.equal(calls[1][1].action, 'create')
    assert.equal(calls[2][1].worktreeId, 'wt-1')
    assert.equal(calls[2][1].sourceWorkspace, workspace)
    assert.equal(outcome.unitId, 'unit-1', '导入结果里的 unitId 必须透传，前端要靠它定位刚导入的表')
  })
})

test('导入接口拿到的源 CSV 必须真的存在（否则真服务会拒）', async () => {
  await withWorkspace(async (workspace) => {
    const { calls, service } = fakeService()
    let seenSource = ''
    const observed = {
      ...service,
      async importUnitContent(request) {
        const entries = await readdir(join(workspace, '.wb-univer-import'))
        seenSource = entries.length === 1 ? entries[0] : ''
        return service.importUnitContent(request)
      },
    }
    await importCsvAsUniverDraft({
      univer: observed,
      workspace,
      name: 'x',
      csv: 'a,b\n1,2\n',
      now: new Date('2026-10-29T10:20:30'),
    })
    assert.notEqual(seenSource, '', '导入时临时 CSV 应该在 .wb-univer-import 里且只有一个文件')
    assert.equal(calls.length, 3)
  })
})

test('中间 CSV 用完即删：不管成功失败都不留在用户目录', async () => {
  await withWorkspace(async (workspace) => {
    const { service } = fakeService({ failImport: true })
    const outcome = await importCsvAsUniverDraft({
      univer: service,
      workspace,
      name: 'x',
      csv: 'a\n1\n',
      now: new Date('2026-10-29T10:20:30'),
    })
    assert.equal(outcome.ok, false)
    const entries = await readdir(join(workspace, '.wb-univer-import'))
    assert.deepEqual(entries, [], '临时目录应该被清空')
  })
})

test('失败映射：新建文件被拒 -> 不再继续建草稿', async () => {
  await withWorkspace(async (workspace) => {
    const { calls, service } = fakeService({ failNewFile: true })
    const outcome = await importCsvAsUniverDraft({
      univer: service,
      workspace,
      name: 'x',
      csv: 'a\n1\n',
      now: new Date('2026-10-29T10:20:30'),
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.failure.code, 'GATEWAY_UNAVAILABLE')
    assert.deepEqual(calls.map(([name]) => name), ['newFile'])
  })
})

test('契约漂移：草稿结果缺 worktreeId 时明确报错，而不是拿空 id 硬导', async () => {
  await withWorkspace(async (workspace) => {
    const { calls, service } = fakeService({ noWorktreeId: true })
    const outcome = await importCsvAsUniverDraft({
      univer: service,
      workspace,
      name: 'x',
      csv: 'a\n1\n',
      now: new Date('2026-10-29T10:20:30'),
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.failure.code, 'UNIVER_INVALID_RESPONSE')
    assert.deepEqual(calls.map(([name]) => name), ['newFile', 'worktree'])
  })
})

test('文件名净化：路径分隔符与控制字符不能漏进文件名', () => {
  assert.equal(safeTableName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(safeTableName('   '), '报表')
  assert.equal(safeTableName('x'.repeat(80)).length, 60)
})

test('时间戳后缀：同一天两次生成不会互相覆盖', () => {
  assert.equal(tableStamp(new Date('2026-10-29T01:02:03')), '20261029-010203')
  assert.notEqual(
    tableStamp(new Date('2026-10-29T01:02:03')),
    tableStamp(new Date('2026-10-29T01:02:04')),
  )
})

test('导入结果缺 unitId：不把已成功的导入判失败，unitId 回空串', async () => {
  await withWorkspace(async (workspace) => {
    const { service } = fakeService({ noUnitId: true })
    const outcome = await importCsvAsUniverDraft({
      univer: service,
      workspace,
      name: 'x',
      csv: 'a\n1\n',
      now: new Date('2026-10-29T10:20:30'),
    })
    assert.equal(outcome.ok, true, '文件已生成，不该为了一个后续才用的元数据字段让用户重试')
    assert.equal(outcome.unitId, '')
  })
})

test('availability：服务缺失 -> available:false 且 unitContent:unavailable', async () => {
  await withRoutes(() => undefined, async ({ request }) => {
    const res = await request('GET', '/api/workbench/univer/availability')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, available: false, unitContent: 'unavailable' })
  })
})

test('availability：服务在、Gateway 健康 -> unitContent:bundled', async () => {
  const { service } = fakeService()
  const full = {
    ...service,
    async gatewayStatus() { return { phase: 'running', gateway: 'http://127.0.0.1:9080', owned: true } },
    async inspectUnitContent() { return { ok: true } },
  }
  await withRoutes(() => full, async ({ request }) => {
    const res = await request('GET', '/api/workbench/univer/availability')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, available: true, unitContent: 'bundled' })
  })
})

test('availability：Gateway failed 或缺读接口 -> unitContent:unavailable（available 仍为 true）', async () => {
  const { service } = fakeService()
  const failed = {
    ...service,
    async gatewayStatus() { return { phase: 'failed', gateway: null, owned: false, reason: 'spawn failed' } },
    async inspectUnitContent() { return { ok: true } },
  }
  await withRoutes(() => failed, async ({ request }) => {
    const res = await request('GET', '/api/workbench/univer/availability')
    assert.deepEqual(res.body, { ok: true, available: true, unitContent: 'unavailable' })
  })

  const noInspect = {
    ...service,
    async gatewayStatus() { return { phase: 'running', gateway: 'http://127.0.0.1:9080', owned: true } },
  }
  await withRoutes(() => noInspect, async ({ request }) => {
    const res = await request('GET', '/api/workbench/univer/availability')
    assert.deepEqual(res.body, { ok: true, available: true, unitContent: 'unavailable' })
  })
})

test('availability：gatewayStatus 抛错 -> unitContent:unavailable，不把异常抛给浏览器', async () => {
  const { service } = fakeService()
  const broken = {
    ...service,
    async gatewayStatus() { throw new Error('gateway supervisor crashed') },
    async inspectUnitContent() { return { ok: true } },
  }
  await withRoutes(() => broken, async ({ request }) => {
    const res = await request('GET', '/api/workbench/univer/availability')
    assert.equal(res.status, 200)
    assert.equal(res.body.unitContent, 'unavailable')
  })
})

