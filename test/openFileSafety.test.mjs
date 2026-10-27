/**
 * 「打开本地文件」端点的安全守卫（2026-10-27，批次 7a）。
 *
 * ## 为什么需要这个测试
 *
 * 旧实现的 `openLocalFile` 是：
 *
 * ```js
 * execFile('cmd', ['/c', 'start', '', filePath], { windowsVerbatimArguments: true })
 * ```
 *
 * 两个因素叠加成**命令注入**：
 * 1. `windowsVerbatimArguments: true` → Node 不转义，原样把参数拼进命令行；
 * 2. `cmd /c` 会**再次解析**整条命令行 → 路径里的 `&` `|` `>` `^` 变成命令分隔符。
 *
 * 而 `filePath` 来自知识条目的 `fileLink` —— **AI 能写**（`workbench_submit_knowledge`），
 * 所以这是可达的攻击面，不是"只有本机用户才能触发"的同用户能力问题。
 *
 * 修法只有一条：**不经过任何 shell**，命令与参数各自是独立 argv 元素。
 * 本测试把这条纪律钉死 —— 因为"哪天有人为了兼容性把 cmd 加回来"是极可能发生的回归，
 * 而它**不会**让任何现有断言变红（旧代码在所有既有测试里都是绿的）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { read, stripComments } from './_clientSources.mjs'
import { makeOpenFileRoute } from '../lib/api/openFileRoute.js'

const SOURCE = 'src/api/openFileRoute.ts'

/** 造一个 loopback 的假请求（`isLoopbackRequest` 只看 remoteAddress + host）。 */
function fakeReq(body) {
  return {
    method: 'POST',
    url: '/api/workbench/knowledge/open-file',
    headers: { host: '127.0.0.1:55773' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

function fakeRes() {
  const state = { status: 0, body: '' }
  return {
    state,
    res: {
      writeHead(status) { state.status = status },
      end(payload) { state.body = String(payload) },
    },
  }
}

async function postOpenFile(body) {
  const route = makeOpenFileRoute()
  const { state, res } = fakeRes()
  await route.handler(fakeReq(body), res)
  return { status: state.status, json: JSON.parse(state.body) }
}

test('源码守卫：open-file 不得经过任何 shell（不许 cmd / 不许 windowsVerbatimArguments）', () => {
  const code = stripComments(read(SOURCE))

  assert.doesNotMatch(
    code, /windowsVerbatimArguments/,
    'windowsVerbatimArguments 会让 Node 原样拼接命令行 —— 只有把整串命令交给 cmd 时才需要它，'
    + '而我们已经不允许经过 shell。',
  )
  assert.doesNotMatch(
    code, /['"]cmd(?:\.exe)?['"]/i,
    '不许把 cmd / cmd.exe 当可执行文件启动：cmd 会二次解析命令行，路径里的 & | > ^ 会变成命令分隔符。',
  )
  assert.doesNotMatch(
    code, /['"]\/c['"]/,
    "不许出现 cmd 的 /c：那是\"把这段字符串当命令执行\"的开关。",
  )
  assert.doesNotMatch(code, /\bshell\s*:\s*true/, '不许用 shell:true 绕过上面三条。')
})

test('源码守卫：每个启动候选都是「命令 + 独立参数」，且 Windows 不再用 cmd', () => {
  const code = stripComments(read(SOURCE))
  // 至少保留一条 Windows 启动路径（功能没被"修安全"改成不可用）
  assert.match(code, /rundll32\.exe/, 'Windows 下应使用 rundll32 的 FileProtocolHandler（无 shell）')
  assert.match(code, /pathToFileURL/, '应把本地路径转成 file:// URL 再交给 rundll32，避开参数歧义')
  // 三平台都要有兜底，不能只剩一条
  assert.match(code, /'open'/, 'macOS 用 open')
  assert.match(code, /xdg-open/, 'Linux 用 xdg-open')
})

test('行为：不存在的路径被拒（400 + ok:false），且不会去启动任何程序', async () => {
  const { status, json } = await postOpenFile({ fileLink: 'C:\\__wb_no_such_file__\\x.txt' })
  assert.equal(status, 400)
  assert.equal(json.ok, false, '统一信封：失败必须 ok:false')
  assert.equal(typeof json.error, 'string')
})

test('行为：目录被拒（400），只有普通文件才允许打开', async () => {
  const dir = process.cwd()
  const { status, json } = await postOpenFile({ fileLink: dir })
  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.match(json.error, /not a file|no such file|ENOENT|EISDIR|is not a file/i)
})

test('行为：缺少 fileLink 被拒（400），空字符串同样不行', async () => {
  for (const body of [{}, { fileLink: '' }, { fileLink: '   ' }]) {
    const { status, json } = await postOpenFile(body)
    assert.equal(status, 400, `期望 400，实际 ${status}（body=${JSON.stringify(body)}）`)
    assert.equal(json.ok, false)
  }
})
