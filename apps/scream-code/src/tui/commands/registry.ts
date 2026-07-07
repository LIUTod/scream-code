import type { ScreamSlashCommand, SlashCommandAvailability } from './types';

// description fields store i18n keys (resolved at display time via t()).
export const BUILTIN_SLASH_COMMANDS = [
  // ── 1. auto / 2. yes / 3. wolfpack / 4. sessions / 5. goal ──
  {
    name: 'auto',
    aliases: [],
    description: 'registry.auto_desc',
    priority: 125,
    availability: 'always',
  },
  {
    name: 'yes',
    aliases: ['yolo'],
    description: 'registry.yolo_desc',
    priority: 124,
    availability: 'always',
  },
  {
    name: 'wolfpack',
    aliases: ['wp'],
    description: 'registry.wolfpack_desc',
    priority: 123,
    availability: 'always',
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'registry.sessions_desc',
    priority: 122,
  },
  {
    name: 'goal',
    aliases: ['goaloff'],
    description: 'registry.goal_desc',
    priority: 122,
    availability: (args) => {
      const trimmed = args.trim();
      return trimmed === '' || trimmed === 'status' || trimmed === 'pause' || trimmed === 'off'
        ? 'always'
        : 'idle-only';
    },
  },
  {
    name: 'loop',
    aliases: [],
    description: 'registry.loop_desc',
    priority: 121,
    availability: 'always',
  },

  // ── 记忆 / 会话 ──
  {
    name: 'memory',
    aliases: ['memo', 'mem'],
    description: 'registry.memory_desc',
    priority: 120,
    availability: 'always',
  },
  {
    name: 'knowledge',
    aliases: ['know'],
    description: 'registry.knowledge_desc',
    priority: 119,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'registry.new_desc',
    priority: 120,
  },

  // ── 模型 / 工作流（高频） ──
  {
    name: 'model',
    aliases: [],
    description: 'registry.model_desc',
    priority: 120,
  },
  {
    name: 'compact',
    aliases: [],
    description: 'registry.compact_desc',
    priority: 119,
  },
  {
    name: 'make-skill',
    aliases: ['makeskill', 'craftskill'],
    description: 'registry.make_skill_desc',
    priority: 118,
    availability: 'idle-only',
  },
  {
    name: 'plan',
    aliases: [],
    description: 'registry.plan_desc',
    priority: 118,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'fusionplan',
    aliases: ['fp'],
    description: 'registry.fusionplan_desc',
    priority: 118,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: 'registry.tasks_desc',
    priority: 117,
    availability: 'always',
  },

  // ── 帮助 / 信息 ──
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'registry.help_desc',
    priority: 116,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: 'registry.status_desc',
    priority: 115,
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: 'registry.usage_desc',
    priority: 114,
    availability: 'always',
  },

  // ── 对话 ──
  {
    name: 'btw',
    aliases: [],
    description: 'registry.btw_desc',
    priority: 113,
    availability: 'always',
  },
  {
    name: 'like',
    aliases: [],
    description: 'registry.like_desc',
    priority: 113,
    availability: 'always',
  },

  // ── 集成 ──
  {
    name: 'mcp',
    aliases: [],
    description: 'registry.mcp_desc',
    priority: 112,
    availability: 'always',
  },
  {
    name: 'skill',
    aliases: ['skills', 'plugin', 'plugins'],
    description: 'registry.skill_desc',
    priority: 110,
    availability: 'always',
  },
  {
    name: 'cc',
    aliases: [],
    description: 'registry.cc_desc',
    priority: 109,
    availability: 'always',
  },
  {
    name: 'cc-connect',
    aliases: [],
    description: 'registry.cc_connect_desc',
    priority: 109,
    availability: 'always',
  },

  // ── 会话操作 ──
  {
    name: 'revoke',
    aliases: [],
    description: 'registry.revoke_desc',
    priority: 108,
    availability: 'idle-only',
  },
  {
    name: 'fork',
    aliases: [],
    description: 'registry.fork_desc',
    priority: 105,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: 'registry.title_desc',
    priority: 104,
    availability: 'always',
  },

  // ── 配置 ──
  {
    name: 'config',
    aliases: [],
    description: 'registry.config_desc',
    priority: 103,
  },
  {
    name: 'permission',
    aliases: [],
    description: 'registry.permission_desc',
    priority: 102,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: 'registry.theme_desc',
    priority: 101,
    availability: 'always',
  },
  {
    name: 'language',
    aliases: ['lang'],
    description: 'registry.language_desc',
    priority: 102,
    availability: 'always',
  },
  {
    name: 'editor',
    aliases: [],
    description: 'registry.editor_desc',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: [],
    description: 'registry.settings_desc',
    priority: 99,
    availability: 'always',
  },

  // ── 项目 / 导出 ──
  {
    name: 'init',
    aliases: [],
    description: 'registry.init_desc',
    priority: 98,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: 'registry.export_md_desc',
    priority: 97,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: 'registry.export_debug_desc',
    priority: 96,
  },

  // ── 系统 ──
  {
    name: 'update',
    aliases: [],
    description: 'registry.update_desc',
    priority: 95,
    availability: 'idle-only',
  },
  {
    name: 'version',
    aliases: [],
    description: 'registry.version_desc',
    priority: 94,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: 'registry.logout_desc',
    priority: 93,
  },

  // ── 退出（最后） ──
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'registry.exit_desc',
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
