# Plugins — 给自己写插件

Scream 可以给自己写插件：遇到技能和 MCP 都覆盖不了的需求时，直接产出一个代码插件。

插件能贡献四类能力：技能（提示词）、MCP server、shell hooks、以及在进程内运行的工具代码。注册后技能立即生效；MCP server 与 hooks 随激活启动，**代码只在 `activate` 时执行**。

## 快速开始

**先征得同意**：动手写之前用 `AskUserQuestion` 问一句（"要不要我做一个插件来完成这个？"）。审批弹窗在 auto/yolo 下不会出现，所以 yolo 里问句是唯一还会出现的同意步骤（与 `/make-skill` 的确认方式一致）。auto 模式连问句也被禁（`AutoModeAskUserQuestionDenyPermissionPolicy`），因此自产插件属于交互模式的用法，无人值守场景请显式 `install`。manual 模式下 `register_generated` 仍会单独弹一次审批。

目录约定 `<scream home>/plugins/generated/<id>/`（`<scream home>` 默认 `~/.scream-code`）。放在别处的目录也能注册，但任何目录都不会被自动扫描——注册必须显式发生。

`scream.plugin.json` 最小内容：

```json
{
  "name": "text-stats",
  "version": "0.1.0",
  "description": "Count lines and characters in a file",
  "entryPoint": "./index.mjs"
}
```

入口 `index.mjs` 最小内容：

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

两步启用：

1. `ManagePlugin { "action": "register_generated", "source": "<插件目录的绝对路径>" }` —— 登记目录、热应用技能，**不 import 入口**。
2. `ManagePlugin { "action": "activate", "id": "text-stats" }` —— 单独审批后 import 入口并执行 `activate`，工具此刻才对模型可见。

## 清单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 插件 id，须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `version` | 否 | 版本字符串，仅用于展示与检查 |
| `description` | 否 | 一句话说明 |
| `skills` | 否 | 技能目录，字符串或字符串数组；每项必须以 `./` 开头且位于插件目录内 |
| `mcpServers` | 否 | MCP server 配置对象，key 为 server 名；注册不会拉起进程，随 `activate` / `enable` 启动 |
| `hooks` | 否 | HookDef 数组（`event` / `command` / `matcher` / `timeout`），激活时注入、停用时移除 |
| `config` | 否 | 任意 JSON 对象，原样作为 `context.config` 交给入口模块 |
| `entryPoint` | 否 | 代码入口；必须 `./` 开头，且 realpath 后仍位于插件目录内。不满足时清单层丢弃该字段并留下诊断，`register_generated` 会据此报 `entry_point_rejected`，不会静默降级 |

`entryPoint` 指向的文件必须存在：`register_generated` 在登记前会 stat 该路径，缺失时返回 `entry_file_missing`，不会留下半登记记录。

## 入口模块契约

```js
export async function activate(context) {}

export async function deactivate() {}
```

- 必须是 ESM。也接受 `export default { activate, deactivate }` 的写法（运行时统一经 `normalizeExtensionModule` 归一化）。
- `activate(context)` 必须导出；`deactivate()` 可选，且不接收参数——需要清理的东西在 `activate` 里捕获到模块作用域。
- `activate` 抛错时，本次激活完成一半的 hooks 与事件订阅会被回滚，错误写入插件记录并返回 `activation_failed`。
- 同一个进程内同一插件不能重复激活；重新激活前先 `deactivate`。

## context API

| 成员 | 说明 |
|---|---|
| `pluginId` | 当前插件 id |
| `config` | 清单 `config` 块；未声明时为 `undefined` |
| `services.tools.registerUserTool(input)` | 注册进程内工具，立即对当前 agent 可见 |
| `services.tools.unregisterUserTool(name)` | 注销自己注册的工具 |
| `services.tools.unregisterToolsByOwner(id)` | 按 owner 批量注销；宿主在停用时也会自动执行 |
| `events.subscribe(type \| '*', handler)` | 订阅 agent 事件，返回 `unsubscribe`；`deactivate` 时宿主也会统一释放 |
| `services` | agent 的子系统清单；只应调用这里列出的工具相关成员 |

`registerUserTool` 的入参：

| 字段 | 说明 |
|---|---|
| `name` | 工具名，全局唯一 |
| `description` | 给模型看的一句话说明 |
| `parameters` | JSON Schema 对象（`type: "object"` 及 `properties` / `required`） |
| `execute(args, ctx)` | 返回 `{ output, message?, isError? }` 或 Promise；`output` 是模型看到的内容，`message` 只给 UI |

运行时会给注册自动打上 `ownerPluginId`，因此停用、移除、熔断都能精确回收该插件的工具；插件自己声明的 owner 优先。`execute` 抛错会被转成工具错误，不会打断 agent loop，但会计入熔断计数。

## 迭代

改完入口文件后执行 `/extension reload <id>`（等价于 `deactivate` + `activate`），或者在会话里用 `ManagePlugin` 先 `deactivate` 再 `activate`。

注意区分两个动作：`ManagePlugin {action:"reload"}` 只是**重读插件表**，不会重新 import；要重新 import 改过的入口文件，用 `/extension reload <id>` 或 `ManagePlugin {action:"reload_code", id:"<id>"}`。

只调用 `activate` 不会加载新代码：模块按入口路径缓存，`deactivate` 会丢掉该缓存并让下一次 import 走新的 specifier，重新激活才读到新文件。激活失败、import 失败同样会让缓存失效，所以「改错 → 报错 → 改对 → reload」是可行的。

## 已知限制

- **重启进程后需要重新激活**：插件记录仍在插件中心（`/plugin`、`ManagePlugin list` 可见），但激活态只存在于进程内。
- **激活绑定当前会话的 main agent**：工具注册在那一个 agent 上。同一进程里的另一个会话可能看到 `●` 状态，但拿不到这个工具。
- **熔断分两种，恢复方式不同**：
  - **工具连续失败 3 次**：持久禁用（写进插件记录），`check` 的 `circuit` 能看到计数，`ManagePlugin { "action": "reset", "id": "<id>" }` 清除并重新启用。
  - **事件 handler 连续抛错 3 次**：只在**当前进程内**停用，不改插件记录，`check.circuit` 也不会显示；修好 handler 后重新 `activate` 即可。
- **`reload` 只重新 import 入口模块**：入口用 `import './lib.mjs'` 引的其它文件仍走进程缓存，多文件插件改完辅助文件不会生效（改放进入口，或重启进程）。
- **每次 reload 都会在进程里留下一份旧模块实例**：这是「改了立刻生效」的代价，量级等于编辑次数，不影响正确性。
- 没有目录扫描或自动发现：新插件必须显式 `register_generated` / `install`。

## 完整示例：text-stats

`scream.plugin.json`：

```json
{
  "name": "text-stats",
  "version": "0.1.0",
  "description": "Count lines and characters in a file",
  "entryPoint": "./index.mjs"
}
```

`index.mjs`：

```js
import { readFile } from 'node:fs/promises';

// Kept in module scope so deactivate() can unregister without a context arg.
let tools;

export async function activate(context) {
  tools = context.services.tools;
  tools.registerUserTool({
    name: 'text_stats',
    description: '统计文件的行数与字符数',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要统计的文件路径' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const text = await readFile(String(args.path), 'utf8');
      return {
        output: `lines=${text.split('\n').length} chars=${text.length}`,
        message: `已统计 ${String(args.path)}`,
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

启用与迭代：

1. `ManagePlugin { "action": "register_generated", "source": "/Users/me/.scream-code/plugins/generated/text-stats" }`
2. `ManagePlugin { "action": "activate", "id": "text-stats" }`
3. 改完代码后 `/extension reload text-stats`

## 安全边界

- 入口只能在插件目录内：清单层强制 `./` 相对路径，并对 realpath 结果做越界检查（见 `resolvePluginPathField`）。越界的 `entryPoint` 会被清单层拒绝，`register_generated` 报 `entry_point_rejected`，不会降级成"看起来注册成功"的纯数据插件。
- 注册不执行代码：`register_generated` 只解析清单、登记记录；`activate` 是唯一的执行点，且单独要求审批。
- 审批身份包含目录路径与插件 id：`register_generated` 的审批串带完整 source，`activate` / `deactivate` / `remove` / `enable` / `disable` / `reset` / `rollback` / `set_mcp_enabled` / `reload_code` 带插件 id（如 `ManagePlugin(activate text-stats)`）。会话级授权只能覆盖同名对象，不能挪用到另一个目录或另一个插件。
- 激活后代码运行在 agent 进程内，可访问 `context.services`。只激活自己写的或完全信任的插件。
