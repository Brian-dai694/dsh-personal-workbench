/**
 * 出厂字典种子。INSERT OR IGNORE：首次安装写入，之后用户改名/停用不会被覆盖。
 *
 * 颜色不写在这里：统一由 `palette.ts` 的 `DICTIONARY_DEFAULT_COLORS` 注入
 * （2026-10-28 与 DSH 统一色系；两侧各写一份配色是上一版的病根）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { DICTIONARY_DEFAULT_COLORS } from '../shared/palette.js'

export interface DictionarySeed {
  kind: string
  code: string
  name: string
  config: Record<string, unknown>
  sortOrder: number
}

const RAW_SEEDS: DictionarySeed[] = [
  // 任务类型
  { kind: 'type', code: 'client_meeting', name: '客户交流', sortOrder: 10, config: { defaultAiPolicy: 'consult', defaultReminderMinutes: 30 } },
  { kind: 'type', code: 'code_impl', name: '代码实现', sortOrder: 20, config: { defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'feature_opt', name: '功能优化', sortOrder: 30, config: { defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'solution_design', name: '方案设计', sortOrder: 40, config: { defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'boss_request', name: '老板要求', sortOrder: 50, config: { defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'team_mgmt', name: '团队管理', sortOrder: 60, config: { defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'project_delivery', name: '项目交付', sortOrder: 70, config: { defaultAiPolicy: 'consult' } },
  { kind: 'type', code: 'personal', name: '个人生活', sortOrder: 80, config: { defaultAiPolicy: 'none', excludeFromReport: true } },
  { kind: 'type', code: 'training', name: '培训学习', sortOrder: 90, config: { defaultAiPolicy: 'consult' } },

  // 状态
  { kind: 'status', code: 'backlog', name: '待规划', sortOrder: 10, config: { category: 'open' } },
  { kind: 'status', code: 'todo', name: '待办', sortOrder: 20, config: { category: 'open' } },
  { kind: 'status', code: 'doing', name: '进行中', sortOrder: 30, config: { category: 'active' } },
  { kind: 'status', code: 'blocked', name: '被阻塞', sortOrder: 40, config: { category: 'active', risk: true } },
  { kind: 'status', code: 'done', name: '已完成', sortOrder: 50, config: { category: 'terminal' } },
  { kind: 'status', code: 'cancelled', name: '已取消', sortOrder: 60, config: { category: 'terminal' } },

  // 优先级
  { kind: 'priority', code: 'p0', name: '紧急', sortOrder: 0, config: { weight: 0, defaultReminderMinutes: 15, meaning: '今天必须处理，不处理会阻塞主线或造成损失' } },
  { kind: 'priority', code: 'p1', name: '高', sortOrder: 1, config: { weight: 1, defaultReminderMinutes: 60, meaning: '本周内必须完成，影响承诺/关键路径' } },
  { kind: 'priority', code: 'p2', name: '普通', sortOrder: 2, config: { weight: 2, defaultReminderMinutes: 1440, meaning: '按计划推进，时间可协商' } },
  { kind: 'priority', code: 'p3', name: '低', sortOrder: 3, config: { weight: 3, defaultReminderMinutes: null, meaning: '有空再做，允许顺延或取消' } },

  // AI 策略
  { kind: 'ai_policy', code: 'none', name: '不允许', sortOrder: 10, config: { allowedV1: true } },
  { kind: 'ai_policy', code: 'consult', name: '可咨询', sortOrder: 20, config: { allowedV1: true, default: true } },
  { kind: 'ai_policy', code: 'execute', name: '可执行', sortOrder: 30, config: { allowedV1: false } },

  // 会话角色
  { kind: 'session_role', code: 'clarify', name: '需求澄清', sortOrder: 10, config: {} },
  { kind: 'session_role', code: 'consult', name: '咨询', sortOrder: 20, config: {} },
  { kind: 'session_role', code: 'breakdown', name: '拆解', sortOrder: 30, config: {} },
  { kind: 'session_role', code: 'review', name: '复盘', sortOrder: 40, config: {} },
  { kind: 'session_role', code: 'execute', name: '执行', sortOrder: 50, config: { allowedV1: false } },

  // 草稿类型 / 草稿状态 / 提醒方式
  { kind: 'draft_kind', code: 'task', name: '单个任务', sortOrder: 10, config: {} },
  { kind: 'draft_kind', code: 'subtask_plan', name: '子任务提案', sortOrder: 20, config: {} },
  { kind: 'draft_kind', code: 'completion', name: '执行完成验收', sortOrder: 30, config: {} },
  { kind: 'draft_kind', code: 'review', name: '复盘确认', sortOrder: 40, config: {} },
  { kind: 'draft_kind', code: 'daily_plan', name: '今日计划', sortOrder: 50, config: {} },
  { kind: 'draft_kind', code: 'report', name: '日报/周报', sortOrder: 60, config: {} },
  { kind: 'draft_kind', code: 'knowledge', name: '知识条目', sortOrder: 70, config: {} },
  { kind: 'draft_kind', code: 'idea_cluster', name: '点子王提案', sortOrder: 80, config: {} },
  { kind: 'draft_kind', code: 'idea_tasks', name: '点子落地任务', sortOrder: 90, config: {} },
  { kind: 'draft_kind', code: 'expert', name: '专家安装草稿', sortOrder: 100, config: {} },

  // 知识库分类
  // ⚠️ 颜色是**字典数据**（用户可在「设置 → 字典管理」里改），不是 UI 里的硬编码调色板。
  // 出厂值由 palette.ts 注入且必须有值：第一版留空 `{}`，于是知识库的 Tab 圆点 / 行前缀点
  // / 类型徽标全落到同一个灰色兜底 —— 用户看到的就是「设计稿有颜色、装盘后没有」。
  { kind: 'knowledge_kind', code: 'note', name: '笔记', sortOrder: 10, config: {} },
  { kind: 'knowledge_kind', code: 'lesson', name: '经验教训', sortOrder: 20, config: {} },
  { kind: 'knowledge_kind', code: 'decision', name: '决策记录', sortOrder: 30, config: {} },
  { kind: 'knowledge_kind', code: 'snippet', name: '片段/模板', sortOrder: 40, config: {} },

  // 点子类型（同样必须有 color：卡片瀑布的左侧色条与类型徽标都取它）
  { kind: 'idea_kind', code: 'project', name: '项目点子', sortOrder: 10, config: {} },
  { kind: 'idea_kind', code: 'skill', name: '技能点子', sortOrder: 20, config: {} },
  { kind: 'idea_kind', code: 'plugin', name: '插件点子', sortOrder: 30, config: {} },
  { kind: 'idea_kind', code: 'spark', name: '突发奇想', sortOrder: 40, config: {} },
  { kind: 'idea_kind', code: 'random', name: '莫名其妙的点子', sortOrder: 50, config: {} },

  // 重复规则
  { kind: 'recurrence', code: 'none', name: '不重复', sortOrder: 10, config: {} },
  { kind: 'recurrence', code: 'daily', name: '每天', sortOrder: 20, config: {} },
  { kind: 'recurrence', code: 'weekly', name: '每周', sortOrder: 30, config: {} },
  { kind: 'recurrence', code: 'monthly', name: '每月', sortOrder: 40, config: {} },

  // V2 复用型 AI 会话范围
  { kind: 'ai_session_scope', code: 'daily_plan', name: '今日计划会话', sortOrder: 10, config: {} },
  { kind: 'ai_session_scope', code: 'day_report', name: '日报会话', sortOrder: 20, config: {} },
  { kind: 'ai_session_scope', code: 'week_report', name: '周报会话', sortOrder: 30, config: {} },
  { kind: 'ai_session_scope', code: 'idea_association', name: '点子关联会话', sortOrder: 40, config: {} },
  { kind: 'ai_session_scope', code: 'idea_brainstorm', name: '点子头脑风暴会话', sortOrder: 50, config: {} },
  { kind: 'ai_session_scope', code: 'expert_generation', name: '专家生成会话', sortOrder: 60, config: {} },
  { kind: 'draft_status', code: 'pending', name: '待确认', sortOrder: 10, config: {} },
  { kind: 'draft_status', code: 'confirmed', name: '已确认', sortOrder: 20, config: {} },
  { kind: 'draft_status', code: 'abandoned', name: '已放弃', sortOrder: 30, config: {} },
  { kind: 'reminder_method', code: 'browser', name: '浏览器通知', sortOrder: 10, config: {} },
  { kind: 'reminder_method', code: 'os', name: '系统通知', sortOrder: 20, config: { allowedV1: false } },
]

/**
 * 出厂字典 = 原始表 + 从 `palette.ts` 注入的颜色。
 *
 * 注入而不是抄在每一行：颜色只有一个来源，`LEGACY_COLOR_REWRITES`（迁移 v35）
 * 才能和出厂值保持一致 —— 否则"种子写 A、迁移认 B"又是一处静默漂移。
 */
export const DICTIONARY_SEEDS: DictionarySeed[] = RAW_SEEDS.map((seed) => {
  const color = DICTIONARY_DEFAULT_COLORS[seed.kind]?.[seed.code]
  return color === undefined ? seed : { ...seed, config: { ...seed.config, color } }
})

export function seedDictionaries(db: DatabaseSync, now: string = new Date().toISOString()): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO dictionaries
      (kind, code, name, config, builtin, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
  `)
  db.exec('BEGIN')
  try {
    for (const seed of DICTIONARY_SEEDS) {
      insert.run(seed.kind, seed.code, seed.name, JSON.stringify(seed.config), seed.sortOrder, now, now)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
