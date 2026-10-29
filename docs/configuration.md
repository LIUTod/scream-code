# Configuration

Everything persistent lives under the Scream home directory: `~/.scream-code`
(override with `SCREAM_CODE_HOME`).

```
~/.scream-code/
├── config.toml          # providers, models, permissions, hooks, services
├── mcp.json             # MCP servers (user level)
├── image-config.json    # image-generation endpoint
├── skills/              # user skills
├── memory/              # memo store
├── knowledge/           # knowledge base
└── sessions/            # transcripts, bucketed by working directory
```

A project can add its own layer with `.scream-code/` in the repository root
(`mcp.json`, `skills/`, `AGENTS.md`).

## config.toml

Parsed by `packages/agent-core/src/config/schema.ts`.

| Section | Purpose |
|---|---|
| `providers` | Named endpoints: `type`, `apiKey`, `baseUrl`, `defaultModel`, `oauth`, `env`, `customHeaders`, `sessionHeader` |
| `models` | Model aliases (see below) |
| `defaultProvider` / `defaultModel` | What a new session uses |
| `defaultPermissionMode` | `yolo` \| `manual` \| `auto` \| `ask` \| `bot` |
| `defaultThinking` / `thinking` | Thinking mode and effort |
| `planMode` / `defaultPlanMode` | Plan-mode defaults |
| `yolo` | Yolo-mode defaults |
| `permission` | `rules[]` (`decision` allow/deny/ask, `scope`, `pattern`, `reason`) and `egressAllowlist` |
| `hooks` | Shell hooks fired on session events |
| `services` | Search providers (google / duckduckgo / bing / sogou / baidu) |
| `loopControl` | `maxStepsPerTurn`, retry and compaction thresholds |
| `background` | Background task limits |
| `secrets` | Redaction rules (`plain` / `regex`, `obfuscate` / `replace`, optional regex `flags`) |
| `extraSkillDirs` | Additional skill roots |
| `mergeAllAvailableSkills` | Merge every discovered skill instead of the project-scoped set |
| `raw` | Escape hatch for keys the schema does not model |

### Provider types

`anthropic`, `openai`, `scream`, `google-genai`, `openai_responses`, `vertexai`.

`baseUrl` is optional: the built-in type supplies the default endpoint, which is
what makes "any OpenAI-compatible endpoint" work.

### Model aliases

A model is an alias, never a raw provider model string:

```toml
[models.my-model]
provider = "my-provider"      # must match a key under [providers]
model = "vendor-model-id"     # what the provider expects on the wire
maxContextSize = 200000
maxOutputSize = 16000
```

Optional: `capabilities`, `displayName`, `reasoningKey`, `adaptiveThinking`,
`forceThinking`, `thinkingLevels`.

Aliases are what `/model`, `--model`, subagent profiles and goal judging refer
to. Removing a provider orphans every alias that pointed at it — Scream detaches
the model from a live session instead of ending the session when that happens.

## Image generation

`~/.scream-code/image-config.json`, written by `/config image`:

```json
{ "provider": "...", "url": "https://.../images/generations", "api_key": "...", "model": "..." }
```

`url` is the full endpoint, not a base URL. Placeholder values (empty,
`replace-with*`, `<...>`) count as unconfigured. The `image` skill and `/image`
read it through the `ImageGenerate` tool.

## Resolution order

1. CLI flag (`--model`, `--yolo`, `--auto`, `--plan`, `--permission-mode bot`)
2. `config.toml` defaults
3. Built-in defaults

`/config` writes `config.toml`; `/logout` removes a provider and clears any alias
that pointed at it.

## Verifying a configuration

- `/config` — pick a provider, writes and reloads in one step
- `/model` — lists aliases that resolve against a live provider
- `/status`, `/usage` — what the current session is actually using
- `scream --version` — confirms which build is installed
