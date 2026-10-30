---
"scream-code": minor
"@scream-code/config": minor
---

The footer is now two fixed rows. Line 1 keeps identity: model name, provider balance and the working-tree git summary, with the context gauge right-aligned as `📨 Context：<bar> <percent>` (slim `▰▱` bar, 10/6/0 cells at >=68/>=52/<52 columns, floored with at least one lit cell for non-zero usage; the whole gauge shares one semantic colour). Line 2 starts with the cache hit rate, then the plan/rlm/wolfpack mode badges, the goal badge and background-task badges, with the channel readout `◆ Line: <Lark|Wechat|未连接> <work status>` right-aligned (only the dot is coloured; line 2 shrinks its left side first). The status row above the editor now uses one chip grammar: `⚠️ 重连中 n/max：reason · delay`, `🤝 name 求助：issue` / `✓ Scream 已处理 name 的请求`, and the idle hint in the theme's dim colour instead of a hardcoded grey.

Subagent-to-parent collaboration requests no longer cut into the transcript. A delivered request surfaces as a one-line ticker above the editor — `coder is asking Scream for help: <preview>` — replaced by the newest event and echoed as `Scream handled the request from coder` once the main agent answers it. The request body stays in the parent's context and in the agent card's tool-call arguments. This removes the unreachable activity-pane component, the unused loader colour setter and the duplicate status-bar spinner branch, and stops the pulse-wave timer chain on shutdown.
