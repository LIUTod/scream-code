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

## Rules

- You may only message subagents you spawned. Messaging a subagent owned by a
  different agent is refused.
- A subagent cannot message itself.
- No message aborts a tool call that is already in flight: a steer joins the
  running turn at its next step boundary, a queue message waits for the next
  turn start.
- The acknowledgement says which path the message took. "queued" means it has
  not reached the subagent yet.
- Keep messages short and unambiguous. The subagent sees them as a
  `[parent_messages]` block — merged into its running turn at the next step
  boundary, or at the top of its next prompt when the message waited for a turn
  start.
- Prefer steering the *goal*, not the implementation: tell the subagent what
  changed and what to reconsider, not how to rewrite its code.
- This tool is available only to agents that may spawn subagents. Subagents
  launched with a restricted `capability_mode` (read-only / read-write /
  execute) do not have this tool — they cannot send messages or spawn further
  agents, which keeps the capability filter from being bypassed.
