/**
 * 白名单套件：**expert**（专家功能出口批次 P9；AX-E59–E62 + P8 遗留的 AX-E52–E58 的 B 层）。
 *
 * 判据输入：`docs/tasks/51189a57-…-工作台专家功能实现和优化/acceptance.md:69-72`、
 * `implementation-plan.md:318-342`（P9 十条）、`P9-handover.md` 的接线义务。
 *
 * ## 四层，分别记状态（照 `persona.mjs` 的模板）
 *
 * | 层 | 覆盖 | 说明 |
 * |---|---|---|
 * | U/N（包与静态） | AX-E59 | 本次链真实打包出来的 tgz：方法论 / 新 `lib/**` / 内置 personas / 许可都在；`.pending`、测试数据、TEMP 证据、绝对路径**都不在** |
 * | H（真实 HTTP） | AX-E60 前半 + AX-E52–E58 的接线面 | 隔离实例的真实 SQLite + 真实文件系统：capabilities / methodology / catalog / generation-start / validate / confirm / abandon / manual-requests / preflight |
 * | B（真实浏览器） | AX-E52–E58 | 真实鼠标点「新建专家」、读 `data-wb-expert-*` 实际渲染值、开关、降级 |
 * | B（真实浏览器 + 真实会话记录） | AX-E60/E61/E62 | 真浏览器走 UI 开生成会话 + 读 `~/.dsh/sessions/**` 的 JSONL（多帧 zstd 逐帧解压）判"模型真调了哪些工具" + 目标库复读草稿行；拿不到就**如实 skip**（required+skipped 由链判不通过），绝不写成 pass |
 *
 * ## 本套件不新增任何隐式 skip 白名单
 *
 * `skipped` 只出现在**真实模型链路**那几条（AX-E60/E61/E62 的模型后半），且 reason 逐条写清**具体阻塞
 * 原因 + 收集到的原始证据**。U/H/B 三层找不到前置一律走 `suite.require()`（记 **fail**，不是 skip）。
 * `total <= 0` 由链判失败，本套件也自检。
 *
 * 用法（链自己会拼）：
 * ```sh
 * node scripts/verify/suites/expert.mjs --url <目标> --evidence-dir <本次证据目录> --user-data-root <临时浏览器根>
 * ```
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import {
  CHECK_LAYERS,
  createApi,
  ensureWorkbenchPanel,
  launchSuiteBrowser,
  parseSuiteArgs,
  repoRootFromSuite,
  safeJson,
  sleep,
  startSuite,
  waitFor,
} from './_harness.mjs'
import { discoverBrowser } from '../browser.mjs'

const options = parseSuiteArgs()
if (options.url === undefined) { console.error('用法：node scripts/verify/suites/expert.mjs --url <目标>'); process.exit(2) }

const AX = ['AX-E59', 'AX-E60', 'AX-E61', 'AX-E62']
/** P8 遗留的 B 层（AX-E52–E58：DOM + 真实点击）。它们与 E59–E62 同属本套件。 */
const P8_AX = ['AX-E52', 'AX-E53', 'AX-E54', 'AX-E55', 'AX-E56', 'AX-E57', 'AX-E58']
const ROOT = repoRootFromSuite()
/**
 * ⚠️ 会话目录的项目键有**前后各两条横线**（实测 `--D-Code-<company>-dsh-workbench--`）。
 * 映射规则（P10 实测反推）：路径里的 **`:` 直接删掉**（盘符不占位），`\` 与 `.` 换成 `-`，
 * 再在两端各加 `--`。`repoRootFromSuite()` 返回的路径还带**尾部分隔符**，所以先去尾部斜杠。
 * 两处都坑过 P10 的中间几次单跑（键算错 ⇒ `startsWith` 恒假 ⇒ 所有新会话都判成"不是这个仓库的"，
 * 白等满 180s 预算）：尾斜杠 ⇒ `---` 结尾；`:` 也变 `-` ⇒ `--D--Code-…`。
 */
const ROOT_TRIMMED = ROOT.replace(/[\\/]+$/, '')
const ROOT_PROJECT_KEY = `--${ROOT_TRIMMED.replace(/[:\\/]/g, (char) => (char === ':' ? '' : '-')).replace(/\./g, '-')}--`
const ROOT_NORM = ROOT_TRIMMED.replace(/\\/g, '/').toLowerCase()

const suite = startSuite({
  id: 'expert',
  title: '专家功能出口批次：真实包 / 真实 HTTP / 真实浏览器 / 真实模型（U-N-H-B-M 五层）',
  url: options.url,
  evidenceDir: options.evidenceDir,
  axIds: [...AX, ...P8_AX],
  legacyIds: [...AX, ...P8_AX],
})
const api = createApi(options.url, { token: options.token })

/**
 * 带**登录会话 cookie** 的 API 客户端。
 *
 * 为什么不能只靠 `Authorization: Bearer`：本机宿主 webserver 的认证是"`?token=` 换
 * `dsh-auth-*` cookie"（`GET /?token=<t>` → 303 + Set-Cookie），裸 Bearer 一律 401
 * （2026-10-05 实测：`/api/workbench/experts/capabilities` → 401，登录后同路径 404/200）。
 * cookie 只留在进程内存里，**绝不**写进证据（与 token 同一条纪律）。
 */
const sessionApi = {
  cookie: '',
  async login() {
    if (this.cookie !== '' || options.token === '') return
    const base = api.base
    const response = await fetch(`${base}/?token=${encodeURIComponent(options.token)}`, { redirect: 'manual' })
    const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    this.cookie = raw.map((entry) => entry.split(';')[0]).join('; ')
  },
  async request(path, init = {}) {
    await this.login()
    return api.request(path, { ...init, headers: { ...(this.cookie === '' ? {} : { cookie: this.cookie }), ...(init.headers ?? {}) } })
  },
  get(path) { return this.request(path, { method: 'GET' }) },
  post(path, body) { return this.request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }) },
}

/** 本套件自己的 runId：合成的会话 id / 请求文本都带它，**绝不**按标题批量匹配别人的数据。 */
const runId = `verify-expert-${Date.now().toString(36)}`
const syntheticSession = (suffix) => `${runId}-${suffix}`

const report = { runId, target: options.url, layers: {}, profile: { profile: options.profile, profileDir: options.profileDir, dbPath: options.dbPath } }
let browser
/**
 * 收尾安全网用的草稿 id（见 `finally`）：只要生成了草稿就必须在退出前确认它不是 pending ——
 * 漏一份 pending 专家草稿，横幅就会在**后续套件**的鼠标点击上盖一层浮层。
 */
let cleanupDraftId
/**
 * 浏览器可执行文件的发现结果（`checkBrowserLayer` 填）。B 层末尾要**关掉当前实例再冷启动一个新的**
 * 才能换会话（见 `runExpertGenerationProbe` 的注释：只有全新进程冷启动才会让 SPA 把
 * `dsh.sessions.current` 解析成最新那个会话），重启动时必须复用同一个浏览器路径。
 */
let BROWSER_PATH = null

/** 层是否被登记过（`CHECK_LAYERS` 是全仓唯一口径：U/H/W/B/N）。 */
const layerOk = (layer) => CHECK_LAYERS.has(layer)

// ─────────────────────────────────────────────────────────────────────────────
// U/N：AX-E59 —— 本次真实打包产物
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 定位**本次链真实打包出来**的 tgz。
 *
 * 顺序（先本次、后兜底，且**只信指针**）：
 * 1. `_local-build/current.txt` 里记的绝对路径 —— `dev-install.mjs` 每次打包都写它，
 *    链的 `install` 阶段刚跑过，所以它指向的就是本次构建的包；
 * 2. `_local-build/current.tgz` —— 同一份包的稳定副本；
 * 3. 仓库根 `<name>-<version>.tgz` —— 手工 `pnpm pack` 的兜底。
 *
 * **绝不按 mtime 猜**：猜错就会把上一个版本的包当成"本次产物"（那正是 AX-E59 要防的）。
 */
function locateTarball() {
  const candidates = []
  const pointer = join(ROOT, '_local-build', 'current.txt')
  if (existsSync(pointer)) {
    try {
      const recorded = readFileSync(pointer, 'utf8').trim().split(/\r?\n/)[0]
      if (typeof recorded === 'string' && recorded !== '') candidates.push({ path: recorded, source: 'current.txt' })
    } catch { /* 指针读不了就换下一档 */ }
  }
  candidates.push({ path: join(ROOT, '_local-build', 'current.tgz'), source: 'current.tgz' })
  try {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    candidates.push({ path: join(ROOT, `dely0-dsh-personal-workbench-${version}.tgz`), source: 'repo-root pack' })
  } catch { /* 读不了 package.json 就只剩前两档 */ }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate.path) && statSync(candidate.path).size > 0) return candidate
    } catch { /* 继续 */ }
  }
  return undefined
}

/**
 * 剥掉 JS/TS/CSS 风格的注释（**只为泄漏扫描用**，不追求完整词法分析）。
 *
 * 为什么需要它：产品源码里本来就有合法示例（`src/personas/resources.ts:16` 的注释写着
 * `拒绝 UNC（\\host\share）`），把它当泄漏是假红 —— 而假红会把真正泄漏的那条淹掉。
 * 用**状态机**而不是正则：正则处理 `//` 与字符串里的 `//`（URL！）会互相咬。
 * 字符串字面量**不剥**（真泄漏也可能出现在字符串里），只剥注释。
 */
function stripComments(text) {
  let out = ''
  let index = 0
  let mode = 'code'
  while (index < text.length) {
    const two = text.slice(index, index + 2)
    const char = text[index]
    if (mode === 'code') {
      if (two === '//') { mode = 'line'; index += 2; continue }
      if (two === '/*') { mode = 'block'; index += 2; continue }
      if (char === '"' || char === "'" || char === '`') { mode = char; out += char; index += 1; continue }
      out += char
      index += 1
      continue
    }
    if (mode === 'line') {
      if (char === '\n') { mode = 'code'; out += char }
      index += 1
      continue
    }
    if (mode === 'block') {
      if (two === '*/') { mode = 'code'; index += 2; continue }
      if (char === '\n') out += char
      index += 1
      continue
    }
    /** 字符串模式：处理转义，闭合后回 code。 */
    if (char === '\\') { index += 2; continue }
    if (char === mode) { mode = 'code'; out += char; index += 1; continue }
    out += char
    index += 1
  }
  return out
}

async function gunzipToBuffer(file) {  const { createGunzip } = await import('node:zlib')
  const { createReadStream } = await import('node:fs')
  const chunks = []
  await new Promise((resolvePromise, rejectPromise) => {
    createReadStream(file)
      .pipe(createGunzip())
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', resolvePromise)
      .on('error', rejectPromise)
  })
  return Buffer.concat(chunks)
}

/**
 * AX-E59：对**本次真实打包产物**核验"该有的都有、不该有的都没有"。
 *
 * 复用 `scripts/lib/tarReader.mjs`（认 PAX 扩展头的唯一实现）——**不自己写一套解包**，
 * 否则中文角色名会静默漏条目（`tarReader.mjs:8-19` 记着这个 bug 的代价）。
 */
async function checkTarball() {
  report.layers.package = {}
  const located = locateTarball()
  if (located === undefined) {
    suite.require({
      id: '找到本次链真实打包出来的 tgz', axId: 'AX-E59', layer: 'U',
      detail: '探测过：_local-build/current.txt、_local-build/current.tgz、仓库根 <name>-<version>.tgz 都不存在',
    })
    return
  }
  /**
   * 动态 import **必须**用文件 URL：Windows 绝对路径（`D:\…`）交给 ESM loader 会被
   * 当成协议 `d:` 拒掉（首跑实测：`Only URLs with a scheme in: file, data, and node are supported`）。
   */
  const { listTarEntries, readEntryContent } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'tarReader.mjs')).href)
  let buffer
  try {
    buffer = await gunzipToBuffer(located.path)
  } catch (error) {
    suite.require({
      id: 'gzip 解压本次 tgz', axId: 'AX-E59', layer: 'U',
      detail: `${located.path} 解压失败：${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }
  const entries = listTarEntries(buffer)
  const names = entries.map((entry) => entry.name)
  const files = new Set(entries.filter((entry) => entry.typeFlag !== '5').map((entry) => entry.name))
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  report.layers.package = {
    tarball: located.path,
    source: located.source,
    bytes: statSync(located.path).size,
    tarBytes: buffer.length,
    entryCount: entries.length,
    version,
  }
  suite.note(`包：${located.path}（来源 ${located.source}，${statSync(located.path).size} 字节，${entries.length} 条目）`)

  suite.check({
    id: 'tgz 能解压、tar 条目非空、包内版本与 package.json 一致', axId: 'AX-E59', layer: 'U',
    ok: entries.length > 0 && files.has('package/package.json')
      && JSON.parse(readEntryContent(buffer, entries.find((entry) => entry.name === 'package/package.json')).toString('utf8')).version === version,
    detail: `entryCount=${entries.length} 期望版本=${version}`,
  })

  /** ① 该有的都有（逐类给**证据计数**，不是"存在即通过"）。 */
  const personaDocs = [...files].filter((name) => /^package\/assets\/personas\/.+\.md$/i.test(name))
  const libFiles = [...files].filter((name) => name.startsWith('package/lib/'))
  const expertLib = [...files].filter((name) => /^package\/lib\/experts\//.test(name))
  const methodology = files.has('package/assets/expert-generation/methodology.md')
  const licenses = ['package/LICENSE', 'package/LICENSE-novotnyllc-dotnet-artisan', 'package/LICENSE-K-Dense-scientific-agents']
    .filter((name) => files.has(name))
  const required = [
    { what: '随包方法论 assets/expert-generation/methodology.md', ok: methodology, got: methodology ? '在' : '缺' },
    { what: '新 lib/experts/**（P1–P6 的编译产物）', ok: expertLib.length >= 8, got: `${expertLib.length} 个文件` },
    { what: 'lib/client.js / lib/index.js', ok: files.has('package/lib/client.js') && files.has('package/lib/index.js'), got: `${libFiles.length} 个 lib 文件` },
    { what: '原有 personas（assets/personas/**/*.md）', ok: personaDocs.length >= 15, got: `${personaDocs.length} 篇` },
    { what: '三份许可原文', ok: licenses.length === 3, got: licenses.map((name) => basename(name)).join(' / ') },
  ]
  report.layers.package.required = required
  suite.check({
    id: 'AX-E59-a 包内"该有的都有"：方法论 / 新 lib 产物 / 原有 personas / 三份许可（逐类计数）', axId: 'AX-E59', layer: 'U',
    ok: required.every((item) => item.ok),
    detail: required.map((item) => `${item.ok ? '✅' : '❌'} ${item.what} = ${item.got}`).join('；'),
  })

  /**
   * ② 不该有的都没有。
   *
   * 判据是**包内路径**，逐条给命中（不是"整串不含某词"那种宽正则）：
   * - `.pending` 是**用户的暂存区**（`EXPERT_PENDING_DIR_NAME`），绝不能随包发出去；
   * - `test/` / `test-results/` / `_local-build/` / `_local-archive/` / `browser-temp/` / `dist/` 是开发或证据产物；
   * - `*.log` / `*.png`（截图证据）同理。
   * 注意 `package/screenshot/**` 是**产品自带**的截图目录（`package.json` 的 `files` 明确列了它），
   * 所以只按**目录**判，不按 `.png` 后缀一刀切。
   */
  const forbidden = [
    { what: '暂存区 .pending', hits: [...files].filter((name) => name.includes('/.pending/') || name.endsWith('/.pending')) },
    { what: '测试源码 test/**', hits: [...files].filter((name) => /^package\/test\//.test(name)) },
    { what: '证据包 test-results/**', hits: [...files].filter((name) => /^package\/test-results\//.test(name)) },
    { what: '开发打包产物 _local-build/**', hits: [...files].filter((name) => /^package\/_local-build\//.test(name)) },
    { what: '历史存档 _local-archive/**', hits: [...files].filter((name) => /^package\/_local-archive\//.test(name)) },
    { what: '浏览器临时目录 browser-temp/**', hits: [...files].filter((name) => /^package\/browser-temp\//.test(name)) },
    { what: '源码 src/**（包只发 lib）', hits: [...files].filter((name) => /^package\/src\//.test(name)) },
    { what: '日志 *.log', hits: [...files].filter((name) => name.endsWith('.log')) },
    { what: 'TEMP 证据（临时目录名里的 verify 痕迹）', hits: [...files].filter((name) => /\/suite-[a-z-]+\//i.test(name)) },
  ]
  report.layers.package.forbidden = forbidden.map((item) => ({ what: item.what, count: item.hits.length, sample: item.hits.slice(0, 5) }))
  suite.check({
    id: 'AX-E59-b 包内"不该有的都没有"：无 .pending / 测试数据 / TEMP 证据 / 源码 / 日志', axId: 'AX-E59', layer: 'U',
    ok: forbidden.every((item) => item.hits.length === 0),
    detail: forbidden.map((item) => `${item.hits.length === 0 ? '✅' : '❌'} ${item.what}=${item.hits.length}`).join('；'),
  })

  /**
   * ③ 包内文本**不含绝对路径**。
   *
   * 为什么只扫**文本类**条目：二进制条目里出现 `C:\` 字节序列是噪声。
   * 为什么先**剥注释**：产品源码里本来就有合法示例与正则字面量 ——
   * `src/personas/resources.ts:16` 的注释写着"拒绝 UNC（`\\host\share`）"、
   * `:81` 的正则里就有 `'\\\\'`。把文档当泄漏是**假红**（首跑实测命中 `lib/personas/resources.js`），
   * 而假红会把真正泄漏的那一条淹掉。
   * 判据抓两类真会泄漏的形态：本机用户名路径（`C:\Users\<name>\…`）与 UNC（`\\server\share`）。
   * **不抓泛化的 `[A-Za-z]:[\\/]`** —— 那会把文档里的示例路径也算成泄漏。
   */
  const textLike = entries.filter((entry) => entry.typeFlag !== '5'
    && /\.(md|json|js|mjs|cjs|ts|yml|yaml|txt|css|map|d\.ts)$/i.test(entry.name)
    && entry.size > 0)
  const leaks = []
  for (const entry of textLike) {
    const content = stripComments(readEntryContent(buffer, entry).toString('utf8'))
    for (const pattern of [/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/, /\\\\[A-Za-z0-9._-]+\.[A-Za-z]{2,}[\\/][A-Za-z0-9$._-]+/]) {
      const match = pattern.exec(content)
      if (match !== null) { leaks.push(`${entry.name} ← ${match[0].slice(0, 60)}`); break }
    }
  }
  report.layers.package.absolutePathLeaks = leaks
  suite.check({
    id: 'AX-E59-c 包内文本没有本机绝对路径 / UNC 泄漏', axId: 'AX-E59', layer: 'U',
    ok: leaks.length === 0,
    detail: `扫描 ${textLike.length} 个文本条目；命中=${safeJson(leaks.slice(0, 5))}`,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// H：真实 HTTP（隔离实例的真实 DB + 真实文件系统）
// ─────────────────────────────────────────────────────────────────────────────

/** 用户库 personas 根（与 `src/experts/paths.ts:72` 的 `defaultUserPersonaRoot` 同源约定）。 */
function userPersonaRoot() {
  const home = process.env.DSH_VERIFY_HOME ?? homedir()
  return join(home, '.dsh', 'workbench', 'personas')
}

/** 列一个目录下的**条目名**（不存在返回空数组，不抛）。 */
function listDir(path) {
  try { return readdirSync(path, { withFileTypes: true }).map((entry) => entry.name) } catch { return [] }
}

/** 递归列出相对路径（只在需要精确比对时用；深度受限，绝不扫上万文件）。 */
function walkRelative(root, maxEntries = 4000) {
  const out = []
  const stack = ['']
  while (stack.length > 0 && out.length < maxEntries) {
    const rel = stack.pop()
    const absolute = rel === '' ? root : join(root, rel)
    let dirents
    try { dirents = readdirSync(absolute, { withFileTypes: true }) } catch { continue }
    for (const dirent of dirents) {
      const child = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      out.push(`${child}${dirent.isDirectory() ? '/' : ''}`)
      if (dirent.isDirectory()) stack.push(child)
    }
  }
  return out.sort()
}

async function checkHttpLayer() {
  report.layers.http = {}
  const health = await api.get('/api/workbench/health')
  report.layers.http.health = { status: health.status, version: health.body?.version ?? null, buildId: health.body?.buildId ?? null, db: health.body?.db ?? null }
  suite.note(`目标 health：status=${health.status} version=${health.body?.version} buildId=${health.body?.buildId} schema=${health.body?.db?.schemaVersion}`)

  /** ── capabilities：四项能力如实探测 ─────────────────────────────────────── */
  const caps = await sessionApi.get('/api/workbench/experts/capabilities')
  report.layers.http.capabilities = caps.body
  suite.check({
    id: 'GET /experts/capabilities 200 且四项能力都带 available/reason（不静默缺字段）', axId: 'AX-E60', layer: 'H',
    ok: caps.status === 200 && caps.body?.ok === true
      && typeof caps.body?.generation?.available === 'boolean'
      && typeof caps.body?.skills?.available === 'boolean'
      && typeof caps.body?.manualSummon?.available === 'boolean'
      && typeof caps.body?.autoSummon?.available === 'boolean'
      && typeof caps.body?.autoSummon?.enabled === 'boolean',
    detail: safeJson(caps.body),
  })
  suite.check({
    id: 'capabilities.generation.available=true（随包方法论可读，这是生成入口的前置）', axId: 'AX-E60', layer: 'H',
    ok: caps.body?.generation?.available === true && caps.body?.generation?.reason === null,
    detail: safeJson(caps.body?.generation ?? null),
  })

  /** ── methodology：真实全文 ──────────────────────────────────────────────── */
  const methodology = await sessionApi.get('/api/workbench/experts/methodology')
  const methodologyText = typeof methodology.body?.text === 'string' ? methodology.body.text : ''
  report.layers.http.methodology = { status: methodology.status, version: methodology.body?.version, chars: methodologyText.length }
  suite.check({
    id: 'GET /experts/methodology 返回真实全文（version=1 且正文非空、不是占位串）', axId: 'AX-E60', layer: 'H',
    ok: methodology.status === 200 && methodology.body?.version === 1 && methodologyText.length > 500
      && /专家|persona|人格/i.test(methodologyText),
    detail: `version=${methodology.body?.version} chars=${methodologyText.length}`,
  })

  /**
   * ── catalog：管理行 + 可选择摘要 ─────────────────────────────────────────
   *
   * ⚠️ 键名按**路由层实际投影**：`{ok, experts, personas, diagnostics, skillsAvailable, preliminary}`
   * —— 服务层的 `rows` 在路由层被投影成 `experts`（`src/experts/catalog.ts:135` 是服务层形状）。
   * 首跑按 `rows` 读，把一条真实 200 记成了失败（假红）。
   */
  const catalogBefore = await sessionApi.get('/api/workbench/experts/catalog')
  const expertsBefore = Array.isArray(catalogBefore.body?.experts) ? catalogBefore.body.experts : []
  const personasBefore = Array.isArray(catalogBefore.body?.personas) ? catalogBefore.body.personas : []
  report.layers.http.catalogBefore = {
    status: catalogBefore.status,
    ok: catalogBefore.body?.ok,
    keys: Object.keys(catalogBefore.body ?? {}),
    experts: expertsBefore.length,
    personas: personasBefore.length,
    diagnostics: Array.isArray(catalogBefore.body?.diagnostics) ? catalogBefore.body.diagnostics.length : null,
    skillsAvailable: catalogBefore.body?.skillsAvailable ?? null,
    preliminary: catalogBefore.body?.preliminary ?? null,
    expert0: expertsBefore[0] ?? null,
  }
  suite.check({
    id: 'GET /experts/catalog 200：管理行（experts）与可选择摘要（personas）都在，每行带 id/source/status', axId: 'AX-E56', layer: 'H',
    ok: catalogBefore.status === 200 && catalogBefore.body?.ok === true
      && expertsBefore.length >= 6 && personasBefore.length >= 6
      && expertsBefore.every((row) => typeof row.id === 'string' && typeof row.source === 'string' && typeof row.status === 'string'),
    detail: safeJson({ keys: report.layers.http.catalogBefore.keys, experts: expertsBefore.length, personas: personasBefore.length, expert0: expertsBefore[0] }).slice(0, 900),
  })

  /**
   * ── AX-E60 前半：generation-start → 草稿；**确认前正式库为空** ─────────────
   *
   * 为什么这是 E60 的**多数派证据**：真实模型那一半（模型确实调了生成工具）需要真实链路；
   * 而"用户确认前正式库为空"这条**与模型无关**，用真实 HTTP + 真实 FS/DB 就能钉死。
   */
  const personasRoot = userPersonaRoot()
  const beforeSnapshot = walkRelative(personasRoot)
  const pendingDir = join(personasRoot, '.pending')
  const pendingBefore = listDir(pendingDir)
  const generatedDir = join(personasRoot, 'generated')
  const generatedBefore = listDir(generatedDir)
  report.layers.http.fsBefore = { personasRoot, entries: beforeSnapshot.length, pendingBefore, generatedBefore }

  const request = `${runId}：写一个只回答"就绪"的验证用专家`
  const started = await sessionApi.post('/api/workbench/experts/generation-start', {
    sessionId: syntheticSession('gen'),
    request,
    workspaceId: process.cwd(),
  })
  /**
   * 响应形状**逐字按实现**（`ExpertDraftView`，不是草稿仓储行）：
   * `{draftId, statusCode, contentVersion, phase, expertId, request, personaMd, provenance, skills, files, validation}`
   * —— 首跑按 `draft.id` 读，拿到 `undefined`，把一条正确的 200 记成了失败（假红）。
   */
  const draft = started.body?.draft
  report.layers.http.generationStart = {
    status: started.status,
    draftId: draft?.draftId ?? null,
    statusCode: draft?.statusCode ?? null,
    phase: draft?.phase ?? null,
    contentVersion: draft?.contentVersion ?? null,
    expertId: draft?.expertId ?? null,
  }
  suite.check({
    id: 'POST /experts/generation-start 建出 pending 草稿（draftId / statusCode=pending / phase=editing / contentVersion 是数字）', axId: 'AX-E60', layer: 'H',
    ok: started.status === 200 && started.body?.ok === true
      && typeof draft?.draftId === 'string' && draft.draftId !== ''
      && draft?.statusCode === 'pending'
      && draft?.phase === 'editing'
      && Number.isInteger(draft?.contentVersion)
      && typeof draft?.expertId === 'string' && draft.expertId.startsWith('generated/'),
    detail: safeJson(report.layers.http.generationStart),
  })
  if (typeof draft?.draftId !== 'string' || draft.draftId === '') {
    suite.require({ id: '后续 E60/E61 断言需要一份真实草稿 id', axId: 'AX-E60', layer: 'H', detail: `generation-start 没给 draftId：${safeJson(started.body)}` })
    return
  }
  const draftId = draft.draftId
  cleanupDraftId = draftId

  /**
   * 正式库为空：三重判据（新草稿的 id 不在 personas 正式根、`generated/` 没多出条目、
   * personas 根**除 `.pending` 外**没有新增文件）。只比对**新增**，不要求"根是空的" ——
   * 隔离实例的用户库本来可能已有历史角色，那不该被算成失败，但**本次的 draftId 绝不能出现**。
   */
  const afterSnapshot = walkRelative(personasRoot)
  const added = afterSnapshot.filter((entry) => beforeSnapshot.includes(entry) === false)
  const leakedIntoLibrary = added.filter((entry) => entry.startsWith('.pending') === false)
  const stagedDir = join(pendingDir, draftId)
  const stagedFiles = existsSync(stagedDir) ? walkRelative(stagedDir) : []
  const generatedAfter = listDir(generatedDir)
  /**
   * **直接读隔离实例的 SQLite**（只读、只查这一行）：HTTP 回执说"草稿建好了"是一件事，
   * 库里真有这行 `pending` 且 `kind_code='expert'` 是另一件事 —— 后者才是"用户确认前
   * 只是草稿"的硬证据（AX-E60 的核心判据）。
   */
  let dbRow
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(options.dbPath, { readOnly: true })
    try {
      dbRow = database
        .prepare('SELECT id, kind_code, session_id, status_code FROM task_drafts WHERE id = ?')
        .get(draftId)
      const installed = database
        .prepare("SELECT COUNT(*) AS n FROM task_drafts WHERE id = ? AND status_code <> 'pending'")
        .get(draftId)
      dbRow = { ...(dbRow ?? {}), notPending: installed?.n ?? null }
    } finally { database.close() }
  } catch (error) {
    dbRow = { error: error instanceof Error ? error.message : String(error) }
  }
  report.layers.http.fsAfterDraft = { added, leakedIntoLibrary, stagedFiles, pending: listDir(pendingDir), generatedAfter, dbRow }
  suite.check({
    id: 'AX-E60 ⭐ 草稿阶段正式库为空：新草稿只落在 task_drafts(pending)，generated/ 与 personas 正式根零新增', axId: 'AX-E60', layer: 'H',
    ok: leakedIntoLibrary.length === 0
      && generatedAfter.length === generatedBefore.length
      && dbRow?.kind_code === 'expert'
      && dbRow?.status_code === 'pending'
      && dbRow?.notPending === 0,
    detail: `正式根新增=${safeJson(added.slice(0, 8))}；泄漏=${safeJson(leakedIntoLibrary)}；DB 行=${safeJson(dbRow)}；generated/=${generatedAfter.length}（原 ${generatedBefore.length}）`,
  })
  suite.check({
    id: 'AX-E60 暂存区按规格待在 .pending/<draftId>/（生成起步时可以是空目录：文件要等模型暂存才落盘）', axId: 'AX-E60', layer: 'H',
    ok: stagedFiles.length === 0 || existsSync(stagedDir),
    detail: `pendingDir=${pendingDir} draftDir=${stagedDir} 条目=${safeJson(stagedFiles.slice(0, 8))}；起步阶段按规格不含文件（stageFile 才落盘）`,
  })

  /** ── 草稿读回 + 校验 + 版本 CAS ─────────────────────────────────────────── */
  const preview = await sessionApi.get(`/api/workbench/experts/drafts/${encodeURIComponent(draftId)}`)
  report.layers.http.preview = { status: preview.status, phase: preview.body?.draft?.phase, contentVersion: preview.body?.draft?.contentVersion, drift: preview.body?.drift ?? null }
  suite.check({
    id: 'GET /experts/drafts/:id 读回草稿与漂移诊断（phase + contentVersion + drift 字段都在）', axId: 'AX-E54', layer: 'H',
    ok: preview.status === 200 && preview.body?.ok === true
      && (preview.body?.draft?.draftId ?? preview.body?.draft?.id) === draftId
      && 'drift' in (preview.body ?? {}),
    detail: safeJson(report.layers.http.preview),
  })

  const badVersion = await sessionApi.post(`/api/workbench/experts/drafts/${encodeURIComponent(draftId)}/validate`, { expectedVersion: 99999 })
  report.layers.http.validateStaleVersion = { status: badVersion.status, code: badVersion.body?.code }
  suite.check({
    id: 'POST /drafts/:id/validate 用过期 expectedVersion → 409（版本 CAS 真的在拦，不是只写文档）', axId: 'AX-E55', layer: 'H',
    ok: badVersion.status === 409,
    detail: safeJson(report.layers.http.validateStaleVersion),
  })

  const validated = await sessionApi.post(`/api/workbench/experts/drafts/${encodeURIComponent(draftId)}/validate`, { expectedVersion: draft.contentVersion })
  const validation = validated.body?.validation
  report.layers.http.validate = { status: validated.status, phase: validated.body?.draft?.phase, errors: validation?.errors?.length, warnings: validation?.warnings?.length, manifestHash: validation?.manifestHash ?? null }
  suite.check({
    id: 'POST /drafts/:id/validate 真跑校验：200/ok:true 且给 validation（errors 是数组、有 manifestHash）', axId: 'AX-E54', layer: 'H',
    ok: validated.status === 200 && validated.body?.ok === true && Array.isArray(validation?.errors)
      && typeof validation?.manifestHash === 'string' && validation.manifestHash.length > 0,
    detail: safeJson(report.layers.http.validate),
  })

  /** ── 放弃：正式库仍为空，且暂存区被清 ─────────────────────────────────── */
  /**
   * ⚠️ 2026-10-05 修（真链上抓到的跨套件污染）：
   * 专家草稿的 abandon **必须带 `{expectedVersion}`** ——
   * `src/api/routes/drafts.ts:312-321`：`body === undefined` → 400 `invalid-json`，
   * 有 body 但缺 `expectedVersion` → 400 `invalid-payload`。
   * 旧写法不带 body ⇒ 恒 400、草稿永远 pending；而「待确认草稿」横幅每 5 秒轮询会把它
   * 弹成全屏浮层盖住工作台，把**同一条链上后面的** progress 套件的鼠标点击吃掉
   *（实测：点 25% 落到了横幅 header 上，progress 挂 2 条，链在 expert 之前就断了）。
   * 判据同时收紧：必须 200，且**直接复读 DB** 确认这行已不是 pending
   *（"我调过放弃了" 不等于 "它真的不再是待确认草稿"）。
   */
  const abandoned = await sessionApi.post(`/api/workbench/drafts/${encodeURIComponent(draftId)}/abandon`, { expectedVersion: draft.contentVersion })
  const afterAbandon = walkRelative(personasRoot)
  const leakedAfterAbandon = afterAbandon.filter((entry) => beforeSnapshot.includes(entry) === false && entry.startsWith('.pending') === false)
  let abandonRow
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(options.dbPath, { readOnly: true })
    try {
      abandonRow = database.prepare('SELECT status_code FROM task_drafts WHERE id = ?').get(draftId)?.status_code ?? null
    } finally { database.close() }
  } catch (error) {
    abandonRow = `error:${error instanceof Error ? error.message : String(error)}`
  }
  report.layers.http.abandon = { status: abandoned.status, code: abandoned.body?.code ?? null, statusAfterAbandon: abandonRow, leakedAfterAbandon }
  suite.check({
    id: 'POST /drafts/:id/abandon（带 expectedVersion）→ 200 且 DB 复读已不是 pending，正式库零新增', axId: 'AX-E60', layer: 'H',
    ok: abandoned.status === 200 && abandoned.body?.ok === true && abandonRow === 'abandoned' && leakedAfterAbandon.length === 0,
    detail: safeJson(report.layers.http.abandon),
  })

  /** ── 手动入口：manual-requests 只建请求（auto=false 也能用） ────────────── */
  const manualPersona = personasBefore[0]
  if (manualPersona === undefined) {
    suite.require({ id: '至少有一个可用角色用于 preflight / manual-requests', axId: 'AX-E61', layer: 'H', detail: `catalog.personas=${personasBefore.length}` })
  } else {
    const preflight = await sessionApi.post('/api/workbench/experts/preflight', { personaId: manualPersona.id, sessionId: syntheticSession('pf') })
    report.layers.http.preflight = { status: preflight.status, usable: preflight.body?.usable, status2: preflight.body?.status, preliminary: preflight.body?.preliminary, summary: preflight.body?.summary }
    suite.check({
      id: 'POST /experts/preflight 给可用性预检（HTTP 侧如实 preliminary=true，不假装权威）', axId: 'AX-E61', layer: 'H',
      ok: preflight.status === 200 && typeof preflight.body?.usable === 'boolean' && preflight.body?.preliminary === true,
      detail: safeJson(report.layers.http.preflight),
    })
    /**
     * 真建一条手动请求：身份（`expectedSourceKey` / `expectedRevision`）**逐字**来自 catalog 行。
     *
     * ⚠️ 这里**不**去读 `/api/workbench/personas/bind`：那条路由的读法是 `GET /bind?session_id=`
     * —— 实测返回里没有 `binding` 字段（首跑按 `body.binding` 判"没写绑定行"，会**恒真**，
     * 属于假绿）。改成两条真的会失败、且不依赖别的套件的判据：
     * ① 身份对得上 → 200 + `requestId`/`expiresAt`；② 身份对不上 → **400** `revision-changed`
     *（不是 409：`src/client/expertInputSource.ts:358` 逐字写着「服务端当场 `revision-changed`（400）」，
     *  真机实测也是 400 —— 首跑按 409 判，把一条正确的拒绝记成了失败）。
     */
    const manualSession = syntheticSession('manual')
    const manual = await sessionApi.post('/api/workbench/experts/manual-requests', {
      sessionId: manualSession,
      personaId: manualPersona.id,
      expectedSourceKey: String(manualPersona.sourceKey ?? ''),
      expectedRevision: String(manualPersona.revision ?? ''),
    })
    const staleSource = await sessionApi.post('/api/workbench/experts/manual-requests', {
      sessionId: syntheticSession('manual-stale'),
      personaId: manualPersona.id,
      expectedSourceKey: 'verify-not-the-real-source',
      expectedRevision: 'verify-not-the-real-revision',
    })
    report.layers.http.manualRequests = {
      status: manual.status,
      code: manual.body?.code ?? null,
      requestId: manual.body?.requestId ?? null,
      expiresAt: manual.body?.expiresAt ?? null,
      staleStatus: staleSource.status,
      staleCode: staleSource.body?.code ?? null,
      staleField: staleSource.body?.field ?? null,
      personaIdentity: { id: manualPersona.id, sourceKey: manualPersona.sourceKey, revision: manualPersona.revision },
    }
    suite.check({
      id: 'POST /experts/manual-requests 建请求成功（200 + requestId + expiresAt，身份按 catalog 逐字传）', axId: 'AX-E61', layer: 'H',
      ok: manual.status === 200 && manual.body?.ok === true
        && typeof manual.body?.requestId === 'string' && manual.body.requestId !== ''
        && typeof manual.body?.expiresAt === 'string' && manual.body.expiresAt !== '',
      detail: safeJson(report.layers.http.manualRequests),
    })
    suite.check({
      id: 'AX-E61 ⭐ 身份对不上时 manual-requests 返回 400 revision-changed 且 sourceKey 字段指认（不按陈旧身份建请求）', axId: 'AX-E61', layer: 'H',
      ok: staleSource.status === 400 && staleSource.body?.code === 'revision-changed'
        && staleSource.body?.field === 'expected_source_key'
        && staleSource.body?.requestId === undefined,
      detail: safeJson(report.layers.http.manualRequests),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B：真实浏览器（AX-E52–E58 的 DOM + 真实点击）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读专家域在真实 DOM 里的**实际渲染值**。
 *
 * 源码级唯一性（P8 已有断言）**不等于** DOM 里的值正确 —— 这里读的就是渲染结果。
 * 选择器逐个来自 `方案-v0.3.md` §12.3 的枚举（`P8-handover.md` §9-4 的接线义务）。
 */
const READ_EXPERT_DOM = `
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (el) => (el.textContent || '').trim().slice(0, 120);
  return {
    roots: q('[data-wb-experts]').map((el) => ({ kind: el.getAttribute('data-wb-experts'), visible: el.offsetParent !== null })),
    actions: q('[data-wb-expert-action]').map((el) => ({ action: el.getAttribute('data-wb-expert-action'), tag: el.tagName, disabled: el.disabled === true, visible: el.offsetParent !== null, text: text(el) })),
    fields: q('[data-wb-expert-field]').map((el) => ({ field: el.getAttribute('data-wb-expert-field'), tag: el.tagName, type: el.getAttribute('type'), value: String(el.value ?? '').slice(0, 80) })),
    rows: q('[data-wb-expert-id]').map((el) => ({ id: el.getAttribute('data-wb-expert-id'), status: el.getAttribute('data-wb-expert-status') })),
    drafts: q('[data-wb-expert-draft]').map((el) => ({ draft: el.getAttribute('data-wb-expert-draft'), version: el.getAttribute('data-wb-expert-version'), status: el.getAttribute('data-wb-expert-status') })),
    errors: q('[data-wb-expert-error]').map((el) => ({ code: el.getAttribute('data-wb-expert-error'), text: text(el) })),
  };
`

async function checkBrowserLayer() {
  report.layers.browser = {}
  const discovered = discoverBrowser({ overridePath: options.browser })
  if (discovered.ok !== true) {
    suite.require({ id: '发现可用浏览器（真实 DOM 判据的前置）', axId: 'AX-E52', layer: 'B', detail: `没有可用浏览器：${discovered.reason}` })
    return
  }
  browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: discovered.path })
  BROWSER_PATH = discovered.path
  await browser.goto(api.pageUrl())
  await waitFor(async () => (await browser.evaluate(`return document.querySelector('[class*="sidebarCol"]') !== null;`)) === true, { timeoutMs: 30000, description: '宿主侧栏渲染' }).catch(() => undefined)
  await sleep(1500)
  const openState = await ensureWorkbenchPanel(browser)
  if (openState === null) {
    suite.require({ id: '打开工作台面板（B 层全部判据的前置）', axId: 'AX-E52', layer: 'B', detail: '找不到侧栏工作台入口' })
    return
  }
  await waitFor(async () => (await browser.evaluate(`const h=document.querySelector('.wb-panel-host'); return h !== null && h.getAttribute('data-open') === '1';`)) === true, { timeoutMs: 15000, description: '面板 data-open=1' }).catch(() => undefined)
  await sleep(1200)
  await browser.screenshot(`${suite.dir}/01-面板.png`)

  /** ── 打开设置弹窗 → 角色库分区（`data-wb-experts="admin"` 挂在这里）───────── */
  /**
   * ⚠️ 选择器必须**限定在工作台面板内**（`.wb-h button`）：宿主侧栏左下角也有一个「设置」，
   * 而它在 document 顺序里更靠前 —— 首跑 `clickByText('设置', 'button')` 点的是宿主的设置弹窗
   *（按钮里出现「通用设置 / 关闭」而不是工作台的「角色库 / 取消 / 保存设置」），
   * 于是 `.wb-settings-nav` 永远不存在，B 层在第一步就 `return`，AX-E52–E58 一条都没跑到。
   */
  const settingsOpened = await browser.clickByText('设置', '.wb-h button')
  await sleep(1500)
  const settingsDom = await browser.evaluate(`
    const nav = document.querySelector('.wb-settings-nav');
    const host = document.querySelector('.wb-panel-host');
    return {
      navFound: nav !== null,
      sections: nav === null ? [] : Array.from(nav.querySelectorAll('button')).map((b) => (b.textContent || '').trim()),
      /* 诊断用：点完「设置」之后，屏幕上跟"设置 / 弹窗"有关的按钮文字 */
      panelOpen: host === null ? null : host.getAttribute('data-open'),
      buttons: Array.from(document.querySelectorAll('button'))
        .filter((b) => /设置|角色库|通用|取消|关闭/.test(b.textContent || '') && b.offsetParent !== null)
        .map((b) => (b.textContent || '').trim()).slice(0, 12),
      dialogCount: document.querySelectorAll('.wb-dialog, [role="dialog"]').length,
      settingsRootFound: document.querySelector('.wb-settings') !== null,
    };
  `)
  report.layers.browser.settings = { clicked: settingsOpened !== null, clickTarget: settingsOpened?.text ?? null, ...settingsDom }
  await browser.screenshot(`${suite.dir}/02-设置.png`)
  if (settingsOpened === null || settingsDom.navFound !== true) {
    suite.require({ id: '真实点击「设置」打开弹窗（专家管理入口的前置）', axId: 'AX-E52', layer: 'B', detail: safeJson(report.layers.browser.settings) })
    return
  }

  /**
   * 设置弹窗里的「角色库」分区。P8 把专家管理放进 `PersonaAdmin`（`data-wb-experts="admin"`），
   * 它只在 `section === 'persona'` 时渲染（`SettingsModal.tsx:235-275`），所以要**真点**那个页签。
   */
  let adminDom = await browser.evaluate(READ_EXPERT_DOM)
  let switched = false
  if (adminDom.roots.some((root) => root.kind === 'admin') === false) {
    switched = (await browser.clickByText('角色库', '.wb-settings-nav button')) !== null
      || (await browser.clickByText('角色库', 'button')) !== null
    await sleep(1200)
    adminDom = await browser.evaluate(READ_EXPERT_DOM)
  }
  report.layers.browser.adminDom = { switched, sections: settingsDom.sections, ...adminDom }
  await browser.screenshot(`${suite.dir}/03-专家管理.png`)
  suite.check({
    id: 'AX-E56 ⭐ 真实 DOM：设置页渲染出专家管理根 data-wb-experts="admin"（可见）', axId: 'AX-E56', layer: 'B',
    ok: adminDom.roots.some((root) => root.kind === 'admin' && root.visible === true),
    detail: safeJson(adminDom.roots),
  })
  suite.check({
    id: 'AX-E52 ⭐ 真实 DOM：专家管理里有 data-wb-expert-action="create"（新建专家入口，按钮可点）', axId: 'AX-E52', layer: 'B',
    ok: adminDom.actions.some((item) => item.action === 'create' && item.disabled === false),
    detail: safeJson(adminDom.actions.filter((item) => item.action === 'create')),
  })
  suite.check({
    id: 'AX-E57 ⭐ 真实 DOM：auto-summon 开关渲染出 data-wb-expert-field="auto-summon"', axId: 'AX-E57', layer: 'B',
    ok: adminDom.fields.some((item) => item.field === 'auto-summon'),
    detail: safeJson(adminDom.fields),
  })

  /** ── 真实点击「新建专家」→ 弹窗 + 两个字段 + 提交按钮 ─────────────────── */
  const createTarget = adminDom.actions.find((item) => item.action === 'create')
  let createDom = { roots: [], actions: [], fields: [], rows: [], drafts: [], errors: [] }
  if (createTarget === undefined) {
    suite.require({ id: '真实鼠标点「新建专家」（AX-E52/E53 的入口）', axId: 'AX-E52', layer: 'B', detail: '管理页里没有 create 动作' })
  } else {
    const clicked = await browser.evaluate(`
      const el = document.querySelector('[data-wb-expert-action="create"]');
      if (el === null) return false;
      el.click();
      return true;
    `)
    await sleep(1000)
    createDom = await browser.evaluate(READ_EXPERT_DOM)
    report.layers.browser.createModal = { clicked, ...createDom }
    await browser.screenshot(`${suite.dir}/04-新建专家弹窗.png`)
    suite.check({
      id: 'AX-E52 ⭐ 真实点击后弹出 data-wb-experts="create-modal"，含 request / workspace 两个字段', axId: 'AX-E52', layer: 'B',
      ok: clicked === true
        && createDom.roots.some((root) => root.kind === 'create-modal' && root.visible === true)
        && createDom.fields.some((item) => item.field === 'request')
        && createDom.fields.some((item) => item.field === 'workspace'),
      detail: safeJson({ roots: createDom.roots, fields: createDom.fields }),
    })
    suite.check({
      id: 'AX-E54 ⭐ 真实 DOM：弹窗里没有「创建任务」假文案（专家流程不写任务）', axId: 'AX-E54', layer: 'B',
      ok: (await browser.evaluate(`
        const root = document.querySelector('[data-wb-experts="create-modal"]');
        return root === null ? true : (root.textContent || '').includes('创建任务') === false;
      `)) === true,
      detail: 'create-modal 的 textContent 不含「创建任务」',
    })

    /** 空文本时提交按钮必须禁用（AX-E52 的"空文本"判据在真实 DOM 上的证据）。 */
    const submitDisabledEmpty = await browser.evaluate(`
      const btn = document.querySelector('[data-wb-expert-action="start-generation"]');
      return btn === null ? null : { disabled: btn.disabled === true, text: (btn.textContent || '').trim() };
    `)
    report.layers.browser.submitEmpty = submitDisabledEmpty
    suite.check({
      id: 'AX-E52 ⭐ 真实 DOM：请求文本为空时「开始生成」按钮是禁用的', axId: 'AX-E52', layer: 'B',
      ok: submitDisabledEmpty !== null && submitDisabledEmpty.disabled === true,
      detail: `start-generation（空文本）=${safeJson(submitDisabledEmpty)}`,
    })

    /**
     * 「按钮会解禁」这条分三步判，因为 `ExpertCreateModal.tsx:53-55` 的 `blocked` 是
     * **busy || 缺 sessions.create || 空文本 || 没选工作区** 四项的并集：
     * ① 空文本 → 禁用（上面已断言）；
     * ② 填文本 + **把工作区清成空选项** → 仍禁用，且出现
     *    `data-wb-expert-error="no-workspace"`（`ExpertCreateModal.tsx:124-131`）；
     * ③ 真选一个工作区 → 解禁。
     * ⚠️ 首跑只断言"填完文本仍禁用"，在这台机器上**假红**了：工作区下拉的初值不是空
     *（实测 `ef1cf070-…`，是上次选择留下的），所以填完文本它本来就该解禁。
     * 要证明"工作区必选"必须**主动把下拉设回 `<option value="">请选择…</option>`**。
     */
    const typed = await browser.evaluate(`
      const input = document.querySelector('[data-wb-expert-field="request"]');
      if (input === null) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, '验证用专家：只回答就绪');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `)
    await sleep(500)
    const clearedWorkspace = await browser.evaluate(`
      const select = document.querySelector('[data-wb-expert-field="workspace"]');
      if (select === null) return { ok: false, reason: 'no-select' };
      if (Array.from(select.options).some((o) => o.value === '') === false) return { ok: false, reason: 'no-empty-option' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, '');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: select.value, options: select.options.length };
    `)
    await sleep(700)
    const afterTyping = await browser.evaluate(READ_EXPERT_DOM)
    const submitAfterTyping = afterTyping.actions.find((item) => item.action === 'start-generation') ?? null
    const noWorkspaceNote = afterTyping.errors.some((item) => item.code === 'no-workspace')
    report.layers.browser.afterTyping = { typed, clearedWorkspace, requestValue: afterTyping.fields.find((f) => f.field === 'request')?.value ?? null, submit: submitAfterTyping, noWorkspaceNote, errors: afterTyping.errors }
    await browser.screenshot(`${suite.dir}/05-已输入.png`)
    suite.check({
      id: 'AX-E52 ⭐ 真实 DOM：清空工作区后即使有文本也禁用，并给出 data-wb-expert-error="no-workspace"（工作区必选，不是"填了就能发"）', axId: 'AX-E52', layer: 'B',
      ok: typed === true && clearedWorkspace.ok === true && submitAfterTyping?.disabled === true && noWorkspaceNote === true,
      detail: safeJson(report.layers.browser.afterTyping),
    })

    /** 真选一个工作区（原生 select 的 value setter + change 事件）→ 按钮必须解禁。 */
    const picked = await browser.evaluate(`
      const select = document.querySelector('[data-wb-expert-field="workspace"]');
      if (select === null) return { ok: false, reason: 'no-select' };
      const options = Array.from(select.options).map((o) => o.value).filter((v) => v !== '');
      if (options.length === 0) return { ok: false, reason: 'no-option' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, options[0]);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: options[0], count: options.length };
    `)
    await sleep(900)
    const afterPick = await browser.evaluate(READ_EXPERT_DOM)
    const submitAfterPick = afterPick.actions.find((item) => item.action === 'start-generation') ?? null
    report.layers.browser.afterWorkspace = { picked, submit: submitAfterPick, errors: afterPick.errors }
    await browser.screenshot(`${suite.dir}/06-已选工作区.png`)
    suite.check({
      id: 'AX-E52 ⭐ 真实 DOM：选好工作区后「开始生成」解禁（受控输入真的驱动按钮态）', axId: 'AX-E52', layer: 'B',
      ok: picked.ok === true && submitAfterPick?.disabled === false,
      detail: safeJson(report.layers.browser.afterWorkspace),
    })
    /**
     * 收起弹窗，避免污染后续判据。
     *
     * ⚠️ 「取消」必须**限定在这份 create-modal 的 `.wb-dialog` 里**找：
     * 首跑用全局 `button` 列表找第一个文案为「取消」的按钮 —— 命中的是**设置弹窗** footer 的
     * 「取消」（`SettingsModal.tsx:179`），于是整个设置弹窗被关掉，
     * `data-wb-experts="admin"` 与它的 15 行 `data-wb-expert-id` 一起消失，
     * AX-E58 / AX-E56 双双假红（detail 里 `adminStillThere:false` / `rows:0`）。
     */
    const clickedCancel = await browser.evaluate(`
      const root = document.querySelector('[data-wb-experts="create-modal"]');
      const dialog = root === null ? null : root.closest('.wb-dialog');
      if (dialog === null) return { ok: false, reason: 'no-dialog' };
      const cancel = Array.from(dialog.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '取消');
      if (cancel === undefined) return { ok: false, reason: 'no-cancel-button' };
      cancel.click();
      return { ok: true, dialogClass: dialog.className };
    `)
    await sleep(900)
    const afterCancel = await browser.evaluate(READ_EXPERT_DOM)
    report.layers.browser.cancelled = { clickedCancel, drafts: afterCancel.drafts, adminRoots: afterCancel.roots }
    if (clickedCancel?.ok !== true) {
      suite.require({ id: '真实点击 create-modal 自己的「取消」（AX-E58 卸载判据的前置）', axId: 'AX-E58', layer: 'B', detail: safeJson(clickedCancel) })
    }
  }

  /**
   * ── 关闭弹窗后的稳定性 / 降级面（AX-E58）──────────────────────────────────
   *
   * 判据刻意**不是**"页面还有字"（那是恒真的假判据）。两条真实可失败的条件：
   * ① 新建弹窗真的消失了（`Modal` 走 portal，关闭是否真卸载 DOM 是 P8 的装配约束）；
   * ② 专家管理根仍在（`data-wb-experts="admin"` 不是一次性入口），且它渲染出的行/草稿
   *    在关弹窗后**没有被清空**（`useWorkbenchExperts` 的 catalog 状态不随弹窗重置）。
   */
  const afterClose = await browser.evaluate(READ_EXPERT_DOM)
  const modalGone = afterClose.roots.some((root) => root.kind === 'create-modal') === false
  const adminStillThere = afterClose.roots.some((root) => root.kind === 'admin')
  report.layers.browser.afterClose = { modalGone, adminStillThere, rows: afterClose.rows.length, drafts: afterClose.drafts.length }
  suite.check({
    id: 'AX-E58 ⭐ 真实 DOM：取消后 create-modal 真的从 DOM 卸载，而专家管理根与它的 catalog 状态仍在', axId: 'AX-E58', layer: 'B',
    ok: modalGone === true && adminStillThere === true && afterClose.rows.length > 0,
    detail: safeJson(report.layers.browser.afterClose),
  })
  suite.check({
    id: 'AX-E56 ⭐ 真实 DOM：专家管理里每行都带 data-wb-expert-id + data-wb-expert-status（行级选择器真的渲染）', axId: 'AX-E56', layer: 'B',
    ok: afterClose.rows.length > 0 && afterClose.rows.every((row) => typeof row.id === 'string' && row.id !== '' && typeof row.status === 'string' && row.status !== ''),
    detail: safeJson(afterClose.rows.slice(0, 6)),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// M/B：真实模型（AX-E60/E61/E62）—— **走真实 DSH 会话通道**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本层的通道口径（P10 定案；P11 修掉了"产品自己不派发"的缺陷，见 `runExpertGenerationProbe()` 里
 * "P11 判据核心"那段注释）。
 *
 * 「生成专家」**不是**插件直接调 LLM：插件客户端新建一个**独立 DSH 会话**
 *（`src/client/hooks/useWorkbenchExperts.ts:746` 的 `sessions.create({ workspaceId })`），
 * 把插件自己构造的 prompt（`:630-645`）当**普通用户消息**发进去（`:789-792`
 * `session.prompt([...], 'queue')`），生成会话**自己的 AI** 再调用插件注册的 5 个草稿工具
 *（`src/experts/tools.ts:559-576`）。所以模型层只能这么验：
 *
 * 1. 真浏览器走 UI 把生成会话**开出来**（真实的 `sessions.create` + 真实的 generation-start）；
 * 2. 从 `~/.dsh/sessions/<项目键>/<sessionId>/session.v*.jsonl.zstd` 读**真实会话记录**：
 *    `user/message`（prompt 真的发出去了）、`request/header.data.header.tools[]`（模型**真的**被
 *    给了这 5 个工具）、`tool/call`（模型**真的**调了它们）；
 * 3. 目标库（隔离 `verify.db`）复读该草稿行：`contentVersion` / `phase` / `validation` /
 *    `session_id`；
 * 4. 正式角色库（用户 personas 根）在**确认前**不许出现这个 expertId。
 *
 * 三条硬纪律：
 * - **禁止**换假 provider / 伪造模型响应 / 新增隐式 skip 白名单；
 * - 拿不到时如实 `skipped` + **具体阻塞原因 + 收集到的原始证据**，绝不假通过；
 * - 真实模型调用**每次运行 ≤ 6 次**（`MODEL_CALL_BUDGET`），每次都记耗时与结果。
 */

/** 真实模型调用的硬预算（本批口径 ≤6 次/次运行）。 */
const MODEL_CALL_BUDGET = 6

/**
 * 5 个专家生成工具的**权威名字**（口径唯一来源：`src/experts/tools.ts:570-576` 的
 * `EXPERT_GENERATION_TOOL_NAMES`）。刻意在套件里再抄一份而**不 import 产品源码**：
 * 判据要能独立失败 —— 哪天源码改了工具名而套件没跟上，实测的 `request/header` 清单对不上就会红。
 */
const EXPERT_GENERATION_TOOL_NAMES = [
  'workbench_get_expert_draft',
  'workbench_submit_expert_draft',
  'workbench_stage_expert_file',
  'workbench_remove_expert_staged_file',
  'workbench_validate_expert_draft',
]

/** 本层真的发出了几次 prompt（只有它是预算依据；读 DB / 读 JSONL 不算）。 */
let modelCallsMade = 0
const modelCallLog = []

/** 发送一次真实 prompt，记耗时与结果（预算超了就拒绝发送并返回 null）。 */
async function sendModelMessage(sessionId, text, label) {
  if (modelCallsMade >= MODEL_CALL_BUDGET) {
    suite.note(`真实模型调用预算已用尽（${MODEL_CALL_BUDGET} 次），跳过「${label}」`)
    return null
  }
  modelCallsMade += 1
  const startedAt = Date.now()
  const entry = { label, sessionId, startedAt: new Date(startedAt).toISOString(), ok: false, note: '', typedPrefix: '' }
  try {
    /**
     * ⚠️ P10 第七次单跑的实际失败点：**光点一下不一定把焦点落到 composer 上**。
     * 那次 `typedPrefix` 是空串（说明 `Input.insertText` 没有进到输入框），但旧代码照样写
     * `ok:true` ⇒ 看上去"发出去了"，实际一条消息都没发，白等 600s。
     * 所以这里每一步都要**验证**：焦点在不在 composer、文本有没有真的进去；失败就如实 `ok:false`
     * 并把现场写进 `entry.note`（调用方会把它当阻塞原因记 skip，不会假通过）。
     */
    const box = await browser.evaluate(`
      const el = document.querySelector('[data-composer-input="true"]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    `)
    if (box === null) throw new Error('页面上没有 composer（data-composer-input）')
    entry.box = box
    const focusComposer = () => browser.evaluate(`
      const el = document.querySelector('[data-composer-input="true"]');
      if (el === null) return { ok: false, reason: 'no-composer' };
      el.focus();
      const active = document.activeElement;
      return { ok: active === el || el.contains(active), activeTag: active === null ? null : active.tagName };
    `)
    await browser.clickAt(box.x, box.y)
    await sleep(400)
    let focus = await focusComposer()
    if (focus.ok !== true) {
      await browser.evaluate(`
        const el = document.querySelector('[data-composer-input="true"]');
        if (el !== null) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        if (el !== null) el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        if (el !== null) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      `)
      await sleep(300)
      focus = await focusComposer()
    }
    entry.focus = focus
    if (focus.ok !== true) throw new Error(`composer 拿不到焦点（${safeJson(focus)}），insertText 会落空`)
    await browser.cdp.send('Input.insertText', { text })
    await sleep(800)
    const typed = await browser.evaluate(`return (document.querySelector('[data-composer-input="true"]')?.textContent || '');`)
    entry.typedPrefix = String(typed).slice(0, 60)
    entry.typedChars = String(typed).length
    if (String(typed).trim() === '') throw new Error('insertText 之后 composer 仍然是空的（消息根本没写进去）')
    await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await sleep(1500)
    const cleared = await browser.evaluate(`return (document.querySelector('[data-composer-input="true"]')?.textContent || '').trim();`)
    entry.afterSendChars = String(cleared).length
    entry.ok = true
    entry.note = `焦点=${String(focus.ok)} 写入=${String(entry.typedChars)} 字符，回车后残留=${String(entry.afterSendChars)} 字符`
    modelCallLog.push(entry)
    return entry
  } catch (error) {
    entry.ok = false
    entry.error = error instanceof Error ? error.message : String(error)
    modelCallLog.push(entry)
    return entry
  }
}

// ── 会话记录的读取（真实证据来源）────────────────────────────────────────────

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** 采集 `~/.dsh/sessions/<项目>/<会话目录>` 的名单（用于判"哪些是新会话"）。 */
function snapshotSessionDirs() {
  const found = new Map()
  if (existsSync(SESSIONS_ROOT) === false) return found
  for (const project of readdirSync(SESSIONS_ROOT)) {
    let entries = []
    try { entries = readdirSync(join(SESSIONS_ROOT, project)) } catch { continue }
    for (const entry of entries) {
      const dir = join(SESSIONS_ROOT, project, entry)
      try { found.set(`${project}/${entry}`, { dir, mtimeMs: statSync(dir).mtimeMs }) } catch { /* 目录刚被清掉就忽略 */ }
    }
  }
  return found
}

function sessionDirOf(project, entry) {
  return join(SESSIONS_ROOT, project, entry)
}

/**
 * 按**会话 id** 在 `~/.dsh/sessions` 树里找目录（不依赖目录里已经有 JSONL）。
 *
 * P10 实测：宿主 `sessions.create()` 会**立刻**建出 `<项目键>/<session-…|uuid>` 目录，但 `session.v4.jsonl.zstd`
 * 要过一会儿才落盘。所以"草稿行的 `session_id` 在磁盘上有目录"是**比读 JSONL 更早、更稳**的判据；
 * 目录名有两种写法（`session-<uuid>` 与裸 `<uuid>`）,两种都要认。
 */
function sessionDirBySessionId(sessionId) {
  const needle = String(sessionId ?? '')
  if (needle === '' || existsSync(SESSIONS_ROOT) === false) return null
  const bare = needle.startsWith('session-') ? needle.slice('session-'.length) : needle
  const candidates = [needle, `session-${bare}`]
  for (const project of readdirSync(SESSIONS_ROOT)) {
    let entries = []
    try { entries = readdirSync(join(SESSIONS_ROOT, project)) } catch { continue }
    for (const entry of entries) {
      if (candidates.includes(entry) === false) continue
      const dir = join(SESSIONS_ROOT, project, entry)
      try { if (statSync(dir).isDirectory()) return dir } catch { /* 刚被清掉就继续找 */ }
    }
  }
  return null
}

/**
 * 解压会话 JSONL 并解析成事件数组。
 *
 * ⚠️ **多帧 zstd 拼接**是这条路的唯一真实坑（P9 的 `persona.mjs` 只记了"压缩时无法按文本扫描"，
 * P10 实测出真正的原因与解法）：`session.v4.jsonl.zstd` 是**逐帧追加**的，`zstdDecompressSync(raw)`
 * 只解第一帧（实测 267KB → 289 字节，只剩 `session` 头）。正确做法是扫 `28 b5 2f fd`（frame magic）
 * 的偏移逐帧解压再拼。
 */
function readSessionEvents(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl.zstd'))
  if (files.length === 0) return { files, bytes: 0, events: [], frames: 0, failedFrames: 0 }
  const raw = readFileSync(join(dir, files[0]))
  const offsets = []
  for (let index = 0; index + 4 <= raw.length; index += 1) {
    if (raw[index] === 0x28 && raw[index + 1] === 0xb5 && raw[index + 2] === 0x2f && raw[index + 3] === 0xfd) offsets.push(index)
  }
  offsets.push(raw.length)
  let text = ''
  let failedFrames = 0
  for (let index = 0; index < offsets.length - 1; index += 1) {
    try { text += zstdDecompressSync(raw.subarray(offsets[index], offsets[index + 1])).toString('utf8') } catch { failedFrames += 1 }
  }
  const events = text.split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  return { files, bytes: raw.length, events, frames: offsets.length - 1, failedFrames, text }
}

/** 会话记录的**只读摘要**（写进证据的就是这个，不落全文）。 */
function sessionSummary(dir) {
  const read = readSessionEvents(dir)
  const events = read.events ?? []
  const head = events.find((event) => event.type === 'session')
  const header = events.find((event) => event.type === 'request/header')
  /**
   * ⚠️ **事件形状不统一**，P10 实测出来的（读错就全是 null，会把"会话建出来了"误判成"没建"）：
   * - `session` 事件的字段在**事件根上**（`{type,version,id,createdAt,cwd,isSeeded,delegationDepth,agentPreset}`），
   *   没有 `data`；
   * - `user/message`、`session/title`、`request/header` 等才把内容放在 `data` 里
   *   （`request/header` 是 `data.header.tools` / `data.header.config`）。
   */
  const calls = events.filter((event) => event.type === 'tool/call').map((event) => ({
    name: event.data.name,
    args: String(event.data.arguments ?? '').slice(0, 200),
    callId: event.data.callId,
  }))
  const results = events.filter((event) => event.type === 'tool/result').map((event) => ({ callId: event.data.toolCallId, ok: event.data.message?.isError !== true }))
  const users = events.filter((event) => event.type === 'user/message').map((event) => ({
    seq: event.seq,
    text: (event.data.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('').slice(0, 300),
  }))
  const titles = events.filter((event) => event.type === 'session/title').map((event) => event.data.title)
  return {
    files: read.files,
    bytes: read.bytes,
    frames: read.frames,
    failedFrames: read.failedFrames,
    events: events.length,
    typeCounts: events.reduce((accumulator, event) => { accumulator[event.type] = (accumulator[event.type] ?? 0) + 1; return accumulator }, {}),
    sessionId: head?.id ?? head?.data?.id ?? null,
    cwd: head?.cwd ?? head?.data?.cwd ?? null,
    parentSession: head?.parentSession ?? head?.data?.parentSession ?? null,
    delegationDepth: head?.delegationDepth ?? head?.data?.delegationDepth ?? null,
    titles,
    userMessages: users,
    toolsOffered: header === undefined ? null : header.data.header.tools.map((tool) => tool.name),
    model: header?.data?.header?.config ?? null,
    toolCalls: calls,
    toolResults: results,
  }
}

/**
 * 第一条 `user/message` 的**全文读数**（`sessionSummary` 只取前 300 字，判"是不是产品自己发的那条 prompt"不够）。
 *
 * 为什么需要它：P11 的核心判据是「点「开始生成」后**产品自己**把提示词发给模型」。
 * 提供 `sha256` + 头尾片段，配合 `pluginDispatch.suiteModelCallsAtDetection`（探测到它时套件的
 * 真实模型调用计数，正常为 0）就能证明**这条消息是产品发的、不是人打的** —— 套件自己没有任何
 * 手工发送动作，唯一的人手通道是后面的 composer 兜底，而那时 `dispatchPath` 已是 `composer-fallback`。
 */
function firstUserMessageFull(dir) {
  const read = readSessionEvents(dir)
  const event = (read.events ?? []).find((entry) => entry.type === 'user/message')
  if (event === undefined) return null
  const text = (event.data?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
  return {
    seq: event.seq ?? null,
    chars: text.length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase(),
    head: text.slice(0, 400),
    tail: text.slice(-160),
  }
}

/**
 * 从源码**逐字**取回插件发给生成会话的 prompt（`buildExpertGenerationPrompt`）。
 *
 * ⚠️ 这是**兜底通道**的素材。P10 实测里它是必须的：宿主**没有把插件排队的那条 prompt 派发出去**
 * （缺陷的现场与 P11 的修复见 `runExpertGenerationProbe()` 里的注释）。P11 修复后正常路径走不到这里：
 * 套件先在会话 JSONL 上轮询，产品自己那条 `user/message` 一到就跳过换会话与补发。
 * 真走到补发这一步时，"prompt 内容到底对不对"就不能靠"某条消息出现过"来证明。做法是从
 * `src/client/hooks/useWorkbenchExperts.ts` 抽出 `buildExpertGenerationPrompt` 的**字面量行**，
 * 组装出与插件**同一份**文本，再用**真实键盘**从页面 composer 发出去 —— 送信通道仍是
 * 真宿主的 composer（不是 API 造假），prompt 文本与插件逐字一致（抽不到就如实返回 null，
 * 本层转 skip，不猜）。
 */
function readPluginGenerationPrompt(request, methodology) {
  const source = readFileSync(join(ROOT, 'src', 'client', 'hooks', 'useWorkbenchExperts.ts'), 'utf8')
  const fn = source.slice(source.indexOf('export function buildExpertGenerationPrompt'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  const literals = [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
  const start = literals.indexOf('你在本工作台里负责**新建一位专家角色**（人格文档 + 需要的 skill）。')
  const tail = literals.indexOf('不要自己去写工作台的数据文件，也不要请求用户手动复制文件。')
  if (start < 0 || tail < 0) return null
  /** 模板里的两处插值是 `input.methodology.trim()` 与 `input.request.trim()`，按出现顺序替换。 */
  const output = []
  let substituted = 0
  for (let index = start; index <= tail; index += 1) {
    const literal = literals[index]
    if (literal === '## 方法论（全文）') { output.push(literal, methodology.trim()); substituted += 1; continue }
    if (literal === '## 用户的请求') { output.push(literal, request.trim()); substituted += 1; continue }
    output.push(literal)
  }
  return substituted === 2 ? output.join('\n') : null
}

/** 目标库里某个会话名下的专家草稿行（`phase` / `contentVersion` 在 payload_json 里）。 */
async function readExpertDraftRow(sessionId, draftId) {
  const { DatabaseSync } = await import('node:sqlite')
  if (options.dbPath === '' || existsSync(options.dbPath) === false) return { error: `目标库不存在或未给出：${options.dbPath === '' ? '(空)' : options.dbPath}` }
  const database = new DatabaseSync(options.dbPath, { readOnly: true })
  try {
    const row = draftId === undefined
      ? database.prepare(`select id, session_id, status_code, created_at, payload_json from task_drafts
          where kind_code = 'expert' and session_id = ? order by created_at desc limit 1`).get(sessionId)
      : database.prepare(`select id, session_id, status_code, created_at, payload_json from task_drafts
          where kind_code = 'expert' and id = ? limit 1`).get(draftId)
    if (row === undefined) return { found: false }
    const payload = JSON.parse(row.payload_json)
    return {
      found: true,
      id: row.id,
      sessionId: row.session_id,
      statusCode: row.status_code,
      createdAt: row.created_at,
      contentVersion: payload.contentVersion,
      phase: payload.phase,
      expertId: payload.expertId,
      request: payload.request,
      personaChars: String(payload.personaMd ?? '').length,
      skills: Array.isArray(payload.skills) ? payload.skills.length : 0,
      files: Array.isArray(payload.files) ? payload.files.length : 0,
      provenanceKind: payload.provenance?.creationKind ?? null,
      validation: payload.validation ?? null,
      lastInstallError: payload.lastInstallError ?? null,
    }
  } finally { database.close() }
}

/**
 * 目标库里**所有 pending 的专家草稿**关联的会话 id（生成前快照，用来判"哪一行是本次新建的"）。
 * 只读、失败返回空数组（后面任何一步拿不到草稿行都会如实落进 skip 原因）。
 */
async function listPendingExpertDraftSessionIds() {
  if (options.dbPath === '' || existsSync(options.dbPath) === false) return []
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(options.dbPath, { readOnly: true })
  try {
    const rows = database.prepare(`select session_id from task_drafts
      where kind_code = 'expert' and status_code = 'pending'`).all()
    return rows.map((row) => String(row.session_id ?? '')).filter((id) => id !== '')
  } catch { return [] } finally { database.close() }
}

/** 目标库里**最近若干行**专家草稿（按 created_at 倒序），供"这次点出来的那一行"的筛选使用。 */
async function readRecentExpertDraftRows(limit = 12) {
  if (options.dbPath === '' || existsSync(options.dbPath) === false) {
    return { rows: [], error: `目标库不存在或未给出：${options.dbPath === '' ? '(空)' : options.dbPath}` }
  }
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(options.dbPath, { readOnly: true })
  try {
    const rows = database.prepare(`select id, session_id, status_code, created_at from task_drafts
      where kind_code = 'expert' order by created_at desc limit ?`).all(limit)
    return { rows: rows.map((row) => ({ id: row.id, sessionId: row.session_id, statusCode: row.status_code, createdAt: row.created_at })) }
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) }
  } finally { database.close() }
}

/** 用户正式角色库根（与 `src/personas/library.ts:59` 的 `defaultUserPersonaRoot` 同一口径）。 */
const USER_PERSONA_ROOT = join(homedir(), '.dsh', 'workbench', 'personas')

/**
 * 正式角色库里有没有这个 expert（**确认前**必须没有）。
 *
 * 专家 id 形如 `generated/<uuid>`（`defaultExpertId()`），P10 实测确认前用户库**整个目录都不存在**；
 * 所以判据是"用户库根下递归任何文件/目录名或内容里出现这个 expertId"。刻意不用"目录存在=有"：
 * 别的专家装过一次之后目录就会存在，那条会变成假绿。
 */
function expertInUserLibrary(expertId) {
  const needle = String(expertId ?? '')
  if (needle === '') return { checked: false, reason: 'expertId 为空' }
  if (existsSync(USER_PERSONA_ROOT) === false) return { checked: true, present: false, rootExists: false, root: USER_PERSONA_ROOT }
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (full.includes(needle) || entry.name.includes(needle.replace('generated/', ''))) { hits.push(full); continue }
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        try { if (readFileSync(full, 'utf8').includes(needle)) hits.push(full) } catch { /* 读不了就当没命中 */ }
      }
    }
  }
  walk(USER_PERSONA_ROOT, 0)
  return { checked: true, present: hits.length > 0, hits: hits.slice(0, 5), rootExists: true, root: USER_PERSONA_ROOT }
}

/**
 * 在**真实的 `start-generation` 弹窗**里发起一次生成（AX-E60 的入口动作）。
 *
 * 工作区**刻意选仓库自己那个**（`D:\Code\<company>\dsh-workbench`）而不是"第一个选项"：
 * P10 首跑用 `options[0]` 落到 `D:\Game\Minecraft`，生成会话就被开在了另一个项目目录里 ——
 * 会话记录在哪个项目键下取决于 `workspaceId` 指向的路径，选错会让"找会话目录"这一步
 * 变得不可判。这里按 `<option>` 的**展示文案**匹配（宿主的 option value 就是 path）。
 */
async function startGenerationViaUi(request) {
  const steps = {}
  await ensureWorkbenchPanel(browser)
  await sleep(800)
  steps.settingsClick = await browser.clickByText('设置', '.wb-h button')
  await sleep(1200)
  if (await browser.evaluate(`return document.querySelector('[data-wb-experts="admin"]') !== null;`) !== true) {
    await browser.clickByText('角色库', '.wb-settings-nav button')
    await sleep(1200)
  }
  steps.adminPresent = await browser.evaluate(`return document.querySelector('[data-wb-experts="admin"]') !== null;`)
  steps.createClick = await browser.evaluate(`
    const el = document.querySelector('[data-wb-expert-action="create"]');
    if (el === null) return 'no-entry';
    el.click();
    return 'ok';
  `)
  await sleep(1000)
  steps.typed = await browser.evaluate(`
    const input = document.querySelector('[data-wb-expert-field="request"]');
    if (input === null) return false;
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, ${JSON.stringify(request)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await sleep(400)
  steps.workspace = await browser.evaluate(`
    const select = document.querySelector('[data-wb-expert-field="workspace"]');
    if (select === null) return { ok: false, reason: 'no-select' };
    /**
     * ⚠️ P10 实战教训（两条，都是实测打脸）：
     * 1. 这个下拉的 **value 是工作区 UUID，不是路径**；路径只在 textContent 上
     *    （实测 value=3e7c363d-… 对应 text=D:\Game\Minecraft）。
     *    第一版按 value 找路径 ⇒ 一个都匹配不上 ⇒ 静默留在默认项，生成会话被开到了别的仓库
     *    （实测落到 --D-Game-Minecraft-- 项目目录下，草稿的会话行也在那儿）。
     * 2. 路径比较必须**归一化**（反斜杠→斜杠、小写、去尾斜杠）：工作区行里的路径不保证与
     *    repoRootFromSuite() 逐字相同（盘符大小写、斜杠方向都可能不同）。
     * 所以：按 **textContent** 归一化后找，找不到再退回目录名后缀，找不到就**如实报错**，
     * 绝不静默用默认项（那会把生成会话开到别的仓库里去）。
     */
    const target = ${JSON.stringify(ROOT)}.replace(/\\\\/g, '/').replace(/\\/+$/, '').toLowerCase();
    const label = ${JSON.stringify(basename(ROOT))}.toLowerCase();
    const options0 = Array.from(select.options).filter((option) => option.value !== '');
    const normalize = (value) => String(value ?? '').replace(/\\\\/g, '/').replace(/\\/+$/, '').toLowerCase();
    const textOf = (option) => normalize(option.textContent);
    const wanted = options0.find((option) => textOf(option) === target)
      ?? options0.find((option) => textOf(option).split('/').pop() === label);
    if (wanted === undefined) {
      return {
        ok: false,
        reason: 'no-matching-workspace',
        target,
        available: options0.map((option) => ({ value: option.value, text: String(option.textContent || '').trim() })).slice(0, 8),
      };
    }
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, wanted.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: wanted.value, label: String(wanted.textContent || '').trim() };
  `)
  await sleep(600)
  steps.submitState = await browser.evaluate(`
    const btn = document.querySelector('[data-wb-expert-action="start-generation"]');
    return btn === null ? null : { disabled: btn.disabled === true, text: (btn.textContent || '').trim() };
  `)
  await browser.screenshot(`${suite.dir}/10-生成入口已填.png`).catch(() => undefined)
  steps.clicked = await browser.evaluate(`
    const btn = document.querySelector('[data-wb-expert-action="start-generation"]');
    if (btn === null) return { ok: false, reason: 'no-button' };
    if (btn.disabled === true) return { ok: false, reason: 'disabled' };
    btn.click();
    return { ok: true };
  `)
  return steps
}

/**
 * AX-E60 的主流程：真浏览器开生成会话 → 找到**那个**会话的 JSONL → 等模型真的调工具。
 *
 * 时序（P10 实测；P11 起"产品自己派发"成为判据）：宿主建会话是**秒级**，但新会话的第一轮要按分钟计时
 *（P10 实测 14:06:40 建会话 → 14:13:39 才出现第一条 `user/message`；那一次的第一条消息是**人手工补发**的）。
 * 所以这里给足预算：`DSH_VERIFY_EXPERT_DISPATCH_MS`（默认 **180000ms**，轮询 10s 一次）等**产品自己**
 * 把排队的 prompt 派发出来，`DSH_VERIFY_EXPERT_TURN_MS`（默认 600000ms）等模型把工具调完；
 * 派发超时就退到换会话 + composer 兜底（`dispatchPath='composer-fallback'`，产品通道判红）。**不假通过**。
 */
async function runExpertGenerationProbe() {
  const findings = { steps: {}, notes: [], calls: [], evidence: {} }
  if (browser === undefined) return { ok: false, reason: '浏览器层没有起来（真实 DOM 判据的前置缺失），无法走 UI 开生成会话', findings }
  if (options.dbPath === '' || existsSync(options.dbPath) === false) {
    return { ok: false, reason: `没有目标库路径（--db-path / WORKBENCH_EXPECTED_DB_PATH），无法复读草稿行：${options.dbPath === '' ? '(空)' : options.dbPath}`, findings }
  }
  const before = snapshotSessionDirs()
  findings.notes.push(`生成前会话目录 ${before.size} 个`)
  /**
   * 生成前先把"库里已存在的 pending 专家草稿"快照下来：本次生成创建的草稿一定是**新的**那一行。
   * 这样即使前端报错（P10 的缺陷现场；P11 修复后正常不该有 `[data-wb-expert-error]`），
   * 我们仍能拿到宿主真正建出的生成会话 id。
   */
  const pendingBefore = await listPendingExpertDraftSessionIds()
  const startedAtIso = new Date().toISOString()

  /** 极短请求（≤60 字）：真实模型计费，本批刻意用最短的需求文本。 */
  const request = `验证用：只做一件事——按方法论新建「验证用就绪专家」，只回答「就绪」。runId=${runId}`
  findings.request = request
  findings.requestChars = request.length
  findings.steps.start = await startGenerationViaUi(request)
  /**
   * 前端把失败原因渲染在 `[data-wb-expert-error]` 上：这是**产品侧缺陷的现场证据**，必须记
   *（P10 的平铺响应缺陷就在这里显示 `generation-start-failed`；P11 修好后正常应为 `null`）。
   */
  findings.uiError = await browser.evaluate(`
    const el = document.querySelector('[data-wb-expert-error]');
    return el === null ? null : { code: el.getAttribute('data-wb-expert-error'), text: (el.textContent || '').trim().slice(0, 200) };
  `).catch(() => null)

  // ── 找**它**建出来的会话目录（不看草稿行、不看 JSONL 有没有内容）────────────────
  /**
   * P10 第三次单跑的教训：**草稿行不能当起点**。同一套件前面的 HTTP 层（`checkHttpLayer`）会为本轮 `runId`
   * 直接 `POST /api/workbench/experts/generation-start` 造一条草稿行，`created_at` 比 UI 这次点击更晚，
   * 且 `session_id` 是**合成 id**（`verify-expert-<runId>-gen`，磁盘上没有对应目录）；只按 DB 取"最新一行"
   * 就会拿一个磁盘上不存在的会话 id 去找目录，白等 180s。
   * 反过来，**磁盘证据**是硬的：`sessions.create()` 会立刻建出 `<项目键>/<session-…|uuid>` 目录。
   * 所以顺序改成：先按目录认会话 → 再用它的 id 去 DB 认草稿行。
   */
  const buildRows = (keys) => {
    const now = snapshotSessionDirs()
    const rows = []
    for (const key of keys) {
      const [project, entry] = key.split('/')
      const dir = sessionDirOf(project, entry)
      try { rows.push({ key, project, entry, dir, mtimeMs: now.get(key)?.mtimeMs ?? 0, ...sessionSummary(dir) }) } catch { /* 目录正在写，下一轮再看 */ }
    }
    return rows
  }
  const freshKeys = () => {
    const now = snapshotSessionDirs()
    return [...now.keys()].filter((key) => before.has(key) === false)
  }
  const rowForKey = (key) => buildRows([key])[0] ?? null
  const rootKey = ROOT_PROJECT_KEY
  const rootNorm = ROOT_NORM
  /**
   * 选中规则（P10 实测教训：**不能只取"最新一个"**，同一次点击可能同时冒出别的项目的新会话）：
   * 1. 新目录里 `session` 事件的 `cwd` 等于仓库根；
   * 2. 项目键匹配仓库根；
   * 3. 两者都没有时报出全部新目录让调用方如实记 skip。
   */
  const pickSession = () => {
    const fresh = freshKeys()
    const freshRows = buildRows(fresh)
    const match = freshRows.find((row) => row.key.startsWith(rootKey))
      ?? freshRows.find((row) => row.sessionId !== null && String(row.cwd ?? '').replace(/\\/g, '/').toLowerCase() === rootNorm)
      ?? null
    return { fresh, freshRows, match }
  }

  let tracked = null
  let waited = 0
  const dispatchBudget = Number(process.env.DSH_VERIFY_EXPERT_DISPATCH_MS ?? '180000')
  while (waited < dispatchBudget) {
    const { fresh, freshRows, match } = pickSession()
    if (tracked === null && match !== null) {
      tracked = match
      findings.notes.push(`新会话目录 ${fresh.length} 个：${JSON.stringify(fresh.slice(0, 4))}；选中 ${match.key}（来源：cwd/项目键）`)
    }
    const freshSessionIds = freshRows.filter((row) => row.sessionId !== null).map((row) => row.sessionId)
    if (freshSessionIds.length > 0) findings.sessionIds = freshSessionIds
    if (tracked !== null) {
      const current = rowForKey(tracked.key) ?? tracked
      tracked = current
      /**
       * 停等条件：这个会话**真的落了一条 JSONL**（有 `session` 事件 / 有 user 消息 / 有工具调用）。
       * P10 第一版要求 `events > 4`，结果把"宿主建了会话但 JSONL 只有 4 条握手事件"当成"没建会话"
       * —— 那会把**产品缺陷**误报成"环境里没有会话"，判据必须只认"这条目录存在且可读"。
       */
      if ((current.sessionId ?? null) !== null && (current.events ?? 0) >= 1) break
      if ((current.userMessages ?? []).length > 0 || (current.toolCalls ?? []).length > 0) break
    }
    await sleep(5000)
    waited += 5000
    if (waited % 60000 === 0) findings.notes.push(`等待生成会话落盘 ${waited / 1000}s（新目录 ${fresh.length} 个）`)
  }
  findings.runified = { waitedMs: waited, dispatchBudget }
  if (tracked === null) {
    return {
      ok: false,
      reason: `点「开始生成」后 ${Math.round(waited / 1000)}s 内没有在 ~/.dsh/sessions 下看到这次点出来的会话目录（仓库根 ${ROOT}；新目录 ${freshKeys().length} 个）`,
      findings,
    }
  }
  const draftSessionId = tracked.sessionId ?? null
  findings.draftSessionId = draftSessionId
  findings.session = sessionSummary(tracked.dir)

  // ── P11 判据核心：**产品自己**把提示词发给模型了吗？──────────────────────────
  /**
   * 为什么这段必须独立存在（P11 新增，直接对着 P10 的漏洞）：
   *
   * P10 实测的缺陷是：前端第 7 步把**平铺**响应当 `res.draft.id` 读（服务端给的是顶层 `draftId`）
   * ⇒ 判"服务端没有返回草稿"⇒ 第 9 步 `session.prompt([...], 'queue')` 永不执行
   * ⇒ 用户点「开始生成」什么都不会发生。P11 的修复见
   * `src/client/hooks/useWorkbenchExperts.ts:400` 的 `normalizeExpertDraftResponse()`。
   *
   * 但套件里有一条**手工补发**的兜底通道（`readPluginGenerationPrompt` 逐字复刻 + 真实 composer 发送），
   * 而 E60 原来只看"模型有没有调工具 + 草稿有没有落库"⇒ **功能坏了也能亮绿灯**
   * （P10 的 4280 字符 prompt 就是分析者手工打进真实输入框的）。所以这里先在**被追踪会话的 JSONL** 上轮询：
   * 一旦出现插件自己那条 `user/message`（`session.prompt(..., 'queue')` 落到会话记录），
   * 就认 `plugin-queued`，并且**整段"关浏览器 + 冷启动换会话"直接跳过** —— 产品会自己把会话开到主视图
   * （`useWorkbenchExperts.ts:851` 的 `openSessionInMainView`），没有人需要打开发输入框。
   * 预算内没出现才走换会话 + composer 兜底，但产品通道判红（见 `checkModelLayer()` 的新 check）。
   *
   * 预算旋钮 `DSH_VERIFY_EXPERT_DISPATCH_MS`（默认 180000ms），轮询间隔 10s（要求 5–15s）。
   */
  const pluginDispatchBudgetMs = Number(process.env.DSH_VERIFY_EXPERT_DISPATCH_MS ?? '180000')
  const PLUGIN_DISPATCH_INTERVAL_MS = 10000
  let pluginDispatchWaited = 0
  /** @type {{budgetMs:number,intervalMs:number,waitedMs:number,dispatched:boolean,samples:object[],suiteModelCallsAtDetection:number|null}} */
  findings.pluginDispatch = {
    budgetMs: pluginDispatchBudgetMs,
    intervalMs: PLUGIN_DISPATCH_INTERVAL_MS,
    waitedMs: 0,
    dispatched: false,
    samples: [],
    suiteModelCallsAtDetection: null,
  }
  let pluginDispatchSeen = (findings.session.userMessages ?? []).length > 0
  while (pluginDispatchSeen === false && pluginDispatchWaited < pluginDispatchBudgetMs) {
    await sleep(PLUGIN_DISPATCH_INTERVAL_MS)
    pluginDispatchWaited += PLUGIN_DISPATCH_INTERVAL_MS
    const snapshot = { ...tracked, ...sessionSummary(tracked.dir) }
    tracked = snapshot
    findings.session = snapshot
    if (findings.pluginDispatch.samples.length < 60) {
      findings.pluginDispatch.samples.push({
        atMs: pluginDispatchWaited,
        events: snapshot.events ?? 0,
        userMessages: (snapshot.userMessages ?? []).length,
        toolCalls: (snapshot.toolCalls ?? []).length,
      })
    }
    if ((snapshot.userMessages ?? []).length > 0) pluginDispatchSeen = true
  }
  findings.pluginDispatch.waitedMs = pluginDispatchWaited
  findings.pluginDispatch.dispatched = pluginDispatchSeen
  /** 探测到的那一刻套件发过几次真实 prompt：正常是 **0**（这就是"不是人打的"的硬证据）。 */
  findings.pluginDispatch.suiteModelCallsAtDetection = modelCallsMade
  findings.pluginFirstUserMessage = pluginDispatchSeen ? firstUserMessageFull(tracked.dir) : null
  /**
   * 派发通道**只有一个真值来源**：被追踪会话的 JSONL。
   * `plugin-queued` = 产品自己那条 `user/message` 到位；`not-dispatched-within-budget` = 预算内没等到
   *（后面若走 composer 兜底会改写成 `composer-fallback`，两者都会被新 check 判红）。
   */
  findings.dispatchPath = pluginDispatchSeen ? 'plugin-queued' : 'not-dispatched-within-budget'
  findings.notes.push(`产品派发轮询：${pluginDispatchWaited / 1000}s 内 ${pluginDispatchSeen ? '看到' : '没看到'}插件自己那条 user/message（dispatchPath=${findings.dispatchPath}）`)

  // ── 草稿行（用**刚认下来的会话 id** 去 DB 取，不用"最新一行"）──────────────────
  const recent = await readRecentExpertDraftRows(12)
  findings.recentDraftRows = recent.rows
  const startRow = (draftSessionId === null ? undefined : await readExpertDraftRow(draftSessionId)) ?? {}
  findings.startDraftRow = startRow
  /**
   * P10 实测的**产品缺陷**与 P11 的**修复**（历史保留；文档不要再说"缺陷仍在"）：
   *
   * - 缺陷（P10 实测）：前端 `useWorkbenchExperts.start()` 在第 7 步把**平铺**响应当成 `res.draft.id` 读
   *   （服务端 `expertDraftView()` 给的是顶层 `draftId`，没有 `id`/`payload`）⇒ 前端判"服务端没有返回草稿"
   *   并**提前 return**，于是第 9 步的 `session.prompt([...], 'queue')` **根本不会执行**。
   *   草稿行与会话都已真实存在，卡住的只有"插件自己把 prompt 发出去"这一步。
   * - 修复（P11，已合入工作区）：三处读取统一走 `normalizeExpertDraftResponse()`
   *   （`src/client/hooks/useWorkbenchExperts.ts:400`，认 `id` / `draftId` 两种形状，都不是才返回 null）。
   *
   * `pluginPromptDispatchBlocked` 保留原名，但**判据换成上面实测出来的 `dispatchPath`**：
   * P10 用的 `startRow.createdAt > startedAtIso` 启发式在修复后**恒真**（草稿行本来就是这次点击建出来的），
   * 留着只会误导；`createdAt` 与点击时刻的关系另记 `draftRowCreatedDuringClick` 作对照证据。
   */
  findings.draftRowCreatedDuringClick = typeof startRow.createdAt === 'string' && startRow.createdAt > startedAtIso
  findings.pluginPromptDispatchBlocked = findings.dispatchPath !== 'plugin-queued'

  /**
   * 在**同一个真实浏览器**里把这个生成会话切成「SPA 当前会话」。
   *
   * ⚠️ P10 实测的四条硬事实（都有独立探针，别凭直觉改）：
   *
   * 1. **`?token=…&session=<id>` 对 SPA 无效**。`_p10_probe_current.mjs` 连做多次 `Page.navigate`
   *    换 `?session=`（f4d437a3 → 7ec1bdca → 别的 id），SPA 自己的
   *    `localStorage['dsh.sessions.current']` **一次都没变**；查询串还被应用壳立刻抹掉
   *    （`location.href` 恒为 `http://127.0.0.1:3080/`）。后果实测很严重：run 9 把 4280 字符的插件
   *    prompt 发进了**另一个**会话（`session-f4d437a3-…`，那是更早一次运行留下的"当前会话"），
   *    被追踪的 `session-7ec1bdca-…` 于是永远只有 4 条握手事件。
   * 2. **打开工作台面板时 composer 会消失**，面板自己的浮层（`div.wb-overlay`）会吃掉点击
   *    （run 10 实测：`clicked.fallbackTarget = "div.wb-overlay"`）。整页重载会把面板/弹窗全清掉，
   *    重载后 composer 就回来了（`_p10_probe_control.mjs` 步骤 2）。
   * 3. **侧栏根本列不出"刚建出来、还没有任何消息"的会话**（run 11 实测：`dsh-workbench` 下第一条会话行
   *    写着「新会话」，点它 `dsh.sessions.current` 纹丝不动 —— 那一条就是当前会话自己的占位行；
   *    目标会话在侧栏里根本没有行）。所以"真点侧栏"只能作为**兜底**，不能当主路径。
   * 4. **唯一确定性可用的开关是「整页重载 + 等 SPA 自己认领」**：SPA 在启动时会把"当前会话"解析成那个
   *    新会话，但**有滞后**——run 10/run 11 各自建出的会话都是在几十分钟后的下一次浏览器启动才变成
   *    `dsh.sessions.current`（`_p10_probe_control.mjs` 冷启动 = `d48ca06b`；
   *    `_p10_probe_pin.mjs` 重载后 = `1925eb4d`，两次都是"最近一次运行建出来的那个"）。
   *    所以这里**反复重载 + 轮询**（`DSH_VERIFY_EXPERT_SWITCH_MS`，默认 300s）等它认领。
   *
   * 走完还是不是目标会话的话，**如实返回失败**：宁可记未验证，也不把消息发进别的会话。
   *
   * ⚠️ P11：**这一整段只在"产品自己没派发"时才跑**。产品自己派发时（`dispatchPath === 'plugin-queued'`）
   * 它会跳过 —— 产品在自己的第 10 步就 `openSessionInMainView()` 把生成会话开到了主视图，
   * 没有人需要再动浏览器，也没有人需要打开发输入框。
   */
  if (draftSessionId !== null && findings.dispatchPath !== 'plugin-queued') {
    const workspaceTitle = basename(ROOT_TRIMMED)
    const readPage = async () => {
      const value = await browser.evaluate(`
      let current = null;
      try { current = localStorage.getItem('dsh.sessions.current'); } catch (error) { current = null; }
      const composer = document.querySelector('[data-composer-input="true"]');
      const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
      return {
        current,
        composer: composer === null ? null : (composer.getAttribute('data-placeholder') || ''),
        rows: rows.map((el) => (el.textContent || '').trim().slice(0, 48)),
      };
    `).catch(() => null)
      return value !== null && value !== undefined && typeof value === 'object' ? value : null
    }
    /** 轮询到 `predicate(state)` 为真（或超时），返回最后一次读数。 */
    const pollPage = async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        await sleep(1500)
        last = await readPage()
        if (last !== null && predicate(last) === true) return last
      }
      return last
    }
    const isTarget = (state) => state !== null && state !== undefined && typeof state === 'object'
      && typeof state.current === 'string' && state.current.includes(draftSessionId)

    findings.steps.openSession = await (async () => {
      const attempt = { workspaceTitle, target: draftSessionId }
      attempt.initial = await readPage()

      /**
       * 主路径：**关掉当前浏览器实例、冷启动一个新的**，直到 SPA 把 `dsh.sessions.current` 解析成这个新会话。
       *
       * 为什么必须是"冷启动新进程"而不是"同一个实例里重新加载"：P10 实测（run 11/12 的整页重载始终停在
       * 上一个会话 `session-1925eb4d`；而 `_p10_probe_pointcurrent.mjs` 一次冷启动就把 `current` 解析成了
       * run 12 刚建出的 `session-eca454ba`，DOM 里也能搜到它的 id）——**只有全新进程的冷启动会认领最新会话**。
       */
      const switchBudget = Number(process.env.DSH_VERIFY_EXPERT_SWITCH_MS ?? '300000')
      attempt.switchBudgetMs = switchBudget
      const startedAt = Date.now()
      const relaunches = []
      try {
        while (Date.now() - startedAt < switchBudget) {
          await browser.close().catch(() => undefined)
          browser = await launchSuiteBrowser({ url: options.url, token: options.token, userDataRoot: options.userDataRoot, browserPath: BROWSER_PATH })
          await browser.goto(api.pageUrl())
          const state = await pollPage((candidate) => candidate !== null && typeof candidate === 'object'
            && candidate.composer !== null && candidate.current !== null, 30000)
          relaunches.push({ atMs: Date.now() - startedAt, current: state?.current ?? null, composer: state?.composer ?? null })
          attempt.lastRelaunch = state
          if (isTarget(state)) break
          await sleep(20000)
        }
      } catch (error) {
        attempt.switchError = error instanceof Error ? `${error.message} @ ${(error.stack ?? '').split('\n')[1]?.trim() ?? ''}` : String(error)
      }
      attempt.relaunches = relaunches
      attempt.afterRelaunchLoop = await readPage()

      /** 兜底：真点侧栏工作区下的第一条会话行（只是兜底，见上面事实 3）。 */
      if (isTarget(attempt.afterRelaunchLoop) === false) {
        const clicked = await browser.evaluate(`
          const title = ${JSON.stringify(workspaceTitle)};
          const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
          const index = rows.findIndex((el) => (el.textContent || '').trim() === title);
          if (index < 0) return { ok: false, reason: 'no-workspace-row' };
          const sessionRow = rows[index + 1];
          if (sessionRow === undefined) return { ok: false, reason: 'no-session-row-after-workspace' };
          const rect = sessionRow.getBoundingClientRect();
          return {
            ok: true,
            text: (sessionRow.textContent || '').trim().slice(0, 48),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            visible: rect.height > 0,
          };
        `).catch((error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
        attempt.sidebarRow = clicked
        if (clicked?.ok === true && clicked.visible === true) {
          attempt.sidebarClicked = await browser.clickAt(clicked.x, clicked.y).catch(() => null)
        }
        attempt.afterSidebarClick = await pollPage(isTarget, 20000)
      }

      const finalState = await readPage()
      attempt.final = finalState
      attempt.verified = isTarget(finalState) && finalState.composer !== null
      return attempt
    })()
    const opened = findings.steps.openSession
    findings.composerAfterSwitch = opened?.final?.composer ?? null
    if (opened?.verified !== true) {
      return {
        ok: false,
        reason: `无法把浏览器切到生成会话 ${draftSessionId}（${Math.round((opened?.switchBudgetMs ?? 0) / 1000)}s 内反复"关浏览器 + 冷启动新实例" + 真点侧栏，SPA 的 dsh.sessions.current 始终不是它；不换通道、不把消息发给别的会话），现场：${safeJson(opened).slice(0, 700)}`,
        findings,
      }
    }
    /**
     * 静置等待：给宿主一点时间把这个刚建的会话"认领"进运行时（P10 实测：静置后再发，
     * 20s 内就 `turn/start` + `request/header`；这一条不单独作为判据，只是省一次白等的钱）。
     */
    const settleMs = Number(process.env.DSH_VERIFY_EXPERT_SETTLE_MS ?? '20000')
    findings.settleMs = settleMs
    if (settleMs > 0) {
      findings.notes.push(`切换并验证到生成会话后静置 ${Math.round(settleMs / 1000)}s`)
      await sleep(settleMs)
      findings.steps.openSessionAfterSettle = await readPage()
    }
  }

  /**
   * ── 兜底通道（只有"产品自己没派发"才会走到这里；P10 的历史缺陷已由 P11 修复）──────────
   *
   * 历史（P10 实测，非推断，保留作对照）：前端 `useWorkbenchExperts.start()` 第 7 步把 `res.draft.id`
   * 当响应读（冻结产物 `lib/client/hooks/useWorkbenchExperts.js:549-551`），而服务端给的是顶层 `draftId`
   * ⇒ 判"服务端没有返回草稿"并 return，第 8 步 `session.rename()` 与第 9 步
   * `session.prompt([...], 'queue')`（`src/client/hooks/useWorkbenchExperts.ts:832-837`）**根本不会执行**。
   * 所以被追踪的生成会话永远只有 4 条握手事件、0 条 `user/message`。
   * **P11 已修**：第 7 步（以及 :908 / :989 两处）统一走 `normalizeExpertDraftResponse()`
   * （`src/client/hooks/useWorkbenchExperts.ts:400`）；正常路径上这条兜底不该再被用到
   * （`dispatchPath` 会是 `plugin-queued`）。
   *
   * 走到这里说明上面的轮询预算内**没看见**产品那条 `user/message`。处理：用**同一份插件 prompt 文本**
   * （`readPluginGenerationPrompt` 逐字抽取）通过真实 composer 补发一次，并且**必须发进被追踪的那个会话**
   * （上面已用真点侧栏 + SPA `dsh.sessions.current` 验证过）。
   * ⚠️ 这条**不算**"插件自己的 prompt 派发了"：`dispatchPath` 写成 `composer-fallback`，
   * 于是 `checkModelLayer()` 里那条「点「开始生成」后由产品自己把提示词发给模型」会**判红**
   * —— 这正是 P10"功能坏了还绿灯"漏洞的补丁所在。
   */
  /** 用**刚读的新鲜摘要**判"插件那条 prompt 到底有没有派发"，不用循环里那份可能已经过期的 `tracked`。 */
  const fresh = { ...tracked, ...sessionSummary(tracked.dir) }
  tracked = fresh
  const dispatchedByPlugin = (fresh.userMessages ?? []).length > 0 || findings.dispatchPath === 'plugin-queued'
  if (findings.dispatchPath !== 'plugin-queued') findings.dispatchPath = dispatchedByPlugin ? 'plugin-queued' : 'not-dispatched-within-budget'
  if (dispatchedByPlugin === false) {
    /**
     * 兜底前置：**同一个真实浏览器必须已经停在那个会话上**（`dsh.sessions.current` 是它 +
     * composer 就绪），否则消息会发到别的会话里去 —— 那等于换了通道，宁可不测也不假通过。
     */
    const composer = findings.composerAfterSwitch
    if (typeof composer !== 'string' || composer === '') {
      return {
        ok: false,
        reason: `插件自己那条 prompt 没有派发（P10 的缺陷形态；P11 的归一化修复没有生效或派发超预算，见上面注释），且同一个真实浏览器没有停在生成会话 ${String(tracked.sessionId)} 上（composer 未就绪：${safeJson(findings.steps.openSession?.final ?? null).slice(0, 300)}），不换通道、如实记未验证`,
        findings,
      }
    }
    const methodologyResponse = await sessionApi.get('/api/workbench/experts/methodology').catch(() => undefined)
    const methodology = methodologyResponse?.body?.text
    if (typeof methodology !== 'string' || methodology === '') {
      return { ok: false, reason: `宿主在 ${Math.round(waited / 1000)}s 内没有派发插件排队的 prompt，且取不到方法论文本（/api/workbench/experts/methodology 无 text），无法补发同一份 prompt`, findings }
    }
    const prompt = readPluginGenerationPrompt(request, methodology)
    if (prompt === null) {
      return { ok: false, reason: '宿主没有派发插件排队的 prompt，且抽不到 `buildExpertGenerationPrompt` 的字面量模板（源码形状变了？），不猜、如实记未验证', findings }
    }
    findings.evidence.pluginPromptChars = prompt.length
    findings.evidence.pluginPromptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex').toUpperCase()
    writeFileSync(join(suite.dir, 'model-plugin-prompt.txt'), prompt, 'utf8')
    findings.dispatchPath = 'composer-fallback'
    findings.call = await sendModelMessage(tracked.sessionId, prompt, 'E60 生成 prompt（composer 兜底，逐字同插件）')
    findings.modelCalls = modelCallLog.slice()
    if (findings.call === null || findings.call.ok !== true) {
      return { ok: false, reason: `补发 prompt 失败：${safeJson(findings.call).slice(0, 300)}`, findings }
    }
  }

  // ── 等模型真的调工具 ─────────────────────────────────────────────────────────
  const turnBudget = Number(process.env.DSH_VERIFY_EXPERT_TURN_MS ?? '600000')
  const wanted = ['workbench_get_expert_draft', 'workbench_submit_expert_draft', 'workbench_validate_expert_draft']
  let turnWaited = 0
  let summary = tracked
  while (turnWaited < turnBudget) {
    await sleep(15000)
    turnWaited += 15000
    summary = { ...tracked, ...sessionSummary(tracked.dir) }
    const names = (summary.toolCalls ?? []).map((call) => call.name)
    if (names.includes('workbench_submit_expert_draft') || names.includes('workbench_validate_expert_draft')) break
    if (turnWaited % 60000 === 0) findings.notes.push(`等模型调工具 ${turnWaited / 1000}s：已见 ${JSON.stringify(names.slice(0, 6))}`)
  }
  findings.turnWaitedMs = turnWaited
  findings.session = {
    key: tracked.key,
    dir: tracked.dir,
    sessionId: summary.sessionId,
    cwd: summary.cwd,
    parentSession: summary.parentSession ?? null,
    delegationDepth: summary.delegationDepth ?? null,
    titles: summary.titles,
    events: summary.events,
    frames: summary.frames,
    failedFrames: summary.failedFrames,
    userMessageCount: (summary.userMessages ?? []).length,
    userMessageHead: (summary.userMessages ?? []).slice(0, 3),
    model: summary.model,
    toolsOfferedCount: summary.toolsOffered === null ? null : summary.toolsOffered.length,
    toolsOffered: summary.toolsOffered === null ? null : summary.toolsOffered.slice(0, 64),
    expertGenerationToolsOffered: summary.toolsOffered === null ? null : summary.toolsOffered.filter((name) => EXPERT_GENERATION_TOOL_NAMES.includes(name)),
    toolCalls: summary.toolCalls,
    toolResults: summary.toolResults,
  }
  const callNames = (summary.toolCalls ?? []).map((call) => call.name)
  findings.calls = callNames

  // ── 目标库复读草稿行 ────────────────────────────────────────────────────────
  const row = await readExpertDraftRow(summary.sessionId)
  findings.draftRow = row
  if (row.found === true) {
    cleanupDraftId = row.id
    findings.expertInUserLibrary = expertInUserLibrary(row.expertId)
  }

  // ── 判据 ────────────────────────────────────────────────────────────────────
  const independentSession = summary.sessionId !== null
    && summary.parentSession === null
    && (summary.delegationDepth ?? 0) === 0
    && summary.sessionId !== (typeof options.sessionId === 'string' ? options.sessionId : '')
  const hasDraft = row.found === true && row.sessionId === summary.sessionId
  const getCalled = callNames.includes('workbench_get_expert_draft')
  const submitCalled = callNames.includes('workbench_submit_expert_draft')
  const validateCalled = callNames.includes('workbench_validate_expert_draft')
  const versionAdvanced = hasDraft && Number(row.contentVersion) >= 1
  const phaseConsistent = hasDraft
    && (validateCalled
      ? (row.validation !== null && typeof row.validation?.manifestHash === 'string')
      : (row.validation === null || row.validation?.manifestHash === undefined))
  const libraryClean = findings.expertInUserLibrary?.checked === true && findings.expertInUserLibrary.present === false
  const allFiveOffered = Array.isArray(findings.session?.toolsOffered)
    && EXPERT_GENERATION_TOOL_NAMES.every((name) => findings.session.toolsOffered.includes(name))

  findings.verdict = { independentSession, hasDraft, getCalled, submitCalled, validateCalled, versionAdvanced, phaseConsistent, libraryClean, allFiveOffered }
  writeFileSync(join(suite.dir, 'model-e60-session.json'), `${JSON.stringify(findings.session, null, 2)}\n`, 'utf8')
  /** P11：把"被追踪会话里第一条 `user/message` 的全文读数"单独落盘（报告要用它证明是产品发的）。 */
  if (findings.pluginFirstUserMessage !== null && findings.pluginFirstUserMessage !== undefined) {
    writeFileSync(join(suite.dir, 'model-e60-first-user-message.json'), `${JSON.stringify(findings.pluginFirstUserMessage, null, 2)}\n`, 'utf8')
  }
  writeFileSync(join(suite.dir, 'model-e60-dispatch.json'), `${JSON.stringify(findings.pluginDispatch ?? null, null, 2)}\n`, 'utf8')
  writeFileSync(join(suite.dir, 'model-e60-draft-row.json'), `${JSON.stringify({ draftRow: row, userLibrary: findings.expertInUserLibrary }, null, 2)}\n`, 'utf8')

  if (independentSession === false) {
    return { ok: false, reason: `生成会话不是独立会话（sessionId=${summary.sessionId} parent=${String(summary.parentSession)} depth=${String(summary.delegationDepth)}）`, findings }
  }
  if (getCalled === false || submitCalled === false) {
    return {
      ok: false,
      reason: `独立会话确实建出来了（${summary.sessionId}），但 ${Math.round(turnWaited / 1000)}s 内模型没有调 ${getCalled ? '' : 'workbench_get_expert_draft '}${submitCalled ? '' : 'workbench_submit_expert_draft'}`.trim()
        + `（实际工具调用：${JSON.stringify(callNames.slice(0, 8))}；prompt 通道=${findings.dispatchPath}）`,
      findings,
    }
  }
  if (hasDraft === false || versionAdvanced === false) {
    return { ok: false, reason: `模型调了生成工具，但目标库里该会话名下的草稿没有推进（found=${String(row.found)} contentVersion=${String(row.contentVersion)}）`, findings }
  }
  if (phaseConsistent === false) {
    return { ok: false, reason: `草稿 phase/validation 与模型实际动作不一致（validateCalled=${String(validateCalled)} validation=${safeJson(row.validation).slice(0, 200)}）`, findings }
  }
  if (libraryClean === false) {
    return { ok: false, reason: `确认之前正式角色库里就已经有这个专家（expertId=${String(row.expertId)} hits=${safeJson(findings.expertInUserLibrary?.hits).slice(0, 200)}）`, findings }
  }
  return { ok: true, reason: null, findings }
}

/**
 * AX-E61 / AX-E62 的**通道前置**：本机 3080 实例上必须能真的把 `@` 专家引用插进 composer。
 *
 * 判据（都可失败）：
 * - `POST /api/workbench/experts/catalog` 里至少有 1 位可引用专家（否则 E61 无从下手）；
 * - `@` 提及菜单里出现 `expert:` 前缀的候选（说明 `createExpertInputSource` 真的注册进了宿主）
 *   —— P10 侦察已实测可见（`仪表回路与测量链专家expert:domain/engineering/rf-…`）。
 *
 * 拿到"可引用"之后，真正发一轮、让模型调 `workbench_run_expert_request` 仍需真实模型与
 * 父会话绑定；那一步若在本环境不可确定性完成，按规格记 skip + 具体原因（不假通过）。
 */
async function probeExpertMentionChannel() {
  const out = { notes: [] }
  const catalog = await sessionApi.get('/api/workbench/experts/catalog?query=').catch(() => undefined)
  out.catalogStatus = catalog?.status ?? null
  out.catalogKeys = catalog?.body === null || typeof catalog?.body !== 'object' ? null : Object.keys(catalog.body).slice(0, 8)
  /**
   * 形状照 `GET /experts/catalog` 的**实测**响应取（`{ok,experts,personas,diagnostics,…}`），
   * 不是猜 `entries`：P10 第一次单跑就因为只认 `entries` 而把"15 位可引用专家"读成 0。
   */
  const body = catalog?.body ?? {}
  const entries = Array.isArray(body.entries) ? body.entries
    : Array.isArray(body.experts) ? body.experts
      : Array.isArray(body.personas) ? body.personas
        : Array.isArray(body.items) ? body.items : []
  out.catalogCount = entries.length
  out.catalogSample = entries.slice(0, 3).map((entry) => ({ id: entry.id ?? entry.personaId, name: entry.name ?? entry.title }))
  if (browser === undefined) { out.mention = { ok: false, reason: '浏览器层没起来' }; return out }
  /**
   * ⚠️ 这一步**必须先把页面带回一个真实会话**：P10 实测里它常常紧接着模型层失败（页面停在
   * 专家管理 / 新建弹窗上）⇒ `no-composer`，把"通道在位"误报成红。所以：关弹窗 → 点侧栏第一条会话
   * → 等 composer 出现；仍没有才 `ok:false`，并把 DOM 现场一并记下来（不猜）。
   */
  out.mention = await (async () => {
    const readComposer = () => browser.evaluate(`
      const el = document.querySelector('[data-composer-input="true"]');
      if (el === null) {
        return {
          ok: false,
          reason: 'no-composer',
          dialogs: document.querySelectorAll('.wb-dialog').length,
          sessionItems: document.querySelectorAll('[role="treeitem"]').length,
          mainText: (document.querySelector('main')?.textContent ?? '').trim().slice(0, 80),
        };
      }
      return { ok: true, placeholder: el.getAttribute('data-placeholder') || '' };
    `).catch((error) => ({ ok: false, reason: `evaluate 失败：${error instanceof Error ? error.message : String(error)}` }))
    const first = await readComposer()
    if (first.ok === true) return first
    out.mentionFirstTry = first
    await browser.evaluate(`
      const dialog = document.querySelector('.wb-dialog');
      if (dialog !== null) {
        const buttons = Array.from(dialog.querySelectorAll('button'));
        const cancel = buttons.find((b) => /取消|关闭|暂存|继续让 AI 修改/.test((b.textContent || '').trim()));
        if (cancel !== undefined) cancel.click();
      }
      return true;
    `).catch(() => undefined)
    await sleep(1000)
    await browser.evaluate(`
      const items = Array.from(document.querySelectorAll('[role="treeitem"]'));
      const target = items.find((el) => (el.textContent || '').trim() !== '');
      if (target !== undefined) target.click();
      return items.length;
    `).catch(() => undefined)
    await sleep(5000)
    const second = await readComposer()
    return second.ok === true ? { ...second, recoveredBy: 'clicked-sidebar-session' } : { ...second, firstTry: first }
  })()
  return out
}

// ── AX-E60-b / E61 / E62 的通道前置 ─────────────────────────────────────────
async function checkModelLayer() {
  report.layers.model = { notes: [], calls: [] }
  const generation = await runExpertGenerationProbe()
  report.layers.model.generation = generation
  report.layers.model.calls = modelCallLog.slice()

  const findings = generation.findings ?? {}
  const verdict = findings.verdict ?? {}
  const offered = findings.session?.expertGenerationToolsOffered ?? null
  /** 会话记录里真的能被模型看到这 5 个工具（`request/header` 的实测清单，不是源码推断）。 */
  const allFiveOfferedObserved = verdict.allFiveOffered === true
  const offeredCount = Array.isArray(findings.session?.toolsOffered) ? findings.session.toolsOffered.length : null

  suite.check({
    id: 'AX-E60 ⭐ 真实模型调用专家草稿提交工具并落库（模型链路：独立会话 + JSONL 工具调用 + 目标库复读）', axId: 'AX-E60', layer: 'B',
    ok: generation.ok === true,
    skipped: generation.ok !== true,
    skipReason: generation.ok === true ? undefined
      : `未观察到真实模型工具调用：${generation.reason}。原始证据：${(findings.notes ?? []).slice(-3).join('；')}（草稿生命周期与"确认前正式库为空"已在 H 层用真实 HTTP + 真实 FS/DB 证明；本层按规格记未验证，不记 pass。"提示词是不是产品自己发的"另由下面那条 AX-E60 判据单独判）`,
    detail: safeJson({
      request: findings.request,
      requestChars: findings.requestChars,
      dispatchPath: findings.dispatchPath,
      dispatchWaitedMs: findings.runified?.waitedMs,
      turnWaitedMs: findings.turnWaitedMs,
      session: findings.session === undefined ? null : {
        sessionId: findings.session.sessionId,
        key: findings.session.key,
        cwd: findings.session.cwd,
        parentSession: findings.session.parentSession,
        delegationDepth: findings.session.delegationDepth,
        events: findings.session.events,
        frames: findings.session.frames,
        failedFrames: findings.session.failedFrames,
        userMessageCount: findings.session.userMessageCount,
        toolsOfferedCount: findings.session.toolsOfferedCount,
        expertGenerationToolsOffered: findings.session.expertGenerationToolsOffered,
        model: findings.session.model,
      },
      calls: findings.calls,
      draftRow: findings.draftRow,
      userLibrary: findings.expertInUserLibrary,
      verdict,
      allFiveOffered: allFiveOfferedObserved,
      modelCalls: modelCallLog,
    }).slice(0, 4000),
  })

  /**
   * ⭐ P11 新增：把「提示词是**产品**发出去的」从 E60 里**拆出来单独判**。
   *
   * 为什么必须单独一条：E60 的 `ok` 只看"真实模型真的调了工具 + 目标库草稿行真的推进"，
   * 而套件里存在一条**手工补发**的兜底通道（`readPluginGenerationPrompt` 逐字复刻 +
   * 真实 composer 发送）。P10 的 4280 字符 prompt 就是这么发出去的 —— 于是
   * "用户点「开始生成」什么都不会发生"这个**真实功能缺陷**依然让 E60 亮绿灯。
   *
   * 这条断言堵的就是它（不许登记进 `ALLOWED_REQUIRED_SKIPS`）：
   * - `dispatchPath === 'plugin-queued'`（被追踪会话的 JSONL 里出现了**产品自己**那条 `user/message`）→ **pass**；
   * - `dispatchPath === 'composer-fallback'`（套件靠人手补发才看到模型）→ **fail**，detail 里写明手工补发；
   * - 探针根本没走到"判派发通道"这一步（`dispatchPath` 缺失）→ 如实 `skip` + 具体原因。
   */
  const dispatchPath = findings.dispatchPath
  const dispatchJudged = typeof dispatchPath === 'string' && dispatchPath !== ''
  const pluginDispatched = dispatchPath === 'plugin-queued'
  suite.check({
    id: 'AX-E60 ⭐ 点「开始生成」后由产品自己把提示词发给模型（不靠人手补发）', axId: 'AX-E60', layer: 'B',
    ok: pluginDispatched,
    skipped: dispatchJudged === false,
    skipReason: dispatchJudged === false
      ? `探针没有走到"判派发通道"这一步（dispatchPath 缺失）：${generation.reason}`
      : undefined,
    detail: safeJson({
      dispatchPath: dispatchJudged ? dispatchPath : null,
      expected: 'plugin-queued',
      manualResendBySuite: dispatchPath === 'composer-fallback',
      verdictNote: pluginDispatched
        ? '通过：被追踪会话的 JSONL 里出现了**产品自己**那条 user/message（不是套件手工补发的）'
        : dispatchPath === 'composer-fallback'
          ? '不通过：套件靠**手工补发**（把逐字复刻的插件 prompt 打进真实 composer）才看到模型 —— 产品自己的派发通道没有被证明可用，用户点「开始生成」走不到这条路'
          : '不通过：预算内没在被追踪会话的 JSONL 里看到产品自己那条 user/message',
      dispatchWaitMs: findings.pluginDispatch?.waitedMs ?? null,
      dispatchBudgetMs: findings.pluginDispatch?.budgetMs ?? null,
      dispatchSamples: findings.pluginDispatch?.samples ?? null,
      /** 探测到那一刻套件发过几次真实 prompt：**0** 才能证明"不是人打的"。 */
      suiteModelCallsAtDetection: findings.pluginDispatch?.suiteModelCallsAtDetection ?? null,
      firstUserMessage: findings.pluginFirstUserMessage ?? null,
      firstUserMessageSource: '被追踪生成会话自己的 session.v*.jsonl.zstd（多帧 zstd 逐帧解压）',
      uiError: findings.uiError ?? null,
      userMessageCount: findings.session?.userMessageCount ?? null,
      modelCalls: modelCallLog,
    }).slice(0, 2500),
  })

  /**
   * ⚠️ 这条**另记一条**（不是 E60 的重复）：E60 判的是"工具真的被调用 + 草稿落库"，
   * 它可能因为"宿主没派发 prompt"而 skip；而"模型到底有没有被交付这 5 个生成工具 schema"
   * 是**同一份会话记录里另一个字段**（`request/header.data.header.tools[]`），
   * 只要会话真的开跑过一轮就能判，并且它正是"插件注册的 5 个生成工具在真实会话里可见"这条规格。
   */
  suite.check({
    id: 'AX-E60-b ⭐ 真实会话的 request/header 里逐个交付了 5 个专家生成工具（模型真的被给了这些 schema）', axId: 'AX-E60', layer: 'B',
    ok: allFiveOfferedObserved === true,
    skipped: allFiveOfferedObserved !== true && offeredCount === null,
    skipReason: allFiveOfferedObserved === true ? undefined
      : `生成会话没有开出可判的一轮（${generation.reason}）`,
    detail: safeJson({
      sessionId: findings.session?.sessionId ?? null,
      userMessages: findings.session?.userMessageCount ?? 0,
      toolsOfferedCount: offeredCount,
      expected: EXPERT_GENERATION_TOOL_NAMES,
      offered,
    }).slice(0, 1500),
  })

  // ── AX-E61：@ 专家 B 的通道前置（真实 HTTP + 真实 composer）────────────────────
  const mention = await probeExpertMentionChannel()
  report.layers.model.mention = mention
  const catalogReady = (mention.catalogCount ?? 0) > 0
  suite.check({
    id: 'AX-E61-a ⭐ 真实 HTTP + 真实 composer：`@` 专家引用通道在位（catalog 有可引用专家、页面有 composer）', axId: 'AX-E61', layer: 'B',
    ok: catalogReady === true && mention.mention?.ok === true,
    detail: safeJson({ catalogStatus: mention.catalogStatus, catalogCount: mention.catalogCount, catalogSample: mention.catalogSample, composer: mention.mention }).slice(0, 1200),
  })
  /**
   * E61 的**模型后半**（父绑定 A → `@` B 发送 → 子代理走 loader → 父仍为 A）需要：
   * 一次真实的父会话轮次（模型调 `workbench_run_expert_request`）+ 一个**可引用**的专家
   *（`@` 源只列 catalog 里带 `sourceKey` 的角色）+ 一次子代理轮次（模型先调
   * `workbench_load_invoked_expert`），然后还要证明**父会话绑定仍是 A**。
   *
   * ⚠️ P10 更正（P9 的交接口径里有一条**不成立**的阻塞）：「本机用户角色库里一位已发布专家都没有
   * ⇒ `@` 没有可引用对象」是**错的**。实测 `@` 源的可引用集合来自
   * `expertCandidatesFromCatalog(catalog.personas)`（`src/client/expertInputSource.ts:174-194`，
   * 只要 `id` + `sourceKey` 非空即可），而本机 catalog 里有 **15 位包内置角色**，
   * 且 `POST /experts/preflight` 对 `domain/engineering/dotnet-代码审查官` 实测返回
   * `usable: true / preliminary: true` —— 也就是说**不装任何专家也能引用内置角色**，
   * 「必须确认安装一位专家」并不是这条的前置。
   *
   * 真正的阻塞是**预算**：这一条要烧掉 ≥3 次真实模型调用（父轮 + 子代理轮 + 判"父仍为 A"的那一轮），
   * 而本批的调用预算（`MODEL_CALL_BUDGET = 6`）已经全部用在 AX-E60 的生成通道上（见 `modelCalls`）。
   * 如实记 skip，不假通过；**不要**为了变绿去登记 `ALLOWED_REQUIRED_SKIPS`。
   */
  const e61Blockers = []
  if (catalogReady === false) e61Blockers.push(`catalog 没有可引用专家（HTTP ${String(mention.catalogStatus)}，entries=${String(mention.catalogCount)}）`)
  if (mention.mention?.ok !== true) e61Blockers.push(`页面没有 composer（${safeJson(mention.mention)}）`)
  e61Blockers.push(`真实模型调用预算已用尽：本层共发出 ${modelCallsMade} 次 / 上限 ${MODEL_CALL_BUDGET}（明细见 modelCalls），而这一条至少还要 3 次（父轮 + 子代理轮 + 复核父绑定轮）`)
  suite.check({
    id: 'AX-E61 ⭐ 真实模型：父绑定 A 时 @ 专家 B，子代理走专用 loader 且父仍为 A（模型链路）', axId: 'AX-E61', layer: 'B',
    ok: false,
    skipped: true,
    skipReason: `端到端模型后半的阻塞：${e61Blockers.join('；')}。可复现的通道前置已单记 AX-E61-a（真实 HTTP catalog 15 位可引用内置角色 + 真实 composer）；父绑定不变的静态面（src/experts/invocation.ts 任何路径都不写绑定）与 manual-requests 只建请求不写绑定已在 H 层单独记 pass`,
    detail: safeJson({ catalogStatus: mention.catalogStatus, catalogCount: mention.catalogCount, catalogSample: mention.catalogSample, composer: mention.mention, modelCalls: modelCallLog }).slice(0, 1500),
  })

  // ── AX-E62：auto 开关的真实读写 + 关闭后工具清单的消失面 ──────────────────────
  /**
   * 这一条的模型后半需要**两轮真实会话**（开 → 自主召唤；关 → 下一轮不再有 `summon_expert`）。
   * P10 实测的注册面：`summon_expert` 只在
   * `ctx.tools.register(summonExpertTool(...))` 生效后出现（`src/index.ts:581-612`），
   * 且它要求宿主有可用的 subagent provider；**开着开关真的发一轮会再烧掉 ≥2 次真实模型调用
   * 与一个子代理**，而本批的调用预算（`MODEL_CALL_BUDGET = 6`）已全部用在 AX-E60 的生成通道上
   *（见 `modelCalls`）。开关真值可读性单记 AX-E62-a（真实 HTTP
   * `GET /api/workbench/experts/capabilities` → `autoSummon.{available,enabled}`），
   * 「关闭后该轮无自主 schema/prompt」的静态面（开关关闭时 `tools.register` 与 systemPrompt 段都撤销）
   * 如实记未验证，不假通过。
   */
  const autoSwitch = await sessionApi.get('/api/workbench/experts/capabilities').catch(() => undefined)
  const autoSummonEnabled = autoSwitch?.body?.autoSummon?.enabled
  const autoSummonAvailable = autoSwitch?.body?.autoSummon?.available
  report.layers.model.autoSummon = autoSwitch?.body?.autoSummon ?? null
  suite.check({
    id: 'AX-E62-a ⭐ 真实 HTTP：auto 开关真值可读、`summon_expert` 的注册面与开关同一真源', axId: 'AX-E62', layer: 'B',
    ok: autoSwitch?.status === 200 && typeof autoSummonEnabled === 'boolean' && typeof autoSummonAvailable === 'boolean',
    detail: safeJson({
      endpoint: 'GET /api/workbench/experts/capabilities',
      capabilitiesStatus: autoSwitch?.status,
      autoSummon: autoSwitch?.body?.autoSummon,
      metaKey: 'expert_auto_summon（真值唯一来源：src/experts/service.ts:1077 autoSummonEnabled）',
      registration: 'src/index.ts:581-612 —— 只有 enabled===true 且 selectSpawnProvider 成功才 register(summon_expert) + systemPrompt 段',
    }).slice(0, 1200),
  })
  suite.check({
    id: 'AX-E62 ⭐ 真实模型：auto=true 自主召唤、关闭后该轮无自主 schema/prompt（模型链路）', axId: 'AX-E62', layer: 'B',
    ok: false,
    skipped: true,
    skipReason: `需要**两轮真实模型会话**（开→自主召唤；关→下一轮 request/header 的 tools[] 里不再有 summon_expert）才能观察到：本批真实模型调用预算已用在 AX-E60 的生成通道（本层共发出 ${modelCallsMade} 次；上限 ${MODEL_CALL_BUDGET}），且自主召唤还会再起一个子代理。开关真值可读性已单记 AX-E62-a（真机 autoSummon.enabled=${String(autoSummonEnabled)}）；"关闭后该轮无自主 schema"的静态面（src/index.ts:581-612 的 effect 在开关关闭时 tools.register 与 systemPrompt 段都撤销）如实记未验证`,
    detail: safeJson({ autoSummon: autoSwitch?.body?.autoSummon, modelCalls: modelCallLog }).slice(0, 1500),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

try {
  await checkTarball()
  await checkHttpLayer()
  await checkBrowserLayer()
  await checkModelLayer()

  /** 自检：层名必须都是 `CHECK_LAYERS` 认得的口径（写错层名 = 证据口径漂移）。 */
  const usedLayers = [...new Set(suite.checks.map((entry) => entry.layer).filter((layer) => layer !== undefined))]
  report.usedLayers = usedLayers
  suite.check({
    id: '自检：本套件用到的层名都在 CHECK_LAYERS 口径内（U/H/W/B/N）', layer: 'N',
    ok: usedLayers.length > 0 && usedLayers.every((layer) => layerOk(layer)),
    detail: `used=${usedLayers.join(',')}`,
  })
} catch (error) {
  suite.fatalError(error)
} finally {
  /**
   * 安全网：正常路径已经在 H 层放弃过草稿；这里兜的是"中途 fatal / 提前退出"——
   * 一份遗留的 pending 专家草稿会让「待确认草稿」横幅在**同一条链上后面的套件**里
   * 自动弹出并盖住界面（真机实测过：progress 套件的 25% 点击落到横幅上）。
   * 兜底失败不覆盖原判定，只记一条 note（本来就该失败的地方不能因此变绿）。
   */
  if (cleanupDraftId !== undefined) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const database = new DatabaseSync(options.dbPath, { readOnly: true })
      let stillPending = false
      try {
        stillPending = database.prepare('SELECT status_code FROM task_drafts WHERE id = ?').get(cleanupDraftId)?.status_code === 'pending'
      } finally { database.close() }
      if (stillPending) {
        const view = await sessionApi.get(`/api/workbench/experts/drafts/${encodeURIComponent(cleanupDraftId)}`)
        const sweeper = await sessionApi.post(`/api/workbench/drafts/${encodeURIComponent(cleanupDraftId)}/abandon`, { expectedVersion: view.body?.draft?.contentVersion ?? 0 })
        suite.note(`收尾兜底放弃遗留草稿 ${cleanupDraftId}：HTTP ${sweeper.status}（不覆盖原判定）`)
      }
    } catch (error) {
      suite.note(`收尾兜底放弃草稿失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    if (browser !== undefined) {
      await browser.screenshot(`${suite.dir}/99-收尾.png`).catch(() => undefined)
      await browser.close()
    }
    suite.writeEvidence('expert-readings.json', report)
  } catch (error) {
    suite.note(`收尾失败（不覆盖原判定）：${error instanceof Error ? error.message : String(error)}`)
  }
  const counts = suite.counts()
  if (counts.total <= 0) suite.fatalError(new Error('套件一条断言都没记下（total<=0）——空测试不算通过'))
  process.exit(suite.finish({ runId }))
}
