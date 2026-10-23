/**
 * 专家**生成通道**的 5 个工具（规格 §5.1）。
 *
 * ## 这一层只做三件事
 *
 * 1. **snake_case → 域 camelCase**（一次转换，域里不再出现下划线字段名）；
 * 2. 把 `exec.agent.session.id` 之外的执行身份带进服务（参数里**没有** session_id /
 *    root / absolute_path —— 模型无法用"参数里的当前会话"替换执行身份）；
 * 3. 把域返回**重建成新的字面量**：`output.schema` 与真实返回值一一对应，
 *    嵌套结构不会因为"顺手多带一个字段"而偷偷变大。
 *
 * ## 刻意**不提供**的东西（AX-E34）
 *
 * 没有"确认安装"工具、没有"写正式库"工具、没有按绝对路径读文件的工具：
 * 生成通道最多把草稿推进到 `validated`，**正式根只有用户在界面上确认后才会被写**。
 * 模型若绕过这里去调确认接口或用 shell 写正式库，那是越权（§5.2 第 12 步明令禁止）。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { ExpertIssue } from '../shared/expert.js'
import type { ExpertDraftView, ExpertOperationResult } from './drafts.js'
import type { ExpertInvocationResult, ExpertLoadResult, ExpertResourceResult } from './invocation.js'
import type { ExpertService } from './service.js'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function renderJson(value: unknown): ContentBlock[] {
  return text(JSON.stringify(value, null, 2))
}

/** 执行上下文里我们真正用到的东西（身份只看 `exec.agent.session.id`）。 */
export interface ExpertToolExec {
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// 返回值形状（工具结果**永远**是新建的字面量，schema 与它逐字段对应）
// ---------------------------------------------------------------------------

interface ToolIssue {
  code: string
  field: string
  message: string
}

/** 失败：`ok:false` + 稳定 code + 可读原因（**不抛栈**，模型看到的是"该怎么改"）。 */
interface ToolFailure {
  ok: false
  code: string
  field?: string
  message: string
  currentVersion?: number
}

interface ToolOperationResult {
  ok: boolean
  draftId?: string
  contentVersion?: number
  phase?: string
  changed?: boolean
  errors?: ToolIssue[]
  warnings?: ToolIssue[]
  message?: string
  code?: string
  field?: string
  currentVersion?: number
}

interface ToolValidationSnapshot {
  manifestHash: string
  checkedAt: string
  errors: ToolIssue[]
  warnings: ToolIssue[]
}

interface ToolDraftSummary {
  ok: boolean
  found: boolean
  draftId?: string
  statusCode?: string
  contentVersion?: number
  phase?: string
  expertId?: string
  request?: string
  personaChars?: number
  skills?: Array<{ name: string; required: boolean; action: string; sourceId: string }>
  files?: Array<{ area: string; path: string; bytes: number; sha256: string }>
  provenanceKind?: string
  provenanceSourceCount?: number
  validation?: ToolValidationSnapshot
  message?: string
  code?: string
  field?: string
  currentVersion?: number
}

interface ToolValidateResult {
  ok: boolean
  draftId?: string
  contentVersion?: number
  phase?: string
  manifestHash?: string
  errors?: ToolIssue[]
  warnings?: ToolIssue[]
  message?: string
  code?: string
  field?: string
  currentVersion?: number
}

// ---------------------------------------------------------------------------
// schema 片段（`as const` 保住字面量类型：`defineTool` 靠它推断 output 的真实形状）
// ---------------------------------------------------------------------------

/** 一条字段级问题（ExpertIssue）。 */
const ISSUE_ITEM = {
  type: 'object',
  additionalProperties: false,
  description: '一条字段级问题',
  properties: {
    code: { type: 'string', required: true, description: '§12.1 的稳定错误码' },
    field: { type: 'string', required: true, description: '出问题的字段（相对字段名）' },
    message: { type: 'string', required: true, description: '可读原因（不含服务端绝对路径）' },
  },
} as const

/** 一条暂存文件索引。 */
const STAGED_FILE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string', required: true, description: 'persona-resource | skill' },
    path: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    sha256: { type: 'string', required: true },
  },
} as const

/** 一条技能需求。 */
const SKILL_REQUIREMENT_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    required: { type: 'boolean', required: true },
    action: { type: 'string', required: true, description: 'install | reuse' },
    sourceId: { type: 'string', description: '来源 id；没有就是空串' },
  },
} as const

const OPERATION_RESULT_DESCRIPTION =
  '§5.1 的操作结果：成功给 draftId/contentVersion/phase，失败给 code/field/message（版本冲突时带 currentVersion）'

const SHARED_FAILURE_NOTE =
  '本工具只写**草稿**：正式角色库只有用户在界面上确认安装后才会被写；没有任何确认/安装工具，也不要通过 shell 去写正式库。'

// ---------------------------------------------------------------------------
// 1) workbench_get_expert_draft
// ---------------------------------------------------------------------------

/**
 * §5.1 第 1 行：**没有参数**，按 `exec.agent.session.id` 取本会话当前的专家草稿。
 *
 * 返回清单而不返回人格正文：正文是模型自己刚提交的，重复回灌只会烧上下文；
 * 版本号与暂存清单才是下一次操作真正需要的东西。
 */
export function getExpertDraftTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_get_expert_draft',
    description:
      '个人工作台专家草稿工具：取回**本会话**当前的专家草稿（id、contentVersion、阶段、暂存文件清单、技能需求、最近校验）。'
      + '没有任何入参 —— 服务端只认执行上下文里的真实会话 id。第一次调用它来确认身份与版本，之后所有操作都用返回的 contentVersion。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: '当前会话的专家草稿清单视图（**不含人格正文**：正文已经在对话里）',
        properties: {
          ok: { type: 'boolean', required: true },
          found: { type: 'boolean', required: true, description: '本会话有没有 pending 专家草稿' },
          draftId: { type: 'string' },
          statusCode: { type: 'string' },
          contentVersion: { type: 'number' },
          phase: { type: 'string', description: 'editing | validated | installing | install-failed' },
          expertId: { type: 'string', description: '服务端生成的 generated/<UUID>' },
          request: { type: 'string', description: '这份草稿对应的用户需求原文' },
          personaChars: { type: 'number', description: '已提交人格正文的字符数' },
          skills: { type: 'array', description: '这份草稿声明的技能需求', items: SKILL_REQUIREMENT_ITEM },
          files: { type: 'array', description: '暂存文件清单（相对路径）', items: STAGED_FILE_ITEM },
          provenanceKind: { type: 'string', description: 'translated | adapted | merged | original（没提交来源时没有这个字段）' },
          provenanceSourceCount: { type: 'number', description: '已登记来源条数' },
          validation: {
            type: 'object',
            additionalProperties: false,
            description: '最近一次校验快照（还没校验过时没有这个字段）',
            properties: {
              manifestHash: { type: 'string', required: true },
              checkedAt: { type: 'string', required: true },
              errors: { type: 'array', description: '校验错误（非空 = 草稿仍待修复）', items: ISSUE_ITEM },
              warnings: { type: 'array', description: '校验警告', items: ISSUE_ITEM },
            },
          },
          message: { type: 'string' },
          code: { type: 'string', description: '失败主因（§12.1）' },
          field: { type: 'string', description: '失败定位到的字段' },
          currentVersion: { type: 'number', description: '失败时当前真实版本：用它重试' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(_args, exec: ExpertToolExec): Promise<ToolDraftSummary> {
      try {
        const view = service.currentPendingDraft(sessionIdOf(exec))
        if (view === undefined) {
          return {
            ok: true,
            found: false,
            message: '本会话还没有专家草稿：先由界面发起「新建专家」（POST /api/workbench/experts/generation-start），再回来取版本。',
          }
        }
        return { ok: true, found: true, ...draftSummary(view), message: draftMessage(view) }
      } catch (error) {
        /** 清单视图的失败也要带 `found`（schema 里它是必需字段）。 */
        return { ...failureOf(service, error), found: false }
      }
    },
  })
}

function sessionIdOf(exec: ExpertToolExec | undefined): string {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' ? id.trim() : ''
}

function draftSummary(view: ExpertDraftView): Omit<ToolDraftSummary, 'ok' | 'found' | 'message'> {
  const provenance = view.provenance
  const validation = view.validation
  return {
    draftId: view.draftId,
    statusCode: view.statusCode,
    contentVersion: view.contentVersion,
    phase: view.phase,
    expertId: view.expertId,
    request: view.request,
    personaChars: view.personaMd.length,
    skills: view.skills.map((entry) => ({
      name: entry.name,
      required: entry.required === true,
      action: entry.action,
      sourceId: entry.sourceId === null ? '' : entry.sourceId,
    })),
    files: view.files.map((entry) => ({ area: entry.area, path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
    ...(provenance === null ? {} : {
      provenanceKind: provenance.creationKind,
      provenanceSourceCount: Array.isArray(provenance.sources) ? provenance.sources.length : 0,
    }),
    ...(validation === null ? {} : {
      validation: {
        manifestHash: validation.manifestHash,
        checkedAt: validation.checkedAt,
        errors: issues(validation.errors),
        warnings: issues(validation.warnings),
      },
    }),
  }
}

function draftMessage(view: ExpertDraftView): string {
  const errorCount = view.validation === null ? 0 : view.validation.errors.length
  return `专家草稿 ${view.draftId}：contentVersion=${view.contentVersion}，phase=${view.phase}，`
    + `暂存文件 ${view.files.length} 个，技能需求 ${view.skills.length} 条，校验错误 ${errorCount} 条。`
    + `下一次操作请使用 expected_version=${view.contentVersion}。`
}

// ---------------------------------------------------------------------------
// 2) workbench_submit_expert_draft
// ---------------------------------------------------------------------------

export function submitExpertDraftTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_submit_expert_draft',
    description:
      '个人工作台专家草稿工具：提交人格正文（persona_md）与来源/技能元数据（provenance_json / skills_json，都是 JSON 字符串）。'
      + '提交会递增 contentVersion 并清空上一次校验。' + SHARED_FAILURE_NOTE,
    parameters: {
      draft_id: { type: 'string', required: true, description: '要修改的专家草稿 id（UUID）' },
      expected_version: { type: 'integer', required: true, description: '你手里那份草稿的 contentVersion；不一致会被拒绝（409）' },
      persona_md: { type: 'string', required: true, description: '人格 Markdown 全文（frontmatter 要有 group；名称 ≤40、简介 ≤160、正文 ≤20000 字符）' },
      provenance_json: { type: 'string', description: '来源登记 JSON 字符串（§3.2 结构）；先提交人格、稍后补也行，但校验前必须提交' },
      skills_json: { type: 'string', description: '技能需求 JSON 数组字符串（每项 name/required/action/sourceId/packageFiles/reason）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: OPERATION_RESULT_DESCRIPTION,
        properties: {
          ok: { type: 'boolean', required: true },
          draftId: { type: 'string' },
          contentVersion: { type: 'number' },
          phase: { type: 'string' },
          changed: { type: 'boolean' },
          errors: { type: 'array', description: '字段级问题', items: ISSUE_ITEM },
          warnings: { type: 'array', description: '字段级警告', items: ISSUE_ITEM },
          message: { type: 'string' },
          code: { type: 'string', description: '失败主因（§12.1）' },
          field: { type: 'string' },
          currentVersion: { type: 'number', description: '失败时当前真实版本：用它重试' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: {
      draft_id: string
      expected_version: number
      persona_md: string
      provenance_json?: string
      skills_json?: string
    }, exec: ExpertToolExec): Promise<ToolOperationResult> {
      const result = await service.submitDraft({
        draftId: args.draft_id,
        expectedVersion: args.expected_version,
        personaMd: args.persona_md,
        provenanceJson: args.provenance_json,
        skillsJson: args.skills_json,
      }, exec)
      return operationResult(service, result)
    },
  })
}

// ---------------------------------------------------------------------------
// 3) workbench_stage_expert_file
// ---------------------------------------------------------------------------

export function stageExpertFileTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_stage_expert_file',
    description:
      '个人工作台专家草稿工具：把**一个**文本文件写进这份草稿的暂存区（许可原文、角色资源、要安装的 skill 文件）。'
      + '路径是相对路径且只能落在草稿自己的暂存目录里；单文件 ≤128KiB、整包 ≤1MiB、最多 64 个文件。' + SHARED_FAILURE_NOTE,
    parameters: {
      draft_id: { type: 'string', required: true, description: '要修改的专家草稿 id（UUID）' },
      expected_version: { type: 'integer', required: true, description: '你手里那份草稿的 contentVersion' },
      area: { type: 'string', required: true, enum: ['persona-resource', 'skill'], description: 'persona-resource=人格资源；skill=某个技能的包文件' },
      path: { type: 'string', required: true, description: '相对路径（`/` 分隔、不能有 `..`、不能是保留名；skill 区必须带 `<技能名>/` 前缀）' },
      content_utf8: { type: 'string', required: true, description: 'UTF-8 文本原文（许可文本不要重排、不要截断）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: OPERATION_RESULT_DESCRIPTION,
        properties: {
          ok: { type: 'boolean', required: true },
          draftId: { type: 'string' },
          contentVersion: { type: 'number' },
          phase: { type: 'string' },
          changed: { type: 'boolean' },
          errors: { type: 'array', description: '字段级问题', items: ISSUE_ITEM },
          warnings: { type: 'array', description: '字段级警告', items: ISSUE_ITEM },
          message: { type: 'string' },
          code: { type: 'string', description: '失败主因（§12.1）' },
          field: { type: 'string' },
          currentVersion: { type: 'number' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: {
      draft_id: string
      expected_version: number
      area: string
      path: string
      content_utf8: string
    }, exec: ExpertToolExec): Promise<ToolOperationResult> {
      const result = await service.stageFile({
        draftId: args.draft_id,
        expectedVersion: args.expected_version,
        area: args.area,
        path: args.path,
        contentUtf8: args.content_utf8,
      }, exec)
      return operationResult(service, result)
    },
  })
}

// ---------------------------------------------------------------------------
// 4) workbench_remove_expert_staged_file
// ---------------------------------------------------------------------------

export function removeExpertStagedFileTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_remove_expert_staged_file',
    description:
      '个人工作台专家草稿工具：从这份草稿的暂存索引里删掉一个已暂存的文件（只删这份草稿索引里的那条，不会碰正式库）。'
      + '要删的路径不在索引里时是幂等的（ok:true, changed:false）。' + SHARED_FAILURE_NOTE,
    parameters: {
      draft_id: { type: 'string', required: true, description: '要修改的专家草稿 id（UUID）' },
      expected_version: { type: 'integer', required: true, description: '你手里那份草稿的 contentVersion' },
      area: { type: 'string', required: true, enum: ['persona-resource', 'skill'], description: 'persona-resource | skill' },
      path: { type: 'string', required: true, description: '要删除的相对路径（以索引里记的那条为准）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: OPERATION_RESULT_DESCRIPTION,
        properties: {
          ok: { type: 'boolean', required: true },
          draftId: { type: 'string' },
          contentVersion: { type: 'number' },
          phase: { type: 'string' },
          changed: { type: 'boolean', description: 'false = 索引里本来就没有这条（幂等）' },
          errors: { type: 'array', description: '字段级问题', items: ISSUE_ITEM },
          warnings: { type: 'array', description: '字段级警告', items: ISSUE_ITEM },
          message: { type: 'string' },
          code: { type: 'string', description: '失败主因（§12.1）' },
          field: { type: 'string' },
          currentVersion: { type: 'number' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: {
      draft_id: string
      expected_version: number
      area: string
      path: string
    }, exec: ExpertToolExec): Promise<ToolOperationResult> {
      const result = await service.removeFile({
        draftId: args.draft_id,
        expectedVersion: args.expected_version,
        area: args.area,
        path: args.path,
      }, exec)
      return operationResult(service, result)
    },
  })
}

// ---------------------------------------------------------------------------
// 5) workbench_validate_expert_draft
// ---------------------------------------------------------------------------

export function validateExpertDraftTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_validate_expert_draft',
    description:
      '个人工作台专家草稿工具：重读全部暂存文件（人格、来源与许可、技能包结构、必需依赖），返回 errors/warnings/manifestHash。'
      + '`errors` 非空表示草稿仍待修复：按 errors 精确修改，最多 3 轮。校验通过**不代表安装完成** —— '
      + '它只是把草稿推进到等用户确认的状态。' + SHARED_FAILURE_NOTE,
    parameters: {
      draft_id: { type: 'string', required: true, description: '要校验的专家草稿 id（UUID）' },
      expected_version: { type: 'integer', required: true, description: '你手里那份草稿的 contentVersion' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: '§5.1 的校验结果：errors 非空表示草稿仍待修复（**不代表安装成功**）',
        properties: {
          ok: { type: 'boolean', required: true },
          draftId: { type: 'string' },
          contentVersion: { type: 'number' },
          phase: { type: 'string' },
          manifestHash: { type: 'string', description: '这份包的 manifestHash；用户确认时要带上它' },
          errors: { type: 'array', description: '校验错误', items: ISSUE_ITEM },
          warnings: { type: 'array', description: '校验警告', items: ISSUE_ITEM },
          message: { type: 'string' },
          code: { type: 'string', description: '失败主因（§12.1）' },
          field: { type: 'string' },
          currentVersion: { type: 'number', description: '失败时当前真实版本：用它重试' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: { draft_id: string; expected_version: number }, exec: ExpertToolExec): Promise<ToolValidateResult> {
      try {
        /** 传 `exec`：工具路径必须过 owner 守卫，不许校验别的会话的草稿（§5.1）。 */
        const view = await service.validateDraft(args.draft_id, args.expected_version, exec)
        const validation = view.validation
        const errors = validation === null ? [] : issues(validation.errors)
        const warnings = validation === null ? [] : issues(validation.warnings)
        return {
          ok: true,
          draftId: view.draftId,
          contentVersion: view.contentVersion,
          phase: view.phase,
          manifestHash: validation === null ? '' : validation.manifestHash,
          errors,
          warnings,
          message: errors.length === 0
            ? `校验通过：草稿 ${view.draftId}（v${view.contentVersion}, phase=${view.phase}）待用户在界面确认安装；你没有确认工具，不要自己安装。`
            : `校验发现 ${errors.length} 个错误（v${view.contentVersion}, phase=${view.phase}）：按 errors 的 field 精确修改后重新提交，再用 expected_version=${view.contentVersion} 重试。`,
        }
      } catch (error) {
        return failureOf(service, error)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 共享转换
// ---------------------------------------------------------------------------

function issues(list: readonly ExpertIssue[]): ToolIssue[] {
  return list.map((entry) => ({ code: entry.code, field: entry.field, message: entry.message }))
}

/**
 * 失败统一走**服务层那一个**投影（`ok:false` 的返回对象与抛出的异常都吃）：
 * 状态码口径与"绝对路径不进消息"这两件事因此只有一份实现。
 */
function failureOf(service: ExpertService, error: unknown): ToolFailure {
  const { body } = service.projectFailure(error)
  return {
    ok: false,
    code: body.code,
    ...(body.field === undefined ? {} : { field: body.field }),
    message: body.error,
    ...(body.currentVersion === undefined ? {} : { currentVersion: body.currentVersion }),
  }
}

/** 域结果 → 工具返回值（新建字面量，与 `output.schema` 一一对应）。 */
function operationResult(service: ExpertService, result: ExpertOperationResult): ToolOperationResult {
  if (result.ok) {
    return {
      ok: true,
      draftId: result.draftId,
      contentVersion: result.contentVersion,
      phase: result.phase,
      changed: result.changed,
      errors: issues(result.errors),
      warnings: issues(result.warnings),
      message: result.message,
    }
  }
  const { body } = service.projectFailure(result)
  return {
    ok: false,
    code: body.code,
    ...(body.field === undefined ? {} : { field: body.field }),
    message: body.error,
    ...(body.currentVersion === undefined ? {} : { currentVersion: body.currentVersion }),
    ...(body.errors === undefined ? {} : { errors: issues(body.errors) }),
  }
}

/** 装配层用：一次拿全 5 个生成工具。 */
export function expertGenerationTools(service: ExpertService): ReturnType<typeof defineTool>[] {
  return [
    getExpertDraftTool(service),
    submitExpertDraftTool(service),
    stageExpertFileTool(service),
    removeExpertStagedFileTool(service),
    validateExpertDraftTool(service),
  ]
}

/** 生成工具的静态名字清单（测试断言"没有确认类工具"时用同一份权威列表）。 */
export const EXPERT_GENERATION_TOOL_NAMES = [
  'workbench_get_expert_draft',
  'workbench_submit_expert_draft',
  'workbench_stage_expert_file',
  'workbench_remove_expert_staged_file',
  'workbench_validate_expert_draft',
] as const

// ---------------------------------------------------------------------------
// P6：专家**调用主链**的 4 个工具（规格 §8.2）
// ---------------------------------------------------------------------------

/**
 * 调用主链工具的执行上下文：除了生成工具用到的身份，还多一个 `callId`。
 *
 * `callId` 是 auto 调用的**去重身份**（§8.6）：同一次工具执行重复进入只算一次，
 * 换一个 `callId` 就是用户有意发起的**新**请求 —— 绝不按任务文本合并两次独立调用。
 */
export interface ExpertInvocationToolExec extends ExpertToolExec {
  agent?: { session?: { id?: string; header?: unknown }; options?: unknown }
  callId?: string
}

interface ToolInvocationResult {
  ok: boolean
  requestId?: string
  personaId?: string
  sourceKey?: string
  revision?: string
  childSessionId?: string
  stopReason?: string
  personaLoaded?: boolean
  text?: string
  truncated?: boolean
  warnings?: ToolIssue[]
  code?: string
  field?: string
  message?: string
}

interface ToolLoadResult {
  ok: boolean
  personaId?: string
  name?: string
  description?: string
  sourceKey?: string
  revision?: string
  body?: string
  resources?: Array<{ path: string; bytes: number }>
  skills?: Array<{ name: string; required: boolean; action: string; available: boolean }>
  boundary?: string
  warnings?: ToolIssue[]
  code?: string
  field?: string
  message?: string
}

interface ToolResourceResult {
  ok: boolean
  personaId?: string
  path?: string
  text?: string
  bytes?: number
  characters?: number
  revision?: string
  resources?: Array<{ path: string; bytes: number }>
  diagnostics?: ToolIssue[]
  code?: string
  field?: string
  message?: string
}

/** 一条人格资源索引。 */
const PERSONA_RESOURCE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true, description: '相对人格资源目录的路径' },
    bytes: { type: 'number', required: true },
  },
} as const

/** 一条技能需求的**求值结果**（比草稿里的需求多一个 available）。 */
const SKILL_EFFECTIVE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    required: { type: 'boolean', required: true },
    action: { type: 'string', required: true, description: 'install | reuse' },
    available: { type: 'boolean', required: true, description: '当前是否真的可用' },
  },
} as const

/**
 * 调用结果的共享字段（`workbench_run_expert_request` 与 `summon_expert` 同一份形状，§8.7）。
 *
 * 只有 `ok` 是**必需**字段：失败时也必须能只带 `ok:false + code + field + message` 返回
 * （否则失败路径会被 schema 逼着伪造一份"看起来成功"的空结果）。
 */
const INVOCATION_RESULT_PROPERTIES = {
  ok: { type: 'boolean', required: true },
  requestId: { type: 'string', description: '本次调用的身份：手动请求 id，或 auto 的 `auto:<会话id>:<callId>`' },
  personaId: { type: 'string' },
  sourceKey: { type: 'string', description: '已校验的人格来源（运行期换来源会被拒，不会悄悄换）' },
  revision: { type: 'string', description: '本次加载的完整 sha256 修订号' },
  childSessionId: { type: 'string', description: '真实子会话 id（界面据此打开子会话；失败时可能是空串）' },
  stopReason: { type: 'string', description: 'completed | aborted | error | max-tokens | refusal（子代理自报的真实停止原因）' },
  personaLoaded: { type: 'boolean', description: '子代理成功加载了指定人格（false 时不算成功）' },
  text: { type: 'string', description: '子代理结论正文（超长会被截断并置 truncated）' },
  truncated: { type: 'boolean', description: 'true = 正文超过上限被截断' },
  warnings: { type: 'array', description: '非致命问题（清理失败等）', items: ISSUE_ITEM },
  code: { type: 'string', description: '失败主因（§12.1 + 人格域的 revision-changed / not-found 等）' },
  field: { type: 'string' },
  message: { type: 'string' },
} as const

const INVOCATION_RESULT_DESCRIPTION =
  '§8.7 的调用结果：ok:true 时给 personaId/sourceKey/revision/childSessionId/stopReason/personaLoaded/text/truncated；'
  + '失败时给 ok:false + code + field + message（可能带 partial 文本与 warnings）'

const LOAD_RESULT_DESCRIPTION =
  '被召唤人格的加载结果：正文 + 修订号 + 资源清单 + 技能需求 + 边界提醒（不含人格目录的绝对路径）'

const RESOURCE_RESULT_DESCRIPTION =
  '被召唤人格的一条资源文件（只在该人格的**资源目录内**；附件里的脚本不会被工作台执行）'

/** 调用主链的失败投影：复用服务层那一个 `projectFailure`，但**去掉** `currentVersion`（调用主链没有版本冲突语义）。 */
function invocationFailure(service: ExpertService, error: unknown): ToolInvocationResult {
  const { body } = service.projectFailure(error)
  return {
    ok: false,
    code: body.code,
    ...(body.field === undefined ? {} : { field: body.field }),
    message: body.error,
    warnings: [],
  }
}

function invocationResultOf(result: ExpertInvocationResult): ToolInvocationResult {
  return {
    ok: result.ok,
    requestId: result.requestId,
    personaId: result.personaId,
    sourceKey: result.sourceKey,
    revision: result.revision,
    childSessionId: result.childSessionId,
    stopReason: result.stopReason,
    personaLoaded: result.personaLoaded,
    text: result.text,
    truncated: result.truncated,
    warnings: issues(result.warnings),
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.field === undefined ? {} : { field: result.field }),
    ...(result.message === undefined ? {} : { message: result.message }),
  }
}

/**
 * §8.2 第 1 行：按人工请求 id 执行一次专家调用。
 *
 * 参数里**没有** session_id：父会话身份只认 `exec.agent`（模型无法用参数冒领别的会话的请求）。
 * 请求属于别的会话 / 已过期 / 已换任务 / 已有运行中的调用都会被明确拒绝。
 */
export function runExpertRequestTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_run_expert_request',
    description:
      '个人工作台专家调用工具：按人工请求 id 执行一次专家调用。'
      + '身份只认执行上下文里的真实父会话：请求不属于本会话 / 已过期 / 已换任务 / 已有运行中的调用都会被拒（专家**忙**时不排队）。'
      + '同一个请求 + 同一个任务重复调用只启动一次子代理（拿到同一份结果）。'
      + '专家子代理不能调用本工具。',
    parameters: {
      request_id: { type: 'string', required: true, description: '手动请求 id（界面上创建请求时生成）' },
      task: { type: 'string', required: true, description: '要交给专家子代理的任务（1–12000 字符；首次执行后本请求的任务就固定了）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: INVOCATION_RESULT_DESCRIPTION,
        properties: INVOCATION_RESULT_PROPERTIES,
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: { request_id: string; task: string }, exec: ExpertInvocationToolExec): Promise<ToolInvocationResult> {
      try {
        const result = await service.runManual(args.request_id, args.task, exec)
        return invocationResultOf(result)
      } catch (error) {
        return invocationFailure(service, error)
      }
    },
  })
}

/**
 * §8.5：**专家子代理自己**用 ticket 按需加载人格正文。
 *
 * ticket 是"父会话 → 一次调用 → 某一个子会话"的凭证：父会话、普通会话、另一个子代理
 * 拿到它都读不到正文；一次调用结束后 ticket 立即失效。
 */
export function loadInvokedExpertTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_load_invoked_expert',
    description:
      '个人工作台专家调用工具：**专家子代理自己**用它按 ticket 加载被召唤人格的正文。'
      + '只有本次调用登记的那个子会话能用（父会话 / 普通会话 / 别的子代理都读不到）。'
      + '加载成功后按正文工作；资源用 workbench_read_invoked_expert_resource 读；未加载成功必须停下报告原因。',
    parameters: {
      ticket: { type: 'string', required: true, description: '召唤时写在 persona 参数里的 hex ticket（照抄，不要改写）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: LOAD_RESULT_DESCRIPTION,
        properties: {
          ok: { type: 'boolean', required: true },
          personaId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          sourceKey: { type: 'string' },
          revision: { type: 'string' },
          body: { type: 'string', description: '人格正文（按它工作）' },
          resources: { type: 'array', description: '可用资源清单（相对路径）', items: PERSONA_RESOURCE_ITEM },
          skills: { type: 'array', description: '该人格的技能需求与当前可用性', items: SKILL_EFFECTIVE_ITEM },
          boundary: { type: 'string', description: '资源边界提醒' },
          warnings: { type: 'array', items: ISSUE_ITEM },
          code: { type: 'string' },
          field: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: { ticket: string }, exec: ExpertInvocationToolExec): Promise<ToolLoadResult> {
      try {
        const result = await service.loadForChild(args.ticket, exec)
        return loadResultOf(result)
      } catch (error) {
        return invocationFailure(service, error)
      }
    },
  })
}

function loadResultOf(result: ExpertLoadResult): ToolLoadResult {
  return {
    ok: true,
    personaId: result.personaId,
    name: result.name,
    description: result.description,
    sourceKey: result.sourceKey,
    revision: result.revision,
    body: result.body,
    resources: result.resources.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    skills: result.skills.map((entry) => ({
      name: entry.name,
      required: entry.required,
      action: entry.action,
      available: entry.available,
    })),
    boundary: result.boundary,
    warnings: issues(result.warnings),
  }
}

/**
 * §8.5 第 13 步：读人格资源目录里的**一个文本文件**。
 *
 * 与加载同一个 ticket、同一个子会话、同一个人格来源 / 修订号；路径边界由
 * `readPersonaResource` 判定（相对路径、扩展名白名单、大小上限），附件里的脚本不会被执行。
 */
export function readInvokedExpertResourceTool(service: ExpertService) {
  return defineTool({
    name: 'workbench_read_invoked_expert_resource',
    description:
      '个人工作台专家调用工具：按 ticket 读被召唤人格**资源目录内**的一个文本资源文件。'
      + '路径是相对路径且不能越出该人格的资源目录；只读文本（脚本不会被工作台执行）。',
    parameters: {
      ticket: { type: 'string', required: true, description: '同一个 ticket（只有登记的子会话能用）' },
      path: { type: 'string', required: true, description: '相对人格资源目录的路径（`/` 分隔，例如 resources/checklist.md）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: RESOURCE_RESULT_DESCRIPTION,
        properties: {
          ok: { type: 'boolean', required: true },
          personaId: { type: 'string' },
          path: { type: 'string' },
          text: { type: 'string' },
          bytes: { type: 'number' },
          characters: { type: 'number' },
          revision: { type: 'string' },
          resources: { type: 'array', description: '当前可用资源清单', items: PERSONA_RESOURCE_ITEM },
          diagnostics: { type: 'array', description: '资源枚举期的问题（非致命）', items: ISSUE_ITEM },
          code: { type: 'string' },
          field: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: { ticket: string; path: string }, exec: ExpertInvocationToolExec): Promise<ToolResourceResult> {
      try {
        const result = await service.readForChild(args.ticket, args.path, exec)
        return {
          ok: true,
          personaId: result.personaId,
          path: result.path,
          text: result.text,
          bytes: result.bytes,
          characters: result.characters,
          revision: result.revision,
          resources: result.resources.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
          diagnostics: issues(result.diagnostics),
        }
      } catch (error) {
        return invocationFailure(service, error)
      }
    },
  })
}

/**
 * §8.2 第 5 行：**条件注册**的自主专家工具（只在 `autoSummonExperts === true` 时存在）。
 *
 * 执行时**再读一次**开关（§8.2）：关闭前已被模型接受的延迟调用不能继续启动；
 * 已经启动的调用不受影响，关闭也**不杀**手动任务。
 */
export function summonExpertTool(service: ExpertService) {
  return defineTool({
    name: SUMMON_EXPERT_TOOL_NAME,
    description:
      '召唤个人工作台里的一位专家：给 persona_id 与 task，服务在**独立子会话**里以该专家的完整人格做一次任务并把结论回传。'
      + '用户明确需要某个专家的领域能力时用一次即可；不要用它绕开用户确认或代替用户做决定。'
      + '自主专家关闭后本工具会消失；若仍被调用会返回 expert-auto-disabled。',
    parameters: {
      persona_id: { type: 'string', required: true, description: '专家（人格）id，例如 builtin 或用户人格 id' },
      task: { type: 'string', required: true, description: '要交给专家子代理的任务（1–12000 字符）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        description: INVOCATION_RESULT_DESCRIPTION,
        properties: INVOCATION_RESULT_PROPERTIES,
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args: { persona_id: string; task: string }, exec: ExpertInvocationToolExec): Promise<ToolInvocationResult> {
      try {
        /** §8.2：再读一次设置真值 —— 开关关闭后，先前已被接受的调用不再启动新的专家。 */
        if (!service.autoSummonEnabled()) {
          return {
            ok: false,
            code: 'expert-auto-disabled',
            field: 'persona_id',
            message: '自主专家已关闭：本次召唤不再启动（已经启动的调用仍会完成）。',
            warnings: [],
          }
        }
        const result = await service.runAuto(args.persona_id, args.task, exec)
        return invocationResultOf(result)
      } catch (error) {
        return invocationFailure(service, error)
      }
    },
  })
}

/** 装配层用：一次拿全**始终注册**的 3 个调用工具（`summon_expert` 由开关决定，单独取）。 */
export function expertInvocationTools(service: ExpertService): ReturnType<typeof defineTool>[] {
  return [runExpertRequestTool(service), loadInvokedExpertTool(service), readInvokedExpertResourceTool(service)]
}

export const RUN_EXPERT_REQUEST_TOOL_NAME = 'workbench_run_expert_request'
export const LOAD_INVOKED_EXPERT_TOOL_NAME = 'workbench_load_invoked_expert'
export const READ_INVOKED_EXPERT_RESOURCE_TOOL_NAME = 'workbench_read_invoked_expert_resource'
/** §8.2：自主专家工具名（**只有它**是条件注册的，也正是 deny 名单里唯一可能不存在的名字）。 */
export const SUMMON_EXPERT_TOOL_NAME = 'summon_expert'
/** 始终注册的 3 个调用工具名（与生成工具一起构成"专家子代理禁用清单"的一部分）。 */
export const EXPERT_INVOCATION_TOOL_NAMES = [
  RUN_EXPERT_REQUEST_TOOL_NAME,
  LOAD_INVOKED_EXPERT_TOOL_NAME,
  READ_INVOKED_EXPERT_RESOURCE_TOOL_NAME,
] as const
