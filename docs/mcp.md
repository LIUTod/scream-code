# MCP Servers

Model Context Protocol servers extend the tool set with external processes or
HTTP endpoints. They are opt-in per session and configured in files, not flags.

## Configuration files

```
~/.scream-code/mcp.json              # user level
<project>/.scream-code/mcp.json      # project level
<parent>/.scream-code/mcp.json       # walked up from cwd, root → shallow
```

On a name collision the file **nearest the working directory** wins: the project
file beats any parent, and a nearer parent beats a shallower one. Discovery
logic: `packages/agent-core/src/mcp/config-loader.ts`.

## Shape

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "TOKEN": "..." }
    },
    "remote": {
      "url": "https://example.test/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

- `command` + `args` → stdio transport (`client-stdio.ts`)
- `url` → HTTP transport (`client-http.ts`)
- OAuth flows live under `packages/agent-core/src/mcp/oauth/`.

## How tools surface

MCP tool schemas are **not** in the request by default. The agent must call
`DiscoverMcpTools` first:

```
DiscoverMcpTools({})                    # server overview
DiscoverMcpTools({ server: "linear" })  # one server's tools
DiscoverMcpTools({ tools: ["mcp__linear__create_issue"] })  # enable for this session
```

Enabled tools appear from the next step on, named
`mcp__<server>__<tool>` (`mcp/tool-naming.ts`). `list`/`info`-style reads are
free; mutating MCP tools go through the normal permission policy.

## Managing from the TUI

- `/mcp` — list servers and their connection state
- A connected row shows the server's **own reported version** (`v1.13.0`) next to
  the tool count. `chrome-devtools-mcp@latest` only says what was asked for; the
  handshake is what tells you what resolved.
- Connection failures are reported per server and never block startup

## Built-in recommendations

`/mcp` offers two servers you can install with Enter: **Chrome DevTools**
(`npx chrome-devtools-mcp@latest`) and **ScreamLife** (decision memory). The
entry written to `~/.scream-code/mcp.json` is a normal entry — you can edit it by
hand afterwards; the panel only reads it back to detect drift.

The Chrome DevTools launch args are chosen, not arbitrary:

| Flag | Why |
|---|---|
| `--no-usage-statistics`, `--no-performance-crux` | no telemetry; trace URLs never leave the machine |
| `--redact-network-headers` | response/request headers are redacted before the model sees them |
| `--no-file-navigations` | `file:` navigation + `take_snapshot` would bypass the workspace boundary |
| `--screenshot-format=jpeg --screenshot-quality=85 --screenshot-max-width=1600` | keeps screenshots from dominating the context |
| `--category-network-mocks` | `mock_network` / `remove_network_mock` — testing error and empty states |
| `--memory-debugging` | heap-analysis tools; `take_heapsnapshot` alone returns an unreadable blob |

Tool schemas never enter the request (see above), so a wider tool surface costs
nothing per turn.

### Authentication (`a`)

An HTTP server that answers 401 (and has no `bearerTokenEnvVar` / `headers`
configured) lands in **needs-auth**. Press `a` on that row: scream-code runs the
OAuth discovery (RFC 9728 / RFC 8414 / RFC 7591), opens the authorization page in
your browser, and reconnects by itself once the callback lands. The flow keeps
running in the background for up to 15 minutes — the panel stays usable and only
reports where to look.

The agent has the same capability through a synthetic
`mcp__<server>__authenticate` tool, so this works whether you start it or it does.

stdio servers cannot use this path: they authenticate through their own command
or env. If a server uses a static bearer token, set `bearerTokenEnvVar` in
`mcp.json` and scream-code will report the missing variable when it is unset.

### Launch options (`o`)

On an installed Chrome DevTools row, `o` opens the launch-option menu: headless,
isolated profile, fixed viewport, Chrome channel and "connect to a running
Chrome". The values are written as launch args into `mcp.json` — nothing is
stored anywhere else — and only 「Save and restart」 writes, because each saved
change relaunches Chrome. Esc discards.

`auto-connect` drives a Chrome you started yourself (144+, remote debugging on
from `chrome://inspect`); the server then does not launch the browser, so headless
and isolated are refused rather than saved as inert switches.

### Upstream skills

The `chrome-devtools-mcp` package ships seven official Agent-Skills (a11y,
cookie and memory-leak debugging, LCP optimization, troubleshooting, CLI, and the
general Chrome DevTools playbook). The same submenu installs them into
`~/.scream-code/skills/` (the `skills/` folder of your Scream home) and keeps a manifest of what it put there, so removal and
updates only ever touch its own directories — a same-named skill of yours is
skipped, never overwritten. Skills load when a session starts, so restart
(`/new`) after installing.

### Updating an existing install

Recommendations change; an entry keeps the args it was installed with. When the
panel sees the installed entry missing recommended flags, the recommendation row
reads **"N recommended flags missing — Enter to update"**. Enter asks for
confirmation (custom args and `env` are replaced), rewrites the entry and
reconnects the server, so the new flags apply immediately in that session.

Entries declared by a project `.scream-code/mcp.json` or provided by a plugin are
refused — rewriting them would be undone on the next start. Update those at the
source.

## Gotchas

- A server that fails to start does not remove its siblings; only its tools are
  missing.
- Tools disabled with `DiscoverMcpTools` stay out of the request until enabled
  again in the same session.
- `mcp.json` is project-scoped configuration; committing it shares the server
  definition (and any literal secrets) with everyone who checks out the repo.
