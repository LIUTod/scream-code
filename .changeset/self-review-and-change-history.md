---
"scream-code": minor
---

Scream improves itself, within limits you set, and every change can be undone.

- **Weekly self-review**, a built-in background job (turn it on in `/jobs`, or when you first turn the service on): every Monday it looks at numbers only — how often each tool was called and failed over the week, which sessions had the most errors (ids only), and how often each skill was actually invoked over four weeks — never at conversations. It proposes at most three improvements (a new skill, a skill change, tidier memories, a plugin), each with what, why, where it came from and which friction it should reduce, and suggests retiring skills nobody used for four weeks.
- **It only proposes by default.** Let it make small changes from the job's page in `/jobs`: new or edited skills are then made directly; deleting skills, writing memories and anything to do with plugins still wait for you, and enabling plugin code always asks. It works in the skills folder, so permissions, budgets and config are out of its reach.
- **Change history** (`/skills` → Change history, or `/memory history`): every change to skills and memories is recorded in `~/.scream-code/evolution` (git) and can be rolled back one change at a time.
