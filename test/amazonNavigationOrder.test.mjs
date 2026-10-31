import assert from 'node:assert/strict'
import test from 'node:test'
import { read, stripComments } from './_clientSources.mjs'

const headerPath = 'src/client/app/WorkbenchHeader.tsx'

test('Amazon 子导航顺序固定且不渲染业务分区标题', () => {
  const source = stripComments(read(headerPath))
  const viewsStart = source.indexOf('const AD_GROUPS')
  const viewsEnd = source.indexOf('const AD_VIEWS', viewsStart)
  const nav = source.slice(viewsStart, viewsEnd)
  const labels = [...nav.matchAll(/\{ key: '([^']+)', label: '[^']+'/g)].map((m) => m[1])
  assert.deepEqual(labels, ['amazon', 'keywords', 'asin', 'reports', 'inventory', 'products', 'payments', 'oplog'])
  assert.doesNotMatch(nav, /售前|售中|售后|label:\s*'广告分析'|label:\s*'商品与经营'/)
})

test('旧 traffic 导航状态继续迁移到 reports', () => {
  const source = stripComments(read(headerPath))
  assert.match(source, /if \(saved === 'traffic'\) return 'reports'/)
})
