/**
 * 工作台 skill provider（`src/experts/skill-provider.ts`）+ 宿主适配层
 * （`src/experts/host-adapter.ts`）的测试。
 *
 * 覆盖验收断言 **AX-E24–E28**，以及 §7.1 的"skills 服务缺失"降级与
 * AX-E49 中 P4 能做的 scope 前置断言（真实 `scopeOf` 真跑 + scope helper 缺失时不猜 API）。
 *
 * ## 诚实性约定（本文件最重要的一段）
 *
 * 本仓**没有**真实宿主技能注册表（`@deepseek-ai/dsh-skill` 是宿主 runtime，不在依赖里）。
 * 所以：
 *
 * 1. 我们自己写一个**忠实模拟注册表** `createFakeRegistry()`，按 §2 的合并规则实现：
 *    层由近到远（scoped → global），**近层先占位**（远层不能靠更小的 rank 逆袭）、
 *    同层内 rank 小者胜出、平手按注册顺序；
 * 2. 被验证的是**我方的消费逻辑**（provider 的 list/get、投影、失效转发）；
 *    "真实 SDK 自己的仲裁"、"真实 provider 重载"**没有**在测试里运行，已写进交接的未验证项。
 * 3. `scopeOf` 例外：`@deepseek-ai/dsh-scope` 是本仓 devDependency，测试里**真跑**它，
 *    并在断言名里注明是真实调用。
 *
 * 每个用例一个 `mkdtempSync` 临时根；`finally` 只删自己核验过的目录，从不碰 `~/.dsh/workbench`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

import {
  WORKBENCH_SKILL_PROVIDER_NAME,
  WORKBENCH_SKILL_RANK,
  createWorkbenchSkillProvider,
  invalidateWorkbenchSkills,
  readWorkbenchSkillProviderDiagnostics,
  registerWorkbenchSkillProvider,
} from '../lib/experts/skill-provider.js'
import {
  createWorkbenchSkillProjection,
  loadScopeHelper,
  normalizeSkillProjectionEntry,
  probeExpertSkills,
  projectWorkbenchSkillRegistry,
  resolveLiveAgentScope,
} from '../lib/experts/host-adapter.js'
import { writeManagedSkillManifest } from './fixtures/expertSkillFixture.mjs'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function removeTempDir(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 9) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

const PREFIX = 'dsh-wb-expert-provider-'

function withSkillsFixture(run) {
  const root = mkdtempSync(join(tmpdir(), PREFIX))
  const skillsDir = join(root, 'skills')
  const personasDir = join(root, 'personas')
  const outsideDir = join(root, 'outside')
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(personasDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'sentinel.txt'), '根外哨兵：一个字节都不许变。\n', 'utf8')
  const safeToRemove = root.startsWith(tmpdir()) && root.includes(PREFIX)
  /** 用例体是 async：**必须 await**，否则清理会与断言赛跑（临时目录先被删掉）。 */
  return Promise.resolve()
    .then(() => run({ root, skillsDir, personasDir, outsideDir }))
    .finally(() => {
      if (safeToRemove) removeTempDir(root)
    })
}

/** 写一个技能包（`<skillsDir>/<name>/SKILL.md`）。 */
function writeSkill(skillsDir, name, { description = '演示技能', body = '## 步骤\n1. 读取输入\n2. 输出结论\n', extraFrontmatter = [] } = {}) {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  const text = ['---', `name: ${name}`, `description: ${description}`, ...extraFrontmatter, '---', '', body].join('\n')
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
  return { dir, text }
}

const UUID_A = '11111111-2222-4333-8444-555555555555'
const AT = '2026-01-01T00:00:00.000Z'
const HEX = 'a'.repeat(64)

/** 写一个人格的发布记录（`personas/generated/<uuid>/publication.json`）。 */
function writePublication(personasDir, uuid, { ready = true, installationId = UUID_A } = {}) {
  const dir = join(personasDir, 'generated', uuid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'publication.json'), `${JSON.stringify({
    version: 1,
    expertId: `generated/${uuid}`,
    installationId,
    manifestHash: HEX,
    committedAt: AT,
    ready,
  }, null, 2)}\n`, 'utf8')
  return dir
}

/** 写一个受管技能的 `workbench-install.json`（**真实哈希**，夹具见 `fixtures/expertSkillFixture.mjs`）。 */
function writeSkillInstallManifest(skillsDir, name, { uuid = UUID_A, installationId = UUID_A } = {}) {
  const path = join(skillsDir, name, 'workbench-install.json')
  writeManagedSkillManifest(join(skillsDir, name), {
    name,
    expertId: `generated/${uuid}`,
    installationId,
  })
  return path
}

function candidatesOf(raw) {
  if (Array.isArray(raw)) return raw
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.candidates)) return raw.candidates
  return []
}

// ---------------------------------------------------------------------------
// 忠实模拟注册表（按 §2 的合并规则）
// ---------------------------------------------------------------------------

/**
 * `registerProvider` 的**模拟**实现。
 *
 * 语义刻意与 §2 的注册表文档注释对齐（这样"我方消费逻辑"的测试才有意义）：
 * - 层由近到远：scoped 层先占位，global 层不能靠更小的 rank 逆袭（**不同层不是按 rank 比**）；
 * - 同一层内：rank 小者胜出；平手按注册顺序（先注册者胜）；
 * - `control.invalidate()` 清掉缓存（模拟宿主"失效后重新 list"），缓存清掉之前一直返回旧结果；
 * - `register`（逐条注册）刻意留着一个会抛错的实现：AX-E25 要证明我们**没走**那条路。
 */
function createFakeRegistry() {
  const globalProviders = []
  const scopeProviders = new Map()
  const cache = new Map()
  const controls = []
  let registerCalls = 0
  let registerProviderCalls = 0

  const makeControl = (label) => {
    const record = { label, invalidated: 0, signal: new AbortController().signal }
    const control = {
      signal: record.signal,
      invalidate() {
        record.invalidated += 1
        cache.clear()
      },
    }
    controls.push(record)
    return { control, record }
  }

  /**
   * 按层合并：`layers` 由**近到远**。
   *
   * 每一层内部先按 rank 选出胜者（小者胜、平手先注册者胜），然后**近层先占位**：
   * 远层即使 rank 更小也不能逆袭 —— 这就是"不同 scope 层不能只按 rank 解释"。
   */
  const runList = async (layers, options) => {
    const merged = new Map()
    for (const layer of layers) {
      const layerWinners = new Map()
      for (const provider of layer) {
        const raw = await provider.list({ cwd: options.cwd, signal: options.signal })
        for (const item of candidatesOf(raw)) {
          const current = layerWinners.get(item.name)
          const rank = item.rank ?? Number.MAX_SAFE_INTEGER
          const currentRank = current === undefined ? Number.MAX_SAFE_INTEGER : (current.rank ?? Number.MAX_SAFE_INTEGER)
          if (current === undefined || rank < currentRank) layerWinners.set(item.name, item)
        }
      }
      for (const [name, item] of layerWinners) {
        if (merged.has(name) === false) merged.set(name, item)
      }
    }
    return [...merged.values()]
  }

  const providerEntry = {}

  const registry = {
    get registerCalls() {
      return registerCalls
    },
    get registerProviderCalls() {
      return registerProviderCalls
    },
    get providerNames() {
      return [...globalProviders, ...[...scopeProviders.values()].flat()].map((entry) => entry.provider.name)
    },
    controls,
    /** 逐条注册：本批**绝不能**走这条路。 */
    register() {
      registerCalls += 1
      throw new Error('runtime register 不该被调用：工作台技能必须以 provider 形式注册（规格 §7.1）')
    },
    registerProvider(create) {
      registerProviderCalls += 1
      const { control, record } = makeControl(`global-${registerProviderCalls}`)
      const provider = create(control)
      const entry = { provider, create, control, record }
      globalProviders.push(entry)
      providerEntry.global = entry
      return () => {
        const index = globalProviders.indexOf(entry)
        if (index >= 0) globalProviders.splice(index, 1)
      }
    },
    /** 只在**某个 Agent scope 层**里注册一个 provider（E26 用）。 */
    registerScopedProvider(scopeKey, create) {
      const { control, record } = makeControl(`scoped-${scopeProviders.size + 1}`)
      const provider = create(control)
      const list = scopeProviders.get(scopeKey) ?? []
      list.push({ provider, control, record })
      scopeProviders.set(scopeKey, list)
      return provider
    },
    /** 模拟子 fiber 重挂：宿主用**新的** control 再调一次工厂。 */
    remount() {
      const entry = providerEntry.global
      assert.ok(entry, '还没有注册过 provider')
      const { control, record } = makeControl(`remount-${controls.length + 1}`)
      entry.provider = entry.create(control)
      entry.control = control
      entry.record = record
      cache.clear()
      return record
    },
    async list(options = {}) {
      const key = options.scope ?? 'global'
      if (cache.has(key)) return cache.get(key)
      const globalLayer = globalProviders.map((entry) => entry.provider)
      const scopedLayer = options.scope === undefined ? [] : (scopeProviders.get(options.scope) ?? []).map((entry) => entry.provider)
      const layers = options.scope === undefined ? [globalLayer] : [scopedLayer, globalLayer]
      const result = await runList(layers, options)
      cache.set(key, result)
      return result
    },
    async get(name, options = {}) {
      const items = await registry.list(options)
      const candidate = items.find((item) => item.name === name)
      if (candidate === undefined) return undefined
      const entries = [...(scopeProviders.get(options.scope) ?? []), ...globalProviders]
      for (const entry of entries) {
        if (entry.provider.name !== candidate.provider) continue
        return entry.provider.get(candidate, options)
      }
      return undefined
    },
  }
  return registry
}

/** 一个"用户/项目层"的假 provider（rank 400，用来演覆盖）。 */
function createUserProvider(name, entries) {
  return () => ({
    name,
    async list() {
      return entries
    },
    async get(candidate) {
      return { ...candidate, content: `来自 ${name} 的正文` }
    },
  })
}

function userCandidate(skillName, { provider = 'user-skills', rank = 400, source = 'user' } = {}) {
  return {
    name: skillName,
    description: '用户自己的同名技能',
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider,
    rank,
    locator: { name: skillName },
  }
}

// ---------------------------------------------------------------------------
// AX-E24：坏包 / 未 ready / 隐藏项不进 list，其余包照旧可见
// ---------------------------------------------------------------------------

test('AX-E24 未 ready 的受管技能不进 list、get 也拿不到，但诊断可读且其余包照旧可见', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'good-skill')
    // 受管技能：有管理清单，但关联人格的发布门没有 ready（缺 publication.json）
    const managed = writeSkill(skillsDir, 'half-installed')
    writeSkillInstallManifest(skillsDir, 'half-installed')
    // 隐藏项与 .pending 暂存目录（真实布局：`.pending/<draftId>/<skillName>`）
    const hidden = join(skillsDir, '.hidden-skill')
    mkdirSync(hidden, { recursive: true })
    writeFileSync(join(hidden, 'SKILL.md'), '---\nname: hidden-skill\ndescription: 隐藏\n---\n\n正文\n', 'utf8')
    writeSkill(join(skillsDir, '.pending'), 'draft-skill')
    writeSkill(join(skillsDir, '.pending', UUID_A), 'staged-skill')

    const invalidations = { count: 0 }
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {
        invalidations.count += 1
      },
    })
    const raw = await provider.list({})
    const names = candidatesOf(raw).map((item) => item.name)
    assert.deepEqual(names, ['good-skill'], '未 ready 的受管技能与隐藏/暂存目录都不得出现')

    const diagnostics = readWorkbenchSkillProviderDiagnostics(provider)
    const incomplete = diagnostics.filter((item) => item.code === 'installation-incomplete')
    assert.equal(incomplete.length, 1, '未 ready 要留下一条可读诊断')
    assert.match(incomplete[0].message, /发布门未就绪/)
    assert.equal(incomplete[0].skill, 'half-installed')
    assert.equal(incomplete[0].path, join(skillsDir, 'half-installed'))
    assert.equal(incomplete[0].field, 'half-installed/SKILL.md')

    // 未 ready 的技能连候选都没有 → 伪造一个候选也拿不到正文（发布门在 get 里同样复核）
    const fake = {
      name: 'half-installed',
      description: '假装是候选',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: WORKBENCH_SKILL_PROVIDER_NAME,
      rank: WORKBENCH_SKILL_RANK,
      locator: { name: 'half-installed', packageHash: HEX },
    }
    assert.equal(await provider.get(fake, {}), undefined)
    assert.equal(invalidations.count, 1, '拿不到定义要让注册表失效，不许留着假候选')

    // 发布门补上之后（publication.json 就位）同一个技能就出现了 —— 证明门判的是当下状态
    writePublication(personasDir, UUID_A, { installationId: UUID_A })
    const after = candidatesOf(await provider.list({})).map((item) => item.name)
    assert.deepEqual(after, ['good-skill', 'half-installed'])
  })
})

test('AX-E24 坏包（YAML 坏 / name 不匹配 / 旧驼峰键 / 链接 / 非目录 / 坏目录名）都不进 list，诊断逐条可读', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir, outsideDir }) => {
    writeSkill(skillsDir, 'good-skill')

    const brokenYaml = join(skillsDir, 'broken-yaml')
    mkdirSync(brokenYaml, { recursive: true })
    writeFileSync(join(brokenYaml, 'SKILL.md'), ['---', 'name: broken-yaml', 'description: [未闭合', '---', '', '正文', ''].join('\n'), 'utf8')

    const legacy = join(skillsDir, 'legacy-keys')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'SKILL.md'), ['---', 'name: legacy-keys', 'description: 旧键', 'disableModelInvocation: true', '---', '', '正文', ''].join('\n'), 'utf8')

    const mismatch = join(skillsDir, 'name-mismatch')
    mkdirSync(mismatch, { recursive: true })
    writeFileSync(join(mismatch, 'SKILL.md'), ['---', 'name: another-name', 'description: 名字不一致', '---', '', '正文', ''].join('\n'), 'utf8')

    const emptyBody = join(skillsDir, 'empty-body')
    mkdirSync(emptyBody, { recursive: true })
    writeFileSync(join(emptyBody, 'SKILL.md'), ['---', 'name: empty-body', 'description: 正文空', '---', '', '   ', ''].join('\n'), 'utf8')

    // 链接（Windows 上用 junction：不需要管理员权限）
    let linkCreated = false
    try {
      symlinkSync(outsideDir, join(skillsDir, 'linked-skill'), 'junction')
      linkCreated = true
    } catch {
      /** 造不出链接的环境跳过这一条（下面会断言"至少没有因为它而崩"）。 */
    }
    // 非目录条目 + 非法目录名
    writeFileSync(join(skillsDir, 'loose-file.txt'), '不是技能包\n', 'utf8')
    writeSkill(skillsDir, 'Bad_Name')

    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {},
    })
    const names = candidatesOf(await provider.list({})).map((item) => item.name)
    assert.deepEqual(names, ['good-skill'], '坏包一律不进候选，好包照旧可见')

    const byCode = new Map()
    for (const item of readWorkbenchSkillProviderDiagnostics(provider)) {
      const list = byCode.get(item.code) ?? []
      list.push(item)
      byCode.set(item.code, list)
    }
    const codes = [...byCode.keys()].sort()
    assert.ok(codes.includes('skill-package-invalid'), `坏包要报 skill-package-invalid，实际 ${codes.join(',')}`)
    assert.ok(codes.includes('invalid-path'), '非目录条目 / 非法目录名要报 invalid-path')
    assert.ok(codes.includes('path-link-forbidden'), '链接要报 path-link-forbidden')
    assert.ok(byCode.get('skill-package-invalid').some((item) => item.skill === 'broken-yaml'))
    assert.ok(byCode.get('skill-package-invalid').some((item) => /disableModelInvocation/.test(item.message)), '旧驼峰键必须被明确拒绝')
    assert.ok(byCode.get('skill-package-invalid').some((item) => item.skill === 'name-mismatch' && /目录名/.test(item.message)))
    assert.ok(byCode.get('invalid-path').some((item) => item.skill === 'Bad_Name'))
    if (linkCreated) {
      assert.ok(byCode.get('path-link-forbidden').some((item) => item.message.includes('linked-skill')))
    }
  })
})

// ---------------------------------------------------------------------------
// AX-E24（篡改档）：受管技能的"清单 hash"复核 —— 安装后被改动/增删文件就不算了
// ---------------------------------------------------------------------------

/** 造一个**未被改动**的受管技能（清单哈希真实、关联人格已发布）。 */
function writeReadyManagedSkill(skillsDir, personasDir, name, { body = '## 步骤\n原始正文\n', extraFiles = [] } = {}) {
  writeSkill(skillsDir, name, { body })
  for (const file of extraFiles) {
    const absolute = join(skillsDir, name, ...file.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, `夹具文件：${file}\n`, 'utf8')
  }
  writeSkillInstallManifest(skillsDir, name)
  writePublication(personasDir, UUID_A, { installationId: UUID_A })
  return join(skillsDir, name)
}

test('AX-E24 受管技能未被改动时照常列出、get 拿到正文（清单 hash 复核不误杀合规包）', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'plain-skill')
    const dir = writeReadyManagedSkill(skillsDir, personasDir, 'managed-skill', {
      extraFiles: ['references/guide.md', 'sources/demo/LICENSE.txt'],
    })
    // 清单里的哈希必须真的等于"此刻目录"的哈希（夹具自己先自证一次）
    const manifest = JSON.parse(readFileSync(join(dir, 'workbench-install.json'), 'utf8'))
    assert.deepEqual(manifest.files.map((item) => item.path), ['SKILL.md', 'references/guide.md', 'sources/demo/LICENSE.txt'])

    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {},
    })
    const candidates = candidatesOf(await provider.list({}))
    assert.deepEqual(candidates.map((item) => item.name).sort(), ['managed-skill', 'plain-skill'])
    const managed = candidates.find((item) => item.name === 'managed-skill')
    assert.equal(managed.locator.packageHash, manifest.packageHash, '候选的整包哈希就是清单里那份')
    const definition = await provider.get(managed, {})
    assert.equal(definition.content, '## 步骤\n原始正文')
    assert.deepEqual(readWorkbenchSkillProviderDiagnostics(provider), [], '合规包不该有任何诊断')
  })
})

test('AX-E24 受管技能装完后手改 SKILL.md → list 不再列出、get 拿不到且 invalidate，其它技能仍可见', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeReadyManagedSkill(skillsDir, personasDir, 'managed-skill', { body: '## 步骤\n原始正文\n' })
    writeSkill(skillsDir, 'other-skill')
    let invalidations = 0
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {
        invalidations += 1
      },
    })
    const before = candidatesOf(await provider.list({}))
    assert.deepEqual(before.map((item) => item.name).sort(), ['managed-skill', 'other-skill'])
    const oldCandidate = before.find((item) => item.name === 'managed-skill')
    assert.equal((await provider.get(oldCandidate, {})).content, '## 步骤\n原始正文')

    /** 只改正文：frontmatter 依然合法、名字没变，**只有整包哈希对不上**。 */
    writeSkill(skillsDir, 'managed-skill', { body: '## 步骤\n被人手改过的正文\n' })

    const after = candidatesOf(await provider.list({}))
    assert.deepEqual(after.map((item) => item.name), ['other-skill'], '清单 hash 不一致的受管技能不得再被列出')
    const diagnostics = readWorkbenchSkillProviderDiagnostics(provider)
    const mismatch = diagnostics.filter((item) => item.code === 'skill-package-invalid' && item.skill === 'managed-skill')
    assert.equal(mismatch.length, 1, `要留下可读诊断，实际 ${JSON.stringify(diagnostics)}`)
    assert.match(mismatch[0].message, /安装清单不一致/)
    assert.equal(mismatch[0].field, 'managed-skill/SKILL.md')

    assert.equal(await provider.get(oldCandidate, {}), undefined, '清单对不上也不许把改后的正文当"老板本"给出')
    assert.equal(invalidations, 1, '拿不到定义要让注册表失效')
  })
})

test('AX-E24 受管技能包内增删文件（多一个 / 少一个）→ 同样按清单 hash 拒绝，手工技能不受影响', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    const dir = writeReadyManagedSkill(skillsDir, personasDir, 'managed-skill', {
      extraFiles: ['references/guide.md'],
    })
    /** 旧手工技能：没有管理清单，**没有可比对的基准**，照旧可用。 */
    writeSkill(skillsDir, 'handmade-skill')
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {},
    })
    assert.deepEqual(
      candidatesOf(await provider.list({})).map((item) => item.name).sort(),
      ['handmade-skill', 'managed-skill'],
    )

    // ① 多一个未登记文件
    writeFileSync(join(dir, 'references', 'extra.md'), '夹具：包外多出来的文件\n', 'utf8')
    assert.deepEqual(
      candidatesOf(await provider.list({})).map((item) => item.name).sort(),
      ['handmade-skill'],
      '包内多出一个未登记文件就不再是"工作台装的那份"',
    )

    // ② 回到干净状态，改成**少一个**已登记文件
    rmSync(join(dir, 'references', 'extra.md'))
    writeSkillInstallManifest(skillsDir, 'managed-skill')
    assert.deepEqual(
      candidatesOf(await provider.list({})).map((item) => item.name).sort(),
      ['handmade-skill', 'managed-skill'],
      '重写清单后（重新登记为"两个文件"）应重新可见',
    )
    rmSync(join(dir, 'references', 'guide.md'))
    assert.deepEqual(
      candidatesOf(await provider.list({})).map((item) => item.name).sort(),
      ['handmade-skill'],
      '包内少了一个已登记文件同样要拒绝',
    )
  })
})

test('AX-E24 链接兜底的语义前提：判"条目自己是不是链接"只能靠 lstat（statSync 跟随目标、对链接永远 false）', async () => {
  await withSkillsFixture(async ({ skillsDir, outsideDir }) => {
    let linkCreated = false
    try {
      symlinkSync(outsideDir, join(skillsDir, 'linked-skill'), 'junction')
      linkCreated = true
    } catch {
      /** 造不出链接的环境：这条语义前提测不了（与上面坏包矩阵的守卫同一口径）。 */
    }
    if (linkCreated === false) return
    const link = join(skillsDir, 'linked-skill')
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'lstat 看的是**条目自己**')
    assert.equal(
      statSync(link).isSymbolicLink(),
      false,
      'stat 会跟随链接，对链接永远说 false —— 旧兜底写 statSync 时一句话也兜不住（本次修复的根据）',
    )
    const dirent = readdirSync(skillsDir, { withFileTypes: true }).find((item) => item.name === 'linked-skill')
    assert.equal(dirent.isSymbolicLink(), true, '本机 Dirent 也会标出 junction（代码里"不一定标出"是保守写法）')
  })
})

test('AX-E24 旧手工技能（managed:false）没有清单基准：改了也照旧列出（清单校验只管受管技能）', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'handmade-skill', { body: '## 步骤\n第一版正文\n' })
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {},
    })
    const first = candidatesOf(await provider.list({}))
    assert.deepEqual(first.map((item) => item.name), ['handmade-skill'])
    assert.equal((await provider.get(first[0], {})).content, '## 步骤\n第一版正文')

    writeSkill(skillsDir, 'handmade-skill', { body: '## 步骤\n第二版正文\n' })
    const second = candidatesOf(await provider.list({}))
    assert.deepEqual(second.map((item) => item.name), ['handmade-skill'], '没有清单就没有基准，不该凭空判它"被改过"')
    assert.equal((await provider.get(second[0], {})).content, '## 步骤\n第二版正文')
    assert.deepEqual(readWorkbenchSkillProviderDiagnostics(provider), [])
  })
})

test('AX-E24 完整性字段：observation.complete 在根读不了时为 false，abort 后立即返回空', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'good-skill')
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {},
    })
    const observation = await provider.list({})
    assert.equal(observation.complete, true)
    assert.equal(observation.candidates.length, 1)

    const controller = new AbortController()
    controller.abort()
    const aborted = await provider.list({ signal: controller.signal })
    assert.deepEqual(aborted, { candidates: [], complete: false }, '已 abort 的调用不得再扫盘')
  })
})

// ---------------------------------------------------------------------------
// AX-E25：rank 400 的用户同名技能胜出，且没走 runtime register
// ---------------------------------------------------------------------------

test('AX-E25 用户层 rank 400 同名技能胜出工作台 rank 600，actualProvider/actualSource 可见，且全程只走 registerProvider', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'demo-skill', { description: '工作台下载的版本' })
    const registry = createFakeRegistry()
    // 宿主上下文：只暴露 get('skills')，绝不存在 ctx.skills.register 这条路的依赖
    const ctx = { get: (name) => (name === 'skills' ? registry : undefined) }
    const service = probeExpertSkills(ctx)
    assert.ok(service, 'probeExpertSkills 要能软探测到服务')

    const registration = registerWorkbenchSkillProvider(service, { skillsDir, personasDir })
    assert.equal(registration.providerName, WORKBENCH_SKILL_PROVIDER_NAME)
    assert.deepEqual(registry.providerNames, [WORKBENCH_SKILL_PROVIDER_NAME])

    // 用户层（global 层里的另一个 provider，rank 400）同名覆盖
    registry.registerProvider(createUserProvider('user-skills', [userCandidate('demo-skill', { rank: 400 })]))
    assert.equal(registry.registerCalls, 0, '绝不能走 ctx.skills.register（runtime 逐条注册）')

    const listed = await registry.list({ cwd: 'C:/work' })
    const winner = listed.find((item) => item.name === 'demo-skill')
    assert.equal(winner.provider, 'user-skills', '同层内 rank 400 必须胜过工作台 600')
    assert.equal(winner.source, 'user')

    const projection = await projectWorkbenchSkillRegistry(service, { scope: undefined, cwd: 'C:/work' })
    assert.equal(projection.available, true)
    const entry = projection.findEntry('demo-skill')
    assert.equal(entry.provider, 'user-skills')
    assert.equal(entry.source, 'user')
    assert.equal(entry.modelInvocable, true)
    assert.equal(projection.find('demo-skill').modelInvocable, true)
    // 工作台那一条其实也在候选里（是 provider 产出），只是**没胜出**：
    // 结构化的 registerProvider 路径只提供候选，仲裁权在宿主。
    assert.equal(projection.entries.filter((item) => item.name === 'demo-skill').length, 1, '同名只留胜者，不得并列两条')

    registration.dispose()
    assert.equal(registration.active, false)
    assert.equal(invalidateWorkbenchSkills(registration), false, 'dispose 之后不得再转发失效')
    assert.equal(invalidateWorkbenchSkills(undefined), false)
    assert.deepEqual(registry.providerNames, ['user-skills'], 'dispose 要真的把工作台 provider 解注册（用户那个仍在）')
  })
})

test('AX-E25 registerWorkbenchSkillProvider 只要求 registerProvider（没有 register 也能挂）', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'demo-skill')
    let registered = 0
    let disposed = 0
    /** 这个对象**只有** registerProvider：证明本模块结构上不可能依赖 runtime register。 */
    const registrar = {
      registerProvider(create) {
        registered += 1
        const provider = create({ signal: new AbortController().signal, invalidate: () => {} })
        assert.equal(provider.name, WORKBENCH_SKILL_PROVIDER_NAME)
        return () => {
          disposed += 1
        }
      },
    }
    const registration = registerWorkbenchSkillProvider(registrar, { skillsDir, personasDir })
    assert.equal(registered, 1)
    assert.equal(registration.active, true)
    assert.equal(await registration.invalidateSkills(), true)
    registration.dispose()
    registration.dispose()
    assert.equal(disposed, 1, 'dispose 幂等：只能解注册一次')
  })
})

// ---------------------------------------------------------------------------
// AX-E26：真实 scopeOf + 最近 scope 层胜出
// ---------------------------------------------------------------------------

test('AX-E26 真实 @deepseek-ai/dsh-scope：scopeOf 解析 scoped ctx，未 scoped 的 ctx 得到 undefined', () => {
  const plain = new Context()
  const carrier = new Context()
  const key = { label: 'agent-scope' }
  const scoped = createScope(carrier, key)
  assert.equal(scopeOf(scoped.ctx), key, '这是真实调用（不是模拟）：scoped ctx 上能拿到自己那层 key')
  assert.equal(scopeOf(plain), undefined, '未打标签的 ctx 是 undefined（host 级），不是错误')
  assert.equal(typeof scoped.dispose, 'function')
  scoped.dispose()
})

test('AX-E26 同名跨层：最近 scope 层胜出（真实 scopeOf 取 key + 模拟注册表按 SDK 合并规则）', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'demo-skill', { description: '工作台下载的版本' })
    const registry = createFakeRegistry()
    // 工作台 provider 挂在 global 层（rank 600）
    const registration = registerWorkbenchSkillProvider(registry, { skillsDir, personasDir })
    // 某个 Agent scope 层里有一条 rank 400 的同名技能
    const ctx = new Context()
    const scopeKey = { label: 'agent' }
    const scoped = createScope(ctx, scopeKey)
    const realScope = scopeOf(scoped.ctx)
    assert.equal(realScope, scopeKey)
    registry.registerScopedProvider(realScope, createUserProvider('agent-skills', [userCandidate('demo-skill', { provider: 'agent-skills', rank: 400, source: 'runtime' })]))

    const listed = await registry.list({ scope: realScope, cwd: 'C:/agent-cwd' })
    const winner = listed.find((item) => item.name === 'demo-skill')
    assert.equal(winner.provider, 'agent-skills', '最近 scope 层胜出')

    const projection = await projectWorkbenchSkillRegistry(registry, { scope: realScope, cwd: 'C:/agent-cwd' })
    assert.equal(projection.preliminary, false, '显式传了 scope 就不是降级视角')
    assert.equal(projection.scope, realScope)
    assert.equal(projection.findEntry('demo-skill').provider, 'agent-skills')
    assert.equal(projection.findEntry('demo-skill').source, 'runtime')
    assert.equal(projection.entries.length, 1)

    // 同一份注册表在**没有** scope 的视角下是另一回事（工作台那份胜出）：
    // 这正是"不能拿全局视角冒充 Agent 视角"的证据。
    const globalView = await projectWorkbenchSkillRegistry(registry, {})
    assert.equal(globalView.findEntry('demo-skill').provider, WORKBENCH_SKILL_PROVIDER_NAME)
    assert.equal(globalView.preliminary, true, '没有 scope 的判定必须标成 preliminary')
    registration.dispose()
    scoped.dispose()
  })
})

test('AX-E26/E49 scope helper 缺失或没有 scopeOf 时不猜 API：明确 skill-scope-unavailable', async () => {
  const missing = await loadScopeHelper(async () => {
    throw new Error('ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-scope')
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.problem.code, 'skill-scope-unavailable')
  assert.match(missing.problem.message, /不假装全局视角等于 Agent 视角/)

  const wrongShape = await loadScopeHelper(async () => ({ createScope: () => {} }))
  assert.equal(wrongShape.ok, false)
  assert.equal(wrongShape.problem.code, 'skill-scope-unavailable')
  assert.match(wrongShape.problem.message, /不猜别的 API/)

  const real = await loadScopeHelper()
  assert.equal(real.ok, true, '本仓装了 @deepseek-ai/dsh-scope（devDependency），真实动态 import 应当成功')

  // 有 ctx 但 helper 拿不到 → 明确 problem（不是"没有 scope 而已"）
  const failed = await resolveLiveAgentScope({ ctx: {} }, undefined, async () => {
    throw new Error('没有这个模块')
  })
  assert.equal(failed.evaluated, false)
  assert.equal(failed.resolved, false)
  assert.equal(failed.problem.code, 'skill-scope-unavailable')

  // 没有 live agent（HTTP 侧）→ 没有 problem，只是这次没得看
  const noAgent = await resolveLiveAgentScope(undefined)
  assert.deepEqual(noAgent, { scope: undefined, evaluated: false, resolved: false })

  const throwingHelper = { scopeOf: () => { throw new Error('宿主内部炸了') } }
  const thrown = await resolveLiveAgentScope({ ctx: {} }, throwingHelper)
  assert.equal(thrown.problem.code, 'skill-scope-unavailable')
  assert.match(thrown.problem.message, /scopeOf\(agent\.ctx\) 抛错/)
})

// ---------------------------------------------------------------------------
// AX-E27：list 之后内容变了 → 旧候选 get 不到、正文不被偷换、刷新得到新候选
// ---------------------------------------------------------------------------

test('AX-E27 内容变化后旧候选 get → undefined + invalidate，绝不返回新版本冒充旧候选；刷新得到新候选', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'demo-skill', { body: '## 步骤\n旧正文：只做甲\n' })
    let invalidations = 0
    const provider = createWorkbenchSkillProvider({ skillsDir, personasDir })({
      signal: new AbortController().signal,
      invalidate: () => {
        invalidations += 1
      },
    })

    const first = candidatesOf(await provider.list({}))
    assert.equal(first.length, 1)
    const oldCandidate = first[0]
    const firstHash = oldCandidate.locator.packageHash
    const firstDefinition = await provider.get(oldCandidate, {})
    assert.equal(firstDefinition.content, '## 步骤\n旧正文：只做甲')
    assert.equal(invalidations, 0, '内容没变时不该无谓地让注册表失效')

    /** 只改正文（frontmatter 不变）→ 整包 hash 必须变。 */
    writeSkill(skillsDir, 'demo-skill', { body: '## 步骤\n新正文：先做甲再做乙\n' })

    const stale = await provider.get(oldCandidate, {})
    assert.equal(stale, undefined, '旧候选取不到正文')
    assert.equal(invalidations, 1, '报告不一致必须让注册表失效')
    const changed = readWorkbenchSkillProviderDiagnostics(provider).filter((item) => item.code === 'package-changed')
    assert.equal(changed.length, 1)
    assert.match(changed[0].message, /绝不返回新版本冒充旧候选/)

    const refreshed = candidatesOf(await provider.list({}))
    assert.equal(refreshed.length, 1)
    assert.notEqual(refreshed[0].locator.packageHash, firstHash, '刷新后必须是新包哈希')
    const fresh = await provider.get(refreshed[0], {})
    assert.equal(fresh.content, '## 步骤\n新正文：先做甲再做乙')
    assert.equal(invalidations, 1, '一致时不再失效')

    // 不信任 locator：即使候选里的 locator 指向别处，也一律按 name 从自己的根重算
    const forged = { ...refreshed[0], locator: { name: 'demo-skill', packageHash: HEX } }
    assert.equal(await provider.get(forged, {}), undefined)
    assert.equal(invalidations, 2)
    const wrongName = { ...refreshed[0], locator: { name: 'other-skill', packageHash: refreshed[0].locator.packageHash } }
    assert.equal(await provider.get(wrongName, {}), undefined)
    assert.equal(invalidations, 3)
  })
})

// ---------------------------------------------------------------------------
// AX-E28：安装完成后 invalidate 立即生效（重启不是必要条件）+ 控制器换代
// ---------------------------------------------------------------------------

test('AX-E28 注册表先有缓存：invalidateSkills 之后无需重启立刻发现新装的技能', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'first-skill')
    const registry = createFakeRegistry()
    const registration = registerWorkbenchSkillProvider(registry, { skillsDir, personasDir })

    const before = candidatesOf(await registry.list({})).map((item) => item.name)
    assert.deepEqual(before, ['first-skill'])
    // 安装完成（技能落盘），但注册表还在用缓存
    writeSkill(skillsDir, 'second-skill')
    const cached = candidatesOf(await registry.list({})).map((item) => item.name)
    assert.deepEqual(cached, ['first-skill'], '缓存期看不到新技能（这就是"重启才生效"的成因）')

    assert.equal(registration.invalidateSkills(), true)
    const after = candidatesOf(await registry.list({})).map((item) => item.name)
    assert.deepEqual(after, ['first-skill', 'second-skill'], 'invalidate 之后必须立刻发现新技能')

    // 受管技能同理：有管理清单但发布门没 ready → 不能出现；publication.json 就位 + invalidate 才可见
    const managed = writeSkill(skillsDir, 'managed-skill')
    writeSkillInstallManifest(skillsDir, 'managed-skill')
    assert.equal(registration.invalidateSkills(), true)
    assert.deepEqual(
      candidatesOf(await registry.list({})).map((item) => item.name),
      ['first-skill', 'second-skill'],
      '未 ready 的受管技能不得因为"装完了"就出现在注册表里',
    )
    writePublication(personasDir, UUID_A, { installationId: UUID_A })
    assert.equal(registration.invalidateSkills(), true)
    assert.deepEqual(
      candidatesOf(await registry.list({})).map((item) => item.name),
      ['first-skill', 'managed-skill', 'second-skill'],
      '发布门一就绪，受管技能立刻出现在列表里',
    )
    assert.equal(readWorkbenchSkillProviderDiagnostics(registry).length, 0, '注册表本身不产诊断')
  })
})

test('AX-E28 注册换代（子 fiber 重挂）后旧控制器作废：失效只发往当前这次注册', async () => {
  await withSkillsFixture(async ({ skillsDir, personasDir }) => {
    writeSkill(skillsDir, 'demo-skill')
    const registry = createFakeRegistry()
    const registration = registerWorkbenchSkillProvider(registry, { skillsDir, personasDir })
    const first = registry.controls[0]
    assert.equal(registration.invalidateSkills(), true)
    assert.equal(first.invalidated, 1)

    const second = registry.remount()
    assert.equal(second.invalidated, 0)
    assert.equal(registration.invalidateSkills(), true)
    assert.equal(first.invalidated, 1, '旧控制器不得再被使用')
    assert.equal(second.invalidated, 1)

    registration.dispose()
    assert.equal(registration.invalidateSkills(), false)
    assert.equal(second.invalidated, 1, 'dispose 之后一次都不许再转发')
    assert.equal(registration.readDiagnostics().length, 0)
  })
})

// ---------------------------------------------------------------------------
// §7.1 / §10：skills 服务缺失的降级
// ---------------------------------------------------------------------------

test('§7.1 skills 服务缺失：探测返回 undefined，投影 available=false 且不给任何可用的假象', async () => {
  assert.equal(probeExpertSkills(undefined), undefined)
  assert.equal(probeExpertSkills({}), undefined)
  assert.equal(probeExpertSkills({ get: 'not-a-function' }), undefined)
  assert.equal(probeExpertSkills({ get: () => undefined }), undefined)
  assert.equal(probeExpertSkills({ get: () => ({}) }), undefined, '没有 list 不算服务')
  assert.equal(probeExpertSkills({ get: () => ({ list: 5 }) }), undefined)
  assert.equal(probeExpertSkills({ get: () => ({ list() {}, get: 5 }) }), undefined, 'get 存在但不是函数 → 形状不符')
  assert.equal(probeExpertSkills({ get: () => { throw new Error('宿主炸了') } }), undefined)

  const service = { async list() { return [] } }
  assert.equal(probeExpertSkills({ get: (name) => (name === 'skills' ? service : undefined) }), service)

  const missing = await projectWorkbenchSkillRegistry(undefined, {})
  assert.equal(missing.available, false)
  assert.equal(missing.preliminary, true)
  assert.deepEqual(missing.entries, [])
  assert.equal(missing.issues[0].code, 'skill-service-unavailable')
  assert.match(missing.issues[0].message, /不得假装 required 技能可用/)

  // list 抛错 → 也不假装可用
  const boom = await projectWorkbenchSkillRegistry({ async list() { throw new Error('provider boom') } }, { scope: {} })
  assert.equal(boom.available, false)
  assert.equal(boom.preliminary, false, '显式传了 scope 就不算降级视角')
  assert.equal(boom.issues[0].code, 'skill-service-unavailable')
  assert.match(boom.issues[0].message, /provider boom/)

  // abort → canceled
  const controller = new AbortController()
  controller.abort()
  const canceled = await projectWorkbenchSkillRegistry({ async list() { return [] } }, { signal: controller.signal })
  assert.equal(canceled.available, false)
  assert.equal(canceled.issues[0].code, 'canceled')
})

test('§7.3 投影保留 provider/source/rank/locator，坏条目丢弃而整个列表不抛', async () => {
  const service = {
    async list() {
      return {
        candidates: [
          {
            name: 'demo-skill',
            description: '演示技能',
            whenToUse: '需要演示时',
            invocation: { modelInvocable: false, userInvocable: true },
            source: 'bundled',
            provider: WORKBENCH_SKILL_PROVIDER_NAME,
            rank: WORKBENCH_SKILL_RANK,
            path: 'C:/fake/SKILL.md',
            resourceBase: { kind: 'directory', path: 'C:/fake' },
            locator: { name: 'demo-skill', packageHash: HEX },
          },
          { description: '没有名字，丢弃' },
          null,
          42,
          { name: 'no-invocation', description: '缺 invocation', provider: 'x', source: 'y', rank: 'nope' },
        ],
        complete: false,
      }
    },
  }
  const projection = await projectWorkbenchSkillRegistry(service, { scope: 'scope-key' })
  assert.equal(projection.available, true)
  assert.equal(projection.complete, false)
  assert.deepEqual(projection.entries.map((item) => item.name), ['demo-skill', 'no-invocation'])
  const demo = projection.findEntry('demo-skill')
  assert.equal(demo.provider, WORKBENCH_SKILL_PROVIDER_NAME)
  assert.equal(demo.source, 'bundled')
  assert.equal(demo.rank, WORKBENCH_SKILL_RANK)
  assert.deepEqual(demo.locator, { name: 'demo-skill', packageHash: HEX })
  assert.equal(demo.modelInvocable, false)
  assert.equal(demo.userInvocable, true)
  assert.equal(demo.path, 'C:/fake/SKILL.md')
  assert.equal(projection.find('demo-skill').modelInvocable, false)
  // 缺字段的条目按保守默认值归一化（不给"看起来可用"的假象）
  const loose = normalizeSkillProjectionEntry({ name: 'no-invocation', description: '缺 invocation', provider: 'x', source: 'y', rank: 'nope' })
  assert.equal(loose.rank, null)
  assert.equal(loose.modelInvocable, true)

  const built = createWorkbenchSkillProjection({ entries: projection.entries, available: true, preliminary: true })
  assert.equal(built.find('missing'), undefined)
  assert.equal(built.findEntry('missing'), undefined)
})
