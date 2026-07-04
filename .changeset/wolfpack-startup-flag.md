---
'scream-code': minor
---

Add `--wolfpack` CLI flag to start with WolfPack batch mode enabled.

Previously WolfPack mode could only be toggled at runtime via the `/wolfpack`
slash command. This adds a CLI startup option (`--wolfpack`) symmetric to the
existing `--plan` and `--auto` flags, so users can launch a session with
WolfPack already active.
