<p align="center">
  <img width="128" height="128" alt="11" src="https://github.com/user-attachments/assets/26b707fa-1fd7-4dda-8484-e8c6b0bd7523" />
</p>

<p align="center">
  <strong>Scream Code — Your Local AI Agent Assistant</strong>
</p>

<p align="center">
  <a href="#中文说明"><img src="https://img.shields.io/badge/点击查看中文版说明-blue?style=for-the-badge" alt="Chinese README"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scream-code"><img src="https://img.shields.io/npm/v/scream-code?style=flat-square&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/scream-code"><img src="https://img.shields.io/npm/dm/scream-code?style=flat-square&logo=npm&logoColor=white" alt="npm downloads"></a>
  <a href="https://github.com/LIUTod/scream-code/blob/main/LICENSE"><img src="https://img.shields.io/github/license/LIUTod/scream-code?style=flat-square" alt="license"></a>
  <a href="https://github.com/LIUTod/scream-code/stargazers"><img src="https://img.shields.io/github/stars/LIUTod/scream-code?style=flat-square&logo=github" alt="stars"></a>
  <a href="https://github.com/LIUTod/scream-code/network/members"><img src="https://img.shields.io/github/forks/LIUTod/scream-code?style=flat-square&logo=github" alt="forks"></a>
  <a href="https://github.com/LIUTod/scream-code/issues"><img src="https://img.shields.io/github/issues/LIUTod/scream-code?style=flat-square&logo=github" alt="issues"></a>
  <a href="https://scream.chat"><img src="https://img.shields.io/badge/website-scream.chat-blue?style=flat-square" alt="website"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-green?style=flat-square&logo=node.js&logoColor=white" alt="node version"></a>
  <a href="https://github.com/LIUTod/scream-code"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square" alt="platform"></a>
</p>

---

Scream Code is a hassle-free, locally deployable, all-in-one AI Agent assistant. No remote calls, high security — just tell it what you need in natural language (Chinese or English). Vibe coding, write code, search papers, edit files, clean your machine, research, generate reports, search the web... You speak, it acts!

---

## ✨ Core Features

<table>
  <tr>
    <td width="50%">
      <h3>🎯 Goal Loop</h3>
      <p>Not a useless loop — <strong>goal-driven autonomy</strong> with an independent judge Agent. Set a goal and it iterates automatically with budget control. No wasteful token-burning loops.</p>
    </td>
    <td width="50%">
      <h3>🐺 Wolfpack Mode</h3>
      <p><strong>Unlimited intelligent batch concurrency</strong> — multiple Agents collaborate in parallel. Built-in coder/explore/plan/verify/reviewer/oracle/writer sub-agents. No item limit.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🧠 Persistent Memory</h3>
      <p><strong>Structured SQL extraction from pain points</strong>, FTS5 full-text + Tag semantic + vector triple retrieval. Shared across sessions — the more you use it, the smarter it gets.</p>
    </td>
    <td width="50%">
      <h3>📚 Local SAG Knowledge Base</h3>
      <p><strong>Based on paper: https://arxiv.org/abs/2606.15971 — SAG knowledge base</strong> (dramatically improves multi-hop reasoning), visual graph, import your local knowledge anytime.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🛡️ Efficient Lightweight Runtime</h3>
      <p><strong>Enterprise-grade security</strong>, fully local deployment, highly extensible with system-level capabilities. Zero remote behavior.</p>
    </td>
    <td width="50%">
      <h3>🔌 Multi-dimensional Extensions</h3>
      <p><strong>MCP / Skills / API providers</strong> — all freely configurable. 130+ built-in providers, or add your own via <code>/config diy</code>.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>⚡️ Multi-Agent Orchestration</h3>
      <p><strong>Enable multi-agent orchestration for sub-Agents with custom model configs.</strong> Let each model do what it does best.</p>
    </td>
    <td width="50%">
      <h3>📱 Multi-channel Connectivity</h3>
      <p>Connect via cc-connect to <strong>WeChat, Feishu, WeCom, DingTalk, Slack</strong> and more. Remotely control your Scream from any chat app.</p>
    </td>
  </tr>
</table>

---

## 🚀 Quick Start

### Step 1: Install

Prerequisite: **Node.js >= 22**. Also recommended: **Git**.

**Recommended: npm install (all platforms)**

```bash
npm install -g scream-code
```

After installation, the `scream` command is added to PATH. First install takes about 2-5 minutes.

- Start TUI: `scream`
- Auto-permission mode: `scream --auto`
- Auto-approve mode: `scream -y`
- Switch language after startup: `/language`

### Step 2: Configure AI Service

On first launch, if no model is configured, an interactive setup wizard (`/config`) starts automatically. Choose from built-in providers or use `/config diy` for custom APIs.

**Multiple models supported** — switch anytime with `/model`:

> Custom APIs supported (DeepSeek, OpenAI, Anthropic, MiniMax, Qwen, SiliconFlow, etc.) via `/config diy`.

After configuration, use `/model` to switch or remove models without restarting. Use `/model diy` to configure sub-Agent models.

### Approval Panel

When it needs to modify files or run commands, an approval panel appears. Press number keys to select, Enter to confirm.

---

## 📖 Features

| Feature | Description |
|---------|-------------|
| 💬 **Conversational Interaction** | Describe what you need in natural language — it writes code, edits files, runs commands |
| 🔒 **Security First** | Must get approval before modifying files; `.env` and sensitive files are blocked by default |
| 🛡️ **Permission Engine** | Fine-grained control over read/write/execute permissions |
| ⚙️ **State Machine** | Prevents drift, enforces task granularity, reduces token waste |
| 🤔 **FusionPlan** | Runs 3 plans from different angles and fuses them into one actionable plan |
| 🧠 **Memory** | `/memory` — interactive memory notebook, shared across sessions, tag-based |
| 📚 **SAG Knowledge Base** | `/knowledge` — interactive knowledge base with vector import and visual graph |
| 💤 **Dream Cleanup** | `/dream` — periodically cleans duplicate and stale records (not available in auto mode) |
| 🎯 **Goal System** | `/goal` — autonomous goal loop with budget control (iterations/tokens/time) |
| 💾 **Session Recovery** | Interrupt anytime, resume later — conversation history auto-saved |
| 🔄 **Multiple Modes** | Interactive mode, silent mode, plan mode, background task mode |
| 🔌 **MCP Extensions** | Connect external tools (databases, browsers, APIs, etc.) |
| 🤖 **Multi-Agent Parallel** | Complex tasks are automatically decomposed into parallel sub-Agents |
| 🎨 **Skill Center** | Browse and install community skills, or create your own |
| 🐺 **Wolfpack** | Multi-file, multi-task concurrent processing with auto-approval, unlimited sub-Agent concurrency |
| 🌳 **Multi-Agent Orchestration** | `/config diy` — assign different models to different sub-Agents |

---

## 📱 cc-connect — Remote Control via Chat

Supports WeChat, Feishu, Slack, DingTalk, QQ, Telegram, and more. Install cc-connect after scream-code to control it remotely.

### Step 1: Install

```bash
npm install -g cc-connect
```

### Step 2: Configure Platform

Open scream-code, type `/cc-connect`, and follow the prompts to select your platform.

> ⚠️ **Note**: Do not reconfigure after initial setup — it will overwrite existing config.

### Step 3: Start Daemon

Follow the steps to complete setup, then start the background daemon (scream-code can be closed while the daemon runs).

**Remote chat quick commands:**

| Command | Description |
|---------|-------------|
| `/new` | Create new session |
| `/bind setup` | Enable file transfer (PDF, images, etc.) |
| `/mode` | View available modes |
| `/mode yolo` | Auto-approve all tools |
| `/mode default` | Ask before each tool call |

---

## 💡 Inspiration & Thanks

Scream Code is a tool-oriented Agent framework I rebuilt from scratch based on my own usage habits and understanding of Agent systems. I started with Rust, but the maintenance overhead kept growing until I had to switch entirely to TypeScript. I've always believed that maximizing the model's own capabilities is the optimal path for Agent tools — in other words, I don't advocate excessive framework constraints, because model development will gradually reduce hallucinations.

The overall logic borrows from the Agent harness approach, while referencing design decisions from many excellent open-source projects. Scream no longer pursues feature stacking — it's a lightweight Agent foundation that stably and efficiently executes intent.

This project is completely free and open to use. Forks and modifications are welcome. Feedback, suggestions, and improvements are appreciated. I'll keep refining it within my capacity based on real-world usage.

Thanks to these excellent projects for inspiration: pi, pi-tui, gork, kimicli, Gemini, ohmypi, zero, and others.

---

## 🔗 Links

🌐 **Website**: https://scream.chat

---

## ⭐ Star History

<a href="https://www-star-history.com/#LIUTod/scream-code&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=LIUTod/scream-code&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=LIUTod/scream-code&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=LIUTod/scream-code&type=Date" />
 </picture>
</a>

---

## 📄 License

[MIT](LICENSE) © [LIUTod](https://github.com/LIUTod)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/LIUTod">LIUTod</a>
</p>

---

<h2 id="中文说明">Scream Code 你的本地 Agent 智能助手</h2>

<p align="center">
  <a href="#readme"><img src="https://img.shields.io/badge/README-English-blue?style=for-the-badge" alt="English README"></a>
</p>

Scream Code 是一款省心的可在本地部署的全能 AI Agent 助手。你无需硬记代码，无任何远程行为，高安全，用户直接用中/英文下达指令，vibe coding、写代码、查论文、改文件、清理电脑、查资料、制作研报、搜全网信息……你动嘴，它动手！

---

## ✨ 核心特性

<table>
  <tr>
    <td width="50%">
      <h3>🎯 Goal loop 循环</h3>
      <p>非无效loop，<strong>目标自主驱动</strong>，裁判Agent独立裁决目标达成。设定目标后自动多轮迭代执行，支持预算控制。拒绝浪费Token式无效Loop循环</p>
    </td>
    <td width="50%">
      <h3>🐺 Wolfpack 群狼模式</h3>
      <p><strong>无限制智能批量并发</strong>多Agent协同，并行处理大项目任务。内置coder/explore/plan/verify/reviewer/oracle/writer 等多种子 Agent，精准识别任务类型，item 数量无上限。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🧠 永久记忆备忘录</h3>
      <p><strong>痛点记忆结构化SQL提取</strong>，FTS5全文+Tag语义+向量三重检索不漂移。跨会话共享，越用越懂你。</p>
    </td>
    <td width="50%">
      <h3>📚 本地SAG图谱知识库</h3>
      <p><strong>基于论文：https://arxiv.org/abs/2606.15971 构建复现SAG知识库</strong>（大幅提高多跳推理能力），可视化图谱，随时导入你的本地知识，让Agent更懂你</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🛡️ 效率级轻量底层</h3>
      <p><strong>企业级安全</strong>，完全本地部署并运行，高度自由可拓展，系统级调用能力。无任何远程行为。</p>
    </td>
    <td width="50%">
      <h3>🔌 多维自定义拓展</h3>
      <p><strong>MCP / Skill / api模型商</strong> 均可自由DIY配置，拓展你Scream的能力，内设主流国内外模型商超130+，也可自由配置。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>⚡️ 多代理编排引擎</h3>
      <p><strong>支持为子Agent开启多代理编排模式，可自定义配置子Agent模型。</strong>让不同模型，去做自己最擅长的工作。</p>
    </td>
    <td width="50%">
      <h3>📱 多渠道互联</h3>
      <p>通过 cc-connect 打通<strong>微信、飞书、企微、钉钉、slack</strong>等平台，随时随地在App上远程调用你的scream。</p>
    </td>
  </tr>
</table>

---

## 🚀 三分钟上手

### 第一步：安装

前置条件：**Node.js >= 22** 建议同步安装 **Git**。

**推荐：npm 安装（全平台通用）更新安装都是这个指令**

```bash
npm install -g scream-code
```

安装完成后，`scream` 命令自动加入 PATH。首次安装约需 2-5 分钟。
TUI启动命令`scream`
自动权限模式启动`scream --auto`
自动批准模式启动`scream -y`
启动后切换语言`/language`

### 第二步：启动并配置 AI 服务

首次启动时，如果检测到没有配置模型，会自动进入交互式配置向导（`/config`），可选择市面模型商一键配置
（`/config diy`） 支持自定义追加配置。按提示输入 API 地址、密钥、模型型号即可完成配置。

**支持多个模型**（配置好后可用 `/model` 随时切换）：

> 支持自定义 API（DeepSeek、OpenAI、Anthropic、MiniMax、通义千问、硅基流动等（`/config diy`）需要输入隐藏指令）。

配置完成后，在交互模式下输入 `/model` 即可切换模型或删除模型，无需重启（`/model diy`）可以单独设置子Agent模型配置。

### 审批面板

当它要修改文件或执行命令时，会弹出审批面板：

按数字键选择，回车确认。

---

## 📖 核心功能

| 功能 | 说明 |
|------|------|
| 💬 **对话式交互** | 用自然语言描述需求，它自动写代码、改文件、跑命令 |
| 🔒 **安全第一** | 修改文件前必须征得同意，`.env` 等敏感文件默认禁止操作 |
| 🛡️ **权限引擎** | 精细控制它能做什么（读取/写入/执行），防止误操作 |
| ⚙️ **状态机机制** | 防漂移，强化任务颗粒度，不出错，任务完成度高，降低 Token 消耗 |
| 🤔 **fusionplan** | 复杂需求规划时跑3个不同角度的方案并融合为真实可行的方案，提高方案正确率 |
| 🧠 **记忆备忘录** | `/memory` 打开交互式记忆备忘录，跨会话共享，知识库tag分级 |
| 📚 **SAG知识库** | `/knowledge` 打开交互式知识库，配置导入向量，可视化知识图谱 |
| 💤 **dream 整理** | `/dream` 定期整理重复和过时记录（auto模式下不可用，避免误删） |
| 🎯 **目标系统** | `/goal` 开启自主目标循环，支持预算控制（轮次/Token/时间） |
| 💾 **会话恢复** | 随时中断，随时继续，对话历史自动保存 |
| 🔄 **多模式** | 交互模式、静默模式、计划模式、后台任务模式 |
| 🔌 **MCP扩展** | 连接外部工具（数据库、浏览器、API 等） |
| 🤖 **多Agent并行** | 复杂任务自动拆解为多个子 Agent 同时执行 |
| 🎨 **技能中心** | 搜罗多款技能可下载，用户也可以自行安装 skill 技能 |
| 🐺 **wolfpack** | 群狼模式，适合多文件多任务同时处理，拥有自动审批权限，子 Agent 并发无上限 |
| 🌳 **多代理编排** | `/config diy` 自定义给子Agent代理配置不同的模型，让最合适的模型做最适合的工作|

---

## 📱 cc-connect 通过聊天远程控制

支持微信、飞书、Slack、钉钉、QQ、Telegram 等，你可以在安装 scream-code 后一键安装 cc-connect 来控制你的 screamcode。

### 第一步：一键安装

```bash
npm install -g cc-connect
```

### 第二步：配置平台

打开 screamcode，输入 `/cc-connect` 按照提示选择你要接入的平台。

> ⚠️ **注意**：配置完毕后不要再次配置，否则会覆盖原有配置。

### 第三步：启动守护进程

按照步骤完成配置与链接后，输入命令启动后台守护进程（关闭 screamcode 也可在后台聊天）。

**远程聊天快捷指令：**

| 指令 | 说明 |
|------|------|
| `/new` | 创建新会话 |
| `/bind setup` | 开启文件传送功能，支持 PDF、图片等 |
| `/mode` | 查看可用模式 |
| `/mode yolo` | 自动批准所有工具 |
| `/mode default` | 每次工具调用前询问 |

---

## 💡 项目灵感与感谢支持

Scream Code 是我基于自身使用习惯以及对 Agent 系统的理解，从零重构的一套工具型 Agent 框架。最早用 Rust 编写，但维护工程量越来越大，不得不彻底转向 TypeScript，我的始终认为，最大化释放模型本身的能力才是 Agent 工具未来发展的最优解，换句话说我并不提倡过度的框架约束，因为模型的发展会逐渐降低幻觉！

另外 Scream Code 的整体逻辑借鉴了 Agent harness 的思路，同时也参考了不少优秀开源项目的设计取舍与实现细节。现在的 Scream 不再追求功能堆叠，而是一个能稳定、高效执行意图的轻量化 Agent 底座。

这个项目完全免费，开放使用，欢迎魔改，也欢迎反馈，并给出建议和改进。我会在能力范围之内，持续根据实际使用场景继续打磨。

再次感谢其他优秀的项目给予灵感：pi、pi-tui、gork、kimicli、Gemini、ohmypi、zero 等优秀项目。
