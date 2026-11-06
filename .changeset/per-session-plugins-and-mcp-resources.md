---
"scream-code": patch
---

Plugin activation is per session. Two sessions can now run the same code plugin independently — each gets its own hooks, event subscriptions and tools — and stopping it in one leaves the other untouched. Before, activations were keyed by plugin id alone, so the second session could not activate a plugin the first already ran, while the plugin centre showed a single global "active" for every session. The status query and the stop call are now session-scoped; global paths (disable, remove, the capability-sync unwind) still take every copy down.

The MCP client can also read a server's `instructions` and, when the server advertises the capability, list resources, list resource templates, read a resource and list prompt templates. (The user-facing surface for those is described in the MCP resource-tools entry.)
