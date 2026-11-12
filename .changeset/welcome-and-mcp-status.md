---
"scream-code": patch
---

Redesign the welcome panel and move MCP server status to the status row

The welcome panel is now borderless: the two-row mascot sits on top and sends
short light pulses above the SCREAM wordmark, with one colour step per impact,
and the rays vanish as soon as the breathing timer stops. MCP server connect
notices move from permanent transcript rows to a transient chip on the status
row above the editor (own slot, 3 s TTL, newest wins); failed and needs-auth
servers keep their transcript message so actionable diagnostics never vanish.
