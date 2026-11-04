# 案卷真源是工作根下的文件夹（指针）

**Status:** accepted（2026-11-04，对齐 sibling ADR-001；本仓不重开该决策）

权威决策在 sibling 仓库 **dsh-patent**：`docs/adr/ADR-001-matter-folder-index.md`。
本文件只记下工作台侧的落点，避免两份 ADR 各写各的。

## 本仓必须守住的口径

| 角色 | 落点 |
|---|---|
| 真源 | 可配置工作根下的案卷目录 + `_matter-log.md` |
| 默认工作根 | `~/工作`（作者机器上的例子是 `/Users/xujian/工作`）。改根用环境变量 `DSH_WORK_ROOT`，不要把绝对路径写死成唯一默认值 |
| 台账 | `~/.dsh/workbench` 的 SQLite：索引元数据 + `matters.workspace_path` |
| `knowledge.db` | 不是案卷库。扫描导入不把案卷正文写进本库 `knowledge_entries` |
| bridge | `_matter-log.md` → `matter_events` 只是可读投影。写案卷文件夹不等于写台账 |

一个代码仓库服务很多案卷。新建案卷不是「一案一个 Cursor / git 项目」，也不是强制另起一棵与工作根无关的 `patent-workspace/<案号>/`。

## 新建案卷（四步）

1. 在工作根下建文件夹，正文写在磁盘上（需要时追加 `_matter-log.md`）。
2. 工作台「扫描导入」把该目录登记进台账（只写路径和索引字段）。
3. 仍在**这一个**代码仓库里，按案卷把会话工作目录指到该文件夹。
4. 继续在磁盘上写。删掉或重建 `~/.dsh/workbench` 里的库，案卷文件夹还在。

## 本仓落点

- 默认根的唯一实现：`src/shared/workRoot.ts`（`configuredWorkRoot`）。
- 扫描（`src/matter-import/scan.ts`）只 `readdir`，不打开文件。
- 落库（`src/matter-import/commit.ts`）新建或更新 `workspace_path`；拒绝正文类字段。
- 回归：`test/matterImportRoute.test.mjs`（省略 root 走配置根；正文哨兵不进库；删库后文件夹仍在）、`test/workRoot.test.mjs`。
