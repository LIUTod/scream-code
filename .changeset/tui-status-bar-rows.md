---
"scream-code": minor
"@scream-code/config": minor
---

The status bar above the editor is now two fixed rows. Line 1 keeps identity: model name, provider balance and the working-tree git summary, with the channel dot, channel name and work status right-aligned. Line 2 starts with the cache hit rate, then the plan/rlm/wolfpack mode badges, the goal badge and background-task badges, ending with the context gauge as `context: <percent> <bar>`.

Subagent-to-parent collaboration requests no longer cut into the transcript. A delivered request surfaces as a one-line ticker above the editor — `coder is asking Scream for help: <preview>` — replaced by the newest event and echoed as `Scream handled the request from coder` once the main agent answers it. The request body stays in the parent's context and in the agent card's tool-call arguments. This removes the unreachable activity-pane component, the unused loader colour setter and the duplicate status-bar spinner branch, and stops the pulse-wave timer chain on shutdown.
