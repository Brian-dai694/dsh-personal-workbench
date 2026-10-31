/**
 * Step 0 后端契约：搜索词阈值存在设置域，两页读同一个值。
 *
 * 断言的是**对外可观察行为**：GET 默认 null、POST 后立刻回读、null 清空、
 * 越界按校准口径夹取、保存别的设置不会顺手重置阈值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { makeRoutes } from '../lib/api/routes.js'

function startServer() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
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
    return { status: res.status, body: text === '' ? {} : JSON.parse(text) }
  }
  try { await fn({ db, request }) } finally { server.close(); db.close() }
}

test('搜索词阈值：默认 null、可设可清、越界按校准口径夹取', async () => {
  await withServer(async ({ request }) => {
    const initial = await request('GET', '/api/workbench/settings')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.settings.amazonKeywordThresholds, null, '未校准必须是 null，不能是空对象')

    const written = await request('POST', '/api/workbench/settings', {
      amazonKeywordThresholds: { wasteMinClicks: 5, goodAcos: 0.2 },
    })
    assert.equal(written.status, 200)
    assert.deepEqual(written.body.settings.amazonKeywordThresholds, { wasteMinClicks: 5, goodAcos: 0.2 })

    const reread = await request('GET', '/api/workbench/settings')
    assert.deepEqual(reread.body.settings.amazonKeywordThresholds, { wasteMinClicks: 5, goodAcos: 0.2 }, '刷新后仍生效')

    /** 越界按 adviceCalibration 同口径夹取：点击下限 3、ACOS 0.1–0.95。 */
    const clamped = await request('POST', '/api/workbench/settings', {
      amazonKeywordThresholds: { wasteMinClicks: 1, goodAcos: 2 },
    })
    assert.deepEqual(clamped.body.settings.amazonKeywordThresholds, { wasteMinClicks: 3, goodAcos: 0.95 })

    /** 保存别的设置不得顺手重置阈值。 */
    const kept = await request('POST', '/api/workbench/settings', { defaultWorkspace: 'D:\\Code\\x' })
    assert.deepEqual(kept.body.settings.amazonKeywordThresholds, { wasteMinClicks: 3, goodAcos: 0.95 })

    const cleared = await request('POST', '/api/workbench/settings', { amazonKeywordThresholds: null })
    assert.equal(cleared.body.settings.amazonKeywordThresholds, null, 'null 清空回默认')
  })
})
