# Self-Evolution End-to-End Manual Test

How to verify the agent-side plugin lifecycle (create → discover → install →
hot-apply → circuit breaker) in a real session. Run these from `screambeta`
(source-run TUI). Always rebuild first — workspace packages resolve to `dist`:

```bash
cd <repo> && pnpm -C packages/agent-core build
```

Prerequisites: any model; approve prompts when they appear (mutating
ManagePlugin actions require approval by design; read-only actions do not).

## Scenario 1 — Self-made skill, live the same turn

1. Ask: *"Make me a skill called weekly-report that turns my bullet points
   into a Monday-status markdown, then use it."*
2. Expected chain: agent calls `MakeSkillPlan` → `MakeSkillApply` (both
   auto-approved; output now ends "…right away — it was hot-applied to this
   session").
3. Ask: *"Show your installed plugins."* → agent calls `ManagePlugin`
   `{action:"list"}` — no approval prompt — and the new `generated-*` plugin
   appears with `state: ok`.
4. Use the skill (`/weekly-report …`) in the SAME session — it must be
   invokable without restart.

## Scenario 2 — Install from the marketplace

1. Ask: *"Is there a plugin in the marketplace that helps with mermaid
   diagrams? Install it if so."*
2. Expected: `ManagePlugin {action:"marketplace", query:"mermaid"}` (read-only,
   no prompt) → if an entry exists, `install` with an approval dialog that
   shows the FULL source string; install result reports
   `codeExecuted:false` and a `sync` block (`skills.inject` may appear;
   `mcp.add` must NOT at install time).
3. Ask it to actually use the capability → agent requests `activate`
   (separate approval) → after that, `sync` shows `mcp.add` for plugin servers
   and its tools/skills are usable in the same session.

## Scenario 3 — Install from an arbitrary repository

1. Ask: *"Install the plugin available at <local-path-or-github-url>."*
2. Expected: approval shows the exact source; afterwards `check` lists it;
   behavior identical to Scenario 2 steps 2-3. GitHub sources only run code
   after the explicit `activate` approval.

## Scenario 4 — Circuit breaker (the loop must survive everything)

Prepare a guaranteed-broken plugin under `/tmp`:

```bash
mkdir -p /tmp/breakme/skills/broken
printf '{\n "name": "breakme",\n "version": "1.0.0",\n "entryPoint": "index.js"\n}\n' > /tmp/breakme/scream.plugin.json
printf 'module.exports = { activate(ctx){ ctx.services.tools.registerUserTool({ name:"always_burst", description:"x", parameters:{}, execute: async()=>{ throw new Error("kaput"); } }); }, deactivate(){} };\n' > /tmp/breakme/index.js
printf -- '---\nname: broken\ndescription: d\n---\nbody\n' > /tmp/breakme/skills/broken/SKILL.md
```

1. Ask: *"Install /tmp/breakme, activate it, and call always_burst five
   times."* Approve each prompt.
2. Expected on the 3rd failing call: the tool result carries a
   `[circuit]` advisory; the plugin flips to disabled (`list` shows
   `enabled:false`; `check` shows diagnostics containing "circuit tripped");
   its tool disappears from the loop; **the session keeps responding
   normally** — no crash, no wedged turn.
3. Ask: *"Reset breakme."* → approval → `reset` clears the ledger and
   re-enables; code is NOT running (needs a fresh approved `activate`); the
   breaker re-arms for any future failure streak.
4. Ask: *"Remove breakme."* → `remove` → skills, tools, and any MCP entries
   vanish from the live session the same turn.

## Scenario 5 — No collateral damage

1. Have at least one user-configured MCP server connected
   (`config.toml [mcp_servers]`).
2. Run Scenario 4 with the user servers connected.
3. Expected: user MCP servers are never stopped/removed — the hot-apply pass
   only touches plugin-owned runtime names shaped `plugin-<id>:<server>`.

## What "pass" means

- Scenarios 1-3: capability usable **in the same session**, no restart.
- Scenario 4: three failures trip exactly one teardown; every failing result
  stays a normal tool error; the conversation survives all of it.
- Scenario 5: zero user-configured MCP churn.

Automated equivalents: `test/agent/circuit-breaker.test.ts`,
`test/plugin/apply-changes.test.ts`, `test/agent/tool-user-ownership.test.ts`,
`test/tools/builtin/manage-plugin.test.ts`, `test/plugin/runtime.test.ts`.
