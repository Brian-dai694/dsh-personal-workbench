/**
 * 专家域**文件边界**（`src/experts/paths.ts`）。
 *
 * 覆盖验收断言：**AX-E05**（路径负例全拒 + 两个根之外零写入）、
 * **AX-E06**（根/父目录/目标文件是 link 或 junction 一律拒绝；外部哨兵文件逐字不变）。
 *
 * ## 夹具布局
 *
 * ```
 * tmp/
 *   home/                      ← 注入给 resolveExpertRoots 的 home
 *     .dsh/workbench/personas  ← 用户库根（链接场景里它本身是 junction）
 *     .dsh/workbench/skills
 *   real-personas/             ← 链接目标（"看起来像根"的目录，但不该被写）
 *   outside/                   ← 根之外的哨兵目录
 *     sentinel.txt             ← 逐字比对用的哨兵文件
 * ```
 *
 * 断言必须**读磁盘真实状态**：`stat` 目标文件、比对一个字节都不许变的哨兵文件，
 * 不能只断言"调用返回了 false"（验收清单 §3 明令）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveExpertRoots, rootForArea, validateExpertRelativePath, checkExpertRelativePathShape,
  expertPathCompareKey, validateStagedFileContent, isInsideExpertRoot, assertNoLinksInsideRoot,
  assertNoLinksInPaths, atomicWriteText, withExpertInstallLock, acquireExpertInstallLock,
  defaultIsProcessAlive, readExpertTextFile, pathProblemToIssue, hasAllowedTextExtension,
} from '../lib/experts/paths.js'
import {
  EXPERT_RESOURCE_MAX_DEPTH, EXPERT_STAGED_FILE_MAX_BYTES, EXPERT_STAGED_FILE_MAX_CHARS,
  EXPERT_INSTALL_LOCK_FILE_NAME,
} from '../lib/shared/expert.js'

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

const SENTINEL_TEXT = '外部文件，一个字节都不许变。\nsentinel: 0xE4B8AD\n'

/** 用完了就整体删掉；失败只清理**已核验**的临时目录（前缀 + 落在 tmpdir 下）。 */
function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wb-expert-paths-'))
  const home = join(root, 'home')
  const personasDir = join(home, '.dsh', 'workbench', 'personas')
  const skillsDir = join(home, '.dsh', 'workbench', 'skills')
  const realPersonas = join(root, 'real-personas')
  const outside = join(root, 'outside')
  mkdirSync(personasDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(realPersonas, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const sentinel = join(outside, 'sentinel.txt')
  writeFileSync(sentinel, SENTINEL_TEXT, 'utf8')
  /** 清理前的复核：必须是 mkdtempSync 建的那个目录、且确实在系统临时目录下。 */
  const safeToRemove = root.startsWith(tmpdir()) && root.includes('dsh-wb-expert-paths-')
  try {
    return run({ root, home, personasDir, skillsDir, realPersonas, outside, sentinel })
  } finally {
    if (safeToRemove) removeTempDir(root)
  }
}

/** 读回哨兵，断言逐字不变（AX-E05 / AX-E06 的收尾动作）。 */
function assertSentinelIntact(sentinel) {
  assert.equal(readFileSync(sentinel, 'utf8'), SENTINEL_TEXT, '根之外的哨兵文件被改动了')
}

/** 列出目录内容（不存在时返回 []），用于断言"根外没有被写入"。 */
function listOrEmpty(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 根解析
// ---------------------------------------------------------------------------

test('resolveExpertRoots 沿用既有目录约定，且根只来自参数（生产没有任意根覆盖入口）', () => {
  withFixture(({ home, personasDir, skillsDir }) => {
    const roots = resolveExpertRoots({ home })
    assert.equal(roots.personasDir, personasDir, '用户库根必须是 <home>/.dsh/workbench/personas')
    assert.equal(roots.skillsDir, skillsDir, '技能根必须是 <home>/.dsh/workbench/skills')
    assert.equal(roots.installLockPath, join(personasDir, EXPERT_INSTALL_LOCK_FILE_NAME))
    assert.equal(rootForArea(roots, 'persona'), roots.personasDir)
    assert.equal(rootForArea(roots, 'skill'), roots.skillsDir)
    /** 显式覆盖（测试注入点）。 */
    const overridden = resolveExpertRoots({ home, personasDir: join(home, 'p2'), skillsDir: join(home, 's2') })
    assert.equal(overridden.personasDir, join(home, 'p2'))
    assert.equal(overridden.skillsDir, join(home, 's2'))
  })
})

// ---------------------------------------------------------------------------
// AX-E05：纯形状负例
// ---------------------------------------------------------------------------

test('AX-E05 纯形状：../ 、UNC、C:/ 、反斜杠、百分号编码、NUL、保留名、尾部点空格全部拒绝', () => {
  const area = 'persona-resource'
  const rejected = [
    // `..` / `.` / 空段
    ['../secret.md', '上层目录'],
    ['a/../../secret.md', '夹在中间的上层目录'],
    ['..', '纯上层目录'],
    ['./a.md', '当前目录段'],
    ['a//b.md', '空段'],
    ['a/./b.md', '夹在中间的当前目录段'],
    // 空 / 空白
    ['', '空字符串'],
    ['   ', '全空白'],
    [' a.md', '首部空格'],
    ['a.md ', '尾部空格'],
    // 分隔符与绝对路径
    ['/etc/passwd.md', 'POSIX 绝对路径'],
    ['C:/Windows/system.md', '盘符'],
    ['c:a.md', '相对盘符'],
    ['\\\\server\\share\\a.md', 'UNC'],
    ['\\\\?\\C:\\a.md', '扩展长度 UNC'],
    ['a\\b.md', '反斜杠分隔'],
    ['\\\\server\\share', '纯 UNC'],
    // 百分号编码（任何百分号都拒，不做"解码后再判"）
    ['%2e%2e%2fsecret.md', '编码后的 ../'],
    ['a%2Fb.md', '编码后的斜杠'],
    ['%252e%252e/secret.md', '二次编码'],
    ['100%.md', '普通百分号'],
    // NUL 与控制字符
    ['a\u0000.md', 'NUL'],
    ['a\rb.md', '回车'],
    ['a\nb.md', '换行'],
    // Windows 保留名 + 尾部点/空格
    ['con.md', 'CON'],
    ['AUX.txt', 'AUX（大小写不敏感）'],
    ['lpt1.json', 'LPT1'],
    ['nul.csv', 'NUL'],
    ['a.md.', '尾部点'],
    ['a.md ', '尾部空格'],
    // 保留文件名（安装器自己写，模型不得写）
    ['provenance.json', 'provenance.json'],
    ['publication.json', 'publication.json'],
    ['install-journal.json', 'install-journal.json'],
    ['workbench-install.json', 'workbench-install.json'],
    // 扩展名与层级
    ['a.exe', '非白名单扩展名'],
    ['a', '没有扩展名'],
    ['a/b/c/d/e.md', `超过 ${EXPERT_RESOURCE_MAX_DEPTH} 层`],
  ]
  for (const [path, why] of rejected) {
    const problem = validateExpertRelativePath(area, path)
    assert.ok(problem !== undefined, `必须拒绝（${why}）：${JSON.stringify(path)}`)
    assert.equal(problem.code, 'invalid-path', `拒绝理由应是 invalid-path（${why}）：${JSON.stringify(path)}`)
    assert.ok(typeof problem.message === 'string' && problem.message.length > 0)
  }
  /** 合法样例确认"没把好人一起拒了"。 */
  for (const ok of ['a.md', 'a/b.md', 'references/guide.md', 'sources/src-1/LICENSE.txt', 'a/b/c/d.md']) {
    assert.equal(checkExpertRelativePathShape(area, ok), undefined, `合法路径不该被拒：${ok}`)
  }
})

test('AX-E05 skill 路径必须是 <skillName>/<相对路径>，skillName 是封闭形状', () => {
  assert.equal(checkExpertRelativePathShape('skill', 'my-skill/SKILL.md'), undefined)
  assert.equal(checkExpertRelativePathShape('skill', 'my-skill/references/a.md'), undefined)
  /** 只有文件名（没有 skill 名前缀）→ 拒。 */
  assert.equal(checkExpertRelativePathShape('skill', 'SKILL.md')?.code, 'invalid-path')
  /** skill 名不合法 → 拒，且理由可读。 */
  for (const bad of ['My-Skill/SKILL.md', '-bad/SKILL.md', 'bad-/SKILL.md', 'a--b/SKILL.md', 'with_underscore/a.md', `${'a'.repeat(65)}/a.md`]) {
    const problem = checkExpertRelativePathShape('skill', bad)
    assert.equal(problem?.code, 'invalid-path', `skill 名不合法应拒：${bad}`)
  }
  /** 保留名在 skill 里同样有效。 */
  assert.equal(checkExpertRelativePathShape('skill', 'my-skill/workbench-install.json')?.code, 'invalid-path')
})

test('AX-E05 NFC / 大小写同路径碰撞与既有集合比对时被拒（Windows/macOS 折叠后是同一条）', () => {
  /** 大小写：win32/darwin 上 a.md 与 A.md 是同一个文件。 */
  const caseCollision = validateExpertRelativePath('persona-resource', 'A.md', { platform: 'win32', existing: ['a.md'] })
  assert.equal(caseCollision?.code, 'invalid-path')
  assert.match(caseCollision.message, /同一条/)
  /** 子目录里的同名文件同样折叠。 */
  assert.equal(
    validateExpertRelativePath('persona-resource', 'Sub/A.md', { platform: 'win32', existing: ['sub/a.md'] })?.code,
    'invalid-path',
  )
  /** Linux 上大小写敏感，允许共存。 */
  assert.equal(validateExpertRelativePath('persona-resource', 'A.md', { platform: 'linux', existing: ['a.md'] }), undefined)

  /** NFC：非 NFC 形式在**形状**阶段就被拒（不等折叠）。 */
  const nfd = 'cafe\u0301.md'
  const nfc = 'caf\u00e9.md'
  assert.notEqual(nfd, nfc)
  assert.equal(checkExpertRelativePathShape('persona-resource', nfd)?.code, 'invalid-path', '非 NFC 形式直接拒')
  assert.equal(checkExpertRelativePathShape('persona-resource', nfc), undefined, 'NFC 形式合法')
  assert.equal(
    validateExpertRelativePath('persona-resource', nfc, { platform: 'win32', existing: ['caf\u00e9.md'], self: nfc }),
    undefined,
    '与自身同形不算碰撞（调用方用 self 声明"这条就是我自己"）',
  )
  /** 不声明 self 时，即使写法完全相同也按碰撞拒（默认 fail-closed，避免静默覆盖）。 */
  assert.equal(
    validateExpertRelativePath('persona-resource', nfc, { platform: 'win32', existing: ['caf\u00e9.md'] })?.code,
    'invalid-path',
    '未声明 self → 同形也拒',
  )
  assert.equal(
    validateExpertRelativePath('persona-resource', nfc, { platform: 'win32', existing: ['CAF\u00c9.md'] })?.code,
    'invalid-path',
    'NFC + 大小写折叠后相同 → 同一条路径',
  )

  /** 尾部点/空格折叠：a.md. 与 a.md 在 Windows 上是同一个文件。 */
  assert.equal(
    validateExpertRelativePath('persona-resource', 'a.md.', { platform: 'win32', existing: ['a.md'] })?.code,
    'invalid-path',
  )
  assert.equal(expertPathCompareKey('persona-resource', 'a.md. ', 'win32'), expertPathCompareKey('persona-resource', 'a.md', 'win32'))

  /** area 是键的一部分：同名文件在 persona 与 skill 里互不碰撞。 */
  assert.notEqual(
    expertPathCompareKey('persona-resource', 'a.md', 'win32'),
    expertPathCompareKey('skill', 'a.md', 'win32'),
  )
  /** self 参数：更新场景下不能与自己碰撞。 */
  assert.equal(validateExpertRelativePath('persona-resource', 'a.md', { existing: ['a.md'], self: 'a.md' }), undefined)
})

test('AX-E05 暂存文件尺寸：默认只判字节，字符上限必须显式传 maxChars 才判', () => {
  assert.equal(validateStagedFileContent('a.md', EXPERT_STAGED_FILE_MAX_BYTES), undefined)
  assert.equal(validateStagedFileContent('a.md', EXPERT_STAGED_FILE_MAX_BYTES + 1)?.code, 'file-too-large')
  assert.equal(validateStagedFileContent('a.md', -1)?.code, 'invalid-payload')
  assert.equal(validateStagedFileContent('a.md', 1.5)?.code, 'invalid-payload')

  /**
   * 归档原件/完整许可文本允许超过正文类的 20000 字符上限（规格：保留完整文件、
   * 超限只给 warning、不截断）。所以**不传 maxChars 时字符数再多也放行** ——
   * 否则"超限只给 warning"那条路径在暂存阶段就不可达了。
   */
  const longText = 'x'.repeat(EXPERT_STAGED_FILE_MAX_CHARS + 1)
  assert.equal(validateStagedFileContent('a.md', 10, { text: longText }), undefined, '默认不判字符数')
  /** 传了 maxChars 才按它报错。 */
  assert.equal(validateStagedFileContent('a.md', 10, { text: longText, maxChars: EXPERT_STAGED_FILE_MAX_CHARS })?.code, 'file-too-large')
  assert.equal(
    validateStagedFileContent('a.md', 10, { text: 'x'.repeat(EXPERT_STAGED_FILE_MAX_CHARS), maxChars: EXPERT_STAGED_FILE_MAX_CHARS }),
    undefined,
  )

  /** 白名单判定与路径判定同源。 */
  assert.equal(hasAllowedTextExtension('A.MD'), true)
  assert.equal(hasAllowedTextExtension('a.exe'), false)
  assert.deepEqual(pathProblemToIssue({ code: 'invalid-path', message: '坏了' }, 'files[0].path'), { code: 'invalid-path', field: 'files[0].path', message: '坏了' })
})

test('AX-E05 isInsideExpertRoot 用相对路径判定（C:\\root2 不属于 C:\\root）', () => {
  const root = join('C:', 'root')
  assert.equal(isInsideExpertRoot(root, join('C:', 'root', 'a', 'b.md'), 'win32'), true)
  assert.equal(isInsideExpertRoot(root, root, 'win32'), true)
  assert.equal(isInsideExpertRoot(root, join('C:', 'root2', 'a.md'), 'win32'), false, 'startsWith 陷阱')
  assert.equal(isInsideExpertRoot(root, join('C:', 'other'), 'win32'), false)
  assert.equal(isInsideExpertRoot(root, join('C:', 'root', '..', 'other'), 'win32'), false)
})

// ---------------------------------------------------------------------------
// AX-E05：真实"根之外零写入"
// ---------------------------------------------------------------------------

test('AX-E05 非法路径在真实写入路径上也拒：根之外没有任何文件被创建', () => {
  withFixture(({ home, outside, realPersonas, sentinel }) => {
    const roots = resolveExpertRoots({ home })
    /** 直接对"目标在根外"的绝对路径调用原子写入：必须拒，且**不留**任何东西。 */
    const outsideTarget = join(outside, 'evil.md')
    const result = atomicWriteText(outsideTarget, 'evil', { root: roots.personasDir })
    assert.equal(result.ok, false)
    assert.equal(result.problem.code, 'invalid-path')
    assert.equal(listOrEmpty(outside).includes('evil.md'), false, '根外出现了文件')
    assert.equal(listOrEmpty(realPersonas).length, 0, '链接目标目录被写入了')
    assertSentinelIntact(sentinel)
  })
})

// ---------------------------------------------------------------------------
// 原子写入
// ---------------------------------------------------------------------------

test('atomicWriteText 成功时建父目录、字节与 sha256 对得上，且不留临时文件', () => {
  withFixture(({ home }) => {
    const roots = resolveExpertRoots({ home })
    const target = join(roots.personasDir, 'generated', 'abc', 'resources', 'note.md')
    const content = '第一行\n第二行\n'
    const result = atomicWriteText(target, content, { root: roots.personasDir })
    assert.equal(result.ok, true, `写入应成功：${result.ok === false ? result.problem.message : ''}`)
    assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'))
    assert.match(result.sha256, /^[0-9a-f]{64}$/)
    /** 读回磁盘字节。 */
    assert.equal(readFileSync(target, 'utf8'), content)
    assert.equal(lstatSync(target).isFile(), true)
    /** 建出来的目录被登记（回滚要用）。 */
    assert.ok(result.createdDirectories.length >= 1)
    /** 同目录里没有 .tmp 残留（随机名 + rename 的全部痕迹都该清掉）。 */
    const leftovers = readdirSync(join(roots.personasDir, 'generated', 'abc', 'resources')).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], `有临时文件残留：${leftovers.join(',')}`)

    /** 覆盖写入：内容替换、仍然没有残留。 */
    const second = atomicWriteText(target, '换成新内容\n', { root: roots.personasDir })
    assert.equal(second.ok, true)
    assert.equal(readFileSync(target, 'utf8'), '换成新内容\n')
    assert.deepEqual(readdirSync(join(roots.personasDir, 'generated', 'abc', 'resources')).filter((n) => n.endsWith('.tmp')), [])

    /** overwrite: false：已存在时拒，且原内容不变。 */
    const third = atomicWriteText(target, '不该写进去', { root: roots.personasDir, overwrite: false })
    assert.equal(third.ok, false)
    assert.equal(readFileSync(target, 'utf8'), '换成新内容\n', '被拒的写入改动了原文件')
  })
})

test('atomicWriteText 拒绝经根外链接的写入，且不改动任何已有文件（AX-E06）', () => {
  withFixture(({ home, personasDir, outside, sentinel }) => {
    const roots = resolveExpertRoots({ home })
    /** 在根内建一个指向根外的 junction：写它下面的路径必须被拒。 */
    const escape = join(personasDir, 'escape')
    symlinkSync(outside, escape, 'junction')
    const result = atomicWriteText(join(escape, 'evil.md'), 'evil', { root: roots.personasDir })
    assert.equal(result.ok, false)
    assert.equal(result.problem.code, 'path-link-forbidden')
    assert.equal(listOrEmpty(outside).includes('evil.md'), false, '经 junction 写到了根外')
    assertSentinelIntact(sentinel)
  })
})

// ---------------------------------------------------------------------------
// AX-E06：链接检查
// ---------------------------------------------------------------------------

test('AX-E06 根内任意一级是 link/junction 就拒（即使目标仍在根内）', () => {
  withFixture(({ home, personasDir, realPersonas }) => {
    const roots = resolveExpertRoots({ home })
    /** 合法：全新的路径（什么都不存在）与普通目录都通过。 */
    assert.equal(assertNoLinksInsideRoot(roots.personasDir, 'generated/a/b.md').ok, true)
    mkdirSync(join(personasDir, 'generated'))
    assert.equal(assertNoLinksInsideRoot(roots.personasDir, 'generated/a/b.md').ok, true)

    /** junction 指向**根内**的另一处目录：仍然拒（链接意味着落点不由路径决定）。 */
    const innerTarget = join(personasDir, 'real-inner')
    mkdirSync(innerTarget, { recursive: true })
    const innerLink = join(personasDir, 'generated', 'inner-link')
    symlinkSync(innerTarget, innerLink, 'junction')
    const inner = assertNoLinksInsideRoot(roots.personasDir, 'generated/inner-link/note.md')
    assert.equal(inner.ok, false)
    assert.equal(inner.problem.code, 'path-link-forbidden')
    assert.match(inner.problem.message, /符号链接|junction/)

    /** 目录符号链接（非 junction）同样拒。 */
    const dirLink = join(personasDir, 'generated', 'dir-link')
    let dirLinkCreated = true
    try {
      symlinkSync(innerTarget, dirLink, 'dir')
    } catch {
      /** Windows 上未开开发者模式时建符号链接会 EPERM；junction 已覆盖同一判定路径。 */
      dirLinkCreated = false
    }
    if (dirLinkCreated) {
      assert.equal(assertNoLinksInsideRoot(roots.personasDir, 'generated/dir-link/note.md').ok, false)
    }

    /** 目标文件**自己**是链接：拒。 */
    writeFileSync(join(realPersonas, 'target.md'), 'x', 'utf8')
    const fileLink = join(personasDir, 'generated', 'linked.md')
    let fileLinkCreated = true
    try {
      symlinkSync(join(realPersonas, 'target.md'), fileLink, 'file')
    } catch {
      fileLinkCreated = false
    }
    if (fileLinkCreated) {
      const fileResult = assertNoLinksInsideRoot(roots.personasDir, 'generated/linked.md')
      assert.equal(fileResult.ok, false)
      assert.equal(fileResult.problem.code, 'path-link-forbidden')
    }

    /** 批量版本：一条坏路径就能让整批拒（安装器不会"跳过坏的、写好的"）。 */
    const batch = assertNoLinksInPaths(roots.personasDir, ['generated/ok.md', 'generated/inner-link/note.md'])
    assert.equal(batch.ok, false)
    assert.equal(batch.problem.code, 'path-link-forbidden')
  })
})

test('AX-E06 根本身是链接：真实根仍在同树内则放行（真实用户布局），指向根外则拒', () => {
  withFixture(({ root, home, personasDir, outside, sentinel }) => {
    /**
     * 情形 ①：真实根在**根外**（链接绑架）→ 拒。
     * 用 `outside/` 当目标：它在 tmp 根下、但明确在 home 树之外，
     * 正是"把工作台根换成指向别处的链接"要挡住的那一类。
     * 包含边界 = home（生产中由构造参数注入，绝不从根自己推导）。
     */
    const kidnapped = join(outside, 'kidnapped-personas')
    mkdirSync(kidnapped, { recursive: true })
    rmSync(personasDir, { recursive: true, force: true })
    symlinkSync(kidnapped, personasDir, 'junction')
    const escaped = assertNoLinksInsideRoot(personasDir, 'generated/a.md', { allowRootLinkUnder: home })
    assert.equal(escaped.ok, false, '根指向包含边界之外必须拒')
    assert.equal(escaped.problem.code, 'path-link-forbidden')
    assert.equal(listOrEmpty(kidnapped).length, 0, '链接目标被写入了')

    /** 未给出包含边界时，根是链接也一律拒（fail-closed：函数自己无法区分合法布局与绑架）。 */
    const noBoundary = assertNoLinksInsideRoot(personasDir, 'generated/a.md')
    assert.equal(noBoundary.ok, false, '不给边界时根是链接必须拒')
    assert.equal(noBoundary.problem.code, 'path-link-forbidden')

    /** 情形 ②：真实根就在包含边界内（用户把数据盘放在 home 里、或迁移后建链接）→ 放行。 */
    const insideTarget = join(home, '.dsh', 'workbench', 'personas-real')
    mkdirSync(insideTarget, { recursive: true })
    const linkDir = join(home, '.dsh', 'workbench', 'personas-link')
    symlinkSync(insideTarget, linkDir, 'junction')
    const allowed = assertNoLinksInsideRoot(linkDir, 'generated/a.md', { allowRootLinkUnder: home })
    assert.equal(allowed.ok, true, '根是链接但真实根在包含边界内，应放行（否则这类用户完全不可用）')

    /**
     * 情形 ③（**豁免根 ≠ 豁免整条链**）：根是链接且合法，但根**里面**某一级是
     * 指向根外的 junction → 仍必须拒。
     *
     * 为什么单列一条：早期实现在"根是链接但边界允许"的分支里直接 `return { ok: true }`，
     * 把后面"逐段判中间级链接 + realpath 复校"整段跳过了 —— 这正好是链接绑架最常用的形态
     * （合法根 + 内部一级跳出去）。规格 §3.4 要求的是"根**及已有父目录**都不是链接"。
     */
    const escapeTarget = join(home, '.dsh', 'workbench', 'escape-target')
    mkdirSync(escapeTarget, { recursive: true })
    /** 注意 `escapeTarget` 在 home 内（属于"合法"范围），但它**不在真实根 `insideTarget` 内**。 */
    const innerLink = join(insideTarget, 'inner-link')
    symlinkSync(escapeTarget, innerLink, 'junction')
    const innerEscaped = assertNoLinksInsideRoot(linkDir, 'inner-link/a.md', { allowRootLinkUnder: home })
    assert.equal(innerEscaped.ok, false, '根是链接时也不能跳过中间级链接检查')
    assert.equal(innerEscaped.problem.code, 'path-link-forbidden')

    /** 批量版本同样要拒（安装器里走的就是它）。 */
    const innerBatch = assertNoLinksInPaths(linkDir, ['generated/ok.md', 'inner-link/a.md'], { allowRootLinkUnder: home })
    assert.equal(innerBatch.ok, false, '批量路径也必须抓到中间级链接')
    assert.equal(innerBatch.problem.code, 'path-link-forbidden')

    /** 根是链接 + 干净路径仍要放行（豁免根这一层之后不能连带把正常路径判红）。 */
    const clean = assertNoLinksInsideRoot(linkDir, 'generated/ok.md', { allowRootLinkUnder: home })
    assert.equal(clean.ok, true, '根是链接 + 干净路径必须放行')

    assertSentinelIntact(sentinel)
    assert.ok(root.length > 0)
  })
})

test('AX-E06 写入路径上的链接也会被拒（atomicWriteText 的最终文件检查）', () => {
  withFixture(({ home, personasDir, outside, sentinel }) => {
    const roots = resolveExpertRoots({ home })
    /** 目标文件本身是指向根外的文件链接：写入必须拒。 */
    const outsideFile = join(outside, 'outside-target.md')
    writeFileSync(outsideFile, '原始内容\n', 'utf8')
    const targetDir = join(personasDir, 'generated', 'x')
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, 'note.md')
    let linkCreated = true
    try {
      symlinkSync(outsideFile, target, 'file')
    } catch {
      linkCreated = false
    }
    if (linkCreated) {
      const result = atomicWriteText(target, '新内容', { root: roots.personasDir })
      assert.equal(result.ok, false)
      assert.equal(result.problem.code, 'path-link-forbidden')
      /** 根外的目标文件逐字不变。 */
      assert.equal(readFileSync(outsideFile, 'utf8'), '原始内容\n')
    }
    assertSentinelIntact(sentinel)
  })
})

// ---------------------------------------------------------------------------
// 只读
// ---------------------------------------------------------------------------

test('readExpertTextFile 只读根内普通文本：越界、链接、超限都拒，正常文件返回真实字节与哈希', () => {
  withFixture(({ home, personasDir, outside }) => {
    const roots = resolveExpertRoots({ home })
    mkdirSync(join(personasDir, 'generated'), { recursive: true })
    const content = 'license text\n'
    writeFileSync(join(personasDir, 'generated', 'LICENSE.txt'), content, 'utf8')

    const ok = readExpertTextFile(roots.personasDir, 'generated/LICENSE.txt')
    assert.equal(ok.ok, true)
    assert.equal(ok.text, content)
    assert.equal(ok.bytes, Buffer.byteLength(content, 'utf8'))
    assert.match(ok.sha256, /^[0-9a-f]{64}$/)

    /** 越界（`..`）与绝对路径。 */
    assert.equal(readExpertTextFile(roots.personasDir, '../outside/sentinel.txt').ok, false)
    assert.equal(readExpertTextFile(roots.personasDir, join(outside, 'sentinel.txt')).ok, false)
    /** 不存在。 */
    assert.equal(readExpertTextFile(roots.personasDir, 'generated/nope.md').ok, false)
    /** 目录不是文件。 */
    assert.equal(readExpertTextFile(roots.personasDir, 'generated').ok, false)
    /** 超限：写一个 > maxBytes 的文件，明确报 file-too-large（不截断）。 */
    writeFileSync(join(personasDir, 'generated', 'big.md'), 'x'.repeat(EXPERT_STAGED_FILE_MAX_BYTES + 10), 'utf8')
    const big = readExpertTextFile(roots.personasDir, 'generated/big.md')
    assert.equal(big.ok, false)
    assert.equal(big.problem.code, 'file-too-large')
    /** maxBytes 可放宽（归档原件场景）。 */
    assert.equal(readExpertTextFile(roots.personasDir, 'generated/big.md', { maxBytes: EXPERT_STAGED_FILE_MAX_BYTES * 4 }).ok, true)
  })
})

// ---------------------------------------------------------------------------
// 安装锁
// ---------------------------------------------------------------------------

test('withExpertInstallLock：互斥、活锁 install-busy、异常也释放锁', () => {
  withFixture(({ home }) => {
    const roots = resolveExpertRoots({ home })
    const options = { lockPath: roots.installLockPath, pid: 4242, hostname: 'test-host', isProcessAlive: () => true }

    const first = withExpertInstallLock(() => 'done', options)
    assert.equal(first.ok, true)
    assert.equal(first.value, 'done')
    /** 释放后文件必须消失（否则下一次安装会永远拿到活锁）。 */
    assert.equal(listOrEmpty(roots.personasDir).includes(EXPERT_INSTALL_LOCK_FILE_NAME), false)

    /** 持锁期间第二次：install-busy（普通安装不排隐式长队）。 */
    const holder = acquireExpertInstallLock(options)
    assert.equal(holder.ok, true)
    const second = withExpertInstallLock(() => 'never', options)
    assert.equal(second.ok, false)
    assert.equal(second.code, 'install-busy')
    /** recovery 模式：同一个活锁报 install-in-progress（区分"有人在装"与"用户又点了一次确认"）。 */
    const recovery = acquireExpertInstallLock({ ...options, mode: 'recovery' })
    assert.equal(recovery.ok, false)
    assert.equal(recovery.code, 'install-in-progress')
    /**
     * 别人的锁：release 不得删掉它。
     *
     * 造法：把锁文件**换成另一个持有者的**（pid 与 token 都不同），
     * 再拿 holder 的句柄去 release。句柄比对的是自己创建时的 token，对不上就绝不能动手。
     */
    const foreign = { pid: 7777, hostname: 'test-host', token: 'foreign-owner-token', acquiredAt: '2026-01-01T00:00:00.000Z' }
    writeFileSync(roots.installLockPath, JSON.stringify(foreign), 'utf8')
    holder.handle.release()
    assert.equal(lstatSync(roots.installLockPath).isFile(), true, '别人的锁被误删了')
    assert.equal(JSON.parse(readFileSync(roots.installLockPath, 'utf8')).token, foreign.token, '别人的锁内容被改动了')
    /** 自己的锁：release 正常删掉（否则下一次安装会永远拿到活锁）。 */
    rmSync(roots.installLockPath, { force: true })
    const mine = acquireExpertInstallLock(options)
    assert.equal(mine.ok, true)
    mine.handle.release()
    assert.equal(listOrEmpty(roots.personasDir).includes(EXPERT_INSTALL_LOCK_FILE_NAME), false)

    /** 操作抛异常：锁仍被释放，异常原样冒出来。 */
    assert.throws(() => withExpertInstallLock(() => { throw new Error('boom') }, options), /boom/)
    assert.equal(listOrEmpty(roots.personasDir).includes(EXPERT_INSTALL_LOCK_FILE_NAME), false, '异常路径没释放锁')

    /**
     * 锁记录字段（规格 §3.2）：pid + owner 随机值 + **draftId** + createdAt。
     * `draftId` 是可选的：给了必须能从锁文件里读回来（诊断"谁在装"），不给则没有该字段。
     */
    const withDraft = acquireExpertInstallLock({ ...options, draftId: '11111111-1111-4111-8111-111111111111' })
    assert.equal(withDraft.ok, true)
    const onDisk = JSON.parse(readFileSync(roots.installLockPath, 'utf8'))
    assert.equal(onDisk.draftId, '11111111-1111-4111-8111-111111111111', 'draftId 没写进锁文件')
    assert.equal(withDraft.handle.owner.draftId, '11111111-1111-4111-8111-111111111111')
    withDraft.handle.release()

    const noDraft = acquireExpertInstallLock(options)
    assert.equal(noDraft.ok, true)
    assert.equal('draftId' in JSON.parse(readFileSync(roots.installLockPath, 'utf8')), false, '没传 draftId 就不该有该字段')
    noDraft.handle.release()
  })
})

test('安装锁的持有者判定：死进程可回收、状态不明与别的主机绝不强删', () => {
  withFixture(({ home }) => {
    const roots = resolveExpertRoots({ home })
    const lockPath = roots.installLockPath

    /** 死锁：pid 已不存在（同主机）→ 回收。 */
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, hostname: 'test-host', token: 'dead', acquiredAt: '2026-01-01T00:00:00.000Z' }), 'utf8')
    const stale = acquireExpertInstallLock({ lockPath, pid: 1, hostname: 'test-host', isProcessAlive: () => false })
    assert.equal(stale.ok, true, '死锁必须可回收，否则一次崩溃会把安装永久锁死')
    assert.equal(stale.handle.owner.pid, 1)
    stale.handle.release()

    /** 状态不明 → install-lock-owner-unknown，且**锁文件还在**。 */
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, hostname: 'test-host', token: 'unknown', acquiredAt: '' }), 'utf8')
    const unknown = acquireExpertInstallLock({ lockPath, pid: 1, hostname: 'test-host', isProcessAlive: () => undefined })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'install-lock-owner-unknown')
    assert.equal(readFileSync(lockPath, 'utf8').includes('unknown'), true, '状态不明时不得强删锁')

    /** 别的主机：pid 不可比 → 同样不回收。 */
    const otherHost = acquireExpertInstallLock({ lockPath, pid: 1, hostname: 'other-host', isProcessAlive: () => false })
    assert.equal(otherHost.ok, false)
    assert.equal(otherHost.code, 'install-lock-owner-unknown')
    assert.equal(readFileSync(lockPath, 'utf8').includes('unknown'), true)

    /** 锁文件内容坏掉（不是 JSON / 缺字段）→ unknown，不删。 */
    for (const broken of ['not json at all', '{}', 'null', JSON.stringify({ pid: 'x', hostname: '' })]) {
      writeFileSync(lockPath, broken, 'utf8')
      const result = acquireExpertInstallLock({ lockPath, pid: 1, hostname: 'test-host', isProcessAlive: () => false })
      assert.equal(result.ok, false, `坏锁内容必须拒绝：${broken}`)
      assert.equal(result.code, 'install-lock-owner-unknown')
      assert.equal(readFileSync(lockPath, 'utf8'), broken, '坏锁被改动了')
    }

    /** 真死的进程（本进程 pid 之外的活体判定）：默认实现读出来是 boolean 或 undefined。 */
    assert.equal(defaultIsProcessAlive(process.pid), true, '自己一定是活的')
    const deadProbability = defaultIsProcessAlive(0)
    assert.ok(deadProbability === undefined || deadProbability === false || deadProbability === true)
  })
})

test('安装锁路径也可由参数注入；不存在的父目录会被建出来', () => {
  withFixture(({ home }) => {
    const deep = join(home, '.dsh', 'workbench', 'personas', 'nested', 'lock.json')
    const result = acquireExpertInstallLock({ lockPath: deep, pid: 7, hostname: 'h', isProcessAlive: () => true })
    assert.equal(result.ok, true)
    assert.equal(lstatSync(deep).isFile(), true)
    result.handle.release()
    assert.equal(lstatSync(deep, { throwIfNoEntry: false }), undefined)
  })
})
