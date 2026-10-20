---
"scream-code": patch
---

`/dream` now distills experience into reusable rules instead of deleting similar memos.

- Dream folds clusters of memos into **digest cards** (`fact` / `preference` / `procedure` / `pitfall`) with an explicit conclusion, evidence ids, confidence and three separate timestamps (statement updated, re-confirmed, last hit).
- Memos are marked `digested`, kept for a 14-day grace window, then physically deleted; nothing is deleted before its information is in a card, and un-digested episodic memos expire after 90 days.
- Cards are capped at 200 and evicted dormant-first; cards nobody re-confirmed or used for 180 days stop being injected but are not deleted.
- New sessions inject the five most relevant cards (fact / procedure / pitfall) with their update month, ranked by relevance × freshness.
- `/memory` keeps its notes view unchanged and now hides digested entries.
