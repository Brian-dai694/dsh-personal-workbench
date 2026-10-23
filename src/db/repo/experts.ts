/**
 * 专家域仓储：**开关设置**、**expert 草稿的筛选**、**CAS 版本更新**。
 *
 * ## 职责边界（规格 §2.2）
 *
 * 本文件只做 DB 行读写，**不安装任何文件**、不解析人格、不校验来源 ——
 * 那三件事分别属于 `experts/drafts.ts`（P2）、`personas/parse.ts`、`experts/provenance.ts`。
 *
 * ## 为什么 CAS 写在这里而不是调用方
 *
 * "同版本并发只有一个成功"是**数据层的性质**，不是调用方的礼貌。放在仓储里、用
 * `UPDATE … WHERE` 同版本 + 0 行即冲突，是唯一能在并发下成立的做法：
 * 先读后写（`if (row.version === expected) update()`）在两次调用之间必然有窗口。
 *
 * 错误一律用**稳定 code**（`ExpertRepoError.code`），中文只进 `message` ——
 * 界面/测试按 code 断言，文案可以改。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, getDraft, parseDraft, type DraftRow, type RawDraftRow } from './shared.js'
import { readMeta, writeMeta } from './meta.js'
import {
  EXPERT_AUTO_SUMMON_META_KEY,
  EXPERT_DRAFT_KIND,
  EXPERT_GENERATED_DIR_NAME,
  EXPERT_UUID_PATTERN,
  type ExpertDraftPayload,
  type ExpertErrorCode,
  type ExpertInstallResult,
  type ExpertIssue,
  type ExpertProvenance,
  type ExpertSettings,
  type ExpertSkillRequirement,
  type ExpertStagedFile,
  type ExpertValidation,
} from '../../shared/expert.js'

/**
 * 仓储层的稳定失败。`code` 只取 `ExpertErrorCode`（封闭枚举），
 * **不把中文文案当 code** —— 文案改了不该让断言变红。
 */
export class ExpertRepoError extends Error {
  readonly code: ExpertErrorCode

  constructor(code: ExpertErrorCode, message: string) {
    super(message)
    this.name = 'ExpertRepoError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 设置：开关（唯一一个键）
// ---------------------------------------------------------------------------

/**
 * 读开关：**缺失 / 脏值一律 false**，只有确切的真值标记才算开。
 *
 * 为什么不是 `raw !== '0'`：那样任何脏值（`'yes'`、`''`、`'null'`、旧版本写坏的值）
 * 都会变成"开" —— 一个默认关闭、又要求用户授权的功能**只能 fail-closed**。
 *
 * 同时接受 `'1'`：写入用 `'true'`/`'false'`，但真实库上可能残留早期写下的 `'1'`
 * （或者干脆是别人手工改的 meta）；把它当"开"读出来、并在下次写入时归一成
 * `'true'`，比让用户"设置里明明开着却一直不生效"要好。
 */
export function readExpertSettings(db: DatabaseSync): ExpertSettings {
  const raw = readMeta(db, EXPERT_AUTO_SUMMON_META_KEY)
  return { autoSummonExperts: raw === 'true' || raw === '1' }
}

/**
 * 写开关：**只接受真正的 boolean**。
 *
 * 字符串 `'false'` 会被拒绝而不是被 `Boolean()` 折叠成 `true`（那正是"界面显示关、
 * 实际按开跑"的经典成因）。返回是否真的写了，供调用方/测试断言"没传就不动"。
 */
export function writeExpertSettings(db: DatabaseSync, patch: { autoSummonExperts?: unknown }): boolean {
  if (patch.autoSummonExperts !== true && patch.autoSummonExperts !== false) return false
  writeMeta(db, EXPERT_AUTO_SUMMON_META_KEY, patch.autoSummonExperts ? 'true' : 'false')
  return true
}

// ---------------------------------------------------------------------------
// 草稿：读
// ---------------------------------------------------------------------------

/** 外层状态：只有这三个（`phase` 是 pending 内部的施工阶段，不是外层状态）。 */
export type ExpertDraftStatus = 'pending' | 'confirmed' | 'abandoned'

/** 读一份 expert 草稿；**kind 不匹配就当作不存在**（绝不误伤 task/knowledge 草稿）。 */
export function getExpertDraft(db: DatabaseSync, id: string): DraftRow | undefined {
  const draft = getDraft(db, id)
  if (draft === undefined || draft.kindCode !== EXPERT_DRAFT_KIND) return undefined
  return draft
}

/**
 * 同 session 的 pending expert 草稿（**按 kind 过滤**）。
 *
 * 必须过滤 kind：同一个会话里普遍同时挂着 task / knowledge 草稿，
 * 不过滤就会把别的域的草稿当成"专家草稿已存在"。
 * 返回 `undefined` 表示该会话没有待确认的专家草稿。
 */
export function getPendingExpertDraftForSession(db: DatabaseSync, sessionId: string): DraftRow | undefined {
  const row = db.prepare(
    `SELECT * FROM task_drafts
      WHERE session_id = ? AND status_code = 'pending' AND kind_code = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).get(sessionId, EXPERT_DRAFT_KIND) as RawDraftRow | undefined
  return parseDraft(row)
}

// ---------------------------------------------------------------------------
// 草稿：建（去重）
// ---------------------------------------------------------------------------

export interface CreateExpertDraftInput {
  sessionId: string | null
  /** 用户需求，1–2000 字符，用于**同 session 内的请求指纹**。 */
  request: string
  /** 预分配的 `generated/<UUID>`；缺省由仓储生成（测试可注入固定值）。 */
  expertId?: string
  personaMd?: string
  provenance?: ExpertProvenance | null
  skills?: ExpertSkillRequirement[]
  files?: ExpertStagedFile[]
}

export interface CreateExpertDraftResult {
  draft: DraftRow
  payload: ExpertDraftPayload
  /** `reused: true` = 同一请求复用既有 pending 草稿，本次**没有**新建行。 */
  reused: boolean
}

/** `expertId` 的生成：**只由服务端产生**，不使用显示名称或上游 repo 作为持久键。 */
export function defaultExpertId(uuid: string = randomUUID()): string {
  return `${EXPERT_GENERATED_DIR_NAME}/${uuid.toLowerCase()}`
}

function initialPayload(input: CreateExpertDraftInput, expertId: string): ExpertDraftPayload {
  return {
    version: 1,
    contentVersion: 0,
    expertId,
    request: input.request,
    phase: 'editing',
    personaMd: input.personaMd ?? '',
    provenance: input.provenance ?? null,
    skills: input.skills ?? [],
    files: input.files ?? [],
    validation: null,
    lastInstallError: null,
  }
}

/**
 * 建一份 pending expert 草稿，**在短事务内去重**。
 *
 * 三条规则（规格/施工计划 P1「精确仓储行为」4）：
 *
 * 1. 同 session 已有 pending expert 草稿、且 `request` **一致** → 复用（不新建行、不覆盖进度）；
 * 2. 同 session 已有 pending expert 草稿、但 `request` **不同** → `generation-conflict`
 *    （用户换了需求时应当先放弃旧草稿，而不是让两份互不相关的草稿悄悄共存）；
 * 3. 否则新建，`contentVersion` 从 0 起。
 *
 * @throws ExpertRepoError `generation-conflict`（不同 request）/ `invalid-payload`（空 request）
 */
export function createExpertDraft(
  db: DatabaseSync,
  input: CreateExpertDraftInput,
  at: string = nowIso(),
): CreateExpertDraftResult {
  const request = typeof input.request === 'string' ? input.request.trim() : ''
  if (request === '') throw new ExpertRepoError('invalid-payload', '专家草稿必须带非空的用户需求（request）')
  const expertId = input.expertId ?? defaultExpertId()
  if (expertId.startsWith(`${EXPERT_GENERATED_DIR_NAME}/`) === false
    || EXPERT_UUID_PATTERN.test(expertId.slice(EXPERT_GENERATED_DIR_NAME.length + 1)) === false) {
    throw new ExpertRepoError('invalid-payload', `专家 id 必须是 generated/<小写UUID>，收到：${expertId}`)
  }

  db.exec('BEGIN')
  try {
    if (input.sessionId !== null) {
      const existing = getPendingExpertDraftForSession(db, input.sessionId)
      if (existing !== undefined) {
        const payload = existing.payload as unknown as ExpertDraftPayload
        if ((payload.request ?? '').trim() !== request) {
          throw new ExpertRepoError(
            'generation-conflict',
            `本会话已有一份待确认的专家草稿（需求：「${payload.request ?? ''}」）；请先放弃它，或继续沿用同一需求`,
          )
        }
        db.exec('COMMIT')
        return { draft: existing, payload, reused: true }
      }
    }
    const id = randomUUID()
    const payload = initialPayload(input, expertId)
    db.prepare(
      `INSERT INTO task_drafts (id, kind_code, session_id, payload_json, status_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(id, EXPERT_DRAFT_KIND, input.sessionId, JSON.stringify(payload), at, at)
    db.exec('COMMIT')
    const draft = getDraft(db, id)
    if (draft === undefined) throw new ExpertRepoError('draft-not-found', `刚写入的专家草稿读不回来：${id}`)
    return { draft, payload, reused: false }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已提交或已回滚，不能掩盖原始错误 */ }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 草稿：CAS 更新
// ---------------------------------------------------------------------------

/**
 * 一次 CAS 变更要改的字段（**全部可选**：只覆盖给了的键）。
 *
 * `undefined` = 不改；显式 `null` = 清空（如 `validation: null`、`provenance: null`）。
 */
export interface ExpertDraftPatch {
  phase?: ExpertDraftPayload['phase']
  personaMd?: string
  provenance?: ExpertProvenance | null
  skills?: ExpertSkillRequirement[]
  files?: ExpertStagedFile[]
  validation?: ExpertValidation | null
  lastInstallError?: ExpertIssue | null
  request?: string
  /** 确认结果回写（幂等回放用）；给了就写进 payload。 */
  confirmResult?: ExpertInstallResult
}

export interface UpdateExpertDraftCasResult {
  draft: DraftRow
  payload: ExpertDraftPayload
  /** 内容是否真的变了（同内容重提交 → `false`，版本不变）。 */
  changed: boolean
}

/** 参与"内容是否变化"比较的字段（用来实现"同内容重提交版本不变"）。 */
const CONTENT_KEYS: readonly (keyof ExpertDraftPatch)[] = [
  'personaMd', 'provenance', 'skills', 'files', 'request',
]

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * CAS 更新：`UPDATE … WHERE id = ? AND kind_code = 'expert' AND status_code = 'pending'
 * AND json_extract(payload_json,'$.contentVersion') = ?`。
 *
 * 0 行受影响就是 `draft-version-conflict`（**绝不覆盖另一轮输出**）。
 * 版本号在**同一条 SQL**里 `contentVersion + 1`，所以不存在"读到的版本已过期"的窗口。
 *
 * 两条自动语义（把它们写进仓储而不是留给调用方，是因为漏掉任一条都会产生坏数据）：
 *
 * - **同内容重提交 → `changed: false`**：版本不变、`validation` 保留（重复提交不该
 *   把用户已经看过的校验结果清空）；
 * - **内容不同 → 清 `validation` 并令 `phase = 'editing'`**（旧 manifestHash 就此失效，
 *   旧 version 上的确认会被 `package-changed` 挡住）。
 *
 * @throws ExpertRepoError `draft-not-found` / `draft-not-pending` / `install-in-progress` /
 *   `draft-version-conflict`
 */
export function updateExpertDraftCas(
  db: DatabaseSync,
  id: string,
  expectedVersion: number,
  patch: ExpertDraftPatch,
  at: string = nowIso(),
): UpdateExpertDraftCasResult {
  const draft = getExpertDraft(db, id)
  if (draft === undefined) throw new ExpertRepoError('draft-not-found', `专家草稿不存在：${id}`)
  if (draft.statusCode !== 'pending') {
    throw new ExpertRepoError('draft-not-pending', `专家草稿当前状态是 ${draft.statusCode}，不可再修改`)
  }
  const before = draft.payload as unknown as ExpertDraftPayload
  if (before.phase === 'installing') {
    throw new ExpertRepoError('install-in-progress', '正在安装的专家草稿不可修改；请等待安装结束或走恢复')
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== before.contentVersion) {
    throw new ExpertRepoError(
      'draft-version-conflict',
      `草稿版本冲突：期望 v${expectedVersion}，库里是 v${before.contentVersion}（另有一轮已写入，请刷新后重试）`,
    )
  }

  const next: ExpertDraftPayload = { ...before }
  for (const key of Object.keys(patch) as (keyof ExpertDraftPatch)[]) {
    const value = patch[key]
    if (value === undefined) continue
    // 这里逐字段赋值而不是整体展开，是为了让 TS 能对每个字段做形状检查。
    switch (key) {
      case 'phase': next.phase = value as ExpertDraftPayload['phase']; break
      case 'personaMd': next.personaMd = value as string; break
      case 'provenance': next.provenance = value as ExpertProvenance | null; break
      case 'skills': next.skills = value as ExpertSkillRequirement[]; break
      case 'files': next.files = value as ExpertStagedFile[]; break
      case 'validation': next.validation = value as ExpertValidation | null; break
      case 'lastInstallError': next.lastInstallError = value as ExpertIssue | null; break
      case 'request': next.request = value as string; break
      case 'confirmResult': next.confirmResult = value as ExpertInstallResult; break
      default: break
    }
  }

  /**
   * `changed` 的含义是"**这次调用有没有真的改到东西**"，不是"内容有没有变"：
   *
   * - 内容变（personaMd / provenance / skills / files / request）→ 版本 +1、清 validation；
   * - 内容没变但**阶段或校验结果**变了（如 `validateDraft` 写回 validation + phase）→
   *   版本不变，但 `changed: true`（否则调用方会以为"什么都没发生"而跳过刷新）；
   * - 完全无变化（同内容重提交一个只有 personaMd 的 patch）→ `changed: false`。
   */
  const contentChanged = CONTENT_KEYS.some((key) => {
    if (patch[key] === undefined) return false
    return sameJson((before as unknown as Record<string, unknown>)[key], (next as unknown as Record<string, unknown>)[key]) === false
  })
  const phaseChanged = patch.phase !== undefined && patch.phase !== before.phase
  const validationChanged = patch.validation !== undefined && sameJson(before.validation, next.validation) === false
  const installErrorChanged = patch.lastInstallError !== undefined && sameJson(before.lastInstallError, next.lastInstallError) === false
  const changed = contentChanged || phaseChanged || validationChanged || installErrorChanged || patch.confirmResult !== undefined
  if (changed === false) {
    return { draft, payload: before, changed: false }
  }
  if (contentChanged) {
    next.contentVersion = before.contentVersion + 1
    /**
     * ⚠️ 调用方**显式传了** `validation` 时尊重它（例如"校验完成：写回新 hash"），
     * 否则按规则清空 —— 旧 hash 对应的是旧内容，留着它等于让用户确认一份没看过的包。
     */
    if (patch.validation === undefined) next.validation = null
    if (patch.phase === undefined) next.phase = 'editing'
  }

  const result = db.prepare(
    `UPDATE task_drafts SET payload_json = ?, updated_at = ?
      WHERE id = ? AND kind_code = ? AND status_code = 'pending'
        AND json_extract(payload_json, '$.contentVersion') = ?`,
  ).run(JSON.stringify(next), at, id, EXPERT_DRAFT_KIND, before.contentVersion)
  if (Number(result.changes) === 0) {
    throw new ExpertRepoError(
      'draft-version-conflict',
      `草稿版本冲突：v${before.contentVersion} 已被另一轮写入（本次变更未落库，请重新读取草稿）`,
    )
  }
  const updated = getDraft(db, id)
  if (updated === undefined) throw new ExpertRepoError('draft-not-found', `更新后的专家草稿读不回来：${id}`)
  return { draft: updated, payload: next, changed: true }
}

// ---------------------------------------------------------------------------
// 草稿：安装器专用的短事务状态迁移（§6.4 第 4 / 9 步）
// ---------------------------------------------------------------------------

/**
 * 一次安装状态迁移要改的字段。
 *
 * 与 `ExpertDraftPatch` 的**关键区别**：这里允许在 `phase === 'installing'` 时写入
 * （安装器必须在"正在装"的状态下推进阶段），而 `updateExpertDraftCas` 会明确拒绝 ——
 * 所以安装器**只能**走这个入口，模型侧的工具走不了。
 */
export interface ExpertInstallTransition {
  /** 目标阶段（`installing` / `install-failed`）。不传 = 不改。 */
  phase?: ExpertDraftPayload['phase']
  /** 最近一次安装失败的字段级原因。显式 `null` = 清空。 */
  lastInstallError?: ExpertIssue | null
  /** 安装结果（§6.4 第 9 步与 `confirmed` 同一事务回写）。 */
  confirmResult?: ExpertInstallResult
}

export interface TransitionExpertDraftInstallResult {
  draft: DraftRow
  payload: ExpertDraftPayload
  /** 本次是否真的把外层状态改成了 `confirmed`。 */
  confirmed: boolean
}

/**
 * 安装器的**唯一** DB 迁移入口（`BEGIN IMMEDIATE` + 同版本 CAS）。
 *
 * 三条不可让步的语义：
 *
 * 1. **CAS 只在同一事务里成立**：`UPDATE … WHERE status_code='pending' AND
 *    json_extract(payload_json,'$.contentVersion') = ?`，0 行即 `draft-version-conflict`。
 *    第 9 步"回写 confirmResult 并把外层改成 confirmed"因此在数据层是原子的 ——
 *    两个并发确认只可能有一个把 `pending` 改成 `confirmed`，另一个拿到冲突错误。
 * 2. **`BEGIN IMMEDIATE`** 而不是 `BEGIN`：立刻拿写锁，避免"读完了才升级写锁"时
 *    发现别人已经改过（那样 CAS 必然失败，但会白白多写一轮文件）。
 * 3. **`contentVersion` 不变**：阶段与 `confirmResult` 都不是内容键（§3.4），
 *    在"装到一半"和"装完之后"之间反复迁移不会让用户手里的版本号漂移。
 *
 * 调用方**不得**在这个事务里做任何文件系统或网络操作（§6.4 末条：`ROLLBACK` 不会撤销文件）。
 *
 * @throws ExpertRepoError `draft-not-found` / `draft-not-pending` / `draft-version-conflict`
 */
export function transitionExpertDraftInstall(
  db: DatabaseSync,
  id: string,
  expectedVersion: number,
  transition: ExpertInstallTransition,
  at: string = nowIso(),
): TransitionExpertDraftInstallResult {
  const draft = getExpertDraft(db, id)
  if (draft === undefined) throw new ExpertRepoError('draft-not-found', `专家草稿不存在：${id}`)
  if (draft.statusCode !== 'pending') {
    throw new ExpertRepoError(
      'draft-not-pending',
      `专家草稿当前状态是 ${draft.statusCode}，安装器不能再用它做状态迁移（已确认的草稿走幂等回放）`,
    )
  }
  const before = draft.payload as unknown as ExpertDraftPayload
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== before.contentVersion) {
    throw new ExpertRepoError(
      'draft-version-conflict',
      `安装期版本冲突：期望 v${expectedVersion}，库里是 v${before.contentVersion}（草稿在安装期间被改过）`,
    )
  }

  const next: ExpertDraftPayload = { ...before }
  if (transition.phase !== undefined) next.phase = transition.phase
  if (transition.lastInstallError !== undefined) next.lastInstallError = transition.lastInstallError
  if (transition.confirmResult !== undefined) next.confirmResult = transition.confirmResult

  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare(
      `UPDATE task_drafts SET payload_json = ?, status_code = 'pending', updated_at = ?
        WHERE id = ? AND kind_code = ? AND status_code = 'pending'
          AND json_extract(payload_json, '$.contentVersion') = ?`,
    ).run(JSON.stringify(next), at, id, EXPERT_DRAFT_KIND, expectedVersion)
    if (Number(result.changes) === 0) {
      throw new ExpertRepoError(
        'draft-version-conflict',
        `安装期版本冲突：v${expectedVersion} 已被另一轮写入（本次迁移未落库，文件补偿由安装器负责）`,
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已提交或已回滚，不能掩盖原始错误 */ }
    throw error
  }

  const updated = getDraft(db, id)
  if (updated === undefined) throw new ExpertRepoError('draft-not-found', `迁移后的专家草稿读不回来：${id}`)
  return { draft: updated, payload: next, confirmed: false }
}

/**
 * §6.4 第 9 步的短事务：**同一个** `BEGIN IMMEDIATE` 里
 * 回写 `confirmResult` 并把外层状态从 `pending` 改成 `confirmed`。
 *
 * 独立成一个函数（而不是给 `transitionExpertDraftInstall` 加个 `confirm` 布尔）是为了让
 * "不可回滚的那一步"在调用点只有**一个**可能的名字 —— 安装器在写正式文件之后只调它。
 *
 * @throws ExpertRepoError 同 `transitionExpertDraftInstall`
 */
export function commitExpertDraftInstallation(
  db: DatabaseSync,
  id: string,
  expectedVersion: number,
  result: ExpertInstallResult,
  at: string = nowIso(),
): DraftRow {
  const draft = getExpertDraft(db, id)
  if (draft === undefined) throw new ExpertRepoError('draft-not-found', `专家草稿不存在：${id}`)
  if (draft.statusCode !== 'pending') {
    throw new ExpertRepoError('draft-not-pending', `专家草稿当前状态是 ${draft.statusCode}，不能再确认`)
  }
  const before = draft.payload as unknown as ExpertDraftPayload
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== before.contentVersion) {
    throw new ExpertRepoError(
      'draft-version-conflict',
      `确认期版本冲突：期望 v${expectedVersion}，库里是 v${before.contentVersion}（草稿在安装期间被改过）`,
    )
  }
  const next: ExpertDraftPayload = { ...before, confirmResult: result }

  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db.prepare(
      `UPDATE task_drafts SET payload_json = ?, status_code = 'confirmed', updated_at = ?
        WHERE id = ? AND kind_code = ? AND status_code = 'pending'
          AND json_extract(payload_json, '$.contentVersion') = ?`,
    ).run(JSON.stringify(next), at, id, EXPERT_DRAFT_KIND, expectedVersion)
    if (Number(updated.changes) === 0) {
      throw new ExpertRepoError(
        'draft-version-conflict',
        `确认期版本冲突：v${expectedVersion} 已不是 pending（本次确认未落库）`,
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已提交或已回滚，不能掩盖原始错误 */ }
    throw error
  }

  const row = getDraft(db, id)
  if (row === undefined) throw new ExpertRepoError('draft-not-found', `确认后的专家草稿读不回来：${id}`)
  return row
}
