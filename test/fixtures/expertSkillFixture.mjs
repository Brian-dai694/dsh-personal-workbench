/**
 * 受管技能夹具（`workbench-install.json`）—— **唯一一份**，provider / catalog 两个测试文件共用。
 *
 * ## 为什么必须算**真实**哈希
 *
 * provider 在 list/get 时会拿安装清单里的 `packageHash` 与「当前目录重算出来的整包哈希」比对
 * （规格 §7.2 get：复核 ready、真实文件、清单 hash）。早期夹具用的是**合成**哈希
 * （`'a'.repeat(64)`），那样的清单在比对落地后会被**正确地**判成"安装后被改过" ——
 * 夹具若不同步，测的就只是夹具自己的谎。
 *
 * ## 口径与安装器一致（`src/experts/install.ts` → `validateWorkbenchSkillPackage`）
 *
 * - `files[]` = 当时写入的**每一个**包内文件（保留名，如 `workbench-install.json` 自身，不算）；
 * - `packageHash` = `hashSkillPackage({ name, metadata, files })`
 *   —— 它自己会剔除保留名并按 `path` 排序，所以"目录里现在的文件"与"安装时写入的文件"
 *   只要没被改动，算出来必然相等。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { hashSkillPackage, parseWorkbenchSkill } from '../../lib/experts/skill-package.js'
import { EXPERT_RESERVED_FILE_NAMES } from '../../lib/shared/expert.js'

const RESERVED = new Set(EXPERT_RESERVED_FILE_NAMES)

export function sha256OfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 走**真实目录**，按安装器口径列出包内文件（相对技能根、`/` 分隔、按 path 排序）。 */
export function readSkillPackageFiles(skillDir, relative = '') {
  const absolute = relative === '' ? skillDir : join(skillDir, relative)
  const files = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (RESERVED.has(entry.name)) continue
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...readSkillPackageFiles(skillDir, child))
      continue
    }
    if (entry.isFile() === false) continue
    const buffer = readFileSync(join(absolute, entry.name))
    files.push({ path: child, bytes: buffer.length, sha256: sha256OfBuffer(buffer) })
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return files
}

/**
 * 写一个**哈希真实**的 `workbench-install.json`
 * （调用前 SKILL.md 与包内其它文件必须已经就位 —— 清单记的是"此刻的目录"）。
 *
 * @returns `{ packageHash, files }`：被测代码重算出来的值应当与它相等。
 */
export function writeManagedSkillManifest(skillDir, { name, expertId, installationId }) {
  const files = readSkillPackageFiles(skillDir)
  const parsed = parseWorkbenchSkill(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), 'SKILL.md')
  if (parsed.ok !== true || parsed.skill === undefined) {
    throw new Error(`夹具：${name}/SKILL.md 解析不过，算不出真实 packageHash`)
  }
  const packageHash = hashSkillPackage({ name, metadata: parsed.skill.metadata, files })
  writeFileSync(join(skillDir, 'workbench-install.json'), `${JSON.stringify({
    version: 1,
    name,
    expertId,
    installationId,
    packageHash,
    files,
  }, null, 2)}\n`, 'utf8')
  return { packageHash, files }
}
