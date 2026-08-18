# compaction — Context Compaction (Full & Micro)

## 职责
- **FullCompaction**：上下文超限时把历史压缩成 summary（`applyCompaction` 折叠 + 写 `context.snapshot`）；worker 带重试（5 次、honor Retry-After）
- **MicroCompaction**：增量折叠（`micro_compaction.apply` 推进 cutoff），延迟到工具交换闭合后执行
- 触发策略：`compaction/strategy.ts`（阈值 + 熔断 + 水位 + 每 turn 限次）
- token 口径：`tokensBefore/tokensAfter` = system prompt + tool schemas + 消息（全请求口径，与实测锚点一致）

## 依赖
- 依赖：`Agent`（hub，读 context.history、tools.loopTools、getRuntimeSystemPrompt）
- 被依赖：`Agent`（turn 循环触发）、`AgentServices.fullCompaction/microCompaction`

## 边界
- 不做：不修改 wire 历史（折叠只影响内存 + 产生 summary 记录）
- compaction 请求：复用真实 system prompt + 排序 tools（命中 provider 前缀缓存）——**不要改成自定义 prompt**
- `apply_compaction` 会 reset micro cutoff + 触发 `injection.onContextCompacted`
- 重试仅处理可重试错误（`isRetryableGenerateError`），非可重试直接抛

## 扩展点
- 新压缩策略：实现 `CompactionStrategy` 接口（现有 full/micro 两策略）
- 调整触发：改 `compaction/strategy.ts` 的阈值/熔断参数
