import type { ScreamSlashCommand, SlashCommandAvailability } from './types';

export const BUILTIN_SLASH_COMMANDS = [
  // ── 1. auto / 2. yes / 3. wolfpack / 4. sessions / 5. goal ──
  {
    name: 'auto',
    aliases: [],
    description: '切换自动权限模式',
    priority: 125,
    availability: 'always',
  },
  {
    name: 'yes',
    aliases: ['yolo'],
    description: '切换至自动批准模式(yolo)',
    priority: 124,
    availability: 'always',
  },
  {
    name: 'wolfpack',
    aliases: ['wp'],
    description: '切换群狼协作模式，自动批准+批量并发',
    priority: 123,
    availability: 'always',
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: '浏览并恢复会话',
    priority: 122,
  },
  {
    name: 'goal',
    aliases: ['goaloff'],
    description: '查看/管理自动目标',
    priority: 121,
    availability: (args) => {
      const trimmed = args.trim();
      return trimmed === '' || trimmed === 'status' || trimmed === 'pause' || trimmed === 'off'
        ? 'always'
        : 'idle-only';
    },
  },

  // ── 记忆 / 会话 ──
  {
    name: 'memory',
    aliases: ['memo', 'mem'],
    description: '浏览、搜索、注入记忆备忘录',
    priority: 120,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: '在当前工作区开启新会话',
    priority: 120,
  },

  // ── 模型 / 工作流（高频） ──
  {
    name: 'model',
    aliases: [],
    description: '切换 LLM 模型',
    priority: 120,
  },
  {
    name: 'compact',
    aliases: [],
    description: '压缩对话上下文',
    priority: 119,
  },
  {
    name: 'plan',
    aliases: [],
    description: '切换计划模式',
    priority: 118,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: '浏览后台任务',
    priority: 117,
    availability: 'always',
  },

  // ── 帮助 / 信息 ──
  {
    name: 'help',
    aliases: ['h', '?'],
    description: '显示可用命令和快捷键',
    priority: 116,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: '显示当前会话和运行时状态',
    priority: 115,
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: '显示 token 用量和上下文窗口',
    priority: 114,
    availability: 'always',
  },

  // ── 对话 ──
  {
    name: 'btw',
    aliases: [],
    description: '在不中断对话的情况下快速提问',
    priority: 113,
    availability: 'always',
  },

  // ── 集成 ──
  {
    name: 'mcp',
    aliases: [],
    description: '管理 MCP 服务器（安装/停用/卸载）',
    priority: 112,
    availability: 'always',
  },
  {
    name: 'plugin',
    aliases: ['plugins'],
    description: 'ScreamCode 插件中心：浏览、安装、卸载插件',
    priority: 111,
    availability: 'always',
  },
  {
    name: 'cc',
    aliases: [],
    description: '操控你的cc（启动/关闭/重启）',
    priority: 110,
    availability: 'always',
  },
  {
    name: 'cc-connect',
    aliases: [],
    description: 'cc-connect 快速通道配置（需先安装）',
    priority: 109,
    availability: 'always',
  },

  // ── 会话操作 ──
  {
    name: 'revoke',
    aliases: [],
    description: '撤回上一次对话（可指定轮数，如 /revoke 3）',
    priority: 108,
    availability: 'idle-only',
  },
  {
    name: 'fork',
    aliases: [],
    description: '复制当前会话并新开分支',
    priority: 105,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: '设置或显示会话标题',
    priority: 104,
    availability: 'always',
  },

  // ── 配置 ──
  {
    name: 'config',
    aliases: [],
    description: '浏览并配置模型（远程拉取最新目录）',
    priority: 103,
  },
  {
    name: 'permission',
    aliases: [],
    description: '选择权限模式',
    priority: 102,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: '设置终端 UI 主题',
    priority: 101,
    availability: 'always',
  },
  {
    name: 'editor',
    aliases: [],
    description: '设置外部编辑器',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: [],
    description: '打开 TUI 设置',
    priority: 99,
    availability: 'always',
  },

  // ── 项目 / 导出 ──
  {
    name: 'init',
    aliases: [],
    description: '分析代码库并生成 AGENTS.md',
    priority: 98,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: '导出当前会话为 Markdown',
    priority: 97,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: '导出当前会话为调试 ZIP 存档',
    priority: 96,
  },

  // ── 系统 ──
  {
    name: 'update',
    aliases: [],
    description: '手动更新 Scream Code 到最新版本',
    priority: 95,
    availability: 'idle-only',
  },
  {
    name: 'version',
    aliases: [],
    description: '显示版本信息',
    priority: 94,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: '删除已配置的模型',
    priority: 93,
  },

  // ── 退出（最后） ──
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: '退出应用',
    priority: 10,
  },
] as const satisfies readonly ScreamSlashCommand[];

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly ScreamSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

export function resolveSlashCommandAvailability(
  command: ScreamSlashCommand,
  args: string,
): SlashCommandAvailability {
  const availability = command.availability ?? 'idle-only';
  return typeof availability === 'function' ? availability(args) : availability;
}

export function sortSlashCommands(commands: readonly ScreamSlashCommand[]): ScreamSlashCommand[] {
  return [...commands].toSorted(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}
