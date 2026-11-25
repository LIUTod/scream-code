---
"@scream-code/agent-core": patch
---

When a tool call's arguments cannot be parsed at all, the error now says what to do next: send the call again as valid JSON, and for Edit split a long change into smaller edits, for Write send long content in parts. A complete call followed by stray text was already run as the first call since the previous release.
