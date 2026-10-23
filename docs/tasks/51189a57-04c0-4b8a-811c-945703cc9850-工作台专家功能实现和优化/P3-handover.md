# P3 交接：安装/发布门/恢复（AX-E15–E23）

- 批次：P3「受管发布门 + 确认安装主链 + 进程中断恢复」
- 执行日期：2026-10-05
- 基线：P2 提交 `7bf40a5`（P1 `a63b6cb`）
- 实施方式：**两轮委派同一子代理**（第一轮 = 安装主链与发布门；第二轮 = 恢复与完整故障矩阵），两轮均由主会话独立复跑 + 逐文件复核后才写本交接；P3 批次不分两次交接。
- 交付状态：**两轮全部完成**，`typecheck 0 / build 0 / 11 个测试文件 207 pass 0 fail`（含 P1/P2 回归），AX-E15–E23 中 P3 范围内的 9 条全部 ✅。

---

## 1. 文件清单（本轮改动）

| 文件 | 行数 | 变更 | 说明 |
|---|---|---|---|
| `src/experts/install.ts` | 1916 | 新增 | §6.4 确认算法 12 步、journal、补偿、幂等回放、恢复 |
| `src/personas/managed.ts` | 350 | 新增 | §6.2 发布门读取器 + 受管 skill 状态读取（P4 provider 共用） |
| `test/expertInstall.test.mjs` | 1027 | 新增 | 12 test（AX-E15–E19/E23 + §6.2/§6.3/§6.5 的额外分支） |
| `test/expertRecovery.test.mjs` | 1276 | 新增 | 13 test（AX-E20–E22 + 真崩溃 + journal 组合 + 跨 DB） |
| `src/personas/library.ts` | 545（+64） | 修改 | `managedPublicationGate` 挂进 `discoverPersonas` 与 `resolvePersona` |
| `src/shared/persona.ts` | 356（+8） | 修改 | `PersonaDiagnosticCode` 增 `installation-incomplete` |
| `src/shared/expert.ts` | 454（+28/−15） | 修改 | 拆出 4 个保留名/文件名常量 + `EXPERT_PUBLICATION_VERSION = 1` |
| `src/experts/paths.ts` | 893（+8/−5） | 修改 | `validateExpertRelativePath`/`checkExpertRelativePathShape` 增 `allowReservedNames`（**只有安装器传**） |
| `src/experts/drafts.ts` | 1413（+76/−24） | 修改 | 导出 `expertStagedRelativePath`/`withExpertDraftMutex`/`expertDraftCurrentVersion`/`expertRepoFailure`；`validateExpertDraft(context,input,{mutex?:boolean})` |
| `src/db/repo/experts.ts` | 505（+151） | 修改 | 安装器专用短事务 `transitionExpertDraftInstall` / `commitExpertDraftInstallation` |
| `tsconfig.build.json` | 77（+2） | 修改 | 显式 include 增 `src/personas/managed.ts`、`src/experts/install.ts` |

全部文件 LF、CR=0。本轮**未改** `src/index.ts` / `src/tools.ts` / `src/api/**`（按批次纪律，接线属后续批次）。

---

## 2. 导出签名（逐字）

### `src/personas/managed.ts`（新增）
```ts
isManagedPersonaId(id: unknown): boolean
managedPersonaDirectoryPath(expertId: string): string            // generated/<uuid>
managedPublicationRelativePath(expertId: string): string        // generated/<uuid>/publication.json
readManagedPersonaPublication(personasDir: string, expertId: unknown): ManagedPublicationReadResult
readManagedSkillInstallState(skillsDir: string, personasDir: string, skillName: unknown): ManagedSkillInstallState
```
- `ManagedPersonaPublication = { version: 1; expertId: string; installationId: string; manifestHash: string; committedAt: string }`
- `ManagedPublicationReadResult = { ok: true; publication } | { ok: false; code: 'installation-incomplete'; reason: 'not-managed-id'|'missing'|'unreadable'|'malformed'|'expert-mismatch'|'not-ready'; message }`
- `ManagedSkillInstallState = { managed: boolean; skillName: string; expertId?; installationId?; packageHash?; files?: Array<{path,bytes,sha256}>; ready: boolean; problem?: { code: ExpertErrorCode; message } }`

### `src/experts/install.ts`（新增）
```ts
confirmExpertDraft(context: ExpertInstallContext, input: ExpertConfirmInput): ExpertConfirmResult
rollbackUncommittedInstallation(context: ExpertInstallContext, input: ExpertRollbackInput): ExpertRollbackOutcome
recoverExpertInstallation(context: ExpertInstallContext, draftId: string): ExpertRecoveryOutcome
recoverExpertInstallations(context: ExpertInstallContext): { outcomes: ExpertRecoveryOutcome[]; scanned: number }
readExpertInstallJournal(context: ExpertInstallContext, draftId: string): ExpertJournalRead
writeExpertInstallJournal(context: ExpertInstallContext, journal: ExpertInstallJournal): void
ownerDbKeyFor(context: ExpertInstallContext): string
canonicalDatabasePath(file: string): string
```
- `ExpertConfirmResult = { ok: true; result: ExpertInstallResult; replayed: boolean } | ExpertOperationFailure`
- `ExpertInstallContext = { db; roots; allowRootLinkUnder?; platform?; now?; failpoint?; ownerDbKey?; refreshSkills?: () => void; skills?: WorkbenchSkillRegistry; lock?: { isProcessAlive?; pid?; hostname? } }`
- `ExpertInstallFailpoint`（17 点）：`install.after-validation` / `before`·`after-prepared-journal` / `before`·`after-persona-directory` / `before`·`after-skill-directory` / `before`·`after-persona-document` / `before`·`after-files-published-journal` / `before`·`after-db-commit` / `before-publication` / `after-publication` / `before-provider-refresh` / `after-ready-journal`
- `ExpertRecoveryAction = 'nothing-to-do'|'already-ready'|'completed-publication'|'rolled-back'|'repair-required'|'skipped-foreign-owner'|'skipped-owner-unknown'|'skipped-locked'|'skipped-no-draft'`

### `src/experts/drafts.ts`（新增导出，安装器复用而非另造）
```ts
expertStagedRelativePath(area: ExpertFileArea, draftId: string, path: string): string
withExpertDraftMutex<T>(draftId: string, operation: () => T): T
expertDraftCurrentVersion(context: ExpertDraftContext, draftId: unknown): number | undefined
expertRepoFailure(error: unknown, field: string, currentVersion?: number | null): ExpertOperationFailure | undefined
validateExpertDraft(context, input, options: ExpertValidateOptions = {}): ExpertValidateResult   // ExpertValidateOptions = { mutex?: boolean }
```

### `src/db/repo/experts.ts`（安装器专用）
```ts
transitionExpertDraftInstall(db, id, expectedVersion, transition: ExpertInstallTransition, at?): TransitionExpertDraftInstallResult
commitExpertDraftInstallation(db, id, expectedVersion, result: ExpertInstallResult, at?): DraftRow
```

---

## 3. 命令与退出码（主会话独立复跑，不是只读子代理报告）

```powershell
pnpm typecheck; $a=$LASTEXITCODE
pnpm build; $b=$LASTEXITCODE
node --test --test-concurrency=1 test/expertRecovery.test.mjs test/expertInstall.test.mjs test/expertDrafts.test.mjs `
  test/expertSkillPackage.test.mjs test/expertContracts.test.mjs test/expertPaths.test.mjs `
  test/expertProvenance.test.mjs test/personaLibrary.test.mjs test/personaBinding.test.mjs `
  test/personaParse.test.mjs test/capabilities.test.mjs; $c=$LASTEXITCODE
Write-Output "SUMMARY typecheck=$a build=$b recovery_full=$c"
```

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 无输出 |
| `pnpm build` | 0 | buildId `wb-13288ff8e36523c8`（首轮）/ 客户端 552.64 kB |
| 上述 11 个测试文件 | 0 | `tests 207 / pass 207 / fail 0`（`duration_ms 15590`） |

- 首轮复核（不含 recovery）：10 个文件 `tests 194 / pass 194 / fail 0`，`SUMMARY typecheck=0 build=0 p3plusregression=0`。
- 第二轮复核（含 recovery）：11 个文件 `tests 207 / pass 207 / fail 0`，`SUMMARY typecheck=0 build=0 recovery_full=0`。
- `build` 与 `node --test` **必须同一条命令**：外部会话的 `probe-*-mutations.mjs` 会 `rmSync('lib')`。

---

## 4. AX 断言覆盖（P3 范围）

| 断言 | 结论 | 关键证据（都重读 DB + 真实文件字节 + discover/resolve，不只断言错误码） |
|---|---|---|
| AX-E15 原创无技能草稿确认 | ✅ | `test/expertInstall.test.mjs`：DB `confirmed` + `publication.ready` + catalog 可取 + 附件字节一致 |
| AX-E16 MIT + 两个 install skill 确认 | ✅ | 4 个 failpoint 快照：未 ready 前 `discoverPersonas`/`resolvePersona` 都读不到且给 `installation-incomplete` |
| AX-E17 同一 confirm 并发/重试 | ✅ | 同 `expertId`/`confirmResult`、文件数不增加；重入被 draft mutex 挡成 `install-in-progress` |
| AX-E18 不同 hash 同名 skill | ✅ | 两例（提交期 / 确认时重新校验）：旧 skill 字节不变、无正式入口 |
| AX-E19 同完整 hash 的 ready skill | ✅ | 记 `reusedPaths`、字节不变；补偿只撤本次 `createdPaths` |
| AX-E20 任一 FS 发布点失败（DB 未确认） | ✅ | 17 个 failpoint 的进程内补偿矩阵 + 4 个真崩溃现场（prepared / files-published / db-committed / ready） |
| AX-E21 COMMIT 后 publication 前中断 | ✅ | 5 个提交后 failpoint + 2 例真崩溃：新实例 `completed-publication`、重复确认幂等、`generated/` 逐字节不变 |
| AX-E22 外部修改/两份日志都坏/他 DB 日志 | ✅ | 主坏+备份好按备份补偿；两份都坏→`repair-required` 且同轮健康草稿仍 `already-ready`；`ownerDbKey` 缺失/null/空串→`skipped-owner-unknown`、异库→`skipped-foreign-owner`，四种都不动文件 |
| AX-E23 活 owner / 死 owner / 状态不明 | ✅ | 活→`install-busy`；同机死→回收重抢；不明/别主机→`install-lock-owner-unknown` 不强删；恢复期锁三档同样不碰别人的锁 |

**逐条覆写口径**：`acceptance.md` 的 9 条都标 ✅；未跑到的仍是"未验证"（见 §6），没有把"规格写了"算成通过。

---

## 5. 关键实现事实（复核后确认，后续批次必须沿用）

1. **journal**：`<personas>/.pending/<draftId>/install-journal.json`，同目录 `journal.previous.json`。写主文件**前**先把可解析的旧主文件备份；读时主文件坏→退备份并 `degraded:true`；两个都坏→`{ok:false, reason:'corrupt'}`（**不抛异常**）。`parseJournal` 对 `ownerDbKey` 只做**归一**（非字符串→`''`，即"不知道是谁的"），**不判为结构损坏** —— 这是 §6.3/AX-E22 的硬要求。
2. **ownerDbKey**：`PRAGMA database_list` 的 `main.file` → `resolve()` + NFC + win32 小写 → sha256；内存 DB（file 为空）→ 按 DB 对象缓存的进程内随机 UUID。可注入 `context.ownerDbKey`（测试固定值）。**绝对路径任何情况下都不进 journal / HTTP**。
3. **锁**：`<personas>/.install.lock`。`confirm` 的顺序是 **draft mutex → 发布锁 → 重读 DB**；`finally` 只释放自己 token 的锁；恢复函数自己抢锁（`mode:'recovery'`），抢不到就 `skipped-locked` 且不删锁文件。
4. **publication.json 是唯一发现门**：安装期 `generated/<uuid>.md` 在步骤 7 就落地，但门仍拒绝发现；`publication.json` 在步骤 10（`db-committed` 日志之后）才原子发布。门挂在 `discoverPersonas` 的 per-path 循环（**先于读文件**）与 `resolvePersona` 定位到文件之后，只对 `source.kind === 'user'` + `isManagedPersonaId(id)` 生效 → 普通手工/内置/外部角色行为一字不变。
5. **createdPaths / reusedPaths**：每项 `{area, path, files:[{path,bytes,sha256}]}`。目录按预演顺序写、每写一个文件即记 hash；skill 先 `hashSkillPackage` 比 `existingInstall` —— 同 hash 且 managed → **reused**（一个字节都不写），不同 hash 或非 managed → `skill-conflict` 拒绝。
6. **补偿只删"自己登记过且哈希仍一致"的东西**：登记外文件、被改过的文件、`reusedPaths` 里的共享技能一律不删，转 `repair-required`（消息里指出具体相对路径）。DB 已 confirmed 时**不回滚**：`replayConfirmed` 补 publication 并返回 `replayed:true`；用户改了已发布文件 → `install-repair-required`，草稿保持 `confirmed`。
7. **DB 提交**：`commitExpertDraftInstallation` 在单个 `BEGIN IMMEDIATE` 里「回写 `confirmResult` + `status_code='confirmed'`」，条件是 `pending` + 同 `contentVersion`；事务里**不做任何文件/网络操作**。`transitionExpertDraftInstall` 是安装期唯一允许在 `phase='installing'` 下写库的入口（模型侧走不了）。
8. **构建件从暂存原件复制**：`.pending/<draftId>/.build-persona` 与 `skills/.pending/<draftId>/.build/<skillName>`；`rename` 前二次 `lstat` 目标；失败只清自己的临时目录，**绝不动唯一的那份暂存原件**（所以同版本重试永远可行）。
9. **门是 fail-closed 的白名单**：缺文件、读不回、JSON 坏、`version≠1`、`expertId` 不一致、`ready≠true` 一律不放行 + `installation-incomplete`，不存在"坏了就当成没有从而也列出来"。

---

## 6. 未验证项（如实标注，不填通过）

1. **生产启动接线未做**：`recoverExpertInstallations` 目前**没有任何调用点**（`src/index.ts`/`src/tools.ts`/`src/api/**` 均未改）。函数语义已用测试打到可验证状态；按 §6.5「启动时先恢复归属本 DB 的可解析专家安装日志**再注册**技能 provider」属后续批次接线。
2. **真实 provider 未注册**：`refreshSkills` 仍是注入 hook，§7.1 的注册与 invalidate 属 P4。
3. **字节撕裂未测**：真崩溃用 `process.exit(97)`（操作**之间**），SIGKILL/断电打断 `fsync`/`rename`/`atomicWriteText` 中间态属 §6.3 末段明确排除的范围。
4. **没有真实 dsh 实例级端到端**：交付物 C 是"同一进程两个 DB 句柄 + 一个真子进程（不同 dbPath）"；跨进程 `ownerDbKey` 稳定性由"子进程写入的 key 与父进程按 dbPath 算出的 key 相等"间接证明。
5. **恢复路径下的 `reusedPaths` 未单独测**（本轮现场都是单草稿无复用）；"补偿不删共享 skill"由第一轮 AX-E19 覆盖。
6. **`repair-required` 之后的人工修复流程未测**（改日志、清现场、再次 recover）。
7. **多条同时中断未测**：扫描层只覆盖"1 条坏 + 1 条健康"与"1 条异库 + 1 条自己"。
8. **未跑全仓 `test/*.test.mjs`**（只跑 11 个相关文件）；`test/db.test.mjs` 的既有 Windows 清理期 EPERM 未触碰、非本批回归。
9. **未用 `--frozen-lockfile` 复验**；`~/.dsh/workbench/{personas,skills}` **仍不存在**（本批只在 `mkdtempSync` 临时目录写文件），所以"真机装一份专家"仍未发生（属 P9 隔离实例验证）。

---

## 7. 与规格的偏差

1. **【已修，含反向注入】** `parseJournal` 原把"`ownerDbKey` 缺失/null"判成日志结构损坏（`reason:'corrupt'` → `repair-required`），与 §6.3/AX-E22 的"只跳过、不删任何文件"矛盾。改成非字符串统一归一为 `''`。**主会话独立反向注入验证**：装回 bug → `test/expertRecovery.test.mjs` `tests 13 / pass 12 / fail 1`，失败原文 `actual: 'repair-required', expected: 'skipped-owner-unknown'`；还原后 `13 / 13 pass`，`REVERSE-INJECTION PROBE` 残留在源码里 0 处。
2. **【记录，未改】** 已提交分支的补偿统一把日志钉成 `db-committed`（`compensate()` 的 `committed` 分支），因此 `install.after-ready-journal` 处抛错会把日志从 `ready` **降级**为 `db-committed`。规格没规定该点的 journal 终态；**仅测试可达**（生产不会在该点抛错），恢复判定只看 DB + publication → 仍 `already-ready`，无功能影响。若要"日志终态必须 ready"，改法是该分支保留原 phase（1 行）。
3. **【记录，未改】** publication 已就绪时的幂等回放不重写日志（日志停在 `db-committed`），只有"补齐发布"分支才把日志推回 `ready`；规格未要求回放改写日志。
4. `install.after-validation` 处的异常**原样抛给调用方**（该点位于补偿 try 之外，磁盘与 DB 零改动）。这也是为什么 P5 接线必须把 `confirmExpertDraft` 包在 try/catch 里（见 §8）。
5. 未预期异常统一回 `install-repair-required`（`install-failed` 不是 `ExpertErrorCode`）；中断型补偿的 `lastInstallError.code = 'canceled'`（既有码）。
6. `ExpertOperationFailure.code` 仍是 `ExpertErrorCode | PersonaDiagnosticCode`（P2 已记录的偏差，本轮沿用）。

---

## 8. 接线义务（给 P4/P5，必须遵守）

1. `recoverExpertInstallations(context)` 必须在**插件启动时、注册技能 provider 之前**调用一次；返回的 `repair-required` 条目**不得阻止插件启动**（隔离该专家并在 catalog 显示原因）。
2. `confirmExpertDraft` 只把 `InstallFailure` 与 `ExpertRepoError` 转成 `ok:false`；**其它异常会抛出**。HTTP/工具层必须 try/catch，且**不得**把原始日志/绝对路径透出。
3. `sessionId` 一律取执行上下文 `exec.agent.session.id`（工具参数不得暴露）；HTTP 用户确认路径**不传** `sessionId` 键（含 `null` 会强制 owner 守卫）。这条在 P2 已记，本轮 `confirmExpertDraft` 同样遵守。
4. `context.failpoint` 只给测试；生产构造 context 时不传（模型/HTTP 都到不了）。`allowRootLinkUnder` / `platform` / `now` / `ownerDbKey` / `lock` 同属构造期注入。
5. P4 注册 provider 时：`refreshSkills` 接 `control.invalidate`；`readManagedSkillInstallState` 是 provider list/get 的共用判定（没 ready 不 list/get）。

---

## 9. 故障点矩阵（实测，可直接引用）

> 口径：除"断点处"三列外，各列都是**补偿/恢复跑完之后**的状态。`△` = 按代码顺序推得、本批未单独断言。

### 9.1 进程内失败（异常被接住 → 当场补偿），17 点

| 故障点 | 补偿后 DB | 补偿后正式 FS | discover / resolve | journal 终态 | 结论 |
|---|---|---|---|---|---|
| `install.after-validation` | pending / `phase=validated`（version 不变、`lastInstallError=null`） | 无 | false / false | **无日志**（从未创建） | 在补偿 try **之外**，异常抛给调用方；磁盘与 DB 零改动；重试成功 |
| `before-`·`after-prepared-journal` | pending / `install-failed`（version 不变，`lastInstallError.code=install-repair-required`） | 无 | false / false | `rolled-back` | 无东西可撤；暂存零改动；重试成功 |
| `before-persona-directory` | 同上 | 无 | false / false | `rolled-back` | 同上 |
| `after-persona-directory` | 同上 | 无（新建的 `generated/<uuid>/` 整个撤掉） | false / false | `rolled-back` | 只撤本次 `createdPaths` |
| `before-`·`after-skill-directory` | 同上 | 无（`skills/demo-skill/` 撤掉） | false / false | `rolled-back` | 技能目录一并撤 |
| `before-`·`after-persona-document` | 同上 | 无（正式 `.md` 撤掉） | false / false | `rolled-back` | 同上 |
| `before-`·`after-files-published-journal` | 同上 | 无 | false / false | `rolled-back` | 同上 |
| `before-db-commit` | 同上 | 无 | false / false | `rolled-back` | `.build-persona` 与 `.build` 清掉 |

11 点共同断言：回执 `ok:false` / `code=install-repair-required` / message 含"未提交\|补偿"；**同 version 重试 → `ok:true`、`replayed:false`、publication ready、`listed/resolved=true`、journal `ready`、DB `confirmed`**。断点处 DB 阶段：`before-prepared-journal` △`validated`，其余 10 点 △`installing`（`transitionExpertDraftInstall({phase:'installing'})` 在 `src/experts/install.ts:1568`，紧随 prepared 日志）。

### 9.2 真崩溃（子进程 `process.exit(97)`，无补偿、不释放锁）

| 崩溃点 | 断点处 DB | 断点处正式 FS | 断点处可见性 | 断点处 journal | 新实例动作 | 恢复后 DB | 恢复后 FS | 恢复后可见性 |
|---|---|---|---|---|---|---|---|---|
| `after-prepared-journal` | pending / `validated` | 空 | false / false | `prepared` | `rolled-back` | pending / `install-failed`（`lastInstallError.code=canceled`） | 空；锁被本轮恢复回收 | false（同 version 重试后 true/true） |
| `after-files-published-journal` | pending / `installing` | 目录 + 技能包 + `.md` 全在 | false / false / `incomplete=true` | `files-published` | `rolled-back` | pending / `install-failed` | 全撤（`generated/<uuid>`、`skills/demo-skill` 都没了）；**暂存保留** | false |
| `after-db-commit` | `confirmed` + `confirmResult` | 全在，**无** `publication.json` | false / false / `incomplete=true` | `files-published` | `completed-publication` | `confirmed`（不回滚） | 只多 `<uuid>/publication.json` | true / true |
| `before-publication` | `confirmed` | 全在，无 `publication.json` | false / false / `incomplete=true` | `db-committed` | `completed-publication` | `confirmed` | 只多 `<uuid>/publication.json` | true / true |
| `after-ready-journal` | `confirmed` | 全在（含 publication） | true / true | `ready` | `already-ready` | `confirmed` | **一个字节都不改** | true / true |

真崩溃用例的判据：子进程写 marker 后 `process.exit(97)`，父进程 `spawnSync` 的 `status=97` 证明它**恰好**死在目标点；`.install.lock` 作为"owner 已死"留在磁盘上，恢复要能回收它。

### 9.3 journal 组合、锁与跨 DB

| 场景 | DB | 正式 FS | journal 读取 | 动作 / 结论 |
|---|---|---|---|---|
| 主日志坏 + `previous` 完整（未确认、文档已发布） | pending / `editing` | 文档在 | `ok:true, degraded:true, phase=prepared` | 按**备份**的 `createdPaths` 补偿 → `rolled-back`，文档撤掉 |
| 主日志坏 + `previous` 完整（已确认且 ready） | `confirmed` | 全在 | `degraded:true, phase=db-committed` | `already-ready`，零改动 |
| 两份都坏 | pending | 文档**保留**、日志不重写 | `ok:false, reason=corrupt` | `repair-required` / `phase:'unknown'`；同一轮扫描里健康草稿仍 `already-ready`（`scanned=2`），不抛异常 |
| `ownerDbKey` 缺失 / null / 空串 | pending / `editing` | 文档保留 | 不变 | `skipped-owner-unknown`；换成自己的 key 后能正常 `rolled-back` |
| `ownerDbKey` 属于别的 DB | pending / `editing` | 文档保留 | 不变 | `skipped-foreign-owner` |
| 日志被删、草稿停在 `installing` | pending / `installing` | 无 | `reason=missing` | `confirm` → `install-repair-required`（"找不到安装日志"）；`recover` → `nothing-to-do`（不猜） |
| 只删主日志、`previous` 在 | `confirmed` | 全在 | `degraded:true` | `already-ready`（不误判成"没有日志"） |
| 锁：活 owner / 查不出（undefined）/ 别的主机 | — | 不动 | — | `skipped-locked`，锁文件**字节不变**，绝不强删 |
| 锁：同机死 owner | — | 补偿完成 | — | `rolled-back`；自己拿的锁随后释放 |
| 两个 DB 共享同一对根 | A: `confirmed`；B: pending | A 零改动 | A 仍 `ready` | A → `skipped-foreign-owner`；B → `rolled-back`；A 跨 profile 仍可发现/可解析 |

---

## 10. 复核与过程事实（不当作成果，如实记录）

- **本轮发现并修复的产品缺陷 3 处**：
  1. `confirmExpertDraft` 先取 draft mutex，又调 `validateExpertDraft`（后者再取同一把锁）→ 11 个用例全红报 `install-in-progress`。修法：给 `validateExpertDraft` 加显式 `options.mutex:false` 复用已有互斥，默认仍自己取（HTTP 路径靠它挡并发）。
  2. `confirmExpertDraft` 外层 catch 只认 `ExpertRepoError`，`replayConfirmed` 抛的 `InstallFailure` 直接冒出调用方。修法：补 `InstallFailure` 分支。
  3. `parseJournal` 把 `ownerDbKey` 缺失判为日志损坏（§7 第 1 条）——由主会话独立反向注入复现并确认修复。
- **测试侧自身问题 3 处**（非产品缺陷）：同一 `sessionId` 会被 `createExpertDraft` 复用同一草稿导致用例串味（每个 case 换 sessionId）；裸 `writeFileSync` 写 journal 时目录还不存在（统一走带 `mkdirSync` 的 helper）；漏 import `transitionExpertDraftInstall`。
- **实施方式**：P3 由同一子代理分两轮完成（第一轮 install.ts 1914 行 + managed.ts + 12 test；第二轮 +13 test 与 1 处缺陷修复）。两轮都由主会话在同一命令里独立复跑（194 → 207）并逐段复核源码后才写本交接。
- **环境事实**：外部会话在跑 `scripts/release-preflight.mjs` 与 `scripts/repro/probe-*-mutations.mjs`（会删 `lib/`、临时改源文件再还原）→ `pnpm build` 与 `node --test` 必须写在同一条命令；仓库本地 `core.autocrlf` 被外部改成 `false`（HEAD blob 全 LF、工作树多为 CRLF）→ 本批新增文件保持 LF；工作树里 `docs/design/2026-10-03-专家市场-调研.md` 等改动**不是本批所为**。
- **未执行的安装/发布操作**：未动当前会话所在实例（19387）；未 `dsh plugin add/remove`；未改 profile；未重启；未 `pnpm publish`；未写 `~/.dsh/workbench/{personas,skills}`。
