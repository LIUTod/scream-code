---
"scream-code": minor
---

Context compaction gained an off mode. `loop_control.compaction_mode = "off"` disables micro and auto compaction entirely — built for unattended and IM sessions that must not stall on a compaction LLM call mid-task. The gate is structural, not advisory: `MicroCompaction.setEnabled(false)` freezes the context read paths (`messages` / `messagesForLLM` call `detect()` on every request), `estimateSavings` reads 0 so the gauge stays on raw tokens, `checkAutoCompaction` and the after-step hook no-op, and a context-overflow error surfaces as an error instead of triggering recovery compaction. At the blocking threshold the model receives a one-time wrap-up reminder per episode (re-armed once the context shrinks back under the same threshold) instead of being blocked, and the provider's own context limit remains the hard backstop. Manual `/compact` still works in both modes (its micro stage no-ops); the default mode is unchanged.
