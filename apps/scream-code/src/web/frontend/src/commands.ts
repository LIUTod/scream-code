/**
 * Slash command definitions shared by Composer (menu) and ChatView (dispatch).
 * Mirrors the TUI equivalents (/compact, /model, /clear, /new, /help).
 */

export interface SlashCommand {
  /** Command name without the leading slash. */
  readonly name: string;
  /** Short description shown in the menu. */
  readonly description: string;
  /** Where the command is executed. */
  readonly target: 'backend' | 'local';
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'compact', description: '压缩会话上下文', target: 'backend' },
  { name: 'model', description: '查看当前模型', target: 'local' },
  { name: 'clear', description: '清空本地消息列表', target: 'local' },
  { name: 'new', description: '新建会话', target: 'local' },
  { name: 'help', description: '显示可用命令', target: 'local' },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

export function slashHelpText(): string {
  const lines = SLASH_COMMANDS.map((c) => `/${c.name} — ${c.description}`);
  return ['可用命令：', ...lines].join('\n');
}
