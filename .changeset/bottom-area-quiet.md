---
"scream-code": patch
---

A quieter bottom of the screen: each fact is said once, in one place.

- The status row above the editor only says what is going on right now, at every terminal width: the pulse wave with the phase and how long (`思考中 · 12s`) and `Esc 中断` on the right, or `◆ 等待批准 · 4m` while a panel waits for you (the row used to be empty exactly then; a question and a compaction are named the same way), or one tip while the chat is empty. The tip no longer carries its own icon and close hint on every line: `Tips` on the left, `Ctrl+B 关闭` fixed on the right, so a narrow terminal gives up the close key before it cuts a sentence in the middle.
- Notices (a fired reminder, a collaboration request, MCP) moved to the footer's right side and show one at a time, by priority, each with its own lifetime. They used to sit side by side on the status row and cut each other off. On a narrow row the notice shrinks and then goes; mode pills never do.
- The footer is one row at every terminal size. The model name keeps its glow while a turn runs: green while the model works, blue while a tool runs. On the left, how Scream runs: model, mode pills, goal, background work, then cache hit rate, balance and git changes. On the right, what needs attention: the notice, MCP trouble, jobs waiting, the chat channel and the context gauge. The key hints are gone from the footer (the tips above the editor teach them, and `Esc 中断` sits on the status row). When the row gets narrow, the measurements give way and the gauge's bar shrinks; the model, the modes, background work, MCP trouble, waiting jobs and the context percentage always stay.
- Items with nothing to say are gone: cache before the first reply, git on a clean tree, and a chat channel that is not running. The emoji labels are plain text now (`ctx`, `git`, `缓存`).
- MCP is silent while healthy. Connecting shows one summary notice, only if it takes a moment; a server that failed or needs auth is announced once and then stays as `✕ MCP 3/5` in the footer until it is resolved. Failures are no longer written into the transcript, and there is no per-server flash.
- The footer takes one row on every terminal, so a panel that replaces the editor and the transcript get a row back.
