# scream-code

## 0.18.8

### Patch Changes

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Make the agent behave consistently on macOS, Linux and Windows. The bundled ripgrep binary is now picked by probing the host libc instead of inferring it from the CPU architecture, Windows falls back to PowerShell when Git Bash is absent, and command execution resolves `.cmd`/`.bat` shims through `PATHEXT` rather than relying on a shell. Timed-out hooks and update steps terminate the whole process tree on Windows. Path safety checks understand Windows drive letters and UNC paths, the external editor no longer assumes a POSIX shell, and installing the package no longer hard-fails on platforms without a prebuilt local-embedding binary. State files are located through the shared home resolver and written atomically.

- [`5290a2a`](https://github.com/LIUTod/scream-code/commit/5290a2a9d6ba94b51587fb4ad1478b335ce6924b) - Fix the embedding-model setup card reappearing on every startup on installs without a pre-existing model cache. The pinned model archive is now staged by the app itself from a first-party GitHub release with HTTP status validation and an on-disk sha256 check, instead of relying on the third-party model mirror that stopped serving anonymous downloads — its downloader never checks the response status, so a 403 error page used to be silently written into the staged archive and every subsequent extract failed. Lint ratchet baseline lowered to the new low.

- [`965f7df`](https://github.com/LIUTod/scream-code/commit/965f7df148bfe9c0d39bcb2756b22ebdd8f4df9f) - Send the product user agent with requests to third-party model endpoints. The identity used to be attached only to providers configured with a session header, so most OpenAI-compatible and Anthropic endpoints saw the SDK's own library user agent instead of the product's. Device fingerprint headers remain host-scoped and are not forwarded to third-party endpoints.

- [#18](https://github.com/LIUTod/scream-code/pull/18) [`2fda5b7`](https://github.com/LIUTod/scream-code/commit/2fda5b7ce50f060d09875a54f35f26e5fa7d8c58) - Recover explicit status codes from OpenAI-compatible streaming errors and classify status-less provider messages so transient failures enter the existing retry policy instead of immediately failing agent tasks.

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Stop reading injected reminders as a fresh user message when deciding whether to repeat the plan-mode reminder: only a real user prompt resets the cadence to the full reminder, so the periodic refresh threshold holds instead of re-emitting the long reminder on every step.

- [`dbbf1d6`](https://github.com/LIUTod/scream-code/commit/dbbf1d6f59f0123dd263f69c2583e8bd534ca67a) - Support an optional per-provider session header that carries the stable conversation id, stamp known catalog entries when connecting, and surface an actionable config hint when a gateway reports a missing session header.

- [`4d9c653`](https://github.com/LIUTod/scream-code/commit/4d9c6530bf9d10505e7649082bf7dd80912faf59) - Add a weighted offer tip to the empty-session tips carousel above the editor: the placement tip carries a clickable domain link (OSC 8) and is opened with Ctrl+F, rotations favor it at an 80% probability, and Ctrl+B still hides all tips.

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Stop appending a todo reconciliation round after the final answer: the reminder is now injected before the answer is written, inside the work the turn is already doing. The TodoList suggestion now waits for the third step so short two-step tasks are no longer nudged, and the periodic todo reminder fires half as often and only while the list still has unfinished items. Goal turns no longer continue after the answer just because TodoList was not updated this turn, and a turn counts as having touched the list only when the TodoList call actually succeeded.

- [`e4b54e1`](https://github.com/LIUTod/scream-code/commit/e4b54e1e13c05551755e92d8ab6798851d989933) - Buffer prompts that arrive while a turn is active so queued user input joins the steer path instead of failing as busy, and flush leftover steers at the start of the next turn.
