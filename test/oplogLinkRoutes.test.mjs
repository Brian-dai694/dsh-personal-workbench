/**
 * 运营日志 ↔ 任务 / 日历：**路由层**端到端测试。
 *
 * 仓储层的单测（`oplogTaskLink.test.mjs`）只证明 SQL 对；这里跑真 HTTP server + `makeRoutes`，
 * 证明三件用户能感知的事确实通了：
 * 1. `POST /oplog` 带 `taskId` 能落库，`GET /oplog` 能读回（日志卡上的任务链接有数据）；
 * 2. 关联到不存在的任务 → 400（不写脏数据，也不静默丢关联）；
 * 3. `GET /oplog/days` 给出日历格子要的「日期 → 条数」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createTask } from '../lib/db/repo.js'

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
  if (address === null || typeof address === 'string') {
    server.close(); db.close()
    throw new Error('测试服务器没有拿到端口')
  }
  const port = address.port
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try { await fn({ request, db }) } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('日志带 taskId 走 HTTP 落库并读回；候选任务与日期索引一并返回', async () => {
  await withServer(async ({ request, db }) => {
    const task = createTask(db, { title: '重做广告结构', typeCode: 'code_impl', priorityCode: 'p2' })

    const created = await request('POST', '/api/workbench/oplog', {
      title: '三组广泛收成两组', logType: '广告', content: '关掉 2 个高花费无单词',
      logDate: '2026-10-22', taskId: task.id,
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.entry.taskId, task.id)

    const list = await request('GET', '/api/workbench/oplog')
    assert.equal(list.status, 200)
    assert.equal(list.body.entries[0].taskId, task.id)
    // 日历/日志页共用同一份「可关联任务」候选，且只含可执行中任务
    assert.deepEqual(list.body.tasks.map((t) => t.id), [task.id])

    const days = await request('GET', '/api/workbench/oplog/days')
    assert.equal(days.status, 200)
    assert.deepEqual(days.body.days, [{ date: '2026-10-22', count: 1 }])
  })
})

test('关联到不存在的任务被拒（400），且不落库', async () => {
  await withServer(async ({ request }) => {
    const bad = await request('POST', '/api/workbench/oplog', {
      title: '挂到不存在的任务', logType: '其它', logDate: '2026-10-22', taskId: 'no-such-task',
    })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /关联任务不存在/)
    const list = await request('GET', '/api/workbench/oplog')
    assert.equal(list.body.entries.length, 0)
  })
})

test('日志列表支持 ?date= 按业务日期筛选（日历跳转落地）', async () => {
  await withServer(async ({ request }) => {
    for (const [title, date] of [['甲', '2026-10-22'], ['乙', '2026-10-22'], ['丙', '2026-10-20']]) {
      const r = await request('POST', '/api/workbench/oplog', { title, logType: '广告', logDate: date })
      assert.equal(r.status, 200)
    }
    const day = await request('GET', '/api/workbench/oplog?date=2026-10-22')
    assert.equal(day.status, 200)
    assert.deepEqual(day.body.entries.map((e) => e.title).sort(), ['乙', '甲'])

    const days = await request('GET', '/api/workbench/oplog/days')
    const byDate = new Map(days.body.days.map((d) => [d.date, d.count]))
    assert.equal(byDate.get('2026-10-22'), day.body.entries.length, '索引说几条，按日期筛就应得几条')
  })
})
