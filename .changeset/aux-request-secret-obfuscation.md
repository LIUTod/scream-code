---
"scream-code": patch
---

Secret obfuscation now covers every LLM request, not only the main loop. Compaction (session model and the `housekeeping_model` override), side questions (`/btw`), exit memory extraction, `generateText` and skill planning previously called `Agent.generate` with history in local form, so configured `secrets` and the default patterns (AWS / GitHub tokens, …) reached the provider in the clear — on the housekeeping path, a different provider. `Agent.generate` now obfuscates messages at that single seam; the side-question excerpt embedded in its system prompt is masked too, and `/btw` / `generateText` answers are deobfuscated for local consumers. The routed main-loop request and the cache warmer replay, already in outbound form, use an internal non-obfuscating path, so request bytes and the cache prefix they share with compaction are unchanged.
