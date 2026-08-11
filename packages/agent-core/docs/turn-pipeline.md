# Turn Pipeline 全景图（agent-core）

> 目的：让一次 turn（用户消息 → 回复完成）的完整链路、每个决策点、每道守卫"一眼可读"。
> 阅读对象：任何需要修改 turn 行为的开发者。改前先读这里，改后同步更新这里。
>
> 行号基于当前 main（`packages/agent-core`，`turn/index.ts` 1029 行）。**这份文档是唯一权威的 turn 行为地图——若代码与文档冲突，以代码为准但请更新本文档。**

## 1. 总览

一次 turn 的代码分布在 **两层、五个文件**：

```
宿主层（有状态，agent/turn/）
  turn/index.ts      TurnFlow 类 —— 编排：入口、账本、goal 驱动、step 循环宿主 hooks
                     （1029 行，核心职责见 §4）
  turn/ltod-llm.ts   LtodLLM —— 把 ltod generate() 桥接成 loop 的 LLM 接口
  turn/tool-dedup.ts ToolCallDeduplicator —— 同 step 重复工具调用去重
  turn/utils.ts      纯函数（mapLoopEvent、isExploratoryBashCommand、summarizeTurnError 等）
  turn/goal.ts       goal 驱动常量（GOAL_CONTINUATION_PROMPT 等）
  turn/defaults.ts   TURN_DEFAULTS（收敛注入上限/最短回复长度/goal 轮数）

循环层（无状态，loop/）
  loop/run-turn.ts   step 循环框架：abort、maxSteps、连续拒绝熔断、shouldContinueAfterStop
  loop/turn-step.ts  单 step 执行：buildMessages → chat → 推导 stopReason → 工具批
  loop/tool-call.ts  工具批：preflight → hooks → ToolScheduler 并发 → finalize
  loop/types.ts      契约：LoopHooks / ExecutableTool / stop reason 联合
```

**关键分界**：`loop/` 无状态、可独立测试；`turn/index.ts` 持有全部宿主状态（steer 缓冲、收敛注入计数、工具失败记录、goal 语义），并决定"下一步做什么"。

## 2. 一次 turn 的完整时序

```
用户输入
  │
  ▼
TurnFlow.prompt() / steer()            [turn/index.ts:92-118]
  │  records.logRecord('turn.prompt'/'turn.steer')
  │  steer 且有活动 turn → 进 steerBuffer，返回 null（缓冲）
  ▼
launch()                               [turn/index.ts:120-152]
  │  有活动 turn → error(turn.agent_busy)
  │  首次 turn → dreamTracker.init()
  │  allocateTurnId() + AbortController + turnWorker(...)
  ▼
turnWorker()                           [turn/index.ts:247-285]
  │  goal 状态 active → driveGoal()（goal 语义，§5）
  │  否则 → runOneTurn(standalone=true)
  ▼
runOneTurn()                           [turn/index.ts:402-509]
  │  重置 turn 状态（convergence/todo/lastToolFailure/step 计数…）
  │  fullCompaction.resetForTurn() + injection.resetForTurn()
  │  usage.beginTurn() + 发 turn.started
  │  context.appendUserMessage(input, origin)
  ├─ applyUserPromptHook()             [turn/index.ts:511-561]
  │    UserPromptSubmit hook 可阻断（返回 completed）或追加消息
  ├─ runTurn()                         [turn/index.ts:563-955，§3]
  │    step 循环
  ├─ 异常 → 映射 cancelled / failed（sessionMemory.recordError + StopFailure hook）
  ▼
收尾                                [turn/index.ts:477-509]
  │  context.closeAbandonedToolExchange()   // 防悬挂 toolCalls 导致下个请求被拒
  │  usage.endTurn() + 发 turn.ended（与 activeTurn 释放同帧）
  │  错误时补发 error 事件
  ▼
返回 TurnEndResult { event, stopReason }
```

## 3. step 循环（runTurn + 宿主 hooks）

`runTurn`（`loop/run-turn.ts:72-184`）是**单层 while(true)**：

```
while (true)
  ├─ signal.throwIfAborted()
  ├─ maxSteps 检查（loopControl.maxStepsPerTurn）
  ├─ executeLoopStep()（loop/turn-step.ts）
  │     beforeStep hook → chatWithRetry → usage 记录 → deriveStepStopReason → 工具批
  ├─ 连续 8 步全 rejected 熔断（run-turn.ts:136-149）
  ├─ stopReason === 'tool_use' → continue
  ├─ 否则调宿主 hooks.shouldContinueAfterStop()
  │     true → continue；false/undefined → break
  └─ 异常：abort → turn.interrupted；max_steps/error → 抛出（宿主 catch）
```

宿主在 `runTurn({ hooks })` 里注入 7 个 hook（`turn/index.ts:593-931`），按调用顺序：

| # | Hook | 时机 | 宿主行为 |
|---|------|------|---------|
| 1 | `beforeStep` | step 开始前 | flushSteerBuffer → fullCompaction.beforeStep → goal TodoList 提醒（step1）→ TodoList 建议（step2）→ session summary / dream 建议（step1）→ **injection.inject()（9 类 injector）** → deduper.beginStep |
| 2 | `afterStep` | step 结束后 | usage.record → goal.recordTokenUsage → fullCompaction.afterStep → deduper.endStep |
| 3 | `prepareToolExecution` | 工具执行前 | **同 step 去重**（syntheticResult 直接返回）；**验证命令硬跳过**（WorkingSet 缓存命中返回合成结果） |
| 4 | `authorizeToolExecution` | 权限检查 | `permission.beforeToolCall(ctx)` |
| 5 | `onToolCallRejected` | preflight 拒绝 | 喂给 deduper 的 repeat breaker（3/5/8 提醒） |
| 6 | `finalizeToolResult` | 工具结果落库前 | dedup finalize → sessionMemory.recordToolExecution → recordWorkingSetPaths → 验证命令记录/全部标记 verified → verify-agent `[verification_status]` 解析 → TodoList 标记 → lastToolFailure 状态更新 |
| 7 | `shouldContinueAfterStop` | 非 tool_use 停下后 | **决策树见 §4** |

## 4. shouldContinueAfterStop 决策树（收敛控制）

宿主在 `turn/index.ts:642-756` 按顺序判断，返回 `{ continue }`：

```
1. steerBuffer 有内容（含 interrupt）？           → continue:true（下一 step 处理）
2. stopReason === 'max_tokens' 且未恢复过且是主 agent？
     → fullCompaction.begin('truncated')          → continue:true（每会话限 1 次）
3. convergenceInjections < maxConvergenceInjections（turn/defaults.ts，=5）？
   满足任一：
     a. 本 step 无任何内容/工具调用
     b. 有 active goal 但本轮没用 TodoList
     c. 非探索性工具失败 且 本轮无通过的验证
     d. 验证失败且未注入过
     → appendSystemReminder(convergence_gate)     → continue:true（注入计数 +1）
4. summary guard：本轮有实际工作（改文件/验证）但收尾回复过短/纯客套？
     → appendSystemReminder(要求完整总结)         → continue:true（每轮限 1 次）
5. Stop hook：hooks.triggerBlock('Stop') 返回阻断？
     → appendUserMessage(stopBlock.reason)        → continue:true（每轮限 1 次）
6. 默认                                          → continue:false
```

**配套守卫**：
- `maxConvergenceInjections = 5`、`minFinalResponseLength = 60`、`maxGoalTurns = 50` 集中定义在 **`turn/defaults.ts`**（`TURN_DEFAULTS`，带注释）
- 探索性 Bash 判定 `isExploratoryBashCommand()`（which/ls/cat/git status/npx tsc 探测等，`turn/utils.ts`）——探索性失败不阻塞收敛
- `lastToolFailure` 只在非探索性失败时置位，Bash 失败仅由**通过的验证**清除（`markAllVerified`）
- 简短收尾判定 `lastAssistantMessageIsTrivial()`（<60 字符或匹配 `done|ok|完成|好了…` 正则，`turn/index.ts:1014-1028`；正则 `TRIVIAL_COMPLETION_RE` 在 `turn/utils.ts`）

## 5. Goal 驱动（driveGoal）

当存在 active goal 时，`turnWorker` 走 `driveGoal`（turn/index.ts:291-370）——把 goal 拆成**连续多个普通 turn**：

```
while (true)
  ├─ 无 turnBudget 且 turnsUsed >= maxGoalTurns(默认 50，turn/defaults.ts) → markBlocked + 结束
  ├─ overBudget → markBlocked + 结束
  ├─ goal.incrementTurn()
  ├─ 预算接近耗尽（overBudget 或 80% 阈值）→ 替换为 GOAL_BUDGET_STEER_PROMPT（收尾提示）
  ├─ runOneTurn(standalone=false)      // activeTurn 保持跨 continuation turn
  ├─ cancelled → goal.pauseOnInterrupt；failed → goal.pauseActiveGoal
  ├─ goal 完成/阻塞 → 结束
  └─ 否则 → 新 turn + GOAL_CONTINUATION_PROMPT（继续）
```

goal 语义的常量与提示词在 **`turn/goal.ts`**（GOAL_*）。

## 6. 工具批处理（loop/tool-call.ts）

- 工具并发由 `ToolScheduler` 按**资源访问冲突**调度（写操作互斥、`all` 全局互斥；见 `loop/tool-access.ts`）
- 结果按 provider 顺序回交（依序 await）
- 有 pending user steer 时 **150ms 轮询中断工具批**（userCancellationReason abort）
- `graceTimeout` 2s 兜底无视 abort 的工具
- 截断 JSON 参数修复 `repairTruncatedJson` + Ajv 校验（`loop/tool-call.ts`）

## 7. 守卫与熔断清单（速查）

| 守卫 | 位置 | 触发 | 后果 |
|---|---|---|---|
| maxSteps | loop/run-turn.ts:107 | `loopControl.maxStepsPerTurn` | 抛 MaxStepsExceededError |
| 连续拒绝熔断 | loop/run-turn.ts:136-149 | 连续 8 步全 rejected | stopReason=end_turn |
| 收敛注入上限 | turn/defaults.ts（TURN_DEFAULTS） | 5 次 | 停止注入 convergence_gate |
| summary guard | turn/index.ts:716-735 | 每轮 1 次 | 要求结构化总结 |
| max_tokens 恢复 | turn/index.ts:656-667 | 每会话 1 次 | 压缩后继续 |
| 验证命令去重 | turn/index.ts:770-793 | WorkingSet 命中 | 合成结果跳过执行 |
| 工具去重 | turn/tool-dedup.ts | 同 step 同工具同参数 | 合成结果 |
| goal turn 上限 | turn/defaults.ts（TURN_DEFAULTS） | 默认 50 无预算轮 | markBlocked |
| steer 轮询中断 | loop/tool-call.ts | 150ms 轮询 | 中断工具批 |
| 悬挂 toolCalls 修复 | turn/index.ts:487-492 | turn 结束 | 合成错误结果 |
| overflow 恢复 | turn/index.ts:935-942 | CONTEXT_OVERFLOW | 压缩后重试（每 turn 1 次） |
| fullCompaction 熔断 | agent/compaction/full.ts | 连续 3 次失败 | 本 turn 停用自动压缩 |

## 8. TurnFlow 关键状态字段

| 字段 | 含义 |
|---|---|
| `steerBuffer` | 缓冲的 steer 消息（interrupt 标记决定是否打断工具批） |
| `activeTurn` | 当前活动 turn（'resuming' 表示会话恢复中） |
| `currentStepByTurn` | 每个 turn 的当前 step（多 turn 并发追踪） |
| `convergenceInjections` | 收敛注入次数（上限 TURN_DEFAULTS.maxConvergenceInjections） |
| `currentStepHadContent` | 本 step 是否产生内容/工具调用 |
| `lastToolFailure` | 最近的非探索性工具失败（收敛 gate 用） |
| `todoSeenThisTurn` | 本轮是否调用过 TodoList |
| `summaryGuardInjected` | 收尾总结提醒是否已注入 |
| `turnStartWorkingSetPathCount` | turn 开始时 working-set 路径数（判断"是否有实际工作"） |
| `maxTokensRecoveryAttempted` | max_tokens 恢复是否已用（每会话 1 次） |

## 9. 相关文件地图

```
agent/turn/index.ts        编排（本文档 §2-§5）
agent/turn/utils.ts        纯函数（事件映射/探索性判定/错误与参数摘要）
agent/turn/goal.ts         goal 驱动常量
agent/turn/defaults.ts     TURN_DEFAULTS 调参总表
agent/turn/ltod-llm.ts     ltod 桥接（LLM 接口）
agent/turn/tool-dedup.ts   工具去重
agent/turn/canonical-args.ts  工具参数规范化
agent/compaction/          微压缩 + 全量压缩（beforeStep/afterStep 挂接点）
agent/injection/           9 类动态 injector（beforeStep 注入）
agent/context/             消息历史、messagesForLLM、前缀稳定性观测
agent/session-memory.ts    session 记忆（工具执行/错误记录，压缩后注入）
agent/working-set.ts       文件追踪 + 验证记录（收敛 gate 的数据源）
loop/run-turn.ts           step 循环框架
loop/turn-step.ts          单 step
loop/tool-call.ts          工具批
loop/tool-scheduler.ts     并发调度
loop/types.ts              契约
```

## 10. 修改 turn 行为的检查单

改任何 turn 行为前：
1. 先确认改动属于哪一层（宿主 `turn/` 还是无状态 `loop/`）
2. 查本清单 §7 是否已有同类守卫，避免重复实现
3. 涉及新状态 → 在 §8 表加一行
4. 涉及新 hook → 更新 §3 的 hook 表
5. 涉及新阈值 → 写进 `turn/defaults.ts`（带"为什么"注释），不要散落魔法数
6. 改完跑全量测试：`vitest run --no-cache`（agent-core 包内 `bunx vitest run`）
7. 同步更新本文档
