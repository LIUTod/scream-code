Schedule a prompt to be enqueued at a future time — recurring jobs and one-shot reminders alike. Cron fields are local time, `M H DoM Mon DoW`, so `0 9 * * *` means 9am local with no timezone conversion.

One-shot (`recurring: false`) fires once at the next match, then auto-deletes — for "remind me at X" pin minute/hour/day-of-month/month: "remind me at 2:30pm today" → `30 14 <today_dom> <today_month> *`. Recurring (`recurring: true`, the default) fires on every match until deleted or auto-expired: `*/5 * * * *` (every 5 min), `0 * * * *` (hourly), `0 9 * * 1-5` (weekdays at 9am local).

Avoid the `:00` and `:30` marks when the request is approximate — every user who asks for "9am" gets `0 9`, so the whole fleet fires at the same instant. Nudge the minute instead (`57 8 * * *`, `3 9 * * *`; hourly → `7 * * * *`), and use `0`/`30` only when the user names that exact time ("at 9:00 sharp"). Anti-herd jitter is applied per task id on top of this: recurring fires drift forward by ≤ min(10% of the period, 15 min), and a one-shot landing on `:00`/`:30` is pulled earlier by ≤ 90s.

Scheduler wake-up: if the scheduler slept past several ideal fire times (laptop closed, long turn), only one delivery arrives, carrying `coalescedCount` — treat `coalescedCount > 1` as "some checks were missed; only the latest state matters". When a task fires, your prompt is re-injected verbatim inside a parseable `<cron-fire jobId="…" cron="…" recurring="…" coalescedCount="N" stale="…">` envelope.

Recurring tasks alive for more than 7 days fire one final time with `stale="true"`, then are auto-deleted; calling `CronCreate` again with the same `cron` and `prompt` starts a fresh 7-day window. One-shot tasks are never stale. Tasks live in the current CLI session — persisted under the session homedir on exit and reloaded by `scream resume` of that session — and do not carry over into a brand-new session.

Returns `id` (8-hex, needed by `CronDelete`), `humanSchedule`, `recurring`, `nextFireAt`.
