<p align="center">
  <a href="https://scream.chat">
    <img width="96" height="96" alt="Scream Code" src="https://github.com/user-attachments/assets/11d86774-b308-4cf7-857b-4c313670ade4" />
  </a>
</p>

<p align="center">A local agent with zero remote data behavior — code, work, and build freely, entirely on your machine.</p>

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

---

### Installation

```bash
npm install -g scream-code
```

> [!NOTE]
> Requires **Node.js >= 22**. Git recommended. Same command installs and updates.

### Quick Start

```bash
scream            # terminal UI
scream web        # browser UI (http://localhost:3210)
scream --auto     # auto permission mode
scream -y         # auto-approve mode
```

On first launch Scream walks you through model setup (`/config`). 130+ providers built in — or point it at any OpenAI-compatible endpoint with `/config diy`. Switch models anytime with `/model`, no restart needed.

When Scream wants to modify files or run commands, an approval panel pops up — pick a number, press Enter.

### Features

- **Goal Loop** — autonomous, goal-driven execution with an independent judge agent and token/time budget control.
- **Wolfpack** — unlimited parallel sub-agents (coder / explore / plan / verify / reviewer / oracle / writer / worker).
- **Persistent Memory** — structured pain-point memory with FTS5 full-text + tag + vector retrieval, shared across sessions.
- **Local Knowledge Graph** — SAG-based visual knowledge base for multi-hop reasoning; import your own docs anytime.
- **RLM Mode** — persistent Python workspace for long-running tasks, with unlimited recursive sub-agents.
- **Session Trace** — `/trace` exports any session as a self-contained, offline interactive HTML timeline.
- **Context Search** — `/search` (Ctrl+Shift+F) full-screen keyword search over the conversation.
- **Cache Hit Rate** — per-session HitR in the status bar, persisted across restarts, green at ≥ 90%.
- **MCP / Skills / 130+ providers** — all DIY-configurable; ships with browser (46 tools) and macOS desktop automation.
- **Remote Control** — drive Scream from WeChat, Feishu, Slack, DingTalk, QQ, Telegram, Discord via cc-connect.

### Slash Commands

Type `/` in the input to browse. All 47 commands:

<details>
<summary>Full command reference (click to expand)</summary>

| Command | Description |
|---------|-------------|
| **Modes & execution** | |
| `/auto` | Toggle auto permission mode |
| `/yes` (`/yolo`) | Toggle auto-approve mode |
| `/ask` | Toggle read-only Q&A mode |
| `/goal [objective]` | View/manage auto goals |
| `/wolfpack` (`/wp`) | Toggle wolfpack mode — auto-approve + batch concurrency |
| `/rlm` | RLM mode: persistent Python workspace, unlimited recursive subagents |
| `/rlm-max-depth [N]` | Set RLM recursion depth limit |
| `/plan` | Toggle plan mode |
| `/fusionplan` (`/fp`) | Fusion plan mode (multi-agent parallel planning) |
| `/btw` | Quick question without interrupting the conversation |
| `/eval` | Run end-to-end tests (agent health check) |
| **Session** | |
| `/new` (`/clear`) | Start a new session |
| `/sessions` (`/resume`) | Browse and restore sessions |
| `/compact` | Compact conversation context |
| `/fork` | Copy session into a new branch |
| `/title` (`/rename`) | Set or show session title |
| `/revoke [N]` | Undo the last N conversation rounds |
| `/export-md` (`/export`) | Export session as Markdown |
| `/export-debug-zip` | Export session as debug ZIP |
| `/status` | Show session and runtime status |
| `/usage` | Show token usage and context window |
| **Memory & knowledge** | |
| `/memory` (`/memo`, `/mem`) `[query]` | Browse, search, inject memory memos |
| `/knowledge` (`/know`) `[query]` | Manage local knowledge base |
| **Models & configuration** | |
| `/model [alias]` | Switch LLM model |
| `/config` | Browse and configure models |
| `/logout` (`/disconnect`) | Remove configured models |
| `/language` (`/lang`) | Switch interface language |
| `/theme` | Set terminal UI theme |
| `/permission` | Select permission mode |
| `/editor` | Set external editor |
| `/settings` | Open TUI settings |
| `/init` | Analyze codebase and generate AGENTS.md |
| `/update` | Update Scream Code |
| `/version` | Show version info |
| **Extensions** | |
| `/mcp` | Manage MCP servers |
| `/skill` (`/skills`, `/plugin`) | Skill center |
| `/make-skill` | Distill the session into a Skill |
| `/cc` | Control your cc daemon |
| `/cc-connect` | cc-connect quick channel setup |
| **Tools** | |
| `/search` | Search the conversation (Esc to close) |
| `/trace` | View the session working trajectory |
| `/hl` (`/highlight`) | Toggle user-message highlight block |
| `/snaptimer` (`/timer`) | Toggle per-turn elapsed timer |
| `/tasks` (`/task`) | Browse background tasks |
| `/like` | Set your preferences |
| `/help` (`/h`) | Show commands and shortcuts |
| `/exit` (`/quit`, `/q`) | Exit application |

</details>

**Shortcuts:** `Ctrl+S` interrupt · `Ctrl+C` cancel · `Ctrl+O` expand tool output · `Ctrl+Shift+F` search · `Shift+Tab` plan mode · `Shift+Enter` new line · `Tab` (empty) cycle thinking effort · `@` mention a file

### Web UI

The browser UI shares the same agent-core as the TUI — zero feature loss. Multi-session sidebar, model & thinking-effort switching, light/dark/system themes, mobile-friendly. Binds `127.0.0.1` only — no external access.

### Documentation

Website: [scream.chat](https://scream.chat)

### Contributing

Free and open — forks, feedback and pull requests are welcome. Scream is a lightweight agent foundation: maximize the model's own capability, don't over-constrain it with framework. Inspired by pi, pi-tui, gork, kimicli, Gemini, ohmypi, zero and others.

---

<p align="center">
  <a href="https://github.com/LIUTod/scream-code">GitHub</a> · <a href="https://scream.chat">scream.chat</a> · <a href="LICENSE">MIT License</a> · Made with ❤️ by <a href="https://github.com/LIUTod">LIUTod</a>
</p>
