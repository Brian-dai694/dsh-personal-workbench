# P1 交接 — 类型、设置、字典种子与纯路径/来源校验

- 执行任务：`ed644638-f9a0-45cf-a32f-90df7d060dda`（工作台专家功能实现和优化）
- 执行时间：2026-10-05 12:25 +08:00
- 规格：方案 v0.3 §3（类型/目录/来源/哈希与路径）、§10（能力降级）、§12.1–§12.2；施工计划 P1；`acceptance.md` AX-E01–E06
- 结论一句话：**P1 五类导出全部就位且经主会话独立复跑验证（typecheck / build / 43 条单元测试 / 80 条回归全绿），AX-E01–E06 全部 pass；设置读写已在服务端接线（含真实 HTTP 证据），其余入口按计划留给 P2+。**

## 已完成文件/导出

### 新增（4 源 + 3 测试）

| 文件 | 导出（关键签名） |
|---|---|
| `src/shared/expert.ts` | `EXPERT_ERROR_CODES`（49 个，封闭）/`isExpertErrorCode`；版本常量 `EXPERT_DRAFT_PAYLOAD_VERSION`/`EXPERT_PROVENANCE_VERSION`/`EXPERT_VALIDATION_VERSION`/`EXPERT_SKILL_INSTALL_VERSION`/`EXPERT_INSTALL_JOURNAL_VERSION`；`EXPERT_DRAFT_KIND`/`EXPERT_DRAFT_STATUSES`/`EXPERT_AUTO_SUMMON_META_KEY`/`EXPERT_GENERATION_SCOPE_CODE`/`EXPERT_RESERVED_FILE_NAMES`/`EXPERT_INSTALL_LOCK_FILE_NAME`/`EXPERT_PENDING_DIR_NAME`/`EXPERT_GENERATED_DIR_NAME`/`EXPERT_JOURNAL_PREVIOUS_NAME`/`EXPERT_INSTALL_JOURNAL_FILE_NAME`/`EXPERT_PENDING_FILES_DIR_NAME`；§1.4 全部限值常量；`isExpertUuid`/`isExpertId`/`expertIdFromUuid`/`expertUuidFromId`/`isExpertSourceId`/`isExpertSkillName`；§3.2 全部类型（`ExpertCreationKind`/`ExpertDraftPhase`/`ExpertFileArea`/`ExpertSource`/`ExpertReference`/`ExpertProvenance`/`ExpertSkillRequirement`/`ExpertStagedFile`/`ExpertIssue`/`ExpertValidation`/`ExpertInstallResult`/`ExpertDraftPayload`/`WorkbenchSkillInstall`/`ExpertPublishedPath`/`ExpertInstallJournal`/`ExpertSettings`） |
| `src/db/repo/experts.ts` | `readExpertSettings(db): ExpertSettings`；`writeExpertSettings(db, {autoSummonExperts?}): boolean`；`getExpertDraft(db,id)`；`getPendingExpertDraftForSession(db,sessionId)`；`createExpertDraft(db,input,at?): {draft,payload,reused}`；`updateExpertDraftCas(db,id,expectedVersion,patch,at?): {draft,payload,changed}`；`defaultExpertId(uuid?)`；`class ExpertRepoError extends Error { code: ExpertErrorCode }` |
| `src/experts/paths.ts` | `resolveExpertRoots({home?,personasDir?,skillsDir?}): ExpertRoots`；`rootForArea`；`hasAllowedTextExtension`；`checkExpertRelativePathShape(area,path,{platform?})`；`expertPathCompareKey(area,path,platform?)`；`validateExpertRelativePath(area,path,{platform?,existing?,self?})`；`validateStagedFileContent(path,bytes,{text?,maxChars?})`；`isInsideExpertRoot(root,candidate,platform?)`；`assertNoLinksInsideRoot(root,rel,{allowRootLinkUnder?,platform?})`/`assertNoLinksInPaths`；`atomicWriteText(path,content,{root?,overwrite?,allowRootLinkUnder?})`；`acquireExpertInstallLock`/`withExpertInstallLock`/`defaultIsProcessAlive`（锁 owner 含 `pid/hostname/token/acquiredAt/draftId?`）；`readExpertTextFile(root,rel,{maxBytes?,allowRootLinkUnder?})`；`pathProblemToIssue` |
| `src/experts/provenance.ts` | `stableJson`；`sha256Hex`；`expertManifestHash({expertId,personaMd,provenance,skills,files})`；`parseExpertProvenance(raw,{maxSources?})`；`lookupFromStagedFiles(files,readText?)`；`validateExpertSourceFiles(provenance,lookup,{area?,allowStructureSkip?})`；`isSha256Hex` |
| `test/expertContracts.test.mjs` | AX-E01–E04 + 错误码/限值/id 形状 |
| `test/expertPaths.test.mjs` | AX-E05 / AX-E06 + 安装锁三档 |
| `test/expertProvenance.test.mjs` | stableJson / manifestHash / 来源与许可结构校验 |

### 修改（7）

| 文件 | 改动 |
|---|---|
| `src/shared/contracts.ts` | `DraftKind` 增 `'expert'`；`WorkbenchSettings` 增 `autoSummonExperts: boolean` |
| `src/db/seed.ts` | `draft_kind/expert`（sortOrder 100）、`ai_session_scope/expert_generation`（60）；仍走 `INSERT OR IGNORE` |
| `src/db/repo.ts` | barrel 再导出 experts 仓储符号（不反向 import） |
| `src/client/settingsFallback.ts` | `autoSummonExperts: settings.autoSummonExperts ?? false`（已有 `false` 不被覆盖） |
| `src/client/hooks/useWorkbenchSettings.ts` | `useState<WorkbenchSettings>` 字面量初值补 `autoSummonExperts: false` |
| `src/api/routes.ts` | **超出 P1 清单**：GET 合并 `...readExpertSettings(db)`；POST `writeExpertSettings(db, {autoSummonExperts: body.autoSummonExperts})`（只认真 boolean） |
| `tsconfig.build.json` | include 追加 4 个新源文件（不加则 `node --test` import `lib/` 会 `ERR_MODULE_NOT_FOUND`） |

## 通过的断言 ID

`AX-E01`–`AX-E06` **全部 pass**（测试名以 `AX-E0x` 前缀直接对应，见测试文件）。无 fail、无 skipped。

| 断言 | 关键覆盖（实际断言内容） |
|---|---|
| AX-E01 | 新库 seed 后有 expert 两个字典种子；**已有 schema 19 的旧库**再 seed 补入且 `SCHEMA_VERSION` 不变；用户改过的字典不被覆盖 |
| AX-E02 | 缺失 / `'yes'` / `''` / `'null'` / `'0'` / 字符串 `'false'` → 关；只有真 boolean 与真值标记 `'1'` 算开；POST 真 boolean 后 GET 一致且其他字段不变 |
| AX-E03 | 同 session 同 request 复用不新建；不同 request → `generation-conflict`；同会话的 task/knowledge 草稿不受影响 |
| AX-E04 | 相同旧版本并发更新只有一个成功，另一个 `draft-version-conflict` 且不丢新内容；同内容重提交 `changed=false` 且保留 validation；内容不同则清 validation 并回 `editing` |
| AX-E05 | `../`、UNC、`C:/`、反斜杠、百分号编码、NUL/CR/LF/DEL、Windows 保留名、尾部点/空格、非 NFC、大小写/NFC 碰撞全部拒；根外无任何文件被创建、外部哨兵逐字不变 |
| AX-E06 | 根内任一级 link/junction 拒（即使目标仍在根内）；根自身是链接时默认拒、给出包含边界且真实落点在边界内才放行、指向边界外仍拒；写入路径最终文件是链接也拒 |

## 实际运行命令与退出码（主会话独立复跑，2026-10-05 12:0x–12:2x）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | 0 | 干净（Node v24.19.0 / pnpm 11.7.0） |
| `pnpm build` | 0 | `buildId wb-a6d365e4dc01c490`，188 个输入文件，client 552.64 kB |
| `node --test --test-concurrency=1 test/expertContracts.test.mjs test/expertPaths.test.mjs test/expertProvenance.test.mjs` | 0 | `tests 43 / pass 43 / fail 0` |
| `node --test --test-concurrency=1 test/personaParse.test.mjs test/personaLibrary.test.mjs test/capabilities.test.mjs` | 0 | `tests 80 / pass 80 / fail 0` |
| `node --test --test-concurrency=1 test/db.test.mjs` | **1** | `tests 9 / pass 8 / fail 1` —— 失败只在 `finally` 的 `removeTempDir`（`test/db.test.mjs:35`，EPERM），**仓库既有 Windows 清理期问题**，见 §环境备注 |
| `node "docs/tasks/ed644638-…/evidence/p1-settings-http.mjs"` | 0 | 真实 HTTP GET/POST 6/6 pass（本批新增证据，补 P1 无路由测试的缺口） |

## 路径负例清单（AX-E05 / AX-E06 实际拒绝的形态）

`../`、`a/../../b`；UNC `\\server\share`、`//server/share`；盘符 `C:/x`、`C:x`；反斜杠 `a\b.md`；百分号 `a%2e%2e/b.md`、`%00`、`caf%25e9.md`；控制字符 NUL/CR/LF/DEL；Windows 保留名 `CON`/`nul.md`/`COM1.txt`；尾部点/空格 `a.md.`、`a.md `；非 NFC `cafe\u0301.md`；大小写与 NFC 折叠后同路径（`A.md` vs `a.md`、`Sub/A.md` vs `sub/a.md`）；空段/`.` 段/超深（>4 层）；skill 名非法（`A/a.md`、65 字符、`a-/b.md`、单段 `a.md`）；非白名单扩展名；保留文件名（`publication.json`/`provenance.json`/`workbench-install.json`/`install-journal.json`）。链接：根内任一级 symlink/junction、目标文件本身是链接、根本身是链接（默认拒 / 边界内放行 / 越界拒）。真实写入路径上也验证了「根外没有被创建任何文件、外部哨兵逐字不变」。

## 关键行为（供 P2 直接复用，勿另造同义实现）

- **设置只有一个 meta 键** `expert_auto_summon`：写入只接受真 boolean（落库 `'true'`/`'false'`，传别的返回 `false` 不写）；读取 `'true'`/`'1'` 为开，其余（含脏值）一律 false —— 默认关闭的功能 fail-closed。
- **草稿 CAS 是数据层性质**：`UPDATE task_drafts SET payload_json=? WHERE id=? AND kind_code='expert' AND status_code='pending' AND json_extract(payload_json,'$.contentVersion')=?`，0 行 → `draft-version-conflict`；同内容 `changed=false` 且保留 validation；内容变则版本 +1、清 validation、回 `editing`；`installing` 阶段一律 `install-in-progress`。
- **同 session 去重**在 SQLite 短事务内「查已有 → 复用或冲突 → 新建」，不只靠 UI 防连点；查询按 `kind_code='expert'` 过滤，不会误伤 task/knowledge 草稿。
- **暂存文件上限只判字节**（128 KiB）；字符上限是可选参数 `maxChars`（正文类由调用方显式传），归档原件与完整许可文本允许超过 20000 字符。
- **锁三档**：活 owner → `install-busy`（恢复路径 `install-in-progress`）；同主机死 owner → 回收后自己重抢；读不了/形状坏/别的主机/进程状态不明 → `install-lock-owner-unknown` 且**不强删**。释放时重新读盘比对 token，绝不删别人的锁。

## 未验证项目与原因

- 全部是**单元/仓储层**证据；没有起真实宿主、没有注册 skill provider、没有起子代理、没有真实 LLM 调用（P4/P6/P9 范围）。
- 设置页 **UI 开关未加**（方案把它放在 §9.3，属 P5/P8）；本批只保证服务端读写与 GET/POST 接线。
- 暂存 / 提交 / 校验 / 确认 / 放弃 / 安装器 / 恢复 / catalog / 手动 request / 子代理调用**全部未实现**（P2+）。正式库 `~/.dsh/workbench/personas|skills` 仍为空，未写入任何文件。
- 来源许可校验只做**本地结构校验**，不联网核验仓库/commit（设计如此，§3.3 第 7 条）。
- `connectWorkspace` 的 `reuseOrCreateBlank` 行为本批未复跑（P0 已记录取证结论）。

## 当前下一批前置条件（P2）

- ✅ P1 导出就位并通过独立复跑；✅ `SCHEMA_VERSION` 仍 19、无新 migration；✅ `DraftKind`/`WorkbenchSettings` 形状已扩。
- P2 需要：`pnpm add yaml@2.9.1`（本仓 `node_modules` 与 `pnpm-lock.yaml` **都还没有 yaml**；宿主 profile 有 2.9.1，网络可达）。
- **新增源文件必须同步追加进 `tsconfig.build.json` 的 include**，否则 `node --test` import `lib/**` 会 `ERR_MODULE_NOT_FOUND`（P1 已踩到）。
- 直接复用 P1 导出：`validateExpertRelativePath` / `checkExpertRelativePathShape` / `assertNoLinksInsideRoot` / `atomicWriteText` / `withExpertInstallLock` / `readExpertTextFile` / `stableJson` / `sha256Hex` / `expertManifestHash` / `parseExpertProvenance` / `validateExpertSourceFiles` / `lookupFromStagedFiles` / `updateExpertDraftCas` / `getPendingExpertDraftForSession` / 全部 `EXPERT_*` 限值常量。
- 提交前把本批文件统一成 LF（见环境备注）。

## 规格偏差

1. **`src/api/routes.ts` 超出 P1 清单（+14 行）**：接了设置 GET/POST 的专家开关（否则「字段加了但没接线」）。方案把设置接线放在 P5；P5 复核此处并补 `service.setAutoEnabled`。已用真实 HTTP 独立验证（`evidence/p1-settings-http.mjs`，6/6）。
2. **读开关接受 `'1'` 当真值标记**（写入只写 `'true'`/`'false'`）：与仓库既有布尔 meta 用 `'1'`/`'0'` 的约定兼容。AX-E02 的口径：「脏值」指 `'yes'`/`''`/`'null'` 这类，`'1'` 算开。P9 对账按此口径；若要改成严格只认 `'true'`，须同步改仓储、测试与本文档。
3. **根是链接时 fail-closed**：默认拒，只有显式传 `allowRootLinkUnder`（构造参数注入的 home/数据根边界）才放行。P2/P3 的生产安装器**必须传该边界**，否则「用户把数据根放成链接」的合法布局会被一律拒绝。
4. `EXPERT_TEXT_EXTENSIONS`（`src/shared/expert.ts`）与 `PERSONA_RESOURCE_EXTENSIONS`（`src/shared/persona.ts`）有重复声明：边界判定用后者（`src/experts/paths.ts` 权威），前者仅为类型侧引用 —— 已识别为潜在漂移点。
5. 其余无偏差：接口名、字段、默认值、错误码、限值均按方案 v0.3 §1.4/§3/§12.1–12.2 实现，未改 `SCHEMA_VERSION`、未自造 migration。

## 复核与修复记录（主会话第 2 轮，已回归全绿）

主会话逐文件复核后提出 4 处，子代理只改这 4 处并复跑：

1. `assertNoLinksInPaths` 不再在「根是链接且边界允许」分支提前 `return { ok: true }` —— 中间级链接检查与 realpath 复校照常执行（规格 §3.4 第 1 条要求「根**及已有父目录**都不许是链接」）。补「情形 ③」测试：合法根 + 根内一级 junction 指向真实根外 → 必须拒。**反向注入验证**：把 `return { ok: true }` 装回去后 `expertPaths` 变红（`pass 15 / fail 1`，红的正是 AX-E06 那条），说明新断言真的守得住。
2. `validateStagedFileContent` 默认**只判字节**；字符上限改为显式 `maxChars`（规格只规定每份暂存文件 128 KiB；§3.1 又要求归档原件可超 20000 字符上限且不截断——原实现会让那条「只给 warning」的路径不可达）。
3. 锁记录补 `draftId`（§6.3 要求记录 pid / owner 随机值 / draftId / createdAt）；不传时字段不出现，旧记录缺该字段不算 malformed。
4. 删除 `src/shared/expert.ts` 注释里「本机 Node 24.19.0 的 RegExp 会漏 `$` 校验」的**错判**（`/^a+$/.test('aa') === true`、`/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test('a'.repeat(65)) === true` 都是正确行为；有界量词 `{0,47}` 实测正常）。实现零改动，只把理由改成真实理由：形状模式与长度上界是两件事，这里放在同一处判定以保证只有一份权威判据。

## 规格偏差之外的已知环境事实（不是本批成果）

- 仓库里**另一个会话**正在跑 `scripts/release-preflight.mjs` 与 `scripts/repro/probe-*-mutations.mjs`：它们会删 `lib/`、改源文件再还原 → **`pnpm build` 与 `node --test` 必须写在同一条命令里**，否则会出现与本次改动无关的假红。
- 检出 `probe-listview-mutations.mjs` 被中途终止后遗留的变异：`src/client/components/KnowledgeList.tsx` 的 `knowledgeFilterActive` 被改成 `return false`（正是该探针的第 12 个变异）。主会话用 `git checkout -- src/client/components/KnowledgeList.tsx` 还原（该文件不属于本批改动，也未提交）。
- 仓库本地 `core.autocrlf` 被外部改成 `false`，而 `HEAD` 的 blob 全是 LF、工作树多为 CRLF → 直接把改动 `git add` 会写进**整文件 CRLF churn**。本批 12 个文件已统一成 LF 后再提交，`git diff --stat` 因此只显示真实改动（+51 / −3）。
- `test/db.test.mjs` 清理期 EPERM 是**仓库既有**问题（`docs/releases/v1.16.0.md:134`、`docs/issues/2026-10-05-clear-plan-does-not-refresh.md:60`），与 P1 改动无关；按既有口径记环境欠账，不修改其判据。

## 没有执行的安装/发布操作

未执行 `dsh plugin add/remove`、未改 profile、未重启任何实例、未发布 npm、未打 tag、未触碰 19387。未向 `~/.dsh/workbench/personas` 或 `skills` 写入任何文件。
