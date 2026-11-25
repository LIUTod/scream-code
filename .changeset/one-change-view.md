---
"scream-code": minor
"@scream-code/agent-core": minor
---

An edit reads the same folded and expanded. Both states draw a change as `line sign text`: real file line numbers, removed lines on a red band, added lines on a green one, the code syntax-highlighted, and the words a one-line replacement changed on a deeper band in bold. Expanded (Ctrl+O) shows the same rows plus the unchanged lines around them and a "… N unchanged lines …" row between changes; it no longer repeats the path and counts, prints "ok", or shows a written file's whole text instead of what changed. The tree now closes on the last row of the block in both states, so the last step's lines stay inside it. A reopened session keeps the line numbers it had live: the change preview is saved with the tool result (still only text the call's own arguments carried; the model never sees it).
