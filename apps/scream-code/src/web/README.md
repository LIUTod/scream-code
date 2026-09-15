# Scream Web UI — architecture and exposed-interface inventory

> This file is the architecture and interface window of `scream web`
> (`apps/scream-code/src/web`). It describes the three layers, every external
> interface of the REST/WS dual channel, the data model, the frontend client
> surface, and the wiring path for adding new capabilities.
> Purpose: let later developers (AI agents included) learn **without reading the
> sources end to end** which capabilities this web backend exposes, how the
> frontend calls them, and how to wire a new capability in.

---

## 1. Architecture overview

```
Browser frontend  (Vue 3, src/web/frontend/)
  ├─ useScreamWebClient.ts — the only state hub (module-level singleton)
  │    · WS connect / heartbeat / reconnect
  │    · REST call wrappers (session / resources / global)
  └─ components/* — views and panels
      │
      │  WS (event stream) + REST (state / approvals / config / resources)
      ▼
Backend  (src/web/server.ts)
  ├─ runWebServer() — multi-session server entry point
  ├─ SessionManager — session table + session lifecycle + generic forwarding
  │    · switchModel / switchThinking (model / thinking-level switches)
  │    · getLiveSession() guard + grouped forwarding (status/usage/…/plugins/MCP)
  ├─ WebSession — single-session wrapper (journal / connections / approvals / Goal)
  │    · requireLiveSession() — public accessor, forwards RPC
  └─ REST handlers — handleGoalRoute / handleSessionControlRoutes /
                     handleResourceRoutes / handleGlobalRoutes
      │
      │  through ScreamHarness (zero intrusion)
      ▼
node-sdk (@scream-code/scream-code-sdk)
  ├─ ScreamHarness — global capabilities (config/flags/preflight/session lifecycle)
  └─ Session — per-session capabilities (prompt/model/skills/plugins/MCP/tasks/Goal)
```

**Key design principles**

- **WS / REST dual channel**: WS carries the event stream plus commands (`prompt` / `command` / `abort` / approvals) only; REST owns state queries, mutations, configuration and resource management, which are naturally idempotent, auditable and testable.
- **Zero intrusion**: web is the third consumer of `agent-core` (through node-sdk), alongside the TUI and stream-json. `packages/agent-core` and `packages/node-sdk` are never touched from the web side.
- **Singleton client**: the frontend reads all state and actions from `useScreamWebClient()`; components only consume computed values and actions.

---

## 2. REST endpoint inventory

Base prefix: `/api/v1`. Every `:id` must be URL-decoded; session-scoped endpoints answer `409` for archived (read-only) sessions and never silently create an empty shell.

### A. Session queries (GET, session scope)

| Endpoint | Description | Returns |
|---|---|---|
| `GET /sessions/:id/status` | Session state (model / thinking / permission / plan / wolfpack / rlm / context / usage) | `SessionStatus` |
| `GET /sessions/:id/usage` | Token usage | `SessionUsage` |
| `GET /sessions/:id/context` | Session context (history + token counts) | `AgentContextData` |
| `GET /sessions/:id/plan` | Current plan-mode plan | `SessionPlan` |
| `GET /sessions/:id/skills` | Skill list | `SkillSummary[]` |
| `GET /sessions/:id/plugins` | Plugin list | `PluginSummary[]` |
| `GET /sessions/:id/plugins/:pid` | Single plugin details | `PluginInfo` |
| `GET /sessions/:id/mcp` | MCP server list | `McpServerInfo[]` |
| `GET /sessions/:id/mcp/startup-metrics` | MCP startup timings | `McpStartupMetrics` |
| `GET /sessions/:id/tasks?activeOnly&limit` | Background task list | `BackgroundTaskInfo[]` |
| `GET /sessions/:id/tasks/:taskId/output?tail` | Task output tail | `{ output }` |

### B. Session control (POST, session scope)

| Endpoint | Request body | Underlying method |
|---|---|---|
| `POST /sessions/:id/permission` | `{ mode: yolo\|manual\|auto\|ask }` | `setPermission` |
| `POST /sessions/:id/plan` | `{ enabled, strategy? }` | `setPlanMode` |
| `POST /sessions/:id/plan/clear` | — | `clearPlan` |
| `POST /sessions/:id/wolfpack` | `{ enabled }` | `setWolfpackMode` |
| `POST /sessions/:id/rlm` | `{ enabled, maxDepth? }` | `setRlmEnabled` + `setRlmMaxDepth` |
| `POST /sessions/:id/undo` | `{ count? }` | `undoHistory` |
| `POST /sessions/:id/compact` | `{ instruction? }` | `compact` |

### C. Skills (session scope)

| Endpoint | Request body | Underlying method |
|---|---|---|
| `POST /sessions/:id/skills/:name/activate` | `{ args? }` | `activateSkill` |
| `DELETE /sessions/:id/skills/:name` | — | `removeSkill` |

### D. Plugins (session scope)

| Endpoint | Request body | Underlying method |
|---|---|---|
| `POST /sessions/:id/plugins/install` | `{ source }` | `installPlugin` |
| `POST /sessions/:id/plugins/:pid/enable` | `{ enabled }` | `setPluginEnabled` |
| `POST /sessions/:id/plugins/:pid/mcp/:server/enable` | `{ enabled }` | `setPluginMcpServerEnabled` |
| `POST /sessions/:id/plugins/:pid/activate` | — | `activatePlugin` |
| `POST /sessions/:id/plugins/:pid/deactivate` | — | `deactivatePlugin` |
| `POST /sessions/:id/plugins/:pid/inject` | — | `injectPlugin` |
| `POST /sessions/:id/plugins/reload` | — | `reloadPlugins` |
| `DELETE /sessions/:id/plugins/:pid` | — | `removePlugin` |

### E. MCP (session scope)

| Endpoint | Request body | Underlying method |
|---|---|---|
| `POST /sessions/:id/mcp/add` | `{ name, config }` | `addMcpServer` |
| `POST /sessions/:id/mcp/:name/reconnect` | — | `reconnectMcpServer` |
| `POST /sessions/:id/mcp/:name/stop` | — | `stopMcpServer` |
| `DELETE /sessions/:id/mcp/:name` | — | `removeMcpServer` |

### F. Background tasks (session scope)

| Endpoint | Request body | Underlying method |
|---|---|---|
| `POST /sessions/:id/tasks/:taskId/stop` | `{ reason? }` | `stopBackgroundTask` |

### G. Global (harness scope, no session needed)

| Endpoint | Method | Request body | Underlying method |
|---|---|---|---|
| `/config` | GET | — | `getConfig` |
| `/config` | POST | `{ patch }` | `setConfig` |
| `/config/providers/:id` | DELETE | — | `removeProvider` |
| `/experimental-flags` | GET | — | `getExperimentalFlags` |
| `/preflight` | GET | — | `preflight` |

### The sessions themselves (the original core endpoints)

| Endpoint | Method | Description |
|---|---|---|
| `/sessions` | GET/POST | List / create (POST accepts an optional `{ workDir }` body: absolute path, no `..`, must exist and be readable/writable, otherwise 4xx + message; omitted → the server process directory) |
| `/workdir` | GET | Server default workspace `{ workDir }` (fallback shown by the home workspace chip before an explicit pick) |
| `/sessions/:id/activate` | POST | Activate an archived session |
| `/sessions/:id/export` | GET | Export as Markdown |
| `/sessions/:id` | DELETE | Delete |
| `/sessions/:id/snapshot?tail` | GET | Full snapshot (reconnect recovery) |
| `/sessions/:id/messages?before&tail` | GET | Older history pagination |
| `/sessions/:id/messages?seq&tool` | GET | Full thinking text for one entry |
| `/sessions/:id/model` | POST | Switch model (with a context-limit guard) |
| `/sessions/:id/thinking` | POST | Switch thinking effort |
| `/sessions/:id/goal` | POST/PATCH | Create / update a Goal |
| `/sessions/:id/goal/refine` | POST | Refine a Goal objective |
| `/sessions/:id/goal/pause\|resume\|cancel` | POST | Goal lifecycle |
| `/git/status` | GET | Git status |
| `/git/diff?path` | GET | Single-file diff |
| `/like` | GET/PUT | User preferences (shared with the TUI) |
| `/models` | GET | Available models |

---

## 3. WS events and commands

### Events (server → client, through the `event` envelope + `seq/epoch`)

Core events (dispatched by `useScreamWebClient.handleMessage`): `server_hello`, `event` (including `assistant.delta` / `thinking.delta` / `tool.call.started` / `tool.result` / `turn.started` / `turn.ended` / `goal.updated` / `todo.updated` / `status` / `agent.status.updated`), `approval_request`, `approval_resolved`, `user_message`, `command_result`, `resync_required`, `server_empty`, `pong`, `error`.

### Commands (client → server)

| Type | Description |
|---|---|
| `prompt` | Send a user message (`{ text, clientMessageId }`) |
| `command` | Slash command (`{ command, args?, pendingMsgId? }`) |
| `abort` | Stop the current turn |
| `approval_response` | Approval answer (`{ id, decision, feedback?, scope? }`) |
| `ping` / `pong` | Heartbeat |

### Frontend slash-command surface (`frontend/src/commands.ts`)

`compact / model / clear / new / help / auto / yes(=yolo) / plan / fork / title(=rename) / status / usage / btw`.
`btw` is special-cased as "sendable while a turn is running"; the other commands are rejected while the session is busy.

---

## 4. Data model

The frontend keeps its own trimmed types (`frontend/src/types.ts`, **imports neither node-sdk nor agent-core** — local mirrors):

| Type | Description |
|---|---|
| `ChatMessage` / `ToolMessage` / `TurnStats` | Messages, tool calls and per-turn stats |
| `SessionStatus` / `SessionUsage` / `TokenUsage` | Session state and usage |
| `GoalSnapshot` / `TodoItem` / `GoalBudgetInput` | Goal / Todo |
| `GitStatus` / `GitFileChange` | Git |
| `ModelInfo` / `ModelsResponse` | Models |
| `SessionListItem` / `SessionSnapshot` | Session list / snapshot |
| `LikePreferences` | User preferences |
| `ApprovalRequest` | Approvals |
| **Exposed by this layer** `AgentContextData` / `SessionPlan` / `PlanInfo` / `SkillSummary` / `PluginSummary` / `PluginInfo` / `ReloadSummary` / `McpServerInfo` / `McpStartupMetrics` / `BackgroundTaskInfo` / `ExperimentalFlagMap` / `ScreamConfig` / `ScreamConfigPatch` | Resources and global state |

These types are **mirrors** of the corresponding backend RPC return structures (field-aligned with agent-core); changing a backend return structure means updating them here as well.

---

## 5. Frontend client interface

`useScreamWebClient()` (singleton) exposes methods in three groups:

- **Session**: `sendPrompt / sendCommand / abort / clearMessages / appendSystemMessage / resolveApproval / switchModel / switchThinking / createSession(workDir?) / switchSession / deleteSession / exportSession / fetchSnapshot / loadOlderMessages / reconnectNow / fetchSessions / fetchGitStatus / fetchModels / fetchLike / updateLike`. The `workDir` passed to `createSession` travels with the POST; when creation fails the toast prefers the server message (an invalid directory, for example).
- **Goal/Todo**: `refineGoal / createGoal / updateGoal / pauseGoal / resumeGoal / cancelGoal`.
- **Additional exposed surface** (the goal of this layer was to expose the API, not to build panels, so most of these methods have no UI panel consuming them yet):
  - Session state: `fetchSessionStatus / fetchSessionUsage / fetchSessionContext / fetchSessionPlan / sessionPlan / clearPlan`; toggles: `switchPermission / switchPlanMode / switchWolfpack / switchRlm / undoHistory / compact`.
  - Skills: `skills / fetchSkills / activateSkill / removeSkill`.
  - Plugins: `plugins / pluginInfo / fetchPlugins / fetchPluginInfo / installPlugin / setPluginEnabled / setPluginMcpServerEnabled / removePlugin / reloadPlugins / activatePlugin / deactivatePlugin / injectPlugin`.
  - MCP: `mcpServers / mcpStartupMetrics / fetchMcpServers / fetchMcpStartupMetrics / addMcpServer / reconnectMcpServer / stopMcpServer / removeMcpServer`.
  - Background tasks: `backgroundTasks / backgroundTaskOutput / fetchBackgroundTasks / fetchBackgroundTaskOutput / stopBackgroundTask`.
  - Global: `config / fetchConfig / setConfig / removeProvider / experimentalFlags / fetchExperimentalFlags / preflightOk / preflight`.

---

## 6. Wiring notes (how to add a capability)

To add a base-layer capability to web, follow four links, normally in the order **backend → frontend**:

1. **Backend accessor**: `WebSession` provides `requireLiveSession(): Session` (already present) and returns the underlying core Session (archived sessions throw `409`).
2. **SessionManager forwarding**: add a thin forwarding method on `SessionManager` (`switchModel`/`switchThinking` are the existing precedent; this layer added the status/usage/…/plugins/MCP/tasks/global groups), which calls `this.getLiveSession(id)` and then the underlying method.
3. **REST handler**: add the route to one of `handleSessionControlRoutes` / `handleResourceRoutes` / `handleGlobalRoutes` (returning `false` means "not matched", so the next handler runs), with a uniform `try/catch → sendHttpError`.
4. **Frontend client**: add the corresponding method in `useScreamWebClient.ts` (best-effort for queries, toast on failure for mutations) and expose it on the `UseScreamWebClientReturn` interface and the return object; mirror the return type in `types.ts`.

**Conventions**

- Query endpoints (GET) fail silently (best-effort); mutating endpoints (POST/DELETE) raise a toast.
- Session-scoped endpoints must go through `getLiveSession` first (404/409) and must never silently create an empty shell.
- Global endpoints (config/flags/preflight) do not depend on a session and go through `SessionManager`'s harness forwarding.
- New endpoints must be registered in section 2 of this README at the same time.

---

## 7. Frontend frame-handling discipline

The hard rules for WS frame handling (rooted in a production incident: the dispatcher never registered a `resync_required` handler, which left the UI permanently stale with no error reported at all):

1. **Frame handlers must register in the registry, and unknown frames must fail loud.** Each domain module self-registers through `onWsMessage(s, type, fn)` at assembly time; `dispatch.ts` logs `console.error` and counts unregistered types — never swallow a frame silently, and never throw either (the WS loop has to stay alive).
2. **Journal events must pass `acceptJournalEvent`, and silent seq gaps are refused.** seq must continue at `seq+1`; a gap within the same epoch counts as a hole — log it loud and trigger the snapshot refetch that `resync_required` also performs, escalating the log level after more than 3 consecutive gaps. An epoch change still goes through the resync reset path.
3. **Reconnect snapshots are swapped atomically.** A snapshot must be fetched in full, pass the `canApplySnapshot` generation check and then replace `messages` and the other state in one shot via `applySnapshot`; any "clear the old snapshot first and leave an empty state if applying fails" shape is forbidden.
4. **Component motion convention**: animations hang off semantic state (state-driven, never imperatively triggered) and honour `prefers-reduced-motion`.

---

## 7.1 Composer and overlay conventions (L2)

- **Composer single primary button**: `Send` / `Stop` collapse into one `.composer-primary` whose shape is driven by `data-action="send|stop"` (idle → send, busy → stop; while busy, Stop is one keystroke away no matter what the input holds — queueing lives on the keyboard: Enter queues, ⌘S injects immediately). Icon, `title` and `aria-label` all come from the same `PRIMARY_META`; a second submit button must never appear.
- **Placeholder state machine**: `placeholderKey` (offline / queue / busy / plan / no-workspace / idle) is resolved in one place in `Composer.vue` and written to the input's `data-placeholder-state`; a `placeholder` passed by the host only overrides the idle state.
- **Chip row**: visibility, wording and `disabled` reasons for `.composer-chip[data-chip=…]` (mention / slash / workspace / model / thinking / permission / context / queue) all come from the `chips` computed in `Composer.vue`. In the home variant the workspace chip opens `WorkspacePicker.vue` (path input + recent list + quick entry into subdirectories) and the chosen value goes into the module-level preference `useWorkspacePreference` (localStorage key `scream-workspace-preference`) as the `workDir` of the next `createSession`; the chat variant only displays the session-bound directory read-only (the workspace is fixed at creation and cannot be changed mid-session). The effort chip appears only when the current model carries `thinkingLevels` metadata; anything that cannot be clicked is `disabled` with the reason in `title`, so no silent path remains.
- **Takeover area**: an in-flight Goal is rendered by `GoalBar.vue` (one in-flow row above the input, non-modal); the edit action switches the right rail to the Goal tab and reuses `GoalPanel` instead of building a second Goal form.
- **Overlay menus**: all components share `MenuPopover.vue` (the `MenuEntry`/`MenuGroup` shapes from `utils/menus.ts`), teleported to body with fixed positioning, closing on outside click / Esc / scroll, plus a module-level mutex registry — only one menu is on screen at a time. The model/effort/permission menus inside the composer add one more layer of mutual exclusion through the single-valued `openMenu`.
- **Top bar convergence**: `ConversationHeader` keeps only back / title (rename) / stats capsule (turns · tokens, opening `SessionStatsPanel`) / a "more" overlay / open right rail; export, clear and the file panel move into the overlay. An empty session (`messages=0` and not running) renders no top bar at all, and the empty-state guidance belongs to `MessageList`.
- **Sidebar session rows**: a row's "more" offers rename / fork / export / delete; fork is available for the current session only (the server-side fork hangs off the active WS session, and the web side has no channel for forking an arbitrary session by id). Time formatting always goes through `utils/relativeTime.ts`; groups longer than `GROUP_COLLAPSE_LIMIT` (5) collapse by default, and search results never collapse. Expansion state lives in `useSidebarState` (shared by the desktop rail and the mobile drawer).
- **Cross-view draft delivery**: `Composer` exposes `insertDraft(text, { activate })`, `ConversationView` forwards it and `WebShell` injects it into `SkillsView` as `injectDraft`; only when delivery fails does `SkillsView` fall back to the clipboard plus written instructions. Injected content carries a 5s window, and draft restoration on session switch consumes it once.
- **Settings modal host**: `<SettingsModal />` is mounted inside `WebShell` (same domain as the view switch) rather than being owned by `App.vue`; the open/closed state is still the module-level `useSettingsModal` singleton and the sidebar entry behaves the same.

---

## Appendix: backend module responsibilities

| Module | Location | Responsibility |
|---|---|---|
| `runWebServer` | server.ts | Multi-session HTTP + WS entry; assembles the handler chain; gateway authentication |
| `startWebServerForSession` | server.ts | Single-session mode entry (`scream web` bound to one session) |
| `SessionManager` | server.ts | Session table, create/activate/archive/fork/delete, model/thinking switches, generic forwarding |
| `WebSession` | server.ts | Single-session wrapper: journal events, connections, approvals, Goal/Todo, reconnect recovery |
| `useScreamWebClient` | frontend | The frontend's only state hub: WS events + REST calls + concurrency guards |
| `files.ts` | alongside server.ts | Read-only file browsing (workdir confinement + symlink escape protection) |
| `auth.ts` | alongside server.ts | LAN gateway authentication (Bearer / cookie, timingSafeEqual) |
