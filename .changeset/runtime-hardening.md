---
"scream-code": patch
---

Harden the runtime and close two discoverability gaps:

- Dependency install scripts are denied by default (`onlyBuiltDependencies: []`), so a future dependency cannot silently run code at install time — the failure mode that once let a GPU download in an optional dependency break the vector feature.
- Concurrent writes to the same file are serialized (per-path queue): parallel edits from one tool batch or from sibling sub-agents can no longer lose an update, while different files still write in parallel.
- An abnormal exit is reported once on the next launch, pointing at `/sessions` to recover; clean exits and terminal hangups stay silent.
- New `/hotkeys` (keyboard shortcut reference) and `/copy` (copy the last reply to the clipboard) commands.
