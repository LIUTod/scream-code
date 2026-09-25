---
"scream-code": patch
---

Stop appending a todo reconciliation round after the final answer: the reminder is now injected before the answer is written, inside the work the turn is already doing. The TodoList suggestion now waits for the third step so short two-step tasks are no longer nudged, and the periodic todo reminder fires half as often and only while the list still has unfinished items. Goal turns no longer continue after the answer just because TodoList was not updated this turn, and a turn counts as having touched the list only when the TodoList call actually succeeded.
