/**
 * 视图切换的过渡（2026-11-01 用户要求：亮块移动到目标、列表淡出、内容淡入）。
 *
 * ## 为什么用 View Transitions 而不是自己写 FLIP
 * 用户要的是"**同一个亮块**从第 3 条移到第 7 条、右侧内容旧的一份淡出新的淡入"。
 * 自己写就是测量 → 记住旧位置 → 切完再测 → 补间，四步里任何一步错位都会闪。
 * 浏览器原生的 `document.startViewTransition(cb)` 正是干这件事：回调里改 DOM，
 * 它负责把"旧快照"与"新快照"补间，并且对声明了 `view-transition-name` 的元素做**共享元素变形**。
 * 我们只需要在样式里给"选中的那条"和"右侧内容区"各起一个名字（见 styles.ts）。
 *
 * ## 边界
 * - **不支持就当它不存在**：老浏览器 / 单测环境没有这个 API，直接同步执行，行为与以前一致；
 * - **尊重减少动效**：`prefers-reduced-motion: reduce` 时同样同步执行（不给前庭不适的人放动画）；
 * - **回调必须同步改完 DOM**：调用方要用 `flushSync` 包住 React 的 setState，
 *   否则 React 在回调返回后才提交，浏览器拍到的"新快照"还是旧的（表现为闪一下）。
 *   这一步交给调用方，本模块不 import react-dom —— 这样它可以被 node 单测直接覆盖。
 */

/** 只取我们用到的那一个方法，避免依赖 lib.dom 里可能还没装的类型。 */
interface TransitionCapableDocument {
  startViewTransition?: (callback: () => void) => unknown
}

export interface ViewTransitionEnv {
  /** 提供 document 的对象（默认 globalThis）；没有 document 视为不支持。 */
  document?: TransitionCapableDocument
  /** 是否处于"减少动效"偏好；未提供时读 matchMedia。 */
  reducedMotion?: boolean
}

function detectEnv(): ViewTransitionEnv {
  const scope = globalThis as unknown as { document?: TransitionCapableDocument; matchMedia?: (q: string) => { matches: boolean } }
  let reducedMotion = false
  try {
    reducedMotion = scope.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    reducedMotion = false
  }
  return { document: scope.document, reducedMotion }
}

/**
 * 在过渡里执行一次 DOM 更新。
 *
 * @returns `true` 表示走了原生过渡；`false` 表示同步执行（不支持 / 减少动效 / 过渡启动失败）。
 *          返回值只用于测试与调用方埋点，业务逻辑不依赖它。
 */
export function withViewTransition(run: () => void, env: ViewTransitionEnv = detectEnv()): boolean {
  const start = env.document?.startViewTransition
  if (typeof start !== 'function' || env.reducedMotion === true) {
    run()
    return false
  }
  try {
    start.call(env.document, run)
    return true
  } catch {
    /** 过渡启动失败（例如上一次过渡还没结束）：宁可没有动画，也不能吞掉这次更新。 */
    run()
    return false
  }
}
