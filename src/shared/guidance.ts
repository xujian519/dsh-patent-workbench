/**
 * 注入文本的**单一真源**（T4）。
 *
 * ## 为什么要有这个文件
 *
 * 「AI 不能直接把任务标记为已完成/已取消」是工作台最硬的一条纪律：任务「完成」
 * 只能由**用户**表达（验收通过、或界面点完成），模型只能**申请**验收
 * （`workbench_request_completion`）。这条规则写在 **4 处**：
 *
 * | 挂点 | 语域 |
 * |---|---|
 * | `src/index.ts` 执行流程段 / 进度语义段 | 常驻引导（模型每次都会读到） |
 * | `src/tools.ts` `updateProgressTool.description` | 工具描述 |
 * | `src/tools.ts` 拒绝 `status_code=done/cancelled` 的返回值 | 错误消息 |
 *
 * 它们**已经漂移过**：`index.ts` 两处写的「完成/取消」，`tools.ts` 两处写的
 * 「已完成/已取消」——同一条规定两种说法。语域不同，所以 import 不了同一个字符串；
 * 但**规定是同一条**，改一处漏三处就是事故。
 *
 * 真源因此给的不是「一个字符串导出」，而是**规则的规范表述**：各挂点按自己的语域
 * 从中取值。`scripts/check-guidance-drift.mjs` 断言规范短语只出现在本文件里，
 * 别处再手打一遍就报错。
 *
 * ## 只收「注入文本」
 *
 * persona `.md` 文件、客户端提示词都**不在这里**：persona 已是单源文件（`assets/personas/`），
 * 而客户端那份 prompt 走工作台面板、服务端拿不到（见 `src/index.ts` 里 intake 命令注释）。
 * 这里只管**服务端注入给模型的文本**。
 */

/** 规则的特征短语 —— 防漂移校验按它判「这句话是不是又被人手打了一遍」。 */
export const COMPLETION_AUTHORITY_MARK = 'AI 不能直接把任务标记为已完成/已取消'

/**
 * 规范句（可直接嵌进段落的完整一句话，**不带句号**，由挂点按语域收尾）。
 *
 * 用 `MARK` 拼出来是刻意的：改了 `MARK`，这句话跟着改，不会各改各的。
 */
export const COMPLETION_AUTHORITY_RULE = `${COMPLETION_AUTHORITY_MARK} —— 「已完成」只由用户验收通过或用户在界面点完成来表达`

/** `workbench_update_task` 拒绝 `status_code=done/cancelled` 时的错误消息。 */
export const COMPLETION_AUTHORITY_REJECTION = `错误：${COMPLETION_AUTHORITY_MARK}；完成请由执行会话调用 workbench_request_completion，取消请在界面操作。`
