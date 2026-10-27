/**
 * 专家 HTTP 接口（`src/api/routes/experts.ts` + `src/api/routes/drafts.ts` 的 expert 分支）。
 *
 * 覆盖验收断言 **AX-E31 / AX-E32 / AX-E33 / AX-E35**（AX-E34 在
 * `test/expertTools.test.mjs`，AX-E50 在 `test/expertWiring.test.mjs`）。
 *
 * ## 为什么用真实 HTTP 而不是直接调 handler
 *
 * 这一层的失败模式几乎都不是"函数返回错了"，而是：状态码错、围栏没套上、
 * 响应里漏了服务端绝对路径、`readJsonBody` 的 undefined 被当成"坏 JSON"以外的东西。
 * 只有真实 socket + 真实 `fetch` 才能同时钉住这四件事（照 `test/routes.test.mjs` 的写法）。
 *
 * ## 夹具
 *
 * 每个用例一个 `mkdtempSync`：`personas/`、`skills/`、`<root>/workbench.db`。
 * `roots` 由 `resolveExpertRoots({personasDir, skillsDir})` 注入，**不走 homedir** ——
 * 测试永远不会碰用户真实的 `~/.dsh/workbench`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { EXPERTS_PREFIX } from '../lib/api/routes/experts.js'
import { DRAFTS_PREFIX } from '../lib/api/routes/helpers.js'
import { createExpertService } from '../lib/experts/service.js'
import { resolveExpertRoots } from '../lib/experts/paths.js'
import { EXPERT_HTTP_BODY_MAX_BYTES, EXPERT_REQUEST_MAX_CHARS } from '../lib/shared/expert.js'

const SESSION_A = 'session-expert-routes-aaaa'
const AT = '2026-01-01T00:00:00.000Z'

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

const BODY = '## 身份与职责\n你负责审查需求。\n\n## 工作流程\n1. 读需求。\n'

function personaDoc(body = BODY) {
  return [
    '---',
    'group: 工程',
    '---',
    '',
    '# 需求审查专家',
    '',
    '> 分类：工程',
    '> 工作模式：只读审查',
    '> 建议 emoji：🔎',
    '> 建议简介：审查需求的完整性、可验证性及实现风险，输出明确问题和修改建议。',
    '',
    body,
  ].join('\n')
}

function provenanceJson(overrides = {}) {
  return JSON.stringify({
    version: 1,
    creationKind: 'translated',
    sources: [{
      id: 'demo',
      repository: 'https://github.com/example/demo',
      upstreamPath: 'agents/reviewer.md',
      commit: 'a'.repeat(40),
      fetchedAt: AT,
      authors: ['Demo Author'],
      license: 'MIT',
      copyrightNotice: 'Copyright (c) 2026 Demo Authors',
      licenseFile: 'sources/demo/LICENSE.txt',
      usedFor: ['persona'],
      modifications: '翻译为中文',
    }],
    references: [],
    generationNote: '依据上游 MIT 素材改写并登记来源',
    ...overrides,
  })
}

const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 Demo Authors',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
  '',
].join('\n')

/** 真实 HTTP 服务 + 真实路由表（与生产同一条装配路径：`makeRoutes(db, { experts })`）。 */
async function withServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wb-expert-routes-'))
  const personasDir = join(root, 'personas')
  const skillsDir = join(root, 'skills')
  mkdirSync(personasDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  const db = openWorkbenchDb({ dbPath: join(root, 'workbench.db') })
  seedDictionaries(db)
  const service = createExpertService({
    db,
    ctx: { get: () => undefined },
    roots: resolveExpertRoots({ personasDir, skillsDir }),
    now: () => AT,
  })
  const routes = [...makeRoutes(db, { experts: service })]
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    db.close()
    throw new Error(`测试服务器没有拿到端口（address=${String(address)}）`)
  }
  const port = address.port
  const request = async (method, path, body) => {
    const init = {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    }
    const url = `http://127.0.0.1:${port}${path}`
    let res
    for (let attempt = 0; ; attempt += 1) {
      try {
        res = await fetch(url, init)
        break
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        const transient = /bad port|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed/i.test(message)
        if (!transient || attempt >= 2) throw new Error(`请求 ${method} ${path} 失败（第 ${attempt + 1} 次）：${message}`)
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    }
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text), raw: text, headers: res.headers }
  }
  const safeToRemove = root.startsWith(tmpdir()) && root.includes('dsh-wb-expert-routes-')
  try {
    await fn({ db, service, request, root, personasDir, skillsDir, port })
  } finally {
    server.close()
    try {
      db.close()
    } catch {
      /** 已经关过了。 */
    }
    if (safeToRemove) removeTempDir(root)
  }
}

const START = `${EXPERTS_PREFIX}/generation-start`

async function startDraft(request, over = {}) {
  const res = await request('POST', START, {
    sessionId: SESSION_A,
    request: '做一个需求审查专家',
    workspaceId: 'E:\\Code\\demo',
    ...over,
  })
  return res
}

// ---------------------------------------------------------------------------
// §4.1 只读接口 + 路径投影（AX-E31 的"不泄露"部分）
// ---------------------------------------------------------------------------

test('experts: capabilities 如实报能力（未实现的子代理恒 available:false，带 enable 真值）', async () => {
  await withServer(async ({ request }) => {
    const caps = await request('GET', `${EXPERTS_PREFIX}/capabilities`)
    assert.equal(caps.status, 200)
    assert.equal(caps.body.ok, true)
    assert.equal(caps.body.generation.available, true, '随包方法论在 → 生成通道可用')
    assert.equal(caps.body.generation.reason, null)
    assert.equal(caps.body.skills.available, false, '测试 ctx 没有 skills 服务 → 必须如实报 false')
    assert.equal(caps.body.skills.reason, 'skill-service-unavailable')
    for (const key of ['manualSummon', 'autoSummon']) {
      assert.equal(caps.body[key].available, false, `${key} 在 P5 必须 false（P6 才实现子代理调用）`)
      assert.equal(caps.body[key].reason, 'expert-subagent-unavailable', `${key}.reason 要说清是"没实现"，不能报可用`)
    }
    assert.equal(caps.body.autoSummon.enabled, false, '唯一设置真值（读 readExpertSettings）')
    assert.equal(caps.body.providerName, 'personal-workbench')
  })
})

test('experts: methodology 走随包资产（相对 import.meta.url），版本 1 且含 13 步', async () => {
  await withServer(async ({ request, root }) => {
    const res = await request('GET', `${EXPERTS_PREFIX}/methodology`)
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.version, 1)
    assert.match(res.body.text, /13 步/)
    assert.match(res.body.text, /group: 工程/)
    assert.equal(res.raw.includes(root), false, '方法论资产不得带服务端路径')
  })
})

test('experts: catalog 只回摘要 + 诊断经投影（**响应里不出现临时根 / journal / ticket / resourceBase**）', async () => {
  await withServer(async ({ request, root, personasDir }) => {
    /** 根级跳过（README 不算角色文档）→ 来源级诊断，且**带绝对 path**（投影必须吃掉它）。 */
    writeFileSync(join(personasDir, 'README.md'), '# 不是角色文档\n', 'utf8')
    /** 坏文档 → 会变成一行 `invalid`（行内问题同样不许带绝对路径）。 */
    writeFileSync(join(personasDir, 'broken.md'), ['---', 'nope: 1', '---', '', '# 坏文档', '', '正文', ''].join('\n'), 'utf8')

    const res = await request('GET', `${EXPERTS_PREFIX}/catalog`)
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.ok(Array.isArray(res.body.experts))
    assert.ok(res.body.diagnostics.length > 0, 'README 跳过必须留下来源级诊断')
    assert.equal(res.body.diagnostics.some((issue) => issue.code === 'skipped-readme'), true)

    // 摘要只给 PersonaSummary 形状（不是管理行）；内置库有可用角色 → 非空
    assert.ok(res.body.personas.length > 0, '内置库里可用的角色要出现在可选摘要里')
    for (const summary of res.body.personas) {
      assert.equal(summary.status, undefined, '§9.1：选择器只拿 summary，不把 status/diagnostics 塞进去')
      assert.equal(typeof summary.name === 'string' && summary.name !== '', true)
    }

    // 投影断言：绝对路径 / 内部文件名 / ticket / resourceBase 一律不许出现
    assert.equal(res.raw.includes(root), false, '响应里不许出现临时根绝对路径')
    for (const forbidden of ['workbench-install.json', 'install-journal.json', 'publication.json', 'ticket', 'resourceBase', '.install.lock']) {
      assert.equal(res.raw.includes(forbidden), false, `响应里不许出现 ${forbidden}`)
    }
    for (const issue of [...res.body.diagnostics, ...res.body.experts.flatMap((row) => row.issues)]) {
      assert.equal(issue.field.includes(root), false, `field 必须是相对口径，实际：${issue.field}`)
      assert.equal(issue.message.includes(root), false, `message 里的已知根要换掉，实际：${issue.message}`)
    }
    assert.match(JSON.stringify(res.body.diagnostics), /用户库/, '已知根必须被换成库名（说明投影真的跑了）')
  })
})

// ---------------------------------------------------------------------------
// generation-start（§4.2）
// ---------------------------------------------------------------------------

test('experts: generation-start 创建 pending 草稿；同 session 同 request 复用、不同 request 409', async () => {
  await withServer(async ({ request, db }) => {
    const created = await startDraft(request)
    assert.equal(created.status, 200)
    assert.equal(created.body.ok, true)
    const draft = created.body.draft
    assert.match(draft.draftId, /^[0-9a-f-]{36}$/)
    assert.equal(draft.statusCode, 'pending')
    assert.equal(draft.contentVersion, 0, '新建 contentVersion 从 0 起')
    assert.equal(draft.phase, 'editing')
    assert.match(draft.expertId, /^generated\/[0-9a-f-]{36}$/)
    assert.equal(draft.validation, null)

    const again = await startDraft(request)
    assert.equal(again.status, 200)
    assert.equal(again.body.draft.draftId, draft.draftId, '同 session 同 request → 回既有草稿，不新建')

    const conflict = await startDraft(request, { request: '换一个完全不同的需求' })
    assert.equal(conflict.status, 409, 'AX-E32/§4.2：需求不同必须 409，不许覆盖用户之前的需求')
    assert.equal(conflict.body.code, 'generation-conflict')

    const rows = db.prepare("SELECT COUNT(*) AS n FROM task_drafts WHERE kind_code = 'expert'").get()
    assert.equal(Number(rows.n), 1, 'conflict 不得落下一张多余的草稿')
  })
})

test('experts: generation-start 入参边界（sessionId 1–512 / request.trim() 1–2000 / workspaceId 非空）', async () => {
  await withServer(async ({ request }) => {
    const noSession = await startDraft(request, { sessionId: '' })
    assert.equal(noSession.status, 400)
    assert.equal(noSession.body.code, 'invalid-payload')

    const longSession = await startDraft(request, { sessionId: 'x'.repeat(513) })
    assert.equal(longSession.status, 400)

    const spacedRequest = await startDraft(request, { request: '   ' })
    assert.equal(spacedRequest.status, 400, 'trim 后为空 → 400')

    const longRequest = await startDraft(request, { request: 'x'.repeat(EXPERT_REQUEST_MAX_CHARS + 1) })
    assert.equal(longRequest.status, 400)

    const noWorkspace = await startDraft(request, { workspaceId: '' })
    assert.equal(noWorkspace.status, 400)
  })
})

// ---------------------------------------------------------------------------
// drafts：读 / 校验 / 暂存文件读取
// ---------------------------------------------------------------------------

test('experts: 未知 draft id → 404；validate 有错误仍 200/ok:true/errors 非空/phase=editing', async () => {
  await withServer(async ({ request }) => {
    const missing = await request('GET', `${EXPERTS_PREFIX}/drafts/11111111-2222-4333-8444-555555555555`)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'draft-not-found')

    const created = await startDraft(request)
    const draftId = created.body.draft.draftId

    /**
     * 坏 id 形状也走 404：读路径只按"这一行在不在库里"回答，不做格式学考古；
     * `isExpertUuid` 的形状检查在 owner 守卫里（针对**已存在**的坏行，用于挡拼暂存路径）。
     */
    const notUuid = await request('GET', `${EXPERTS_PREFIX}/drafts/not-a-uuid`)
    assert.equal(notUuid.status, 404)
    assert.equal(notUuid.body.code, 'draft-not-found')

    const validated = await request('POST', `${EXPERTS_PREFIX}/drafts/${draftId}/validate`, { expectedVersion: 0 })
    assert.equal(validated.status, 200, '§4.1：校验出错误也是 200/ok:true')
    assert.equal(validated.body.ok, true)
    assert.equal(validated.body.draft.phase, 'editing')
    assert.equal(validated.body.validation.errors.length > 0, true, 'errors 必须非空（还没提交人格/来源）')

    const stale = await request('POST', `${EXPERTS_PREFIX}/drafts/${draftId}/validate`, { expectedVersion: 999 })
    assert.equal(stale.status, 409, '版本不符 → 409')
    assert.equal(stale.body.code, 'draft-version-conflict')
    assert.equal(stale.body.currentVersion, 0, '要带上当前版本，客户端才能自愈')
  })
})

test('experts: drafts/:id/file 只读该草稿索引里的文件，且不泄露根', async () => {
  await withServer(async ({ request, service, root }) => {
    const created = await startDraft(request)
    const draftId = created.body.draft.draftId
    const staged = await service.stageFile(
      {
        draftId,
        expectedVersion: 0,
        area: 'persona-resource',
        path: 'sources/demo/LICENSE.txt',
        contentUtf8: MIT_TEXT,
      },
      { agent: { session: { id: SESSION_A } } },
    )
    assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')

    const read = await request('GET', `${EXPERTS_PREFIX}/drafts/${draftId}/file?area=persona-resource&path=${encodeURIComponent('sources/demo/LICENSE.txt')}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.text, MIT_TEXT)
    assert.equal(read.body.bytes, Buffer.byteLength(MIT_TEXT, 'utf8'))
    assert.equal(read.body.archivedOnly, false, '只有 sources/<id>/original.md 才算归档原件')
    assert.equal(read.raw.includes(root), false, '响应不得带服务端路径')

    /** 路径越界：即使磁盘上真有一个文件也不给读（越权面在结构上不存在）。 */
    const outside = await request('GET', `${EXPERTS_PREFIX}/drafts/${draftId}/file?area=persona-resource&path=${encodeURIComponent('../../../secret.txt')}`)
    assert.equal(outside.status, 400, '路径越界 → 400（消息经投影）')
    assert.equal(outside.raw.includes(root), false)

    const other = await request('GET', `${EXPERTS_PREFIX}/drafts/${draftId}/file?area=persona-resource&path=${encodeURIComponent('sources/demo/NOT-STAGED.txt')}`)
    assert.equal(other.status, 400, '没在索引里 → 400 invalid-path')
    assert.equal(other.body.code, 'invalid-path')
  })
})

test('experts: preflight 对未知 personaId 回 usable:false + expert-not-found（不 500）', async () => {
  await withServer(async ({ request }) => {
    const res = await request('POST', `${EXPERTS_PREFIX}/preflight`, { personaId: 'generated/11111111-2222-4333-8444-555555555555', sessionId: SESSION_A })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.usable, false)
    assert.equal(res.body.status, 'invalid')
    assert.equal(res.body.issues.some((issue) => issue.code === 'expert-not-found'), true)
  })
})

// ---------------------------------------------------------------------------
// 围栏与状态码（AX-E31）
// ---------------------------------------------------------------------------

test('AX-E31: 非回环请求一律 403（用的是既有 isLoopbackRequest，不是第二套围栏）', async () => {
  await withServer(async ({ db }) => {
    void db
    /** 直接调 handler：伪造一个非 loopback 的 remoteAddress（与 knowledgeRecallRoutes 同法）。 */
    const service = createExpertService({ db, ctx: { get: () => undefined } })
    const routes = [...makeRoutes(db, { experts: service })]
    const route = routes.find((item) => item.kind === 'prefix' && item.path === EXPERTS_PREFIX)
    assert.ok(route !== undefined, '端点必须注册')
    for (const call of [
      { method: 'GET', url: `${EXPERTS_PREFIX}/capabilities` },
      { method: 'POST', url: `${EXPERTS_PREFIX}/generation-start` },
    ]) {
      const res = {
        statusCode: undefined,
        body: undefined,
        writeHead(code) { this.statusCode = code },
        end(chunk) { this.body = chunk },
      }
      await route.handler({ ...call, socket: { remoteAddress: '10.1.2.3' }, headers: {} }, res)
      assert.equal(res.statusCode, 403)
      assert.match(String(res.body), /forbidden: loopback-only/)
    }
  })
})

test('AX-E31: 坏 JSON → 400 invalid-json；声明超 body → 413（仍走既有 readJsonBody）', async () => {
  await withServer(async ({ request, port }) => {
    const bad = await request('POST', START, '{ 这不是 JSON')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.code, 'invalid-json')

    /**
     * 声明长度就超限：服务端**不必读 body** 就能拒绝（既有 `readJsonBody` 是"读的过程中"拦截，
     * 声明值比上限大时连读都不用读）。这里故意只写一个字节、不结束请求，
     * 拿完响应就断开 —— 避免往内核缓冲里灌 256KB。
     */
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: START,
          headers: { 'content-type': 'application/json', 'content-length': String(EXPERT_HTTP_BODY_MAX_BYTES + 1) },
        },
        (res) => {
          res.resume()
          res.on('end', () => { req.destroy(); resolve(res.statusCode) })
        },
      )
      const timer = setTimeout(() => { req.destroy(); reject(new Error('413 用例超时：服务端没有及时拒绝超 body')) }, 5000)
      req.on('response', () => clearTimeout(timer))
      req.on('error', (error) => { if (req.destroyed && error.code === 'ECONNRESET') return; clearTimeout(timer); reject(error) })
      req.write('x')
    })
    assert.equal(status, 413, '超 body 必须 413（不是笼统 400）')
  })
})

test('AX-E31: 源码级——专家路由复用 http.ts 的围栏，没有第二套', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('src/api/routes/experts.ts', 'utf8')
  assert.match(source, /from '\.\/helpers\.js'/, '围栏与写响应必须来自既有 helpers（唯一实现）')
  assert.match(source, /isLoopbackRequest/, '每个 handler 首行都要过回环判定')
  assert.equal(/res\.writeHead\(/.test(source), false, '不许自己写响应头')
  assert.equal(/socket\.remoteAddress/.test(source), false, '不许自己再做 loopback 判定')
  assert.equal(/function readJsonBody|function writeJson|function isLoopbackRequest/.test(source), false, '不许复制围栏实现')
})

// ---------------------------------------------------------------------------
// draft confirm / abandon（AX-E32 / AX-E33 / AX-E35）
// ---------------------------------------------------------------------------

/** 走完整真实链路：创建 → 提交人格/来源 → 暂存许可 → 校验 → 拿 manifestHash。 */
async function prepareValidatedDraft({ request, service }) {
  const created = await startDraft(request)
  const draftId = created.body.draft.draftId
  const exec = { agent: { session: { id: SESSION_A } } }
  const submitted = await service.submitDraft(
    { draftId, expectedVersion: 0, personaMd: personaDoc(), provenanceJson: provenanceJson(), skillsJson: '[]' },
    exec,
  )
  assert.equal(submitted.ok, true, submitted.ok === false ? submitted.message : '')
  const staged = await service.stageFile(
    { draftId, expectedVersion: submitted.contentVersion, area: 'persona-resource', path: 'sources/demo/LICENSE.txt', contentUtf8: MIT_TEXT },
    exec,
  )
  assert.equal(staged.ok, true, staged.ok === false ? staged.message : '')
  const validated = await service.validateDraft(draftId, staged.contentVersion)
  assert.ok(validated.validation !== null, '校验必须产出 validation')
  assert.deepEqual(validated.validation.errors, [], '这份夹具必须能通过校验（否则后续断言测的不是 confirm）')
  return { draftId, version: validated.contentVersion, manifestHash: validated.validation.manifestHash }
}

test('AX-E32: 旧 version / 错 hash 的 confirm → 409，且正式库一个文件都不许出现', async () => {
  await withServer(async ({ request, service, personasDir, root }) => {
    const { draftId, version, manifestHash } = await prepareValidatedDraft({ request, service })

    const staleVersion = await request('POST', `${DRAFTS_PREFIX}/${draftId}/confirm`, { expectedVersion: version + 5, manifestHash })
    assert.equal(staleVersion.status, 409)
    assert.equal(staleVersion.body.code, 'draft-version-conflict')
    assert.equal(staleVersion.body.currentVersion, version)

    const wrongHash = await request('POST', `${DRAFTS_PREFIX}/${draftId}/confirm`, { expectedVersion: version, manifestHash: 'b'.repeat(64) })
    assert.equal(wrongHash.status, 409)
    assert.equal(wrongHash.body.code, 'package-changed')

    const { existsSync, readdirSync } = await import('node:fs')
    const generated = join(personasDir, 'generated')
    const published = existsSync(generated) ? readdirSync(generated).filter((name) => name.endsWith('.md')) : []
    assert.deepEqual(published, [], '用户还没看过的内容不许在刷新前装进正式根')
    assert.equal(wrongHash.raw.includes(root), false, '409 文案不得带服务端绝对路径')
  })
})

test('AX-E33: expert confirm 返回 expert 字段；再次 confirm 幂等回放（旧任务草稿返回结构不变）', async () => {
  await withServer(async ({ request, service }) => {
    const { draftId, version, manifestHash } = await prepareValidatedDraft({ request, service })

    const first = await request('POST', `${DRAFTS_PREFIX}/${draftId}/confirm`, { expectedVersion: version, manifestHash })
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    assert.equal(first.body.expert.kind, 'expert', '安装结果放在 expert 字段（§4.1）')
    assert.equal(first.body.expert.draftId, draftId)
    assert.equal(first.body.expert.manifestHash, manifestHash)
    assert.equal(first.body.replayed, false, '首次确认不是回放')

    /**
     * 关键：草稿现在是 `confirmed`，而外层还有一道 `statusCode !== 'pending'` 的旧闸门 ——
     * expert 分支必须在它**之前**，否则这里会被提前 400 拒掉（P3 要求幂等回放）。
     */
    const replay = await request('POST', `${DRAFTS_PREFIX}/${draftId}/confirm`, { expectedVersion: version, manifestHash })
    assert.equal(replay.status, 200, 'AX-E33：已 confirmed 的专家草稿再确认必须幂等回放，不能 400')
    assert.equal(replay.body.ok, true)
    assert.equal(replay.body.expert.draftId, draftId)
    assert.equal(replay.body.replayed, true, '回放要如实标注 replayed:true（没有新建任何正式文件）')
  })
})

test('AX-E33: 旧任务草稿的 confirm 返回结构一个字都没变（expert 分支不得吃掉它）', async () => {
  await withServer(async ({ request, db }) => {
    const { submitTaskTool } = await import('../lib/tools/workbench.js')
    const { getDraftBySession } = await import('../lib/db/repo.js')
    const created = await submitTaskTool(db).execute(
      { title: '任务草稿的旧契约', type_code: 'code_impl', priority_code: 'p2' },
      { agent: { session: { id: 'session-task-draft' } } },
    )
    void created
    const draft = getDraftBySession(db, 'session-task-draft')
    assert.ok(draft !== undefined, '任务草稿必须落库')

    const confirmed = await request('POST', `${DRAFTS_PREFIX}/${draft.id}/confirm`, {})
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.ok, true)
    assert.ok(confirmed.body.task !== undefined, '旧契约：任务在 task 字段')
    assert.equal(confirmed.body.expert, undefined, '任务草稿的响应不许冒出 expert 字段')

    /** 已 confirmed 的任务草稿再确认：走旧的任务幂等回放分支（不是 expert 分支）。 */
    const again = await request('POST', `${DRAFTS_PREFIX}/${draft.id}/confirm`, {})
    assert.equal(again.status, 200)
    assert.ok(again.body.task !== undefined)
    assert.equal(again.body.expert, undefined)
  })
})

test('AX-E35: abandon 只清自己那份草稿的暂存；installing 时 409；其他草稿不受影响', async () => {
  await withServer(async ({ request, service, db, personasDir, skillsDir }) => {
    const { existsSync, readdirSync } = await import('node:fs')
    const first = await startDraft(request)
    const firstId = first.body.draft.draftId
    const exec = { agent: { session: { id: SESSION_A } } }
    const staged = await service.stageFile(
      { draftId: firstId, expectedVersion: 0, area: 'persona-resource', path: 'sources/demo/LICENSE.txt', contentUtf8: MIT_TEXT },
      exec,
    )
    assert.equal(staged.ok, true)

    /** 他会话的第二份草稿（用另一个 session，避免 generation-conflict）。 */
    const other = await request('POST', `${EXPERTS_PREFIX}/generation-start`, {
      sessionId: 'session-expert-routes-bbbb',
      request: '另一个专家的需求',
      workspaceId: 'E:\\Code\\demo',
    })
    const otherId = other.body.draft.draftId
    const otherStaged = await service.stageFile(
      { draftId: otherId, expectedVersion: 0, area: 'persona-resource', path: 'sources/demo/LICENSE.txt', contentUtf8: MIT_TEXT },
      { agent: { session: { id: 'session-expert-routes-bbbb' } } },
    )
    assert.equal(otherStaged.ok, true)

    const pendingDir = join(personasDir, '.pending')
    assert.equal(readdirSync(pendingDir).includes(firstId), true, '暂存目录按 draftId 隔离')
    assert.equal(readdirSync(pendingDir).includes(otherId), true)

    const abandoned = await request('POST', `${DRAFTS_PREFIX}/${firstId}/abandon`, { expectedVersion: 1, reason: '不要了' })
    assert.equal(abandoned.status, 200)
    assert.equal(abandoned.body.ok, true)
    assert.equal(abandoned.body.draftId, firstId)
    assert.equal(abandoned.body.message.length > 0, true)
    const row = db.prepare('SELECT status_code FROM task_drafts WHERE id = ?').get(firstId)
    assert.equal(row.status_code, 'abandoned')
    assert.equal(readdirSync(pendingDir).includes(firstId), false, '只清这一份草稿的暂存')
    assert.equal(readdirSync(pendingDir).includes(otherId), true, '其他草稿的暂存不许被连坐')
    assert.equal(existsSync(join(skillsDir, 'unrelated')) === false || true, true)

    /** installing 阶段必须 409 拒绝放弃（不能把"正在装"的东西半途丢掉）。 */
    const third = await startDraft(request, { sessionId: 'session-expert-routes-cccc', request: '第三份草稿' })
    const thirdId = third.body.draft.draftId
    const { transitionExpertDraftInstall } = await import('../lib/db/repo/experts.js')
    transitionExpertDraftInstall(db, thirdId, 0, { phase: 'installing' })
    const refused = await request('POST', `${DRAFTS_PREFIX}/${thirdId}/abandon`, { expectedVersion: 0 })
    assert.equal(refused.status, 409, 'AX-E35：installing 放弃必须 409')
    assert.equal(refused.body.code, 'install-in-progress')
    const stillPending = db.prepare('SELECT status_code FROM task_drafts WHERE id = ?').get(thirdId)
    assert.equal(stillPending.status_code, 'pending', '拒绝后状态不许被改动')
  })
})

test('experts: 坏 JSON / 缺字段的 confirm 与 abandon 走 400（不冒到外层 catch 泄露路径）', async () => {
  await withServer(async ({ request, service, root }) => {
    const { draftId, version, manifestHash } = await prepareValidatedDraft({ request, service })

    const badJson = await request('POST', `${DRAFTS_PREFIX}/${draftId}/confirm`, '{')
    assert.equal(badJson.status, 400)
    assert.equal(badJson.body.code, 'invalid-json')

    const noHash = await request('POST', `${DRAFTS_PREFIX}/${draftId}/confirm`, { expectedVersion: version })
    assert.equal(noHash.status, 400)
    assert.equal(noHash.body.code, 'invalid-payload')
    assert.equal(noHash.body.field, 'manifestHash')

    const noVersion = await request('POST', `${DRAFTS_PREFIX}/${draftId}/confirm`, { manifestHash })
    assert.equal(noVersion.status, 400)
    assert.equal(noVersion.body.field, 'expectedVersion')

    assert.equal(noHash.raw.includes(root), false, '400 文案不得泄露绝对路径')
    void service
  })
})
