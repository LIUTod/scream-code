# tool — Tool Registry & Runtime

## 职责
- 维护工具注册表（内置 + 用户 + MCP），`loopTools` 排序生成发往 LLM 的 tool schemas
- **注册入口（第三方扩展请走这里）**：
  - `registerUserTool(definition)` — 用户/插件工具
  - `registerMcpServer(...)` — MCP server 接入
  - 内置工具在 `tools/builtin/` 各自定义后注册
- 工具调度：执行工具调用（`runTool`），处理结果回写 context
- 参数校验：工具定义含 schema，调用时校验

## 依赖
- 依赖：`Agent`（hub）、MCP 客户端、BlobStore（大输出 offload）
- 被依赖：`AgentServices.tools`、`LtodLLM`（读 loopTools）、插件/技能加载

## 边界
- 不做：不实现工具的具体逻辑（那是各工具模块/插件的事）
- `loopTools` 顺序确定性：`.toSorted()` 排序——**不要破坏**（provider 前缀缓存依赖字节稳定）
- 注册是幂等的：同名工具注册需显式处理（用户工具覆盖内置？看调用点约定）
- MCP 工具随 MCP server 生命周期启停

## 扩展点
- 新增工具 = 调 `registerUserTool`（不碰核心）；未来 dsh 插件适配器也走这两个注册口
- 新工具能力分类（fs/lsp/web...）= 新 builtin 模块 + 注册
