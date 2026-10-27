/**
 * 关键词方案的 CSV 导出（纯函数，服务端与客户端共用一份）。
 *
 * 为什么要共享：客户端只负责"给人看的预览/复制"，服务端负责"真的写文件"。
 * 两处各写一遍转义规则，迟早出现「复制出来的 CSV 能打开、导出的打不开」。
 *
 * 格式约定（对齐广告后台的批量表心智，但不冒充 Bulk Sheet）：
 * - 单行表头 `keyword,match,campaign,rationale`；
 * - 否词单独成段（`match=negative_exact`），因为"否词混进投放词"是最危险的误读；
 * - 所有字段一律加引号并把内部引号翻倍（关键词里出现逗号/引号不会把列冲散）。
 */

export interface KeywordCsvRow {
  keyword: string
  match: string
  campaign: string
  rationale: string
}

const HEADER = 'keyword,match,campaign,rationale'

function escapeCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * 生成 CSV 文本。
 *
 * @param rows 投放候选（关键词 × 匹配方式）
 * @param negatives 否词列表；会以 `negative_exact` 追加在末尾，理由列写明来源
 */
export function keywordPlanCsv(rows: readonly KeywordCsvRow[], negatives: readonly string[] = []): string {
  const lines = [HEADER]
  for (const row of rows) {
    lines.push([row.keyword, row.match, row.campaign, row.rationale].map(escapeCell).join(','))
  }
  for (const word of negatives) {
    lines.push([word, 'negative_exact', 'SP-否词', '人工整理的否词清单'].map(escapeCell).join(','))
  }
  return lines.join('\n')
}

/**
 * 方案标题 → 安全的文件名片段。
 *
 * 只保留中英文/数字/连字符：Windows 上 `: * ? " < > |` 会让写文件直接失败，
 * 而标题是用户随手写的（"Q4 主推: 焊接手套"）。
 */
export function keywordCsvFileName(title: string, now: Date = new Date()): string {
  const safe = title.trim().replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `${safe === '' ? 'keywords' : safe}-${stamp}.csv`
}
