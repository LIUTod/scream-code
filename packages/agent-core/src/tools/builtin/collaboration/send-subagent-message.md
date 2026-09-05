# SendSubagentMessage

Send a directed message to a subagent you own. Use this to steer or inform a
subagent between its turns — for example, to redirect it after new
information arrives, or to hand it a correction while it is still running.

- **queue**: delivered at the subagent's next turn boundary, after any steer
  messages. Use for context that does not change the immediate direction.
- **steer**: delivered first (highest priority). Use for a redirection that
  should be applied before the subagent continues.

## Rules

- You may only message subagents you spawned. Messaging a subagent owned by a
  different agent is refused.
- A subagent cannot message itself.
- Messages are delivered at the next turn start; a message cannot interrupt a
  turn that is already in flight.
- Keep messages short and unambiguous. The subagent sees them as a
  `[parent_messages]` block at the top of its next prompt.
- Prefer steering the *goal*, not the implementation: tell the subagent what
  changed and what to reconsider, not how to rewrite its code.
- This tool is available only to agents that may spawn subagents. Subagents
  launched with a restricted `capability_mode` (read-only / read-write /
  execute) do not have this tool — they cannot send messages or spawn further
  agents, which keeps the capability filter from being bypassed.
