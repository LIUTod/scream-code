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

### agent-core intra-package dependency direction

`packages/agent-core/src` top-level directories form three layers (dependencies may only point downward):

- **Support layer** (any layer may depend on it; must not depend upward): `utils/` `errors/` `flags/` `logging/` `config/` `profile/` `lsp/` `markit/`
- **Orchestration layer** (depends on support-layer and tool-layer public contracts): `agent/` `session/` `rpc/` `loop/`
- **Tool layer** (depends on the support layer and the public contracts of `loop/` and `agent/tool`): `tools/` `mcp/` `plugin/` `skill/`

Rules:

- `import type` across layers is allowed (types are erased at compile time — no runtime coupling): the tool layer may `import type` orchestration-layer types (`GoalSnapshot`, `PlanData`, `CronManager`, `ContextMessage`, etc.), but must not `import type` private implementation details of orchestration-layer class instances.
- The tool layer must NOT **value-import** orchestration-layer runtime implementations (`agent/goal`, `agent/context`, `agent/plan`, `agent/cron` class instances and constants). Tools that need agent state should go through the execution context (`ToolContext`) first; the ~18 existing constructor-injected `Agent` references are a legacy pattern — new code should avoid reading state directly from inside the agent; constants a tool needs should live in the tool or be exported via an explicit orchestration-layer contract.
- `agent/` may value-import `tools/` (existing pattern, including deep paths like `tools/cron/*`, `tools/support/*`; prefer public entry points in new code).
- **Existing exception (do not add new ones)**: `agent/cron/manager.ts` value-importing `tools/cron/` clock/scheduler/cron-fire-xml/persist/session-store is a legacy implementation-reuse exception; new code must not copy it; prefer moving shared logic to the support layer or local to `agent/cron`.
- Before adding a cross-layer **value import**, first explain why it cannot be solved via `ToolContext` or a local constant.

---

## Code Quality & Style

### TypeScript

- Avoid `any`. If unavoidable, add a short comment explaining why.
- Keep the codebase erasable-TypeScript compatible (Node strip-only): do **not** introduce `enum`, `namespace`/`module`, `import =`, or `export =` — constructs that need JS emit. Use string-literal unions instead of `enum`. The current codebase has zero `enum` usages; keep it that way.
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

- Issue-specific regression tests go under `packages/*/test/**/regressions/<issue-number>-<short-slug>.test.ts` (name includes the issue number so failures trace back to the report). General tests live next to the code they cover.

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

### Releasing

**Lockstep versioning**: all 10 packages share one version; every release bumps them together. 9 packages are private (not published to npm); only `apps/scream-code` (`scream-code`) is published.

- The release pipeline runs through changesets: record changes with `pnpm changeset add`, push to `main`, and the GitHub Actions workflow (`release.yml`) opens a "ci: release packages" version PR that bumps all fixed-group packages and generates their `CHANGELOG.md`. Merge the version PR, then publish manually (`pnpm publish`) — the workflow currently has no `publish` step; add one only if npm trusted publishing is configured.
- `.changeset/config.json` defines the 9-package fixed group (`@scream-code/*` + `scream-code`) so any bump keeps them in sync. The **root `package.json` is not a workspace and changesets never touches it** — sync its `version` manually when releasing (one line; the other 9 packages are automatic).
- Tag releases as `vX.Y.Z` (with the `v` prefix). Never edit released `CHANGELOG.md` sections.
- **Never hand-edit the 9 packages' `package.json` versions to release** — that bypasses the lockstep group and skips CHANGELOG generation. Exceptions require an explicit user request (e.g. a hotfix bump with a follow-up changeset).

### Git

- **Never commit, push, or publish unless explicitly asked** (see above). When committing is asked for:
  - Stage only files you changed in this session — explicit `git add <path>`; **never** `git add -A` / `git add .`.
  - Run `git status` before committing and verify the staged set contains only your files.
- Never run: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git commit --no-verify`.
- If a rebase/merge conflict occurs, resolve only files you modified; if a conflict is in a file you did not touch, abort and ask the user.
- Never force-push.

### Dependency Safety

- Treat npm dependency and lockfile changes as reviewed code. Direct external dependencies currently use caret ranges (`^x.y.z`) — keep that convention, but never upgrade a batch of deps blindly.
- Before upgrading behavior-sensitive dependencies (network stacks, parsers, SDKs), read the target version's changelog and evaluate functional impact — do not apply blindly.
- Lockfile changes ship with the code that caused them and are reviewed like code; never commit lockfile changes silently.

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

Batch parallel subagent orchestration. Toggles `wolfpackMode` in `AppState`. When active, the LLM can use the `WolfPack` tool to spawn parallel subagents via a template + items pattern with **no item cap** (all items run in parallel via `Promise.allSettled`), aggregated into a single result. Follows the PlanMode pattern end-to-end.

- **Entry**: `/wolfpack` (aliases: `wp`), toggles on/off with no args
- **State machine**: `packages/agent-core/src/agent/wolfpack/index.ts` — `WolfPackMode` (enter / exit / restoreEnter / isActive)
- **Injector**: `packages/agent-core/src/agent/injection/wolfpack.ts` — `WolfPackModeInjector`, injects usage instructions on enter/exit
- **Tool**: `packages/agent-core/src/tools/builtin/collaboration/wolfpack.ts` — `WolfPackTool`, runtime-gated by `wolfpackMode.isActive`. Tool description injects the 7 preset `subagent_type` profiles (coder/explore/plan/verify/reviewer/oracle/writer) plus a per-batch selection guide so the model can pick the right type for each batch (reviewer for audits, writer for content, etc.).
- **Permission policy**: `packages/agent-core/src/agent/permission/policies/wolfpack-mode-approve.ts` — auto-approves all tools when WolfPack is active
- **Records**: `wolfpack.enter` / `wolfpack.exit` for session replay recovery
- **Footer badge**: `wolfpack` in brand blue when active

### RLM Mode (`/rlm`)

Persistent-python runtime: a long-lived `python3 -u -i` kernel where state (variables, imports, loaded data) survives across tool calls, plus a subagent bridge so the model can spawn recursive subagents from code.

- **Entry**: `/rlm` toggles on/off with no args; `/rlm on|off` explicit. `/rlm-max-depth N` sets the recursion cap (0 = unlimited, the default is unlimited).
- **Kernel**: `packages/agent-core/src/tools/builtin/python/python.ts` — `PythonTool` with a base64 single-line `exec` bootstrap injecting `rlm()`/`rlm_wait()` bridge helpers. Replies go through a `/tmp` file bridge (`scream-rlm-<pid>-<id>.json`) to avoid stdin read/write contention.
- **State machine**: `packages/agent-core/src/agent/index.ts` — `setRlmEnabled` / `getRlmEnabled` / `inheritRlm` / `rlmDepth` / `rlmMaxDepth` (default `Infinity` = unlimited recursion).
- **Recursion**: `packages/agent-core/src/session/subagent-host.ts` — spawned children inherit depth `parent+1`, the max-depth cap, and RLM mode itself (python tool mounted after the child profile is applied), so the chain continues parent → child → grandchild … indefinitely.
- **Host handlers**: `packages/agent-core/src/agent/tool/index.ts` — `rlm.run` (spawn, depth-checked) / `rlm.result` (wait) / `__dispose__` (abort in-flight children on kernel teardown).
- **Resilience**: graceful interrupt first (SIGINT, 1.5s grace, state preserved), SIGKILL only if the kernel does not settle; `_snapshot()`/`_restore()` pickle state so a crashed kernel is resurrected with variables intact.
- **Records**: `rlm.enter` / `rlm.exit` for session replay recovery.
- **Footer badge**: `RLM` in bright yellow when active.

### Goal System (`/goal`, `/goaloff`)

Persistent goal injection that survives turns and session resumes.

- **TUI**: `src/tui/commands/goal.ts` — subcommands: `status`, `pause`, `resume`, `replace`, `update`, `setup`. `/goaloff` cancels entirely. `/goal setup` runs a guided, LLM-refined objective flow (brief description -> `session.generateText` refinement -> user confirm/edit -> config wizard).
- **State**: `AppState.goal`, `goalActive`, `goalContinuationCount`. Injected into the system prompt by `GoalInjectionProvider`.
- **Storage**: persisted in session metadata (`custom.goal`) so goals survive session switch and resume.
- **Footer badge**: 🎯 + truncated goal text (green) when active.

#### Goal Loop & WriteGoalNote

The goal system runs in an autonomous loop (`driveGoal()` in `packages/agent-core/src/agent/turn/index.ts`). After each turn, if the goal is still active, the agent is prompted to continue. During execution:

- **WriteGoalNote tool**: `packages/agent-core/src/tools/builtin/goal/write-goal-note.ts` — lets the model record working notes (max 10 notes × 200 chars). Notes are stored in `GoalMode` memory state, not in conversation context, so compaction cannot lose them.
- **GoalInjector**: `packages/agent-core/src/agent/injection/goal.ts` — injects notes into each continuation turn under `## Working Notes`. Also prompts the model to use WriteGoalNote when discovering facts or hitting dead ends.
- **Lifecycle**: notes are cleared when the goal completes or is cancelled. Notes do not survive session resume (model re-accumulates them).
- **TUI ordering**: `/goal` is 6th in the quick command list (priority 120, after rlm).

### Loop Mode (`/loop`)

Stateless retry with an optional `--verify` shell gate. Each iteration re-sends the same prompt; the model does not see prior iteration output. Use only for idempotent tasks with an objective exit condition (wait for CI, health-check polling, retry a flaky build). For tasks that need to adapt based on the previous failure, use `/goal` instead — the model carries working notes across turns.

- **Entry**: `/loop [iterations|duration] [prompt] [--verify "command"]`
- **TUI**: `src/tui/commands/loop.ts` — `handleLoopCommand`, `disableLoopMode`, `describeLoopStatus`
- **Args parser**: `src/tui/utils/loop-limit.ts` — `parseLoopLimitArgs` extracts `--verify` (quoted) + iteration/duration limit + prompt
- **Verifier**: `src/tui/utils/loop-verifier.ts` — `runShellVerifier` runs the verify command, returns `{ passed, output, durationMs, exitCode }`
- **Auto-submit**: `src/tui/controllers/session-event-handler.ts` — `advanceLoopIteration` runs the verifier after each turn, stops on pass, decrements the limit, and re-sends the prompt. Esc during the verifier pauses without corrupting state.
- **Auto permission**: opening loop with `permissionMode === 'manual'` auto-switches to `auto` (via `ensureAutoPermission`) so iterations don't block on approval. Closing loop does **not** restore the previous mode.
- **Footer badge**: `loop N/M` (iterations), `loop Nm` / `loop Ns` (duration), ` · ✗` suffix when the last verify failed
- **TUI ordering**: `/loop` is a lightweight inner-loop mode, not part of the quick command priority list — it is a tool for driving repeated verify cycles, not a goal replacement.

One-click cc-connect daemon life cycle management (cross-platform).

- **TUI**: `src/tui/commands/cc.ts` — panel with start / stop / restart.
- **Platform**: macOS `launchd`, Linux `systemd`, Windows `pm2`.
- **Footer dot**: `●` green when cc-connect is active, dim when not. Refreshed every 3 s via `refreshCcStatus()`.
- **Config**: `src/tui/commands/cc-connect.ts` — channel setup wizard.

### Update (`/update`)

Manual and auto update via npm. Silent background version check runs at startup.

- **Version source**: `src/cli/update/cdn.ts` — `fetchLatestVersionFromNpm()` runs `npm view scream-code version` (with `shell: process.platform === 'win32'` so npm.cmd resolves on Windows). Validates semver before returning.
- **Cache**: `src/cli/update/cache.ts` — reads/writes `~/.scream-code/updates/latest.json` with `source: 'npm'` and a Zod schema.
- **Compare**: `src/cli/update/select.ts` — `semver.gt(latest, current)`.
- **Refresh**: `src/cli/update/refresh.ts` — `refreshUpdateCache()` calls `fetchLatestVersionFromNpm()`, writes the cache on success, propagates errors so a transient npm blip leaves the existing cache intact.
- **TUI startup**: `checkForUpdates()` in `scream-tui.ts` calls `refreshUpdateCache()` then `readUpdateCache()` + `selectUpdateTarget()`.
- **Welcome panel**: shows "New version available (x.y.z)" when `hasNewVersion` is true.
- **Preflight**: `src/cli/update/preflight.ts` — `runUpdatePreflight()` prompts interactively (or prints the manual command when non-TTY) and runs `npm install -g scream-code@latest` via `spawn` with `shell: process.platform === 'win32'` and `stdio: 'inherit'`. Single step, no git/pnpm.
- **Manual trigger**: `/update` in `src/tui/commands/update.ts` — `npm install -g scream-code@latest` via `spawn` with `shell: process.platform === 'win32'`, 5-minute timeout, network-error detection with Chinese user-facing messages.

### /revoke

Undo the last N conversation turns. Anchors at user messages and restores the welcome panel if all messages are removed.

- **TUI**: `src/tui/commands/revoke.ts` — `findUndoAnchorEntryIndex`, `removeUndoContextComponents`.
- **Core**: `packages/agent-core/src/agent/context/index.ts` — `undo()` performs a backward walk, splices messages, and clamps `_tokenCount` down.
- **Availability**: `idle-only`.

### User Preferences (`/like`)

Collects the user's persona/preferences through a short interactive TUI and injects them into the **main agent** system prompt via the existing `{{ ROLE_ADDITIONAL }}` placeholder. Each `/like` save overwrites the previous preferences.

- **Entry**: `/like` (no arguments)
- **TUI flow**: three free-form text inputs — nickname, response tone, other preferences — followed by a save notification
- **TUI command**: `apps/scream-code/src/tui/commands/like.ts`
- **Persistence**:
  - Structured preferences are saved in `~/.scream-code/tui.toml` under `[like]`.
  - A rendered `~/.scream-code/user-prefs.md` file is written for `agent-core` to load.
- **Prompt injection**: `packages/agent-core/src/profile/context.ts` reads `user-prefs.md` into `PreparedSystemPromptContext.roleAdditional`; `packages/agent-core/src/profile/resolve.ts` maps it to `{{ ROLE_ADDITIONAL }}`.
- **Scope**: affects **new sessions / new agents** created after saving. It does not retroactively update the currently running session's system prompt, and subagents keep their default profiles.
- **Availability**: `always` (works even without an active session).


### Session Trace (`/trace`)

Replays the current session's wire log as a self-contained interactive HTML timeline and opens it in the browser. Long sessions have dedicated performance guards.

- **Entry**: `/trace` (availability `always`)
- **TUI**: `src/tui/commands/trace.ts` — reads `sessionDir/agents/main/wire.jsonl` → `buildTraceCells` → `renderTraceHtml` → writes `tmpdir()/scream-trace.html` (fixed filename + `?v=Date.now()` anti-cache), opens via `open`/`cmd start`/`xdg-open`
- **Builder**: `src/utils/trace/trace-builder.ts` — `buildTraceCells` (user/message/tool cell types); system-context records merge into the next user turn; `turn.prompt` starts a new turn
- **Renderer**: `src/utils/trace/render-trace-html.ts` — three-lane timeline Input/Model/Tools, Seq/Time dual mode, fixed two-column ledger, Turns/Calls folding; `</`→`<\/` escaping against script injection + title/sessionId HTML escaping
- **Long-session performance**: `MAX_DETAIL=4000` / `MAX_CELLS=4000` caps + old cells fold into per-turn summary rows; ledger pagination `PAGE=300`; timeline sampling `ceil(n/1500)`
- **Data model**: `src/utils/trace/trace-types.ts` — `TraceCell` (tokens/TTFT/decoding/model/finishReason/turn)

### Conversation Search (`/search`)

Opens the full-screen session search overlay (same as Ctrl+Shift+F).

- **Entry**: `/search` — `src/tui/commands/search.ts`, opens the full-screen search overlay
- **i18n**: zh/en localized descriptions

### User Message Highlight (`/hl`)

Renders the user message with the roleUser theme background block; `/hl` toggles it with an immediate re-render.

- **Entry**: `/hl` (alias: `highlight`) — `src/tui/commands/hl.ts` `toggleUserMessageHighlight` + `requestRender`
- **Rendering**: `src/tui/components/messages/user-message.ts` — `<system-reminder>` prefixes are never highlighted; when enabled the whole row gets a `bgHex(roleUserBg)` background + contrast text (images go inside the block), when disabled only roleUser-colored text + ■ prefix; the cache is keyed by the toggle state
- **Config**: `ui-preferences.ts` `userMessageHighlightEnabled` (default on); theme keys `roleUser`/`roleUserBg` (dark `#f7e308` / light `#bd5302`)

### Turn Elapsed Marker (`/snaptimer`)

Stamps a light-gray elapsed-time marker (e.g. ` 23m 42s`) at the end of the assistant's final reply after each turn; global toggle, persisted.

- **Entry**: `/snaptimer` (alias: `timer`) — `src/tui/commands/snaptimer.ts` `toggleTurnElapsed`
- **Timing**: `src/tui/controllers/streaming-ui.ts` `markTurnStarted`/`formatElapsed`/`appendTurnSummaryLine`; `transcript-controller.ts` `appendElapsedToLastAssistant` matches by turnId and appends to the last line (not in the markdown source, not in the LLM context)
- **Config**: `ui-preferences.ts` `turnElapsedEnabled` (default on), persisted in `<dataDir>/ui-preferences.json`


### Plugin Center (`/plugin`) & Code Extensions (`/extension`)

Manages installed plugins and browses installable plugin packages; `/extension` manages code plugins (dynamic-import runtime). `/skill` is the hidden compat alias of `/plugin` (routeable but not shown in completion/help).

- **Entry**: `/plugin` (aliases: `skills`, `plugins`; hiddenAlias: `skill`), `/extension` (aliases: `extensions`)
- **TUI**: `src/tui/commands/skill-center.ts` — picker panel: `Enter` activate, `i` install-and-inject, `d` uninstall
- **Extension runtime**: `packages/agent-core/src/plugin/runtime/extension.ts` — `discover()` (by manifest `entryPoint`), `load()` (cached dynamic import), `activate()` (register manifest hooks first, then call `module.activate(ExtensionContext)`; roll back on failure), `deactivate()`; `ExtensionContext` = `{ services, events, config, pluginId }`
- **Event bus**: `packages/agent-core/src/agent/events.ts` — `EventSubscriptionBus.subscribe(type|'*')` / `dispatch()` (handler errors are swallowed, never break the main loop); manifest hooks register in bulk via `session/hooks/engine.ts:registerAll`
- **/extension subcommands**: `src/tui/commands/extension.ts` — `activate|deactivate|status [pluginId]`; bare `/extension` = status; goes through `session.activatePlugin` / `deactivatePlugin` / `pluginExtensionStatus`
- **Activation text unified to plugin**: `skillact.activated` = "▶ Activated plugin: …" (i18n en/zh)
- **Plugin display name**: plugin-package skills show `displayName` instead of the raw plugin id
- **Uninstall impact**: plugin skills can only be uninstalled as a whole package (the SDK throws `removeSkill` for plugin skills); the confirm dialog spells out that the entire package (N skills) will be removed. Manual skills still go through `removeSkill`
- **AGENTS.md excluded from skill scanning**: `packages/agent-core/src/skill/scanner.ts` adds `agents.md` to `DOCUMENTATION_MARKDOWN_LOWER`
- **Marketplace fallback**: `src/tui/commands/skill-marketplace.ts` provides the built-in installable plugin package list
- **Loading overlay**: `SkillCenterLoadingComponent` shows a spinner while loading installed skills and marketplace data
- **Core install/remove**: `packages/agent-core/src/session/index.ts` — `Session.removeSkill` (manual install unit), `Session.injectSkillRoots` (loads new plugin skills without restarting the session)
- **Registry helpers**: `packages/agent-core/src/skill/registry.ts` — `SkillRegistry.ejectPlugin` / `removeSkillPath`
- **RPC chain**: `packages/agent-core/src/rpc/core-api.ts` → `core-impl.ts` → `session/rpc.ts` → node-sdk → TUI, adding `removeSkill` / `injectPlugin`
- **Tests**: `apps/scream-code/test/tui/commands/skill-center.test.ts`, `packages/agent-core/test/skill/install-paths.test.ts`


---

## TUI Runtime Behaviors (apps/scream-code)

### Tool Card Rendering (Bash / Grep)

- **Bash**: `src/tui/components/messages/shell-execution.ts` — collapsed card always shows the command (`highlightLines(command,'bash',colors)` syntax highlight + dim `$ ` prefix), collapsed limit `SHELL_COMMAND_COLLAPSED_LINES=3` lines, ctrl+o expands to see the full command
- **Grep**: `tool-renderers/glance-lines.ts` `GlanceLinesComponent` — `truncateToWidth(line, width, '…')` hard-truncates without wrapping; `tool-renderers/summary.ts` `grepGlance` — structured `display.search_results`, `GLANCE_SAMPLES=3` samples, `path:line` column alignment, dim directory + default-color filename, amber line number, `+N more`

### Streaming Token Pacing

Decouples "arrival" from "display" — a shown-length cursor on the draft gains budget each frame by the measured arrival rate: fast models stay smooth, slow models don't freeze, bursts spread over several frames.

- **Controller**: `src/tui/controllers/streaming-ui.ts` `flush()`/`advanceAssistantShown()`/`finalizeAssistantStream` (forces a full flush at the end)
- **Constants**: `src/tui/constant/streaming.ts` — `SMOOTH_FRAME_MS=50`, `MIN_CHARS_PER_FRAME=1`, `MAX_CHARS_PER_FRAME=25`, `DEFAULT_ARRIVAL_TOK_PER_SEC=50`, `CHARS_PER_TOKEN=2.5`; thinking/tool still flush at `STREAMING_UI_FLUSH_MS=50`
- **Speed**: `src/tui/utils/speed-tracker.ts` — `SPEED_WINDOW_MS=3000`, `SPEED_MAX=200`, `getSharedSpeedTracker()`; observation point `streaming-ui.ts:151-162`

### Cache Hit Rate Footer & Usage Accounting

Footer persistently shows the cache hit rate and token usage (session accumulation + model badge glow).

- **Footer**: `src/tui/components/chrome/footer.ts` — `${ccDot} ${segHit} ${contextPart} ${statusPart}` order; shows `--` before any input tokens; model badge green shimmer while thinking/waiting/composing, cyan during tool execution, gray when idle; 30fps ticker (`1000/30`ms)
- **TUI accumulation**: `src/tui/controllers/session-event-handler.ts` `handleStepCompleted` accumulates `turn.step.completed` usage into `appState.sessionUsage` (compaction produces no such event, so it is excluded)
- **Agent-side persistence**: `packages/agent-core/src/agent/usage/index.ts` — `turnTotal` field, `record(scope:'turn')` accumulation, `records/index.ts` keeps `usageScope` on restore/replay; `session-manager.ts` `syncRuntimeState` seeds with `status.usage.turnTotal`
- **Cache-write separate accounting**: `packages/ltod/src/providers/openai-common.ts` — pulls `prompt_tokens_details.cache_write_tokens` into `inputCacheCreation`; the three buckets are disjoint (input/cacheRead/cacheWrite)

### Startup Empty-Session Pruning

On startup, prunes working-directory empty sessions that never received a user message and were never named (best-effort, does not block startup).

- **Location**: `src/tui/managers/session-manager.ts` — `PRUNE_EMPTY_SESSION_GRACE_MS = 5*60*1000` grace window; `isPrunableEmptySession` (keeps archived / already-prompted / placeholder-title / within-grace sessions); `isUntitledTitle` treats 'New Session' as unnamed; skips the session about to be used

### Model Refresh & Switch Confirmation

- **Refresh**: `src/tui/commands/config.ts` `handleModelCommand` → `refreshModelsForPicker` (`harness.getConfig({reload:true})` raced against a 2s timeout)
- **Status confirmation**: after `setModel`/`setThinking`, `session.getStatus()` re-reads `effectiveAlias`/`effectiveThinking` (the provider may route to a different variant)
- **Cache warning**: switching models with `contextTokens > 0` prompts "switching models invalidates the existing prompt cache - use /new to avoid extra token costs."

### Clipboard Copy

On selection release, writes the selected text to the system clipboard (`pbcopy` / `wl-copy` / `xclip` / PowerShell), replacing the OSC 52 that most terminals silently drop; has a degradation path on failure.


---

## Agent-Core Mechanisms

### Fusion Plan

`EnterPlanMode` supports a `mode: 'fusion'` argument. When the main agent enters fusion plan mode, it is prompted to call the `FusionPlan` built-in tool instead of writing the plan manually. `FusionPlanTool` spawns multiple `plan` subagents in parallel via `SessionSubagentHost`, each exploring the task from a different angle, then a synthesis subagent merges the outputs into a single consolidated plan. The synthesized plan is written to the session plan file with `strategy: 'fusion'`.

- **Angles**: correctness/edge cases, minimal invasiveness, and architecture/maintainability.
- **Worker count**: defaults to 3; configurable per invocation (`worker_count`, 1–3).
- **Timeout**: default 600 seconds per worker; configurable (`timeout_seconds`, 30–3600).
- **Recursion guard**: `FusionPlanTool` is only registered on the main agent. `plan` subagents have `spawns: [explore]` and cannot recursively invoke `FusionPlan`.
- **TUI toggle**: `Shift+Tab` cycles `off → plan → fusionplan → off`. The `fusionplan` state sets `strategy: 'fusion'` via `setPlanStrategy` RPC; the main agent then calls `FusionPlan` on the next turn.
- **Plan mode injection**: when `planMode.strategy === 'fusion'`, the `PlanModeInjector` injects independent fusion prompts telling the main agent to use `FusionPlan` instead of writing manually.

The LLM should choose `mode: 'fusion'` for ambiguous, large, or multi-approach tasks and `mode: 'normal'` (default) for straightforward or localized changes. See `packages/agent-core/src/tools/builtin/planning/enter-plan-mode.md` for the full decision guide.

Key files: `packages/agent-core/src/tools/builtin/planning/fusion-plan.ts`, `packages/agent-core/src/agent/injection/plan-mode.ts`, `packages/agent-core/src/tools/builtin/planning/enter-plan-mode.ts`, `packages/agent-core/src/profile/default/system.md`.

### Compaction Pipeline

Three-stage compaction pipeline coordinated at the `beforeStep` hook
in `packages/agent-core/src/agent/turn/index.ts`. Each step, before the LLM call:

```
Stage 1: Micro (zero LLM) → truncates old tool results to placeholders, always enabled, triggers at >= 50% usage
Stage 2: Full  (one LLM)   → LLM summarizes old messages, triggers at >= 85% of the window (or reserved-context rule)
Stage 3: Block (safety net) → blocks the turn until compaction completes, triggers at >= 90% of the window
```

- **Predictive trigger**: estimates next-step token growth and proactively compacts before overflow, rather than waiting for it to happen.
- **Circuit breaker**: 3 consecutive compaction failures → auto-compaction disabled for the current turn, auto-resets next turn.
- **Timeout**: `block()` waits up to 120 seconds for compaction, cancels and notifies the user on timeout.
- **Reactive overflow recovery**: when the API returns a context overflow error, `handleOverflowError` starts a compaction and AWAITS it (via `block()`) before the turn retries — it never races the un-compacted context against the provider; runs once per turn.
- **Retry semantics**: retryable server errors (429/5xx) consume the 5-attempt budget with Retry-After-honoring backoff; context-overflow/truncation shrinks are local and FREE (never consume the server budget), falling back to half-split re-summarization at the minimum split.
- **Model-switch watermark**: `lowWaterMark` (post-compaction × 1.1) resets when the model alias changes, so a stale mark from a larger model cannot suppress compaction under a smaller one.
- **Stale-worker guard**: compaction workers are owner-tagged; a late-finishing stale worker cannot cancel a newer compaction, corrupt its circuit breaker, or misapply its result.

Key files: `packages/agent-core/src/agent/compaction/{micro,full,strategy}.ts`,
`packages/agent-core/src/loop/retry.ts`.

### Stream-JSON Adapter & Channel Bridge

`run-stream-json` encodes the standard session event stream as a line-based JSON dialect (for external bridges/pipes); the channel bridge re-broadcasts events into IM channels.

- **Dialect**: `apps/scream-code/src/cli/run-stream-json.ts` — `ClaudeStreamJsonWriter` (`emitSystem(sessionId)` / `emitResult(subtype, summary, usage?)` / `emitAssistant` / `emitToolDelta`; assistant events carry no usage; merged tool deltas have string input), `mapCcConnectMode` (default/acceptEdits/dontAsk→manual, plan→planMode, auto→auto, bypassPermissions/yolo→yolo, unset→auto), `extractUserText` (joined with `\n`)
- **EPIPE guard**: `installStdoutEpipeGuard()` factory — catches EPIPE on both the stdout `error` event and `write` throws → `process.exit(0)` (quiet exit, no crash); regression tests `test/cli/run-stream-json.test.ts` (31 cases)
- **Bridge**: session events (assistant deltas / tool calls / status / approvals / questions) go out over the two read-only WebSockets `/api/events.mux` and `/api/events.host`; approvals and questions reply via `POST /api/respond` echoing the original `rpcId`

### Service Manifest & Extension Contracts

- **Manifest**: plugin packages carry `manifest.json` (incl. `entryPoint`), parsed/validated by `packages/agent-core/src/plugin/manifest.ts`; the 117-package set is the manifest publish/parse closure, not the browser-runtime or TS-import closure
- **Contract doc**: `apps/scream-code/src/web/migration/protocol-report.md` — minimal protocol reimplementation plan + vendor-closure advice for keeping the Cordis plugin ABI
- **Registration model**: manifest hooks register in bulk via `session/hooks/engine.ts:registerAll`, shared with the `/extension` runtime

### Output-Truncation Recovery

After a long output is truncated, it auto-"continues" — resuming generation from the last truncated text block (keeping its format prefix) instead of making the model re-imagine the whole text.

- **Location**: `packages/agent-core/src/loop/` (finishReason=truncated branch) — records the truncation point; the next-round prompt injects "continue from [kept fragment]" to avoid repeating the first half
- **Relation**: distinct from compaction-overflow truncation (`TruncatedError` → shrink retry): the former is model-output truncation, the latter is input-over-limit

### Invalid Tool-Call Repeat Breaker

Interrupts the loop when the same tool call fails repeatedly (the same `toolCallId` throws the same error N consecutive times), preventing the model from retrying forever on a broken tool.

- **Location**: `packages/agent-core/src/loop/` (tool-execution failure aggregation) — counts per `toolCallId`; past the threshold it converts to an error event and skips the tool, protecting turn progress
- **Fallback**: the model may still re-issue the tool call in later rounds (no global circuit breaker — only stuck loops are cut)

### Approval Rejection Guidance

After an approval is rejected, the model receives explicit guidance: which action was rejected, why it may have been rejected (permission/cost/risk), and alternative directions — so the model is not confused by the rejection and does not resubmit blindly.

- **Location**: permission-layer rejection paths (`packages/agent-core/src/` permission/approval related) — injects the guidance text into the next step on rejection

### Anti-Drift Prompt Guidance

The system prompt carries an "anti-drift" discipline section (context management / verification / anti-drift) that keeps the LLM from diverging from the original request in long sessions — paired with the Verification Protocol's convergence gate below as a second line of defense.

### Memory System

The agent has a memory system provided by the `@scream-code/memory` package. Positioned as "task experience records" — structured logs of what was tried, what worked, and what failed. Each record also carries 3-5 semantic `tags` and a `projectDir`. Legacy entries without a `projectDir` or `tags` remain visible and usable.

- **Storage**: SQLite database at `<screamHomeDir>/memory/memos.sqlite` (legacy JSONL at `<screamHomeDir>/memory/entries.jsonl` is migrated and kept as `.bak`). Schema includes `project_dir` and `tags`.
- **Fields**: `userNeed` (the user's goal), `approach` (what was done), `outcome` (the result), `whatFailed` (dead ends), `whatWorked` (key successful actions), `projectDir` (project directory), `tags` (semantic tags).
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

#### Knowledge Library

A local reference library — distinct from memory. Where memory is "sticky notes
on the fridge" (personal task experience), knowledge is "a bookshelf of
reference docs" (structured material the user ingests). The agent should reach
for `MemoryLookup` when recalling *how it handled something before*, and
`KnowledgeLookup` when the user asks *what a concept means* or explicitly asks
to search the knowledge base.

- **Storage**: SQLite database at `<screamHomeDir>/knowledge/knowledge.db`.
  Schema: `knowledge_sources` (one per ingested file) → `knowledge_documents` →
  `knowledge_chunks` (with embedding) → `knowledge_events` (LLM-fused event per
  chunk, with title + content embeddings) → `knowledge_entities` (with embedding)
  → `knowledge_event_entities` (bipartite edges with relation embeddings). Vectors
  are stored as JSON text and ranked via JS cosine similarity (same pattern as
  memory). FTS5 indexes chunks/events/entities for keyword fallback.
- **Ingest** (`/knowledge` → ingest): markdown file → heading_strict chunking →
  embed chunks → LLM extract 1 fused event + N entities per chunk → embed event
  title/content + entity names + relation text → store. All writes run in a
  single SQLite transaction; a mid-ingest failure rolls back every partial row.
  Re-ingesting the same file path errors out (deduped via `knowledge_sources.file_path`).
- **Search** (`KnowledgeLookup` tool and `/knowledge` → search): multi-hop
  retrieval — vectorize query → LLM extract query entities → recall entities by
  name + vector → seed events (entity-linked + title-vector matched) → BFS expand
  1 hop via event-entity edges → coarse rank by content embedding → LLM rerank →
  return deduped chunks with scores and provenance. Falls back to direct chunk
  vector search when no seed events match, and to FTS5 when embeddings are unavailable.
- **Tool**: `KnowledgeLookup` in `packages/agent-core/src/tools/builtin/knowledge/knowledge-lookup.ts`
  — registered only on the main agent. Searches the store via `multiSearch` and
  returns markdown-formatted ranked chunks.
- **TUI command**: `/knowledge` (`apps/scream-code/src/tui/commands/knowledge.ts`)
  — interactive menu: ingest / list / search / delete / stats. Uses its own
  `KnowledgeStore` instance (separate from the agent's) but operates on the same
  `knowledge.db`; SQLite WAL mode makes concurrent reads safe during ingest.
- **Agent integration**: `Agent.knowledgeStore` is auto-created in the Agent
  constructor for main agents (same pattern as `memoStore`), with
  `knowledgeStoreReady` awaited during session create/resume. LLM access for
  extraction/rerank/entity-recall goes through `Agent.generateText(systemPrompt, userPrompt)`
  — a new method that calls the configured LLM with a custom system prompt and
  single user message, bypassing conversation history and tools.

Key files: `packages/knowledge/src/store.ts`, `packages/knowledge/src/ingest.ts`,
`packages/knowledge/src/search.ts`, `packages/knowledge/src/extractor.ts`,
`packages/knowledge/src/chunking.ts`,
`packages/agent-core/src/tools/builtin/knowledge/knowledge-lookup.ts`,
`apps/scream-code/src/tui/commands/knowledge.ts`.

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

The bundled `writer` profile is the document-lifecycle specialist, not a Markdown-only report generator. It handles research, drafting, rewriting, editing, proofreading, translation, summarization, template completion, and production or revision of requested document artifacts. When a file is requested it should create or edit the actual artifact, preserve supplied templates and unrelated formatting, and verify the finished output before handing exact paths back to the parent agent.

Key files: `packages/agent-core/src/profile/default/writer.yaml`, `packages/agent-core/src/profile/default/agent.yaml`, `packages/agent-core/src/profile/default/system.md`.

The bundled `worker` profile is the office/document automation specialist, distinct from code work (coder) and content writing (writer). It performs format conversion (docx/pdf/md/html/images/media), batch file processing, file organization, and document transformation. Its operating rules: never overwrite originals (output goes to an `output/` directory or a `_converted` suffix), parse the task scope before bulk work and list missing information instead of guessing, sample one file before batches larger than 3, deliver a plain-language reviewable checklist (what/command/products/how to verify/failures), and clean up partial products on failure so the task can be retried safely.

Key files: `packages/agent-core/src/profile/default/worker.yaml`, `packages/agent-core/src/profile/default/agent.yaml`, `packages/agent-core/src/profile/default/system.md`.

### Self Assets Map & InspectOwnAssets

The base system prompt carries a **Self Assets** section that tells the main agent where its own persistent configuration and data live, and what it must never touch. The accompanying `InspectOwnAssets` tool lets the agent actually inspect those assets — read-only, no write path.

- **Self Assets injection**: `buildSelfMap()` (`packages/agent-core/src/profile/self-map.ts`) renders the map (config.toml / tui.toml / user-prefs.md / mcp.json / AGENTS.md / skills / plugins / memory / knowledge, plus core-code and runtime-artifact boundaries). It is injected as the `SCREAM_SELF_ASSETS` template variable in `buildTemplateVars` (`profile/resolve.ts`) and rendered in the `# Self Assets` section of `profile/default/system.md`. Paths are anchored deliberately: user-level AGENTS.md and skills resolve against the OS home (`~/.scream-code/...`) regardless of `SCREAM_CODE_HOME`; everything else against the scream home. `buildSelfMap` must stay pure and synchronous (no async path lookups — `resolveSkillInstallPaths` is async and cannot be used there).
- **InspectOwnAssets tool**: `packages/agent-core/src/tools/builtin/state/inspect-own-assets.ts` (+ `.md` description). Registered in `ToolManager.initializeBuiltinTools()` **main-agent only** (`this.agent.type === 'main'`), listed in `profile/default/agent.yaml` under the main agent's `tools`, and added to the auto-approve whitelist in `agent/permission/policies/default-tool-approve.ts` (read-only, like Read/Grep/Glob). Subagent profiles define their own tool lists, so the tool is not exposed to subagents. It supports `scope` = `all | skills | mcp | config | memory | knowledge`; reports existence/size/frontmatter status (dir skills: `---` + `name:` within the first 25 lines, bounded 32 KiB read; flat skills: always ok, name from filename; skips dot-entries, node_modules and the 14 documentation filenames), mcp.json parse status + server count (1 MiB oversize guard), plugin-managed skills under `<screamHome>/plugins/managed/<id>/SKILL.md`, and git-root-anchored project skills via `resolveSkillInstallPaths`. Strictly read-only; declares `ToolAccesses.readTree`/`readFile` conservatively.
- **Tests**: `test/tools/inspect-own-assets.test.ts` (unit, temp dir tree) and `test/tools/inspect-own-assets.e2e.test.ts` (real agent: registration, `useProfile(DEFAULT_AGENT_PROFILES['agent'])` wiring into model-visible `loopTools`, execution).

Key files: `packages/agent-core/src/profile/self-map.ts`, `packages/agent-core/src/profile/resolve.ts`, `packages/agent-core/src/profile/default/system.md`, `packages/agent-core/src/tools/builtin/state/inspect-own-assets.ts`, `packages/agent-core/src/agent/tool/index.ts`, `packages/agent-core/src/profile/default/agent.yaml`.

### Goal / Todo State

`TodoList` items support an optional `phase` field. Items sharing the same phase are rendered together, while preserving input order within each phase. The phase is preserved across state round-trips.

The canonical public DTO is `TodoItem` in `packages/agent-core/src/todo.ts`. Successful Todo writes and clears persist the complete list and emit a `todo.updated` full snapshot; query mode is read-only and emits nothing. `AgentAPI.getTodos()` exposes a defensive snapshot through Session RPC and the node SDK. Record replay restores the tool store without surfacing live events. The TUI consumes `todo.updated` for live updates and uses restored core state for initial hydration rather than parsing TodoList tool calls or results.

Every Goal mutation that changes its visible state—including lifecycle, objective, budget, token/turn accounting, and notes—emits `goal.updated` with the complete current snapshot. Goal restore remains silent and retains the existing resume/terminal normalization semantics.

Web snapshots read Goal/Todo through the node SDK after subscribing to core events, then use revision guards so late initial RPC reads cannot overwrite newer events. Main-agent `goal.updated` / `todo.updated` events flow through the existing durable journal exactly once, preserving multi-tab broadcast and seq/epoch reconnect replay. Web metadata keeps Web IDs separate from `coreSessionId`; activation resumes the core ID instead of creating an empty replacement session.

The Web frontend hydrates Goal/Todo only from session snapshots and full `goal.updated` / `todo.updated` journal events. Its right panel keeps the existing quick actions above a complete Goal manager and a read-only, phase-grouped core Todo view; session/connection generations plus epoch/seq guards prevent stale snapshots and mutation responses from crossing session switches or reconnects.

Key files: `packages/agent-core/src/todo.ts`, `packages/agent-core/src/agent/goal/index.ts`, `packages/agent-core/src/tools/builtin/state/todo-list.ts`, `packages/agent-core/src/tools/builtin/state/todo-list.md`, `apps/scream-code/src/tui/controllers/session-event-handler.ts`, `apps/scream-code/src/web/server.ts`, `apps/scream-code/src/web/frontend/src/composables/useScreamWebClient.ts`, `apps/scream-code/src/web/frontend/src/components/GoalPanel.vue`, `apps/scream-code/src/web/frontend/src/components/TodoPanel.vue`, `apps/scream-code/src/utils/goal-refiner.ts`.

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
