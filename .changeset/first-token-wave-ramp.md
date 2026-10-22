---
"scream-code": patch
---

The status-bar pulse wave now reports network silence only. While the agent is waiting on the model but receiving nothing — a request awaiting its first token, a reasoning or text stream that stopped delivering, or a tool call whose arguments are still being authored — the wave ramps from the brand colour to yellow at 15s and to a deep red at 25s, then stays deep red. Any qualifying inbound event returns it to the brand colour immediately.

Tool execution is exempt: a local command that prints nothing (`sleep`, a quiet install, a long test run) is still working, and its own timeout owns the outcome, so the wave keeps its brand colour for as long as the tool runs. The footer now distinguishes the two halves of a tool call — `调用中 / Calling` while the model streams the arguments, `执行中 / Running` while the tool executes.

A retry floors the wave at yellow, so a known failure never renders next to a "reconnecting" label while the wave still claims everything is healthy. Child-agent traffic and non-stream custom tool notifications (such as an MCP OAuth prompt) no longer reset the parent's silence clock, so activity that does not belong to the main model stream cannot hide a stalled call. Switching sessions clears the work phase and the liveness clock, so a new session cannot inherit a stalled indicator.

The wave uses dedicated palette tokens (`waveMid` yellow / `wavePeak` deep red) instead of the general warning/error colours, with a light-theme pair tuned for a white background. It remains an early warning only: retries still come from real transport failures (the stall timeout, disconnects, rate limits).
