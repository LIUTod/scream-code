/**
 * Slash command definitions shared by Composer (menu) and ChatView (dispatch).
 * Mirrors the TUI equivalents (/compact, /model, /clear, /new, /help) and
 * extends the web with permission/plan/fork/title/status/usage/btw.
 */

export interface SlashCommand {
  /** Command name without the leading slash. */
  readonly name: string;
  /** Short description shown in the menu. */
  readonly description: string;
  /** Where the command is executed. */
  readonly target: 'backend' | 'local';
  /** Alternative triggers (without the leading slash). */
  readonly aliases?: readonly string[];
  /** Whether the command takes free-form input after the name (e.g. `/title x`). */
  readonly acceptsInput?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'compact', description: '压缩会话上下文', target: 'backend' },
  { name: 'model', description: '切换模型 / 思考强度', target: 'local' },
  { name: 'clear', description: '清空本地消息列表', target: 'local' },
  { name: 'new', description: '新建会话', target: 'local' },
  { name: 'help', description: '显示可用命令', target: 'local' },
  { name: 'auto', description: '切换为 auto 权限模式', target: 'backend' },
  { name: 'yes', description: '切换为 yolo 权限模式', target: 'backend', aliases: ['yolo'] },
  { name: 'plan', description: '切换计划模式', target: 'backend' },
  { name: 'fork', description: '复制当前会话为新分支', target: 'backend' },
  { name: 'title', description: '重命名当前会话', target: 'backend', aliases: ['rename'], acceptsInput: true },
  { name: 'status', description: '查看会话状态', target: 'local' },
  { name: 'usage', description: '查看 Token 用量', target: 'local' },
  { name: 'btw', description: '快速侧问（不打断当前回合）', target: 'backend', acceptsInput: true },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter(
    (c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q)),
  );
}

/** Resolve a typed token (name or alias) to its canonical command name. */
export function resolveCommandName(input: string): string {
  const lower = input.toLowerCase();
  const cmd = SLASH_COMMANDS.find((c) => c.name === lower || c.aliases?.includes(lower));
  return cmd?.name ?? lower;
}

export function slashHelpText(): string {
  const lines = SLASH_COMMANDS.map((c) => {
    const names = c.aliases?.length
      ? [c.name, ...c.aliases].map((n) => `/${n}`).join(', ')
      : `/${c.name}`;
    return `${names} - ${c.description}`;
  });
  return ['可用命令：', ...lines].join('\n');
}
