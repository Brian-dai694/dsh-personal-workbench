/**
 * dsh-personal-workbench DB schema（对应 docs/DSH个人工作台/01_数据模型.md）
 * 迁移只前向；所有“枚举”都走 dictionaries 表。
 */
import type { DatabaseSync } from 'node:sqlite'
import { LEGACY_COLOR_REWRITES } from '../shared/palette.js'
import { applyAsinIdentityV37, backfillAsinIdentityV37 } from './asinIdentityV37.js'
import { applyOplogAssociationsV38, backfillOplogAssociationsV38 } from './oplogAssociationsV38.js'

export const SCHEMA_VERSION = 39

export interface Migration {
  version: number
  name: string
  up(db: DatabaseSync): void
}

const V1_DDL = `
CREATE TABLE dictionaries (
  kind       TEXT NOT NULL,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  builtin    INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, code)
) STRICT;

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  parent_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  type_code         TEXT NOT NULL,
  status_code       TEXT NOT NULL,
  priority_code     TEXT NOT NULL,
  ai_policy_code    TEXT NOT NULL DEFAULT 'consult',
  due_at            TEXT,
  all_day           INTEGER NOT NULL DEFAULT 0,
  estimated_minutes INTEGER,
  source            TEXT NOT NULL DEFAULT 'manual',
  archived          INTEGER NOT NULL DEFAULT 0,
  extra             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  cancelled_at      TEXT
) STRICT;

CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_due ON tasks(due_at);
CREATE INDEX idx_tasks_status ON tasks(status_code);
CREATE INDEX idx_tasks_type ON tasks(type_code);
CREATE INDEX idx_tasks_priority ON tasks(priority_code);

CREATE TABLE task_reminders (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL,
  method_code    TEXT NOT NULL DEFAULT 'browser',
  enabled        INTEGER NOT NULL DEFAULT 1,
  fired_at       TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_reminders_task ON task_reminders(task_id);

CREATE TABLE task_drafts (
  id           TEXT PRIMARY KEY,
  kind_code    TEXT NOT NULL DEFAULT 'task',
  session_id   TEXT,
  payload_json TEXT NOT NULL,
  status_code  TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_drafts_session ON task_drafts(session_id);
CREATE INDEX idx_task_drafts_status ON task_drafts(status_code);

CREATE TABLE task_sessions (
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,
  role_code        TEXT NOT NULL,
  workspace        TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL,
  last_activity_at TEXT,
  PRIMARY KEY (task_id, session_id, role_code)
) STRICT;

CREATE INDEX idx_task_sessions_session ON task_sessions(session_id);

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_code  TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  actor       TEXT NOT NULL DEFAULT 'user',
  note        TEXT,
  at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_task_events_task ON task_events(task_id, at);

-- V2 预留表：复盘与产出物（先建表，UI 后续接）
CREATE TABLE task_reviews (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id   TEXT,
  summary_md   TEXT NOT NULL,
  lessons_json TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE task_artifacts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id    TEXT,
  kind_code     TEXT NOT NULL,
  title         TEXT NOT NULL,
  path          TEXT NOT NULL,
  category_code TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
) STRICT;
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(V1_DDL)
    },
  },
  {
    version: 2,
    name: 'task-workspace-path',
    up(db) {
      db.exec('ALTER TABLE tasks ADD COLUMN workspace_path TEXT')
    },
  },
  {
    version: 3,
    name: 'daily-plans',
    up(db) {
      db.exec(`
        CREATE TABLE daily_plans (
          id          TEXT PRIMARY KEY,
          plan_date   TEXT NOT NULL UNIQUE,
          summary     TEXT NOT NULL DEFAULT '',
          items_json  TEXT NOT NULL DEFAULT '[]',
          source_code TEXT NOT NULL DEFAULT 'ai',
          session_id  TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        ) STRICT;
      `)
    },
  },
  {
    version: 4,
    name: 'task-reports',
    up(db) {
      db.exec(`
        CREATE TABLE task_reports (
          id           TEXT PRIMARY KEY,
          period_code  TEXT NOT NULL,
          period_start TEXT NOT NULL,
          title        TEXT NOT NULL,
          summary_md   TEXT NOT NULL,
          stats_json   TEXT NOT NULL DEFAULT '{}',
          session_id   TEXT,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          UNIQUE (period_code, period_start)
        ) STRICT;
        CREATE INDEX idx_task_reports_period ON task_reports(period_code, period_start DESC);
      `)
    },
  },
  {
    version: 5,
    name: 'ai-session-registry',
    up(db) {
      db.exec(`
        CREATE TABLE ai_session_registry (
          scope_code       TEXT NOT NULL,
          anchor           TEXT NOT NULL,
          session_id       TEXT NOT NULL,
          workspace        TEXT,
          note             TEXT,
          created_at       TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          PRIMARY KEY (scope_code, anchor)
        ) STRICT;
        CREATE INDEX idx_ai_session_registry_session ON ai_session_registry(session_id);
      `)
    },
  },
  {
    version: 6,
    name: 'recurring-tasks',
    up(db) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN recurrence_code TEXT;
        ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE tasks ADD COLUMN recurrence_master_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
        ALTER TABLE tasks ADD COLUMN recurrence_last_generated TEXT;
        CREATE INDEX idx_tasks_recurrence_master ON tasks(recurrence_master_id);
        CREATE INDEX idx_tasks_recurrence_code ON tasks(recurrence_code);
      `)
    },
  },
  {
    version: 7,
    name: 'knowledge-base',
    up(db) {
      db.exec(`
        CREATE TABLE knowledge_entries (
          id               TEXT PRIMARY KEY,
          kind_code        TEXT NOT NULL DEFAULT 'note',
          title            TEXT NOT NULL,
          content_md       TEXT NOT NULL DEFAULT '',
          tags_json        TEXT NOT NULL DEFAULT '[]',
          source_task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_knowledge_kind ON knowledge_entries(kind_code, updated_at DESC);
        CREATE INDEX idx_knowledge_source ON knowledge_entries(source_task_id);
      `)
    },
  },
  {
    version: 8,
    name: 'ideas-and-clusters',
    up(db) {
      db.exec(`
        CREATE TABLE ideas (
          id               TEXT PRIMARY KEY,
          title            TEXT NOT NULL,
          content_md       TEXT NOT NULL DEFAULT '',
          kind_code        TEXT NOT NULL DEFAULT 'spark',
          tags_json        TEXT NOT NULL DEFAULT '[]',
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_ideas_kind ON ideas(kind_code, updated_at DESC);

        CREATE TABLE idea_clusters (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          summary_md TEXT NOT NULL DEFAULT '',
          tags_json  TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE idea_links (
          cluster_id TEXT NOT NULL REFERENCES idea_clusters(id) ON DELETE CASCADE,
          idea_id    TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
          note       TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (cluster_id, idea_id)
        ) STRICT;
        CREATE INDEX idx_idea_links_idea ON idea_links(idea_id);
      `)
    },
  },
  {
    version: 9,
    name: 'knowledge-source-review',
    up(db) {
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN source_review_id TEXT')
    },
  },
  {
    version: 10,
    name: 'task-shared-memory',
    up(db) {
      db.exec(`
        CREATE TABLE task_memories (
          id               TEXT PRIMARY KEY,
          root_task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind             TEXT NOT NULL DEFAULT 'note',
          content          TEXT NOT NULL,
          source_session_id TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_task_memories_root ON task_memories(root_task_id, updated_at DESC);
        CREATE INDEX idx_task_memories_task ON task_memories(task_id, updated_at DESC);
      `)
    },
  },
  {
    version: 11,
    name: 'knowledge-file-link',
    up(db) {
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN file_link TEXT')
    },
  },
  {
    version: 12,
    name: 'reminder-queue',
    up(db) {
      // 微信提醒的待发队列：host 侧调度器把"暂时发不出去"的提醒落库，重启不丢。
      // 不存 botId/targetId —— 目标在发送时解析，用户换投递目标后旧队列自动跟新目标。
      db.exec(`
        CREATE TABLE reminder_queue (
          id              TEXT PRIMARY KEY,
          reminder_id     TEXT,
          root_task_id    TEXT NOT NULL,
          task_id         TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          priority_code   TEXT NOT NULL,
          due_at          TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error      TEXT,
          created_at      TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_reminder_queue_next ON reminder_queue(next_attempt_at, created_at);
        CREATE INDEX idx_reminder_queue_root ON reminder_queue(root_task_id, created_at DESC);
      `)
    },
  },
  {
    version: 13,
    name: 'draft-defer-and-notify',
    up(db) {
      // 验收「暂存」：草稿仍是 pending（确认/驳回两条老路径不变），
      // 只用一个标记让"自动弹窗"那条查询跳过它 —— 用户可以先去跑回归测试，再手动唤回。
      db.exec('ALTER TABLE task_drafts ADD COLUMN deferred_at TEXT')
      db.exec('ALTER TABLE task_drafts ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0')
      // 草稿通知去重：非空表示该草稿已经进过通知队列，不再重复推送。
      db.exec('ALTER TABLE task_drafts ADD COLUMN notified_at TEXT')
    },
  },
  {
    version: 14,
    name: 'draft-notify-queue',
    up(db) {
      // 草稿通知的待发队列（静默时段/汇总/节流导致的延后投递）。
      // 与 reminder_queue 分开：那边是"任务到期提醒"，字段与幂等键都不同。
      db.exec(`
        CREATE TABLE draft_notify_queue (
          id              TEXT PRIMARY KEY,
          draft_id        TEXT NOT NULL UNIQUE,
          kind_code       TEXT NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          priority_code   TEXT NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error      TEXT,
          created_at      TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_draft_notify_next ON draft_notify_queue(next_attempt_at, created_at);
      `)
    },
  },
  {
    version: 15,
    name: 'reminder-status-semantics',
    up(db) {
      // 拆开原先由 fired_at 一肩挑的三种语义（历史事故：一条提醒永久停在「待处理」）：
      //   fired_at        —— 已送达/已入队（调度器与队列的幂等键，语义不变）
      //   skipped_at      —— 已判定"太旧"而放弃：终态，不再参与 /reminders/due
      //   acknowledged_at —— 用户点了「知道了」：终态，但可重置
      db.exec('ALTER TABLE task_reminders ADD COLUMN skipped_at TEXT')
      db.exec('ALTER TABLE task_reminders ADD COLUMN acknowledged_at TEXT')
    },
  },
  {
    version: 16,
    name: 'kind-colors',
    up(db) {
      /**
       * 给「知识库分类」与「点子类型」回填出厂颜色。
       *
       * 背景：这两类字典的种子原先写的是空 `config: {}`（任务类型/状态/优先级一直有 color），
       * 而知识库的 Tab 圆点、行前缀点、类型徽标，以及点子卡片的左侧色条都取 `config.color`，
       * 取不到就统一落到灰色兜底 —— 用户看到的现象是「设计稿有颜色，装盘后全灰」。
       *
       * 为什么必须用迁移而不是只改种子：种子只在**首次安装**时 INSERT，已存在的库不会被更新，
       * 现存用户（本机就是）改完种子依然是灰的。
       *
       * 只补**没有 color 的**行：用户若已经自己在「字典管理」里配过色，一律保留。
       * 已重命名/停用的行也照补 —— 颜色与名字无关，缺了就补。
       */
      const DEFAULT_COLORS: Record<string, Record<string, string>> = {
        knowledge_kind: { note: '#4F86F7', lesson: '#E7634C', decision: '#8B7BE8', snippet: '#2E9B7B' },
        idea_kind: { project: '#4F86F7', skill: '#2E9B7B', plugin: '#8B7BE8', spark: '#E7634C', random: '#D98E32' },
      }
      const select = db.prepare('SELECT config FROM dictionaries WHERE kind = ? AND code = ?')
      const update = db.prepare('UPDATE dictionaries SET config = ?, updated_at = ? WHERE kind = ? AND code = ?')
      const at = new Date().toISOString()
      for (const [kind, byCode] of Object.entries(DEFAULT_COLORS)) {
        for (const [code, color] of Object.entries(byCode)) {
          const row = select.get(kind, code) as { config: string } | undefined
          if (row === undefined) continue
          let config: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(row.config) as unknown
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) config = parsed as Record<string, unknown>
          } catch {
            // config 不是合法 JSON（手工改过库）→ 当作空对象，只补颜色这一个字段
          }
          if (typeof config.color === 'string' && config.color.trim() !== '') continue
          update.run(JSON.stringify({ ...config, color }), at, kind, code)
        }
      }
    },
  },
  {
    version: 17,
    name: 'knowledge-recall-log',
    up(db) {
      /**
       * 知识库自动召回的**可观测事实源**。
       *
       * 为什么用表而不是只写日志文件：验收要求「会话/日志里能看到检索了哪些关键词、
       * 命中哪几条、是否被引用」，而这三件事要能**按会话、按时间**回看。
       * 文本日志只能人肉翻，界面/端点查不了的证据等于没有。
       *
       * - `trigger_code`：session_start（开工前）/ turn（回合预取）/ tool（模型主动查）
       * - `skipped_reason` 非空 = **没有检索**（与"检索了零命中"区分开，团队记忆的同一条教训）
       * - `cited_ids_json`：模型回报"用到了哪几条"，于是"是否被引用"可判定
       */
      db.exec(`
        CREATE TABLE knowledge_recall_log (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id        TEXT,
          task_id           TEXT,
          trigger_code      TEXT NOT NULL,
          query             TEXT NOT NULL DEFAULT '',
          terms_json        TEXT NOT NULL DEFAULT '[]',
          hits_json         TEXT NOT NULL DEFAULT '[]',
          matched           INTEGER NOT NULL DEFAULT 0,
          dropped_by_score  INTEGER NOT NULL DEFAULT 0,
          dropped_by_limit  INTEGER NOT NULL DEFAULT 0,
          dropped_as_seen   INTEGER NOT NULL DEFAULT 0,
          injected          INTEGER NOT NULL DEFAULT 0,
          skipped_reason    TEXT,
          cited_ids_json    TEXT NOT NULL DEFAULT '[]',
          created_at        TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_knowledge_recall_session ON knowledge_recall_log(session_id, id DESC);
        CREATE INDEX idx_knowledge_recall_created ON knowledge_recall_log(created_at DESC);
      `)
    },
  },
  {
    version: 18,
    name: 'knowledge-supersede',
    up(db) {
      /**
       * 知识条目的**过期 / 被取代**语义（P2）。
       *
       * 实证（用户 2026-09-17）：删掉一条写错的条目、新建一条修正条，两条并存了一段时间，
       * 而"哪条取代了哪条"**只能靠正文里手写一句"本条修正已入库的另一条"**——
       * 召回时两条都会被带出来，模型没有任何结构化的信号判断该信哪条。
       *
       * - `superseded_by_id`：本条已被哪条取代（非空即在召回时**压制**）。
       * - `valid_until`：有效期截止（ISO 时间；到点后同样压制）。
       *
       * 两条都**不改历史行**（只加列、默认 NULL）：老条目行为完全不变，
       * 直到有人显式标注取代关系。
       */
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN superseded_by_id TEXT')
      db.exec('ALTER TABLE knowledge_entries ADD COLUMN valid_until TEXT')
      db.exec('CREATE INDEX idx_knowledge_superseded ON knowledge_entries(superseded_by_id)')
    },
  },
  {
    version: 19,
    name: 'task-progress-and-plan-effort',
    up(db) {
      /**
       * S1：把「任务显式进度」与「每日计划投入」一次性落进数据模型。
       *
       * ## 为什么进度**只允许 0–99**
       *
       * ADR 0003：`100` 不是可存储的进度，而是「提交完成验收申请」的触发值
       * （与 `workbench_request_completion` 同一条路径，弹框/可暂存/可驳回/留痕）。
       * 「已完成」只能由 `tasks.status_code = done` 表达，写入者只能是用户验收通过
       * 或用户在界面点完成。所以 DDL 的 CHECK 是**最后一道防线**，
       * 路由/工具在它之前就给中文错误（不夹取、不静默改成 99）。
       *
       * ## 为什么旧任务进度一律 0，而不从状态/子任务反推
       *
       * ADR 0004：进度是**显式值**，不由子任务比例派生。存量任务从来没有被任何人
       * 显式写过进度，反推出来的数字（比如"3 个子任务完成 2 个 → 67%"）是系统**编**的，
       * 用户既没说过也无法解释。一律置 0 = 「还没人写」，语义最诚实；
       * done 任务也一样（它已有 status 表达完成，不需要一个假进度）。
       *
       * ## 第二个动作：ai_session_scope/persona 字典
       *
       * S11 的角色绑定要复用现有 `ai_session_registry` 表（scope_code + anchor），
       * 需要一个 `persona` 这个 scope 的字典项。**只在这里加一次** ——
       * 后续子任务不得再开同号或第二个迁移（任务描述明确要求）。
       *
       * ## 第三个动作：旧计划 JSON 的兼容回填
       *
       * `daily_plans.items_json` 是老格式（`{taskId, order, title, note}`）。
       * 本迁移按 requirements §2.1 一次性补齐 `minutes`/`effortDone`，
       * **不改计划表结构**（不需要新列）。
       *
       * 三条硬约束（都来自真实教训：静默丢件与静默改写是禁区）：
       * 1. **合法旧项**：缺 `minutes` 就用"迁移当时该任务的合法预计耗时"，取不到用默认
       *    30 分钟快照填上；缺 `effortDone` 填 `false`。已有合法值**不覆盖**。
       * 2. **保留原字段与原顺序**：只做加法，`taskId`/`order`/`title`/`note` 逐字保留；
       *    未知 taskId 的项照样保留（只补 minutes，不定标题）。
       * 3. **坏数据不猜不删**：`items_json` 不是 JSON / 不是数组 / 项不是对象时，
       *    **原串一个字节都不动**，并输出一条带 `planDate` 的诊断（进度链路的
       *    `GET /plans` 与容量读取会据此报「计划数据无法解析」而不是假装 0）。
       */
      db.exec(`ALTER TABLE tasks ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0 CHECK(progress_percent BETWEEN 0 AND 99)`)

      const at = new Date().toISOString()
      db.prepare(
        `INSERT OR IGNORE INTO dictionaries (kind, code, name, config, builtin, active, sort_order, created_at, updated_at)
         VALUES ('ai_session_scope', 'persona', '角色会话', '{}', 1, 1, 60, ?, ?)`,
      ).run(at, at)

      // 计划回填的默认投入：读设置（meta），缺省 30。与 shared/dailyPlanPolicy 的缺省一致。
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'default_estimate_minutes'").get() as { value: string } | undefined
      const parsedDefault = metaRow === undefined ? Number.NaN : Number(metaRow.value)
      const defaultMinutes = Number.isInteger(parsedDefault) && parsedDefault >= 1 && parsedDefault <= 1440 ? parsedDefault : 30

      const estimateStmt = db.prepare('SELECT estimated_minutes FROM tasks WHERE id = ?')
      const plans = db.prepare('SELECT plan_date, items_json FROM daily_plans').all() as unknown as Array<{ plan_date: string; items_json: string }>
      const updatePlan = db.prepare('UPDATE daily_plans SET items_json = ? WHERE plan_date = ?')
      const diagnostics: string[] = []

      for (const plan of plans) {
        let parsed: unknown
        try {
          parsed = JSON.parse(plan.items_json)
        } catch {
          diagnostics.push(`计划 ${plan.plan_date} 的 items_json 不是合法 JSON，已原样保留（读取时会给「计划数据无法解析」诊断）`)
          continue
        }
        if (!Array.isArray(parsed)) {
          diagnostics.push(`计划 ${plan.plan_date} 的 items_json 不是数组，已原样保留（读取时会给「计划数据无法解析」诊断）`)
          continue
        }
        let changed = false
        const items: unknown[] = []
        for (const raw of parsed) {
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            // 坏项：不猜语义、不删除，原样留在数组里（顺序也不动）。
            items.push(raw)
            diagnostics.push(`计划 ${plan.plan_date} 有一项不是对象，已原样保留`)
            continue
          }
          const item = { ...(raw as Record<string, unknown>) }
          if (!Number.isInteger(item.minutes) || (item.minutes as number) < 1 || (item.minutes as number) > 1440) {
            item.minutes = resolveBackfillMinutes(item.taskId, estimateStmt, defaultMinutes)
            changed = true
          }
          if (typeof item.effortDone !== 'boolean') {
            // 已是 true 之外的任何非布尔值都属于"缺字段"：统一填 false（旧数据没有结束语义）。
            item.effortDone = false
            changed = true
          }
          items.push(item)
        }
        if (changed) updatePlan.run(JSON.stringify(items), plan.plan_date)
      }

      /**
       * 诊断**只写日志、不落库**：迁移时刻的观察结果属于运维信息，
       * 而"这份计划读不出来"是**每次读取都要重新判定**的事实（数据可能被人手工修好）。
       * 库里存一份快照会在修复后变成假的告警。
       */
      if (diagnostics.length > 0) {
        for (const line of diagnostics) console.warn(`[dsh-personal-workbench] migration 19: ${line}`)
      }
    },
  },
  {
    version: 20,
    name: 'amazon-datasets',
    up(db) {
      /**
       * Amazon 报表数据集（v1.18）：面板导入的搜索词报表必须**落库**，
       * 否则 AI 工具读不到用户的真实表格，"agent 读写"只是句空话。
       *
       * 三个刻意的取舍：
       * 1. 行数据与建议分开两列（`rows_json` / `annotations_json`）：
       *    重新导入同一份报表不会把 AI 的分析结论连带改掉；
       * 2. **不存派生指标**（CTR/CVR/ACOS 一律现算）：算法一变，旧快照就成了假数据；
       * 3. `kind_code` 现在就带上，ABA/广告日报以后加表不必再改结构。
       */
      db.exec(`
        CREATE TABLE amazon_datasets (
          id               TEXT PRIMARY KEY,
          kind_code        TEXT NOT NULL DEFAULT 'search_term',
          title            TEXT NOT NULL,
          period           TEXT,
          rows_json        TEXT NOT NULL,
          annotations_json TEXT NOT NULL DEFAULT '[]',
          source_code      TEXT NOT NULL DEFAULT 'paste',
          session_id       TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_amazon_datasets_kind ON amazon_datasets(kind_code, created_at DESC);
      `)
    },
  },
  {
    version: 21,
    name: 'oplog-entries',
    up(db) {
      /**
       * 运营日志（2026-10-23 接入第 1 步）：承接旧「亚马逊运营日志 V5」的导出。
       * content 只存**剥掉 HTML 的纯文本**——旧数据是富文本，直接渲染有 XSS 面；
       * ASIN 与附件元信息存 JSON，不存文件字节（体积与备份成本都不值得）。
       */
      db.exec(`CREATE TABLE IF NOT EXISTS oplog_entries (
        id TEXT PRIMARY KEY,
        log_type TEXT NOT NULL,
        title TEXT NOT NULL,
        content_text TEXT NOT NULL DEFAULT '',
        asin_json TEXT NOT NULL DEFAULT '[]',
        documents_json TEXT NOT NULL DEFAULT '[]',
        shop_id TEXT,
        site TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_oplog_created ON oplog_entries(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_oplog_type ON oplog_entries(log_type, created_at DESC);`)
    },
  },
  {
    version: 22,
    name: 'oplog-images',
    up(db) {
      /** 旧日志的正文里内嵌截图（dataURL）。剥 HTML 会把图片一起剥掉，
       *  所以单独存一列：正文只保留 [图片] 占位，图片本体在这里。 */
      db.exec("ALTER TABLE oplog_entries ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'")
    },
  },
  {
    version: 23,
    name: 'oplog-presentation',
    up(db) {
      /** 把旧应用的信息架构搬进来：店铺名、类型颜色、业务日期。
       *  颜色与旧应用同一调色板，日期用于「今天/昨天/本周…」分组。 */
      db.exec('ALTER TABLE oplog_entries ADD COLUMN shop_name TEXT')
      db.exec('ALTER TABLE oplog_entries ADD COLUMN type_color TEXT')
      db.exec('ALTER TABLE oplog_entries ADD COLUMN log_date TEXT')
    },
  },
  {
    version: 24,
    name: 'asin-watchlist',
    up(db) {
      /** 选品收藏（逆向自「亚马逊选品收藏助手 v3.2.10」）：产品库 + 趋势采样。 */
      db.exec(`CREATE TABLE IF NOT EXISTS asin_products (
        asin TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        current_title TEXT, image_url TEXT, url TEXT, price REAL, rating REAL, reviews INTEGER, bsr INTEGER,
        shop_id TEXT, shop_name TEXT, category TEXT, note TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        added_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_asin_added ON asin_products(added_at DESC);
      CREATE INDEX IF NOT EXISTS idx_asin_category ON asin_products(category);
      CREATE TABLE IF NOT EXISTS asin_snapshots (
        id TEXT PRIMARY KEY, asin TEXT NOT NULL, captured_at TEXT NOT NULL,
        price REAL, monthly_sales INTEGER, reviews INTEGER, rating REAL, bsr_major INTEGER, bsr_minor INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_asin_snap ON asin_snapshots(asin, captured_at);`)
    },
  },
  {
    version: 25,
    name: 'oplog-writable',
    up(db) {
      /** 类型字典（旧应用把类型+颜色存在 localStorage，这里落库并给 8 个默认值）。 */
      db.exec(`CREATE TABLE IF NOT EXISTS oplog_types (
        name TEXT PRIMARY KEY,
        color TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0
      ) STRICT`)
      const seed = db.prepare('INSERT OR IGNORE INTO oplog_types (name, color, sort) VALUES (?, ?, ?)')
      ;['Listing', '复盘', '库存', '销售', '广告', '促销', '事件', '其它'].forEach((name, index) => {
        const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8', '#6f42c1', '#fd7e14', '#6c757d']
        seed.run(name, colors[index] ?? '#6c757d', index)
      })
      db.exec('ALTER TABLE oplog_entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    version: 26,
    name: 'asin-v319-fields',
    up(db) {
      /** 对齐 v3.2.19 导出：多站点身份、deal/coupon/BSR/五点等次要字段，以及店铺表。 */
      db.exec('ALTER TABLE asin_products ADD COLUMN site TEXT')
      db.exec("ALTER TABLE asin_products ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'")
      db.exec('ALTER TABLE asin_products ADD COLUMN brand TEXT')
      db.exec('ALTER TABLE asin_products ADD COLUMN seller TEXT')
      db.exec('ALTER TABLE asin_products ADD COLUMN currency TEXT')
      db.exec(`CREATE TABLE IF NOT EXISTS asin_stores (
        id TEXT PRIMARY KEY,
        seller_id TEXT, site TEXT, name TEXT NOT NULL, url TEXT, note TEXT,
        watch INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT,
        products_count INTEGER NOT NULL DEFAULT 0
      ) STRICT`)
    },
  },
  {
    version: 27,
    name: 'asin-list-management',
    up(db) {
      db.exec('ALTER TABLE asin_products ADD COLUMN watch INTEGER NOT NULL DEFAULT 0')
      db.exec('ALTER TABLE asin_products ADD COLUMN manual_order INTEGER')
    },
  },
  {
    version: 28,
    name: 'oplog-task-link',
    up(db) {
      db.exec('ALTER TABLE oplog_entries ADD COLUMN task_id TEXT')
      db.exec('CREATE INDEX IF NOT EXISTS idx_oplog_task ON oplog_entries(task_id)')
    },
  },
  {
    version: 29,
    name: 'keyword-plans',
    /**
     * 关键词库（2026-10-24）：把「关键词规划」从一次性页面变成**可保存、可复用**的词库。
     *
     * 为什么不复用 `amazon_datasets`：那份表存的是**导入的原始报表行**（搜索词+曝光点击花费），
     * 而这里是**我方生成的投放候选**（关键词+匹配方式+活动路由+否定词）。两者生命周期、
     * 条数上限、导出格式都不同，塞进一张表会让"导入源"和"生成结果"混成一个概念。
     *
     * `rows_json` 存生成时的快照：生成规则将来改了，历史方案也不会被悄悄改写
     * （与"计划项速度快照"同一条纪律）。
     */
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS keyword_plans (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        seed TEXT NOT NULL DEFAULT '',
        modifiers_json TEXT NOT NULL DEFAULT '[]',
        match_types_json TEXT NOT NULL DEFAULT '["exact","phrase","broad"]',
        negatives_json TEXT NOT NULL DEFAULT '[]',
        rows_json TEXT NOT NULL DEFAULT '[]',
        asin TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_keyword_plans_updated ON keyword_plans(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_keyword_plans_asin ON keyword_plans(asin);`)
    },
  },
  {
    version: 30,
    name: 'asin-judgment',
    /**
     * 选品库升级为「判断库」（2026-10-24）。
     *
     * 背景：ASIN 表原来只存**事实**（价格/评分/BSR/标签），而判断（能不能做、VOC 痛点、
     * 商标风险、覆盖多少词）跑完技能后只留在会话里 —— 下次要筛"哪些可做"就得翻聊天。
     *
     * 设计取舍：判断结果**整体存一个 JSON**（`judgment_json`），只把
     * 需要**筛选/排序**的两个提成列（`verdict`、`score`）。理由：
     * - 判断字段会随技能演进而增删，一列一迁移不划算；
     * - 但要按结论筛列表，SQL 就得有列，不能全塞 JSON 里。
     *
     * `judged_source` 记来源技能/工具，回答"这条结论是谁给的"，避免人写的与 AI 写的混为一谈。
     */
    up(db) {
      db.exec("ALTER TABLE asin_products ADD COLUMN verdict TEXT NOT NULL DEFAULT 'none'")
      db.exec('ALTER TABLE asin_products ADD COLUMN score REAL')
      db.exec("ALTER TABLE asin_products ADD COLUMN judgment_json TEXT NOT NULL DEFAULT '{}'")
      db.exec('ALTER TABLE asin_products ADD COLUMN judged_at TEXT')
      db.exec('ALTER TABLE asin_products ADD COLUMN judged_source TEXT')
      db.exec('CREATE INDEX IF NOT EXISTS idx_asin_verdict ON asin_products(verdict)')
    },
  },
  {
    version: 31,
    name: 'inventory-snapshots',
    /**
     * 库存补货看板（2026-10-24）：存"一次盘点"的输入，不存算出来的结论。
     *
     * 为什么不存结论：可售天数/断货日依赖**今天**与到货天数，存下来隔天就是错的；
     * 存输入，每次打开按当时参数重算，才不会"看板上的断货日永远是导入那天算的"。
     *
     * `rows_json` 是用户导入的原始行（SKU/期初/到货/销量/在途），
     * 与 `amazon_datasets` 同一条纪律：导入源与生成结果不混在一张表。
     */
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS inventory_snapshots (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        counted_at TEXT NOT NULL,
        window_days INTEGER NOT NULL,
        lead_time_days INTEGER NOT NULL DEFAULT 0,
        safety_days INTEGER NOT NULL DEFAULT 0,
        rows_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_inventory_created ON inventory_snapshots(created_at DESC);`)
    },
  },
    {
    version: 32,
    name: 'calculator-scenarios',
    /**
     * 测算方案（2026-10-24）：把「Amazon 测算」的参数从浏览器 localStorage 搬进库。
     *
     * 为什么必须搬：localStorage 换机器就丢、不进备份、也不属于"工作台的数据"。
     * 而且不做持久化就没法做**多方案对比**（同一款货的三个定价/成本假设排在一起看）。
     *
     * 存的是**完整输入**（`input_json`），不存算出来的结论：结论由
     * `calculateAmazonEconomics` 每次现算 —— 公式改了以后老方案不会继续显示旧结论。
     *
     * `asin` 是弱关联（不做外键）：选品库清理不该连带删掉用户辛苦做的测算。
     */
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS calculator_scenarios (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        note TEXT NOT NULL DEFAULT '',
        asin TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_calc_scenarios_updated ON calculator_scenarios(updated_at DESC);`)
    },
  },

{
    version: 33,
    name: 'aba-keyword-sets',
    /**
     * ABA 词表（2026-10-24 用户要求）：把"表格导入 → 分层/判垄断 → 回填建议"落成数据。
     *
     * 为什么与 `keyword_plans` 分开：那张表存的是**我们生成的投放候选**（可编辑的方案），
     * 这张存的是**市场原始证据**（ABA 导出的排名/搜索量/购买率/点击集中度）。
     * 两者的可信度口径不同（后者是 observed，前者是 derived），混表会让"这是市场数据还是我们的建议"说不清。
     *
     * `annotations_json` 存 DSH/人工的回填（worth / 建议匹配 / 理由 / 证据等级），
     * 读取时覆盖本地规则算出来的结论 —— 规则给基线，回填给结论。
     */
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS aba_keyword_sets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        period TEXT,
        rows_json TEXT NOT NULL DEFAULT '[]',
        annotations_json TEXT NOT NULL DEFAULT '[]',
        source_code TEXT NOT NULL DEFAULT 'import',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_aba_sets_created ON aba_keyword_sets(created_at DESC);`)
    },
  },
  {
    version: 34,
    name: 'amazon-dataset-ai-summary',
    /**
     * 报表级 AI 结论（2026-10-24）：词级建议已有 `annotations_json`，
     * 但"整体 ACOS 多少、否词几条共烧多少钱、最该处理的三个词"这类**报表级**结论
     * 之前只能留在会话里 —— 三页联动时另外两页读不到。
     *
     * 为什么不塞进 `annotations_json`：那里是**词级**建议数组（同一份报表里一个词一条），
     * 混进一个报表级对象会让"每条建议都有 keyword"的前提失效，
     * 现有写回/校验/UI 全部按那个前提写。
     *
     * 为什么整段存 JSON 而不是拆列：结论结构会随分析口径演进（distribution / notes /
     * evidence…），一列一迁移不划算；这份数据只被整体读、整体替换，不做 SQL 筛选。
     *
     * **不迁移数据**：老行是 NULL，读取按 null 处理（"还没做过报表级结论"），
     * 不伪造空结论 —— 空的 totals 会被误读成"报表总额为 0"。
     */
    up(db) {
      db.exec('ALTER TABLE amazon_datasets ADD COLUMN ai_summary TEXT')
    },
  },
  {
    version: 35,
    name: 'dictionary-palette-dsh',
    /**
     * 字典出厂色对齐 DSH 色系（2026-10-28，用户要求「工作台和 dsh 统一一个色系」）。
     *
     * 为什么要迁移而不是只改种子：种子只在**首次装库**时 INSERT OR IGNORE，
     * 已经存在的库（本机就是）改完种子依然是旧色 —— 任务类型圆点还是紫/青混搭。
     * v16 当年就是靠迁移把「知识库/点子类型没有颜色」补上的，这里是同一个道理。
     *
     * 只改**还等于旧出厂值**的行：用户在「设置 → 字典管理」里自己调过的颜色一律保留
     * （判据是精确字符串相等，不做"近似色"匹配 —— 近似匹配会改掉用户的自主选择）。
     *
     * 逐 (kind, code) 匹配而不是全局"旧色 → 新色"表：旧色板里 `#8B7BE8` 同时出现在
     * 知识库「决策记录」（应转琥珀）和点子「插件点子」（应转浅蓝）上，按颜色值映射
     * 必然把其中一个改成错的语义。
     */
    up(db) {
      const select = db.prepare('SELECT config FROM dictionaries WHERE kind = ? AND code = ?')
      const update = db.prepare('UPDATE dictionaries SET config = ?, updated_at = ? WHERE kind = ? AND code = ?')
      const at = new Date().toISOString()
      for (const [kind, byCode] of Object.entries(LEGACY_COLOR_REWRITES)) {
        for (const [code, { from, to }] of Object.entries(byCode)) {
          const row = select.get(kind, code) as { config: string } | undefined
          if (row === undefined) continue
          let config: Record<string, unknown>
          try {
            const parsed = JSON.parse(row.config) as unknown
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
            config = parsed as Record<string, unknown>
          } catch {
            continue // config 不是合法 JSON（手工改过库）→ 不动它，交给「字典管理」修
          }
          if (typeof config.color !== 'string' || config.color !== from) continue
          update.run(JSON.stringify({ ...config, color: to }), at, kind, code)
        }
      }
    },
  },
  {
    version: 36,
    name: 'amazon-dataset-univer-file',
    /**
     * 亚马逊版块重构（2026-10-29）：数据集要记住自己生成过的 `.univer` 表格。
     *
     * ## 为什么是 36 而不是 35
     * v35 已被 `dictionary-palette-dsh`（2026-10-28 的字典配色迁移）占用，且本机真实库
     * 已经迁到 35。把新列塞进 v35 会导致**已迁到 35 的库永远不会重跑**，
     * 列永远加不上，服务端一读 `amazon_datasets` 就炸。
     *
     * ## 为什么只加一列
     * 报表类型**已经存在**（`kind_code`，六种取值，且已有索引
     * `idx_amazon_datasets_kind(kind_code, created_at DESC)`）。再建一个同义的 `kind`
     * 只会让"读哪一列"变成两处判断 —— 直接复用 `kind_code`。
     *
     * ## 老行
     * `univer_file` 为 NULL（= 还没生成过表格），读取按 null 处理，不伪造路径；
     * 不重写任何旧数据。
     */
    up(db) {
      db.exec('ALTER TABLE amazon_datasets ADD COLUMN univer_file TEXT')
    },
  },
  {
    version: 37,
    name: 'asin-identity-shadow',
    /**
     * P1：选品/产品身份影子表（site+ASIN）+ 复核队列。
     *
     * **只增不改**：不碰 `asin_products` / `asin_snapshots` 的列，也不切换读取路径；
     * 未知站点一律进 `migration_review`，**不回填 US**。父子/SKU 只建表、不猜关系。
     *
     * 迁移在事务内执行；回填全部 `INSERT OR IGNORE`，重复执行不会翻倍。
     * 回滚：影子表与复核队列都是新增对象，停用读取开关后可整表删除；v1 数据原样保留。
     */
    up(db) {
      applyAsinIdentityV37(db)
      backfillAsinIdentityV37(db)
    },
  },
  {
    version: 38,
    name: 'oplog-associations',
    /**
     * P4-B：运营日志 0..n 结构化关联。
     *
     * **只增不改**：不碰 `oplog_entries` 任何列，`asin_json` 原样保留；
     * 存量按 `asin_json` 顺序回填，role 一律 `unknown`，站点缺失保持 NULL 并进 `migration_review`。
     * 父子/SKU 不推断；读路径（列表/详情）同时返回 `asins`（旧）与 `associations`（新）。
     *
     * 可重复执行：建表 `IF NOT EXISTS`，回填 `INSERT OR IGNORE`。
     * 回滚：只删这张新表，旧列与旧读路径原样。
     */
    up(db) {
      applyOplogAssociationsV38(db)
      backfillOplogAssociationsV38(db)
    },
  },
  {
    version: 39,
    name: 'products-library',
    /** 独立产品事实表；不回填、不读取、不修改选品库 asin_products。 */
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        asin TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        price REAL,
        shop_name TEXT,
        category TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (site, asin)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_products_site ON products(site);`)
    },
  },
]

/**
 * 迁移回填用的「这条计划项该记多少分钟」。
 *
 * 顺序：任务当前合法预计耗时 → 设置里的默认投入 → 30。
 * 未知 taskId（任务已删除）同样走这个顺序（拿不到估时 → 默认），**不定标题、不丢项**。
 */
function resolveBackfillMinutes(
  taskId: unknown,
  estimateStmt: { get(id: string): unknown },
  defaultMinutes: number,
): number {
  if (typeof taskId === 'string' && taskId !== '') {
    const row = estimateStmt.get(taskId) as { estimated_minutes: number | null } | undefined
    const estimated = row?.estimated_minutes ?? null
    if (typeof estimated === 'number' && Number.isInteger(estimated) && estimated >= 1 && estimated <= 1440) return estimated
  }
  return defaultMinutes
}
