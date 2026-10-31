## [14:31] - 功能实现: Amazon 测算新增飞机盒 / 外箱装箱 3D 预览组件

- **文件**: src/client/components/PackageBox3D.tsx; src/client/components/CartonBox3D.tsx; src/shared/cartonPacking.ts; src/client/views/AmazonToolsView.tsx; src/client/styles.ts
- **决策**: 两个组件都用纯 CSS 3D（零依赖 / 无 WebGL）。适配比例由 8 个顶点在整圈水平角上的最大投影反解 px/单位，盒体投影恒 ≤ 380×380 并居中；外箱内盒按"单一朝向"枚举 6 种摆放取最大；内盒直接取包裹尺寸，不另存一份（避免预览与面板两套结论）。
- **验证**: `tsc --noEmit` exit 0；`dev-install` 构建 + 打包 + 装盘指纹逐文件一致（588 文件）；重启后用户确认两个 3D 均正常渲染。

## [14:31] - 配置变更: 插件装盘

- **文件**: ~/.dsh/profiles/desktop/package.json; pnpm-lock.yaml
- **决策**: 用 `scripts/dev-install.mjs --profile-dir ... --apply` 装盘，构建戳 `...-20261030-142222`。
- **验证**: 门禁 `dsh --dump-config` 报 `Unsupported command: --profile web --dump-config`；实测 `dsh --profile desktop --dump-config` 返回 `profile "desktop" is managed exclusively by the Electron application` —— desktop profile 归 Electron 托管，CLI 无法 dump，该门禁在本机永远过不了，属环境限制而非构建问题。其余三条（指纹 / 版本+schema / 增量 diff）全绿。

## [14:31] - 坑: CSS 3D 里绝对定位元素用 left:50% 必须再减自身一半

- **文件**: src/client/components/CartonBox3D.tsx; src/client/styles.ts
- **决策**: `.wb-carton3d-ibox` 的 `left: 50%` 是**左上角**落在容器中心，`translate3d` 就成了"相对容器中心 + 半个自身宽"的偏移，整组内盒稳定偏右半个间距。改成 `left: calc(50% - var(--iw) / 2)` 后归位。
- **验证**: 用 getBoundingClientRect 逐件比对箱心，修正后 2×2 阵列左右对称。
