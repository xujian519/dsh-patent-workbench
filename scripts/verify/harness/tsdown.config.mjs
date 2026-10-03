/**
 * H4 视图拆分的真浏览器验证脚手架专用构建配置（**独立于 `tsdown.config.ts`**）。
 *
 * 与产品构建的两点关键差异，别拿去替换产品配置：
 * 1. `format: 'iife'` + 普通 `<script>` 加载 —— 脚手架是单页，不需要宿主 module table；
 * 2. react 家族**打进包里**（产品构建里它们是 external，由 `__ModuleLoader__` 提供；
 *    浏览器里没有那个 module table，不打包进来就跑不起来）。
 *
 * 用法（由 `scripts/repro/verify-h4-*.mjs` 调用，产物落在 `_local-build/`，不入库）：
 *   npx tsdown --config scripts/verify/harness/tsdown.config.mjs
 *
 * 加一个视图 harness = 在 `HARNESSES` 里加**一行**（配置本身不改，避免 7 份拷贝各自漂移）。
 */
const HARNESSES = [
  { name: 'calendar', entry: 'scripts/verify/harness/calendarHarness.tsx' },
  { name: 'today', entry: 'scripts/verify/harness/todayHarness.tsx' },
  { name: 'task-detail', entry: 'scripts/verify/harness/taskDetailHarness.tsx' },
  { name: 'knowledge', entry: 'scripts/verify/harness/knowledgeHarness.tsx' },
  { name: 'matters', entry: 'scripts/verify/harness/mattersHarness.tsx' },
  { name: 'tasks', entry: 'scripts/verify/harness/tasksHarness.tsx' },
  { name: 'quick-entry', entry: 'scripts/verify/harness/quickEntryHarness.tsx' },
  { name: 'dialogs', entry: 'scripts/verify/harness/dialogsHarness.tsx' },
  { name: 'prompt', entry: 'scripts/verify/harness/promptHarness.tsx' },
  { name: 'task-forms', entry: 'scripts/verify/harness/taskFormsHarness.tsx' },
  { name: 'pending', entry: 'scripts/verify/harness/pendingHarness.tsx' },
]

export default HARNESSES.map((harness) => ({
  name: `h4-harness-${harness.name}`,
  entry: { harness: harness.entry },
  cwd: process.cwd(),
  outDir: '_local-build/h4',
  format: 'iife',
  platform: 'browser',
  dts: false,
  minify: false,
  clean: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  deps: { alwaysBundle: () => true },
  outputOptions: { entryFileNames: `${harness.name}-harness.js` },
}))
