/**
 * 设置页的读写路由（`/api/workbench/settings`）与它的读模型。
 *
 * ## 为什么从 api/routes.ts 拆出来
 *
 * 那一个 handler 曾经是整份路由表里最长的内联块：逐字段 `typeof` 判断 + 9 次写 meta +
 * 3 个域设置写入口混排，还夹着两条跨服务通知。它和"路由组合"没有关系 —— 而它恰好
 * 是**最容易漏一处**的地方（加字段时 GET/POST 只改一边，表现为"保存后开关自己变回去"）。
 *
 * 拆法：**读模型 `readWorkbenchSettings` 与写入口 `makeSettingsRoutes` 放在同一个文件**，
 * 因为"读到的形状"和"能写的字段"必须被同一个人看见（这正是当年出 bug 的地方）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest, readJsonBody, writeJson } from '../http.js'
import { readMeta, writeMeta } from '../../db/repo.js'
import { readExpertSettings, writeExpertSettings } from '../../db/repo/experts.js'
import { readPersonaSettings, writePersonaSettings } from '../../db/repo/personas.js'
import { normalizeRecentWorkspaces } from '../../shared/quickWorkspaceRecent.js'
import { isUiLocale, normalizeUiLocale } from '../../shared/i18n.js'
import type { WorkbenchSettings } from '../../shared/contracts.js'
import type { KnowledgeRecallManager } from '../../knowledge/recall.js'
import type { ExpertService } from '../../experts/service.js'

/** 每天可投入时长（分钟）：存 meta，缺省 390（6.5 小时），夹在 30–1440 之间。 */
export const DEFAULT_DAILY_CAPACITY_MINUTES = 390
export function readDailyCapacityMinutes(db: DatabaseSync): number {
  const raw = Number(readMeta(db, 'daily_capacity_minutes'))
  if (!Number.isFinite(raw) || raw < 30) return DEFAULT_DAILY_CAPACITY_MINUTES
  return Math.min(1440, Math.round(raw))
}

/**
 * 没填「预计耗时」时的默认分钟数：存 meta，缺省 30，夹在 5–1440 之间。
 *
 * ⚠️ 这两个常量（`DEFAULT_ESTIMATE_MINUTES` / `MIN_ESTIMATE_MINUTES`）与客户端
 * `src/client/capacity.ts` 里**必须同值**：一处是"读书时兜底"，一处是"落库时夹取"，
 * 不同值就会出现"库里存 3 分钟、界面按 5 分钟算"的双口径。
 * 测试 `test/routes.test.mjs` 直接 import 客户端那份做交叉断言，不靠人记。
 */
export const DEFAULT_SETTINGS_ESTIMATE_MINUTES = 30
export const MIN_SETTINGS_ESTIMATE_MINUTES = 5
export const MAX_SETTINGS_ESTIMATE_MINUTES = 1440
export function readDefaultEstimateMinutes(db: DatabaseSync): number {
  const raw = Number(readMeta(db, 'default_estimated_minutes'))
  if (!Number.isFinite(raw) || raw < MIN_SETTINGS_ESTIMATE_MINUTES) return DEFAULT_SETTINGS_ESTIMATE_MINUTES
  return Math.min(MAX_SETTINGS_ESTIMATE_MINUTES, Math.round(raw))
}

/**
 * 读取「最近用过的工作区」列表。
 *
 * 存 meta 的 JSON 字符串（单键，不动 schema）：这是**用户偏好**而非业务数据，
 * 且必须容忍脏值（手改过 meta、旧版本写过别的形状）——解析失败就返回空数组，
 * 绝不让一个坏字符串把设置接口整个打挂。脏值也在这里归一化（去重/截断）。
 */
export function readRecentWorkspaces(db: DatabaseSync): string[] {
  const raw = readMeta(db, 'quick_workspace_recent')
  if (raw === undefined || raw === '') return []
  try { return normalizeRecentWorkspaces(JSON.parse(raw)) } catch { return [] }
}


/**
 * 读一份完整的设置视图（GET 与 POST 的响应**共用这一个实现**）。
 *
 * 为什么必须抽出来：原先 GET/POST 各写一份字面量，加字段时极易只加一处 ——
 * 表现为"保存后返回的设置少了一个字段"，而前端是拿响应回填 state 的，
 * 于是那个开关看起来"保存后自己变回去了"（本轮加 `autoKnowledgeRecall` 时正好撞上这个风险）。
 */
export function readWorkbenchSettings(db: DatabaseSync): WorkbenchSettings {
  return {
    defaultWorkspace: readMeta(db, 'ai_default_workspace') ?? '',
    autoCreateTypeFolders: (readMeta(db, 'auto_create_type_folders') ?? '1') === '1',
    desktopNotify: (readMeta(db, 'desktop_notify') ?? '1') === '1',
    dailyCapacityMinutes: readDailyCapacityMinutes(db),
    quickWorkspaceRecent: readRecentWorkspaces(db),
    /** 缺省**开**：功能不默认关闭，否则用户永远发现不了它（关掉是显式动作）。 */
    autoKnowledgeRecall: (readMeta(db, 'knowledge_recall_auto') ?? '1') !== '0',
    defaultEstimateMinutes: readDefaultEstimateMinutes(db),
    /** 缺省**关**：逾期是历史欠账，默认不混进"今天要做的事"（见 contracts 里的说明）。 */
    dailyCapacityIncludeOverdue: (readMeta(db, 'daily_capacity_include_overdue') ?? '0') === '1',
    /** 角色库三个偏好：**唯一读入口**在 `db/repo/personas.ts`（与写入端共用一处形状）。 */
    ...readPersonaSettings(db),
    /** 界面语言（issue #12）：客户端显示偏好，服务端只持久化。缺省 auto。 */
    uiLocale: normalizeUiLocale(readMeta(db, 'ui_locale')),
    /**
     * 专家自动召唤（缺省**关**）：**唯一实现**在 `db/repo/experts.ts`。
     *
     * 这里刻意不写 `readMeta(db, 'expert_auto_summon') === '1'`：meta 键名与真值口径
     * 只允许有一处（仓储），否则"设置页显示开、实际按关跑"迟早会发生。
     */
    ...readExpertSettings(db),
  }
}

export interface SettingsRouteDeps {
  /** 知识库自动召回管理器（写入开关要同步到它，否则设置页显示开、实际按关跑）。 */
  knowledgeRecall?: KnowledgeRecallManager
  /** 专家服务（自动召唤开关同理）。 */
  experts?: ExpertService
}

/** 设置页路由：GET 读视图 / POST 逐字段写，响应一律回完整视图（前端拿它回填 state）。 */
export function makeSettingsRoutes(db: DatabaseSync, deps: SettingsRouteDeps = {}): WebRoute[] {
  return [
    // ------------------------------------------------------------------ settings
    {
      kind: 'exact',
      path: '/api/workbench/settings',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const method = req.method ?? 'GET'
        if (method === 'GET') return writeJson(res, 200, { ok: true, settings: readWorkbenchSettings(db) })
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
          if (typeof body.defaultWorkspace === 'string') writeMeta(db, 'ai_default_workspace', body.defaultWorkspace)
          /** 界面语言：只接受封闭枚举；脏值不写（避免设置页显示一个不存在的语言）。 */
          if (isUiLocale(body.uiLocale)) writeMeta(db, 'ui_locale', body.uiLocale)
          if (body.autoCreateTypeFolders === true || body.autoCreateTypeFolders === false) writeMeta(db, 'auto_create_type_folders', body.autoCreateTypeFolders ? '1' : '0')
          if (body.desktopNotify === true || body.desktopNotify === false) writeMeta(db, 'desktop_notify', body.desktopNotify ? '1' : '0')
          /**
           * 知识库自动召回开关（v1.15.3）：写的是**同一个 meta 键**
           * （`knowledge_recall_auto`），与 `/api/workbench/knowledge-recall/auto` 共享 ——
           * 两个入口写两个键就一定会出现"设置页显示开、实际按关跑"的矛盾。
           */
          if (body.autoKnowledgeRecall === true || body.autoKnowledgeRecall === false) {
            writeMeta(db, 'knowledge_recall_auto', body.autoKnowledgeRecall ? '1' : '0')
            deps.knowledgeRecall?.setAutoEnabled(body.autoKnowledgeRecall)
          }
          if (typeof body.dailyCapacityMinutes === 'number' && Number.isFinite(body.dailyCapacityMinutes)) {
            const minutes = Math.min(1440, Math.max(30, Math.round(body.dailyCapacityMinutes)))
            writeMeta(db, 'daily_capacity_minutes', String(minutes))
          }
          /**
           * 默认耗时（v1.15.1）：没填「预计耗时」的任务按它计入今日容量。
           * 夹 5–1440，缺省 30；越界按边界落库而不是静默丢弃（静默丢件是禁区）。
           */
          if (typeof body.defaultEstimateMinutes === 'number' && Number.isFinite(body.defaultEstimateMinutes)) {
            const minutes = Math.min(MAX_SETTINGS_ESTIMATE_MINUTES, Math.max(MIN_SETTINGS_ESTIMATE_MINUTES, Math.round(body.defaultEstimateMinutes)))
            writeMeta(db, 'default_estimated_minutes', String(minutes))
          }
          /** 逾期是否计入今日容量：写单个 meta 键，客户端读同一键（不另开字段）。 */
          if (body.dailyCapacityIncludeOverdue === true || body.dailyCapacityIncludeOverdue === false) {
            writeMeta(db, 'daily_capacity_include_overdue', body.dailyCapacityIncludeOverdue ? '1' : '0')
          }
          /**
           * 角色库三个偏好（§6.3）：路径 + 两个 ID 数组。
           *
           * 写入实现**只有一处**（`db/repo/personas.ts`）：GET 与 POST 的响应都走
           * `readWorkbenchSettings`，所以"形状一致"是结构上保证的，不靠人记得同步两处。
           * 数组语义是**整表替换**（与 `quickWorkspaceRecent` 同口径）：设置页必须能
           * 删掉一个收藏 —— 合并语义下删掉的门会被并回来。
           */
          writePersonaSettings(db, {
            personaExternalDir: body.personaExternalDir,
            personaFavorites: body.personaFavorites,
            personaDisabledIds: body.personaDisabledIds,
          })
          /**
           * 专家自动召唤开关：**只接受真正的 boolean**（`'false'` 字符串不算，
           * 否则 `Boolean('false') === true` 会让界面"显示关、实际按开跑"）。
           * 写入实现只有一处（`db/repo/experts.ts` 的 `writeExpertSettings`）。
           */
          writeExpertSettings(db, { autoSummonExperts: body.autoSummonExperts })
          /**
           * 专家服务的**同一份**设置在服务侧也要生效（P6 的自主召唤调度读服务）：
           * 只在"真的是 boolean"时转发 —— 脏值（`'true'` 字符串等）落库时就被拒了，
           * 转发脏值会让服务侧与设置页出现两套口径。
           */
          if (body.autoSummonExperts === true || body.autoSummonExperts === false) {
            deps.experts?.setAutoEnabled(body.autoSummonExperts)
          }
          if (Array.isArray(body.quickWorkspaceRecent)) {
            /**
             * ⚠️ 语义是**整表替换**（2026-09-16 从"合并"改过来）：
             * 这个列表现在是"快速录入默认工作区"的唯一来源，客户端必须能**删**它
             * （"不再记住这个目录"）——合并语义下 `[...incoming, ...current]` 会把删掉的门又并回来，
             * 用户改回系统默认工作区就成了不可能（fresh-eyes 审查 F1）。
             * 合并/删除的唯一实现在客户端 `shared/quickWorkspaceRecent.ts`，这里只负责归一化后落库。
             */
            writeMeta(db, 'quick_workspace_recent', JSON.stringify(normalizeRecentWorkspaces(body.quickWorkspaceRecent)))
          }
          return writeJson(res, 200, { ok: true, settings: readWorkbenchSettings(db) })
        }
        return writeJson(res, 405, { error: 'method not allowed' })
      },
    },
  ]
}
