/**
 * dsh-personal-workbench — host half 入口。
 *
 * 这个文件只做**对外表面**：
 * - 插件元信息（`name` / `inject`）
 * - `apply`（装配）与 `workbenchCommandDefinition`（单测直接驱动的命令语义）
 *
 * 装配细节在 `plugin/`：apply（开库/降级）· ready（完整装配）· commands（两个斜杠命令）·
 * prompt（提示词常量）· probe（可选服务软探测）· config（配置项）。
 */
export const name = 'personal-workbench'

/**
 * 插件依赖。
 *
 * `commands`（v1.15.1，`/workbench` 斜杠命令）是**必需前置**：
 * 命令注册没有它根本不成立；而 `@deepseek-ai/dsh-commands` 从 `0.1.5-rc.1`
 * （= 本仓 `MIN_HOST_VERSION`）起就有，所以放进 `inject` 不会把支持范围内的宿主挡在外面。
 *
 * ⚠️ 与它相对的是 `llm`（模型输入能力查询）：那是**可选增强**，
 * 一律 `ctx.get` 软探测，**绝不放进 inject**（缺了只是少一条"这个模型不收图"的提前提示）。
 *
 * 可选服务一律 `ctx.get()` 软探测，绝不写进 inject、绝不直接 `ctx.x` ——
 * 这条规则是被真实事故逼出来的：cordis 的 inject 语义是"缺一个就整个插件 pending"，
 * 把 0.1.5 才有的服务写进去，旧宿主上直接 `Failed to load plugins`
 * （已复发 3 次：v1.10.1 的 uiWorkspace、v1.13.0 的 runtime.slots、v1.13.3 根治）。
 * 软探测的唯一实现在 `plugin/probe.ts`。
 */
export const inject = ['webServer', 'systemPrompt', 'tools', 'commands']

export { apply } from './plugin/apply.js'
export { workbenchCommandDefinition } from './plugin/commands.js'
export type { Config } from './plugin/config.js'
