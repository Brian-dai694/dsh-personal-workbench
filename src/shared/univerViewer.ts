/**
 * 从 Univer 的 `/univer-api/state` 结果里挑出**最该看的那一个** Viewer 地址。
 *
 * ## 为什么必须只有一份
 * 同一个文件可能有三种可见版本：草稿（正在改）、ready（草稿已提交预览）、trunk（主线）。
 * 界面（`useUniverCsvTable`）与服务端（生成表格后回传的 `viewerUrl`）如果各挑各的，
 * 就会出现「工作台里看到的是草稿、右栏里看到的是旧版本」这种自相矛盾。
 * 所以挑选顺序写在共享模块里，两边都引它。
 *
 * ## 顺序（与 dsh-univer-rightpanel 的 viewerUrlOf 一致）
 * 1. `status === 'draft'` → `worktreeUrl`（再看 `openUrl`）
 * 2. `status === 'ready'` → `mergeUrl`（再看 `worktreeUrl`）
 * 3. 兜底 `state.viewerUrl`（trunk）
 *
 * 拿不到就返回空串 —— 调用方据此显示"表格已生成但取不到预览地址"，绝不编一个地址。
 */

interface UniverFileStateLike {
  readonly viewerUrl?: unknown
  readonly worktrees?: unknown
}

interface UniverWorktreeLike {
  readonly status?: unknown
  readonly worktreeUrl?: unknown
  readonly mergeUrl?: unknown
  readonly openUrl?: unknown
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function viewerUrlOf(state: unknown): string {
  if (typeof state !== 'object' || state === null) return ''
  const typed = state as UniverFileStateLike
  const worktrees = Array.isArray(typed.worktrees) ? typed.worktrees : []
  const items = worktrees.filter((item): item is UniverWorktreeLike => typeof item === 'object' && item !== null)
  for (const item of items) {
    if (item.status === 'draft') {
      const url = asString(item.worktreeUrl) || asString(item.openUrl)
      if (url !== '') return url
    }
  }
  for (const item of items) {
    if (item.status === 'ready') {
      const url = asString(item.mergeUrl) || asString(item.worktreeUrl)
      if (url !== '') return url
    }
  }
  return asString(typed.viewerUrl)
}

/**
 * 把 `sessionId` 附到 Viewer 地址上。
 *
 * 宿主只在 `/univer-api/state?sessionId=...` 这条路径上做 session 作用域（见
 * `stateRoute` 的 `withSessionScope`：`&sessionId=`）。服务端直接调 `fileState()`
 * 拿到的地址**不带** sessionId，所以这里补上，否则 iframe 里会因缺少会话作用域而 401。
 */
export function withUniverSession(url: string, sessionId: string): string {
  if (url === '' || sessionId.trim() === '') return url
  const query = `sessionId=${encodeURIComponent(sessionId.trim())}`
  return `${url}&${query}`
}
