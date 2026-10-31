/**
 * 表格能力桥（并入 CSV 版块的宿主侧）：把工作台已经解析好的 CSV 变成**可编辑的 `.univer` 表格**。
 *
 * ## 为什么这层必须存在
 *
 * 报表分析页现在的落地路径只有"复制 CSV 到剪贴板"（见 `AmazonReportView` 的既有口径，
 * 那里明确写过"不允许把数据当成文件下载"）。Univer 恰好补的正是这一半：
 * 真表格、能加公式/条件格式/图表、能导出 `.xlsx`。
 *
 * 但生成 `.univer` 这件事故意不放在客户端：
 * - 写盘、建 draft worktree、导入 Unit 都是**宿主能力**（`ctx.univer` 服务）；
 * - 客户端只负责"把 CSV 交上去"和"把回来的地址嵌进页面"。
 *
 * ## 严格遵守 Univer 自己的纪律
 *
 * 导入必须落在一个 **draft worktree** 里（这是 `dsh-univer-office` 的硬约束：
 * 内容写入不能绕过草稿）。所以这里做的是「新建文件 → 建草稿 → 导入 CSV」，
 * **不做 merge**：合并/放弃留给用户在 Viewer 里点，AI 与本插件都不替用户拍板。
 *
 * ## 依赖是软探测
 *
 * `ctx.get('univer')` 取不到就返回"没装"，**绝不假装能生成**。
 * 同样不把 `univer` 写进工作台的 `inject`（会让没装它的机器上整个插件 pending，
 * 这条规矩在 `plugin/probe.ts` 里已经因为复发 3 次事故钉死了）。
 *
 * ## 中间文件
 *
 * 导入接口要求"源文件在工作区内且已存在"，所以 CSV 先落到
 * `<workspace>/.wb-univer-import/` 下，导入成功后无论成败都删掉；不污染用户目录。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apiError, apiOk, isLoopbackRequest } from '../http.js'

export const UNIVER_OFFICE_PREFIX = '/api/workbench/univer'

/** 中间 CSV 落点（在工作区内，导入接口要求如此）。 */
const IMPORT_DIR = '.wb-univer-import'

/**
 * Univer 宿主服务里本桥用到的方法（结构性声明，不 import 对方包）。
 *
 * `gatewayStatus` / `inspectUnitContent` 是**可选**的：
 * - 前者只用于 `availability` 的读能力位，老服务没有它时按不可读降级；
 * - 后者是读回单元格数据的入口（本批不开放读路由，只用它判断能力）。
 * 两者都不参与"能不能生成表格"的判断，缺了也不该让整条桥消失。
 */
export interface UniverServiceLike {
  newFile(request: { workspace: string; file: string }, signal?: AbortSignal): Promise<unknown>
  worktree(
    request: { workspace: string; file: string; action: 'create'; name?: string },
    signal?: AbortSignal
  ): Promise<unknown>
  importUnitContent(
    request: {
      workspace: string
      file: string
      source: string
      sourceWorkspace: string
      worktreeId: string
      name: string
    },
    signal?: AbortSignal
  ): Promise<unknown>
  gatewayStatus?(): Promise<unknown>
  inspectUnitContent?(request: unknown, signal?: AbortSignal): Promise<unknown>
}

/**
 * `availability.unitContent` 的合法值（前端只认这两个；老宿主缺字段按 `unknown` 处理）。
 *
 * ⚠️ 不要用 `unitContentStatus()` 判断：0.3.7 里它恒返回 `'bundled'`，
 * 既不看服务是否存在，也不看 Gateway 是否起得来，拿它当能力位会把"读不到"说成"能读"。
 */
export type UnitContentCapability = 'bundled' | 'unavailable'

/** 一次失败的**可读原因**（不回传堆栈、不回传绝对路径以外的内部细节）。 */
export interface UniverBridgeFailure {
  readonly code: string
  readonly message: string
}

function fail(code: string, message: string): UniverBridgeFailure {
  return { code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 把服务返回值里的 worktreeId 抠出来；抠不到就是宿主契约变了，明确报错而不是继续。 */
function readWorktreeId(value: unknown): string {
  if (!isRecord(value)) return ''
  const result = value.result
  if (!isRecord(result)) return ''
  const id = result.worktreeId
  return typeof id === 'string' ? id : ''
}

/**
 * 把导入结果里的 unitId 抠出来。
 *
 * 0.3.7 的 Gateway `POST /uf/<enc>/worktrees/<id>/units` 明确回 `unitId`，
 * 服务再把 Gateway 响应摊进 `result`，所以正常情况下一定有值。
 * 但这里**不**因为缺它把一次已成功的导入判失败：文件已经生成，
 * 为了一个后续才用的元数据字段让用户重试、多堆一份带时间戳的 `.univer` 不划算。
 * 缺值时回空串，由调用方如实告诉前端"这次没拿到 unitId"。
 */
function readUnitId(value: unknown): string {
  if (!isRecord(value)) return ''
  const result = value.result
  if (!isRecord(result)) return ''
  const id = result.unitId
  return typeof id === 'string' ? id : ''
}

/**
 * 判断"读表格内容"这项能力现在是否可用。
 *
 * 依据只有两条（Chief 已纠正：`unitContentStatus()` 在 0.3.7 是常量，不能当能力位）：
 * 1. 服务对象上真的有 `inspectUnitContent`（读内容的入口）；
 * 2. `gatewayStatus()` 拿得到且不是 `failed`。
 *
 * `stopped` 算可用：Gateway 默认 `autoStartGateway=true`，所有读操作都会按需拉起它；
 * 把它判成"读不到"会造成首屏误报。`starting` 同理（正在起来）。
 */
async function probeUnitContent(service: UniverServiceLike): Promise<UnitContentCapability> {
  if (typeof service.inspectUnitContent !== 'function') return 'unavailable'
  if (typeof service.gatewayStatus !== 'function') return 'unavailable'
  try {
    const status = await service.gatewayStatus()
    if (!isRecord(status)) return 'unavailable'
    return status.phase === 'failed' ? 'unavailable' : 'bundled'
  } catch {
    return 'unavailable'
  }
}

/** 服务返回 `ok:false` 时把它翻成可读失败原因。 */
function readServiceFailure(value: unknown, what: string): UniverBridgeFailure | null {
  if (!isRecord(value)) return fail('UNIVER_INVALID_RESPONSE', `Univer 返回了无法识别的${what}结果。`)
  if (value.ok === false) {
    const reason = typeof value.reason === 'string' ? value.reason : ''
    return fail(reason !== '' ? reason : 'UNIVER_OPERATION_FAILED', `Univer 拒绝了${what}（${reason || '未知原因'}）。`)
  }
  return null
}

/** 文件名净化：只留安全字符，避免把用户输入当路径用。 */
export function safeTableName(raw: string): string {
  const trimmed = raw.trim()
  const base = trimmed === '' ? '报表' : trimmed
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 60) === '' ? '报表' : cleaned.slice(0, 60)
}

/** 时间戳后缀：保证不覆盖既有文件（宁可多一个文件，也不悄悄盖掉用户的东西）。 */
export function tableStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export async function ensureWorkspaceDir(value: unknown): Promise<string | UniverBridgeFailure> {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('INVALID_REQUEST', '缺少 workspace：无法确定把表格写到哪里。')
  }
  const dir = value.trim()
  if (!isAbsolute(dir)) return fail('INVALID_REQUEST', 'workspace 必须是绝对路径。')
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return fail('INVALID_REQUEST', 'workspace 不是一个目录。')
  } catch {
    return fail('WORKSPACE_UNAVAILABLE', 'workspace 不存在或不可访问。')
  }
  return dir
}

/**
 * CSV → `.univer`（草稿）的核心编排。
 *
 * 抽成纯函数式入口便于单测用**假服务**验证调用顺序与中间文件清理 ——
 * 真服务要跑起 Gateway 才能测，不适合放进单测。
 */
export async function importCsvAsUniverDraft(input: {
  readonly univer: UniverServiceLike
  readonly workspace: string
  readonly name: string
  readonly csv: string
  readonly now?: Date
  readonly newId?: () => string
}): Promise<
  | { ok: true; file: string; worktreeId: string; unitId: string }
  | { ok: false; failure: UniverBridgeFailure }
> {
  const now = input.now ?? new Date()
  const tableName = safeTableName(input.name)
  const targetFile = join(input.workspace, `${tableName}-${tableStamp(now)}.univer`)
  const importDir = join(input.workspace, IMPORT_DIR)
  const stamp = input.newId === undefined ? randomUUID() : input.newId()
  const sourceCsv = join(importDir, `${stamp}.csv`)

  try {
    await mkdir(importDir, { recursive: true })
    await writeFile(sourceCsv, input.csv, 'utf8')
  } catch (error) {
    return { ok: false, failure: fail('TEMP_WRITE_FAILED', `无法写入临时 CSV：${error instanceof Error ? error.message : String(error)}`) }
  }

  try {
    const created = await input.univer.newFile({ workspace: input.workspace, file: targetFile })
    const createdFailure = readServiceFailure(created, '新建文件')
    if (createdFailure !== null) return { ok: false, failure: createdFailure }

    const worktree = await input.univer.worktree({
      workspace: input.workspace,
      file: targetFile,
      action: 'create',
      name: `${tableName} 导入`,
    })
    const worktreeFailure = readServiceFailure(worktree, '创建草稿')
    if (worktreeFailure !== null) return { ok: false, failure: worktreeFailure }

    const worktreeId = readWorktreeId(worktree)
    if (worktreeId === '') {
      return { ok: false, failure: fail('UNIVER_INVALID_RESPONSE', 'Univer 没有返回草稿 id，无法继续导入。') }
    }

    const imported = await input.univer.importUnitContent({
      workspace: input.workspace,
      file: targetFile,
      source: sourceCsv,
      sourceWorkspace: input.workspace,
      worktreeId,
      name: tableName,
    })
    const importFailure = readServiceFailure(imported, '导入 CSV')
    if (importFailure !== null) return { ok: false, failure: importFailure }

    return { ok: true, file: targetFile, worktreeId, unitId: readUnitId(imported) }
  } catch (error) {
    return {
      ok: false,
      failure: fail(
        'UNIVER_BRIDGE_FAILED',
        `生成表格失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    }
  } finally {
    /** 中间文件一定要清掉：它只是导入的载体，不该留在用户目录里。 */
    await rm(sourceCsv, { force: true }).catch(() => undefined)
  }
}

export function makeUniverOfficeRoutes(probeUniver: () => unknown): WebRoute[] {
  const readService = (): UniverServiceLike | null => {
    const value = probeUniver()
    if (!isRecord(value)) return null
    const candidate = value as Partial<UniverServiceLike>
    if (
      typeof candidate.newFile !== 'function'
      || typeof candidate.worktree !== 'function'
      || typeof candidate.importUnitContent !== 'function'
    ) return null
    return candidate as UniverServiceLike
  }

  return [
    {
      kind: 'exact',
      path: `${UNIVER_OFFICE_PREFIX}/availability`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
        const univer = readService()
        if (univer === null) {
          const unitContent: UnitContentCapability = 'unavailable'
          return apiOk(res, { available: false, unitContent })
        }
        return apiOk(res, {
          available: true,
          unitContent: await probeUnitContent(univer),
        })
      },
    },
  ]
}
