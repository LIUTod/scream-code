# loop — Agent Turn Loop & Retry

## 职责
- 驱动 agent 回合：`turn-step.ts` 的 `runTurn`（dispatch step 事件 → LLM 调用 → 工具执行 → 直到 turn 结束）
- 引擎级重试：`loop/retry.ts` 的 `chatWithRetry`（默认 10 次、abortable、覆盖 429/5xx/quota、honor Retry-After）——**SDK 重试已禁用（maxRetries:0），重试唯一入口在这里**
- 事件模型：`loop/events.ts`（step.begin/end、content.part、tool.call/result、thinking.delta...）
- 辅助 LLM 调用（退出记忆提取/侧问/文本生成/技能规划）走 `Agent.generateWithRetry`（3 次，同样 honor Retry-After）

## 依赖
- 依赖：`Agent`（hub，context/records/tools/usage）、`LtodLLM`（llm 调用）、`loop/retry.ts`
- 被依赖：`Agent`（turn 入口）、`AgentServices.turn`

## 边界
- 不做：不维护会话状态（那是 context/records），只驱动"这一轮做什么"
- **重试纪律**：所有 provider 调用必须经 `chatWithRetry`（主循环）或 `generateWithRetry`（辅助）——禁止裸调 `generate`（会失去重试/可取消）
- 中断处理：`runOneTurn` 结束调 `closeAbandonedToolExchange` + `dropVacuousOpenMessages`（丢弃 thinking-only 空消息）
- `turn.ended` emit 在清理之后（RPC 快照与重放一致）

## 扩展点
- 新步骤类型 = `loop/events.ts` 加事件 + `turn-step` dispatch + `context.appendLoopEvent` 处理
- 调整重试预算 = `loop/retry.ts` 的 `DEFAULT_MAX_RETRY_ATTEMPTS`
