---
"scream-code": patch
---

Groundwork for a Scream that keeps working while you are away.

- Scheduled tasks are told that a firing is work to do now. A task's prompt is written like a schedule ("every morning, append …"), and arriving with no frame it could be read as a request to check the schedule, so the turn did nothing and still counted as a success. Every firing now carries a line that says: do the work in this turn.
- A session that stays open across midnight (a chat channel, a long goal, scheduled tasks) is told the new date once the day changes, instead of reading "today" off the time the session was opened. Nothing is added while the day has not changed.
- The line daemon (`scream line`) is found and stopped through a lock the operating system holds for the daemon's lifetime, not a pidfile. It can no longer be mistaken for an unrelated process that reused its pid (on Windows that kept a new daemon from starting), and `scream line stop` and `/line` stop now let the turn in progress finish, up to 60 seconds, on every platform; before, stop killed the daemon after 8 seconds, and on Windows at once. The CLI says that it is waiting. A daemon from an earlier release is still found and stopped.
- On Windows the daemon no longer opens a console window of its own.
- `daemon.log` is kept under 5 MB while the daemon runs (it was only checked at start).
- `scream -C` continues your own most recent session and skips sessions a chat channel owns, and `scream -r <id>` refuses a chat channel's session, as the session picker already did.
- Chat replies no longer point you to a "desktop" app that does not exist; they say to use `scream` in the terminal.
- The hidden `stream-json` subcommand, kept only for an external chat bridge, is gone, along with its session-picker special case. Sessions that bridge created open and delete like any other. `scream -p --output-format stream-json` is unchanged.
