Use WolfPack to spawn multiple subagents in parallel for a batch of independent items (files, checks, searches) that share one `subagent_type` and one `prompt_template`. Items must not depend on each other's output — if they do, use separate `Agent` calls. There is no artificial concurrency cap: every item spawns and runs in parallel.

Pick `subagent_type` from the "Available agent types" list below; each type states its own USE WHEN / NOT FOR, and the same rule holds for a batch (one type for every item).

Batch-level `output_schema` / `output_token_hint` / `capability_mode` are forwarded to every spawned subagent with the same semantics as the `Agent` tool.
