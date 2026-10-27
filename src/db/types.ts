/**
 * 仓储层的**类型**单一来源。
 *
 * 为什么从 `db/repo.ts` 搬出来：这些接口原先定义在门面文件里，于是 17 个 `db/repo/*`
 * 子模块为了拿类型反向 `import from '../repo.js'`，而门面又 re-export 这些子模块 ——
 * 形成 `repo.ts ↔ repo/*.ts` 的循环。类型本身能用 `import type` 规避运行时环，
 * 但**值**（`nowIso` / `localDateString` / `getDraft` …）不能；把类型与值都挪到叶子模块，
 * 环才真正断掉（见 `docs/design/2026-10-27-architecture-rebaseline.md` D2 / R4）。
 *
 * 约束：本文件只放类型，**不 import 任何运行时模块**。
 */

// ---------------------------------------------------------------------------
// 字典
// ---------------------------------------------------------------------------

export interface DictionaryEntry {
  kind: string
  code: string
  name: string
  config: Record<string, unknown>
  builtin: number
  active: number
  sortOrder: number
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export interface TaskInput {
  /**
   * 由调用方**预先分配**的任务 id（v1.15.1）。
   *
   * 为什么要留这个口：澄清阶段需要先把"任务资料夹"建出来并写进提示词，
   * 而旧做法是拿**用户打的那句自然语言**当目录名（`folderForText(text)`）——
   * 等于把一句话当路径，还会因为改标题变成孤儿。现在客户端先 `randomUUID()` 预留 id、
   * 用它建资料夹，确认草稿时复用同一个 id（`confirmTaskDraft` 读 `payload.id`）。
   *
   * 缺省仍由仓储层 `randomUUID()`：老调用点行为不变。
   */
  id?: string
  title: string
  description?: string
  typeCode: string
  statusCode?: string
  priorityCode: string
  aiPolicyCode?: string
  dueAt?: string | null
  allDay?: boolean
  estimatedMinutes?: number | null
  source?: string
  parentId?: string | null
  workspacePath?: string | null
  /**
   * 显式进度（0–99）。**只由 `repo/progress.ts#setTaskProgress` 写** ——
   * 这里留给"建任务时就带进度"的极少数场景（迁移/导入），常规入口一律默认 0。
   */
  progressPercent?: number
  extra?: Record<string, unknown>
  children?: Array<Partial<TaskInput>>
  recurrenceCode?: string | null
  recurrenceRule?: Record<string, unknown>
  recurrenceMasterId?: string | null
}

export interface TaskPatch {
  title?: string
  description?: string
  typeCode?: string
  statusCode?: string
  priorityCode?: string
  aiPolicyCode?: string
  dueAt?: string | null
  allDay?: boolean
  estimatedMinutes?: number | null
  archived?: boolean
  workspacePath?: string | null
  /**
   * 显式进度（0–99）。
   *
   * ⚠️ 不在这里做范围/幂等判断：唯一权威入口是
   * `repo/progress.ts#setTaskProgress`（同值不写事件、越界拒绝）。`updateTask` 只负责落库，
   * 给它传 100 会被 DDL 的 CHECK 挡下来（那是"绕过守卫"的响铃）。
   */
  progressPercent?: number
  /** 改父任务：undefined = 不变；null = 移到顶层；字符串 = 挂到该父任务下（仓储层会做存在/归档/防环校验）。 */
  parentId?: string | null
  extra?: Record<string, unknown>
  recurrenceCode?: string | null
  recurrenceRule?: Record<string, unknown>
}

export interface TaskRow {
  id: string
  parentId: string | null
  title: string
  description: string
  typeCode: string
  statusCode: string
  priorityCode: string
  aiPolicyCode: string
  dueAt: string | null
  /** 动态有效截止时间：优先自身 dueAt，未设置时向上继承最近一个有截止时间的祖先。 */
  effectiveDueAt: string | null
  allDay: number
  estimatedMinutes: number | null
  source: string
  workspacePath: string | null
  /** 动态有效工作区：优先自身 workspacePath，未设置时向上继承最近一个已设工作区的祖先。 */
  effectiveWorkspacePath: string | null
  /** 显式进度 0–99（写入口只有 `repo/progress.ts`；DRL 的 CHECK 是最后防线）。 */
  progressPercent: number
  archived: number
  extra: Record<string, unknown>
  recurrenceCode: string | null
  recurrenceRule: Record<string, unknown>
  recurrenceMasterId: string | null
  recurrenceLastGenerated: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
}

// ---------------------------------------------------------------------------
// 草稿 / 任务会话
// ---------------------------------------------------------------------------

export interface DraftInput {
  kindCode?: 'task' | 'subtask_plan' | string
  sessionId?: string | null
  payload: Record<string, unknown>
}

export interface TaskSessionLinkInput {
  taskId: string
  sessionId: string
  roleCode: string
  workspace?: string
  note?: string
}
