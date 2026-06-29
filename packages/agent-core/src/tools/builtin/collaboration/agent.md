Launch a subagent to handle a focused task. Prefer this tool over doing the work yourself when the task matches one of the specialists below.

Specialist subagents:
- `coder` — concrete coding, editing, refactoring
- `explore` — read-only codebase investigation
- `plan` — implementation planning and architecture
- `verify` — build/test/lint checks
- `reviewer` — code review
- `oracle` — deep debugging and second opinions
- `writer` — reports and documentation

## Required prompt structure

The final prompt sent to the subagent MUST contain these sections. Provide them either by writing them directly into the `prompt` field, or by using the structured `target`, `change`, and `acceptance` fields — they will be appended to `prompt` automatically.

```markdown
# Target
Exact files, symbols, or directories to touch. Explicit non-goals.

# Change
Step-by-step what to add, remove, or modify. Include concrete examples when possible.

# Acceptance
Observable result that proves completion: a passing test, a build command, a specific file content, or a verification step the subagent must run.
```

Omitting a section causes the subagent to miss context and increases the chance of a wrong or incomplete result.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.
- The `Acceptance` section is not optional. The subagent MUST verify against it before returning.

Usage notes:
- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its `resume` id) over spawning a fresh instance — the resumed agent keeps its prior context.
- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.

When NOT to use Agent: skip delegation for trivial one-step work (e.g. reading a known file). Almost everything else is a candidate for delegation.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.