/**
 * 包装/外箱尺寸记录：落库、校验、HTTP 往返，以及「面板把它做成一等可载入记录」的接线。
 *
 * 为什么这些判据值得存在：
 * 1. 记录必须**落在数据库**里（换机器/重装浏览器仍在），而不是 localStorage；
 * 2. 非法尺寸**不能静默写进去**（看起来保存成功、算出来却是另一份尺寸）；
 * 3. 载入一条记录后必须同时还原包裹与外箱两侧，否则「包裹是新值、外箱是旧值」；
 * 4. Univer 只负责表格外壳，合并由用户在 Viewer 确认 —— 界面不得声称已写回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { makeRoutes } from '../lib/api/routes.js'
import {
  createPackagingDimension, deletePackagingDimension, listPackagingDimensions, updatePackagingDimension,
} from '../lib/db/repo.js'

const DATA = {
  packageLength: 15, packageWidth: 12, packageHeight: 8, packageWeight: 2, quantity: 1,
  sizeUnit: 'in', weightUnit: 'lb',
  cartonLength: 24, cartonWidth: 18, cartonHeight: 12,
}

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-pkg-'))
  const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
  /** 必须 await：异步用例里同步 finally 会先关库、删目录，用例跑到一半就没数据库可用。 */
  const finish = () => {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  let outcome
  try { outcome = run(db) } catch (error) { finish(); throw error }
  if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
    return outcome.finally(finish)
  }
  finish()
  return outcome
}

function listen(db) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of makeRoutes(db)) {
      if (route.kind === 'prefix' ? url.pathname === route.path || url.pathname.startsWith(`${route.path}/`) : url.pathname === route.path) {
        void route.handler(req, res)
        return
      }
    }
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('尺寸记录落库：创建 / 列出 / 更新 / 删除', () => {
  withDb((db) => {
    const created = createPackagingDimension(db, { name: ' YB2301-1 标准包装 ', sku: 'yb2301', data: DATA })
    assert.equal(created.name, 'YB2301-1 标准包装', '名称去首尾空白')
    assert.equal(created.sku, 'yb2301')
    assert.deepEqual(created.data, DATA)

    const listed = listPackagingDimensions(db)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, created.id)

    const updated = updatePackagingDimension(db, created.id, { name: 'YB2301-1 加厚', sku: 'yb2301', data: { ...DATA, cartonHeight: 14 } })
    assert.equal(updated.name, 'YB2301-1 加厚')
    assert.equal(updated.data.cartonHeight, 14)

    assert.equal(deletePackagingDimension(db, created.id), true)
    assert.equal(listPackagingDimensions(db).length, 0)
    assert.equal(deletePackagingDimension(db, created.id), false, '重复删除返回 false，不抛')
  })
})

test('非法尺寸不落库：空名称、负数、非数字、单位非法都拒绝', () => {
  withDb((db) => {
    assert.throws(() => createPackagingDimension(db, { name: '   ', data: DATA }), /名称/)
    assert.throws(() => createPackagingDimension(db, { name: 'A', data: { ...DATA, packageLength: -1 } }), /非负/)
    assert.throws(() => createPackagingDimension(db, { name: 'A', data: { ...DATA, packageWeight: Number.NaN } }), /非负/)
    assert.throws(() => createPackagingDimension(db, { name: 'A', data: { ...DATA, sizeUnit: 'ft' } }), /单位/)
    assert.equal(listPackagingDimensions(db).length, 0, '被拒绝的记录一条都不许进去')
  })
})

test('HTTP 往返：POST 保存、GET 列表、PUT 覆盖、DELETE 删除', async () => {
  await withDb(async (db) => {    const { server, port } = await listen(db)
    const base = `http://127.0.0.1:${port}/api/workbench/amazon/packaging-dimensions`
    try {
      const post = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'PT31 包装', sku: 'PT31', data: DATA }),
      })
      assert.equal(post.status, 200)
      const created = (await post.json()).record
      assert.equal(created.sku, 'PT31')

      const list = await (await fetch(base)).json()
      assert.equal(list.records.length, 1)

      const put = await fetch(`${base}/${created.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'PT31 包装 v2', sku: 'PT31', data: { ...DATA, quantity: 2 } }),
      })
      assert.equal((await put.json()).record.data.quantity, 2)

      const del = await fetch(`${base}/${created.id}`, { method: 'DELETE' })
      assert.equal(del.status, 200)
      assert.equal((await (await fetch(base)).json()).records.length, 0)

      const bad = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '', data: DATA }),
      })
      assert.equal(bad.status, 400, '空名称必须是 400，不能默默创建一条无名记录')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('面板接线：记录可载入且同时还原包裹与外箱两侧，Univer 只是外壳', () => {
  const view = readFileSync(new URL('../src/client/views/AmazonToolsView.tsx', import.meta.url), 'utf8')
  assert.match(view, /<PackagingRecordsPanel/)
  assert.match(view, /setPackageInput\(\{[\s\S]*?setCartonOuter\(/)
  assert.match(view, /record\.data\.cartonLength/, '外箱三边必须从记录还原')
  assert.match(view, /尺寸记录（\{packaging\.records\.length\}）/)
  assert.match(view, /openTable\(/)
  assert.match(view, /是否写回工作区文件由你在 Viewer 里确认/, '不得声称工作台已写入 Univer 正式文件')
  assert.doesNotMatch(view, /已写入 Univer|已保存到 Univer/)
})

test('保存不会静默失败：名称留空自动命名，成功/失败都有明确文案与条数', () => {
  const view = readFileSync(new URL('../src/client/views/AmazonToolsView.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('../src/client/hooks/usePackagingDimensions.ts', import.meta.url), 'utf8')
  assert.match(view, /function autoName\(\): string/, '留空要能自动命名，不能点了没反应')
  assert.match(view, /name\.trim\(\) === '' \? autoName\(\) : name\.trim\(\)/)
  assert.match(view, /已保存「\$\{finalName\}」· 共 \$\{result\.total\} 条/, '成功要说清存了什么、共几条')
  assert.match(view, /保存失败：原因见下方错误提示/)
  assert.match(view, /共 \$\{packaging\.records\.length\} 条/, '空闲时显示总条数')
  assert.match(hook, /return \{ ok: true, total: list\.length \}/, '条数取刷新后的真实列表，不拿旧 state 猜')
  assert.match(hook, /alive\.current = true/, '重挂载要复位存活标记，否则列表永远不更新')
})

test('尺寸记录面板样式：三列表单对齐到底线，窄容器退成单列', () => {
  const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  assert.match(styles, /\.wb-pkg-records-form \{[^}]*grid-template-columns: minmax\(0, 1\.4fr\) minmax\(0, 1fr\) auto;[^}]*align-items: end;/s)
  assert.match(styles, /\.wb-pkg-records-search \{[^}]*flex: 0 1 260px;/s)
  assert.match(styles, /@container wb-calc \(max-width: 560px\) \{\s*\.wb-pkg-records-form \{ grid-template-columns: minmax\(0, 1fr\); \}/s)
})

test('装配层把尺寸记录域下发到亚马逊页', () => {
  const assembly = readFileSync(new URL('../src/client/app/assembly.ts', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const body = readFileSync(new URL('../src/client/app/WorkbenchBody.tsx', import.meta.url), 'utf8')
  assert.match(assembly, /packagingDimensions: ReturnType<typeof usePackagingDimensions>/)
  assert.match(index, /const packagingDimensions = usePackagingDimensions\(\)/)
  assert.match(index, /packagingDimensions,/)
  assert.match(body, /packaging=\{props\.packagingDimensions\}/)
})
