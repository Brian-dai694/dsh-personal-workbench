/**
 * 选品判断 → 立项任务（v1.26）。
 *
 * 这组测试守的是三件事，都是"用户会真的踩到"的：
 * 1. **幂等**：同一 ASIN 点两下「立项」不能得到两个任务（返回 409 + 已有任务 id）；
 * 2. **判断内容进描述**：任务打开后要能看见分数/评分卡/VOC/风险/下一步，
 *    否则立项只是一个空标题，等于把判断丢了；
 * 3. **不伪造进度**：新建任务是 `todo` + 进度 0，不能顺手置成 doing。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import { createTask, findOpenTaskByAsin, getTask, importAsinProducts, listTasks, setAsinJudgment, updateTask } from '../lib/db/repo.js'

function product(asin, overrides = {}) {
  return {
    asin, site: 'US', title: `商品 ${asin}`, currentTitle: null, imageUrl: null, url: null,
    price: 39.99, currency: 'USD', rating: 4.5, reviews: 100, bsr: 2000, brand: null, seller: null,
    shopId: null, shopName: null, category: null, note: null, tags: [],
    extraJson: '{}', addedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

async function withServer(fn) {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db)
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
  if (address === null || typeof address === 'string') { server.close(); db.close(); throw new Error('no port') }
  const request = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: text === '' ? null : JSON.parse(text) }
  }
  try { await fn({ request, db }) } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
}

test('立项：建出真实任务，判断内容进描述，状态是 todo / 进度 0', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0TASK00001')], [], 0, null)
    setAsinJudgment(db, 'B0TASK00001', {
      verdict: 'do', score: 86, nextAction: '先打样',
      criteria: [{ name: '需求', value: '高' }], painPoints: [{ label: '不透气', count: 7 }],
      risk: { level: 'medium', note: '近似商标一件' }, keywordCount: 42, source: 'manual',
    })

    const created = await request('POST', '/api/workbench/asin/B0TASK00001/task')
    assert.equal(created.status, 200)
    assert.match(created.body.title, /^选品立项：/)
    const task = getTask(db, created.body.taskId)
    assert.ok(task !== undefined)
    assert.equal(task.statusCode, 'todo')
    assert.equal(task.progressPercent, 0)
    assert.equal(task.source, 'asin-library')
    assert.equal(task.extra.asin, 'B0TASK00001')
    assert.equal(task.extra.verdict, 'do')

    // 描述里必须能看见判断内容（否则立项只剩标题）
    assert.match(task.description, /B0TASK00001/)
    assert.match(task.description, /选品结论：do · 评分 86/)
    assert.match(task.description, /下一步：先打样/)
    assert.match(task.description, /评分卡：需求 高/)
    assert.match(task.description, /VOC 痛点：不透气（7）/)
    assert.match(task.description, /商标\/合规风险：medium · 近似商标一件/)
    assert.match(task.description, /\$39\.99/)
  })
})

test('立项幂等：同 ASIN 第二次 409 并给出现有任务 id；完成后可再立一次', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0TASK00002')], [], 0, null)
    setAsinJudgment(db, 'B0TASK00002', { verdict: 'watch', score: 50, source: 'manual' })

    const first = await request('POST', '/api/workbench/asin/B0TASK00002/task')
    assert.equal(first.status, 200)
    const second = await request('POST', '/api/workbench/asin/B0TASK00002/task')
    assert.equal(second.status, 409, '重复点立项不能建出第二个任务')
    assert.equal(second.body.existingTaskId, first.body.taskId)
    assert.equal(listTasks(db).length, 1)

    // 第一个任务完成后允许再立（第二轮做同一个品是正常的）
    updateTask(db, first.body.taskId, { statusCode: 'done' })
    assert.equal(findOpenTaskByAsin(db, 'B0TASK00002'), undefined)
    const third = await request('POST', '/api/workbench/asin/B0TASK00002/task')
    assert.equal(third.status, 200)
    assert.notEqual(third.body.taskId, first.body.taskId)
    assert.equal(listTasks(db).length, 2)
  })
})

test('立项边界：未知 ASIN 404；ASIN 大小写不敏感；别的手工任务不会被误判成同一 ASIN', async () => {
  await withServer(async ({ request, db }) => {
    assert.equal((await request('POST', '/api/workbench/asin/B0NOTEXIST/task')).status, 404)

    importAsinProducts(db, [product('B0TASK00003')], [], 0, null)
    // 一条描述里带 ASIN 但 extra 没有锚点的普通任务，不该挡住立项
    createTask(db, { title: '手工写的关于 B0TASK00003 的任务', typeCode: 'personal', priorityCode: 'p2' })
    assert.equal(findOpenTaskByAsin(db, 'B0TASK00003'), undefined, '只认 extra.asin，不靠标题/描述猜')

    const lower = await request('POST', '/api/workbench/asin/b0task00003/task')
    assert.equal(lower.status, 200)
    assert.equal(findOpenTaskByAsin(db, 'B0TASK00003')?.id, lower.body.taskId, '小写 ASIN 也归一到同一条')
  })
})

test('立项参数可选：类型/优先级/标题按传入生效，非法 code 被字典拒（400）', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0TASK00009')], [], 0, null)
    setAsinJudgment(db, 'B0TASK00009', { verdict: 'do', score: 70, source: 'manual' })

    const custom = await request('POST', '/api/workbench/asin/B0TASK00009/task', {
      title: '自定义标题：先算模具费', typeCode: 'project_delivery', priorityCode: 'p1',
    })
    assert.equal(custom.status, 200)
    assert.equal(custom.body.title, '自定义标题：先算模具费')
    const task = getTask(db, custom.body.taskId)
    assert.equal(task.typeCode, 'project_delivery')
    assert.equal(task.priorityCode, 'p1')
    // 描述里仍然带判断内容（改标题不该丢掉证据）
    assert.match(task.description, /B0TASK00009/)
  })
})

test('立项参数：字典里不存在或已停用的 code 被拒，且不留下半成品任务', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0TASK00010')], [], 0, null)
    setAsinJudgment(db, 'B0TASK00010', { verdict: 'do', source: 'manual' })
    const before = listTasks(db).length

    const badType = await request('POST', '/api/workbench/asin/B0TASK00010/task', { typeCode: '与选品无关的类型' })
    assert.equal(badType.status, 400)
    assert.match(badType.body.error, /typeCode/)

    const badPriority = await request('POST', '/api/workbench/asin/B0TASK00010/task', { priorityCode: 'p9' })
    assert.equal(badPriority.status, 400)
    assert.match(badPriority.body.error, /priorityCode/)

    assert.equal(listTasks(db).length, before, '校验失败不能留下任务')
  })
})

test('列表接口下发类型/优先级候选（界面不硬编码 code）', async () => {
  await withServer(async ({ request }) => {
    const list = await request('GET', '/api/workbench/asin')
    assert.equal(list.status, 200)
    assert.ok(Array.isArray(list.body.taskTypes) && list.body.taskTypes.length > 0)
    assert.ok(Array.isArray(list.body.taskPriorities) && list.body.taskPriorities.length > 0)
    assert.ok(list.body.taskTypes.every((item) => typeof item.code === 'string' && typeof item.name === 'string'))
  })
})

test('参数校验先于幂等：已有任务时传非法类型，必须报类型错而不是"已有任务"', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0TASK00011')], [], 0, null)
    setAsinJudgment(db, 'B0TASK00011', { verdict: 'do', source: 'manual' })
    assert.equal((await request('POST', '/api/workbench/asin/B0TASK00011/task')).status, 200)

    // 现在已有未完成任务；这一步校验必须排在幂等判断之前，否则错误会被 409 盖住
    const bad = await request('POST', '/api/workbench/asin/B0TASK00011/task', { typeCode: '不存在类型' })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /typeCode/)
  })
})

test('截止时间：传入则落库并按类型/优先级补提醒；非法时间 400', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0DUE000001')], [], 0, null)
    setAsinJudgment(db, 'B0DUE000001', { verdict: 'do', source: 'manual' })
    const due = new Date('2026-11-02T10:00:00.000Z')
    const created = await request('POST', '/api/workbench/asin/B0DUE000001/task', { dueAt: due.toISOString(), priorityCode: 'p1' })
    assert.equal(created.status, 200)
    const task = getTask(db, created.body.taskId)
    assert.equal(task.dueAt, due.toISOString())
    assert.equal(task.priorityCode, 'p1')
    // 提醒：按类型/优先级默认值补一条（口径与 POST /tasks 一致）
    const reminders = db.prepare('SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ?').get(task.id).n
    assert.equal(reminders, 1, '有截止时间就应该按默认提前量加一条提醒')

    importAsinProducts(db, [product('B0DUE000002')], [], 0, null)
    const bad = await request('POST', '/api/workbench/asin/B0DUE000002/task', { dueAt: '不是时间' })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /dueAt/)
  })
})

test('判断回写闭环：立项任务完成后，商品备注追加一条事实（幂等、不改判断）', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0WB000001')], [], 0, null)
    setAsinJudgment(db, 'B0WB000001', { verdict: 'do', score: 71, nextAction: '先打样', source: 'manual' })
    const created = await request('POST', '/api/workbench/asin/B0WB000001/task')
    assert.equal(created.status, 200)

    // 验收通过那条路径（completeTaskCascade）
    const accepted = await request('POST', `/api/workbench/tasks/${created.body.taskId}/archive`)
    assert.equal(accepted.status, 200)

    const noteOf = () => db.prepare('SELECT note FROM asin_products WHERE asin = ?').get('B0WB000001').note
    // 归档不等于完成，这里不该有回写
    assert.equal(noteOf(), null, '归档不是完成，不应回写')

    // 真正完成：走 PATCH statusCode=done（updateTaskWithCompletion）
    const done = await request('PATCH', `/api/workbench/tasks/${created.body.taskId}`, { statusCode: 'done' })
    assert.equal(done.status, 200)
    const note = noteOf()
    assert.ok(note !== null && note.includes('[立项完成'), '完成后应回写一条事实')
    assert.ok(note.includes(created.body.taskId), '回写要带任务 id 便于追溯')
    // 判断本身不许被改（机器不替人下结论）
    const jug = db.prepare('SELECT verdict, score, judgment_json FROM asin_products WHERE asin = ?').get('B0WB000001')
    assert.equal(jug.verdict, 'do')
    assert.equal(jug.score, 71)
    assert.match(jug.judgment_json, /先打样/)

    // 幂等：再完成一次不重复追加
    const before = noteOf()
    await request('PATCH', `/api/workbench/tasks/${created.body.taskId}`, { statusCode: 'done' })
    assert.equal(noteOf(), before, '重复完成不能重复写备注')
  })
})

test('判断回写：普通任务（无 ASIN 锚点）完成时不碰选品库', async () => {
  await withServer(async ({ request, db }) => {
    importAsinProducts(db, [product('B0WB000002')], [], 0, null)
    const plain = createTask(db, { title: '普通任务', typeCode: 'personal', priorityCode: 'p2' })
    const done = await request('PATCH', `/api/workbench/tasks/${plain.id}`, { statusCode: 'done' })
    assert.equal(done.status, 200)
    const note = db.prepare('SELECT note FROM asin_products WHERE asin = ?').get('B0WB000002').note
    assert.equal(note, null)
  })
})
