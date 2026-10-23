/**
 * 工作台界面语言（issue #12）：**纯逻辑**，不 import React、不碰 DOM。
 *
 * ## 为什么用中文原文当 key
 *
 * 现有界面里散落着几千条中文字面量。若先造一套 `header.quickEntry` 之类的语义 key，
 * 就得同时改所有调用点并把「没翻译的字符串」变成「没被发现的英文 key」。
 * 这里换一种迁移方式：**中文原文就是 key**，英文表按需覆盖。
 * - 未翻译 → 原样显示中文（不会出现空白/占位符）；
 * - 要翻译 → 把字面量包进 `t('…')` 并往 `EN_MESSAGES` 加一行；
 * - 参数用 `{name}` 占位，如 `t('共 {n} 条', { n })`。
 *
 * 这与 issue #12 的「string table + t(key,args)」提议兼容，但迁移成本低得多：
 * 一个组件可以先翻译一半，另一半照旧显示中文，不会整块坏掉。
 *
 * ## 语言解析
 *
 * 设置里有三个值：`auto` / `zh-CN` / `en-US`。`auto` 跟随浏览器语言：
 * 以 `zh` 开头 → 中文，否则英文（非中文读者是这次需求的来源）。
 * 解析失败/缺失一律回中文，保持旧行为。
 */

export type UiLocale = 'auto' | 'zh-CN' | 'en-US'
export type ResolvedLocale = 'zh-CN' | 'en-US'

/** 设置下拉的合法值（服务端写入口与客户端都只认这三个）。 */
export const UI_LOCALES: readonly UiLocale[] = ['auto', 'zh-CN', 'en-US']

/** 把一个不可信值归一成合法设置值；不认识 → `auto`。 */
export function normalizeUiLocale(value: unknown): UiLocale {
  return value === 'zh-CN' || value === 'en-US' ? value : 'auto'
}

/** 是否是一个合法的显式语言值（服务端 POST 用）。 */
export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'auto' || value === 'zh-CN' || value === 'en-US'
}

/**
 * 解析成实际语言。
 *
 * @param value 设置里的 `uiLocale`（不可信）
 * @param navigatorLanguage 浏览器语言（`navigator.language`；测试可注入）
 */
export function resolveLocale(value: unknown, navigatorLanguage: unknown = ''): ResolvedLocale {
  const normalized = normalizeUiLocale(value)
  if (normalized !== 'auto') return normalized
  const language = typeof navigatorLanguage === 'string' ? navigatorLanguage.trim().toLowerCase() : ''
  if (language === '') return 'zh-CN'
  return language.startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** Intl / 排序用的 BCP-47 标签（与界面语言一一对应，不另造值）。 */
export function localeTag(locale: ResolvedLocale): string {
  return locale === 'en-US' ? 'en-US' : 'zh-CN'
}

/** 数字格式化：1000 → 1,000（中文/英文都用千分位，但按 locale 走 Intl）。 */
export function formatCount(locale: ResolvedLocale, value: number): string {
  if (!Number.isFinite(value)) return String(value)
  try {
    return new Intl.NumberFormat(localeTag(locale)).format(value)
  } catch {
    return String(value)
  }
}

/** `{name}` 占位替换；缺参数时保留占位符（不静默吞掉，便于发现漏传）。 */
export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (params === undefined) return text
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * 取一条界面文案。
 *
 * @param locale 已解析语言（不会传 auto）
 * @param key 中文原文（也是默认显示值）
 * @param params `{name}` 占位参数
 */
export function translate(locale: ResolvedLocale, key: string, params?: Record<string, string | number>): string {
  const text = locale === 'en-US' ? (EN_MESSAGES[key] ?? key) : key
  return interpolate(text, params)
}

/**
 * 中文→英文表。
 *
 * 只收「顶层 chrome / 设置页 / 角色库 / 专家」这些当前已经包了 `t()` 的字符串；
 * 其余界面仍原样显示中文（见文件头「未翻译 → 原样显示中文」）。
 */
export const EN_MESSAGES: Record<string, string> = {
  // ── 顶栏 / 主导航 ──────────────────────────────────────────────────────────
  '个人工作台': 'Personal Workbench',
  '今日': 'Today',
  '日历': 'Calendar',
  '任务': 'Tasks',
  '知识库': 'Knowledge',
  '点子': 'Ideas',
  '待处理': 'Pending',
  '待你处理的草稿与提醒': 'Drafts and reminders waiting for you',
  '快速录入': 'Capture',
  '新建': 'New',
  '设置': 'Settings',
  '收起全部': 'Collapse',
  '返回对话': 'Back',
  '全部': 'All',
  '其他': 'Other',
  '逾期': 'Overdue',
  '今天到期': 'Due today',
  '进行中': 'In progress',
  '总数': 'Total',
  '已排': 'Planned',
  '可投入': 'Capacity',
  '余': 'Left',
  '紧急': 'Urgent',
  '高': 'High',
  '普通': 'Normal',
  '低': 'Low',
  '空闲': 'Free',
  '点击修改每天可投入时长': 'Click to edit daily capacity',
  '今天没有需要关注的任务': 'Nothing needs attention today',
  '可以快速录入一个新任务，或新建一个待办': 'Capture a task quickly, or create a new one',
  '新建任务': 'New task',
  '没有符合条件的知识条目': 'No matching knowledge entries',
  '今天': 'Today',
  '本周': 'This week',
  '本月': 'This month',
  '近三个月': 'Last 3 months',
  '一年内': 'Within a year',
  '更早': 'Earlier',
  '更新时间': 'Last updated',
  '创建时间': 'Created',
  '搜索标题 / 正文 / 标签': 'Search knowledge',
  '排序键（默认更新时间）': 'Sort key (default: last updated)',
  '当前按「{sort}」{dir}，点击切换': 'Sorted by "{sort}" ({dir}); click to toggle',
  '切换排序方向（当前按{sort}{dir}）': 'Toggle sort direction (currently {sort}, {dir})',
  '降序': 'descending',
  '升序': 'ascending',
  '命中 {n} 条': '{n} hits',
  'AI 总结本地文档': 'Summarize local doc with AI',
  '清空筛选': 'Clear filters',
  '知识库分类': 'Knowledge categories',
  '第 {start}–{end} 条 / 共 {total} 条': 'Showing {start}–{end} of {total}',
  '每页条数': 'Items per page',
  '{n} / 页': '{n} / page',
  '搜索 {n} 个标签': 'Search {n} tags',
  '没有匹配的标签': 'No matching tags',
  '清空已选': 'Clear selected',
  '关闭': 'Close',
  '全部标签': 'All tags',
  '还有 {n} 个标签没显示': '{n} more tags not shown',
  '更多 +{n} ▾': 'More +{n} ▾',
  '还没有知识条目': 'No knowledge entries yet',
  '沉淀经验教训、决策和可复用片段；也可以在 AI 复盘后一键写入': 'Capture lessons, decisions, and reusable snippets; AI reviews can also write them in one click.',
  '新建知识': 'New knowledge',
  '知识条目已更新': 'Knowledge entry updated',
  '知识条目已创建': 'Knowledge entry created',
  '新建知识条目': 'New knowledge entry',
  '编辑知识条目': 'Edit knowledge entry',
  '可检索的标题': 'A searchable title',
  '分类': 'Category',
  '标签': 'Tags',
  '用逗号/空格分隔，如 TTS, 踩坑': 'Separate with commas or spaces, e.g. TTS, pitfalls',
  '本地文件链接（可选）': 'Local file link (optional)',
  'file:// 或绝对路径，如 D:\\docs\\方案.md、/mnt/d/docs/方案.md': 'file:// or an absolute path, e.g. D:\\docs\\plan.md or /mnt/d/docs/plan.md',
  '关联任务 id（可选）': 'Related task id (optional)',
  '留空表示不关联': 'Leave empty for no related task',
  '正文（Markdown）': 'Body (Markdown)',
  '编辑': 'Edit',
  '删除': 'Delete',
  '删除这条知识？': 'Delete this knowledge entry?',
  '已删除': 'Deleted',
  '📎 本地文件：': '📎 Local file:',
  '打开文件': 'Open file',
  '🔗 关联任务：': '🔗 Related task:',
  '← 从左侧选择或新建知识条目': '← Select a knowledge entry on the left, or create one',
  '计划': 'Plan',
  '未排期': 'Unscheduled',
  '已完成': 'Completed',
  '报告': 'Report',
  '规则': 'Rules',
  '收藏': 'Favorites',
  '今日计划 · {date}': "Today's plan · {date}",
  '耗时改完立即影响今日容量的「已排」；留空 = 按默认 {n} 分钟计入。': "Changing the estimate immediately affects today's planned capacity; empty = count the default {n} minutes.",
  '搜索标题 / 描述': 'Search title / description',
  '状态': 'Status',
  '优先级': 'Priority',
  '排序': 'Sort',
  '截止时间': 'Due date',
  '标题': 'Title',
  '当前升序，点击切换为降序': 'Currently ascending; click to switch to descending',
  '当前降序，点击切换为升序': 'Currently descending; click to switch to ascending',
  '↑ 升序': '↑ Asc',
  '↓ 降序': '↓ Desc',
  '共 {n} 条': '{n} tasks',
  '清空': 'Clear',
  '返回任务': 'Back to tasks',
  '查看归档': 'View archive',
  '没有归档任务': 'No archived tasks',
  '还没有任务，点“快速录入”或“新建”开始': 'No tasks yet. Click "Capture" or "New" to start.',
  '没有符合条件的任务，点“清空”恢复完整列表': 'No matching tasks. Click "Clear" to restore the full list.',
  '任务类型': 'Task type',
  '编辑任务': 'Edit task',
  '保存任务': 'Save task',
  '保存': 'Save',
  '要做什么？': 'What needs doing?',
  '类型': 'Type',
  '重复': 'Recurrence',
  'AI 策略': 'AI policy',
  '耗时（分钟）': 'Estimate (minutes)',
  '留空 = 默认 {n} 分钟': 'Leave empty for the default {n} minutes',
  '全天任务': 'All-day task',
  '只影响显示与重复锚点，不改变容量计算': 'Only affects display and recurrence anchoring; does not change capacity math.',
  '留空 = 用默认工作区': 'Leave empty to use the default workspace',
  '默认工作区未设置': 'No default workspace configured',
  '描述': 'Description',
  '背景 / 目标 / 验收标准（Markdown）': 'Background / goal / acceptance criteria (Markdown)',
  '重复：由模板任务管理': 'Recurrence: managed by the template task',
  '留空 = 继承父任务，父任务也没有才用默认': 'Leave empty to inherit from the parent; fall back to the default if the parent has none',
  '描述（Markdown）': 'Description (Markdown)',
  '父任务': 'Parent task',
  '（顶层）': '(Top level)',
  '移动子树：后代跟随一起移动。候选里不列出自身与自身后代（会形成环）；服务端另有独立防环校验，失败会给出可读原因。移动会写入任务详情的「记录」页签。': 'Moving a subtree carries its descendants with it. Candidates never include the task itself or its descendants (which would create a cycle); the server also validates cycles and reports a readable reason. Moves are recorded in the task detail\'s "Record" tab.',
  '手动指定': 'Manually specified',
  '从已打开的工作区 / 最近手动选择 / 默认工作区里选一个；也可以直接在右边输入任意路径': 'Pick an open workspace, a recent manual choice, or the default; you can also type any path on the right.',
  '打开文件夹浏览器，选一个本地目录': 'Open the folder browser and pick a local directory',
  '浏览…': 'Browse…',
  '不再把 {path} 当作默认工作区（下次打开改用设置里的默认值）': 'Stop treating {path} as the default workspace (use the configured default next time)',
  '不再记住': 'Forget',
  '已打开': 'Open',
  '最近': 'Recent',
  '默认': 'Default',
  '（宿主没有已打开的工作区）': '(The host has no open workspaces)',
  '选择已有工作区…': 'Choose an existing workspace…',
  '上次手动选择': 'Last manual choice',
  '使用默认工作区': 'Using the default workspace',
  '未设置（DSH 当前工作区）': 'Not set (DSH current workspace)',
  '会跳转到官方会话区，由 AI 澄清后生成任务草稿': 'Opens the official chat area; the AI clarifies and then creates a task draft.',
  '创建澄清会话': 'Start clarification chat',
  '一句话描述任务': 'Describe the task in one line',
  '一句话描述任务，例如：周五 10:30 接待重要客户；也可以粘贴或拖入图片、PDF、DOCX': 'Describe the task in one line, e.g. Meet an important client at 10:30 on Friday. You can also paste or drag images, PDFs, or DOCX files.',
  '附件': 'Attachments',
  '图片最多 {images} 张 · PDF/DOCX 最多 {documents} 份 · 单份 ≤ 5MB': 'Up to {images} images and {documents} PDF/DOCX files; each ≤ 5 MB',
  '快速录入附件': 'Quick capture attachments',
  '图片': 'Image',
  '（已截断）': ' (truncated)',
  '移除附件': 'Remove attachment',
  '添加附件': 'Add attachment',
  '在该工作区下建任务资料夹（<任务ID>-<标题片段>；不勾 = 直接用它本身）': 'Create a task folder in this workspace (<task ID>-<title fragment>; unchecked = use it directly)',
  '加载 Skill': 'Load skills',
  '正在读取…': 'Loading…',
  '暂不可用': 'Unavailable',
  '已选 {n}': '{n} selected',
  '可选': 'Available',
  '正在读取技能目录…': 'Loading skill catalog…',
  '暂不可用 —— {message}': 'Unavailable — {message}',
  '搜索技能名或描述（共 {n} 个）': 'Search skill name or description ({n} total)',
  '点击移除': 'Click to remove',
  '加载技能目录…': 'Loading skill catalog…',
  '本机暂无可选技能': 'No skills available on this machine',
  '没有匹配的技能': 'No matching skills',
  '（无描述）': '(No description)',
  '选中后会在提示词开头注入"请加载这些技能"的指令，技能正文由 AI 按需加载。': 'Selected skills add a "load these skills" instruction at the start of the prompt; the AI loads the skill body on demand.',
  '当天': 'That day',
  '继续编辑今日计划': "Continue today's plan",
  '继续编辑该日计划': "Continue this day's plan",
  'AI 智能排序': 'AI smart ordering',
  'AI 智能排序（{day}）': 'AI smart ordering ({day})',
  '过去日期只读；如需为今天/未来排期，请选择今天或之后的日期。': 'Past dates are read-only; pick today or a later date to plan.',
  'AI 会先提交顺序提案，确认后才生效': 'The AI submits an ordering proposal first; it takes effect after you confirm.',
  '{date} 计划': 'Plan for {date}',
  '{period}还没有报告。': 'No report for {period} yet.',
  '{day} 没有计划任务': 'No planned tasks on {day}',
  '没有逾期任务': 'No overdue tasks',
  '没有未排期的任务': 'No unscheduled tasks',
  '{day} 没有完成记录': 'No completion records on {day}',

  // ── 设置弹窗：分区与通用 ───────────────────────────────────────────────────
  '工作台设置': 'Workbench settings',
  '通用': 'General',
  '角色库': 'Personas',
  '通知': 'Notifications',
  '知识库召回': 'Knowledge recall',
  '微信提醒': 'WeChat reminders',
  '字典管理': 'Dictionaries',
  '取消': 'Cancel',
  '保存设置': 'Save',
  '保存中…': 'Saving…',
  '设置保存在本机工作台数据库，不影响 DSH 其他配置': 'Settings are stored in the local Workbench database and do not affect other DSH configuration.',
  '语言': 'Language',
  '界面语言': 'UI language',
  '自动（跟随浏览器）': 'Auto (follow browser)',
  '选择工作台界面语言；自动 = 跟随浏览器语言': 'Choose the Workbench UI language. Auto follows the browser language.',
  '外部角色目录': 'External persona directory',
  '可留空；例如 （外部角色目录）': 'Optional; e.g. (external persona directory)',
  '留空 = 只用内置角色库与用户库': 'Leave empty to use only the built-in and user libraries.',
  '使用说明（角色是什么 / 来源优先级 / 停用会怎样）': 'Usage notes (what a persona is / source priority / effect of disabling)',
  '角色 = 一份 .md': 'A persona is a .md file',
  '三级来源，前者优先：': 'Three source levels, earlier wins:',
  '内置 / 外部角色只读': 'Built-in / external personas are read-only',
  '内置 / 外部角色只读：工作台不复制、不修改、不覆盖它们。': 'Built-in / external personas are read-only: the Workbench never copies, modifies, or overwrites them.',
  '新建专家只在用户确认后写入用户库': 'New experts are written to your user library only after you confirm',
  '新建专家只在用户确认后写入用户库：AI 先暂存成草稿，确认前不落盘到用户库。': 'New experts are written to your user library only after you confirm: the AI stages a draft first and does not write to the user library before confirmation.',
  '停用的角色仍会列在这里（否则就启用不回来了），只是不能在选择器中选中。': 'Disabled personas stay listed here (otherwise you could not re-enable them); they just cannot be selected in pickers.',
  '角色正文与资源由 workbench_load_persona / workbench_read_persona_resource 按需读取，不预先塞进提示词。': 'Persona text and resources are loaded on demand by workbench_load_persona / workbench_read_persona_resource and are not preloaded into prompts.',
  '本页的收藏 / 停用与「允许 AI 自主召唤专家」是点一下立刻生效（不等「保存设置」）；上面的外部目录属于设置草稿，要按「保存设置」才生效。': 'Favorites / disabled state and "Let AI summon experts on its own" take effect immediately (no need to save); the external directory above is part of the settings draft and takes effect when you save.',
  'AI 会话工作区': 'AI chat workspace',
  '默认工作区（任务未指定时使用）': 'Default workspace (used when a task has none)',
  '自动为每个任务创建独立文件夹': 'Create a separate folder for each task',
  '关闭后所有任务共用默认工作区；父任务设了工作区时，未单独设置子任务会跟随父任务。': 'When off, all tasks share the default workspace; if a parent task has a workspace, subtasks without one follow the parent.',
  '今日容量': "Today's capacity",
  '默认耗时（任务没填「预计耗时」时按它计入，分钟）': 'Default estimate (minutes) for tasks without one',
  '可设 5–1440；任务自己的耗时优先于它。': "5–1440; a task's own estimate takes priority.",
  '把逾期任务计入今日容量': "Include overdue tasks in today's capacity",
  '默认关闭：逾期是历史欠账，混进"今天要做的事"会让「已排」失去意义。打开后，未完成且截止时间早于今天 0 点的任务也会计入（读数会明显变大）。任务页的「今日容量 → 规则」面板里有同样的开关，两处写同一个设置。': 'Off by default: overdue work is a historical debt; mixing it into "today" makes the plan meaningless. When on, unfinished tasks due before today 00:00 also count (the number will visibly grow). The same switch exists in Today → Capacity → Rules; both write the same setting.',
  '引用块元信息 + 正文），工具按名称逐字使用。': 'quote-block metadata + body), and tools use the name verbatim.',
  '用户库（~/.dsh/workbench/personas）> 外部角色目录 > 内置 15 篇（6 篇通用工作方式 + 9 篇领域岗位）。列表里每行右侧标出它来自哪一级。': 'User library (~/.dsh/workbench/personas) > external persona directory > 15 built-in files (6 general ways of working + 9 domain roles). Each row shows which level it comes from.',
  '（AI 只先暂存成草稿，确认前不落盘）。': ' (the AI only stages a draft; nothing is written before confirmation).',
  '的角色仍会列在下表里（否则启用不回来），只是不能在选择器中选中。': ' personas stay listed below (otherwise you could not re-enable them); they just cannot be selected in pickers.',
  '只影响选择器里的「只看收藏」筛选，不改变角色本身的可用性。': ' only affects the "Favorites only" filter in pickers; it does not change a persona\'s availability.',

  // ── 角色库管理 ────────────────────────────────────────────────────────────
  '新建专家': 'New expert',
  '刷新': 'Refresh',
  '搜索专家名 / 简介 / 分组（共 {n} 个）': 'Search experts by name / description / group ({n} total)',
  '搜索专家（共 {n} 个）': 'Search experts ({n})',
  '全部状态': 'All statuses',
  '可用': 'Available',
  '已停用': 'Disabled',
  '文件有问题': 'File problem',
  '依赖技能不可用': 'Required skill unavailable',
  '安装未完成': 'Installation incomplete',
  '按状态筛选（坏行也会列出来，方便看原因）': 'Filter by status (broken rows stay listed so you can see why)',
  '可用 {available}｜★ 已收藏 {favorites}｜停用 {disabled}': 'Available {available} | ★ Favorites {favorites} | Disabled {disabled}',
  '允许 AI 自主召唤专家（默认关闭）': 'Let AI summon experts on its own (off by default)',
  '关闭时手动 @ 引用专家与 /expert 命令照常可用；打开后 AI 才可能在执行过程中自己挑专家。': 'When off, manual @ expert references and /expert commands still work; when on, the AI may pick an expert during a task.',
  '专家目录读不到 —— {message}': 'Cannot read the expert catalog — {message}',
  '重试': 'Retry',
  '待确认草稿 {n} 份 —— 还没有安装到你的用户库。': '{n} draft(s) awaiting confirmation — not installed in your user library yet.',
  '草稿 {id}': 'Draft {id}',
  '查看草稿': 'View draft',
  '继续修改': 'Continue editing',
  '读取专家目录…': 'Loading expert catalog…',
  '目录为空（内置库没打包进来？）': 'The catalog is empty (is the built-in library missing from the package?)',
  '没有匹配的专家': 'No matching experts',
  '（无简介）': '(No description)',
  '来源与技能': 'Source and skills',
  '没有登记上游来源。': 'No upstream source was recorded.',
  '说明（来源与写入范围 / 停用为何仍列出）': 'Notes (source and write scope / why disabled personas stay listed)',
  '内置角色（无需上游来源）': 'Built-in persona (no upstream source needed)',
  '来源已登记': 'Source recorded',
  '来源未登记（可用，但无法追溯上游）': 'Source not recorded (usable, but not traceable upstream)',
  '来源登记损坏': 'Source record is invalid',
  '来源状态未知': 'Source status unknown',
  '内置': 'Built-in',
  '外部目录': 'External',
  '用户库': 'User library',
  'domain': 'Domain',
  'generic': 'Generic',
  '未知来源': 'Unknown source',
  '（已停用）': ' (disabled)',
  '取消收藏': 'Remove from favorites',
  '收藏（选择器里可用「只看收藏」筛出来）': 'Favorite (filterable with "Favorites only" in pickers)',
  '★ 已收藏': '★ Favorite',
  '☆ 收藏': '☆ Favorite',
  '停用：不再出现在可选列表里（这里仍列出来，可随时启用回来）': 'Disable: remove from selectable lists (still listed here; re-enable anytime)',
  '重新启用': 'Re-enable',
  '停用': 'Disable',
  '启用': 'Enable',
  '待确认的专家草稿': 'Expert draft awaiting confirmation',
  '工作台不复制、不修改、不覆盖它们。': 'the Workbench never copies, modifies, or overwrites them.',
  'AI 先暂存成草稿，确认前不落盘到用户库。': 'the AI stages a draft first and does not write to the user library before confirmation.',
  '停用的角色仍会列在这里': 'Disabled personas stay listed here',
  '（否则就启用不回来了），只是不能在选择器中选中。': ' (otherwise you could not re-enable them); they just cannot be selected in pickers.',
  '角色正文与资源由': 'Persona text and resources are loaded on demand by',
  '按需读取，不预先塞进提示词。': 'and are not preloaded into prompts.',

  // ── 专家草稿预览 ──────────────────────────────────────────────────────────
  '逻辑 ID：{id} · 版本 v{version} · {draft}': 'Logical ID: {id} · Version v{version} · {draft}',
  '用户需求': 'User request',
  '生成方式': 'Generation type',
  '译文（来自上游人格）': 'Translation (from upstream persona)',
  '改编（来自上游人格）': 'Adaptation (from upstream persona)',
  '合并（多个上游来源）': 'Merge (multiple upstream sources)',
  '原创（无上游来源）': 'Original (no upstream source)',
  '未登记生成方式': 'Generation type not recorded',
  '背景引用 {n} 条（未复制原文）': '{n} background reference(s) (source text not copied)',
  '来源': 'Source',
  '没有复制任何上游素材（原创）。': 'No upstream material was copied (original).',
  '有 {n} 条来源拿不到具体提交，无法核对你拿到的是哪一版上游内容。': '{n} source(s) have no specific commit, so you cannot verify which upstream version you got.',
  '许可原文与版权声明会一起保存到人格附件里（不代替许可原文）。': 'License texts and copyright notices are saved with the persona attachments (they do not replace the licenses).',
  '技能': 'Skills',
  '不需要任何 skill。': 'No skills required.',
  '必需': 'Required',
  '可选（非必需）': 'Optional',
  '本次安装': 'Install now',
  '复用已安装': 'Reuse installed',
  '{n} 个文件': '{n} files',
  '安装 {install} 个 · 复用 {reuse} 个': 'Install {install} · Reuse {reuse}',
  '暂存附件 {n} 个': '{n} staged attachment(s)',
  '{required} · {name} · {action}': '{required} · {name} · {action}',
  '校验': 'Validation',
  '校验的是 v{v}（当前 v{current}）· {time}': 'Validated v{v} (current v{current}) · {time}',
  '草稿已改动，需要重新校验': 'The draft changed; validate again',
  '没有错误。': 'No errors.',
  '警告：{items}': 'Warnings: {items}',
  '上次安装失败：{message}': 'Last install failed: {message}',
  '校验中…': 'Validating…',
  '重新校验': 'Validate again',
  '重新校验并重试': 'Validate and retry',
  '确认安装专家': 'Install expert',
  '安装中…': 'Installing…',
  '安装中…（完成后这里会变成已安装）': 'Installing… (this becomes Installed when done)',
  '继续让 AI 修改': 'Continue editing with AI',
  '跟随 DSH 默认模型': 'Follow DSH default model',
  '选择本次 AI 会话使用的模型（快速录入与共享提示词弹窗共用同一份选择）': 'Choose the model for this AI chat (shared by quick capture and the shared-prompt dialog)',
  '选择模型': 'Select model',
  '正在读取模型列表…': 'Loading models…',
  '不支持图片输入': 'Does not support image input',
  '暂无可用模型': 'No models available',
  '{n} 个模型来源读取失败（其余仍可选）': '{n} model source(s) failed to load (others remain selectable)',
  '待确认：新建专家': 'Awaiting confirmation: new expert',
  '放弃这份草稿': 'Discard this draft',
  '放弃': 'Discard',
  '驳回': 'Reject',
  '确认生成点子王': 'Create idea cluster',
  '确认转为任务': 'Convert to tasks',
  '确认入库': 'Save to knowledge',
  '确认保存报告': 'Save report',
  '确认应用排序': 'Apply order',
  '确认写回任务': 'Write back to task',
  '验收通过（标记完成）': 'Accept (mark complete)',
  '确认入册': 'Confirm',
  '回到关联会话': 'Back to related chat',
  '回到头脑风暴会话': 'Back to brainstorm chat',
  '回到会话': 'Back to chat',
  '回到报告会话': 'Back to report chat',
  '回到排序会话': 'Back to planning chat',
  '回到复盘会话': 'Back to review chat',
  '回到执行会话': 'Back to execution chat',
  '回到拆解会话': 'Back to breakdown chat',
  '回到录入会话': 'Back to intake chat',
  '⏸ 暂存': '⏸ Defer',
  '内置/外部角色只读；新建专家仅在你确认后写入用户库。确认按钮会带上你看到的版本与清单哈希。': 'Built-in/external personas are read-only; new experts are written to your user library only after you confirm. The confirm button carries the version and manifest hash you see.',

  // ── 新建专家弹窗 ──────────────────────────────────────────────────────────
  '开始生成': 'Start generating',
  '生成中…': 'Generating…',
  '说明你想要的专家：它负责什么、什么场景用它、有没有必须沿用的上游人格或 skill。AI 会按工作台的方法论生成一份草稿，由你确认后才会安装到你的用户库里。': 'Describe the expert you want: what it owns, when to use it, and any upstream persona or skill it must reuse. The AI generates a draft with the Workbench methodology; it is installed into your user library only after you confirm.',
  '需求': 'Request',
  '工作区': 'Workspace',
  '请选择…': 'Choose…',
  '生成会话开在这个工作区里（与任务资料夹无关，工作台不会替你建目录）。': 'The generation session runs in this workspace (unrelated to task folders; the Workbench will not create a directory for you).',
  '{n}/{max} 字符（服务端上限，超出会被拒）。': '{n}/{max} characters (server limit; longer requests are rejected).',
  '先选一个工作区：生成会话只能开在已有工作区里，工作台不会替你新建目录。': 'Choose a workspace first: the generation session must run in an existing workspace; the Workbench will not create a directory for you.',
  '当前宿主没有提供 sessions.create，无法新开一个独立的生成会话。浏览与使用已有专家不受影响。': 'The current host does not provide sessions.create, so a separate generation session cannot be created. Browsing and using existing experts still works.',
  '这次生成会话已经建出来了（{id}…）。可以打开它继续让 AI 修改；草稿不会被删掉，改完仍会回来找你确认。': 'The generation session has been created ({id}…). Open it to keep editing with the AI; the draft is not deleted and will come back for confirmation.',
  '草稿 id：{id}': 'Draft id: {id}',
  '打开生成会话': 'Open generation session',
  '例如：帮我做一个「接口联调排障」专家，先看设备日志再定位，必须能复用已有的 tcdebug skill。': 'e.g. Build an "API integration troubleshooting" expert that reads device logs first, and must reuse the existing tcdebug skill.',

  // ── 角色选择器 ────────────────────────────────────────────────────────────
  '角色（专家人格）': 'Persona (expert)',
  '搜索角色名 / 简介 / 分组 / 工作模式（共 {n} 个）': 'Search by name / description / group / mode ({n} total)',
  '角色库暂不可用 —— {message}': 'Persona library unavailable — {message}',
  '☆ 只看收藏': '☆ Favorites only',
  '★ 只看收藏': '★ Favorites only',
  '未指定（沿用该会话原有角色）': 'Unspecified (keep this session\'s persona)',
  '复用型会话继续用原来的角色；新会话等于无角色': 'Reused sessions keep their current persona; a new session has none.',
  '无角色': 'No persona',
  '明确不带人格（与"复用会话原有角色"不同：那会新建会话）': 'Explicitly no persona (unlike "keep this session\'s persona", this starts a new session).',
  '读取角色库…': 'Loading personas…',
  '角色库为空（内置库没打包进来？）。不影响本会话继续使用。': 'The persona library is empty (is the built-in library missing from the package?). This session can still continue.',
  '还没有收藏角色 —— 在「设置 → 角色库（专家人格）」里点☆收藏，收藏后这里就能筛出来。': 'No favorite personas yet — open Settings → Personas and click ☆ to favorite one.',
  '没有匹配的角色': 'No matching personas',
  '当前选中的角色不在筛选结果里（改一下搜索或关掉「只看收藏」就能看到它）。': 'The selected persona is not in the filtered results (change the search or turn off Favorites only).',
  '共 {n} 个可用角色（当前显示 {shown} 个；启用 {enabled}{disabledPart}）': '{n} personas available ({shown} shown; {enabled} enabled{disabledPart})',
  '依赖技能缺失的角色不出现在这里（在「设置 → 角色库」里能看到原因）': 'Personas with missing required skills are hidden here (see the reason in Settings → Personas).',
  '收藏与停用在设置里改 · 角色正文由 AI 按需加载，不写进提示词': 'Change favorites and disabled state in Settings · Persona text is loaded on demand by the AI and is not written into prompts.',
  '通用工作方式': 'General ways of working',
  '领域岗位': 'Domain roles',
}
