/**
 * 草稿通知队列的**持久化层**（`draft_notify_queue` 表 + `task_drafts.notified_at`）。
 *
 * ## 为什么从 `reminder/draft-notify.ts` 搬出来
 *
 * 那一层是**编排**：策略判定、静默时段、汇总节流、通道发送。这里只是表读写。
 * 混在一起有两个后果：
 *
 * 1. `db.prepare` 散落在 `db/` 之外 —— 架构规则 R7 的破口（见 `test/architecture.test.mjs`）；
 * 2. 想知道"到底哪一列决定只推一次"，得先翻过几百行通知策略代码。
 *
 * 现在的分工：**本文件回答"哪些草稿该推、队列里有什么、这一条推成功没有"**；
 * `reminder/draft-notify.ts` 回答"现在该不该推、推不出去怎么退避"。
 *
 * ## 语义（搬动时逐字保留，未改行为）
 *
 * - `task_drafts.notified_at` 非空 = 已进过队列 → AI 反复更新同一草稿不会重复打扰；
 * - 队列按 `draft_id` 唯一（`ON CONFLICT(draft_id) DO NOTHING`），入队幂等；
 * - 失败只累加 `attempts` + 写 `last_error`，由调度器按退避时间重试。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './shared.js'
import { getTask } from './tasks.js'

export interface DraftNotifyEntry {
  id: string
  draftId: string
  kindCode: string
  title: string
  body: string
  priorityCode: string
  attempts: number
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
}

interface RawDraftNotifyRow {
  id: string
  draft_id: string
  kind_code: string
  title: string
  body: string
  priority_code: string
  attempts: number
  next_attempt_at: string
  last_error: string | null
  created_at: string
}

const parseEntry = (row: RawDraftNotifyRow): DraftNotifyEntry => ({
  id: row.id,
  draftId: row.draft_id,
  kindCode: row.kind_code,
  title: row.title,
  body: row.body,
  priorityCode: row.priority_code,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  createdAt: row.created_at,
})

/** 找出「待确认、未暂存、未通知过、类型已开启」的草稿。 */
export function listNotifiableDrafts(db: DatabaseSync, kinds: readonly string[]): Array<{ id: string; kindCode: string; payload: Record<string, unknown>; sessionId: string | null }> {
  if (kinds.length === 0) return []
  const placeholders = kinds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id, kind_code, payload_json, session_id FROM task_drafts
    WHERE status_code = 'pending' AND deferred_at IS NULL AND notified_at IS NULL AND kind_code IN (${placeholders})
    ORDER BY created_at
  `).all(...kinds) as unknown as Array<{ id: string; kind_code: string; payload_json: string; session_id: string | null }>
  return rows.map((row) => ({ id: row.id, kindCode: row.kind_code, payload: JSON.parse(row.payload_json) as Record<string, unknown>, sessionId: row.session_id }))
}

/**
 * 草稿关联的任务标题（验收申请草稿只存 taskId，通知里带上标题才有信息量）。
 *
 * 取不到任务（任务已删）返回 null，由调用方回落到草稿自带的 title 字段。
 */
export function draftTaskTitle(db: DatabaseSync, payload: Record<string, unknown>): string | null {
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
  if (taskId === '') return null
  return getTask(db, taskId)?.title ?? null
}

export function markDraftNotified(db: DatabaseSync, draftId: string, at = nowIso()): void {
  db.prepare('UPDATE task_drafts SET notified_at = ? WHERE id = ?').run(at, draftId)
}

export function enqueueDraftNotify(db: DatabaseSync, input: { draftId: string; kindCode: string; title: string; body: string; priorityCode: string; nextAttemptAt: string; at?: string }): DraftNotifyEntry {
  const at = input.at ?? nowIso()
  db.prepare(`
    INSERT INTO draft_notify_queue (id, draft_id, kind_code, title, body, priority_code, attempts, next_attempt_at, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
    ON CONFLICT(draft_id) DO NOTHING
  `).run(randomUUID(), input.draftId, input.kindCode, input.title, input.body, input.priorityCode, input.nextAttemptAt, at)
  const row = db.prepare('SELECT * FROM draft_notify_queue WHERE draft_id = ?').get(input.draftId) as unknown as RawDraftNotifyRow
  return parseEntry(row)
}

export function listDraftNotifyQueue(db: DatabaseSync): DraftNotifyEntry[] {
  const rows = db.prepare('SELECT * FROM draft_notify_queue ORDER BY created_at').all() as unknown as RawDraftNotifyRow[]
  return rows.map(parseEntry)
}

export function listDueDraftNotifies(db: DatabaseSync, nowIso_: string): DraftNotifyEntry[] {
  const rows = db.prepare('SELECT * FROM draft_notify_queue WHERE next_attempt_at <= ? ORDER BY created_at').all(nowIso_) as unknown as RawDraftNotifyRow[]
  return rows.map(parseEntry)
}

export function removeDraftNotify(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM draft_notify_queue WHERE id = ?').run(id)
}

export function markDraftNotifyAttempt(db: DatabaseSync, id: string, error: string | null, nextAttemptAt: string): void {
  db.prepare('UPDATE draft_notify_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?').run(error, nextAttemptAt, id)
}

export function countDraftNotifiesSince(db: DatabaseSync, sinceIso: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM task_drafts WHERE notified_at IS NOT NULL AND notified_at >= ?").get(sinceIso) as { n: number } | undefined
  return row?.n ?? 0
}
