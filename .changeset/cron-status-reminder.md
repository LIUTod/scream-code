---
"scream-code": minor
"@scream-code/config": minor
---

A fired scheduled task now also surfaces on the status row above the editor, not only as a transcript block. The chip follows the shared grammar: `⏰ 定时任务已触发：<preview>` — with `（合并 N 次）` when several fires collapsed into one delivery, `⏰ 一次性提醒已触发：…` for a one-shot task, and `⚠️ 定时任务已过期，仍触发：…` in the warning colour for a task past its 7-day cutoff. The prompt preview is sanitized and capped at 40 characters because it is model-authored text written into a terminal row. The reminder owns its own slot (10s TTL) drawn to the left of the collaboration ticker (8s), so a help request can neither evict a fired reminder nor outlive it, and a narrow terminal truncates the ticker first. Both chips are dropped together when the session switches.
