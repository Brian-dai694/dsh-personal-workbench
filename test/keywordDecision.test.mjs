/**
 * 关键词分层决策（`src/shared/keywordDecision.ts`）：阈值边界 + 真实报表基准。
 *
 * 两条线：
 * 1. **边界**：恰好等于门槛算不算（点击 8 / ACOS 30% / 订单 2）、`sales === 0` 时
 *    ACOS 是 unknown 而不是 0、脏值归零、`none` 只在全 0 时出现。
 * 2. **真实基准**：`test/fixtures/keyword-decisions-20261024.json` 是本地最新那份
 *    搜索词报表（1243 行）**按词聚合后**的 767 个词，金额已收到分。
 *    用它锁 7 否词 / 3 加词，以及 `tig torch` 必须落在否词里。
 *
 * ⚠️ 关于「690 watch / 67 none」：这两个数在真实数据上不成立。
 * 该报表 **767 个词每一个都有花费**（搜索词报表里出现即代表有投放消耗），
 * 而 `watch` 的条件是"有曝光或有花费"，所以剩余 757 个词全是 watch、none 为 0。
 * 这里按函数真实结果断言，不按预期数字凑。
 * 690 / 67 若来自别的口径（例如"有点击 vs 无点击"），需要先改 `KEYWORD_RULES`
 * 的判定条件再谈数字 —— 不能只改断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  KEYWORD_DECISION_CODES, KEYWORD_RULES, decideKeyword, summarizeDecisions,
} from '../lib/shared/keywordDecision.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/keyword-decisions-20261024.json', import.meta.url), 'utf8'))

const row = (overrides = {}) => ({ impressions: 100, clicks: 0, orders: 0, spend: 0, sales: 0, ...overrides })

test('阈值常量是唯一来源，四条口径与 SOP 一致', () => {
  assert.equal(KEYWORD_RULES.negativeMinClicks, 8)
  assert.equal(KEYWORD_RULES.addMinOrders, 2)
  assert.equal(KEYWORD_RULES.addMaxAcos, 0.3)
  assert.deepEqual(KEYWORD_DECISION_CODES, ['negative', 'add', 'watch', 'none'])
})

test('否词边界：点击恰好 8 且 0 单且花了钱才算；7 点击 / 花费 0 都不算', () => {
  assert.equal(decideKeyword(row({ clicks: 8, spend: 5 })), 'negative', '恰好等于门槛要算进来')
  assert.equal(decideKeyword(row({ clicks: 7, spend: 5 })), 'watch')
  assert.equal(decideKeyword(row({ clicks: 20, spend: 0 })), 'watch', '没花钱不判否词（门槛同时要求 spend>0）')
  assert.equal(decideKeyword(row({ clicks: 20, orders: 1, spend: 9, sales: 20 })), 'watch', '出过单不判否词')
})

test('加词边界：订单 ≥ 2 且 ACOS ≤ 30%；恰好 30% 算，30.01% 不算', () => {
  assert.equal(decideKeyword(row({ clicks: 10, orders: 2, spend: 30, sales: 100 })), 'add', 'ACOS 恰好 30% 算达标')
  assert.equal(decideKeyword(row({ clicks: 10, orders: 2, spend: 30.01, sales: 100 })), 'watch')
  assert.equal(decideKeyword(row({ clicks: 10, orders: 1, spend: 5, sales: 100 })), 'watch', '订单不足 2')
  assert.equal(decideKeyword(row({ clicks: 10, orders: 3, spend: 5, sales: 0 })), 'watch', '有单无销售额：ACOS 是 unknown，不能当 0')
})

test('优先级：高点击 + 多单先判加词，不会被否词规则吞掉', () => {
  // 否词要求 orders === 0；有 2 单时即使点击 20 也应进 add
  assert.equal(decideKeyword(row({ clicks: 20, orders: 2, spend: 10, sales: 100 })), 'add')
})

test('none 只在全 0 时出现；脏值按 0 处理', () => {
  assert.equal(decideKeyword(row({ impressions: 0, clicks: 0, orders: 0, spend: 0, sales: 0 })), 'none')
  assert.equal(decideKeyword(row({ impressions: 0, clicks: Number.NaN, orders: 0, spend: 0, sales: 0 })), 'none')
  assert.equal(
    decideKeyword({ impressions: -5, clicks: -1, orders: -2, spend: -3, sales: -4 }),
    'none',
    '负值一律按 0，不因为"-3 花费"判否词',
  )
  assert.equal(decideKeyword(row({ impressions: 0, spend: 0.01 })), 'watch', '只要花了钱就是 watch')
})

test('summarizeDecisions：四个键总在，合计等于词数', () => {
  const rows = [
    row({ clicks: 9, spend: 3 }),                       // negative
    row({ clicks: 10, orders: 2, spend: 10, sales: 100 }), // add
    row({ impressions: 4, clicks: 1, spend: 0.5 }),      // watch
    row({ impressions: 0, clicks: 0, spend: 0 }),        // none
  ]
  const result = summarizeDecisions(rows)
  assert.deepEqual(result, { negative: 1, add: 1, watch: 1, none: 1 })
  assert.equal(Object.values(result).reduce((sum, n) => sum + n, 0), rows.length)
  assert.deepEqual(summarizeDecisions([]), { negative: 0, add: 0, watch: 0, none: 0 })
})

test('真实报表基准：767 词 → 7 否词 / 3 加词 / 757 观察 / 0 不动', () => {
  const words = fixture.words
  assert.equal(fixture.source.rows, 1243, '夹具必须来自那份 1243 行的报表')
  assert.equal(words.length, 767)

  const distribution = summarizeDecisions(words)
  assert.deepEqual(distribution, { negative: 7, add: 3, watch: 757, none: 0 })
  assert.equal(Object.values(distribution).reduce((sum, n) => sum + n, 0), 767)

  // 为什么 none 是 0：这份报表里每个词都有花费 —— "有曝光或有花费"必然成立
  assert.equal(words.filter((word) => word.spend > 0).length, 767, '所有词都有花费，所以不存在 none')

  // 否词：tig torch 必须在内（23 点击 / 0 单 / 19 行合并 —— 按单行永远判不出来）
  const negatives = words.filter((word) => decideKeyword(word) === 'negative')
  const torch = negatives.find((word) => word.keyword === 'tig torch')
  assert.ok(torch !== undefined, 'tig torch 必须在否词候选里')
  assert.equal(torch.clicks, 23)
  assert.equal(torch.orders, 0)
  assert.equal(torch.rowCount, 19)
  const negativeSpend = Math.round(negatives.reduce((sum, word) => sum + word.spend, 0) * 100) / 100
  assert.equal(negativeSpend, 97.93, '7 条否词的花费合计 $97.93')

  // 加词：就是基准里的那三个
  const adds = words.filter((word) => decideKeyword(word) === 'add').map((word) => word.keyword).sort()
  assert.deepEqual(adds, ['jumbo tig cups', 'tig cups jumbo', 'tig welding accessories'])

  // tig cups 不是加词（ACOS 49% 高于 30%），也不是否词（4 单）→ watch
  const cups = words.find((word) => word.keyword === 'tig cups')
  assert.ok(cups !== undefined, '夹具里应有 tig cups')
  assert.equal(decideKeyword(cups), 'watch')
  assert.equal(cups.rowCount, 44)
  assert.equal(cups.clicks, 55)
})
