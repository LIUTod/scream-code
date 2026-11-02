---
"scream-code": minor
---

A `/line` turn now gets an hour of wall-clock time instead of 15 minutes. Real work over chat — a full test run, a multi-file refactor, a long review — regularly passed the old cap and the user lost the whole turn; the new default is 60 minutes, configurable with `turnTimeoutMinutes` in `line/config.json` (1–1440). The cap is still only there so a turn that never settles cannot hold a chat's queue forever: when it does fire, the reply names the configured minutes instead of a hardcoded 15, `/status` shows the cap, the daemon prints it at startup, and scheduled-task turns are bounded by the same value rather than their own separate guard.
