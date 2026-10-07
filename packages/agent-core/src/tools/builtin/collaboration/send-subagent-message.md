# SendSubagentMessage

Send a directed message to a subagent you own. Use this to steer or inform a
subagent between its turns — for example, to redirect it after new
information arrives, or to hand it a correction while it is still running.

- **queue**: delivered when the subagent starts its next turn, after any steer
  messages. Use for context that does not change the immediate direction.
- **steer**: delivered into the subagent's running turn, where it joins at the
  subagent's next step boundary; if no turn is running it waits in the mailbox
  and is delivered first at the next turn start. Use for a redirection that
  should reach the subagent while it is still working.
- **interject**: like steer, but it also interrupts the tool call the subagent
  currently has in flight, so the correction takes effect immediately instead
  of after a long wait. Use it when the subagent is stuck in — or about to
  outlive the value of — a running command, and you already know what it
  should do instead. This is a batch-level hammer, not a single-call cancel:
  every tool that observes the abort signal is cut short (side-effecting
  commands included), approvals still waiting for an answer are withdrawn, and
  the abort travels down the signal chain into any foreground grandchild the
  batch is waiting on. The RLM Python kernel observes the signal too: a long
  exec is interrupted through the same SIGINT route, the running statement is
  unwound and the kernel keeps its state (variables survive; a kernel that does
  not return to an idle prompt is restarted instead). An interject aimed at an
  idle or structured-output subagent degrades to the steer/mailbox path.

## Rules

- You may only message subagents you spawned. Messaging a subagent owned by a
  different agent is refused.
- A subagent cannot message itself.
- `queue` and `steer` never abort a tool call that is already in flight: a
  steer joins the running turn at its next step boundary, a queue message waits
  for the next turn start. Only `interject` interrupts the in-flight batch —
  the interrupted tool reports the interruption, so the subagent knows the
  result is missing and why.
- The acknowledgement says which path the message took. "queued" means it has
  not reached the subagent yet; "interjected" means the in-flight batch was cut
  short.
- Keep messages short and unambiguous. The subagent sees them as a
  `[parent_messages]` block — merged into its running turn at the next step
  boundary, or at the top of its next prompt when the message waited for a turn
  start.
- Prefer steering the *goal*, not the implementation: tell the subagent what
  changed and what to reconsider, not how to rewrite its code.
- Do not use this tool to stop a subagent: a message is never a cancellation.
  To end its work use `TaskStop` (background tasks) or let the turn finish.
- Do not use this tool to collect results: a subagent's completion arrives on
  its own as a notification (or as the `Agent` tool's return value in the
  foreground). Wait for that instead of polling.
- This tool is available only to agents that may spawn subagents. Subagents
  launched with a restricted `capability_mode` (read-only / read-write /
  execute) do not have this tool — they cannot send messages or spawn further
  agents, which keeps the capability filter from being bypassed.
