import type { ScreamSlashCommand, SlashCommandAvailability } from './types';

// description fields store i18n keys (resolved at display time via t()).
// `priority` defines the display order: higher sorts first. The sequence
// below is the user-curated order (most-used modes first), followed by
// remaining commands grouped by function/usage frequency.
export const BUILTIN_SLASH_COMMANDS = [
  // ── 用户指定顺序（1-22） ──
  {
    name: 'auto',
    aliases: [],
    description: 'registry.auto_desc',
    priority: 220,
    availability: 'always',
  },
  {
    name: 'yes',
    aliases: ['yolo'],
    description: 'registry.yolo_desc',
    priority: 219,
    availability: 'always',
  },
  {
    name: 'ask',
    aliases: ['ask'],
    description: 'registry.ask_desc',
    priority: 218,
    availability: 'always',
  },
  {
    name: 'goal',
    aliases: ['goaloff'],
    description: 'registry.goal_desc',
    argumentHint: '[objective]',
    priority: 217,
    availability: (args) => {
      const trimmed = args.trim();
      return trimmed === '' || trimmed === 'status' || trimmed === 'pause' || trimmed === 'off'
        ? 'always'
        : 'idle-only';
    },
  },
  {
    name: 'wolfpack',
    aliases: ['wp'],
    description: 'registry.wolfpack_desc',
    priority: 216,
    availability: 'always',
  },
  {
    name: 'rlm',
    aliases: ['rlm'],
    description: 'registry.rlm_desc',
    priority: 215,
    availability: 'always',
  },
  {
    name: 'rlm-max-depth',
    aliases: [],
    description: 'registry.rlm_max_depth_desc',
    argumentHint: '[N]',
    priority: 214,
    availability: 'always',
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'registry.sessions_desc',
    priority: 213,
  },
  {
    name: 'memory',
    aliases: ['memo', 'mem'],
    description: 'registry.memory_desc',
    argumentHint: '[query]',
    priority: 212,
    availability: 'always',
  },
  {
    name: 'knowledge',
    aliases: ['know'],
    description: 'registry.knowledge_desc',
    argumentHint: '[query]',
    priority: 211,
    availability: 'always',
  },
  {
    name: 'model',
    aliases: [],
    description: 'registry.model_desc',
    argumentHint: '[alias]',
    priority: 210,
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'registry.new_desc',
    priority: 209,
  },
  {
    name: 'compact',
    aliases: [],
    description: 'registry.compact_desc',
    priority: 208,
  },
  {
    name: 'fusionplan',
    aliases: ['fp'],
    description: 'registry.fusionplan_desc',
    priority: 207,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'plan',
    aliases: [],
    description: 'registry.plan_desc',
    priority: 206,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: 'registry.tasks_desc',
    priority: 205,
    availability: 'always',
  },
  {
    name: 'btw',
    aliases: [],
    description: 'registry.btw_desc',
    priority: 204,
    availability: 'always',
  },
  {
    name: 'like',
    aliases: [],
    description: 'registry.like_desc',
    priority: 203,
    availability: 'always',
  },
  {
    name: 'skill',
    aliases: ['skills', 'plugin', 'plugins'],
    description: 'registry.skill_desc',
    priority: 202,
    availability: 'always',
  },
  {
    name: 'fork',
    aliases: [],
    description: 'registry.fork_desc',
    priority: 201,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: 'registry.title_desc',
    priority: 200,
    availability: 'always',
  },
  {
    name: 'config',
    aliases: [],
    description: 'registry.config_desc',
    priority: 199,
  },

  // ── 帮助 / 信息 ──
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'registry.help_desc',
    priority: 198,
    availability: 'always',
  },
  {
    name: 'make-skill',
    aliases: ['makeskill', 'craftskill'],
    description: 'registry.make_skill_desc',
    priority: 197,
    availability: 'idle-only',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'registry.mcp_desc',
    priority: 196,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: 'registry.status_desc',
    priority: 195,
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: 'registry.usage_desc',
    priority: 194,
    availability: 'always',
  },
  {
    name: 'revoke',
    aliases: [],
    description: 'registry.revoke_desc',
    priority: 193,
    availability: 'idle-only',
  },
  {
    name: 'cc',
    aliases: [],
    description: 'registry.cc_desc',
    priority: 192,
    availability: 'always',
  },
  {
    name: 'cc-connect',
    aliases: [],
    description: 'registry.cc_connect_desc',
    priority: 191,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: 'registry.theme_desc',
    priority: 190,
    availability: 'always',
  },
  {
    name: 'language',
    aliases: ['lang'],
    description: 'registry.language_desc',
    priority: 189,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: 'registry.permission_desc',
    priority: 188,
    availability: 'always',
  },
  {
    name: 'editor',
    aliases: [],
    description: 'registry.editor_desc',
    priority: 187,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: [],
    description: 'registry.settings_desc',
    priority: 186,
    availability: 'always',
  },
  {
    name: 'init',
    aliases: [],
    description: 'registry.init_desc',
    priority: 185,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: 'registry.export_md_desc',
    priority: 184,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: 'registry.export_debug_desc',
    priority: 183,
  },
  {
    name: 'eval',
    aliases: [],
    description: 'registry.eval_desc',
    priority: 182,
  },
  {
    name: 'update',
    aliases: [],
    description: 'registry.update_desc',
    priority: 181,
    availability: 'idle-only',
  },
  {
    name: 'version',
    aliases: [],
    description: 'registry.version_desc',
    priority: 180,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: 'registry.logout_desc',
    priority: 179,
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
