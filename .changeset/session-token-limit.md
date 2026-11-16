---
"scream-code": minor
---

New session token limit and a `/budget` command to set it. `/budget` opens a list of presets (or "Custom…"), `/budget 50m` sets it directly (`500k`, `20m`, `1.5b`, `500万` and `1亿` all work), `/budget off` removes it. The change applies to the running session at once — raising the limit un-pauses a session that hit it, no restart — and is saved as `loop_control.max_session_tokens` for new sessions. `/usage` shows this run's use against the limit while one is set.

It is a circuit breaker for unattended work (`/goal`, `/loop`, cron, wide subagent fan-out). Tokens are counted the way `/usage` and `/goal` budgets show them — input (cache reads included) plus output — across the main agent, every subagent (including ones still running, whose usage previously only reached the parent when they finished), compaction and the cache warmer. Once the limit is reached, every turn ends before its next model request (no wrap-up request), the cache warmer stops, an active goal is paused, recurring cron / `/loop` jobs skip their fires until the limit is raised (a one-shot reminder is still delivered), and `turn.ended` carries `tokenCapReached { usedTokens, limitTokens }`: the TUI shows a warning that points at `/budget`, stream-json exits 4 like the step budget, `-p` exits non-zero, and LINE replies with the reason. The count is what this run of the session used (resume or a new session starts a fresh allowance).

The unit is tokens, not money, on purpose: a dollar limit needs a catalog price, which custom providers and self-hosted models do not have, so it would count them as free and never trip. Unset or 0 (the default) changes nothing. New SDK calls: `Session.getSessionTokenBudget()` and `Session.setSessionTokenBudget(limit | null)`.
