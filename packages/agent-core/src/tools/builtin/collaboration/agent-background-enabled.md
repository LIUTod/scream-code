Delegation is **non-blocking by default**. You do NOT need to set `run_in_background` for normal work: an omitted flag gives the subagent a short foreground window, and if it outlives that window the still-running child is handed to the background automatically — you never hard-block waiting for it.

**Results auto-deliver; NEVER poll.** A finished subagent's result arrives as a synthetic user-role `<notification>` in a later turn — it steers you (waking you if you are idle) and you continue from there. Do not poll, sleep, or call `TaskOutput(block=true)` to wait for it, and never fabricate or predict what a subagent will say.

**What to do after delegating:** keep working on something else, or reply to the user. Do not sit idle re-checking. Only when there is genuinely nothing else to do, wait for the first subagent to finish — if you have a blocking-wait tool (the main agent's `Wait`; omit `task_id`), use it, and prefer it over any polling loop.

While a subagent runs it can reach you via `ContactParent` (delivered at your next step boundary), and a `SendSubagentMessage` reply steers it mid-run. When `timeout` is omitted, a background task falls back to the operator-configured background timeout if one is set — with none configured it runs with no time limit.
