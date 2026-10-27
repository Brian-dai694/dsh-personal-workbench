# 搜索词大报表被 256KB 默认请求体上限误杀

- 首次发现：2026-10-22
- 影响版本：1.17.0（装盘实测）及更早
- 严重度：P0（模块主路径不可用）
- 状态：已修（源码 + 回归测试），**尚未装盘**

## 现象

`POST /api/workbench/amazon/datasets/parse-file` 与 `POST /api/workbench/amazon/datasets`
在请求体超过 256KB 时返回：

```json
{ "error": "invalid JSON body" }
```

HTTP 400。

文案指向"JSON 不合法"，但请求体是完全合法的 JSON —— 真实原因是**太大**。

## 影响

- `parse-file`：模块内声明的 `MAX_FILE_BASE64 = 10MB`（约 7.5MB 源文件）**永远到不了**——
  更大的文件在读取请求体时就已被拒。真实搜索词 Excel（几千行）base64 后通常数百 KB 到数 MB，
  基本必然触发。
- `POST /`（rows）：几千行搜索词报表的 rows JSON 本身就有数百 KB，同样被拒。
- 表现为"导入按钮点了没反应/报 JSON 不合法"，用户无从判断该去筛选还是改文件。

## 根因

`src/api/routes/amazon-datasets.ts` 的 handler 在所有分支之前统一读体：

```ts
const body = ['POST', 'PATCH'].includes(method) ? await readJsonBody(req) : undefined
```

`readJsonBody` 的默认上限是 **256KB**（`src/api/http.js`）。而同一文件里
`MAX_FILE_BASE64`（10MB）、`MAX_ROWS_BODY` 这类"按端点该有多大"的口径压根没接到读体上。

此外 `readJsonBody` 超限与 JSON 语法错误**返回同一个 `undefined`**，
调用方无法区分，只能一律报 400 —— 这就是错误文案误导的来源。

## 证据

读代码 + 装盘实测（1.17.0，`/parse-file` 不落库，可安全探测）：

| 请求体 base64 长度 | 结果 |
| --- | --- |
| 98KB | 200/400 进入处理逻辑（内容非法时报"不是有效的 .xls/.xlsx 工作簿"） |
| 293KB | `400 {"error":"invalid JSON body"}` |

同一端点在同一个实例上，98KB 能进处理逻辑、293KB 直接被拒，与 256KB 默认值一致。

## 修法

`src/api/routes/amazon-datasets.ts`：

1. 按端点给上限，不再吃默认值：
   - `parse-file`：`MAX_FILE_BASE64 + 2MB`（base64 之外的 JSON 外壳余量）
   - `POST /`（rows）：8MB（与 `aba-keywords` 的 8MB 同一档）
   - `PATCH`：1MB（reviews / summary 都是小体量）
2. 读体前用 `content-length` 预判，超限直接回 **413 + `code: 'too-large'`**，
   不再让用户看到"JSON 不合法"。
3. 没有 `content-length`（chunked）时仍落到读体上限，安全边界不变。

## 回归

`test/amazonDatasetRoutes.test.mjs` 新增一条：

- 约 300KB 的 CSV（base64 约 400KB）走 `parse-file` → 200 `format: 'text'`
- 4000 行 rows（约 400KB）走 `POST /` → 201，行数 4000
- PATCH 1.2MB 体 → 413 `too-large`

验证：`pnpm build` 通过；`node --test test/amazonDatasetRoutes.test.mjs` 8/8 通过。

## 遗留（未做，建议单独评估）

1. **报表无来源与去重**：`amazon_datasets` 表只有 `source_code`（paste/import），
   没有源文件名、文件哈希、行数快照。同一份报表导两次会变成两份数据集，
   而 ABA 对照导出取的是"最新一份搜索词报表"，口径会跟着最后一次导入漂移。
   建议加 `source_name` / `content_hash` 两列并在导入时做重复提示（不是静默去重）。
2. **非法行报错没有行号**：`rows 中存在不合法的行（关键词为空或指标不是非负数字）`。
   整体拒绝是既定设计（不做部分导入），但应指出第一处非法行的下标，
   否则几千行里找那一行只能靠猜。
