/**
 * 「入口面」的共享读法。
 *
 * ## 为什么需要它
 *
 * 2026-10-27 把 723 行的 `src/index.ts` 拆成 `src/index.ts` + `src/plugin/*`，
 * 而大量接线断言原先直接 grep 入口文件。那些判据要表达的是**「装配里确实做了这件事」**，
 * 不是「这件事写在这个文件名里」—— 所以读**整个入口面**（`index.ts` + `plugin/*.ts`）。
 *
 * 负向唯一性（「只许一处」）不会被放宽：面里出现两次就是两次。
 *
 * 与 `_clientSources.mjs` 同一个思路（那边解决的是客户端按域拆分后的假红），
 * 见该文件头部对"判据要读真实 owner"的说明。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 入口面 = 入口文件 + `src/plugin/` 下全部模块（按文件名排序，顺序稳定）。 */
export const ENTRY_FILES = [
  'src/index.ts',
  ...readdirSync(join(ROOT, 'src', 'plugin'))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => `src/plugin/${name}`),
]

/** 读仓库内任意相对路径的文本（行尾统一成 `\n`，避免 Windows 的 CRLF 让正则失配）。 */
export function readRepo(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8').replace(/\r\n/g, '\n')
}

/** 拼接整个入口面，供"接线是否存在"类断言使用。 */
export function entrySurface() {
  return ENTRY_FILES.map((rel) => `\n/* ==== ${rel} ==== */\n${readRepo(rel)}`).join('\n')
}
