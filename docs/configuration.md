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
| `defaultPermissionMode` | `yolo` \| `auto` \| `ask` \| `bot` |
| `defaultThinking` / `thinking` | Thinking mode and effort |
| `planMode` / `defaultPlanMode` | Plan-mode defaults |
| `yolo` | Yolo-mode defaults |
| `permission` | `rules[]` (`decision` allow/deny/ask, `scope`, `pattern`, `reason`) and `egressAllowlist` |
| `hooks` | Shell hooks fired on session events |
| `services` | Search providers (google / duckduckgo / bing / sogou / baidu) |
| `loopControl` | `maxStepsPerTurn`, retry and compaction thresholds, `toolPortal` (see below) |
| `background` | Background task limits |
| `secrets` | Redaction rules (`plain` / `regex`, `obfuscate` / `replace`, optional regex `flags`) |
| `extraSkillDirs` | Additional skill roots |
| `mergeAllAvailableSkills` | Merge every discovered skill instead of the project-scoped set |
| `raw` | Escape hatch for keys the schema does not model |

A fresh session starts in `yolo`. The old `manual` mode no longer exists: a
legacy `defaultPermissionMode = "manual"` (or a stored session still carrying
that value) is accepted and normalized to `yolo`.

`permission.rules[]` with `decision = "ask"` only prompt in `ask` mode, and only
for tools the read-only guard does not deny. In `yolo` / `auto` those rules sit
below the blanket approve policies, so they never fire for Bash or file writes;
config load warns once about such rules instead of rejecting them.

### Provider types

`anthropic`, `openai`, `scream`, `google-genai`, `openai_responses`, `vertexai`.

`baseUrl` is optional: the built-in type supplies the default endpoint, which is
what makes "any OpenAI-compatible endpoint" work.

`api_key` takes a single credential, or a pool:

```toml
[providers.relay]
type = "anthropic"
api_key = ["sk-a", "sk-b"]
```

A pool is key rotation: requests start at a session-affine key, and a
quota-style 429 rotates to the next usable key while the rejected one cools down
(30s). Only the rotation-capable types accept one — `anthropic`, `openai`,
`openai_responses`; every other type takes a single key and rejects an array at
load time. Blank entries are dropped, and an unusable pool falls back to the
provider's `env` entry like an unset key.

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
`forceThinking`, `thinkingLevels`, `tokenizer`.

`tokenizer` selects the measurement used by local token estimates — compaction
watermarks and the context gauge:

```toml
[models.my-model]
tokenizer = "heuristic"     # cl100k (default) | o200k | heuristic
```

`cl100k` and `o200k` count with the matching OpenAI encoding; `heuristic` keeps
the character estimate (ASCII ~4 chars per token, other characters ~1 token).
Encoder counts are near-exact, not exact — Anthropic and Gemini tokenizers are
closed — and every estimate is re-anchored by the provider-reported usage at
each step end, so only local watermarks and the budget display depend on it.

Aliases are what `/model`, `--model`, subagent profiles and goal judging refer
to. Removing a provider orphans every alias that pointed at it — Scream detaches
the model from a live session instead of ending the session when that happens.

### Loop control

`loop_control` holds the per-turn budget, retry and compaction knobs. One switch
changes the tool surface:

```toml
[loop_control]
tool_portal = "off"
```

The deferred-tool portal is on by default: low-frequency built-in groups (cron,
memory, knowledge, goal, image, make-skill, manage-plugin, inspect, debug) are
held behind a single discovery tool so their schemas stay off every request.
`tool_portal = "off"` restores the pre-portal behavior — every enabled tool is
declared up front.

#### Session token limit

```toml
[loop_control]
max_session_tokens = 100000000   # 0 or unset = no limit
```

A circuit breaker for unattended work (`/goal`, `/loop`, cron, wide subagent
fan-out). You normally do not edit it by hand: **`/budget`** sets it
interactively — `/budget` opens a list, `/budget 50m` sets it directly (`500k`,
`20m`, `1.5b`, `500万`, `1亿` all work), `/budget off` removes it. The change
applies to the running session at once (raising the limit un-pauses a stopped
session — no restart) and is saved here as the default for new sessions.

The unit is **tokens**, not money: a dollar limit needs a price from the model
catalog, and custom providers and self-hosted models have none, so it would
count them as free and never trip. A token count exists for every model.

Tokens are counted the way `/usage` shows them — input (cache reads included)
plus output, the same total `/goal` budgets use. Every agent step re-sends the
context, so a busy session moves tens of millions of tokens; the `/budget`
presets (10M – 1B) are sized for that. The count covers the whole session: the
main agent, every subagent (including ones still running), compaction and the
cache warmer. Once it reaches the limit, every turn ends before its next model
request — no wrap-up request either — and the cache warmer stops. The TUI shows
a warning that points at `/budget`, `-p` / stream-json exit non-zero
(stream-json uses exit code 4, like the step budget), an active goal is paused,
and LINE replies with the reason.

- The limit counts what this run of the session has used. Reopening (resume) or
  starting a new session starts a fresh allowance; `/usage` keeps showing the
  lifetime total, and shows this run's use against the limit while one is set.
- Side questions (`/btw`), exit memory extraction, knowledge-base text calls
  and goal grading count too (under the session alias), but they are not
  blocked by the limit — only turns are.
- Setting a limit below what this run already used pauses requests at once;
  `/budget` says so when you do.
- While the limit is tripped, recurring cron / `/loop` jobs skip their fires
  (a skipped fire would only open an empty turn, repeat the warning, and — on
  an IM channel — repeat it in the chat); they run again at the next fire after
  the limit is raised. A one-shot reminder is still delivered.

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

## Optional dependencies

- `debugpy` — the Python debugging tools drive it over DAP; install it into the
  interpreter the session uses (`python3 -m pip install debugpy`). Without it
  the debug tools return that install command instead of a raw spawn error.
- `@ast-grep/napi` — bundled with the CLI and backing the AST search/edit
  tools; a source checkout resolves it through the workspace install.
- `rg` (ripgrep) — backs `Grep`. It is looked up on `PATH`, then in
  `~/.scream-code/bin`; if neither has it, a pinned release is downloaded from
  GitHub once. The download gives up if the server does not answer or the data
  stops for 30 seconds, and a failed attempt is not repeated for two minutes (so
  a blocked network costs one wait, not one per search). Where GitHub is slow or
  unreachable, either install ripgrep with your package manager, put a static
  `rg` in `~/.scream-code/bin`, or set `SCREAM_RG_DOWNLOAD_BASE_URL` to a mirror
  of `https://github.com/BurntSushi/ripgrep/releases/download/15.0.0` (same file
  names). Archives are always checked against pinned SHA-256 digests, so a mirror
  cannot supply different bytes.

## Verifying a configuration

- `/config` — pick a provider, writes and reloads in one step
- `/model` — lists aliases that resolve against a live provider
- `/status`, `/usage` — what the current session is actually using
- `scream --version` — confirms which build is installed
