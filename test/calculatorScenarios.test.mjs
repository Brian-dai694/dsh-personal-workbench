/**
 * 测算方案库：输入归一 + 对比逻辑 + 仓储 + HTTP。
 *
 * 关注点：
 * 1. **非法输入不隐藏**：不合法参数照样能保存/列出，并标出错误（静默丢弃会让用户以为"我存的那份没了"）；
 * 2. **对比结论现算**：每列都走 `calculateAmazonEconomics`，改公式后老方案不会显示旧结论；
 * 3. **同名不静默覆盖**：409 + existingId，界面确认后才 `replace`；
 * 4. **"优"标记**只按数值方向，且全列同值时不标（否则每列都最优）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  createCalculatorScenario, deleteCalculatorScenario, findCalculatorScenarioByName,
  getCalculatorScenario, listCalculatorScenarios, updateCalculatorScenario,
} from '../lib/db/repo.js'
import { CALCULATOR_DEFAULTS as DEFAULTS, diffCalculatorInputs, normalizeCalculatorInput, normalizeScenarioName } from '../lib/shared/calculatorScenario.js'

const INPUT = {
  price: 39.99, unitCost: 8, freight: 3, fbaFee: 6, referralFee: 6,
  storageFee: 0.4, removalFee: 0.1, promotionCost: 0.5, returnRate: 0.03, returnLoss: 2,
  otherCosts: 0, targetAcos: 0.25, conversionRate: 0.1, adOrderShare: 0.6, marketCpc: 1.2,
}

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-calc-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  try { return run(db) } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

test('输入归一：非有限值被丢弃（不是转 0），负数原样保留交给校验层报错', () => {
  const normalized = normalizeCalculatorInput({
    price: 39.99, unitCost: Number.NaN, freight: Number.POSITIVE_INFINITY,
    fbaFee: '6' /* 字符串不收 */, referralFee: -3, storageFee: 0,
    unknownField: 123,
  })
  assert.equal(normalized.price, 39.99)
  assert.equal('unitCost' in normalized, false, 'NaN 必须被丢弃，不能变成 0')
  assert.equal('freight' in normalized, false, 'Infinity 必须被丢弃')
  assert.equal('fbaFee' in normalized, false, '字符串不算数字')
  assert.equal(normalized.referralFee, -3, '负数要保留，让 calculateAmazonEconomics 报错，而不是被悄悄夹成 0')
  assert.equal(normalized.storageFee, 0, '0 是有意义的值，必须保留')
  assert.equal('unknownField' in normalized, false, '未知字段不落库')
})

test('方案名归一：去空白并截断到 60 字符', () => {
  assert.equal(normalizeScenarioName('  $39.99 标准成本  '), '$39.99 标准成本')
  assert.equal(normalizeScenarioName('   '), '')
  assert.equal(normalizeScenarioName('x'.repeat(200)).length, 60)
  assert.equal(normalizeScenarioName(123), '')
})

test('diff：只报真的不同的字段，相等时为空', () => {
  const a = { ...INPUT }
  const b = { ...INPUT, price: 34.99, unitCost: 7.5 }
  const diffs = diffCalculatorInputs(a, b)
  assert.deepEqual(diffs.map((d) => d.field).sort(), ['price', 'unitCost'])
  assert.deepEqual(diffCalculatorInputs(a, { ...INPUT }), [])
  // 未填 vs 填了 0 也算差异（语义不同）
  const diffs2 = diffCalculatorInputs({ ...INPUT, calibrationCpc: undefined }, { ...INPUT, calibrationCpc: 0 })
  assert.deepEqual(diffs2, [{ field: 'calibrationCpc', from: null, to: 0 }])
})

test('仓储：存的是输入不是结论；改名字不冲掉参数；删一份不牵连别份', () => withDb((db) => {
  const created = createCalculatorScenario(db, { name: '标准成本', input: INPUT, note: '首发假设' })
  assert.deepEqual(created.input, normalizeCalculatorInput(INPUT))
  assert.equal(created.note, '首发假设')

  const renamed = updateCalculatorScenario(db, created.id, { name: '标准成本 v2' })
  assert.equal(renamed.name, '标准成本 v2')
  assert.deepEqual(renamed.input, normalizeCalculatorInput(INPUT), '只改名时参数必须原样')
  assert.equal(renamed.note, '首发假设')

  const other = createCalculatorScenario(db, { name: '低价假设', input: { ...INPUT, price: 29.99 } })
  assert.equal(deleteCalculatorScenario(db, created.id), true)
  assert.deepEqual(listCalculatorScenarios(db).map((s) => s.id), [other.id])
  assert.equal(getCalculatorScenario(db, created.id), null)
}))

test('仓储：同名可查到（供 409 判定）、ASIN 归一为大写', () => withDb((db) => {
  createCalculatorScenario(db, { name: 'A 方案', input: INPUT, asin: ' b0test999 ' })
  assert.notEqual(findCalculatorScenarioByName(db, 'A 方案'), null)
  assert.equal(findCalculatorScenarioByName(db, '不存在的'), null)
  assert.equal(listCalculatorScenarios(db)[0].asin, 'B0TEST999')
}))

test('对比：每列结论现算、非法列给警告、第一列为基准', async () => {
  const { buildComparison, bestColumnId, COMPARISON_METRICS, describeDiffs, formatComparisonValue } = await import('../lib/client/calculatorCompare.js')
  const table = buildComparison([
    { id: 'a', name: '标准', input: normalizeCalculatorInput(INPUT) },
    { id: 'b', name: '低价', input: normalizeCalculatorInput({ ...INPUT, price: 29.99 }) },
    { id: 'c', name: '填错', input: { price: -1 } },
  ], DEFAULTS)

  assert.equal(table.columns.length, 3)
  // 第一列是基准：没有 diff
  assert.deepEqual(table.columns[0].diffs, [])
  // 第二列相对第一列只差 price
  assert.deepEqual(table.columns[1].diffs.map((d) => d.field), ['price'])
  assert.match(describeDiffs(table.columns[1], '标准'), /售价 39\.99 → 29\.99/)
  assert.match(describeDiffs(table.columns[0], '标准'), /参数相同/)
  // 非法列保留在表里并进 warnings
  assert.equal(table.columns[2].result.valid, false)
  assert.equal(table.warnings.length, 1)
  assert.match(table.warnings[0], /填错/)

  // 「优」标记：非法列绝不参与（否则 -1 的坏方案会以"成本最低"拿下「优」）
  const cost = COMPARISON_METRICS.find((m) => m.key === 'totalVariableCost')
  /**
   * 2026-10-27：佣金改成"售价 × 固定 15%"后，**低价那份的成本确实更低**（佣金跟着降），
   * 所以这里从"两份成本相同 → 不标"改成"低价成本最低 → 标 b"。
   * 旧判据成立的前提是两份都把佣金固定写成 6.00 —— 那本身就是佣金与售价脱钩的症状。
   */
  assert.equal(bestColumnId(cost, table.columns), 'b', '低价方案佣金同步降低 → 成本最低')
  assert.equal(bestColumnId(cost, [table.columns[0], table.columns[2]]), null,
    '只剩基准与非法列时不许标优（非法列排除后有效值不足 2 个）')
  // 全列同值仍然不标（每列都"最优"等于没有信息）
  const sameInputs = buildComparison([
    { id: 'x', name: 'X', input: normalizeCalculatorInput(INPUT) },
    { id: 'y', name: 'Y', input: normalizeCalculatorInput(INPUT) },
  ], DEFAULTS)
  assert.equal(bestColumnId(cost, sameInputs.columns), null, '两份完全相同的方案不标优')

  // 有效贡献：售价高的那列更高 → 标 a
  const profit = COMPARISON_METRICS.find((m) => m.key === 'effectiveProfit')
  assert.equal(bestColumnId(profit, table.columns), 'a')
  // 单看非法列也不能被标
  const onlyInvalid = bestColumnId(profit, [table.columns[2]])
  assert.equal(onlyInvalid, null, '只剩一列（还是非法的）时不许标优')

  // 全列同值不标优
  const samePrice = COMPARISON_METRICS.find((m) => m.key === 'price')
  assert.equal(bestColumnId(samePrice, table.columns), null, 'price 是 better=none，永远不标')
  assert.equal(formatComparisonValue(null, 'money'), '—')
  assert.equal(formatComparisonValue(0.255, 'percent'), '25.5%')
})

async function withServer(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close(); db.close()
    throw new Error('测试服务器没有拿到端口')
  }
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try { await fn({ request }) } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('路由：存 → 列 → 同名 409 → 确认覆盖 → 删', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/workbench/calculator-scenarios', { name: '标准成本', input: INPUT, note: '首发' })
    assert.equal(created.status, 200)
    assert.equal(created.body.scenario.input.price, 39.99)

    const list = await request('GET', '/api/workbench/calculator-scenarios')
    assert.equal(list.status, 200)
    assert.equal(list.body.scenarios.length, 1)

    // 同名 → 409，且带上 existingId（界面据此问"要覆盖吗"）
    const conflict = await request('POST', '/api/workbench/calculator-scenarios', { name: '标准成本', input: { ...INPUT, price: 34.99 } })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.existingId, created.body.scenario.id)

    // 显式 replace 才覆盖
    const replaced = await request('POST', '/api/workbench/calculator-scenarios', { name: '标准成本', input: { ...INPUT, price: 34.99 }, replace: true })
    assert.equal(replaced.status, 200)
    assert.equal(replaced.body.scenario.id, created.body.scenario.id, '覆盖是同一份，不该新增')
    assert.equal(replaced.body.scenario.input.price, 34.99)

    const after = await request('GET', '/api/workbench/calculator-scenarios')
    assert.equal(after.body.scenarios.length, 1, '覆盖后仍然只有一份')

    assert.equal((await request('DELETE', `/api/workbench/calculator-scenarios/${created.body.scenario.id}`)).status, 200)
    assert.equal((await request('GET', '/api/workbench/calculator-scenarios')).body.scenarios.length, 0)
  })
})

test('路由：空名 400、未知 id 404', async () => {
  await withServer(async ({ request }) => {
    assert.equal((await request('POST', '/api/workbench/calculator-scenarios', { name: '  ' })).status, 400)
    assert.equal((await request('GET', '/api/workbench/calculator-scenarios/nope')).status, 404)
    assert.equal((await request('PATCH', '/api/workbench/calculator-scenarios/nope', { name: 'x' })).status, 404)
    assert.equal((await request('DELETE', '/api/workbench/calculator-scenarios/nope')).status, 404)
  })
})

test('对比差异文案：超过 3 项就折叠（避免一行撑半屏），中文错误文案不带内部键名', async () => {
  const { describeDiffs, buildComparison } = await import('../lib/client/calculatorCompare.js')
  const table = buildComparison([
    { id: 'a', name: '基准', input: normalizeCalculatorInput(INPUT) },
    { id: 'b', name: '只填售价', input: { price: 9.99 } },
  ], DEFAULTS)
  const text = describeDiffs(table.columns[1], '基准')
  assert.match(text, /相比「基准」/)
  assert.match(text, /等 \d+ 项$/, '多余字段要折叠成「等 N 项」')
  assert.equal((text.match(/→/g) ?? []).length <= 3, true, '最多展示三项')
})

test('错误文案是中文：不再出现 price cannot be negative 这类内部键名', async () => {
  const { calculateAmazonEconomics } = await import('../lib/shared/amazonCalculator.js')
  const result = calculateAmazonEconomics({ ...DEFAULTS, price: -1, targetAcos: 2 })
  assert.equal(result.valid, false)
  const joined = result.errors.join('；')
  assert.match(joined, /售价不能为负/)
  assert.match(joined, /售价必须大于 0/)
  assert.match(joined, /目标 ACOS必须在 0 到 100% 之间/)
  assert.doesNotMatch(joined, /cannot be negative|must be greater than zero|must be between/)
})
