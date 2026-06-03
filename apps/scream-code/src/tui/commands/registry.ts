import type { ScreamSlashCommand, SlashCommandAvailability } from './types';

export const BUILTIN_SLASH_COMMANDS = [
  // ── 权限模式 ──
  {
    name: 'auto',
    aliases: [],
    description: '切换自动权限模式',
    priority: 110,
    availability: 'always',
  },
  {
    name: 'yes',
    aliases: ['yolo'],
    description: '切换至自动批准模式(yolo)',
    priority: 105,
    availability: 'always',
  },
  {
    name: 'fanout',
    aliases: ['parallel'],
    description: '切换为 Agent 优先并行模式',
    priority: 106,
    availability: 'always',
  },

  // ── 会话管理 ──
  {
    name: 'sessions',
    aliases: ['resume'],
    description: '浏览并恢复会话',
    priority: 104,
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: '在当前工作区开启新会话',
    priority: 103,
  },
  {
    name: 'fork',
    aliases: [],
    description: '复制当前会话并新开分支',
    priority: 98,
  },

  // ── 记忆备忘录 ──
  {
    name: 'memory',
    aliases: ['memo', 'mem'],
    description: '浏览、搜索、注入记忆备忘录',
    priority: 102,
    availability: 'always',
  },

  // ── 核心功能 ──
  {
    name: 'compact',
    aliases: [],
    description: '压缩对话上下文',
    priority: 101,
  },
  {
    name: 'plan',
    aliases: [],
    description: '切换计划模式',
    priority: 100,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'model',
    aliases: [],
    description: '切换 LLM 模型',
    priority: 99,
  },
  {
    name: 'goal',
    aliases: [],
    description: '设置或查看自动工作目标',
    priority: 97,
    availability: 'always',
  },
  {
    name: 'goaloff',
    aliases: [],
    description: '关闭并清空当前目标',
    priority: 96,
    availability: 'always',
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: '浏览后台任务',
    priority: 95,
    availability: 'always',
  },

  // ── 信息查看 ──
  {
    name: 'help',
    aliases: ['h', '?'],
    description: '显示可用命令和快捷键',
    priority: 90,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: '显示当前会话和运行时状态',
    priority: 89,
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: '显示 token 用量和上下文窗口',
    priority: 88,
    availability: 'always',
  },

  // ── 配置与工具 ──
  {
    name: 'init',
    aliases: [],
    description: '分析代码库并生成 AGENTS.md',
    priority: 85,
  },
  {
    name: 'permission',
    aliases: [],
    description: '选择权限模式',
    priority: 84,
    availability: 'always',
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: '设置或显示会话标题',
    priority: 83,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: '设置终端 UI 主题',
    priority: 82,
    availability: 'always',
  },
  {
    name: 'editor',
    aliases: [],
    description: '设置外部编辑器',
    priority: 81,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    description: '显示 MCP 服务器状态',
    priority: 80,
    availability: 'always',
  },

  // ── 导出 ──
  {
    name: 'export-md',
    aliases: ['export'],
    description: '导出当前会话为 Markdown',
    priority: 70,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: '导出当前会话为调试 ZIP 存档',
    priority: 40,
  },

  // ── 高级设置 ──
  {
    name: 'settings',
    aliases: [],
    description: '打开 TUI 设置',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'config',
    aliases: [],
    description: '浏览并配置模型（远程拉取最新目录）',
    priority: 59,
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: '删除已配置的模型',
    priority: 58,
  },

  // ── 系统 ──
  {
    name: 'version',
    aliases: [],
    description: '显示版本信息',
    priority: 30,
    availability: 'always',
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: '退出应用',
    priority: 10,
  },

  // ── cc-connect 通道配置 ──
  {
    name: 'cc-connect',
    aliases: [],
    description: 'cc-connect 快速通道配置（需先安装）',
    priority: 29,
    availability: 'always',
  },

  // ── 插件中心 ──
  {
    name: 'plugin',
    aliases: ['plugins'],
    description: 'ScreamCode 插件中心：浏览、安装、卸载插件',
    priority: 28,
    availability: 'always',
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
