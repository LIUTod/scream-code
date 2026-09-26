---
'@scream-code/agent-core': patch
---

Fix three runtime robustness gaps: the per-step tool-call block index no longer leaks one Map entry per step; approval timeouts clear their rejection timer when the response arrives first; and a provider-wrapped context-overflow error now fails fast instead of burning the full retry budget (compaction handles it). Session deletion no longer reports success when the directory could not be removed (new `session.delete_failed` error code), and session index/state writes all go through the shared atomic write. Tool name sets are centralized in one catalog module.
