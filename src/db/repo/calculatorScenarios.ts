/**
 * 测算方案仓储（2026-10-24）：把「Amazon 测算」的参数从 localStorage 搬进库。
 *
 * 只存**输入**，不存结论：可售成本/盈亏 CPC 之类的结论由 `calculateAmazonEconomics`
 * 现算。理由和库存快照一样 —— 公式改了以后老方案不能继续显示旧结论。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  normalizeCalculatorInput, normalizeScenarioName, type CalculatorInputRecord,
} from '../../shared/calculatorScenario.js'

export interface CalculatorScenario {
  id: string
  name: string
  input: CalculatorInputRecord
  note: string
  /** 关联的选品库 ASIN（弱关联，不做外键）。 */
  asin: string | null
  createdAt: string
  updatedAt: string
}

export interface CalculatorScenarioInput {
  name: string
  input?: unknown
  note?: string
  asin?: string | null
}

interface RawRow {
  id: string
  name: string
  input_json: string
  note: string
  asin: string | null
  created_at: string
  updated_at: string
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown } catch { return {} }
}

function toScenario(row: RawRow): CalculatorScenario {
  return {
    id: row.id,
    name: row.name,
    input: normalizeCalculatorInput(parseJson(row.input_json)),
    note: row.note,
    asin: row.asin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeAsin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toUpperCase()
  return trimmed === '' ? null : trimmed
}

export function listCalculatorScenarios(db: DatabaseSync): CalculatorScenario[] {
  const rows = db.prepare('SELECT * FROM calculator_scenarios ORDER BY updated_at DESC').all() as unknown as RawRow[]
  return rows.map(toScenario)
}

export function getCalculatorScenario(db: DatabaseSync, id: string): CalculatorScenario | null {
  const row = db.prepare('SELECT * FROM calculator_scenarios WHERE id = ?').get(id) as unknown as RawRow | undefined
  return row === undefined ? null : toScenario(row)
}

export function createCalculatorScenario(db: DatabaseSync, input: CalculatorScenarioInput, at = new Date().toISOString()): CalculatorScenario {
  const name = normalizeScenarioName(input.name)
  if (name === '') throw new Error('方案名不能为空')
  const scenario: CalculatorScenario = {
    id: `calc-${randomUUID().slice(0, 8)}`,
    name,
    input: normalizeCalculatorInput(input.input),
    note: typeof input.note === 'string' ? input.note : '',
    asin: normalizeAsin(input.asin),
    createdAt: at,
    updatedAt: at,
  }
  db.prepare(`INSERT INTO calculator_scenarios (id, name, input_json, note, asin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    scenario.id, scenario.name, JSON.stringify(scenario.input), scenario.note, scenario.asin, scenario.createdAt, scenario.updatedAt,
  )
  return scenario
}

/**
 * 局部更新：只有显式给出的字段才改。
 *
 * `input` 传了就**整份替换**（这是"保存当前参数"的语义，不是逐字段打补丁）；
 * 不传就保留原值 —— 改名字不该把参数一起冲掉。
 */
export function updateCalculatorScenario(db: DatabaseSync, id: string, patch: Partial<CalculatorScenarioInput>, at = new Date().toISOString()): CalculatorScenario | null {
  const existing = getCalculatorScenario(db, id)
  if (existing === null) return null
  const name = patch.name === undefined ? existing.name : normalizeScenarioName(patch.name)
  if (name === '') return null
  const next: CalculatorScenario = {
    ...existing,
    name,
    input: patch.input === undefined ? existing.input : normalizeCalculatorInput(patch.input),
    note: patch.note === undefined ? existing.note : patch.note,
    asin: patch.asin === undefined ? existing.asin : normalizeAsin(patch.asin),
    updatedAt: at,
  }
  db.prepare('UPDATE calculator_scenarios SET name = ?, input_json = ?, note = ?, asin = ?, updated_at = ? WHERE id = ?').run(
    next.name, JSON.stringify(next.input), next.note, next.asin, next.updatedAt, id,
  )
  return next
}

export function deleteCalculatorScenario(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM calculator_scenarios WHERE id = ?').run(id).changes > 0
}

/** 重名检查：同名方案会让"载入哪个"变得不可判断（返回同名的那份）。 */
export function findCalculatorScenarioByName(db: DatabaseSync, name: string): CalculatorScenario | null {
  const clean = normalizeScenarioName(name)
  if (clean === '') return null
  const row = db.prepare('SELECT * FROM calculator_scenarios WHERE name = ? ORDER BY updated_at DESC LIMIT 1').get(clean) as unknown as RawRow | undefined
  return row === undefined ? null : toScenario(row)
}
