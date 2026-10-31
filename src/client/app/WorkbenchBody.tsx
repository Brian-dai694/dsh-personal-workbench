/**
 * D17 / P7-2：`WorkbenchApp` 的**主体** JSX（搬迁前 index.tsx 的第 1003–1182 行）。
 *
 * 逐字搬出 —— 内层行的缩进一个字没改，只把外层标签挪进本文件的 `return`，
 * 所以拼装出来的 DOM 与拆分前逐层一致（弹窗刻意留在原来的位置上，不改层叠顺序）。
 *
 * 依赖以 `WorkbenchAssembly` 整体注入，这里只**解构自己真正用到的那几个** ——
 * 解构名与入口里的局部名逐个一致（不把 `selected` 改写成 `data.selected`，
 * 既有判据锚的就是这些原文）。
 */
import type { WorkbenchAssembly } from './assembly.js'
import { useState } from 'react'
import { SettingsModal } from '../components/SettingsModal.js'
import { startOfWeek, localDateString } from '../format.js'
import { readNotificationCtor, requestNotificationPermission, sendSystemNotification } from '../notificationCapability.js'
import { AsinView } from '../views/AsinView.js'
import { CalendarView } from '../views/CalendarView.js'
import { IdeasDetailPane } from '../views/IdeasDetailPane.js'
import { IdeasListView } from '../views/IdeasListView.js'
import { KnowledgeDetailPane } from '../views/KnowledgeDetailPane.js'
import { KnowledgeListView } from '../views/KnowledgeListView.js'
import { TaskDetailPane } from '../views/TaskDetailPane.js'
import { TaskListView } from '../views/TaskListView.js'
import { OpsLogView } from '../views/OpsLogView.js'
import { TodayPane } from '../views/TodayPane.js'
import { AmazonToolsView } from '../views/AmazonToolsView.js'
import { AmazonKeywordView } from '../views/AmazonKeywordView.js'
import { AmazonReportView } from '../views/AmazonReportView.js'
import { ProductLibraryView } from '../views/ProductLibraryView.js'
import { InventoryView } from '../views/InventoryView.js'
import { PaymentReconcileView } from '../views/PaymentReconcileView.js'
import { AmazonSopCard } from '../components/AmazonSopCard.js'

export function WorkbenchBody(props: WorkbenchAssembly): JSX.Element {
  /**
   * 日历 → 运营日志的「这一天」跳转意图。
   *
   * 为什么这份状态留在这里：它不属于任何一个域 —— 起因是日历格子上的点击，
   * 消费方是运营日志页，而**同时渲染这两张视图的只有本组件**。塞进日期域会让
   * `useDayWorkspace` 认识运营日志；塞进运营日志页则无法被日历写入。
   * `seq` 是"同一天再点一次也要生效"的版本号（否则第二次点击没有可观察变化）。
   */
  const [oplogFocus, setOplogFocus] = useState<{ date: string; seq: number } | null>(null)
  /**
   * 产品库落地意图（P3 / B3）：从选品页某一行跳过来时带上 `q + site`。
   *
   * 放在装配层而不是产品库内部：产品库是**独立数据域**，它不该知道"我是从哪跳来的"；
   * 装配层负责把"意图"变成道具，产品库只消费。
   */
  const [productFocus, setProductFocus] = useState<{ q: string; site: string } | null>(null)
  const { openSessionInPanel, startAISession } = props.ai.actions
  const { busy } = props.busyApi
  const { bootstrap, childrenOf, dictOf, dicts, linkedOplog, pendingMap, selected, taskKnowledge, tasks } = props.data
  const { archiveSelectedTask, completeTaskFromProgress, createSubtask, patchTask, restoreTask, saveProgress } = props.data.actions
  const { addingPlanTaskId, calMode, capacity, capacityEdit, capacityExpanded, cursor, dayPanel, monthGrid, picked, weekDays } = props.day
  const { addTaskToPlan, moveMonth, moveWeek, setCalMode, setCapacityEdit, setCapacityExpanded, setCursor, setPicked } = props.day.actions
  const { draftProblems } = props.draftsApi
  const { setDraftProblems } = props.draftsApi.actions
  const { pushToast, setError, setNotice } = props.feedback.actions
  const { editDraft, subtaskParent } = props.forms
  const { view } = props.nav
  const { setView } = props.nav.actions
  /**
   * 跳到运营日志的**某一天**：日历格子上的「N 条日志」与任务详情里的「关联日志」共用这一条。
   *
   * 抽成具名函数而不是两处内联：这三句（选中那天 / 递增 seq / 切视图）漏任何一句的表现
   * 都是"点了没反应"，而两处内联迟早只改一处。
   */
  const openOplogDate = (date: string): void => {
    setPicked(new Date(`${date}T00:00:00`))
    setOplogFocus((prev) => ({ date, seq: (prev?.seq ?? 0) + 1 }))
    setView('oplog')
  }
  /**
   * 仪表盘数据（2026-10-27，方案 A）：今日视图上半屏。
   *
   * 全部在这里派生 —— 视图不发 HTTP，也不自己算。三块来源：
   * - 最近完成：从已加载的 `tasks` 里按 `completedAt` 倒序取 4 条（不额外请求）；
   * - 运营日志：`useOplogDayIndex` 已经附带 KPI / 最近几条 / 待归档数；
   * - 亚马逊事实：`amazonData` / `keywordPlans` / `inventory` 三个域现有的结果。
   */
  const recentDone = tasks
    .flatMap((task) => (task.statusCode === 'done' && typeof task.completedAt === 'string' && task.completedAt !== ''
      ? [{ date: localDateString(new Date(task.completedAt)), title: task.title }]
      : []))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4)

  const dashboardProps = {
    pendingArchive: props.oplogIndex.pendingArchive,
    oplog: {
      week: props.oplogIndex.kpi.week,
      month: props.oplogIndex.kpi.month,
      total: props.oplogIndex.kpi.total,
      recent: props.oplogIndex.recent,
    },
    amazon: {
      datasetCount: props.amazonData.datasets.length,
      datasetLatest: typeof props.amazonData.datasets[0]?.createdAt === 'string'
        ? props.amazonData.datasets[0].createdAt.slice(0, 10)
        : null,
      keywordPlanCount: props.keywordPlans.plans.length,
      keywordPlanWords: props.keywordPlans.plans[0]?.rowCount ?? 0,
      keywordPlanNegatives: props.keywordPlans.plans[0]?.negativeCount ?? 0,
      inventoryReady: props.inventory.snapshot !== null,
    },
    recentDone,
  }
  const { dictEditCode, dictError, dictForm, dictKind, recallLog, recallSessionOff, settings, settingsSaving, showSettings } = props.prefs
  const { deleteDictionaryEntry, loadRecallLog, recallSessionRestore, saveDictionaryEntry, saveIncludeOverdue, saveSettings, setDictEditCode, setDictError, setDictForm, setDictKind, setSettings, setShowSettings, toggleDictionaryEntry } = props.prefs.actions
  const { notifyPerm, reminderBusy, reminderChannel, reminderOptions, reminderPolicy } = props.remindersApi
  const { addTaskReminder, loadReminderChannel, resetReminderState, saveReminderPolicy, saveReminderTarget, sendReminderTest, setNotifyPerm, setReminderChannel, setReminderPolicy } = props.remindersApi.actions
  const { aiSessionUsable, dayPanelProps, detail, forms, ideas, knowledge, linkExistingSession, linkedSessionIds, now, openQuickEntry, openTask, openTaskById, runtime, saveDailyCapacity, sessionCandidates, sessionListSnapshot, taskList } = props
  /**
   * 右侧详情区什么时候展开（第五轮收尾）。
   *
   * 第三轮只写了 `view === 'list' && selected === null`，结果**非任务视图全落到 `open`**：
   * 测算 / 关键词 没有自己的详情组件，会走 `TaskDetailPane` 的分支，于是右半屏挂着
   * 「从左侧选择一个任务查看详情」——当前页明明是 Amazon 测算。
   *
   * 现在的判定按"这个视图到底有没有详情内容"来分：
   * - 任务、今日：有选中任务才展开（今日的任务选中来自日期面板）；
   * - 知识库 / 点子：各自有选中项才展开（收起时它们的详情就点不到了，属于功能回归）；
   * - 流量分析：右侧是分析结果区，空态本身有引导文案，保持常显；
   * - 测算 / 关键词：**没有详情内容**，一律收起 —— 这两个正是这轮要修的。
   */
  const detailOpen = ((): boolean => {
    if (view === 'list' || view === 'today') return selected !== null
    if (view === 'knowledge') return knowledge.selected !== null
    if (view === 'ideas') return ideas.selectedIdea !== null || ideas.selectedCluster !== null
    /**
     * `'traffic'` 保留但**不再可达**（2026-10-29 合并进「报表分析 · 搜索词」）。
     * 旧会话里存着的 view 值不该让界面崩，所以这里仍按"有详情区"处理，
     * 但导航里已经没有入口 —— 见 `WorkbenchHeader` 与 `test/trafficRetired.test.mjs`。
     */
    if (view === 'traffic' || view === 'oplog' || view === 'asin') return true
    return false // amazon / keywords / reports：没有详情内容
  })()
  return (
    <div className="wb-body" data-detail={detailOpen ? 'open' : 'collapsed'}>
        {draftProblems.length > 0 && (
          <div className="wb-draft-problems" role="alert">
            <h5>⚠️ 有 {draftProblems.length} 项没能创建（其余已正常入册）</h5>
            {draftProblems.map((p, i) => (
              <div key={i}>
                <b>{p.title === '' ? '(无标题)' : p.title}</b>：{p.reason}
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>（{p.field} = {p.code}）</span>
              </div>
            ))}
            <div style={{ marginTop: 6, color: 'var(--dsw-alias-label-secondary)' }}>
              这些条目<b>没有被创建</b>。请让 AI 用合法 code 重新提交，或在界面上手动补建。
            </div>
            <button className="wb-btn" style={{ marginTop: 6 }} onClick={() => setDraftProblems([])}>知道了，关闭提示</button>
          </div>
        )}
        <div className="wb-nav">
      {showSettings && (
        <SettingsModal
          settings={settings}
          onSettingsChange={setSettings}
          onSaveSettings={saveSettings}
          saving={settingsSaving}
          notifyPermission={notifyPerm}
          /**
           * 请求授权（v1.15.7）：**先判支不支持**再请求。
           *
           * 旧写法直接 `Notification.requestPermission()`，rc.2 上不支持的客户端会抛
           * `TypeError`，而 `.then()` 后面没有 `.catch()` ⇒ 用户点完什么也看不到。
           * 现在失败一定变成一条可读提示（控制台也留痕），不再有"点了没反应的按钮"。
           */
          onRequestNotifyPermission={() => {
            void requestNotificationPermission(readNotificationCtor(globalThis)).then((result) => {
              setNotifyPerm(result.permission)
              if (result.ok) pushToast('桌面通知已开启', 'success')
              else pushToast(`通知授权未成功：${result.reason}`, 'error')
            })
          }}
          /**
           * 发送测试通知（v1.15.7）：失败**必须可观测**。
           *
           * 旧写法 `try { new Notification(…) } catch { ignore }` 把失败吞得干干净净，
           * 用户看到的就是"显示已开启但毫无反应"（本次 P0 的原始描述）。
           * 现在：成功给一条成功提示，失败把**宿主原话**带出来。
           * ⚠️ 成功的措辞只说"已交给浏览器"——系统级是否真的显示，网页侧读不到。
           */
          onSendTestNotification={() => {
            const sent = sendSystemNotification({
              NotificationCtor: readNotificationCtor(globalThis),
              title: 'dsh-personal-workbench 通知测试',
              body: '如果你看到这条系统通知，说明桌面提醒已正常工作。',
            })
            if (sent.ok) {
              pushToast('测试通知已交给浏览器；若没看到，请检查系统的通知/专注助手设置', 'success')
            } else {
              pushToast(`测试通知发送失败：${sent.reason}`, 'error')
            }
          }}
          reminderPolicy={reminderPolicy}
          onReminderPolicyChange={setReminderPolicy}
          onSaveReminderPolicy={saveReminderPolicy}
          reminderChannel={reminderChannel}
          reminderOptions={reminderOptions}
          reminderBusy={reminderBusy}
          onSelectTarget={(botId, targetId) => setReminderChannel((prev) => prev === null ? prev : { ...prev, botId, targetId })}
          onSaveTarget={saveReminderTarget}
          onRefreshChannel={loadReminderChannel}
          onSendTestMessage={sendReminderTest}
          dicts={dicts}
          dictKind={dictKind}
          onDictKindChange={setDictKind}
          dictForm={dictForm}
          onDictFormChange={setDictForm}
          dictEditCode={dictEditCode}
          onDictEditCodeChange={setDictEditCode}
          dictError={dictError}
          onDictErrorChange={setDictError}
          onSaveDictionary={saveDictionaryEntry}
          onToggleDictionary={toggleDictionaryEntry}
          onDeleteDictionary={deleteDictionaryEntry}
          recallLog={recallLog}
          onRefreshRecallLog={() => void loadRecallLog()}
          recallSessionOff={recallSessionOff}
          onRecallSessionOffChange={(sessionId, mode) => void recallSessionRestore(sessionId, mode)}
          /**
           * 专家域（P8）：整束下发（`useWorkbenchExperts` 的结果 + 待确认专家草稿）。
           *
           * 待确认草稿从**草稿域**里筛出来（`allPendingDrafts` 是服务端事实，含被本地
           * 屏蔽的那些）——「设置 → 角色库」里的"待确认草稿"区要看到全部，
           * 而不是"当前弹着的那一份"。这是跨域读取，不新增任何状态。
           */
          experts={props.experts}
          pendingExpertDrafts={props.draftsApi.allPendingDrafts.filter((draft) => draft.kindCode === 'expert')}
          /**
           * 「查看草稿」/「继续修改」都**先收设置弹窗**：
           * 草稿横幅是右下角的非模态浮卡，设置弹窗还在时它要么被挡在后面（同 z-index 时
           * 后渲染的弹窗赢），要么把会话切换挡在弹窗后面 —— 实测点「继续修改」后
           * `dsh.sessions.current` 已经切到生成会话，但用户仍停在设置页，看起来像没反应。
           */
          onOpenExpertDraft={(draft) => {
            setShowSettings(false)
            void props.draftsApi.actions.resumePendingDraft(draft)
          }}
          onEditExpertDraft={(draft) => {
            setShowSettings(false)
            props.draftsApi.actions.dismissDraft(draft)
            props.experts.actions.openGenerationSession(draft)
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
          {view === 'today' && (
            <TodayPane
              stats={bootstrap?.stats}
              capacity={capacity}
              capacityEdit={capacityEdit}
              dailyCapacityMinutes={settings.dailyCapacityMinutes}
              defaultEstimateMinutes={settings.defaultEstimateMinutes}
              includeOverdue={settings.dailyCapacityIncludeOverdue}
              capacityExpanded={capacityExpanded}
              onCapacityEditStart={() => setCapacityEdit(String(settings.dailyCapacityMinutes))}
              onCapacityEditChange={setCapacityEdit}
              onCapacityEditCommit={() => void saveDailyCapacity()}
              onCapacityEditCancel={() => setCapacityEdit(null)}
              onIncludeOverdueChange={(next) => void saveIncludeOverdue(next)}
              onCapacityExpandedChange={setCapacityExpanded}
              onAddToPlan={addTaskToPlan}
              addingTaskId={addingPlanTaskId}
              dayPanelProps={dayPanelProps}
              onQuickEntry={openQuickEntry}
              onNewTask={() => forms.actions.toggleCreate()}
              dashboard={dashboardProps}
              onOpenTasks={() => setView('list')}
              onOpenOplog={() => setView('oplog')}
              onOpenAmazon={() => setView('keywords')}
            />
          )}
          {view === 'calendar' && (
            <CalendarView
              calMode={calMode}
              cursor={cursor}
              now={now}
              picked={picked}
              weekDays={weekDays}
              monthGrid={monthGrid}
              tasks={tasks}
              dayPanelProps={dayPanelProps}
              onMoveWeek={moveWeek}
              onMoveMonth={moveMonth}
              onToday={() => (calMode === 'week' ? setCursor(startOfWeek(now)) : setCursor(new Date(now.getFullYear(), now.getMonth(), 1)))}
              onPick={setPicked}
              onCalModeChange={setCalMode}
              onStartPlanAISession={(d) => void startAISession('plan', null, d)}
              readOnly={dayPanel.readOnly}
              day={dayPanel.day}
              oplogDates={props.oplogIndex.dates}
              onOpenOplogDate={openOplogDate}
            />
          )}

          {view === 'knowledge' && <KnowledgeListView model={knowledge} dictOf={dictOf} busy={busy} />}

          {view === 'ideas' && <IdeasListView model={ideas} dictOf={dictOf} busy={busy} startAISession={startAISession} />}

          {view === 'amazon' && <><AmazonToolsView onSendToAI={(text) => void startAISession('consult', null, text)} scenarios={props.calculatorScenarios} /><AmazonSopCard tool="profit" /></>}

          {view === 'keywords' && <><AmazonKeywordView model={props.keywordPlans} amazon={props.amazonData} aba={props.abaKeywordSets} table={props.univerTable} onSendToAI={(text) => void startAISession('consult', null, text)} onOpenTraffic={(keyword) => { props.amazonData.actions.setCurrentKeyword(keyword.trim() === '' ? null : keyword); setView('reports') }} /><AmazonSopCard tool="keywords" /></>}

          {/**
           * `'traffic'` 已并入「报表分析 · 搜索词」：这里**不再渲染左栏视图**。
           * 保留分支只有一个作用 —— 旧会话恢复时给出可读的去处，而不是空白页。
           */}
          {view === 'traffic' && (
            <div className="wb-empty">
              <div className="wb-empty-title">「流量分析」已并入「报表分析 · 搜索词」</div>
              <div className="wb-empty-desc">同一份数据、同一套结论，现在只有一个入口。</div>
              <button type="button" className="wb-btn primary" style={{ marginTop: 8 }} onClick={() => setView('reports')}>
                去报表分析
              </button>
            </div>
          )}

          {view === 'reports' && <AmazonReportView amazon={props.amazonData} reports={props.adReportData} table={props.univerTable} thresholds={settings.amazonKeywordThresholds} onSendToAI={(text) => void startAISession('consult', null, text)} onOpenKeyword={(keyword) => { props.amazonData.actions.setCurrentKeyword(keyword); setView('keywords') }} />}

          {view === 'inventory' && <InventoryView model={props.inventory} table={props.univerTable} />}

          {view === 'payments' && <PaymentReconcileView table={props.univerTable} />}

          {view === 'oplog' && (
            <OpsLogView
              tasks={tasks}
              onOpenTask={openTaskById}
              onChanged={() => void props.oplogIndex.actions.refresh()}
              focusDate={oplogFocus?.date}
              focusSeq={oplogFocus?.seq ?? 0}
            />
          )}

          {view === 'asin' && (
            <AsinView
              onOpenLibrary={() => setView('products')}
              /**
               * 行内跳转带 `site + asin` 成对落地（B3）。只传 asin 的后果是
               * 同一 ASIN 跨站点两条时落地页搜出两行 —— 看着像定位成功，实际要用户再选一次。
               */
              onOpenProducts={(asin, site) => {
                setProductFocus({ q: asin, site: site ?? '' })
                setView('products')
              }}
            />
          )}

          {view === 'products' && (
            <ProductLibraryView table={props.univerTable} focus={productFocus ?? undefined} />
          )}

          {view === 'list' && <TaskListView model={taskList} dictOf={dictOf} dicts={dicts} selectedId={selected?.task.id} pending={pendingMap} childrenOf={childrenOf} onOpen={openTask} />}
        </div>

        <div className="wb-detail">
          {/**
           * `'traffic'` 不再有自己的右栏：搜索词结论现在长在报表页里
           * （`AmazonReportView` 内嵌 `AmazonTrafficDetailPane`）。
           * 这里不能留分支，否则旧会话恢复时会多出一份"没有左栏的右栏"。
           */}
          {view === 'ideas'
            ? <IdeasDetailPane model={ideas} dictOf={dictOf} busy={busy} startAISession={startAISession} />
            : view === 'knowledge'
            ? <KnowledgeDetailPane model={knowledge} tasks={tasks} dictOf={dictOf} setError={setError} setNotice={setNotice} openTaskById={openTaskById} />
            : (
              <TaskDetailPane
                selected={selected}
                detail={detail}
                dicts={dicts}
                dictOf={dictOf}
                pendingMap={pendingMap}
                settings={settings}
                taskKnowledge={taskKnowledge}
                linkedOplog={linkedOplog}
                onOpenOplogDate={openOplogDate}
                knowledge={knowledge}
                busy={busy}
                editing={editDraft !== null}
                onOpenEdit={forms.actions.openEdit}
                subtaskParent={subtaskParent}
                onAddSubtask={forms.actions.setSubtaskParent}
                onCancelSubtask={() => forms.actions.setSubtaskParent(null)}
                startAISession={startAISession}
                setNotice={setNotice}
                patchTask={patchTask}
                saveProgress={saveProgress}
                completeTaskFromProgress={completeTaskFromProgress}
                archiveSelectedTask={archiveSelectedTask}
                openTask={openTask}
                onRestoreTask={restoreTask}
                onCreateSubtask={createSubtask}
                setView={setView}
                isSessionUsable={(sessionId) => aiSessionUsable(runtime, sessionId)}
                sessionCandidates={sessionCandidates}
                sessionListSnapshot={sessionListSnapshot}
                linkedSessionIds={linkedSessionIds}
                linkExistingSession={linkExistingSession}
                openSessionInPanel={openSessionInPanel}
                addTaskReminder={addTaskReminder}
                resetReminderState={resetReminderState}
              />
            )}
        </div>
    </div>
  )
}
