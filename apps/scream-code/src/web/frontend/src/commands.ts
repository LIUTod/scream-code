/**
 * Slash command catalog shared by Composer (menu) and ChatView (dispatch).
 *
 * Capability-surface rework: this file used to be a single hardcoded command
 * list consumed independently by the menu, the dispatcher and the skills view,
 * which let the three streams drift apart. It is now a **candidate catalog**:
 * - local commands (carrying core/advanced groups; debug-oriented commands live
 *   in the advanced group and stay collapsed on an empty query);
 * - real skills (from webClient's client.skills, injected via setSlashSkills and
 *   listed after the command group; picking one drops plain `/skill-name ` text
 *   into the input instead of executing it).
 *
 * Note: skill entries reuse the SlashCommand shape (kind:'skill' +
 * acceptsInput), so Composer's existing pickSlashCommand logic
 * (acceptsInput → refill the input) needs no change to select them correctly.
 */

import { ref, type Ref } from 'vue';

/** Command execution surface. Mirrors the TUI equivalents. */
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
  /**
   * Group: `core` is listed at the top level, `advanced` is debug-oriented and
   * collapses to a group header on an empty query.
   */
  readonly group?: SlashGroup;
  /** Entry kind; commands default to 'command', skill candidates are 'skill'. */
  readonly kind?: 'command' | 'skill';
  /** Skill origin marker (kind:'skill' only), e.g. 'user' / 'project' / a plugin id. */
  readonly source?: string;
}

export type SlashGroup = 'core' | 'advanced';

/** Minimal projection of a skill candidate (client.skills' SkillSummary satisfies this shape). */
export interface SlashSkillSource {
  name: string;
  description: string;
  source?: string;
  pluginId?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'model', description: '切换模型 / 思考强度', target: 'local', group: 'core' },
  { name: 'new', description: '新建会话', target: 'local', group: 'core' },
  { name: 'clear', description: '清空本地消息列表', target: 'local', group: 'core' },
  { name: 'help', description: '显示可用命令', target: 'local', group: 'core' },
  { name: 'compact', description: '压缩会话上下文', target: 'backend', group: 'core' },
  { name: 'title', description: '重命名当前会话', target: 'backend', aliases: ['rename'], acceptsInput: true, group: 'core' },
  { name: 'btw', description: '快速侧问（不打断当前回合）', target: 'backend', acceptsInput: true, group: 'core' },
  { name: 'auto', description: '切换为 auto 权限模式', target: 'backend', group: 'advanced' },
  { name: 'ask', description: '切换为询问权限模式', target: 'backend', group: 'advanced' },
  { name: 'yes', description: '切换为 yolo 权限模式', target: 'backend', aliases: ['yolo'], group: 'advanced' },
  { name: 'bot', description: '切换为 Bot 无人值守模式', target: 'backend', group: 'advanced' },
  { name: 'plan', description: '切换计划模式', target: 'backend', group: 'advanced' },
  {
    name: 'fusionplan',
    description: '切换融合计划模式',
    target: 'local',
    aliases: ['fp'],
    acceptsInput: true,
    group: 'advanced',
  },
  {
    name: 'wolfpack',
    description: '切换 Wolfpack 多代理模式',
    target: 'local',
    aliases: ['wp'],
    acceptsInput: true,
    group: 'advanced',
  },
  {
    name: 'rlm',
    description: '切换 RLM Python 内核模式',
    target: 'local',
    acceptsInput: true,
    group: 'advanced',
  },
  {
    name: 'rlm-max-depth',
    description: '设置 RLM 递归最大深度',
    target: 'local',
    acceptsInput: true,
    group: 'advanced',
  },
  {
    name: 'revoke',
    description: '撤销最近一轮消息',
    target: 'local',
    acceptsInput: true,
    group: 'advanced',
  },
  { name: 'fork', description: '复制当前会话为新分支', target: 'backend', group: 'advanced' },
  { name: 'status', description: '查看会话状态', target: 'local', group: 'advanced' },
  { name: 'usage', description: '查看 Token 用量', target: 'local', group: 'advanced' },
];

/* ── Skill candidate injection (webClient → menu) ────────────────────────── */

/**
 * Mirror of client.skills. Written by useScreamWebClient on every skill-list
 * refresh; empty while there is no session or no registration, which degrades
 * the menu to commands only.
 */
const slashSkills: Ref<SlashSkillSource[]> = ref([]);

export function setSlashSkills(skills: readonly SlashSkillSource[]): void {
  slashSkills.value = [...skills];
}

/**
 * Secondary search term inside the menu (written by SlashMenu's filter row).
 * Used to narrow the list once candidates exceed one screen (>8) and combined
 * with the slash suffix through AND. Reset when SlashMenu unmounts (menu closes).
 */
const slashMenuFilter: Ref<string> = ref('');

export function setSlashMenuFilter(query: string): void {
  slashMenuFilter.value = query.trim().toLowerCase();
}

export function resetSlashMenuFilter(): void {
  slashMenuFilter.value = '';
}

/** Candidate-count threshold above which SlashMenu shows its search filter row. */
export const SLASH_MENU_SEARCH_THRESHOLD = 8;

/**
 * Whether the last filterSlashCommands hid the advanced group (the menu renders
 * a collapsed group header on that basis).
 */
const advancedCollapsed: Ref<boolean> = ref(false);

export function isAdvancedCollapsed(): boolean {
  return advancedCollapsed.value;
}

function commandMatches(cmd: SlashCommand, q: string): boolean {
  if (!q) return true;
  return (
    cmd.name.startsWith(q) ||
    cmd.aliases?.some((a) => a.startsWith(q)) === true ||
    cmd.description.includes(q)
  );
}

function skillMatches(skill: SlashSkillSource, q: string): boolean {
  if (!q) return true;
  const lower = skill.name.toLowerCase();
  return lower.startsWith(q) || skill.name.includes(q) || skill.description.includes(q);
}

/**
 * Command candidates (skills excluded): shared by filterSlashCommands and
 * /help so both stay in sync.
 */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => commandMatches(c, q));
}

/**
 * Merged candidates: the command group first (core listed directly; advanced
 * collapsed on an empty query and expanded once the query matches), then the
 * skill group. Composer's slashCommands computed calls this function, so changes
 * to slashSkills / slashMenuFilter drive the menu refresh by construction.
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = (query || '').toLowerCase();
  // Empty query + empty secondary filter = browsing: collapse the advanced
  // group and show only its header.
  const browsing = q === '' && slashMenuFilter.value === '';
  advancedCollapsed.value = browsing;

  const commands = SLASH_COMMANDS.filter(
    (c) => commandMatches(c, q) && commandMatches(c, slashMenuFilter.value),
  ).filter((c) => !browsing || c.group !== 'advanced');

  const skills: SlashCommand[] = slashSkills.value
    .filter(
      (sk) => skillMatches(sk, q) && skillMatches(sk, slashMenuFilter.value),
    )
    .map((sk) => ({
      name: sk.name,
      description: sk.description || '技能',
      target: 'local' as const,
      // acceptsInput=true makes Composer's selection logic refill the input with
      // `/skill-name ` instead of emitting a command immediately — a skill only
      // runs after the user adds its arguments.
      acceptsInput: true,
      kind: 'skill' as const,
      source: sk.pluginId ? `plugin:${sk.pluginId}` : sk.source,
    }));

  return [...commands, ...skills];
}

/**
 * Currently injected skill candidates (the dispatcher routes `/skill-name ...`
 * to skill activation with these).
 */
export function getSlashSkills(): SlashSkillSource[] {
  return slashSkills.value;
}

/** Resolve a typed token (name or alias) to its canonical command name. */
export function resolveCommandName(input: string): string {
  const lower = input.toLowerCase();
  const cmd = SLASH_COMMANDS.find((c) => c.name === lower || c.aliases?.includes(lower));
  return cmd?.name ?? lower;
}

/** Whether a dispatched name refers to an injected skill (exact, case-insensitive). */
export function isSlashSkillName(name: string): boolean {
  const lower = name.toLowerCase();
  return slashSkills.value.some((s) => s.name.toLowerCase() === lower);
}

/** Slash help text: /help only (the skills view no longer doubles as a command cheat sheet). */
export function slashHelpText(): string {
  const line = (c: SlashCommand): string => {
    const names = c.aliases?.length
      ? [c.name, ...c.aliases].map((n) => `/${n}`).join(', ')
      : `/${c.name}`;
    return `${names} - ${c.description}`;
  };
  const core = SLASH_COMMANDS.filter((c) => c.group !== 'advanced');
  const advanced = SLASH_COMMANDS.filter((c) => c.group === 'advanced');
  const lines = [
    '常用：',
    ...core.map(line),
    '高级：',
    ...advanced.map(line),
  ];
  if (slashSkills.value.length > 0) {
    lines.push(
      '',
      `技能 ${slashSkills.value.length} 个（输入 / 后在菜单中查看，或前往技能中心）：`,
      ...slashSkills.value.map((s) => `/${s.name} - ${s.description || '技能'}`),
    );
  }
  return ['可用命令：', ...lines].join('\n');
}
