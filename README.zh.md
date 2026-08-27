<p align="center">
  <a href="https://scream.chat">
    <img width="280" alt="Scream Code" src="assets/logo-v2.svg" />
  </a>
</p>

<p align="center">一款本地 Agent，无任何远程数据行为。用它自由写代码、跑任务、查资料，coding 或 working随你发挥。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scream-code"><img alt="npm" src="https://img.shields.io/npm/v/scream-code?style=flat-square&logo=npm&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/scream-code"><img alt="downloads" src="https://img.shields.io/npm/dm/scream-code?style=flat-square" /></a>
  <a href="https://github.com/LIUTod/scream-code/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/LIUTod/scream-code?style=flat-square&logo=github" /></a>
  <a href="https://github.com/LIUTod/scream-code/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/LIUTod/scream-code?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>
<p align="center">
  <img width="839" height="640" alt="企业微信20260815-164515" src="https://github.com/user-attachments/assets/5bd4d097-421f-45e0-aee5-840e56cdf975" />
</p>

---

### 安装

```bash
npm install -g scream-code
```

> [!NOTE]
> 要求 **Node.js >= 22**，建议安装 Git。安装与更新都是同一条命令。

### 快速开始

```bash
scream            # 终端 TUI
scream web        # 浏览器网页端 (http://localhost:3210)
scream --auto     # 自动权限模式
scream -y         # 自动批准模式
```

首次启动会自动进入模型配置向导（`/config`）。内置 130+ 模型商，或用 `/config diy` 指向任意 OpenAI 兼容端点。配置后用 `/model` 随时切换，无需重启，亦或者通过 `/model diy` 为子Agent 配置不同的模型，让模型去做最擅长的工作。

当它要修改文件或执行命令时，会弹出审批面板：按数字键选择，回车确认。

### 核心特性

- **Goal Loop** — 目标自主驱动，独立裁判 Agent 裁决，支持轮次/Token/时间预算控制，拒绝无效循环。
- **Wolfpack 群狼模式** — 无限制并行子 Agent（coder / explore / plan / verify / reviewer / oracle / writer / worker）。
- **永久记忆备忘录** — 痛点记忆结构化 SQL 提取，FTS5 全文 + Tag 语义 + 向量三重检索，跨会话共享，越用越懂你。
- **本地 SAG 知识图谱** — 基于 SAG 论文（[arXiv:2606.15971](https://arxiv.org/abs/2606.15971)）的可视化知识库，大幅提升多跳推理，随时导入本地知识。
- **RLM 模式** — 面向长任务的持久 Python 工作环境，状态跨调用保留，`rlm()` 支持无限递归子代理。
- **会话轨迹 `/trace`** — 将会话导出为自包含、离线的交互式 HTML 时间轴（含工具调用、JSON 导出）。
- **上下文搜索 `/search`** — 全屏关键词搜索（等同 Ctrl+Shift+F），输入即过滤，Esc 关闭。
- **高缓存命中率 HitR** — 状态栏会话级命中率，适配多种兼容协议，工作不降智的情况下最大化优化了缓存命中率。
- **MCP / Skill / 130+ 模型商** — 全部可 DIY 配置；内置浏览器自动化（46 工具）与 macOS 桌面自动化。
- **自进化插件系统** — 内置 `ManagePlugin` 工具，让 Agent 自行检索/自制/安装技能与 MCP 服务器，装入即对当前会话热生效；安全兜底：代码入口需单独批准激活、熔断自动摘除、免疫记忆在重复安装前提示历史、升级保留一键回滚备份。
- **多渠道远程控制** — 通过 cc-connect 打通微信、飞书、Slack、钉钉、QQ、Telegram、Discord。

### 斜杠命令

输入框输入 `/` 即可浏览全部 47 个命令：

| 指令 | 说明 |
|------|------|
| **模式与执行** | |
| `/auto` | 切换自动权限模式 |
| `/yes`（`/yolo`） | 切换自动批准模式 |
| `/ask` | 切换只读问答模式 |
| `/goal [目标]` | 查看/管理自动目标（目标驱动循环） |
| `/wolfpack`（`/wp`） | 切换群狼协作模式，自动批准+批量并发 |
| `/rlm` | RLM 模式：持久 Python 工作环境，无限递归子代理 |
| `/rlm-max-depth [N]` | 设置 RLM 递归深度上限 |
| `/plan` | 切换计划模式 |
| `/fusionplan`（`/fp`） | 切换融合计划模式（多子代理并行规划） |
| `/btw` | 在不中断对话的情况下快速提问 |
| `/eval` | 运行端到端测试（Agent健康度检查） |
| **会话** | |
| `/new`（`/clear`） | 在当前工作区开启新会话 |
| `/sessions`（`/resume`） | 浏览并恢复会话 |
| `/compact` | 压缩对话上下文 |
| `/fork` | 复制当前会话并新开分支 |
| `/title`（`/rename`） | 设置或显示会话标题 |
| `/revoke [N]` | 撤回上一次对话（如 `/revoke 3`） |
| `/export-md`（`/export`） | 导出当前会话为 Markdown |
| `/export-debug-zip` | 导出当前会话为调试 ZIP 存档 |
| `/status` | 显示当前会话和运行时状态 |
| `/usage` | 显示 token 用量和上下文窗口 |
| **记忆与知识** | |
| `/memory`（`/memo`、`/mem`）`[查询]` | 浏览、搜索、注入记忆备忘录 |
| `/knowledge`（`/know`）`[查询]` | 管理本地知识库（摄入/搜索/删除/统计） |
| **模型与配置** | |
| `/model [别名]` | 切换 LLM 模型 |
| `/config` | 浏览并配置模型（远程拉取最新模型商目录） |
| `/logout`（`/disconnect`） | 删除已配置的模型 |
| `/language`（`/lang`） | 切换界面语言 |
| `/theme` | 设置终端 UI 主题 |
| `/permission` | 选择权限模式 |
| `/editor` | 设置外部编辑器 |
| `/settings` | 打开 TUI 设置 |
| `/init` | 分析代码库并生成 AGENTS.md |
| `/update` | 手动更新 Scream Code 到最新版本 |
| `/version` | 显示版本信息 |
| **扩展** | |
| `/mcp` | 管理 MCP 服务器（安装/停用/卸载） |
| `/skill`（`/skills`、`/plugin`） | 技能中心，管理 Skill 技能，含激活、安装、卸载等 |
| `/make-skill` | 从当前会话沉淀工作流为 Skill |
| `/cc` | 操控你的 cc（启动/关闭/重启） |
| `/cc-connect` | cc-connect 快速通道配置 |
| **工具** | |
| `/search` | 上下文关键词搜索，ESC 关闭 |
| `/trace` | 查看会话工作轨迹 |
| `/hl`（`/highlight`） | 开关用户消息高亮块 |
| `/snaptimer`（`/timer`） | 开关会话快照计时器（每回合耗时标记） |
| `/tasks`（`/task`） | 浏览后台任务 |
| `/like` | 设置你的偏好（昵称、语气、其他偏好） |
| `/help`（`/h`） | 显示可用命令和快捷键 |
| `/exit`（`/quit`、`/q`） | 退出应用 |

**常用快捷键：** `Ctrl+S` 中断 · `Ctrl+C` 取消 · `Ctrl+O` 展开工具输出 · `Ctrl+Shift+F` 搜索 · `Shift+Tab` 计划模式 · `Shift+Enter` 换行 · `Tab`（空输入）切换思考强度 · `@` 提及文件

### Web 网页端

与 TUI 共用同一套 agent-core，功能零损失。多会话侧边栏、模型与思考强度切换、亮/暗/跟随系统主题、移动端适配。仅绑定 `127.0.0.1`，外部无法访问。

### 文档

官网：https://scream.chat

- **自进化实测手册** — 从自制技能、安装、激活、熔断到回滚的完整演练：`packages/agent-core/docs/self-evolution-e2e.md`。

### 致谢

完全免费、开放使用，欢迎魔改与反馈。Scream 是一个轻量化 Agent 底座——最大化释放模型本身的能力，不做过度的框架约束。灵感来自 pi、pi-tui、gork、kimicli、Gemini、ohmypi、zero 等优秀项目。

---

<p align="center">
  <a href="https://github.com/LIUTod/scream-code">GitHub</a> · <a href="https://scream.chat">scream.chat</a> · <a href="LICENSE">MIT License</a> · Made with ❤️ by <a href="https://github.com/LIUTod">LIUTod</a>
</p>
