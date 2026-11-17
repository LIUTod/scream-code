---
"scream-code": patch
---

Headless runs and first-run robustness.

- `scream -p "<prompt>" --max-time <duration>` stops a prompt-mode run that outlasts the limit (`600`, `90s`, `10m`, `1h30m`): at the limit it cancels the turn, prints a message and the command to resume the saved session, and exits with status 124 — the conventional `timeout` status — so a script or scheduler can tell "ran out of time" from a failure. The limit is when shutdown starts, not a hard kill: winding down the request or tool that is in flight takes a few more seconds (about two in the common case). An error while winding down after the limit is logged but never replaces the 124 status. The flag is rejected outside prompt mode.
- ripgrep (behind `Grep`) is fetched more safely when it is not installed: the one-off download now gives up when the server does not answer or the data stops for 30 seconds (the old time limit was lifted as soon as the response headers arrived), and a failed attempt is not repeated for two minutes, so an unreachable GitHub costs one wait instead of one per search. `SCREAM_RG_DOWNLOAD_BASE_URL` points the download at a mirror; archives are still checked against pinned SHA-256 digests.
- `/cron`: the repeat option no longer says "until deleted" — a repeating task expires after 7 days (one last fire, then it is removed) — and creating a task now says that tasks only fire while the session is open and how to resume it (`scream -C`, `scream -r <id>` or `/sessions`). The cron tool docs and code comments no longer point at a `scream resume` command, which does not exist.
- CI also builds, smoke-tests and runs the suite on macOS (reported, not blocking yet).
