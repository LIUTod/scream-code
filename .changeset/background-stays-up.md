---
"scream-code": patch
"@scream-code/agent-core": patch
"@scream-code/scream-code-sdk": patch
---

The background is harder to break and easier to trust.

- **It checks that it can reach the model, from its own environment.** A service starts without your shell's environment, so a key exported only in `~/.zshrc`, a company CA or a model set through `SCREAM_MODEL_*` worked in the terminal and silently failed in the background. Turning the service on now runs `scream host check` the way the service runs: one tiny request, no MCP servers or plugins started. `/service` shows the result, says what to do (`/config` to store a key), and can check again; the background also says which model it uses when it differs from the terminal's.
- **No more restart loops.** With a service installed, a terminal now starts the background through the service (once the check passed), so a terminal's host and the service's never compete. If they still do, the service's host waits for the other to leave instead of exiting and being restarted every ten seconds; `scream host stop` still leaves it stopped. A host that crashes three times in ten minutes is not restarted again, and you are told.
- **The launcher is repaired, never moved.** Running scream from a checkout no longer re-points your resident service at it; the launcher is rewritten only when what it runs is gone, and it now carries your CA, proxy and locale settings (never a key).
- **A timeout is not a failure.** A background task that fails because the provider timed out, the network was down or the provider was overloaded runs again 15 minutes later (twice at most) before it counts as failed; `/jobs` shows `↻`. The failure that remains names its cause (`Request timed out. [provider.timeout]`) instead of "the turn ended with reason 'failed'".
