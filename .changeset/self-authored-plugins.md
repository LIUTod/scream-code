---
"scream-code": minor
---

The agent can now author a plugin for itself: write a plugin directory, `register_generated` it, then `activate` it to bring the new tool live. Registration accepts a manifest with a code entry point, which the manifest layer confines to the plugin directory and which still runs only on an explicitly approved `activate`. `/extension reload <id>` re-imports edited plugin code by dropping the cached module, so iterating on a self-authored plugin no longer needs a process restart. The format is documented in `docs/plugins.md` and indexed in the system prompt.
