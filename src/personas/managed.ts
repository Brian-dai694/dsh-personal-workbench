/**
 * 受管人格的**发布门**（规格 §6.2，P3 第一轮）。
 *
 * ## 为什么需要一个独立的模块
 *
 * 安装器（`src/experts/install.ts`）是**分步**把文件放上正式位置的：
 *
 * 1. `generated/<UUID>/provenance.json` 与附件；
 * 2. 每个 skill 目录；
 * 3. `generated/<UUID>.md`（这一份才是解析器唯一看得见的人格文档）；
 * 4. `generated/<UUID>/publication.json`（**最后**一步）。
 *
 * 第 3 步做完、第 4 步没做完之间，目录里已经有一份"完整得能解析"的人格文档。
 * 如果发现链只看"文件在不在"，这个中间态就会被当成一个正常角色列出来 ——
 * 用户会看到一个**半成品**，而它随后可能被补偿删掉（§6.5 第一行）。
 *
 * 所以发布门是**白名单**：只有 `generated/` 下同名附件里的 `publication.json`
 * 明确 `ready: true` 且 `expertId` 一致，这份文档才算"存在"。
 *
 * ## 三个不可让步的性质
 *
 * 1. **只对受管 ID 生效**：门的判据是"`source.kind === 'user'` 且 id 精确匹配
 *    `generated/<小写UUID>`"。手工角色、内置角色、外部角色**永远**不走这条分支，
 *    行为与 P1/P2 完全一致（AX-R01/R02/R03 的回归就靠这一点）。
 * 2. **fail-closed**：缺文件、读不回来、JSON 坏、版本不对、`expertId` 不一致、
 *    `ready !== true` —— 一律**不放行**，并给出 `installation-incomplete`。
 *    没有"坏了就当没有、于是也列出来"的可能。
 * 3. **发现与解析共用同一份判定**：`discoverPersonas` 与 `resolvePersona` 都调
 *    `readManagedPersonaPublication`，不存在"列表里没有、直接按 id 解析却能拿到"的缝。
 *
 * ## 边界
 *
 * 这里**只读**：不创建、不修复、不删除任何一个字节。修复是安装器/恢复逻辑的事
 * （同一个"谁有权写正式文件"的问题，不该有两个答案）。
 */
import { isSha256Hex } from '../experts/provenance.js'
import { readExpertTextFile } from '../experts/paths.js'
import {
  EXPERT_GENERATED_DIR_NAME,
  EXPERT_PUBLICATION_FILE_NAME,
  EXPERT_PUBLICATION_VERSION,
  EXPERT_SKILL_INSTALL_FILE_NAME,
  EXPERT_SKILL_INSTALL_VERSION,
  expertUuidFromId,
  isExpertId,
  isExpertSkillName,
  isExpertUuid,
  type ExpertErrorCode,
} from '../shared/expert.js'

/** `publication.json` 的已校验形状（`version` 固定 1）。 */
export interface ManagedPersonaPublication {
  version: 1
  /** `generated/<UUID>`，必须与所在目录的父 ID 逐字一致。 */
  expertId: string
  /** = 安装它那份草稿的 draftId。 */
  installationId: string
  /** 与草稿 `validation.manifestHash` 同源。 */
  manifestHash: string
  /** 发布（写 publication.json）的时间。 */
  committedAt: string
}

/** 发布门不放行的具体原因（都收敛成同一个对外 code `installation-incomplete`）。 */
export type ManagedPublicationProblemReason =
  | 'not-managed-id'
  | 'missing'
  | 'unreadable'
  | 'malformed'
  | 'expert-mismatch'
  | 'not-ready'

export type ManagedPublicationReadResult =
  | { ok: true; publication: ManagedPersonaPublication }
  | { ok: false; code: 'installation-incomplete'; reason: ManagedPublicationProblemReason; message: string }

/**
 * 这个人格 id 是不是**受管**（安装器生成）的。
 *
 * 判据与 `isExpertId` 完全一致（`generated/<小写UUID>`）：这里单独起个名字是因为
 * "受管"是发布门的语义契约，而 `isExpertId` 是形状判定的名字；改名成 `isExpertId`
 * 会让"为什么发现链要在这里分叉"失去可读性。
 */
export function isManagedPersonaId(id: unknown): boolean {
  return isExpertId(id)
}

/** `generated/<uuid>`（**唯一**一处从 expertId 拼目录的地方）。 */
export function managedPersonaDirectoryPath(expertId: string): string {
  const uuid = expertUuidFromId(expertId)
  if (uuid === undefined) throw new Error(`不是受管人格 id：${expertId}`)
  return `${EXPERT_GENERATED_DIR_NAME}/${uuid}`
}

/** `generated/<uuid>/publication.json`（相对 personas 根）。 */
export function managedPublicationRelativePath(expertId: string): string {
  return `${managedPersonaDirectoryPath(expertId)}/${EXPERT_PUBLICATION_FILE_NAME}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

/**
 * 读并校验一份受管人格的发布门。
 *
 * **任何**不满足"版本 1 + expertId 一致 + ready=true + 三个字段形状正确"的情形都返回
 * `ok:false`，调用方（发现链）据此**跳过这份文档**并给出 `installation-incomplete`。
 * 这里绝不"降级读一个更宽松的版本"：中间态文件在磁盘上确实存在，而恰恰是它最危险。
 */
export function readManagedPersonaPublication(
  personasDir: string,
  expertId: unknown,
): ManagedPublicationReadResult {
  if (isExpertId(expertId) === false) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'not-managed-id',
      message: `不是受管人格 id（必须形如 generated/<小写UUID>）：${JSON.stringify(expertId)}`,
    }
  }
  const id = expertId as string
  const relative = managedPublicationRelativePath(id)
  const read = readExpertTextFile(personasDir, relative, { maxBytes: 64 * 1024 })
  if (read.ok === false || read.text === undefined) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'missing',
      message: `受管人格「${id}」缺少同名附件里的 ${EXPERT_PUBLICATION_FILE_NAME}（安装未完成或已被删除）：${read.problem?.message ?? '读不到'}。按发布门跳过该文档。`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(read.text) as unknown
  } catch (error) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'malformed',
      message: `${relative} 不是合法 JSON（${(error as Error).message}）；按发布门跳过该文档，不做任何修复。`,
    }
  }
  if (isPlainObject(parsed) === false) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'malformed',
      message: `${relative} 不是一个 JSON 对象；按发布门跳过该文档。`,
    }
  }
  if (parsed.version !== EXPERT_PUBLICATION_VERSION) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'malformed',
      message: `${relative} 的 version 是 ${JSON.stringify(parsed.version)}，本版只认 ${EXPERT_PUBLICATION_VERSION}；按发布门跳过该文档。`,
    }
  }
  if (parsed.expertId !== id) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'expert-mismatch',
      message: `${relative} 里的 expertId 是 ${JSON.stringify(parsed.expertId)}，与它所在目录对应的 ${id} 不一致；按发布门跳过该文档（不认一份指向别处的发布记录）。`,
    }
  }
  if (typeof parsed.installationId !== 'string' || isExpertUuid(parsed.installationId) === false) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'malformed',
      message: `${relative} 的 installationId 不是标准小写 UUID：${JSON.stringify(parsed.installationId)}；按发布门跳过该文档。`,
    }
  }
  if (typeof parsed.manifestHash !== 'string' || isSha256Hex(parsed.manifestHash) === false) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'malformed',
      message: `${relative} 的 manifestHash 不是 sha256 十六进制串；按发布门跳过该文档。`,
    }
  }
  if (typeof parsed.committedAt !== 'string' || parsed.committedAt === '') {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'malformed',
      message: `${relative} 的 committedAt 不是非空字符串；按发布门跳过该文档。`,
    }
  }
  if (parsed.ready !== true) {
    return {
      ok: false,
      code: 'installation-incomplete',
      reason: 'not-ready',
      message: `${relative} 的 ready 不是 true（${JSON.stringify(parsed.ready)}）；发布未完成，按发布门跳过该文档。`,
    }
  }

  return {
    ok: true,
    publication: {
      version: EXPERT_PUBLICATION_VERSION,
      expertId: id,
      installationId: parsed.installationId,
      manifestHash: parsed.manifestHash,
      committedAt: parsed.committedAt,
    },
  }
}

/**
 * 一个正式 skill 目录的**受管状态**（P4 的 provider 与 P3 的安装器共用这一份判定）。
 *
 * provider 的规则（§6.2 末段）：目录里带 `workbench-install.json` 的 skill 属于工作台安装，
 * 必须**同时**确认它关联的人格 `publication.json` 已 ready，才允许 list/get。没有 ready 就
 * 当成不存在 —— 否则一个"安装到一半"的方法论会被别的会话当成可调用技能挂上去。
 */
export interface ManagedSkillInstallState {
  /** 目录里有没有工作台管理清单（没有 = 旧手工技能，门不管它）。 */
  managed: boolean
  skillName: string
  /** 管理清单里的字段（`managed` 且形状正确时才有）。 */
  expertId?: string
  installationId?: string
  packageHash?: string
  /** 管理清单里登记的包内文件（相对 skill 根，不含管理文件自身）。 */
  files?: Array<{ path: string; bytes: number; sha256: string }>
  /** 关联人格的发布门是否 ready；`managed === false` 时恒为 false（不可由工作台装载）。 */
  ready: boolean
  /** 管理清单本身坏掉/关联人格未 ready 时的原因（调用方**不要**据此修复，只据此跳过）。 */
  problem?: { code: ExpertErrorCode; message: string }
}

/**
 * 读一个正式 skill 目录的管理清单并对照它关联的人格发布门。
 *
 * 返回 `managed: false`（无 problem）表示"这不是工作台装的技能"——**旧手工技能的正常状态**，
 * 调用方应当照旧读它（发现链与 P2 的 `readExistingSkillInstall` 都依赖这个区分）。
 */
export function readManagedSkillInstallState(
  skillsDir: string,
  personasDir: string,
  skillName: unknown,
): ManagedSkillInstallState {
  if (isExpertSkillName(skillName) === false) {
    return {
      managed: false,
      skillName: typeof skillName === 'string' ? skillName : '',
      ready: false,
      problem: { code: 'invalid-path', message: `skill 名必须是小写 kebab-case（1–64 字符）：${JSON.stringify(skillName)}` },
    }
  }
  const name = skillName as string
  const relative = `${name}/${EXPERT_SKILL_INSTALL_FILE_NAME}`
  const read = readExpertTextFile(skillsDir, relative, { maxBytes: 64 * 1024 })
  if (read.ok === false || read.text === undefined) {
    /** 读不回来 = 没有管理清单。**坏掉的清单**（下面）才是问题。 */
    return { managed: false, skillName: name, ready: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(read.text) as unknown
  } catch (error) {
    return {
      managed: true,
      skillName: name,
      ready: false,
      problem: {
        code: 'skill-package-invalid',
        message: `${relative} 不是合法 JSON（${(error as Error).message}）；按发布门把该技能当成不可用（不做任何修复）。`,
      },
    }
  }
  if (isPlainObject(parsed) === false) {
    return {
      managed: true,
      skillName: name,
      ready: false,
      problem: { code: 'skill-package-invalid', message: `${relative} 不是一个 JSON 对象；按发布门把该技能当成不可用。` },
    }
  }
  const problems: string[] = []
  if (parsed.version !== EXPERT_SKILL_INSTALL_VERSION) {
    problems.push(`version=${JSON.stringify(parsed.version)}（只认 ${EXPERT_SKILL_INSTALL_VERSION}）`)
  }
  if (parsed.name !== name) problems.push(`name=${JSON.stringify(parsed.name)} 与目录名「${name}」不一致`)
  if (isExpertId(parsed.expertId) === false) problems.push(`expertId=${JSON.stringify(parsed.expertId)} 不是 generated/<UUID>`)
  if (typeof parsed.installationId !== 'string' || isExpertUuid(parsed.installationId) === false) {
    problems.push(`installationId=${JSON.stringify(parsed.installationId)} 不是标准小写 UUID`)
  }
  if (typeof parsed.packageHash !== 'string' || isSha256Hex(parsed.packageHash) === false) {
    problems.push('packageHash 不是 sha256 十六进制串')
  }
  if (Array.isArray(parsed.files) === false) problems.push('files 不是数组')
  if (problems.length > 0) {
    return {
      managed: true,
      skillName: name,
      ready: false,
      problem: { code: 'skill-package-invalid', message: `${relative} 形状不完整：${problems.join('；')}；按发布门把该技能当成不可用。` },
    }
  }
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  for (const item of parsed.files as unknown[]) {
    if (isPlainObject(item) === false
      || typeof item.path !== 'string'
      || typeof item.bytes !== 'number'
      || typeof item.sha256 !== 'string') {
      return {
        managed: true,
        skillName: name,
        ready: false,
        problem: { code: 'skill-package-invalid', message: `${relative} 的 files 里有形状不对的条目；按发布门把该技能当成不可用。` },
      }
    }
    files.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 })
  }

  const expertId = parsed.expertId as string
  const publication = readManagedPersonaPublication(personasDir, expertId)
  if (publication.ok === false) {
    return {
      managed: true,
      skillName: name,
      expertId,
      installationId: parsed.installationId as string,
      packageHash: parsed.packageHash as string,
      files,
      ready: false,
      problem: {
        code: 'installation-incomplete',
        message: `技能「${name}」由受管人格 ${expertId} 安装，但该人格的发布门未就绪：${publication.message}`,
      },
    }
  }
  return {
    managed: true,
    skillName: name,
    expertId,
    installationId: parsed.installationId as string,
    packageHash: parsed.packageHash as string,
    files,
    ready: true,
  }
}
