---
"scream-code": minor
---

Generated skills now ship with a test. `MakeSkillPlan` requires a `verification` block — two to four requests a real user would type that should invoke the skill, one to three near misses that should not, and one sentence naming an observable acceptance result — and returns it as a runnable line (`verification.instructions`) alongside the package. Short or generic triggers ("when needed"), a negative that repeats a positive, and an acceptance that names nothing observable are rejected with a message telling the author what to write instead. `/make-skill` relays that line to the user once the skill is installed, so a skill that never fires or fires on everything gets noticed the same day rather than never. Installed packages are untouched — the block lives in the plan, not in `SKILL.md` — but a newly generated plan without it is rejected.

The delegation rule gained a matching budget. A subagent that came back short gets one follow-up round with the specific gap; if the gap survives that, the work is finished directly or delivered with the gap stated — no third round, no fresh subagent for the same sub-problem. The same one-round budget now applies to research: after one supplementary search, report what is present and what is missing instead of widening the search again.
