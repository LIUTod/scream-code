---
"scream-code": patch
---

The agent now uses scheduled tasks on its own initiative.

- The system prompt no longer says scheduling is a command only the user can run. It tells the agent when to schedule for itself: a later check instead of waiting with `sleep` on CI, a deploy or a review; a reminder at a time the user mentioned; a recurring job the user agreed to. Every task it creates is reported in its reply, one-off tasks are preferred, and tasks that became moot are deleted. Subagents, which cannot schedule, do not get this guidance.
- The tool group picker says what the scheduling tools are for, so the agent opens them when it needs them (they stay out of requests otherwise, saving about 2,600 tokens per request).
- Bot mode (unattended) is told not to stop where work only has to wait, but to schedule its own follow-up and carry on until the agreed work is done, still skipping and reporting what it is not allowed to do. It no longer asks the user questions: nobody is there to answer (in the terminal UI the question would hold the run until someone came back), so it picks the safest reasonable option, notes the assumption, and continues, listing in its final report only what truly needs the user. It can create, list and delete scheduled tasks, and can open tool groups at all — before, tools such as memory and knowledge lookup were listed as allowed in bot mode but were unreachable there.
