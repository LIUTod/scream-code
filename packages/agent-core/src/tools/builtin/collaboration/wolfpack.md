Use WolfPack to spawn multiple subagents in parallel for batch operations.
This is ideal when processing many independent items (files, checks, searches)
that all use the same subagent type and follow a similar pattern.

Items must be independent - no subagent depends on another's output.
If items depend on each other, use separate Agent calls instead.

Pick `subagent_type` from the generated "Available agent types" list below: every type states its own USE WHEN / NOT FOR, and the same rule holds for a batch (one type for every item).

Example: review source files for OWASP vulnerabilities by setting items to the file
paths, subagent_type to "reviewer", and prompt_template to the review instruction.
All items are processed in parallel.

All spawned subagents share one `subagent_type`, one `prompt_template` and the
same batch-level settings. WolfPack keeps its unlimited-concurrency contract:
every item spawns and runs in parallel with no artificial concurrency cap.

Batch-level `output_schema` / `output_token_hint` / `capability_mode` are
forwarded to every spawned subagent (same semantics as the `Agent` tool):
- `output_schema` — each item result that parses as a JSON object is surfaced
  as a `[structured]` block; non-JSON results are marked `structured: invalid`.
- `capability_mode` — runtime tool isolation (read-only / read-write /
  execute / all) applied to every item; restricted modes strip MCP tools and
  nested Agent / SendSubagentMessage / WolfPack tools.
