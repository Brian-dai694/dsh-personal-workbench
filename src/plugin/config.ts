/**
 * 插件配置项与目录覆盖口径。
 *
 * `home` 只给测试/多机部署：设了它，数据库、专家库、角色库整体挪到 `<home>/.dsh/workbench`，
 * 测试才能在临时目录里跑完整 `apply()` 而不碰用户真实数据。
 */
import { join } from 'node:path'
import type { WorkbenchDbConfig } from '../db/database.js'

export interface Config extends WorkbenchDbConfig {
  announceToAgent?: boolean
  /**
   * 工作台主目录覆盖（**只给测试/多机部署**）。
   *
   * 设了它，`~/.dsh/workbench` 整体挪到 `<home>/.dsh/workbench`：数据库、专家库、
   * 角色用户库都跟着走 —— 测试因此可以在临时目录里跑完整 `apply()`，
   * **不会读写用户真实的工作台数据**。缺省（undefined）= `homedir()`，生产行为不变。
   */
  home?: string
  /** 提醒调度器扫描间隔（毫秒），缺省 30s；测试可调小 */
  reminderScanIntervalMs?: number
  /** 知识库自动召回：全局缺省开关（不传则读 meta，缺省**开**）。 */
  knowledgeRecallEnabled?: boolean
  /**
   * 知识库自动召回的阈值 —— **原始权重分**口径（缺省 0.34，见 `RECALL_DEFAULTS`）。
   *
   * ⚠️ 这个数字不是界面上看到的"相关度"：展示层做了归一化
   * （`relevance = 原始分 / 0.55`），所以 0.34 对应界面上的 **0.62**。
   * 填之前想清楚用的是哪把尺子（工具参数 `min_score` 用的是归一化口径，两处刻意不同：
   * 配置是调试公式用的，工具参数是给模型看着输出里的数字填的）。
   */
  knowledgeRecallMinScore?: number
  /** 知识库自动召回的单回合条数上限（缺省 3）。 */
  knowledgeRecallMaxEntries?: number
}

/**
 * `config.home` 的覆盖口径（只给测试/多机部署）：把**默认**数据库目录挪到
 * `<home>/.dsh/workbench`。显式 `dataDir`/`dbPath` 仍然优先。
 */
export function workbenchDbConfigFor(config: Config): WorkbenchDbConfig {
  if (typeof config.home !== 'string' || config.home.trim() === '') return config
  return { dataDir: join(config.home, '.dsh', 'workbench'), ...config }
}

/** 角色/专家两套目录的共同覆盖项：生产不传（`{}` ⇒ 宿主目录约定）。 */
export function homeRootOverride(config: Config): { home: string } | Record<string, never> {
  return typeof config.home === 'string' && config.home.trim() !== '' ? { home: config.home } : {}
}
