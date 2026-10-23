# Scream Bot workbench UI

The browser client for the Scream Bot gateway. Components use `BotClient`; the gateway owns
execution and persistence. See the [Bot operator guide](../README.md) for CLI options, storage,
migrations and interrupted-run recovery.

## Run

Run these commands from the repository root. Start the real gateway and Vite in separate terminals:

```bash
pnpm --filter scream-code run bot:server --no-open
pnpm --filter scream-code run bot:dev
```

Vite requests port `5174` and selects another free port if necessary. `vite.bot.config.ts` sets
`root` to this directory, aliases `@` to it, and proxies `/api` to `http://localhost:3210`.
The default transport is `HttpBotClient`, using real REST requests and the SSE event stream.
A gateway failure does not switch the UI to mock data.

For an explicit, non-production preview without the gateway:

```bash
VITE_BOT_MOCK=1 pnpm --filter scream-code run bot:dev
```

Only the exact value `1` selects `MockBotClient` in `lib/api/client.ts`. Its simulated Bots,
threads, messages, runs, approvals, questions, handoffs, rooms and files live in memory and reset
on reload. Keep this flag unset for real execution and release builds; preview behavior is not
proof of gateway functionality.

Build and type-check the UI from the repository root:

```bash
pnpm --filter scream-code run bot:build
pnpm exec tsc -p apps/scream-code/src/bot/ui/tsconfig.json --noEmit
```

The build writes `apps/scream-code/dist/bot-ui`, which the gateway serves when present.
The package's `typecheck` script checks both the CLI/server and this UI; its `build` script builds
both the CLI and the UI.

## Layout

```
main.tsx            React root, theme install, query client
router.tsx          code-based route tree
routes/             welcome, cockpit, inbox, room, settings
components/ui/      local UI primitives
components/layout/  shell, page shell, detail panel
components/chat/    transcript, composer, tool cards, handoff card
components/approvals/ approval and question cards
components/bots/    rail, status
components/agents/  avatar, orb, new-Bot and Bot-settings sheets
components/shell/   command palette, right drawer
lib/client.ts       component-facing BotClient contract
lib/api/            HTTP/SSE transport, queries, event and transcript reconciliation
lib/mock/           explicit in-memory preview transport
styles/tokens.css   Tailwind v4 theme and base styles
```

## Data and execution boundaries

- Components use `BotClient` (`lib/client.ts`), not SDK/core session objects or direct database
  access. `shared/contracts.ts` is the REST/SSE wire contract; `lib/api/http-client.ts` adapts it
  for the UI. REST submits commands and reads durable state; SSE delivers updates for reconciliation.
- Each thread maps to a full Scream main session. A Bot's name and role prompt do not select a
  specialist subagent type. Internal delegation stays in the existing session engine.
- Bot permissions are the existing `bot` and `auto` modes, not a UI-defined permission system.
  A workspace is a working directory, not an execution sandbox. Memory follows the existing
  shared/project-scoped system; the UI does not provide Bot-private memory.
- Nonempty prompt attachments are rejected by the runtime as `attachments.unsupported`.
  An attachment field or tool-policy DTO does not establish a working upload or tool-grant UI.

### Transcript snapshots and live updates

`GET /api/threads/:id/messages` returns `{ threadId, version, messages }`, not a bare message
array. `HttpBotClient.listMessages()` validates that envelope and exposes `Message[]` to
components, retaining its version/process-generation metadata for query-cache reconciliation.
`messagesQuery` reconciles at cache-write time so a late, older HTTP response cannot overwrite
newer live content. Identity is based on message IDs, not equal text or array positions.
Legacy message times may be `null`; do not invent timestamps when rendering them.

SSE uses a process `epoch` and a workbench-global `seq`. The cursor is `epoch:seq`, carried in
`Last-Event-ID` on reconnect; it is never a per-Bot sequence. A process change, invalid/future
cursor or replay-buffer gap produces `resync`. The stream's `snapshot` is also a checkpoint for
reconciliation, not a complete replacement for all cached queries. `applyBotEvent` invalidates
Bots, threads, transcripts, runs, Inbox, handoffs, rooms, activity and files on resync, including
inactive views. Do not limit that refresh to the currently selected Bot.

### Default conversation and deletion

Bot creation seeds a conversation; opening an older database fills in Bots with no conversations.
Deleting a Bot's last conversation creates a replacement. Preserve the rail's quick-delete action
and the server's last-Bot guard.

Thread deletion is owned by the operation's original `{ botId, threadId }`, not whichever Bot is
mounted when it finishes. `lib/delete-thread.ts` removes the deleted transcript cache and only
navigates away if the user is still on that thread. A failed follow-up refresh must not turn a
successful DELETE into a failed deletion. `lib/session.ts` clears a deleted Bot's stored selection
and cached Bot entry.

## Vendored code

copyright header and notes local changes. Three primitives (`message-scroller`, `questionnaire`,
`carousel`) were rebuilt locally because their original implementations depend on packages this
app does not install.
