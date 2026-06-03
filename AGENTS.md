# ScreamCode — Agent 开发说明

## 项目结构

```
scream-code/
├── apps/scream-code/         # TUI 终端应用（主入口）
│   └── src/tui/
│       ├── commands/         # 斜杠命令注册与分发
│       ├── components/       # UI 组件（chrome/消息/对话框）
│       ├── controllers/      # 控制器（会话事件/流式输出/任务管理）
│       └── theme/            # 主题系统
├── packages/
│   ├── agent-core/           # Agent 核心引擎
│   │   └── src/
│   │       ├── agent/        # Agent 生命周期与 Turn 管理
│   │       ├── loop/         # Agent 循环（工具调度/冲突检测）
│   │       ├── profile/      # Agent 配置文件（system.md/agent.yaml）
│   │       ├── session/      # 会话管理与子 Agent 主机
│   │       ├── skill/        # Skill 系统
│   │       └── tools/        # 内置工具（Agent/FanOut/Read/Write/...）
│   ├── node-sdk/             # Node.js SDK（供 TUI 调用）
│   ├── memory/               # 记忆备忘录系统
│   └── ltod/                 # LLM 对话协议层
└── install.sh                # 一键安装脚本
```

## 关键架构概念

### Agent 工具 `Agent`
- 文件：`packages/agent-core/src/tools/builtin/collaboration/agent.ts`
- 功能：生成一个子 Agent 执行单个任务（前台阻塞等待 / 后台异步）
- 子 Agent 类型：`coder` / `explore` / `plan` / `verify` / `writer`
- 子 Agent 有独立上下文窗口，结果通过 `SubagentHandle.completion` Promise 返回

### FanOut 工具 `FanOut`（并行编排）
- 文件：`packages/agent-core/src/tools/builtin/collaboration/fanout.ts`
- 功能：一次生成多个子 Agent 并行执行，等待全部完成后聚合结果
- 限制：最多 5 个并行，每个子 Agent 5 分钟超时
- 安全：ConflictTracker 扫描任务 prompt 中的文件路径，检测到重叠时自动注入安全警告
- 适用场景：扇出分析/对抗验证/多角度审查/跨模块重构

### 斜杠命令 `/fanout`
- 文件：`apps/scream-code/src/tui/commands/config.ts`
- 用法：`/fanout` / `/parallel` — 切换全局并行 Agent 模式
- 效果：开启后在底部状态栏显示蓝色 `fanout` 标记，Agent 优先使用 FanOut 并行派发独立子任务
- 别名：`/parallel`

### 子 Agent 主机 `SessionSubagentHost`
- 文件：`packages/agent-core/src/session/subagent-host.ts`
- 功能：管理子 Agent 的生成/恢复/取消生命周期
- 恢复：支持按 agentId 恢复子 Agent 继续工作
- 取消：`cancelAll()` 递归取消所有活跃子 Agent

### 工具调度器 `ToolScheduler`
- 文件：`packages/agent-core/src/loop/tool-scheduler.ts`
- 功能：同一 step 内的工具调用并发调度，基于文件访问冲突检测
- 冲突模型：`packages/agent-core/src/loop/tool-access.ts`

## 添加新斜杠命令的步骤

1. `registry.ts` — 注册命令名、别名、描述、优先级
2. `config.ts` — 实现 `handleXxxCommand` 处理函数
3. `dispatch.ts` — 导入并在 switch 中注册 case

## 添加新内置工具的步骤

1. 在 `packages/agent-core/src/tools/builtin/` 创建工具文件（实现 `BuiltinTool` 接口）
2. 在 `builtin/index.ts` 中导出
3. 在 `agent/tool/index.ts` 的 `initializeBuiltinTools()` 中实例化
4. 在 `agent.yaml` 的 `tools` 列表中启用
5. 如需模型使用指导，在 `system.md` 中添加说明

## FanOut 工具测试

```bash
# 运行 FanOut 单元测试
cd packages/agent-core && npx vitest run test/tools/fanout.test.ts

# 运行全部测试
cd packages/agent-core && npx vitest run

# 构建
pnpm -r build
```
