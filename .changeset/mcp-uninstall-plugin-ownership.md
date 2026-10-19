---
"scream-code": patch
---

Make /mcp uninstall honest for plugin-provided servers: the management panel now tags servers contributed by a plugin, refuses to "uninstall" them with a pointer to /plugin (that removal used to be undone on the next startup by the plugin hot-apply pass), and reports a real error instead of a fake success when a removed server is still listed.
