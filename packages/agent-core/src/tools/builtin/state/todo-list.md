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
- Call with `todos: [...]` to replace the full list. Statuses: pending / in_progress / done.
- Call with no arguments to retrieve the current list without changing it.
- Call with `todos: []` to clear the list.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- Update statuses as you make progress — mark one item in_progress at a time.