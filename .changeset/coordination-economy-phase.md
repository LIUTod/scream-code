---
"scream-code": minor
---

Coordination and economy phase: model roles, blocking wait, cache warmer, and the deferred tool portal

- New role-based model routing: `[loop_control] model_roles` binds read,
  task, and judge tiers to cheaper model aliases; subagent profiles
  without an explicit binding fall back to their role class, then to the
  session model. Thinking-level probing is unchanged, and profiles that
  are never role-routed (prose/design) follow the session model.
- New Wait tool blocks the current turn until an owned background task
  reaches a terminal state (event-driven with an idle-ladder fallback),
  returning the terminal status, an output tail, and the remaining task
  count. Timeouts report the still-running state rather than an error;
  interrupts follow the standard abort convention.
- New opt-in `[loop_control] cache_warmer` replays the last routed
  request at ~90% of the provider's declared cache TTL on idle sessions,
  gated on a net dollar saving (protected cache value minus the replay's
  own cost). Sessions without prompt-caching aliases never schedule.
- Low-frequency built-in tool groups (cron, memory, knowledge, goal,
  image, make-skill, manage-plugin, inspect — 19 tools) are now offered
  through a DiscoverTools portal instead of occupying schema space in
  every request; enabling a group registers its tools from the next
  turn. `toolPortal = "off"` restores the always-resident tool table
  byte-for-byte.
