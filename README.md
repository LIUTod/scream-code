<p align="center">
  <img width="128" height="128" alt="11" src="https://github.com/user-attachments/assets/26b707fa-1fd7-4dda-8484-e8c6b0bd7523" />
</p>

<p align="center">
  <strong>Scream Code 属于你的本地 AI 智能助手</strong>
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

Scream Code 是一款省心的本地中文 AI Agent 助手。无需硬记代码，完全本地部署运行，无任何远程行为，高安全，用户直接用中/英文下达指令，vibe coding、写代码、查论文、改文件、清理电脑、查资料、制作研报、搜全网信息……你动嘴，它动手！

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
      <h3>🛡️ 效率级轻量底层</h3>
      <p><strong>企业级安全</strong>，本地部署，高度自由可拓展，系统级调用能力。完全本地运行，无任何远程行为。</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔌 自定义拓展</h3>
      <p><strong>MCP / Skill / 模型商</strong> /子Agent等全部自由定义无限拓展。支持 DeepSeek、OpenAI、Anthropic 等。</p>
    </td>
    <td width="50%">
      <h3>📱 多渠道互联</h3>
      <p>通过 CC 打通<strong>微信、飞书、企微、钉钉</strong>等平台，远程调用不用慌。</p>
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


### 第二步：启动并配置 AI 服务

首次启动时，如果检测到没有配置模型，会自动进入交互式配置向导（`/config`），可选择市面模型商一键配置
（`/config diy`） 支持自定义追加配置。按提示输入 API 地址、密钥、模型型号即可完成配置。

**支持多个模型**（配置好后可用 `/model` 随时切换）：

> 支持自定义 API（DeepSeek、OpenAI、Anthropic、MiniMax、通义千问、硅基流动等（`/config diy`）需要输入隐藏指令）。

配置完成后，在交互模式下输入 `/model` 即可切换模型或删除模型，无需重启（`/model diy`）可以单独设置子Agent模型配置。

### 审批面板

当它要修改文件或执行命令时，会弹出审批面板：

按数字键选择，回车确认。所有提示都是中文。

---

## 📖 核心功能

| 功能 | 说明 |
|------|------|
| 💬 **对话式交互** | 用自然语言描述需求，它自动写代码、改文件、跑命令 |
| 🔒 **安全第一** | 修改文件前必须征得同意，`.env` 等敏感文件默认禁止操作 |
| 🛡️ **权限引擎** | 精细控制它能做什么（读取/写入/执行），防止误操作 |
| ⚙️ **状态机机制** | 防漂移，强化任务颗粒度，不出错，任务完成度高，降低 Token 消耗 |
| 🧠 **记忆备忘录** | `/memory` 打开交互式记忆备忘录，跨会话共享，知识库tag分级 |
| 💤 **dream 整理** | `/dream` 定期整理重复和过时记录（auto模式下不可用，避免误删） |
| 🎯 **目标系统** | `/goal` 开启自主目标循环，支持预算控制（轮次/Token/时间） |
| 💾 **会话恢复** | 随时中断，随时继续，对话历史自动保存 |
| 🔄 **多模式** | 交互模式、静默模式、计划模式、后台任务模式 |
| 🔌 **MCP 扩展** | 连接外部工具（数据库、浏览器、API 等） |
| 🤖 **多 Agent 并行** | 复杂任务自动拆解为多个子 Agent 同时执行 |
| 🎨 **技能中心** | 内置多款技能可下载，用户也可以自行安装 skill 技能 |
| 🐺 **wolfpack** | 群狼模式，适合多文件多任务同时处理，拥有自动审批权限，子 Agent 并发无上限 |

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

Scream 是我基于自身使用习惯与对 Agent 系统的理解，从零重构的一套工具型 Agent 框架。最早用 Rust 写，架构膨胀得厉害，最后成屎山了。经历了教训之后，彻底转向 TypeScript，也顺便做了大量减法。

重构之后，我把精力集中在三件事上：并行调度和状态机 + 记忆系统的收敛设计 + 最大化释放模型本身的能力上。整体逻辑借鉴了 Agent harness 的思路，同时也参考了不少优秀开源项目的设计取舍与实现细节。现在的 Scream 不再追求功能堆叠，而是一个能稳定、高效执行意图的轻量化 Agent 底座。

这个项目完全免费，开放使用，也欢迎反馈，并给出建议和改进。会持续根据实际使用场景继续打磨。

再次感谢其他优秀的项目给予灵感：pi、gork、kimicli、Gemini、ohmypi 等优秀项目。

---

## 🔗 入口

🌐 **官网**：https://scream.chat

---

## ⭐ Star History

<a href="https://www.star-history.com/#LIUTod/scream-code&Date">
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
