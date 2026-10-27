/**
 * 架构边界的**可执行断言**。
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-27 的后端重构把三条边界从"注释里的约定"搬回了结构上：
 * 宿主不再 import `client/`、`db/repo/*` 不再回导门面、门面只剩 re-export。
 * 但这些约束如果只写在文档里，下一个 PR 就会重新破掉 —— 本仓此前的教训是
 * 「同一个语义两处实现」「注释承诺了、代码没做到」两类 bug 反复出现，
 * 而 `test/httpFence.test.mjs` 已经证明**源码级扫描**是有效解法。
 *
 * ## 规则
 *
 * | 规则 | 内容 | 白名单 |
 * | --- | --- | --- |
 * | R2 | 非 `client/` 文件不得 import `client/`（含 type-only） | 无 |
 * | R4a | `db/repo/*` 不得回导 `db/repo.ts` 门面 | 无 |
 * | R4b | 门面 `db/repo.ts` 不得声明实现（function / const 赋值） | 无 |
 * | R1 | `shared/` 只放**双端**都在用的模块（含 shared→shared 传递） | 6 个历史遗留，只许减少 |
 * | R5 | `client/` 不得**运行时** import 服务端（type-only 单独登记） | 6 条 type-only |
 * | R6 | `src/` 根目录只允许 `index.ts` | 无 |
 * | R7 | `db.prepare(` 只许出现在 `db/`（含 `experts/install.ts` 的 PRAGMA 例外） | 14 个文件，只许减少 |
 * | R8 | `shared/` 不得 import `node:*` | 无 |
 *
 * 白名单的语义是**棘轮**：只允许删条目，不允许加。加等于"新欠一笔债"，
 * 必须在 PR 里说明原因 —— 这正是本文件想逼出来的那个对话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC = join(ROOT, 'src')

/** 只读 `src/`：产物 `lib/` 是派生物，不该被断言。 */
function walkSources(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkSources(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/** `src/` 下的相对路径（正斜杠），例如 `db/repo/tasks.ts`。 */
const relOf = (abs) => abs.slice(SRC.length + 1).replace(/\\/g, '/')

/** 去掉扩展名的模块键，便于把 `from './x.js'` 与真实 `.ts` 文件对上。 */
const moduleKey = (rel) => rel.replace(/\.(js|ts|tsx)$/, '')

/**
 * 一个文件的相对导入。
 * @returns {{ spec: string, target: string, typeOnly: boolean }[]} target 是 `src/` 相对的模块键。
 */
function relativeImports(rel) {
  const text = readFileSync(join(SRC, rel), 'utf8')
  const dir = posix.dirname(rel)
  const found = []
  /**
   * ⚠️ 必须允许跨行：本仓大量 import 写成多行（`import {\n  a,\n  b,\n} from './x.js'`），
   * 用 `[^'\n]*?` 会整块漏掉 —— 第一版就是这么漏了 `client/hooks/useWorkbenchAISessions.ts`
   * 的 `shared/taskFolder`，把双端模块误判成单端。
   */
  const re = /(?:import|export)\s[\s\S]{0,600}?from\s*['"](\.{1,2}\/[^'"]*)['"]|import\s*\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*\)/g
  for (const match of text.matchAll(re)) {
    const spec = match[1] ?? match[2]
    const statement = match[0]
    found.push({
      spec,
      target: moduleKey(posix.normalize(posix.join(dir, spec))),
      typeOnly: /\b(?:import|export)\s+type\b|\{\s*type\b|\btype\s+\{/.test(statement),
    })
  }
  return found
}

const allFiles = walkSources().map(relOf).sort()

// ---------------------------------------------------------------------------
// R2：宿主侧不得 import 浏览器目录
// ---------------------------------------------------------------------------

test('R2：非 client/ 文件不得 import client/（宿主产物不能拖进浏览器目录）', () => {
  const violations = []
  for (const rel of allFiles) {
    if (rel.startsWith('client/')) continue
    for (const { spec, target } of relativeImports(rel)) {
      if (target.startsWith('client/')) violations.push(`${rel} -> ${target}（spec: ${spec}）`)
    }
  }
  assert.deepEqual(violations, [], `宿主侧仍有 ${violations.length} 处 import client/：\n${violations.join('\n')}`)
})

// ---------------------------------------------------------------------------
// R4：仓储门面不成环
// ---------------------------------------------------------------------------

test('R4a：db/repo/* 不得回导门面（否则 repo.ts ↔ 子模块成环）', () => {
  const offenders = []
  for (const rel of allFiles) {
    if (!rel.startsWith('db/repo/')) continue
    for (const { target, spec } of relativeImports(rel)) {
      if (target === 'db/repo') offenders.push(`${rel} -> ${spec}`)
    }
  }
  assert.deepEqual(offenders, [], `子模块回导门面：\n${offenders.join('\n')}`)
})

test('R4b：门面 db/repo.ts 只做 re-export，不得声明实现', () => {
  const text = readFileSync(join(SRC, 'db/repo.ts'), 'utf8')
  const offenders = []
  /** 多行 `export { … } from` 的续行本身不是实现，要整块放行。 */
  let inExportBlock = false
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (inExportBlock) {
      const close = trimmed.indexOf('}')
      if (close < 0) return
      const rest = trimmed.slice(close + 1).trim()
      inExportBlock = false
      if (rest === '' || rest.startsWith('//') || /^from\s+['"]/.test(rest)) return
      offenders.push(`${index + 1}: ${trimmed}`)
      return
    }
    // 允许：注释、空行、`export { … } from` / `export type { … } from`
    if (trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return
    if (/^export\s+(type\s+)?\{/.test(trimmed)) {
      if (!trimmed.includes('}')) inExportBlock = true
      return
    }
    offenders.push(`${index + 1}: ${trimmed}`)
  })
  assert.deepEqual(offenders, [], `门面里出现非 re-export 行（把实现搬去领域模块，门面只保留导出）：\n${offenders.join('\n')}`)
})

// ---------------------------------------------------------------------------
// R1：shared/ = 双端共用（含 shared 之间的传递引用）
// ---------------------------------------------------------------------------

/**
 * 历史遗留：这些模块目前只被一端引用，按 rebaseline §4.2 应迁去对应域目录。
 * ⚠️ 只许删，不许加 —— 新增单端模块请直接放进对应域，别塞 shared。
 */
const SINGLE_END_DEBT = new Map([
  ['shared/adReport', '仅客户端；Amazon 报表解析，宿主侧解析器待收口（rebaseline D4）'],
  ['shared/asinExport', '仅宿主；应归 amazon/ 域'],
  ['shared/asinImport', '仅宿主；应归 amazon/ 域'],
  ['shared/oplogImport', '仅宿主；应归 amazon/ 域'],
  ['shared/paymentReconciliation', '仅客户端；对账只在前端做，宿主无消费方'],
])

test('R1：shared/ 的模块必须双端都在用（含 shared→shared 传递）', () => {
  /** 每个模块的"消费端"集合：client / server。 */
  const ends = new Map()
  const edges = []
  for (const rel of allFiles) {
    ends.set(moduleKey(rel), new Set())
    for (const { target } of relativeImports(rel)) edges.push([moduleKey(rel), target])
  }
  // 种子：非 shared 的直接引用者把自己的端带进去
  for (const [importer, target] of edges) {
    if (!target.startsWith('shared/')) continue
    const bucket = importer.startsWith('client/') ? 'client' : importer.startsWith('shared/') ? null : 'server'
    if (bucket === null) continue
    ends.get(target)?.add(bucket)
  }
  // 传递：shared A import shared B ⇒ A 的两个端也属于 B（反复到不动点）
  for (let changed = true; changed;) {
    changed = false
    for (const [importer, target] of edges) {
      if (!importer.startsWith('shared/') || !target.startsWith('shared/')) continue
      const from = ends.get(importer)
      const to = ends.get(target)
      if (from === undefined || to === undefined) continue
      for (const end of from) {
        if (!to.has(end)) { to.add(end); changed = true }
      }
    }
  }

  const singleEnd = []
  for (const [key, set] of [...ends.entries()].sort()) {
    if (!key.startsWith('shared/')) continue
    const both = set.has('client') && set.has('server')
    if (!both) singleEnd.push(key)
  }

  const unexpected = singleEnd.filter((key) => !SINGLE_END_DEBT.has(key))
  const stale = [...SINGLE_END_DEBT.keys()].filter((key) => !singleEnd.includes(key))
  assert.deepEqual(unexpected, [], `shared/ 新增了单端模块（应放进对应域，而不是 shared）：\n${unexpected.join('\n')}`)
  assert.deepEqual(stale, [], `白名单里的模块已经变成双端共用，请从 SINGLE_END_DEBT 删除：\n${stale.join('\n')}`)
})

test('R8：shared/ 不得 import node:*（它是浏览器也要打包的纯逻辑）', () => {
  const offenders = []
  for (const rel of allFiles) {
    if (!rel.startsWith('shared/')) continue
    const text = readFileSync(join(SRC, rel), 'utf8')
    for (const match of text.matchAll(/from\s+['"](node:[^'"]+)['"]/g)) offenders.push(`${rel} -> ${match[1]}`)
  }
  assert.deepEqual(offenders, [], `shared/ 里出现 node 内建依赖：\n${offenders.join('\n')}`)
})

// ---------------------------------------------------------------------------
// R5：客户端不得运行时依赖宿主
// ---------------------------------------------------------------------------

/**
 * type-only 依赖在编译后会被擦除，先把它们登记下来（只许减少）。
 * 想新增一条，说明你在浏览器里引用了宿主模块的类型 —— 那个类型应该住在 `shared/contracts.ts`。
 */
const CLIENT_TYPE_ONLY_DEBT = new Set([
  'client/hooks/useAmazonDatasets.ts -> db/repo/amazonDatasets',
  'client/hooks/useCalculatorScenarios.ts -> db/repo/calculatorScenarios',
  'client/hooks/useKeywordPlans.ts -> db/repo/keywordPlans',
  'client/hooks/useWorkbenchExperts.ts -> experts/catalog',
  'client/hooks/useWorkbenchExperts.ts -> experts/service',
  'client/views/AmazonKeywordView.tsx -> db/repo/keywordPlans',
])

test('R5：client/ 不得运行时 import 宿主模块（type-only 单独登记）', () => {
  const runtime = []
  const typeOnly = new Set()
  for (const rel of allFiles) {
    if (!rel.startsWith('client/')) continue
    for (const { target, typeOnly: isTypeOnly } of relativeImports(rel)) {
      if (target.startsWith('client/') || target.startsWith('shared/')) continue
      if (isTypeOnly) typeOnly.add(`${rel} -> ${target}`)
      else runtime.push(`${rel} -> ${target}`)
    }
  }
  assert.deepEqual(runtime, [], `客户端出现运行时宿主依赖：\n${runtime.join('\n')}`)
  const added = [...typeOnly].filter((pair) => !CLIENT_TYPE_ONLY_DEBT.has(pair))
  const stale = [...CLIENT_TYPE_ONLY_DEBT].filter((pair) => !typeOnly.has(pair))
  assert.deepEqual(added, [], `客户端新增了 type-only 宿主依赖（类型应放 shared/contracts.ts）：\n${added.join('\n')}`)
  assert.deepEqual(stale, [], `已消除的 type-only 依赖请从白名单删除：\n${stale.join('\n')}`)
})

// ---------------------------------------------------------------------------
// R6：src 根不再平铺子系统
// ---------------------------------------------------------------------------

test('R6：src/ 根目录只允许 index.ts', () => {
  const rootFiles = readdirSync(SRC).filter((name) => statSync(join(SRC, name)).isFile() && /\.(ts|tsx)$/.test(name))
  assert.deepEqual(rootFiles.sort(), ['index.ts'], '根目录出现新的平铺文件：请按域建目录（knowledge/ amazon/ tools/ …）')
})

// ---------------------------------------------------------------------------
// R7：SQL 收口在 db/ 里
// ---------------------------------------------------------------------------

/**
 * 2026-10-27 的存量（28 处 / 8 文件），只许减少。
 * api 层已清零（7 处全部收进 `db/repo/*`）；余下按域继续收。
 * 修法：在 `db/repo/<domain>.ts` 里加一个具名函数，调用点改成 `repo.xxx(...)`。
 */
const RAW_SQL_DEBT = new Map([
  ['experts/install.ts', 1],
  ['knowledge/recall-log.ts', 8],
  ['knowledge/recall.ts', 2],
  ['memory/review-memory.ts', 2],
  ['reminder/config.ts', 2],
  ['reminder/draft-notify.ts', 10],
  ['reminder/scheduler.ts', 2],
  ['tools/workbench.ts', 1],
])

test('R7：db.prepare 只许出现在 db/（存量白名单只许减少）', () => {
  const found = new Map()
  for (const rel of allFiles) {
    if (rel.startsWith('db/')) continue
    const count = (readFileSync(join(SRC, rel), 'utf8').match(/db\.prepare\(/g) ?? []).length
    if (count > 0) found.set(rel, count)
  }
  const grew = []
  for (const [rel, count] of found) {
    const allowed = RAW_SQL_DEBT.get(rel)
    if (allowed === undefined) grew.push(`${rel}（新增 ${count} 处）`)
    else if (count > allowed) grew.push(`${rel}（${allowed} → ${count}）`)
  }
  assert.deepEqual(grew, [], `越层 SQL 增加了：\n${grew.join('\n')}`)
  const stale = [...RAW_SQL_DEBT.entries()].filter(([rel, allowed]) => (found.get(rel) ?? 0) < allowed)
  assert.deepEqual(stale, [], `这些文件的越层 SQL 已减少，请同步下调白名单：\n${stale.map(([rel, n]) => `${rel}（白名单 ${n}，实际 ${found.get(rel) ?? 0}）`).join('\n')}`)
})
