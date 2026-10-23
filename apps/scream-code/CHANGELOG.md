# scream-code

## 0.19.1

### Patch Changes

- [`e53d2f9`](https://github.com/LIUTod/scream-code/commit/e53d2f9e9da0e2e7e8ea9141e8bc8fed847d4d8e) - Collapsed activity blocks now default to eight rows instead of three. At three rows a busy run only showed its header plus one step, which read as a frozen agent; the default now surfaces the newest steps of the timeline. `/blockrows` lets each user pick 5, 8 or 10, and a stored choice overrides the default; a previously stored 3 falls back to the new default.

- [`ca795a1`](https://github.com/LIUTod/scream-code/commit/ca795a1a3e6dea6a1928e71d8bb4781ae85fa471) - Give `/config` an entry menu: a bare `/config` (or `/login`) now asks which configuration flow to enter — the shortcut provider directory, the custom DIY setup, or image generation — instead of jumping straight into the catalog. `/config diy` and `/config image` keep their direct paths, and the first-run nudge opens the same menu.

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Make the agent behave consistently on macOS, Linux and Windows. The bundled ripgrep binary is now picked by probing the host libc instead of inferring it from the CPU architecture, Windows falls back to PowerShell when Git Bash is absent, and command execution resolves `.cmd`/`.bat` shims through `PATHEXT` rather than relying on a shell. Timed-out hooks and update steps terminate the whole process tree on Windows. Path safety checks understand Windows drive letters and UNC paths, the external editor no longer assumes a POSIX shell, and installing the package no longer hard-fails on platforms without a prebuilt local-embedding binary. State files are located through the shared home resolver and written atomically.

- [`5290a2a`](https://github.com/LIUTod/scream-code/commit/5290a2a9d6ba94b51587fb4ad1478b335ce6924b) - Fix the embedding-model setup card reappearing on every startup on installs without a pre-existing model cache. The pinned model archive is now staged by the app itself from a first-party GitHub release with HTTP status validation and an on-disk sha256 check, instead of relying on the third-party model mirror that stopped serving anonymous downloads — its downloader never checks the response status, so a 403 error page used to be silently written into the staged archive and every subsequent extract failed. Lint ratchet baseline lowered to the new low.

- [`965f7df`](https://github.com/LIUTod/scream-code/commit/965f7df148bfe9c0d39bcb2756b22ebdd8f4df9f) - Send the product user agent with requests to third-party model endpoints. The identity used to be attached only to providers configured with a session header, so most OpenAI-compatible and Anthropic endpoints saw the SDK's own library user agent instead of the product's. Device fingerprint headers remain host-scoped and are not forwarded to third-party endpoints.

- [`74904e9`](https://github.com/LIUTod/scream-code/commit/74904e9f3832466a8f16d2e35e5b9568c36f35fc) - The status-bar pulse wave now reports network silence only. While the agent is waiting on the model but receiving nothing — a request awaiting its first token, a reasoning or text stream that stopped delivering, or a tool call whose arguments are still being authored — the wave ramps from the brand colour to yellow at 15s and to a deep red at 25s, then stays deep red. Any qualifying inbound event returns it to the brand colour immediately.

  Tool execution is exempt: a local command that prints nothing (`sleep`, a quiet install, a long test run) is still working, and its own timeout owns the outcome, so the wave keeps its brand colour for as long as the tool runs. The footer now distinguishes the two halves of a tool call — `调用中 / Calling` while the model streams the arguments, `执行中 / Running` while the tool executes.

  A retry floors the wave at yellow, so a known failure never renders next to a "reconnecting" label while the wave still claims everything is healthy. Child-agent traffic and non-stream custom tool notifications (such as an MCP OAuth prompt) no longer reset the parent's silence clock, so activity that does not belong to the main model stream cannot hide a stalled call. Switching sessions clears the work phase and the liveness clock, so a new session cannot inherit a stalled indicator.

  The wave uses dedicated palette tokens (`waveMid` yellow / `wavePeak` deep red) instead of the general warning/error colours, with a light-theme pair tuned for a white background. It remains an early warning only: retries still come from real transport failures (the stall timeout, disconnects, rate limits).

- [#18](https://github.com/LIUTod/scream-code/pull/18) [`2fda5b7`](https://github.com/LIUTod/scream-code/commit/2fda5b7ce50f060d09875a54f35f26e5fa7d8c58) - Recover explicit status codes from OpenAI-compatible streaming errors and classify status-less provider messages so transient failures enter the existing retry policy instead of immediately failing agent tasks.

- [`165a7ca`](https://github.com/LIUTod/scream-code/commit/165a7caa67c618fa82a6037d2cf0aa7da3c039b0) - Generated plan files no longer create a visible `plan/` folder in the project root when an agent has no session home: they now go to `.scream/plans`, which is already gitignored. The coverage report also moved out of the repository root to `node_modules/.cache/coverage`, so running the test suite no longer leaves a 27 MB `coverage/` directory behind.

- [`7f6bf0d`](https://github.com/LIUTod/scream-code/commit/7f6bf0d9b49026ced29de226884849add0a0ec32) - `/knowledge` can now ingest PDF, Word (.docx) and Excel (.xlsx) files alongside Markdown and plain text. Binary documents are converted to Markdown by the document engine that already ships with the runtime, then follow the exact same chunking and embedding path as a `.md` file, so the shared vector index and `/memory` are unaffected.

  Details:

  - The converter engine moved into the knowledge package (no new dependencies, no new package). It is imported lazily, so startup and `/memory` searches never pay for it.
  - Images are dropped and their placeholders stripped; a document with no text layer (scanned PDF) fails with a clear message instead of storing an empty record.
  - Documents are fingerprinted by their raw bytes, so an identical file is skipped and a changed one is re-ingested.
  - Directory ingestion skips hidden entries, Office lock files (`~$…`) and unsupported formats.
  - Ingest prompts now recommend Markdown first and warn that scans, image-heavy files and wide tables extract poorly.

- [`0baa2ce`](https://github.com/LIUTod/scream-code/commit/0baa2ce006a5a611a2c16b1e02f163369a99108e) - Make /mcp uninstall honest for plugin-provided servers: the management panel now tags servers contributed by a plugin, refuses to "uninstall" them with a pointer to /plugin (that removal used to be undone on the next startup by the plugin hot-apply pass), and reports a real error instead of a fake success when a removed server is still listed.

- [`164e04b`](https://github.com/LIUTod/scream-code/commit/164e04b413618ef27ca4e9c81f69d7a9c50d6259) - Memory stays a single entity: `memos`. `/dream` merges near-duplicate memos and asks the model to write a distilled conclusion for each merge group, stored on the replacement memo as its latest distillation (最新归纳); merged memos also keep their sources' notes and a traceable lineage (`distilledFrom`, `distilledAt`, `origin`). Distilled rules are never age-pruned as resolved/stale, and a group that holds a rule is skipped when the plan carries no new conclusion. Both `distilled` and `note` are persisted, editable via `MemoryEdit` or in place from `/memory`, shown in `/memory` and memo injection, and returned by `MemoryLookup`; both also count towards keyword relevance, and search falls back to a LIKE match when a term appears only in either field.

  Each memo now also records where it came from: `origin` (`session` = extracted experience, `dream` = /dream rule, `user` = conclusion rewritten by the user), `distilledAt` (when the conclusion was generated or last rewritten) and `distilledFrom` (a snapshot of the memos folded into it — `{id, title, at}`, title clipped to 80 chars, max 100 items, carried across consolidation generations so a rule distilled from other rules keeps its ancestry). Existing rows are migrated in place: `origin` is backfilled to `dream` for every memo that already carries a `distilled` conclusion.

  The `/memory` picker shows rule provenance on the card (归纳 / 人工归纳, the distilled time and the source count) and in the detail view (归纳于 + up to five source entries, then `+N`), and lets the user rewrite the conclusion in place with `e` → Enter; a rewrite sets `origin='user'` and a fresh `distilledAt`, while clearing the text drops back to an extracted memo. Because merging permanently deletes the original memos, the `/dream` preview must show any existing conclusion it overrides, and deleting a rule in `/memory` now warns that its originals are gone for good.

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Stop reading injected reminders as a fresh user message when deciding whether to repeat the plan-mode reminder: only a real user prompt resets the cadence to the full reminder, so the periodic refresh threshold holds instead of re-emitting the long reminder on every step.

- [`71379e3`](https://github.com/LIUTod/scream-code/commit/71379e35d8d184f1481312d97a5d5a674fb52c16) - Harden the runtime and close two discoverability gaps:

  - Dependency install scripts are denied by default (`onlyBuiltDependencies: []`), so a future dependency cannot silently run code at install time — the failure mode that once let a GPU download in an optional dependency break the vector feature.
  - Concurrent writes to the same file are serialized (per-path queue): parallel edits from one tool batch or from sibling sub-agents can no longer lose an update, while different files still write in parallel.
  - An abnormal exit is reported once on the next launch, pointing at `/sessions` to recover; clean exits and terminal hangups stay silent.
  - New `/hotkeys` (keyboard shortcut reference) and `/copy` (copy the last reply to the clipboard) commands.

- [`dbbf1d6`](https://github.com/LIUTod/scream-code/commit/dbbf1d6f59f0123dd263f69c2583e8bd534ca67a) - Support an optional per-provider session header that carries the stable conversation id, stamp known catalog entries when connecting, and surface an actionable config hint when a gateway reports a missing session header.

- [`4d9c653`](https://github.com/LIUTod/scream-code/commit/4d9c6530bf9d10505e7649082bf7dd80912faf59) - Add a weighted offer tip to the empty-session tips carousel above the editor: the placement tip carries a clickable domain link (OSC 8) and is opened with Ctrl+F, rotations favor it at an 80% probability, and Ctrl+B still hides all tips.

- [`49a3542`](https://github.com/LIUTod/scream-code/commit/49a3542835bbdd4a6043a346b9c1ad45369e698c) - Stop appending a todo reconciliation round after the final answer: the reminder is now injected before the answer is written, inside the work the turn is already doing. The TodoList suggestion now waits for the third step so short two-step tasks are no longer nudged, and the periodic todo reminder fires half as often and only while the list still has unfinished items. Goal turns no longer continue after the answer just because TodoList was not updated this turn, and a turn counts as having touched the list only when the TodoList call actually succeeded.

- [`e4b54e1`](https://github.com/LIUTod/scream-code/commit/e4b54e1e13c05551755e92d8ab6798851d989933) - Buffer prompts that arrive while a turn is active so queued user input joins the steer path instead of failing as busy, and flush leftover steers at the start of the next turn.

- [`641f335`](https://github.com/LIUTod/scream-code/commit/641f3353706fb03a7eeadc8860fb5b27126042f8) - Move the local embedding engine off native binaries onto a self-contained WebAssembly pipeline. Installing no longer pulls a compiler toolchain or an unused GPU runtime on Linux (and can no longer lose the whole vector feature when that download fails), the dependency tree drops its deprecated packages, and the model download now reports byte progress with stall and overall timeout guards plus verify/load phases. A cache is only considered installed when the weights and both tokenizer files are present, so a half-restored cache repairs itself instead of failing at load time. Vectors are bit-compatible with the previous engine.
