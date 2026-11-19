# Plugins — writing plugins for yourself

Scream can write plugins for itself: when a need falls outside both skills and MCP, it produces a code plugin directly.

A plugin contributes four kinds of capability: skills (prompt material), MCP servers, shell hooks, and tool code that runs in-process. Skills take effect as soon as the plugin is registered; MCP servers and hooks start with activation, and **code runs only at `activate`**.

## Quick start

**Ask for consent first**: before writing anything, ask with `AskUserQuestion` ("shall I make a plugin to do this?"). The approval panel does not appear in auto/yolo, so in yolo the question is the only consent step left (the same way `/make-skill` confirms). Auto mode forbids even the question (`AutoModeAskUserQuestionDenyPermissionPolicy`), so a self-made plugin is for interactive use; in unattended settings, `install` explicitly. In bot mode `register_generated` is rejected (bot asks nothing, and the decision is recorded only in the audit log); in ask mode that call still raises one approval (it is not caught by ask mode's read-only interception), and only the write that follows is refused.

The conventional directory is `<scream home>/plugins/generated/<id>/` (`<scream home>` defaults to `~/.scream-code`). A directory anywhere else can be registered too, but no directory is ever scanned automatically — registration must happen explicitly.

Minimal `scream.plugin.json`:

```json
{
  "name": "text-stats",
  "version": "0.1.0",
  "description": "Count lines and characters in a file",
  "entryPoint": "./index.mjs"
}
```

Minimal `index.mjs` entry:

```js
import { readFile } from 'node:fs/promises';

export async function activate(context) {
  context.services.tools.registerUserTool({
    name: 'text_stats',
    description: 'Count lines and characters in a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async (args) => {
      const text = await readFile(String(args.path), 'utf8');
      return { output: `lines=${text.split('\n').length} chars=${text.length}` };
    },
  });
}
```

Enable it in two steps:

1. `ManagePlugin { "action": "register_generated", "source": "<absolute path of the plugin directory>" }` — records the directory and hot-applies its skills, **without importing the entry**.
2. `ManagePlugin { "action": "activate", "id": "text-stats" }` — after a separate approval, imports the entry and runs `activate`; only then are the tools visible to the model.

## Manifest fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Plugin id; must match `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `version` | No | Version string, used for display and checks only |
| `description` | No | One-line description |
| `skills` | No | Skill directories, a string or an array of strings; each item must start with `./` and sit inside the plugin directory |
| `mcpServers` | No | MCP server config objects keyed by server name; registering does not launch the process — they start with `activate` / `enable` |
| `hooks` | No | An array of HookDef entries (`event` / `command` / `matcher` / `timeout`), injected on activation and removed on deactivation |
| `config` | No | Any JSON object, passed to the entry module unchanged as `context.config` |
| `entryPoint` | No | Code entry; must start with `./` and, after realpath, still sit inside the plugin directory. Otherwise the manifest layer drops the field and leaves a diagnostic, and `register_generated` reports `entry_point_rejected` for it instead of silently degrading |

The file `entryPoint` points at must exist: `register_generated` stats the path before recording anything, returns `entry_file_missing` when it is missing, and leaves no half-registered record behind.

## Entry module contract

```js
export async function activate(context) {}

export async function deactivate() {}
```

- It must be ESM. `export default { activate, deactivate }` is accepted too (the runtime normalizes either form through `normalizeExtensionModule`).
- `activate(context)` must be exported; `deactivate()` is optional and takes no arguments — whatever needs cleaning up is captured into module scope inside `activate`.
- When `activate` throws, the hooks and event subscriptions it already set up in this activation are rolled back, the error is written to the plugin record, and `activation_failed` is returned.
- Activation is **per session**: the same plugin can run once in session A and once in session B (their hooks, event subscriptions and tools stay independent), but it cannot be activated twice **within one session**; deactivating it in one session does not affect the other.
- When a session closes, the plugins it activated get an automatic `deactivate`; nothing lingers.

## context API

| Member | Description |
|---|---|
| `pluginId` | Id of the current plugin |
| `config` | The manifest's `config` block; `undefined` when not declared |
| `services.tools.registerUserTool(input)` | Registers an in-process tool, visible to the current agent immediately |
| `services.tools.unregisterUserTool(name)` | Unregisters a tool it registered itself |
| `services.tools.unregisterToolsByOwner(id)` | Unregisters by owner in bulk; the host does this automatically on deactivation too |
| `events.subscribe(type \| '*', handler)` | Subscribes to agent events, returns `unsubscribe`; the host releases them as well on `deactivate` |
| `services` | The agent's subsystem list; call only the tool-related members listed here |
| `ui.notify(level, message)` | Tells the user one line: `info` / `warn` / `error`. Shown as a status-area message, never interrupting |
| `ui.confirm({ title, body?, confirmLabel?, cancelLabel? })` | Asks the user yes/no, returns `Promise<boolean>`; a host with no UI always returns `false` and says why |
| `ui.progress(title)` | Returns `{ update(label), done(message?), fail(message?) }`; text progress, `update` is throttled to about 5 times a second |

Arguments of `registerUserTool`:

| Field | Description |
|---|---|
| `name` | Tool name, globally unique |
| `description` | One-line description for the model |
| `parameters` | JSON Schema object (`type: "object"` plus `properties` / `required`) |
| `execute(args, ctx)` | Returns `{ output, message?, isError? }` or a Promise; `output` is what the model sees, `message` goes to the UI only |

The runtime stamps registrations with `ownerPluginId`, so deactivation, removal and the circuit breaker all reclaim exactly that plugin's tools; an owner the plugin declares itself takes precedence. An error thrown by `execute` becomes a tool error — it does not break the agent loop, but it counts toward the circuit breaker.

## UI interaction (ui)

Three primitives, all of which **degrade instead of throwing**:

| Host | `notify` | `confirm` | `progress` |
|---|---|---|---|
| TUI | one status-area line | a picker; choosing "Confirm" yields `true` | status-area text updated step by step |
| `/line`, SDK, print | the event log | `false` outright plus one warn | status-area text (if the host has one) |

`confirm` goes through the same question channel as `AskUserQuestion`, so a plugin never has to draw its own UI; `notify` reuses the host's warning event (`code: "plugin:<level>"`), which lets the host tell levels apart. **A plugin must not block the session**: every wait resolves, and with no host present the answer is "no".

## Iterating

After changing the entry file, run `/extension reload <id>` (equivalent to `deactivate` + `activate`), or use `ManagePlugin` in the session to `deactivate` and then `activate`.

Mind the difference between two actions: `ManagePlugin {action:"reload"}` only **re-reads the plugin table** and does not import again; to re-import a changed entry file, use `/extension reload <id>` or `ManagePlugin {action:"reload_code", id:"<id>"}`.

Calling `activate` alone does not load new code: modules are cached by entry path, `deactivate` drops that cache and makes the next import use a new specifier, so only a fresh activation reads the new file. A failed activation or a failed import invalidates the cache just the same, which is why "get it wrong → see it fail → get it right → reload" works.

## Known limits

- **A process restart means activating again**: the plugin record stays in the plugin center (visible in `/plugin` and `ManagePlugin list`), but the active state lives only inside the process.
- **Activation is bound to the current session's main agent**: the tools are registered on that one agent. Another session in the same process may show the `●` state but does not get the tool.
- **There are two kinds of circuit breaker, and they recover differently**:
  - **A tool fails 3 times in a row**: a persistent disable (written into the plugin record); `check`'s `circuit` shows the count, and `ManagePlugin { "action": "reset", "id": "<id>" }` clears it and enables the plugin again.
  - **An event handler throws 3 times in a row**: disabled **in the current process only**; the plugin record is unchanged and `check.circuit` does not show it; fix the handler and `activate` again.
- **`reload` re-imports the entry module only**: other files the entry pulls in with `import './lib.mjs'` still come from the process cache, so editing a helper in a multi-file plugin has no effect (move the change into the entry, or restart the process).
- **Every reload leaves one old module instance in the process**: that is the price of "edits take effect immediately", it scales with the number of edits, and it does not affect correctness.
- No directory scanning or automatic discovery: a new plugin must be registered explicitly, with `register_generated` / `install`.

## Full example: text-stats

`scream.plugin.json`:

```json
{
  "name": "text-stats",
  "version": "0.1.0",
  "description": "Count lines and characters in a file",
  "entryPoint": "./index.mjs"
}
```

`index.mjs`:

```js
import { readFile } from 'node:fs/promises';

// Kept in module scope so deactivate() can unregister without a context arg.
let tools;

export async function activate(context) {
  tools = context.services.tools;
  tools.registerUserTool({
    name: 'text_stats',
    description: 'Count lines and characters in a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to count' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const text = await readFile(String(args.path), 'utf8');
      return {
        output: `lines=${text.split('\n').length} chars=${text.length}`,
        message: `counted ${String(args.path)}`,
      };
    },
  });
}

export async function deactivate() {
  // The host reclaims owned tools too; this keeps the plugin self-contained.
  tools?.unregisterUserTool('text_stats');
  tools = undefined;
}
```

Enabling and iterating:

1. `ManagePlugin { "action": "register_generated", "source": "/Users/me/.scream-code/plugins/generated/text-stats" }`
2. `ManagePlugin { "action": "activate", "id": "text-stats" }`
3. after changing the code, `/extension reload text-stats`

## Security boundaries

- The entry can only live inside the plugin directory: the manifest layer enforces a `./` relative path and runs a containment check on the realpath result (see `resolvePluginPathField`). An `entryPoint` that escapes is rejected at the manifest layer, `register_generated` reports `entry_point_rejected`, and it does not degrade into a data-only plugin that "looks registered".
- Registration runs no code: `register_generated` only parses the manifest and records it; `activate` is the single execution point, and it requires an approval of its own.
- The approval identity includes the directory path and the plugin id: the approval string for `register_generated` carries the full source, while `activate` / `deactivate` / `remove` / `enable` / `disable` / `reset` / `rollback` / `set_mcp_enabled` / `reload_code` carry the plugin id (e.g. `ManagePlugin(activate text-stats)`). A session-level grant covers only the object it names; it cannot be moved to another directory or another plugin.
- Once activated, code runs inside the agent process and can reach `context.services`. Activate only plugins you wrote yourself or fully trust.
