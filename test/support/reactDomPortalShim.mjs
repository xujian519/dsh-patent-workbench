/**
 * 冒烟测试用的 `react-dom` 替身：**只**把 `createPortal` 换成"就地渲染 children"。
 *
 * ## 为什么需要它（2026-10-05，审计 §4.1）
 *
 * 本仓 37 个客户端模块从不被任何测试加载 —— 而其中 11 个弹窗、`Modal` / `Toast` /
 * `ModelPicker` / `TagFilter` / `LocalDocModal` 都是**靠 portal 挂到 `document.body`** 的。
 * 服务端渲染器遇到 portal 会直接抛：
 *
 * ```text
 * Target container is not a DOM element.   ← createPortal 自己的容器校验
 * ```
 *
 * 本机没有 jsdom / happy-dom（也没人愿意为一个冒烟测试引入 DOM 实现），于是：
 * **把它就地渲染**。冒烟测试要的只是"这段真实代码被执行过一次、并且真的产出了 HTML"，
 * 而不是"portal 挂到了哪个节点"（那件事由 `Modal.tsx` 自己的注释与实机走查负责）。
 *
 * ## 口径（别把它当成 portal 的替代品）
 *
 * - 只影响**冒烟测试这一个进程**：由 `test/support/portalShim.loader.mjs` 在测试文件
 *   顶部 `register()`，`react-dom/server` 与其它测试文件都不受影响。
 * - 只替 `createPortal` 一个导出（全仓客户端就只 import 了它）。
 * - **不改变事件/焦点/锁滚动这些行为** —— 那些在服务端渲染里本来就不执行。
 */

/** 原地返回 children：让 portal 的内容进入本次 `renderToStaticMarkup` 的输出。 */
export function createPortal(children) {
  return children
}
