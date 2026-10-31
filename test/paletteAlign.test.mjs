/**
 * 色系一致性守卫（2026-10-28：用户要求「工作台和 dsh 统一一个色系」）。
 *
 * 这条要求落在**两处**：
 *   1. UI 的 CSS 令牌（`styles.ts` + `entryContract.ts`）—— 由 `tokenScope.test.mjs` 盯；
 *   2. **字典数据里的颜色**（任务类型圆点、状态点、优先级点、知识库/点子分类点）——
 *      它们存在库里、由「设置 → 字典管理」编辑，CSS 令牌管不到，本文件盯。
 *
 * 历史病根：出厂色散落在 `seed.ts`（首次装库）与 `schema.ts`（v16 回填迁移）两处，
 * 于是同一套字典有两个"真相"，而且都没和 DSH 对齐（紫 #8B7BE8 / 青 #16A085 混用）。
 * 现在唯一来源是 `palette.ts`，这里断言三件事：
 *   1. 出厂种子颜色 === 调色板；
 *   2. 迁移 v35 的"新值" === 出厂色（迁移不会和种子漂移）；
 *   3. v35 的实际行为：只改还停在旧出厂值的行，用户自定义色一律保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { DICTIONARY_SEEDS, seedDictionaries } from '../lib/db/seed.js'
import { DICTIONARY_DEFAULT_COLORS, LEGACY_COLOR_REWRITES, PALETTE } from '../lib/shared/palette.js'
import { MIGRATIONS } from '../lib/db/schema.js'

const COLORED_KINDS = ['type', 'status', 'priority', 'knowledge_kind', 'idea_kind']

test('出厂种子的颜色必须来自调色板（只在 palette.ts 里定义一次）', () => {
  const problems = []
  for (const seed of DICTIONARY_SEEDS) {
    const expected = DICTIONARY_DEFAULT_COLORS[seed.kind]?.[seed.code]
    const actual = seed.config.color
    if (expected === undefined) {
      if (actual !== undefined) problems.push(`${seed.kind}/${seed.code} 不该有颜色（调色板未登记）`)
      continue
    }
    if (actual !== expected) problems.push(`${seed.kind}/${seed.code}: ${String(actual)} ≠ ${expected}`)
  }
  assert.deepEqual(problems, [], `种子颜色和调色板不一致：\n  - ${problems.join('\n  - ')}`)
})

test('五类带颜色的字典都要有出厂色，且取值全部落在 DSH 色板内', () => {
  const allowed = new Set(Object.values(PALETTE))
  for (const kind of COLORED_KINDS) {
    const byCode = DICTIONARY_DEFAULT_COLORS[kind]
    assert.ok(byCode !== undefined, `调色板缺少 ${kind}`)
    for (const [code, color] of Object.entries(byCode)) {
      assert.ok(allowed.has(color), `${kind}/${code} 的 ${color} 不在 DSH 色板里`)
    }
    const seeded = DICTIONARY_SEEDS.filter((seed) => seed.kind === kind)
    assert.deepEqual(
      seeded.map((seed) => seed.code).sort(),
      Object.keys(byCode).sort(),
      `${kind} 的种子与调色板的 code 集合不一致（有一方漏了）`,
    )
  }
})

test('迁移 v35 的目标值必须等于出厂色（否则种子写 A、迁移认 B）', () => {
  const problems = []
  for (const [kind, byCode] of Object.entries(LEGACY_COLOR_REWRITES)) {
    for (const [code, { from, to }] of Object.entries(byCode)) {
      const expected = DICTIONARY_DEFAULT_COLORS[kind]?.[code]
      if (expected === undefined) { problems.push(`${kind}/${code} 在调色板里没有出厂色`); continue }
      if (to !== expected) problems.push(`${kind}/${code}: 迁移写 ${to}，出厂色是 ${expected}`)
      if (from === to) problems.push(`${kind}/${code}: 旧值与新值相同（${from}），这条迁移是空的`)
    }
  }
  assert.deepEqual(problems, [], `迁移与出厂色漂移：\n  - ${problems.join('\n  - ')}`)
})

test('迁移 v35 只改还停在旧出厂值的行，用户自定义色保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-palette-'))
  const db = openWorkbenchDb({ dataDir: dir })
  try {
    seedDictionaries(db)
    const migration = MIGRATIONS.find((item) => item.version === 35)
    assert.ok(migration !== undefined, 'MIGRATIONS 里找不到 v35（dictionary-palette-dsh）')

    const legacy = LEGACY_COLOR_REWRITES.knowledge_kind.decision
    const setColor = (kind, code, color) => {
      const row = db.prepare('SELECT config FROM dictionaries WHERE kind = ? AND code = ?').get(kind, code)
      const config = JSON.parse(row.config)
      db.prepare('UPDATE dictionaries SET config = ? WHERE kind = ? AND code = ?')
        .run(JSON.stringify({ ...config, color }), kind, code)
    }
    const colorOf = (kind, code) => JSON.parse(
      db.prepare('SELECT config FROM dictionaries WHERE kind = ? AND code = ?').get(kind, code).config,
    ).color

    // ① 还停在旧值 → 改成新色系
    setColor('knowledge_kind', 'decision', legacy.from)
    // ② 用户自己调过 → 原样保留
    setColor('idea_kind', 'plugin', '#123456')
    // ③ config 被手工改坏 → 不碰（不能让迁移把坏数据变成异常退出）

    migration.up(db)

    assert.equal(colorOf('knowledge_kind', 'decision'), legacy.to,
      '旧出厂色应当被迁到 DSH 色系')
    assert.equal(colorOf('idea_kind', 'plugin'), '#123456',
      '用户自定义色必须保留（迁移只认旧出厂值）')
  } finally {
    db.close()
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* Windows 上偶发 EPERM，不影响断言 */ }
  }
})
