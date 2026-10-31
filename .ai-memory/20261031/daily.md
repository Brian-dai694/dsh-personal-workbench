# 2026-10-31

## [11:25] - 功能实现: Amazon 测算界面重排（信息分层 + 单位贴数字 + 口径折叠）

- **文件**: src/client/views/AmazonToolsView.tsx; src/client/styles.ts; docs/design/2026-10-31-calculator-ui-pass.md
- **决策**:
  - 销售佣金字段此前是"金额 + 15% 后缀"双口径 → 只读金额按两位小数显示，`%` 后缀只给真正的百分比字段。
  - `%` 后缀改为绝对定位进输入框内部右缘（`has-suffix` + `padding-right`），不再被 flex 推到 241px 输入框最右端。
  - 8 个指标分两层：4 条结论 + 「核对明细」标题下的 4 条核对数值（字号小一档、标签用 tertiary）。指标共用一个"表格"边框，明细去掉上边框。
  - 「恢复默认值」从整行宽按钮收进底部动作行（保存状态在左、按钮在右）；计算口径收进原生 `<details>`，默认折叠。
  - 顶部按钮「保存参数」→「保存到本机」，与状态文案统一措辞。
  - 没做 sticky 结果列：结果块高于视口时 sticky 会让底部「带入 AI 协助」永远够不到，宁可滚动。
- **验证**: SSR 真实组件渲染核对（1120/860/520 三档 + 深浅主题）；`pnpm typecheck` 0 错；`pnpm build` 通过；全量 1713/1715（两条红灯来自并行会话的 PackageBoxThree 字面色与 shared 单端模块）；`dev-install --no-build --apply` 598 文件逐文件一致、schema 39=39。

## [11:25] - 配置变更: 插件装盘（产品库 + 测算两轮 UI 一起）

- **文件**: ~/.dsh/profiles/desktop/package.json; pnpm-lock.yaml
- **决策**: 构建戳 `...-20261031-112319.tgz`（带 three 的 1.62MB client bundle）。门禁「插件树组装 `dsh --profile web --dump-config`」仍报 `Unsupported command` —— desktop profile 归 Electron 托管，本机永远过不了，属环境限制；其余三条（指纹 598/598、版本+schema、零增量 diff）全绿。
- **验证**: 装盘产物里能搜到两轮改动的新文案（`手动录入` / `核对明细` / `保存到本机`），说明打包内容正确；需重启 DSH 才生效（客户端 bundle 有 rev 缓存）。

## [10:52] - 功能实现: 产品库加入「手动录入」并重做界面

- **文件**: src/client/views/ProductLibraryView.tsx; src/client/hooks/useProductLibrary.ts; src/client/components/ProductFactForm.tsx（新）; src/client/productFactDraft.ts（新）; src/api/routes/products.ts; src/db/repo/products.ts; src/db/repo.ts; src/client/app/WorkbenchBody.tsx; src/client/views/AsinView.tsx; src/client/styles.ts
- **决策**:
  - 产品库切到**独立 `products` 表**（migration 39 的既定边界：不回填、不读写 `asin_products`），客户端从 `/api/workbench/asin` 改为 `/api/workbench/products`；两张表互不写入，P3 边界因此是物理的。
  - 补全单条写通道：`POST /products`（409 + `code:'duplicate'`）、`PATCH /products/:id`（身份字段拒绝，`code:'immutable_field'`）、`DELETE /products/:id`（第二次 404）；`:id` 用 `站点_ASIN`，省掉"站点与 ASIN 不匹配"分支。
  - 两张表无关 ⇒ 从选品页落地多半查不到那条：空态给"把「B0XXX」录入产品库"的预填 CTA，而不是让人回去抄 ASIN。
  - 行内操作改**常显**（旧版藏 hover 里，触屏等于没有编辑入口）；重拉时只淡化表格不撤掉。
  - 分面计数按全库算（与 `asinFacets` 同口径），否则每次筛选下拉数字都缩水。
- **验证**: `pnpm typecheck` exit 0；`pnpm build` 通过；全量 `node --test` **1713 通过 / 1 失败**——唯一红灯是 `architecture.test.mjs` R1（`shared/cartonPacking`、`shared/packageCalculator` 单端），来自 10/30 飞机盒 3D 那次会话的未提交新增，与本次改动无关（本次没动 `src/shared/`）。

## [10:52] - 坑: `.wb-empty-title` / `.wb-empty-desc` 被 6 个视图用了却一直没有样式

- **文件**: src/client/styles.ts
- **现象**: 空态里标题与说明同样大小、同样颜色，看起来像"加载失败"而不是"这里还没有数据"。
- **结论**: 类名先落地、样式后补是这类"看着没设计"的常见来源；新增界面时先 grep 类名是否真有规则，别假设它存在。本次补了这两条（6 个列表页一起受益）与 `.wb-btn.danger`。

## [10:52] - 坑: 产品库身份字段的校验顺序会给出误导文案

- **文件**: src/db/repo/products.ts
- **现象**: 站点校验套了 `text(value,'站点',2)`，填 `USA` 报的是"站点不超过 2 个字符"——用户会以为是长度限制，而不是"必须是两位字母"。
- **结论**: 枚举型字段先判**格式**再判长度；`text(...,max)` 适合自由文本，不适合站这类封闭语义。
