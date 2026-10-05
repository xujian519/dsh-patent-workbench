/**
 * 「把本地文件交给系统默认程序打开」的**唯一判定处**（宿主与客户端共用）。
 *
 * ## 为什么必须有这个文件
 *
 * `POST /api/workbench/knowledge/open-file` 是全仓唯一把用户可控路径交给本机程序的入口，
 * 而它的入参（知识条目的 `fileLink`）能由模型知识草稿、导入数据、案卷事件日志写入。
 * 原来的判据只有 `stat().isFile()` —— 而 `.command` / `.sh` / `.bat` / `.exe` / `.lnk`
 * **都是普通文件**，所以"点开一条知识里的文档链接"实际等价于"执行本机任意程序"。
 *
 * 更关键的是客户端有**两条腿**：优先走宿主原生 `workspaces.openPath`，失败才回退到
 * 上面那条路由（`index.tsx` 的 `openKnowledgeFile`）。判定若只在路由里做，
 * 在装得全的机器上原生那条腿会**完全绕过**它 —— 于是判定做成这个共用纯模块，
 * 两条腿都必须先问它（`test/openableFile.test.mjs` 钉住两侧都引用）。
 *
 * ## 为什么是白名单，而不是"拉黑可执行扩展名"
 *
 * 黑名单永远追不上平台的新花样（`.command` `.workflow` `.terminal` `.appref-ms`
 * `.jse` `.wsf` `.scf` `.gadget`…），漏一个就等于没做。反过来，
 * "能放心交给默认程序打开"的东西是一个**封闭且稳定**的集合：文档 / 表格 / 演示 /
 * 图片 / 音视频 / 压缩包 / 电子书。
 *
 * 不在集合里的一律**降级为「在文件管理器中定位」** —— 功能不丢（用户仍可从那里打开，
 * 甚至双击），但"点一下链接就执行了程序"这条路被堵死。降级是**默认**，
 * 所以新出现的扩展名自动是安全的（fail-closed），不需要维护者记得加黑名单。
 *
 * ## 只看最后一段扩展名（有意如此）
 *
 * 三个平台的默认程序关联都只认最后一段，所以判据跟着它们走：
 * `report.md.command` → `command` → 降级（这正是要挡的形态）；
 * `report.command.md` → `md` → 打开（系统也确实按 Markdown 打开它，
 * 纯文本不构成执行）。命名陷阱因此不可能骗过判定。
 *
 * ## 边界：不 import `node:*`、不读 `process`
 *
 * 与 `shared/hostPath.ts` 同一条纪律：客户端 bundle 也依赖本模块
 * （`client/index.tsx` → 打包），所以只做纯字符串处理，平台无关。
 */

/**
 * 可以直接交给系统默认程序打开的扩展名（小写、不含点）。
 *
 * 想放行新类型时**只在这里加一条**，不要在调用点另写判断
 * （"同一个语义两处实现" 是本仓的头号 bug 类别）。
 */
export const OPENABLE_EXTENSIONS: readonly string[] = [
  // 文档 / 纯文本（含本仓最常出现的 .md）
  'pdf', 'txt', 'md', 'markdown', 'rst', 'log', 'rtf', 'tex', 'diff', 'patch',
  'doc', 'docx', 'odt', 'wps',
  // 表格 / 结构化数据
  'csv', 'tsv', 'xls', 'xlsx', 'ods', 'et',
  'json', 'jsonl', 'ndjson', 'xml', 'yml', 'yaml', 'toml', 'ini',
  // 演示
  'ppt', 'pptx', 'odp', 'dps',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'ico', 'heic', 'avif',
  // 音视频
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v',
  // 压缩 / 归档（是数据，不是可执行体）
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  // 电子书
  'epub', 'mobi', 'azw3',
  // 网页（在浏览器里打开，与用户自己双击等价；`.hta` 不在其中）
  'html', 'htm',
]

const OPENABLE = new Set(OPENABLE_EXTENSIONS)

/** 传输给宿主/客户端的行为：交给默认程序打开，还是在文件管理器中定位。 */
export type OpenMode = 'open' | 'reveal'

/** 降级原因（客户端据此给用户可读提示，不猜）。 */
export type RevealReason = 'no-extension' | 'not-openable'

export type OpenDecision =
  | { mode: 'open'; extension: string }
  | { mode: 'reveal'; extension: string; reason: RevealReason }

/**
 * 取**最后一段**扩展名（小写、不含点）；没有扩展名时返回空串。
 *
 * 与 `node:path.extname` 同口径：点文件（`.env`）没有扩展名，
 * 结尾点（`report.`）也没有。两种形态都会走"降级定位"，不会被误放行。
 */
export function fileExtension(path: string): string {
  const clean = String(path ?? '').replace(/\\/g, '/')
  const base = clean.slice(clean.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // dot < 0：没有点；dot === 0：以 `.` 开头的点文件（`.env` / `..`）—— 都不算扩展名。
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 判定一个本地路径应当「交给默认程序打开」还是「在文件管理器中定位」。 */
export function decideOpenMode(path: string): OpenDecision {
  const extension = fileExtension(path)
  if (extension === '') return { mode: 'reveal', extension, reason: 'no-extension' }
  if (!OPENABLE.has(extension)) return { mode: 'reveal', extension, reason: 'not-openable' }
  return { mode: 'open', extension }
}

/** 该路径是否是「可直接打开」的文档类文件（客户端原生那条腿用的就是它）。 */
export function isOpenableDocument(path: string): boolean {
  return decideOpenMode(path).mode === 'open'
}
