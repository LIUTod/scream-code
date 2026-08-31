# Scream Web UI — 架构与接口暴露清单

> 本文件是 `scream web`（`apps/scream-code/src/web`）的架构与接口窗口。它描述三层架构、REST/WS 双通道的全部对外接口、数据模型、前端 client 能力，以及新增能力时的接线路径。
> 用途：让后续开发者（含 AI 代理）在**不读源码全文**的情况下，快速知道"这个 web 后端暴露了哪些能力、前端怎么调、要加新能力怎么接"。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│  浏览器前端  (Vue 3,  src/web/frontend/)                         │
│  ├─ useScreamWebClient.ts   —— 唯一状态中枢（模块级单例）          │
│  │   · WS 连接/心跳/断线重连                                     │
│  │   · REST 调用封装（session/资源/全局）                          │
│  └─ components/*   —— 视图与面板                                  │
└───────────────┬─────────────────────────────────────────────────┘
                │  WS(事件流)  +  REST(状态/审批/配置/资源)
┌───────────────▼─────────────────────────────────────────────────┐
│  后端  (src/web/server.ts)                                      │
│  ├─ runWebServer()   —— 多会话服务器入口                          │
│  ├─ SessionManager   —— 多会话表 + 会话生命周期 + 通用转发           │
│  │   . switchModel / switchThinking（模型/思考切换）                │
│  │   . getLiveSession() guard + 分组转发（status/usage/…/插件/MCP） │
│  ├─ WebSession       —— 单会话封装（journal/连接/审批/Goal）         │
│  │   . requireLiveSession() —— 公开访问器，转发 RPC                │
│  └─ REST handlers     —— handleGoalRoute / handleSessionControl   │
│                          / handleResourceRoutes / handleGlobal... │
└───────────────┬─────────────────────────────────────────────────┘
                │  通过 ScreamHarness（零侵入）
┌───────────────▼─────────────────────────────────────────────────┐
│  node-sdk (@scream-code/scream-code-sdk)                        │
│  ├─ ScreamHarness  —— 全局能力（config/flags/preflight/会话生命周期）│
│  └─ Session        —— 单会话能力（prompt/模型/技能/插件/MCP/任务/Goal）│
└─────────────────────────────────────────────────────────────────┘
```

**关键设计原则**
- **WS / REST 双通道**：WS 只传事件流 + 命令（`prompt`/`command`/`abort`/审批）；REST 负责状态查询、变更、配置、资源管理，天然幂等、可审计、可测试。
- **零侵入**：web 是 `agent-core`（经 node-sdk）的第三个消费者，与 TUI、stream-json 并列。`packages/agent-core` 与 `packages/node-sdk` 不被 web 侧改动。
- **单例 client**：前端所有状态与动作都从 `useScreamWebClient()` 取，组件只读 computed/actions。

---

## 2. REST 端点清单

基准前缀：`/api/v1`。所有 `:id` 均需 URL 解码；session 作用域端点对归档（只读）会话返回 `409`，不会静默新建。

### A. 会话查询类（GET，session 作用域）

| 端点 | 说明 | 返回 |
|---|---|---|
| `GET /sessions/:id/status` | 会话状态（模型/思考/权限/计划/wolfpack/rlm/上下文/usage） | `SessionStatus` |
| `GET /sessions/:id/usage` | Token 用量 | `SessionUsage` |
| `GET /sessions/:id/context` | 会话上下文（历史 + token 数） | `AgentContextData` |
| `GET /sessions/:id/plan` | 当前计划模式方案 | `SessionPlan` |
| `GET /sessions/:id/skills` | 技能列表 | `SkillSummary[]` |
| `GET /sessions/:id/plugins` | 插件列表 | `PluginSummary[]` |
| `GET /sessions/:id/plugins/:pid` | 单个插件详情 | `PluginInfo` |
| `GET /sessions/:id/mcp` | MCP 服务列表 | `McpServerInfo[]` |
| `GET /sessions/:id/mcp/startup-metrics` | MCP 启动耗时 | `McpStartupMetrics` |
| `GET /sessions/:id/tasks?activeOnly&limit` | 后台任务列表 | `BackgroundTaskInfo[]` |
| `GET /sessions/:id/tasks/:taskId/output?tail` | 任务输出尾部 | `{ output }` |

### B. 会话控制类（POST，session 作用域）

| 端点 | 请求体 | 底层方法 |
|---|---|---|
| `POST /sessions/:id/permission` | `{ mode: yolo\|manual\|auto\|ask }` | `setPermission` |
| `POST /sessions/:id/plan` | `{ enabled, strategy? }` | `setPlanMode` |
| `POST /sessions/:id/plan/clear` | — | `clearPlan` |
| `POST /sessions/:id/wolfpack` | `{ enabled }` | `setWolfpackMode` |
| `POST /sessions/:id/rlm` | `{ enabled, maxDepth? }` | `setRlmEnabled` + `setRlmMaxDepth` |
| `POST /sessions/:id/undo` | `{ count? }` | `undoHistory` |
| `POST /sessions/:id/compact` | `{ instruction? }` | `compact` |

### C. 技能类（session 作用域）

| 端点 | 请求体 | 底层方法 |
|---|---|---|
| `POST /sessions/:id/skills/:name/activate` | `{ args? }` | `activateSkill` |
| `DELETE /sessions/:id/skills/:name` | — | `removeSkill` |

### D. 插件类（session 作用域）

| 端点 | 请求体 | 底层方法 |
|---|---|---|
| `POST /sessions/:id/plugins/install` | `{ source }` | `installPlugin` |
| `POST /sessions/:id/plugins/:pid/enable` | `{ enabled }` | `setPluginEnabled` |
| `POST /sessions/:id/plugins/:pid/mcp/:server/enable` | `{ enabled }` | `setPluginMcpServerEnabled` |
| `POST /sessions/:id/plugins/:pid/activate` | — | `activatePlugin` |
| `POST /sessions/:id/plugins/:pid/deactivate` | — | `deactivatePlugin` |
| `POST /sessions/:id/plugins/:pid/inject` | — | `injectPlugin` |
| `POST /sessions/:id/plugins/reload` | — | `reloadPlugins` |
| `DELETE /sessions/:id/plugins/:pid` | — | `removePlugin` |

### E. MCP 类（session 作用域）

| 端点 | 请求体 | 底层方法 |
|---|---|---|
| `POST /sessions/:id/mcp/add` | `{ name, config }` | `addMcpServer` |
| `POST /sessions/:id/mcp/:name/reconnect` | — | `reconnectMcpServer` |
| `POST /sessions/:id/mcp/:name/stop` | — | `stopMcpServer` |
| `DELETE /sessions/:id/mcp/:name` | — | `removeMcpServer` |

### F. 后台任务类（session 作用域）

| 端点 | 请求体 | 底层方法 |
|---|---|---|
| `POST /sessions/:id/tasks/:taskId/stop` | `{ reason? }` | `stopBackgroundTask` |

### G. 全局类（harness 作用域，无需 session）

| 端点 | 方法 | 请求体 | 底层方法 |
|---|---|---|---|
| `/config` | GET | — | `getConfig` |
| `/config` | POST | `{ patch }` | `setConfig` |
| `/config/providers/:id` | DELETE | — | `removeProvider` |
| `/experimental-flags` | GET | — | `getExperimentalFlags` |
| `/preflight` | GET | — | `preflight` |

### 会话本身（原有的核心端点）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/sessions` | GET/POST | 列表 / 新建 |
| `/sessions/:id/activate` | POST | 激活归档会话 |
| `/sessions/:id/export` | GET | 导出 Markdown |
| `/sessions/:id` | DELETE | 删除 |
| `/sessions/:id/snapshot?tail` | GET | 全量快照（断线恢复） |
| `/sessions/:id/messages?before&tail` | GET | 更早历史分页 |
| `/sessions/:id/messages?seq&tool` | GET | 取完整 thinking 文本 |
| `/sessions/:id/model` | POST | 切换模型（含上下文上限守卫） |
| `/sessions/:id/thinking` | POST | 切换思考强度 |
| `/sessions/:id/goal` | POST/PATCH | 创建 / 更新 Goal |
| `/sessions/:id/goal/refine` | POST | 精炼 Goal 目标 |
| `/sessions/:id/goal/pause\|resume\|cancel` | POST | Goal 生命周期 |
| `/git/status` | GET | Git 状态 |
| `/git/diff?path` | GET | 单文件 diff |
| `/like` | GET/PUT | 用户偏好（共享 TUI） |
| `/models` | GET | 可用模型列表 |

---

## 3. WS 事件与命令清单

### 事件（服务端 → 客户端，经 `event` 信封 + `seq/epoch`）

核心事件（经 `useScreamWebClient.handleMessage` 分发）：`server_hello`、`event`（含 `assistant.delta`/`thinking.delta`/`tool.call.started`/`tool.result`/`turn.started`/`turn.ended`/`goal.updated`/`todo.updated`/`status`/`agent.status.updated`）、`approval_request`、`approval_resolved`、`user_message`、`command_result`、`resync_required`、`server_empty`、`pong`、`error`。

### 命令（客户端 → 服务端）

| 类型 | 说明 |
|---|---|
| `prompt` | 发送用户消息（`{ text, clientMessageId }`） |
| `command` | 斜杠命令（`{ command, args?, pendingMsgId? }`） |
| `abort` | 停止当前回合 |
| `approval_response` | 审批答复（`{ id, decision, feedback?, scope? }`） |
| `ping` / `pong` | 心跳 |

### 前端斜杠命令面（`frontend/src/commands.ts`）

`compact / model / clear / new / help / auto / yes(=yolo) / plan / fork / title(=rename) / status / usage / btw`。
其中 `btw` 特判为"回合进行中也可发"，其余命令在会话忙时拒绝。

---

## 4. 数据模型

前端自持精简类型（`frontend/src/types.ts`，**不 import node-sdk/agent-core**，本地镜像）：

| 类型 | 说明 |
|---|---|
| `ChatMessage` / `ToolMessage` / `TurnStats` | 消息与工具调用、回合统计 |
| `SessionStatus` / `SessionUsage` / `TokenUsage` | 会话状态与用量 |
| `GoalSnapshot` / `TodoItem` / `GoalBudgetInput` | Goal/Todo |
| `GitStatus` / `GitFileChange` | Git |
| `ModelInfo` / `ModelsResponse` | 模型 |
| `SessionListItem` / `SessionSnapshot` | 会话列表/快照 |
| `LikePreferences` | 用户偏好 |
| `ApprovalRequest` | 审批 |
| **新增（本次暴露）** `AgentContextData` / `SessionPlan` / `PlanInfo` / `SkillSummary` / `PluginSummary` / `PluginInfo` / `ReloadSummary` / `McpServerInfo` / `McpStartupMetrics` / `BackgroundTaskInfo` / `ExperimentalFlagMap` / `ScreamConfig` / `ScreamConfigPatch` | 资源与全局 |

这些类型是 `backend` 对应 RPC 返回结构的**镜像**（字段对齐 agent-core），改后端返回结构时需同步更新这里。

---

## 5. 前端 client 接口

`useScreamWebClient()`（单例）对外暴露方法分三类：

- **会话**：`sendPrompt / sendCommand / abort / clearMessages / appendSystemMessage / resolveApproval / switchModel / switchThinking / createSession / switchSession / deleteSession / exportSession / fetchSnapshot / loadOlderMessages / reconnectNow / fetchSessions / fetchGitStatus / fetchModels / fetchLike / updateLike`。
- **Goal/Todo**：`refineGoal / createGoal / updateGoal / pauseGoal / resumeGoal / cancelGoal`。
- **本次新增**：
  - 会话状态：`fetchSessionStatus / fetchSessionUsage / fetchSessionContext / fetchSessionPlan / sessionPlan / clearPlan`；开关：`switchPermission / switchPlanMode / switchWolfpack / switchRlm / undoHistory / compact`。
  - 技能：`skills / fetchSkills / activateSkill / removeSkill`。
  - 插件：`plugins / pluginInfo / fetchPlugins / fetchPluginInfo / installPlugin / setPluginEnabled / setPluginMcpServerEnabled / removePlugin / reloadPlugins / activatePlugin / deactivatePlugin / injectPlugin`。
  - MCP：`mcpServers / mcpStartupMetrics / fetchMcpServers / fetchMcpStartupMetrics / addMcpServer / reconnectMcpServer / stopMcpServer / removeMcpServer`。
  - 后台任务：`backgroundTasks / backgroundTaskOutput / fetchBackgroundTasks / fetchBackgroundTaskOutput / stopBackgroundTask`。
  - 全局：`config / fetchConfig / setConfig / removeProvider / experimentalFlags / fetchExperimentalFlags / preflightOk / preflight`。

以上为**本次"暴露接口"范围**：多数新方法尚无 UI 面板消费（本阶段目标是暴露接口，不是做面板）。

---

## 6. 接线说明（新增能力如何加）

要新增一个基础层能力到 web，按四条链路走，通常是**后端 → 前端**顺序：

1. **后端访问器**：`WebSession` 提供 `requireLiveSession(): Session`（已存在），返回底层核心 Session（归档抛 `409`）。
2. **SessionManager 转发**：在 `SessionManager` 加薄转发方法（现有 `switchModel/switchThinking` 为先例；本次新增了 status/usage/…/插件/MCP/任务/全局各组），内部 `this.getLiveSession(id)` 后调底层方法。
3. **REST handler**：在 `handleSessionControlRoutes` / `handleResourceRoutes` / `handleGlobalRoutes` 之一加路由（返回 `false` 即未匹配，交给下一个 handler），统一 `try/catch → sendHttpError`。
4. **前端 client**：在 `useScreamWebClient.ts` 加对应方法（查询 best-effort、变更带 toast），并在 `UseScreamWebClientReturn` 接口 + return 对象中暴露；`types.ts` 同步镜像返回类型。

**约定**
- 查询类（GET）失败静默（best-effort），变更类（POST/DELETE）失败弹 toast。
- session 作用域端点必须先经 `getLiveSession` 判活（404/409），绝不静默建空壳。
- 全局类（config/flags/preflight）不依赖 session，走 `SessionManager` 的 harness 转发。
- 新增端点需在 README 第 2 节同步登记。

---

## 附：后端模块职责速览

| 模块 | 位置 | 职责 |
|---|---|---|
| `runWebServer` | server.ts | 多会话 HTTP+WS 入口；组装 handler 链；网关认证 |
| `startWebServerForSession` | server.ts | 单会话模式入口（`scream web` 绑定指定会话） |
| `SessionManager` | server.ts | 多会话表、创建/激活/归档/fork/删除、模型/思考切换、通用转发 |
| `WebSession` | server.ts | 单会话封装：journal 事件、连接、审批、Goal/Todo、断线恢复 |
| `useScreamWebClient` | frontend | 前端唯一状态中枢：WS 事件 + REST 调用 + 并发防护 |
| `files.ts` | server.ts 同层 | 文件只读浏览（workdir 收敛 + symlink 逃逸防护） |
| `auth.ts` | server.ts 同层 | LAN 网关认证（Bearer / cookie，timingSafeEqual） |
