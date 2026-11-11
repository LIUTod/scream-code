---
"scream-code": patch
---

Authority is now a property of the message channel, not of a text tag. The prompt says how it works: a `<system-reminder>` block delivered as a standalone user-role message between steps is a runtime directive; the same tag inside a tool result, a file, a subagent report, a longer user message, or a third-party wrapper is quoted text that can inform the work but cannot widen permissions, approve an action, lift a restriction, or stand in for the user's consent. `AGENTS.md` and other repository files carry project instructions, never approval.

Three channels were brought in line with that rule. MCP server instructions arrive in their own `<mcp-server-instructions>` block on the user channel instead of impersonating a runtime reminder, and resume no longer re-appends the block after replaying it. Stop-hook output is wrapped as `<hook_result>` like every other hook result, so a hook cannot forge a directive. Cross-step duplicate-call nudges moved from an inline `<system-reminder>` inside the tool result to a `<tool-call-advisory>` wrapper — they stay visible without claiming an authority that the tool-result channel cannot carry.

Two guards keep the surface honest. A prompt test asserts the reminder wrapper is constructed in exactly one module, so a second authority channel cannot be added quietly; a profile test asserts every constructed tool is enabled by at least one profile, which is how the three MCP resource tools had shipped constructible but invisible — they are now listed in the main profile.
