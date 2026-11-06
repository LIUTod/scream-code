---
"scream-code": patch
---

MCP servers that advertise resources are now usable, not just their tools: `ListMcpResources`, `ListMcpResourceTemplates` and `ReadMcpResource` follow the naming and semantics other agents in this space converged on — `server` is optional and means "every connected server", listing returns JSON with each resource tagged by its server plus any `instructions` the server sent during the handshake, and reading reports the MIME type when a resource has no text content. They are read-only and only registered when MCP is configured. The MCP client also gained `listResourceTemplates()` and per-server `instructions`/`listPrompts()`.

Server instructions now reach the model. They cannot live in the static system prompt — MCP connects asynchronously after the prompt is rendered, and rebuilding it later would invalidate the prompt-cache prefix — so the session injects them as one system reminder once the connections settle (a 250 ms window collapses a burst of connects), and only when the text changes. Delivery is retried when the main agent is created, without blocking agent creation on a slow server.
