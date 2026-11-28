---
"scream-code": patch
---

When a newer version is found at startup, a small card asks what to do: Update now (runs `/update`), Not now (asks again next start), or Don't remind me (saved as `[updates] prompt = false` in `tui.toml`). It comes after the first-run cards, so they never stack, and the welcome panel keeps showing the new version either way.
