/**
 * 仓储层门面：**只做 re-export，不放实现**。
 *
 * ## 为什么它必须保持"纯门面"（架构规则 R4）
 *
 * 门面 re-export 28 个领域模块；只要它还定义任何**值**（函数/常量），
 * 需要那个值的子模块就只能回导 `'../repo.js'` —— 于是 `repo.ts ↔ repo/*.ts` 成环。
 * 这类环在 ESM 下能跑，是因为子模块只在函数体里取用；
 * 一旦有人在模块求值期用它，拿到的是 `undefined`，而报错位置与被改文件无关。
 *
 * 2026-10-27：`localDateString` 已挪到 `repo/local-date.ts`，
 * 6 个接口已挪到 `db/types.ts`，17 个子模块改为直连具体模块 —— 环已断。
 * 新增领域模块时请遵守：**本文件不得出现 `function` / `const … =` 实现**，
 * 子模块不得 `import ... from '../repo.js'`。两条例外用测试钉住（R4）。
 *
 * 领域模块清单见下方分组注释；对外 API 与拆分前逐字一致（调用点不必改）。
 */

// ---------------------------------------------------------------------------
// 原语（时间 / 草稿骨架）
// ---------------------------------------------------------------------------
export { nowIso, getDraft, setDraftStatus, withDraftConfirm } from './repo/shared.js'
export type { DraftRow } from './repo/shared.js'

/** 「本地日」的唯一实现在 `repo/local-date.ts`（叶子模块，可被任何子模块直连）。 */
export { localDateString } from './repo/local-date.js'

// ---------------------------------------------------------------------------
// 行 / 输入类型（叶子模块，无运行时依赖）
// ---------------------------------------------------------------------------
export type { DictionaryEntry, DraftInput, TaskInput, TaskPatch, TaskRow, TaskSessionLinkInput } from './types.js'

export { effectiveDueAtForTask, effectiveWorkspacePathForTask, parseTask, appendEvent, isDescendantOf } from './repo/task-primitives.js'
export type { RawTaskRow } from './repo/task-primitives.js'

// 字典域已抽到 repo/dictionaries.ts
export {
  listDictionaries, getDictionary, createDictionaryEntry, updateDictionaryEntry, deleteDictionaryEntry, dictionaryUsageCount,
  listActiveDictionaryCodes,
} from './repo/dictionaries.js'

// 任务域已抽到 repo/tasks.ts
export { createTask, getTask, listChildIds, listTasks, listChildren, taskPriorityCode, updateTask, taskIdProblem, taskStatusIndex } from './repo/tasks.js'
// 「任务已完成」的跨域广播口（2026-10-27 批次 4）：任务域只广播，选品域自己订阅。
export { emitTaskCompleted, onTaskCompleted, taskCompletedHandlerCount } from './repo/task-completion-hooks.js'
export type { TaskCompletedHandler } from './repo/task-completion-hooks.js'

// 状态聚合与级联已抽到 repo/status.ts
export {
  completeTaskCascade, updateTaskWithCompletion, repairParentCompletion,
  archiveTask, restoreTask, listArchivedTasks, countTaskEventsWithNote, listTaskEvents, listTaskEventsInRange,
  createTaskReview, getTaskReviewRecord, listTaskReviews,
} from './repo/status.js'
export type { TaskEventView, TaskReviewInput, TaskReviewRecord } from './repo/status.js'

// 草稿域已抽到 repo/drafts.ts
export {
  createDraft, updateDraft, getDraftBySession, confirmTaskDraft, confirmSubtaskPlanDraft,
  getLatestPendingDraft, getPendingDraftForTask, abandonDraft, toTaskInputFromDraftItem,
  getLatestActiveDraft, listDeferredDrafts, getDeferredDraftForTask, deferDraft, resumeDraft,
  isDeferrableDraftKind, DEFERRABLE_DRAFT_KINDS, NON_DEFERRABLE_DRAFT_KINDS, validateDraftTaskItem,
} from './repo/drafts.js'
export type {
  DraftTaskItem, DraftItemProblem, ConfirmTaskDraftResult, ConfirmSubtaskPlanResult,
} from './repo/drafts.js'

// 任务会话关联已抽到 repo/task-sessions.ts
export { linkTaskSession, listTaskSessions } from './repo/task-sessions.js'

// 任务共享记忆已抽到 repo/task-memory.ts
export { getTaskRootId, getTaskMemory, listTaskMemories, addTaskMemory, getTaskMemoryContext } from './repo/task-memory.js'
export type { TaskMemoryRow } from './repo/task-memory.js'

// 提醒域已抽到 repo/reminders.ts
export {
  listDueReminders, skipStaleReminders, listReminders,
  fireReminder, acknowledgeReminder, resetReminder, skipReminder, addReminder, reminderExists,
} from './repo/reminders.js'
export type { DueReminder, TaskReminderRow } from './repo/reminders.js'

// meta 已抽到 repo/meta.ts
export { readMeta, writeMeta } from './repo/meta.js'

// 提醒队列已抽到 repo/reminder-queue.ts
export {
  REMINDER_QUEUE_LIMIT, enqueueReminder, listDueQueue, listQueue, countQueue, removeQueueEntry, markQueueAttempt, countFiredRemindersSince, listDueRemindersInWindow, getTaskRootIdOrSelf,
} from './repo/reminder-queue.js'
export type { ReminderQueueRow, ReminderQueueInput } from './repo/reminder-queue.js'

// 进度 / 完成验收域已抽到 repo/progress.ts（显式进度唯一写入口 + 验收草稿唯一提交实现）
export {
  setTaskProgress, submitCompletionDraft, listPendingCompletions, getTaskPendingCompletion, readDraft,
} from './repo/progress.js'
export type { SetProgressResult, SubmitCompletionResult, SubmitCompletionOutcome } from './repo/progress.js'

// 每日计划域已抽到 repo/plans.ts（T2/D05–D06：minutes 快照 + effortDone + 原子追加/项级更新）
export {
  getDailyPlan, saveDailyPlan, updateDailyPlan, deleteDailyPlan, confirmDailyPlanDraft, getPendingDailyPlanDraft,
  addDailyPlanItem, updateDailyPlanItem,
} from './repo/plans.js'
export type {
  DailyPlanItem, DailyPlanRow, DailyPlanInput, ManualPlanItemInput, PlanTaskView, AddPlanItemResult, UpdatePlanItemResult,
} from './repo/plans.js'

// 日报 / 周报域已抽到 repo/reports.ts
export {
  saveTaskReport, getTaskReport, listTaskReports, deleteTaskReport, confirmReportDraft, getPendingReportDraft,
} from './repo/reports.js'
export type { ReportPeriodCode, TaskReportInput, TaskReportRow } from './repo/reports.js'

// AI 会话注册表已抽到 repo/ai-sessions.ts
export { getAiSession, registerAiSession } from './repo/ai-sessions.js'
export type { AiSessionRegistryRow } from './repo/ai-sessions.js'

// 重复任务域已抽到 repo/recurring.ts
export { ensureRecurringInstances, RECURRENCE_BACKFILL_LIMIT } from './repo/recurring.js'

// 知识库域已抽到 repo/knowledge.ts；此处再导出保持对外 API 不变
export {
  normalizeFileLink, assertValidFileLink, createKnowledge, getKnowledge, listKnowledge,
  updateKnowledge, deleteKnowledge, deleteKnowledgeWithRefs, confirmKnowledgeDraft, getPendingKnowledgeDraft,
} from './repo/knowledge.js'
export type { KnowledgeInput, KnowledgeRow } from './repo/knowledge.js'

// 点子 / 点子王域已抽到 repo/ideas.ts；此处再导出保持对外 API 不变
export {
  createIdea, getIdea, listIdeas, updateIdea, deleteIdea,
  createIdeaCluster, getIdeaCluster, listIdeaClusters, deleteIdeaCluster, listIdeaClustersForIdea,
  updateIdeaCluster, addIdeaToCluster, removeIdeaFromCluster, listUnfiledIdeas, mergeIdeaClusters,
  confirmIdeaClusterDraft, confirmIdeaTaskDraft, getPendingDraftForSession,
} from './repo/ideas.js'
export type { IdeaInput, IdeaRow, IdeaClusterInput, IdeaClusterRow } from './repo/ideas.js'

// 专家域已抽到 repo/experts.ts（P1：只做设置开关 + expert 草稿的筛选/CAS，
// 装文件、解析人格、校验来源分别属于 experts/*、personas/parse.ts、experts/provenance.ts）
export {
  readExpertSettings, writeExpertSettings,
  getExpertDraft, getPendingExpertDraftForSession, createExpertDraft, updateExpertDraftCas,
  defaultExpertId, ExpertRepoError,
} from './repo/experts.js'
export type {
  CreateExpertDraftInput, CreateExpertDraftResult, ExpertDraftPatch, UpdateExpertDraftCasResult,
  ExpertDraftStatus,
} from './repo/experts.js'

// Amazon 报表数据集域（v1.18）：搜索词报表的导入 / 读取 / AI 建议写回
export {
  AMAZON_DATASET_KINDS, createAmazonDataset, findDuplicateAmazonDataset, getAmazonDataset,
  getLatestAmazonDataset, isAmazonDatasetKind,
  listAmazonDatasets, saveAmazonDatasetSummary, saveSearchTermReview, deleteAmazonDataset,
  setAmazonDatasetUniverFile,
} from './repo/amazonDatasets.js'
export type {
  AmazonDatasetKind, AmazonDatasetRow, AmazonDatasetSummary, AmazonDatasetSummaryPayload,
  CreateAmazonDatasetInput, SearchTermReviewInput,
} from './repo/amazonDatasets.js'

// 运营日志域
export {
  createOplogEntry,
  deleteOplogEntry,
  deleteOplogType,
  getOplogEntry,
  importOplogEntries,
  listOplogTypes,
  listOplogTaskOptions,
  listOplogCompletionCandidates,
  listOplogEntriesByTask,
  listOplogDayIndex,
  oplogKpiCounts,
  setOplogPinned,
  updateOplogEntry,
  upsertOplogType,
  listOplogEntries,
  oplogFacets,
} from './repo/oplog.js'
export type { OplogCompletionCandidate, OplogAssociation, OplogDraft, OplogEntry, OplogFacets, OplogFilter, OplogImportSummary, OplogKpiCounts, OplogTaskOption, OplogDayIndexEntry, OplogType } from './repo/oplog.js'

// ASIN 域
export { AsinConflictError, asinFacets, asinTrend, batchUpdateAsins, createAsinProduct, createAsinStore, deleteAsinStore, findOpenTaskByAsin, getAsinProduct, getAsinStore, getAsinTaskSource, importAsinProducts, importAsinStores, listAllAsinProducts, listAsinJudgments, listAsinProducts, listAsinStoreSummaries, listAsinStores, normalizeAsinCode, setAsinStoreWatch, queryAsinPage, setAsinJudgment, setAsinWatch, trendsFor, updateAsinProduct, updateAsinStore } from './repo/asin.js'
export type { AsinBatchAction, AsinBatchResult, AsinStoreSummary, AsinTaskSource } from './repo/asin.js'
export type { AsinFacets, AsinFilter, AsinImportSummary, AsinJudgment, AsinJudgmentInput, AsinPage, AsinTrendPoint, AsinVerdict } from './repo/asin.js'

// 独立产品库（migration 39）：不读取/写入 asin_products
export {
  DEFAULT_PRODUCT_PAGE_SIZE, MAX_PRODUCT_PAGE_SIZE, ProductConflictError, ProductFieldError,
  createProduct, deleteProduct, getProduct, getProductById, listProducts, productFacets,
  queryProductPage, updateProduct,
} from './repo/products.js'
export type { ProductFacets, ProductFilter, ProductPage, ProductPatch, ProductRecord } from './repo/products.js'

// 库存补货看板（migration 31）：只存盘点输入，结论现算
export { createInventorySnapshot, deleteInventorySnapshot, getInventorySnapshot, getLatestInventorySnapshot, listInventorySnapshots } from './repo/inventory.js'
export type { CreateInventorySnapshotInput, InventorySnapshot, InventorySnapshotSummary } from './repo/inventory.js'

// 关键词计划
export {
  createKeywordPlan, deleteKeywordPlan, getKeywordPlan, listKeywordPlans, updateKeywordPlan,
} from './repo/keywordPlans.js'
export type {
  KeywordMatchCode, KeywordPlan, KeywordPlanInput, KeywordPlanRow, KeywordPlanSummary,
} from './repo/keywordPlans.js'

// 测算场景
export {
  createCalculatorScenario, deleteCalculatorScenario, findCalculatorScenarioByName,
  getCalculatorScenario, listCalculatorScenarios, updateCalculatorScenario,
} from './repo/calculatorScenarios.js'
export type { CalculatorScenario, CalculatorScenarioInput } from './repo/calculatorScenarios.js'

// ABA 词集
export {
  createAbaKeywordSet, deleteAbaKeywordSet, getAbaKeywordSet, listAbaKeywordSets, setAbaAnnotations,
} from './repo/abaKeywordSets.js'
export type { AbaKeywordSet, AbaKeywordSetSummary } from './repo/abaKeywordSets.js'
