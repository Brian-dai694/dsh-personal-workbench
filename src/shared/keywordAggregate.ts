/**
 * 关键词聚合：把**逐行**的搜索词报表压成**词级**一行（纯函数，界面/工具/测试共用一份）。
 *
 * ## 为什么需要它
 * 亚马逊导出的搜索词报表是按"搜索词 × 投放单元"逐行给的：同一个词在多个广告活动/
 * 广告组/匹配类型里各占一行。直接在行级看数会同时犯两个错：
 * - 低估一个词的真实花费与点击（55 次点击被拆成 44 行，每行都显得"样本不足"）；
 * - 词表里同一个词出现多次，做"词级结论"时不知道该看哪一行。
 * 所以先把行压成词，再谈加词/否词。
 *
 * ## 口径（改之前先想清楚，别处依赖这些字面语义）
 * - **合并键**：`keyword.trim().toLowerCase()`。大小写、首尾空白不同视为同一个词；
 *   中间的连续空格**不**归一（亚马逊的搜索词本身可能带双空格，那是另一个词）。
 * - **显示词**：保留**首次出现**的那份原词（已 trim）。不做 title case，
 *   因为原词大小写是报表原文，改了就不好对照。
 * - **数值**：五项（曝光/点击/订单/花费/销售额）逐组求和；`NaN`、`Infinity`、负数
 *   一律按 **0** 计入，不抛错 —— 脏数据不该让整张表打不开，但也不能让-5 次点击
 *   把合计冲掉。
 * - **空词**：`trim()` 后为空的行直接跳过，不产生 `''` 组。
 * - **排序**：花费降序 → 点击降序 → 词升序（按码位比较，不用 localeCompare，
 *   避免不同机器排序不一致）。最后一级是唯一的词，所以顺序是确定的，
 *   同一份数据聚合两次结果逐字一致。
 *
 * ⚠️ 这是**词级**聚合，不是投放单元级：它用来看"这个词整体花了多少、出没出单"。
 * 判否词仍然要回看行级（同一个词在别的活动里可能出过单）—— 见工作台知识库
 * 「搜索词报告必须按投放单元级归因」那条。
 */

/** 聚合的输入行：与 `TrafficRow` 结构一致，不引入额外依赖。 */
export interface KeywordAggregateInput {
  keyword: string
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
}

/** 聚合输出：一个词一行。 */
export interface KeywordAggregateRow {
  /** 首次出现的原词（已 trim，大小写保留原文）。 */
  keyword: string
  /** 这个键一共合并了多少行。 */
  rowCount: number
  impressions: number
  clicks: number
  orders: number
  spend: number
  sales: number
}

/** 参与求和的字段（顺序即输出字段顺序，别打乱）。 */
const METRIC_KEYS = ['impressions', 'clicks', 'orders', 'spend', 'sales'] as const

/**
 * 脏值归零：只有有限的正数才计入。
 *
 * `0` 本身是真实值（0 单、0 花费），走 `> 0` 与负值/NaN 一样落到 0，语义上不冲突。
 */
function safeNumber(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 花费降序 → 点击降序 → 词升序；码位比较保证跨机器一致。 */
function compareAggregates(a: KeywordAggregateRow, b: KeywordAggregateRow): number {
  if (a.spend !== b.spend) return b.spend - a.spend
  if (a.clicks !== b.clicks) return b.clicks - a.clicks
  if (a.keyword === b.keyword) return 0
  return a.keyword < b.keyword ? -1 : 1
}

/**
 * 按词聚合。
 *
 * 不修改入参数组与行对象；返回新数组。空输入返回空数组（不是 `[{}]`）。
 */
export function aggregateByKeyword(rows: ReadonlyArray<KeywordAggregateInput>): KeywordAggregateRow[] {
  const groups = new Map<string, KeywordAggregateRow>()
  for (const row of rows) {
    const display = typeof row.keyword === 'string' ? row.keyword.trim() : ''
    if (display === '') continue
    const key = display.toLowerCase()
    let group = groups.get(key)
    if (group === undefined) {
      group = { keyword: display, rowCount: 0, impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 }
      groups.set(key, group)
    }
    group.rowCount += 1
    for (const metric of METRIC_KEYS) group[metric] += safeNumber(row[metric])
  }
  return [...groups.values()].sort(compareAggregates)
}
