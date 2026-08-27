Manage this product's own plugins. Plugins are the vehicle for add-on capabilities: each one can contribute skills, MCP servers, shell hooks, and — only after an explicit activate — code that runs in this process.

Use this tool in two situations: (a) a task needs a capability you do not currently have — exhaust your existing tools first and add a plugin only when the gap is real; (b) the user asks you to find, install, configure, inspect, or clean up a capability (e.g. "install something that can render mermaid", "what plugins do you have"). In both cases, remove or disable additions again when the work is done unless the capability is broadly reusable.

Choose the lightest vehicle that solves the problem, in this order: a skill (prompt instructions — safest, no code, no process), an MCP server (an external process), a code plugin (runs in this process — the most powerful, needs its own approved `activate`).

## Workflow

1. `{"action":"list"}` — see what is already installed before adding anything. Do not grow a second plugin that duplicates an existing capability; enable, disable, or extend the one you already have.
2. `{"action":"marketplace","query":"pdf"}` — browse the catalog for a matching capability. Pass `source` to read a different catalog. `tier` is a display label only; judge an entry by its description and source. Entries whose origin previously produced a tripped plugin carry `quarantined: true`.
3. `{"action":"precheck","source":"https://github.com/owner/repo"}` — free read-only origin check before installing anything external that you have not vetted in this session: it reports past incidents recorded by the plugin center's immune memory (`quarantined:true` + the reason). Surface such a warning to the user BEFORE asking for the install approval.
4. If nothing in the catalog fits and precheck is clean, you may search the web (`WebSearch` / `FetchURL`) and evaluate a repository yourself: read its README and manifest, prefer a pinned branch/tag/commit URL over a moving default, and check that it does something you cannot already do.
5. To **make a capability yourself**: if the user invoked `/make-skill`, use the `MakeSkillPlan` → `MakeSkillApply` pair (it produces a valid skill package and registers it into this table automatically). Otherwise build a plugin directory by hand (a `scream.plugin.json` manifest plus your SKILL.md under `skills/`) and register it with `register_generated` — that route lands in this table, hot-applies the same turn, and stays manageable here (disable/remove/circuit). Writing a plain SKILL.md into the user skills directory is also a legitimate skill, but it does NOT appear in this table and cannot be managed with this tool.
6. `{"action":"install","source":"https://github.com/owner/repo/tree/v1.2.0"}` — install from a local path, a GitHub URL, or a zip URL. **Installing never executes code.** The plugin's files are copied and its record is registered; a manifest `entryPoint` stays dormant until step 8.
7. `{"action":"install","source":"...","upgrade":true}` — same-name refresh: backs up the current files (single slot under `plugins/backups/<id>/`), swaps in the new ones, and reloads; `from`/`to` versions and any downgrade warning are reported. If activation then fails, `rollback` restores the previous files in one approved step.
8. `{"action":"enable","id":"..."}` / `{"action":"disable","id":"..."}` / `{"action":"set_mcp_enabled","id":"...","server":"...","enabled":false}` — turn contributed capabilities on and off.
9. `{"action":"activate","id":"..."}` — the only action that runs a plugin's code entry point in this process. Skip it for skill-only and MCP-only plugins; they need no activation.
10. `{"action":"info","id":"..."}` / `{"action":"check"}` — inspect one record in full, or the health of the table. Each entry also carries `usage: {calls, okCalls, okRate, lastUsedAt}` from this machine: zero calls since install marks it as a cleanup candidate; high usage with a high okRate is worth keeping when you must choose.
11. `{"action":"reset","id":"..."}` — recover a circuit-tripped or manually disabled plugin: clears its failure ledger, re-derives the record from disk, enables it, and hot-applies its capabilities. It never runs code — a code plugin still needs its own approved `activate`.
12. `{"action":"rollback","id":"..."}` — restore the pre-upgrade backup taken by step 7 in one approved step.
13. `{"action":"reload"}` — re-read the plugin table from disk and get an added/removed/error summary.
14. `{"action":"remove","id":"..."}` (or `disable` to keep the record) — retreat once the capability is no longer wanted.

## Circuit breaker (limbs that fail get pulled, the loop never dies)

Plugin-owned capabilities are counted per plugin: every failed tool call (in-process plugin tools and plugin MCP servers) and every faulty event handler. A success clears the streak; three consecutive failures trip the breaker, and the failing result arrives with a `[circuit]` advisory: the plugin was marked with the reason, disabled persistently, its code deactivated, and its tools, MCP servers, skills, and hooks pulled from every live session. Nothing retries automatically — read the state with `check` (each plugin carries `circuit: {failures, tripped}`), then `reset` to give it another chance or `remove` to let it go. User-configured MCP servers and built-in tools are never charged to anyone's breaker.

Every trip ALSO writes the origin into the plugin center's immune memory (quarantine ledger): future `precheck`/`install`/`marketplace` calls for the same repository will surface that history before anything is executed again, even across sessions — and even if the broken plugin was removed afterwards.

Changes are hot-applied to the running session wherever the host supports it: mutating results carry a `sync` report (`{ok, applied[], failed[]}`) naming exactly what landed — `skills.inject`, `mcp.add`/`mcp.remove`, tool teardown. An `install` deliberately reports no `mcp.add`: installing never starts a plugin's MCP process; that waits for an approved `enable`/`activate`/`reload`. Treat `sync.failed` as advisory (the mutation itself already succeeded) and re-check with `info`/`check` rather than re-running the mutation. Reload before judging whether a change landed.

## Registration of your own output

`{"action":"register_generated","source":"/abs/path/to/generated/plugin"}` registers a plugin directory you produced locally, without a copy step. It refuses any manifest that declares an `entryPoint`: this action is normally auto-approved and must never become a route to running code. For a code plugin, use `install` and then `activate`.

## Approval contract

- Read-only actions (`list`, `info`, `check`, `marketplace`) run without prompting.
- Every mutating action (`install`, `register_generated`, `enable`, `disable`, `set_mcp_enabled`, `activate`, `deactivate`, `remove`, `reset`, `reload`) requires the user's approval. State what you are about to do and why in one line, then call the tool — never describe a plugin change you have not made.
- The approval prompt for `install` and `register_generated` shows the full source string, and a session grant applies to that exact source only.
- `activate` is the step that executes third-party code; treat it as its own decision, made after you have read what the plugin does.
- A rejected approval is an answer, not a retry cue. Report the refusal and continue without the capability.

## Output

Every action returns a JSON string. Success is a compact result object; failure is
`{"error":{"code","message","next"}}` with `isError: true`. Follow `next` rather than
guessing at a repair — it names the call that resolves the problem.
