/**
 * 插件**入口装配**：开库 → 失败降级 / 成功交给 `ready.ts`。
 *
 * 降级路径不是可选项：`apply` 抛错会让 cordis 把整个 patch 行回滚、宿主拒绝启动、GUI 都进不去
 * （2026-09-12 真实事故：数据库比插件新）。所以"库打不开"必须是一条**可读的降级**而不是异常。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import { openWorkbenchDb, SchemaTooNewError } from '../db/database.js'
import { seedDictionaries } from '../db/seed.js'
import { applyReady } from './ready.js'
import { workbenchDbConfigFor, type Config } from './config.js'
import { SECTION_ORDER } from './prompt.js'

export function apply(ctx: Context, config: Config = {}): void {
  let db: DatabaseSync
  try {
    db = openWorkbenchDb(workbenchDbConfigFor(config))
    seedDictionaries(db)
  } catch (error) {
    applyDegraded(ctx, error, config)
    return
  }
  applyReady(ctx, db, config)
}

/**
 * 数据库打不开时的降级路径：**保证 DSH 仍然能起来**。
 *
 * 为什么必须有这条路：`apply` 抛错会让 cordis 把整个 patch 行事务组回滚，
 * 宿主直接拒绝启动、GUI 都进不去（2026-09-12 的真实事故：工作台被 pnpm 回退到
 * 1.12.1，读不了已迁到 schema 15 的库，整个 DSH 起不来）。
 * 数据库比插件新属于运维常态，不该等于宿主不可用。
 *
 * 降级语义：不注册任何路由/工具/提醒调度（数据不可信，宁可什么都不做），
 * 但**照常注册 systemPrompt 告警**——这样 AI 会话里能直接看到"工作台已停用 + 怎么修"，
 * 用户不必去翻日志。
 */
function applyDegraded(ctx: Context, error: unknown, config: Config): void {
  const detail = error instanceof SchemaTooNewError
    ? `数据库 schema 版本 ${error.dbVersion} 比当前插件支持的 ${error.supportedVersion} 新`
    : `无法打开数据库：${String(error)}`
  const notice = `[dsh-personal-workbench] 已降级为空转：${detail}。`
    + '插件本体已加载但未注册路由/工具/提醒，工作台功能不可用。'
    + '修复：把 @dely0/dsh-personal-workbench 升级到与数据库 schema 匹配的版本'
    + '（如 `dsh plugin --profile web add @dely0/dsh-personal-workbench@latest`），然后重启 dsh web。'
    + '请勿降级数据库 schema——那会丢数据语义。'
  ctx.logger?.error?.(notice)
  // 控制台兜底：logger 未必被宿主接管，而这条信息决定用户能不能自救。
  console.error(notice)
  if ((config.announceToAgent ?? true) === false) return
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:workbench',
    order: SECTION_ORDER,
    text: `本机 dsh-personal-workbench 插件当前处于**降级空转**状态，工作台功能全部不可用。`
      + `原因：${detail}。`
      + '请告知用户：升级该插件到与数据库 schema 匹配的版本后重启 dsh web 即可恢复；'
      + '不要试图降级数据库，也不要调用任何 workbench_* 工具（它们未注册）。',
  }), 'dsh-personal-workbench: degraded-prompt')
}
