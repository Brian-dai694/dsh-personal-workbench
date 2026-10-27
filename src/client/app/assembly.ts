/**
 * D17 / P7-2：装配层交给四段 JSX 的**那一束东西**。
 *
 * 为什么是大对象而不是逐个 props：这四段是"同一份装配结果的不同位置"（顶栏、提示层、
 * 主体、弹窗），逐个传会得到四份几乎重复的 40+ 字段清单，任一处漏传都只在运行期露头；
 * 而设计 §4 的边界（"同一语义只有一个所有者"）约束的是**状态**，不是"读"。
 * 所以：域的**结果**整束注入，每个组件只解构自己真正用到的那几个字段 ——
 * 组件文件头那段 `const { … } = props.xxx` 就是它的真实依赖声明（也是审查入口）。
 *
 * 刻意不做的事：不引入 Context、不做全局 store、不把域 hook 的返回值拆成 setter 传下去
 *（视图拿意图不拿 setter，设计 §5）。
 */
import type { DayPanelProps } from '../components/DayPanel.js'
import type { useDayWorkspace } from '../hooks/useDayWorkspace.js'
import type { useIdeas } from '../hooks/useIdeas.js'
import type { useKnowledge } from '../hooks/useKnowledge.js'
import type { useAmazonDatasets } from '../hooks/useAmazonDatasets.js'
import type { useAbaKeywordSets } from '../hooks/useAbaKeywordSets.js'
import type { useAdReportDatasets } from '../hooks/useAdReportDatasets.js'
import type { useTaskData } from '../hooks/useTaskData.js'
import type { useTaskDetailModel } from '../hooks/useTaskDetailModel.js'
import type { useTaskForms } from '../hooks/useTaskForms.js'
import type { useTaskListModel } from '../hooks/useTaskListModel.js'
import type { useWorkbenchAISessions } from '../hooks/useWorkbenchAISessions.js'
import type { useWorkbenchBusy } from '../hooks/useWorkbenchBusy.js'
import type { useWorkbenchDirectoryPicker } from '../hooks/useWorkbenchDirectoryPicker.js'
import type { useWorkbenchDrafts } from '../hooks/useWorkbenchDrafts.js'
import type { useWorkbenchFeedback } from '../hooks/useWorkbenchFeedback.js'
import type { useWorkbenchExperts } from '../hooks/useWorkbenchExperts.js'
import type { useWorkbenchNavigation } from '../hooks/useWorkbenchNavigation.js'
import type { useOplogDayIndex } from '../hooks/useOplogDayIndex.js'
import type { useKeywordPlans } from '../hooks/useKeywordPlans.js'
import type { useCalculatorScenarios } from '../hooks/useCalculatorScenarios.js'
import type { useWorkbenchQuickIntake } from '../hooks/useWorkbenchQuickIntake.js'
import type { useWorkbenchReminders } from '../hooks/useWorkbenchReminders.js'
import type { useWorkbenchSettings } from '../hooks/useWorkbenchSettings.js'
import type { DshSessionListState, DshSessionSummary, Task, WorkbenchRuntime } from '../viewTypes.js'
import type { workspaceCandidates } from '../workspacePicker.js'

export interface WorkbenchAssembly {
  /** 导航域（D17/P6-1）。 */
  nav: ReturnType<typeof useWorkbenchNavigation>
  /** 任务数据域（D17/P3-4）。 */
  data: ReturnType<typeof useTaskData>
  /** 任务表单域（D17/P3-3）。 */
  forms: ReturnType<typeof useTaskForms>
  /** 任务详情域（D17/P3-2）。 */
  detail: ReturnType<typeof useTaskDetailModel>
  /** 任务列表域（D17/P3-1）。 */
  taskList: ReturnType<typeof useTaskListModel>
  /** 日期域（D17/P4）。 */
  day: ReturnType<typeof useDayWorkspace>
  /** 快速录入域（D17/P6-2）。 */
  quick: ReturnType<typeof useWorkbenchQuickIntake>
  /** AI 会话域（D17/P6-3）。 */
  ai: ReturnType<typeof useWorkbenchAISessions>
  /** 设置域（D17/P5-1）。 */
  prefs: ReturnType<typeof useWorkbenchSettings>
  /** 目录选择域（D17/P6-4）。 */
  dir: ReturnType<typeof useWorkbenchDirectoryPicker>
  /** 界面忙碌标志（D17/P6-1）。 */
  busyApi: ReturnType<typeof useWorkbenchBusy>
  /** 提醒域（D17/P5-2）。 */
  remindersApi: ReturnType<typeof useWorkbenchReminders>
  /** 草稿域（D17/P5-3）。 */
  draftsApi: ReturnType<typeof useWorkbenchDrafts>
  /**
   * 运营日志 × 日历：每天有几条日志的索引。
   *
   * 日历只画点、不拉正文，所以这里下发的是一份极小的「日期 → 条数」索引；
   * 日志页写完之后调它的 `refresh()`，日历不会显示过期标记。
   */
  oplogIndex: ReturnType<typeof useOplogDayIndex>
  /**
   * 关键词库：已保存方案的唯一状态所有者。
   *
   * 关键词**生成**是纯函数（`buildKeywordPlan`）留在视图里；这里只管持久化，
   * 所以视图拿到的是"库"和五个意图，不是第二套生成逻辑。
   */
  keywordPlans: ReturnType<typeof useKeywordPlans>
  /** 测算方案库：已保存方案与对比选择的唯一所有者（数学仍在 amazonCalculator）。 */
  calculatorScenarios: ReturnType<typeof useCalculatorScenarios>
  /** 知识域（D17/P1）。 */
  knowledge: ReturnType<typeof useKnowledge>
  /**
   * Amazon 数据集域（v1.18）：搜索词报表的导入 / 读取 / AI 建议回显。
   *
   * 为什么整束下发：视图不许发 HTTP（D17 结构硬门），而这份数据同时被
   * 「搜索词」面板与"带入 AI 协助"的提示词使用 —— 两处必须读**同一个** current，
   * 否则出现"表里有 12 行、AI 提示词里 3 行"这类不可核对的状态。
   */
  amazonData: ReturnType<typeof useAmazonDatasets>
  /**
   * ABA 词表域（T3）：已保存词表的列表 / 当前 / 保存 / 打开 / 导出 / 删除。
   *
   * 为什么提到装配层：关键词页的 ABA 面板原先自己在视图里发 7 条请求（D17 硬门）。
   * 提到这里后，切视图不会把它重置成"刚导入"的状态（与其他域常量同一条纪律）。
   */
  abaKeywordSets: ReturnType<typeof useAbaKeywordSets>
  /**
   * 广告报表域（T3）：**非搜索词**类型（投放/活动/广告位/预算/份额）。
   *
   * 搜索词一路不在这里 —— 它读 `amazonData`，三页共用同一个 current。
   * 类型上已排除 `search_term`，因此不存在覆盖共享 current 的路径。
   */
  adReportData: ReturnType<typeof useAdReportDatasets>
  /** 点子域（D17/P2）。 */
  ideas: ReturnType<typeof useIdeas>
  /** 反馈域（D17/P5-1）：toast 宿主与三个写口。 */
  feedback: ReturnType<typeof useWorkbenchFeedback>
  /**
   * 专家域（P8）：目录 / 生成入口 / 自主召唤开关 / 专家草稿动作的**唯一所有者**。
   *
   * 为什么整束下发：角色库界面（`SettingsModal` → `PersonaAdmin`）与草稿横幅
   * （`DraftBanner` 的专家分支）都要用同一份 catalog；若各自再拉一份，
   * 就会出现"刚安装完专家，一个界面看得到、另一个看不到"（§12.3 明令禁止重复 catalog state）。
   */
  experts: ReturnType<typeof useWorkbenchExperts>

  /* ---- 宿主与模块级助手（刻意留在入口的模块作用域，以注入形式下发，避免成环） ---- */
  runtime: WorkbenchRuntime
  closePanel: () => void
  loadModelModalityTable: () => Promise<ReadonlyMap<string, readonly string[] | null>>
  aiSessionUsable: (runtime: WorkbenchRuntime, sessionId: string) => boolean

  /* ---- 装配层本地值：跨域组合算出来的，不属任何域 ---- */
  collapseAll: () => void
  dayPanelProps: Omit<DayPanelProps, 'emptyPlanAction'>
  now: Date
  pendingCount: number
  linkedSessionIds: Set<string>
  sessionCandidates: DshSessionSummary[]
  sessionListSnapshot: DshSessionListState
  reparentCandidates: Array<{ id: string; title: string; depth: number }>
  workspaceChoices: ReturnType<typeof workspaceCandidates>
  openTask: (task: Task) => void
  openTaskById: (taskId: string) => void
  linkExistingSession: (sessionId: string) => Promise<void>
  saveDailyCapacity: () => Promise<void>
  saveEditDraft: () => Promise<void>
  openQuickEntry: () => void
  openDirPicker: (target: 'quick' | 'form' | 'edit') => void
  applyWorkspaceDir: (dirPath: string) => void
}
