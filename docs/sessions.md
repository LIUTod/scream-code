# Sessions

A session is a persisted conversation: one agent, one working directory, one
append-only record stream.

## Storage layout

```
~/.scream-code/sessions/
└── <encoded-workdir>/
    └── <session-id>/
        ├── wire.jsonl              # main agent records (append-only)
        └── agents/<agent-id>/wire.jsonl
```

- `wire.jsonl` is the source of truth: every message, tool call and tool result
  in order. Corrupt lines are reported with the file path and line number
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

## Compaction

Three layers, all automatic:

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
