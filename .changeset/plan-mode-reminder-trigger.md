---
"scream-code": patch
---

Stop reading injected reminders as a fresh user message when deciding whether to repeat the plan-mode reminder: only a real user prompt resets the cadence to the full reminder, so the periodic refresh threshold holds instead of re-emitting the long reminder on every step.
