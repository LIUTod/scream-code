---
"scream-code": patch
---

Buffer prompts that arrive while a turn is active so queued user input joins the steer path instead of failing as busy, flush leftover steers at the start of the next turn, and allow one bounded todo reconcile continuation before ending a turn with unfinished items.
