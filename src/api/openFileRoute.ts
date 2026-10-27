/**
 * 知识库“打开本地文件”路由。
 * 独立成文件是为了在热重载时能作为新模块被重新加载（routes.ts 会被 ESM 缓存，
 * 新增/修复路由无法通过 dev_reload_package 立即生效）。
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { assertValidFileLink } from '../db/repo.js'
import { apiError, apiOk, isLoopbackRequest, readJsonBody } from './http.js'

function fileLinkToPath(link: string): string {
  const trimmed = link.trim()
  if (/^file:/i.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.protocol !== 'file:') throw new Error('not a file URL')
    let pathname = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1)
    return pathname
  }
  return trimmed
}

function toNativePath(link: string): string {
  let path = fileLinkToPath(link)
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(path)) {
    const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(path)
    if (match !== null) {
      const drive = match[1].toLowerCase()
      const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
      path = rest === '' ? `/mnt/${drive}` : `/mnt/${drive}/${rest}`
    }
  }
  return path
}

function wslPathToWindowsPath(filePath: string): string {
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(filePath)
  if (match === null) return filePath
  const drive = match[1].toUpperCase()
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return rest === '' ? `${drive}:\\` : `${drive}:\\${rest}`
}

function tryOpen(candidates: Array<{ command: string; args: string[] }>): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0
    const errors: unknown[] = []
    const attempt = (): void => {
      if (index >= candidates.length) {
        reject(new AggregateError(errors, `无法打开文件：所有打开命令均失败（${errors.map((e) => e instanceof Error ? e.message : String(e)).join('; ')}）`))
        return
      }
      const { command, args } = candidates[index++]
      /**
       * ⚠️ **不要**再加 `windowsVerbatimArguments`（2026-10-27 批次 7a 已删）。
       *
       * 它是旧实现里命令行注入的一半成因：`windowsVerbatimArguments: true` 让 Node
       * **原样拼接**命令行、不加任何引号。只有需要把一整串命令交给 `cmd /c` 时才该用它 ——
       * 而我们现在的每个启动方式都是「可执行文件 + 独立 argv 元素」，不需要也不允许 verbatim。
       */
      execFile(command, args, (error) => {
        if (error) { errors.push(error); attempt() } else resolve()
      })
    }
    attempt()
  })
}

/**
 * 用系统默认程序打开一个本地文件。
 *
 * ## 为什么这里一行 `cmd` 都不能有（真实注入面，不是洁癖）
 *
 * 旧实现：`execFile('cmd', ['/c', 'start', '', filePath], { windowsVerbatimArguments: true })`。
 * 两个因素叠加成**命令注入**：
 *
 * 1. `windowsVerbatimArguments: true` → Node 不转义、原样把参数拼进命令行；
 * 2. `cmd /c` 会**再次解析**整条命令行 → 路径里的 `&` `|` `>` `^` 都成了命令分隔符。
 *
 * 于是 `fileLink = 'C:\\a.txt & calc.exe'` 就能拉起任意进程。
 * 这条输入来自知识条目的 `fileLink` —— **AI 能写**（`workbench_submit_knowledge`），
 * 所以它是可达的攻击面，不是"只有本机用户才能触发"。
 *
 * 现在改成不经过任何 shell 的启动方式：命令与参数都是独立 argv 元素，
 * 操作系统不会对参数做二次解析。这是本函数唯一正确的写法 ——
 * 以后想加新平台，也请遵守"不经过 shell"这一条。
 */
function openLocalFile(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    /**
     * `rundll32 url.dll,FileProtocolHandler` 是"用默认关联程序打开"的标准无 shell 方式；
     * 传 `file://` URL 而不是裸路径，避开参数里可能的 `%` 之类歧义。
     *
     * 兜底用 `explorer.exe <path>`（同样无 shell）。注意它成功时也可能返回非 0，
     * 所以它排在第二位：正常情况下第一条就成功，走不到这里。
     */
    return tryOpen([
      { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', pathToFileURL(filePath).href] },
      { command: 'explorer.exe', args: [filePath] },
    ])
  }
  if (process.platform === 'darwin') {
    return tryOpen([{ command: 'open', args: [filePath] }])
  }
  const winPath = wslPathToWindowsPath(filePath)
  const candidates: Array<{ command: string; args: string[] }> = []
  if (winPath !== filePath) {
    /**
     * WSL 下的 Windows 路径：**只保留 explorer.exe**，删掉原来的 `cmd.exe /c start`。
     * 那条腿在 WSL 里同样要经过 cmd 解析（同一个注入面），而 `wslview` 已能覆盖这个场景。
     */
    candidates.push({ command: 'explorer.exe', args: [winPath] })
  }
  candidates.push({ command: 'wslview', args: [filePath] })
  candidates.push({ command: 'xdg-open', args: [filePath] })
  candidates.push({ command: 'gio', args: ['open', filePath] })
  return tryOpen(candidates)
}

export function makeOpenFileRoute(): WebRoute {
  return {
    kind: 'exact',
    path: '/api/workbench/knowledge/open-file',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return apiError(res, 403, 'forbidden: loopback-only')
      if ((req.method ?? 'GET') !== 'POST') return apiError(res, 405, 'method not allowed')
      const body = await readJsonBody(req)
      if (body === undefined) return apiError(res, 400, 'invalid JSON body')
      const raw = typeof body.fileLink === 'string' ? body.fileLink : typeof body.path === 'string' ? body.path : undefined
      if (raw === undefined || raw.trim() === '') return apiError(res, 400, 'fileLink is required')
      try {
        const fileLink = assertValidFileLink(raw)
        if (fileLink === null) return apiError(res, 400, 'fileLink is required')
        const filePath = toNativePath(fileLink)
        /**
         * 存在性校验**在启动之前**（原有行为，保留）：必须是已存在的**普通文件**。
         * 这一条挡住的是"打不开的东西"；挡住注入的是下面 `openLocalFile` 里
         * "绝不经过 shell" 那条纪律 —— 两件事不要混为一谈。
         */
        const info = await stat(filePath)
        if (!info.isFile()) return apiError(res, 400, 'path is not a file')
        await openLocalFile(filePath)
        return apiOk(res, { path: filePath })
      } catch (error) {
        return apiError(res, 400, error instanceof Error ? error.message : String(error))
      }
    },
  }
}
