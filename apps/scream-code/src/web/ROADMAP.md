# Scream Web UI 产品化迭代路线图

> 状态：MVP 已上线（commit `615a3a0`）。本路线图把 `/web` 从"能跑"逐步迭代到可交付给普通用户使用的生产级产品。
> 参考来源：`/Users/tod/Downloads/kimi-code-main`（kap-server + kimi-web）。

## 1. 现状

### 已实现
- `scream web` 启动本地 HTTP + WebSocket 服务器。
- 浏览器聊天：用户发 prompt，LLM 返回事件流（`assistant.delta`、`thinking.delta`、`tool.call.started`、`tool.result`、`turn.ended`）。
- 审批弹窗：手动模式下浏览器收到 `approval_request`，用户点批准/拒绝。
- 权限模式：`-y`（yolo）、`--auto`（自动）、默认 manual。
- 后端零侵入 agent-core，web 是 TUI / stream-json 之外的第三个消费者。

### 当前限制
- 单连接：第二个浏览器标签会被拒绝。
- 无断线重连：刷新页面后当前会话上下文、输出全丢。
- 无心跳/超时检测：长时间静置可能假死。
- 前端裸 HTML：无 Markdown、代码高亮、历史会话、token 成本显示。
- 无认证：任何人知道端口就能连并执行 Bash。
- 无 REST：所有交互挤在 WS 里，审批无法幂等和审计。
- 无会话持久化：server 重启 = 任务归零。

## 2. 从 kimi 借鉴的核心原则

1. **WS/REST 双通道**：WS 只传事件/流式 delta；REST 负责状态变更、审批、上传、配置。
2. **seq + epoch + journal 做断线恢复**：服务端为每个 session 维护 append-only event journal；客户端保存 `lastSeq` 和 `epoch`；重连时增量 replay，超范围回退 snapshot。
3. **durable / volatile 分离**：消息结构、工具结果等 durable 事件入 journal；token 流、进度条等 volatile 事件不入 journal，只保留最后快照。
4. **审批走 REST + 幂等**：利用 HTTP 路由做幂等控制，短期去重窗口 + 结构化错误码 + 审计日志。
5. **前端模块级状态**：一个模块级 client/composable 统一管 WS/REST/状态，组件只读 computed/actions。
6. **认证共用 validator**：HTTP `Authorization: Bearer` + WS `Sec-WebSocket-Protocol: scream.bearer.<token>`，都用 `timingSafeEqual`。

## 3. 分阶段迭代路线

### Phase 1：可用性兜底（MVP 加固） ✅ 已完成

**目标**：让现有 web 从"能跑"变成"刷新/断网/多标签不丢、不卡"。

**关键改动**（已实现）：

| 改动 | 涉及文件 | 说明 |
|------|----------|------|
| 心跳与半开检测 | `server.ts`, `index.html` | 服务端发 `ping`，客户端回 `pong`；客户端超过 `2*heartbeat` 未收到任何帧则标记 stale 并重连。 |
| 断线重连 + 内存 journal | `server.ts`, `index.html` | 每个 session 维护 `events: Array<{seq, epoch, volatile, payload}>`； durable 事件入 journal；重连时按 `lastSeq` 增量推送。 |
| 多连接支持 | `server.ts` | 允许多个浏览器标签同时连接，按 session 广播事件；或至少允许新连接替换旧连接并恢复状态。 |
| 停止生成 | `server.ts`, `index.html` | 前端发 `abort`，后端调用 `session.abortTurn()`。 |
| REST snapshot | `server.ts` | 新增 `GET /api/v1/sessions/:id/snapshot`，返回当前完整状态（messages、pendingApprovals、status）。 |
| 连接状态 UX | `index.html` | 显示 "connecting / connected / reconnecting / disconnected"，重连时自动拉 snapshot 恢复。 |

**WS 协议升级**（向后兼容当前前端，升级后前端再改）：

```ts
// control
{ type: 'server_hello', heartbeat_ms: 30000, epoch: 1 }
{ type: 'client_hello', lastSeq: 42, epoch: 1 }

// business
{ type: 'event', seq: 43, epoch: 1, volatile: false, payload: { type: 'tool.result', ... } }

// command
{ type: 'prompt', text: '...' }
{ type: 'abort' }

// error
{ type: 'error', code: 'session.busy', message: '...', requestId: '...' }
```

**验收标准**：
1. 启动 `scream web`，发送一个 prompt，触发工具调用。
2. 刷新浏览器页面，3 秒内自动重连并恢复历史消息和待审批项。
3. 打开第二个浏览器标签，两个标签都能收到后续事件。
4. LLM 生成过程中点击"停止"，`turn.ended` 正常到来，不再继续输出。
5. 断网 10 秒后恢复，前端自动重连并补齐期间 durable 事件。

---

### Phase 2：体验升级（前端框架 + 渲染 + 历史） ✅ 已完成

**目标**：普通用户愿意用，视觉和交互接近 kimi / ChatGPT。

**关键改动**（已实现）：

| 改动 | 涉及文件 | 说明 |
|------|----------|------|
| 前端迁移到 Vite + Vue3 SPA | 新增 `src/web/frontend/` | 替换裸 HTML；保留 `index.html` 作为 Vite 入口或 fallback。 |
| Markdown 流式渲染 | `frontend/components/Markdown.vue` | 用 `markstream` 或自研流式 parser，支持段落、列表、代码块。 |
| 代码高亮 | `frontend/components/CodeBlock.vue` | 用 `shiki` 做语法高亮；超大代码块降级为 `<pre>`。 |
| diff 块渲染 | `frontend/components/CodeBlock.vue` | `diff` 语言保留 `+`/`-` 颜色，与 TUI 风格一致。 |
| 消息历史 | `server.ts`, `frontend` | 服务端维护 `messages` 数组；`snapshot` 返回；支持向上滚动懒加载。 |
| token / cost 状态栏 | `server.ts`, `frontend` | 新增 `GET /api/v1/sessions/:id/status`，返回 `contextTokens / maxContextTokens / costUsd`；前端底部显示。 |
| 输入增强 | `frontend/components/Composer.vue` | 多行 textarea、Shift+Enter 换行、粘贴图片/文件占位、命令补全。 |
| 主题 | `frontend/styles/` | CSS 变量 + `data-theme`，支持 light/dark/system，同步 `theme-color`。 |
| 错误/Toast | `frontend/` | 全局错误提示，网络错误自动重试，业务错误码映射。 |

**构建流程调整**：
- `frontend/` 独立 Vite 项目，`pnpm build` 输出到 `dist/web-static/`。
- `scripts/copy-web-assets.mjs` 拷 `dist/web-static/` 到 `dist/public/`。
- 开发模式 `scream web --dev` 启动 Vite dev server + 代理后端 WS。

**验收标准**：
1. `scream web` 启动后页面有 Markdown 渲染、代码块复制按钮、底部 token 使用环。
2. 发送 prompt 后，assistant 回复的代码块高亮正确。
3. 刷新页面后历史消息完整恢复，思考过程可折叠。
4. 切换 light/dark 主题，CSS 变量生效。
5. 移动端宽度 ≤640px 时布局单栏，输入框不被键盘顶飞。

---

### Phase 3：安全与生产（认证 + REST 审批 + TLS）

**目标**：能暴露到内网或公网，不怕误操作和未授权访问。

**关键改动**：

| 改动 | 涉及文件 | 说明 |
|------|----------|------|
| Bearer token 认证 | 新增 `src/web/auth.ts` | `Authorization: Bearer <token>`；WS 用 `Sec-WebSocket-Protocol: scream.bearer.<token>`；`timingSafeEqual` 比较。 |
| 开发绕过 | `commands.ts` | `--dangerous-bypass-auth` 开发模式跳过认证，启动日志打印警告。 |
| REST 审批 | 新增 `src/web/routes/approvals.ts` | `GET /api/v1/sessions/:id/approvals?status=pending`；`POST /api/v1/sessions/:id/approvals/:approvalId`。 |
| 幂等与审计 | `server.ts` / routes | `recentlyResolved` 60s 去重窗口；重复 POST 返回 `40902 approval.already_resolved`；决策写 `requestLog`。 |
| REST prompt/abort | `src/web/routes/sessions.ts` | `POST /api/v1/sessions/:id/prompt`、`POST /api/v1/sessions/:id/abort`，幂等 key 可选。 |
| TLS / WSS | `server.ts`, `commands.ts` | `--tls-key` / `--tls-cert` 参数；存在则启动 HTTPS/WSS。 |
| Rate limit | 新增 `src/web/rateLimit.ts` | 内存 fixed window；按路由配置；内网 CIDR 白名单可绕过。 |
| 并发隔离 | `server.ts` | 多 session 时每个 session 独立 journal；session busy 时新 prompt 返回 `40901 session.busy`。 |

**审批流程变更**：
- 当前：WS 发 `approval_request`，前端 WS 回 `approval_response`。
- Phase 3：WS 只通知前端"有新的 approval"；前端调 REST POST 提交决策；服务端幂等处理后推进 agent。

**验收标准**：
1. 不带 token 访问 `http://localhost:3210/` 或 WS，返回 401/403。
2. 启动 `scream web --token xxx`，浏览器第一次打开要求输入 token，输入后正常连接。
3. 手动模式下触发审批，点批准后 F5 刷新，不再重复执行（幂等）。
4. 启动 `scream web --tls-key key.pem --tls-cert cert.pem`，`https://localhost:3210` 可用，WS 走 `wss://`。
5. 高频发 prompt，超过 rate limit 后返回 `42903` 并带重试时间。

---

### Phase 4：高级功能 ✅ 已完成（本机使用导向）

**目标**：追上 kimi 的完整体验（本机场景）。

| 功能 | 状态 | 说明 |
|------|------|------|
| 多 session | ✅ | SessionManager + Map，sidebar 列表，新建/切换/删除 |
| 持久化存储 | ✅ | journal 落盘到 `~/.scream/web-sessions/<id>.jsonl`，server 重启恢复 |
| 导出 | ✅ | 导出当前会话为 Markdown 下载 |
| 归档会话恢复 | ✅ | 切换到旧会话时自动 reactivate agent session |
| 文件上传 | ❌ | 后续可加，本机优先级低 |
| slash 命令 | ❌ | 后续可加 |
| 移动端独立 shell | ❌ | 已有响应式布局，独立 shell 后续 |

## 4. 接口总览（目标形态）

### WebSocket

路径：`/api/v1/ws`（或保留 `/` 兼容旧前端）。

| 方向 | 消息类型 | 说明 |
|------|----------|------|
| S→C | `server_hello` | `{ heartbeat_ms, epoch }` |
| C→S | `client_hello` | `{ lastSeq, epoch }` |
| S→C | `event` | `{ seq, epoch, volatile, payload }` |
| S→C | `resync_required` | `{ reason: 'buffer_overflow' \| 'epoch_changed' }` |
| C→S | `prompt` | `{ text }` |
| C→S | `abort` | — |
| C→S | `pong` | 响应 `ping` |

### REST

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/sessions/:id/snapshot` | 完整当前状态 |
| GET | `/api/v1/sessions/:id/status` | tokens / cost / busy |
| GET | `/api/v1/sessions/:id/messages` | 分页历史消息 |
| POST | `/api/v1/sessions/:id/prompt` | 提交 prompt |
| POST | `/api/v1/sessions/:id/abort` | 停止生成 |
| GET | `/api/v1/sessions/:id/approvals` | 待审批列表 |
| POST | `/api/v1/sessions/:id/approvals/:approvalId` | 提交审批决策 |
| POST | `/api/v1/files` | 文件上传 |

## 5. 数据模型

```ts
interface SessionJournal {
  sessionId: string;
  epoch: number;
  nextSeq: number;
  durable: Array<{ seq: number; payload: AgentEvent }>;
  volatileSnapshot: AgentEvent | null; // 最后一条 volatile 事件快照
}

interface SessionSnapshot {
  sessionId: string;
  workDir: string;
  model: string;
  permission: 'manual' | 'auto' | 'yolo';
  messages: ChatMessage[];
  pendingApprovals: ApprovalRequest[];
  status: SessionStatus;
}

interface SessionStatus {
  busy: boolean;
  contextTokens: number;
  maxContextTokens: number;
  costUsd: number;
}
```

## 6. 最小改动原则

- **每一阶段只解决一个主题**，不提前引入下一阶段的重构。
- **后端尽量复用现有 `ScreamHarness` 和 `Session`**，不改造 agent-core。
- **前端先用最轻量方案**，例如 Phase 1 仍用裸 HTML，Phase 2 再迁 Vite+Vue。
- **REST 接口从 `/api/v1` 开始**，保持版本化，旧 WS 路径做兼容。
- ** journal 先从内存实现**，Phase 4 再考虑落盘和索引。

## 7. 下一步建议

如果老板想继续推进，建议按顺序：

1. **先做 Phase 1**：它是所有后续阶段的基础，改动最小（基本在 `server.ts` 和 `index.html`），但收益最大（刷新不丢、多标签、停止生成）。
2. **Phase 1 完成后立即做端到端测试**：重连、多标签、abort 三个场景必须稳定。
3. **Phase 2 再重构前端**：引入 Vite+Vue 后，Phase 3/4 的新功能会容易很多。
4. **Phase 3 是生产门槛**：如果 web 只在本机使用可以延后；一旦要让同事/外部访问，必须做认证 + REST 审批。
