/**
 * 宿主路径归一化的**唯一实现**（服务端与客户端共用）。
 *
 * ## 为什么必须有这个文件
 *
 * 同一套「WSL ↔ Windows 盘符」转换曾在 5 处各写一遍：
 * `api/routes/helpers.ts`、`api/localDirRoute.ts`、`api/openFileRoute.ts`（三份逐字相同），
 * 以及 `workspace-check.ts`、`client/workspacePath.ts`。
 * 一处规则修正必然漏掉其余 —— `helpers.ts` 的注释记录过一次同源事故：
 * WSL 下 `node:path.join` 拼出的 `D:\...` 被直接 `mkdirSync`，
 * 在当前目录建出一个名叫 `D:\DSHWorkspace` 的单层目录。
 *
 * ## 边界：为什么不 import `node:*`、也不读 `process`
 *
 * 客户端（tsdown 从 `client/index.tsx` 起打包）也依赖本模块，因此：
 * - 不使用任何 `node:` 内置模块（`file://` 解析只用全局 `URL` 与 `decodeURIComponent`）；
 * - **不引用 `process`** —— 平台由调用方显式传入，服务端的包装函数再补默认值。
 *
 * ## 一个有意保留的差异
 *
 * `workspace-check.ts` 的 `windowsToWsl` 要求**必须带分隔符**（裸 `D:` / `C:relative`
 * 原样返回），因为它用它做**文件系统探测**：把 `C:relative` 当成 `/mnt/c/relative`
 * 会探到错误目录。这里导出 `isWindowsDrivePath` 供它保留那条前置判断。
 */

/** 盘符 + 可选分隔符 + 余下部分：`D:` / `D:\` / `D:/Code` 都能匹配。 */
const WINDOWS_DRIVE_RE = /^([A-Za-z]):(?:[\\/](.*))?$/

/** 必须带分隔符的盘符前缀：`D:\` / `D:/`（裸 `D:` 不算）。 */
const WINDOWS_DRIVE_WITH_SEPARATOR_RE = /^[A-Za-z]:[\\/]/

/** WSL 挂载点前缀：`/mnt/d` 或 `/mnt/d/...`。 */
const WSL_MOUNT_RE = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/

/** `D:\Code` / `D:/Code` → `/mnt/d/Code`。非盘符路径原样返回。 */
export function windowsDriveToWsl(input: string): string {
  const match = WINDOWS_DRIVE_RE.exec(input)
  if (match === null) return input
  const drive = match[1].toLowerCase()
  const rest = (match[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  return rest === '' ? `/mnt/${drive}` : `/mnt/${drive}/${rest}`
}

/** `/mnt/d/code` → `D:\code`。非 WSL 挂载点路径原样返回。 */
export function wslDriveToWindows(input: string): string {
  const match = WSL_MOUNT_RE.exec(input)
  if (match === null) return input
  const drive = match[1].toUpperCase()
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return rest === '' ? `${drive}:\\` : `${drive}:\\${rest}`
}

/** 是否形如 `D:\foo` / `D:/foo`（**必须带分隔符**；裸 `D:` 为 false）。 */
export function isWindowsDrivePath(input: string): boolean {
  return WINDOWS_DRIVE_WITH_SEPARATOR_RE.test(input)
}

/** 把 `file://` URL 或绝对路径转成服务器本地文件路径。 */
export function fileLinkToPath(link: string): string {
  const trimmed = link.trim()
  if (/^file:/i.test(trimmed)) {
    const url = new URL(trimmed)
    if (url.protocol !== 'file:') throw new Error('not a file URL')
    let pathname = decodeURIComponent(url.pathname)
    // file:///D:/... 在 URL.pathname 中会是 /D:/...，去掉盘符前多余的斜杠。
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1)
    return pathname
  }
  return trimmed
}

/**
 * `file://` 解析 + 按宿主平台归一化（非 Windows 下 `D:\Code` → `/mnt/d/Code`）。
 *
 * @param platform - 宿主平台。**必传**（服务端包装函数补 `process.platform`）。
 */
export function toNativePath(link: string, platform: string): string {
  const path = fileLinkToPath(link)
  if (platform === 'win32') return path
  return isWindowsDrivePath(path) ? windowsDriveToWsl(path) : path
}
