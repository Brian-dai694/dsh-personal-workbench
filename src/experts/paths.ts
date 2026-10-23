/**
 * 专家域的**文件边界**：根解析、路径形状与链接检查、原子文本写入、跨进程安装锁。
 *
 * ## 为什么这个文件必须"啰嗦"
 *
 * 它是**唯一**允许往用户主目录写专家文件的地方。写错一个路径就可能覆盖 `~/.ssh` 里的
 * 东西，或者顺着一个 junction 把文件写到根之外。所以每道检查都独立成步、各有明确
 * 拒绝理由与**稳定 code**（规格 §3.4），而不是"一句 resolve + startsWith 就完事"：
 *
 * 1. **根只能由构造参数注入**（`resolveExpertRoots({home})`）：生产从 `homedir()` 与
 *    既有目录约定算出来，HTTP/工具**没有**任意根覆盖参数 —— 否则"根内"这个概念就没有意义了；
 * 2. **形状拒绝**（不碰文件系统）：盘符、UNC、绝对路径、反斜杠、空段、`.`、`..`、NUL、
 *    百分号编码、Windows 保留名、尾部点/空格、非法扩展名、超深、保留文件名；
 * 3. **逐段 `lstat`**：根与中间每一级是符号链接/junction 就拒绝（**即使在根内也拒绝**）；
 * 4. **`realpath` 复校**：最近存在祖先的真实路径仍必须在根内（防"根自己是个链接"）；
 * 5. **原子写入**：同目录随机名 + `wx` 创建 → `write` → `fsync` → `rename`；
 *    失败只清理**本次操作拥有**的临时文件。
 *
 * 不 import React、不 import 宿主 SDK、不碰任何宿主服务。
 */
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync, writeSync, constants as fsConstants, type Stats,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { homedir, hostname as osHostname } from 'node:os'
import { defaultUserPersonaRoot } from '../personas/library.js'
import {
  EXPERT_INSTALL_LOCK_FILE_NAME,
  EXPERT_RESERVED_FILE_NAMES,
  EXPERT_RESOURCE_MAX_DEPTH,
  EXPERT_STAGED_FILE_MAX_BYTES,
  isExpertSkillName,
  type ExpertErrorCode,
  type ExpertFileArea,
  type ExpertIssue,
} from '../shared/expert.js'
import { PERSONA_RESOURCE_EXTENSIONS } from '../shared/persona.js'

// ---------------------------------------------------------------------------
// 根
// ---------------------------------------------------------------------------

export interface ExpertRootOptions {
  /** 用户主目录（**只给测试用**的注入点；生产缺省 `homedir()`）。 */
  home?: string
  /** 用户库 personas 根的显式覆盖（测试用；生产不传）。 */
  personasDir?: string
  /** skills 根的显式覆盖（测试用；生产不传）。 */
  skillsDir?: string
}

export interface ExpertRoots {
  /** `~/.dsh/workbench/personas` */
  personasDir: string
  /** `~/.dsh/workbench/skills` */
  skillsDir: string
  /** `~/.dsh/workbench/personas/.install.lock` */
  installLockPath: string
}

/**
 * 解析两个根。**唯一一处**：沿用既有目录约定（`defaultUserPersonaRoot`），
 * 不在别处再拼一套 `~/.dsh/workbench/...`。
 *
 * ⚠️ 根**只从这里的参数注入**：HTTP / 工具层没有任何"传一个根进来"的参数，
 * 否则"路径必须在根内"这条边界就形同虚设。
 */
export function resolveExpertRoots(options: ExpertRootOptions = {}): ExpertRoots {
  const home = options.home ?? homedir()
  const personasDir = resolve(options.personasDir ?? defaultUserPersonaRoot(home))
  const skillsDir = resolve(options.skillsDir ?? join(home, '.dsh', 'workbench', 'skills'))
  return { personasDir, skillsDir, installLockPath: join(personasDir, EXPERT_INSTALL_LOCK_FILE_NAME) }
}

/** 某个 area 对应的正式根。 */
export function rootForArea(roots: ExpertRoots, area: 'persona' | 'skill'): string {
  return area === 'skill' ? roots.skillsDir : roots.personasDir
}

// ---------------------------------------------------------------------------
// 路径形状（纯函数，不碰文件系统）
// ---------------------------------------------------------------------------

export interface ExpertPathProblem {
  code: ExpertErrorCode
  message: string
}

const RESERVED_WINDOWS_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/**
 * 文本扩展名白名单判定（**导出**：来源校验也要用同一把尺子判 `licenseFile`，
 * 各写一份必然漂移成"路径校验放行、来源校验拒绝"）。
 */
export function hasAllowedTextExtension(name: string): boolean {
  const lower = name.toLowerCase()
  return PERSONA_RESOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * 纯形状判定：`undefined` = 通过，否则给稳定 code + 可读原因。
 *
 * **任何百分号都拒绝**（不"解码后再判"）：`%2e%2e%2f` / `%252f` 这类多次编码没有穷尽，
 * 而"解码后再判"要求判定逻辑与解码实现永远同步 —— 差一个变体就漏。
 */
export function checkExpertRelativePathShape(
  area: ExpertFileArea,
  relativePath: unknown,
  options: { platform?: string; allowReservedNames?: readonly string[] } = {},
): ExpertPathProblem | undefined {
  const allowReservedNames = options.allowReservedNames ?? []
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    return { code: 'invalid-path', message: '路径必须是非空字符串' }
  }
  const raw = relativePath
  if (raw.trim() !== raw) return { code: 'invalid-path', message: '路径首尾不得有空白' }
  /**
   * 控制字符（含 NUL、CR、LF、DEL）一律拒。
   *
   * 为什么连 `\r`/`\n` 一起拒：它们不止能拼出 NUL 截断，还能在把路径写进
   * 日志/清单/命令行时**伪造出下一行**（"看起来像两条记录"），或在 Windows 上
   * 被静默截断 —— 而非法字符不该有任何"被静默处理"的机会。
   */
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { code: 'invalid-path', message: '路径含控制字符（NUL / 换行 / 回车 / DEL 等），拒绝' }
  }
  if (raw.includes('%')) {
    return { code: 'invalid-path', message: '路径含百分号编码（`%`），按边界一律拒绝（防编码绕过）' }
  }
  if (raw.includes('\\')) {
    return { code: 'invalid-path', message: '路径必须用 `/` 分隔：拒绝反斜杠（Windows 上会被当成同一条路径）' }
  }
  if (raw.startsWith('/')) return { code: 'invalid-path', message: '必须是相对路径：拒绝绝对路径' }
  if (raw.endsWith('/')) return { code: 'invalid-path', message: '路径不得以 `/` 结尾（目录不带尾部斜杠）' }
  if (/^[A-Za-z]:/.test(raw)) return { code: 'invalid-path', message: '必须是相对路径：拒绝盘符（如 `C:`）' }

  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment === '') {
      return { code: 'invalid-path', message: `路径含空段（连续 \`/\`）：${raw}` }
    }
    if (segment === '.' || segment === '..') {
      return { code: 'invalid-path', message: `路径含 \`${segment}\` 段，拒绝（不许越出根）` }
    }
    if (segment.normalize('NFC') !== segment) {
      return { code: 'invalid-path', message: `路径段必须是 NFC 形式：${segment}` }
    }
    if (/[. ]$/.test(segment)) {
      return { code: 'invalid-path', message: `路径段不得以点或空格结尾（Windows 会静默改写）：${segment}` }
    }
    const dot = segment.indexOf('.')
    const stem = (dot === -1 ? segment : segment.slice(0, dot)).toLowerCase()
    if (RESERVED_WINDOWS_BASENAMES.has(stem)) {
      return { code: 'invalid-path', message: `路径段是 Windows 保留名，拒绝：${segment}` }
    }
    if (EXPERT_RESERVED_FILE_NAMES.includes(segment) && allowReservedNames.includes(segment) === false) {
      return { code: 'invalid-path', message: `「${segment}」是安装器保留名，模型不得写入` }
    }
  }

  if (area === 'persona-resource') {
    if (segments.length > EXPERT_RESOURCE_MAX_DEPTH) {
      return {
        code: 'invalid-path',
        message: `人格资源路径最多 ${EXPERT_RESOURCE_MAX_DEPTH} 层，收到 ${segments.length} 层：${raw}`,
      }
    }
  } else {
    const skillName = segments[0] ?? ''
    if (segments.length < 2) {
      return { code: 'invalid-path', message: `skill 路径必须形如 <skillName>/<相对路径>：${raw}` }
    }
    if (isExpertSkillName(skillName) === false) {
      return {
        code: 'invalid-path',
        message: `skill 名必须是小写 kebab-case（1–64 字符）：「${skillName}」`,
      }
    }
  }

  const fileName = segments[segments.length - 1]
  if (fileName === undefined || fileName === '') {
    return { code: 'invalid-path', message: `路径没有文件名：${raw}` }
  }
  if (hasAllowedTextExtension(fileName) === false) {
    return {
      code: 'invalid-path',
      message: `只允许文本扩展名 ${PERSONA_RESOURCE_EXTENSIONS.join(' / ')}：${fileName}`,
    }
  }
  return undefined
}

/**
 * 比较键：Windows/macOS 大小写不敏感 + NFC + `/` 分隔 + 去尾部点/空格。
 *
 * 唯一用途是判"**两个不同写法会不会落到同一个文件**"。思路与 `personaCompareKey` 同源，
 * 差别是这里必须**同时**折掉尾部点/空格（`a.md.` 与 `a.md` 在 Windows 上是同一个文件）。
 */
export function expertPathCompareKey(area: ExpertFileArea, relativePath: string, platform: string = process.platform): string {
  const segments = relativePath.split('/').map((segment) => {
    /**
     * 尾部点/空格在 Windows 上会被**静默丢弃**（`a.md.` 与 `a.md` 落到同一个文件），
     * 所以比较键必须先折掉它们 —— 否则"两个写法不同、落点相同"的路径会被当成两条，
     * 后面就会真的互相覆盖。
     */
    const nfc = segment.replace(/[. ]+$/, '').normalize('NFC')
    return platform === 'win32' || platform === 'darwin' ? nfc.toLowerCase() : nfc
  })
  return `${area}:${segments.join('/')}`
}

/**
 * 路径校验（形状 + 与既有集合的**同路径碰撞**）。
 *
 * @param existing 同 area 的既有路径（暂存索引里的相对路径）
 * @param self 本次要写入的路径（更新场景下传它自己，避免"与自身碰撞"）
 */
export function validateExpertRelativePath(
  area: ExpertFileArea,
  relativePath: unknown,
  options: { platform?: string; existing?: readonly string[]; self?: string; allowReservedNames?: readonly string[] } = {},
): ExpertPathProblem | undefined {
  const platform = options.platform ?? process.platform
  const shape = checkExpertRelativePathShape(area, relativePath, {
    platform,
    ...(options.allowReservedNames === undefined ? {} : { allowReservedNames: options.allowReservedNames }),
  })
  if (shape !== undefined) return shape
  const raw = relativePath as string
  const key = expertPathCompareKey(area, raw, platform)
  for (const other of options.existing ?? []) {
    if (options.self !== undefined && other === options.self) continue
    if (expertPathCompareKey(area, other, platform) === key) {
      return {
        code: 'invalid-path',
        message: `路径与既有文件「${other}」在 ${platform} 上是同一条（NFC/大小写/尾部点空格折叠后相同），拒绝`,
      }
    }
  }
  return undefined
}

/**
 * 暂存文件的**尺寸**校验（只判字节；字符上限是可选参数）。
 *
 * 规格只对暂存文件规定"每份 128 KiB UTF-8 字节（仅文本）"，**没有** 20000 字符的暂存门槛，
 * 而且 §3.4/§3.1 明确"归档原件可能超过资源工具的 20000 字符上限，仍保留完整文件"。
 * 所以默认**只判字节**：`maxChars` 不传就不判 —— 否则正文类之外的大文本（归档原件、
 * 完整许可文件）会在暂存阶段被拒，让"超限只给 warning、不截断"那条路径根本不可达。
 * 调用方要判正文类上限时显式传 `maxChars`（例如 `EXPERT_STAGED_FILE_MAX_CHARS`）。
 */
export function validateStagedFileContent(
  path: string,
  bytes: number,
  options: { text?: string; maxChars?: number } = {},
): ExpertPathProblem | undefined {
  if (!Number.isInteger(bytes) || bytes < 0) {
    return { code: 'invalid-payload', message: `暂存文件字节数非法：${String(bytes)}` }
  }
  if (bytes > EXPERT_STAGED_FILE_MAX_BYTES) {
    return {
      code: 'file-too-large',
      message: `暂存文件 ${path} 有 ${bytes} 字节，超过上限 ${EXPERT_STAGED_FILE_MAX_BYTES} 字节（128 KiB）`,
    }
  }
  const maxChars = options.maxChars
  if (maxChars !== undefined && options.text !== undefined && options.text.length > maxChars) {
    return {
      code: 'file-too-large',
      message: `暂存文件 ${path} 有 ${options.text.length} 字符，超过上限 ${maxChars} 字符`,
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 根内判定与链接检查
// ---------------------------------------------------------------------------

/**
 * 是否位于根内。判定用**字符串相对路径**而不是 `startsWith`：
 * `C:\root2`.startsWith(`C:\root`) 是 true，但那显然在根外。
 */
export function isInsideExpertRoot(root: string, candidate: string, platform: string = process.platform): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const rel = relative(resolvedRoot, resolvedCandidate)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  if (rel.includes(`..${sep}`)) return false
  if (/^[A-Za-z]:/.test(rel)) return false
  if (platform === 'win32' || platform === 'darwin') {
    return relative(resolvedRoot.toLowerCase(), resolvedCandidate.toLowerCase()).startsWith('..') === false
  }
  return true
}

/** 从根开始逐段 `lstat`；遇到第一级不存在就停下（返回已存在的那条链）。 */
function lstatChain(root: string, relativePath: string): Array<{ path: string; stats: Stats }> {
  const chain: Array<{ path: string; stats: Stats }> = []
  let current = root
  try {
    chain.push({ path: current, stats: lstatSync(current) })
  } catch {
    return []
  }
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    try {
      chain.push({ path: current, stats: lstatSync(current) })
    } catch {
      return chain
    }
  }
  return chain
}

/**
 * 拒绝"根 / 任一中间目录 / 目标文件是链接"。
 *
 * 要点（规格 §3.4）：**即使链接目标仍在根内也拒绝** —— 链接意味着"这条路径的落点
 * 不由路径本身决定"，一旦允许，之后所有基于路径的判定都不再可信。
 * 判定用 `lstatSync().isSymbolicLink()`：**junction 也走这条**
 * （Node 上 junction 被报成符号链接，`readlink` 结果带 `\\?\` 前缀）。
 *
 * **根这一层是 fail-closed 的**：默认连根是链接也拒。只有调用方显式给出包含边界
 * （`allowRootLinkUnder`，来自构造时注入的工作台根/用户主目录）才可能放行 ——
 * 凭"函数自己看到的路径"无法判断一个链接是"用户的合法布局"还是"链接绑架"。
 *
 * 不存在的层级不算错误 —— 由调用方决定"是否要创建它"（创建后必须**再查一次**）。
 */
export function assertNoLinksInsideRoot(
  root: string,
  relativePath: string,
  options: AssertNoLinksOptions = {},
): { ok: true } | { ok: false; problem: ExpertPathProblem } {
  return assertNoLinksInPaths(root, [relativePath], options)
}

/** 链接校验的选项：`allowRootLinkUnder` 是放行"根是链接"时要求的包含边界（绝对路径）。 */
export interface AssertNoLinksOptions {
  /**
   * 根**自己**可以是链接，但它的真实落点必须在这个边界之内（例如用户的 home / 工作台数据根）。
   *
   * 只有边界来自**注入的构造参数**时才是可信的；调用方不能拿"根自己"当边界，
   * 否则等于把"这个链接指向哪里"当作自己的判据（自证），挡不住链接绑架。
   */
  allowRootLinkUnder?: string
  /** 平台（测试注入，默认当前平台）。 */
  platform?: string
}

/**
 * 批量版本（一次算链、每个相对路径逐段判）。
 *
 * 独立成函数而不是"循环调单条"：安装器要一次校验几十条路径，逐条调会把根目录
 * 反复 `lstat`，既有开销也放大 TOCTOU 窗口。
 */
export function assertNoLinksInPaths(
  root: string,
  relativePaths: readonly string[],
  options: AssertNoLinksOptions = {},
): { ok: true } | { ok: false; problem: ExpertPathProblem } {
  const platform = options.platform ?? process.platform
  const resolvedRoot = resolve(root)
  const chains = relativePaths.map((relativePath) => lstatChain(resolvedRoot, relativePath))

  /** 根是不是链接：直接对解析出的根做 lstat（chain[0] 可能是子路径，不能拿它代替）。 */
  let rootIsLink = false
  try {
    rootIsLink = lstatSync(resolvedRoot).isSymbolicLink()
  } catch {
    /** 根还不存在：没有链接可言。 */
    rootIsLink = false
  }

  if (rootIsLink) {
    const boundary = options.allowRootLinkUnder
    if (boundary === undefined) {
      return {
        ok: false,
        problem: {
          code: 'path-link-forbidden',
          message: `工作台根「${resolvedRoot}」是符号链接/junction；未给出包含边界时不放行（无法区分合法布局与链接绑架）`,
        },
      }
    }
    let realRoot: string
    try {
      realRoot = realpathSync(resolvedRoot)
    } catch {
      return { ok: false, problem: { code: 'invalid-path', message: `根的真实化失败（读不到根）：${resolvedRoot}` } }
    }
    let anchor: string
    try {
      anchor = realpathSync(resolve(boundary))
    } catch {
      return { ok: false, problem: { code: 'invalid-path', message: `包含边界无法真实化：${boundary}` } }
    }
    if (isInsideExpertRoot(anchor, realRoot, platform) === false) {
      return {
        ok: false,
        problem: {
          code: 'path-link-forbidden',
          message: `根「${resolvedRoot}」是指向包含边界之外的链接（真实根 ${realRoot} 不在 ${anchor} 内），拒绝`,
        },
      }
    }
    /**
     * 根是链接但真实落点在边界内 —— **只豁免"根这一层"**，绝不在此提前返回：
     * 规格（§3.4）要求根**及已有父目录**都不是链接。根被放行后，下面照样要
     * 逐段判中间级、照样要做 realpath 复校（基准是 `realpathSync(根)`）。
     * 提前 return 会让"根是链接 + 中间某级是指向根外的 junction"整段漏检。
     */
  }

  for (const chain of chains) {
    for (const [index, entry] of chain.entries()) {
      if (index === 0) continue
      if (entry.stats.isSymbolicLink()) {
        return {
          ok: false,
          problem: {
            code: 'path-link-forbidden',
            message: `路径中的「${entry.path}」是符号链接/junction，按边界拒绝（即使链接目标仍在根内）`,
          },
        }
      }
    }
  }
  /**
   * realpath 复校：拿**真实根**做基准（不是 `resolvedRoot`）。
   *
   * 比什么：最近存在祖先的 realpath 是否落在「真实根」之下。两种越界都能逮住 ——
   * ①根本身是指向根外的链接（上面已单独判过）；②中间某级是指向根外的链接（且它已在上面被拒，这里是双保险）。
   * 拿 `resolvedRoot`（未 realpath）当基准则**漏掉**情形 ①：`resolvedRoot` 是链接，
   * 而在链接下拼出来的子路径 realpath 之后落在**链接目标**里，两者永不相交。
   */
  let effectiveRoot = resolvedRoot
  try {
    effectiveRoot = realpathSync(resolvedRoot)
  } catch {
    /** 根还不存在（全新安装）：没有真实路径可比，用解析值兜底。 */
  }
  for (const [index, chain] of chains.entries()) {
    if (chain.length === 0) continue
    const nearest = chain[chain.length - 1]
    if (nearest === undefined) continue
    let real: string
    try {
      real = realpathSync(nearest.path)
    } catch {
      return { ok: false, problem: { code: 'invalid-path', message: `路径的真实化失败（读不到父目录）：${nearest.path}` } }
    }
    if (isInsideExpertRoot(effectiveRoot, real, platform) === false) {
      return {
        ok: false,
        problem: {
          code: 'path-link-forbidden',
          message: `路径「${relativePaths[index] ?? ''}」的真实路径越出根（realpath 复校失败）：${real}`,
        },
      }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 原子文本写入
// ---------------------------------------------------------------------------

export type AtomicWriteResult =
  | { ok: true; path: string; bytes: number; sha256: string; createdDirectories: string[] }
  | { ok: false; problem: ExpertPathProblem }

export interface AtomicWriteOptions {
  /** 显式根；给了就先做边界检查并自动建父目录（**生产一律传它**）。 */
  root?: string
  /** 允许覆盖已存在文件；缺省 `true`（`rename` 天生动替换）。 */
  overwrite?: boolean
  /**
   * 根**自己**是链接时的包含边界（构造参数注入的 home / 数据根）。
   *
   * 缺省不传 = 根是链接就拒（fail-closed）。只有调用方拿着注入的边界时才传它，
   * 这样"根是链接放行"这件事永远由一个外部事实决定，而不是由根自己自证。
   */
  allowRootLinkUnder?: string
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 从根到 `directory` 逐级 `mkdirSync`，返回**本次新建**的目录（供回滚）。 */
function ensureDirectories(root: string, directory: string): { ok: true; created: string[] } | { ok: false; problem: ExpertPathProblem } {
  const chain: string[] = []
  let current = directory
  while (resolve(current) !== resolve(root)) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) {
      return { ok: false, problem: { code: 'invalid-path', message: `目录不在根内：${directory}` } }
    }
    current = parent
  }
  const created: string[] = []
  for (const path of chain.reverse()) {
    try {
      mkdirSync(path)
      created.push(path)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'EEXIST') {
        let stats: Stats
        try {
          stats = lstatSync(path)
        } catch {
          return { ok: false, problem: { code: 'invalid-path', message: `目录状态读不到：${path}` } }
        }
        if (stats.isSymbolicLink()) {
          return { ok: false, problem: { code: 'path-link-forbidden', message: `目录是符号链接/junction，拒绝：${path}` } }
        }
        if (stats.isDirectory() === false) {
          return { ok: false, problem: { code: 'invalid-path', message: `同名路径不是目录，拒绝：${path}` } }
        }
        continue
      }
      return {
        ok: false,
        problem: { code: 'invalid-path', message: `创建目录失败：${path}（${error instanceof Error ? error.message : String(error)}）` },
      }
    }
  }
  return { ok: true, created }
}

/**
 * 原子写一个 UTF-8 文本文件。
 *
 * 顺序（规格 §3.4 最后一条）：同目录随机名 + `wx` 创建 → `write` → `fsync` → `rename`。
 * **失败只清理本操作拥有的临时文件**（随机名只在本函数内可见，所以"拥有"是可判定的）。
 *
 * 传了 `root` 时会先过边界检查、再逐级建父目录、建完**再查一次链接**：
 * `mkdir` 自身不跟随链接创建，但某一级若在检查之后才被换成链接，只有再查一次才能发现。
 */
export function atomicWriteText(targetPath: string, content: string, options: AtomicWriteOptions = {}): AtomicWriteResult {
  const target = resolve(targetPath)
  let createdDirectories: string[] = []
  if (options.root !== undefined) {
    const root = resolve(options.root)
    const relativeTarget = relative(root, target)
    if (relativeTarget === '' || relativeTarget.startsWith('..') || /^[A-Za-z]:/.test(relativeTarget)) {
      return { ok: false, problem: { code: 'invalid-path', message: `目标不在根内：${target}` } }
    }
    const relativeForCheck = relativeTarget.split(sep).join('/')
    const linkOptions: AssertNoLinksOptions = options.allowRootLinkUnder === undefined
      ? {}
      : { allowRootLinkUnder: options.allowRootLinkUnder }
    const linkCheck = assertNoLinksInsideRoot(root, relativeForCheck, linkOptions)
    if (linkCheck.ok === false) return { ok: false, problem: linkCheck.problem }
    const mkdirResult = ensureDirectories(root, dirname(target))
    if (mkdirResult.ok === false) return { ok: false, problem: mkdirResult.problem }
    createdDirectories = mkdirResult.created
    const recheck = assertNoLinksInsideRoot(root, relativeForCheck, linkOptions)
    if (recheck.ok === false) return { ok: false, problem: recheck.problem }
  } else {
    mkdirSync(dirname(target), { recursive: true })
  }

  const directory = dirname(target)
  const base = target.slice(directory.length + 1)
  const temporary = join(directory, `.${base}.${randomBytes(8).toString('hex')}.tmp`)
  const buffer = Buffer.from(content, 'utf8')
  let handle: number | undefined
  try {
    handle = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    writeSync(handle, buffer, 0, buffer.length, 0)
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    /**
     * 最终文件也不能是链接：`rename` 在 POSIX 上会**替换**链接本身（把链接换成普通文件），
     * 在 Windows 上则会失败。显式拒绝比依赖平台差异清楚。
     */
    try {
      if (lstatSync(target).isSymbolicLink()) {
        unlinkSync(temporary)
        return { ok: false, problem: { code: 'path-link-forbidden', message: `目标文件是符号链接/junction，拒绝写入：${target}` } }
      }
      if (options.overwrite === false) {
        unlinkSync(temporary)
        return { ok: false, problem: { code: 'invalid-path', message: `目标文件已存在且不允许覆盖：${target}` } }
      }
    } catch (error) {
      if (error instanceof Error && (error as { code?: string }).code === 'ENOENT') {
        /** 不存在 = 正常的新建路径。 */
      }
    }
    renameSync(temporary, target)
    return { ok: true, path: target, bytes: buffer.length, sha256: sha256Of(buffer), createdDirectories }
  } catch (error) {
    if (handle !== undefined) {
      try { closeSync(handle) } catch { /* 已经关掉无所谓 */ }
    }
    try { unlinkSync(temporary) } catch { /* 临时文件没建起来 */ }
    return {
      ok: false,
      problem: {
        code: 'invalid-path',
        message: `原子写入失败：${target}（${error instanceof Error ? error.message : String(error)}）`,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// 跨进程安装锁
// ---------------------------------------------------------------------------

export interface ExpertLockOwner {
  /** 持有者进程 id。 */
  pid: number
  /** 持有者主机名；不同主机上 pid 不可比。 */
  hostname: string
  /** 本次持锁的随机身份（释放时用它确认"锁还是我的"）。 */
  token: string
  /** 加锁时间（ISO）。 */
  acquiredAt: string
  /** 这次安装属于哪份草稿（规格 §3.2 的锁记录字段；旧记录可能没有，故可选）。 */
  draftId?: string
}

export interface ExpertLockHandle {
  owner: ExpertLockOwner
  /** 释放（幂等；别人的锁**不会**被释放）。 */
  release(): void
}

export type ExpertLockFailureCode = 'install-busy' | 'install-in-progress' | 'install-lock-owner-unknown' | 'invalid-path'

export type ExpertLockAcquireResult =
  | { ok: true; handle: ExpertLockHandle }
  | { ok: false; code: ExpertLockFailureCode; message: string }

export type ExpertInstallLockResult<T> =
  | { ok: true; handle: ExpertLockHandle; value: T }
  | { ok: false; code: ExpertLockFailureCode; message: string }

export interface ExpertInstallLockOptions {
  /** 锁文件路径；缺省 `<personasDir>/.install.lock`（由 `resolveExpertRoots` 给出）。 */
  lockPath?: string
  /** 持锁者主机名（测试可注入）。缺省 `os.hostname()`。 */
  hostname?: string
  /**
   * 进程存活判定（**测试注入点**）。
   *
   * 为什么必须可注入：真实"死 owner"要靠杀进程来造，测试里既慢又不可靠；
   * 而"死锁可回收"正是这条锁最危险的语义，必须有会红的测试。
   * 返回 `undefined` = **状态不明**（此时**绝不**回收）。
   */
  isProcessAlive?: (pid: number) => boolean | undefined
  /** 本进程 pid（测试可注入）。 */
  pid?: number
  /** 这次安装属于哪份草稿；给了就写进锁记录（诊断"谁在装"用，缺省不写）。 */
  draftId?: string
  now?: () => string
}

/** 默认存活判定：`EPERM` 表示"进程存在但没权限查"（**存在**），`ESRCH` 才是真的没了。 */
export function defaultIsProcessAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return undefined
  }
}

function readLockOwner(lockPath: string): { ok: true; owner: ExpertLockOwner } | { ok: false; reason: 'unreadable' | 'malformed' } {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'malformed' }
  const record = parsed as Partial<ExpertLockOwner>
  if (Number.isInteger(record.pid) === false
    || typeof record.hostname !== 'string' || record.hostname === ''
    || typeof record.token !== 'string' || record.token === '') {
    return { ok: false, reason: 'malformed' }
  }
  return {
    ok: true,
    owner: {
      pid: record.pid as number,
      hostname: record.hostname,
      token: record.token,
      acquiredAt: typeof record.acquiredAt === 'string' ? record.acquiredAt : '',
      /** 可选字段：只有写过的记录才有（旧记录不带，不算 malformed）。 */
      ...(typeof record.draftId === 'string' && record.draftId !== '' ? { draftId: record.draftId } : {}),
    },
  }
}

/**
 * 取一次跨进程安装锁（**不执行**任何回调；给需要先判定再决定的调用方用）。
 *
 * 规格 §6.3 / AX-E23 的三档判定：
 *
 * | 锁文件 | 判定 | 结果 |
 * |---|---|---|
 * | 不存在 | — | 抢锁（`wx` 创建，天然互斥） |
 * | 活 owner（同主机且进程在） | 活锁 | 普通安装 → `install-busy`；恢复 → `install-in-progress` |
 * | 死 owner（同主机、进程已退出） | 死锁 | **可回收**：删掉后重抢 |
 * | 文件读不了 / 形状坏 / 别的主机 / 进程状态不明 | 状态不明 | `install-lock-owner-unknown`，**绝不强删** |
 *
 * `mode: 'recovery'` 只改**活锁**的错误码：恢复路径上"有人在装"与"用户又点了一次确认"
 * 需要被区分开。本函数不抛异常 —— 锁失败是**控制流**，不是异常。
 */
export function acquireExpertInstallLock(options: ExpertInstallLockOptions & { mode?: 'install' | 'recovery' } = {}): ExpertLockAcquireResult {
  const lockPath = options.lockPath ?? resolveExpertRoots().installLockPath
  const mode = options.mode ?? 'install'
  const pid = options.pid ?? process.pid
  const hostname = options.hostname ?? osHostname()
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const now = options.now ?? (() => new Date().toISOString())

  const attempt = (): ExpertLockHandle | undefined => {
    const token = randomBytes(16).toString('hex')
    /** 锁记录字段（规格）：pid + owner 随机值 + draftId + createdAt；`draftId` 缺省不写。 */
    const owner: ExpertLockOwner = options.draftId === undefined
      ? { pid, hostname, token, acquiredAt: now() }
      : { pid, hostname, token, acquiredAt: now(), draftId: options.draftId }
    try {
      mkdirSync(dirname(lockPath), { recursive: true })
      writeFileSync(lockPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') return undefined
      throw error
    }
    /**
     * 释放时**重新读盘比对 token**，而不是无脑删。
     *
     * 为什么必须比对：锁可能已经被回收（死 owner 被后来者清掉）并**被新的持有者重新创建**，
     * 此时无脑 `unlink` 会删掉**别人的**锁，让两个安装同时进入临界区。
     * 比对基准是本句柄创建时的 token：句柄一旦丢失（进程崩溃后别的持有者重建了锁），
     * 或者句柄压根不是这把锁的（拿错对象），都对不上，于是不动手。
     */
    const handle: ExpertLockHandle = {
      owner,
      release: () => {
        const current = readLockOwner(lockPath)
        if (current.ok === true && current.owner.token !== token) return
        try { unlinkSync(lockPath) } catch { /* 已经被回收或删掉 */ }
      },
    }
    return handle
  }

  const created = attempt()
  if (created !== undefined) return { ok: true, handle: created }

  const existing = readLockOwner(lockPath)
  if (existing.ok === false) {
    return {
      ok: false,
      code: 'install-lock-owner-unknown',
      message: existing.reason === 'unreadable'
        ? `安装锁存在但读不了（${lockPath}）；不确认持有者时不会强行回收，请人工检查`
        : `安装锁内容不是合法持有者记录（${lockPath}）；不确认持有者时不会强行回收，请人工检查`,
    }
  }
  const owner = existing.owner
  if (owner.hostname !== hostname) {
    return {
      ok: false,
      code: 'install-lock-owner-unknown',
      message: `安装锁由另一台主机（${owner.hostname}，pid ${owner.pid}）持有；跨主机无法判定存活，不做回收`,
    }
  }
  const alive = isAlive(owner.pid)
  if (alive === undefined) {
    return {
      ok: false,
      code: 'install-lock-owner-unknown',
      message: `安装锁持有者 pid ${owner.pid} 的状态无法判定；与"死锁"区分不开，不做回收`,
    }
  }
  if (alive === true) {
    return {
      ok: false,
      code: mode === 'recovery' ? 'install-in-progress' : 'install-busy',
      message: mode === 'recovery'
        ? `另一次安装正在进行（pid ${owner.pid}）；恢复不抢活锁`
        : `另一次安装正在进行（pid ${owner.pid}），本次不再排队`,
    }
  }
  /** 死锁：pid 已不存在（同主机）。回收后**自己重抢**，不假设别人不会抢先。 */
  try { rmSync(lockPath, { force: true }) } catch { /* 别人已经回收了 */ }
  const recovered = attempt()
  if (recovered !== undefined) return { ok: true, handle: recovered }
  return {
    ok: false,
    code: 'install-busy',
    message: `回收死锁后仍被别人抢先持锁（${lockPath}），本次不再排队`,
  }
}

/**
 * 持锁执行一段操作：拿到锁 → 跑 `operation(handle)` → **无论成败都释放**。
 *
 * 用 `finally` 而不是 `catch`：异常也要释放，否则一次崩溃会把之后所有安装永久锁死。
 */
export function withExpertInstallLock<T>(
  operation: (handle: ExpertLockHandle) => T,
  options: ExpertInstallLockOptions & { mode?: 'install' | 'recovery' } = {},
): ExpertInstallLockResult<T> {
  const acquired = acquireExpertInstallLock(options)
  if (acquired.ok === false) return acquired
  try {
    return { ok: true, handle: acquired.handle, value: operation(acquired.handle) }
  } finally {
    acquired.handle.release()
  }
}

// ---------------------------------------------------------------------------
// 只读辅助（校验/安装器用；不写任何东西）
// ---------------------------------------------------------------------------

export interface ExpertFileReadResult {
  ok: boolean
  text?: string
  bytes?: number
  sha256?: string
  problem?: ExpertPathProblem
}

/** 读一条暂存/已发布文本（根内、非链接、大小受限）。**只读**。 */
export function readExpertTextFile(
  root: string,
  relativePath: string,
  options: { maxBytes?: number; allowRootLinkUnder?: string } = {},
): ExpertFileReadResult {
  const rootResolved = resolve(root)
  const candidate = resolve(rootResolved, relativePath)
  if (isInsideExpertRoot(rootResolved, candidate) === false) {
    return { ok: false, problem: { code: 'invalid-path', message: `路径越出根：${relativePath}` } }
  }
  const linkOptions: AssertNoLinksOptions = options.allowRootLinkUnder === undefined
    ? {}
    : { allowRootLinkUnder: options.allowRootLinkUnder }
  const linkCheck = assertNoLinksInsideRoot(rootResolved, relativePath, linkOptions)
  if (linkCheck.ok === false) return { ok: false, problem: linkCheck.problem }
  let stats: Stats
  try {
    stats = statSync(candidate)
  } catch {
    return { ok: false, problem: { code: 'invalid-path', message: `文件不存在：${relativePath}` } }
  }
  if (stats.isFile() === false) {
    return { ok: false, problem: { code: 'invalid-path', message: `不是普通文件：${relativePath}` } }
  }
  const maxBytes = options.maxBytes ?? EXPERT_STAGED_FILE_MAX_BYTES
  if (stats.size > maxBytes) {
    return { ok: false, problem: { code: 'file-too-large', message: `文件 ${stats.size} 字节，超过上限 ${maxBytes} 字节：${relativePath}` } }
  }
  const buffer = readFileSync(candidate)
  return { ok: true, text: buffer.toString('utf8'), bytes: buffer.length, sha256: sha256Of(buffer) }
}

/** 把一条路径问题收成 `ExpertIssue`（`field` 由调用方给定位串）。 */
export function pathProblemToIssue(problem: ExpertPathProblem, field: string): ExpertIssue {
  return { code: problem.code, field, message: problem.message }
}
