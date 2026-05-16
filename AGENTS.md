# Scream Code CLI

## Quick commands (use uv)

- `make prepare` (sync deps for all workspace packages and install git hooks)
- `make format`
- `make check`
- `make test`
- `make ai-test`
- `make build` / `make build-bin`

If running tools directly, use `uv run ...`.

## Project overview

Scream Code is a Python CLI agent for software engineering workflows. It supports an interactive
shell UI, ACP server mode for IDE integrations, and MCP tool loading.

## Tech stack

- Python 3.12+ (tooling configured for 3.14)
- CLI framework: Typer
- Async runtime: asyncio
- LLM framework: ltod
- MCP integration: fastmcp
- Logging: loguru
- Package management/build: uv + uv_build; PyInstaller for binaries
- Tests: pytest + pytest-asyncio; lint/format: ruff; types: pyright + ty

## Architecture overview

- **CLI entry**: `src/scream/cli/__init__.py` (Typer) parses flags (UI mode, agent spec, config, MCP)
  and routes into `ScreamCLI` in `src/scream/app.py`.
- **App/runtime setup**: `ScreamCLI.create` loads config (`src/scream/config.py`), chooses a
  model/provider (`src/scream/llm.py`), builds a `Runtime` (`src/scream/soul/agent.py`),
  loads an agent spec, restores `Context`, then constructs `ScreamSoul`.
- **Agent specs**: YAML under `src/scream/agents/` loaded by `src/scream/agentspec.py`.
  Specs can `extend` base agents, select tools by import path, and register builtin subagent
  types via the `subagents` field. Subagent instances are persisted separately under the session
  directory and can be resumed by `agent_id`. System prompts live alongside specs; builtin args
  include `SCREAM_NOW`, `SCREAM_WORK_DIR`, `SCREAM_WORK_DIR_LS`, `SCREAM_AGENTS_MD`, `SCREAM_SKILLS`, `SCREAM_OS`, `SCREAM_SHELL`
  (this file is injected via `SCREAM_AGENTS_MD`).
- **Tooling**: `src/scream/soul/toolset.py` loads tools by import path, injects dependencies,
  and runs tool calls. Built-in tools live in `src/scream/tools/` (agent, shell, file, web,
  todo, background, dmail, think, plan). MCP tools are loaded via `fastmcp`; CLI management is
  in `src/scream/mcp.py` and stored in the share dir.
- **Subagents**: `LaborMarket` in `src/scream/soul/agent.py` registers builtin subagent types.
  The `Agent` tool (`src/scream/tools/agent/`) creates or resumes subagent instances, while
  `SubagentStore` persists instance metadata, prompts, wire logs, and context under
  `session/subagents/<agent_id>/`.
- **Core loop**: `src/scream/soul/screamsoul.py` is the main agent loop. It accepts user input,
  handles slash commands (`src/scream/soul/slash.py`), appends to `Context`
  (`src/scream/soul/context.py`), calls the LLM (ltod), runs tools, and performs compaction
  (`src/scream/soul/compaction.py`) when needed.
- **PermissionEngine**: `src/scream/permission/engine.py` provides wildcard-based rule matching
  (`allow`/`deny`/`ask`) for tool calls. Rules are loaded from `~/.scream/config.toml`
  (`permission_rules` table) and evaluated in `src/scream/soul/approval.py` before the UI
  approval panel is shown. `DENY` rules reject immediately without UI; `ASK` rules show the
  approval panel; `ALLOW` rules auto-approve. YOLO/AFK flags always take precedence.
- **Memory System**: `src/scream/memory/` provides dual-scope persistent memory. Project-scoped
  entries live in `{work_dir}/.scream/memory/`; global-scoped entries live in
  `~/.scream/memory/`. `MemoryManager` (`manager.py`) handles CRUD and keyword search
  (Chinese + English tokenization). `MemoryInjectionProvider` (`injection.py`) injects up to
  3 relevant memories into the system prompt before each LLM call via the
  `DynamicInjectionProvider` pattern. The `/memory` slash command (`src/scream/soul/slash.py`)
  exposes `add`, `list`, `search`, and `delete` subcommands.
- **Approvals**: `src/scream/soul/approval.py` is the tool-facing facade. `ApprovalRuntime`
  in `src/scream/approval_runtime/` is the session-level source of truth for pending approvals,
  and approval requests are projected onto the root wire stream for Shell/Web style UIs.
  Approval panel UI (`src/scream/ui/shell/visualize/_approval_panel.py`) and all user-facing
  approval messages are localized to Chinese.
- **First-run config**: `src/scream/app.py` detects when no LLM is configured
  (`self._runtime.llm is None`) and passes `needs_first_time_config=True` to `Shell`. On startup,
  `Shell.run()` in `src/scream/ui/shell/__init__.py` automatically invokes the `/config`
  slash command to guide users through interactive provider/model setup.
- **Skill loading**: `src/scream/skill/__init__.py` discovers skills from layered roots:
  project-level (`.scream/skills/`, `.claude/skills/`, `.codex/skills/`, `.agents/skills/`),
  user-level (`~/.scream/skills/`, etc.), and built-in (`src/scream/skills/`). Skills are
  parsed from `SKILL.md` files (YAML frontmatter + markdown body). Project-level skills
  have the highest priority.
- **UI/Wire**: `src/scream/soul/run_soul` connects `ScreamSoul` to a `Wire`
  (`src/scream/wire/`) so UI loops can stream events. UIs live in `src/scream/ui/`
  (shell/print/acp/wire).
- **Shell UI**: `src/scream/ui/shell/` handles interactive TUI input, shell command mode,
  and slash command autocomplete; it is the default interactive experience.
- **Slash commands**: Soul-level commands live in `src/scream/soul/slash.py`; shell-level
  commands live in `src/scream/ui/shell/slash.py`. The shell UI exposes both and dispatches
  based on the registry. Standard skills register `/skill:<skill-name>` and load `SKILL.md`
  as a user prompt; flow skills register `/flow:<skill-name>` and execute the embedded flow.

## Major modules and interfaces

- `src/scream/app.py`: `ScreamCLI.create(...)` and `ScreamCLI.run(...)` are the main programmatic
  entrypoints; this is what UI layers use.
- `src/scream/soul/agent.py`: `Runtime` (config, session, builtins), `Agent` (system prompt +
  toolset), and `LaborMarket` (builtin subagent type registry).
- `src/scream/soul/screamsoul.py`: `ScreamSoul.run(...)` is the loop boundary; it emits Wire
  messages and executes tools via `ScreamToolset`.
- `src/scream/soul/context.py`: conversation history + checkpoints; used by DMail for
  checkpointed replies.
- `src/scream/soul/toolset.py`: load tools, run tool calls, bridge to MCP tools.
- `src/scream/ui/*`: shell/print/acp frontends; they consume `Wire` messages.
- `src/scream/wire/*`: event types and transport used between soul and UI.
- `src/scream/permission/engine.py`: `PermissionEngine` with wildcard rule matching,
  specificity scoring, and `ALLOW`/`DENY`/`ASK` evaluation.
- `src/scream/memory/`: `MemoryManager` (CRUD + search), `MemoryEntry` models, and
  `MemoryInjectionProvider` (pre-LLM-call memory injection via `DynamicInjectionProvider`).
- `src/scream/skill/__init__.py`: skill discovery from project/user/built-in roots, with
  `resolve_skills_roots()` controlling priority order.

## Repo map

- `src/scream/agents/`: built-in agent YAML specs and prompts
- `src/scream/prompts/`: shared prompt templates
- `src/scream/soul/`: core runtime/loop, context, compaction, approvals
- `src/scream/tools/`: built-in tools
- `src/scream/ui/`: UI frontends (shell/print/acp/wire)
- `src/scream/acp/`: ACP server components
- `src/scream/permission/`: permission rule engine (`engine.py`) with `ALLOW`/`DENY`/`ASK`
- `src/scream/memory/`: persistent memory system (`manager.py`, `models.py`, `injection.py`)
- `src/scream/skill/`: skill discovery and loading from layered roots
- `.scream/skills/`: project-level skills (highest priority; `custom-helper/` is an example)
- `.agents/skills/`: project-level skills (generic group, lower priority than `.scream/skills/`)
- `packages/ltod/`, `packages/kaos/`: workspace deps
  + ltod is an LLM abstraction layer designed for modern AI agent applications.
    It unifies message structures, asynchronous tool orchestration, and pluggable
    chat providers so you can build agents with ease and avoid vendor lock-in.
  + PyKAOS is a lightweight Python library providing an abstraction layer for agents
    to interact with operating systems. File operations and command executions via KAOS
    can be easily switched between local environment and remote systems over SSH.
- `tests/`, `tests_ai/`: test suites
- `klips`: Scream Code CLI Improvement Proposals

## Conventions and quality

- Python >=3.12 (ty config uses 3.14); line length 100.
- Ruff handles lint + format (rules: E, F, UP, B, SIM, I); pyright + ty for type checks.
- Tests use pytest + pytest-asyncio; files are `tests/test_*.py`.
- CLI entry point: `scream` -> `src/scream/__main__.py` (routes to `src/scream/cli/__init__.py`).
- User config: `~/.scream/config.toml`; logs, sessions, and MCP config live in `~/.scream/`.

## Recent additions

- **PermissionEngine** (`src/scream/permission/`): wildcard-based tool call permission rules
  loaded from config. Supports `ALLOW` (auto-approve), `DENY` (immediate rejection), and
  `ASK` (show approval UI). Evaluated in `approval.py` after yolo/afk checks.
- **Memory System** (`src/scream/memory/`): dual-scope persistent memory (project + global).
  Entries stored as `.md` files with JSON frontmatter. `MemoryInjectionProvider` injects
  up to 3 relevant memories before each LLM call. Exposed via `/memory` slash command
  (`add`, `list`, `search`, `delete`).
- **Skill system** (`src/scream/skill/`): layered skill discovery from project (`/.scream/skills/`)
  and user roots. Skills are `SKILL.md` files with YAML frontmatter. A `custom-helper` example
  skill exists under `.scream/skills/`.
- **First-run auto-config**: `Shell.run()` automatically invokes `/config` when no LLM is
  configured, guiding users through interactive setup without manual file editing.
- **Chinese localization**: all user-facing approval UI strings and messages are localized
  to Chinese. Internal protocol fields remain English.
- **`/config` append mode**: the interactive `/config` command now appends new providers and
  models to existing config instead of overwriting, with conflict confirmation dialogs.
- **`/model` delete option**: when multiple models are configured, `/model` presents a
  "删除模型..." option that lets users remove unused models (and unreferenced providers).

## PermissionEngine design

`src/scream/permission/engine.py` implements wildcard-based rule matching for tool calls.

- **Rule structure**: `PermissionRule(tool_pattern, action, path_pattern, description)`.
  - `tool_pattern` matches the tool/action name (e.g. `read file`, `edit*`, `*`).
  - `path_pattern` optionally matches file paths extracted from arguments
    (`file_path`, `path`, `command`, `target` keys).
  - `action` is one of `ALLOW` | `DENY` | `ASK`.
- **Specificity scoring**: rules are sorted by specificity (highest first) before evaluation.
  - Exact tool name = +10; wildcard tool name = +5; `*` = 0.
  - Exact path = +20; wildcard path = +15; `*` path = +5.
  - This ensures concrete rules (e.g. `edit file` + `*.env`) beat generic defaults.
- **Evaluation flow** (`PermissionEngine.evaluate`):
  1. Session auto-approve and per-tool auto-approve are checked first.
  2. Rules are merged (`session_overrides + default_rules`) and sorted by specificity.
  3. First matching rule wins.
  4. No match → `REQUIRES_APPROVAL`.
- **Default rules** (`DEFAULT_RULES`):
  - Read/search/browser operations → `ALLOW`
  - Write/execute/install/delete operations → `ASK`
  - System paths (`/etc/*`, `/usr/*`, `/bin/*`, `/sbin/*`) → `ASK`
  - Sensitive files (`*.env`, `.env*`, `*/.env`, `.ssh/*`, `.aws/*`) → `DENY`
  - Scream config (`~/.scream/config.toml`) → `ASK`
  - Catch-all unknown → `ASK`
- **Integration**: `src/scream/soul/approval.py` calls `PermissionEngine.evaluate` after
  yolo/afk checks and before the UI approval panel. `DENY` results return immediately
  without showing the panel.

## Memory System design

`src/scream/memory/` provides a three-tier persistent memory system with automatic
summarization, TTL-based cleanup, and injection into LLM context.

- **Storage format**: each entry is a `.md` file with JSON frontmatter:
  ```markdown
  ---
  {"tags": ["偏好"], "created_at": "...", "updated_at": "...", "expires_at": "..."}
  ---
  内容...
  ```
  - `expires_at` is present only on short-term entries.
  - Backward compatible with plain `.md` files (no frontmatter → empty tags).
  - `MEMORY.md` index is auto-generated in each scope directory.
- **Three-tier scope**:
  - **Short-term**: `{work_dir}/.scream/memory/short-term/` — auto-saved memories with a
    configurable TTL (default 48h). Expired entries are cleaned up on session start.
  - **Long-term**: `{work_dir}/.scream/memory/long-term/` — manually promoted or explicitly
    saved memories. Persist indefinitely.
  - **Global**: `~/.scream/memory/` — shared across all projects.
  - **Backward compatibility**: on startup, legacy `.md` files directly under
    `{work_dir}/.scream/memory/` are automatically migrated to `long-term/`.
- **Auto-memory** (`src/scream/memory/summarizer.py` + `screamsoul.py`):
  - Triggered after every `TurnEnd` (fire-and-forget background task).
  - LLM summarizes the turn into `{title, content, tags}` JSON.
  - Jaccard similarity deduplication against existing short-term entries (threshold 0.75).
  - Saved to `short-term/` with `expires_at = now + ttl_hours`.
  - Emits `MemorySaved` wire event; UI shows `💾 48小时短期记忆已保存`.
  - Input truncation: conversations >4000 chars are head/tail truncated before summarization.
  - Can be disabled via `auto_memory = false` in config or `/memory off` at runtime.
- **Search**: `MemoryManager.find_relevant(query, limit=5, search_scope="all")` uses
  token-based keyword matching with Chinese single-character tokens and English word
  tokens (2+ chars). Searches across short-term, long-term, and global.
- **Injection** (`MemoryInjectionProvider`):
  - Implements `DynamicInjectionProvider` (same pattern as plan mode / afk mode injections).
  - Runs before each LLM call, extracts the latest user query from history.
  - Finds up to 3 relevant memories and injects them as `[记忆] content` reminders.
  - Deduplicates across identical short queries; resets on context compaction.
  - `_last_injected_ids` is capped at 100 entries to prevent unbounded growth.
  - Registered in `ScreamSoul._injection_providers` alongside other providers.
- **Slash commands** (`/memory` in `src/scream/soul/slash.py`):
  - `list [short|long|global|all]` — list entries by scope (default `all`).
  - `search <keyword>` — keyword search across all scopes.
  - `get <id>` — show full content of a single entry.
  - `keep <id>` — promote a short-term entry to long-term.
  - `delete <id>` — remove by entry ID (searches all scopes).
  - `toggle | on | off` — enable/disable auto-memory for the current session.
  - `status` — show auto-memory state and entry counts per scope.

## Git commit messages

Conventional Commits format:

```
<type>(<scope>): <subject>
```

Allowed types:
`feat`, `fix`, `test`, `refactor`, `chore`, `style`, `docs`, `perf`, `build`, `ci`, `revert`.

## Versioning

The project follows a **minor-bump-only** versioning scheme (`MAJOR.MINOR.PATCH`):

- **Patch** version is always `0`. Never bump it.
- **Minor** version is bumped for any change: new features, improvements, bug fixes, etc.
- **Major** version is only changed by explicit manual decision; it stays unchanged during
  normal development.

Examples: `0.68.0` → `0.69.0` → `0.70.0`; never `0.68.1`.

This rule applies to all packages in the repo (root, `packages/*`, `sdks/*`) as well as release
and skill workflows.

## Release workflow

For the full procedure, follow the `release` skill (`.agents/skills/release/SKILL.md`). The summary:

1. Ensure `main` is up to date (pull latest).
2. Create a release branch, e.g. `bump-0.68` or `bump-pykaos-0.5.3`.
3. Update `CHANGELOG.md`: add a new `## 0.68 (YYYY-MM-DD)` section below `## Unreleased` (do not rename `## Unreleased`).
4. Update `pyproject.toml` version.
5. Run `uv sync` to align `uv.lock`.
6. Commit the branch and open a PR.
7. Merge the PR, then switch back to `main` and pull latest.
8. Tag and push:
   - `git tag 0.68` or `git tag pykaos-0.5.3`
   - `git push --tags`
9. GitHub Actions handles the release after tags are pushed.
