# scream-code Development Guide

> This guide covers the whole monorepo. Sections marked **apps/scream-code** are app-specific; the rest apply to all workspace packages.

## Table of Contents

1. [Workspace Overview](#workspace-overview)
2. [Code Quality & Style](#code-quality--style)
3. [TUI Sanitization](#tui-sanitization)
4. [Testing Guidance](#testing-guidance)
5. [Commands & Workflow](#commands--workflow)
6. [TUI File Layout (apps/scream-code)](#tui-file-layout-apps-scream-code)
7. [Module Responsibilities (apps/scream-code)](#module-responsibilities-apps-scream-code)
8. [ScreamTUI Internal Sections (apps/scream-code)](#screamtui-internal-sections-apps-scream-code)
9. [Where New Features Go (apps/scream-code)](#where-new-features-go-apps-scream-code)
10. [TUI Coding Conventions (apps/scream-code)](#tui-coding-conventions-apps-scream-code)
11. [How to Set Themes (apps/scream-code)](#how-to-set-themes-apps-scream-code)
12. [MCP (apps/scream-code)](#mcp-apps-scream-code)
13. [Slash Commands (apps/scream-code)](#slash-commands-apps-scream-code)
14. [Agent-Core Mechanisms](#agent-core-mechanisms)
15. [General Coding Requirements](#general-coding-requirements)

---

## Workspace Overview

### Packages

| Package | Path | Responsibility |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `agent-core` | `packages/agent-core/` | Agent runtime: turn loop, session, tools, MCP client, compaction, memory, goal/wolfpack |
| `ltod` | `packages/ltod/` | Multi-provider LLM client with streaming support |
| `jian` | `packages/jian/` | Execution environment abstractions (filesystem, process, sandbox) |
| `node-sdk` | `packages/node-sdk/` | Node.js SDK (`ScreamHarness`, `Session`) consumed by the app |
| `memory` | `packages/memory/` | Cross-session memory store and scoring |
| `config`      | `packages/config/`      | Platform configuration, identity, model aliases |
| `migration-legacy` | `packages/migration-legacy/` | Legacy data migration — **deprecated, do not expand** |
| `apps/scream-code` | `apps/scream-code/` | CLI and terminal UI application (`scream` command) |

### Terminology

- When the user says **"agent"** or **"session"**, they mean the `packages/agent-core` runtime (`Session`, `Agent`, turn loop), not the assistant.
- **"app"** / **"TUI"** / **"CLI"** refers to `apps/scream-code`.
- **"SDK"** refers to `@scream-code/scream-code-sdk` exported from `packages/node-sdk`.
- **"LLM layer"** refers to `packages/ltod`.
- **"memory"** refers to `packages/memory` task-experience records.

### Cross-package Import Rules

- `apps/scream-code` must use core capabilities **only through `@scream-code/scream-code-sdk`**. Never import `@scream-code/agent-core` directly in app code.
- `packages/agent-core` must not depend on `apps/scream-code`.
- Prefer package-local imports. When crossing packages, import from the package's public `index.ts` or documented subpaths.
- For Node built-ins, prefer namespace imports: `import * as fs from 'node:fs/promises'`, `import * as path from 'node:path'`.

---

## Code Quality & Style

### TypeScript

- Avoid `any`. If unavoidable, add a short comment explaining why.
- Do **not** introduce new `ReturnType<>` usage for new code; prefer explicit type names. Existing uses (e.g., timer IDs) should migrate to named aliases when touched.
- Avoid inline type imports such as `import('pkg').Type` or `import('./module').Type`. Use top-level imports.
- Optional object properties: pass `undefined` directly — do not use conditional spread.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own public `index.ts`, internal `index.ts` barrels should prefer `export * from './module'`.

### Classes

- The current codebase uses `private readonly` for internal class state. Keep this style within a file; do not mix `private readonly` and native `#private` fields in the same component.
- Constructor parameter properties are fine (e.g., `constructor(private readonly host: Host)`).
- Leave externally accessible members bare (no `public` keyword).

### Promises & Async

- New code should prefer `Promise.withResolvers()` when it simplifies control flow. Do not refactor existing `new Promise` code purely for style.
- In Bun contexts, prefer `await Bun.sleep(ms)` over `new Promise(r => setTimeout(r, ms))`.

### Prompts & Static Copy

- Tool descriptions and system prompts live in `.md` files next to the code that uses them.
- Import them through the project's raw-text loader, e.g.:
  ```ts
  import DESCRIPTION from './tool.md';
  ```
  Do not inline multi-line prompts as template literals.
- UI copy, option labels, help text, and dialog titles should stay next to the component or command that uses them. Do not centralize them into a global "copy constants" module.

### Logging

- **Never use `console.log` / `console.warn` / `console.error` in TUI components or render paths** — it corrupts terminal rendering.
- `console.log` is allowed only in CLI-only, non-interactive flows (e.g., `channel-setup.ts`).
- Runtime errors should go through the logger or be written to the app log file, not printed to stdout/stderr.
- Existing `console.error` in `apps/scream-code/src/tui/tui-state.ts` should be treated as a legacy escape hatch, not a pattern to copy.

### Generated Files

- `dist/`, `.turbo/`, and build artifacts are generated. Never hand-edit them.
- `packages/agent-core/src/tools/builtin/**/*.md` are hand-authored prompt files; edit them directly.
- `packages/migration-legacy/` is deprecated; do not add new migration logic.

---

## TUI Sanitization

All text rendered in the TUI must be sanitized. Raw content — file contents, error messages, tool output, paths — breaks terminal rendering: tabs create visual holes, long lines overflow, and absolute paths leak the home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@earendil-works/pi-tui` or local render-utils).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Reuse existing `TRUNCATE_LENGTHS` constants; do not invent ad-hoc numbers.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Apply to every render path**, not just the happy path:
  - Success output (file previews, command output, search results).
  - **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, run `replaceTabs()` and truncate.
  - Diff content (added and removed).
  - Streaming previews.

**Streaming tool previews:** Tool-call previews can have multiple render paths. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Verify both live streaming and rebuilt transcript paths after any preview change.

---

## Testing Guidance

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- No placeholder tests, tautologies, or "the code ran" assertions (`expect(true).toBe(true)`, bare `not.toThrow()`, non-empty string checks, length-grew checks, "prompt exists" checks without semantic assertion).
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`.
- **Never use `mock.module()`**. It mutates the global module registry and leaks across files. Use `spyOn` on the imported module object instead.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

### Test Placement (apps/scream-code)

- Component behavior tests live next to the corresponding component's tests.
- Command parsing tests go under `test/tui/commands/`.
- reverse-rpc tests go under `test/tui/reverse-rpc/`.
- Pure utility tests go next to the corresponding utils tests.
- Do not create a generic `some-feature.test.ts` just to land a small feature.

---

## Commands & Workflow

- **Never commit, push, or publish unless explicitly asked.**
- Type-check: `bun run typecheck` (per package) or the workspace check command.
- Tests: `bunx vitest run` (package) or `bun run test` (workspace).
- Build: `bun run build`.
- Do not run raw `tsc` directly.

### Changesets

When generating a changeset (`.changeset/*.md`), never decide on a `major` bump on your own. `major` is reserved for breaking changes — renamed or removed commands/arguments, removed public APIs, changed behavior semantics, or incompatible user configuration. When you judge a change to meet the major criteria, stop and ask the user for confirmation first; only write `major` after they explicitly agree. Otherwise default to `minor` (fall back to `patch` when the change is clearly a fix with no new surface).

---

## TUI File Layout (apps/scream-code)

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

---

## Module Responsibilities (apps/scream-code)

- `cli` only interprets command-line input, assembles startup arguments, and invokes the TUI. Do not put TUI interaction logic into the CLI.
- `ScreamTUI` coordinates; it does not accumulate complex business rules. New logic that can be tested independently should be split into `commands`, `components`, `reverse-rpc`, or `utils` first.
- `commands` only owns slash-command declaration, parsing, and the parsed-result types. The actual execution can be dispatched from `ScreamTUI`, but complex logic should continue to sink downward.
- `components` only handle presentation and local interaction; they must not call the SDK directly, and must not read or write session state directly.
- `reverse-rpc` converts SDK approval/question requests into the data shape a UI panel/dialog needs, and converts the user's choice back into an SDK response.
- `theme` is the single source of truth for colors and styles. Components must not bypass the theme system and use chalk named colors directly.
- `utils` holds utility functions with no UI-state dependency. Logic that needs `TUIState` or a component instance must not live under app-level `src/utils`.
- Resume replay orchestration lives in the `Session Replay` section of `ScreamTUI`, because it intentionally drives the same stateful render hooks as live events. Stateless replay parsing, limiting, and projection helpers belong in `src/tui/utils/message-replay.ts`.
- `apps/scream-code` may only use core capabilities through `@scream-code/scream-code-sdk`. Do not import `@scream-code/agent-core` directly in app code.

---

## ScreamTUI Internal Sections (apps/scream-code)

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

---

## Where New Features Go (apps/scream-code)

The feature type decides where it lands:

- New CLI arguments: change `src/cli/commands.ts` / `src/cli/options.ts`, then pass them into the TUI via `src/cli/run-shell.ts`. Do not let the CLI operate on the session directly.
- New CLI subcommands: put them under `src/cli/sub/`, with non-interactive command logic only; when SDK access is needed, go through `@scream-code/scream-code-sdk`.
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

---

## TUI Coding Conventions (apps/scream-code)

- Do not over-encapsulate, especially for one- or two-line functions — do not introduce a two-layer wrapper, just inline.
- Functions with no state / UI side effects do not belong as private methods on the `ScreamTUI` class; put them in external utils.
- Constants must live in the corresponding `constant` directory; they must not be scattered through component or logic code.
- Inside `handleInput(data)`, when comparing a printable character (letter, digit, space, punctuation), it is **forbidden** to write literal comparisons such as `data === 'q'`. With the Kitty keyboard protocol enabled in terminals like VSCode, these keys are sent as CSI-u sequences (e.g. `\x1b[113u`), and a bare comparison will never match. Decode with `printableChar(data)` from `src/tui/utils/printable-key.ts` first, then compare; function keys continue to use `matchesKey(data, Key.*)`; control characters (codepoint < 32) may still be compared against the raw `data`. `test/tui/printable-key-guard.test.ts` enforces this in CI.

---

## How to Set Themes (apps/scream-code)

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

---

## MCP (apps/scream-code)

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

---

## Slash Commands (apps/scream-code)

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

#### Goal Loop & WriteGoalNote

The goal system runs in an autonomous loop (`driveGoal()` in `packages/agent-core/src/agent/turn/index.ts`). After each turn, if the goal is still active, the agent is prompted to continue. During execution:

- **WriteGoalNote tool**: `packages/agent-core/src/tools/builtin/goal/write-goal-note.ts` — lets the model record working notes (max 10 notes × 200 chars). Notes are stored in `GoalMode` memory state, not in conversation context, so compaction cannot lose them.
- **GoalInjector**: `packages/agent-core/src/agent/injection/goal.ts` — injects notes into each continuation turn under `## Working Notes`. Also prompts the model to use WriteGoalNote when discovering facts or hitting dead ends.
- **Lifecycle**: notes are cleared when the goal completes or is cancelled. Notes do not survive session resume (model re-accumulates them).
- **TUI ordering**: `/goal` is 5th in the quick command list (priority 121, after sessions).

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

### Skill Center (`/skill`)

管理已安装 Skill 与浏览可安装 Skill 包。原 `/plugin` 命令及其别名已合并为 `/skill` 的兼容别名。

- **Entry**: `/skill` (aliases: `skills`, `plugin`, `plugins`)
- **TUI**: `src/tui/commands/skill-center.ts` — 选择器面板，支持 `Enter` 激活、`i` 安装并注入、`d` 卸载
- **Loading overlay**: `SkillCenterLoadingComponent` 在加载已安装 Skill 与 Marketplace 数据时显示 spinner，避免画面卡顿
- **Marketplace fallback**: `src/tui/commands/skill-marketplace.ts` 提供内置可安装 Skill 包列表
- **Core install/remove**: `packages/agent-core/src/session/index.ts` — `Session.removeSkill` 删除手动安装的 skill 安装单元（包含子 Skill）；`Session.injectSkillRoots` 在不重启会话的情况下加载新插件的 Skill
- **Registry helpers**: `packages/agent-core/src/skill/registry.ts` — `SkillRegistry.ejectPlugin` / `removeSkillPath`
- **RPC chain**: `packages/agent-core/src/rpc/core-api.ts` → `core-impl.ts` → `session/rpc.ts` → node-sdk → TUI，新增 `removeSkill` / `injectPlugin`
- **Tests**: `apps/scream-code/test/tui/commands/skill-center.test.ts`, `packages/agent-core/test/skill/install-paths.test.ts`


---

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

The agent has a memory system provided by the `@scream-code/memory` package. Positioned as "task experience records" — structured logs of what was tried, what worked, and what failed. Each record also carries 3-5 semantic `tags` and a `projectDir`. Legacy entries without a `projectDir` or `tags` remain visible and usable.

- **Storage**: SQLite database at `<screamHomeDir>/memory/memos.sqlite` (legacy JSONL at `<screamHomeDir>/memory/entries.jsonl` is migrated and kept as `.bak`). Schema includes `project_dir` and `tags`.
- **Fields**: `userNeed` (需求), `approach` (方案), `outcome` (结果), `whatFailed` (踩坑), `whatWorked` (经验), `projectDir` (项目目录), `tags` (语义标签).
- **Extraction triggers**:
  - Compaction: `extractAndStoreMemos()` in `packages/agent-core/src/agent/compaction/full.ts` — scans compaction summary for `memory-memo` blocks.
  - Session exit: `extractMemoriesOnExit()` in `packages/agent-core/src/agent/index.ts` — takes last 30 messages × 300 chars, calls LLM.
  - Idle timer: after 10 minutes of no user input, `ScreamTUI.performIdleMemoryExtraction()` calls `session.extractMemoriesOnExit()`. Cooldown: 10 minutes. Compaction extraction updates the cooldown timestamp to avoid duplicates.
  - Manual write: `MemoryWrite` tool in `packages/agent-core/src/tools/builtin/memory/memory-write.ts` — the model can save a structured memo immediately when the user explicitly asks, e.g. "save this to memory", "save to memo", or "summarize and save". These entries are tagged with `extractionSource: 'manual'`.
- **Scoring**: keyword Jaccard similarity (45%) + recency decay 90 days (25%) + usage boost (15%) + project affinity (10%) + tag overlap with the current project's tag cloud (5%). Rule-based with optional local embedding similarity via `fastembed` (ONNX runtime, `packages/memory/src/embeddings.ts`).

#### Active Lookup

The model queries the memory store on demand via the `MemoryLookup` tool. It is no longer injected automatically at the start of every turn.

- **When to call**: the current task resembles prior work, you hit a repeating error or pattern, you are unsure of the best approach, or the user references a previous fix/decision.
- **Input**: `query` (required), optional `limit` (default 5, max 20), optional `min_score` (default 0.2), optional `scope` (`'global'` by default; use `'project'` to restrict results to the current working directory).
- **Output**: ranked memos with `approach`, `outcome`, `whatFailed`, `whatWorked`, relevance `score`, `projectDir`, and `tags`. Memos from the current project and memos sharing tags with it are ranked higher. The model should apply `whatWorked` and avoid `whatFailed`.
- **Registration**: `ToolManager.initializeBuiltinTools()` registers it only for the `main` agent when `memoStore` is available.
- **Manual injection**: users can still browse and inject existing memos via the `/memory` TUI picker (`apps/scream-code/src/tui/managers/dialog-manager.ts`).

#### Editing Memories

The `MemoryEdit` tool lets the model correct or delete a single memo by id. Use it when the user says a memory is wrong, outdated, or should be removed. For updates, only the provided fields are changed; omitted fields are preserved. `tags` can be updated to add or remove labels.

Key files: `packages/agent-core/src/tools/builtin/memory/memory-lookup.ts`,
`packages/agent-core/src/tools/builtin/memory/memory-write.ts`,
`packages/agent-core/src/tools/builtin/memory/memory-edit.ts`,
`packages/memory/src/scoring.ts`,
`packages/memory/src/store.ts`.

#### Session Memory

`SessionMemory` tracks every tool execution in the current session (tool name,
argument summary, success/failure). After compaction, a summary is injected as a
`<system-reminder>` so the model retains awareness of recent actions even after
detailed conversation history is stripped.

Key file: `packages/agent-core/src/agent/session-memory.ts`.

#### Dream Consolidation (`/dream`)

A CCB-style four-stage memory consolidation command. LLM-driven planning,
programmatic execution:

1. **Orient** — `MemoryConsolidatePlan` scans all memories and reports overview
   stats (count, outcome distribution, time range).
2. **Gather** — the model reviews the programmatic plan and semantically checks
   for false positives, contradictions, and additional stale entries.
3. **Consolidate** — the model presents the merge plan to the user.
4. **Prune** — after user confirmation, `MemoryConsolidateApply` deletes the
   originals, appends merged records with the correct JSONL envelope, and resets
   the dream tracker.

Includes automatic reminders: when >= 24 hours and >= 5 sessions have passed since
the last dream, a suggestion is injected on the first step of the turn.

`/dream` operates globally across all projects' memories. Legacy entries
without a `projectDir` are still considered so existing data is not lost. Merged
records inherit the union of the original tags.

- **Tracker**: `packages/memory/src/dream.ts` — `DreamTracker`, persisted to
  `<screamHomeDir>/dream-lock.json` (default `~/.scream-code/dream-lock.json`).
- **Store**: `packages/memory/src/store.ts` — `MemoryMemoStore`, persisted to
  `<screamHomeDir>/memory/entries.jsonl`.
- **Consolidator**: `packages/memory/src/consolidator.ts` —
  `buildConsolidationPlan` / `applyConsolidation`.
- **Tools**: `packages/agent-core/src/tools/builtin/memory/memory-consolidate.ts` —
  `MemoryConsolidatePlan` / `MemoryConsolidateApply`.
- **Skill**: `packages/agent-core/src/skill/builtin/dream.ts` + `dream.md`.

Key files: `packages/memory/src/{dream,consolidator}.ts`,
`packages/agent-core/src/tools/builtin/memory/memory-consolidate.ts`,
`packages/agent-core/src/skill/builtin/dream.md`.

### LSP Integration (read-only)

The agent can query language servers for read-only code intelligence via the `LSP` tool. This is useful before refactors, renames, or when diagnosing type errors.

- **Operations**:
  - `references` — find all usages of a symbol.
  - `definition` — jump to where a symbol is defined.
  - `diagnostics` — get type errors and warnings for a file.
- **Input**: `path` (required), `operation` (required), plus `line`/`character` for references/definition. `line` is 1-based; `character` is 0-based.
- **Behavior**: the tool opens the file in the language server, executes the request, and returns a formatted markdown list. It does not modify files.
- **Supported languages**: TypeScript/JavaScript (`typescript-language-server`), Python (`pyright-langserver`), Rust (`rust-analyzer`), Go (`gopls`). Unsupported file types return a friendly error.
- **Registration**: `ToolManager.initializeBuiltinTools()` constructs an `LspRegistry` and registers `LspTool` for the main agent.

Key files: `packages/agent-core/src/tools/builtin/lsp-tool.ts`,
`packages/agent-core/src/lsp/client.ts`,
`packages/agent-core/src/lsp/registry.ts`.

### Tool Priority and BashTool Interception

The agent MUST prefer specialized built-in tools over shell equivalents. `BashTool` recoverably blocks commands that duplicate built-in functionality, returning a `Blocked: <message>\n\nOriginal command: <command>` error so the caller can retry with the suggested tool. Interception only fires when the suggested tool is enabled (via `availableTools`), so a disabled tool never produces a "use Read instead" dead end. Only the leading token is matched — `ls; cat foo` or `ls | grep foo` pass through, letting prompt guidance handle compound commands. Interception covers `cat`/`head`/`tail`/`less`/`more`, `grep`/`rg`/`ag`/`ack`, `sed -i`/`perl -i`/`awk -i inplace`, and `echo ... > file`. Use `Read`, `Grep`/`LSP`, `Edit`, and `Write` instead. Bash is reserved for builds/tests, package managers, git, dev servers, and executing compiled programs.

Key files: `packages/agent-core/src/tools/builtin/shell/bash.ts`, `packages/agent-core/src/agent/tool/index.ts`, `packages/agent-core/src/profile/default/system.md`.

### Subagent Standardization

The `Agent` tool accepts optional `target`, `change`, and `acceptance` fields. When provided, they are composed into the required Target / Change / Acceptance structure and appended to the subagent prompt. This helps the parent agent include acceptance criteria without forgetting them. They can also be written directly into the `prompt` field.

Key files: `packages/agent-core/src/tools/builtin/collaboration/agent.ts`, `packages/agent-core/src/tools/builtin/collaboration/agent.md`.

### TodoList Phases

`TodoList` items support an optional `phase` field. Items sharing the same phase are rendered together, while preserving input order within each phase. The phase is preserved across state round-trips.

Key files: `packages/agent-core/src/tools/builtin/state/todo-list.ts`, `packages/agent-core/src/tools/builtin/state/todo-list.md`.

### Verification Protocol and Convergence Gate

The turn loop requires exactly one verification pass per code change. `WorkingSet` tracks files touched by `Write`/`Edit` and read by `Read`. `suggestVerificationCommands()` maps the project kind to appropriate build/test/lint commands.

For simple or single-file fixes, the model should run the obvious verification command directly
(e.g. `npx -p typescript tsc --noEmit --strict file.ts`, `python3 -m py_compile file.py`). For
complex projects or when the correct command is unclear, the model may spawn the `verify`
subagent instead.

Once a verification command passes, the model must deliver rather than run additional build/test/lint commands to "double-check" the same change.

`WorkingSet` also records recent successful verification commands with their full output and turn ID. When a Bash verification command is requested again within 60 seconds and no unverified file has been touched since the prior run, `TurnFlow.prepareToolExecution()` returns the cached result without re-executing the shell. The model should not request the same verification command repeatedly, and should not substitute a different command to satisfy the same verification urge.

`TurnFlow` injects a `convergence_gate` system reminder when the model tries to stop while:

- the last assistant step had no content,
- a tool failed in the current turn,
- there are unverified touched files,
- a TodoList update is missing for an active goal, or
- the turn produced meaningful work (file changes or a passed verification) but the final response is too brief or only acknowledges completion.

The gate fires up to five times per turn for the hard checks; the brief-final-response check is allowed one remedial step. Empty or failed verification triggers a retry rather than allowing the model to claim completion.

Key files: `packages/agent-core/src/agent/turn/index.ts`, `packages/agent-core/src/agent/working-set.ts`, `packages/agent-core/src/profile/default/system.md`.

### Cron / Scheduled Tasks

The agent has an experimental cron subsystem for scheduling recurring tasks (periodic memory extraction, system health checks, etc.).

- **Registry**: `packages/agent-core/src/tools/cron/` — cron expression parser (`cron-expr.ts`), scheduler (`scheduler.ts`), persistence (`persist.ts`, `session-store.ts`), and tool definitions (`cron-create.ts`, `cron-list.ts`, `cron-delete.ts`).
- **Manager**: `packages/agent-core/src/agent/cron/manager.ts` — polls for due jobs, fires them via the agent turn loop, persists results.
- **Jitter**: `packages/agent-core/src/tools/cron/jitter.ts` — adds random jitter to cron schedules to avoid thundering herds.
- **Feature flag**: cron is experimental and not enabled by default. Toggle via scream config.

Key files: `packages/agent-core/src/tools/cron/`, `packages/agent-core/src/agent/cron/`.

### WelcomeComponent Breathing

The welcome logo cycles through a 24-hue colour wheel at 40 ms intervals (25 fps).

- **Component**: `src/tui/components/chrome/welcome.ts` — `startBreathing()` / `stopBreathing()`.
- **Lifecycle**: breathing starts automatically at app launch. The first keystroke in the editor fires `onFirstInput`, which calls `stopBreathing()` permanently. `firstInputFired` is never reset across session switches.
- **Session switch**: `clearTranscriptAndRedraw()` does NOT call `resetFirstInputGate()`, so breathing stays off. `renderWelcome()` checks `hasFirstInputFired()` before starting the new component.
- **Rationale**: prevents expensive full-tree re-renders when the transcript is packed with replayed historical components.

---

## General Coding Requirements

- For optional object properties, pass `undefined` directly — do not use conditional spread.
- Optional object properties do not need to additionally allow `undefined` in the type.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module'`.
