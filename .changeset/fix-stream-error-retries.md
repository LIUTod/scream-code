---
"scream-code": patch
---

Recover explicit status codes from OpenAI-compatible streaming errors and classify status-less provider messages so transient failures enter the existing retry policy instead of immediately failing agent tasks.
