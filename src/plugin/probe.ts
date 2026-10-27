/**
 * 宿主**可选服务**的唯一软探测实现。
 *
 * 为什么单独一个文件：装配（`ready.ts`）与命令注册（`commands.ts`）都要用它，
 * 而它是"绝不把可选服务写进 inject"这条规则的**唯一执行点**（该规则已复发 3 次事故）。
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * 软探测一个可选服务。
 *
 * **可选服务一律 `ctx.get()` 软探测，绝不放进 `inject`、绝不直接 `ctx.x`** ——
 * 这条规则是被真实事故逼出来的：cordis 的 inject 语义是"缺一个就整个插件 pending"，
 * 把 0.1.5 才有的服务写进去，旧宿主上直接 `Failed to load plugins`
 * （已复发 3 次：v1.10.1 的 uiWorkspace、v1.13.0 的 runtime.slots、v1.13.3 根治）。
 */
export function probeService<T>(ctx: unknown, name: string): T | undefined {
  const getter = (ctx as { get?: (key: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  try { return getter.call(ctx, name) as T | undefined } catch { return undefined }
}
