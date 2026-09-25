# scream-code

## 0.16.10

### Patch Changes

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Make the agent behave consistently on macOS, Linux and Windows. The bundled ripgrep binary is now picked by probing the host libc instead of inferring it from the CPU architecture, Windows falls back to PowerShell when Git Bash is absent, and command execution resolves `.cmd`/`.bat` shims through `PATHEXT` rather than relying on a shell. Timed-out hooks and update steps terminate the whole process tree on Windows. Path safety checks understand Windows drive letters and UNC paths, the external editor no longer assumes a POSIX shell, and installing the package no longer hard-fails on platforms without a prebuilt local-embedding binary. State files are located through the shared home resolver and written atomically.

- [#18](https://github.com/LIUTod/scream-code/pull/18) [`2fda5b7`](https://github.com/LIUTod/scream-code/commit/2fda5b7ce50f060d09875a54f35f26e5fa7d8c58) - Recover explicit status codes from OpenAI-compatible streaming errors and classify status-less provider messages so transient failures enter the existing retry policy instead of immediately failing agent tasks.

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Stop reading injected reminders as a fresh user message when deciding whether to repeat the plan-mode reminder: only a real user prompt resets the cadence to the full reminder, so the periodic refresh threshold holds instead of re-emitting the long reminder on every step.

- [`dbbf1d6`](https://github.com/LIUTod/scream-code/commit/dbbf1d6f59f0123dd263f69c2583e8bd534ca67a) - Support an optional per-provider session header that carries the stable conversation id, stamp known catalog entries when connecting, and surface an actionable config hint when a gateway reports a missing session header.

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Stop appending a todo reconciliation round after the final answer: the reminder is now injected before the answer is written, inside the work the turn is already doing. The TodoList suggestion now waits for the third step so short two-step tasks are no longer nudged, and the periodic todo reminder fires half as often and only while the list still has unfinished items. Goal turns no longer continue after the answer just because TodoList was not updated this turn, and a turn counts as having touched the list only when the TodoList call actually succeeded.

- [`e4b54e1`](https://github.com/LIUTod/scream-code/commit/e4b54e1e13c05551755e92d8ab6798851d989933) - Buffer prompts that arrive while a turn is active so queued user input joins the steer path instead of failing as busy, and flush leftover steers at the start of the next turn.
