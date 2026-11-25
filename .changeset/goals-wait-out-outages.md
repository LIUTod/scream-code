---
"scream-code": patch
"@scream-code/agent-core": patch
---

**Unattended work waits out an outage instead of giving up.** A goal or a bot-mode run whose model requests keep failing because the network is down (a laptop that just woke), the provider timed out or is overloaded keeps trying for up to 30 minutes, less and less often, instead of pausing after a few minutes. The status bar says when it tries next and until when (`⚠️ 连不上模型：… · 2 分钟 后再试 · 最多等到 09:40 · Esc 停止`); Esc stops it. A conversation you are typing in still fails after the usual retries, and a rejected key is never waited out.
