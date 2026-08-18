# records — Session Wire Log & Replay

## 职责
- 持久化 agent 的全部状态变更：`logRecord(type, payload)` 写 append-only wire.jsonl（`AgentRecordPersistence` 抽象，默认文件实现）
- Resume 重放：`replay()` 从 wire 恢复内存状态（快照起跳：有 `context.snapshot` 时跳过其前的折叠 context 记录）
- 版本迁移：`migrateWireRecord` + `WireMigration`，wire 版本升级时逐条迁移
- blob 引用：大 content 经 `BlobStore.offload` 落盘为 `blobref:`，replay 后 `rehydrateParts`

## 依赖
- 依赖：`Agent`（hub）、`AgentRecordPersistence`、`BlobStore`
- 被依赖：`ContextMemory`、`Agent`（所有状态方法调 `logRecord`）

## 边界
- 不做：不负责状态"如何更新"（那是各子系统方法），只负责"记录 + 恢复 + 迁移"
- restore 契约：`restoreAgentRecord` 不得 emit UI 事件 / 调 LLM / 执行工具 / 触碰 fs
- 快照机制（`context.snapshot`）：compaction 后写入，replay 跳过其前折叠记录——改 record 类型时务必保持向后兼容（未知类型静默忽略）

## 扩展点
- 换存储 = 实现 `AgentRecordPersistence`（已含 InMemory + FileSystem 两实现）
- 新状态类型 = 在 `AgentRecordEvents` 加类型 + `restoreAgentRecord` 加 case
