import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import {
  createOplogEntry, updateOplogEntry, listOplogEntries, listOplogDayIndex, listOplogTaskOptions, getOplogEntry,
} from '../lib/db/repo.js'

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-oplog-link-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try { return run(db) } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

function draft(overrides = {}) {
  return {
    title: '调整广告结构', logType: '广告', contentText: '把三组广泛匹配收成两组',
    shopId: null, site: null, logDate: '2026-10-22', asins: [], documents: [],
    ...overrides,
  }
}

function makeTask(db, id, title, dueAt = null) {
  db.prepare(`INSERT INTO tasks (id, parent_id, title, description, type_code, status_code, priority_code,
    ai_policy_code, due_at, all_day, estimated_minutes, source, workspace_path, progress_percent, archived, extra,
    recurrence_code, recurrence_rule, recurrence_master_id, recurrence_last_generated,
    created_at, updated_at, completed_at, cancelled_at)
    VALUES (?, NULL, ?, '', 'personal', 'todo', 'p2', 'consult', ?, 0, NULL, 'manual', NULL, 0, 0, '{}',
    NULL, '{}', NULL, NULL, ?, ?, NULL, NULL)`)
    .run(id, title, dueAt, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')
}

test('日志可关联任务并在列表/详情里读回', () => withDb((db) => {
  makeTask(db, 'task-A', '重做广告结构')
  const created = createOplogEntry(db, draft({ taskId: 'task-A' }))
  assert.equal(created.taskId, 'task-A')
  assert.equal(listOplogEntries(db)[0].taskId, 'task-A')
  assert.equal(getOplogEntry(db, created.id).taskId, 'task-A')

  // 不传 taskId 视为"保持原值"，不能被编辑顺手清掉
  const updated = updateOplogEntry(db, created.id, draft({ title: '改个标题' }))
  assert.equal(updated.taskId, 'task-A')
  assert.equal(updated.title, '改个标题')

  // 显式传 null 才是解绑
  assert.equal(updateOplogEntry(db, created.id, draft({ taskId: null })).taskId, null)
}))

/**
 * 候选池口径（2026-10-27 变更）。
 *
 * 原实现排除 `done` / `cancelled`，后果是**任务一完成就再也关联不上** ——
 * 想给已完成的任务补一条复盘日志，选择器里根本找不到。现在只排除**已归档**，
 * 并按「未完成优先」排序：常用项仍在前，历史任务不会把它挤到后面。
 */
test('任务候选：排除已归档；未完成优先，已完成也要能选', () => withDb((db) => {
  makeTask(db, 'task-1', '无截止')
  makeTask(db, 'task-2', '早截止', '2026-10-21T00:00:00.000Z')
  makeTask(db, 'task-3', '晚截止', '2026-11-30T00:00:00.000Z')
  db.prepare("UPDATE tasks SET status_code = 'done', completed_at = '2026-10-22T00:00:00.000Z' WHERE id = 'task-3'").run()
  db.prepare("UPDATE tasks SET archived = 1 WHERE id = 'task-1'").run()
  assert.deepEqual(listOplogTaskOptions(db).map((t) => t.id), ['task-2', 'task-3'],
    '已归档的 task-1 不出现；未完成的 task-2 排在已完成的 task-3 之前')
}))

test('日历日期索引按业务日期聚合，缺失 log_date 回退 createdAt', () => withDb((db) => {
  createOplogEntry(db, draft({ logDate: '2026-10-22' }))
  createOplogEntry(db, draft({ logDate: '2026-10-22' }))
  createOplogEntry(db, draft({ logDate: '2026-10-19' }))
  // 模拟历史导入记录：log_date 为空时应该用 created_at 的日期，不丢行
  const legacy = createOplogEntry(db, draft({ logDate: '2026-10-01' }))
  db.prepare("UPDATE oplog_entries SET log_date = NULL, created_at = '2026-09-30T08:00:00.000Z' WHERE id = ?").run(legacy.id)

  const index = listOplogDayIndex(db)
  const byDate = new Map(index.map((row) => [row.date, row.count]))
  assert.equal(byDate.get('2026-10-22'), 2)
  assert.equal(byDate.get('2026-10-19'), 1)
  assert.equal(byDate.get('2026-09-30'), 1)
  assert.equal(byDate.get('2026-10-01'), undefined)
}))

test('按业务日期筛选与日历日期索引口径一致（不会格子说有 3 条、筛出 2 条）', () => withDb((db) => {
  createOplogEntry(db, draft({ logDate: '2026-10-22', title: 'A' }))
  createOplogEntry(db, draft({ logDate: '2026-10-22', title: 'B' }))
  createOplogEntry(db, draft({ logDate: '2026-10-19', title: 'C' }))
  // 历史记录 log_date 为空：索引把它算在 created_at 那天，筛选也必须同一天能筛出来
  const legacy = createOplogEntry(db, draft({ logDate: '2026-10-01', title: 'D' }))
  db.prepare("UPDATE oplog_entries SET log_date = NULL, created_at = '2026-09-30T08:00:00.000Z' WHERE id = ?").run(legacy.id)

  const index = new Map(listOplogDayIndex(db).map((row) => [row.date, row.count]))
  for (const [date, count] of index) {
    assert.equal(listOplogEntries(db, { logDate: date }).length, count, `${date} 的索引条数与筛选结果必须一致`)
  }
  assert.deepEqual(listOplogEntries(db, { logDate: '2026-10-22' }).map((e) => e.title).sort(), ['A', 'B'])
}))

test('同一毫秒内连建多条日志，id 不会撞（旧实现 1/1000 概率抛 UNIQUE 错）', () => withDb((db) => {
  const ids = []
  for (let i = 0; i < 60; i += 1) ids.push(createOplogEntry(db, draft({ title: `批量 ${i}` })).id)
  assert.equal(new Set(ids).size, ids.length, '60 条日志的 id 必须两两不同')
  assert.equal(listOplogEntries(db).length, 60)
}))
