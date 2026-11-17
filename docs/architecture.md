# Architecture

Eight packages, one application. Dependencies point downward only.

```
apps/scream-code            terminal UI (TUI), CLI, commands
   ├── packages/node-sdk     session API; runs the engine in-process behind an RPC pair
   ├── packages/agent-core   engine: agent loop, tools, permissions, prompts, records
   │      ├── packages/ltod       LLM abstraction (providers, streaming, tokens)
   │      ├── packages/jian       execution environment (process, fs, env)
   │      ├── packages/memory     memo store (FTS5 + tags + vectors)
   │      └── packages/knowledge  local knowledge base
   ├── packages/config       platform config, model catalog, i18n
   └── packages/evals        evaluation harness
```

The SDK creates the engine in-process (`ScreamCore`) and talks to it only
through an in-memory RPC pair (`createRPC<CoreAPI, SDKAPI>()`), so callers
depend on the RPC contract rather than on engine internals.

## agent-core

| Area | Path | Role |
|---|---|---|
| Agent loop | `agent/index.ts` | turn lifecycle, tool dispatch, subagents |
| Tools | `tools/builtin/*` (registered in `agent/tool/index.ts`) | 57 built-in tools; some only for the main agent or when a service is configured |
| Permissions | `agent/permission/` | mode policy, rules, egress allowlist |
| Injection | `agent/injection/` | dynamic reminders (goal, permission mode, plan mode, user prefs, wolfpack, todo, working set, MCP guides) |
| Prompts | `profile/` | `default/system.md` template, conditional parts, self-asset map |
| Records | `agent/records/` | `wire.jsonl` persistence and replay |
| Compaction | `agent/compaction/` | summarisation and thresholds |
| Skills | `skill/` | scan, parse, registry |
| MCP | `mcp/` | config, stdio/HTTP clients, OAuth, tool naming |

## Prompt assembly

```
profile/default/system.md (nunjucks)
  ├─ static part   → conditional sections (IS_MAIN, CAN_SPAWN, HAS_WRITE_EDIT, OS)
  └─ dynamic part  → cwd listing, AGENTS.md, skills, self-asset map, role additions
```

The two parts are separated so the static half stays cacheable. Mode changes do
not re-render the prompt; they are announced through the injection layer
instead.

## Event flow

```
user input → TUI controller → Session.prompt()
  → core RPC → agent turn → LLM stream + tool calls
  → records (wire.jsonl) + events
  → Session event emitter → TUI controller → render
```

Permissions are evaluated inside the tool dispatch path, before execution.
Denials return a reason to the model rather than throwing.

## Testing

| Scope | Location |
|---|---|
| Engine, tools, prompts, sessions | `packages/*/test/` |
| TUI controllers, commands, rendering | `apps/scream-code/test/` |
| Cross-package behaviour | root vitest projects |

`pnpm exec vitest run` runs every project; `pnpm run lint:ratchet` enforces a
warning baseline that may only go down.
