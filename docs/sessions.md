# Sessions

A session is a persisted conversation: one agent, one working directory, one
append-only record stream.

## Storage layout

```
~/.scream-code/sessions/
└── <encoded-workdir>/
    └── <session-id>/
        ├── state.json              # title, last prompt, session metadata
        ├── logs/                   # this session's log
        └── agents/
            ├── main/wire.jsonl     # main agent records (append-only)
            └── <agent-id>/wire.jsonl
```

- Each agent's `wire.jsonl` is the source of truth: every message, tool call and
  tool result in order. Corrupt lines are reported with the file path and line number
  (`agent/records/persistence.ts`).
- `encoded-workdir` comes from `session/store/workdir-key.ts`, so sessions are
  bucketed per project and a listing defaults to the current directory.
- An index (`session/store/session-index.ts`) caches id → metadata and is
  validated by mtime + size, so another process's writes are picked up.

## Lifecycle

| Action | Mechanism |
|---|---|
| Create | `Session` is created with a model alias; the first record opens the wire |
| Resume | `/sessions` (alias `/resume`) or `--session <id>`; the wire is replayed |
| Fork | `/fork` — copies the conversation into a new session id |
| Rename | `/title` |
| Close | `/exit`, or the TUI detaching from the session |

Every launch starts a session, so a launch used only for a slash command, or
quit right away, would leave an empty one behind. An **empty session** — no
prompt ever sent, no title, not archived — is therefore:

- deleted when you quit (unless its work was handed to the background), and
  when you switch away from it (`/new`, `/sessions`);
- left out of `/sessions` and skipped by `-C`;
- swept at startup for the current project when an earlier one is still
  around (untouched for 5 minutes, so another terminal's fresh session is
  safe; a session another process has open is never deleted).

### Titles

The first prompt is only a provisional title. When a turn completes, the model
reads a short excerpt — the opening request, the two latest requests and the
latest reply — and names the task in a few words, in the language you write
in. A greeting or a request too vague to name ("你好", "continue") gets no
title yet, and the next turn tries again, up to four requests per session in
all (counted in the session, so reopening it does not start over); after that
the provisional title stays. Once named, a session keeps its title and no
further title request is made. A title you
set with `/title` is never replaced, and background job runs are not titled.

The request goes to the housekeeping model when one is set
(`loop_control.housekeeping_model` or `/model diy`), else to the session model,
with thinking off: a few hundred tokens, once per session.

## Compaction

Three layers, all automatic (unless `loopControl.compactionMode = "off"`):

- **Micro** — keeps the most recent 20 messages (bounded to 40k tokens) and
  truncates older ones.
- **Full** — at 85% of the context window, older turns are summarised and
  replaced, preserving up to 24 recent messages (12 user, 30k tokens, at most
  25% of the window). At 90% the turn is blocked until compaction runs — older
  context is never silently truncated away.
- **`/compact`** — triggers a full compaction manually. Useful to pick a pause
  point instead of letting the engine interrupt mid-task.

The summary is marked unverified: re-check anything it asserts before acting on
it. Configurable via `loopControl.compactionTriggerRatio` (0.5–0.99).

**Off mode** — `loopControl.compactionMode = "off"` for unattended and IM
sessions that must not stall on a compaction LLM call: micro and auto
compaction are disabled entirely (the context read paths never advance the
micro cutoff behind the caller's back, and a context-overflow error surfaces
instead of triggering recovery). At the 90% blocking threshold the model gets
a one-time wrap-up reminder per episode instead of being blocked; the
provider's own context limit remains the hard backstop. `/compact` still works
manually.

## Switching and concurrency

- One session is live at a time; its turns are serialised.
- Switching replays the target session's history and clears the current
  transcript view, so the screen always matches the live session.
- Inputs queued in memory are not persisted. After a restart the wire replays
  messages and tool results, not pending user input.

## Export

| Command | Output |
|---|---|
| `/export-md` | Markdown transcript |
| `/export-debug-zip` | Bundle with diagnostics |
| `scream export [sessionId]` | ZIP from the CLI |

## Deleting

`/sessions` → select → `d` (then `Enter` to confirm). The session currently open
cannot be deleted, and channel-owned (line) sessions are managed by their channel instead.
