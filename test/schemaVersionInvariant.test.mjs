/**
 * 测试门禁：**测试里不许硬编码 schema 版本号**。
 *
 * 背景（2026-10-23）：schema 从 19 升到 20 时，两条测试仍写着 19，
 * `pnpm test` 直接红成 1338/1340 —— 而产品代码完全没问题。
 * 版本号的唯一来源是 `src/db/schema.ts` 的 `SCHEMA_VERSION`（等于最大迁移号）。
 *
 * 这里守两件事：
 * 1. 任何测试文件里 `assert.equal(SCHEMA_VERSION, <数字>)` 都算违规；
 * 2. `SCHEMA_VERSION` 必须等于 `MIGRATIONS` 的最大版本号（与 listViewWiring 的那条互补）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIGRATIONS, SCHEMA_VERSION } from '../lib/db/schema.js'

const testDir = fileURLToPath(new URL('.', import.meta.url))

test('SCHEMA_VERSION 等于迁移表最大号（唯一来源）', () => {
  const max = Math.max(...MIGRATIONS.map((m) => m.version))
  assert.equal(SCHEMA_VERSION, max, `SCHEMA_VERSION=${SCHEMA_VERSION} 与最大迁移号 ${max} 不一致`)
})

test('测试里不得硬编码 schema 版本号（应引用 SCHEMA_VERSION）', () => {
  const offenders = []
  for (const name of readdirSync(testDir)) {
    if (!name.endsWith('.mjs')) continue
    const text = readFileSync(join(testDir, name), 'utf8')
    // 只抓"断言 SCHEMA_VERSION 等于某个字面量"这一种形状；比较大小/引用常量都放行
    const re = /assert\.(?:equal|strictEqual|deepEqual)\(\s*SCHEMA_VERSION\s*,\s*\d+/g
    let m
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length
      offenders.push(`${name}:${line}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下位置把 schema 版本写死了（改成 assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map(m => m.version)))）：\n${offenders.join('\n')}`
  )
})
