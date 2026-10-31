/**
 * 工作台全部样式（从 index.tsx 抽出，便于维护）。
 *
 * 颜色策略（v1.14.5 起）：**先映射到我们自己的 `--wb-*` 令牌层，再由它引用宿主
 * `--dsw-alias-*`**。原先直接写 `var(--dsw-alias-xxx, <深色回退>)`，令牌拿不到时
 * 会回退成深黑 —— 这是本插件最严重的一次视觉事故的成因，细节见
 * `entryContract.ts` 的 `tokenLayerCss()`。
 *
 * 令牌层函数放在 `entryContract.ts`：那边进构建产物、能被 `node --test` 直接断言；
 * 本文件只在打包进浏览器 bundle 时参与，测不到。
 *
 * 结构：令牌层 → 宿主注入钩子 → 布局 → 组件 → 弹窗/toast → 响应式。
 */
import { ACTIVE_ATTR, OFFICIAL_ATTR, PENDING_ATTR, VIEW_ATTR } from './constants.js'
import { panelContainerCss, toWorkbenchTokens, tokenLayerCss, zLayerCss } from './entryContract.js'

const RAW_CSS = `[data-pane='conversation'], [class*='centerCol'] { position: relative; }
[${VIEW_ATTR}] {
  position: absolute; inset: 0; display: none; z-index: var(--wb-z-content);
  background: var(--dsw-alias-bg-base, #111); color: var(--dsw-alias-label-primary, #eee);
  font-family: var(--dsw-font-family, system-ui); overflow: hidden;
}
/* ---------------------------------------------------------------------------
   面板容器的可见性（v1.14.0；2026-09-12「点工作台→整片空白」事故的直接修复）
   ---------------------------------------------------------------------------
   规则本体在 entryContract.ts 的 panelContainerCss()：那里可被单测锁住，
   而本文件的 CSS 只进浏览器 bundle、测不到。这里只负责拼接。
   v1.14.53：DOM 降级腿已删除，容器只剩官方 shell.overlay 一个 ——
   "两份容器二选一"那套门控（含 BLOCKED_ATTR）随之消失。
   --------------------------------------------------------------------------- */
${panelContainerCss({ view: VIEW_ATTR, official: OFFICIAL_ATTR, active: ACTIVE_ATTR }).join('\n')}
/* 面板容器（挂在**始终存在**的 shell.overlay 里）：由自己的 data-open 决定显隐。
   为什么不用宿主给的高度链：宿主 main 容器外面套了一层 display:contents 中转节点，
   它可能在组件挂载之后才定高，依赖 height 会偶发 0 高度（面板"挂上了却看不见"）。
   为什么是 fixed 而不是填满格子：需要一个不依赖宿主布局的稳定容器。

   ⚠️ 两条硬约束（2026-09-15 用户实测踩到）：
   1. **不能盖住左侧导航栏**。容器本身 pointer-events:none、只有面板本体 auto，
      点击直接穿透到 DSH 侧栏；同时从 --wb-sidebar-w（运行时量出的侧栏宽度）开始铺，
      视觉上也不压住侧栏。改造前的覆盖层贴在会话列里，左侧栏一直是可用的。
   2. **开合只切 display，不卸载组件** —— 草稿弹框要跨页面常驻，
      依赖 useEffect 拉数据的区块（今日容量）也不能被反复重建。 */
.wb-panel-host {
  /* 左边界 = 运行时量出的侧栏宽度（--wb-sidebar-w，见 index.tsx 的 syncSidebarWidth）。
     ⚠️ 兜底值**不能是 0**（v1.14.54 真实事故）：一旦量宽失败，left: 0 会让面板从视口
     最左边铺起、把整个 DSH（含侧栏）盖住 —— 用户"侧边栏都没有了"。
     用 DSH 侧栏的默认宽度 280px 兜底：最坏情况是边界偏一点，而不是遮住导航。
     v1.15.5：侧栏**收起**时这个变量会被明确写成 0px（判据见 panelGeometry.ts），
     于是面板跟着铺满 —— 收起后铺不满正是旧口径把 0 当成"量取失败"造成的。 */
  position: fixed; top: var(--wb-top-inset, 0px); right: 0; bottom: 0; left: var(--wb-sidebar-w, 280px);
  z-index: var(--wb-z-panel); overflow: hidden; display: none;
  background: var(--wb-bg-base);
  pointer-events: none;
}
.wb-panel-host[data-open='1'] { display: block; }
/* 面板本体恢复接收事件（容器保持穿透，保证左侧栏可点）。 */
.wb-panel-host > .wb-app-scope { pointer-events: auto; }
/* 样式作用域包装层：组件样式按 [data-...-view] 后代作用域书写，这里必须撑满并可见
   （它**不能**同时是 .wb-panel-host，否则会命中 [data-...-view] 的 display:none 基线规则）。 */
.wb-panel-host .wb-app-scope { height: 100%; min-height: 0; }
/* 兜底：**内容为空时绝不拦点击**（v1.14.28）。
   2026-09-13 真实事故：宿主面板状态读不到时容器被永久置为 data-open="1"，
   一张 2280×1377 的空层盖住会话区与 task-board，用户"除左栏外什么都点不了"。
   这条规则保证"空层"即使处于显示态也不会吃掉点击。 */
.wb-panel-host > .wb-app-scope:empty { pointer-events: none; }
.wb-panel-host > [${VIEW_ATTR}] { position: static; inset: auto; z-index: auto; height: 100%; }
.wb-panel-fill { height: 100%; min-height: 0; }
/* v1.14.53 删掉了「自建入口行上的红点」规则（html[pending] [entry]::after）：
   DOM 降级腿删除后没有自建入口行了，待确认计数改由工作台内的「待处理」胶囊显示
   （见 index.tsx 的 wb-pending-pill）。PENDING_ATTR 仍用于草稿浮卡的定位。 */
.wb-app { height:100%; display:flex; flex-direction:column; }
.wb-h { flex:none; display:flex; align-items:center; flex-wrap:wrap; row-gap: var(--wb-sp-2); min-width:0; gap: var(--wb-sp-5); padding: var(--wb-sp-4) var(--wb-sp-6); border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02)); }
/* 英文标签比中文长：按钮/分段项一律不折行，否则顶栏会出现"两行字"的矮按钮（实测 en-US 截图）。 */
.wb-h .wb-btn, .wb-h .wb-seg { white-space:nowrap; }
.wb-title { display:flex; align-items:center; gap: var(--wb-sp-3); font-size: var(--wb-fs-4); font-weight:700; letter-spacing:.02em; white-space:nowrap; }
.wb-title svg { width:19px; height:19px; color:var(--dsw-alias-state-business-primary, var(--wb-info)); }
.wb-segmented { display:inline-flex; min-width:0; padding: var(--wb-sp-1); border-radius: var(--wb-r-3); background:var(--dsw-alias-bg-base, #111); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.20)); }
.wb-seg { display:inline-flex; align-items:center; gap: var(--wb-sp-2); border:none; background:transparent; color:var(--dsw-alias-label-secondary); padding: var(--wb-sp-2) var(--wb-sp-4); border-radius: var(--wb-r-2); cursor:pointer; font:inherit; font-weight:600; font-size: var(--wb-fs-2); }
.wb-seg svg { width:15px; height:15px; }
.wb-seg.on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent); color:var(--dsw-alias-label-primary); box-shadow: var(--wb-ring-select); }
.wb-sub-segmented { padding: var(--wb-sp-1); }
/* 第四轮 A1：广告组的子页签行（顶栏第二行）。只调这一行自己的内外边距，
   避免和主行的 gap/高度互相拉扯导致顶栏整体变高。 */
.wb-h-sub { padding: 0 var(--wb-sp-6) var(--wb-sp-3); gap: var(--wb-sp-2); }
.wb-sub-segmented .wb-seg { padding: var(--wb-sp-2) var(--wb-sp-5); font-size: var(--wb-fs-1); }
.wb-sub-segmented .count { min-width:17px; height:17px; padding: 0 var(--wb-sp-2); border-radius: var(--wb-r-2); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent); color: var(--dsw-alias-label-primary); font-size: var(--wb-fs-1); display:inline-flex; align-items:center; justify-content:center; }
/* 日期面板的任务页签（计划/逾期/未排期 + 已完成/报告）与下方内容之间必须留呼吸。
   ⚠️ 2026-10-01 用户实测反馈：'计划/已完成/报告"这三个Tab切换控件和下面控件的间隔几乎没有，有点丑'。
   间距加在**页签的 margin-bottom**（而不是内容的 margin-top）：页签共用同一处间距 ——
   否则"计划"（下面先是一行排序按钮）与"已完成"（下面直接是列表）会走出两种间距。
   ⚠️ 2026-10-02 加到五个页签后必须允许换行：窄面板上挤出去的那一个会**整块消失**
   （用户看不到"报告"却不报错），换行只是变两行。 */
.wb-segmented[data-day-tabs] { margin-bottom: var(--wb-sp-4); flex-wrap: wrap; }
.wb-btn { display:inline-flex; align-items:center; gap: var(--wb-sp-2); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26)); background:var(--dsw-alias-bg-layer-1, transparent); color:var(--dsw-alias-label-secondary); border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); cursor:pointer; font:inherit; font-size: var(--wb-fs-2); }
.wb-btn svg { width:15px; height:15px; }
.wb-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 6%, transparent); color:var(--dsw-alias-label-primary); }
.wb-btn.primary { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 16%, transparent); border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 38%, transparent); color:var(--dsw-alias-label-primary); }
/**
 * 破坏性动作（删除）：默认**安静**，只有 hover / focus 才用危险色 ——
 * 常驻红按钮会让"确认删除"看起来像普通操作。颜色只是辅助，文案里始终有"删除"。
 */
.wb-btn.danger { color: var(--wb-danger-ink); border-color: color-mix(in srgb, var(--wb-danger) 38%, var(--wb-line-soft)); }
.wb-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--wb-danger) 12%, transparent); color: var(--wb-danger-ink); }
.wb-btn.danger:focus-visible { outline: 2px solid var(--wb-danger); outline-offset: 3px; }
.wb-body { flex:1; min-height:0; display:flex; }
.wb-nav { flex:0 0 min(56%, 880px); min-width:420px; overflow:auto; padding: 0 var(--wb-sp-6) var(--wb-sp-6); box-sizing:border-box; border-right:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.wb-nav > :first-child:not(.wb-stats-sticky) { margin-top: var(--wb-sp-6); }
.wb-detail { flex:1; min-width:0; overflow:auto; padding: var(--wb-sp-6) var(--wb-sp-6); box-sizing:border-box; }
/* 第三轮：任务页没选中任务时详情区收起，列表吃满整行；选中后回到两栏（列表 56%）。
   只按 data-detail 切，不动组件结构：DOM 仍在、只是不显示，选中回来不用重建。 */
.wb-body[data-detail='collapsed'] .wb-detail { display:none; }
.wb-body[data-detail='collapsed'] .wb-nav { flex:1 1 auto; min-width:0; border-right:0; }
.wb-stats { display:grid; grid-template-columns:repeat(4,1fr); gap: var(--wb-sp-3); margin-bottom: var(--wb-sp-5); }
.wb-stat { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.20)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius: var(--wb-r-4); padding: var(--wb-sp-5) var(--wb-sp-5); box-shadow:var(--wb-sh-2); }
.wb-stat b { font-size: var(--wb-fs-5); }
.wb-stat span { display:block; color:var(--dsw-alias-label-secondary); font-size: var(--wb-fs-1); }
.wb-stats-sticky { position:sticky; top:0; z-index: var(--wb-z-sticky); margin: 0 calc(var(--wb-sp-6) * -1) var(--wb-sp-5); padding: var(--wb-sp-5) var(--wb-sp-6) var(--wb-sp-5); background:var(--dsw-alias-bg-base,#111); box-shadow:none; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24)); }
.wb-card { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26)); background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius: var(--wb-r-4); padding: var(--wb-sp-6); margin-bottom: var(--wb-sp-5); box-shadow:var(--wb-sh-3); }
.wb-card h4 { margin: 0 0 var(--wb-sp-4); padding-bottom: var(--wb-sp-4); border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); display:flex; align-items:center; gap: var(--wb-sp-3); font-size: var(--wb-fs-3); font-weight:700; }
.wb-card h4 svg { width:16px; height:16px; color:var(--dsw-alias-state-business-primary, var(--wb-info)); flex:none; }
.wb-plan { border-left:4px solid var(--dsw-alias-state-business-primary, var(--wb-info)); background: linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 9%, transparent), color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 3%, transparent) 45%, var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)) 100%); }
.wb-plan-item { display:flex; align-items:center; margin: var(--wb-sp-2) 0; font-size: var(--wb-fs-2); }
.wb-plan-num { display:inline-flex; width:20px; height:20px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 16%, transparent); border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 40%, transparent); color:var(--dsw-alias-label-primary); font-size: var(--wb-fs-1); font-weight:700; align-items:center; justify-content:center; margin-right: var(--wb-sp-3); flex:none; }
.wb-plan-note { color:var(--dsw-alias-label-secondary); margin-left: var(--wb-sp-3); font-size: var(--wb-fs-1); }
.wb-plan-scroll { max-height:min(27vh,280px); overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 38%, transparent) transparent; padding-right: var(--wb-sp-1); }
.wb-plan-scroll::-webkit-scrollbar { width:8px; }
.wb-plan-scroll::-webkit-scrollbar-track { background:transparent; }
.wb-plan-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 38%, transparent); border-radius: var(--wb-r-1); }
.wb-plan-expanded .wb-plan-scroll { max-height:min(70vh,720px); }
.wb-plan-footer { display:flex; align-items:center; gap: var(--wb-sp-3); flex-wrap:wrap; margin-top: var(--wb-sp-4); padding-top: var(--wb-sp-4); border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); }
.wb-plan-item { min-width:0; gap: var(--wb-sp-2); }
.wb-plan-item b, .wb-plan-item .wb-plan-note { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-plan-item b { flex:0 1 auto; }
.wb-plan-item .wb-plan-note { flex:1 1 36%; }
.wb-plan-item-actions { display:inline-flex; gap: var(--wb-sp-1); flex:none; margin-left: auto; }
.wb-plan-act { display:inline-flex; align-items:center; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); background:color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 3%, transparent); color:var(--dsw-alias-label-secondary); border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); font-size: var(--wb-fs-1); cursor:pointer; line-height:1.5; }
.wb-plan-act:hover { color:var(--dsw-alias-label-primary); border-color:color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 35%, transparent); }
.wb-plan-act:disabled { opacity:.45; cursor:default; }
.wb-plan-act.done { color:color-mix(in srgb, var(--wb-ok) 85%, #fff); border-color:color-mix(in srgb, var(--wb-ok) 45%, transparent); }
.wb-plan-act.defer { color:color-mix(in srgb, var(--wb-warn-ink) 85%, #fff); border-color:color-mix(in srgb, var(--wb-warn-ink) 45%, transparent); }
.wb-plan-item.closed { opacity:.55; }
.wb-plan-item.closed b { text-decoration:line-through; }
.wb-plan-edit-note { flex:1 1 36%; min-width:0; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); color:inherit; border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); font-size: var(--wb-fs-1); }
/* 计划投入（T2/D07）：显示态的按钮与编辑态的输入框都刻意窄，避免把标题挤没 */
.wb-plan-minutes { flex:none; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); background:color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 4%, transparent); color:var(--dsw-alias-label-secondary); border-radius: 999px; padding: var(--wb-sp-1) var(--wb-sp-3); font-size: var(--wb-fs-1); cursor:pointer; font-variant-numeric:tabular-nums; white-space:nowrap; }
.wb-plan-minutes:hover { color:var(--dsw-alias-label-primary); border-color:color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 35%, transparent); }
.wb-plan-minutes:disabled { opacity:.5; cursor:default; }
.wb-plan-minutes-static { flex:none; color:var(--dsw-alias-label-secondary); font-size: var(--wb-fs-1); font-variant-numeric:tabular-nums; white-space:nowrap; }
.wb-plan-minutes-input, .wb-plan-edit-minutes { flex:none; width:76px; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); color:inherit; border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); font-size: var(--wb-fs-1); font-variant-numeric:tabular-nums; }
.wb-plan-effort-done { flex:none; font-size: var(--wb-fs-1); border-radius: 999px; padding: var(--wb-sp-1) var(--wb-sp-3); color:color-mix(in srgb, var(--wb-ok) 88%, #fff); border:1px solid color-mix(in srgb, var(--wb-ok) 42%, transparent); background:color-mix(in srgb, var(--wb-ok) 12%, transparent); white-space:nowrap; }
.wb-plan-act.effort { color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 88%, #fff); border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 45%, transparent); }
.wb-plan-act.effort.on { color:var(--dsw-alias-label-secondary); }
/* 结束投入后的进度建议：非自动、不默认勾选，所以视觉上刻意弱于主动作 */
.wb-plan-progress-hint { flex:1 1 100%; display:flex; align-items:center; gap: var(--wb-sp-2); margin-top: var(--wb-sp-1); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); }
.wb-plan-progress-hint .wb-btn { padding: var(--wb-sp-1) var(--wb-sp-3); font-size: var(--wb-fs-1); }
.wb-plan-item.effort-done b { color:color-mix(in srgb, var(--wb-ok) 70%, var(--dsw-alias-label-primary, #eee)); }
.wb-plan-unreadable { border-color:color-mix(in srgb, var(--wb-danger) 42%, transparent); }
.wb-plan-edit-actions { display:inline-flex; gap: var(--wb-sp-1); flex:none; margin-left: auto; }
.wb-plan-edit-actions .wb-btn { padding: var(--wb-sp-1) var(--wb-sp-2); font-size: var(--wb-fs-1); }
.wb-row-title { display:flex; align-items:center; gap: var(--wb-sp-2); min-width:0; }
/* 标题文字自己的节点（徽标是它的兄弟节点）：截断在这一层做，否则会把徽标一起截掉。
   ⚠️ 别把徽标放回 .wb-row-title 的文字流里 —— 那会污染"标题"这个定位点（见 TaskList.tsx 的长注释）。 */
.wb-row-title-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 日期面板的行来源徽标（批次2 D15）：到期 / 计划 / 进行中，可多来源并列 */
.wb-src { flex:none; font-size: var(--wb-fs-1); font-weight:600; padding: var(--wb-sp-1) var(--wb-sp-2); border-radius: var(--wb-r-1); letter-spacing:.2px;
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent);
  color:var(--dsw-alias-state-business-primary, var(--wb-info));
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 38%, transparent); }
/* 行内「排入今日」（2026-10-02）：只在日期面板的**逾期 / 未排期**页签、且**今天**这一实例上出现。
   它是行内动作，必须比整行小一号且不与右侧固定列抢宽度（flex:none + 小字号内边距）。
   ⚠️ 这段在 JS 模板串里，注释中**不能出现反引号**（会提前结束模板串 —— 本次已踩过一次）。 */
.wb-schedule { flex:none; padding: var(--wb-sp-1) var(--wb-sp-3); font-size: var(--wb-fs-1); border-radius: var(--wb-r-2); white-space:nowrap; }
.wb-schedule:disabled { opacity:.5; cursor:default; }
.wb-plan-add { max-width:220px; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); color:inherit; border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-3); font-size: var(--wb-fs-1); }
/* 文档/目录弹窗（LocalDocModal）的遮罩。
   ⚠️ z-index 必须夹在 .wb-overlay(300) 与对话框内浮层（.wb-model-scrim 329 / .wb-model-menu 330）之间。
   原来是 200 —— 低于 .wb-overlay，于是当这个弹窗**从另一个弹窗里**打开时（批次2 #2：快速录入 /
   新建任务里的工作区「浏览…」），它整个被对话框盖住：真实鼠标点在「选择此文件夹」的坐标上，
   命中的是对话框里的元素，表现为"点了没反应、值也不落进去"。这个 bug 是
   scripts/verify/suites/workspace-picker.mjs 的 elementFromPoint 诊断抓出来的。
   ⚠️ 本段在模板字符串里，**不能出现反引号**。 */
.wb-modal-mask { position:fixed; inset:0; z-index: var(--wb-z-dialog-mask); pointer-events:auto; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; }
.wb-modal { width:min(520px, 92vw); background:var(--dsw-alias-bg-layer-2, #1c1c1f); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.25)); border-radius: var(--wb-r-4); padding: var(--wb-sp-6); box-shadow:var(--wb-sh-5); color:var(--dsw-alias-label-primary, #eee); font-family:var(--dsw-font-family, system-ui); }
.wb-modal h4 { margin: 0 0 var(--wb-sp-3); }
.wb-modal p { margin: 0 0 var(--wb-sp-5); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); }
.wb-modal textarea { width:100%; min-height:110px; box-sizing:border-box; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2)); color:inherit; border-radius: var(--wb-r-3); padding: var(--wb-sp-4); font:inherit; resize:vertical; }
.wb-modal-actions { display:flex; justify-content:flex-end; gap: var(--wb-sp-3); margin-top: var(--wb-sp-5); }
/* 技能选择器（AI 会话前的提示词弹窗内） */
.wb-skill-picker { margin-top: var(--wb-sp-5); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius: var(--wb-r-3); padding: var(--wb-sp-4); background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 3%, transparent); }
.wb-skill-picker-head { display:flex; align-items:center; justify-content:space-between; font-size: var(--wb-fs-1); color:var(--dsw-alias-label-primary); margin-bottom: var(--wb-sp-3); }
.wb-skill-picker-head svg { width:13px; height:13px; vertical-align:-2px; margin-right: var(--wb-sp-1); }
.wb-skill-count { font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); }
.wb-skill-search { width:100%; box-sizing:border-box; background:var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); color:inherit; border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-3); font:inherit; font-size: var(--wb-fs-1); }
.wb-skill-selected { display:flex; flex-wrap:wrap; gap: var(--wb-sp-2); margin-top: var(--wb-sp-2); }
.wb-skill-tag { display:inline-flex; align-items:center; gap: var(--wb-sp-1); border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent); color:var(--dsw-alias-label-primary); border-radius: 999px; padding: var(--wb-sp-1) var(--wb-sp-3); font-size: var(--wb-fs-1); font:inherit; font-size: var(--wb-fs-1); cursor:pointer; }
.wb-skill-tag:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 22%, transparent); }
.wb-skill-list { margin-top: var(--wb-sp-2); max-height:190px; overflow:auto; display:flex; flex-direction:column; gap: var(--wb-sp-1); }
.wb-skill-item { display:flex; align-items:center; gap: var(--wb-sp-3); padding: var(--wb-sp-2) var(--wb-sp-3); border-radius: var(--wb-r-2); cursor:pointer; border:1px solid transparent; }
.wb-skill-item:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 5%, transparent); }
.wb-skill-item.on { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 10%, transparent); }
.wb-skill-item input { flex:none; margin: 0; }
.wb-skill-body { flex:1; min-width:0; display:flex; flex-direction:column; gap: var(--wb-sp-1); }
.wb-skill-name { font-size: var(--wb-fs-1); color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-skill-desc { font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-skill-provider { flex:none; font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); opacity:.75; }
.wb-skill-hint { padding: var(--wb-sp-3) var(--wb-sp-1); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); }
/* 技能目录拿不到时的**可见故障态**（v1.15.6）：旧实现是整块隐藏，用户看到的是"功能没了"。 */
.wb-skill-problem { margin-top: var(--wb-sp-5); display:flex; align-items:center; gap: var(--wb-sp-4); justify-content:space-between; padding: var(--wb-sp-3) var(--wb-sp-4); border-radius: var(--wb-r-2); font-size: var(--wb-fs-1); line-height:1.6; color:var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--wb-warn) 12%, transparent); border-left:3px solid var(--wb-warn); }
.wb-skill-problem svg { width:13px; height:13px; vertical-align:-2px; margin-right: var(--wb-sp-1); }
.wb-skill-problem .wb-btn { flex:none; display:inline-flex; align-items:center; gap: var(--wb-sp-1); }
.wb-skill-foot { margin-top: var(--wb-sp-2); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); opacity:.85; }
/* 角色选择器（D13-B）：与技能选择器并列的**普通文档流**区块 —— 不用绝对定位、不加遮罩，
   所以它下面的技能选择器照常展开，两者不遮挡（AX-R07）。 */
.wb-persona-picker { margin-top: var(--wb-sp-5); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius: var(--wb-r-3); padding: var(--wb-sp-4); background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 3%, transparent); }
.wb-persona-head { display:flex; align-items:center; justify-content:space-between; gap: var(--wb-sp-3); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-primary); }
.wb-persona-head svg { width:13px; height:13px; vertical-align:-2px; margin-right: var(--wb-sp-1); }
.wb-persona-current { font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); max-width:62%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-persona-hint { margin-top: var(--wb-sp-2); font-size: var(--wb-fs-1); line-height:1.6; color:var(--dsw-alias-label-secondary); }
/* 搜索常驻（与「加载 Skill」同形）：一行放搜索框 + 「只看收藏」筛选 */
.wb-persona-toolbar { margin-top: var(--wb-sp-3); display:flex; align-items:center; gap: var(--wb-sp-2); }
.wb-persona-toolbar .wb-skill-search { flex:1; min-width:0; margin: 0; }
.wb-persona-toolbar .wb-btn { flex:none; white-space:nowrap; }
.wb-persona-admin { margin-top: var(--wb-sp-3); }
/**
 * 管理列表**不再自带滚动区**（2026-10-01 实测截图暴露的缺陷）。
 *
 * 拆成独立页签后这一页有整幅高度，而原来那条 max-height:300px + overflow:auto 会在
 * 列表中间切一刀：截图里第 4 行从中间被截断、第 5 行完全看不见 ——
 * 用户要"少滚"，结果变成"弹窗里再滚一层"，比不滚更难用（还看不出下面还有内容）。
 *
 * 选择器（弹窗里那个窄条）**保留** max-height：那里确实需要一个上限。
 */
.wb-persona-admin-list { margin-top: var(--wb-sp-3); display:flex; flex-direction:column; gap: var(--wb-sp-1); }
.wb-persona-admin-list .wb-persona-name { max-width:26%; }
.wb-persona-foot { margin-top: var(--wb-sp-3); font-size: var(--wb-fs-1); line-height:1.6; color:var(--dsw-alias-label-secondary); }
.wb-persona-list { margin-top: var(--wb-sp-3); display:flex; flex-direction:column; gap: var(--wb-sp-1); max-height:320px; overflow:auto; }
.wb-persona-item { display:flex; align-items:center; gap: var(--wb-sp-3); text-align:left; width:100%; box-sizing:border-box; padding: var(--wb-sp-2) var(--wb-sp-3); border-radius: var(--wb-r-2); cursor:pointer; border:1px solid transparent; background:transparent; color:inherit; font:inherit; }
.wb-persona-item:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 5%, transparent); }
.wb-persona-item.on { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 10%, transparent); }
.wb-persona-item:disabled { opacity:.55; cursor:not-allowed; }
.wb-persona-item.grow { flex:1; min-width:0; }
/* ---- 角色：名称 / 描述 / 来源 三层（2026-10-01 用户报"层级分布不明显、全挤在一起"）----
   改之前三类信息是**同一个灰、同一个字重**，只差 0.5px 字号（分组名 11、描述 11、来源 10.5），
   所以视觉上糊成一片。下面按"字号 + 字重 + 颜色深浅"拉开三层：
     ① 分组标题 14/600/主色 + 上分割线 + 计数
     ② 角色名 12.5/600/主色；描述 11.5/次色（管理页两行截断，选择器仍单行省略）
     ③ 来源｜分组 10.5/最淡色
*/
.wb-persona-name { flex:none; font-size: var(--wb-fs-1); font-weight:600; color:var(--dsw-alias-label-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:52%; }
.wb-persona-desc { flex:1; min-width:0; font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-persona-source { flex:none; font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); opacity:.7; }
.wb-persona-more-head { margin-top: var(--wb-sp-3); display:flex; align-items:center; gap: var(--wb-sp-3); flex-wrap:wrap; }
.wb-persona-more { margin-top: var(--wb-sp-3); border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); padding-top: var(--wb-sp-3); max-height:300px; overflow:auto; }
/**
 * 分组标题 = **章节级**（两处共用：设置页的角色库管理 + 弹窗里的角色选择器）。
 * 上分割线把它和上一组分开，计数让它自带规模信息 —— 这两样是"看得出分组"的关键，
 * 只靠字号（改前 11px vs 12.5px）区分不出来。
 */
.wb-persona-group { margin-top: var(--wb-sp-5); }
.wb-persona-group:first-child { margin-top: 0; }
.wb-persona-group-name {
  display:flex; align-items:center; gap: var(--wb-sp-3);
  margin: 0 0 var(--wb-sp-2); padding-top: var(--wb-sp-3);
  border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
  font-size: var(--wb-fs-3); font-weight:600; color:var(--dsw-alias-label-primary);
  letter-spacing:.2px;
}
.wb-persona-group-count { font-size: var(--wb-fs-1); font-weight:400; color:var(--dsw-alias-label-secondary); opacity:.8; }
.wb-persona-row { display:flex; align-items:flex-start; gap: var(--wb-sp-4); padding: var(--wb-sp-2) var(--wb-sp-1); border-radius: var(--wb-r-2); }
.wb-persona-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 4%, transparent); }
.wb-persona-row.off { opacity:.6; }
.wb-persona-info { flex:1; min-width:0; display:flex; flex-direction:column; gap: var(--wb-sp-1); }
/* 管理页的描述给两行（单行截断在宽栏里浪费空间）；选择器里仍是单行省略。
   为什么只给管理页：选择器每行只有 300px 上下，两行会让列表长一倍。 */
.wb-persona-admin .wb-persona-desc {
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; white-space:normal; line-height:1.45;
}
.wb-persona-admin .wb-persona-name { max-width:100%; }
.wb-persona-admin-list .wb-persona-name { max-width:100%; }
.wb-persona-actions { flex:none; display:flex; align-items:center; gap: var(--wb-sp-2); padding-top: var(--wb-sp-1); }
.wb-persona-star { margin-left: var(--wb-sp-2); font-size: var(--wb-fs-1); color:var(--wb-warn-ink); }
.wb-persona-off-tag {
  margin-left: var(--wb-sp-2); padding: 0 var(--wb-sp-2); border-radius: var(--wb-r-1); font-size: var(--wb-fs-1); font-weight:400;
  color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
}
.wb-persona-flag { flex:none; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28)); background:transparent; color:var(--dsw-alias-label-secondary); border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); font:inherit; font-size: var(--wb-fs-1); cursor:pointer; }
.wb-persona-flag.on { color:var(--wb-warn-ink); border-color: color-mix(in srgb, var(--wb-warn) 45%, transparent); background: color-mix(in srgb, var(--wb-warn) 12%, transparent); }
.wb-persona-flag:hover:not(:disabled) { color:var(--dsw-alias-label-primary); border-color: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 30%, transparent); }
.wb-persona-flag:disabled { opacity:.5; cursor:not-allowed; }
/* 列表里的"读取中 / 无匹配"提示：不参与行布局，也不是 .wb-hint（那带 margin）。 */
.wb-persona-note { padding: var(--wb-sp-3) var(--wb-sp-1); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); }
/**
 * 默认折叠的「使用说明」块（2026-10-01 用户要求把"到处都有的解释性段落"收起来）。
 *
 * 口径：**页面默认只留可操作的控件**；要看"这个东西是什么/为什么这样"就点开。
 * 要点一条都不删（源文件里原文保留），只是不再各占一行把页面撑满。
 */
.wb-notes { margin: var(--wb-sp-5) 0 0; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius: var(--wb-r-3); background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 3%, transparent); }
.wb-notes > summary {
  cursor:pointer; list-style:none; padding: var(--wb-sp-3) var(--wb-sp-4);
  font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary);
  display:flex; align-items:center; gap: var(--wb-sp-2);
}
.wb-notes > summary::-webkit-details-marker { display:none; }
.wb-notes > summary::before { content:'▸'; font-size: var(--wb-fs-1); opacity:.8; }
.wb-notes[open] > summary::before { content:'▾'; }
.wb-notes > summary:hover { color:var(--dsw-alias-label-primary); }
.wb-notes-body { padding: 0 var(--wb-sp-5) var(--wb-sp-4); font-size: var(--wb-fs-1); line-height:1.7; color:var(--dsw-alias-label-secondary); }
.wb-notes-body p { margin: 0 0 var(--wb-sp-2); }
.wb-notes-body p:last-child { margin-bottom: 0; }
.wb-notes-body b { color:var(--dsw-alias-label-primary); font-weight:650; }
.wb-notes-body code { font-size: var(--wb-fs-1); padding: var(--wb-sp-1) var(--wb-sp-1); border-radius: var(--wb-r-1); background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 8%, transparent); }
.wb-notes-body .wb-notes-warn { color:var(--wb-warn-ink); }
.wb-list { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24)); border-radius: var(--wb-r-4); overflow:hidden; background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); }

/* 键盘可达性（2026-10-23 A）：任务行 / 日格 / 文件夹等用 div+role=button 伪装的可点区域，
   必须看得见焦点；只在工作台根节点内生效，不污染宿主。 */
[data-dsh-personal-workbench-view] [role="button"]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4f8ef7);
  outline-offset: 2px;
  border-radius: var(--wb-r-1);
}

.wb-row { display:flex; align-items:center; gap: var(--wb-sp-3); padding: 11px var(--wb-sp-5); border-bottom:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12)); cursor:pointer; transition:background .12s ease; }
.wb-row:last-child { border-bottom:none; }
.wb-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 5%, transparent); }
.wb-row.selected { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 12%, transparent); box-shadow: var(--wb-bar); }
.wb-row-context { opacity:.55; }
.wb-row-context .wb-row-title { color: var(--dsw-alias-label-secondary); }
.wb-card { transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
.wb-card.selected { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 65%, transparent) !important; box-shadow: var(--wb-ring-out), var(--wb-sh-3); transform: translateY(-1px); }
.wb-row-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-row-meta { flex:none; display:grid; grid-template-columns:68px 46px 56px 88px; align-items:center; gap: var(--wb-sp-2); }
.wb-row-meta .wb-chip { display:inline-flex; align-items:center; justify-content:center; width:100%; padding-left: 0; padding-right: 0; text-align:center; }
.wb-due { text-align:right; color:var(--dsw-alias-label-secondary); font-size: var(--wb-fs-1); font-variant-numeric:tabular-nums; white-space:nowrap; }
.wb-chip { display:inline-flex; align-items:center; justify-content:center; border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); font-size: var(--wb-fs-1); white-space:nowrap; }
/* 第三轮：色彩只留给「优先级高的」和「状态异常」。其余 chip 一律中性灰，
   一屏颜色从 7 种收到 2–3 种（红=紧急、橙=高，其余全是中性）。 */
.wb-chip.is-neutral { background: color-mix(in srgb, var(--wb-label-secondary, var(--wb-neutral)) 10%, transparent); color: var(--wb-label-secondary, var(--wb-neutral)); border: 1px solid var(--wb-line-soft, rgba(127,127,127,.22)); font-weight: 500; }

/* ---- 任务进度（S4）：列表行的紧凑条 + 详情页的完整卡片 ---- */
/* 行内形态：**在自己的网格格子里**伸缩（2026-10-01）。
   旧写法是网格外的 flex 兄弟 + max-width:46%，进度条一长就压窄左边的到期列，
   同一屏里几行对不齐（用户截图点名的就是它）。
   现在它占第 4 列固定 96px：0% 与 >10% 的行左右边界完全一致。 */
.wb-progress-compact { display:inline-flex; align-items:center; gap: var(--wb-sp-2); min-width:0; width:100%; justify-content:flex-end; }
.wb-progress { position:relative; height:6px; width:100%; min-width:38px; border-radius: 999px; background:color-mix(in srgb, var(--dsw-alias-label-secondary, var(--wb-neutral)) 22%, transparent); overflow:hidden; }
.wb-progress-fill { height:100%; border-radius: 999px; background:var(--dsw-alias-state-business-primary, #4f8ef7); transition:width .18s ease; }
.wb-progress-num { font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; flex:none; }
.wb-progress-badge.pending { color:var(--wb-warn-ink); border-color:color-mix(in srgb, var(--wb-warn) 45%, transparent); background:color-mix(in srgb, var(--wb-warn) 14%, transparent); }
/* 「延后」不是告警也不是完成，是中性的"暂不处理" —— 原先用紫色，成了全面板唯一的孤例色。
   收进状态徽标族后只剩 ok / warn / danger / neutral 四色，读起来才有一致的语义。 */
.wb-progress-badge.deferred { color:var(--wb-ink-2); border-color:color-mix(in srgb, var(--wb-neutral) 45%, transparent); background:color-mix(in srgb, var(--wb-neutral) 14%, transparent); }
/* 详情卡：**一行**（2026-10-01 用户报"进度页面太高、把详情页撑丑了"）。
   旧的六块竖排（标题/条/旁证/提示/五档/输入框）已合并；旁证与黄色提示改用 title 悬停，
   用一个小图标表示"这里有话可说"。窄屏自动换行，不再有固定高度。 */
.wb-progress-card { padding: var(--wb-sp-2) var(--wb-sp-4); margin-bottom: var(--wb-sp-4); }
/* ⚠️ 进度卡里的 h4 只是"这一个控件叫什么"，不是卡片标题：
   .wb-card h4 自带 padding-bottom:10px + border-bottom，而用户截图里的
   "进度下面有个下划线、比其他元素高"正是它。这里清掉，让整条与徽标/状态行同高。 */
.wb-progress-card h4, .wb-card h4.wb-progress-title {
  margin: 0; padding: 0; border-bottom:none;
  font-size: var(--wb-fs-1); font-weight:600; color:var(--dsw-alias-label-secondary);
}
.wb-progress-row { display:flex; align-items:center; gap: var(--wb-sp-3); flex-wrap:wrap; min-height:24px; }
.wb-progress-title { margin: 0; font-size: var(--wb-fs-1); font-weight:600; flex:none; }
/* 进度条槽位：**先收缩、不抢宽度**。
   ⚠️ 别写 flex:1 1 120px：那个 120px 的 flex-basis 在窄右栏里会让整条宽度超出容器，
   于是"0% 25% 50% 75% 完成任务"和输入框被换到**第二行**（2026-10-01 用户截图：
   进度卡分了两行，下面还多个下划线，比旁边元素高一截）。
   现在 basis=0：其余控件先占位，进度条吃剩下的；min-width 兜住"再挤也看得见"。 */
.wb-progress-bar-slot { flex:1 1 0; min-width:56px; display:flex; align-items:center; }
.wb-progress-card .wb-progress { height:6px; margin: 0; }
.wb-progress-child, .wb-progress-hint { font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); margin: 0; display:inline-flex; align-items:center; flex:none; }
.wb-progress-hint { color:var(--wb-warn-ink); }
.wb-progress-note { font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); margin: 0; }
.wb-progress-error { font-size: var(--wb-fs-1); color:var(--wb-danger-ink); margin-top: var(--wb-sp-2); }
.wb-progress-presets { display:inline-flex; align-items:center; gap: var(--wb-sp-2); flex:none; }
.wb-progress-input { display:inline-flex; align-items:center; gap: var(--wb-sp-2); flex:none; }
.wb-progress-input input { width:70px; }
.wb-cal-nav { display:flex; align-items:center; gap: var(--wb-sp-3); margin-bottom: var(--wb-sp-4); }
.wb-week { display:grid; grid-template-columns:repeat(7,1fr); gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-4); }
.wb-day { border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius: var(--wb-r-4); min-height:92px; padding: var(--wb-sp-3); cursor:pointer; transition:border-color .12s ease, background .12s ease; }
.wb-day.today { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 50%, transparent); }
.wb-day.selected { border-color:var(--dsw-alias-state-business-primary, var(--wb-info)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 10%, transparent); }
.wb-month { display:grid; grid-template-columns:repeat(7,1fr); gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-4); }
.wb-mday { min-height:52px; border:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); border-radius: var(--wb-r-3); padding: var(--wb-sp-2); cursor:pointer; color:var(--dsw-alias-label-secondary); }
.wb-mday.other { opacity:.35; }
.wb-mday.today { border-color: var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-mday.selected { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 12%, transparent); }
.wb-form { display:grid; grid-template-columns:1fr 1fr; gap: var(--wb-sp-4); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12)); border-radius: var(--wb-r-3); padding: var(--wb-sp-5); }
.wb-form-panel { border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 45%, transparent) !important; border-left:4px solid var(--dsw-alias-state-business-primary, var(--wb-info)) !important; border-radius: var(--wb-r-4); padding: var(--wb-sp-6) !important; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--wb-info)) 8%, var(--dsw-alias-bg-base, #111)) !important; box-shadow:var(--wb-sh-4); margin-bottom: var(--wb-sp-5); }
.wb-form-panel h4 { margin: 0 0 var(--wb-sp-4); font-size: var(--wb-fs-4); color:var(--dsw-alias-label-primary); display:flex; align-items:center; gap: var(--wb-sp-3); }
.wb-form-panel h4 svg { width:16px; height:16px; color:var(--dsw-alias-state-business-primary, var(--wb-info)); }
.wb-btn.lg { padding: var(--wb-sp-3) var(--wb-sp-6); font-size: var(--wb-fs-3); font-weight:600; }
.wb-form label { display:flex; flex-direction:column; gap: var(--wb-sp-1); font-size: var(--wb-fs-1); color:var(--dsw-alias-label-secondary); }
.wb-form input, .wb-form select, .wb-form textarea { background: var(--dsw-alias-bg-base,#17171a); border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.15)); color:inherit; border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); font:inherit; }
.wb-form .full { grid-column:1 / -1; }
.wb-empty { padding: var(--wb-sp-7); text-align:center; color:var(--dsw-alias-label-secondary); }
.wb-banner { border:1px solid color-mix(in srgb, var(--wb-info) 42%, transparent); border-radius: var(--wb-r-4); padding: var(--wb-sp-6); margin: var(--wb-sp-4) var(--wb-sp-5) 0; box-shadow:var(--wb-sh-4); }
.wb-banner.draft { border-color:color-mix(in srgb, var(--wb-info) 45%, transparent); border-left-color:var(--wb-info); background:color-mix(in srgb, var(--wb-info) 10%, transparent); }
.wb-banner.review { border-color:color-mix(in srgb, var(--wb-info) 60%, transparent); border-left-color:var(--wb-info); background:color-mix(in srgb, var(--wb-info) 12%, transparent); }
.wb-banner.completion { border-color:color-mix(in srgb, var(--wb-warn) 55%, transparent); border-left-color:var(--wb-warn); background:color-mix(in srgb, var(--wb-warn) 10%, transparent); }
.wb-banner.reminder { border-color:color-mix(in srgb, var(--wb-warn) 50%, transparent); border-left-color:var(--wb-warn); background:color-mix(in srgb, var(--wb-warn) 9%, transparent); }
.wb-banner.error { border-color:color-mix(in srgb, var(--wb-danger) 55%, transparent); border-left-color:var(--wb-danger); background:color-mix(in srgb, var(--wb-danger) 10%, transparent); }
.wb-banner.notice { border-color:color-mix(in srgb, var(--wb-info) 50%, transparent); border-left-color:var(--wb-info); background:color-mix(in srgb, var(--wb-info) 8%, transparent); }
.wb-banner h4 { margin: 0 0 var(--wb-sp-3); font-size: var(--wb-fs-4); }

/* 边界增强：用主题文字色计算边框，亮/暗主题都保证对比；不改卡片底色 */
/* 边框词表已统一到 --wb-line / --wb-line-soft / --wb-line-strong（round7），此处不再另起一套。 */
.wb-card, .wb-list, .wb-stat { border-color: var(--wb-line-strong) !important; }
.wb-card h4 { border-bottom-color: var(--wb-line-quiet) !important; }
.wb-row { border-bottom-color: var(--wb-line-quiet) !important; }
.wb-h { border-bottom-color: var(--wb-line-strong) !important; }
.wb-nav { border-right-color: var(--wb-line-quiet) !important; }
.wb-day, .wb-mday, .wb-form { border-color: var(--wb-line-quiet) !important; }
/* 今日卡片高亮：周/月视图统一加亮边框 + 浅色背景 + 日期数字高亮 */
.wb-day.today { border-color: var(--dsw-alias-state-business-primary, #4f8ef7) !important; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 12%, transparent) !important; }
.wb-day.today .wb-day-date { color: var(--dsw-alias-state-business-primary, #4f8ef7); font-weight: 700; }
.wb-day.today.selected { box-shadow: var(--wb-ring-today); }
.wb-mday.today { border-color: var(--dsw-alias-state-business-primary, #4f8ef7) !important; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent) !important; color: var(--dsw-alias-label-primary); }
.wb-mday.today .wb-mday-date { color: var(--dsw-alias-state-business-primary, #4f8ef7); font-weight: 700; }
.wb-mday.today.selected { box-shadow: var(--wb-ring-today); }
.wb-mday.other.today { opacity: 1; }

/* ---- UI 美化：统一卡片/列表/表单视觉，强化 hover/selected/focus 态 ---- */
.wb-card { transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
.wb-card:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 42%, transparent); box-shadow: var(--wb-sh-4); }
.wb-card.selected { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 70%, transparent) !important; box-shadow: var(--wb-ring-out), var(--wb-sh-4); transform: translateY(-1px); }
.wb-stat { transition: border-color .16s ease, box-shadow .16s ease; }
.wb-stat:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 42%, transparent); box-shadow: var(--wb-sh-3); }
.wb-row { transition: background .14s ease, box-shadow .14s ease; }
.wb-row.done { opacity: .58; }
.wb-row.done .wb-row-title { text-decoration: line-through; }
.wb-row.selected { box-shadow: var(--wb-bar); }
.wb-form input:focus, .wb-form select:focus, .wb-form textarea:focus { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 65%, transparent); box-shadow: var(--wb-ring-focus); outline: none; }
.wb-idea-card { display: flex; flex-direction: column; margin-bottom: 0; padding: var(--wb-sp-5); cursor: pointer; }
.wb-idea-card .wb-idea-summary { font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); line-height: 1.5; min-height: 36px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wb-idea-card .wb-idea-foot { display: flex; gap: var(--wb-sp-2); flex-wrap: wrap; align-items: center; margin-top: var(--wb-sp-3); }
.wb-file-chip { display: inline-flex; align-items: center; gap: var(--wb-sp-2); border: 1px solid var(--wb-line-strong); background: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 5%, transparent); border-radius: 999px; padding: var(--wb-sp-1) var(--wb-sp-4); font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }
.wb-file-chip code { background: transparent; border: none; padding: 0; }
.wb-cluster-meta { font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); margin-top: var(--wb-sp-1); }
.wb-empty { border: 1px dashed var(--wb-line-quiet); border-radius: var(--wb-r-4); margin: var(--wb-sp-1); }
/**
 * 空态的标题与说明（v1.19）。
 *
 * 这两条类名被 6 个视图用了很久，但**一直没有样式** —— 于是"空态"实际是一堆
 * 同样大小、同样颜色的文字，看起来像加载失败。补上之后所有列表页一起受益。
 */
.wb-empty-title { color: var(--wb-ink-1); font-size: var(--wb-fs-3); font-weight: 600; margin-bottom: var(--wb-sp-2); }
.wb-empty-desc { max-width: 56ch; margin: 0 auto; color: var(--wb-ink-3); font-size: var(--wb-fs-1); line-height: 1.7; }
/* ---- P0: 任务详情摘要 + Tabs + 吸顶操作条 ---- */
.wb-detail-actions { position: sticky; top: 0; z-index: var(--wb-z-actions); display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; margin-bottom: var(--wb-sp-5); padding: var(--wb-sp-3) var(--wb-sp-5); border: 1px solid var(--wb-line-quiet); border-radius: var(--wb-r-4); background: color-mix(in srgb, var(--dsw-alias-bg-base, #111) 88%, transparent); backdrop-filter: blur(8px); box-shadow: var(--wb-sh-3); }
.wb-detail-tabs { display: flex; gap: var(--wb-sp-1); margin: var(--wb-sp-1) 0 var(--wb-sp-5); border-bottom: 1px solid var(--wb-line-quiet); }
.wb-detail-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--wb-fs-2); font-weight: 600; padding: var(--wb-sp-2) var(--wb-sp-5); border-top-left-radius: var(--wb-r-2); border-top-right-radius: var(--wb-r-2); cursor: pointer; white-space: nowrap; }
.wb-detail-tab:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 6%, transparent); }
.wb-detail-tab.on { color: var(--dsw-alias-label-primary); box-shadow: var(--wb-underline); }
.wb-detail-tab .count { margin-left: var(--wb-sp-1); font-size: var(--wb-fs-1); opacity: .8; }
/* ---- P1: 会话 Chip + 事件时间线 ---- */
.wb-session-chip { display: inline-flex; align-items: center; gap: var(--wb-sp-2); border: 1px solid var(--wb-line-quiet); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 6%, transparent); border-radius: 999px; padding: var(--wb-sp-2) var(--wb-sp-4); font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); cursor: pointer; margin: 0 var(--wb-sp-2) var(--wb-sp-2) 0; transition: border-color .12s ease, background .12s ease; }
.wb-session-chip:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 55%, transparent); color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 12%, transparent); }
.wb-session-role { font-weight: 600; color: var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-session-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: .75; }
.wb-session-open { opacity: .6; }
.wb-session-list { display: flex; flex-direction: column; gap: var(--wb-sp-2); }
.wb-session-row { display: flex; align-items: center; gap: var(--wb-sp-4); width: 100%; padding: var(--wb-sp-3) var(--wb-sp-5); border: 1px solid var(--wb-line-quiet); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 5%, transparent); border-radius: var(--wb-r-3); text-align: left; cursor: pointer; font: inherit; font-size: var(--wb-fs-2); color: var(--dsw-alias-label-primary); transition: border-color .12s ease, background .12s ease; }
.wb-session-row:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 55%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 10%, transparent); }
.wb-session-role { flex: none; font-size: var(--wb-fs-1); font-weight: 600; color: var(--dsw-alias-state-business-primary, #4f8ef7); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 10%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 30%, transparent); border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); white-space: nowrap; }
.wb-session-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-session-open { flex: none; font-size: var(--wb-fs-1); opacity: .65; }
.wb-session-picker { margin-top: var(--wb-sp-4); border: 1px solid var(--wb-line-strong); border-radius: var(--wb-r-4); padding: var(--wb-sp-4); background: color-mix(in srgb, var(--dsw-alias-bg-base, #111) 90%, transparent); }
.wb-session-picker-bar { display: flex; gap: var(--wb-sp-3); margin-bottom: var(--wb-sp-3); }
.wb-session-search { flex: 1; min-width: 0; background: var(--dsw-alias-bg-base,#17171a); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16)); color: inherit; border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); font: inherit; font-size: var(--wb-fs-2); }
.wb-session-search:focus { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 65%, transparent); box-shadow: var(--wb-ring-focus); outline: none; }
.wb-session-role-select { background: var(--dsw-alias-bg-base,#17171a); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16)); color: inherit; border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); font: inherit; font-size: var(--wb-fs-2); }
.wb-session-picker-list { display: flex; flex-direction: column; gap: var(--wb-sp-1); max-height: 260px; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.wb-session-option { display: flex; align-items: center; gap: var(--wb-sp-3); width: 100%; padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid transparent; background: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 4%, transparent); border-radius: var(--wb-r-2); text-align: left; cursor: pointer; font: inherit; font-size: var(--wb-fs-2); color: var(--dsw-alias-label-primary); transition: border-color .12s ease, background .12s ease; }
.wb-session-option:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 9%, transparent); }
.wb-session-option:disabled { opacity: .5; cursor: default; }
.wb-session-cwd { flex: none; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); opacity: .8; }
.wb-session-add { flex: none; font-size: var(--wb-fs-1); font-weight: 600; color: var(--dsw-alias-state-business-primary, #4f8ef7); }
.wb-session-option:disabled .wb-session-add { color: var(--dsw-alias-label-secondary); }
/* ---- P3: 快速录入附件与模型选择器（v1.15.1） ---- */
.wb-quick-attach-rail { display: flex; flex-wrap: wrap; gap: var(--wb-sp-3); margin-top: var(--wb-sp-3); }
.wb-quick-attach-item { position: relative; display: flex; align-items: center; gap: var(--wb-sp-2); max-width: 240px; padding: var(--wb-sp-2) var(--wb-sp-7) var(--wb-sp-2) var(--wb-sp-3); border: 1px solid var(--wb-line-strong); border-radius: var(--wb-r-2); background: color-mix(in srgb, var(--dsw-alias-label-primary, #888) 5%, transparent); font-size: var(--wb-fs-1); color: var(--dsw-alias-label-primary); }
.wb-quick-attach-item img { width: 36px; height: 36px; object-fit: cover; border-radius: var(--wb-r-1); flex: none; }
.wb-quick-attach-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-quick-attach-remove { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; line-height: 1; border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: var(--wb-fs-3); }
.wb-quick-attach-remove:hover { background: color-mix(in srgb, var(--wb-danger) 22%, transparent); color: inherit; }
.wb-quick-attach-note { margin-top: var(--wb-sp-2); font-size: var(--wb-fs-1); color: var(--wb-warn-ink); }
.wb-quick-actions { display: flex; align-items: center; gap: var(--wb-sp-3); margin-top: var(--wb-sp-4); }
.wb-quick-actions .wb-spacer { flex: 1; }
/* ---------------------------------------------------------------------------
   模型选择浮层（v1.15.2 修「被遮挡」）
   ---------------------------------------------------------------------------
   ⚠️ 必须 position: fixed + **由 JS portal 到 document.body**：
   浮层原来用 position:absolute + bottom: calc(100% + 4px) 挂在触发按钮的
   position:relative 包装盒里，而那个盒子在 .wb-dialog-body（overflow: auto）
   **里面** —— 于是只会朝上开、不看可用空间，多出来的部分被滚动容器裁掉
   （实测常见窗口下只有 48% 可见，「跟随 DSH 默认模型」和前几个模型正好在被裁掉的那一段），
   窗口小一点时甚至画到视口外面。
   left/top/width/max-height 由 popoverPlacement.ts 的 placePopover() 算好写 inline style；
   这里的值是"拿不到量取结果"时的兜底（见该项目规范第 9 条：兜底值要选最坏情况可接受的）。
   ⚠️ box-sizing 必须是 border-box：placePopover() 把 max-height 当"整块菜单的高度"用，
   默认的 content-box 会让 border+padding（这里共 14px）额外顶出去 ——
   实测 1000x400 就因此有 3% 被挤出视口（这正是本次要修的"被裁"）。
   层叠：.wb-overlay 是 300，浮层要压住它；--wb-* 令牌由令牌层提供。
   ⚠️ 本段在模板字符串里，**不能出现反引号**。
   --------------------------------------------------------------------------- */
.wb-model-menu { position: fixed; z-index: var(--wb-z-top); pointer-events: auto; box-sizing: border-box; width: 320px; max-height: min(60vh, 360px); overflow-y: auto; padding: var(--wb-sp-2); border: 1px solid var(--wb-line-strong); border-radius: var(--wb-r-3); background: var(--dsw-alias-bg-layer-2, #1c1c1f); box-shadow: var(--wb-sh-5); overscroll-behavior: contain; scrollbar-width: thin; }
/* 浮层打开时的"点外面关掉"层：必须**在弹窗之上**（300）才能接住落在弹窗任意位置的第一次点击 */
.wb-model-scrim { position: fixed; inset: 0; z-index: var(--wb-z-scrim); pointer-events: auto; }
.wb-model-group-title { padding: var(--wb-sp-1) var(--wb-sp-3); font-size: var(--wb-fs-1); font-weight: 700; color: var(--dsw-alias-label-secondary); }
.wb-model-option { display: flex; align-items: center; gap: var(--wb-sp-3); width: 100%; padding: var(--wb-sp-3) var(--wb-sp-3); border: 1px solid transparent; border-radius: var(--wb-r-2); background: transparent; color: inherit; font: inherit; font-size: var(--wb-fs-2); text-align: left; cursor: pointer; }
.wb-model-option:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 7%, transparent); }
.wb-model-option.selected { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 34%, transparent); }
.wb-model-option-main { min-width: 0; flex: 1; }
.wb-model-option-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-model-option-note { display: block; font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }
.wb-model-option-note.warn { color: var(--wb-warn-ink); }
.wb-model-menu-empty { padding: var(--wb-sp-3) var(--wb-sp-4); font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }
.wb-model-menu-error { padding: var(--wb-sp-3) var(--wb-sp-4); font-size: var(--wb-fs-1); color: var(--wb-danger-ink); }
.wb-event-group-date { display: flex; align-items: center; gap: var(--wb-sp-3); margin: var(--wb-sp-4) 0 var(--wb-sp-1); font-size: var(--wb-fs-1); font-weight: 700; color: var(--dsw-alias-label-secondary); }
.wb-event-group-date::after { content: ''; flex: 1; height: 1px; background: var(--wb-line-quiet); }
.wb-event-row { display: flex; align-items: flex-start; gap: var(--wb-sp-3); padding: var(--wb-sp-2) 0; font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }
.wb-event-icon { flex: none; width: 18px; text-align: center; line-height: 1.4; }
.wb-event-main { flex: 1; min-width: 0; }
.wb-event-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
.wb-event-meta { opacity: .8; margin-top: var(--wb-sp-1); word-break: break-all; }
/* ---- P2: 顶栏窄屏自适应 ---- */
@media (max-width: 1100px) {
  .wb-h { gap: var(--wb-sp-3); padding: var(--wb-sp-4) var(--wb-sp-5); }
  .wb-h .wb-label { display: none; }
  .wb-h .wb-h-actions .wb-btn { width: var(--wb-ctl-h); height: var(--wb-ctl-h); padding: 0; justify-content: center; }
  .wb-h .wb-segmented { flex-wrap: wrap; }
  .wb-h .wb-seg { padding: var(--wb-sp-2) var(--wb-sp-3); font-size: var(--wb-fs-1); }
  .wb-h .wb-title { font-size: var(--wb-fs-3); letter-spacing: 0; }
}
/* ---- P2: Markdown 代码块复制 ---- */
.wb-code-block { position: relative; margin: var(--wb-sp-3) 0; }
.wb-code-block pre { background: var(--wb-sunk); padding: var(--wb-sp-4) var(--wb-sp-5); border-radius: var(--wb-r-2); overflow: auto; font-size: var(--wb-fs-1); margin: 0; }
.wb-code-copy { position: absolute; top: 6px; right: 6px; border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); font-size: var(--wb-fs-1); opacity: .75; }
.wb-blockquote { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 32%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 7%, transparent); border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-5); margin: var(--wb-sp-3) 0; }

/* ==========================================================================
   弹窗（Modal）：替代"内联面板挤压任务列表"的旧形态。
   签名元素 = 两栏悬浮工作台面板：左分区导航 / 右独立滚动 / 粘性底栏。
   ========================================================================== */
/* 非模态浮卡：**不铺遮罩、不拦点击**（草稿弹框用它，避免"弹框一出什么都干不了"）。
   容器本身 pointer-events:none，只有卡片本体接收事件 —— 点卡片外面照样能操作 DSH。
   z-index 305 = 高于设置弹窗（.wb-overlay 300），但低于嵌套浮层（.wb-modal-mask 320 /
   .wb-model-scrim 329 / .wb-model-menu 330）。这样"生成完成"的草稿卡在设置页打开时
   仍然看得见；实测同值 300 时它被后渲染的设置弹窗整个盖住。 */
.wb-dock {
  position: fixed; right: 18px; bottom: 18px; z-index: var(--wb-z-dock);
  pointer-events: none; display: flex; justify-content: flex-end;
}
.wb-dock > .wb-dialog {
  pointer-events: auto;
  max-height: min(70vh, 640px);
  width: min(560px, calc(100vw - 36px));
  box-shadow: var(--wb-sh-5);
  animation: wb-dialog-in .18s cubic-bezier(.2,.9,.3,1);
}
.wb-overlay {
  position: fixed; inset: 0; z-index: var(--wb-z-dialog);
  /* 宿主 overlay 层是 pointer-events:none 且该属性会继承；挂进去后必须自己重新开启，
     否则就是 issue #14 作者说的"看得见点不动"。 */
  pointer-events: auto;
  display: flex; align-items: center; justify-content: center; padding: var(--wb-sp-7);
  background: rgba(0,0,0,.52);
  backdrop-filter: blur(2px);
  animation: wb-overlay-in .16s ease-out;
}
@keyframes wb-overlay-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes wb-dialog-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }

.wb-dialog {
  display: flex; flex-direction: column;
  max-height: min(88vh, 900px); width: 100%;
  background: var(--dsw-alias-bg-layer-2, #1c1c1f);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.22));
  border-radius: var(--wb-r-4);
  box-shadow: var(--wb-sh-5);
  color: var(--dsw-alias-label-primary, #eee);
  font-family: var(--dsw-font-family, system-ui);
  overflow: hidden;
  animation: wb-dialog-in .18s cubic-bezier(.2,.9,.3,1);
}
.wb-dialog:focus { outline: none; }
/* finesse · component: modal · register=product
 * states: default · hover · focus-visible · active · disabled · loading · error · success
 * tokens: inherited (workbench token layer)
 */
.wb-dialog-close:focus-visible, .wb-dialog-foot .wb-btn:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 3px; }
.wb-dialog-close:active, .wb-dialog-foot .wb-btn:active { transform: translateY(1px); }
.wb-dialog-foot .wb-btn:disabled { opacity: .5; cursor: not-allowed; }
.wb-dialog-sm { max-width: 460px; }
.wb-dialog-md { max-width: 620px; }
.wb-dialog-lg { max-width: 860px; }
.wb-dialog-xl { max-width: min(1080px, 94vw); }

.wb-dialog-head {
  flex: none; display: flex; align-items: center; gap: var(--wb-sp-4);
  padding: var(--wb-sp-5) var(--wb-sp-6); border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02));
}
.wb-dialog-head h3 { margin: 0; font-size: var(--wb-fs-4); font-weight: 700; display: flex; align-items: center; gap: var(--wb-sp-3); }
.wb-dialog-head h3 svg { width: 16px; height: 16px; color: var(--dsw-alias-state-business-primary, var(--wb-info)); }
.wb-dialog-head-extra { flex: 1; display: flex; align-items: center; justify-content: flex-end; gap: var(--wb-sp-3); font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }
.wb-dialog-close {
  flex: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: var(--wb-r-2); background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
@media (hover: hover) { .wb-dialog-close:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 8%, transparent); color: var(--dsw-alias-label-primary); } }
.wb-dialog-body { flex: 1; min-height: 0; overflow: auto; padding: var(--wb-sp-6); }
.wb-dialog-foot {
  flex: none; display: flex; align-items: center; justify-content: flex-end; gap: var(--wb-sp-3);
  padding: var(--wb-sp-5) var(--wb-sp-6); border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02));
}
.wb-dialog-foot .wb-foot-note { margin-right: auto; font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }

/* 设置面板：左分区导航 + 右内容 */
.wb-settings { display: grid; grid-template-columns: 168px 1fr; gap: var(--wb-sp-6); min-height: 340px; }
.wb-settings-nav { display: flex; flex-direction: column; gap: var(--wb-sp-1); align-content: start; }
.wb-settings-nav button {
  display: flex; align-items: center; gap: var(--wb-sp-3); width: 100%; text-align: left;
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  padding: var(--wb-sp-3) var(--wb-sp-4); border-radius: var(--wb-r-2); cursor: pointer; font: inherit; font-size: var(--wb-fs-2);
}
.wb-settings-nav button:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 6%, transparent); color: var(--dsw-alias-label-primary); }
.wb-settings-nav button.on {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 14%, transparent);
  color: var(--dsw-alias-label-primary); font-weight: 600;
  box-shadow: var(--wb-ring-select);
}
.wb-settings-nav button .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-business-primary, #4f8ef7); margin-left: auto; flex: none; }
.wb-settings-pane { min-width: 0; }
.wb-settings-pane > section + section { margin-top: var(--wb-sp-6); padding-top: var(--wb-sp-6); border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14)); }
.wb-settings-pane h5 { margin: 0 0 var(--wb-sp-4); font-size: var(--wb-fs-2); font-weight: 700; color: var(--dsw-alias-label-primary); }
.wb-settings-pane .wb-hint { font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); margin: var(--wb-sp-2) 0 0; line-height: 1.6; }
/* ---------------------------------------------------------------------------
   弹框里的提示文字（v1.14.0 修复「提示被上方输入框遮挡」）
   ---------------------------------------------------------------------------
   原来只有 .wb-settings-pane .wb-hint 这一条，于是弹框里的 .wb-hint
   **完全没有样式**：字号继承、行高默认、上下无间距，紧贴着一个行内 input
   渲染，看起来就被输入框压住了。这里补一条全局基线。
   --------------------------------------------------------------------------- */
.wb-hint { font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); margin: var(--wb-sp-2) 0 0; line-height: 1.6; }
/* 字段名右边的小字说明（例如「使用默认工作区」）。inline-flex + 基线对齐，避免与标题挤在一行时错位。 */
.wb-field-note { display: inline-flex; align-items: center; margin-left: var(--wb-sp-3); font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); opacity: .85; }
/* 弹框里的行内勾选项：图标与文字垂直居中，不参与 .wb-field 的列布局。 */
.wb-inline-check { display: flex; align-items: flex-start; gap: var(--wb-sp-2); margin: var(--wb-sp-3) 0 0; font-size: var(--wb-fs-1); line-height: 1.6; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.wb-inline-check input { margin: var(--wb-sp-1) 0 0; flex: none; }
.wb-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--wb-sp-4); }
.wb-field { display: flex; flex-direction: column; gap: var(--wb-sp-2); font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }
/**
 * 字段里"输入框 + 一个按钮"同排（2026-10-01 用户要求："不再记住"按钮与输入框放一行）。
 *
 * 为什么按钮要 flex:none：输入框自带 width:100%，若让它在 flex 里自由伸缩，
 * 长路径会把按钮挤出弹窗（或反过来把输入框压到看不清）。
 * 现在输入框吃剩余宽度（min-width:0 允许收缩）、按钮保持自身宽度不被压扁。
 */
.wb-field-row { display: flex; align-items: center; gap: var(--wb-sp-3); }
.wb-field-row > input, .wb-field-row > select { flex: 1 1 auto; min-width: 0; }
.wb-field-row > .wb-btn { flex: none; white-space: nowrap; }
.wb-field > span { font-size: var(--wb-fs-1); }
.wb-field input, .wb-field select, .wb-field textarea {
  background: var(--dsw-alias-bg-base, #17171a); color: inherit; font: inherit; font-size: var(--wb-fs-2);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18)); border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); width: 100%; box-sizing: border-box;
}
.wb-field input:focus, .wb-field select:focus, .wb-field textarea:focus {
  outline: none; border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f8ef7) 60%, transparent);
  box-shadow: var(--wb-ring-focus);
}
.wb-switch-row { display: flex; align-items: flex-start; gap: var(--wb-sp-3); padding: var(--wb-sp-3) 0; font-size: var(--wb-fs-2); }
.wb-switch-row input { margin-top: var(--wb-sp-1); flex: none; }
.wb-switch-row .wb-switch-desc { display: block; font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); margin-top: var(--wb-sp-1); line-height: 1.5; }

/* --------------------------------------------------------------------------
   知识库召回：可观测回执（v1.15.3）
   日志行是等宽的数字+中文混排，必须允许换行（不换行会把设置弹窗撑出横向滚动）。
   -------------------------------------------------------------------------- */
.wb-recall-log { margin-top: var(--wb-sp-5); border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); padding-top: var(--wb-sp-4); }
.wb-recall-log-head { display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; margin-bottom: var(--wb-sp-2); }
.wb-recall-log-head span { font-size: var(--wb-fs-1); color: var(--dsw-alias-label-secondary); }
.wb-recall-log-head .wb-btn { margin-left: auto; }
.wb-recall-log-lines {
  list-style: none; margin: 0; padding: var(--wb-sp-4) var(--wb-sp-5); max-height: 260px; overflow: auto;
  border-radius: var(--wb-r-3); background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.04));
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--wb-fs-1); line-height: 1.7;
}
.wb-recall-log-lines li { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.wb-recall-sessions { margin-top: var(--wb-sp-5); font-size: var(--wb-fs-1); }
.wb-recall-sessions ul { list-style: none; margin: var(--wb-sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--wb-sp-2); }
.wb-recall-sessions li { display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-recall-sessions code { font-size: var(--wb-fs-1); opacity: .85; overflow-wrap: anywhere; }

/* ==========================================================================
   Toast：浮在右上角，不参与布局
   ========================================================================== */
.wb-toasts { position: fixed; top: 16px; right: 16px; z-index: var(--wb-z-toast); display: flex; flex-direction: column; gap: var(--wb-sp-3); pointer-events: none; }
.wb-toast {
  pointer-events: auto; display: flex; align-items: flex-start; gap: var(--wb-sp-3);
  min-width: 220px; max-width: min(380px, 82vw);
  padding: var(--wb-sp-4) var(--wb-sp-5); border-radius: var(--wb-r-4);
  background: var(--dsw-alias-bg-layer-2, #1c1c1f);
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.2));
  box-shadow: var(--wb-sh-5);
  color: var(--dsw-alias-label-primary, #eee); font-size: var(--wb-fs-2); line-height: 1.5;
  animation: wb-toast-in .18s cubic-bezier(.2,.9,.3,1);
}
.wb-toast.leaving { animation: wb-toast-out .18s ease-in forwards; }
@keyframes wb-toast-in { from { opacity: 0; transform: translateX(10px) } to { opacity: 1; transform: none } }
@keyframes wb-toast-out { to { opacity: 0; transform: translateX(10px) } }
.wb-toast-icon { flex: none; width: 18px; height: 18px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: var(--wb-fs-1); font-weight: 700; }
.wb-toast-msg { flex: 1; min-width: 0; word-break: break-word; }
.wb-toast-close { flex: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: var(--wb-fs-1); padding: var(--wb-sp-1) var(--wb-sp-1); border-radius: var(--wb-r-1); }
.wb-toast-close:hover { color: var(--dsw-alias-label-primary); }
.wb-toast-info { border-left: 3px solid var(--wb-info); }
.wb-toast-info .wb-toast-icon { background: color-mix(in srgb, var(--wb-info) 22%, transparent); color: var(--wb-info-ink); }
.wb-toast-success { border-left: 3px solid var(--wb-ok); }
.wb-toast-success .wb-toast-icon { background: color-mix(in srgb, var(--wb-ok) 22%, transparent); color: var(--wb-ok-ink); }
.wb-toast-warning { border-left: 3px solid var(--wb-warn); }
.wb-toast-warning .wb-toast-icon { background: color-mix(in srgb, var(--wb-warn) 22%, transparent); color: var(--wb-warn-ink); }
.wb-toast-error { border-left: 3px solid var(--wb-danger); }
.wb-toast-error .wb-toast-icon { background: color-mix(in srgb, var(--wb-danger) 22%, transparent); color: var(--wb-danger-ink); }

/* 待处理入口（替代常驻横幅）：标题栏右上角的小药丸 */
.wb-pending-pill {
  display: inline-flex; align-items: center; gap: var(--wb-sp-2); border-radius: 999px; padding: var(--wb-sp-1) var(--wb-sp-4);
  border: 1px solid color-mix(in srgb, var(--wb-warn) 45%, transparent);
  background: color-mix(in srgb, var(--wb-warn) 12%, transparent);
  color: var(--dsw-alias-label-primary); font-size: var(--wb-fs-1); cursor: pointer;
}
.wb-pending-pill:hover { background: color-mix(in srgb, var(--wb-warn) 20%, transparent); }
.wb-pending-pill .count { font-weight: 700; }

/* 弹窗内滚动区域（草稿确认等长内容） */
.wb-scroll-area { max-height: min(46vh, 420px); overflow: auto; padding-right: var(--wb-sp-1); }
/* 草稿弹框的字段行（v1.14.0：补齐信息量，让用户能判断 AI 建得对不对） */
.wb-draft-field { display: flex; gap: var(--wb-sp-3); font-size: var(--wb-fs-1); line-height: 1.7; margin: var(--wb-sp-1) 0; }
.wb-draft-field-k { flex: none; min-width: 76px; color: var(--dsw-alias-label-secondary); }
.wb-draft-field-v { flex: 1; min-width: 0; word-break: break-all; }
/**
 * 专家草稿预览（ExpertDraftBody）：它的字段是**成对的 label / value 直接排在根上**，
 * 所以根必须是两列网格，不能复用 .wb-draft-field 的 flex 行。
 *
 * 实测缺陷（2026-10-18）：根误用了 .wb-draft-field，5 个字段变成 5 个并排的 flex 项，
 * 每列被压到 0–76px、正文一字一行、横向溢出 615px；草稿弹窗里整块不可读。
 */
.wb-expert-draft { display:grid; grid-template-columns:76px minmax(0,1fr); column-gap: var(--wb-sp-3); align-items:start; font-size: var(--wb-fs-1); line-height:1.7; margin: var(--wb-sp-1) 0; }
.wb-expert-draft > .wb-draft-field-k { min-width:0; }
.wb-expert-draft > .wb-draft-field-v { min-width:0; overflow-wrap:anywhere; }
/* 说明 / 提示 / 按钮行不是一对字段：必须横跨两列，否则会被塞进左列。 */
.wb-expert-draft > :not(.wb-draft-field-k):not(.wb-draft-field-v) { grid-column:1 / -1; }
/**
 * 专家预览里的说明文字。
 *
 * ⚠️ 不能复用 .wb-row-meta：那个类是任务行里的四列元数据网格
 * （68/46/56/88px），套到长句子上会把正文塞进第一列 68px，
 * 实测每行只剩 5–6 个字、整块看起来像竖排。这里只保留字号/颜色/换行。
 */
.wb-expert-note { display:block; font-size: var(--wb-fs-1); line-height:1.6; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.wb-expert-draft .wb-row-title { white-space:normal; overflow:visible; text-overflow:clip; }
/* 确认草稿时「本该创建但没创建」的告警条（绝不静默丢件的界面侧防线） */
.wb-draft-problems {
  margin-top: var(--wb-sp-4); padding: var(--wb-sp-3) var(--wb-sp-4); border-radius: var(--wb-r-2); font-size: var(--wb-fs-1); line-height: 1.7;
  border: 1px solid color-mix(in srgb, var(--wb-warn) 42%, transparent); background: color-mix(in srgb, var(--wb-warn) 12%, transparent);
}
.wb-draft-problems h5 { margin: 0 0 var(--wb-sp-1); font-size: var(--wb-fs-1); font-weight: 700; }

/* ===========================================================================
   视觉层 v2（v1.13.0）
   ---------------------------------------------------------------------------
   目标：在**不改变信息架构**的前提下统一视觉语言。
   - 令牌一律映射回宿主 --dsw-alias-*，浅色/深色跟随外壳，不引入自有配色；
   - 边框保持"中档"强度（≈宿主 --dsw-alias-border-l1 的中灰口径）：这是用户
     明确要求的可读性底线，白卡叠白底必须能看出模块边界，不允许再调淡；
   - 强调色**就是宿主品牌色**（2026-10-28 改口径：原先自定的深墨绿与宿主蓝并存，
     同一界面两套强调色，已收成一个源，见下方令牌块注记）；
   - 字号收敛为三档，分割线统一 1px 发丝，卡片圆角 12px + 轻阴影。
   =========================================================================== */
[data-dsh-personal-workbench-view] {
  /* 后代的 @container 按面板宽度判定，而不是窗口宽度（1296 窗口 / 990 面板会让按钮文字展开后被裁切） */
  container-type: inline-size;
}

/* 令牌层（2026-10-23 修复）：弹窗/浮层被 portal 到宿主 overlay 层，**不在面板子树里**，
   只挂在 [data-...-view] 上会让 .wb-dialog 里所有 var(--wb-*) 取不到值 ——
   表现就是"内边距全丢、标题和输入框挤在一起"。所以 portal 出来的根节点也要带上同一套令牌。

   2026-10-27 补齐：上一版只列了 .wb-overlay / .wb-dock / .wb-dialog，**漏了 4 个 portal 浮层根**
   —— .wb-model-menu（ModelPicker）、.wb-tagmenu（TagFilter）、.wb-idea-foldmenu（IdeaCardGrid）、
   .wb-toasts（ToastHost）都走 createPortal(menu, overlayMountContainer())，落点是
   [data-shell-overlay] 或 document.body，与面板是**兄弟节点**。漏在列表里的后果：
   这些浮层里任何 var(--wb-*) 都解析失败（阴影/颜色直接消失），所以历史上它们只能写死字面值。
   .wb-modal-mask 是内联渲染的，一并列上是为了不依赖"它恰好没被 portal"这个巧合。
   ⚠️ 本文件整体在模板字符串里：注释中**不能出现反引号**，否则会提前闭合字面量、tsc 直接报语法错。

   2026-10-27 再补一笔：**会话标题栏那枚入口（.wb-header-entry）也在这里面之外。**
   它挂在宿主的 conversation.session.header.actions 槽位里，同样不在面板子树里 ——
   漏掉它的后果与弹窗那次一模一样，只是更隐蔽：--wb-sp-* / --wb-fs-* / --wb-r-*
   **只定义在本规则块里**（不像 --wb-label-* 那样由 tokenLayerCss() 铺到 :root），
   于是那枚按钮的 padding / font-size / border-radius / gap 全部"无效化"：
   font-size 退回继承宿主的 16px（比旁边那排 13px 的 chip 大一圈），
   padding 与圆角退回初始值（贴字、没有药丸形）。用户 2026-10-27 的原话是"工作台字号在小一号"。 */
[data-dsh-personal-workbench-view], .wb-overlay, .wb-dock, .wb-dialog,
.wb-modal-mask, .wb-model-menu, .wb-tagmenu, .wb-idea-foldmenu, .wb-toasts,
.wb-header-entry {
  /* 强调色（2026-10-28 定案：**与 DSH 统一一个色系**）
     ---------------------------------------------------------------------------
     强调色不再自带一套，而是**直接取宿主品牌色** --wb-state-business-primary
     （= --dsw-alias-state-business-primary；DSH 是 deepseek-500 #4176e6 / 深色 400 #7aaaff）。

     历史：这里原本硬编码墨绿 color-mix(#2E9B7B 62%, #14493A)，而环线/选中/表单聚焦
     引用的是宿主蓝 —— 同一界面里两套强调色并存（2026-10-27 记为"待产品决策"）。
     现在只有**一个源**：换色只改这一行，回退墨绿也只改这一行。
     配套：entryContract.ts 的 TOKENS 把回退值也换成了 DSH 自己的色阶取值。 */
  --wb-accent: var(--wb-state-business-primary);
  --wb-accent-soft: color-mix(in srgb, var(--wb-accent) 12%, transparent);
  --wb-accent-line: color-mix(in srgb, var(--wb-accent) 38%, transparent);
  /* 文字与结构线：一律走令牌层（这里的字面回退值已经全部搬进 entryContract.TOKENS，
     就地再写一份就等于"两处各挑一个近似色"，正是色系跑偏的老路）。 */
  --wb-ink-1: var(--wb-label-primary);
  --wb-ink-2: var(--wb-label-secondary);
  --wb-ink-3: color-mix(in srgb, var(--wb-label-secondary) 95%, transparent);
  --wb-line: var(--wb-border-l1);
  --wb-line-soft: color-mix(in srgb, var(--wb-border-l1) 62%, transparent);
  /* 边框统一（round7）：原先两套词表 —— --wb-line*（走宿主 border-l1，定义在本作用域，浮层也拿得到）
     与 --wb-border*（走 color-mix(label-primary 26%)，只定义在 .wb-app 上，portal 浮层继承不到）。
     现在收成一套三档：line（结构边框）/ line-soft（分隔、虚线空态）/ line-strong（胶囊、菜单、面板）。
     line-strong 的值就是原 --wb-border 的口径，所以观感不变。 */
  --wb-line-strong: color-mix(in srgb, var(--wb-ink-1) 26%, transparent);
  --wb-line-quiet: color-mix(in srgb, var(--wb-ink-1) 15%, transparent);
  /* 标记条（round7）：同一视觉角色原先 2px 绿 / 3px 蓝两种写法。统一 3px + accent。
     下划线是另一个角色（页签当前项），2px，也统一到 accent。 */
  --wb-bar: inset 3px 0 0 var(--wb-accent);
  --wb-underline: inset 0 -2px 0 var(--wb-accent);
  --wb-surface: var(--wb-bg-layer-1);
  --wb-sunk: var(--wb-bg-base);
  /* 层叠阶梯（round7）：数值冻结，只给名字；顺序由 test/tokenScope.test.mjs 断言。
     表在 entryContract.ts 的 Z_LAYERS 里，这里由它渲染，避免两处各写一份。 */
  ${zLayerCss()}
  /* 阴影阶梯（第三轮）：13 种外投影字面量 → 5 档。
     按"视觉重量（alpha 带）"归并，不按像素就近 —— 令牌编的是**角色**，不是尺寸：
       1=微抬（页签/行） 2=卡片 3=强调卡片·悬浮 4=浮层（菜单/侧板/横幅） 5=顶层（对话框/toast）。
     ⚠️ 环线（描边）是另一类，别塞进 sh-*：内描边是"选中"，外描边是"框住"，都不是投影。 */
  --wb-sh-1: 0 1px 2px rgba(0,0,0,.05);
  --wb-sh-2: 0 2px 8px rgba(0,0,0,.06);
  --wb-sh-3: 0 6px 18px rgba(0,0,0,.10);
  --wb-sh-4: 0 10px 28px rgba(0,0,0,.18);
  --wb-sh-5: 0 18px 50px rgba(0,0,0,.42);
  /* 环线阶梯：浓度原为 22/28/30/32%（内选中）、35%（外框住）、14/16%（聚焦）、70%（今日选中）
     —— 收成 30% / 34% / 15% / 70%，同角色只留一个浓度。 */
  --wb-ring-select: inset 0 0 0 1px color-mix(in srgb, var(--wb-state-business-primary) 30%, transparent);
  --wb-ring-out: 0 0 0 1px color-mix(in srgb, var(--wb-state-business-primary) 34%, transparent);
  --wb-ring-focus: 0 0 0 3px color-mix(in srgb, var(--wb-state-business-primary) 15%, transparent);
  --wb-ring-today: inset 0 0 0 2px color-mix(in srgb, var(--wb-state-business-primary) 70%, transparent);
  /* 圆角刻度（第二轮）：6 / 8 / 10 / 12。胶囊与圆形统一 999px，不算档位。 */
  --wb-r-1: 6px; --wb-r-2: 8px; --wb-r-3: 10px; --wb-r-4: 12px;
  /* 控件高度（2026-10-28 视觉对齐）：顶栏同一行里 待处理胶囊 23 / 页签 27.6 / 图标按钮 29 /
     主按钮 29.6 —— 4 种高度并排，看起来就是"没对齐"。收成这一个刻度，顶栏控件一律等高。 */
  --wb-ctl-h: 28px;
  /* 间距刻度（第二轮）：2 / 6 / 8 / 10 / 12 / 16 / 24。由 21 种字面量按 k-median 归并而来。 */
  --wb-sp-1: 2px; --wb-sp-2: 6px; --wb-sp-3: 8px; --wb-sp-4: 10px;
  --wb-sp-5: 12px; --wb-sp-6: 16px; --wb-sp-7: 24px;
  /* 字号刻度（第一轮：14 档 → 6 档）。只做文本，不覆盖徽标容器尺寸。
     1=元信息 12 / 2=正文 13 / 3=小标题 14 / 4=面板标题 16 / 5=大数字 20 / 6=展示 24 */
  --wb-fs-1: 12px; --wb-fs-2: 13px; --wb-fs-3: 14px;
  --wb-fs-4: 16px; --wb-fs-5: 20px; --wb-fs-6: 24px;
  /* 状态语义色（第三轮收敛，2026-10-28 改口径）：主色 + ink 两档仍然保留，
     但两边都**从宿主语义别名派生**（--wb-state-*-primary / --wb-link），
     不再是我们自己挑的琥珀/红/绿/灰。DSH 的语义色阶见 entryContract.ts 的 TOKENS。

     色系对应：
       警告 = amber-500 #f59e0b   危险 = red-600/400    成功 = green-500 #22c55e
       信息 = deepseek-500/400（与强调色同源）           中性 = neutral-bluish-600/400

     ink 档仍然是"往宿主深中性里压一档"的派生色，因为主色当小字对比不足
     （#f59e0b 压白底 2.1:1、#22c55e 3.0:1）。实测对比：
       warn-ink  #8e6115 → 5.4:1（压 12% 琥珀底 4.7:1）
       ok-ink    #147a3a → 5.4:1（压 12% 绿底 4.9:1）
       danger-ink#d11313 → 5.5:1（压 12% 红底 4.5:1）
       info-ink  #345eb6 → 6.1:1（压 12% 蓝底 5.1:1）
     深色主题直接用主色（宿主深色档本身就是浅色值，压深底 5.5~8.5:1）。 */
  --wb-warn: var(--wb-state-warn-primary);
  --wb-warn-ink: light-dark(color-mix(in srgb, var(--wb-warn) 50%, #27241f), var(--wb-warn));
  --wb-danger: var(--wb-state-error-primary);
  --wb-danger-ink: light-dark(color-mix(in srgb, var(--wb-danger) 88%, #0f0f0f), var(--wb-danger));
  --wb-ok: var(--wb-state-success-primary);
  --wb-ok-ink: light-dark(color-mix(in srgb, var(--wb-ok) 50%, #052e16), var(--wb-ok));
  --wb-info: var(--wb-link);
  --wb-info-ink: light-dark(color-mix(in srgb, var(--wb-info) 75%, #0b1424), var(--wb-info));
  --wb-neutral: var(--wb-label-tertiary);
  /* 优先级：p0 危险 / p1 警告 / p2 强调 / p3 中性 —— 与宿主语义色一一对应，
     不再有 p2 那个既不是宿主蓝也不是我们强调色的 #3498DB。 */
  --wb-p0: var(--wb-danger); --wb-p1: var(--wb-warn); --wb-p2: var(--wb-accent); --wb-p3: var(--wb-neutral);
  /* 优先级徽标底色：白字要够对比，所以不能直接用 p1/p2 的亮色，压一档深中性
     （p1 4.6:1 / p2 5.6:1）。 */
  --wb-prio-p1-bg: color-mix(in srgb, var(--wb-p1) 56%, #27241f);
  --wb-prio-p2-bg: color-mix(in srgb, var(--wb-p2) 82%, #0b1424);
  /* ABA 分层是**分类色**（头部 / 中部 / 长尾），不是状态色：三色成阶梯，单独命名。
     同色不同义要分开 —— 头=成功绿（值得做）、中=强调蓝（可观察）、尾=中性灰（弱）。
     原先的紫色 #8B7BE8 不在宿主调色板里，已去掉。 */
  --wb-tier-middle: var(--wb-accent); --wb-tier-tail: var(--wb-neutral);
  /* 行高基线：72 条小字号规则没有声明 line-height，抬到 12px 后不能再继承宿主
     （宿主若给 1.6–1.7，42 行列表会凭空长高）。稠密档统一 1.3；正文段落各自声明 1.5–1.7 的照旧。 */
  line-height: 1.3;
}

/* 顶栏：低频操作图标化后不再抢注意力，标题与分段导航是唯一入口 */
[data-dsh-personal-workbench-view] .wb-h {
  padding: var(--wb-sp-4) var(--wb-sp-5); gap: var(--wb-sp-3);
  border-bottom: 1px solid var(--wb-line);
  background: var(--dsw-alias-bg-layer-2, var(--wb-surface));
}
[data-dsh-personal-workbench-view] .wb-title { font-size: var(--wb-fs-3); font-weight: 650; }
[data-dsh-personal-workbench-view] .wb-title svg { color: var(--wb-accent); }
[data-dsh-personal-workbench-view] .wb-segmented {
  padding: var(--wb-sp-1); border-radius: 999px;
  background: var(--wb-sunk); border: 1px solid var(--wb-line-soft);
}
[data-dsh-personal-workbench-view] .wb-seg { padding: var(--wb-sp-2) var(--wb-sp-5); border-radius: 999px; font-size: var(--wb-fs-1); font-weight: 500; gap: var(--wb-sp-2); }
[data-dsh-personal-workbench-view] .wb-seg.on {
  background: var(--wb-surface); color: var(--wb-ink-1); font-weight: 600;
  box-shadow: var(--wb-sh-1);
}
[data-dsh-personal-workbench-view] .wb-seg.on svg { color: var(--wb-accent); }
[data-dsh-personal-workbench-view] .wb-sub-segmented .wb-seg { padding: var(--wb-sp-1) var(--wb-sp-4); font-size: var(--wb-fs-1); }

/* 按钮：统一 8px 圆角；主操作走强调色 */
[data-dsh-personal-workbench-view] .wb-btn {
  border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); font-size: var(--wb-fs-1);
  border: 1px solid var(--wb-line); background: var(--wb-surface);
}
[data-dsh-personal-workbench-view] .wb-btn:hover { background: color-mix(in srgb, var(--wb-ink-1) 6%, transparent); }
[data-dsh-personal-workbench-view] .wb-btn.primary {
  background: var(--wb-accent); border-color: transparent; color: #fff;
}
[data-dsh-personal-workbench-view] .wb-btn.primary:hover { background: color-mix(in srgb, var(--wb-accent) 88%, #000); }
/* 顶栏右侧的动作簇（2026-10-28）：原先「待处理胶囊 + 5 个按钮」是 .wb-h 的直接子项，
   面板不够宽时整簇会被拆到两行（胶囊留在第一行右端、按钮掉到第二行），看起来像没对齐。
   收进一个 flex 容器后，它要么整簇在右端，要么整簇换行；margin-left:auto 负责靠右。
   ⚠️ 本文件整体在模板字符串里：注释中不能出现反引号（会提前闭合字面量）。 */
[data-dsh-personal-workbench-view] .wb-h-actions {
  display: flex; align-items: center; justify-content: flex-end;
  gap: var(--wb-sp-3); flex: 0 1 auto; flex-wrap: wrap;
  margin-left: auto; min-width: 0;
}
/* 顶栏控件等高：待处理胶囊 / 页签 / 按钮共用 --wb-ctl-h，图标按钮同时收成正方形。
   （测量值：胶囊 23、页签 27.6、图标按钮 29、主按钮 29.6 —— 同一行四种高度。） */
[data-dsh-personal-workbench-view] .wb-h .wb-btn,
[data-dsh-personal-workbench-view] .wb-h .wb-seg,
[data-dsh-personal-workbench-view] .wb-h .wb-pending-pill { height: var(--wb-ctl-h); box-sizing: border-box; }
[data-dsh-personal-workbench-view] .wb-h .wb-h-actions .wb-btn { flex: 0 0 auto; }
[data-dsh-personal-workbench-view] .wb-h-actions .wb-btn:not(.primary) { border-color: transparent; background: transparent; }
[data-dsh-personal-workbench-view] .wb-h-actions .wb-btn:not(.primary):hover { background: color-mix(in srgb, var(--wb-ink-1) 7%, transparent); }
[data-dsh-personal-workbench-view] .wb-h-actions .wb-btn:not(.primary) { padding: 0; width: var(--wb-ctl-h); justify-content: center; }
[data-dsh-personal-workbench-view] .wb-h-actions .wb-btn:not(.primary) .wb-label { display: none; }
@container (min-width: 1200px) {
  [data-dsh-personal-workbench-view] .wb-h-actions .wb-btn:not(.primary) .wb-label { display: inline; }
  /* 宽面板才显示文字：此时不能再钉死正方形宽度，否则文字会被挤出去 */
  [data-dsh-personal-workbench-view] .wb-h-actions .wb-btn:not(.primary) { width: auto; padding: 0 var(--wb-sp-3); }
}

/* 统计卡：保持卡片与边框（可读性底线），只收敛字号与留白 */
[data-dsh-personal-workbench-view] .wb-stats { gap: var(--wb-sp-4); margin-bottom: var(--wb-sp-5); }
[data-dsh-personal-workbench-view] .wb-stats-sticky {
  background: var(--dsw-alias-bg-base, var(--wb-sunk));
  border-bottom: 1px solid var(--wb-line); padding: var(--wb-sp-5) var(--wb-sp-6) var(--wb-sp-5); margin: 0 calc(var(--wb-sp-6) * -1) var(--wb-sp-5);
}
[data-dsh-personal-workbench-view] .wb-stat {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-4); background: var(--wb-surface);
  box-shadow: var(--wb-sh-1); padding: var(--wb-sp-5) var(--wb-sp-5);
}
[data-dsh-personal-workbench-view] .wb-stat b { font-size: var(--wb-fs-6); font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
[data-dsh-personal-workbench-view] .wb-stat span { font-size: var(--wb-fs-1); }

/* 今日容量条（新增元素：把"今天投得进多少时间"显式化） */
[data-dsh-personal-workbench-view] .wb-cap {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-4); background: var(--wb-surface);
  box-shadow: var(--wb-sh-1); padding: var(--wb-sp-5) var(--wb-sp-5); margin-bottom: var(--wb-sp-5);
}
[data-dsh-personal-workbench-view] .wb-cap-head { display: flex; align-items: baseline; gap: var(--wb-sp-4); margin-bottom: var(--wb-sp-3); }
[data-dsh-personal-workbench-view] .wb-cap-head h3 { margin: 0; font-size: var(--wb-fs-1); font-weight: 650; }
[data-dsh-personal-workbench-view] .wb-cap-meta {
  margin-left: auto; display: flex; gap: var(--wb-sp-5); font-size: var(--wb-fs-1); color: var(--wb-ink-3);
  font-variant-numeric: tabular-nums;
}
[data-dsh-personal-workbench-view] .wb-cap-meta b { color: var(--wb-ink-1); font-weight: 650; }
[data-dsh-personal-workbench-view] .wb-cap-edit { border-bottom: 1px dashed var(--wb-line); cursor: pointer; }
[data-dsh-personal-workbench-view] .wb-cap-bar {
  display: flex; gap: var(--wb-sp-1); height: 9px; border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--wb-ink-1) 9%, transparent);
}
[data-dsh-personal-workbench-view] .wb-cap-bar i { display: block; height: 100%; border-radius: var(--wb-r-1); }
[data-dsh-personal-workbench-view] .wb-cap-bar i.p0 { background: var(--wb-p0); }
[data-dsh-personal-workbench-view] .wb-cap-bar i.p1 { background: var(--wb-p1); }
[data-dsh-personal-workbench-view] .wb-cap-bar i.p2 { background: var(--wb-p2); }
[data-dsh-personal-workbench-view] .wb-cap-bar i.p3 { background: var(--wb-p3); }
[data-dsh-personal-workbench-view] .wb-cap-bar i.free { background: color-mix(in srgb, var(--wb-ok) 36%, transparent); }
[data-dsh-personal-workbench-view] .wb-cap-legend { display: flex; align-items: center; gap: var(--wb-sp-5); margin-top: var(--wb-sp-3); font-size: var(--wb-fs-1); color: var(--wb-ink-2); flex-wrap: wrap; }
[data-dsh-personal-workbench-view] .wb-cap-legend span { display: inline-flex; align-items: center; gap: var(--wb-sp-2); }
[data-dsh-personal-workbench-view] .wb-cap-legend i { width: 7px; height: 7px; border-radius: var(--wb-r-1); flex: none; }
[data-dsh-personal-workbench-view] .wb-cap-legend b { color: var(--wb-ink-1); font-weight: 650; font-variant-numeric: tabular-nums; }

/* ── 今日容量：规则与账本（v1.15.1）──────────────────────────────────────────
   目标：用户看到的每个数字都能在账本里找到出处，且规则写在界面上而不是只写在代码里。
   小屏可滚动（不挤坏上面的容量条 —— 布局类缺陷由 harness 的像素断言守）。 */
[data-dsh-personal-workbench-view] .wb-cap-rule { margin-top: var(--wb-sp-4); border-top: 1px dashed var(--wb-line); padding-top: var(--wb-sp-3); }
[data-dsh-personal-workbench-view] .wb-cap-rule-head { display: flex; align-items: baseline; gap: var(--wb-sp-4); flex-wrap: wrap; }
[data-dsh-personal-workbench-view] .wb-cap-rule-toggle {
  background: none; border: 1px solid var(--wb-line); border-radius: var(--wb-r-2);
  color: var(--wb-ink-2); font: inherit; font-size: var(--wb-fs-1); padding: var(--wb-sp-1) var(--wb-sp-3); cursor: pointer; flex: none;
  /* 两态等宽：内容是固定的「箭头 + 规则」，宽度不随开合变化 */
  display: inline-flex; align-items: center; gap: var(--wb-sp-1);
}
[data-dsh-personal-workbench-view] .wb-cap-rule-toggle:hover { color: var(--wb-ink-1); border-color: var(--wb-ink-3); }
/* 箭头按展开态旋转：
   Icon name="chevron" 的字形是**左向**（‹），所以折叠态先转 -90° 变成"下"（⌄），
   展开态再转 +90° 变成"上"（⌃）。两态之间正好差 180°，且**字形与占位都不变**，
   按钮盒子尺寸因此逐像素一致。 */
[data-dsh-personal-workbench-view] .wb-cap-rule-arrow { display: inline-flex; transform: rotate(-90deg); transition: transform .15s ease; }
[data-dsh-personal-workbench-view] .wb-cap-rule[data-cap-expanded='1'] .wb-cap-rule-arrow { transform: rotate(90deg); }

/**
 * 内联模式：把「规则」块**拆开**——头部那个开关留在容量图例那一行，展开体拿到全宽下方。
 *
 * 'display: contents' 让 '.wb-cap-rule' 这个壳不生成盒子，它的两个孩子直接成为图例 flex 行的成员：
 * 头部（含开关）就落在图例行里，展开体（'flex-basis:100%'）被挤到下一行、横跨整幅宽度。
 * 这比"把整块塞进图例行"正确得多：早期版本一展开，长内容全挤在那条窄行里，
 * 连带把开关推来推去（用户原话："打开、收起规则的按钮还不在同一个位置"）。
 */
[data-dsh-personal-workbench-view] .wb-cap-legend {
  display: flex; align-items: center; gap: var(--wb-sp-5); flex-wrap: wrap;
  font-size: var(--wb-fs-1); color: var(--wb-ink-2); font-variant-numeric: tabular-nums;
}
[data-dsh-personal-workbench-view] .wb-cap-legend .wb-cap-legend-item { display: inline-flex; align-items: center; gap: var(--wb-sp-1); }
/**
 * 展开时图例项**保留占位、只是看不见**（visibility:hidden，不是 display:none）。
 *
 * 为什么不能用 display:none：那样整行会变窄，右推的按钮就**从右端滑到左端**
 * （2026-10-01 实测：折叠态按钮 x=593，展开态变成 x=313 —— 正是用户说的
 * "打开、收起规则的按钮不在同一个位置"）。保留占位后按钮横向位置一个像素都不动。
 * 语义上也没问题：图例是"容量条的分段说明"，展开规则时把它视觉上让位即可。
 */
[data-dsh-personal-workbench-view] .wb-cap-legend[data-cap-expanded='1'] .wb-cap-legend-item { visibility: hidden; }
[data-dsh-personal-workbench-view] .wb-cap-legend .wb-cap-rule { display: contents; margin: 0; border: 0; padding: 0; }
[data-dsh-personal-workbench-view] .wb-cap-legend .wb-cap-rule-sum { display: none; }
/* 按钮永远贴在**右端**：两态（含展开态图例项被让位）位置都一致 */
[data-dsh-personal-workbench-view] .wb-cap-legend .wb-cap-rule-head { display: inline-flex; align-items: center; gap: 0; flex: none; margin-left: auto; }
[data-dsh-personal-workbench-view] .wb-cap-legend .wb-cap-rule-body { flex-basis: 100%; margin-top: var(--wb-sp-2); }
[data-dsh-personal-workbench-view] .wb-cap-rule-sum { font-size: var(--wb-fs-1); color: var(--wb-ink-3); font-variant-numeric: tabular-nums; }
[data-dsh-personal-workbench-view] .wb-cap-rule-sum b { color: var(--wb-ink-1); font-weight: 650; }
[data-dsh-personal-workbench-view] .wb-cap-rule-body { margin-top: var(--wb-sp-3); display: flex; flex-direction: column; gap: var(--wb-sp-4); }
[data-dsh-personal-workbench-view] .wb-cap-rules {
  margin: 0; padding-left: var(--wb-sp-6); font-size: var(--wb-fs-1); line-height: 1.75; color: var(--wb-ink-2);
}
[data-dsh-personal-workbench-view] .wb-cap-rules b { color: var(--wb-ink-1); font-weight: 650; }
[data-dsh-personal-workbench-view] .wb-cap-audit-wrap, [data-dsh-personal-workbench-view] .wb-cap-overdue, [data-dsh-personal-workbench-view] .wb-cap-unscheduled {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-4); overflow: hidden;
}
[data-dsh-personal-workbench-view] .wb-cap-audit-title, [data-dsh-personal-workbench-view] .wb-cap-overdue-head {
  font-size: var(--wb-fs-1); font-weight: 650; color: var(--wb-ink-2);
  padding: var(--wb-sp-2) var(--wb-sp-4); background: color-mix(in srgb, var(--wb-ink-1) 4%, transparent);
}
[data-dsh-personal-workbench-view] .wb-cap-overdue-head b { color: var(--wb-warn, var(--wb-warn-ink)); font-weight: 650; }
[data-dsh-personal-workbench-view] .wb-cap-audit-empty { font-size: var(--wb-fs-1); color: var(--wb-ink-3); padding: var(--wb-sp-3) var(--wb-sp-4); }
[data-dsh-personal-workbench-view] .wb-cap-audit { width: 100%; border-collapse: collapse; font-size: var(--wb-fs-1); }
[data-dsh-personal-workbench-view] .wb-cap-audit th {
  text-align: left; font-weight: 600; color: var(--wb-ink-3); padding: var(--wb-sp-2) var(--wb-sp-4);
  border-bottom: 1px solid var(--wb-line);
}
[data-dsh-personal-workbench-view] .wb-cap-audit td { padding: var(--wb-sp-2) var(--wb-sp-4); border-bottom: 1px solid color-mix(in srgb, var(--wb-line) 60%, transparent); vertical-align: top; }
[data-dsh-personal-workbench-view] .wb-cap-audit tr:last-child td { border-bottom: none; }
[data-dsh-personal-workbench-view] .wb-cap-audit td.t { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-personal-workbench-view] .wb-cap-audit td.p, [data-dsh-personal-workbench-view] .wb-cap-audit td.m { font-variant-numeric: tabular-nums; white-space: nowrap; }
[data-dsh-personal-workbench-view] .wb-cap-audit td.s { display: flex; flex-wrap: wrap; gap: var(--wb-sp-1); }
[data-dsh-personal-workbench-view] .wb-cap-audit .tag {
  font-size: var(--wb-fs-1); padding: var(--wb-sp-1) var(--wb-sp-2); border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--wb-line); color: var(--wb-ink-3);
}
[data-dsh-personal-workbench-view] .wb-cap-audit-total {
  font-size: var(--wb-fs-1); font-weight: 650; color: var(--wb-ink-1);
  padding: var(--wb-sp-2) var(--wb-sp-4); border-top: 1px solid var(--wb-line);
  background: color-mix(in srgb, var(--wb-ink-1) 4%, transparent);
}
[data-dsh-personal-workbench-view] .wb-cap-switch {
  display: flex; align-items: center; gap: var(--wb-sp-2); font-size: var(--wb-fs-1); color: var(--wb-ink-2); cursor: pointer;
}
[data-dsh-personal-workbench-view] .wb-cap-switch input { flex: none; }
[data-dsh-personal-workbench-view] .wb-cap-switch .hint {
  width: 16px; height: 16px; border-radius: 999px; border: 1px solid var(--wb-line);
  display: inline-flex; align-items: center; justify-content: center; font-size: var(--wb-fs-1); color: var(--wb-ink-3); cursor: help;
}
[data-dsh-personal-workbench-view] .wb-cap-foot { font-size: var(--wb-fs-1); color: var(--wb-ink-3); }

/* 卡片 / 列表 / 计划：统一边框强度与阴影，行分割线改发丝 */
[data-dsh-personal-workbench-view] .wb-card {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-2); background: var(--wb-surface);
  box-shadow: var(--wb-sh-1); padding: var(--wb-sp-5) var(--wb-sp-5); margin-bottom: var(--wb-sp-5);
}
[data-dsh-personal-workbench-view] .wb-card h4 { font-size: var(--wb-fs-2); padding-bottom: var(--wb-sp-3); border-bottom: 1px solid var(--wb-line-soft); }
/**
 * ⚠️ 进度卡里的 h4 **不是卡片标题**，不该继承上面那条"标题下划线"。
 *
 * 为什么必须写在**这里**而不是上面那条 .wb-progress-card h4 里：
 * 上面那条选择器带 [data-dsh-personal-workbench-view]，**特异性更高**，
 * 后来者再写 .wb-progress-card h4 也压不过它 —— 2026-10-01 实测踩到：
 * 我先把覆盖规则写在 233 行，跑真机一看下划线还在、padding-bottom 仍是 9px。
 * 规矩：皮肤层的覆盖要写在**同层且更靠后**（或用等特异性 + 更靠后）。
 */
[data-dsh-personal-workbench-view] .wb-progress-card { padding: var(--wb-sp-2) var(--wb-sp-4); }
[data-dsh-personal-workbench-view] .wb-progress-card h4 {
  margin: 0; padding-bottom: 0; border-bottom: none;
  font-size: var(--wb-fs-1); font-weight: 600; color: var(--wb-ink-3);
}
[data-dsh-personal-workbench-view] .wb-list {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-4); background: var(--wb-surface);
  box-shadow: var(--wb-sh-1); overflow: hidden;
}
[data-dsh-personal-workbench-view] .wb-row { padding: var(--wb-sp-4) var(--wb-sp-5); border-bottom: 1px solid var(--wb-line-soft); }
[data-dsh-personal-workbench-view] .wb-row.selected {
  background: var(--wb-accent-soft); box-shadow: var(--wb-bar);
}
[data-dsh-personal-workbench-view] .wb-plan {
  border: 1px solid var(--wb-line); border-left: 1px solid var(--wb-line);
  border-radius: var(--wb-r-4); background: var(--wb-surface); box-shadow: var(--wb-sh-1); overflow: hidden;
}
[data-dsh-personal-workbench-view] .wb-plan-item { font-size: var(--wb-fs-2); }

/* 日历：日期卡保留边框，选中/今天用强调色描边而非整块填色 */
[data-dsh-personal-workbench-view] .wb-day {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-4); background: var(--wb-surface);
  box-shadow: var(--wb-sh-1); min-height: 82px;
}
[data-dsh-personal-workbench-view] .wb-day.today { border-color: var(--wb-accent-line); background: var(--wb-accent-soft); }
[data-dsh-personal-workbench-view] .wb-day.selected { border-color: var(--wb-accent); box-shadow: 0 0 0 1px var(--wb-accent-line), var(--wb-sh-1); }
[data-dsh-personal-workbench-view] .wb-mday {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-3); background: var(--wb-surface); box-shadow: var(--wb-sh-1);
}
[data-dsh-personal-workbench-view] .wb-mday.today { border-color: var(--wb-accent-line); background: var(--wb-accent-soft); }
[data-dsh-personal-workbench-view] .wb-mday.selected { background: var(--wb-accent-soft); border-color: var(--wb-accent); }

/* 待处理入口：与整体强调色一致，不再单独用黄色 */
[data-dsh-personal-workbench-view] .wb-pending-pill {
  border-color: var(--wb-accent-line); background: var(--wb-accent-soft); color: var(--wb-ink-1);
}
[data-dsh-personal-workbench-view] .wb-pending-pill:hover { background: color-mix(in srgb, var(--wb-accent) 20%, transparent); }

/* 表单控件：统一边框强度，避免"浅色下看不见输入框" */
[data-dsh-personal-workbench-view] .wb-form label { font-size: var(--wb-fs-1); }
[data-dsh-personal-workbench-view] .wb-form input,
[data-dsh-personal-workbench-view] .wb-form select,
[data-dsh-personal-workbench-view] .wb-form textarea,
[data-dsh-personal-workbench-view] .wb-skill-search,
[data-dsh-personal-workbench-view] .wb-plan-edit-note,
[data-dsh-personal-workbench-view] .wb-plan-add {
  border: 1px solid var(--wb-line); border-radius: var(--wb-r-2);
}
[data-dsh-personal-workbench-view] .wb-form input:focus,
[data-dsh-personal-workbench-view] .wb-form select:focus,
[data-dsh-personal-workbench-view] .wb-form textarea:focus,
[data-dsh-personal-workbench-view] .wb-skill-search:focus {
  outline: none; border-color: var(--wb-accent-line); box-shadow: 0 0 0 2px var(--wb-accent-soft);
}

/* 行内操作：静息态保持干净，hover / 选中才出现 */
[data-dsh-personal-workbench-view] .wb-row-acts { display: flex; gap: var(--wb-sp-2); opacity: 0; transition: opacity .12s ease; flex: none; }
[data-dsh-personal-workbench-view] .wb-row:hover .wb-row-acts,
[data-dsh-personal-workbench-view] .wb-row.selected .wb-row-acts,
[data-dsh-personal-workbench-view] .wb-row:focus-within .wb-row-acts { opacity: 1; }

/* 空态：从灰底占位改为邀请式文案 */
[data-dsh-personal-workbench-view] .wb-empty { padding: var(--wb-sp-7) var(--wb-sp-6); }
[data-dsh-personal-workbench-view] .wb-empty-ic {
  width: 34px; height: 34px; margin: 0 auto var(--wb-sp-3); border-radius: var(--wb-r-3);
  display: grid; place-items: center; background: var(--wb-accent-soft); color: var(--wb-accent);
}

/* 点子文件夹（v1.13.0 新增：文件夹优先） */
[data-dsh-personal-workbench-view] .wb-idea-crumb {
  display: flex; align-items: center; gap: var(--wb-sp-2); font-size: var(--wb-fs-1); color: var(--wb-ink-3); margin-bottom: var(--wb-sp-4);
}
[data-dsh-personal-workbench-view] .wb-idea-crumb b { color: var(--wb-ink-1); font-weight: 650; }
[data-dsh-personal-workbench-view] .wb-folder-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(238px, 1fr)); gap: var(--wb-sp-4); margin-bottom: var(--wb-sp-6);
}
[data-dsh-personal-workbench-view] .wb-folder {
  position: relative; border: 1px solid var(--wb-line); border-radius: var(--wb-r-4);
  background: var(--wb-surface); box-shadow: var(--wb-sh-1); padding: var(--wb-sp-5) var(--wb-sp-5); cursor: pointer;
  transition: border-color .12s ease, background .12s ease;
}
[data-dsh-personal-workbench-view] .wb-folder:hover { border-color: color-mix(in srgb, var(--wb-line) 60%, var(--wb-ink-2)); }
[data-dsh-personal-workbench-view] .wb-folder.selected { border-color: var(--wb-accent-line); background: var(--wb-accent-soft); }
[data-dsh-personal-workbench-view] .wb-folder-head { display: flex; align-items: center; gap: var(--wb-sp-3); margin-bottom: var(--wb-sp-3); }
[data-dsh-personal-workbench-view] .wb-folder-ic {
  width: 25px; height: 25px; border-radius: var(--wb-r-2); flex: none; display: grid; place-items: center;
  background: var(--wb-accent-soft); color: var(--wb-accent);
}
[data-dsh-personal-workbench-view] .wb-folder-head h4 {
  margin: 0; flex: 1; min-width: 0; font-size: var(--wb-fs-2); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-dsh-personal-workbench-view] .wb-folder-cnt {
  flex: none; font-size: var(--wb-fs-1); font-weight: 650; font-variant-numeric: tabular-nums;
  background: var(--wb-sunk); border: 1px solid var(--wb-line-soft); border-radius: 999px; padding: var(--wb-sp-1) var(--wb-sp-2); color: var(--wb-ink-2);
}
[data-dsh-personal-workbench-view] .wb-folder-mini { display: flex; flex-direction: column; gap: var(--wb-sp-1); }
[data-dsh-personal-workbench-view] .wb-folder-mini span {
  font-size: var(--wb-fs-1); color: var(--wb-ink-2); background: var(--wb-sunk); border-radius: var(--wb-r-1); padding: var(--wb-sp-2) var(--wb-sp-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-dsh-personal-workbench-view] .wb-folder-mini span.more { background: transparent; color: var(--wb-ink-3); padding-left: 0; }
[data-dsh-personal-workbench-view] .wb-folder.new {
  border-style: dashed; box-shadow: none; display: grid; place-items: center; text-align: center;
  color: var(--wb-ink-3); font-size: var(--wb-fs-1); min-height: 116px;
}
[data-dsh-personal-workbench-view] .wb-folder-acts {
  position: absolute; top: 8px; right: 8px; display: flex; gap: var(--wb-sp-1); opacity: 0; transition: opacity .12s ease;
}
[data-dsh-personal-workbench-view] .wb-folder:hover .wb-folder-acts { opacity: 1; }
[data-dsh-personal-workbench-view] .wb-icon-btn {
  width: 24px; height: 24px; border-radius: var(--wb-r-1); display: grid; place-items: center;
  border: 1px solid var(--wb-line); background: var(--dsw-alias-bg-layer-2, var(--wb-surface)); color: var(--wb-ink-2);
}
[data-dsh-personal-workbench-view] .wb-icon-btn:hover { color: var(--wb-ink-1); background: var(--wb-sunk); }
[data-dsh-personal-workbench-view] .wb-member {
  display: flex; align-items: center; gap: var(--wb-sp-3); padding: var(--wb-sp-3) var(--wb-sp-5);
  border-bottom: 1px solid var(--wb-line-soft); font-size: var(--wb-fs-1);
}
[data-dsh-personal-workbench-view] .wb-member:last-child { border-bottom: none; }
[data-dsh-personal-workbench-view] .wb-member .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 会话标题栏入口（官方槽位 conversation.session.header.actions）。
   字号取 --wb-fs-2（13px）：与同一排宿主 chip（智能体团队 / 标准模式 / N 个后台任务）
   实测一致。用 --wb-fs-1（12px）会小一号、且**在那枚按钮上根本不生效** ——
   它曾经不在令牌作用域里，font-size 无效化后退回继承宿主的 16px，反而比邻居大一圈
   （2026-10-27 用户反馈"工作台字号在小一号"，作用域见上方令牌层注记）。 */
.wb-header-entry {
  display: inline-flex; align-items: center; gap: var(--wb-sp-2); height: 26px; padding: 0 var(--wb-sp-4);
  border-radius: var(--wb-r-2); border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.26));
  background: transparent; color: var(--dsw-alias-label-secondary, inherit);
  font: inherit; font-size: var(--wb-fs-2); cursor: pointer;
}
.wb-header-entry:hover { color: var(--dsw-alias-label-primary, inherit); background: color-mix(in srgb, currentColor 8%, transparent); }
.wb-header-entry svg { width: 14px; height: 14px; }
.wb-header-entry[data-active] {
  border-color: color-mix(in srgb, var(--wb-ok) 40%, transparent);
  background: color-mix(in srgb, var(--wb-ok) 14%, transparent);
  color: var(--dsw-alias-label-primary, inherit); font-weight: 600;
}

@media (max-width: 900px) {
  .wb-overlay { padding: var(--wb-sp-5); }
  .wb-dialog { max-height: 92vh; }
  .wb-settings { grid-template-columns: 1fr; gap: var(--wb-sp-5); }
  .wb-settings-nav { flex-direction: row; flex-wrap: wrap; }
  .wb-settings-nav button { width: auto; }
  [data-dsh-personal-workbench-view] .wb-folder-grid { grid-template-columns: 1fr 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .wb-overlay, .wb-dialog, .wb-toast, .wb-toast.leaving { animation: none; }
}

/* ===========================================================================
   知识库（打样 2 号）：密集列表 + 自适应时间分组 + 编号分页
   判定全在 listPresentation.ts；这里只负责长什么样。
   =========================================================================== */
/* 知识库工具栏：**一行**放完 —— 左半搜索/排序/命中数，右半三个按钮。
   宽度不够时只缩搜索框（唯一可缩项）；按钮一律 flex:none + nowrap，
   否则会被父级 flex 压成竖排文字（本项目踩过一次：缺 flex-shrink/min-width/white-space 三重保护）。 */
.wb-kb-bar { display:flex; gap: var(--wb-sp-3); align-items:center; margin-bottom: var(--wb-sp-3); }
.wb-kb-bar > * { flex:none; white-space:nowrap; }
.wb-kb-search { flex:1 1 auto; min-width:110px; background:var(--wb-sunk); border:1px solid var(--wb-line); color:inherit;
  border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); font:inherit; font-size: var(--wb-fs-1); }
.wb-kb-spacer { flex:1 1 auto !important; min-width:0; }
.wb-kb-sortkey, .wb-kb-pagesize { background:var(--wb-sunk); border:1px solid var(--wb-line); color:inherit;
  border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-3); font:inherit; font-size: var(--wb-fs-1); }
.wb-kb-hit { font-size: var(--wb-fs-1); color:var(--wb-ink-3); font-variant-numeric:tabular-nums; }
/* 排序方向只留箭头（排序键名在下拉里已有）：把这一行的宽度预算让给搜索框 */
.wb-kb-sortdir { padding-left: var(--wb-sp-3); padding-right: var(--wb-sp-3); font-variant-numeric:tabular-nums; }

/* 通用分类 Tab 条（知识库与任务页共用；组件在 components/TabBar.tsx） */
.wb-tabs { display:flex; gap: var(--wb-sp-1); overflow-x:auto; border-bottom:1px solid var(--wb-line); margin-bottom: var(--wb-sp-3); }
.wb-tab { border:none; background:transparent; color:var(--wb-ink-3); font:inherit; font-size: var(--wb-fs-1);
  padding: var(--wb-sp-3) var(--wb-sp-4) var(--wb-sp-3); border-bottom:2px solid transparent; cursor:pointer; white-space:nowrap;
  display:inline-flex; align-items:center; gap: var(--wb-sp-2); }
.wb-tab:hover { color:var(--wb-ink-1); }
.wb-tab.on { color:var(--wb-ink-1); font-weight:600; border-bottom-color:var(--wb-accent); }
.wb-tab-dot { width:7px; height:7px; border-radius: 999px; display:inline-block; flex:none; }
/* 第四轮 4a：页签圆点走中性色（字典色仍在数据里，只是不拿来画点）。 */
.wb-tab-dot.is-neutral { background: color-mix(in srgb, var(--wb-label-secondary, var(--wb-neutral)) 62%, transparent); }
.wb-tab-cnt { font-size: var(--wb-fs-1); background:color-mix(in srgb, var(--wb-ink-1) 8%, transparent);
  border-radius:999px; padding: var(--wb-sp-1) var(--wb-sp-2); color:var(--wb-ink-3); font-variant-numeric:tabular-nums; }
/* 空分类降噪（2026-10-23 A）：0 条的分类页签置灰并隐藏「0」徽标，仍可点；
   选中时恢复满强度，避免"当前筛选看起来是禁用状态"。 */
.wb-tab[data-empty='true'] { opacity: .55; }
.wb-tab[data-empty='true']:hover { opacity: .9; }
.wb-tab[data-empty='true'] .wb-tab-cnt { display: none; }
.wb-tab.on[data-empty='true'] { opacity: 1; }
.wb-tab.on .wb-tab-cnt { color:var(--wb-ink-1); background:var(--wb-accent-soft); }

/* 标签筛选：**单行**（横向滚动），不再 flex-wrap 铺开——标签一多就吃好几行高度。
   超出 VISIBLE_TAG_LIMIT 的收进「更多 ▾」浮层（TagFilter.tsx）。 */
.wb-kb-tags { display:flex; gap: var(--wb-sp-2); flex-wrap:nowrap; overflow-x:auto; margin-bottom: var(--wb-sp-4);
  padding-bottom: var(--wb-sp-1); scrollbar-width:thin; }
.wb-kb-tags::-webkit-scrollbar { height:5px; }
.wb-kb-tags::-webkit-scrollbar-thumb { background:color-mix(in srgb, var(--wb-ink-1) 16%, transparent); border-radius: var(--wb-r-1); }
.wb-kb-tag { flex:none; border:1px solid var(--wb-line); background:transparent; color:var(--wb-ink-3);
  border-radius: 999px; padding: var(--wb-sp-1) var(--wb-sp-3); font:inherit; font-size: var(--wb-fs-1); cursor:pointer; white-space:nowrap; }
.wb-kb-tag:hover { color:var(--wb-ink-1); }
.wb-kb-tag.on { color:var(--wb-ink-1); border-color:var(--wb-accent-line); background:var(--wb-accent-soft); font-weight:600; }
.wb-kb-tagcnt { margin-left: var(--wb-sp-2); opacity:.7; font-variant-numeric:tabular-nums; }
.wb-kb-tag-more { border-style:dashed; }

/* 「更多标签」浮层：portal 到 document.body（工具栏在滚动容器里，留在里面会被裁）。
   与 .wb-idea-foldmenu 同一套：容器 pointer-events:none 防继承、z-index 高于面板宿主 55。 */
.wb-tagmenu { position:fixed; z-index: var(--wb-z-popover); min-width:210px; max-width:280px; padding: var(--wb-sp-2);
  background:var(--dsw-alias-bg-layer-2, #1c1c1f); border:1px solid var(--wb-line);
  border-radius: var(--wb-r-3); box-shadow:var(--wb-sh-5); pointer-events:none; }
.wb-tagmenu > * { pointer-events:auto; }
.wb-tagmenu-search { width:100%; box-sizing:border-box; background:var(--wb-sunk); border:1px solid var(--wb-line);
  color:inherit; border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-3); font:inherit; font-size: var(--wb-fs-1); margin-bottom: var(--wb-sp-2); }
.wb-tagmenu-list { max-height:220px; overflow-y:auto; display:flex; flex-direction:column; gap: var(--wb-sp-1); }
.wb-tagmenu-item { display:flex; align-items:center; gap: var(--wb-sp-2); width:100%; text-align:left; border:none;
  background:transparent; color:var(--wb-ink-1); font:inherit; font-size: var(--wb-fs-1); padding: var(--wb-sp-2) var(--wb-sp-3);
  border-radius: var(--wb-r-1); cursor:pointer; }
.wb-tagmenu-item:hover { background:color-mix(in srgb, var(--wb-ink-1) 8%, transparent); }
.wb-tagmenu-item.on { background:var(--wb-accent-soft); font-weight:600; }
.wb-tagmenu-check { width:12px; flex:none; color:var(--wb-accent); }
.wb-tagmenu-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-tagmenu-cnt { flex:none; font-size: var(--wb-fs-1); color:var(--wb-ink-3); font-variant-numeric:tabular-nums; }
.wb-tagmenu-empty { padding: var(--wb-sp-4) var(--wb-sp-3); font-size: var(--wb-fs-1); color:var(--wb-ink-3); text-align:center; }
.wb-tagmenu-foot { display:flex; gap: var(--wb-sp-2); align-items:center; margin-top: var(--wb-sp-2); padding-top: var(--wb-sp-2);
  border-top:1px solid var(--wb-line-soft); }

/* 「AI 总结本地文档」弹窗（LocalDocModal.tsx）：路径 + 浏览 + 执行收在一处，
   工具栏因此只留一个按钮（原先三个裸控件横在工具栏里占一整行）。 */
.wb-doc-modal { width:min(680px, 94vw); }
.wb-doc-path { display:flex; gap: var(--wb-sp-2); align-items:center; margin-bottom: var(--wb-sp-3); }
.wb-doc-path input { flex:1; min-width:0; background:var(--wb-sunk); border:1px solid var(--wb-line); color:inherit;
  border-radius: var(--wb-r-2); padding: var(--wb-sp-2) var(--wb-sp-4); font:inherit; font-size: var(--wb-fs-1); }
.wb-doc-nav { display:flex; gap: var(--wb-sp-2); align-items:center; margin-bottom: var(--wb-sp-3); }
.wb-doc-crumb { flex:1; min-width:0; font-size: var(--wb-fs-1); word-break:break-all; color:var(--wb-ink-3);
  background:var(--wb-sunk); border:1px solid var(--wb-line); border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-3); }
.wb-doc-error { color:var(--wb-danger-ink); font-size: var(--wb-fs-1); margin-bottom: var(--wb-sp-2); }
.wb-doc-loading { padding: var(--wb-sp-6); color:var(--wb-ink-3); font-size: var(--wb-fs-2); }
.wb-doc-list { max-height:320px; overflow:auto; border:1px solid var(--wb-line); border-radius: var(--wb-r-2); }
.wb-doc-empty { padding: var(--wb-sp-5); color:var(--wb-ink-3); font-size: var(--wb-fs-1); }
.wb-doc-row { display:flex; align-items:center; gap: var(--wb-sp-3); padding: var(--wb-sp-2) var(--wb-sp-3); cursor:pointer;
  border-bottom:1px solid var(--wb-line-soft); }
.wb-doc-row:last-child { border-bottom:none; }
.wb-doc-row:hover { background:color-mix(in srgb, var(--wb-ink-1) 5%, transparent); }
.wb-doc-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size: var(--wb-fs-2);
  display:inline-flex; align-items:center; gap: var(--wb-sp-2); }
.wb-doc-acts { display:flex; gap: var(--wb-sp-2); flex:none; }

.wb-kb-list { border:1px solid var(--wb-line-soft); border-radius: var(--wb-r-4); overflow:hidden; background:var(--wb-surface); }
.wb-kb-group { display:block; }
.wb-kb-ghead { display:flex; align-items:center; gap: var(--wb-sp-3); padding: var(--wb-sp-3) var(--wb-sp-5) var(--wb-sp-1); font-size: var(--wb-fs-1);
  font-weight:600; color:var(--wb-ink-3); letter-spacing:.3px; }
.wb-kb-gcnt { font-variant-numeric:tabular-nums; }
.wb-kb-gline { flex:1; height:1px; background:var(--wb-line-soft); }
.wb-kb-row { display:flex; align-items:flex-start; gap: var(--wb-sp-4); padding: var(--wb-sp-3) var(--wb-sp-5) var(--wb-sp-3) var(--wb-sp-4); cursor:pointer;
  border-left:3px solid transparent; transition:background .12s ease; }
.wb-kb-row:hover { background:color-mix(in srgb, var(--wb-ink-1) 5%, transparent); }
.wb-kb-row.sel { background:var(--wb-accent-soft); border-left-color:var(--wb-accent); }
.wb-kb-dot-sm { width:7px; height:7px; border-radius: 999px; flex:none; margin-top: var(--wb-sp-2); }
.wb-kb-body { flex:1; min-width:0; }
.wb-kb-title { font-size: var(--wb-fs-2); font-weight:550; line-height:1.4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-kb-sum { font-size: var(--wb-fs-1); color:var(--wb-ink-3); line-height:1.5; margin-top: var(--wb-sp-1);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wb-kb-meta { display:flex; gap: var(--wb-sp-2); align-items:center; flex-wrap:wrap; margin-top: var(--wb-sp-1); }
.wb-kb-chip { display:inline-flex; align-items:center; border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-2); font-size: var(--wb-fs-1); font-weight:600; white-space:nowrap; }
.wb-kb-tg { font-size: var(--wb-fs-1); color:var(--wb-ink-3); }
.wb-kb-stamp { flex:none; font-size: var(--wb-fs-1); color:var(--wb-ink-3); font-variant-numeric:tabular-nums; padding-top: var(--wb-sp-1); }

.wb-kb-pager { display:flex; align-items:center; gap: var(--wb-sp-3); flex-wrap:wrap; padding: var(--wb-sp-4) var(--wb-sp-1) var(--wb-sp-1);
  font-size: var(--wb-fs-1); color:var(--wb-ink-3); }
.wb-kb-pages { display:flex; gap: var(--wb-sp-1); }
.wb-kb-pnum { border:1px solid var(--wb-line); background:transparent; color:var(--wb-ink-2);
  border-radius: var(--wb-r-1); min-width:27px; padding: var(--wb-sp-1) var(--wb-sp-2); font:inherit; font-size: var(--wb-fs-1); cursor:pointer; }
.wb-kb-pnum:hover:not(:disabled) { background:color-mix(in srgb, var(--wb-ink-1) 7%, transparent); }
.wb-kb-pnum.on { border-color:var(--wb-accent-line); color:var(--wb-ink-1); background:var(--wb-accent-soft); font-weight:600; }
.wb-kb-pnum:disabled { opacity:.35; cursor:default; }

/* ===========================================================================
   点子页（打样 1 号）：卡片瀑布。文件夹区沿用原有样式，未改。
   =========================================================================== */
.wb-idea-cards { display:grid; grid-template-columns:1fr 1fr; gap: var(--wb-sp-4); }
.wb-idea-card2 { position:relative; display:flex; flex-direction:column; gap: var(--wb-sp-3); cursor:pointer;
  padding: var(--wb-sp-5) var(--wb-sp-5) var(--wb-sp-4); border:1px solid var(--wb-line-soft); border-left:3px solid var(--wb-idea-color, var(--wb-ink-3));
  border-radius: var(--wb-r-3); background:var(--wb-surface); box-shadow:var(--wb-sh-1);
  transition:border-color .14s ease, transform .14s ease, background .14s ease; }
.wb-idea-card2:hover { background:color-mix(in srgb, var(--wb-ink-1) 5%, var(--wb-surface)); transform:translateY(-1px); }
.wb-idea-card2.sel { border-color:var(--wb-accent-line); box-shadow:0 0 0 1px var(--wb-accent-line), var(--wb-sh-2); }
.wb-idea-card2.picked { border-color:var(--wb-accent-line); background:var(--wb-accent-soft); }
.wb-idea-title { font-size: var(--wb-fs-2); font-weight:600; line-height:1.45; padding-right: var(--wb-sp-7);
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.wb-idea-sum2 { font-size: var(--wb-fs-1); color:var(--wb-ink-3); line-height:1.6;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.wb-idea-foot2 { display:flex; align-items:center; gap: var(--wb-sp-2); flex-wrap:wrap; margin-top: auto; padding-top: var(--wb-sp-1); }
.wb-idea-stamp { color:var(--wb-ink-3); font-size: var(--wb-fs-1); font-variant-numeric:tabular-nums; white-space:nowrap; margin-left: auto; }
.wb-idea-pick { position:absolute; top:9px; right:9px; width:19px; height:19px; border-radius: var(--wb-r-1);
  border:1px solid var(--wb-line); background:var(--wb-sunk); color:transparent; font-size: var(--wb-fs-1); line-height:1;
  cursor:pointer; opacity:0; transition:opacity .12s ease, background .12s ease; padding: 0; }
.wb-idea-card2:hover .wb-idea-pick,
.wb-idea-card2.picked .wb-idea-pick,
/* 键盘用户：Tab 焦点落在 ☑ 上时必须看得见（只靠 hover 显形 = 焦点落在隐形控件上） */
.wb-idea-pick:focus-visible,
.wb-idea-card2:focus-within .wb-idea-pick { opacity:1; }
.wb-idea-pick:focus-visible { outline:2px solid var(--wb-accent); outline-offset:1px; }
.wb-idea-pick[aria-pressed="true"] { color:var(--wb-ink-1); border-color:var(--wb-accent); background:var(--wb-accent); }
.wb-idea-foldbtn { border:1px solid var(--wb-line); background:transparent; color:var(--wb-ink-3);
  border-radius: var(--wb-r-1); padding: var(--wb-sp-1) var(--wb-sp-3); font:inherit; font-size: var(--wb-fs-1); cursor:pointer; white-space:nowrap; }
.wb-idea-foldbtn:hover:not(:disabled) { color:var(--wb-ink-1); background:color-mix(in srgb, var(--wb-ink-1) 7%, transparent); }
.wb-idea-foldbtn:disabled { opacity:.45; cursor:default; }
.wb-idea-empty { padding: var(--wb-sp-7); text-align:center; color:var(--wb-ink-3); font-size: var(--wb-fs-1);
  border:1px dashed var(--wb-line); border-radius: var(--wb-r-3); grid-column:1 / -1; }
/* 菜单 portal 到 document.body（见 IdeaCardGrid.tsx）：网格/卡片/面板的 overflow 与层叠都裁不到它。
   ⚠️ 两条坑都是 scripts/repro/harness-real-browser.mjs 的命中测试抓出来的（都是"看得见、点不动"）：
   1. pointer-events 是**继承**属性：面板宿主 .wb-panel-host 是 pointer-events:none
      （为了让左侧导航栏在面板铺开时仍可点）→ portal 到 body 的菜单连点击都收不到。
      按「容器 none + 菜单本体 auto」两段写，与 .wb-toasts / .wb-toast 同一套办法。
   2. z-index 必须**高于 .wb-panel-host 的 55**：否则面板里的卡片会盖在菜单上面，
      菜单看得见但点到的还是卡片（实测 z-index:40 时 elementFromPoint 命中的是 .wb-idea-card2）。 */
.wb-idea-foldmenu { position:fixed; z-index: var(--wb-z-popover); min-width:200px; padding: var(--wb-sp-1);
  background:var(--dsw-alias-bg-layer-2, #1c1c1f); border:1px solid var(--wb-line);
  border-radius: var(--wb-r-3); box-shadow:var(--wb-sh-5);
  pointer-events:none; overflow-y:auto; }
.wb-idea-foldmenu > * { pointer-events:auto; }
.wb-idea-foldmenu button { display:flex; align-items:center; gap: var(--wb-sp-2); width:100%; text-align:left;
  border:none; background:transparent; color:var(--wb-ink-1); font:inherit; font-size: var(--wb-fs-1);
  padding: var(--wb-sp-2) var(--wb-sp-3); border-radius: var(--wb-r-1); cursor:pointer; }
.wb-idea-foldmenu button:hover { background:color-mix(in srgb, var(--wb-ink-1) 8%, transparent); }
.wb-idea-foldic { flex:none; }
.wb-idea-foldnote { padding: var(--wb-sp-2) var(--wb-sp-3) var(--wb-sp-2); font-size: var(--wb-fs-1); color:var(--wb-ink-3); border-top:1px solid var(--wb-line-soft); margin-top: var(--wb-sp-1); }
@media (max-width: 720px) {
  .wb-idea-cards { grid-template-columns:1fr; }
}
/* ==========================================================================
   快速录入 / 选择器视觉整理（2026-10-23）
   - 勾选框跟主题（原生灰块是"没设计"最强的信号）
   - 三个选择器不再各套一层实线框，改用浅凹底，避免"框里套框"
   - 小标题给层级、说明文字降一级，长列表限高内部滚动
   ========================================================================== */
.wb-dialog input[type='checkbox'], .wb-dialog input[type='radio'] {
  accent-color: var(--wb-ok); width: 15px; height: 15px; margin: 0; flex: none; cursor: pointer;
}
.wb-dialog .wb-skill-picker, .wb-dialog .wb-persona-picker {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 4%, transparent);
  border-radius: var(--wb-r-3); padding: var(--wb-sp-4); margin-top: var(--wb-sp-5);
}
.wb-dialog .wb-skill-picker-head, .wb-dialog .wb-persona-head { font-size: var(--wb-fs-2); font-weight: 650; }
.wb-dialog .wb-skill-count, .wb-dialog .wb-persona-group-count { font-weight: 400; opacity: .8; }
.wb-dialog .wb-skill-item, .wb-dialog .wb-persona-item { padding: var(--wb-sp-2) var(--wb-sp-3); border-radius: var(--wb-r-2); }
.wb-dialog .wb-skill-name, .wb-dialog .wb-persona-name { font-weight: 600; }
.wb-dialog .wb-skill-desc, .wb-dialog .wb-persona-desc { opacity: .9; }
.wb-dialog .wb-skill-provider, .wb-dialog .wb-persona-source { font-size: 11px; opacity: .55; }
.wb-dialog .wb-skill-list { max-height: 176px; }
.wb-dialog .wb-persona-list { max-height: 240px; }
.wb-dialog .wb-form label { font-weight: 500; }
.wb-dialog .wb-foot-note { max-width: 62%; line-height: 1.5; }

/**
 * 侧栏入口字号对齐（2026-10-24 用户反馈：工作台入口的字比「创造模式」小一号）。
 *
 * 侧栏那一行是**宿主 PanelRow 渲染的**（我们只提供图标），所以字号属于宿主样式；
 * 但宿主给 panel 行用了比 list 行小一档的字。这里按 aria-label 精确定位到我们自己
 * 那一行，只改字号、不动行高/颜色/图标 —— 不用 class 名（会随宿主版本变）。
 *
 * 14px 来自截图比对（创造模式 ≈ 工作台 × 1.08）；如与实际不符，改这一个值即可。
 *
 * ⚠️ 这条只管**侧栏那一行**（宿主 PanelRow，带 aria-label）。会话标题栏那枚
 * .wb-header-entry 是**我们自己渲染的 button、没有 aria-label**（只有 title），
 * 所以它从来不受这条影响 —— 2026-10-27 排查"工作台字号在小一号"时就是在这里绕了一圈，
 * 真因是那个按钮不在令牌作用域里（见上方令牌层注记）。
 */
button[aria-label='打开工作台（任务 / 日历 / 知识库 / 点子）'] { font-size: 14px; }
/* 运营日志（2026-10-23 第 1 步）：工具条 + 行式列表 + 展开正文 */
.wb-oplog { display: flex; flex-direction: column; gap: var(--wb-sp-4); }.wb-oplog-bar { display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-oplog-filters { display: flex; align-items: center; gap: var(--wb-sp-2); flex-wrap: wrap; }
.wb-oplog-select, .wb-oplog-search { height: 30px; border-radius: var(--wb-r-2); border: 1px solid var(--wb-line); background: var(--wb-surface); color: var(--wb-ink-1); font: inherit; font-size: var(--wb-fs-2); padding: 0 var(--wb-sp-3); }
.wb-oplog-search { width: 220px; }
.wb-oplog-import { cursor: pointer; display: inline-flex; align-items: center; gap: var(--wb-sp-2); margin-left: auto; }
.wb-oplog-note { font-size: var(--wb-fs-1); color: var(--wb-ok-ink); }
/* 运营日志「待归档」建议条（2026-10-27）：提醒"这些任务完成了，但还没写进日志"。
   视觉比正文低一档 —— 它是**建议**不是告警：虚线边框、info 色系、不抢主列表注意力。
   点一颗 chip = 用那条任务预填表单（真正落库仍然要用户在表单里确认）。 */
/* 两行结构（2026-10-27 截图实测后改）：第一行「说明 …… 本次不再提示」，第二行 chip。
   原先三者在一条 flex 里自由换行，窄面板会把「本次不再提示」挤到 chip 中间，看着像第三个任务。
   用 flex-basis 100% 把 chip 行**确定性地**推下去，任何宽度下版式一致。 */
.wb-oplog-suggest { display: flex; flex-wrap: wrap; align-items: center;
  gap: var(--wb-sp-2) var(--wb-sp-3);
  margin: 0 0 var(--wb-sp-4); padding: var(--wb-sp-3) var(--wb-sp-4);
  border: 1px dashed color-mix(in srgb, var(--wb-info) 72%, transparent);
  border-radius: var(--wb-r-2);
  background: color-mix(in srgb, var(--wb-info) 10%, transparent); }
.wb-oplog-suggest-title { display: inline-flex; align-items: center; gap: var(--wb-sp-2);
  flex: 1 1 auto; min-width: 0; color: var(--wb-info-ink); font-size: var(--wb-fs-1); }
.wb-oplog-suggest-dismiss { flex: none; margin-left: auto; white-space: nowrap; }
.wb-oplog-suggest-list { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2);
  flex: 1 1 100%; min-width: 0; }
.wb-oplog-suggest-chip { display: inline-flex; align-items: center; gap: var(--wb-sp-1);
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: var(--wb-sp-1) var(--wb-sp-3); border: 1px solid var(--wb-line);
  border-radius: 999px; background: var(--wb-surface); color: var(--wb-ink-1);
  font: inherit; font-size: var(--wb-fs-1); cursor: pointer; }
.wb-oplog-suggest-chip:hover { border-color: color-mix(in srgb, var(--wb-accent) 52%, transparent); color: var(--wb-accent); }
.wb-oplog-suggest-chip:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 2px; }

/* 任务详情的「关联日志」列表（反向查询）：一行一条，日期在最左做扫读锚点。
   0 条时整块不渲染 —— 每张任务卡挂一个空区块比没有更吵。 */
.wb-oplog-link-count { margin-left: var(--wb-sp-2); padding: 0 var(--wb-sp-2); border-radius: 999px;
  background: color-mix(in srgb, var(--wb-accent) 14%, transparent); color: var(--wb-accent);
  font-size: var(--wb-fs-1); font-weight: 600; }
.wb-oplog-links { display: flex; flex-direction: column; gap: var(--wb-sp-2); }
.wb-oplog-link { display: flex; align-items: baseline; gap: var(--wb-sp-3); width: 100%;
  padding: var(--wb-sp-2) var(--wb-sp-3); border: 1px solid var(--wb-line);
  border-radius: var(--wb-r-1); background: transparent; color: var(--wb-ink-1);
  font: inherit; font-size: var(--wb-fs-1); text-align: left; cursor: pointer; }
.wb-oplog-link:hover { border-color: color-mix(in srgb, var(--wb-accent) 45%, transparent); background: color-mix(in srgb, var(--wb-accent) 6%, transparent); }
.wb-oplog-link:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 2px; }
.wb-oplog-link-date { flex: none; color: var(--wb-ink-3); font-variant-numeric: tabular-nums; }
.wb-oplog-link-type { flex: none; color: var(--wb-ink-2); }
.wb-oplog-link-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 过去日期看不到「逾期 / 未排期」时的说明条（2026-10-27）。
   虚线 + 次级文字：它是**说明**不是告警，且只在过去日期出现，不该抢计划列表的注意力。 */
.wb-day-hint { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wb-sp-3);
  margin: 0 0 var(--wb-sp-4); padding: var(--wb-sp-3) var(--wb-sp-4);
  border: 1px dashed var(--wb-line); border-radius: var(--wb-r-2);
  color: var(--wb-ink-2); font-size: var(--wb-fs-1); line-height: 1.55; }
.wb-day-hint button { margin-left: auto; flex: none; }

/* ===== 仪表盘（2026-10-27，方案 A）：今日视图上半屏 =====
   设计取向：这是**动手清单**，不是统计墙 —— 顶部一句话态势，下面只列需要你动的事。
   两条硬规则：① 缺数据源显示 needs_data 而不是 0（0 是"确实是零"，缺数据是"不知道"，
   在运营判断上完全相反）；② 空模块不画空壳，没有动态就整块不渲染。 */
.wb-dash { display: flex; flex-direction: column; gap: var(--wb-sp-5); margin-bottom: var(--wb-sp-5); }
.wb-dash-hero { display: flex; align-items: center; gap: var(--wb-sp-5); flex-wrap: wrap;
  padding: var(--wb-sp-5) var(--wb-sp-6); border-radius: var(--wb-r-3); border: 1px solid var(--wb-line);
  background: linear-gradient(90deg, color-mix(in srgb, var(--wb-accent) 7%, transparent), transparent 62%); }
.wb-dash-hero-main { flex: 1 1 300px; min-width: 0; }
.wb-dash-date { font-size: var(--wb-fs-1); color: var(--wb-ink-2); letter-spacing: .02em; }
.wb-dash-line { margin-top: var(--wb-sp-1); font-size: var(--wb-fs-3); color: var(--wb-ink-1); }
.wb-dash-line b { font-variant-numeric: tabular-nums; font-size: var(--wb-fs-4); margin: 0 2px; }
.wb-dash-line b.is-warn { color: var(--wb-warn-ink); }
.wb-dash-line b.is-quiet { color: var(--wb-ink-3); }
.wb-dash-sep { margin: 0 var(--wb-sp-3); color: var(--wb-ink-3); }
.wb-dash-hero-actions { display: flex; gap: var(--wb-sp-3); flex: none; flex-wrap: wrap; }

/* 宽屏两栏（动手清单 : 节奏 = 2:1），域快照三等分且**等高**（脚注贴底）；940px 以下全部单列 */
.wb-dash-main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--wb-sp-5); align-items: start; }
.wb-dash-domains { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--wb-sp-5); align-items: stretch; }
.wb-dash-main > .wb-card, .wb-dash-domains > .wb-card { margin-bottom: 0; }
.wb-dash-domains > .wb-card { display: flex; flex-direction: column; }
.wb-dash-domains > .wb-card > .wb-dash-foot { margin-top: auto; }
@media (max-width: 940px) {
  .wb-dash-main { grid-template-columns: 1fr; }
  .wb-dash-domains { grid-template-columns: 1fr; }
}

/* 动手清单每一行：数字 / 标题+说明两行 / 动作按钮。
   ⚠️ 标题与说明必须是 block —— 写成 inline span 会被挤成
   "逾期任务截止时间已过先定去留" 这种连在一起读不出来的样子（设计稿实测踩过）。 */
.wb-dash-queue { margin: 0; padding: 0; list-style: none; }
.wb-q { display: flex; align-items: center; gap: var(--wb-sp-4);
  padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid var(--wb-line-soft);
  border-radius: var(--wb-r-2); }
.wb-q + .wb-q { margin-top: var(--wb-sp-2); }
.wb-q:hover { border-color: color-mix(in srgb, var(--wb-accent) 45%, transparent); }
.wb-q-n { flex: none; width: 30px; text-align: center; font-size: var(--wb-fs-4); font-weight: 700;
  font-variant-numeric: tabular-nums; color: var(--wb-ink-1); }
.wb-q-n.is-warn { color: var(--wb-warn-ink); }
.wb-q-body { flex: 1 1 auto; min-width: 0; }
.wb-q-t { display: block; font-size: var(--wb-fs-2); color: var(--wb-ink-1); }
.wb-q-d { display: block; margin-top: 2px; font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-q-go { flex: none; }
.wb-dash-quiet { font-size: var(--wb-fs-1); color: var(--wb-ink-3); }

/* 域快照 */
.wb-dash-kv { display: flex; align-items: baseline; gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-2); }
.wb-dash-kv b { font-size: var(--wb-fs-5); font-variant-numeric: tabular-nums; }
.wb-dash-kv span { font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-dash-sub { display: flex; gap: var(--wb-sp-4); flex-wrap: wrap;
  font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-dash-sub-col { flex-direction: column; gap: var(--wb-sp-2); }
.wb-dash-sub b { color: var(--wb-ink-1); font-variant-numeric: tabular-nums; }
/* needs_data：虚线胶囊，视觉上必须与"0"明显不同，不能让人误读成零 */
.wb-needs { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px;
  border: 1px dashed var(--wb-line-strong); color: var(--wb-ink-3);
  font-size: var(--wb-fs-1); font-variant-numeric: normal; }
.wb-dash-foot { display: flex; align-items: center; gap: var(--wb-sp-3); margin-top: var(--wb-sp-3);
  padding-top: var(--wb-sp-3); border-top: 1px solid var(--wb-line-soft);
  font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-dash-foot-go { margin-left: auto; flex: none; }
/* 容量面板原本是今日视图的**顶层块**（自带边框 / 圆角 / 阴影 / 外边距）。
   搬进「今日节奏」卡里之后它只是卡内的一块内容 —— 中和外壳，避免"卡中卡"。 */
.wb-dash-rhythm .wb-cap { border: 0; border-radius: 0; background: transparent; box-shadow: none;
  padding: 0; margin-bottom: 0; }
/* 卡里已有一级标题（今日节奏），容量块自己的 h3 降一格当分组名用，不与 h4 抢层级 */
.wb-dash-rhythm .wb-cap-head h3 { font-size: var(--wb-fs-2); color: var(--wb-ink-2); font-weight: 600; }

/* 最近动态：日期 / 类型 / 文本 */
.wb-tl { display: flex; flex-direction: column; gap: var(--wb-sp-2); }
.wb-tl-item { display: flex; align-items: baseline; gap: var(--wb-sp-3);
  font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-tl-date { flex: none; width: 76px; color: var(--wb-ink-3); font-variant-numeric: tabular-nums; }
.wb-tl-kind { flex: none; min-width: 34px; color: var(--wb-ink-3); }
.wb-tl-text { flex: 1 1 auto; min-width: 0; color: var(--wb-ink-1); }
.wb-oplog-error { font-size: var(--wb-fs-1); color: var(--wb-danger-ink); }
.wb-oplog-list { display: flex; flex-direction: column; }
.wb-oplog-item { border-bottom: 1px solid var(--wb-line-soft); }
.wb-oplog-item:last-child { border-bottom: none; }
.wb-oplog-head { display: flex; align-items: center; gap: var(--wb-sp-3); width: 100%; padding: var(--wb-sp-3) var(--wb-sp-4); background: transparent; border: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.wb-oplog-head:hover { background: color-mix(in srgb, var(--wb-ink-1) 5%, transparent); }
.wb-oplog-when { flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-3); font-variant-numeric: tabular-nums; }
.wb-oplog-title { flex: 1; min-width: 0; font-size: var(--wb-fs-2); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-oplog-meta { flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-oplog-body { padding: 0 var(--wb-sp-4) var(--wb-sp-4); display: flex; flex-direction: column; gap: var(--wb-sp-3); }
.wb-oplog-text { font-size: var(--wb-fs-2); line-height: 1.65; color: var(--wb-ink-2); white-space: pre-wrap; }
.wb-oplog-asins, .wb-oplog-docs { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2); }
.wb-oplog-doc { font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-oplog-images { display: flex; flex-direction: column; gap: var(--wb-sp-2); }
.wb-oplog-images img { max-width: 100%; border-radius: var(--wb-r-2); border: 1px solid var(--wb-line-soft); display: block; }
/* 运营日志 v2：KPI / 类型标签 / 日期分组 / 行与详情 */
.wb-oplog-kpi { margin-bottom: var(--wb-sp-2); }
.wb-oplog-types { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2); }
.wb-oplog-type { display: inline-flex; align-items: center; gap: var(--wb-sp-2); height: 28px; padding: 0 var(--wb-sp-3); border-radius: 999px; border: 1px solid var(--wb-line); background: var(--wb-surface); color: var(--wb-ink-2); font: inherit; font-size: var(--wb-fs-1); cursor: pointer; }
.wb-oplog-type:hover { color: var(--wb-ink-1); }
.wb-oplog-type.on { color: var(--wb-ink-1); font-weight: 600; border-color: color-mix(in srgb, var(--wb-accent) 45%, transparent); background: var(--wb-accent-soft); }
.wb-oplog-type-count { font-variant-numeric: tabular-nums; opacity: .7; }
.wb-oplog-type-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--dot, var(--wb-ink-3)); flex: none; display: inline-block; }
.wb-oplog-group { margin-top: var(--wb-sp-3); }
.wb-oplog-group-title { display: flex; align-items: center; gap: var(--wb-sp-2); margin: 0 0 var(--wb-sp-2); font-size: var(--wb-fs-1); font-weight: 600; color: var(--wb-ink-3); }
.wb-oplog-group-count { font-weight: 400; }
.wb-oplog-row { display: flex; align-items: center; gap: var(--wb-sp-3); width: 100%; padding: var(--wb-sp-3) var(--wb-sp-4); background: transparent; border: 0; border-bottom: 1px solid var(--wb-line-soft); font: inherit; color: inherit; text-align: left; cursor: pointer; }
.wb-oplog-row:last-child { border-bottom: none; }
.wb-oplog-row:hover { background: color-mix(in srgb, var(--wb-ink-1) 5%, transparent); }
.wb-oplog-row-type { flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-2); min-width: 3.5em; }
.wb-oplog-row-title { flex: 1; min-width: 0; font-size: var(--wb-fs-2); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-oplog-row-meta { flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-oplog-row-date { flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-3); font-variant-numeric: tabular-nums; }
.wb-oplog-detail-meta { display: flex; align-items: center; gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-3); }
/* 卡片式列表：正文/截图/附件直接可见（对齐旧应用的信息密度） */
.wb-oplog-cards { display: flex; flex-direction: column; gap: var(--wb-sp-3); }
.wb-oplog-card { border: 1px solid var(--wb-line-soft); border-radius: var(--wb-r-3); background: var(--wb-surface); padding: var(--wb-sp-4) var(--wb-sp-5); display: flex; flex-direction: column; gap: var(--wb-sp-3); }
.wb-oplog-card-head { display: flex; align-items: center; gap: var(--wb-sp-3); }
.wb-oplog-card-type { flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-oplog-card-title { flex: 1; min-width: 0; margin: 0; font-size: var(--wb-fs-3); font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-oplog-card-date { flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-3); font-variant-numeric: tabular-nums; }
.wb-oplog-card-open { flex: none; font: inherit; font-size: var(--wb-fs-1); color: var(--wb-accent); background: none; border: 0; cursor: pointer; text-decoration: underline; }
.wb-oplog-card-text { margin: 0; font-size: var(--wb-fs-2); line-height: 1.65; color: var(--wb-ink-2); white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.wb-oplog-card-images { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2); }
.wb-oplog-card-images img { height: 96px; width: auto; max-width: 240px; object-fit: cover; border-radius: var(--wb-r-2); border: 1px solid var(--wb-line-soft); display: block; }
.wb-oplog-card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wb-sp-2); font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
/* v3：编辑器 / 类型管理 / 置顶 */
.wb-oplog-card.is-pinned { border-color: color-mix(in srgb, var(--wb-accent) 45%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wb-accent) 22%, transparent); }
.wb-oplog-form { display: flex; flex-direction: column; gap: var(--wb-sp-3); }
.wb-oplog-form-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--wb-sp-3); }
.wb-oplog-form-row > .wb-field { min-width: 0; }
/**
 * 网格里的相邻字段**不享受**「堆叠字段分隔线」（即下方 .wb-dialog .wb-field + .wb-field）。
 *
 * 2026-10-27 视觉对齐实测（选品库「编辑店铺 / 编辑商品」弹框）：那条分隔线是给**单列堆叠**
 * 分组的，但两列网格里的第二个 .wb-field 同样是"相邻兄弟"，于是右列被整体推下 28px
 * （margin-top 16 + padding-top 12）、头顶还多出一条孤线 —— 截图里「站点 / 店铺链接」
 * 正好比左列低半个字段，而两列本该在同一基线上。这里按**容器**中和掉，
 * 规则本身留给设置弹窗那种真正的单列堆叠；wb-field-grid 是同一处老问题，一并中和。
 */
.wb-dialog .wb-oplog-form-row > .wb-field + .wb-field,
.wb-dialog .wb-field-grid > .wb-field + .wb-field { margin-top: 0; padding-top: 0; border-top: 0; }
/**
 * 勾选框/单选框必须排除在这条"整行宽度"规则之外。
 *
 * 2026-10-27 同样是一次实测：上面这条 input:not([type='file']):not([type='color'])
 * 的选择器把 input[type=checkbox] 也算进来了 —— 它的权重(0,4,1)压过了
 * .wb-dialog input[type='checkbox'] 那条(0,2,1)，于是勾选框被撑成整行宽、
 * 带上边框和 8px 圆角，行内勾选项的**文字被挤到右边只剩一列字宽**
 * （竖排、溢出弹窗外），弹窗底部还多出一条空白。
 * 现在交给那条 15px 规格与 accent-color，颜色跟随主题。
 */
.wb-dialog .wb-oplog-form input:not([type='file']):not([type='color']):not([type='checkbox']):not([type='radio']), .wb-dialog .wb-oplog-form select, .wb-dialog .wb-oplog-form textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--wb-line); border-radius: var(--wb-r-2); background: var(--wb-surface); color: var(--wb-ink-1); font: inherit; font-size: var(--wb-fs-2); padding: 6px 8px; }
.wb-dialog .wb-oplog-form textarea { resize: vertical; line-height: 1.6; }
/* 行内勾选：勾选框与首行文字视觉居中；文字是显式 flex 子项（不再是匿名项，
   不会被一个坏掉的输入框压成 min-content 竖排）。长文案仍按 flex-start 顶部对齐。 */
.wb-dialog .wb-oplog-form .wb-inline-check { align-items: center; }
.wb-dialog .wb-oplog-form .wb-inline-check > span { flex: 1 1 auto; min-width: 0; }
.wb-oplog-typelist { display: flex; flex-direction: column; gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-3); }
.wb-oplog-typerow { display: flex; align-items: center; gap: var(--wb-sp-3); }
.wb-oplog-typerow > span { flex: 1; }
.wb-oplog-typerow input[type='color'] { width: 28px; height: 24px; border: 0; background: none; padding: 0; cursor: pointer; }
.wb-oplog-typerow input:not([type='color']) { flex: 1; border: 1px solid var(--wb-line); border-radius: var(--wb-r-2); background: var(--wb-surface); color: var(--wb-ink-1); font: inherit; font-size: var(--wb-fs-2); padding: 4px 8px; }


/* 选品：收藏列表（缩略图 + 标题 + 价格迷你图 + 评分/BSR） */
.wb-asin-list { display: flex; flex-direction: column; }
/**
 * 产品库（v1.19）：可维护的**产品事实**表。不与 .wb-asin-row 共用网格 ——
 * 选品行有勾选框/收藏星/结论 chip，列数不同，共用会被挤成错位。
 *
 * 6 列 = 站点 / ASIN / 标题（含店铺·类目副行）/ 价格 / 更新时间 / 操作。
 * 固定列合计 ≈464px + 间距 40px ≈ 504px，比"店铺、类目各占一列"窄了 200px ——
 * 侧栏面板普遍不到 640px，七列固定宽度会横向溢出。
 * 注意：下面的窄屏断点按**浏览器窗口**判定，而面板比窗口窄，所以不能只靠断点兜底。
 */
.wb-product-facts { border: 1px solid var(--wb-line-soft); border-radius: var(--wb-r-2); overflow: hidden; container-type: inline-size; }
.wb-product-head, .wb-product-row { display: grid; grid-template-columns: 56px 124px minmax(0, 1fr) 80px 84px 120px; gap: var(--wb-sp-3); align-items: center; padding: var(--wb-sp-3) var(--wb-sp-4); }
.wb-product-head { color: var(--wb-ink-3); font-size: var(--wb-fs-1); border-bottom: 1px solid var(--wb-line-soft); background: var(--wb-surface); }
.wb-product-row { border-bottom: 1px solid var(--wb-line-soft); font-size: var(--wb-fs-1); min-width: 0; }
.wb-product-row:last-child { border-bottom: none; }
.wb-product-row:hover { background: color-mix(in srgb, var(--wb-accent) 4%, transparent); }
/* 重拉期间保留表格、只做轻微淡化：整张表撤掉再长回来会闪（切筛选时尤其明显）。 */
.wb-product-facts.is-refreshing { opacity: .72; transition: opacity .15s var(--wb-ease, ease); }
@media (prefers-reduced-motion: reduce) { .wb-product-facts.is-refreshing { transition: none; } }
.wb-product-title-cell { display:flex; align-items:center; gap:var(--wb-sp-2); min-width:0; }
.wb-product-title-cell .wb-asin-title { flex:1; min-width:0; }
/* 标题两行结构：第一行标题（可截断），第二行店铺 + 类目（元信息）。 */
.wb-product-title-stack { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.wb-product-meta { display:flex; align-items:center; gap:var(--wb-sp-2); min-width:0; color:var(--wb-ink-3); font-size:var(--wb-fs-1); }
.wb-product-shop { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.wb-product-meta .wb-chip { flex:none; }
/**
 * 行内操作（v1.19）：**常显**而不是 hover 才出现。
 * 旧版把「编辑」藏在 hover 里，触屏设备根本没有 hover —— 于是那台设备上永远改不了产品。
 */
.wb-product-row-actions { display:flex; align-items:center; justify-content:flex-end; gap:var(--wb-sp-2); }
.wb-product-row-actions .wb-asin-copy { display:inline-flex; align-items:center; gap:var(--wb-sp-1); }
.wb-product-row-actions .wb-asin-copy:focus-visible { outline:2px solid var(--wb-accent); outline-offset:2px; }
.wb-product-row-actions .wb-asin-copy.is-danger:hover { color: var(--wb-danger-ink); border-color: color-mix(in srgb, var(--wb-danger) 45%, var(--wb-line-soft)); }
.wb-product-price-head { text-align:right; }
.wb-product-actions-head { text-align:right; }
.wb-asin-title.is-empty { color: var(--wb-ink-3); font-style: italic; }
.wb-product-delete-note { margin:0 0 var(--wb-sp-2); line-height:1.7; }
/* 空态里的一组动作：主 CTA 在前，清空筛选在后，窄屏自动换行。 */
.wb-empty-actions { display:flex; flex-wrap:wrap; justify-content:center; gap:var(--wb-sp-2); margin-top:var(--wb-sp-5); }
/* 产品库顶部计数条：安静的一行数字，不抢表格的注意力。 */
.wb-products-stats { display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--wb-sp-5); margin:0 0 var(--wb-sp-3); color:var(--wb-ink-3); font-size:var(--wb-fs-1); }
.wb-products-stat { display:inline-flex; align-items:baseline; gap:var(--wb-sp-2); }
.wb-products-stat b { color:var(--wb-ink-1); font-size:var(--wb-fs-3); font-variant-numeric:tabular-nums; }
.wb-product-edit-form { display:flex; flex-direction:column; gap:var(--wb-sp-4); }
.wb-product-edit-identity { display:flex; align-items:center; gap:var(--wb-sp-3); padding-bottom:var(--wb-sp-3); border-bottom:1px solid var(--wb-line-soft); }
.wb-product-edit-form .wb-field { gap:var(--wb-sp-2); }
.wb-product-edit-form input { width:100%; box-sizing:border-box; }
.wb-product-row .wb-asin-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* finesse · product surface: quiet density, one accent, feedback-only motion */
.wb-univer-preview { border-radius: var(--wb-r-3); box-shadow: var(--wb-sh-3); }
.wb-univer-preview-head { justify-content: space-between; }
.wb-univer-preview-title { display:inline-flex; align-items:center; gap:var(--wb-sp-3); min-width:0; }
.wb-univer-close { flex:none; min-height:var(--wb-ctl-h); }
.wb-univer-preview .wb-hint { max-width:78ch; text-wrap:pretty; }
.wb-univer-preview iframe { border:1px solid var(--wb-line-soft) !important; border-radius:var(--wb-r-2); background:var(--wb-surface); }
@media (hover: hover) { .wb-univer-close:hover { border-color:var(--wb-accent); color:var(--wb-ink-1); } }
.wb-univer-close:focus-visible { outline:2px solid var(--wb-accent); outline-offset:3px; }
.wb-univer-close:active { transform:translateY(1px); }
@media (prefers-reduced-motion: reduce) { .wb-univer-close { transition:none; } }
@media (max-width: 720px) {
  /**
   * 窄屏保留「站点 / ASIN / 标题 / 操作」四列 —— 操作列**必须留着**：
   * 旧版把第 4 列之后全部隐藏，代价是手机上连编辑按钮都没了。
   */
  .wb-product-head, .wb-product-row { grid-template-columns: 52px 96px minmax(0, 1fr) auto; row-gap: var(--wb-sp-1); }
  .wb-product-head span:nth-child(4), .wb-product-row > span:nth-child(4),
  .wb-product-head span:nth-child(5), .wb-product-row > span:nth-child(5) { display: none; }
  .wb-product-row-actions .wb-asin-copy span { display: none; }
}
/**
 * 容器查询版断点（v1.19）：@media 判的是**浏览器窗口**，而工作台活在侧栏面板里 ——
 * 窗口 1600px、面板 520px 时媒体查询一条都不触发，标题列会被挤成 0 宽。
 * 这里按**面板自身宽度**收窄：去掉价格与更新时间，保留操作列。
 */
@container (max-width: 640px) {
  .wb-product-head, .wb-product-row { grid-template-columns: 52px 104px minmax(0, 1fr) auto; row-gap: var(--wb-sp-1); }
  .wb-product-head span:nth-child(4), .wb-product-row > span:nth-child(4),
  .wb-product-head span:nth-child(5), .wb-product-row > span:nth-child(5) { display: none; }
  .wb-product-row-actions .wb-asin-copy span { display: none; }
}
/**
 * 产品库整页也做容器查询（命名容器 wb-products）：面板窄的时候标题与按钮要**竖排**，
 * 否则"手动录入 / 刷新 / 生成表格并预览"三个按钮会把说明文字挤成三行。
 * 注意 @container 不带名字时取**最近**容器，所以上面那条列宽断点仍然按表格自身宽度算。
 */
@container wb-products (max-width: 560px) {
  .wb-products .wb-amazon-heading { flex-direction: column; align-items: flex-start; gap: var(--wb-sp-3); }
  .wb-products .wb-amazon-heading-actions { width: 100%; justify-content: flex-start; }
}
.wb-asin-toolbar { display: flex; flex-direction: column; gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-3); }
/* 选品页跳产品库的入口：与两个 tab 同一行，靠右放，不抢 tab 的选中态。 */
.wb-asin-tab-link { margin-left: auto; }
.wb-asin-filters { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wb-sp-2); }
.wb-asin-row { display: flex; align-items: center; gap: var(--wb-sp-3); padding: var(--wb-sp-3) var(--wb-sp-4); border-bottom: 1px solid var(--wb-line-soft); }
.wb-asin-watch { flex: none; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--wb-line); color: var(--wb-ink-3); background: var(--wb-surface); cursor: pointer; font-size: 17px; line-height: 1; }
.wb-asin-watch:hover, .wb-asin-watch:focus-visible { border-color: var(--wb-accent); color: var(--wb-accent); }
.wb-asin-watch.is-on { color: var(--wb-warn-ink); background: color-mix(in srgb, var(--wb-warn) 13%, var(--wb-surface)); border-color: color-mix(in srgb, var(--wb-warn) 35%, var(--wb-line)); }
.wb-asin-watch:disabled { opacity: .55; cursor: wait; }
/* 判断结论 chip：点一下轮转；颜色只做辅助，文字始终在（不靠颜色单独表意）。 */
.wb-asin-judgment { font: inherit; font-size: 11px; padding: 1px 7px; border-radius: var(--wb-r-1); border: 1px solid var(--wb-line-soft); background: transparent; color: var(--wb-ink-3); cursor: pointer; }
.wb-asin-judgment:hover:not(:disabled) { border-color: var(--wb-accent); color: var(--wb-ink-1); }
.wb-asin-judgment:disabled { opacity: .55; cursor: wait; }
.wb-asin-judgment.is-do { color: var(--wb-ok-ink); border-color: color-mix(in srgb, var(--wb-ok-ink) 45%, var(--wb-line-soft)); background: color-mix(in srgb, var(--wb-ok-ink) 10%, transparent); }
.wb-asin-judgment.is-watch { color: var(--wb-warn-ink); border-color: color-mix(in srgb, var(--wb-warn-ink) 45%, var(--wb-line-soft)); background: color-mix(in srgb, var(--wb-warn-ink) 10%, transparent); }
.wb-asin-judgment.is-drop { color: var(--wb-ink-3); border-color: var(--wb-line); text-decoration: line-through; }
.wb-asin-next { color: var(--wb-ink-3); font-size: 11px; max-width: 22em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-asin-pager { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--wb-sp-2); padding: var(--wb-sp-3) var(--wb-sp-4); border-top: 1px solid var(--wb-line-soft); }
.wb-asin-count { margin-right: auto; color: var(--wb-ink-3); font-size: var(--wb-fs-1); font-variant-numeric: tabular-nums; }
.wb-asin-page-size { display: flex; align-items: center; gap: var(--wb-sp-1); color: var(--wb-ink-3); font-size: var(--wb-fs-1); }
.wb-asin-page { min-width: 4.5em; text-align: center; font-size: var(--wb-fs-1); font-variant-numeric: tabular-nums; }
.wb-asin-pager button:disabled { opacity: .45; cursor: not-allowed; }
.wb-asin-row:last-child { border-bottom: none; }
.wb-asin-thumb { width: 44px; height: 44px; object-fit: contain; border-radius: var(--wb-r-2); border: 1px solid var(--wb-line-soft); background: var(--wb-surface); flex: none; }
.wb-asin-thumb.is-empty { display: inline-block; }
.wb-asin-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wb-asin-title { font-size: var(--wb-fs-2); font-weight: 600; color: var(--wb-ink-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-asin-title:hover { text-decoration: underline; }
.wb-asin-sub { display: flex; align-items: center; gap: var(--wb-sp-2); flex-wrap: wrap; font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-asin-code { font-family: var(--font-mono, ui-monospace, monospace); }
.wb-asin-copy { font: inherit; font-size: 11px; color: var(--wb-accent); background: none; border: 0; padding: 0 4px; cursor: pointer; text-decoration: underline; }
.wb-asin-note { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 18em; }
.wb-asin-nums { display: flex; align-items: center; gap: var(--wb-sp-2); flex: none; }
.wb-asin-price { font-size: var(--wb-fs-2); font-weight: 600; font-variant-numeric: tabular-nums; }
.wb-asin-spark { display: block; }
.wb-asin-meta { display: flex; align-items: center; gap: var(--wb-sp-3); flex: none; font-size: var(--wb-fs-1); color: var(--wb-ink-3); font-variant-numeric: tabular-nums; }
.wb-asin-date { opacity: .8; }
/* 选品「立项」按钮（v1.26）：比结论 chip 更"可执行"，所以是实心描边而不是 chip。
   只在已判断（verdict ≠ none）时出现 —— 未判断就立项等于跳过判断直接执行。 */
.wb-asin-task { display: inline-flex; align-items: center; height: 20px; padding: 0 var(--wb-sp-2); border: 1px solid color-mix(in srgb, var(--wb-accent) 48%, transparent); border-radius: var(--wb-r-2); background: transparent; color: var(--wb-accent); font: inherit; font-size: 11px; cursor: pointer; }
.wb-asin-task:hover { background: var(--wb-accent-soft); }
.wb-asin-task:disabled { opacity: .5; cursor: progress; }
.wb-asin-task:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 2px; }
/* ABA 词表（v1.30）：头部动作区 + 分层概览 + 阈值 + 表格
   - 三块之间用 1px 线分隔，避免"一整片白"里找不到结构；
   - 分层 chip 的颜色按层递进（头/中/长尾），"值得投"单独一色； */
.wb-aba { display: flex; flex-direction: column; gap: var(--wb-sp-4); margin-top: var(--wb-sp-7); padding-top: var(--wb-sp-6); border-top: 1px solid var(--wb-line); }
.wb-aba-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--wb-sp-4); flex-wrap: wrap; }
.wb-aba-head h3 { margin: 0 0 var(--wb-sp-1); font-size: var(--wb-fs-3); color: var(--wb-ink-1); }
.wb-aba-head p { margin: 0; font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-aba-actions { display: flex; align-items: center; gap: var(--wb-sp-2); flex-wrap: wrap; }
.wb-aba-actions .wb-btn { cursor: pointer; }
.wb-aba-sets { display: flex; align-items: center; gap: var(--wb-sp-2); flex-wrap: wrap; }
.wb-aba-sets-title { font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-aba-set { display: inline-flex; align-items: center; gap: var(--wb-sp-1); border: 1px solid var(--wb-line); border-radius: var(--wb-r-2); background: var(--wb-surface); }
.wb-aba-set.on { border-color: color-mix(in srgb, var(--wb-accent) 50%, transparent); background: var(--wb-accent-soft); }
.wb-aba-set-open { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: var(--wb-sp-1) var(--wb-sp-3); border: 0; background: transparent; color: var(--wb-ink-1); font: inherit; font-size: var(--wb-fs-1); text-align: left; cursor: pointer; }
.wb-aba-set-open small { color: var(--wb-ink-3); font-size: 10px; }
.wb-aba-tiers { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2); }
.wb-aba-tier { display: inline-flex; align-items: baseline; gap: var(--wb-sp-2); padding: var(--wb-sp-2) var(--wb-sp-3); border: 1px solid var(--wb-line); border-radius: var(--wb-r-2); font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-aba-tier b { font-size: var(--wb-fs-3); color: var(--wb-ink-1); font-variant-numeric: tabular-nums; }
.wb-aba-tier small { color: var(--wb-ink-3); font-size: 10px; }
.wb-aba-tier.is-head { border-color: color-mix(in srgb, var(--wb-ok) 40%, transparent); }
.wb-aba-tier.is-middle { border-color: color-mix(in srgb, var(--wb-tier-middle) 34%, transparent); }
.wb-aba-tier.is-tail { border-color: color-mix(in srgb, var(--wb-tier-tail) 26%, transparent); }
.wb-aba-tier.is-worth { border-style: dashed; }
.wb-aba-thresholds { display: flex; flex-wrap: wrap; gap: var(--wb-sp-4); font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-aba-thresholds label { display: inline-flex; align-items: center; gap: var(--wb-sp-2); }
.wb-aba-thresholds input { width: 72px; height: 26px; padding: 0 var(--wb-sp-2); border: 1px solid var(--wb-line); border-radius: var(--wb-r-1); background: var(--wb-surface); color: var(--wb-ink-1); font: inherit; font-size: var(--wb-fs-1); text-align: right; }
.wb-aba-worth { font-size: var(--wb-fs-1); white-space: nowrap; }
.wb-aba-worth.is-invest { color: var(--wb-ok-ink); font-weight: 600; }
.wb-aba-worth.is-watch { color: var(--wb-ink-2); }
.wb-aba-worth.is-avoid { color: var(--wb-danger-ink); }
.wb-aba-worth.is-unknown { color: var(--wb-ink-3); }
.wb-aba-reason { max-width: 380px; white-space: normal; font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
/* 「规则 vs 回填」：一致是背景信息（灰），不一致是**要人看一眼的信号**（谨慎用红，不用大色块） */
.wb-aba-diverge { white-space: nowrap; font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-aba-diverge.is-differs { color: var(--wb-danger-ink); font-weight: 600; }
/* 关联搜索词表现：这三类状态是**决策信号**，要能在扫视时看出来 */
.wb-aba-link { display: inline-flex; align-items: center; gap: var(--wb-sp-2); color: var(--wb-ink-2); }
.wb-aba-link input { accent-color: var(--wb-accent); width: 14px; height: 14px; margin: 0; cursor: pointer; }
.wb-aba-link.is-disabled { opacity: .6; cursor: default; }
/* 关联状态带：两侧各一项 + 开关，永远可见 —— 缺哪一侧要一眼看出并知道去哪补 */
.wb-aba-linkstate { display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; padding: var(--wb-sp-2) var(--wb-sp-3); border: 1px dashed var(--wb-line); border-radius: var(--wb-r-2); font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-aba-linkstate-item { padding: 1px var(--wb-sp-2); border-radius: var(--wb-r-1); background: color-mix(in srgb, var(--wb-ink-1) 5%, transparent); }
/* 报表摘要卡：导入后立刻能看出"这份报表有什么"，不依赖 ABA 词表是否存在 */
.wb-aba-report { display: flex; flex-direction: column; gap: var(--wb-sp-1); padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid var(--wb-line); border-radius: var(--wb-r-2); background: var(--wb-surface); font-size: var(--wb-fs-1); }
.wb-aba-report-head { display: flex; align-items: baseline; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-aba-report-head b { color: var(--wb-ink-1); font-size: var(--wb-fs-2); }
.wb-aba-report-head span { color: var(--wb-ink-2); font-variant-numeric: tabular-nums; }
.wb-aba-report-foot { color: var(--wb-ink-3); }
.wb-aba-report-foot b { color: var(--wb-ink-1); }
.wb-aba-report-foot em { font-style: normal; color: var(--wb-ink-3); }.wb-aba-linkstate-item.is-missing { color: var(--wb-ink-3); background: transparent; border: 1px dashed var(--wb-line); }
.wb-aba-status { white-space: nowrap; font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-aba-status.is-waste { color: var(--wb-danger-ink); font-weight: 600; }
.wb-aba-untouched { color: var(--wb-ink-3); font-size: var(--wb-fs-1); }
/* 搜索词报表里的 ABA 市场列：垄断要能一眼看出来（这是"换个打法"的信号） */
.wb-aba-market { white-space: nowrap; font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-aba-market.is-monopoly { color: var(--wb-danger-ink); font-weight: 600; }
@media (max-width: 720px) {
  .wb-aba-head { flex-direction: column; }
  .wb-aba-actions { width: 100%; }
  .wb-aba-reason { max-width: none; }
}
/* 选品店铺库（v1.25）：视图切换 + 店铺行
   - 页签复用工作台的分段控件（不另造一套）；
   - 店铺行是「星标 + 名称/副标题 + 两个操作」三段式，副标题里区分
     "库内实际商品数" 与 "脚本扫描数"，两者不一致时给出可解释的差值。 */
.wb-asin-tabs { margin-bottom: var(--wb-sp-3); }
/* finesse · product tabs: selected state stays obvious without decorative motion */
.wb-asin-tabs .wb-seg { min-height:var(--wb-ctl-h); transition:background-color .16s var(--wb-ease, cubic-bezier(.25,1,.5,1)), color .16s var(--wb-ease, cubic-bezier(.25,1,.5,1)); }
.wb-asin-tabs .wb-seg:focus-visible, .wb-asin-filters select:focus-visible, .wb-asin-filters input:focus-visible { outline:2px solid var(--wb-accent); outline-offset:3px; }
@media (hover: hover) { .wb-asin-tabs .wb-seg:hover { background:color-mix(in srgb, var(--wb-accent) 8%, transparent); color:var(--wb-ink-1); } }
.wb-asin-filters .wb-oplog-select, .wb-asin-filters .wb-oplog-search { min-height:var(--wb-ctl-h); border-radius:var(--wb-r-1); }
@media (prefers-reduced-motion: reduce) { .wb-asin-tabs .wb-seg { transition:none; } }
.wb-asin-tab-count { margin-left: var(--wb-sp-2); font-variant-numeric: tabular-nums; opacity: .75; }
.wb-asin-stores { display: flex; flex-direction: column; gap: var(--wb-sp-2); }
.wb-asin-store-row { display: flex; align-items: center; gap: var(--wb-sp-3); padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid var(--wb-line-soft); border-radius: var(--wb-r-2); }
.wb-asin-store-row.is-on { border-color: color-mix(in srgb, var(--wb-accent) 40%, transparent); background: color-mix(in srgb, var(--wb-accent) 6%, transparent); }
.wb-asin-store-main { display: flex; flex-direction: column; gap: var(--wb-sp-2); flex: 1; min-width: 0; }
.wb-asin-store-main b { font-size: var(--wb-fs-2); }
.wb-asin-store-sub { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wb-sp-3); font-size: var(--wb-fs-1); color: var(--wb-ink-3); }
.wb-asin-store-drift { border-bottom: 1px dashed currentColor; cursor: help; }
.wb-asin-store-actions { display: flex; align-items: center; gap: var(--wb-sp-2); flex: none; }
@media (max-width: 600px) {
  .wb-asin-store-row { flex-wrap: wrap; }
  .wb-asin-store-actions { flex: 1 1 100%; justify-content: flex-end; }
}
/* 选品批量操作（v1.24）：勾选列 + 批量条 + 导出路径
   - 勾选框单独一列，宽度固定：它不能把缩略图/标题挤走；
   - 批量条只在有勾选时出现（平时不占一行）；
   - 已选行整行淡色高亮，扫视时能看出"哪些会被改动"。 */
.wb-asin-selectall { display: flex; align-items: center; justify-content: space-between; gap: var(--wb-sp-3); padding: var(--wb-sp-2) var(--wb-sp-3); border-bottom: 1px solid var(--wb-line-soft); font-size: var(--wb-fs-1); color: var(--wb-ink-2); }
.wb-asin-selectall label { display: inline-flex; align-items: center; gap: var(--wb-sp-2); cursor: pointer; }
.wb-asin-selectall input, .wb-asin-pick input { accent-color: var(--wb-accent); width: 15px; height: 15px; margin: 0; cursor: pointer; }
.wb-asin-batch-hint { color: var(--wb-ink-3); }
.wb-asin-pick { display: inline-flex; align-items: center; flex: none; padding: 0 var(--wb-sp-1); cursor: pointer; }
.wb-asin-row.is-picked { background: color-mix(in srgb, var(--wb-accent) 7%, transparent); }
.wb-asin-batch { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wb-sp-2); padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid color-mix(in srgb, var(--wb-accent) 40%, transparent); border-radius: var(--wb-r-2); background: var(--wb-accent-soft); }
.wb-asin-batch-count { font-size: var(--wb-fs-1); font-weight: 600; color: var(--wb-ink-1); margin-right: var(--wb-sp-1); }
.wb-asin-batch-tag { width: 130px; height: 30px; padding: 0 var(--wb-sp-3); border: 1px solid var(--wb-line); border-radius: var(--wb-r-2); background: var(--wb-surface); color: var(--wb-ink-1); font: inherit; font-size: var(--wb-fs-2); }
.wb-asin-batch-danger { color: var(--wb-danger-ink); border-color: color-mix(in srgb, var(--wb-danger) 40%, transparent); }
.wb-asin-batch-tag:focus-visible, .wb-asin-pick input:focus-visible, .wb-asin-selectall input:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 2px; }
@media (max-width: 600px) {
  .wb-asin-batch-tag { flex: 1 1 100%; width: auto; }
}
/* 选品筛选按功能分组，列表容器边界柔化，避免窄屏挤压数据列。 */
.wb-asin { min-width: 0; }
/* 产品库整页是命名容器：页头/工具栏的窄屏重排按**面板**宽度判定（见下方 @container wb-products）。 */
.wb-products { container-type: inline-size; container-name: wb-products; }
.wb-asin-filters { min-width: 0; }
.wb-asin-filters > select { max-width: 190px; }
.wb-asin-filters > .wb-oplog-search { flex: 1 1 220px; min-width: 160px; }
.wb-asin-list { border-color: color-mix(in srgb, var(--wb-line) 72%, transparent); }
.wb-asin-row { min-width: 0; transition: background-color .12s ease; }
.wb-asin-row:hover { background: color-mix(in srgb, var(--wb-accent) 4%, transparent); }
.wb-asin-main { overflow: hidden; }
.wb-asin-nums { min-width: 118px; justify-content: flex-end; }
.wb-asin-meta { min-width: 170px; justify-content: flex-end; }
.wb-asin-watch:focus-visible, .wb-asin-order:focus-visible, .wb-asin-copy:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 2px; }
.wb-asin-pager { background: var(--wb-surface); }
@media (max-width: 920px) {
  .wb-asin-row { flex-wrap: wrap; align-items: flex-start; }
  .wb-asin-main { flex: 1 1 calc(100% - 120px); }
  .wb-asin-nums { margin-left: 56px; justify-content: flex-start; }
  .wb-asin-meta { flex: 1; min-width: 0; justify-content: flex-end; }
}
@media (max-width: 600px) {
  .wb-asin-filters > select { flex: 1 1 145px; max-width: none; }
  .wb-asin-filters > .wb-asin-order { min-width: 38px; }
  .wb-asin-row { gap: var(--wb-sp-2); padding: var(--wb-sp-3); }
  .wb-asin-thumb { width: 40px; height: 40px; }
  .wb-asin-main { flex-basis: calc(100% - 100px); }
  .wb-asin-title { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .wb-asin-sub { column-gap: var(--wb-sp-2); }
  .wb-asin-nums { margin-left: 48px; min-width: 0; }
  .wb-asin-meta { justify-content: flex-start; gap: var(--wb-sp-2); }
  .wb-asin-pager { justify-content: center; }
  .wb-asin-count { flex-basis: 100%; margin: 0; text-align: center; }
}


/* 运营日志 × 日历（2026-10-24）：格子上的日志标记 + 日志卡上的任务链接
   - 日志标记是**第二类信息**，不能抢任务主标记的视觉权重：小一号、低饱和。
   - 它是按钮（点了直接跳到该日日志），所以必须具备可见的 hover / focus 反馈。 */
.wb-day-log { margin-top: var(--wb-sp-2); display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px var(--wb-sp-2); border: 1px solid color-mix(in srgb, var(--wb-ink-3) 28%, transparent); border-radius: 999px; background: transparent; color: var(--wb-ink-3); font: inherit; font-size: 10px; line-height: 1.4; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-day-log:hover { color: var(--wb-ink-1); border-color: color-mix(in srgb, var(--wb-accent) 50%, transparent); background: var(--wb-accent-soft); }
.wb-mday-dots { display: flex; align-items: center; gap: 4px; }
.wb-mday-log { display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; padding: 0; border: 0; background: transparent; cursor: pointer; }
.wb-mday-log i { width: 5px; height: 5px; border-radius: 50%; background: var(--wb-ink-3); display: block; }
.wb-mday-log:hover i { background: var(--wb-accent); }
.wb-oplog-day { display: inline-flex; align-items: center; gap: var(--wb-sp-2); height: 30px; padding: 0 var(--wb-sp-3); border-radius: var(--wb-r-2); border: 1px solid var(--wb-line); background: var(--wb-surface); color: var(--wb-ink-2); }
.wb-oplog-day.is-on { border-color: color-mix(in srgb, var(--wb-accent) 55%, transparent); background: var(--wb-accent-soft); color: var(--wb-ink-1); }
.wb-oplog-day input { border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--wb-fs-2); padding: 0; outline: none; }
.wb-oplog-day:focus-within { outline: 2px solid var(--wb-accent); outline-offset: 2px; }
.wb-oplog-task-link { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--wb-sp-2); padding: 2px var(--wb-sp-3); border: 1px solid color-mix(in srgb, var(--wb-accent) 34%, transparent); border-radius: 999px; background: var(--wb-accent-soft); color: var(--wb-ink-1); font: inherit; font-size: var(--wb-fs-1); cursor: pointer; max-width: 100%; }
.wb-oplog-task-link:hover { border-color: color-mix(in srgb, var(--wb-accent) 60%, transparent); }
.wb-day-log:focus-visible, .wb-mday-log:focus-visible, .wb-oplog-task-link:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 2px; }

/* 折叠段：技能 / 角色 / 工作方式收成一行摘要（2026-10-23 重构） */
.wb-dialog .wb-fold { margin-top: var(--wb-sp-5); border-top: 1px solid var(--wb-line-soft); }
.wb-dialog .wb-fold-sum { display: flex; align-items: center; gap: var(--wb-sp-3); padding: var(--wb-sp-4) 0; cursor: pointer; list-style: none; font-size: var(--wb-fs-2); font-weight: 600; }
.wb-dialog .wb-fold-sum::-webkit-details-marker { display: none; }
.wb-dialog .wb-fold-sum::after { content: "▾"; margin-left: var(--wb-sp-2); color: var(--wb-ink-3); font-size: 11px; transition: transform .15s ease; }
.wb-dialog .wb-fold[open] .wb-fold-sum::after { transform: rotate(180deg); }
.wb-dialog .wb-fold-meta { margin-left: auto; font-weight: 400; font-size: var(--wb-fs-1); color: var(--wb-ink-3); max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-dialog .wb-fold-body { padding-bottom: var(--wb-sp-3); }
/* 折叠段内部不再画第二层框 */
.wb-dialog .wb-fold .wb-skill-picker, .wb-dialog .wb-fold .wb-persona-picker { margin-top: 0; border: 0; padding: 0; background: transparent; }


/* 快速录入排版（2026-10-23，第二轮）：字段之间给分隔，标签与说明分两行，
   技能行不再重复来源名，列表限高，避免整个弹窗变成一堵墙。 */
.wb-dialog .wb-field > span { display: block; font-weight: 600; }
.wb-dialog .wb-field > span .wb-field-note { display: block; margin-top: 2px; font-weight: 400; opacity: .85; line-height: 1.45; }
.wb-dialog .wb-field + .wb-field { margin-top: var(--wb-sp-6); padding-top: var(--wb-sp-5); border-top: 1px solid var(--wb-line-soft); }
.wb-dialog .wb-skill-picker-head, .wb-dialog .wb-persona-head { flex-wrap: wrap; row-gap: var(--wb-sp-1); }
.wb-dialog .wb-persona-current { max-width: 100%; }
.wb-dialog .wb-skill-provider { display: none; }
.wb-dialog .wb-skill-list { max-height: 150px; }
.wb-dialog .wb-skill-item { border-bottom: 1px solid var(--wb-line-soft); border-radius: 0; }
.wb-dialog .wb-skill-item:last-child { border-bottom: none; }
.wb-dialog .wb-skill-desc, .wb-dialog .wb-persona-desc { font-size: 11.5px; line-height: 1.4; }


/* 会话标题栏入口：从"贴在标签栏里的方框"改成幽灵药丸（仅 hover/激活时显形） */
.wb-header-entry { height: 24px; padding: 0 var(--wb-sp-3); border-radius: 999px; border-color: transparent; background: transparent; }
.wb-header-entry:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
.wb-header-entry[data-active] {
  border-color: transparent;
  background: color-mix(in srgb, var(--wb-ok) 13%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wb-ok) 28%, transparent);
  font-weight: 600;
}

`

/**
 * 对外导出的最终样式表：**令牌层 + 令牌化后的主体**。
 *
 * 两步的意义：主体里所有 '--dsw-*' 引用都被换成 '--wb-*'，而 '--wb-*' 在
 * 'tokenLayerCss()' 里以 'light-dark()' 兜底 —— 这样即使宿主主题令牌
 * 没有被继承到我们的节点（Modal portal 到 body、面板跨出主题子树），
 * 也只会跟随明暗，而不会退化成一片深黑。
 */
const AMAZON_CSS = `
.wb-amazon-tools { height: 100%; overflow: auto; padding: var(--wb-sp-6) var(--wb-sp-7); color: var(--wb-label-primary); container-type: inline-size; container-name: wb-calc; }
.wb-amazon-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--wb-sp-6); margin-bottom: var(--wb-sp-6); }
.wb-amazon-heading .wb-btn { flex: none; white-space: nowrap; }
.wb-amazon-heading h2 { margin: 0 0 var(--wb-sp-2); font-size: var(--wb-fs-5); }
.wb-amazon-heading p, .wb-amazon-footnote, .wb-amazon-save-state { margin: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-save-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-amazon-layout { display: grid; grid-template-columns: minmax(290px, .9fr) minmax(320px, 1.1fr); gap: var(--wb-sp-6); align-items: start; }
.wb-amazon-mode { width: max-content; max-width: 100%; margin: 0 0 var(--wb-sp-5); }
.wb-amazon-native-layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: var(--wb-sp-6); align-items: start; }
.wb-amazon-native-layout > * { min-width: 0; }
.wb-amazon-section-title { grid-column: 1 / -1; margin: var(--wb-sp-1) 0 0; color: var(--wb-label-primary); font-size: var(--wb-fs-2); font-weight: 600; }
.wb-amazon-result-head { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--wb-sp-1); border: 1px solid var(--wb-border-l1); background: var(--wb-border-l1); }
.wb-amazon-result-head > div { display: flex; flex-direction: column; gap: var(--wb-sp-3); min-width: 0; padding: var(--wb-sp-5); background: var(--wb-bg-layer-1); }
.wb-amazon-result-head span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-result-head strong { color: var(--wb-label-primary); font-size: var(--wb-fs-6); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.wb-amazon-result-actions { display: flex; justify-content: flex-end; padding-top: var(--wb-sp-1); }
.wb-amazon-bid-layout { margin-top: var(--wb-sp-5); }
.wb-amazon-inputs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--wb-sp-5); padding: var(--wb-sp-6); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); }
.wb-amazon-field { display: flex; flex-direction: column; gap: var(--wb-sp-2); min-width: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-field small { display: block; margin-top: var(--wb-sp-1); font-size: var(--wb-fs-1); }
.wb-amazon-input-wrap { display: flex; align-items: center; gap: var(--wb-sp-2); position: relative; }
.wb-amazon-input-wrap input { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: var(--wb-sp-2) var(--wb-sp-3); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; }
/**
 * 单位后缀（% 号）贴在输入框内部右缘。旧写法是 input 与 b 并排、b 被 flex 推到列尾，
 * 宽面板下数字和后缀相隔 200px，看起来像两个无关的元素。
 */
.wb-amazon-input-wrap.has-suffix input { padding-right: calc(var(--wb-sp-3) * 2 + 14px); }
.wb-amazon-input-wrap > b { position: absolute; right: var(--wb-sp-3); top: 50%; transform: translateY(-50%); color: var(--wb-label-tertiary); font-size: var(--wb-fs-1); font-weight: 500; pointer-events: none; }
/* 佣金固定 15%：只读但不是禁用 —— 用弱化的底与斜体数字表达"这项由售价推导"，不让它看着像坏掉的输入框。 */
.wb-amazon-field-fixed .wb-amazon-input-wrap input { color: var(--wb-label-secondary); background: color-mix(in srgb, var(--wb-label-primary) 6%, transparent); cursor: default; font-variant-numeric: tabular-nums; }
.wb-amazon-field-fixed .wb-amazon-input-wrap b { color: var(--wb-label-secondary); }
.wb-amazon-inputs > .wb-btn, .wb-amazon-save-state { grid-column: 1 / -1; }
/**
 * 输入卡的收尾行（v1.24）：保存状态在左、"恢复默认值"在右，**不再占满整行**。
 * 旧版把恢复默认值渲染成整行宽的 .wb-btn，看上去比真正的主按钮还重，而它是破坏性动作。
 */
.wb-amazon-input-actions { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--wb-sp-3); padding-top: var(--wb-sp-4); border-top: 1px solid var(--wb-border-l1); }
.wb-amazon-input-actions .wb-amazon-save-state { grid-column: auto; }
.wb-amazon-input-actions .wb-btn { flex: none; }
.wb-amazon-results { display: flex; flex-direction: column; gap: var(--wb-sp-5); }
.wb-amazon-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-top: 1px solid var(--wb-border-l1); border-left: 1px solid var(--wb-border-l1); }
.wb-amazon-metric { display: flex; flex-direction: column; gap: var(--wb-sp-3); min-width: 0; padding: var(--wb-sp-5); border-right: 1px solid var(--wb-border-l1); border-bottom: 1px solid var(--wb-border-l1); }
.wb-amazon-metric span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-metric strong { overflow-wrap: anywhere; font-size: var(--wb-fs-5); font-variant-numeric: tabular-nums; }
/**
 * 指标分两层（v1.24）：上面 4 个是结论，下面 4 个是核对用明细。
 * 两层共用一个"表格"边框（明细去掉上边框，看起来是同一张表的下半截），
 * 靠**小标题 + 字号**分层，而不是靠颜色 —— 颜色只用来表达状态。
 */
.wb-amazon-metrics-caption { margin: var(--wb-sp-2) 0 calc(var(--wb-sp-1) * -1); color: var(--wb-label-tertiary); font-size: var(--wb-fs-1); }
.wb-amazon-metrics-detail { border-top: 0; }
.wb-amazon-metrics-detail .wb-amazon-metric { gap: var(--wb-sp-2); padding: var(--wb-sp-3) var(--wb-sp-5); }
.wb-amazon-metrics-detail .wb-amazon-metric span { color: var(--wb-label-tertiary); }
.wb-amazon-metrics-detail .wb-amazon-metric strong { font-size: var(--wb-fs-3); color: var(--wb-label-primary); }
/**
 * 计算口径折叠（v1.24）：口径要"查得到"，但不该每次挡在结论前面。
 * 用原生 details/summary —— 键盘可达、无需额外 state。
 */
.wb-amazon-disclosure { border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); padding: var(--wb-sp-3) var(--wb-sp-4); }
.wb-amazon-disclosure > summary { cursor: pointer; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-disclosure > summary:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 2px; }
.wb-amazon-disclosure[open] > summary { margin-bottom: var(--wb-sp-2); }
.wb-amazon-disclosure > p { margin: 0; }
.wb-amazon-warning { padding: var(--wb-sp-4) var(--wb-sp-5); border: 1px solid color-mix(in srgb, var(--wb-warn) 42%, transparent); border-radius: var(--wb-r-2); background: color-mix(in srgb, var(--wb-warn) 12%, transparent); font-size: var(--wb-fs-1); }
.wb-amazon-footnote { line-height: 1.6; }
@media (max-width: 720px) { .wb-amazon-tools { padding: var(--wb-sp-5); } .wb-amazon-layout { grid-template-columns: minmax(0, 1fr); } .wb-amazon-inputs { grid-template-columns: minmax(0, 1fr); } .wb-amazon-heading { align-items: flex-start; } .wb-amazon-metric { padding: var(--wb-sp-4); } .wb-amazon-metric strong { font-size: var(--wb-fs-4); } .wb-amazon-result-head strong { font-size: var(--wb-fs-5); } }
/* 面板常被放在分栏里（宽 450–560px）而窗口仍很宽 —— 响应式必须跟容器走，不能跟视口走，否则结果列会被裁掉。 */
@container wb-calc (max-width: 656px) {
  /* 窄面板里结果放前面：改参数时不必先滚过一屏输入才看见数字。 */
  .wb-amazon-native-layout > .wb-amazon-inputs { order: 2; }
  .wb-amazon-native-layout > .wb-amazon-results { order: 1; }
}
@container wb-calc (max-width: 560px) {
  .wb-amazon-result-head > div { padding: var(--wb-sp-5); }
  .wb-amazon-metric { padding: var(--wb-sp-4) var(--wb-sp-5); }
  .wb-amazon-result-head strong { font-size: var(--wb-fs-5); }
  .wb-amazon-metric strong { font-size: var(--wb-fs-4); }
  .wb-amazon-results { gap: var(--wb-sp-4); }
}
.wb-package-layout { display: grid; grid-template-columns: minmax(0, .86fr) minmax(0, 1.14fr); gap: var(--wb-sp-6); margin-top: var(--wb-sp-5); align-items: start; }
.wb-package-inputs, .wb-package-results { min-width: 0; padding: var(--wb-sp-6); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-layer-1); }
.wb-package-inputs, .wb-package-results { display: flex; flex-direction: column; gap: var(--wb-sp-5); }
.wb-package-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--wb-sp-4); min-height: 42px; }
.wb-package-section-head h3 { margin: var(--wb-sp-1) 0 0; color: var(--wb-label-primary); font-size: var(--wb-fs-2); font-weight: 600; }
.wb-package-kicker { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-package-unit-note, .wb-package-class { flex: none; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-package-class { padding: var(--wb-sp-1) var(--wb-sp-3); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); }
.wb-package-input-group { display: flex; flex-direction: column; gap: var(--wb-sp-3); padding-top: var(--wb-sp-4); border-top: 1px solid var(--wb-border-l1); }
.wb-package-input-group h4 { margin: 0; color: var(--wb-label-primary); font-size: var(--wb-fs-1); font-weight: 600; }
.wb-package-dimension-grid, .wb-package-inline-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--wb-sp-4); }
.wb-package-dimension-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.wb-package-results { display: flex; flex-direction: column; gap: var(--wb-sp-5); }
.wb-package-alerts { display: flex; flex-direction: column; gap: var(--wb-sp-3); }
.wb-package-fee-head { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; border: 1px solid var(--wb-border-l1); background: var(--wb-border-l1); }
.wb-package-fee-head > div { display: flex; flex-direction: column; gap: var(--wb-sp-3); min-width: 0; padding: var(--wb-sp-5); background: var(--wb-bg-layer-1); }
.wb-package-fee-head span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-package-fee-head strong { color: var(--wb-label-primary); font-size: var(--wb-fs-6); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.wb-package-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border-top: 1px solid var(--wb-border-l1); border-left: 1px solid var(--wb-border-l1); }
.wb-package-metrics .wb-amazon-metric { padding: var(--wb-sp-5); }
.wb-package-preview {
  display: flex; justify-content: center;
  padding-bottom: var(--wb-sp-5);
  border-bottom: 1px solid var(--wb-border-l1);
}
/* ---------------- 飞机盒 3D 预览（按刀版 v2：315×202×62，机翼夹合） ----------------
   盖 / 底 各一片 + 中间 62 夹带 + 圆角插舌 + 两端机翼下折夹住侧壁 + 四角 45° 斜折。
   材质：瓦楞纹 + SVG feTurbulence 纸纹 + 逐面受光 + 内角遮蔽 + 影棚背景。
   牛皮纸色阶由令牌派生（--wb-warn 压深成棕再提亮），明暗主题都能跟随，
   同时满足 tokenScope 守卫"规则里不得出现字面色"。
   面板一律不用 border：1px 边框在 3D 旋转面上会被栅格化成"缝线"锯齿。 */

.wb-pkg3d { position: relative; width: 400px; max-width: 100%; margin: 0 auto; }
.wb-pkg3d-stage {
  position: relative; width: 400px; height: 400px;
  transform-origin: top left;
  border-radius: var(--wb-r-2);
  overflow: hidden;
  background:
    radial-gradient(120% 82% at 50% -6%, color-mix(in srgb, var(--wb-bg-layer-1) 92%, transparent), transparent 62%),
    radial-gradient(140% 120% at 50% 116%, color-mix(in srgb, var(--wb-label-primary) 9%, transparent), transparent 60%),
    var(--wb-bg-base);
  perspective: 1250px;
  perspective-origin: 50% 48%;
  touch-action: none;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  outline: none;

  --kp: color-mix(in srgb, var(--wb-warn) 82%, var(--wb-label-primary) 18%);
  --k-base: color-mix(in srgb, var(--kp) 76%, var(--wb-bg-base) 24%);
  --k-print: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='260' height='190' viewBox='0 0 260 190'%3E%3Cg fill='none' stroke='%23fff' stroke-opacity='.34' stroke-width='1'%3E%3Cpath d='M-20 170L70 80L160 170L250 80L330 160M-20 20L70 110L160 20L250 110L330 20'/%3E%3C/g%3E%3Cg fill='%23fff' fill-opacity='.38' font-family='Arial,sans-serif' font-size='10' font-weight='700'%3E%3Ctext x='20' y='55' transform='rotate(-34 20 55)'%3EPACK%3C/text%3E%3Ctext x='122' y='55' transform='rotate(-34 122 55)'%3EPACK%3C/text%3E%3Ctext x='224' y='55' transform='rotate(-34 224 55)'%3EPACK%3C/text%3E%3Ctext x='70' y='150' transform='rotate(-34 70 150)'%3EPACK%3C/text%3E%3Ctext x='172' y='150' transform='rotate(-34 172 150)'%3EPACK%3C/text%3E%3C/g%3E%3C/svg%3E");
  --k-crease: repeating-linear-gradient(135deg, transparent 0 38px, color-mix(in srgb, var(--wb-label-primary) 17%, transparent) 38px 39px, transparent 39px 76px);
  --k-edge-light: color-mix(in srgb, var(--wb-bg-layer-1) 38%, transparent);
  --k-edge-dark: color-mix(in srgb, var(--kp) 58%, transparent);
  --k-0: color-mix(in srgb, var(--k-base) 54%, var(--wb-bg-layer-1));
  --k-1: color-mix(in srgb, var(--k-base) 68%, var(--wb-bg-layer-1));
  --k-2: color-mix(in srgb, var(--k-base) 82%, var(--wb-bg-layer-1));
  --k-3: color-mix(in srgb, var(--k-base) 92%, var(--wb-bg-layer-1));
  --k-4: color-mix(in srgb, var(--k-base) 98%, var(--wb-bg-layer-1));
  --k-5: color-mix(in srgb, var(--k-base) 100%, var(--wb-bg-layer-1));
  --k-in1: color-mix(in srgb, var(--kp) 21%, var(--wb-bg-layer-1));
  --k-in2: color-mix(in srgb, var(--kp) 35%, var(--wb-bg-layer-1));
  --k-edge: color-mix(in srgb, var(--kp) 58%, transparent);
  --k-line: color-mix(in srgb, var(--kp) 42%, transparent);
  --k-flute: color-mix(in srgb, var(--kp) 13%, transparent);
  --k-ao: color-mix(in srgb, var(--kp) 46%, transparent);
  --k-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23g)' opacity='0.42'/%3E%3C/svg%3E");
  --k-fiber: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='f'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.018 0.32' numOctaves='2' seed='8' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23f)' opacity='0.22'/%3E%3C/svg%3E");
  --k-stain: radial-gradient(ellipse at 22% 18%, color-mix(in srgb, var(--kp) 11%, transparent), transparent 32%), radial-gradient(ellipse at 78% 74%, color-mix(in srgb, var(--kp) 8%, transparent), transparent 38%);
}
.wb-pkg3d-stage:focus-visible { box-shadow: var(--wb-ring-focus); }
.wb-pkg3d-stage.is-dragging { cursor: grabbing; }
.wb-pkg3d-frame {
  position: absolute; inset: 10px;
  border: 1px dashed color-mix(in srgb, var(--wb-label-primary) 12%, transparent);
  border-radius: 4px;
  pointer-events: none;
}
.wb-pkg3d-frame span {
  position: absolute; right: 4px; bottom: 2px;
  color: var(--wb-label-tertiary); font-size: 9px; line-height: 1; letter-spacing: .04em;
}
.wb-pkg3d-pan {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transform: translate3d(var(--px, 0px), var(--py, 0px), 0);
  transition: transform .7s cubic-bezier(.22, .9, .24, 1);
}
.wb-pkg3d-world {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transform: rotateX(var(--rx, -24deg)) rotateY(var(--ry, -32deg));
}
.wb-pkg3d-rig {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transform: scale3d(var(--s, 1), var(--s, 1), var(--s, 1));
  transition: transform .3s ease;
}
.wb-pkg3d-box { position: absolute; inset: 0; transform-style: preserve-3d; }

.wb-pkg3d-board {
  position: absolute; left: 50%; top: 50%;
  backface-visibility: visible;
  background-repeat: repeat;
  background-blend-mode: multiply, normal, normal;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 26%, transparent),
    inset 0 -10px 16px -10px var(--k-ao),
    inset 0 0 44px color-mix(in srgb, var(--kp) 26%, transparent),
   inset 1px 0 0 var(--k-edge-light), inset -1px 0 0 var(--k-edge-dark);
}
.wb-pkg3d-board.front, .wb-pkg3d-board.back {
  width: var(--bw); height: var(--bh);
  background-image:
    var(--k-print), var(--k-grain), var(--k-fiber), var(--k-stain), var(--k-crease),
    repeating-linear-gradient(180deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(172deg, var(--k-2) 0%, var(--k-3) 58%, var(--k-4) 100%);
}
.wb-pkg3d-board.left, .wb-pkg3d-board.right {
  width: var(--bd); height: var(--bh);
  overflow: hidden;
  background-image:
    var(--k-grain), var(--k-fiber), var(--k-stain),
    repeating-linear-gradient(90deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(176deg, var(--k-3) 0%, var(--k-4) 58%, var(--k-5) 100%);
}
.wb-pkg3d-board.bottom {
  width: var(--bw); height: var(--bd);
  background-image:
    var(--k-grain), var(--k-fiber), var(--k-stain),
    repeating-linear-gradient(90deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(160deg, var(--k-5), var(--k-5));
}
.wb-pkg3d-board.front { transform: translate(-50%, -50%) translateZ(calc(var(--bd) / 2)); }
.wb-pkg3d-board.back { transform: translate(-50%, -50%) rotateY(180deg) translateZ(calc(var(--bd) / 2)); }
.wb-pkg3d-board.right { transform: translate(-50%, -50%) rotateY(90deg) translateZ(calc(var(--bw) / 2)); }
.wb-pkg3d-board.left { transform: translate(-50%, -50%) rotateY(-90deg) translateZ(calc(var(--bw) / 2)); }
.wb-pkg3d-board.bottom { transform: translate(-50%, -50%) rotateX(-90deg) translateZ(calc(var(--bh) / 2)); }

.wb-pkg3d-liner {
  position: absolute; left: 50%; top: 50%;
  background-blend-mode: multiply, normal, normal;
  background-image:
    var(--k-grain), var(--k-fiber), var(--k-stain),
    repeating-linear-gradient(90deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(180deg, var(--k-in1), var(--k-in2));
  box-shadow:
    inset 0 0 34px color-mix(in srgb, var(--kp) 40%, transparent),
    inset 0 12px 22px -14px color-mix(in srgb, var(--k-5) 70%, transparent);
}
.wb-pkg3d-liner.front { width: var(--bw); height: var(--bh); transform: translate(-50%, -50%) translateZ(calc(var(--bd) / 2 - 2px)) rotateY(180deg); }
.wb-pkg3d-liner.back { width: var(--bw); height: var(--bh); transform: translate(-50%, -50%) translateZ(calc(var(--bd) / -2 + 2px)); }
.wb-pkg3d-liner.left { width: var(--bd); height: var(--bh); transform: translate(-50%, -50%) translate3d(calc(var(--bw) / -2 + 2px), 0, 0) rotateY(90deg); }
.wb-pkg3d-liner.right { width: var(--bd); height: var(--bh); transform: translate(-50%, -50%) translate3d(calc(var(--bw) / 2 - 2px), 0, 0) rotateY(-90deg); }
.wb-pkg3d-liner.bottom { width: var(--bw); height: var(--bd); transform: translate(-50%, -50%) translate3d(0, calc(var(--bh) / 2 - 2px), 0) rotateX(90deg); }

.wb-pkg3d-miter {
  position: absolute; top: 0; height: 1px;
  width: calc(var(--bh) * 1.45);
  transform-origin: 0 0;
  background: linear-gradient(90deg, var(--k-line), color-mix(in srgb, var(--k-line) 30%, transparent));
  pointer-events: none;
}
.wb-pkg3d-miter.a { left: 0; transform: rotate(45deg); }
.wb-pkg3d-miter.b { right: 0; transform-origin: 100% 0; transform: rotate(135deg); }

.wb-pkg3d-lidroot {
  position: absolute; left: 50%; top: 50%;
  width: 0; height: 0;
  transform-style: preserve-3d;
  transform: translate3d(0, calc(var(--bh) / -2), calc(var(--bd) / -2));
}
.wb-pkg3d-lid {
  position: absolute;
  left: calc(var(--lw) / -2); top: 0;
  width: var(--lw); height: var(--ld);
  transform-origin: 50% 0;
  transform-style: preserve-3d;
  transform: rotateX(90deg);
  transition: transform .78s cubic-bezier(.24, .86, .22, 1);
}
.wb-pkg3d-stage[data-open="true"] .wb-pkg3d-lid { transform: rotateX(262deg); }
.wb-pkg3d-lid-skin {
  position: absolute; inset: 0;
  border-radius: 2px;
  transform: translateZ(calc(var(--board) / 2));
  background-blend-mode: multiply, normal, normal;
  background-image:
    var(--k-print), var(--k-grain), var(--k-fiber), var(--k-stain),
    repeating-linear-gradient(90deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(118deg, var(--k-0) 0%, var(--k-1) 46%, var(--k-2) 100%);
  box-shadow:
    inset 0 2px 3px color-mix(in srgb, #fff 30%, transparent),
    inset 0 0 46px color-mix(in srgb, var(--kp) 22%, transparent);
}
.wb-pkg3d-lid-under {
  position: absolute; inset: 0;
  border-radius: 2px;
  transform: translateZ(calc(var(--board) * -1)) rotateY(180deg);
  background-blend-mode: multiply, normal, normal;
  background-image:
    var(--k-grain), var(--k-fiber), var(--k-stain),
    repeating-linear-gradient(90deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(180deg, var(--k-in1), var(--k-in2));
  box-shadow:
    inset 0 0 30px color-mix(in srgb, var(--kp) 40%, transparent),
    inset 0 10px 18px -12px color-mix(in srgb, var(--k-5) 75%, transparent);
}
.wb-pkg3d-tuck {
  position: absolute;
  left: 6%; top: 100%;
  width: 88%; height: var(--tk);
  transform-origin: 50% 0;
  transform: translateY(calc(-1 * var(--tk-in))) rotateX(-90deg);
  transition: transform .78s cubic-bezier(.24, .86, .22, 1);
  border-radius: 0 0 10px 10px;
  background-blend-mode: multiply, normal, normal;
  background-image:
    var(--k-grain), var(--k-fiber), var(--k-stain),
    repeating-linear-gradient(90deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(180deg, var(--k-1), var(--k-2));
  box-shadow:
    inset 0 -14px 22px -8px color-mix(in srgb, var(--kp) 45%, transparent),
    inset 0 2px 3px color-mix(in srgb, #fff 20%, transparent);
}
.wb-pkg3d-stage[data-open="true"] .wb-pkg3d-tuck { transform: translateY(calc(-1 * var(--tk-in))) rotateX(-4deg); }
.wb-pkg3d-stage[data-open="false"] .wb-pkg3d-tuck { transform: translateY(calc(-1 * var(--tk-in))) rotateX(-90deg); }
.wb-pkg3d-tuck-edge { position: absolute; left: 0; right: 0; bottom: 0; height: var(--board); background: repeating-linear-gradient(90deg, var(--k-edge-light) 0 1px, var(--k-edge-dark) 1px 3px, var(--k-flute) 3px 5px); transform: translateZ(1px); }

.wb-pkg3d-wing {
  position: absolute; top: 0;
  width: var(--wg); height: 100%;
  transform-style: preserve-3d;
  transition: transform .78s cubic-bezier(.24, .86, .22, 1);
}
.wb-pkg3d-wing.l { left: calc(-1 * var(--wg)); transform-origin: 100% 0; transform: rotateY(-90deg); }
.wb-pkg3d-wing.r { right: calc(-1 * var(--wg)); transform-origin: 0 0; transform: rotateY(90deg); }
.wb-pkg3d-stage[data-open="true"] .wb-pkg3d-wing.l { transform: rotateY(-10deg); }
.wb-pkg3d-stage[data-open="true"] .wb-pkg3d-wing.r { transform: rotateY(10deg); }
.wb-pkg3d-wing-skin {
  position: absolute; inset: 0;
  border-radius: 2px 2px 3px 3px;
  transform: translateZ(calc(var(--board) / 2));
  background-blend-mode: multiply, normal, normal;
  background-image:
    var(--k-grain), var(--k-fiber), var(--k-stain),
    repeating-linear-gradient(90deg, var(--k-flute) 0 1px, transparent 1px 6px),
    linear-gradient(180deg, var(--k-2) 0%, var(--k-3) 62%, var(--k-4) 100%);
  box-shadow:
    inset 0 2px 3px color-mix(in srgb, #fff 22%, transparent),
    inset 0 -12px 20px -10px color-mix(in srgb, var(--kp) 40%, transparent);
}
.wb-pkg3d-wing-edge { position: absolute; top: 0; right: 0; bottom: 0; width: var(--board); background: repeating-linear-gradient(0deg, var(--k-edge-light) 0 1px, var(--k-edge-dark) 1px 3px, var(--k-flute) 3px 5px); transform: translateX(50%) rotateY(90deg); transform-origin: right center; }
.wb-pkg3d-lid-edge { position: absolute; left: 0; right: 0; bottom: 0; height: var(--board); background: repeating-linear-gradient(90deg, var(--k-edge-light) 0 1px, var(--k-edge-dark) 1px 3px, var(--k-flute) 3px 5px); transform: translateY(50%) rotateX(-90deg); transform-origin: center top; }
.wb-pkg3d-wing-skin::after {
  content: ""; position: absolute; inset: 0;
  background-image:
    var(--k-print), var(--k-crease),
    linear-gradient(to bottom right, transparent calc(50% - .6px), var(--k-line) calc(50% - .6px) calc(50% + .6px), transparent calc(50% + .6px));
}

.wb-pkg3d-shadow {
  position: absolute; left: 50%; top: 50%;
  width: calc(var(--bw) * 1.18); height: calc(var(--bd) * 1.18);
  transform: translate(-50%, -50%) rotateX(90deg) translateZ(calc(var(--bh) / -2 - 4px));
  border-radius: 50%;
  background:
    radial-gradient(42% 42% at 50% 50%, color-mix(in srgb, var(--wb-label-primary) 34%, transparent), transparent 72%),
    radial-gradient(60% 60% at 50% 50%, color-mix(in srgb, var(--wb-label-primary) 16%, transparent), transparent 78%);
  filter: blur(6px);
  pointer-events: none;
}

.wb-pkg3d-hud { position: absolute; left: 12px; top: 10px; display: flex; flex-direction: column; gap: 3px; pointer-events: none; }
.wb-pkg3d-hud-big { color: var(--wb-label-primary); font-size: 15px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; }
.wb-pkg3d-hud-sub { color: var(--wb-label-secondary); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.wb-pkg3d-actions { position: absolute; left: 10px; right: 10px; bottom: 8px; display: flex; align-items: center; gap: 6px; }
.wb-pkg3d-btn {
  appearance: none; cursor: pointer;
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
  border: 1px solid var(--wb-border-l1); border-radius: 999px;
  background: color-mix(in srgb, var(--wb-bg-layer-1) 86%, transparent);
  color: var(--wb-label-secondary);
  font-size: 11px; font-weight: 500; line-height: 1;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.wb-pkg3d-btn:hover { color: var(--wb-label-primary); border-color: color-mix(in srgb, var(--wb-accent) 45%, transparent); }
.wb-pkg3d-btn[aria-pressed="true"] { color: var(--wb-accent); border-color: color-mix(in srgb, var(--wb-accent) 50%, transparent); background: var(--wb-accent-soft); }

/* ---------------- 外箱装箱 3D 预览（RSC 开槽箱） ----------------
   与飞机盒共用同一套牛皮纸色阶；四片摇盖向箱体外侧下翻展开。 */
.wb-carton3d { position: relative; width: 400px; max-width: 100%; margin: 0 auto; }
.wb-carton3d-stage {
  position: relative; width: 400px; height: 400px;
  transform-origin: top left;
  border-radius: var(--wb-r-2);
  overflow: hidden;
  background:
    radial-gradient(120% 82% at 50% -6%, color-mix(in srgb, var(--wb-bg-layer-1) 92%, transparent), transparent 62%),
    radial-gradient(140% 120% at 50% 116%, color-mix(in srgb, var(--wb-label-primary) 9%, transparent), transparent 60%),
    var(--wb-bg-base);
  perspective: 1200px;
  perspective-origin: 50% 50%;
  touch-action: none;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  outline: none;

  --kp: color-mix(in srgb, var(--wb-warn) 58%, var(--wb-label-primary));
  --ct0: color-mix(in srgb, var(--kp) 14%, var(--wb-bg-layer-1));
  --ct1: color-mix(in srgb, var(--kp) 27%, var(--wb-bg-layer-1));
  --ct2: color-mix(in srgb, var(--kp) 41%, var(--wb-bg-layer-1));
  --ct3: color-mix(in srgb, var(--kp) 56%, var(--wb-bg-layer-1));
  --ct4: color-mix(in srgb, var(--kp) 72%, var(--wb-bg-layer-1));
  --ct5: color-mix(in srgb, var(--kp) 90%, var(--wb-bg-layer-1));
  --ct-line: color-mix(in srgb, var(--kp) 42%, transparent);
  --ct-flute: color-mix(in srgb, var(--kp) 13%, transparent);
  --ct-grain: var(--k-grain, none);
}
.wb-carton3d-stage:focus-visible { box-shadow: var(--wb-ring-focus); }
.wb-carton3d-stage.is-dragging { cursor: grabbing; }
.wb-carton3d-frame {
  position: absolute; inset: 10px;
  border: 1px dashed color-mix(in srgb, var(--wb-label-primary) 12%, transparent);
  border-radius: 4px;
  pointer-events: none;
}
.wb-carton3d-frame span {
  position: absolute; right: 4px; bottom: 2px;
  color: var(--wb-label-tertiary); font-size: 9px; line-height: 1; letter-spacing: .04em;
}
.wb-carton3d-pan {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transform: translate3d(var(--px, 0px), var(--py, 0px), 0);
}
.wb-carton3d-world {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transform: rotateX(var(--rx, -26deg)) rotateY(var(--ry, -34deg));
}
.wb-carton3d-rig {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
  transform: scale3d(var(--s, 1), var(--s, 1), var(--s, 1));
  transition: transform .3s ease;
}
.wb-carton3d-carton { position: absolute; inset: 0; transform-style: preserve-3d; }

.wb-carton3d-wall {
  position: absolute; left: 50%; top: 50%;
  border: 0;
  background-color: var(--ct2);
  background-image:
    repeating-linear-gradient(90deg, var(--ct-flute) 0 1px, transparent 1px 6px),
    linear-gradient(180deg, color-mix(in srgb, #fff 14%, transparent) 0, transparent 16%);
  box-shadow:
    inset 0 0 30px color-mix(in srgb, var(--kp) 20%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--kp) 22%, transparent);
  backface-visibility: visible;
  transition: background-color .35s ease;
}

.wb-carton3d-wall.front { width: var(--cw); height: var(--ch); background-image: repeating-linear-gradient(90deg, var(--ct-flute) 0 1px, transparent 1px 6px), linear-gradient(174deg, var(--ct1) 0%, var(--ct2) 55%, var(--ct3) 100%); transform: translate(-50%, -50%) translateZ(calc(var(--cd) / 2)); }
.wb-carton3d-wall.back { width: var(--cw); height: var(--ch); background-image: repeating-linear-gradient(90deg, var(--ct-flute) 0 1px, transparent 1px 6px), linear-gradient(174deg, var(--ct4), var(--ct5)); transform: translate(-50%, -50%) rotateY(180deg) translateZ(calc(var(--cd) / 2)); }
.wb-carton3d-wall.right { width: var(--cd); height: var(--ch); background-image: repeating-linear-gradient(90deg, var(--ct-flute) 0 1px, transparent 1px 6px), linear-gradient(176deg, var(--ct3) 0%, var(--ct4) 55%, var(--ct5) 100%); transform: translate(-50%, -50%) rotateY(90deg) translateZ(calc(var(--cw) / 2)); }
.wb-carton3d-wall.left { width: var(--cd); height: var(--ch); background-image: repeating-linear-gradient(90deg, var(--ct-flute) 0 1px, transparent 1px 6px), linear-gradient(176deg, var(--ct2) 0%, var(--ct3) 60%, var(--ct4) 100%); transform: translate(-50%, -50%) rotateY(-90deg) translateZ(calc(var(--cw) / 2)); }
.wb-carton3d-wall.bottom {
  width: var(--cw); height: var(--cd);
  background-color: var(--ct3);
  transform: translate(-50%, -50%) rotateX(-90deg) translateZ(calc(var(--ch) / 2));
}


.wb-carton3d-flap-root { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform-style: preserve-3d; }
.wb-carton3d-flap-root.back { transform: translate3d(0, calc(var(--ch) / -2 - .7px), calc(var(--cd) / -2)); }
.wb-carton3d-flap-root.front { transform: translate3d(0, calc(var(--ch) / -2 - .2px), calc(var(--cd) / 2)) rotateY(180deg); }
.wb-carton3d-flap-root.right { transform: translate3d(calc(var(--cw) / 2), calc(var(--ch) / -2 + .2px), 0) rotateY(-90deg); }
.wb-carton3d-flap-root.left { transform: translate3d(calc(var(--cw) / -2), calc(var(--ch) / -2 + .6px), 0) rotateY(90deg); }

.wb-carton3d-flap {
  position: absolute;
  transform-origin: 50% 0;
  background-color: var(--ct1);
  background-image:
    repeating-linear-gradient(90deg, var(--ct-flute) 0 1px, transparent 1px 6px),
    linear-gradient(180deg, color-mix(in srgb, #fff 18%, transparent) 0, transparent 22%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kp) 20%, transparent);
  transform: rotateX(90deg);
  transition: transform .7s cubic-bezier(.22, .9, .24, 1), background-color .35s ease;
}
/* 透视档：整层降透明，不改逐面受光，避免把实体材质冲成灰 */
.wb-carton3d-stage[data-xray="true"] .wb-carton3d-wall { opacity: .42; }
.wb-carton3d-stage[data-xray="true"] .wb-carton3d-wall.front,
.wb-carton3d-stage[data-xray="true"] .wb-carton3d-wall.right { opacity: .26; }
.wb-carton3d-stage[data-xray="true"] .wb-carton3d-flap { opacity: .5; }
.wb-carton3d-flap.back, .wb-carton3d-flap.front {
  left: calc(var(--cw) / -2); top: 0;
  width: var(--cw); height: calc(var(--cd) / 2);
}
.wb-carton3d-flap.left, .wb-carton3d-flap.right {
  left: calc(var(--cd) / -2); top: 0;
  width: var(--cd); height: calc(var(--cw) * .3);
}
.wb-carton3d-stage[data-open="true"] .wb-carton3d-flap.back { transform: rotateX(260deg); }
.wb-carton3d-stage[data-open="true"] .wb-carton3d-flap.front { transform: rotateX(260deg); }
.wb-carton3d-stage[data-open="true"] .wb-carton3d-flap.right { transform: rotateX(265deg); }
.wb-carton3d-stage[data-open="true"] .wb-carton3d-flap.left { transform: rotateX(265deg); }

.wb-carton3d-items { position: absolute; inset: 0; transform-style: preserve-3d; }
.wb-carton3d-ibox {
  position: absolute;
  left: calc(50% - var(--iw) / 2);
  top: calc(50% - var(--ih) / 2);
  width: var(--iw); height: var(--ih);
  transform-style: preserve-3d;
  transform: translate3d(var(--tx), var(--ty), var(--tz));
}
.wb-carton3d-ibox i {
  position: absolute; left: 50%; top: 50%;
  background-color: color-mix(in srgb, var(--kp) 34%, var(--wb-bg-layer-1));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--kp) 26%, transparent),
    inset 0 0 14px color-mix(in srgb, var(--kp) 22%, transparent);
}
.wb-carton3d-ibox.alt i { background-color: color-mix(in srgb, var(--kp) 44%, var(--wb-bg-layer-1)); }
.wb-carton3d-ibox .f-top { width: var(--iw); height: var(--id); background-color: color-mix(in srgb, var(--kp) 26%, var(--wb-bg-layer-1)); transform: translate(-50%, -50%) rotateX(90deg) translateZ(calc(var(--ih) / 2)); }
.wb-carton3d-ibox.alt .f-top { background-color: color-mix(in srgb, var(--kp) 34%, var(--wb-bg-layer-1)); }
.wb-carton3d-ibox .f-front { width: var(--iw); height: var(--ih); transform: translate(-50%, -50%) translateZ(calc(var(--id) / 2)); }
.wb-carton3d-ibox .f-back { width: var(--iw); height: var(--ih); transform: translate(-50%, -50%) rotateY(180deg) translateZ(calc(var(--id) / 2)); }
.wb-carton3d-ibox .f-right { width: var(--id); height: var(--ih); transform: translate(-50%, -50%) rotateY(90deg) translateZ(calc(var(--iw) / 2)); }
.wb-carton3d-ibox .f-left { width: var(--id); height: var(--ih); transform: translate(-50%, -50%) rotateY(-90deg) translateZ(calc(var(--iw) / 2)); }

.wb-carton3d-shadow {
  position: absolute; left: 50%; top: 50%;
  width: calc(var(--cw) * 1.22); height: calc(var(--cd) * 1.22);
  transform: translate(-50%, -50%) rotateX(90deg) translateZ(calc(var(--ch) / -2 - 4px));
  border-radius: 50%;
  background:
    radial-gradient(42% 42% at 50% 50%, color-mix(in srgb, var(--wb-label-primary) 32%, transparent), transparent 72%),
    radial-gradient(62% 62% at 50% 50%, color-mix(in srgb, var(--wb-label-primary) 15%, transparent), transparent 78%);
  filter: blur(6px);
  pointer-events: none;
}

.wb-carton3d-hud { position: absolute; left: 12px; top: 10px; display: flex; flex-direction: column; gap: 3px; pointer-events: none; }
.wb-carton3d-hud-big { color: var(--wb-label-primary); font-size: 15px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; }
.wb-carton3d-hud-sub { color: var(--wb-label-secondary); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.wb-carton3d-actions { position: absolute; left: 10px; right: 10px; bottom: 8px; display: flex; align-items: center; gap: 6px; }
.wb-carton3d-btn {
  appearance: none; cursor: pointer;
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
  border: 1px solid var(--wb-border-l1); border-radius: 999px;
  background: color-mix(in srgb, var(--wb-bg-layer-1) 86%, transparent);
  color: var(--wb-label-secondary);
  font-size: 11px; font-weight: 500; line-height: 1;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.wb-carton3d-btn:hover { color: var(--wb-label-primary); border-color: color-mix(in srgb, var(--wb-accent) 45%, transparent); }
.wb-carton3d-btn[aria-pressed="true"] { color: var(--wb-accent); border-color: color-mix(in srgb, var(--wb-accent) 50%, transparent); background: var(--wb-accent-soft); }
@container wb-calc (max-width: 560px) {
  .wb-package-layout { grid-template-columns: minmax(0, 1fr); }
  .wb-package-inputs { order: 2; }
  .wb-package-results { order: 1; }
}
@container wb-calc (max-width: 460px) {
  .wb-amazon-inputs { grid-template-columns: minmax(0, 1fr); }
  .wb-amazon-result-head { grid-template-columns: minmax(0, 1fr); }
  .wb-amazon-heading { align-items: flex-start; flex-direction: column; gap: var(--wb-sp-3); }
  .wb-amazon-mode { width: 100%; }
  .wb-amazon-mode .wb-seg { flex: 1; justify-content: center; }
}
/* 关键词库（v1.21）：输入区改成自适应多列 —— 核心词/修饰词/否词/方案名四个字段，
   固定 3 列会把「方案名」挤到第二行只剩半格。 */
.wb-amazon-keyword-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--wb-sp-5); margin-bottom: var(--wb-sp-6); align-items: end; }
.wb-amazon-keyword-form label { display: flex; flex-direction: column; gap: var(--wb-sp-2); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); min-width: 0; }
.wb-amazon-keyword-form input[type=text], .wb-amazon-keyword-form input:not([type]) { height: 34px; padding: var(--wb-sp-2) var(--wb-sp-3); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); }
.wb-amazon-keyword-form .wb-amazon-checks { padding-top: 0; }
.wb-amazon-checks { display: flex; align-items: center; gap: var(--wb-sp-4); padding-top: var(--wb-sp-6); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
/* 否词清单：与关键词表分开，避免"否词混进投放词"这种最危险的误读 */
.wb-amazon-negatives { margin: var(--wb-sp-6) 0; padding: var(--wb-sp-4) var(--wb-sp-5); border: 1px solid color-mix(in srgb, var(--wb-danger) 26%, transparent); border-radius: var(--wb-r-2); background: color-mix(in srgb, var(--wb-danger) 6%, transparent); }
.wb-amazon-chips { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2); }
/* 词库列表行：左"打开"，右"关联 ASIN / 删除"，窄屏换行不挤压标题 */
.wb-amazon-keyword-plan { display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; padding: var(--wb-sp-2); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); }
.wb-amazon-keyword-plan.on { border-color: color-mix(in srgb, var(--wb-state-business-primary) 42%, transparent); background: color-mix(in srgb, var(--wb-state-business-primary) 8%, transparent); }
.wb-amazon-keyword-plan-open { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: var(--wb-sp-1); padding: var(--wb-sp-2) var(--wb-sp-3); border: 0; background: transparent; color: var(--wb-label-primary); font: inherit; font-size: var(--wb-fs-1); text-align: left; cursor: pointer; border-radius: var(--wb-r-1); }
.wb-amazon-keyword-plan-open:hover { background: color-mix(in srgb, var(--wb-label-primary) 5%, transparent); }
.wb-amazon-keyword-plan-open small { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-keyword-plan-actions { display: flex; align-items: center; gap: var(--wb-sp-2); flex: none; }
.wb-amazon-keyword-asin { width: 130px; height: 28px; padding: 0 var(--wb-sp-2); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; font-size: var(--wb-fs-1); }
/* 导出后的真实路径：等宽 + 可换行，长路径不会把整行撑破 */
.wb-amazon-path { display: inline-block; max-width: 100%; padding: 1px var(--wb-sp-2); border-radius: var(--wb-r-1); background: color-mix(in srgb, var(--wb-label-primary) 6%, transparent); font: 11px/1.5 ui-monospace, monospace; word-break: break-all; }
@media (max-width: 720px) {
  .wb-amazon-keyword-form { grid-template-columns: 1fr; }
  .wb-amazon-keyword-plan-actions { flex: 1 1 100%; }
  .wb-amazon-keyword-asin { flex: 1; width: auto; }
}
.wb-amazon-table-wrap { overflow: auto; border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); }
.wb-amazon-table { width: 100%; min-width: 680px; border-collapse: collapse; font-size: var(--wb-fs-1); }
.wb-amazon-table th, .wb-amazon-table td { padding: var(--wb-sp-4); border-bottom: 1px solid var(--wb-border-l1); text-align: left; white-space: nowrap; }
.wb-amazon-table th { color: var(--wb-label-secondary); font-weight: 600; }
.wb-amazon-csv { box-sizing: border-box; width: 100%; min-height: 140px; margin-bottom: var(--wb-sp-6); padding: var(--wb-sp-4); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); font: 12px/1.5 ui-monospace, monospace; }
@media (max-width: 720px) { .wb-amazon-keyword-form { grid-template-columns: 1fr; } .wb-amazon-checks { padding-top: 0; } }


/* ---- 搜索词：表格接入（v1.18） ---- */
.wb-amazon-heading-actions { display: flex; flex: none; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-amazon-file { display: none; }
.wb-amazon-import { margin-bottom: var(--wb-sp-5); }
.wb-amazon-import .wb-amazon-csv { min-height: 150px; max-height: 260px; margin-bottom: var(--wb-sp-3); resize: vertical; }
.wb-amazon-import-actions { display: flex; align-items: center; gap: var(--wb-sp-4); flex-wrap: wrap; }
.wb-amazon-import-hint { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-dataset-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--wb-sp-5); flex-wrap: wrap; margin-bottom: var(--wb-sp-5); padding: var(--wb-sp-4) var(--wb-sp-5); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-layer-1); }
.wb-amazon-dataset-bar strong { display: block; color: var(--wb-label-primary); font-size: var(--wb-fs-2); }
.wb-amazon-dataset-bar span { display: block; margin-top: var(--wb-sp-1); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-dataset-id { display: inline-block; margin-top: var(--wb-sp-1); padding: var(--wb-sp-1) var(--wb-sp-2); border-radius: var(--wb-r-1); background: color-mix(in srgb, var(--wb-label-primary) 8%, transparent); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-dataset-actions { display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-amazon-pill { padding: var(--wb-sp-1) var(--wb-sp-3); border: 1px solid var(--wb-border-l1); border-radius: 999px; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); white-space: nowrap; }
.wb-amazon-pill.ok { border-color: color-mix(in srgb, var(--wb-state-business-primary) 40%, transparent); color: var(--wb-state-business-primary); }
.wb-amazon-summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--wb-sp-1); margin-bottom: var(--wb-sp-5); border: 1px solid var(--wb-border-l1); background: var(--wb-border-l1); }
.wb-amazon-summary-item { display: flex; flex-direction: column; gap: var(--wb-sp-2); min-width: 0; padding: var(--wb-sp-4) var(--wb-sp-5); background: var(--wb-bg-layer-1); }
.wb-amazon-summary-item span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-summary-item strong { color: var(--wb-label-primary); font-size: var(--wb-fs-4); font-variant-numeric: tabular-nums; }
.wb-amazon-table-grid { min-width: 900px; padding: 0; font-variant-numeric: tabular-nums; }
.wb-amazon-table-grid th, .wb-amazon-table-grid td { padding: var(--wb-sp-3) var(--wb-sp-4); }
.wb-amazon-table-grid thead th { position: sticky; top: 0; z-index: 1; background: var(--wb-bg-layer-1); text-align: right; }
.wb-amazon-table-grid th.text, .wb-amazon-table-grid td.text { text-align: left; }
.wb-amazon-table-grid thead th.text { left: 0; }
.wb-amazon-table-grid td { text-align: right; }
.wb-amazon-table-grid tbody tr:hover td { background: color-mix(in srgb, var(--wb-label-primary) 4%, transparent); }
.wb-amazon-table-grid tbody td.text:first-child { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
/* 横向滚动时首列（搜索词）与表头都钉住：11 列在 500px 面板里必然要滚，丢掉的不能是关键信息。 */
.wb-amazon-table-grid th:first-child, .wb-amazon-table-grid td:first-child { position: sticky; left: 0; z-index: 2; background: var(--wb-bg-base); }
.wb-amazon-table-grid thead th:first-child { z-index: 3; background: var(--wb-bg-layer-1); }
@container wb-calc (max-width: 760px) {
  .wb-amazon-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@container wb-calc (max-width: 400px) {
  .wb-amazon-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.wb-amazon-action { display: inline-block; padding: var(--wb-sp-1) var(--wb-sp-2); border: 1px solid var(--wb-border-l1); border-radius: 999px; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); white-space: nowrap; }
.wb-amazon-action.none { border-style: dashed; }
.wb-amazon-action.add-exact, .wb-amazon-action.add-phrase { border-color: color-mix(in srgb, var(--wb-state-business-primary) 42%, transparent); color: var(--wb-state-business-primary); }
.wb-amazon-action.negative-exact, .wb-amazon-action.negative-phrase { border-color: color-mix(in srgb, var(--wb-label-primary) 34%, transparent); color: var(--wb-label-primary); }
.wb-amazon-empty { display: flex; flex-direction: column; gap: var(--wb-sp-2); padding: var(--wb-sp-7) var(--wb-sp-6); border: 1px dashed var(--wb-border-l1); border-radius: var(--wb-r-2); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); text-align: center; }
.wb-amazon-empty strong { color: var(--wb-label-primary); font-size: var(--wb-fs-2); }
/* ---- 亚马逊版块唯一数据入口（2026-10-29） ----
   替掉两个常驻大 textarea：拖放区 + 引导块。颜色只借用业务主色与既有边界/标签变量，
   不新增硬编码色值，换肤仍然只改 :root。 */
.wb-datasource { display: flex; flex-direction: column; gap: var(--wb-sp-4); margin-bottom: var(--wb-sp-5); }
.wb-datasource-drop { display: flex; align-items: center; gap: var(--wb-sp-4); flex-wrap: wrap; padding: var(--wb-sp-5); border: 1px dashed var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-layer-1); }
.wb-datasource-drop.is-over { border-color: var(--wb-state-business-primary); background: color-mix(in srgb, var(--wb-state-business-primary) 8%, transparent); }
.wb-datasource-drop.is-busy { opacity: .72; }
.wb-datasource-icon { display: flex; flex: none; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--wb-r-1); background: color-mix(in srgb, var(--wb-state-business-primary) 12%, transparent); color: var(--wb-state-business-primary); }
.wb-datasource-copy { display: flex; flex: 1 1 220px; flex-direction: column; gap: var(--wb-sp-1); min-width: 0; }
.wb-datasource-copy strong { color: var(--wb-label-primary); font-size: var(--wb-fs-2); }
.wb-datasource-copy span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-datasource-actions { display: flex; flex: none; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-datasource-guide { display: flex; flex-direction: column; gap: var(--wb-sp-2); padding: var(--wb-sp-4) var(--wb-sp-5); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-base); }
.wb-datasource-guide > div { display: flex; gap: var(--wb-sp-3); align-items: flex-start; font-size: var(--wb-fs-1); }
.wb-datasource-guide b { display: flex; flex: none; align-items: center; gap: var(--wb-sp-1); width: 88px; color: var(--wb-label-secondary); font-weight: 500; }
.wb-datasource-guide span { color: var(--wb-label-primary); line-height: 1.6; }
.wb-datasource-cols { display: flex; gap: var(--wb-sp-2); flex-wrap: wrap; }
/* 窄屏：按钮组整行落下，引导块的标签列收窄，避免"要哪几列"被挤成竖排单字。 */
@media (max-width: 720px) {
  .wb-datasource-drop { align-items: flex-start; }
  .wb-datasource-actions { width: 100%; }
  .wb-datasource-guide b { width: 64px; }
}
/* ---- 关键词分层分析块（T5） ----
   放在汇总条与筛选栏之间：三个总览数字 → 四个结论桶 → 两张 Top 5 表。
   刻意不加彩色底：结论靠文字与数字读，颜色只用来区分"风险/机会"两种表头语气。 */
.wb-kw-analysis { display: flex; flex-direction: column; gap: var(--wb-sp-4); margin-bottom: var(--wb-sp-5); padding: var(--wb-sp-5); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-layer-1); }
.wb-kw-analysis-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-kw-analysis-head h5 { margin: 0; color: var(--wb-label-primary); font-size: var(--wb-fs-2); font-weight: 600; }
.wb-kw-analysis-head span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); font-variant-numeric: tabular-nums; }
.wb-kw-analysis-head b { color: var(--wb-label-primary); font-weight: 600; }
.wb-kw-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--wb-sp-1); border: 1px solid var(--wb-border-l1); background: var(--wb-border-l1); }
.wb-kw-overview-item { display: flex; flex-direction: column; gap: var(--wb-sp-1); min-width: 0; padding: var(--wb-sp-3) var(--wb-sp-4); background: var(--wb-bg-layer-1); }
.wb-kw-overview-item span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-kw-overview-item strong { color: var(--wb-label-primary); font-size: var(--wb-fs-3); font-variant-numeric: tabular-nums; }
.wb-kw-buckets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--wb-sp-2); }
.wb-kw-bucket { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); }
.wb-kw-bucket b { display: flex; align-items: baseline; justify-content: space-between; gap: var(--wb-sp-2); color: var(--wb-label-primary); font-size: var(--wb-fs-2); font-weight: 600; }
.wb-kw-bucket-count { color: var(--wb-label-primary); font-size: var(--wb-fs-3); font-variant-numeric: tabular-nums; }
.wb-kw-bucket > span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); font-variant-numeric: tabular-nums; }
.wb-kw-bucket.is-negative { border-color: color-mix(in srgb, var(--wb-label-primary) 28%, var(--wb-border-l1)); }
.wb-kw-bucket.is-add { border-color: color-mix(in srgb, var(--wb-state-business-primary) 40%, transparent); }
.wb-kw-bucket.is-add b, .wb-kw-bucket.is-add .wb-kw-bucket-count { color: var(--wb-state-business-primary); }
.wb-kw-bucket.is-none { border-style: dashed; }
.wb-kw-tops { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: var(--wb-sp-4); }
.wb-kw-top { min-width: 0; }
.wb-kw-top h6 { margin: 0 0 var(--wb-sp-2); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); font-weight: 600; }
.wb-kw-top table { width: 100%; border-collapse: collapse; font-size: var(--wb-fs-1); font-variant-numeric: tabular-nums; }
.wb-kw-top th { padding: var(--wb-sp-1) var(--wb-sp-2); border-bottom: 1px solid var(--wb-border-l1); color: var(--wb-label-secondary); font-weight: 500; text-align: right; }
.wb-kw-top td { padding: var(--wb-sp-2); border-bottom: 1px solid var(--wb-border-l1); color: var(--wb-label-primary); text-align: right; }
.wb-kw-top tr:last-child td { border-bottom: none; }
.wb-kw-top th.text, .wb-kw-top td.text { text-align: left; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-kw-empty { margin: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-searchterm-block { display: flex; flex-direction: column; gap: var(--wb-sp-4); margin-bottom: var(--wb-sp-5); }
.wb-current-keyword { display: inline-flex; align-items: center; gap: var(--wb-sp-2); margin-left: var(--wb-sp-2); }
.wb-keyword-link { padding: 0; border: none; background: none; color: var(--wb-state-business-primary); font: inherit; text-align: left; cursor: pointer; }
.wb-keyword-link:hover { text-decoration: underline; }
.wb-kw-decision { display: inline-block; padding: 1px var(--wb-sp-2); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); white-space: nowrap; }
.wb-kw-decision.is-negative { color: var(--wb-label-primary); border-color: color-mix(in srgb, var(--wb-label-primary) 28%, var(--wb-border-l1)); }
.wb-kw-decision.is-add { color: var(--wb-state-business-primary); border-color: color-mix(in srgb, var(--wb-state-business-primary) 40%, transparent); }
.wb-amazon-table tr.is-current-keyword td { background: color-mix(in srgb, var(--wb-state-business-primary) 8%, transparent); }
.wb-kw-footnote { margin: 0; padding-top: var(--wb-sp-3); border-top: 1px solid var(--wb-border-l1); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
@container wb-calc (max-width: 560px) {
  .wb-kw-buckets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/* ---- AI 报表结论（T4） ----
   证据等级与本地口径分开显示：这块是 agent 写回的（可能引用市场证据），
   上面那块是本地规则算的（可复算）。待分析态用虚线，表示"还没有结论"而不是"没有数据"。 */
.wb-ai-summary { display: flex; flex-direction: column; gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-5); padding: var(--wb-sp-5); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-layer-1); }
.wb-ai-summary.is-pending { border-style: dashed; }
.wb-ai-summary-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-ai-summary-head h5 { margin: 0; color: var(--wb-label-primary); font-size: var(--wb-fs-2); font-weight: 600; }
.wb-ai-summary-state { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-ai-summary-evidence { padding: 2px var(--wb-sp-2); border: 1px solid var(--wb-border-l1); border-radius: 999px; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-ai-summary-pending { margin: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); line-height: 1.6; }
.wb-ai-summary-line { margin: 0; color: var(--wb-label-primary); font-size: var(--wb-fs-1); font-variant-numeric: tabular-nums; }
.wb-ai-summary-tops { display: flex; flex-direction: column; gap: 2px; }
.wb-ai-summary-tops p { margin: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); line-height: 1.6; }
.wb-ai-summary-tops b { margin-right: var(--wb-sp-2); color: var(--wb-label-primary); font-weight: 600; }
.wb-ai-summary-notes { margin: 0; padding-left: 18px; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); line-height: 1.6; }
.wb-ai-summary-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--wb-sp-3); flex-wrap: wrap; padding-top: var(--wb-sp-2); }
.wb-ai-summary-actions span { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
/* ---- 测算方案库与多方案对比（v1.23） ----
   列表行是「勾选框 + 名称/副标题 + 两个操作」三段式：勾选框必须独立可点，
   所以它是一整个 label，而不是套在行 onClick 里（否则点按钮也会误切换对比）。 */
.wb-calc-scenarios { display: flex; flex-direction: column; gap: var(--wb-sp-4); margin-top: var(--wb-sp-7); padding-top: var(--wb-sp-6); border-top: 1px solid var(--wb-border-l1); }
.wb-calc-scenario-head { display: flex; align-items: center; justify-content: space-between; gap: var(--wb-sp-4); flex-wrap: wrap; }
.wb-calc-scenario-save { display: flex; align-items: center; gap: var(--wb-sp-2); flex-wrap: wrap; }
.wb-calc-scenario-name { width: 220px; height: 32px; padding: 0 var(--wb-sp-3); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; font-size: var(--wb-fs-1); }
.wb-calc-scenario-note { width: 200px; height: 32px; padding: 0 var(--wb-sp-3); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; font-size: var(--wb-fs-1); }
.wb-calc-scenario-list { display: flex; flex-direction: column; gap: var(--wb-sp-2); margin: 0; padding: 0; list-style: none; }
.wb-calc-scenario-item { display: flex; align-items: center; gap: var(--wb-sp-3); padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); }
.wb-calc-scenario-item.on { border-color: color-mix(in srgb, var(--wb-state-business-primary) 46%, transparent); background: color-mix(in srgb, var(--wb-state-business-primary) 8%, transparent); }
.wb-calc-scenario-pick { display: inline-flex; align-items: center; flex: none; cursor: pointer; }
.wb-calc-scenario-pick input { accent-color: var(--wb-state-business-primary); width: 15px; height: 15px; margin: 0; cursor: pointer; }
.wb-calc-scenario-meta { display: flex; flex-direction: column; gap: 2px; flex: 1 1 200px; min-width: 0; }
.wb-calc-scenario-meta b { color: var(--wb-label-primary); font-size: var(--wb-fs-2); }
.wb-calc-scenario-meta small { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-calc-scenario-actions { display: flex; align-items: center; gap: var(--wb-sp-2); flex: none; }
.wb-calc-compare { display: flex; flex-direction: column; gap: var(--wb-sp-3); margin-top: var(--wb-sp-3); }
.wb-calc-compare-head { display: flex; align-items: center; justify-content: space-between; gap: var(--wb-sp-3); }
.wb-calc-compare-head h4 { margin: 0; color: var(--wb-label-primary); font-size: var(--wb-fs-3); }
/* 「优」标记：小、克制，不抢数字本身的注意力 */
.wb-calc-best { display: inline-block; margin-left: var(--wb-sp-2); padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--wb-state-business-primary) 18%, transparent); color: var(--wb-state-business-primary); font-size: 10px; line-height: 1.6; }
.wb-amazon-table td.is-best { color: var(--wb-label-primary); font-weight: 600; }
.wb-calc-diff { white-space: normal !important; min-width: 180px; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); line-height: 1.5; }
/**
 * 对比表在窄面板必须能**看全所有方案列**（v1.29，截图实测发现的问题）。
 *
 * 原来沿用 .wb-amazon-table 的 min-width: 680px：窄屏下第三、四份方案被推到屏幕外，
 * 只剩一条细滚动条 —— 用户根本不知道右边还有列。对比表列数上限只有 5（指标 + 4 方案），
 * 数字又短（39.99 这种），所以这里允许它缩到容器宽度：固定表格布局 + 小一号字，
 * 而不是让用户横向滚动去拼数据。
 */
@container wb-calc (max-width: 656px) {
  .wb-calc-compare .wb-amazon-table { min-width: 0; width: 100%; table-layout: fixed; font-size: 11px; }
  .wb-calc-compare .wb-amazon-table th,
  .wb-calc-compare .wb-amazon-table td { padding: var(--wb-sp-2) var(--wb-sp-2); white-space: normal; word-break: break-word; }
  .wb-calc-compare .wb-amazon-table th:first-child,
  .wb-calc-compare .wb-amazon-table td:first-child { width: 30%; }
  .wb-calc-compare .wb-amazon-table .wb-calc-diff { min-width: 0; font-size: 10px; }
  .wb-calc-compare .wb-calc-best { margin-left: 2px; padding: 0 3px; font-size: 9px; }
  .wb-calc-compare .wb-amazon-table-wrap { overflow-x: hidden; }
}
@media (max-width: 720px) {
  .wb-calc-scenario-save { width: 100%; }
  .wb-calc-scenario-name, .wb-calc-scenario-note { flex: 1 1 140px; width: auto; }
  .wb-calc-scenario-item { flex-wrap: wrap; }
  .wb-calc-scenario-actions { flex: 1 1 100%; justify-content: flex-end; }
}
/* ---- 包装/外箱尺寸记录 ----
   保存表单是「名称 / SKU / 按钮」三列：标签在上、输入对齐到底线，按钮跟着输入框底边
   （align-items: end），而不是被撑到与两行文字等高后再居中。
   搜索框只占左侧固定宽度，状态文字跟在后面 —— 宽度 100% 的输入会把整行挤成两行。 */
.wb-pkg-records { display: flex; flex-direction: column; gap: var(--wb-sp-4); margin-top: var(--wb-sp-7); padding-top: var(--wb-sp-6); border-top: 1px solid var(--wb-border-l1); }
.wb-pkg-records-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--wb-sp-4); flex-wrap: wrap; }
.wb-pkg-records-head > div { display: flex; flex-direction: column; gap: var(--wb-sp-1); min-width: 0; }
.wb-pkg-records-head .wb-btn { flex: none; }
.wb-pkg-records-form { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; align-items: end; gap: var(--wb-sp-3); padding: var(--wb-sp-4); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); }
.wb-pkg-records-field { display: flex; flex-direction: column; gap: var(--wb-sp-2); min-width: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-pkg-records-field > span { display: flex; align-items: baseline; gap: var(--wb-sp-2); }
.wb-pkg-records-field small { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); font-weight: 400; }
.wb-pkg-records-field input { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: 0 var(--wb-sp-3); color: var(--wb-label-primary); background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; font-size: var(--wb-fs-2); }
.wb-pkg-records-form .wb-btn { height: 34px; }
.wb-pkg-records-tools { display: flex; align-items: center; gap: var(--wb-sp-3); flex-wrap: wrap; }
.wb-pkg-records-search { box-sizing: border-box; flex: 0 1 260px; min-width: 0; height: 32px; padding: 0 var(--wb-sp-3); color: var(--wb-label-primary); background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; font-size: var(--wb-fs-1); }
.wb-pkg-records-status { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); overflow-wrap: anywhere; }
@container wb-calc (max-width: 560px) {
  .wb-pkg-records-form { grid-template-columns: minmax(0, 1fr); }
  .wb-pkg-records-form .wb-btn { width: 100%; }
  .wb-pkg-records-search { flex: 1 1 100%; }
}
/* ---- 搜索词：右侧结果区（v1.19，结果与左栏导入分开） ---- */
.wb-amazon-result-pane { display: flex; flex-direction: column; gap: var(--wb-sp-5); min-width: 0; container-type: inline-size; container-name: wb-calc; }
.wb-amazon-result-head-bar { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--wb-sp-5); flex-wrap: wrap; }
.wb-amazon-result-head-bar h4 { margin: 0 0 var(--wb-sp-1); color: var(--wb-label-primary); font-size: var(--wb-fs-4); }
.wb-amazon-result-head-bar p { margin: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-result-head-actions { display: flex; flex: none; gap: var(--wb-sp-3); flex-wrap: wrap; }
/* ---- 搜索词：筛选/排序工具条（v1.22） ----
   两段式：上面是"看哪一片"（预设 + 角标），下面是"怎么排/怎么找"。
   不放同一条 flex 里 —— 8 个控件挤一行会让窄屏出现横向溢出。 */
.wb-traffic-bar { display: flex; flex-direction: column; gap: var(--wb-sp-3); padding: var(--wb-sp-4) var(--wb-sp-5); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: color-mix(in srgb, var(--wb-label-primary) 3%, transparent); }
.wb-traffic-presets { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2); }
.wb-traffic-preset { display: inline-flex; align-items: center; gap: var(--wb-sp-2); height: 28px; padding: 0 var(--wb-sp-3); border: 1px solid var(--wb-border-l1); border-radius: 999px; background: transparent; color: var(--wb-label-secondary); font: inherit; font-size: var(--wb-fs-1); cursor: pointer; }
.wb-traffic-preset:hover { color: var(--wb-label-primary); }
.wb-traffic-preset.on { color: var(--wb-label-primary); font-weight: 600; border-color: color-mix(in srgb, var(--wb-state-business-primary) 52%, transparent); background: color-mix(in srgb, var(--wb-state-business-primary) 12%, transparent); }
.wb-traffic-preset-count { font-variant-numeric: tabular-nums; opacity: .75; }
.wb-traffic-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wb-sp-3); }
.wb-traffic-search { flex: 1 1 180px; min-width: 140px; height: 30px; padding: 0 var(--wb-sp-3); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; font-size: var(--wb-fs-1); }
.wb-traffic-threshold { display: inline-flex; align-items: center; gap: var(--wb-sp-2); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); white-space: nowrap; }
.wb-traffic-threshold input { width: 64px; height: 30px; padding: 0 var(--wb-sp-2); color: inherit; background: var(--wb-bg-base); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); font: inherit; font-size: var(--wb-fs-1); text-align: right; }
.wb-traffic-slice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--wb-sp-2); margin: 0; color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-traffic-slice b { color: var(--wb-label-primary); font-variant-numeric: tabular-nums; }
.wb-traffic-copy-note { margin-left: auto; color: var(--wb-state-business-primary); }
.wb-traffic-search:focus-visible, .wb-traffic-threshold input:focus-visible, .wb-traffic-preset:focus-visible { outline: 2px solid var(--wb-state-business-primary); outline-offset: 2px; }
@media (max-width: 720px) {
  .wb-traffic-controls > * { flex: 1 1 auto; }
  .wb-traffic-threshold { flex: 0 1 auto; }
  .wb-traffic-copy-note { margin-left: 0; }
}

.wb-amazon-dataset-list { display: flex; flex-direction: column; gap: var(--wb-sp-2); margin-top: var(--wb-sp-6); }
.wb-amazon-dataset-item { display: flex; flex-direction: column; gap: var(--wb-sp-1); padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-1); background: transparent; color: var(--wb-label-primary); font: inherit; font-size: var(--wb-fs-1); text-align: left; cursor: pointer; }
.wb-amazon-dataset-item small { color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-dataset-item.on { border-color: color-mix(in srgb, var(--wb-state-business-primary) 42%, transparent); background: color-mix(in srgb, var(--wb-state-business-primary) 8%, transparent); }
/* 2026-10-29：数据集行改成「主按钮 + 在表格里打开」，容器本身不再是按钮
   （按钮里再套按钮会让键盘焦点与读屏混乱）。 */
.wb-amazon-dataset-item { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--wb-sp-3); cursor: default; }
.wb-amazon-dataset-pick { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: var(--wb-sp-1); padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: var(--wb-fs-1); text-align: left; cursor: pointer; }
.wb-amazon-sop { margin: var(--wb-sp-6) var(--wb-sp-7); padding: var(--wb-sp-5) var(--wb-sp-6); border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); }
.wb-amazon-sop summary { cursor: pointer; color: var(--wb-label-primary); font-weight: 600; }
.wb-amazon-sop summary span { margin-right: var(--wb-sp-3); color: var(--wb-label-secondary); font-family: ui-monospace, monospace; font-size: var(--wb-fs-1); }
.wb-amazon-sop p { line-height: 1.6; }
.wb-amazon-sop-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--wb-sp-5) var(--wb-sp-7); }
.wb-amazon-sop-grid ul, .wb-amazon-sop-grid ol { margin: var(--wb-sp-2) 0 0; padding-left: var(--wb-sp-6); line-height: 1.6; }
.wb-amazon-calibration-note { margin: 0 0 var(--wb-sp-5); padding: var(--wb-sp-4) var(--wb-sp-5); border: 1px solid color-mix(in srgb, var(--wb-state-business-primary) 34%, transparent); border-radius: var(--wb-r-2); background: color-mix(in srgb, var(--wb-state-business-primary) 9%, transparent); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); line-height: 1.6; }
.wb-amazon-calibration-note b { color: var(--wb-label-primary); }
.wb-amazon-note { padding: var(--wb-sp-3) var(--wb-sp-4); border: 1px solid color-mix(in srgb, var(--wb-state-business-primary) 34%, transparent); border-radius: var(--wb-r-2); background: color-mix(in srgb, var(--wb-state-business-primary) 9%, transparent); color: var(--wb-label-secondary); font-size: var(--wb-fs-1); line-height: 1.55; }
.wb-amazon-note b { color: var(--wb-label-primary); }
.wb-amazon-sop-skills { border-top: 1px solid var(--wb-border-l1); padding-top: var(--wb-sp-3); }
@media (max-width: 720px) { .wb-amazon-sop { margin: var(--wb-sp-5) var(--wb-sp-5); } .wb-amazon-sop-grid { grid-template-columns: 1fr; } }

/* 广告报表分析（P1）：三类报表共用一套指标表 + 建议清单。
   数字列 tabular-nums 右对齐；理由列限宽换行，避免把表格撑成横向滚动。 */
.wb-report { padding: var(--wb-sp-2) 0 var(--wb-sp-6); }
.wb-report-tabs { display: flex; gap: var(--wb-sp-1); margin: var(--wb-sp-3) 0 var(--wb-sp-5); border-bottom: 1px solid var(--wb-border-l1); }
.wb-report-tab { border: none; background: transparent; color: var(--wb-label-secondary); font: inherit; font-size: var(--wb-fs-2); font-weight: 600; padding: var(--wb-sp-2) var(--wb-sp-4); border-top-left-radius: var(--wb-r-2); border-top-right-radius: var(--wb-r-2); cursor: pointer; }
.wb-report-tab:hover { color: var(--wb-label-primary); background: color-mix(in srgb, var(--wb-label-primary) 6%, transparent); }
.wb-report-tab.on { color: var(--wb-label-primary); box-shadow: var(--wb-underline); }
.wb-report-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--wb-sp-3); margin: var(--wb-sp-3) 0; }
.wb-report-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-layer-1, transparent); color: var(--wb-label-primary); font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; padding: var(--wb-sp-3); resize: vertical; }
.wb-report-status { border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); padding: var(--wb-sp-3) var(--wb-sp-4); margin-bottom: var(--wb-sp-4); font-size: var(--wb-fs-1); line-height: 1.6; }
.wb-report-status.is-ok { border-color: color-mix(in srgb, var(--wb-ok) 45%, var(--wb-border-l1)); }
.wb-report-status.is-warn { border-color: color-mix(in srgb, var(--wb-warn-ink) 45%, var(--wb-border-l1)); }
.wb-report-status.is-error { border-color: color-mix(in srgb, var(--wb-danger-ink) 55%, var(--wb-border-l1)); color: var(--wb-label-primary); }
.wb-report-rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--wb-sp-4); }
.wb-report-rules label { display: flex; align-items: center; gap: var(--wb-sp-2); font-size: var(--wb-fs-1); color: var(--wb-label-secondary); flex-wrap: wrap; }
.wb-report-rules input { width: 84px; border: 1px solid var(--wb-border-l1); border-radius: var(--wb-r-2); background: var(--wb-bg-layer-1, transparent); color: var(--wb-label-primary); font: inherit; padding: 4px 8px; font-variant-numeric: tabular-nums; }
.wb-report-quadrants { display: flex; flex-wrap: wrap; gap: var(--wb-sp-2); margin-bottom: var(--wb-sp-3); }
.wb-report-tablewrap { overflow-x: auto; }
.wb-report-table { width: 100%; border-collapse: collapse; font-size: var(--wb-fs-1); }
.wb-report-table th, .wb-report-table td { text-align: left; padding: var(--wb-sp-2) var(--wb-sp-3); border-bottom: 1px solid var(--wb-border-l1); vertical-align: top; }
.wb-report-table th { color: var(--wb-label-secondary); font-weight: 600; white-space: nowrap; }
.wb-report-table td.is-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.wb-report-table td.is-reason { min-width: 240px; }
/* 负库存在库存看板里必须一眼看见（数字本身保留，颜色只做强调） */
.wb-report-table td.is-negative { color: var(--wb-danger-ink); font-weight: 700; }
.wb-report-prio { display: inline-block; padding: 0 6px; border-radius: var(--wb-r-1); font-size: 11px; font-weight: 700; }
.wb-report-prio.p1 { color: #fff; background: var(--wb-prio-p1-bg); }
.wb-report-prio.p2 { color: #fff; background: var(--wb-prio-p2-bg); }
.wb-report-prio.p3 { color: var(--wb-label-secondary); background: color-mix(in srgb, var(--wb-label-secondary) 18%, transparent); }
@media (max-width: 720px) { .wb-report-table td.is-reason { min-width: 160px; } }
`

export const WORKBENCH_CSS = `${tokenLayerCss()}\n${toWorkbenchTokens(RAW_CSS)}\n${toWorkbenchTokens(AMAZON_CSS)}`