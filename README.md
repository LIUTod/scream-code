<img width="463" height="157" alt="image" src="https://github.com/user-attachments/assets/a24426f5-1c15-48e4-9625-9066557dc6b6" />


Scream Code 是一款省心的中文 AI Agent 助手。无需硬记代码，直接用中/英文下达指令，vibe coding、写代码、查论文、改文件、清理电脑、查资料、制作研报、搜全网信息……你动嘴，它动手！

---

## 三分钟上手

### 第一步：安装

前置条件：**Node.js >= 22.0.0** 和 **Git**。

> **国内用户**：安装过程需从 GitHub 下载，建议科学上网，如遇网络错误请多尝试几次。

**推荐：npm 安装（全平台通用）**

```bash
npm install -g scream-code
```

或使用 npx（无需全局安装）：

```bash
npx scream-code
```

**一键安装（macOS / Linux）**

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
- **记忆备忘录** —— `/memory` 打开交互式记忆备忘录，compaction 和退出会话时自动从对话中提取结构化工作日志（需求/方案/完成情况/遇到的问题），跨会话共享，支持手动注入到当前会话
- **会话恢复** —— 随时中断，随时继续，对话历史自动保存，可通过 `/sessions` 浏览和恢复历史会话
- **多模式** —— 交互模式、静默模式、计划模式、后台任务模式，可选
- **MCP 扩展** —— 连接外部工具（数据库、浏览器、API 等）
- **多 Agent 并行模式** —— `/power` 开启 Power 并行模式，复杂任务自动拆解为多个子 Agent 同时执行，内置 coder/explore/plan/verify/writer 五类子 Agent。支持多角度分析、对抗验证等并行编排模式。
- **技能中心** —— 内置多款技能可下载，用户也可以自行安装skill技能
- **MCP** —— 内置浏览器自动化MCP和电脑桌面自动化MCP（目前仅支持mac），另外可自行添加或下载使用自定MCP
- **power** —— 强制集群模式，适合多文件多任务同时处理（未开启情况下由主Agent自行决定是否开启并行）
- **dream** —— 定期整理自动记忆备忘录，清理无效记忆日志

---

## cc-connect 通过聊天远程控制screamcode

- 支持微信、飞书、slack、钉钉、QQ、Telegram等，你可以在安装scream-code后一键安装cc-connect来控制你的screamcode

###第一步：一键安装指令安装

```
# npm install -g cc-connect
```
###第二步：打开screamcode，输入/cc-connect 按照提示选择你要接入的平台（配置完毕后不要再次配置，否则会覆盖原有配置）

###第三步：按照步骤完成配置与链接后，输入命令启动后台守护进程（关闭screamcode也可在后台聊天）

**提示：关于会话系统

- *远程聊天会话默认走cc标识注入会话管理系统，可通过斜杠命令进入进行管理和删除，也可以直接在电脑端直接继承会话继续让screamcode完成工作 

**提示：远程聊天快捷指令（已默认支持，飞书、微信等通道文件图片发送）

- /new             创建新会话
- /bind setup      开启文件传送功能，支持PDF、图片等
- /mode            查看可用模式
- /mode yolo       自动批准所有工具
- /mode default    每次工具调用前询问
---

## 项目灵感与感谢支持

Scream 是我基于自身使用习惯与对 Agent 系统的理解，从零重构的一套工具型 Agent 框架。最早用 Rust 写，架构膨胀得厉害，最后成屎山了。经历了教训之后，彻底转向 TypeScript，也顺便做了大量减法。

早期版本塞了不少“有意思但多余”的东西：比如 /look 交互模式爬取网页js、浏览器 MCP 接入。在底层也尝试过对抗式 Agent 决策机制，还参考过“三省六部”的组织结构来拆分职责。最多的时候内置了 10 个并行子 Agent，走的是排列式群狼协同路线。为了多开集群协同，我还专门做了一个 48 小时短期记忆的全局共享系统——结果实际效果非常有限，甚至根本就没机会真正用上。回头看，属于典型的伪需求。

重构之后，我把精力集中在三件事上：并行调度和状态机 + 记忆系统的收敛设计 + 最大化释放模型本身的能力上。整体逻辑借鉴了 Agent harness 的思路，同时也参考了不少优秀开源项目的设计取舍与实现细节。现在的 Scream 不再追求功能堆叠，而是一个能稳定、高效执行意图的轻量化 Agent 底座。

这个项目完全免费，开放使用，也欢迎反馈，并给出建议和改进。会持续根据实际使用场景继续打磨。

再次感谢其他优秀的项目给予灵感：gork codex、kimicli、Gemini、等优秀项目

---

## 入口

https://scream.chat

## Star History

<a href="https://www.star-history.com/?repos=LIUTod%2Fscream-code&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=LIUTod/scream-code&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=LIUTod/scream-code&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=LIUTod/scream-code&type=date&legend=top-left" />
 </picture>
</a>


## License

MIT
