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

### Phase 3：安全与生产（认证 + REST 审批 + TLS）— 认证已落地（见 Phase 3.5），REST 审批与 TLS 待做

**目标**：能暴露到内网或公网，不怕误操作和未授权访问。

**关键改动**：

| 改动 | 涉及文件 | 说明 |
|------|----------|------|
| Bearer token 认证 | 新增 `src/web/auth.ts` | **已落地为 cookie 网关形态**（手机浏览器无法携带 Bearer header，见 Phase 3.5）；`timingSafeEqual` 比较原则保留。 |
| 开发绕过 | `commands.ts` | `--dangerous-bypass-auth` 开发模式跳过认证，启动日志打印警告。 |
| REST 审批 | 新增 `src/web/routes/approvals.ts` | `GET /api/v1/sessions/:id/approvals?status=pending`；`POST /api/v1/sessions/:id/approvals/:approvalId`。 |
| 幂等与审计 | `server.ts` / routes | `recentlyResolved` 60s 去重窗口；重复 POST 返回 `40902 approval.already_resolved`；决策写 `requestLog`。 |
| REST prompt/abort | `src/web/routes/sessions.ts` | `POST /api/v1/sessions/:id/prompt`、`POST /api/v1/sessions/:id/abort`，幂等 key 可选。 |
| TLS / WSS | `server.ts`, `commands.ts` | `--tls-key` / `--tls-cert` 参数；存在则启动 HTTPS/WSS。**移入"公网映射"版本**（配合 frp/中继时一并设计）。 |
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

### Phase 3.5：网关验证 + 局域网模式 ✅ 已完成

**目标**：`scream web --lan` 一条命令把 Web UI 共享到局域网，同网设备凭访问密钥进入；本机行为不变。

| 改动 | 涉及文件 | 说明 |
|------|----------|------|
| 网关认证 | `src/web/auth.ts` | scrypt hash + salt 存 `<home>/web-gateway.json`（0600，明文不落盘）；cookie 会话（HttpOnly / SameSite=Lax / 30 天）；loopback 免验证；`timingSafeEqual` 比较 |
| 网关判定 | `auth.ts` `gatewayVerdict()` | 纯函数：allow / redirect(302 → `/gateway`) / unauthorized(401 `{code:40101}`)；WS 未认证 `close(1008)` |
| 登录限流 | `src/web/rateLimit.ts` | per-IP fixed window，10 次 / 5 分钟，超出 429 + `42903` + `Retry-After` |
| 网关路由 | `server.ts` | `GET /api/v1/gateway/status`、`POST /api/v1/gateway/login` / `logout`、`GET /gateway` 网关页 |
| 局域网枚举 | `src/web/lan.ts` | 过滤环回 / IPv6 / 链路本地 / CGNAT（100.64.0.0/10），输出可直达 IPv4 |
| CLI | `commands.ts`, `run-web.ts` | `--lan`（绑 0.0.0.0 + 强制网关）、`--token <key>`（自设并持久化）、`--reset-password`（交互重设，输入不回显）；`--lan` 无密钥时自动生成并打印 |
| 启动横幅 | `server.ts` | LAN URL 列表 + 访问密钥（首启生成时展示）+ 终端二维码（`qrcode` 依赖，纯 JS） |
| 网关页 | `frontend/public/gateway.html` | 独立单文件页（无框架依赖），站内 `next` 校验防 open redirect，失败/限流提示 |
| 顺带修复 | `server.ts` | 持久化元数据指向已删除核心会话时，启动不再崩溃（warn 后跳过恢复，用户从空状态开始） |

**设计决策**：局域网 = 显式 opt-in。默认 `scream web` 仍绑 `127.0.0.1` 无认证——web 界面能驱动 agent 执行命令，网络暴露必须显式声明（dev server 类工具的行业惯例）；`--lan` 的"开箱即用"顺滑感靠自动密钥 + 终端二维码 + cookie 30 天免输实现，而非默认暴露。

### Phase 4：架构收敛 ✅ 已完成（独立 CLI + 多会话）

**当前形态**：Web UI 通过独立的 `scream web` CLI 子命令启动（与 `scream` TUI、`scream stream-json` 平级）。没有 TUI `/web` slash 命令。

| 决策 | 状态 | 说明 |
|------|------|------|
| 启动方式 | ✅ | `scream web --port --model -y --auto --no-open` |
| 多 session | ✅ | `SessionManager` 按 Web ID 管理会话；metadata 单独保存 `coreSessionId`，恢复调用 `resumeSession` |
| WS 路由 | ✅ | `?sessionId=` 选择会话；无参数时连接首个 active 会话 |
| REST API | ✅ | 会话列表/创建/恢复/导出、snapshot、模型/思考切换及 Goal 操作 |
| 持久化存储 | ✅ | durable event journal + metadata 落盘；volatile delta 仅实时发送 |
| 归档恢复 / fork | ✅ | 恢复和 fork 均使用核心 Session ID，不以空会话冒充恢复 |
| Goal / Todo 状态 | ✅ | snapshot 来自核心 RPC；`goal.updated` / `todo.updated` 复用统一 journal/seq/epoch 通道 |
| 文件上传 | ❌ | 后续可加 |
| 移动端独立 shell | ❌ | 已有响应式布局，独立 shell 后续 |

### Phase 5：前端按原型从零重建 ✅ 已完成（黑白浅色工作台形态）

### Phase 6：参考实现 对照优化 ✅ 已完成（可靠性 / 文件 / 分页 / 分支 / 打磨）

**背景**：对照 参考实现 深度分析后按批准方案实施三个里程碑。视觉基线不变（黑白简约原型），优化聚焦功能/细节/渲染。

#### M1 可靠性与安全
| 改动 | 文件 | 验收 |
|---|---|---|
| 消息持久化：`turn.ended` 落盘 `web.message.finalized` 完整快照（正文+thinking+tools+ts）；`buildMessages` 优先采用快照；旧会话无快照标 `degraded` 提示 | `server.ts` | kill -9 重启后正文完整（真实 E2E）；单测 2/2 |
| Markdown `html` token 转义渲染（XSS 净化） | `MarkdownRenderer.vue` | 注入单测 3/3 |
| 时间戳持久化（finalized.ts）+ 断连横幅 + faint 对比度 4.5:1 + Dialog focus trap + 失败重试按钮 + `reconnectNow()` | 前端多文件 | 浏览器实测 |

#### M2 文件能力与渲染
| 改动 | 文件 | 验收 |
|---|---|---|
| 只读文件 API：`/files/root|list|read|raw`；roots=全部会话 workDir；词法 + realpath 双重防逃逸；256KB 截断 | `files.ts`（新） | 逃逸单测 9/9（../、绝对路径、symlink、无 roots） |
| 文件抽屉（详情/文件 Tab）+ 文本/图片/音频/PDF 预览 + 面包屑 | `FilesBrowser.vue`（新）、`SessionDrawer.vue` | 浏览器实测（浏览/预览） |
| Git 文件级 diff：`/git/diff?path=`；status 增 porcelain files[]；repoTop 换行 trim 修复；workdir 相对路径修正 | `server.ts`、`GitPanel.vue`、`utils/diff.ts`（parseUnifiedDiff） | curl 2085 字符 patch；抽屉 diff 视图实测 |
| 消息分页：`/sessions/:id/messages?before=&tail=`；snapshot `?tail=`（首屏 tail=100）；olderAvailable/oldestSeq；「加载更早」哨兵 + 前插滚动锚定 | `server.ts`、`useScreamWebClient.ts`、`MessageList.vue` | curl 分页 API 实测 |
| thinking >8KB 尾段截断 + `?seq=&tool=` 按需拉全文；工具输出 ≥8KB 惰性展开；workdir 图片结果内联预览 | `server.ts`、`ThinkingBlock.vue`、`GenericToolCard.vue` | 代码完成 |

#### M3 分支与打磨
| 改动 | 文件 | 验收 |
|---|---|---|
| Fork UI：最后一条 assistant 消息「Fork」按钮 → `fork` 命令 + 会话列表刷新 | `MessageItem/List/ConversationView` | 真实 fork：会话 6→7 |
| 全局 Esc 停止（输入框聚焦时豁免）+ 顶栏「运行中」呼吸指示 | `WebShell.vue` | 代码完成 |
| ModelPicker 键盘导航（↓ 进列表、↑↓ 循环、Enter 原生） | `ModelPicker.vue` | 代码完成 |
| 审批上下文：判定已达标（display 全文展示），无需改动 | `ApprovalCard.vue` | — |

**明确不做**（诚实边界）：Todo 写操作（协议只读）、turn 分组（无 turn id 数据结构）、空状态动态化（现有建议卡是真实可发的引导）、通知/PWA/i18n（无需求）。

**测试**：web 测试 8 文件 46 用例全绿；`web:typecheck`（vue-tsc）0 错误；`tsc -p tsconfig.json` 0 错误。

**目标**：按用户手绘原型重做 Web 前端——浅色黑白、288px 固定侧栏、右侧大留白、中央品牌 + 双模式（智能对话/任务执行）+ 居中大输入卡；展示层全部推倒，状态层（`useScreamWebClient`）保留。

| 改动 | 涉及文件 | 说明 |
|------|----------|------|
| 新壳 | `WebShell.vue` | 唯一持有 client；视图状态机 home/chat/skills/settings；⌘K 搜索 / ⌘N 新建 |
| 侧栏 | `Sidebar.vue` | 品牌 + 7 导航（智能体/知识库/工具为「即将上线」禁用态，无 API 不造假）+ 我的空间（workDir 分组）+ 身份卡；≤640px 抽屉式 |
| 首页 | `WorkspaceHome.vue`, `ModeSwitch.vue` | 56px wordmark +「你的智能协作伙伴」+ 模式 pill + 居中输入卡（`Composer variant="home"`：通用智能体 ▾ / 黑色圆形发送） |
| 对话页 | `ConversationView.vue`, `ConversationHeader.vue` | 840px 三层；扁平会话条（返回/状态点/悬停改名/导出/清空/抽屉钮） |
| 详情抽屉 | `SessionDrawer.vue` | 原右栏能力（运行状态/Git/Todo/Like/Goal）从常驻右栏迁入按需抽屉 |
| 视觉 | `styles/tokens.css` `variables.css` `main.css` | 单色 token（`--accent: #111`）；light 为原型观感、dark 为中性灰阶；无大幅渐变 |
| 契约补丁 | `useScreamWebClient.ts` | 接口补 `like/fetchLike/updateLike`（实现已存在但未暴露类型）；`SessionUsage`/`LikePreferences` 导入补全 |
| 门禁 | `package.json` | 新增 `web:typecheck`（vue-tsc），MarkdownRenderer/CodeBlock/InfoPanel 类型错误清零 |
| 墙 | `frontend/public/gateway.html` | 仅浅色重做，登录/限流/`next` 校验行为不变 |

**验收**（均通过）：`web:typecheck` 0 error；`test/web` 28/28；`pnpm build` 全链；真实发送 E2E（首页输入 → 自动建会话 → 进对话 → Agent 真实回复 8.4s）；技能中心 13 卡片、主题三态、Like 4 字段、抽屉、禁用导航、模式切换。

**收尾**：删除旧壳（`ChatView/SessionSidebar/ChatHeader/PlaceholderView`）/ 右栏三件套 / `useResizable` / 未引用 ui 件（Tooltip/IconButton/ToolCard）；`main.ts` 移除全局 ripple。

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
| GET | `/api/v1/sessions/:id/snapshot` | 完整当前状态（含核心 Goal/Todo 快照） |
| POST | `/api/v1/sessions/:id/goal/refine` | LLM refine，失败回退原始描述 |
| POST | `/api/v1/sessions/:id/goal` | 创建或显式 replace Goal、配置预算并启动 objective |
| PATCH | `/api/v1/sessions/:id/goal` | 更新 objective 和/或预算 |
| POST | `/api/v1/sessions/:id/goal/pause` | 暂停 Goal |
| POST | `/api/v1/sessions/:id/goal/resume` | 恢复 Goal 并继续执行 |
| POST | `/api/v1/sessions/:id/goal/cancel` | 取消 Goal |
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
  goal: GoalSnapshotData | null;
  todos: TodoItem[];
}

// Goal/Todo 状态事实源始终是核心：先订阅事件再读取初始 RPC，
// 用 revision 防止旧 RPC 覆盖新事件；实时更新沿用统一 journal/seq/epoch。
// REST 结果仅确认 mutation 已接受，不作为前端状态副本。

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
- **journal 分层持久化**：durable 事件落盘，volatile 流式事件仅实时发送；统一复用 seq/epoch 恢复协议。

## 7. 下一步建议

### Phase 7：视觉细节整改（框中框 / 控件度量统一）✅ 已完成

**背景**：浏览器实测发现"输入框框中有框、功能区不协调"是可量化的度量混乱，不是主观审美问题。全部结论来自 `getComputedStyle` 实测。

| 缺陷（实测） | 根因 | 处置 |
|---|---|---|
| 对话页正文/输入框满幅 1144px，首页只有 840px | `.chat-column { flex: 1 }` 的 `flex-basis` 覆盖了同规则的 `width: min(840px,100%)`，上限从未生效 | 改 `flex: 1 1 auto` + `max-width: var(--content-max)`；实测正文列 840、内容 796 |
| 输入卡内一行控件高度 20/32/34/40 混排、圆角 6/8/999 混排、边框三种流派 | 各按钮各自定义盒模型 | 统一「32px 高 / `--radius-md` / 无边框 / 透明底，hover 才给底色」；状态 chip 只靠底色区分；发送钮 32×32 实心 |
| 执行模式、抽屉 Tab 都是「胶囊套胶囊」 | 外层容器也画了边框+底色 | 外层去框去底色（透明分组），只保留选中态填充 |
| 工具折叠是 1080px 宽、58px 高、带 34px 图标的大卡，且 `running` 自动展开 | 折叠容器与内容同层级都带框 | 折叠态 = 一行 32px 文本（chevron + 状态点 + `已完成 N 项 · M 步` + 工具名）；**只有展开时**才有 1px 外框，内层工具卡圆角降为 `--radius-sm`（8→6 嵌套正确） |
| 抽屉 5 个面板**全部被裁切**（实测：渲染 52/195/85/139/204px，内容需要 142/550/177/332/517px），且 `scrollHeight == clientHeight` 连滚动条都不出现 | `.drawer` 是定高 flex 容器，面板作为 flex item 默认 `flex-shrink: 1`，1718px 内容被等比压进 798px，溢出部分被 `overflow:hidden` 剪掉 | 工具栏固定 + `.drawer-body` 作为唯一滚动容器，且 `.drawer-body > * { flex-shrink: 0 }`；实测 5 张卡 158/591/145/335/510px 全部自然高度、`clipped:false`，body 1818/750 正常滚动 |
| 抽屉里 5 层框中框、5 份 `.panel-section` 各自定义（圆角 12 vs 14、内距 0 vs 16 vs 17），且同列混用两套 section 语汇（可折叠 `.panel-head` vs 不可折叠 `.section-heading`，标题字号 14 vs 16、图标有的有有的没有） | 复制粘贴式样式 | 收敛为**「一模块一卡 + 卡内全扁平」**：卡片是唯一边框层（1px line / radius 12 / surface 底），卡间 12px 间距（实测 gap 全 12）；头部统一两行解剖 `[22px icon chip] [标题 13/650] [tail]` + 第二行提示 11px，实测 5 个头部全 55px、下方 1px 发丝线（折叠时通过 `.is-open` 变透明，避免与卡片底边叠成双线） |
| 模块之间「不好区分、挤在一起」——同质行密排，没有各自的信息设计 | 只做了统一，没做分层 | 每个模块按内容类型单独排版：运行状态=2 列 stat 网格（连接点+文字、上下文环+百分比、Token 宽行 mono）；Git=状态字母徽标 + mono 路径行 + 8 行上限与「显示全部 N」+ diffstat 沉底块（去掉内滚槽）；核心 Todo=进度条 + 阶段分组 + 每项左侧 2px 状态轨（进行中 accent / 完成 success）；偏好=发丝分隔的 `64px + 1fr` key/value 行（长值换行不挤压）；Goal=目标/验收标准两级排版 + 预算 stat 列表（右侧 mono 数值 + 4px 进度条）+ 底部动作栏 |
| 抽屉宽度实测 312px，而 token 是 360px | 同 `flex-shrink` 陷阱：`.drawer` 作为 flex item 被压缩 | `flex: 0 0 var(--rightbar-width)`，实测 360px；移动端绝对定位补 `max-width: 100vw` |
| 偏好设置标题左侧图标是空白 | 模板用了 `SvgIcon name="heart"`，而图标集里**没有 heart** → 渲染成空 svg | 换成集内已有的 `settings`；顺带把 `LikePanel` 自绘弹窗的 `z-index: 50` 提到 `var(--z-modal)`（移动端抽屉是 `z-index: var(--z-overlay)` 层，50 会被抽屉盖住） |
| 截图复核：一列 5 个模块看起来仍是"5 个黑块" | 图标芯片底色 `accent-soft` + 字形 `#111`，与标题同权重，芯片比标题还抢 | 芯片底改 `--color-surface-sunken`、字形改 `--color-text-muted`（实测 `22×22 r6`），识别信息交回标题与尾部状态 |
| 截图复核：Git 列表 74 个深灰状态块 + 长路径被裁成 `src/web/frontend/src/com…nents/App.vue`（省略号跑到中间） | 状态徽标用实心底色块；路径用 `direction: rtl` 做首端省略，而 `/` 是 bidi 中性字符会被重排 | 状态改"着色文字"（M 灰 / A·R 绿 / D·U 红 / ? 黄，无底块）；路径改 `utils/pathLabel.ts` 按段裁剪：≤34 字符全显，否则 `…/<父目录>/<文件名>`，**文件名永不丢**（实测 8 行 `dirClipped/baseClipped` 全 false） |
| 抽屉右上角"收起"用 `>` 箭头，读起来像"下一个" | 内联 SVG 语义不符 | 换 `SvgIcon name="panel-right"` |
| Git 列表 74 行挤在 24vh 内滚槽里 | 用内部滚动代替分层 | 默认 8 行 + `显示全部 N 个文件` 平铺按钮（实测 count=8，按钮文案 `显示全部 76 个文件`），去掉内滚槽 |
| **Git 点文件不显示 diff（截图上每个文件点了都没反应）** | **一条链路混了两种路径基准**：`git status` 的 porcelain 路径是仓库根相对，`getGitStatus` 剥掉 `apps/scream-code/` 前缀后传给 UI；而 `getGitFileDiff` 又给 UI 路径加 `../..` 前导（爬回仓库根）→ 嵌套文件解析到不存在的路径，`git diff` 静默返回空 patch；未跟踪文件 `git diff` 本来就无内容 → 也空。两条失败叠加 = "点了不显示" | 基准统一：`GitFileChange.path` 恒为**仓库根相对**（API 与 UI 直通），新增 `displayPath` 只用于展示；`getGitFileDiff` 改为 `git -C <repoTop> diff -- <repoRootRelative>`；未跟踪文件**合成 added-file patch**（`--- /dev/null` + 每行 `+`，512KB/二进制/非文件各有说明文案）；`FileAccessError` 补进 `toHttpError` 映射（越界从 500 变 403）；diff 卡 `max-height:40vh` 内部滚动（原可长到 2800px 撑穿一列）+ `scrollIntoView` 定位。实测：嵌套 M 文件 `+102 −7`、未跟踪 `+31`、越界 403 |
| 行上无 +/- | numstat 只有 tracked 有数值 | 每行加 `.git-file-stat`（绿 +N / 红 −N，numstat 逐文件解析，含 rename 归一 `normalizeNumstatPath`）；未跟踪行无计数，展开 diff 后头部按合成 patch 补 `+N` |
| 历史消息的工具没有 output 时永久显示「执行中」+呼吸点+自动展开 | `toolStatus` 把 `output === undefined` 直接当运行中，不区分回合是否存活 | 新增 `unknown` 态与 `live` 参数（`utils/toolGroup.ts`），`MessageItem` 传 `:live="streaming"`；实测恢复后显示「已完成 1 项」/「结果未持久化」 |
| 消息左右各 32px 内缩 + 气泡双层渐变描边 + 骨架屏残留 28px 头像占位 | 头像移除后的遗留度量 | 消息内缩改 `--space-5`（与输入卡同一条左右边界）；气泡单层 1px 边框 + `--radius-lg`；删 `.sk-avatar` |
| 滚动条 8px 抢内容 | — | 4px（thumb 用 `--color-line-strong`，hover 变 muted） |

**验收**：`web:typecheck` 0 错误；`test/web` **57/57** 通过（新增 4 条折叠状态回归 + 4 条 `splitPath` 回归）。浏览器量测：首页/对话页控件高度全等 32、圆角一致、列宽 840 生效；抽屉 5 张卡 331px 宽 / radius 12 / 卡间距 12 / 头部 55px / 芯片 22×22 / `clipped:false` / body 1818-750 正常滚动 / 无横向溢出（`overflowCount:0`）/ 折叠开关与 `localStorage` 记忆正常 / 文件页签正常 / Git 8 行上限 + 路径零裁切。
> 注：视觉复核拿到过一次「一模块一卡」整体截图（据此发现并修掉图标芯片过重、状态色块、路径中段省略号三处问题）；最后一轮细修后的截图因 chrome-devtools 截图接口连续超时未补上，几何与计算样式已逐项量测。

### 追加：侧栏折叠、模式文案、聚焦双框

| 项 | 取证 | 处置 |
|---|---|---|
| 「输入框点进去里面还有一个输入框」 | 聚焦 textarea 时实测 `.composer-input` 带 `box-shadow: rgba(17,17,17,.12) 0 0 0 3px`（全局 `:focus-visible` 环），而 `.composer:focus-within` 卡片自己也在画高亮 → **两层框叠成框中框** | 只抑制输入类控件的默认环（`.composer:focus-within :is(textarea,input):focus-visible`），卡片成为唯一高亮层；按钮保留焦点环——实测 Tab 到 `.quick-action` 仍是 `outline 2px + ring`，键盘可达性不回退 |
| 首页模式文案 | — | `智能对话 → 智能工作`、`任务执行 → 任务模式`（`ModeSwitch.vue`），同步更新断言 |
| 左侧侧栏折叠 | 需求 | 288px ↔ **64px 图标窄栏**：新增 `--sidebar-width-collapsed`，`.shell.sidebar-collapsed` 改 grid 轨道并与侧栏同缓动；窄栏隐藏品牌词/搜索/文字标签/身份文案，空间收成首字母点（当前会话所在空间高亮），点空间点即展开；`localStorage['scream-sidebar-collapsed']` 记忆；⌘K 在窄栏下先展开再聚焦；`prefers-reduced-motion` 关过渡 |

**追加验收**：`web:typecheck` 0 错误、`test/web` 57/57；浏览器实测折叠 288↔64、窄栏 `dots:["S"]` 且 active 高亮、文字项全隐、⌘K 展开+聚焦成功；聚焦输入框后内部环 `none` 而卡片 `#111 边框 + 3px glow` 唯一高亮，Tab 到按钮焦点环仍在。

### Phase 7.1：发版前全面审查（本轮结论）

| 级别 | 发现 | 取证 | 处置 |
|---|---|---|---|
| **P0** | 项目级 `pnpm typecheck` 失败（`server.ts:618`） | `web:typecheck` 只查前端，服务端类型错误此前从未被跑到；根因是我把 `displayPath` 设为必填而 `parsePorcelainFiles` 仍返回 `{path,status}` | `parsePorcelainFiles` 改返回原始 porcelain 结构，由 `getGitStatus` 负责富化 → 双 typecheck 均 0 错误 |
| **P1** | 我把抽屉原语写成了**全局裸类名**，会污染同名 scoped 类 | 计算优先级：scoped `.x[data-v]`(0,2,0) 只覆盖它**自己声明**的属性，我未声明的 `flex-direction`/`width`/`display` 会漏进 `TurnStats .stat`、`ApprovalCard .icon-btn`、`ThinkingBlock .panel-body`（三者都是条件渲染，当前 DOM 看不到但真实回合会触发） | 33 个选择器统一收进 `.panel-section` 作用域；实测抽屉无回归（headH 55 / chip 22×22 / pad 12 / 无裁切） |
| **P1** | 我新写的 `getGitFileDiff` 只做字面 `resolve()` 收敛，**符号链接可逃逸**读仓库外文件 | `files.ts` 明确用 `realpath` 收敛（注释写明防 symlink 逃逸），我的未跟踪文件合成分支用 `stat`+`readFile` 会跟随符号链接 | 读盘前补 `realpath` 双端收敛校验并改读 `realAbs`，与 `files.ts` 同一标准 |
| **P2** | 折叠按钮 `aria-expanded` 写死 `"false"` | 模板硬编码 | 改绑 `!collapsed`，实测展开态返回 `true` |
| **P2** | 移动端抽屉实例也渲染折叠按钮，点击会翻动桌面端专属 grid 轨道并写 localStorage | 组件复用未区分场景 | 新增 `showCollapseToggle`（默认 true），移动端传 false |
| **P3** | `suspended` 工具被 `aggregateStatus` 归为 ok → 挂起调用显示绿点 + "已完成 N 项" | 聚合函数未覆盖该分支 | 加 `suspended` 优先级 + 橙色点 + "含挂起等待" |
| 卫生 | 源码注释里出现外部项目名 3 处（其中 2 处是我这几轮写的） | `grep 参考实现` | 全部改为中性描述，代码内已 0 命中（`ROADMAP.md` 作为规划文档仍保留该词，如需一并清可说） |

**发布门禁实测**：`pnpm typecheck` 0 错误 · `pnpm web:typecheck` 0 错误 · 全量 `vitest run` **1307 passed / 4 skipped（146 文件）** · `pnpm build` 通过 · `dist/public` 3.5M / assets 10 个（清理脚本生效，无陈旧 hash）· 冒烟：index/sessions/git-status 200、`git/diff` 正常、越界 403。
**注意**：仓库**无 lint 脚本**（`package.json` 未配置），代码风格仅靠 typecheck 兜底。

### 死代码审计（脚本化全树扫描）

| 类别 | 结论 |
|---|---|
| 未被 import 的前端模块/组件 | **0**（11 个已删组件也无残留引用；`.assistant-avatar` 只剩一条 `exists()===false` 回归断言，属有意保留） |
| server.ts 定义了却从未调用的函数 | **0** |
| 未使用的 import | 1 个（`SessionDrawer.vue` 的 `watch`，重构遗留）→ 已删 |
| 死 CSS 类 | 21 个候选中 20 个是**假阳性**（`<Transition name>` 生成的 `*-enter/leave`、`toast--${type}`、`dl-${line.type}` 动态拼接）；真死 1 个 `.todo-groups` → 已删 |
| 死函数/死类型 | `utils/toolGroup.ts` 的 `groupConsecutiveTools()` 与只服务于它的 `ToolGroupData`（全树含测试零引用）→ 已删 |
| 孤立 design token | 删 6 个：`--font-size-3xl`、`--stagger-step`（本轮引入未用）+ `--topbar-height`、`--surface-light`、`--surface-dark`、`--accent-primary-light`（被本次 UI 重写孤立的旧顶栏/旧调色板残留）；保留 `--space-7`/`--font-size-xl`/`--radius-2xl`/`--z-base`/`--z-dock` 这类刻意标度步长 |
| 构建产物会否误提交 | `src/web/frontend/dist`(3.5M) 与 `dist/` 均被根 `.gitignore:2 dist/` 覆盖，跟踪数 **0** ✓ |
| diff 工具链是否整条死掉 | `buildEditDiff → computeDiff/diffStats` 有活跃调用方（EditToolCard）✓ |

**清理后复验**：`typecheck` + `web:typecheck` 均 0 错误；全量 `vitest run` **1307 passed / 4 skipped**；`pnpm build` 通过；冒烟 index/sessions/diff=200、越界=403；`dist/public` 3.5M / assets 10。
**发布链**：`prepublishOnly → scripts/verify-publish.mjs` 会**重新跑完整 build** 并断言版本注入、保留 `dist/public`，所以本地 dist 陈旧不影响发布产物；`files: ["dist","icon.ico"]` → 源码与 300KB 的 `apps/scream-code/logo-v2.svg` 原件不进包（真正进包的是 `dist/public/assets/logo-v2-*.svg` 135KB 优化版）。

### 追加：品牌改为 logo-v2 文字标

| 事项 | 取证 | 处置 |
|---|---|---|
| 左上角品牌替换 | 旧实现是手绘 `.brand-mark`（30px 墨块 + "s" 字形）+ `.brand-word` 文本 | 改为引用 `logo-v2.svg`：`import logoUrl from '../assets/logo-v2.svg'` + `<img class="brand-logo" alt="scream">`；展开态实测 99×22，窄栏态 42×9（头部改竖排，logo 在上、折叠按钮在下——原先窄栏是 `display:none` 整个品牌，换 logo 后必须露出） |
| 暗色主题不可见 | 该 SVG 是位图描摹产物，填充为 `rgb(2,3,1)` 纯黑、无 `currentColor`；暗底渲染实测与背景同色 | 不额外做第二份文件：`:root[data-theme='dark'] .brand-logo { filter: invert(1) grayscale(1) }`，实测暗色下反相为白且清晰 |
| 300KB 描摹文件 | 1610 条 path / 300197B（gzip 41KB）；坐标取整无收益（本来就 ≤2 位小数） | 按样式分组（fill / fill-opacity / stroke / stroke-width / stroke-opacity / opacity / fill-rule 七元组）合并为 **11 条 path**，134990B（**−55%**，gzip 38KB）。合并会把子路径并进同一 nonzero 规则，因此做像素回归：与合并前渲染逐像素比对，差异 973px（0.118%）、最大灰度差 7/255，字母内洞未被填死 |
| 构建脚本不清理产物 | 换 hash 后 `dist/public/assets` 同时留 300KB 旧 logo 与新 logo，共 27 个陈旧 chunk | `copy-web-assets.mjs` 复制前 `rm -r dist/public/assets`，实测 27 → 10 |

**首页大标题同步**：`.workspace-brand` 从 56px 文字 `scream` 换成同一 logo（`<h1><img class="brand-logo" alt="scream"></h1>`，实测 **269×60**、`naturalWidth>0`、与侧栏 `src` 完全一致 → 浏览器只发一次请求）。文字标字母带只占画布高约 59%，所以图片高度取 60px 才能顶住原来 56px 字重的观感；移动端 42px。暗色同样 `invert(1) grayscale(1)`。a11y 上 `alt` 承担标题的可访问名，测试断言从 `.text() === 'scream'` 改为校验 `img.alt`。

**说明**：`apps/scream-code/logo-v2.svg` 原文件未改动，前端资源目录里是**优化后的副本**（唯一被打包进产物的那份）。若希望仓库只留一份，可把组件的 import 改成相对引用 `../../../../../logo-v2.svg`，但那会让 `vite dev` 依赖 `server.fs.allow` 越出 frontend root，故当前保持前端目录内自持。

如果老板想继续推进，建议按顺序：

1. **REST 审批改造**（Phase 3 余项）：审批走 REST + 幂等，是审计与多人使用的基础。
2. **TLS/WSS 与公网映射**：下一个大版本主题。中继通道（自托管 relay，跑在用户自己的服务器上）+ 显式 opt-in；若做托管中继，端到端加密是硬前提。
3. **移动端独立 shell 与文件上传**：按需求排期。

### 发布级审查（第二轮，面向 `npm publish`）

| 级别 | 发现 | 取证 | 需要你决定 |
|---|---|---|---|
| **P0** | **干净检出必然构建失败**：已跟踪文件 import 了未跟踪文件 | `App.vue`(tracked) → `./components/WebShell.vue`(**tracked=NO**)；`server.ts`(tracked) → `#/web/auth`、`#/web/rateLimit`、`#/web/lan`、`#/web/files` 全部 **tracked=NO**。共 25 个未跟踪文件（整套新 UI + 7 个测试）与 11 个未 stage 的删除 | 发布前必须 `git add -A` 并提交；在 CI 或另一台机器上现在这份代码构建不出来 |
| ⚠️ | 版本状态不一致 | `package.json=0.15.0`；本地最新 tag `v0.14.5`；注册表最新 `0.14.9`；`npm view scream-code@0.15.0` → 404（未占用） | 直接 `npm publish` 发 **0.15.0**；跑 `release:patch` 会变 **0.15.1**（跳过 0.15.0）且它 `git push --follow-tags` 而本地缺 v0.14.6~9 → 先 `git fetch --tags` |
| ⚠️ | **source map 进包** | 包 34 文件 / 解包 12.5MB，其中 `index-*.js.map` 1.6MB + `wasm-*.map` 608KB + github-*.map ≈ **2.3MB**，并完整暴露前端源码；开关 `frontend/vite.config.ts:36 sourcemap: true` | 关或留（关掉省约 18% 体积且不泄源） |
| ℹ️ | 会话列表是**内存态**，服务重启后侧栏从空开始 | `SessionManager` 只有 `Map`，`list()` 读内存；全文件 grep `restore/loadFromDisk/readdir sessions/session_index` **0 命中**。磁盘 141 条会话索引完好（**不是数据丢失**） | Phase 4 的"刷新页面后历史消息完整恢复"只在同一进程内成立，跨重启不成立——补恢复还是改措辞，你定 |
| ✅ | 包内容完整 | `dist/public/index.html` + `assets/*`（含 logo 135KB）+ `gateway.html` + `dist/main.mjs` 及其全部 chunk 依赖均在包内；LICENSE/README 在 | — |
| ✅ | 无硬编码密钥 | 未提交 diff 扫描 api_key/secret/token/sk-/ghp_/AKIA/bearer：2 处命中均为文档行与横幅文案 | — |
| ✅ | `prepublishOnly` 链可靠 | `verify-publish.mjs` 重跑完整 build 并断言 `dist/main.mjs` 存在、版本已注入、`dist/public` 保留 | — |
| ✅ | 运行时无报错 | 当前 bundle `index-B0XlDIOZ.js` 加载后 console 无 error/warn；空会话正确渲染 empty-state | — |
