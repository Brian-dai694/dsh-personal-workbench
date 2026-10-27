/**
 * 选品「判断」的共享类型（migration 30）。
 *
 * 为什么单独一个 shared 文件：
 * - 数据库要**按结论筛选**（`verdict` 提成列），客户端要**显示/编辑**同一套语义；
 * - 技能产出的回写（agent 工具）也要用同一个封闭枚举，不能各写一份字符串。
 *
 * 纪律：`verdict` 是封闭枚举；`score` 只接受 0–100；`risk.level` 同枚举。
 * 非法值一律在写入前拒绝，不静默夹取（否则筛出来的"可做"可能是被改小的分）。
 */

export const ASIN_VERDICTS = ['none', 'do', 'watch', 'drop'] as const
export type AsinVerdict = typeof ASIN_VERDICTS[number]

export const ASIN_VERDICT_LABELS: Record<AsinVerdict, string> = {
  none: '未判断',
  do: '可做',
  watch: '观望',
  drop: '放弃',
}

export const ASIN_RISK_LEVELS = ['low', 'medium', 'high', 'unknown'] as const
export type AsinRiskLevel = typeof ASIN_RISK_LEVELS[number]

export interface AsinJudgment {
  verdict: AsinVerdict
  score: number | null
  /** 为什么是这个结论 / 下一步动作（一句话）。 */
  nextAction: string | null
  /** 评分卡分项，原样保存（顺序即展示顺序）。 */
  criteria: Array<{ name: string; value: string }>
  /** VOC 痛点与条数（来自评论聚类）。 */
  painPoints: Array<{ label: string; count: number }>
  /** 商标/合规风险等级与证据。 */
  risk: { level: AsinRiskLevel; note: string }
  /** 已覆盖的关键词数（词库 / 反查结果）。 */
  keywordCount: number | null
  judgedAt: string | null
  judgedSource: string | null
}

export function isAsinVerdict(value: unknown): value is AsinVerdict {
  return typeof value === 'string' && (ASIN_VERDICTS as readonly string[]).includes(value)
}

export function isAsinRiskLevel(value: unknown): value is AsinRiskLevel {
  return typeof value === 'string' && (ASIN_RISK_LEVELS as readonly string[]).includes(value)
}

export function emptyJudgment(): AsinJudgment {
  return {
    verdict: 'none',
    score: null,
    nextAction: null,
    criteria: [],
    painPoints: [],
    risk: { level: 'unknown', note: '' },
    keywordCount: null,
    judgedAt: null,
    judgedSource: null,
  }
}

export interface AsinJudgmentInput {
  verdict: AsinVerdict
  score?: number | null
  nextAction?: string | null
  criteria?: Array<{ name: string; value: string }>
  painPoints?: Array<{ label: string; count: number }>
  risk?: { level: AsinRiskLevel; note: string }
  keywordCount?: number | null
  source?: string | null
}

/**
 * 校验并归一化一次判断写入。
 *
 * **未提供的字段保持 `undefined`**（不补默认空值），写入层靠这一点区分
 * "这次不改这个字段"与"这次要清空它"——否则面板上点一下结论会把 VOC 一起抹掉。
 */
export function normalizeJudgmentInput(input: AsinJudgmentInput): AsinJudgmentInput {
  if (!isAsinVerdict(input.verdict)) {
    throw new Error(`verdict 非法：${String(input.verdict)}（允许 ${ASIN_VERDICTS.join(' / ')}）`)
  }
  if (input.score !== undefined && input.score !== null) {
    if (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > 100) {
      throw new Error('score 必须是 0–100 的数字')
    }
  }
  if (input.risk !== undefined && !isAsinRiskLevel(input.risk.level)) {
    throw new Error(`risk.level 非法：${String(input.risk.level)}（允许 ${ASIN_RISK_LEVELS.join(' / ')}）`)
  }
  if (input.keywordCount !== undefined && input.keywordCount !== null) {
    if (!Number.isInteger(input.keywordCount) || input.keywordCount < 0) throw new Error('keywordCount 必须是非负整数')
  }
  const criteria = input.criteria === undefined
    ? undefined
    : input.criteria.filter((item) => typeof item?.name === 'string' && item.name.trim() !== '')
      .map((item) => ({ name: item.name.trim(), value: String(item.value ?? '') }))
  const painPoints = input.painPoints === undefined
    ? undefined
    : input.painPoints.filter((item) => typeof item?.label === 'string' && item.label.trim() !== '')
      .map((item) => ({ label: item.label.trim(), count: Number.isFinite(item.count) && item.count > 0 ? Math.floor(item.count) : 0 }))
  return { ...input, criteria, painPoints }
}
