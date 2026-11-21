Retrieve output from a running or completed background task.

Use this after `Bash(run_in_background=true)` when you need to inspect progress or explicitly wait for completion.

Guidelines:
- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.
- By default this tool is non-blocking and returns a current status/output snapshot.
- Use block=true only when you intentionally want to wait for completion or timeout.
- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.
- For a terminal task, the metadata also explains why it ended: `timed_out` when an agent task was aborted by its deadline, and `stop_reason` when the task was explicitly stopped. `terminal_reason` is a categorical label for the same event — its value is `timed_out` or `stopped` — and is emitted alongside the matching `timed_out` / `stop_reason` field. A task that ended on its own emits none of these three fields.
- A running agent task (`agent-<id>`, a subagent) writes nothing to its log until it finishes: `output_size_bytes: 0` is its normal state and carries no liveness information. Read `subagent_steps` / `subagent_tool_calls` instead. They are cumulative, so a single sample proves nothing — only a later sample with higher counters proves progress. When the child could not be sampled the report says `subagent_steps: unavailable` with a `subagent_steps_note` — a missing reading is never left as a silent gap. `deadline_seconds_remaining` says when a quiet child will be reaped for you; stopping a task is a decision for the user, never a way to find out whether it is alive.
- The full, never-truncated log is always available at output_path; use the `Read` tool with that path to page through it, whether or not the preview was truncated.
- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.
