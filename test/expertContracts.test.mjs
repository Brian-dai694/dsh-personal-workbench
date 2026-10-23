/**
 * 专家域**契约与常量**（`src/shared/expert.ts`）。
 *
 * 覆盖验收断言：**AX-E01**（字典种子）、**AX-E02**（设置开关的口径）、
 * **AX-E03 / AX-E04**（expert 草稿的筛选与 CAS）—— 这一批是"数据契约"的靶子，
 * 文件系统边界在 `expertPaths.test.mjs`、来源与许可校验在 `expertProvenance.test.mjs`。
 *
 * 断言原则（验收清单 §3）：**读回真实状态** —— 查 DB 行、再读一次设置、
 * 看别的 kind 的草稿有没有被动过；不断言"调用了某个函数"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { listDictionaries, listActiveDictionaryCodes } from '../lib/db/repo.js'
import {
  readExpertSettings, writeExpertSettings, getExpertDraft, getPendingExpertDraftForSession,
  createExpertDraft, updateExpertDraftCas, defaultExpertId, ExpertRepoError,
} from '../lib/db/repo/experts.js'
import {
  EXPERT_ERROR_CODES, isExpertErrorCode, isExpertUuid, isExpertId, isExpertSourceId, isExpertSkillName,
  expertIdFromUuid, expertUuidFromId, EXPERT_DRAFT_KIND, EXPERT_AUTO_SUMMON_META_KEY,
  EXPERT_DRAFT_MAX_FILES, EXPERT_DRAFT_MAX_TOTAL_BYTES, EXPERT_STAGED_FILE_MAX_BYTES,
  EXPERT_BODY_MAX_CHARS, EXPERT_SKILL_MAX_INSTALLS, EXPERT_SKILL_MAX_REUSES,
  EXPERT_SKILL_MAX_REQUIREMENTS, EXPERT_RESOURCE_MAX_DEPTH, EXPERT_SUBAGENT_TIMEOUT_MS,
  EXPERT_MANUAL_REQUEST_TTL_MS, EXPERT_MAX_CONCURRENT_PER_SESSION, EXPERT_MAX_CONCURRENT_TOTAL,
  EXPERT_CHILD_RESULT_MAX_CHARS, EXPERT_HTTP_BODY_MAX_BYTES, EXPERT_PROVIDER_CODE,
  EXPERT_METHODOLOGY_MAX_ATTEMPTS, EXPERT_SOURCE_MAX_COUNT, EXPERT_SOURCE_MAX_AUTHORS,
  EXPERT_REQUEST_MAX_CHARS, EXPERT_ALLOWED_LICENSE,
} from '../lib/shared/expert.js'
import { PERSONA_FILE_MAX_BYTES } from '../lib/shared/persona.js'

/** 删临时目录并在 Windows 上重试（WAL 句柄未释放会 EPERM；见 `test/db.test.mjs` 的说明）。 */
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

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wb-expert-contracts-'))
  let db
  try {
    db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
  } catch (error) {
    if (db !== undefined) db.close()
    removeTempDir(dir)
    throw error
  }
  return { dir, db, close() { db.close(); removeTempDir(dir) } }
}

// ---------------------------------------------------------------------------
// 常量与判别函数
// ---------------------------------------------------------------------------

test('专家错误码是封闭枚举：每个都能被 isExpertErrorCode 认出，且没有重复', () => {
  assert.ok(EXPERT_ERROR_CODES.length >= 40, `错误码数量异常：${EXPERT_ERROR_CODES.length}`)
  assert.equal(new Set(EXPERT_ERROR_CODES).size, EXPERT_ERROR_CODES.length, '错误码有重复项')
  for (const code of EXPERT_ERROR_CODES) {
    assert.equal(isExpertErrorCode(code), true, `枚举内的 code 应被认出：${code}`)
    /** 稳定 code = 小写 kebab-case，**不允许中文**（中文只进 message）。 */
    assert.match(code, /^[a-z][a-z0-9-]*$/, `错误码必须是小写 kebab-case：${code}`)
  }
  assert.equal(isExpertErrorCode('专家忙'), false)
  assert.equal(isExpertErrorCode('expert-busy '), false)
  assert.equal(isExpertErrorCode(undefined), false)
  /** 规格 §12.1 里几条会被断言用到的关键码必须在册（漏一个就会在别处变成临时字符串）。 */
  for (const required of ['draft-version-conflict', 'install-busy', 'install-in-progress', 'path-link-forbidden', 'generation-conflict']) {
    assert.ok(EXPERT_ERROR_CODES.includes(required), `缺少错误码：${required}`)
  }
})

test('§1.4 限值就是规格里那些数字（改一个都会红）', () => {
  assert.equal(EXPERT_BODY_MAX_CHARS, 20000)
  assert.equal(PERSONA_FILE_MAX_BYTES, 256 * 1024)
  assert.equal(EXPERT_STAGED_FILE_MAX_BYTES, 128 * 1024)
  assert.equal(EXPERT_DRAFT_MAX_FILES, 64)
  assert.equal(EXPERT_DRAFT_MAX_TOTAL_BYTES, 1024 * 1024)
  assert.equal(EXPERT_SKILL_MAX_INSTALLS, 8)
  assert.equal(EXPERT_SKILL_MAX_REUSES, 16)
  assert.equal(EXPERT_SKILL_MAX_REQUIREMENTS, 24)
  assert.equal(EXPERT_RESOURCE_MAX_DEPTH, 4)
  assert.equal(EXPERT_METHODOLOGY_MAX_ATTEMPTS, 3)
  assert.equal(EXPERT_MANUAL_REQUEST_TTL_MS, 30 * 60 * 1000)
  assert.equal(EXPERT_SUBAGENT_TIMEOUT_MS, 10 * 60 * 1000)
  assert.equal(EXPERT_MAX_CONCURRENT_PER_SESSION, 1)
  assert.equal(EXPERT_MAX_CONCURRENT_TOTAL, 2)
  assert.equal(EXPERT_CHILD_RESULT_MAX_CHARS, 12000)
  assert.equal(EXPERT_HTTP_BODY_MAX_BYTES, 256 * 1024)
  assert.equal(EXPERT_REQUEST_MAX_CHARS, 2000)
  assert.equal(EXPERT_SOURCE_MAX_COUNT, 8)
  assert.equal(EXPERT_SOURCE_MAX_AUTHORS, 16)
  assert.equal(EXPERT_PROVIDER_CODE, 'spawn')
  assert.equal(EXPERT_ALLOWED_LICENSE, 'MIT')
  assert.equal(EXPERT_DRAFT_KIND, 'expert')
  assert.equal(EXPERT_AUTO_SUMMON_META_KEY, 'expert_auto_summon')
})

test('id 形状：draftId/expertId 只认小写 UUID，sourceId 与 skillName 各有自己的封闭形状', () => {
  const uuid = '01234567-89ab-cdef-0123-456789abcdef'
  assert.equal(isExpertUuid(uuid), true)
  assert.equal(isExpertUuid(uuid.toUpperCase()), false, '大写 UUID 不接受（路径大小写敏感性不统一）')
  assert.equal(isExpertUuid('{01234567-89ab-cdef-0123-456789abcdef}'), false)
  assert.equal(isExpertUuid('01234567-89ab-cdef-0123-456789abcde'), false, '少一位不是 UUID')
  assert.equal(isExpertId(`generated/${uuid}`), true)
  assert.equal(isExpertId(`personas/${uuid}`), false, '前缀必须是 generated')
  assert.equal(expertIdFromUuid(uuid), `generated/${uuid}`)
  assert.equal(expertUuidFromId(`generated/${uuid}`), uuid)
  assert.equal(expertUuidFromId('generated/not-a-uuid'), undefined)
  /** expertId 是**目录名/文件名**：形状不对时必须能被拒，不能带出 `../`。 */
  assert.equal(isExpertId('generated/../secret'), false)

  assert.equal(isExpertSourceId('openai-agents'), true)
  assert.equal(isExpertSourceId('a'), true)
  assert.equal(isExpertSourceId('-a'), false, '不能以连字符开头')
  assert.equal(isExpertSourceId('A-b'), false, '只允许小写')
  assert.equal(isExpertSourceId('a'.repeat(49)), false, '最长 48 字符')
  assert.equal(isExpertSourceId('a'.repeat(48)), true)

  assert.equal(isExpertSkillName('pdf-extract'), true)
  assert.equal(isExpertSkillName('a'), true)
  assert.equal(isExpertSkillName('-a'), false)
  assert.equal(isExpertSkillName('a-'), false)
  assert.equal(isExpertSkillName('A-B'), false, 'skill 名必须小写 kebab-case')
  assert.equal(isExpertSkillName('a--b'), false, '不允许连续连字符')
  assert.equal(isExpertSkillName('a'.repeat(64)), true)
  assert.equal(isExpertSkillName('a'.repeat(65)), false)
  assert.equal(isExpertSkillName('a/b'), false, 'skill 名不得含分隔符')
  assert.equal(isExpertSkillName('..'), false)
})

// ---------------------------------------------------------------------------
// AX-E01：字典种子
// ---------------------------------------------------------------------------

test('AX-E01 新库 seed 后带 expert 两个字典种子（draft_kind / ai_session_scope）', () => {
  const ctx = makeDb()
  try {
    const draftKinds = listDictionaries(ctx.db, 'draft_kind')
    const expert = draftKinds.find((row) => row.code === 'expert')
    assert.ok(expert !== undefined, 'draft_kind 里缺 expert 种子')
    assert.equal(expert.name, '专家安装草稿')
    assert.equal(expert.sortOrder, 100)
    /** SQLite INTEGER 列读回是 0/1（`DictionaryEntry` 的既有形状），按 1 断言。 */
    assert.equal(expert.builtin, 1)
    assert.equal(expert.active, 1)

    const scopes = listDictionaries(ctx.db, 'ai_session_scope')
    const scope = scopes.find((row) => row.code === 'expert_generation')
    assert.ok(scope !== undefined, 'ai_session_scope 里缺 expert_generation 种子')
    assert.equal(scope.name, '专家生成会话')
    assert.equal(scope.sortOrder, 60)

    /** 既有种子不能被顶掉（expert 排在最后，不是替换）。 */
    assert.ok(listActiveDictionaryCodes(ctx.db, 'draft_kind').includes('idea_tasks'))
  } finally {
    ctx.close()
  }
})

test('AX-E01 在「已有 schema 的旧库」上再 seed：补入 expert 种子，schema 版本不变，已改过的字典不被覆盖', () => {
  const ctx = makeDb()
  try {
    const versionOf = () => ctx.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const before = ctx.db.prepare('PRAGMA user_version').get()
    const metaBefore = versionOf()

    /** 模拟"用户改过种子"：改掉一个既有字典的显示名与排序。 */
    ctx.db.prepare('UPDATE dictionaries SET name = ?, sort_order = ? WHERE kind = ? AND code = ?')
      .run('我的点子落地', 91, 'draft_kind', 'idea_tasks')
    /** 再删掉 expert 种子，模拟"老库还没有它"。 */
    ctx.db.prepare('DELETE FROM dictionaries WHERE kind = ? AND code = ?').run('draft_kind', 'expert')

    seedDictionaries(ctx.db)

    const expert = listDictionaries(ctx.db, 'draft_kind').find((row) => row.code === 'expert')
    assert.ok(expert !== undefined, '重复 seed 应把缺的 expert 种子补回来（INSERT OR IGNORE 的补入语义）')
    const modified = listDictionaries(ctx.db, 'draft_kind').find((row) => row.code === 'idea_tasks')
    assert.equal(modified.name, '我的点子落地', 'INSERT OR IGNORE 不得覆盖用户改过的条目')
    assert.equal(modified.sortOrder, 91)
    assert.deepEqual(ctx.db.prepare('PRAGMA user_version').get(), before, 'seed 不得改 schema')
    assert.deepEqual(versionOf(), metaBefore, 'seed 不得改 schema_version')

    /** 再 seed 一次仍然稳定（幂等）。 */
    seedDictionaries(ctx.db)
    assert.equal(listDictionaries(ctx.db, 'draft_kind').filter((row) => row.code === 'expert').length, 1)
  } finally {
    ctx.close()
  }
})

// ---------------------------------------------------------------------------
// AX-E02：设置开关
// ---------------------------------------------------------------------------

test('AX-E02 设置缺失 / 脏值 / "false" 字符串 / true boolean：只有真 boolean 与真值标记算开', () => {
  const ctx = makeDb()
  try {
    /** 1) 完全不存在 → 关。 */
    assert.equal(readExpertSettings(ctx.db).autoSummonExperts, false)

    /** 2) 脏值 → 关（fail-closed，不能让 'yes' 变成"开"）。 */
    for (const dirty of ['yes', '', 'null', '2', 'TRUE', 'on']) {
      ctx.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(EXPERT_AUTO_SUMMON_META_KEY, dirty)
      assert.equal(readExpertSettings(ctx.db).autoSummonExperts, false, `脏值「${dirty}」必须读成关`)
    }

    /** 3) 字符串 'false' **不是** boolean：写入必须被拒，且库里保持原值。 */
    ctx.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(EXPERT_AUTO_SUMMON_META_KEY, 'true')
    assert.equal(writeExpertSettings(ctx.db, { autoSummonExperts: 'false' }), false, '字符串不得被当作 boolean 写入')
    assert.equal(readExpertSettings(ctx.db).autoSummonExperts, true, '被拒的写入不得改动库里已有的值')

    /** 4) 真 boolean 写入 → 读回一致（两条路都必须对）。 */
    assert.equal(writeExpertSettings(ctx.db, { autoSummonExperts: true }), true)
    assert.equal(readExpertSettings(ctx.db).autoSummonExperts, true)
    assert.equal(writeExpertSettings(ctx.db, { autoSummonExperts: false }), true)
    assert.equal(readExpertSettings(ctx.db).autoSummonExperts, false)
    /** 空 patch：不写、不报错、不改状态。 */
    assert.equal(writeExpertSettings(ctx.db, {}), false)
    assert.equal(readExpertSettings(ctx.db).autoSummonExperts, false)

    /** 5) 只动这一个键：别的 meta 一个字节都不能变。 */
    ctx.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('desktop_notify', '1')
    const snapshot = () => ctx.db.prepare('SELECT key, value FROM meta ORDER BY key').all()
    const before = snapshot()
    writeExpertSettings(ctx.db, { autoSummonExperts: true })
    const after = snapshot()
    assert.deepEqual(after.map((row) => row.key), before.map((row) => row.key), '写入只允许出现 expert_auto_summon 这一个键')
    for (const row of before) {
      if (row.key === EXPERT_AUTO_SUMMON_META_KEY) continue
      assert.equal(after.find((item) => item.key === row.key).value, row.value, `别的 meta 键被改动了：${row.key}`)
    }
    assert.equal(after.find((row) => row.key === EXPERT_AUTO_SUMMON_META_KEY).value, 'true')
  } finally {
    ctx.close()
  }
})

// ---------------------------------------------------------------------------
// AX-E03：同 session 去重 / 不同 request 冲突 / 不误伤别的 kind
// ---------------------------------------------------------------------------

test('AX-E03 同 session 两个请求建 expert 草稿：同 request 复用、不同 request 冲突，且不动 knowledge/task 草稿', () => {
  const ctx = makeDb()
  try {
    const sessionId = 'session-expert-a'
    /** 场景夹具：同会话里**先**有一条 task 草稿与一条 knowledge 草稿。 */
    ctx.db.prepare(
      `INSERT INTO task_drafts (id, kind_code, session_id, payload_json, status_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run('draft-task-1', 'task', sessionId, JSON.stringify({ title: '写周报' }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    ctx.db.prepare(
      `INSERT INTO task_drafts (id, kind_code, session_id, payload_json, status_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run('draft-knowledge-1', 'knowledge', sessionId, JSON.stringify({ title: '一条知识' }), '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')

    /** 第一次：新建。 */
    const first = createExpertDraft(ctx.db, { sessionId, request: '做一个会写测试的专家' })
    assert.equal(first.reused, false)
    assert.equal(first.draft.kindCode, 'expert')
    assert.equal(first.draft.statusCode, 'pending')
    assert.equal(first.payload.contentVersion, 0)
    assert.equal(first.payload.phase, 'editing')
    assert.equal(first.payload.request, '做一个会写测试的专家')
    assert.match(first.payload.expertId, /^generated\/[0-9a-f-]{36}$/)
    assert.equal(isExpertId(first.payload.expertId), true)

    /** 第二次同 request：**复用**，不新建行。 */
    const rowCount = () => ctx.db.prepare('SELECT COUNT(*) AS n FROM task_drafts WHERE kind_code = ?').get(EXPERT_DRAFT_KIND).n
    const second = createExpertDraft(ctx.db, { sessionId, request: '做一个会写测试的专家' })
    assert.equal(second.reused, true)
    assert.equal(second.draft.id, first.draft.id)
    assert.equal(rowCount(), 1, '同 request 不得再建一行')

    /** 第二次不同 request：冲突（带稳定 code）。 */
    assert.throws(
      () => createExpertDraft(ctx.db, { sessionId, request: '换一个完全不同的需求' }),
      (error) => {
        assert.ok(error instanceof ExpertRepoError, `应是 ExpertRepoError，实际 ${error?.name}`)
        assert.equal(error.code, 'generation-conflict')
        return true
      },
    )
    assert.equal(rowCount(), 1, '冲突时不得留下半截新行')

    /** 空 request：当场拒绝（静默丢件是禁区）。 */
    assert.throws(() => createExpertDraft(ctx.db, { sessionId: 'session-expert-b', request: '   ' }), (error) => {
      assert.equal(error.code, 'invalid-payload')
      return true
    })

    /** 别的 kind 的草稿**逐字不变**。 */
    const taskRow = ctx.db.prepare('SELECT * FROM task_drafts WHERE id = ?').get('draft-task-1')
    const knowledgeRow = ctx.db.prepare('SELECT * FROM task_drafts WHERE id = ?').get('draft-knowledge-1')
    assert.equal(taskRow.status_code, 'pending')
    assert.equal(taskRow.kind_code, 'task')
    assert.deepEqual(JSON.parse(taskRow.payload_json), { title: '写周报' })
    assert.equal(knowledgeRow.status_code, 'pending')
    assert.deepEqual(JSON.parse(knowledgeRow.payload_json), { title: '一条知识' })

    /** 查询必须按 kind 过滤：查 expert 草稿不会捞到 task/knowledge。 */
    const pending = getPendingExpertDraftForSession(ctx.db, sessionId)
    assert.equal(pending?.id, first.draft.id)
    assert.equal(getExpertDraft(ctx.db, 'draft-task-1'), undefined, 'getExpertDraft 不得返回别的 kind 的草稿')
    assert.equal(getExpertDraft(ctx.db, 'draft-knowledge-1'), undefined)
    assert.equal(getExpertDraft(ctx.db, first.draft.id)?.kindCode, 'expert')

    /** 别会话互不影响；session 为 null 时不去重（没有会话键可比）。 */
    const other = createExpertDraft(ctx.db, { sessionId: 'session-expert-c', request: '另一个需求' })
    assert.notEqual(other.draft.id, first.draft.id)
    assert.equal(getPendingExpertDraftForSession(ctx.db, 'session-expert-c')?.id, other.draft.id)
    assert.equal(getPendingExpertDraftForSession(ctx.db, 'session-does-not-exist'), undefined)

    /** 只认 pending：草稿一旦不是 pending 就不再算"待确认"。 */
    ctx.db.prepare('UPDATE task_drafts SET status_code = ? WHERE id = ?').run('confirmed', first.draft.id)
    assert.equal(getPendingExpertDraftForSession(ctx.db, sessionId), undefined)
  } finally {
    ctx.close()
  }
})

test('AX-E03 不同用户 request 的冲突可被"放弃旧草稿"解开（新 request 建新草稿）', () => {
  const ctx = makeDb()
  try {
    const sessionId = 'session-expert-d'
    const first = createExpertDraft(ctx.db, { sessionId, request: '需求一' })
    assert.throws(() => createExpertDraft(ctx.db, { sessionId, request: '需求二' }), /待确认的专家草稿/)
    ctx.db.prepare('UPDATE task_drafts SET status_code = ? WHERE id = ?').run('abandoned', first.draft.id)
    const second = createExpertDraft(ctx.db, { sessionId, request: '需求二' })
    assert.notEqual(second.draft.id, first.draft.id)
    assert.equal(second.payload.contentVersion, 0)
    /** 旧草稿还在（放弃不等于删除），但状态是 abandoned。 */
    assert.equal(getExpertDraft(ctx.db, first.draft.id)?.statusCode, 'abandoned')
  } finally {
    ctx.close()
  }
})

test('defaultExpertId 只生成 generated/<UUID>，注入的非法 expertId 当场拒绝', () => {
  const ctx = makeDb()
  try {
    const generated = defaultExpertId()
    assert.equal(isExpertId(generated), true)
    assert.equal(defaultExpertId('ABCDEF01-2345-6789-ABCD-EF0123456789'), 'generated/abcdef01-2345-6789-abcd-ef0123456789')
    for (const bad of ['generated/not-a-uuid', '../generated/x', 'generated/01234567-89ab-cdef-0123-456789abcdef/..', 'plain-uuid']) {
      assert.throws(() => createExpertDraft(ctx.db, { sessionId: null, request: 'r', expertId: bad }), (error) => {
        assert.equal(error.code, 'invalid-payload')
        return true
      }, `非法 expertId 应被拒：${bad}`)
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM task_drafts').get().n, 0, '被拒的创建不得留下行')
  } finally {
    ctx.close()
  }
})

// ---------------------------------------------------------------------------
// AX-E04：CAS
// ---------------------------------------------------------------------------

test('AX-E04 相同旧版本的两次更新：只有一个成功，另一个是 draft-version-conflict，且不丢新内容', () => {
  const ctx = makeDb()
  try {
    const created = createExpertDraft(ctx.db, { sessionId: 'session-cas', request: '做一个专家' })
    const id = created.draft.id
    assert.equal(created.payload.contentVersion, 0)

    /** 第一轮：v0 → v1，写入正文。 */
    const first = updateExpertDraftCas(ctx.db, id, 0, { personaMd: '第一版正文' })
    assert.equal(first.changed, true)
    assert.equal(first.payload.contentVersion, 1)
    assert.equal(first.payload.personaMd, '第一版正文')

    /** 第二轮：**仍拿 v0**（模拟另一轮并发输出）→ 必须冲突，不能覆盖 v1。 */
    assert.throws(() => updateExpertDraftCas(ctx.db, id, 0, { personaMd: '并发的第二版' }), (error) => {
      assert.ok(error instanceof ExpertRepoError)
      assert.equal(error.code, 'draft-version-conflict')
      return true
    })

    /** 读回 DB 真实内容：v1 的正文还在，版本还是 1（并发那版没落库）。 */
    const row = ctx.db.prepare('SELECT payload_json, updated_at FROM task_drafts WHERE id = ?').get(id)
    const payload = JSON.parse(row.payload_json)
    assert.equal(payload.contentVersion, 1)
    assert.equal(payload.personaMd, '第一版正文')

    /** 再用正确版本推进：v1 → v2，前一轮内容不丢。 */
    const third = updateExpertDraftCas(ctx.db, id, 1, { personaMd: '第三版正文' })
    assert.equal(third.payload.contentVersion, 2)
    assert.equal(third.payload.personaMd, '第三版正文')
    assert.equal(JSON.parse(ctx.db.prepare('SELECT payload_json FROM task_drafts WHERE id = ?').get(id).payload_json).contentVersion, 2)
  } finally {
    ctx.close()
  }
})

test('AX-E04 同内容重提交 changed=false（版本不变、validation 保留）；内容不同则清 validation 并回到 editing', () => {
  const ctx = makeDb()
  try {
    const created = createExpertDraft(ctx.db, { sessionId: 'session-cas2', request: '做一个专家' })
    const id = created.draft.id

    const v1 = updateExpertDraftCas(ctx.db, id, 0, { personaMd: '正文 A' })
    assert.equal(v1.payload.contentVersion, 1)

    /** 假装已经校验过（manifestHash + 时间）。 */
    const validation = { version: 1, manifestHash: 'f'.repeat(64), checkedAt: '2026-01-01T00:00:00.000Z', errors: [], warnings: [] }
    const validated = updateExpertDraftCas(ctx.db, id, 1, { validation, phase: 'validated' })
    assert.equal(validated.payload.contentVersion, 1, '只写 validation 不算内容变更，版本不变')
    assert.equal(validated.changed, true)
    assert.equal(validated.payload.phase, 'validated')

    /** 同内容重提交：内容没变 → 版本不变，且**不清**用户已看过的校验结果。 */
    const same = updateExpertDraftCas(ctx.db, id, 1, { personaMd: '正文 A' })
    assert.equal(same.changed, false)
    assert.equal(same.payload.contentVersion, 1)
    assert.equal(same.payload.validation?.manifestHash, 'f'.repeat(64), '同内容重提交不得清掉 validation')

    /**
     * 幂等重放：完全相同的 patch（含 phase）再跑一次——`changed` 必须是 false。
     * 界面靠它判断"要不要提示用户已重新校验"，恒为 true 就等于每次都在撒谎。
     */
    const replay = updateExpertDraftCas(ctx.db, id, 1, { validation, phase: 'validated' })
    assert.equal(replay.changed, false)
    assert.equal(replay.payload.contentVersion, 1)

    /** 内容不同：版本 +1、清 validation、phase 回 editing。 */
    const changed = updateExpertDraftCas(ctx.db, id, 1, { personaMd: '正文 B' })
    assert.equal(changed.payload.contentVersion, 2)
    assert.equal(changed.payload.validation, null, '内容变了必须清 validation（旧 hash 已失效）')
    assert.equal(changed.payload.phase, 'editing')
    const row = JSON.parse(ctx.db.prepare('SELECT payload_json FROM task_drafts WHERE id = ?').get(id).payload_json)
    assert.equal(row.validation, null)
    assert.equal(row.phase, 'editing')
    assert.equal(row.personaMd, '正文 B')
  } finally {
    ctx.close()
  }
})

test('CAS 的状态守卫：不存在 / 非 pending / installing 各有稳定 code', () => {
  const ctx = makeDb()
  try {
    assert.throws(() => updateExpertDraftCas(ctx.db, 'no-such-draft', 0, {}), (error) => {
      assert.equal(error.code, 'draft-not-found')
      return true
    })

    const created = createExpertDraft(ctx.db, { sessionId: 'session-guard', request: 'r' })
    const id = created.draft.id
    /** installing：正在装的草稿不可改。 */
    ctx.db.prepare('UPDATE task_drafts SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...created.payload, phase: 'installing' }), id)
    assert.throws(() => updateExpertDraftCas(ctx.db, id, 0, { personaMd: 'x' }), (error) => {
      assert.equal(error.code, 'install-in-progress')
      return true
    })

    /** 非 pending：已确认的草稿不可再改。 */
    ctx.db.prepare('UPDATE task_drafts SET status_code = ?, payload_json = ? WHERE id = ?')
      .run('confirmed', JSON.stringify({ ...created.payload, phase: 'validated' }), id)
    assert.throws(() => updateExpertDraftCas(ctx.db, id, 0, { personaMd: 'x' }), (error) => {
      assert.equal(error.code, 'draft-not-pending')
      return true
    })

    /** 负数/非整数版本也是冲突，而不是"恰好等于"。 */
    ctx.db.prepare('UPDATE task_drafts SET status_code = ? WHERE id = ?').run('pending', id)
    assert.throws(() => updateExpertDraftCas(ctx.db, id, -1, { personaMd: 'x' }), (error) => {
      assert.equal(error.code, 'draft-version-conflict')
      return true
    })
    assert.throws(() => updateExpertDraftCas(ctx.db, id, 0.5, { personaMd: 'x' }), (error) => {
      assert.equal(error.code, 'draft-version-conflict')
      return true
    })
  } finally {
    ctx.close()
  }
})

test('CAS 不能跨草稿：拿 A 的版本去改 B 必须按 B 自己的版本判定', () => {
  const ctx = makeDb()
  try {
    const a = createExpertDraft(ctx.db, { sessionId: 'session-x', request: 'A' })
    const b = createExpertDraft(ctx.db, { sessionId: 'session-y', request: 'B' })
    updateExpertDraftCas(ctx.db, a.draft.id, 0, { personaMd: 'A 正文' })
    /** B 还在 v0：用 v0 改 B 成功；用 v1 改 B 冲突。 */
    assert.throws(() => updateExpertDraftCas(ctx.db, b.draft.id, 1, { personaMd: 'B 正文' }), (error) => {
      assert.equal(error.code, 'draft-version-conflict')
      return true
    })
    const ok = updateExpertDraftCas(ctx.db, b.draft.id, 0, { personaMd: 'B 正文' })
    assert.equal(ok.payload.personaMd, 'B 正文')
    /** A 的内容不受影响。 */
    const aRow = JSON.parse(ctx.db.prepare('SELECT payload_json FROM task_drafts WHERE id = ?').get(a.draft.id).payload_json)
    assert.equal(aRow.personaMd, 'A 正文')
    assert.equal(aRow.contentVersion, 1)
  } finally {
    ctx.close()
  }
})
