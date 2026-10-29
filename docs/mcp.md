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
- Connection failures are reported per server and never block startup

## Gotchas

- A server that fails to start does not remove its siblings; only its tools are
  missing.
- Tools disabled with `DiscoverMcpTools` stay out of the request until enabled
  again in the same session.
- `mcp.json` is project-scoped configuration; committing it shares the server
  definition (and any literal secrets) with everyone who checks out the repo.
