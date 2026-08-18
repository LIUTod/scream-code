# tool — Tool Registry & Runtime

## Responsibility
- Maintain the tool registry (built-in + user + MCP); `loopTools` produces the
  sorted tool schemas sent to the LLM
- **Registration entry points (third-party extensions use these)**:
  - `registerUserTool(definition)` — user/plugin tools
  - `registerMcpServer(...)` — MCP server integration
  - built-in tools live in `tools/builtin/` and register after definition
- Tool dispatch: execute tool calls (`runTool`), write results back to context
- Argument validation: tool definitions carry schemas, validated on call

## Dependencies
- Depends on: `Agent` (hub), MCP clients, BlobStore (large output offload)
- Depended on by: `AgentServices.tools`, `LtodLLM` (reads loopTools),
  plugin/skill loading

## Boundaries
- Does NOT: implement tool logic (that is each tool module / plugin's job)
- `loopTools` determinism: sorted via `.toSorted()` — do NOT break it
  (provider prefix cache depends on byte-stable schemas)
- Registration is idempotent: duplicate names need explicit handling (user tool
  overriding built-in? see call-site conventions)
- MCP tools come and go with their server's lifecycle

## Extension points
- New tool = call `registerUserTool` (no core changes); a future harness
  adapter also exposes tools through these two entry points
- New tool capability class (fs/lsp/web...) = new builtin module + registration
