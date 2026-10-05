/**
 * 载入器：把 `react-dom` 解析到 `reactDomPortalShim.mjs`（只为冒烟测试）。
 *
 * 为什么用载入器而不是"改源码/加依赖"：
 * - 被测模块是**构建产物** `lib/client/**.js`（`import { createPortal } from 'react-dom'`），
 *   改不了 import 语句；
 * - 加 jsdom 是给一个冒烟测试引一个依赖树，不划算；
 * - 载入器只在**注册它的那个测试进程**里生效，其它测试与产品代码零影响。
 */
export async function resolve(specifier, context, next) {
  if (specifier === 'react-dom') {
    return { url: new URL('./reactDomPortalShim.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
