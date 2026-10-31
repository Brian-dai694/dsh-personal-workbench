# 选品库 `site + ASIN` 客户端合同（P2）

> 状态：**已锁定**（2026-10-29）。后端实现见 `src/api/routes/asin.ts`、`src/db/repo/asin.ts`；
> 合同测试见 `test/asinIdentityClientContract.test.mjs`。前端 `ApiError` 按本文解析即可。

## 1. 响应信封

所有 `/api/workbench/asin/*` 响应都带 `ok`，由 `src/api/http.ts` 的 `apiOk` / `apiError` 产生。

```jsonc
// 成功
{ "ok": true, /* …payload */ }

// 失败（真实形状 —— 文案字段是 error）
{ "ok": false, "error": "ASIN B0XXXXXXXX 在多个站点存在（DE / US），请显式传 site",
  "code": "identity_required", "asin": "B0XXXXXXXX", "candidates": [{ "site": "DE" }, { "site": "US" }] }
```

**字段名只有一个：`error`。** 不存在 `message` 字段，前端 `ApiError.message` 取 `body.error`。

> 背景：`apiError` 有意把文案放在顶层 `error`（`http.ts:84-96`，决策 2），
> 因为 `client/api.ts` 一直读 `body.error`；改成 `message` 会让全站错误提示退化成
> `HTTP 4xx（path）`。合同测试里专门断言了 `body.message === undefined`，防止两边各写一套。

## 2. 错误码

| HTTP | `code` | 何时出现 | 附加字段 | 前端建议 |
|---|---|---|---|---|
| 400 | `site_required` | 写操作（创建/编辑/关注/判断/立项）缺 `site`，或 `?site=` 为空串 | `asin`（可能为空串，例如新建表单还没填） | 提示补站点，不发重试；不要自动填 US |
| 409 | `identity_required` | 读单条/批量/导出时同一 ASIN 有多个站点，未指定 `site` | `asin`、`candidates` | 弹站点选择，让用户按站点重发 |
| 409 | `site_mismatch` | 显式 `site` 与该 ASIN 已有行的站点不一致 | `asin`、`candidates` | 提示「刷新后重试」；P2 读路径仍是 v1，不按 site 取另一行 |
| 400 | （无 code） | 其余参数错（如 `site=USA`、ASIN 格式、请求体非法） | — | 走通用文案分支，只展示 `error` |

`candidates` 形状：`Array<{ site: string }>`，站点两位大写、按字母升序。
**`shopName` 目前不提供**，前端不要假设该字段存在。

## 3. 类型（可直接抄进 `src/client`）

```ts
export interface ApiFailure {
  ok: false
  error: string            // 中文文案，直接展示
  code?: 'site_required' | 'identity_required' | 'site_mismatch'
  asin?: string
  candidates?: Array<{ site: string }>
}

export interface AsinIdentityRef { site: string | null; asin: string }

// shared/asinImport.ts 里已改好；视图侧别再复制一份旧类型
export interface AsinProductSiteFields {
  site: string | null                       // null = 身份未定，绝不是 US
  identityState: 'ok' | 'needs_site'
}
```

`client/api.ts` 抛出（参数顺序以现有实现为准）：

```ts
class ApiError extends Error {
  constructor(message: string, status: number, code: string | null)
  readonly status: number
  readonly code: string | null
}
```

## 4. 端点规则

| 方法与路径 | 身份参数 | 成功响应要点 |
|---|---|---|
| `GET /asin` | `?site=` 可选（列表筛选） | `products[].site/identityState`、`facets.sites` 是 `[{value,count}]`（不是字符串数组，空站点不入选） |
| `GET /asin/:asin/trend` | `?site=` 可选；唯一匹配可通过 | `{ asin, site, points }` —— `asin` 回显大写，`site` 是解析结果（`null` 表示该行无身份） |
| `POST /asin` | `?site=` **必填**（body 的 `site` 兼容，query 优先） | 201，`{ product, facets }`；重复 ASIN → 409（无 code，带业务文案） |
| `PATCH /asin/:asin` | `?site=` **必填** | `{ product, facets }`；`site` 不能通过 PATCH 改（等于换身份，会被拒） |
| `PATCH /asin/:asin/watch` | `?site=` **必填** | `{ watch }` |
| `PATCH /asin/:asin/judgment` | `?site=` **必填** | `{ judgment, facets }` |
| `POST /asin/:asin/task` | `?site=` **必填** | `{ taskId, title, dueAt }`；已有未完成任务 → 409 + `existingTaskId` |
| `POST /asin/batch` | `items:[{site,asin}]` 优先；旧 `asins:string[]` 兼容 | `{ action, affected, missing, tag, facets }`；任一条歧义整体 409，不静默丢项 |
| `GET /asin/export` | `?asins=` 支持 JSON 对象数组或旧逗号列表 | `{ path, products, stores, bytes }`；歧义整体 409，**写文件之前**返回 |
| `POST /asin/import` | 文件里带 `site` 就用，缺失保持 `null` | `{ inserted, snapshots, rejected, firstReason, stores, judgmentRestored, judgmentFailed, facets }` |

导入纪律：缺 `site` 的商品照常入库但 `identityState='needs_site'`；该类商品的判断恢复跳过并计入 `judgmentFailed`，**不回填、不猜站点**。
导出键：站点未知写 `UNKNOWN_<ASIN>`，回导仍归 `needs_site`。

## 5. 站点归一

- 任何入口的 `site`：`trim().toUpperCase()`；空串等价缺省（写操作即 400，读操作即「未指定」）。
- 只接受两位字母 `^[A-Z]{2}$`；其他格式 400（无 code）。
- **未知站点绝不回填 US**；前端草稿/表单里 `null` 保持空串逼用户选。

## 6. 已知边界（P2）

- 读路径仍是 v1 单行（`asin_products` PK 是 `asin`）；v37 影子表已建但未切读。
  因此「同一 ASIN 两个站点分别读取」要等 P5，P2 只保证**不静默选一个**。
- 批量一次只能一个站点；跨站点会在解析阶段 409（`site_mismatch` 或 `identity_required` + 并集候选）。
- 仓储函数内部仍保留「唯一匹配兼容」（供工具/迁移）；HTTP 写入口已强制 `site`。

## 7. 验证

```bash
pnpm typecheck
pnpm build
node --test test/asinIdentityClientContract.test.mjs   # 9/9：信封与字段名
node --test test/asinIdentityCompat.test.mjs           # 后端行为
```

合同测试全部用 `:memory:` 数据库，并在导出用例里把 `HOME`/`USERPROFILE` 指向临时目录，
不会打开也不写入 `~/.dsh/workbench/workbench.db`。
