import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchDb } from '../lib/db/database.js'
import { seedDictionaries } from '../lib/db/seed.js'
import { proposeDailyPlanTool, submitKnowledgeTool, submitTaskTool, updateTaskTool, requestCompletionTool, saveTaskMemoryTool } from '../lib/tools.js'
import { createDraft, createKnowledge, createMatter, createTask, confirmDailyPlanDraft, confirmTaskDraft, getKnowledge, getTask, getTaskMemoryContext, getDraftBySession, getPendingDailyPlanDraft, getPendingDraftForTask, linkTaskSession, updateTask } from '../lib/db/repo.js'
import { linkKnowledgeMatterTool, syncMatterEventsTool } from '../lib/matter-tools.js'

/**
 * 删临时目录，容忍 Windows 上刚 `close()` 时文件句柄尚未释放导致的 EPERM。
 *
 * 背景：`rmSync` 偶发 EPERM 会让一条**断言全过**的测试报失败，
 * 看起来像功能坏了，实际只是杀毒/索引还在占着 WAL 文件。
 * 这类"清理期的假失败"最耗排查时间，所以统一重试几次再放弃（放弃也不 fail）。
 */
function rmTempDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') throw error
      // 忙等一小会儿（同步 sleep）——测试进程里没有别的活可干，等一下最省事。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
    }
  }
}

test('agent tools write pending drafts and update tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-workbench-tools-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const submit = submitTaskTool(db)
    const out = await submit.execute(
      { title: 'clarified task', type_code: 'client_meeting', priority_code: 'p0' },
      { agent: { session: { id: 'sess-1' } } },
    )
    assert.match(out, /草稿已保存/)
    assert.ok(getDraftBySession(db, 'sess-1'))

    // type_code 是**封闭枚举**（v1.14.0 起）：合法值通过，字典外的值**当场拒绝**。
    //
    // 旧行为是"未知 code 静默回退成 personal 并返回草稿已保存"，用户实测反馈
    // 「非法 code 拦截失败」—— 静默改写比静默丢弃更难发现（以为建的是"培训学习"，
    // 实际是"个人生活"）。这条测试原来锁的正是那个旧行为，现已按新契约反转。
    const training = await submit.execute({ title: '学做东北菜', type_code: 'training', priority_code: 'p2' }, { agent: { session: { id: 'sess-training' } } })
    assert.match(training, /草稿已保存/)
    assert.equal(getDraftBySession(db, 'sess-training').payload.typeCode, 'training')

    const unknown = await submit.execute({ title: '未知类型任务', type_code: 'foobar', priority_code: 'p2' }, { agent: { session: { id: 'sess-unknown' } } })
    assert.match(unknown, /type_code 不是有效值/)
    assert.match(unknown, /合法值/)
    assert.equal(getDraftBySession(db, 'sess-unknown'), undefined, '非法 type_code 不应落成草稿')

    // 大小写/字形变体同样拒绝（CODE_IMPL 不是 code_impl）；空串才允许走默认值
    const upper = await submit.execute({ title: '大写变体', type_code: 'CODE_IMPL', priority_code: 'p2' }, { agent: { session: { id: 'sess-upper' } } })
    assert.match(upper, /type_code 不是有效值/)
    assert.equal(getDraftBySession(db, 'sess-upper'), undefined)

    // 回执必须回显**最终落库**的字段，避免"静默改写"再次发生
    assert.match(training, /本次落库的字段：type=training/)

    /**
     * 预分配任务 id（v1.15.1）：客户端在澄清前先 `randomUUID()` 生成 id、用它建**任务资料夹**，
     * 并把 id 写进提示词；确认草稿时必须复用它 —— 否则"资料夹名"与"任务 id"会对不上，
     * 而资料夹规矩（`taskWorkspaceFolderName`）完全建立在"两者同名"之上。
     */
    const reservedId = '11111111-2222-4333-8444-555555555555'
    const reservedOut = await submit.execute(
      { title: '预分配 id 的任务', type_code: 'personal', priority_code: 'p2', task_id: reservedId },
      { agent: { session: { id: 'sess-reserved' } } },
    )
    assert.match(reservedOut, /草稿已保存/)
    const reservedDraft = getDraftBySession(db, 'sess-reserved')
    assert.equal(reservedDraft.payload.id, reservedId, 'task_id 必须原样落到草稿 payload.id')
    const confirmed = confirmTaskDraft(db, reservedDraft.id)
    assert.equal(confirmed.task.id, reservedId, '确认草稿时必须复用预分配 id（资料夹名靠它对齐）')

    /**
     * 预分配 id 的**格式与占用**校验（fresh-eyes 审查 F4）。
     *
     * 旧行为：`input.id` 只 `trim()` → `'../../evil'`、`'...'`、500 字符都能原样落进 `tasks.id`；
     * 两条草稿用同一个 id 时，第二条会把 `UNIQUE constraint failed: tasks.id`（英文 SQLite 原文）
     * 甩给用户。现在两处都必须给**中文可读**原因，且**当场拒绝、不静默改写**。
     */
    for (const bad of ['../../evil', '...', 'x'.repeat(500), 'has space']) {
      const out = await submit.execute(
        { title: `非法 id ${bad.slice(0, 8)}`, type_code: 'personal', priority_code: 'p2', task_id: bad },
        { agent: { session: { id: `sess-bad-${bad.length}-${bad.slice(0, 3)}` } } },
      )
      assert.match(out, /^错误：任务 id/, `非法 id ${JSON.stringify(bad.slice(0, 20))} 必须当场被拒，实际回执：${out}`)
    }
    // 复用已建任务的 id：也当场拒（否则要等确认草稿时才炸）
    const reuse = await submit.execute(
      { title: '复用 id', type_code: 'personal', priority_code: 'p2', task_id: reservedId },
      { agent: { session: { id: 'sess-reuse-id' } } },
    )
    assert.match(reuse, /^错误：任务 id 已存在/)
    // 仓储层同样守（其它调用方绕不过去）：非法 id / 重复 id 都是中文原因，不是 SQLite 原文
    assert.throws(
      () => createTask(db, { id: '../../evil', title: 'x', typeCode: 'personal', priorityCode: 'p3' }),
      (error) => {
        assert.match(String(error.message), /不能包含 "\.\."/)
        assert.equal(/UNIQUE constraint/.test(String(error.message)), false)
        return true
      },
    )
    assert.throws(
      () => createTask(db, { id: reservedId, title: 'x', typeCode: 'personal', priorityCode: 'p3' }),
      /任务 id 已存在/,
    )
    // 两条草稿用同一个 id：第二条确认时给中文原因（而不是 UNIQUE constraint 英文）
    const dupPayload = { id: 'dup-id-12345678', title: '重复 id 任务', typeCode: 'personal', priorityCode: 'p3' }
    const dupDraft1 = createDraft(db, { kindCode: 'task', sessionId: 'sess-dup-1', payload: dupPayload })
    const dupDraft2 = createDraft(db, { kindCode: 'task', sessionId: 'sess-dup-2', payload: dupPayload })
    confirmTaskDraft(db, dupDraft1.id)
    assert.throws(
      () => confirmTaskDraft(db, dupDraft2.id),
      (error) => {
        assert.match(String(error.message), /任务 id 已存在/, `第二条必须给中文原因，实际：${error.message}`)
        assert.equal(/UNIQUE constraint/.test(String(error.message)), false, '不许泄漏 SQLite 英文原文')
        return true
      },
    )
    assert.equal(getTask(db, 'dup-id-12345678') !== undefined, true, '第一份草稿照常落库')

    const update = updateTaskTool(db)
    const task = createTaskForTest(db)
    const upd = await update.execute({ task_id: task.id, description: '## 更新后描述' })
    assert.match(upd, /已更新任务/)
    assert.equal(getTask(db, task.id).description, '## 更新后描述')

    const completion = requestCompletionTool(db)
    const done = await completion.execute({ task_id: task.id, summary: '完成总结' }, { agent: { session: { id: 'sess-exec' } } })
    assert.match(done, /验收申请/)
    const pending = getPendingDraftForTask(db, 'completion', task.id)
    assert.ok(pending)
    assert.equal(getTask(db, task.id).statusCode, 'todo') // 验收前不完成
    // 幂等：同一任务再次申请完成，更新同一草稿
    await completion.execute({ task_id: task.id, summary: '完成总结 v2' }, { agent: { session: { id: 'sess-exec' } } })
    assert.equal(getPendingDraftForTask(db, 'completion', task.id).id, pending.id)
    // AI 不能直接关闭任务
    const deniedClose = await update.execute({ task_id: task.id, status_code: 'done' })
    assert.match(deniedClose, /不能直接/)

    // 验收历史：首次提交返回"第 1 次"，被驳回后再提交带上反馈并回报历史
    assert.match(done, /第 1 次验收提交/)
    const rejected = await completion.execute({ task_id: task.id, summary: '完成总结 v3', feedback: '已按反馈补齐回归测试' }, { agent: { session: { id: 'sess-exec' } } })
    assert.match(rejected, /已按反馈补齐回归测试|第 1 次|暂存/)
    assert.equal(getPendingDraftForTask(db, 'completion', task.id).payload.feedback, '已按反馈补齐回归测试')

    // 任意节点（含父任务）均可申请完成；父任务不再被“叶子”限制拒绝
    const parent = createTask(db, { title: 'parent exec', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
    createTask(db, { title: 'child', typeCode: 'code_impl', priorityCode: 'p1', parentId: parent.id })
    const parentDone = await completion.execute({ task_id: parent.id, summary: '父任务完成' }, { agent: { session: { id: 'sess-parent' } } })
    assert.match(parentDone, /验收申请/)
    assert.ok(getPendingDraftForTask(db, 'completion', parent.id))

    // 任务共享记忆工具：保存后可被同树后续会话读取
    const saveMem = saveTaskMemoryTool(db)
    const memOut = await saveMem.execute({ task_id: task.id, content: '关键决策：使用方案A', kind: 'decision' }, { agent: { session: { id: 'sess-exec' } } })
    assert.match(memOut, /已保存任务共享记忆/)
    assert.match(getTaskMemoryContext(db, task.id), /关键决策：使用方案A/)

    const proposePlan = proposeDailyPlanTool(db)
    const t1 = createTaskForTest(db)
    const planOut = await proposePlan.execute(
      { summary: '先清逾期再推进方案', items: [{ task_id: t1.id, order: 1, note: '上午整块时间' }] },
      { agent: { session: { id: 'sess-plan' } } },
    )
    assert.match(planOut, /今日计划提案已保存/)
    assert.match(planOut, /计划投入 30 min/, '回执必须列最终分钟（AX-D01）')
    const planDraft = getPendingDailyPlanDraft(db, 'sess-plan')
    assert.ok(planDraft)
    // 提案创建即快照：草稿里的 minutes 在创建那一刻算好（不是确认时再取）
    assert.equal(planDraft.payload.items[0].minutes, 30)
    // 同一会话同日再次提交：更新同一草稿，不重复创建；省略 minutes 时保留**草稿里**的快照
    const planOut2 = await proposePlan.execute(
      { summary: '第二版排序', items: [{ task_id: t1.id, order: 1, note: '下午' }] },
      { agent: { session: { id: 'sess-plan' } } },
    )
    assert.match(planOut2, /今日计划提案已保存/)
    assert.equal(getPendingDailyPlanDraft(db, 'sess-plan').id, planDraft.id)
    // 显式 minutes 非法 → 整份报错（不静默丢弃/夹取）
    const badMinutes = await proposePlan.execute(
      { summary: '非法分钟', items: [{ task_id: t1.id, order: 1, minutes: 0 }] },
      { agent: { session: { id: 'sess-plan-bad' } } },
    )
    assert.match(badMinutes, /minutes 非法/)
    // AI 不能写当日结束状态（那是用户当天的工作状态）
    const withEffort = await proposePlan.execute(
      { summary: '想替用户结束', items: [{ task_id: t1.id, order: 1, effortDone: true }] },
      { agent: { session: { id: 'sess-plan-bad' } } },
    )
    assert.match(withEffort, /effortDone/)
    // 已完成任务仍可以写成草稿，但**确认时**共同校验会整份拒绝并保留草稿（AX-D04）
    updateTask(db, t1.id, { statusCode: 'done' })
    assert.equal(getTask(db, t1.id).statusCode, 'done')
    const badPlan = await proposePlan.execute(
      { summary: '不应生效', items: [{ task_id: t1.id, order: 1, note: '' }] },
      { agent: { session: { id: 'sess-plan-bad' } } },
    )
    assert.match(badPlan, /今日计划提案已保存/)
    const badDraft = getPendingDailyPlanDraft(db, 'sess-plan-bad')
    assert.ok(badDraft, '被拒的确认必须保留草稿供用户调整')
    assert.throws(() => confirmDailyPlanDraft(db, badDraft.id), /已完成|已归档/)

    const submitKnowledge = submitKnowledgeTool(db)
    const kOut = await submitKnowledge.execute(
      { title: '经验：先验证再开发', content_md: '# 结论', kind_code: 'lesson', tags: ['流程'], file_link: 'D:\\docs\\经验.md' },
      { agent: { session: { id: 'sess-know' } } },
    )
    assert.match(kOut, /知识草稿已新建/)
    const firstDraftId = getDraftBySession(db, 'sess-know').id
    assert.equal(getDraftBySession(db, 'sess-know').payload.fileLink, 'D:\\docs\\经验.md')
    /**
     * 第二次**不带 draft_id** 的提交：按会话去重 → 覆盖同一份草稿。
     * 回执必须写成"已更新本会话已有草稿（id=…）"并带上被替换的标题，
     * 不能再说"已保存"（旧措辞让"覆盖"读起来像"新建"，这是本次要修的缺陷）。
     */
    const kOut2 = await submitKnowledge.execute(
      { title: '经验：换个主题的覆盖测试', content_md: '# 结论 v2', kind_code: 'lesson', tags: ['流程'] },
      { agent: { session: { id: 'sess-know' } } },
    )
    assert.match(kOut2, /已更新本会话已有草稿/)
    assert.match(kOut2, /不是新建/)
    assert.ok(kOut2.includes(firstDraftId), '回执必须带上被覆盖的那份草稿 id')
    // 回执里说的必须是**被替换掉的旧标题**。两条标题刻意不互为子串，
    // 否则"读的是更新后的新标题"这种错法照样能匹配上（形态对、来源错）。
    assert.match(kOut2, /经验：先验证再开发/)
    assert.equal(/经验：换个主题的覆盖测试/.test(kOut2), false, '回执要说被替换的旧标题，不能是新标题')
    assert.equal(getDraftBySession(db, 'sess-know').id, firstDraftId)
    // 历史落进 payload —— 界面靠它显示"这是替换、不是新增"
    assert.equal(getDraftBySession(db, 'sess-know').payload.revision, 2)
    assert.deepEqual(getDraftBySession(db, 'sess-know').payload.replacedTitles, ['经验：先验证再开发'])
    /**
     * 第三次：**内容与上一次逐字相同**（模型重试工具调用 / 存完再确认一遍）。
     * 这时不能报"前一次的内容已被本次替换"——那是**假的丢件告警**。
     */
    const kOut3 = await submitKnowledge.execute(
      { title: '经验：换个主题的覆盖测试', content_md: '# 结论 v2', kind_code: 'lesson', tags: ['流程'] },
      { agent: { session: { id: 'sess-know' } } },
    )
    assert.match(kOut3, /内容与本次完全一致/)
    assert.match(kOut3, /没有覆盖任何内容/)
    assert.equal(/已被本次替换/.test(kOut3), false, '内容没变就不能说"被替换"')
    assert.equal(getDraftBySession(db, 'sess-know').payload.revision, 2, '重复提交不得虚增历史')
    // 非法 file_link 会被工具拒绝，不写入草稿
    const badLink = await submitKnowledge.execute(
      { title: '坏链接', content_md: '# x', kind_code: 'note', file_link: 'relative/path.md' },
      { agent: { session: { id: 'sess-know-bad' } } },
    )
    assert.match(badLink, /fileLink must be a file:\/\/ URL or an absolute path/)

    db.close()
  } finally {
    rmTempDir(dir)
  }
})

test('workbench_update_task 改父任务：parent_id / parent_title 解析、顶层与防环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-workbench-tools-reparent-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const update = updateTaskTool(db)
    const target = createTask(db, { title: '目标父任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const other = createTask(db, { title: '另一个任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const moving = createTask(db, { title: '被移动任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const child = createTask(db, { title: '子任务', typeCode: 'code_impl', priorityCode: 'p1', parentId: moving.id })

    // 用 id 指定父任务
    const byId = await update.execute({ task_id: moving.id, parent_id: target.id })
    assert.match(byId, /已更新任务/)
    assert.match(byId, /父任务改为「目标父任务」/)
    assert.equal(getTask(db, moving.id).parentId, target.id)

    // 用户只给了标题：用 parent_title 解析
    const byTitle = await update.execute({ task_id: moving.id, parent_title: '另一个任务' })
    assert.match(byTitle, /父任务改为「另一个任务」/)
    assert.equal(getTask(db, moving.id).parentId, other.id)

    // 移到顶层
    const toTop = await update.execute({ task_id: moving.id, parent_id: 'none' })
    assert.match(toTop, /父任务改为「顶层」/)
    assert.equal(getTask(db, moving.id).parentId, null)

    // 防环：目标是自己的子任务 → 返回中文错误文本（而不是抛异常），且不改库
    const cyclic = await update.execute({ task_id: moving.id, parent_id: child.id })
    assert.match(cyclic, /^错误：/)
    assert.match(cyclic, /形成环/)
    assert.equal(getTask(db, moving.id).parentId, null)

    // 标题找不到 → 列出候选让 AI 回去问用户；重名 → 不替用户挑；两个参数同时给 → 明确报错
    const missing = await update.execute({ task_id: moving.id, parent_title: '不存在的标题' })
    assert.match(missing, /没有找到/)
    assert.match(missing, /目标父任务/)
    assert.equal(getTask(db, moving.id).parentId, null)

    createTask(db, { title: '重名任务', typeCode: 'code_impl', priorityCode: 'p1' })
    createTask(db, { title: '重名任务', typeCode: 'code_impl', priorityCode: 'p1' })
    const ambiguous = await update.execute({ task_id: moving.id, parent_title: '重名任务' })
    assert.match(ambiguous, /匹配到 2 个/)
    assert.match(ambiguous, /parent_id/)
    assert.equal(getTask(db, moving.id).parentId, null)

    const both = await update.execute({ task_id: moving.id, parent_id: target.id, parent_title: '目标父任务' })
    assert.match(both, /只能给一个/)
    assert.equal(getTask(db, moving.id).parentId, null)

    // 父任务 id 不存在：中文原因
    const badId = await update.execute({ task_id: moving.id, parent_id: 'no-such-parent' })
    assert.match(badId, /父任务 no-such-parent 不存在/)
    assert.equal(getTask(db, moving.id).parentId, null)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createTaskForTest(db) {
  return createTask(db, { title: 'execution target', typeCode: 'code_impl', priorityCode: 'p1', aiPolicyCode: 'execute' })
}

function localDateStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 回归（工具侧，2026-09-13 真实事故）：
 * 任务**执行会话**里再次 `workbench_submit_task` 同名任务时，回执必须提醒"这条任务已存在"。
 *
 * 事故形态：任务 A 的执行会话（session-5cf75152）又录了一份同名草稿，
 * 用户在「待处理」里把它确认掉 → 库里多出一条同名任务。
 * 工具不能拒绝（同名任务可能是正当需求），但必须让 AI 有据可依地提醒用户。
 */
test('workbench_submit_task 在同名任务已存在时给出提醒（尤其是当前会话就是它的关联会话）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-workbench-tools-dup-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const submit = submitTaskTool(db)

    // ① 全新标题：不该有任何提醒
    const clean = await submit.execute(
      { title: '第一次录入的任务', type_code: 'personal', priority_code: 'p3' },
      { agent: { session: { id: 'sess-clarify' } } },
    )
    assert.doesNotMatch(clean, /已经存在|已经有/)

    // ② 任务已存在，但当前会话与它无关 → 提示但不阻断
    const task = createTask(db, { title: '已存在的任务', typeCode: 'personal', priorityCode: 'p3' })
    const unrelated = await submit.execute(
      { title: '已存在的任务', type_code: 'personal', priority_code: 'p3' },
      { agent: { session: { id: 'sess-other' } } },
    )
    assert.match(unrelated, /草稿已保存/, '提醒不能变成拒绝')
    assert.match(unrelated, /已经有 1 条同名任务/)

    // ③ 当前会话正是那条任务的关联会话（= 执行会话重复录入）→ 明确指出"这几乎肯定是重复录入"
    linkTaskSession(db, { taskId: task.id, sessionId: 'sess-execute', roleCode: 'execute' })
    const repeat = await submit.execute(
      { title: '已存在的任务', type_code: 'personal', priority_code: 'p3' },
      { agent: { session: { id: 'sess-execute' } } },
    )
    assert.match(repeat, /草稿已保存/)
    assert.match(repeat, /已经存在/)
    assert.match(repeat, /几乎肯定是重复录入/)
    assert.match(repeat, new RegExp(task.id.slice(0, 8)))
  } finally {
    rmTempDir(dir)
  }
})

// ---------------------------------------------------------------------------
// 阶段 5：workbench_link_knowledge_matter（知识 ↔ 案卷的显式写入口）
// ---------------------------------------------------------------------------

test('link_knowledge_matter：归入 / 改归 / 移出 / 三种坏输入都给可读中文原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-workbench-matter-tool-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const tool = linkKnowledgeMatterTool(db)
    const matterA = createMatter(db, { caseNumber: '2026-UM-001', title: '甲案', matterType: 'drafting' })
    const matterB = createMatter(db, { caseNumber: '2026-UM-002', title: '乙案', matterType: 'drafting' })
    const entry = createKnowledge(db, { title: '答复策略：三步法' })
    const run = (args) => tool.execute(args, {})

    // 归入
    const linked = await run({ knowledge_id: entry.id, case_number: '2026-UM-001' })
    assert.match(linked, /已归入案卷「2026-UM-001 · 甲案」/)
    assert.equal(getKnowledge(db, entry.id).matterId, matterA.id)
    assert.equal(getKnowledge(db, entry.id).contentMd, '', '只改归属，不动内容')

    // 重复归入同一个是幂等的（不做无意义的写）
    assert.match(await run({ knowledge_id: entry.id, case_number: '2026-UM-001' }), /已经归在案卷/)

    // 改归另一个（明确说出"原先归在别的案卷下"）
    assert.match(await run({ knowledge_id: entry.id, case_number: '2026-UM-002' }), /原先归在别的案卷下/)
    assert.equal(getKnowledge(db, entry.id).matterId, matterB.id)

    // 移出
    assert.match(await run({ knowledge_id: entry.id, unlink: true }), /已移出案卷「2026-UM-002」/)
    assert.equal(getKnowledge(db, entry.id).matterId, null)
    assert.match(await run({ knowledge_id: entry.id, unlink: true }), /本来就没有归入任何案卷/, '再移出一次要说清"无需改动"')

    // 坏输入：都要可读原因，且不许半写
    assert.match(await run({ knowledge_id: 'no-such-entry', case_number: '2026-UM-001' }), /^错误：没有这条知识条目/)
    assert.match(await run({ knowledge_id: entry.id, case_number: '不存在的案号' }), /^错误：没有这个案卷/)
    assert.match(await run({ knowledge_id: entry.id }), /^错误：要么给 case_number/)
    assert.equal(getKnowledge(db, entry.id).matterId, null, '坏输入不许改到任何东西')
    db.close()
  } finally {
    rmTempDir(dir)
  }
})

test('sync_matter_events：真读案卷目录的 _matter-log.md 并幂等投影（回执把三件事分开报）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-workbench-sync-tool-'))
  const caseDir = join(dir, 'patent-workspace', '2026-UM-002')
  mkdirSync(caseDir, { recursive: true })
  writeFileSync(join(caseDir, '_matter-log.md'), [
    '2026-08-19T21:00:00+08:00 | 建案 | 目录骨架 | 用户 | 交底书已入 00-交底书/',
    '这行格式不对',
  ].join('\n'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const tool = syncMatterEventsTool(db)
    const run = (args) => tool.execute(args, {})

    /**
     * 坏输入：案号必填 —— **框架先挡**（`required: true` 的参数缺失时 `execute` 根本进不来，
     * 抛 `ToolArgsError`；与 `progressTools.test.mjs` 里那条口径一致）。
     * 处理函数里那句 `str(args.case_number) === undefined` 因此是**第二道防线**（直接调用
     * `tool.execute` 的场景，比如本文件里的各种直调），不是死代码。
     */
    await assert.rejects(() => run({}), /missing required property "case_number"/)
    assert.match(await run({ case_number: '不存在' }), /^错误：没有这个案卷/)

    // 没登记目录 → 明确说"无法定位"，并说明不猜路径
    const noDir = createMatter(db, { caseNumber: '2026-UM-001', title: '无目录', matterType: 'drafting' })
    const noDirOut = await run({ case_number: noDir.caseNumber })
    assert.match(noDirOut, /没有登记案卷目录/)
    assert.match(noDirOut, /不会去猜路径/)

    // 正常：新增 1 条 + 1 行未解析（带行号与原因）
    const matter = createMatter(db, { caseNumber: '2026-UM-002', title: '有目录', matterType: 'drafting', workspacePath: caseDir })
    const out = await run({ case_number: matter.caseNumber })
    assert.match(out, /新增 1 条/)
    assert.match(out, /日志共 1 条记录/)
    assert.match(out, /1 行\*\*没解析出来\*\*/)
    assert.match(out, /第 2 行/)
    assert.match(out, /只读；本插件从不改写它/)

    // 幂等：再跑一次是 0 新增
    assert.match(await run({ case_number: matter.caseNumber }), /新增 0 条，已存在（幂等跳过）1 条/)
    db.close()
  } finally {
    rmTempDir(dir)
  }
})

test('sync_matter_events：目录在但没有日志文件时，说清"这不是错误"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patent-workbench-sync-tool2-'))
  try {
    const db = openWorkbenchDb({ dbPath: join(dir, 'workbench.db') })
    seedDictionaries(db)
    const matter = createMatter(db, { caseNumber: '2026-UM-003', title: '空目录', matterType: 'drafting', workspacePath: join(dir, 'nope') })
    const out = await syncMatterEventsTool(db).execute({ case_number: matter.caseNumber }, {})
    assert.match(out, /没有 _matter-log\.md/)
    assert.match(out, /这不是错误/)
    db.close()
  } finally {
    rmTempDir(dir)
  }
})
