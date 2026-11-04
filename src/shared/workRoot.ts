/**
 * 案卷工作根（对齐 sibling 仓库 dsh-patent 的 ADR-001，2026-11-04 Accepted）。
 *
 * 案卷正文在这个根下面的文件夹里。工作台 SQLite 只存索引和 `workspace_path`，
 * 不存交底书 / 说明书等正文。
 *
 * ## 默认可移植，例子不写死
 *
 * 默认语义是「当前用户主目录下的 `工作`」（`~/工作`）。作者机器上展开后是
 * `/Users/xujian/工作` —— 那是**例子**（`WORK_ROOT_EXAMPLE`），不是运行时唯一默认值。
 * 换一台机器仍用 `~/工作`；要改根，设环境变量 `DSH_WORK_ROOT`（绝对路径或以 `~` 开头）。
 *
 * 本模块是这条默认值的**唯一出处**：扫描预填、省略 root 时的服务端回退、bootstrap
 * 下发给界面的值，都从 `configuredWorkRoot` 来。
 */

/** 覆盖默认工作根的环境变量名。 */
export const WORK_ROOT_ENV = 'DSH_WORK_ROOT'

/** 可移植默认值。服务端会展开开头的 `~`。 */
export const DEFAULT_WORK_ROOT = '~/工作'

/**
 * 文档与报错里的绝对路径例子。
 * 不要把它当成扫描默认值：那会把其他用户的主目录钉死成 `/Users/xujian`。
 */
export const WORK_ROOT_EXAMPLE = '/Users/xujian/工作'

/** 本次进程该用的工作根：环境变量优先，否则 `DEFAULT_WORK_ROOT`。不展开 `~`（展开在扫描入口）。 */
export function configuredWorkRoot(env: NodeJS.ProcessEnv): string {
  const raw = env[WORK_ROOT_ENV]
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return DEFAULT_WORK_ROOT
}
