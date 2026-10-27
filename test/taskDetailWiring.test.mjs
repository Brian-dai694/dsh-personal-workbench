/**
 * D17 / P3-2：任务详情区的接线不变量（源码级扫描）。
 *
 * 为什么用源码扫描：`index.tsx`（4700+ 行、要宿主运行时）没法在 node 里渲染，
 * "详情卡真的接上同一个 `TaskProgress`""空态真的搬进了组件"这类**接线**只能用扫描钉住；
 * 能跑行为的（`taskProgressView` / `taskFilterSort`）另有测试。
 *
 * 判据口径（设计 §8.2）：
 * - 正向断言读**真实 owner**（`views/TaskDetailPane.tsx` / `hooks/useTaskDetailModel.ts`），
 *   实现搬到哪判据就指哪；
 * - 负向唯一性**递归全客户端**（`countInClient`），因为"入口没有第二份"在搬家后会空洞通过。
 *
 * 本批最要紧的两条（设计 §3 的硬规矩）：
 * ① `views/` **不许发 HTTP** —— 详情面板里原先有两处内联 `void api(...)`（恢复任务、新建子任务），
 *    P3-2 把它们提成装配层注入的 `onRestoreTask` / `onCreateSubtask`；
 * ② 详情域状态**只有一个 owner** —— 6 项 `useState` 搬进 `useTaskDetailModel`，
 *    入口不再持有第二份可写副本。
 */
import { test } from 'node:test'
import { entrySurface, readRepo, ENTRY_FILES } from './_entrySources.mjs'
import assert from 'node:assert/strict'
import { read, stripComments, countInClient, assertClientCount } from './_clientSources.mjs'

const indexSource = read('src/client/index.tsx')
const paneSource = read('src/client/views/TaskDetailPane.tsx')
const hookSource = read('src/client/hooks/useTaskDetailModel.ts')
/** D17/P3-3：编辑草稿这一格（连同它的契约类型）已随任务表单域搬进这个 hook。 */
const formsHookSource = read('src/client/hooks/useTaskForms.ts')
/**
 * D17/P6-1：视图联合类型的 `useState` 随**导航域**搬进这个 hook。
 * 断言跟着 owner 走 —— 入口改成负向（"不再持有"），正向指到新 owner（不是放宽）。
 */
const navHookSource = read('src/client/hooks/useWorkbenchNavigation.ts')
/**
 * D17/P7-1：`restoreTask` / `createSubtask` 的请求本体随**任务数据域**归域（`WorkbenchApp`
 * 体内不许再有 `api(` / `fetch(` —— ADR-0008 的结构硬门）。
 */
const taskDataHookSource = read('src/client/hooks/useTaskData.ts')
const contractsSource = read('src/client/app/contracts.ts')
/** D17/P7-2：四段 JSX 搬进 app/ —— 详情面板与三路分派的装配点在 WorkbenchBody。 */
const appBodySource = read('src/client/app/WorkbenchBody.tsx')
const appHeaderSource = read('src/client/app/WorkbenchHeader.tsx')
const amazonToolsSource = read('src/amazon/tools.ts')
/** 测算视图与共享成本模型：面板/DSH 工具同源，出价公式只有一份实现。 */
const amazonToolsViewSource = read('src/client/views/AmazonToolsView.tsx')
const calculatorSource = read('src/shared/amazonCalculator.ts')
const stylesSource = read('src/client/styles.ts')
/** 「带入 AI 协助」的投递路径：consult + 无任务时必须把面板文本写进提示词，否则按钮等于空操作。 */
const aiSessionsSource = read('src/client/hooks/useWorkbenchAISessions.ts')
/** 搜索词「接入表格 + agent 读写」：数据层 / 路由 / 视图 / 装配四处的接线判据。 */
const schemaSource = read('src/db/schema.ts')
const routesSource = read('src/api/routes.ts')
const datasetRoutesSource = read('src/api/routes/amazon-datasets.ts')
const trafficViewSource = read('src/client/views/AmazonTrafficView.tsx')
const trafficDetailSource = read('src/client/views/AmazonTrafficDetailPane.tsx')
/** Excel 导入：解析模块与被 TypeScript 构建清单收录的事实。 */
const xlsxSource = read('src/lib/xlsx.ts')
const buildTsconfigSource = read('tsconfig.build.json')
const amazonDatasetsHookSource = read('src/client/hooks/useAmazonDatasets.ts')
const assemblySource = read('src/client/app/assembly.ts')
/** 服务端入口（工具注册的地方）—— 注意不是 `src/client/index.tsx`。 */
const serverEntrySource = entrySurface()

const DETAIL_STATES = [
  'detailTab', 'sessionPickerOpen', 'sessionPickerRole',
  'sessionPickerQuery', 'sessionPickerBusy', 'eventsExpanded',
]

test('D17/P3-2：详情域 6 项状态的 useState 全客户端只出现一次（唯一所有者）', () => {
  for (const name of DETAIL_STATES) {
    const { hits } = countInClient(new RegExp(`const \\[${name},`, 'g'))
    assert.deepEqual(hits, ['src/client/hooks/useTaskDetailModel.ts×1'],
      `${name} 只许在 useTaskDetailModel 里创建（实际：${hits.join('、') || '无'}）`)
  }
  assert.match(hookSource, /export function useTaskDetailModel\(\): UseTaskDetailModelResult \{/,
    'hook 导出与类型一致')
  assert.match(hookSource, /const \[detailTab, setDetailTab\] = useState<TaskDetailTab>\('desc'\)/,
    '页签初值与拆分前逐字一致')
  assert.match(hookSource, /const \[sessionPickerRole, setSessionPickerRole\] = useState\('consult'\)/,
    '会话角色初值 consult 与拆分前逐字一致')
})

test('D17/P3-2：详情视图是纯展示 —— 不发 HTTP、不持有 state/effect/派生', () => {
  const code = stripComments(paneSource)
  assert.doesNotMatch(code, /\b(api|fetch)\s*[<(]/,
    'views/ 不许发 HTTP（设计 §3）：恢复任务与新建子任务都必须走注入的回调')
  assert.doesNotMatch(code, /\buseState\s*[<(]/, '视图不自建 state')
  assert.doesNotMatch(code, /\buseEffect\s*\(/, '视图不自建 effect')
  assert.doesNotMatch(code, /\buseMemo\s*\(/, '视图不自建派生')
  assert.doesNotMatch(paneSource, /from '\.\.\/index/, '视图不 import 入口')
  // 两处 HTTP 改成注入回调后，请求本体必须在**任务数据域**（唯一一份；D17/P7-1 归域）
  assert.match(taskDataHookSource, /const restoreTask = \(taskId: string\): void => \{\n\s+void api\(`\/api\/workbench\/tasks\/\$\{taskId\}\/restore`, \{ method: 'POST' \}\)/,
    '恢复任务的请求本体在 useTaskData.ts')
  assert.match(taskDataHookSource, /const createSubtask = \(form: FormData, parent: Task\): void => \{/,
    '新建子任务的请求本体在 useTaskData.ts')
  assert.doesNotMatch(indexSource, /const restoreTask = |const createSubtask = /,
    '入口不再各留一份（D17/P7-1：只从 hook 解构使用）')
  assert.match(appBodySource, /onRestoreTask=\{restoreTask\}/,
    '仍把它交给详情面板（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）')
  assert.doesNotMatch(stripComments(indexSource), /onRestoreTask=\{restoreTask\}/,
    '入口不留副本（注释不算）')
  assert.match(code, /onClick=\{\(\) => onRestoreTask\(selected\.task\.id\)\}/, '视图只调注入的回调')
  assert.match(code, /onCreateSubtask\(new FormData\(e\.currentTarget\), subtaskParent\)/,
    '视图只交 FormData 与父任务，payload 拼接在装配层')
})

test('D17/P3-2：入口只保留三路分派，空态与详情 JSX 都归 TaskDetailPane', () => {
  assert.equal((appBodySource.match(/<TaskDetailPane/g) ?? []).length, 1,
    '详情面板装配一处（D17/P7-2 起 owner = src/client/app/WorkbenchBody.tsx）')
  assert.doesNotMatch(stripComments(indexSource), /<TaskDetailPane/, '入口不再有第二处装配')
  assert.match(appBodySource, /: view === 'knowledge'\n\s+\? <KnowledgeDetailPane/,
    '三路分派顺序不变（ideas → knowledge → task）')
  assert.doesNotMatch(indexSource, /: selected === null/,
    '入口不再自己判空态（那是详情面板的第一种形态）')
  assert.doesNotMatch(indexSource, /AI 澄清\/咨询\/拆解会跳转到官方会话区/,
    '空态文案不该在入口留副本')
  assert.match(paneSource, /if \(selected === null\) \{[\s\S]{0,400}?wb-empty[\s\S]{0,400}?AI 澄清\/咨询\/拆解会跳转到官方会话区/,
    '空态逐字搬进组件')
})

test('D17/P3-2：三个语义动作只有一份实现，「两连 setState」不再出现在调用点', () => {
  const resetBody = hookSource.slice(hookSource.indexOf('const resetDetailView'), hookSource.indexOf('const openSessionPicker'))
  const openBody = hookSource.slice(hookSource.indexOf('const openSessionPicker'), hookSource.indexOf('const closeSessionPicker'))
  const closeBody = hookSource.slice(hookSource.indexOf('const closeSessionPicker'), hookSource.indexOf('return {'))
  assert.match(resetBody, /setDetailTab\('desc'\)\n\s+setEventsExpanded\(false\)/,
    'resetDetailView 就是拆分前 openTask / openTaskById 里那两行')
  assert.match(openBody, /setSessionPickerQuery\(''\)\n\s+setSessionPickerOpen\(true\)/)
  assert.match(closeBody, /setSessionPickerOpen\(false\)\n\s+setSessionPickerQuery\(''\)/)
  const entryAndPane = stripComments(indexSource) + stripComments(paneSource)
  assert.doesNotMatch(entryAndPane, /setSessionPickerQuery\(''\); setSessionPickerOpen\(true\)/,
    '「清空 + 展开」两连调用只许在 hook 里')
  assert.doesNotMatch(entryAndPane, /setSessionPickerOpen\(false\); setSessionPickerQuery\(''\)/,
    '「收起 + 清空」两连调用只许在 hook 里')
  // 入口只剩三个动作在用，且都经 detail.actions
  assert.match(indexSource, /const \{ setSessionPickerBusy, resetDetailView, closeSessionPicker \} = detail\.actions/)
  assert.doesNotMatch(stripComments(indexSource), /(?<![\w.])setDetailTab\b/,
    '入口不许再直接摸 setDetailTab（页签复位只能走 resetDetailView）')
})

test('CPC 面板与 DSH 工具使用同一成本字段，运营总览已移除', () => {
  assert.doesNotMatch(contractsSource, /amazon-ops/)
  assert.doesNotMatch(appHeaderSource, /运营总览/)
  assert.doesNotMatch(appBodySource, /AmazonOperationsView/)
  assert.match(amazonToolsSource, /name: 'workbench_cpc_breakeven'/)
  for (const field of ['storage_fee', 'removal_fee', 'promotion_cost', 'calibration_cpc']) {
    assert.match(amazonToolsSource, new RegExp(field))
  }
})

test('测算视图是原生组件：复用工作台分段控件与设计令牌，且出价公式只有一份实现', () => {
  assert.match(amazonToolsViewSource, /className=\{`wb-seg \$\{mode === 'profit'/)
  assert.match(amazonToolsViewSource, /wb-amazon-native-layout/)
  assert.match(amazonToolsViewSource, /带入 AI 协助/)
  assert.doesNotMatch(amazonToolsViewSource, /#[0-9a-fA-F]{6}/, '新视图不许硬编码颜色')
  assert.match(amazonToolsViewSource, /calculateAmazonBid/)
  assert.match(calculatorSource, /export function calculateAmazonBid/)
  assert.match(amazonToolsSource, /calculateAmazonBid\(/)
  assert.match(appBodySource, /<AmazonToolsView onSendToAI=/)
  for (const cls of ['wb-amazon-mode', 'wb-amazon-native-layout', 'wb-amazon-section-title', 'wb-amazon-result-head', 'wb-amazon-result-actions']) {
    assert.match(stylesSource, new RegExp(`\\.${cls} \\{`), `${cls} 必须有样式（否则新视图裸奔）`)
  }
})

/**
 * 2026-10-22 真实事故：面板被放进分栏后只有 ~500px 宽，而窗口 982px。
 * 旧实现用视口媒体查询（max-width:720px）+ 固定 `minmax(320px,…)` 结果列，
 * 于是媒体查询不触发、结果列溢出容器被裁掉（用户截图：右列"有效贡献率"被切）。
 * 判据：响应式必须挂在**容器**上，列宽必须能收进 100%。
 */
test('窄面板按容器宽度重排：容器查询 + 可收缩列，不再依赖视口断点', () => {
  assert.match(stylesSource, /\.wb-amazon-tools \{[^}]*container-type: inline-size/, '测算视图必须是查询容器')
  assert.match(stylesSource, /@container wb-calc \(max-width: 656px\)/)
  assert.match(stylesSource, /\.wb-amazon-native-layout \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(min\(320px, 100%\), 1fr\)\)/)
  assert.match(stylesSource, /\.wb-amazon-native-layout > \* \{ min-width: 0; \}/)
  assert.doesNotMatch(stylesSource, /minmax\(280px, \.85fr\) minmax\(320px, 1\.15fr\)/, '旧的固定双列会把结果列挤出容器')
  assert.doesNotMatch(stylesSource, /wb-amazon-calibration-note[^}]*#[0-9a-fA-F]{6}/, '校准提示不许硬编码颜色')
})

test('搜索词「接入表格 + agent 读写」的接线：落库、双向工具、视图不发 HTTP', () => {
  // 1. 数据集落库：表 + 迁移号 + 路由前缀都在
  assert.match(schemaSource, /version: 20,\s*\n\s*name: 'amazon-datasets'/)
  assert.match(schemaSource, /CREATE TABLE amazon_datasets/)
  assert.match(routesSource, /makeAmazonDatasetRoutes\(db\)/)
  assert.match(datasetRoutesSource, /\/api\/workbench\/amazon\/datasets/)

  // 2. 双向工具：读原始行 + 写回建议，且都注册到 DSH
  assert.match(amazonToolsSource, /name: 'workbench_read_search_terms'/)
  assert.match(amazonToolsSource, /name: 'workbench_save_search_term_review'/)
  assert.match(serverEntrySource, /readSearchTermsTool\(db\), saveSearchTermReviewTool\(db\)/)

  // 3. 视图只拿意图、不发 HTTP（D17 结构硬门）：导入/刷新都走 hook 的 actions
  assert.doesNotMatch(stripComments(trafficViewSource), /\bapi\(|fetch\(/, '搜索词视图不许自己发请求')
  assert.match(trafficViewSource, /model\.actions\.importRows/)
  assert.match(trafficViewSource, /model\.actions\.select/)
  assert.match(trafficViewSource, /import type \{ UseAmazonDatasetsResult \}/)
  assert.match(amazonDatasetsHookSource, /\/api\/workbench\/amazon\/datasets/)

  // 3b. Excel 导入（v1.20）：文件读取在 hook 里，`.xlsx` 走服务端转 TSV，旧版 .xls 给提示
  assert.match(trafficViewSource, /model\.actions\.parseUpload/)
  assert.doesNotMatch(stripComments(trafficViewSource), /\bapi\(|FileReader|fetch\(/, '文件读取与请求都在 hook 里')
  assert.match(amazonDatasetsHookSource, /\/api\/workbench\/amazon\/datasets\/parse-file/)
  assert.match(trafficViewSource, /\.xlsx,\.xls/, '文件选择器要放行 Excel')
  assert.match(datasetRoutesSource, /id === 'parse-file'/)
  assert.match(datasetRoutesSource, /readXlsx\(buffer\)/)
  assert.match(xlsxSource, /export function readXlsx/)
  assert.match(buildTsconfigSource, /"src\/lib\/xlsx\.ts"/, 'xlsx 模块必须进构建清单，否则服务端 import 会 404')

  // 4. 结果在右栏（用户要求）：左栏只做接入，右栏渲染指标表与 AI 建议
  assert.match(appBodySource, /view === 'traffic' && <AmazonTrafficView model=\{props\.amazonData\} \/>/)
  assert.match(appBodySource, /view === 'traffic'\s*\n\s*\? <AmazonTrafficDetailPane model=\{props\.amazonData\}/)
  assert.doesNotMatch(trafficViewSource, /wb-amazon-table-grid/, '左栏不许再渲染结果表')
  assert.match(trafficDetailSource, /wb-amazon-table-grid/)
  assert.match(trafficDetailSource, /summarizeTrafficForAI/)
  assert.doesNotMatch(stripComments(trafficDetailSource), /\bapi\(|fetch\(/, '结果区同样只拿意图，不发请求')
  assert.match(assemblySource, /amazonData: ReturnType<typeof useAmazonDatasets>/)
})

test('「带入 AI 协助」的投递路径把面板文本真的写进提示词（consult 无任务分支）', () => {
  assert.match(aiSessionsSource, /task === null\s*\n?\s*\? `你是“个人工作台”的 Amazon 测算协助助手/)
  assert.match(aiSessionsSource, /\$\{text\}/, '无任务分支必须内联面板传来的测算摘要')
  assert.match(aiSessionsSource, /'协助：Amazon 测算'/, '无任务时不吐出 “协助：undefined”')
})

test('D17/P3-2：两份匿名类型收进 app/contracts.ts，入口不再内联', () => {
  assert.match(contractsSource, /export type WorkbenchView = 'today' \| 'calendar' \| 'list' \| 'knowledge' \| 'ideas' \| 'amazon' \| 'keywords' \| 'traffic'/,
    'WorkbenchView 保留现有面板集合，且不含已移除的运营总览')
  assert.match(contractsSource, /export interface TaskEditDraft \{/)
  for (const field of ['title', 'description', 'typeCode', 'priorityCode', 'statusCode', 'aiPolicyCode',
    'dueLocal', 'workspacePath', 'recurrenceCode', 'parentId', 'estimatedMinutes', 'allDay']) {
    assert.match(contractsSource, new RegExp(`\\b${field}:`), `TaskEditDraft.${field} 必须在契约里`)
  }
  assert.match(navHookSource, /const \[view, setView\] = useState<WorkbenchView>\('today'\)/,
    '视图联合类型由导航域（useWorkbenchNavigation）持有')
  assert.doesNotMatch(stripComments(indexSource), /useState<WorkbenchView>/,
    '入口不再持有视图联合类型的 useState（D17/P6-1 后 owner 是 useWorkbenchNavigation）')
  assert.match(formsHookSource, /useState<TaskEditDraft \| null>\(null\)/, '编辑草稿用契约类型')
  assertClientCount(assert, /useState<'today' \| 'calendar'/g, 0,
    '不再内联视图联合类型（一份定义，不是两份）')
})
