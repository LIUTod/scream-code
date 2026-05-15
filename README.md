# Scream Code CLI

> 一个会写代码的终端助手 —— 你说话，它干活。

**Scream**（尖叫）是一款运行在终端里的 AI 编程助手。你不用记复杂的命令，直接用中文或英文告诉它想做什么，它就会帮你写代码、改文件、查资料、跑程序。

---

## 适合谁用？

| 人群 | 你能用它做什么 |
|------|---------------|
| **零基础想学代码** | 告诉它"帮我写一个计算 BMI 的网页"，它直接生成完整代码并解释每行是什么意思 |
| **普通工作者** | 批量重命名文件、从网页抓取数据、自动生成 Excel 报表、写邮件脚本 —— 不用学 Python |
| **专业工程师** | 自动重构代码、批量迁移项目、生成单元测试、分析代码库架构、作为 IDE 的 ACP 后端 |

---

## 三分钟上手

### 第一步：安装

```bash
# 克隆仓库
git clone https://github.com/LIUTod/scream-code.git
cd scream-code

# 安装依赖（需要 Python 3.12+ 和 uv）
make prepare

# 或者使用 pip
pip install -e .
```

> **Windows 用户注意**：如果没有 `make`，直接运行 `uv sync --all-packages` 即可。

### 第二步：启动并配置 AI 服务

```bash
scream
```

首次启动时，如果检测到没有配置模型，会自动进入交互式配置向导（`/config`）。按提示输入 API 地址、密钥、模型型号即可完成配置。

**也支持手动创建配置文件** `~/.scream/config.toml`：

```bash
mkdir -p ~/.scream
cat > ~/.scream/config.toml << 'EOF'
default_model = "gpt-4o"

[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-你的密钥放这里"

[models.gpt-4o]
provider = "openai"
model = "gpt-4o"
max_context_size = 128000
EOF
```

**支持多个模型**（配置好后可用 `/model` 随时切换）：

```toml
default_model = "gpt-4o"

[providers.openai]
type = "openai"
base_url = "https://api.openai.com/v1"
api_key = "sk-xxx"

[providers.deepseek]
type = "openai"
base_url = "https://api.deepseek.com"
api_key = "sk-xxx"

[models.gpt-4o]
provider = "openai"
model = "gpt-4o"
max_context_size = 128000

[models.deepseek-chat]
provider = "deepseek"
model = "deepseek-chat"
max_context_size = 64000
```

> 支持所有 OpenAI 兼容的 API（DeepSeek、Moonshot、通义千问、硅基流动等）。

配置完成后，在交互模式下输入 `/model` 即可切换模型，无需重启。`/config` 支持追加配置，不会覆盖已有模型。

### 第三步：开始使用

```bash
# 进入交互模式，像聊天一样使用
scream

# 或者直接让它执行一个任务
scream -p "帮我把当前目录下所有 .txt 文件合并成一个 all.txt"
```

---

## 实际使用示例

### 示例 1：零基础 —— 做一个 Todo 网页

```
你：帮我做一个简单的 Todo 列表网页，可以添加和删除任务

Scream：（自动生成 HTML + CSS + JS 文件）
  ✓ 已创建 todo.html
  ✓ 已创建 todo.css
  ✓ 已创建 todo.js

生成的网页支持输入任务、点击完成、删除任务，
数据保存在浏览器本地存储中。
```

### 示例 2：普通工作者 —— 批量处理 Excel

```bash
scream -p "读取 data.xlsx，统计每个城市的销售额，
           生成一个汇总表并保存为 summary.xlsx"
```

### 示例 3：工程师 —— 重构代码

```bash
scream -p "把 src/utils.py 里的重复逻辑提取成公共函数，
           确保所有测试仍然通过"
```

### 示例 4：继续之前的工作

```bash
# 昨天让它写了一半的程序，今天继续
scream -C
```

---

## 交互模式里的常用操作

进入 `scream` 后，你会看到一个聊天界面。除了直接打字提问，还可以使用**斜杠命令**：

| 命令 | 作用 |
|------|------|
| `/config` | 交互式添加模型配置（支持多模型，追加不覆盖） |
| `/model` | 切换当前使用的模型，或删除不再使用的模型 |
| `/yolo` | 切换"大胆模式" —— 自动批准所有操作（适合信任的任务） |
| `/plan` | 进入计划模式 —— 先制定方案，不执行任何修改 |
| `/memory add 我喜欢用单引号` | 告诉它你的偏好，它会记住 |
| `/memory list` | 查看它记住了什么 |
| `/memory search <关键词>` | 搜索相关记忆 |
| `/memory delete <ID>` | 删除指定记忆 |
| `/compact` | 聊天记录太长时压缩上下文 |
| `/clear` | 清空当前对话 |
| `/export` | 导出整个对话为 Markdown 文件 |

### 审批面板

当它要修改文件或执行命令时，会弹出审批面板：

```
[1] 仅批准一次    [2] 本次会话都批准    [3] 拒绝    [4] 拒绝并说明原因
```

按数字键选择，回车确认。所有提示都是中文。

---

## 核心功能

- **对话式编程** —— 用自然语言描述需求，它自动写代码、改文件、跑命令
- **安全第一** —— 修改文件前必须征得同意，`.env` 等敏感文件默认禁止操作
- **权限引擎** —— 精细控制它能做什么（读取/写入/执行），防止误操作
- **记忆系统** —— 记住你的编码偏好，跨会话保持上下文
- **会话恢复** —— 随时中断，随时继续，对话历史自动保存
- **多模式** —— 交互模式、静默模式、计划模式、后台任务模式
- **MCP 扩展** —— 连接外部工具（数据库、浏览器、API 等）
- **子代理** —— 复杂任务自动拆解为多个子任务并行执行
- **Skill 自定义** —— 在 `.scream/skills/` 下添加自定义技能，扩展助手能力

---

## 进阶配置

### 自定义权限规则

在 `~/.scream/config.toml` 中添加：

```toml
# 禁止执行任何命令（最严格的模式）
[[permission_rules]]
tool_pattern = "run command"
action = "deny"

# 允许自动编辑 Markdown 文件
[[permission_rules]]
tool_pattern = "edit file"
action = "allow"
path_pattern = "*.md"
```

规则动作说明：
- `allow` —— 自动通过，不弹审批
- `ask` —— 每次都要你确认
- `deny` —— 直接拒绝，不弹审批

### 自定义 Skill

在项目的 `.scream/skills/` 目录下创建文件夹，每个 Skill 是一个包含 `SKILL.md` 的文件夹：

```
.scream/skills/
├── my-skill/
│   └── SKILL.md
└── code-style/
    └── SKILL.md
```

`SKILL.md` 格式：

```markdown
---
name: my-skill
description: 触发条件描述，Scream 会根据描述决定何时调用此 Skill
---

# Skill 内容

## 策略

1. 步骤一
2. 步骤二
```

项目级 Skill 优先级高于内置 Skill 和用户级 Skill。同名 Skill 以项目级为准。示例参考 `.scream/skills/custom-helper/`。

### 配置项速查

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `default_model` | `""` | 默认使用的模型 |
| `default_thinking` | `false` | 是否显示 AI 的思考过程 |
| `default_yolo` | `false` | 默认自动批准所有操作 |
| `theme` | `"dark"` | 终端主题（`dark`/`light`） |
| `telemetry` | `true` | 匿名使用数据上报（可关闭） |

---

## 参与开发

### 环境准备

```bash
git clone https://github.com/LIUTod/scream-code.git
cd scream-code
make prepare        # 安装依赖和 git hooks
```

### 常用命令

```bash
make format         # 格式化代码
make check          # 类型检查和 lint
make test           # 运行测试
make build          # 构建发布包
```

### 技术架构（给开发者）

```
scream-code/
├── src/scream/
│   ├── cli/              # Typer CLI 入口
│   ├── soul/             # 核心代理循环（ScreamSoul）
│   │   ├── approval.py   # 审批系统 + PermissionEngine
│   │   ├── screamsoul.py # 主循环（LLM 调用 → 工具执行 → 上下文管理）
│   │   └── slash.py      # 斜杠命令注册
│   ├── tools/            # 内置工具（文件、Shell、Web、Agent）
│   ├── ui/shell/         # 交互式终端 UI
│   ├── permission/       # 权限规则引擎
│   ├── memory/           # 持久化记忆系统
│   └── wire/             # UI 与核心的事件传输层
├── packages/
│   ├── ltod/             # LLM 抽象层（消息、工具、Provider）
│   └── kaos/             # OS 抽象层（文件、命令、路径）
└── tests/                # 测试套件
```

**核心设计决策**：
- PermissionEngine 在审批 UI 之前做前置过滤，yolo/afk 始终优先
- Memory 使用 DynamicInjectionProvider 模式，不修改系统 prompt 模板
- 双作用域记忆：project 级随项目走，global 级跨项目共享
- 汉化只改用户可见字符串，内部协议字段保持英文

---
## 迭代贡献指南

欢迎贡献！无论是 bug 修复、功能改进还是文档完善。

- 大改动（>100 行）建议先开 Issue 讨论
- 提交前运行 `make format` 和 `make check`
- 代码质量对标前沿 AI 编码水平

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 感谢支持
— 因个人使用习惯，部分UI及交互设计参考kimicli、Geminicli，再次感谢优质项目提供交互灵感

---
## 许可证

[LICENSE](LICENSE)

---

**相关链接**

- 源码：https://github.com/LIUTod/scream-code
- 问题反馈：https://github.com/LIUTod/scream-code/issues
