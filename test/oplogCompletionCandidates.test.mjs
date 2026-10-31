/**
 * 运营日志 ↔ 任务：**待归档建议 / 反向查询 / 候选池放开**（2026-10-27）。
 *
 * 三件事各自对应一个真实的用户痛点：
 * 1. 任务完成了，但没人记得去运营日志里补一笔 → 日志页给"待归档"建议（**只出建议，不自动写**）；
 * 2. 日志能指向任务，任务却看不到自己被谁提到过 → 反向查询；
 * 3. 候选池排除了 `done`，于是"任务一完成就再也关联不上" → 放开，未完成仍排前。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  createOplogEntry, createTask, listOplogCompletionCandidates, listOplogEntriesByTask,
  listOplogTaskOptions, localDateString, updateTask,
} from '../lib/db/repo.js'

function freshDb() {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  return db
}

/** 一条最小可用的日志草稿；`taskId` 由调用方按需覆盖。 */
const draft = (over) => ({
  title: '日志', logType: '广告', contentText: '', shopId: null, site: null,
  logDate: localDateString(), asins: [], documents: [], ...over,
})

test('待归档建议：只给「当天完成 且 还没写过日志」的任务', () => {
  const db = freshDb()
  try {
    const today = localDateString()

    const doneToday = createTask(db, { title: '完成A', typeCode: 'code_impl', priorityCode: 'p2' })
    updateTask(db, doneToday.id, { statusCode: 'done' })

    // 别的日子完成：completed_at 是 UTC ISO，按**本地日**判定，2020 年那天不该混进今天
    const doneOtherDay = createTask(db, { title: '完成B', typeCode: 'code_impl', priorityCode: 'p2' })
    updateTask(db, doneOtherDay.id, { statusCode: 'done' }, 'user', '2020-01-01T03:00:00.000Z')

    const stillOpen = createTask(db, { title: '未完成C', typeCode: 'code_impl', priorityCode: 'p2' })

    const ids = listOplogCompletionCandidates(db, today).map((c) => c.id)
    assert.ok(ids.includes(doneToday.id), '当天完成的任务应出现在待归档建议里')
    assert.equal(ids.includes(doneOtherDay.id), false, '别的日子完成的不能混进今天')
    assert.equal(ids.includes(stillOpen.id), false, '未完成的任务不是"待归档"')

    // 写一条日志关联它 → 建议里立刻消失（不会追着让人写第二遍）
    createOplogEntry(db, draft({ title: '写掉了', taskId: doneToday.id }))
    const after = listOplogCompletionCandidates(db, today).map((c) => c.id)
    assert.equal(after.includes(doneToday.id), false, '关联日志后不该再提示')
  } finally { db.close() }
})

test('待归档建议：日期不合法就直接返回空，不猜', () => {
  const db = freshDb()
  try {
    assert.deepEqual(listOplogCompletionCandidates(db, '2026/10/27'), [])
    assert.deepEqual(listOplogCompletionCandidates(db, ''), [])
    assert.deepEqual(listOplogCompletionCandidates(db, '2026-10-27'), [], '合法但没有完成记录时是空数组')
  } finally { db.close() }
})

test('反向查询：任务能看到自己被哪些日志引用（按业务日期倒序）', () => {
  const db = freshDb()
  try {
    const task = createTask(db, { title: '广告结构', typeCode: 'code_impl', priorityCode: 'p2' })
    createOplogEntry(db, draft({ title: '第一版', logDate: '2026-10-20', taskId: task.id }))
    createOplogEntry(db, draft({ title: '第二版', logDate: '2026-10-25', taskId: task.id }))
    createOplogEntry(db, draft({ title: '无关日志' }))

    const linked = listOplogEntriesByTask(db, task.id)
    assert.deepEqual(linked.map((e) => e.title), ['第二版', '第一版'], '按业务日期倒序，且只含本任务的')
    assert.deepEqual(listOplogEntriesByTask(db, ''), [], '空 taskId 返回空，不当成"匹配全部"')
  } finally { db.close() }
})

test('候选池：已完成任务也能被关联，且未完成排在前面', () => {
  const db = freshDb()
  try {
    const open = createTask(db, { title: '未完成任务', typeCode: 'code_impl', priorityCode: 'p2', dueAt: '2026-11-01T00:00:00.000Z' })
    const done = createTask(db, { title: '已完成任务', typeCode: 'code_impl', priorityCode: 'p2' })
    updateTask(db, done.id, { statusCode: 'done' })

    const ids = listOplogTaskOptions(db).map((o) => o.id)
    assert.ok(ids.includes(open.id), '未完成任务必须在候选池里')
    assert.ok(ids.includes(done.id), '已完成任务必须也能被关联 —— 这正是本次修复的点')
    assert.ok(ids.indexOf(open.id) < ids.indexOf(done.id), '未完成应排在已完成之前（常用项在前）')
  } finally { db.close() }
})

test('HTTP：两个新接口走同一套信封，且只读不改库', async () => {
  const db = freshDb()
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
  if (address === null || typeof address === 'string') { server.close(); db.close(); throw new Error('没有拿到端口') }
  const request = async (path) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`)
    return { status: res.status, body: JSON.parse(await res.text()) }
  }
  try {
    const today = localDateString()
    const task = createTask(db, { title: '今天完成的', typeCode: 'code_impl', priorityCode: 'p2' })
    updateTask(db, task.id, { statusCode: 'done' })

    const cand = await request(`/api/workbench/oplog/completion-candidates?date=${today}`)
    assert.equal(cand.status, 200)
    assert.equal(cand.body.ok, true, '信封走 apiOk')
    assert.equal(cand.body.date, today)
    assert.deepEqual(cand.body.candidates.map((c) => c.id), [task.id])

    const noDate = await request('/api/workbench/oplog/completion-candidates')
    assert.equal(noDate.body.date, today, '缺省 date 用服务器本地日')

    const byTask = await request(`/api/workbench/oplog/by-task/${encodeURIComponent(task.id)}`)
    assert.equal(byTask.body.ok, true)
    assert.deepEqual(byTask.body.entries, [], '还没写日志时反向查询为空数组，不是 404')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
})
