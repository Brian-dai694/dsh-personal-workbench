# P3/P4 后端关联设计（日志关联表 / listing_id）

> 状态：**方案，未落代码、未改迁移、未连接正本**（2026-10-29）。
> 依据：`src/db/schema.ts`、`src/db/repo/oplog.ts`、`src/db/asinIdentityV37.ts`、P0 审计报告。
> 下一步需要 Chief 批准后才进 v38；本文件不代表已实现。

## 1. 目标与非目标

**目标**

1. `site + ASIN` 是业务身份；给跨域引用一个稳定的 `listing_id` 文本键。
2. 运营日志从「`asin_json` 自由字符串数组」升级为「0..n 条显式关联」，**旧列逐字节不动**。
3. 关联能表达角色（父/子/SKU/未知），但不推断父子关系。

**非目标（本阶段不做）**

- 不切换读路径（v1 仍是唯一读源）。
- 不改 `oplog_entries` 既有列，不做数据回写。
- 不建价格/BD 台账（只留扩展位）。
- 不在正本上跑任何迁移。

## 2. `listing_id` 的定义

```ts
// src/shared/listingId.ts（P4 新增，纯函数，无 schema 依赖）
export function listingIdOf(site: string | null, asin: string): string {
  const s = (site ?? '').trim().toUpperCase()
  const a = asin.trim().toUpperCase()
  return `${s === '' ? 'UNKNOWN' : s}_${a}`   // 与导出键 productKey 完全一致
}
```

- **是派生键，不是新主键**：规范身份仍是 `(site, asin)`；不引入 UUID 映射表。
  理由：导出/回导已经在用 `US_<asin>` / `UNKNOWN_<asin>`（`shared/asinExport.ts:44`），
  再发一套 UUID 会让「备份能不能回导」变成两套口径。
- ASIN 字符集是 `[A-Z0-9]{10}`，`_` 不会出现在 ASIN 里，分隔符安全。
- 空站点必须是 `UNKNOWN_`，**不得写成 `US_`**。

## 3. `oplog_entry_associations`（v38，只增表）

```sql
CREATE TABLE IF NOT EXISTS oplog_entry_associations (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES oplog_entries(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,              -- 保留用户在日志里的输入顺序
  role        TEXT NOT NULL DEFAULT 'unknown', -- parent | child | sku | unknown
  site        TEXT,                          -- 可空：站点未知就是 NULL，不猜 US
  site_key    TEXT NOT NULL DEFAULT '',      -- COALESCE(site,'')，只为让唯一约束可用
  asin        TEXT NOT NULL DEFAULT '',
  sku         TEXT,                          -- role='sku' 时填
  sku_key     TEXT NOT NULL DEFAULT '',
  shop_id     TEXT,
  listing_id  TEXT NOT NULL,                 -- listingIdOf(site, asin)，冗余但便于跨表 join
  source      TEXT NOT NULL DEFAULT 'legacy',-- legacy | manual | import
  created_at  TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_oplog_assoc_identity
  ON oplog_entry_associations(entry_id, role, site_key, asin, sku_key);
CREATE INDEX IF NOT EXISTS idx_oplog_assoc_entry ON oplog_entry_associations(entry_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_oplog_assoc_listing ON oplog_entry_associations(listing_id);
```

要点：

- **SQLite 的 UNIQUE 对 NULL 不生效**，所以用 `site_key` / `sku_key` 折叠空值；`site` 本身保留 NULL，
  读出来仍是「未知」而不是空串。
- `ON DELETE CASCADE` 需要 `PRAGMA foreign_keys=ON`（现有迁移是否开启需 P4 实测；否则用仓储层显式删）。
- 一个日志可有 0..n 条；`ordinal` 允许同一日志里两个相同 ASIN 出现在不同角色（父/子）。

### 回填（v38 同一事务）

```text
for each oplog_entries row:
  asins = JSON.parse(asin_json)          # 顺序即 ordinal
  for i, asin of asins:
      INSERT OR IGNORE association(role='unknown', site=row.site, asin=normalize(asin),
                                   source='legacy', ordinal=i)
```

- `role` 一律 `unknown`：**不从前缀、不从上架时间、不猜父子**。
- `site` 取日志自身的 `site`；那条 `site=NULL` 的历史日志保持 NULL（P0 已点名 `oplog-20261027033640667-6c6ea497`）。
- `asin_json` **不重写**（验收：回填前后 `asin_json` 逐字节一致，8 条存量）。

## 4. 读写契约（P4 只在仓储层，不改 HTTP 形状）

| 场景 | 规则 |
|---|---|
| 新建/编辑日志，新客户端 | `associations: [{site, asin, role, sku?}]`；`site` 可省，省则继承日志 `site`；仍无站点则 NULL |
| 新建/编辑日志，旧客户端 | `asins: string[]` 兼容，落成 `role='unknown'`、`site=日志 site` |
| 同时传两者 | 400（不静默二选一，避免"我改了却没生效"） |
| 读单条/列表 | 返回 `associations[]`（按 ordinal）；`asins[]` 由关联派生（`role != 'sku'`），旧字段继续可用 |
| 按 ASIN 反查日志 | 走 `idx_oplog_assoc_listing`，不再 `LIKE` 扫 `asin_json` |

`OplogDraft` 增加可选 `associations`，`OplogEntry` 增加 `associations`；旧代码只读 `asins` 不变。

## 5. 回滚

- 只增表：`DROP TABLE oplog_entry_associations` 即回到现状；旧 `asin_json` 未被改写，读路径无感。
- 回填是 `INSERT OR IGNORE`，可重复执行（幂等）；失败只影响新表。
- 读切换（P5）前设置开关 `oplogAssocRead`，默认 `off`，出问题按开关回退，不靠回滚数据。

## 6. 价格/BD 的扩展位（P4 只定形，不建表）

三张表按「事实 / 当前配置 / 未来计划」分开，全部以 `listing_id` + 日期为键：

| 表 | 语义 | 关键列 |
|---|---|---|
| `price_facts` | 观测到的价格（导入/抓取） | `listing_id, observed_at, price, currency, source` |
| `price_config` | 当前生效配置（谁改的、何时改） | `listing_id, price, effective_from, note` |
| `bd_plans` | 未来计划（BD/秒杀排期） | `listing_id, starts_at, ends_at, type, discount` |

缺失一律 `unknown`，**不许用计划回填事实**，也不把测算情景当价格事实。

## 7. 已发现的问题（P4 一并处理，不在本轮改）

1. **`shopName` 被写成 `shopId`**：`repo/oplog.ts:226` `shopName: draft.shopId`。
   新日志的店铺名会变成店铺 id（如 `US_sellerId`），列表按店铺名分组就会串。修法：
   `OplogDraft` 增加 `shopName`，路由按 `shop_id` 查 `asin_stores` 补名；查不到就存 null，不编。
2. **日志 `site` 与 ASIN 可能冲突**：一条日志 `site='US'` 但 ASIN 属于 DE。P4 允许每条关联自带 `site`
   覆盖日志默认值，冲突时以关联为准并进复核队列（不静默改日志站点）。
3. **`findOpenTaskByAsin` 只看 `tasks.extra.asin`**：多站点下同一 ASIN 会互相堵塞，P4 需按 `(site, asin)`
   匹配，找不到 `site` 的历史任务进复核。

## 8. 迁移与验收

- 版本号：**v38**（v37 已占用），只增表 + 回填，单事务；二次执行 0 新增。
- 验收（副本/fixture，禁止正本）：
  1. 8 条存量日志 → 关联行数 = 各条 `asin_json` 项数之和（10 个 ASIN，5 条多 ASIN）；`role` 全 `unknown`。
  2. `asin_json` 前后逐字节比较一致；NULL site 那条关联的 `site` 仍为 NULL。
  3. 新建 `{site:'US',asin}` + `{site:'DE',asin}` 两条关联同一日志：读回顺序与角色正确，`listing_id` 不同。
  4. 旧客户端只传 `asins[]` 仍可创建；同时传两者 400。
  5. 删除日志 → 关联随 CASCADE（或仓储显式）清空，不留孤儿。
  6. 反查：`WHERE listing_id='US_<asin>'` 能命中且不走全表扫描（EXPLAIN QUERY PLAN 含索引）。

## 9. 待确认

- `PRAGMA foreign_keys` 在现有连接里是否开启（决定 CASCADE 能不能依赖）。
- 日志编辑界面允许同一 ASIN 同时是父与子吗？如果产品上不允许，唯一索引要加 `role` 之外的约束。
- `listing_id` 是否需要进导出 JSON（目前导出键已是等价形式，建议不加，避免两套键）。
