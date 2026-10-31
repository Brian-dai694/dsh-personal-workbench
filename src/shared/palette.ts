/**
 * 字典出厂调色板（2026-10-28：**与 DSH 统一一个色系**）。
 *
 * ## 为什么住在 shared/
 *
 * 这些颜色是**字典数据**（`dictionaries.config.color`），会被写进库、出现在
 * 任务列表类型圆点、Tab 圆点、知识库分类点、点子卡片左侧色条上；
 * 而「设置 → 字典管理」里新增一条字典时，客户端也要给出默认色。
 * 也就是说**服务端与客户端共用同一份取值** —— 架构约束（R5）规定客户端只能
 * import `client/` 与 `shared/`，所以它住在 shared，而不是 db/。
 *
 * 过去它们散落在 `seed.ts`（出厂种子）与 `schema.ts`（v16 回填迁移）两处，
 * 于是"改一版配色"要改两个地方，而且两边很容易不一致。
 *
 * 现在只有这一处：`seed.ts` 用它写出厂值；迁移 v35 用 `LEGACY_COLOR_REWRITES`
 * 把**还停在旧出厂值**的行改到新色系（用户自己改过的颜色一律保留）。
 *
 * ## 取值口径
 *
 * 全部取 DSH 自己的色阶（`--dsw-static-*`，见主题包 dsh-client-ui-theme）：
 * 蓝 `deepseek-500/400/300`、`blue-500`，绿 `green-500/400`，
 * 琥珀 `amber-500/600`，红 `red-500/600`，中性 `neutral-bluish-500/600`。
 * 不引入宿主调色板里没有的色相（原来是紫 #8B7BE8 / 青 #16A085 / 紫 #8E44AD 混用）。
 */

/** DSH 色阶取值（只放本文件需要的几个档）。 */
export const PALETTE = {
  /** 包装 3D 预览专用材质色 */
  boxBackground: '#ffffff',
  boxPaper: '#b68a59',
  boxEdge: '#633f21',
  boxEdgeLight: '#92704b',
  boxFlute: '#d2b58d',
  boxAmbient: '#fffdf8',
  boxGround: '#806447',
  boxKeyLight: '#fff7e9',
  boxFillLight: '#d7e5ff',
  boxText: '#382b1d',
  boxFallback: '#fff',
  /** deepseek-500：品牌主色，与 `--dsw-alias-state-business-primary` 浅色档同值 */
  blue: '#4176e6',
  /** blue-500：同族更亮一档，用于"同一族但不同项" */
  blueBright: '#3b82f6',
  /** deepseek-400：深色主题里品牌色就是它，浅色下当浅蓝用 */
  blueSoft: '#7aaaff',
  /** deepseek-300：最浅一档 */
  bluePale: '#b7c8fe',
  /** green-500：成功色 */
  green: '#22c55e',
  /** green-400 */
  greenSoft: '#4ed17e',
  /** amber-500：警告色 */
  amber: '#f59e0b',
  /** amber-600 */
  amberDeep: '#dd8629',
  /** red-500 */
  red: '#ef4444',
  /** red-600：与 `--dsw-alias-state-error-primary` 浅色档同值 */
  redDeep: '#ec1313',
  /** neutral-bluish-500 */
  neutral: '#979da6',
  /** neutral-bluish-600：字典缺色时的兜底（= --wb-neutral 浅色档） */
  neutralDeep: '#81858c',
} as const

/**
 * 出厂色（按字典类型 → code）。`seed.ts` 首次装库时用这些值。
 *
 * 分组原则：同族不同项靠**明度**分开（蓝三档 / 绿两档 / 琥珀两档），
 * 语义类（状态、优先级）则严格对齐宿主语义色：紧急=红、警告=琥珀、普通=蓝、低=灰。
 */
export const DICTIONARY_DEFAULT_COLORS: Record<string, Record<string, string>> = {
  type: {
    client_meeting: PALETTE.blue,
    code_impl: PALETTE.green,
    feature_opt: PALETTE.blueSoft,
    solution_design: PALETTE.amber,
    boss_request: PALETTE.red,
    team_mgmt: PALETTE.greenSoft,
    project_delivery: PALETTE.blueBright,
    personal: PALETTE.neutral,
    training: PALETTE.bluePale,
  },
  status: {
    backlog: PALETTE.neutral,
    todo: PALETTE.blue,
    doing: PALETTE.amber,
    blocked: PALETTE.redDeep,
    done: PALETTE.green,
    cancelled: PALETTE.neutralDeep,
  },
  priority: {
    p0: PALETTE.redDeep,
    p1: PALETTE.amber,
    p2: PALETTE.blue,
    p3: PALETTE.neutral,
  },
  knowledge_kind: {
    note: PALETTE.blue,
    lesson: PALETTE.red,
    decision: PALETTE.amber,
    snippet: PALETTE.green,
  },
  idea_kind: {
    project: PALETTE.blue,
    skill: PALETTE.green,
    plugin: PALETTE.blueSoft,
    spark: PALETTE.red,
    random: PALETTE.amberDeep,
  },
}

/**
 * 旧私有色板 → 新色系（**迁移 v35 专用**，逐 (kind, code) 精确匹配）。
 *
 * 为什么不做一个"颜色值 → 颜色值"的全局表：旧色板里同一个 `#8B7BE8` 在
 * `knowledge_kind.decision`（决策记录）与 `idea_kind.plugin`（插件点子）上
 * 语义不同 —— 前者该是琥珀、后者该是浅蓝。按值映射会把其中一个改成错的颜色。
 *
 * 只改**还等于旧出厂值**的行：用户若在「设置 → 字典管理」里自己配过色，一律保留。
 */
export const LEGACY_COLOR_REWRITES: Record<string, Record<string, { from: string; to: string }>> = {
  type: {
    client_meeting: { from: '#4F86F7', to: PALETTE.blue },
    code_impl: { from: '#2E9B7B', to: PALETTE.green },
    feature_opt: { from: '#6C5CE7', to: PALETTE.blueSoft },
    solution_design: { from: '#F39C12', to: PALETTE.amber },
    boss_request: { from: '#E74C3C', to: PALETTE.red },
    team_mgmt: { from: '#16A085', to: PALETTE.greenSoft },
    project_delivery: { from: '#2980B9', to: PALETTE.blueBright },
    personal: { from: '#95A5A6', to: PALETTE.neutral },
    training: { from: '#8E44AD', to: PALETTE.bluePale },
  },
  status: {
    backlog: { from: '#95A5A6', to: PALETTE.neutral },
    todo: { from: '#3498DB', to: PALETTE.blue },
    doing: { from: '#F39C12', to: PALETTE.amber },
    blocked: { from: '#E74C3C', to: PALETTE.redDeep },
    done: { from: '#2E9B7B', to: PALETTE.green },
    cancelled: { from: '#7F8C8D', to: PALETTE.neutralDeep },
  },
  priority: {
    p0: { from: '#E74C3C', to: PALETTE.redDeep },
    p1: { from: '#F39C12', to: PALETTE.amber },
    p2: { from: '#3498DB', to: PALETTE.blue },
    p3: { from: '#95A5A6', to: PALETTE.neutral },
  },
  knowledge_kind: {
    note: { from: '#4F86F7', to: PALETTE.blue },
    lesson: { from: '#E7634C', to: PALETTE.red },
    decision: { from: '#8B7BE8', to: PALETTE.amber },
    snippet: { from: '#2E9B7B', to: PALETTE.green },
  },
  idea_kind: {
    project: { from: '#4F86F7', to: PALETTE.blue },
    skill: { from: '#2E9B7B', to: PALETTE.green },
    plugin: { from: '#8B7BE8', to: PALETTE.blueSoft },
    spark: { from: '#E7634C', to: PALETTE.red },
    random: { from: '#D98E32', to: PALETTE.amberDeep },
  },
}

/** 取某类字典的出厂色（找不到返回 undefined，调用方自己决定兜底）。 */
export function defaultColorOf(kind: string, code: string): string | undefined {
  return DICTIONARY_DEFAULT_COLORS[kind]?.[code]
}
