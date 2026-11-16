---
"scream-code": patch
---

More of the UI now follows the language setting instead of showing Chinese under an English UI. The reusable-skill prompt (`skill_candidate`) is the one that mattered: it is sent through `session.prompt`, so it appeared in an English session's transcript as a Chinese "user message" and told the model to offer the options 生成 / 忽略 — it now asks in the UI language, option labels included. Also localized: the `/compact` and model-switch Storm Breaker notices, the "no model configured" notice, the `/editor` confirmations (previously a mix of English and Chinese in either language), `/trace` messages and the whole trace report (page title, detail panel, counts, and the cell descriptions — the report's `lang` follows the UI), plugin-marketplace validation errors, the clipboard video-size error, and the `[imported]` session badge. The memory consolidation reminder (`/dream` suggestion) is injected for the model, so it is English like the other reminders.

The engine words its warnings in English (headless output, logs), which had left Chinese-UI users reading English after the engine-side Chinese was removed. The notices a TUI user acts on are now localized by a stable code: `warning` events with code `compaction_circuit_open` / `compaction_circuit_open_overflow`, and the new `code` on `compaction.cancelled` (`timeout` | `context_changed`, exported as `CompactionCancelCode`; `reason` keeps the English text for other consumers). Any other warning still shows the engine's text. `/budget`'s limit display no longer shows `1000k` for 999,999 (it rolls over to `1M`).

Seven idle-memory-extraction messages (`lifecycle.memory_*`) referenced dictionary keys that did not exist in either language; that path is currently unreachable (idle extraction is disabled), but the entries are added so re-enabling it cannot show raw keys.

Two tests now guard this class of mistake: `i18n-call-sites.test.ts` (every literal `t()` key exists and every `{placeholder}` the text uses is supplied) and `i18n-hardcoded-text.test.ts` (no CJK outside comments in the app source, except a short list of deliberate exceptions such as the Feishu/WeChat channel).
