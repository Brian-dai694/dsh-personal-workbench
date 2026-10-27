/**
 * 运营日志导入的纯函数测试（第 1 步）。
 *
 * 守三件事：HTML 必须剥成纯文本（安全）、ASIN 去重、坏条目要计数而不是静默丢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractInlineImages, htmlToText, normalizeOplogImport } from '../lib/shared/oplogImport.js'

test('htmlToText：块级标签转换行，其余标签剥掉，实体还原', () => {
  const html = '<p>今天补货 <b>120</b> 件</p><div>库存告警：A&amp;B</div><br><p>明天再看</p>'
  const text = htmlToText(html)
  assert.equal(text.includes('<'), false, '不许残留标签')
  assert.equal(text.includes('今天补货 120 件'), true)
  assert.equal(text.includes('A&B'), true, '&amp; 要还原')
  assert.ok(text.split('\n').length >= 3, '块级标签要断行')
})

test('normalizeOplogImport：接受数组 / {logs} / 其它键包一层', () => {
  const one = [{ id: 'l1', logType: '补货', title: '补货日志', content: '<p>x</p>', createdAt: Date.parse('2026-09-30T02:25:54Z') }]
  assert.equal(normalizeOplogImport(one).entries.length, 1)
  assert.equal(normalizeOplogImport({ logs: one }).entries.length, 1)
  assert.equal(normalizeOplogImport({ entries: one }).entries.length, 1)
  assert.equal(normalizeOplogImport({ items: one }).entries.length, 1)
})

test('normalizeOplogImport：毫秒时间戳转 ISO；ASIN 去重且大写', () => {
  const result = normalizeOplogImport([{
    id: 'l2',
    logType: '广告',
    title: '调价',
    content: '',
    createdAt: Date.parse('2026-09-30T02:25:54Z'),
    asinList: [{ value: 'b0aaa11111' }, { value: 'B0AAA11111' }, { value: 'B0BBB22222' }],
  }])
  const entry = result.entries[0]
  assert.equal(entry.createdAt, '2026-09-30T02:25:54.000Z')
  assert.deepEqual(entry.asins, ['B0AAA11111', 'B0BBB22222'])
})

test('normalizeOplogImport：坏条目不静默丢，计数 + 给出第一条原因', () => {
  const result = normalizeOplogImport([
    { title: '', content: '', createdAt: 1 },
    { title: '没有时间', content: 'x' },
    { title: '正常', content: 'y', createdAt: 1 },
  ])
  assert.equal(result.entries.length, 1)
  assert.equal(result.rejected, 2)
  assert.ok(result.firstReason !== null && result.firstReason.length > 0)
})

test('normalizeOplogImport：整份文件不是数组时报错而不是返回空数组', () => {
  const result = normalizeOplogImport({ foo: 1 })
  assert.equal(result.entries.length, 0)
  assert.ok(result.firstReason?.includes('logs'))
})

test('normalizeOplogImport：附件只留元信息，不保留 dataURL', () => {
  const result = normalizeOplogImport([{
    title: '带附件',
    createdAt: 1,
    documents: [{ name: '报表.xlsx', size: '12KB', type: 'xlsx', data: 'data:application/vnd.ms-excel;base64,AAAA' }],
  }])
  const doc = result.entries[0].documents[0]
  assert.equal(doc.name, '报表.xlsx')
  assert.equal('data' in doc, false, '绝不能把 dataURL 存进库')
})

test('normalizeOplogImport：内嵌截图被抽出来，正文留 [图片]（不能丢）', () => {
  const png = 'data:image/png;base64,' + 'A'.repeat(200)
  const result = normalizeOplogImport([{
    title: '带图日志',
    createdAt: 1,
    content: '<p>先看这张图</p><img src="' + png + '"><p>结论：换标题</p>',
  }])
  const entry = result.entries[0]
  assert.equal(entry.images.length, 1, '截图必须被抽出来')
  assert.equal(entry.images[0].mime, 'image/png')
  assert.equal(entry.contentText.includes('[图片]'), true, '正文要留占位')
  assert.equal(entry.contentText.includes('先看这张图'), true, '文字不能丢')
  assert.equal(entry.contentText.includes('base64'), false, '正文不许带 dataURL')
})

test('extractInlineImages：超过单张上限的图片跳过并计数', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024)
  const result = extractInlineImages('<img src="' + huge + '">')
  assert.equal(result.images.length, 0)
  assert.equal(result.skipped, 1)
  assert.equal(result.rest.includes('[图片]'), true)
})
