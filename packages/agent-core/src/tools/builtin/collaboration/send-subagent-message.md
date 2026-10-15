# SendSubagentMessage

Send a directed message to a subagent you own — to steer or inform it between turns, or to hand it a correction while it is still running.

- **queue**: delivered when the subagent starts its next turn, after any steer messages; use it for context that does not change the immediate direction.
- **steer**: delivered into the running turn at its next step boundary (or into the mailbox, delivered first, when no turn is running) — for a redirection that should reach the subagent while it is still working.
- **interject**: like steer, but it also interrupts the tool call currently in flight, so the correction lands immediately instead of after a long wait. Use it when the subagent is stuck in — or about to outlive the value of — a running command. This is a batch-level hammer, not a single-call cancel: every tool observing the abort signal is cut short (side-effecting commands included), approvals still waiting are withdrawn, and the abort travels down the signal chain into any foreground grandchild. Aimed at an idle or structured-output subagent, interject degrades to the steer/mailbox path and the acknowledgement names the reason.

## Rules

- Only the owning parent may message a subagent (never itself); the acknowledgement names the path — "queued" means it has not reached the subagent yet, "interjected" means the in-flight batch was cut short.
- `queue` and `steer` never abort a tool call already in flight; only `interject` does, and the interrupted tool reports it.
- Delivery is in-session and time-boxed: the mailbox lives in memory for this session only, an accepted message expires undelivered about 5 minutes after acceptance, and nothing survives a process restart; a subagent that already finished is refused — resume it instead.
- Messages are capped at 16 KiB of UTF-8 text (about 5,400 Chinese characters) and rejected rather than truncated. They arrive as a `[parent_messages]` block at the next step boundary or the top of the next prompt; steer the *goal*, not the implementation.
- Not a cancellation or a result channel: end work with `TaskStop` (background tasks) or by letting the turn finish, and wait for the completion notification instead of polling. Available only to agents that may spawn subagents — a subagent launched with a restricted `capability_mode` (read-only / read-write / execute) does not have this tool, so the capability filter cannot be bypassed.
