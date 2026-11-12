---
"scream-code": patch
---

Three kernel guards close the gap between "the tool behaved" and "the loop stayed healthy".

Repaired tool arguments are no longer silently indistinguishable from the model's own words. When a provider stream breaks mid-call and the bracket balancer reconstructs the arguments, the result now carries a visible note that the values are a reconstruction, so the model can verify or re-issue instead of trusting a best effort.

Tool calls got a generic execution deadline (default 300s, per-turn configurable via `toolDeadlineMs`). Previously a tool that never resolved and never checked the abort signal would hold the turn forever, because the grace timeout only arms *after* an abort. The deadline aborts the call's own signal — never the turn's — and if the tool ignores it, the call ends with a synthetic `timeout` result. `timeout` is a tool defect and counts toward the failure streak, unlike `aborted`, which is a user decision. Tools that manage their own lifetime (subagent host, WolfPack, blocking user prompts, plan approval) declare `longRunning` and are exempt.

Malformed provider streams no longer kill a turn unretryably. A tool-call argument delta naming an index that was never opened is now a typed `provider.stream_error` — retryable, with a bounded budget of three attempts so a transiently spliced gateway gets ridden out while a persistently broken one fails fast instead of burning the ten-attempt step budget.
