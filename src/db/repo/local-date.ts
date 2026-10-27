/**
 * 「本地日」的唯一实现。
 *
 * 从 `db/repo.ts` 搬出来：`recurring.ts` 需要它，而它原先住在门面文件里 →
 * `repo.ts ↔ repo/recurring.ts` 成一环（门面 re-export 子模块、子模块回导门面）。
 * 放在叶子模块后，门面只 re-export，环消失。
 *
 * ⚠️ 口径是**服务器本地时区**，不是 UTC：每日计划按本地"天"划分（ADR0002）。
 */

/** 服务器本地时区的 YYYY-MM-DD；每日计划按本地“天”划分。 */
export function localDateString(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
