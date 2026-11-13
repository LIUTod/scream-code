Debug a Python program through a debugger (Debug Adapter Protocol) instead of guessing from prints.

One session per tool: `launch` or `attach` opens it, `disconnect` closes it. While a session is open every other operation applies to that session, and a second `launch`/`attach` is refused until you disconnect.

Typical loop:
1. `launch` with `program` and, when you know where it breaks, `breakpoints` — they are set before the program starts, so it stops at them (with `stop_on_entry` the program stops on its first line; default true).
2. Read the snapshot: `status: stopped`, the reason, the thread id and the top frame.
3. Inspect with `stack_trace`, `scopes`, `variables`, and `evaluate` (expressions run in the stopped frame).
4. `continue` to resume and wait for the next stop; add breakpoints mid-run with `set_breakpoints`.
5. `disconnect` when done — it terminates the debuggee and the adapter.

Operations:
- `launch` — `program`, optional `args`, `stop_on_entry`, `breakpoints`. Requires debugpy (`python3 -m pip install debugpy`); a missing install is reported as such.
- `attach` — `port` of a debuggee already running under `python -m debugpy --listen 127.0.0.1:<port>`.
- `set_breakpoints` — `path` + `lines` (1-based); reports verified/unverified per line.
- `continue` — resumes `thread_id` (defaults to the last stopped thread) and waits for the next stop.
- `stack_trace` — frames as `#0 main at file:line`; ids feed `scopes`.
- `scopes` — variable scopes of a `frame_id`; references feed `variables`.
- `variables` — `name = value (type)` for a `variables_reference`; nested references are reported as `(ref N)`.
- `evaluate` — `expression` in an optional `frame_id` (defaults to the top frame of the last stop).
- `disconnect` — ends the session and kills the adapter process.

`timeout_seconds` (default 5, at most 60) bounds how long `launch`/`attach`/`continue` wait for a stop. Timing out is not an error: the result says `status: running` and the session stays usable — inspect later with `stack_trace` after another `continue`, or add a breakpoint and continue.

Prefer this over inserting sleep/print debugging when the program is Python and a normal run reproduces the problem. Reads are returned for stopped threads only; a running program has no stack to inspect.
