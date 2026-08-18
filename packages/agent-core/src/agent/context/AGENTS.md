# context — Message History, Projection & Token Gauge

## 职责
- 维护会话消息历史（`history`）、在途步骤（`openSteps`）、token 计量（`tokenCount` + covered 计数）
- 组装发往 LLM 的消息：`messagesForLLM`（投影 + 前缀缓存稳定性观测）
- 处理 loop 事件：step.begin/end、content.part、tool.call/result、thinking.delta（经 `appendLoopEvent`）
- 快照：`toJSONSnapshot`/`restoreJSONSnapshot`（compaction 后持久化，replay 起跳用）
- 清理：`dropVacuousOpenMessages`（中断时丢弃只有 thinking/空的 assistant 消息）

## 依赖
- 依赖：`Agent`（hub，经 `this.agent` 访问 records/background/replayBuilder/injection）
- 被依赖：`Agent`、`FullCompaction`（读 history 压缩）、`AgentServices.context`

## 边界
- 不做：不决定"下一步做什么"（那是 loop/turn），只维护"当前是什么"
- 不 emit UI 事件（restore 契约）；`emitStatusUpdated` 仅 live 路径
- openSteps 引用同一性：step.begin 时消息同时入 history 和 openSteps（同一对象），快照恢复用 history 索引重建——**不要改成值拷贝**
- token 计量口径：`step.end` 用 provider 实测 usage 覆盖；compaction 用全请求估算（含 system+tools）

## 扩展点
- 新消息 content 类型：在 ltod `ContentPart` 加类型（投影/序列化/计数随之适配）
- 新投影策略：改 `projector.ts`（现有：全量投影 + synthesized 缺失消息）
