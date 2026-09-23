---
"@scream-code/ltod": patch
"scream-code": patch
---

Recover explicit status codes from OpenAI-compatible streaming errors so transient 5xx and 429 failures enter the existing retry policy instead of immediately failing agent tasks.
