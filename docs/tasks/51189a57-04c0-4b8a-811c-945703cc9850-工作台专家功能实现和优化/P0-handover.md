# P0 交接 — 固定宿主契约与施工基线

- 执行任务：`ed644638-f9a0-45cf-a32f-90df7d060dda`（工作台专家功能实现和优化）
- 执行时间：2026-10-05 11:39 +08:00
- 规格：方案 v0.3 §1、§2、§8、§10；ADR 0005 / 0006 / 0008 / 0009(proposed)
- 结论一句话：**依赖的公开 SDK 接口在本机目标环境全部存在，P1–P3 具备开工前置条件。**

## 已完成文件/导出

本批**不实现产品**，无 `src/` 改动。产出的是事实记录：

- [verification.md](verification.md) §7：目标环境事实表、SDK 契约核对表、新增约束、未验证项。
- 本文件（P0 交接）。

## 通过的断言 ID

无。P0 不承担任何 AX-E 断言（规格如此）。已执行的检查只有：

| 命令 | 退出码 | 说明 |
|---|---|---|
| `git rev-parse HEAD` | 0 | `50d85b9aeffee3a23929e32ddb44567a82e89e61` |
| `pnpm typecheck` | 0 | 基线干净（node v24.19.0 / pnpm 11.7.0） |

## 实际核对到的契约（基目录 `C:/Users/<user>/.dsh/profiles/node_modules/@deepseek-ai`，SDK `0.2.0-rc.2`）

| 契约 | 符号 | 存在 |
|---|---|---|
| 新建会话 | `sessions.create(opts?: {workspaceId?; cwd?; sessionId?}) → Promise<SessionId>` | ✅ |
| subagents | `list()` / `getProvider(name)` / `start(name, request)` | ✅ |
| spawn 能力 | `inheritsParentContext=false`、`persona/toolFilter/depthLimit=true`、name 缺省 `spawn` | ✅ |
| run | `localAgent` / `dispose()` / `result` | ✅ |
| 深度 | `delegationDepthOf(agent)` 公开导出 | ✅ |
| skills | `registerProvider(create)` 工厂 + `control.invalidate` | ✅ |
| candidate | `rank` / `resourceBase` | ✅ |
| scope | `scopeOf(ctx)`（`dsh-scope@0.2.0-rc.2`） | ✅ |
| @ 源 | `onPick` 同步、`codec.serialize(ref, signal)` 异步、`clipboardText(ref)` | ✅ |
| 引用 | `ReferenceInsert`（经 `dsh-client-ui-conversation/client` 再导出） | ✅ |

## 未验证项目与原因

- 以上全部是**源码/类型核对**，没有运行时验证（没起真实宿主、没注册 provider、没起子代理）。P0 规格如此。
- 本仓 devDependencies 没有 `dsh-skill` / `dsh-subagent` / `dsh-scope` / 客户端 UI 包 → P4/P6/P7 必须使用结构化 Probe 形状，不能 import 宿主 runtime（已记入 verification §7.3）。
- `connectWorkspace` 的 `reuseOrCreateBlank` 行为沿用设计取证，本批未复跑。
- AX-E01–E62 仍全部未做产品验收。

## 当前下一批前置条件（P1）

- ✅ P0 完成；✅ typecheck 基线 0；✅ SDK 契约不缺 → P1 可以开工。
- P1 新增：`src/shared/expert.ts`、`src/db/repo/experts.ts`、`src/experts/paths.ts`、`src/experts/provenance.ts`；
  修改：`src/shared/contracts.ts`、`src/db/seed.ts`、`src/db/repo.ts`、`src/client/settingsFallback.ts`；
  测试：`test/expertContracts.test.mjs`、`test/expertPaths.test.mjs`、`test/expertProvenance.test.mjs`（AX-E01–E06）。

## 规格偏差

无。SDK 版本、host/client inject、`SCHEMA_VERSION=19` 与 §1/§2 的取证一致。

## 没有执行的安装/发布操作

未执行 `dsh plugin add/remove`、未改 profile、未重启任何实例、未发布 npm、未打 tag。当前会话实例（19387）未被触碰。
