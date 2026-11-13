---
"scream-code": minor
---

/model diy rework: role routing and the compaction model become pickers

`/model diy` now opens with three entries: role-based routing (read =
explore/plan/verify, task = coder/worker, judge = reviewer/oracle),
the compaction-summary model, and the existing per-profile bindings
(unchanged, one level deeper). Selections persist to tui.toml's new
`[modelTiers]` table and apply live — the next subagent spawn, resume,
and compaction all honour them, falling back to the config.toml
`loop_control.model_roles` / `housekeeping_model` values and then the
session model. Unset tier rows now say "follow default (config first)"
instead of claiming the main model, and compaction warnings name the
real fallback.

Also tightens the tool-portal contract: an explicit tool list is exact,
portal shaping happens only for the default profile, explicit lists that
name a deferred tool construct it, and enabled groups survive a default
profile re-application.
