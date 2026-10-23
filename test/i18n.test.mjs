/**
 * issue #12：界面语言的纯逻辑测试（不渲染 React、不碰 DOM）。
 *
 * 这里钉住三件会静默出错的事：
 * 1. `auto` 的解析方向（非中文浏览器 → 英文；缺省 → 中文）；
 * 2. 未翻译 key 必须原样返回中文，不能变成空白或 `undefined`；
 * 3. 数字格式化必须跟随 locale，不能继续写死 `'zh-CN'`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  EN_MESSAGES, formatCount, isUiLocale, normalizeUiLocale, resolveLocale, translate, UI_LOCALES,
} from '../lib/shared/i18n.js'

test('uiLocale 归一：只认三个合法值，其余回 auto', () => {
  assert.deepEqual(UI_LOCALES, ['auto', 'zh-CN', 'en-US'])
  assert.equal(normalizeUiLocale('en-US'), 'en-US')
  assert.equal(normalizeUiLocale('zh-CN'), 'zh-CN')
  assert.equal(normalizeUiLocale('auto'), 'auto')
  assert.equal(normalizeUiLocale('fr-FR'), 'auto')
  assert.equal(normalizeUiLocale(undefined), 'auto')
  assert.equal(isUiLocale('en-US'), true)
  assert.equal(isUiLocale('fr-FR'), false)
})

test('auto 跟随浏览器语言：zh* → 中文，其它 → 英文，缺失 → 中文', () => {
  assert.equal(resolveLocale('auto', 'zh-CN'), 'zh-CN')
  assert.equal(resolveLocale('auto', 'zh-Hans-CN'), 'zh-CN')
  assert.equal(resolveLocale('auto', 'en-US'), 'en-US')
  assert.equal(resolveLocale('auto', 'fr-FR'), 'en-US')
  assert.equal(resolveLocale('auto', ''), 'zh-CN')
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN', '显式选择优先于浏览器')
  assert.equal(resolveLocale('en-US', 'zh-CN'), 'en-US', '显式选择优先于浏览器')
  assert.equal(resolveLocale('胡说', 'en-US'), 'en-US', '脏值按 auto 处理')
})

test('translate：中文原样 + 占位替换；英文查表；未翻译回中文（不是空串）', () => {
  assert.equal(translate('zh-CN', '共 {n} 条', { n: 3 }), '共 3 条')
  assert.equal(translate('en-US', '未收录的文案 {n}', { n: 3 }), '未收录的文案 3', '未收录的 key 保留中文，避免出现空 UI')
  assert.equal(translate('en-US', '今日'), 'Today')
  assert.equal(translate('en-US', '可用 {available}｜★ 已收藏 {favorites}｜停用 {disabled}', { available: 15, favorites: 4, disabled: 0 }), 'Available 15 | ★ Favorites 4 | Disabled 0')
  assert.equal(translate('en-US', '搜索专家名 / 简介 / 分组（共 {n} 个）', { n: 16 }), 'Search experts by name / description / group (16 total)')
  // 缺参数时保留占位符，便于发现漏传（不静默吞掉）
  assert.equal(translate('zh-CN', '共 {n} 条'), '共 {n} 条')
})

test('formatCount：跟随 locale（英文用千分位，中文也用 Intl）', () => {
  assert.equal(formatCount('en-US', 1234567), '1,234,567')
  assert.equal(formatCount('zh-CN', 1234567), '1,234,567')
  assert.equal(formatCount('en-US', Number.NaN), 'NaN')
})

test('英文表覆盖顶层 chrome 与专家 UI 的关键文案（不是空表）', () => {
  const required = [
    '个人工作台', '今日', '日历', '任务', '知识库', '点子', '快速录入', '设置', '返回对话',
    '角色库', '新建专家', '查看草稿', '继续修改', '确认安装专家', '开始生成', '打开生成会话',
    '待确认：新建专家', '放弃这份草稿', '来源已登记',
  ]
  for (const key of required) {
    assert.equal(typeof EN_MESSAGES[key], 'string', `缺少英文翻译：${key}`)
    assert.notEqual(EN_MESSAGES[key].trim(), '', `英文翻译为空：${key}`)
  }
})

test('设置路由持久化 uiLocale：合法值写库、脏值不写，GET 与 POST 响应同形', async () => {
  const db = openWorkbenchDb({ dbPath: ':memory:' })
  seedDictionaries(db)
  const routes = makeRoutes(db, {})
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      if (route.kind === 'exact' && url.pathname === route.path) return route.handler(req, res)
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  try {
    const initial = await request('GET', '/api/workbench/settings')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.settings.uiLocale, 'auto', '缺省 auto')

    const written = await request('POST', '/api/workbench/settings', { uiLocale: 'en-US' })
    assert.equal(written.status, 200)
    assert.equal(written.body.settings.uiLocale, 'en-US', 'POST 响应直接回显落库值')

    const reread = await request('GET', '/api/workbench/settings')
    assert.equal(reread.body.settings.uiLocale, 'en-US', 'GET 读回同一个值')

    const dirty = await request('POST', '/api/workbench/settings', { uiLocale: 'fr-FR' })
    assert.equal(dirty.body.settings.uiLocale, 'en-US', '脏值不被写入，也不会把已有值冲掉')

    const back = await request('POST', '/api/workbench/settings', { uiLocale: 'auto' })
    assert.equal(back.body.settings.uiLocale, 'auto')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
})

