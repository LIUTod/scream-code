---
"scream-code": patch
---

A quieter bottom of the screen: each fact is said once, in one place.

- The status row above the editor only says what is going on right now: the pulse wave with the phase and how long (`思考中 · 12s`), or `◆ 等待批准 · 4m` while a panel waits for you (the row used to be empty exactly then; a question and a compaction are named the same way), or one tip while the chat is empty. The tip no longer carries its own icon and close hint on every line: `Tips` on the left, `Ctrl+B 关闭` fixed on the right, so a narrow terminal gives up the close key before it cuts a sentence in the middle.
- Notices (a fired reminder, a collaboration request, MCP) moved to the footer's right side and show one at a time, by priority, each with its own lifetime. They used to sit side by side on the status row and cut each other off. On a narrow row the notice shrinks before any mode pill does.
- The footer is split by meaning. Row 1 holds the measurements: model, cache hit rate, balance, git changes and the context gauge. Row 2 holds the controls: mode pills, goal, background work and, on the left, the keys that work now (`/ 命令  Shift+Tab 计划` in quiet tones while idle, or `Esc 中断` while working). The work status no longer swaps in and out at the bottom right.
- Items with nothing to say are gone: cache before the first reply, git on a clean tree, and a chat channel that is not running. The emoji labels are plain text now (`ctx`, `git`, `缓存`).
- MCP is silent while healthy. Connecting shows one summary notice, only if it takes a moment; a server that failed or needs auth is announced once and then stays as `✕ MCP 3/5` in the footer until it is resolved. Failures are no longer written into the transcript, and there is no per-server flash.
- On a terminal shorter than 20 rows the footer folds into one row (model, pills, notice, gauge) and gives a row back to the transcript. On a terminal narrower than 60 columns, where the status row is not drawn, the footer carries the work status itself.
