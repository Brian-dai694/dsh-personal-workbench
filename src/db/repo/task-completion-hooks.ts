/**
 * 「任务已完成」的跨域回调注册点（2026-10-27，批次 4 / R3）。
 *
 * ## 为什么必须要有它
 *
 * `status.ts`（任务域）原先直接 `import { appendAsinLaunchOutcome } from './asin.js'`，
 * 于是「任务完成 → 回写选品库备注」这条**附带动作**，把任务域和选品域在代码层焊死了。
 *
 * 后果不是"不好看"：
 * - 想单独测任务域，就得连着把整个 ASIN 域（525 行 + 两张表）拖进测试；
 * - 想换一种回写方式（事件表、外部队列），必须改任务域；
 * - 反过来，选品域也随时可能 `import './status.js'` 造成**双向依赖**（本仓最忌讳的结构）。
 *
 * ## 现在的依赖方向
 *
 * ```
 *   status.ts ──► task-completion-hooks ◄── asin.ts
 * ```
 *
 * 任务域只在完成后**广播**一条事实，选品域自己决定要不要听、听完做什么。
 * 两边都只依赖这个中立模块，谁也不知道谁存在。
 *
 * ## 三条硬约束
 *
 * 1. **幂等**：同一模块重复加载不得注册两次（`Set` 按函数引用去重；ESM 模块体只执行一次，
 *    热重载会拿到新的函数引用 —— 所以处理器自身必须幂等，
 *    `appendAsinLaunchOutcome` 已按 `[立项完成] + 任务 id` 做过去重）。
 * 2. **回调失败必须静默**：回写只是附带痕迹，**不能**把它变成"任务完成失败" ——
 *    用户在验收里点了通过，任务就该完成。这条原先写在 `status.ts` 的 `writeBackAsinOutcome`
 *    里（`catch { /* 回写失败不影响任务完成 *\/ }`），现在由广播口统一保证，
 *    而且保证的是**所有**域，不只是 ASIN。
 * 3. **不引 DI 容器**：这是 db 层内部的进程级注册，一个 `Set` 足够。
 *    接容器会让 repo 层依赖宿主生命周期，反而更容易漏注册。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { TaskRow } from '../types.js'

/** 处理器签名：拿到**已提交后**的任务行（状态已是终态），以及完成时间。 */
export type TaskCompletedHandler = (db: DatabaseSync, task: TaskRow, at: string) => void

const handlers = new Set<TaskCompletedHandler>()

/**
 * 注册一个「任务完成」处理器，返回注销函数。
 *
 * 注销函数主要给测试用：同进程内多个用例共享模块状态时，可以精确隔离。
 * 生产代码不注销（进程结束即消失）。
 */
export function onTaskCompleted(handler: TaskCompletedHandler): () => void {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

/**
 * 广播「任务已完成」。
 *
 * 逐个处理器 try/catch：**单个处理器抛错不影响其他处理器，更不影响任务完成本身**。
 * 这条纪律比"广播成功"重要得多 —— 附带动作失败不该让主流程回滚。
 */
export function emitTaskCompleted(db: DatabaseSync, task: TaskRow, at: string): void {
  for (const handler of handlers) {
    try {
      handler(db, task, at)
    } catch {
      /* 附带动作失败不影响任务完成（原 writeBackAsinOutcome 的同一条纪律，上移到广播口） */
    }
  }
}

/** 当前注册数。只给测试与诊断用（断言"注册确实发生了"，而不是默默失效）。 */
export function taskCompletedHandlerCount(): number {
  return handlers.size
}
