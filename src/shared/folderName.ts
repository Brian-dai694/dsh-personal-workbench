/**
 * 目录名清洗的唯一实现（原 `client/format.ts` 的 `folderForText`）。
 *
 * 为什么挪到 `shared/`：宿主侧 `index.ts`（`/workbench` 命令）与 `shared/taskFolder.ts`
 * 都要用它算任务资料夹名，而它原先住在浏览器目录里 —— 服务端 import `client/` 是
 * 编译容器边界的破口（架构规则 R2：宿主不得依赖浏览器目录）。
 *
 * ⚠️ 口径已冻结：这是 v1.15.0 及以前"按标题建目录"的**逐字产物**，
 * `taskFolder.ts` 的 `legacyTitleFolderNames()` 靠它判定历史自动路径。
 * 改清洗规则 = 改历史路径判据（会漏迁或误迁用户目录），不是纯重构。
 */

/** 标题 → 目录名：去非法字符、折叠空白、截 24 字；空标题回退「未命名任务」。 */
export const folderForText = (text: string): string => {
  const cleaned = text.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 24).trim()
  return cleaned === '' ? '未命名任务' : cleaned
}