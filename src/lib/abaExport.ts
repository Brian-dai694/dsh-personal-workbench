/**
 * ABA 对照表的导出（服务端，写本地文件）。
 *
 * 为什么放服务端：浏览器不能往磁盘写文件；且导出要带**搜索词报表的表现**，
 * 那份数据在服务端（`amazon_datasets`），在这边拼比在界面里拼更稳。
 *
 * 列的顺序就是用户在 Excel 里筛的顺序：
 * 市场证据 → 规则结论 → 回填结论 → 差异 → 我们自己的表现。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { classifyAbaRow, type AbaThresholds } from '../shared/abaKeywordTable.js'
import type { AbaKeywordSet } from '../db/repo/abaKeywordSets.js'
import type { AbaAnnotation } from '../shared/abaKeywordTable.js'

export const ABA_EXPORT_COLUMNS = [
  '关键词', 'ABA排名', '分层', '搜索量', '购买率%', '点击集中度%', 'SPR', '商品数',
  '规则结论', '规则匹配', '回填结论', '回填匹配', '一致?', '差异',
  '我们的点击', '订单', '花费', '销售额', 'ACOS%', '投放状态',
] as const

const WORTH_TEXT: Record<string, string> = { invest: '值得投', watch: '观察', avoid: '避开', unknown: '未知' }
const MATCH_TEXT: Record<string, string> = { exact: '精准', phrase: '词组', broad: '广泛' }
const TIER_TEXT: Record<string, string> = { head: '头部', middle: '中部', tail: '长尾', unknown: '未知' }

function csvCell(value: string | number | null): string {
  if (value === null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 同名文件不覆盖：追加 `-2`、`-3`……（导出目录是用户的，不该被静默覆盖） */
function freePath(dir: string, base: string, ext: string): string {
  let candidate = join(dir, `${base}${ext}`)
  let index = 2
  const { existsSync } = require('node:fs') as typeof import('node:fs')
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}-${index}${ext}`)
    index += 1
  }
  return candidate
}

export interface ExportLookup {
  /** 关键词（小写）→ 报表表现。 */
  get: (keyword: string) => { clicks: number; orders: number; spend: number; sales: number } | undefined
}

export function buildAbaComparisonCsv(set: AbaKeywordSet, lookup: ExportLookup | null, thresholds: Partial<AbaThresholds> = {}): { csv: string; rows: number } {
  const annotations = new Map<string, AbaAnnotation>(set.annotations.map((item: AbaAnnotation): [string, AbaAnnotation] => [item.keyword.trim().toLowerCase(), item]))
  const lines: string[] = [ABA_EXPORT_COLUMNS.join(',')]
  for (const row of set.rows) {
    const base = classifyAbaRow(row, thresholds)
    const note = annotations.get(row.keyword.trim().toLowerCase())
    const appliedWorth = note?.worth ?? base.worth
    const appliedMatch = note?.suggestedMatch ?? base.suggestedMatch
    const worthChanged = note !== undefined && note.worth !== base.worth
    const matchChanged = note !== undefined && note.suggestedMatch !== base.suggestedMatch
    const differs = worthChanged || matchChanged
    const diffText: string = !differs
      ? (note === undefined ? '一致（规则）' : '一致（回填确认）')
      : [
        worthChanged ? `${WORTH_TEXT[base.worth] ?? base.worth} → ${WORTH_TEXT[appliedWorth] ?? appliedWorth}` : '',
        matchChanged ? `${MATCH_TEXT[base.suggestedMatch ?? ''] ?? '—'} → ${MATCH_TEXT[appliedMatch ?? ''] ?? '—'}` : '',
      ].filter((part) => part !== '').join(' · ')
    const actual = lookup?.get(row.keyword) ?? undefined
    const acos = actual !== undefined && actual.sales > 0 ? (actual.spend / actual.sales) * 100 : null
    const status = actual === undefined
      ? '未投放'
      : actual.orders > 0
        ? (acos !== null && acos <= 30 ? '有单·达标' : '有单·ACOS 高')
        : actual.spend > 0 ? '有花费无单' : '有点击无花费'
    lines.push([
      csvCell(row.keyword),
      csvCell(row.rank),
      csvCell(TIER_TEXT[base.tier] ?? base.tier),
      csvCell(row.searches),
      csvCell(row.purchaseRate === null ? null : Math.round(row.purchaseRate * 1000) / 10),
      csvCell(row.clickConcentration === null ? null : Math.round(row.clickConcentration * 1000) / 10),
      csvCell(row.spr),
      csvCell(row.products),
      csvCell(WORTH_TEXT[base.worth] ?? base.worth),
      csvCell(MATCH_TEXT[base.suggestedMatch ?? ''] ?? '—'),
      csvCell(note === undefined ? '' : WORTH_TEXT[appliedWorth] ?? appliedWorth),
      csvCell(note === undefined ? '' : MATCH_TEXT[appliedMatch ?? ''] ?? '—'),
      csvCell(differs ? '否' : '是'),
      csvCell(diffText),
      csvCell(actual?.clicks ?? null),
      csvCell(actual?.orders ?? null),
      csvCell(actual === undefined ? null : Math.round(actual.spend * 100) / 100),
      csvCell(actual === undefined ? null : Math.round(actual.sales * 100) / 100),
      csvCell(acos === null ? null : Math.round(acos * 10) / 10),
      csvCell(status),
    ].join(','))
  }
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, rows: set.rows.length }
}

/** 写进 `~/.dsh/workbench/exports/`，返回绝对路径（让用户能直接去打开）。 */
export function writeAbaComparisonCsv(set: AbaKeywordSet, lookup: ExportLookup | null, thresholds: Partial<AbaThresholds> = {}): { path: string; rows: number } {
  const { csv, rows } = buildAbaComparisonCsv(set, lookup, thresholds)
  const dir = join(homedir(), '.dsh', 'workbench', 'exports')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const path = freePath(dir, `aba-compare-${stamp}`, '.csv')
  writeFileSync(path, csv, 'utf8')
  return { path, rows }
}
