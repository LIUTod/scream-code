# Scream Code - Claude 上下文知识库

本项目由 Claude Code 进行架构审查后建立，用于后续优化时提供上下文记忆。

---

## 项目概览

Scream Code 是一款中文 AI Agent CLI 助手，主打"你动嘴，它动手"的自然语言编程体验。
- 仓库：`/Users/tod/Desktop/scream-code`
- Monorepo：pnpm workspaces，10 个包
- 规模：~967 个 TS 文件，~49 万行代码（含测试 ~10 万行）
- 技术栈：TypeScript 6.0.2、Node.js >=22、pnpm 10.33.0、Vitest、oxlint、tsdown
- TUI 框架：`@earendil-works/pi-tui`（v0.74.2，pnpm patch）

## 架构分层

```
CLI (apps/scream-code/src/main.ts)
  → TUI (pi-tui components, scream-tui.ts)
  → SDK (ScreamHarness, @scream-cli/scream-code-sdk)
  → Agent Core (@scream-cli/agent-core)
  → LLM Providers (@scream-cli/ltod)
```

**关键规则**：`apps/scream-code` 只能通过 `@scream-cli/scream-code-sdk` 访问核心能力，**禁止**直接导入 `@scream-cli/agent-core`。

## Workspace 结构

| 包 | 职责 | 规模 |
|---|---|---|
| `apps/scream-code` | CLI/TUI 主应用 | ~186 文件，~50k 行 |
| `packages/agent-core` | Agent 引擎（最大包） | ~200+ 文件，~80k 行 |
| `packages/ltod` | LLM 提供商抽象 | ~20 文件，~5k 行 |
| `packages/jian` | 执行环境（本地/SSH） | ~10 文件，~3k 行 |
| `packages/memory` | 跨会话记忆 | ~8 文件，~2k 行 |
| `packages/config` | 配置管理 | ~7 文件，~1k 行 |
| `packages/node-sdk` | 公共 SDK | ~8 文件，~3k 行 |
| `packages/scream-code-sdk` | scream-code 专用 SDK | - |
| `packages/shared` | 共享工具 | - |
| `packages/telemetry` | 遥测 | ~5 文件，~1k 行 |

## 关键文件路径

```
入口链：src/main.ts → src/cli/commands.ts → src/cli/run-shell.ts → SDK → src/tui/scream-tui.ts

TUI 主协调器：apps/scream-code/src/tui/scream-tui.ts
Agent 核心类：packages/agent-core/src/agent/index.ts
Turn 循环：packages/agent-core/src/agent/turn/index.ts
工具并发执行：packages/agent-core/src/loop/tool-call.ts
权限引擎：packages/agent-core/src/agent/permission/
压缩管道：packages/agent-core/src/agent/compaction/{micro,full,strategy}.ts
记忆召回注入：packages/agent-core/src/agent/injection/memory-recall.ts
Session 记忆：packages/agent-core/src/agent/session-memory.ts
LLM 提供商工厂：packages/ltod/src/providers/index.ts
MCP 连接管理：packages/agent-core/src/mcp/connection-manager.ts
TUI 组件组织：src/tui/components/{chrome,dialogs,messages,panes}/
主题系统：src/tui/theme/{colors,styles,pi-tui-theme,bundle}.ts
斜杠命令：src/tui/commands/{registry,dispatch}.ts
开发指南：AGENTS.md
```

## 已知架构债务（P0 优先级）

### 1. ScreamTUI - God Class（1917 行，~30 个职责区块）
- **位置**：`apps/scream-code/src/tui/scream-tui.ts`
- **问题**：维护困难，变更易引发意外副作用
- **拆分方向**：
  - 事件路由 → `EventRouter`
  - 会话管理 → `SessionManager`
  - 流式渲染 → `StreamingCoordinator`
  - 对话框管理 → `DialogManager`

### 2. Agent 类过大（~20 个子系统注入）
- **位置**：`packages/agent-core/src/agent/index.ts`
- **问题**：测试困难，初始化复杂，职责边界模糊
- **拆分方向**：内部子系统不变，对外暴露使用 Composition + Facade 模式

### 3. TurnFlow 过大（870+ 行）
- **位置**：`packages/agent-core/src/agent/turn/index.ts`
- **问题**：包含流式处理 + 重试 + 工具调度，单一职责原则被违反
- **拆分方向**：`StreamingController` + `RetryCoordinator` + `ToolDispatcher`

### 4. 其他大文件
- `tool-call.ts` 消息渲染：1877 行
- `approval-panel.ts`：425 行
- `question-dialog.ts`：801 行

**红线规则**：单文件不超过 500 行（组件不超过 400 行），应纳入 CI 检查。

## 核心子系统

### 权限引擎
- 14 条策略按序评估，deny 优先
- 三种模式：manual（每次询问）、yolo（自动批准工作区工具）、auto（全自动）
- 敏感文件（.env、SSH keys）即使在 yolo 模式下也要求确认
- Session 级临时规则支持"Approve for session"

### 上下文压缩管道
- Stage 1 Micro（零 LLM）：截断旧工具结果为占位符，>=50% 触发
- Stage 2 Full（一次 LLM）：LLM 摘要旧消息，>=75% 触发
- Stage 3 Block（安全网）：阻塞 turn 直到压缩完成，>=85% 触发
- 预测性触发：估计下一步 token 增长提前压缩
- 断路器：3 次连续失败 → 当前 turn 禁用自动压缩
- Overflow fast-fail：API 返回上下文溢出时不再重试，直接上报

### 记忆系统
- 存储：`<project>/.scream-code/memory/entries.jsonl`
- 分类：user_preference、feedback、project_context、reference
- 自动提取：compaction 和退出时 LLM 驱动提取
- 评分：关键词重叠 + 时间衰减 + 分类权重 + 状态提升（零 LLM 成本）
- Auto Recall：每轮首步自动查找 top-3 相关记忆注入 system-reminder
- **已知问题**：JSONL append-only 无压缩/GC，文件会无限增长

### Dream 整理（/dream）
- CCB 四阶段：Orient → Gather → Consolidate → Prune
- 自动提醒：>=24h 且 >=5 sessions 后首次 step 注入建议
- 存储：`<project>/.scream-code/dream-lock.json`

### Power 并行模式（/power）
- 内置五类子 Agent：coder、explore、plan、verify、writer
- 并发执行通过 `Promise.allSettled`
- **限制**：简单 boolean toggle，无子 Agent 配置 UI

### MCP 扩展
- 配置：`~/.scream-code/mcp.json`（用户级）+ `<cwd>/.scream-code/mcp.json`（项目级）
- 内置推荐：Playwright（浏览器自动化）
- 连接管理：addServer / stopServer / removeServer / reconnect

### 主题系统
- 语义 token：`ColorPalette`，darkColors / lightColors
- WCAG AA 合规（文本 4.5:1，边框/大元素 3:1）
- **禁止**：使用 `chalk.red`、`chalk.cyan` 等具名颜色
- **必须**：`chalk.hex(colors.token)` 或 `styles.helper()`
- 主题切换后单 render 周期内生效，不可缓存 styled chalk 函数

### 会话管理
- 创建/恢复/切换/关闭/浏览历史
- Resume replay：通过 live render hooks 回放历史事件恢复 UI 状态
- 存储：`<project>/.scream-code/sessions/` 下的 wire protocol JSONL

## 安全要点

| 机制 | 状态 |
|---|---|
| 路径沙箱 | ✅ strict / absolute-outside-allowed / disabled 三模式 |
| 敏感文件检测 | ✅ .env、SSH keys 等 |
| 权限引擎 | ✅ 14 条策略 |
| Git 目录保护 | ✅ 写入前询问 |
| API Key 遮罩 | ✅ 专用对话框 |
| 日志脱敏 | ✅ 可配置 |
| Symlink 跟随 | ⚠️ 不跟随，注释已标记为限制 |
| MCP 工具冲突 | ⚠️ 静默丢弃，仅 emission 事件 |

## 已审查确定的改进优先级

### P0 - 立即（影响项目健康）
1. 拆分 ScreamTUI → EventRouter / SessionManager / StreamingCoordinator / DialogManager
2. 拆分 Agent 类 → Composition + Facade
3. 设定文件大小红线：单文件 <= 500 行，组件 <= 400 行，纳入 CI

### P1 - 短期（3-4 周）
4. 国际化框架：提取中文硬编码，建立 zh-CN/en 字典
5. 填充 docs/ 目录（用户手册、架构图、开发指南、API 参考）
6. JSONL 文件 GC：记忆和 wire records 定期 compaction/归档
7. 客户端速率限制：LLM 调用 token bucket 限流
8. CI 依赖图分析：madge/skott 检测循环依赖

### P2 - 中期（1-3 月）
9. Power 模式配置 UI：选择子 Agent、并发数限制
10. LLM 提供商插件化：配置文件/约定注册，不修改工厂代码
11. 自定义主题：用户可定义 ColorPalette
12. Web GUI 原型：Electron/Tauri 桌面端
13. 覆盖率门禁：设定并强制执行阈值

### P3 - 长期（3-6 月）
14. Agent 编排可视化：Power 模式显示子 Agent 执行 DAG
15. 智能 API Key 管理：OAuth 自动刷新
16. 团队协作：会话共享、团队记忆空间

## 审查结论

**综合评分：A-**

最大优势：架构分层清晰、安全权限体系完善、记忆系统设计出色、中文本地化体验优秀。

最大风险：核心类过大（ScreamTUI / Agent / TurnFlow），直接影响长期维护成本和新人上手速度。

## 关键规则与禁忌

- **禁止**：`apps/scream-code` 直接导入 `@scream-cli/agent-core`
- **禁止**：组件中使用 chalk 具名颜色（`chalk.red`、`chalk.cyan` 等）
- **禁止**：键盘输入比较使用 `data === 'q'`，必须使用 `printableChar(data)`
- **禁止**：TUI 组件直接调用 SDK 或直接读写 session 状态
- **禁止**：创建通用测试文件（some-feature.test.ts），测试必须与具体功能对应
- **必须**：新增功能按 AGENTS.md 规则放入对应目录
- **必须**：常量放入对应 `constant/` 目录，不要散落在组件代码中
- **必须**：无状态/无副作用函数提取为外部 utils，不作为 ScreamTUI 私有方法
