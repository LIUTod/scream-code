Use this tool to maintain a structured TODO list as you work through a multi-step task. This is especially useful in plan mode and for long-running investigations.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them

**When NOT to use:**
- Single-shot answers that complete in one or two tool calls
- Trivial requests where tracking adds no clarity

**Avoid churn:**
- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.
- When unsure of the current state, call query mode first (omit `todos`) to check the list before deciding what to update.
- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.

**How to use:**
- Call with `todos: [...]` to replace the full list. Statuses: pending / in_progress / done / blocked.
- Call with no arguments to retrieve the current list without changing it.
- Call with `todos: []` to clear the list.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- For multi-phase work, set `phase` on each item. Items with the same phase are grouped together. Complete all items in a phase before marking items in the next phase as in_progress.
- Update statuses as you make progress — mark one item in_progress at a time.
- Before the final reply, synchronize actual results: mark completed work done, and externally blocked work blocked with a concrete blocker. Do not leave finished work in_progress or clear unfinished work merely to hide it. A final status-only call is allowed; do not repeat completed work to accompany it.

**Item schema:**
- `title` (string, required) — short actionable description. Do not use `content` or `name`.
- `status` (string, required) — one of `pending`, `in_progress`, `done`, `blocked`.
- `phase` (string, optional) — group label for multi-phase work.
- `blocker` (string, required for blocked items) — what external input or condition is needed to proceed.

Example tool call:
```json
{
  "todos": [
    {"title": "Read session-control.ts", "status": "done"},
    {"title": "Add planMode flag to TurnManager", "status": "in_progress", "phase": "Implementation"}
  ]
}
```
