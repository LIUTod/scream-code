import type { ScreamSlashCommand, SlashCommandAvailability } from './types';

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: 'yolo',
    aliases: ['yes'],
    description: '切换自动批准模式',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'auto',
    aliases: [],
    description: '切换自动权限模式',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: '选择权限模式',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: [],
    description: '打开 TUI 设置',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'goal',
    aliases: [],
    description: '查看自动工作目标，/goal+空格+输入 可设置目标',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'goaloff',
    aliases: [],
    description: '关闭并清空当前目标',
    priority: 100,
    availability: 'always',
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
    priority: 100,
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: '显示可用命令和快捷键',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: '在当前工作区开启新会话',
    priority: 80,
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: '浏览并恢复会话',
    priority: 80,
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: '浏览后台任务',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    description: '显示 MCP 服务器状态',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'compact',
    aliases: [],
    description: '压缩对话上下文',
    priority: 80,
  },
  {
    name: 'init',
    aliases: [],
    description: '分析代码库并生成 AGENTS.md',
  },
  {
    name: 'fork',
    aliases: [],
    description: '复制当前会话并新开分支',
    priority: 80,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: '设置或显示会话标题',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: '显示会话 token + 上下文窗口 + 计划配额',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: '显示当前会话和运行时状态',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'editor',
    aliases: [],
    description: '设置 Ctrl-G 的外部编辑器',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: '设置终端 UI 主题',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: '删除已配置模型商',
    priority: 40,
  },
  {
    name: 'config',
    aliases: [],
    description: '自定义模型配置',
    priority: 40,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: '将当前会话导出为 Markdown 文件',
    priority: 40,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: '将当前会话导出为调试 ZIP 存档',
    priority: 40,
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: '退出应用',
    priority: 20,
  },
  {
    name: 'version',
    aliases: [],
    description: '显示版本信息',
    priority: 20,
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
