Schedule a prompt to be enqueued at a future time — recurring jobs and one-shot reminders alike. Give exactly one of `cron`, `in` or `at`.

One-off reminders: use `in` or `at` and let the tool do the date math against the real local clock — never work out today's date or hour yourself. The time in your system prompt is from when the session was opened and does not advance, so arithmetic on it drifts and can land on the wrong day.
- "in 20 minutes" → `in: "20m"`; "in 2 hours" → `in: "2h"`; also `90s`, `1h30m`, `2d` (rounded up to the next minute).
- "at 3pm" → `at: "15:00"` (the next 15:00: today if still ahead, otherwise tomorrow); "tomorrow at 9" → `at: "tomorrow 09:00"`; "today at 18:30" → `at: "today 18:30"` (refused if already past, rather than moved); a specific day → `at: "2026-11-20 09:00"`. Local time, 24-hour clock.
- `in` / `at` are always one-shot: leave `recurring` out (or false).

Repeating tasks: use `cron`. Fields are local time, `M H DoM Mon DoW`, so `0 9 * * *` means 9am local with no timezone conversion. Recurring (`recurring: true`, the default with `cron`) fires on every match until deleted or auto-expired: `*/5 * * * *` (every 5 min), `0 * * * *` (hourly), `0 9 * * 1-5` (weekdays at 9am local). A `cron` with `recurring: false` fires once at the next match, then auto-deletes.

Every result — and every refusal — ends with `now:` (the current local time with its UTC offset) and `timeZone:` (for example `Asia/Shanghai (UTC+08:00)`); `nextFireAt` is in the same local form. Tell the user times in that local form, and use `now:` when you need today's date for a dated `at`.

Avoid the `:00` and `:30` marks when the request is approximate — every user who asks for "9am" gets `0 9`, so the whole fleet fires at the same instant. Nudge the minute instead (`57 8 * * *`, `3 9 * * *`; hourly → `7 * * * *`), and use `0`/`30` only when the user names that exact time ("at 9:00 sharp"). Anti-herd jitter is applied per task id on top of this: recurring fires drift forward by ≤ min(10% of the period, 15 min), and a one-shot `cron` landing on `:00`/`:30` is pulled earlier by ≤ 90s. `in` / `at` reminders are exempt — they fire on the stated minute.

Scheduler wake-up: if the scheduler slept past several ideal fire times (laptop closed, long turn), only one delivery arrives, carrying `coalescedCount` — treat `coalescedCount > 1` as "some checks were missed; only the latest state matters". When a task fires, your prompt is re-injected verbatim inside a parseable `<cron-fire jobId="…" cron="…" recurring="…" coalescedCount="N" stale="…" firedAt="…">` envelope; `firedAt` is the local time of that delivery. An `<instruction>` line before the prompt marks the fire as work to do in that turn: do what the prompt says, rather than listing or re-creating the task.

Recurring tasks alive for more than 7 days fire one final time with `stale="true"`, then are auto-deleted; calling `CronCreate` again with the same `cron` and `prompt` starts a fresh 7-day window. One-shot tasks are never stale. Tasks live in the current CLI session — persisted under the session homedir on exit and reloaded when that session is resumed (`scream -C` in the same directory, `scream -r <session id>`, or `/sessions`) — and do not carry over into a brand-new session.

Returns `id` (8-hex, needed by `CronDelete`), `cron` (the pinned expression for `in` / `at`), `humanSchedule`, `recurring`, `nextFireAt`, `now`, `timeZone`.

In a one-off command run (such as `scream -p`) the tool refuses: the process exits when the run ends, so nothing would fire.

While the background host runs, a repeating task (`cron`, every 15 minutes or less often) made in a terminal session becomes a background job instead: it runs in a fresh session each time, keeps running after this terminal closes, and its results show in `/jobs` (manage it with `JobList` / `JobDelete`). One-shots, chat sessions and `in_session: true` keep the task in this conversation.
