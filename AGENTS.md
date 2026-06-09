# apps/scream-code Development Guide

This file only contains rules local to `apps/scream-code`.

## TUI File Layout

`apps/scream-code` is the terminal UI / CLI app. The entry chain is:

`src/main.ts` -> `src/cli/commands.ts` -> `src/cli/run-shell.ts` -> SDK `ScreamHarness` -> `src/tui/scream-tui.ts`

Main directories:

- `src/constant/`: non-copy constants shared by CLI/TUI — product, protocol, paths, terminal control, updates, and so on.
- `src/cli/`: command-line arguments, subcommands, and CLI startup.
- `src/tui/`: the interactive terminal UI.
- `src/tui/scream-tui.ts`: the TUI master assembler, responsible for wiring state, layout, editor, session, SDK events, and dialogs together.
- `src/tui/commands/`: slash command definitions, parsing, ordering, and dynamic skill command generation.
- `src/tui/components/`: pi-tui components, organized by UI type.
- `src/tui/constant/`: non-copy constants reused across TUI modules — symbols, terminal sequences, render sizing, streaming-arg match rules, and so on.
- `src/tui/components/chrome/`: persistent UI chrome — footer, todo panel, welcome, loader, device code.
- `src/tui/components/dialogs/`: selectors, approval panels, question popups, and settings popups that temporarily replace the editor.
- `src/tui/components/editor/`: the custom input box and the file mention provider.
- `src/tui/components/media/`: image, diff, code highlight, and other media displays.
- `src/tui/components/messages/`: message blocks in the transcript — assistant, user, tool call, thinking, usage, subagent, and so on.
- `src/tui/components/panes/`: right-side / activity-area panes such as the activity pane and queue pane.
- `src/tui/reverse-rpc/`: the adapter layer that bridges SDK approval/question callbacks to the UI.
- `src/tui/theme/`: themes, color tokens, style helpers, and the pi-tui markdown theme.
- `src/tui/utils/`: TUI-only utility functions.
- `src/utils/`: app-wide utilities — clipboard, git, history, image, process, usage, and so on.

## Module Responsibilities

- `cli` only interprets command-line input, assembles startup arguments, and invokes the TUI. Do not put TUI interaction logic into the CLI.
- `ScreamTUI` coordinates; it does not accumulate complex business rules. New logic that can be tested independently should be split into `commands`, `components`, `reverse-rpc`, or `utils` first.
- `commands` only owns slash-command declaration, parsing, and the parsed-result types. The actual execution can be dispatched from `ScreamTUI`, but complex logic should continue to sink downward.
- `components` only handle presentation and local interaction; they must not call the SDK directly, and must not read or write session state directly.
- `reverse-rpc` converts SDK approval/question requests into the data shape a UI panel/dialog needs, and converts the user's choice back into an SDK response.
- `theme` is the single source of truth for colors and styles. Components must not bypass the theme system and use chalk named colors directly.
- `utils` holds utility functions with no UI-state dependency. Logic that needs `TUIState` or a component instance must not live under app-level `src/utils`.
- Resume replay orchestration lives in the `Session Replay` section of `ScreamTUI`, because it intentionally drives the same stateful render hooks as live events. Stateless replay parsing, limiting, and projection helpers belong in `src/tui/utils/message-replay.ts`.
- `apps/scream-code` may only use core capabilities through `@scream-cli/scream-code-sdk`. Do not import `@scream-cli/agent-core` directly in app code.

## ScreamTUI Internal Sections

`src/tui/scream-tui.ts` is large. When you modify it, place code into the existing responsibility section — do not just drop it where it happens to be convenient.

- Types and state creation: `ScreamTUIStartupInput`, `TUIState`, `createInitialAppState`, `createTUIState`. Before adding new global UI state, decide whether it really belongs in `TUIState`.
- Startup helpers: slash commands, autocomplete, skill commands, input history.
- Lifecycle: `start`, `init`, `stop`. They only handle startup/shutdown order — do not stuff feature implementations into them.
- Layout and editor: `buildLayout`, `setupEditorHandlers`, external editor, clipboard image, exit shortcuts.
- User input: `handleUserInput`, `executeSlashCommand`, `handleBuiltInSlashCommand`, `sendNormalUserInput`.
- Sending and queueing: `enqueueMessage`, `sendMessageInternal`, `sendMessage`, `steerMessage`, `finalizeTurn`.
- Session management: create, restore, switch, close, sync runtime state, subscribe to session events.
- Session replay: hydrate resume snapshots, drive replay records through live render hooks, and clean up transient replay state.
- Event routing: `handleEvent` only dispatches; concrete events go into the corresponding `handleXxx`.
- Streaming rendering: assistant delta, thinking, tool call, tool result, compaction, subagent, background agent.
- Transcript: `createTranscriptComponent`, `appendTranscriptEntry`, read/tool/agent group aggregation.
- Activity / queue / footer: `updateActivityPane`, `resolveActivityPaneMode`, `updateQueueDisplay`, terminal progress.
- Dialogs / selectors: help, session picker, memory picker, editor/model/thinking/theme/permission/settings selectors, approval / question panels.
- Slash command handlers: `handleThemeCommand`, `handleModelCommand`, `handlePlanCommand`, `handleCompactCommand`, `handleLoginCommand`, and so on.

If a section keeps growing, split pure functions, state projections, presentation components, and handler logic into the corresponding directories rather than continuing to expand `ScreamTUI`.

## Where New Features Go

The feature type decides where it lands:

- New CLI arguments: change `src/cli/commands.ts` / `src/cli/options.ts`, then pass them into the TUI via `src/cli/run-shell.ts`. Do not let the CLI operate on the session directly.
- New CLI subcommands: put them under `src/cli/sub/`, with non-interactive command logic only; when SDK access is needed, go through `@scream-cli/scream-code-sdk`.
- New slash commands: first change definition, parsing, and types under `src/tui/commands/`; put the execution entry into the slash-command handler section of `ScreamTUI`; split complex execution logic into `utils` or focused components when it has no reason to stay in `ScreamTUI`.
- New skill-derived commands: hook into `buildSkillSlashCommands` / the skill command map — do not hard-code a single skill.
- New transcript message types: define the data shape in `src/tui/types.ts`, add or extend a component under `components/messages/`, and register the renderer in `createTranscriptComponent`.
- New tool-result display: prefer extending `components/messages/tool-renderers/registry.ts` and the corresponding renderer; do not stack branches inside `ToolCallComponent`.
- New popup / selector: put it under `components/dialogs/` and mount it via `mountEditorReplacement`; if the trigger comes from an SDK callback, also check whether `reverse-rpc/` needs an adapter/controller/handler.
- New SDK event handling: add the dispatch in `handleEvent`, then add the corresponding `handleXxx`. If the event simply maps to a transcript entry.
- New session start / resume behavior: put it in the session management section, keeping `init` focused only on startup orchestration. New resume replay behavior belongs in the `Session Replay` section and should reuse live rendering paths where possible.
- New status bar, activity area, or queue display: change `chrome/footer`, `panes/activity`, `panes/queue`, and the corresponding `updateXxx` method.
- New configuration option: first change the read/write and schema in `src/tui/config.ts`, then wire the settings UI; when persistence is needed, go through `saveTuiConfig`.
- New constants: constants shared by CLI/TUI and not copy belong in `src/constant/`; non-copy constants reused only within the TUI belong in `src/tui/constant/`. Component-local copy, option labels, help descriptions, dialog title/footer text — keep these next to the corresponding component or command, do not centralize them into a global copy constants module.
- New general-purpose capability: if it does not depend on TUI state, put it under `src/utils/`; if it depends on TUI state or a component, put it under `src/tui/utils/`.

Test placement rules:

- Component behavior tests live next to the corresponding component's tests.
- Command parsing tests go under `test/tui/commands/`.
- reverse-rpc tests go under `test/tui/reverse-rpc/`.
- Pure utility tests go next to the corresponding utils tests.
- Do not create a generic `some-feature.test.ts` just to land a small feature.

## TUI Coding Conventions

- Do not over-encapsulate, especially for one- or two-line functions — do not introduce a two-layer wrapper, just inline.
- Functions with no state / UI side effects do not belong as private methods on the `ScreamTUI` class; put them in external utils.
- Constants must live in the corresponding `constant` directory; they must not be scattered through component or logic code.
- Inside `handleInput(data)`, when comparing a printable character (letter, digit, space, punctuation), it is **forbidden** to write literal comparisons such as `data === 'q'`. With the Kitty keyboard protocol enabled in terminals like VSCode, these keys are sent as CSI-u sequences (e.g. `\x1b[113u`), and a bare comparison will never match. Decode with `printableChar(data)` from `src/tui/utils/printable-key.ts` first, then compare; function keys continue to use `matchesKey(data, Key.*)`; control characters (codepoint < 32) may still be compared against the raw `data`. `test/tui/printable-key-guard.test.ts` enforces this in CI.

## How to Set Themes

Themes are managed centrally under `src/tui/theme/`:

- `colors.ts` defines semantic tokens: `ColorPalette`, `darkColors`, `lightColors`.
- `styles.ts` builds common chalk helpers on top of `ColorPalette`.
- `pi-tui-theme.ts` produces the theme configuration markdown / pi-tui requires.
- `bundle.ts` packs `colors`, `styles`, and `markdownTheme` into a `ScreamTUIThemeBundle`.
- `index.ts` / `detect.ts` handle the theme type and auto/dark/light resolution.

When setting or switching themes:

- The UI entry goes through `ThemeSelectorComponent`, `handleThemeCommand`, and `applyThemeChoice`.
- The real apply step goes through `ScreamTUI.applyTheme`, which should update `state.theme`, `state.appState.theme`, and notify the relevant components to refresh their palette.
- Persisting the user's choice goes through `saveTuiConfig`. Do not let a component write the config file itself.

When writing color:

- Do not use chalk named colors such as `chalk.red`, `chalk.cyan`, `chalk.white`, `chalk.gray`, `chalk.dim`, or `chalk.yellow` directly.
- If a component already has `colors`, use `chalk.hex(colors.<token>)(text)`.
- If a component already has `state.theme.styles` or styles passed in, prefer helpers such as `styles.error(text)`, `styles.dim(text)`.
- When new visual semantics have no token, first add a semantic field to `ColorPalette`, and fill in both `darkColors` and `lightColors`.
- In light themes, text tokens against a white background must be at least 4.5:1; borders and large chrome must be at least 3:1.
- Do not cache styled chalk functions at module top level. Theme switching must take effect within a single render, so styles must be generated on the render path from the current palette.

After a theme change, non-comment code must not contain chalk named colors such as `chalk.white`, `chalk.cyan`, `chalk.red`, `chalk.green`, `chalk.gray`, `chalk.yellow`, `chalk.blue`, `chalk.magenta`, `chalk.whiteBright`, or `chalk.blackBright`.

## MCP (Model Context Protocol)

ScreamCode has a built-in MCP client. Agents can call external tools (browser automation, GitHub operations, filesystem access, etc.) through the Model Context Protocol.

### Architecture

```
/mcp panel → write mcp.json → McpConnectionManager → StdioClient/HttpClient
                 ↑                                          ↓
           ~/.scream-code/mcp.json                   MCP server process
                                                      (launched via npx)
```

- **Config**: `~/.scream-code/mcp.json` (user-global) and `<cwd>/.scream-code/mcp.json` (project-local). Project entries override user entries with the same key.
- **Connection manager**: `packages/agent-core/src/mcp/connection-manager.ts` — `addServer` (runtime add + connect), `stopServer` (disconnect, keep entry), `removeServer` (disconnect + delete entry), `reconnect` (reconnect existing entry).
- **RPC chain**: `core-api.ts` → `core-impl.ts` → `session/rpc.ts` → node-sdk → TUI.
- **TUI panel**: `apps/scream-code/src/tui/commands/mcp.ts` — `/mcp` slash command with custom `McpPickerComponent`.
- **Footer**: MCP status is NOT shown in the footer status bar. Use `/mcp` to inspect.

### /mcp panel

```
/mcp → MCP management panel
  ├─ Installed servers (status + tool count)
  ├─ Enter → install+start (recommended) / toggle enable/disable (installed)
  ├─ d → uninstall (removes from mcp.json + disconnects)
  └─ Built-in recommendation: Playwright (browser automation)
```

### Adding recommendations

Edit the `RECOMMENDED` array in `apps/scream-code/src/tui/commands/mcp.ts`.

### Timeouts

- Playwright recommendation: `startupTimeoutMs: 300_000` (5 min — first launch downloads Chromium).
- Global default: `DEFAULT_STARTUP_TIMEOUT_MS = 60_000`.

## Slash Commands

All slash commands are declared in `src/tui/commands/registry.ts` and dispatched in `src/tui/commands/dispatch.ts`. Beyond the session-config-modelling helpers documented in `ScreamTUI`, these commands carry non-trivial state or backend integration:

### WolfPack Mode (`/wolfpack`)

Batch parallel subagent orchestration. Toggles `wolfpackMode` in `AppState`. When active, the LLM can use the `WolfPack` tool to spawn parallel subagents via a template + items pattern (max 20 items), executed concurrently via `Promise.allSettled` with aggregated results. Follows the PlanMode pattern end-to-end.

- **Entry**: `/wolfpack` (aliases: `wp`), toggles on/off with no args
- **State machine**: `packages/agent-core/src/agent/wolfpack/index.ts` — `WolfPackMode` (enter / exit / restoreEnter / isActive)
- **Injector**: `packages/agent-core/src/agent/injection/wolfpack.ts` — `WolfPackModeInjector`, injects usage instructions on enter/exit
- **Tool**: `packages/agent-core/src/tools/builtin/collaboration/wolfpack.ts` — `WolfPackTool`, runtime-gated by `wolfpackMode.isActive`
- **Permission policy**: `packages/agent-core/src/agent/permission/policies/wolfpack-mode-approve.ts` — auto-approves all tools when WolfPack is active
- **Records**: `wolfpack.enter` / `wolfpack.exit` for session replay recovery
- **Footer badge**: `wolfpack` in brand blue when active

### Goal System (`/goal`, `/goaloff`)

Persistent goal injection that survives turns and session resumes.

- **TUI**: `src/tui/commands/goal.ts` — subcommands: `status`, `pause`, `resume`, `replace`. `/goaloff` cancels entirely.
- **State**: `AppState.goal`, `goalActive`, `goalContinuationCount`. Injected into the system prompt by `GoalInjectionProvider`.
- **Storage**: persisted in session metadata (`custom.goal`) so goals survive session switch and resume.
- **Footer badge**: 🎯 + truncated goal text (green) when active.

### cc-connect (`/cc`)

One-click cc-connect daemon life cycle management (cross-platform).

- **TUI**: `src/tui/commands/cc.ts` — panel with start / stop / restart.
- **Platform**: macOS `launchd`, Linux `systemd`, Windows `pm2`.
- **Footer dot**: `●` green when cc-connect is active, dim when not. Refreshed every 3 s via `refreshCcStatus()`.
- **Config**: `src/tui/commands/cc-connect.ts` — channel setup wizard.

### Update (`/update`)

Manual update from GitHub. Silent background version check runs at startup.

- **Version source**: `src/cli/update/cdn.ts` — fetches `api.github.com/repos/LIUTod/scream-code/releases/latest`, strips `v` prefix from `tag_name`.
- **Cache**: `src/cli/update/cache.ts` — reads/writes `~/.scream-code/updates/latest.json`.
- **Compare**: `src/cli/update/select.ts` — `semver.gt(latest, current)`.
- **TUI startup**: `checkForUpdates()` in `scream-tui.ts` calls `refreshUpdateCache()` then `readUpdateCache()` + `selectUpdateTarget()`.
- **Welcome panel**: shows "有新版本（x.y.z）" when `hasNewVersion` is true.
- **Manual trigger**: `/update` command in `src/cli/update/` — git pull → pnpm install → pnpm -r build, with per-step timeouts and network error detection.
- **Constant**: `src/constant/app.ts` — `SCREAM_CODE_CDN_LATEST_URL`, `SCREAM_CODE_GITHUB_REPO`.

### /revoke

Undo the last N conversation turns. Anchors at user messages and restores the welcome panel if all messages are removed.

- **TUI**: `src/tui/commands/revoke.ts` — `findUndoAnchorEntryIndex`, `removeUndoContextComponents`.
- **Core**: `packages/agent-core/src/agent/context/index.ts` — `undo()` performs a backward walk, splices messages, and clamps `_tokenCount` down.
- **Availability**: `idle-only`.

## Agent-Core Mechanisms

### Compaction Pipeline

ScreamCode has a three-stage compaction pipeline coordinated at the `beforeStep` hook
in `packages/agent-core/src/agent/turn/index.ts`. Each step, before the LLM call:

```
Stage 1: Micro (zero LLM) → truncates old tool results to placeholders, always enabled, triggers at >= 50% usage
Stage 2: Full  (one LLM)   → LLM summarizes old messages, triggers at >= 75% usage
Stage 3: Block (safety net) → blocks the turn until compaction completes, triggers at >= 85% usage
```

- **Predictive trigger**: estimates next-step token growth and proactively compacts before overflow, rather than waiting for it to happen.
- **Circuit breaker**: 3 consecutive compaction failures → auto-compaction disabled for the current turn, auto-resets next turn.
- **Timeout**: `block()` waits up to 60 seconds for compaction, cancels and notifies the user on timeout.
- **Overflow fast-fail**: when the API returns a context overflow error, `chatWithRetry` no longer retries 3 times — it surfaces the error immediately so the upper layer can trigger emergency compaction.

Key files: `packages/agent-core/src/agent/compaction/{micro,full,strategy}.ts`,
`packages/agent-core/src/loop/retry.ts`.

### Memory System

The agent has a full memory system provided by the `@scream-cli/memory` package:

- **Storage**: JSONL file at `<project>/.scream-code/memory/entries.jsonl` with full CRUD support.
- **Categories**: `user_preference`, `feedback`, `project_context`, `reference`.
- **Extraction**: structured memories are automatically extracted from messages during compaction (LLM-driven), no manual steps needed.
- **Scoring**: multi-factor relevance algorithm (keyword overlap + recency decay + category weight + status boost), purely rule-based, zero LLM cost.

#### Auto Recall

On the first step of every new turn, `MemoryRecallInjector` automatically looks up
memories relevant to the current user query (up to 3) and injects them into context
as a `<system-reminder>`. Fully rule-based matching — no extra LLM call.

- **Registration**: `InjectionManager` registers it at construction time (requires `memoStore` to be available).
- **Opt-out**: set `memoStore` to `undefined` to disable auto recall.

Key files: `packages/agent-core/src/agent/injection/memory-recall.ts`,
`packages/memory/src/scoring.ts`.

#### Session Memory

`SessionMemory` tracks every tool execution in the current session (tool name,
argument summary, success/failure). After compaction, a summary is injected as a
`<system-reminder>` so the model retains awareness of recent actions even after
detailed conversation history is stripped.

Key file: `packages/agent-core/src/agent/session-memory.ts`.

#### Dream Consolidation (`/dream`)

A CCB-style four-stage memory consolidation command. LLM-driven:

1. **Orient** — scan all memories, report an overview
2. **Gather** — semantically identify duplicates, contradictions, and stale entries
3. **Consolidate** — produce a merge plan
4. **Prune** — execute after user confirmation

Includes automatic reminders: when >= 24 hours and >= 5 sessions have passed since
the last dream, a suggestion is injected on the first step of the turn.

- **Tracker**: `packages/memory/src/dream.ts` — `DreamTracker`, persisted to
  `<project>/.scream-code/dream-lock.json`.
- **Skill**: `packages/agent-core/src/skill/builtin/dream.ts` + `dream.md`.

Key files: `packages/memory/src/{dream,consolidator}.ts`,
`packages/agent-core/src/skill/builtin/dream.md`.

### WelcomeComponent Breathing

The welcome logo cycles through a 24-hue colour wheel at 40 ms intervals (25 fps).

- **Component**: `src/tui/components/chrome/welcome.ts` — `startBreathing()` / `stopBreathing()`.
- **Lifecycle**: breathing starts automatically at app launch. The first keystroke in the editor fires `onFirstInput`, which calls `stopBreathing()` permanently. `firstInputFired` is never reset across session switches.
- **Session switch**: `clearTranscriptAndRedraw()` does NOT call `resetFirstInputGate()`, so breathing stays off. `renderWelcome()` checks `hasFirstInputFired()` before starting the new component.
- **Rationale**: prevents expensive full-tree re-renders when the transcript is packed with replayed historical components.

## General Coding Requirements

- For optional object properties, pass `undefined` directly — do not use conditional spread.
- Optional object properties do not need to additionally allow `undefined` in the type.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module'`.
