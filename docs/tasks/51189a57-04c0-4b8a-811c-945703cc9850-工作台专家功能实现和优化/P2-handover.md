# P2 交接 — 草稿提交、分文件暂存与整包校验

- 批次：P2（施工计划 `implementation-plan.md` 第 72–106 行；规格 `方案-v0.3.md` §3–§5、§6.1、§7.2）
- 执行：子代理施工 → 主会话独立复跑 + 逐文件复核 → 本文件
- 时点：2026-10-05，基线 HEAD `a63b6cb`（P1 提交）；本批未提交前工作树见 §10
- 结论：`typecheck=0 build=0 p2=0`，AX-E07–E14 全部 ✅；**未接线部分如实列在 §7**

## 已完成文件/导出

### 新增（2 源 + 2 测试）

| 文件 | 规模 | 内容 |
|---|---|---|
| `src/experts/skill-package.ts` | 524 行 / 23184 B | SKILL.md frontmatter 解析、skill 包校验、包哈希 |
| `src/experts/drafts.ts` | 1385 行 / 59536 B | owner 守卫、submit、stage/remove/read 暂存文件、validate |
| `test/expertDrafts.test.mjs` | 1663 行 / 30 个 `test()` | AX-E07–E13 + P2 步骤 3–9 的负例与真实 FS/DB 断言 |
| `test/expertSkillPackage.test.mjs` | 445 行 / 20 个 `test()` | AX-E14 + AX-E12 的 skill 包分支 |

### 修改（3，均为配置/清单，无产品代码改动）

| 文件 | 改动 |
|---|---|
| `package.json` | `dependencies` 加 `"yaml": "2.9.1"`（`git diff` 仅此一处；pnpm 顺带重排 devDependencies 已被实施者恢复 HEAD 原顺序） |
| `pnpm-lock.yaml` | +10 行：importer `yaml: specifier 2.9.1 / version 2.9.1`、`yaml@2.9.1` 包条目、snapshot |
| `tsconfig.build.json` | include 增 `src/experts/skill-package.ts`、`src/experts/drafts.ts`（否则 `node --test` import `lib/**` 会 ERR_MODULE_NOT_FOUND） |

**P1 文件零改动**：`src/shared/expert.ts`、`src/experts/paths.ts`、`src/experts/provenance.ts`、`src/db/repo/experts.ts`、`src/db/repo.ts`、`src/tools.ts`、`src/api/routes.ts` 全部未动（`git status` 可证）。

### 新导出签名（原文）

```ts
// src/experts/skill-package.ts
export function parseWorkbenchSkill(raw: string, field: string = 'SKILL.md'): WorkbenchSkillParseResult
export function hashSkillPackage(input: HashWorkbenchSkillInput): string
export function validateWorkbenchSkillPackage(input: ValidateWorkbenchSkillPackageInput): ValidateWorkbenchSkillPackageResult

// src/experts/drafts.ts
export function assertExpertDraftOwner(context: ExpertDraftContext, input: ExpertDraftOwnerInput): ExpertOwnedDraft
export function submitExpertDraft(context: ExpertDraftContext, input: ExpertSubmitInput): ExpertOperationResult
export function stageExpertFile(context: ExpertDraftContext, input: ExpertStageInput): ExpertOperationResult
export function removeExpertStagedFile(context: ExpertDraftContext, input: ExpertRemoveInput): ExpertOperationResult
export function readExpertStagedFile(context: ExpertDraftContext, input: ExpertReadStagedFileInput): ExpertFileView | ExpertOperationFailure
export function validateExpertDraft(context: ExpertDraftContext, input: ExpertValidateInput): ExpertValidateResult
export function expertDraftView(draft: DraftRow): ExpertDraftView
export function isExpertValidation(value: unknown): value is ExpertValidation
export const EXPERT_NO_SESSION_MESSAGE: string
```

语境类型：`ExpertDraftContext{db; roots: ExpertRoots; allowRootLinkUnder?; platform?; now?; failpoint?; skills?: WorkbenchSkillRegistry}`；
`ExpertSubmitInput{draftId, sessionId, expectedVersion, personaMd, provenanceJson, skillsJson}`（全 `unknown`）；
`ExpertStageInput{draftId, sessionId, expectedVersion, area, path, contentUtf8}`；
`ExpertRemoveInput{draftId, sessionId, expectedVersion, area, path}`；
`ExpertReadStagedFileInput{draftId, area, path}`；
`ExpertValidateInput{draftId; expectedVersion; sessionId?}`（**不传 sessionId 键 = HTTP 路径，传了含 `null` 就强制 owner 守卫**）；
`ExpertOperationFailure{ok:false; code: ExpertErrorCode | PersonaDiagnosticCode; field; message; currentVersion?; errors?}`；
`ExpertDraftFailpoint = 'stage.before-write' | 'stage.after-write' | 'remove.before-cas' | 'submit.before-cas' | 'validate.before-write'`（仅测试注入）。
成功文案逐字：`专家草稿已更新，尚未安装。下一次操作使用 contentVersion=N。`

## 通过的断言 ID

| 断言 | 结论 | 关键证据（测试名摘录 + 断言实质） |
|---|---|---|
| AX-E07 | ✅ | 先断言 `parsePersonaDocument(normalizePersonaText(x)).document.body.length === 20000`，再 submit：20000 通过且 DB 的 `payload.personaMd` 含 20000 个 x；20001 → `oversized-body`(field=personaMd)。CRLF 归一后 20000 通过；BOM 落库文本不带 `\uFEFF` 且无 `\r`；9999 个 😀 + 2 字符 = 20000 单元（字节数 > 20000，证明按 UTF-16 单元计数）通过，+1 → 拒绝 |
| AX-E08 | ✅ | 3 个坏例（`secret:` 键 → `unsupported-frontmatter`、空正文 → `empty-body`、41 字标题 → `invalid-title`）每条先证明**现有 parser 仍拒绝**（不放宽 parser），再断言 submit 返回同码且 DB 行 `contentVersion/personaMd/updatedAt` 逐字未变；非法 `provenance_json` → `invalid-json`、`required:'yes'` → `invalid-payload`，且 `JSON.stringify(payload)` 前后一致 |
| AX-E09 | ✅ | translated 无来源 / merged 单来源 → `source-invalid`；MIT 缺版权声明或缺许可全文 → `source-license-unsupported`（message 明写"只做结构校验"，无"已核实"字样、无联网）；`commit: null` → warning `source-commit-unknown`、errors 为空 |
| AX-E10 | ✅ | 含 CRLF 与原版权的许可文本：直接 `readFileSync` 比对磁盘字节与输入完全一致、索引 `sha256` 与磁盘一致，CRLF 与 Copyright 行原样 |
| AX-E11 | ✅ | SESSION_B 拿 A 的 draftId → `draft-owner-mismatch`；`session_id` 为空的草稿任何会话操作都拒绝；非 UUID / `status≠pending` / `payload.version=99` 的直插行都被守卫挡住（code 分别为 `invalid-payload`/`draft-not-pending`/`unknown-schema-version`） |
| AX-E12 | ✅ | 单件 > 128 KiB → `file-too-large`；总量 > 1 MiB → `package-too-large` 且第 9 个文件不落盘；> 64 件 → `file-count-limit` 且索引保持 64 条；skill 需求数/install 数/reuse 数越界 → `file-count-limit`。每条都重读 DB 索引与真实目录，确认不留超限索引。skill 侧：单件超限只报 `file-too-large`（不多报 `skill-package-invalid`）；声明↔暂存双向不一致、缺 SKILL.md、缺 `sources/<sourceId>/LICENSE.txt`、`packageFiles` 条目形状非法、name 与目录名不符、reuse 带文件 → `skill-package-invalid`；reuse 必需项缺失是 error、可选缺失是 warning；正式目录同名且无管理清单或哈希不同 → `skill-conflict` |
| AX-E13 | ✅ | stage 改一件文件后：`contentVersion` +1、`payload.validation === null`、phase 回 `editing`、旧 `manifestHash` 无法 confirm；submit 改人格同样清 validation。另有「文件被第三方改成另一内容」：读与 validate 都报 `staged-file-changed`，**不自动确认** |
| AX-E14 | ✅ | 10 条覆盖：默认 invocation `{disableModelInvocation:false, userInvocable:true}` 且 metadata `{}`；无 frontmatter / 无结束 `---`、invalid YAML、重复 key、非顶层 map（序列与标量）、锚点别名、自定义与 JS 标签 → `skill-package-invalid`；缺 name / 缺 description / 空 description 逐条报错；legacy 键点名具体键；`"false"/"0"/"no"/"off"` 归一 false（无 `Boolean('false')`）；metadata 原样保留（含嵌套对象与数组）；空正文拒绝、20000 通过 / 20001 拒绝 |

补充用例（P2 步骤 → 测试）：`步骤 4 CAS 失败`（failpoint 触发 → 仅当磁盘仍是本次新哈希才回滚，第三方改动不覆盖）、`步骤 5 中途改动`（见 AX-E13 行）、`步骤 9 warning 不自动消失`（重复校验仍报同一条且 validation 落进 DB 行）、`同一草稿进程内互斥重入 → install-in-progress`、`stage 只接受形状合法相对路径`、`remove 只删索引内文件且幂等 changed:false`、`read 只读本草稿索引`、`归档原件/许可全文超 20000 字符是 warning、普通资源是 error`、`expertDraftView / isExpertValidation 形状`。

## 实际运行命令与退出码（主会话独立复跑，2026-10-05 12:4x）

```
pnpm typecheck; $tc=$LASTEXITCODE; pnpm build; $bd=$LASTEXITCODE;
node --test --test-concurrency=1 test/expertDrafts.test.mjs test/expertSkillPackage.test.mjs test/personaParse.test.mjs; $t1=$LASTEXITCODE;
node --test --test-concurrency=1 test/expertContracts.test.mjs test/expertPaths.test.mjs test/expertProvenance.test.mjs test/personaLibrary.test.mjs test/personaBinding.test.mjs test/capabilities.test.mjs; $t2=$LASTEXITCODE;
node --test --test-concurrency=1 test/db.test.mjs; $t3=$LASTEXITCODE
```

| 命令 | 退出码 | 实际结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 干净 |
| `pnpm build` | 0 | `buildId wb-13288ff8e36523c8`，190 个输入文件；client bundle 552.64 kB |
| P2 三件套 | 0 | `tests 77 / pass 77 / fail 0`（expertDrafts 30 + expertSkillPackage 20 + personaParse 27） |
| 回归六件套 | 0 | `tests 105 / pass 105 / fail 0` |
| `test/db.test.mjs` | 1 | `tests 9 / pass 8 / fail 1`：仅 `removeTempDir` EPERM（`test/db.test.mjs:35` ← `:303`），**仓库既有** Windows 清理期问题（`docs/releases/v1.16.0.md:134`），非本批回归 |

`SUMMARY typecheck=0 build=0 p2=0 regression=0 dbtest=1`。

## 关键行为（P3/P5 直接复用，勿另造同义实现）

1. **owner 守卫是唯一身份入口**：`assertExpertDraftOwner` 的 `sessionId` 必须是**执行上下文的真实会话 id**（`exec.agent.session.id`）。注释与 `EXPERT_NO_SESSION_MESSAGE` 都写明"工具参数里没有 session_id 入参"——**P5 注册五个工具时不得把 `sessionId` 暴露成工具参数**，否则 AX-E11 失效。
2. `validateExpertDraft` **不传 `sessionId` 键**才是 HTTP 路径（浏览器没有 live Agent 身份）；一旦传了（含 `null`）强制 owner 守卫。P5 的 HTTP 路由必须走"不传"这条，工具路径必须传真实会话 id。
3. 暂存与索引的顺序固定为：**owner 守卫 → 路径形状/碰撞 → 内容尺寸 → 配额 → 写文件（atomicWriteText）→ DB CAS**；CAS 失败时只回滚"磁盘仍是本次刚写入哈希"的情况。
4. 校验前**重读真实文件**（索引只是账本）：`sha256` 或 `bytes` 不一致 → `staged-file-changed`，不自动确认、不替用户修好。
5. `validateExpertDraft` **有错也是 `ok:true`**，`validation.errors` 非空、`phase` 留 `editing`——这是 §4.1 的 HTTP 契约。
6. `manifestHash` 由 `expertManifestHash` 按 §3.4 计算（含 `indexFiles` 的 area/path 排序、不含 checkedAt/phase/contentVersion）。**P3 的 confirm 不能只信这个值**：它来自索引，必须在重读磁盘后自行复算并与 `expectedManifestHash` 比对。
7. skill frontmatter 解析按 §7.2：`parseDocument` + core schema + `customTags: []` + 未解析标签（`TAG_RESOLVE_FAILED`）升级为错误 + `toJS({maxAliasCount:0})` + 重复 key/非顶层 map 拒绝 + legacy 键点名。
8. `hashSkillPackage` 与文件顺序无关，并排除管理文件自身。

## 未验证项目与原因

- **没有真实进程崩溃测试**：步骤 4/5 的中断/回滚用注入的 `failpoint` 模拟（`stage.after-write`、`submit.before-cas`、`remove.before-cas`、`validate.before-write`），不是 kill 进程；跨进程中断要等 P3 的 install journal 与 `.install.lock`。
- **没有真实 skills 服务 / 真实 DSH runtime**：reuse 判定只对着注入的 fake registry 验过 available / missing / `modelInvocable=false` 三条分支。
- `context.skills` 在**生产里还没有注入点**：validate 的 reuse 判定当前只能拿到 `undefined` → 必需 reuse 报 `skill-service-unavailable`（正确降级，但接线属 P4/P5）。
- `SKILL.md` 的 `whenToUse`、`allowed-tools` 等未知 metadata 只验"原样保留"，没验下游怎么用（P4 职责）。
- 未跑全仓 75 个测试文件：只跑 P2 三个 + 回归六个（本批未改任何被其它测试 import 的源文件，风险低）。
- 未用 `pnpm install --frozen-lockfile` 复验锁文件与 `node_modules` 完全一致（`git diff pnpm-lock.yaml` 只有 yaml@2.9.1 的 10 行）。

## 当前下一批前置条件（P3）

1. 读 `方案-v0.3.md` §6 全部（§6.1 校验顺序已落地，§6.2 发布门、§6.3 锁与日志、§6.4 确认算法、§6.5 失败与恢复决策）。
2. 直接复用本批的：`drafts.ts` 的守卫与校验调用方式、`skill-package.ts` 的 `validateWorkbenchSkillPackage`/`hashSkillPackage`、P1 的 `withExpertInstallLock`/`atomicWriteText`/`expertManifestHash`。
3. 新增 `src/personas/managed.ts`（`isManagedPersonaId`、`readManagedPersonaPublication`）与 `src/experts/install.ts`（`confirmExpertDraft`/`recoverExpertInstallations`/`recoverExpertInstallation`/`rollbackUncommittedInstallation`）+ `test/expertInstall.test.mjs`/`test/expertRecovery.test.mjs`。
4. `src/shared/persona.ts` 需新增 `installation-incomplete` 诊断码（P1 复核已登记：现有 24 个码里没有它）；`library.ts` 的 discovery/resolve 共用链上加发布门。
5. 每加一个新源文件都要追加进 `tsconfig.build.json` 的显式 include。

## 规格偏差

1. `ExpertOperationFailure.code` 放宽为 `ExpertErrorCode | PersonaDiagnosticCode`（原计划只写 `ExpertErrorCode`）。原因：AX-E07/E08 要求原码透出 `oversized-body`/`unsupported-frontmatter`/`empty-body`/`invalid-title`，若用 `asExpertErrorCode()` 收窄会被降级成 `invalid-payload`；§12.1 本就允许 `PersonaDiagnosticCode` 出现在诊断里。实施方式：只对**人格正文失败**这一条路径用 `personaFailureCode()`，其余路径仍严格收窄。
2. `rootForArea()`（P1）只认 `'persona' | 'skill'`，而暂存区类型是 `'persona-resource' | 'skill'`：`drafts.ts` 内部用 `areaRoot()` 显式映射 `'persona-resource' → 'persona'`，**未改 P1**。（建议 P3 顺手把 P1 的 `rootForArea` 参数类型放宽为 `ExpertFileArea`，或在注释里固化这个映射。）
3. `validateWorkbenchSkillPackage` 里"单件超 128 KiB"不再 `continue` 掉，仍入暂存集合，只报 `file-too-large`（否则会额外多报一条 `skill-package-invalid`「声明了但没暂存」）。

## 复核记录（主会话）

- 独立复跑：见上文命令表（与实施者自报一致：`typecheck=0 build=0 p2=0`）。
- 逐文件复核：`skill-package.ts` 的 frontmatter 解析链、`drafts.ts` 的守卫/`stageExpertFile`/`validateExpertDraft`/`expertDraftView` 与 §3.4、§4.1、§6.1、§7.2 逐条对照，未发现需要修改的缺陷；发现的两条**接线义务**（工具不得暴露 `sessionId` 参数、`validateExpertDraft` 的 HTTP 路径靠"不传 sessionId 键"区分）已写进 §关键行为供 P5 遵守。
- 副作用复核：`~/.dsh/workbench` 下 `personas/`、`skills/` **仍不存在**（本批只在测试临时目录写文件）；工作树无 P2 之外的新增/修改。
- 实施者中途崩溃过一次（写完两个源文件后无收尾消息，`pnpm typecheck` 退出码 2：`drafts.ts:64` 误从 `../shared/persona.js` 导入 `normalizePersonaText`/`parsePersonaDocument`（实际在 `src/personas/parse.ts:47/309`）、失败对象 `code` 被推断成 `string`、`:1183` 的 `'persona-resource'` 与 `rootForArea()` 不匹配）；主会话诊断后发回修复清单，实施者补齐测试并跑通。**记录在案：本批是"跨轮续作"而非一次成功。**

## 规格偏差之外的已知环境事实（不是本批成果）

- 仓库本地 `core.autocrlf` 被外部改成 `false`，HEAD blob 全 LF：本批新增/修改文件 CRLF=0（纯 LF），不会产生换行 churn。
- 仓库里另有会话在跑 `scripts/release-preflight.mjs` 与 `scripts/repro/probe-*-mutations.mjs`，会删 `lib/`、改源文件后还原 → `pnpm build` 与 `node --test` 必须写在同一条命令里。
- 全仓 `test/db.test.mjs` 的清理期 EPERM（`test/db.test.mjs:35`）是既有问题，已在 `docs/releases/v1.16.0.md:134`、`docs/issues/2026-10-05-clear-plan-does-not-refresh.md:60` 记录。

## 没有执行的安装/发布操作

- 未 `git add` / `git commit` / `git checkout` / `git stash`（提交由主会话按显式路径单独做）。
- 未 `dsh plugin add/remove`、未改 profile、未重启任何实例（含 19387）、未 `pnpm publish`、未打 tag。
- 未写任何正式专家/技能目录；`~/.dsh/workbench/personas`、`~/.dsh/workbench/skills` 仍为空（不存在）。
