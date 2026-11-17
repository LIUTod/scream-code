---
"scream-code": patch
---

Consistent tool names, recovery from rejected message sequences, and tidier command lists.

- Three built-in tools now use PascalCase like every other built-in: `ast_grep` is `AstGrep`, `ast_edit` is `AstEdit`, and the RLM kernel tool `python` is `Python`. The old names keep working: a model that calls a tool by its old name runs the renamed tool (permission rules and hooks see the new name, so a deny rule cannot be dodged by the old spelling), permission rules, profile `tools:` lists and SDK active-tool lists are read with the new names, and a `PreToolUse` / `PostToolUse` hook whose matcher names the old tool still fires. Stored sessions are rewritten on resume (session wire v1.9). `AstGrep` is now available to read-only subagents and `AstEdit` to read-write ones; before, neither was classified, so restricted subagents could not use them.
- When a provider rejects the message sequence itself (a blank text block, a conversation that does not start with the user, roles that do not alternate, a repeated tool-call id), the step now normalizes the request and retries once, and the rest of the turn sends the normalized sequence. The stored history is not changed.
- `/bot`, `/ask`, `/rlm` and `/script` no longer list themselves as their own alias in `/help` and in completion.
