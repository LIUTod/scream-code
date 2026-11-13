Block the current turn until a background task finishes, then return its final status, an output tail, and how many other tasks are still running.

Prefer this over polling `TaskOutput` in a loop: start long work with `Bash(run_in_background=true)` (or a background agent task), then call Wait instead of repeatedly checking.

Guidelines:
- Omit `task_id` to wait for whichever task of this session finishes first; pass `task_id` to wait for one specific task. Waiting on an unknown task returns an error immediately instead of blocking.
- Waiting on an already-finished task returns its status and output tail immediately without blocking.
- `timeout_seconds` caps the block (default 120, at most 600). On timeout the task is still running and the result is NOT an error — wait again or check `TaskOutput`.
- `tail_lines` controls how many trailing output lines come back (default 40, at most 200). The full, never-truncated log stays available at `output_path` via the `Read` tool.
- A user or parent-agent interrupt cancels the wait.
