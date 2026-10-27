/**
 * 测试用的层级解析器（round7）。
 *
 * 背景：`z-index` 从散落的字面数字收成了 `Z_LAYERS` 令牌表（`entryContract.ts`）。
 * 原先几个守卫测试直接在 CSS 源码里用 `\d+` 抠数字，令牌化后会一律抓空 —— 那不是
 * 测试失败，而是**测试本身被绕过了**（抓不到就当 0，断言反而更容易"通过"）。
 *
 * 所以这里把"读层级"这件事收成一处：既认字面数字（历史遗留/表格内堆叠），
 * 也认 `var(--wb-z-*)`，并且**查不到就抛错**，不让空的 var() 静默变成 0。
 */
import { Z_LAYERS } from '../lib/client/entryContract.js'

/** 解析单个 z-index 值（字面数字或 var(--wb-z-*)）。 */
export function resolveZ(value) {
  const text = String(value).trim()
  const token = /^var\(\s*(--wb-z-[a-z0-9-]+)\s*\)$/.exec(text)
  if (token !== null) {
    const name = token[1].slice('--wb-'.length)
    const resolved = Z_LAYERS[name]
    if (resolved === undefined) throw new Error(`未知层级令牌 ${token[1]}：先在 entryContract.ts 的 Z_LAYERS 里登记`)
    return resolved
  }
  const num = Number(text)
  if (Number.isFinite(num)) return num
  throw new Error(`无法解析 z-index 值：${text}`)
}

/** 取某条选择器规则里的 z-index（按 `.{selector} … { … }` 定位）。 */
export function zIndexOf(css, selector) {
  const rule = new RegExp(`\\${selector}\\s*\\{[^}]*z-index\\s*:\\s*([^;}]+)[;}]`, 's').exec(css)
  if (rule === null) return null
  return resolveZ(rule[1])
}

/** 取一段规则文本（不含选择器）里的 z-index。 */
export function zInRule(ruleText) {
  const hit = /z-index\s*:\s*([^;}]+)[;}]/.exec(ruleText)
  if (hit === null) throw new Error('这段规则里没有 z-index')
  return resolveZ(hit[1])
}
