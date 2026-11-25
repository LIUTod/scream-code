---
"@scream-code/agent-core": minor
"scream-code": minor
---

When a shell command changes a file the agent has read or edited — a Python one-off, a redirect, `sed -i` — the change no longer happens out of sight. The command's row in the activity block shows what it did to each file, under the file's name, with the same line numbers and colours as an edit, and the block's `+added -removed` counts it. The file's new text becomes the agent's known view, so its next Edit is not refused over it, and the result carries a short note pointing back to Edit / Write. Files the command created, or that the agent never opened, are not tracked.
