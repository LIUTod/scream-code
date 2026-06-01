<img width="1667" height="302" alt="截屏2026-05-31 20 53 26" src="https://github.com/user-attachments/assets/568d6a08-c251-4204-906d-16de9b304b90" />


# Scream Code

你的超级Ai个人助手。

Scream Code 是一款省心的中文 AI Agent 助手。无需硬记代码，直接用中/英文下达指令，vibe coding、写代码、改文件、清理电脑、查资料、制作研报、制作 skill、搜全网信息……你动嘴，它动手！

---

## 三分钟上手

### 第一步：安装

前置条件：**Node.js >= 22.0.0** 和 **Git**。

> **国内用户**：安装过程需从 GitHub 下载，建议科学上网，如遇网络错误请多尝试几次。

**推荐：一键安装（macOS / Linux）**

```bash
curl -fsSL https://raw.githubusercontent.com/LIUTod/scream-code/main/install.sh | bash
```

**Windows — PowerShell：**

```powershell
irm https://raw.githubusercontent.com/LIUTod/scream-code/main/install.ps1 | iex
```

安装完成后，`scream` 命令自动加入 PATH。首次安装约需 2-5 分钟。

**升级到新版本**

```bash
cd ~/.scream-code && ./install.sh --upgrade
```

**手动安装**（一键脚本不可用时的备用方案）：

```bash
# 1. 克隆仓库
git clone --depth 1 https://github.com/LIUTod/scream-code.git ~/.scream-code
cd ~/.scream-code

# 2. 安装依赖并构建
pnpm install && pnpm -r build

# 3. 手动创建命令并加入 PATH
mkdir -p ~/.scream-code/bin
cat > ~/.scream-code/bin/scream <<'EOF'
#!/usr/bin/env bash
SCREAM_HOME="${SCREAM_HOME:-$HOME/.scream-code}"
cd "$SCREAM_HOME"
exec node "$SCREAM_HOME/apps/scream-code/dist/main.mjs" "$@"
EOF
chmod +x ~/.scream-code/bin/scream
# 将 ~/.scream-code/bin 加入 PATH
```

### 第二步：启动并配置 AI 服务

首次启动时，如果检测到没有配置模型，会自动进入交互式配置向导（`/config`）。按提示输入 API 地址、密钥、模型型号即可完成配置。

**支持多个模型**（配置好后可用 `/model` 随时切换）：

> 支持自定义 API（DeepSeek、OpenAI、Anthropic、Moonshot、MiniMax、通义千问、GPT、硅基流动等）。

配置完成后，在交互模式下输入 `/model` 即可切换模型或删除模型，无需重启。`/config` 支持追加配置。

### 审批面板

当它要修改文件或执行命令时，会弹出审批面板：

按数字键选择，回车确认。所有提示都是中文。

---

## 核心功能

- **对话式交互** —— 用自然语言描述需求，它自动写代码、改文件、跑命令
- **安全第一** —— 修改文件前必须征得同意，`.env` 等敏感文件默认禁止操作
- **权限引擎** —— 精细控制它能做什么（读取/写入/执行），防止误操作
- **状态机机制** —— 防漂移，强化任务颗粒度，不出错，任务完成度高，降低 Token 消耗
- **记忆备忘录** —— `/memory` 打开交互式记忆浏览器，compaction 和退出会话时自动从对话中提取结构化工作日志（需求/方案/完成情况/遇到的问题），跨会话共享，支持手动注入到当前会话
- **会话恢复** —— 随时中断，随时继续，对话历史自动保存，可通过 `/sessions` 浏览和恢复历史会话
- **多模式** —— 交互模式、静默模式、计划模式、后台任务模式，可选
- **MCP 扩展** —— 连接外部工具（数据库、浏览器、API 等）
- **多 Agent 模式** —— 复杂任务自动拆解为多个子 Agent 并行执行（内置 4 类不同的子 Agent，根据任务调用最契合的 Agent 们执行任务）
- **Skill 自定义** —— 在 `.scream/skills/` 下添加自定义技能，扩展助手能力（内置）

---

## cc-connect 通过聊天远程控制screamcode

- 支持微信、飞书、slack、钉钉、QQ、Telegram等，你可以在安装scream-code后一键安装cc-connect来控制你的screamcode

###第一步：一键安装指令安装

```
# npm install -g cc-connect
```
###第二步：打开screamcode，输入/cc-connect 选择你要接入的平台

###第三步：按照步骤完成配置与链接后，输入命令启动后台守护进程（关闭screamcode也可在后台聊天）

**提示：关于会话系统

- *远程聊天会话默认走cc标识注入会话管理系统，可通过斜杠命令进入进行管理和删除，也可以直接在电脑端直接继承会话继续让screamcode完成工作 

**提示：终端快捷指令

cc-connect daemon start              ← 启动守护进程（电脑不关可一直使用）
cc-connect daemon stop               ← 强制停用
---

## 项目灵感与感谢支持

Scream 是结合作者本人的使用习惯和个人理解自行开发重构的 Agent 工具助手
从最开始的 Rust 版本，到 Python 版本，再到现在的 TypeScript 版本
我在很多功能上做了减法与优化，结合使用习惯与 Agent harness 的理解而开发。

部分 UI 及交互设计参考 codex、kimi、Gemini、等优秀项目，欢迎各位的使用反馈与优化建议！

---

## 许可证

[LICENSE](LICENSE)

---

## 入口

https://scream.chat
