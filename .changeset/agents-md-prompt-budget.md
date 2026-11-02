---
"scream-code": patch
---

`AGENTS.md` instructions are no longer lost silently. The merged prompt payload keeps a 32 KiB budget, but every discovered file now gets a 2 KiB floor first, so one oversized project guide can no longer zero the user-level `~/.scream-code/AGENTS.md` — the previous allocation order dropped those conventions from the prompt without a trace. A file that does not fit ends with `[... N bytes truncated; read <path> for the rest]`, so the model knows the guide continues and can open it, instead of assuming it read everything. Truncation itself is now a single encode plus a UTF-8 boundary walk rather than one character per pass, which removes a multi-second stall on the prompt path of every agent start and subagent spawn when the guide is large.
