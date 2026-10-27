/**
 * 构建产物与构建配置的**结构断言**。
 *
 * ## 为什么需要这个文件
 *
 * `tsconfig.build.json` 曾经是一份 **100 条逐文件白名单**：新增一个模块忘了往里加一行，
 * 产物里就没有它，而 `tsc --noEmit`（走 `tsconfig.json` 的 `include: ["src"]`）**照样是绿的** ——
 * 表现是"本地跑得通、装盘后 `ERR_MODULE_NOT_FOUND`"。这类漏项没有测试会红，只能靠人记得。
 *
 * 2026-10-27 起构建配置不再枚举文件：它继承 `tsconfig.json` 的 `include: ["src"]`，
 * 只覆盖 emit 相关选项。本文件把这件事钉成断言，防止哪天又被改回白名单。
 *
 * ## 覆盖口径
 *
 * 产物必须覆盖**全部宿主侧源码**（`src/` 下非 `client/` 的一切）。
 * `client/` 的 UI 组件目前**也会**被编进 `lib/`（因为既有测试直接 `import '../lib/client/…'`），
 * 但"UI 该不该进宿主产物"是 rebaseline D1 的独立议题，不在这里断言 —— 这里只保证
 * **宿主真正要用的模块一个都不能少**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

function walkSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkSources(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

test('构建配置：include 必须是目录/通配，不许回退成逐文件白名单', () => {
  const build = readJson('tsconfig.build.json')
  const base = readJson('tsconfig.json')
  const include = build.include ?? base.include
  assert.ok(Array.isArray(include) && include.length > 0, '构建配置必须继承或自声明 include')

  const fileEntries = include.filter((entry) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/i.test(entry))
  assert.deepEqual(
    fileEntries,
    [],
    `tsconfig.build.json 又出现了逐文件条目（漏加一行 = 产物缺模块且无测试会红）：\n${fileEntries.join('\n')}`,
  )
  assert.ok(include.length <= 5, `include 条目过多（${include.length}），应当只写目录或通配：\n${include.join('\n')}`)

  // emit 选项仍然是"声明 + 产物到 lib"，别在改 include 时把这些顺手弄丢
  assert.equal(build.compilerOptions.noEmit, false)
  assert.equal(build.compilerOptions.outDir, 'lib')
  assert.equal(build.compilerOptions.rootDir, 'src')
})

test('构建产物覆盖全部宿主侧源码（src/ 下非 client/）', () => {
  const missing = []
  for (const abs of walkSources(join(ROOT, 'src'))) {
    const rel = abs.slice(join(ROOT, 'src').length + 1).replace(/\\/g, '/')
    if (rel.startsWith('client/')) continue
    const expected = join(ROOT, 'lib', rel.replace(/\.tsx?$/, '.js'))
    if (!existsSync(expected)) missing.push(`src/${rel} → lib/${rel.replace(/\.tsx?$/, '.js')}`)
  }
  assert.deepEqual(
    missing,
    [],
    `以下宿主侧模块没有产物（先在仓库根跑 pnpm build，再跑测试）：\n${missing.join('\n')}`,
  )
})

test('构建产物：入口、客户端 bundle、构建标识三件套都在', () => {
  for (const rel of ['lib/index.js', 'lib/client.js', 'lib/build-info.json']) {
    assert.ok(existsSync(join(ROOT, rel)), `缺少 ${rel}（pnpm build 没跑成功？）`)
  }
})
