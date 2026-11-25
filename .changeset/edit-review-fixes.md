---
"@scream-code/agent-core": patch
---

Fixes from reviewing the edit-reliability changes. A line-range edit carried across the agent's own earlier edit is an ordinary edit again: it is no longer rolled back when the language server reports more errors mid-refactor. Re-reading a file the agent just edited keeps the change marked as the agent's own, so a later edit is not told someone else changed it. Only a command that looks like a hand-written edit (`sed -i`, a one-off script, a redirect into a file) gets pointed back at Edit and counts as a shell edit in the weekly review; git, formatters and generators changing files just have the change noted. A command that touches many tracked files keeps changed lines for the first six only.
