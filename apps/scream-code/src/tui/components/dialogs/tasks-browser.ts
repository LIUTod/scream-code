/**
 * TasksBrowserApp — full-screen alt-screen takeover for browsing
 * background tasks. Three-pane layout (left task list, right top
 * detail, right bottom preview output) framed by a header row and
 * footer key hint.
 *
 * Mounted by `scream-tui.ts` via container swap rather than `showOverlay`
 * — the main TUI's children are saved, cleared, and this component is
 * added as the sole child so it covers the entire screen. The
 * controller restores the children when the user exits.
 *
 * Data (tasks list, tail output) flows in via `setProps`; user actions
 * fire the `on*` callbacks back to the controller.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@liutod-scream/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@scream-code/scream-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '@/tui/theme/colors';
import { printableChar } from '@/tui/utils/printable-key';
import { sanitizeShellOutput } from '@/tui/utils/sanitize';
import type { AgentRow, AgentRowStatus, AgentSource } from '@/tui/utils/subagent-instances';
import { t } from '@scream-code/config';

const ELLIPSIS = '…';

export type TasksFilter = 'all' | 'active' | 'agents';

export interface TasksBrowserProps {
  readonly tasks: readonly BackgroundTaskInfo[];
  /**
   * Source subagent of every subagent-owned task, keyed by task id. A
   * subagent's task lives in that subagent's own registry, so the main-agent
   * list the controller polls cannot contain it: these rows are fed from the
   * live event stream (`SessionEventHandler.recordSubagentBackgroundTask`) and
   * name their owner so the row never reads as the main agent's work.
   */
  readonly taskSourceNames: ReadonlyMap<string, string>;
  /** Subagent rows shown by the `agents` filter (see utils/subagent-instances). */
  readonly agents: readonly AgentRow[];
  readonly filter: TasksFilter;
  readonly selectedTaskId: string | undefined;
  readonly tailOutput: string | undefined;
  readonly tailLoading: boolean;
  readonly flashMessage: string | undefined;
  readonly colors: ColorPalette;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleFilter: () => void;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  /** Fired when the user confirms a stop request via the inline `y` prompt. */
  readonly onStopConfirmed: (taskId: string) => void;
  /** Fired when the user presses Enter or O on a selected task. */
  readonly onOpenOutput: (taskId: string) => void;
  /** Fired when stop is requested on a task that cannot be stopped. */
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void;
}

const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
  lost: 'lost',
};

/** Auto-cancel the inline stop confirmation after this many ms. */
const STOP_CONFIRM_TIMEOUT_MS = 5_000;

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

/** Hard caps so a tiny / huge terminal still gets a sensible left-column width. */
const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

function statusColor(colors: ColorPalette, status: BackgroundTaskStatus): string {
  switch (status) {
    case 'running':
      return colors.success;
    case 'completed':
      return colors.textMuted;
    case 'failed':
    case 'killed':
    case 'lost':
      return colors.error;
  }
}

function isTerminal(status: BackgroundTaskStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'killed' || status === 'lost'
  );
}

/** Width of the agent-name column in the Agents list (leaves room for the
 *  status word, the instance count and an activity hint on narrow panes). */
const AGENT_NAME_COLS = 12;

/** Localized word per agent row status: the six live slot states plus the two
 *  terminal outcomes the instance registry can report. */
function agentStatusText(status: AgentRowStatus): string {
  switch (status) {
    case 'idle':
      return t('sidebar.agent_idle');
    case 'working':
      return t('sidebar.agent_working');
    case 'outputting':
      return t('sidebar.agent_outputting');
    case 'messaging':
      return t('sidebar.agent_messaging');
    case 'reworking':
      return t('sidebar.agent_reworking');
    case 'requesting':
      return t('sidebar.agent_requesting');
    case 'completed':
      return t('taskbrowser.agents_completed');
    case 'failed':
      return t('taskbrowser.agents_failed');
  }
}

function agentStatusColor(colors: ColorPalette, status: AgentRowStatus): string {
  switch (status) {
    case 'working':
    case 'outputting':
      return colors.success;
    case 'messaging':
      return colors.accent;
    case 'reworking':
    case 'requesting':
      return colors.warning;
    case 'completed':
      return colors.textMuted;
    case 'failed':
      return colors.error;
    case 'idle':
      return colors.textDim;
  }
}

/** "Who triggered this agent" line. Each kind names its own evidence, and a
 *  missing clue is voiced as unknown instead of guessed. */
function formatAgentSource(source: AgentSource): string {
  switch (source.kind) {
    case 'tool': {
      if (source.name === undefined) return t('taskbrowser.agent_source_unknown');
      return source.description === undefined
        ? source.name
        : `${source.name} · ${source.description}`;
    }
    case 'agent': {
      const via =
        source.name === undefined
          ? t('taskbrowser.agent_source_unknown')
          : t('taskbrowser.agent_source_via', { name: source.name });
      return source.description === undefined ? via : `${via} · ${source.description}`;
    }
    case 'rlm': {
      const rlm = t('taskbrowser.agent_source_rlm');
      return source.name === undefined
        ? rlm
        : `${rlm} · ${t('taskbrowser.agent_source_via', { name: source.name })}`;
    }
    case 'main':
      return t('taskbrowser.agent_source_main');
    case 'unknown':
      return t('taskbrowser.agent_source_unknown');
  }
}

/** Full spawn chain, root first: `main → researcher → coder`, `…` when the
 *  walk stopped early (missing link / cycle / depth cap). */
function formatAgentChain(agent: AgentRow): string {
  const parents = [...agent.ancestors].toReversed();
  const parts = [t('taskbrowser.agent_main'), ...parents, agent.type];
  return `${parts.join(' → ')}${agent.chainTruncated ? ' → …' : ''}`;
}

function formatRelativeTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

/** Fit `line` into exactly `width` columns, even after CJK-edge truncation. */
function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

function visibleTasks(
  tasks: readonly BackgroundTaskInfo[],
  filter: TasksFilter,
): BackgroundTaskInfo[] {
  if (filter === 'active') return tasks.filter((t) => !isTerminal(t.status));
  return [...tasks];
}

/**
 * Keep `selectedIndex` inside the window `scrollOffset … scrollOffset+rows-1`,
 * clamped to the list bounds. Shared by the task list and the agent list.
 */
function clampListScroll(
  selectedIndex: number,
  scrollOffset: number,
  total: number,
  visibleRows: number,
): number {
  if (visibleRows <= 0) return 0;
  let next = scrollOffset;
  if (selectedIndex < next) {
    next = selectedIndex;
  } else if (selectedIndex >= next + visibleRows) {
    next = selectedIndex - visibleRows + 1;
  }
  const maxScroll = Math.max(0, total - visibleRows);
  if (next < 0) next = 0;
  if (next > maxScroll) next = maxScroll;
  return next;
}

function compareTasks(a: BackgroundTaskInfo, b: BackgroundTaskInfo): number {
  const aTerminal = isTerminal(a.status);
  const bTerminal = isTerminal(b.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
  if (!aTerminal) return a.startedAt - b.startedAt;
  return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
}

interface StatusCounts {
  running: number;
  completed: number;
  terminalFailed: number;
}

function countByStatus(tasks: readonly BackgroundTaskInfo[]): StatusCounts {
  const counts: StatusCounts = { running: 0, completed: 0, terminalFailed: 0 };
  for (const t of tasks) {
    switch (t.status) {
      case 'running':
        counts.running += 1;
        break;
      case 'completed':
        counts.completed += 1;
        break;
      case 'failed':
      case 'killed':
      case 'lost':
        counts.terminalFailed += 1;
        break;
    }
  }
  return counts;
}

export class TasksBrowserApp extends Container implements Focusable {
  focused = false;

  private props: TasksBrowserProps;
  private readonly terminal: Terminal;
  private sortedVisible: BackgroundTaskInfo[];
  private selectedIndex = 0;
  private listScroll = 0;
  /** Agents view selection — component-local: agent rows are read-only, so
   *  nothing needs to travel back to the controller. `selectedAgentKey` is the
   *  anchor: rows re-sort as statuses change, the index must not decide. */
  private agentIndex = 0;
  private agentScroll = 0;
  private selectedAgentKey: string | undefined = undefined;
  private pendingStopTaskId: string | undefined = undefined;
  private pendingStopTimer: NodeJS.Timeout | undefined = undefined;

  constructor(props: TasksBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.sortedVisible = visibleTasks(props.tasks, props.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
  }

  setProps(next: TasksBrowserProps): void {
    this.props = next;
    this.sortedVisible = visibleTasks(next.tasks, next.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
    this.syncAgentSelectionFromProps();
    if (this.pendingStopTaskId !== undefined) {
      const task = next.tasks.find((t) => t.taskId === this.pendingStopTaskId);
      if (task === undefined || isTerminal(task.status)) this.clearPendingStop();
    }
    this.invalidate();
  }

  private syncSelectionFromProps(): void {
    if (this.sortedVisible.length === 0) {
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    if (this.props.selectedTaskId !== undefined) {
      const idx = this.sortedVisible.findIndex((t) => t.taskId === this.props.selectedTaskId);
      if (idx !== -1) {
        this.selectedIndex = idx;
        return;
      }
    }
    if (this.selectedIndex >= this.sortedVisible.length) {
      this.selectedIndex = this.sortedVisible.length - 1;
    }
  }

  /** Keep the agents selection pinned to the same slot type across refreshes
   *  (rows re-sort as statuses change); fall back to clamping. */
  private syncAgentSelectionFromProps(): void {
    const agents = this.props.agents;
    if (agents.length === 0) {
      this.agentIndex = 0;
      this.agentScroll = 0;
      this.selectedAgentKey = undefined;
      return;
    }
    if (this.selectedAgentKey !== undefined) {
      const byKey = agents.findIndex((agent) => agent.key === this.selectedAgentKey);
      if (byKey !== -1) {
        this.agentIndex = byKey;
        return;
      }
    }
    if (this.agentIndex >= agents.length) this.agentIndex = agents.length - 1;
    this.selectedAgentKey = agents[this.agentIndex]?.key;
  }

  /** Move the agents cursor (rows are read-only: no controller round-trip). */
  private selectAgent(index: number): void {
    const agents = this.props.agents;
    if (agents.length === 0) return;
    this.agentIndex = Math.min(agents.length - 1, Math.max(0, index));
    this.selectedAgentKey = agents[this.agentIndex]?.key;
    this.invalidate();
  }

  private clearPendingStop(): void {
    this.pendingStopTaskId = undefined;
    if (this.pendingStopTimer !== undefined) {
      clearTimeout(this.pendingStopTimer);
      this.pendingStopTimer = undefined;
    }
  }

  /**
   * Component-local teardown, called by the controller's close() before the
   * component is swapped out: the pending-stop confirm timer must not
   * outlive the browser.
   */
  close(): void {
    this.clearPendingStop();
  }

  private emitSelect(): void {
    const task = this.sortedVisible[this.selectedIndex];
    if (task) this.props.onSelect(task.taskId);
  }

  handleInput(data: string): void {
    const k = printableChar(data);
    const agentsMode = this.props.filter === 'agents';

    if (this.pendingStopTaskId !== undefined) {
      if (k === 'y' || k === 'Y') {
        const taskId = this.pendingStopTaskId;
        this.clearPendingStop();
        this.props.onStopConfirmed(taskId);
        this.invalidate();
        return;
      }
      this.clearPendingStop();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      if (agentsMode) {
        this.selectAgent(this.agentIndex - 1);
        return;
      }
      if (this.sortedVisible.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.emitSelect();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      if (agentsMode) {
        this.selectAgent(this.agentIndex + 1);
        return;
      }
      if (this.sortedVisible.length === 0) return;
      this.selectedIndex = Math.min(this.sortedVisible.length - 1, this.selectedIndex + 1);
      this.emitSelect();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab) || k === '\t') {
      this.props.onToggleFilter();
      return;
    }
    if (k === 'r' || k === 'R') {
      this.props.onRefresh();
      return;
    }
    // The agents view is read-only: nothing to stop, no output stream to open.
    if (agentsMode) return;
    if (k === 's' || k === 'S') {
      const task = this.sortedVisible[this.selectedIndex];
      if (task === undefined) return;
      if (isTerminal(task.status)) {
        this.props.onStopIgnored?.(task.taskId, 'terminal');
        return;
      }
      this.pendingStopTaskId = task.taskId;
      this.pendingStopTimer = setTimeout(() => {
        this.clearPendingStop();
        this.invalidate();
      }, STOP_CONFIRM_TIMEOUT_MS);
      this.invalidate();
      return;
    }
    if (k === 'o' || k === 'O' || matchesKey(data, Key.enter)) {
      const task = this.sortedVisible[this.selectedIndex];
      if (task) this.props.onOpenOutput(task.taskId);
      return;
    }
  }

  /**
   * Render the entire screen as `terminal.rows` lines of `width` cols.
   * Layout: header(1) + body(rows-2) + footer(1).
   */
  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return this.renderTooSmall(width, rows);
    }

    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyHeight = rows - 2;

    const listWidth = Math.max(
      LIST_COL_MIN,
      Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)),
    );
    const rightWidth = width - listWidth;

    const listFrame = this.renderListFrame(listWidth, bodyHeight);
    const rightFrames = this.renderRightStack(rightWidth, bodyHeight);

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push((listFrame[i] ?? ' '.repeat(listWidth)) + (rightFrames[i] ?? ' '.repeat(rightWidth)));
    }
    lines.push(footer);
    return lines;
  }

  // ── header / footer ──────────────────────────────────────────────────

  private renderHeader(width: number): string {
    const colors = this.props.colors;
    const title = chalk.hex(colors.primary).bold(' TASK BROWSER ');
    const filterLabel =
      this.props.filter === 'all' ? 'ALL' : this.props.filter === 'active' ? 'ACTIVE' : 'AGENTS';
    const filterText = chalk.hex(colors.textMuted)(` filter=${filterLabel} `);

    const segments: string[] = [];
    if (this.props.filter === 'agents') {
      const live = this.props.agents.filter((agent) => agent.live).length;
      const ended = this.props.agents.length - live;
      if (live > 0) {
        segments.push(chalk.hex(colors.success)(` ${String(live)} ${t('taskbrowser.agents_live')} `));
      }
      if (ended > 0) {
        segments.push(chalk.hex(colors.textDim)(` ${String(ended)} ${t('taskbrowser.agents_ended')} `));
      }
      if (this.props.agents.length === 0) {
        segments.push(chalk.hex(colors.textMuted)(` 0 ${t('taskbrowser.agents')} `));
      }
    } else {
      const counts = countByStatus(this.props.tasks);
      if (counts.running > 0)
        segments.push(chalk.hex(colors.success)(` ${String(counts.running)} ${t('taskbrowser.running')} `));
      if (counts.completed > 0)
        segments.push(chalk.hex(colors.textDim)(` ${String(counts.completed)} ${t('taskbrowser.completed')} `));
      if (counts.terminalFailed > 0)
        segments.push(
          chalk.hex(colors.error)(` ${String(counts.terminalFailed)} ${t('taskbrowser.interrupted')} `),
        );
      segments.push(
        chalk.hex(colors.textMuted)(` ${String(this.props.tasks.length)} ${t('taskbrowser.total')} `),
      );
      const liveAgents = this.props.agents.filter((agent) => agent.live).length;
      if (liveAgents > 0) {
        segments.push(chalk.hex(colors.success)(` ${String(liveAgents)} ${t('taskbrowser.agents')} `));
      }
    }

    return fitExactly(title + filterText + segments.join(''), width);
  }

  private renderFooter(width: number): string {
    const colors = this.props.colors;
    const key = (text: string): string => chalk.hex(colors.primary).bold(text);
    const dim = (text: string): string => chalk.hex(colors.textMuted)(text);

    if (this.pendingStopTaskId !== undefined) {
      const warn = (text: string): string => chalk.hex(colors.warning).bold(text);
      const line =
        ` ${warn(t('taskbrowser.stop'))} ${chalk.hex(colors.text)(this.pendingStopTaskId)}? ` +
        `${key('Y')} ${dim(t('taskbrowser.confirm'))}  ${key('N')} ${dim(t('taskbrowser.cancel'))} `;
      return fitExactly(line, width);
    }

    const parts =
      this.props.filter === 'agents'
        ? [
            ` ${key('↑↓')} ${dim(t('taskbrowser.select'))}`,
            `${key('Tab')} ${dim(t('taskbrowser.filter'))}`,
            `${key('R')} ${dim(t('taskbrowser.refresh'))}`,
            `${key('Q/Esc')} ${dim(t('taskbrowser.exit'))} `,
          ]
        : [
            ` ${key('↑↓')} ${dim(t('taskbrowser.select'))}`,
            `${key('Enter/O')} ${dim(t('taskbrowser.output'))}`,
            `${key('S')} ${dim(t('taskbrowser.stop_action'))}`,
            `${key('R')} ${dim(t('taskbrowser.refresh'))}`,
            `${key('Tab')} ${dim(t('taskbrowser.filter'))}`,
            `${key('Q/Esc')} ${dim(t('taskbrowser.exit'))} `,
          ];
    const left = parts.join('  ');
    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = chalk.hex(colors.warning)(` ${flash} `);
      const total = visibleWidth(left) + visibleWidth(flashStyled);
      if (total <= width) {
        return left + ' '.repeat(width - total) + flashStyled;
      }
    }
    return fitExactly(left, width);
  }

  // ── frame primitive ──────────────────────────────────────────────────

  /**
   * Render a framed box: `┌─ Title ─┐` top, `│ <content> │` sides, `└─┘`
   * bottom. Result is exactly `width × height` cells. `content` is a
   * pre-rendered array of inner-width-sized lines; extra rows are padded.
   */
  private renderFrame(
    title: string,
    content: readonly string[],
    width: number,
    height: number,
  ): string[] {
    if (height < 2 || width < 4) {
      const out: string[] = [];
      for (let i = 0; i < height; i++) out.push(' '.repeat(width));
      return out;
    }
    const stroke = this.props.colors.primary;
    const innerWidth = width - 2;
    const innerHeight = height - 2;

    const titleStyled = chalk.hex(this.props.colors.textStrong).bold(title);
    const titleWidth = visibleWidth(titleStyled);
    const titleSegment = `─ ${titleStyled} `;
    const titleSegmentWidth = visibleWidth(titleSegment);
    const remainingDashes = Math.max(0, innerWidth - titleSegmentWidth);
    const topMid =
      titleWidth > 0 && titleSegmentWidth <= innerWidth
        ? chalk.hex(stroke)('─ ') +
          titleStyled +
          ' ' +
          chalk.hex(stroke)('─'.repeat(remainingDashes))
        : chalk.hex(stroke)('─'.repeat(innerWidth));
    const top = chalk.hex(stroke)('┌') + topMid + chalk.hex(stroke)('┐');
    const bottom = chalk.hex(stroke)('└' + '─'.repeat(innerWidth) + '┘');

    const lines: string[] = [top];
    for (let i = 0; i < innerHeight; i++) {
      const inner = content[i] ?? '';
      lines.push(chalk.hex(stroke)('│') + fitExactly(inner, innerWidth) + chalk.hex(stroke)('│'));
    }
    lines.push(bottom);
    return lines;
  }

  // ── left: task list frame ────────────────────────────────────────────

  private renderListFrame(width: number, height: number): string[] {
    if (this.props.filter === 'agents') return this.renderAgentsFrame(width, height);

    const title = `Tasks [${this.props.filter}]`;
    const innerHeight = Math.max(0, height - 2);

    if (this.sortedVisible.length === 0) {
      const empty =
        this.props.filter === 'active'
          ? t('taskbrowser.no_active')
          : t('taskbrowser.no_tasks');
      const lines: string[] = [chalk.hex(this.props.colors.textMuted)(empty)];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(title, lines, width, height);
    }

    this.adjustScroll(innerHeight);
    const start = this.listScroll;
    const window = this.sortedVisible.slice(start, start + innerHeight);

    const innerWidth = width - 2;
    const lines: string[] = [];
    for (const [vi, task] of window.entries()) {
      const index = start + vi;
      lines.push(this.renderListRow(task, index === this.selectedIndex, innerWidth));
    }
    while (lines.length < innerHeight) lines.push('');

    return this.renderFrame(title, lines, width, height);
  }

  /** Left pane, `agents` filter: one row per subagent type with history (live
   *  ones first), including types whose slot the cap pushed out and that only
   *  the instance registry knows; read-only — the detail pane carries the full
   *  provenance. */
  private renderAgentsFrame(width: number, height: number): string[] {
    const colors = this.props.colors;
    const agents = this.props.agents;
    const innerHeight = Math.max(0, height - 2);
    const title = `${t('taskbrowser.agents_title')} [${String(agents.length)}]`;

    if (agents.length === 0) {
      const lines: string[] = [chalk.hex(colors.textMuted)(t('taskbrowser.agents_empty'))];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(title, lines, width, height);
    }

    this.agentScroll = clampListScroll(
      this.agentIndex,
      this.agentScroll,
      agents.length,
      innerHeight,
    );
    const start = this.agentScroll;
    const window = agents.slice(start, start + innerHeight);

    const innerWidth = width - 2;
    const lines: string[] = [];
    for (const [vi, agent] of window.entries()) {
      const index = start + vi;
      lines.push(this.renderAgentRow(agent, index === this.agentIndex, innerWidth));
    }
    while (lines.length < innerHeight) lines.push('');

    return this.renderFrame(title, lines, width, height);
  }

  private renderAgentRow(agent: AgentRow, selected: boolean, innerWidth: number): string {
    const colors = this.props.colors;
    const pointer = selected ? '> ' : '  ';
    const pointerStyled = chalk.hex(selected ? colors.primary : colors.textDim)(pointer);
    const marker = chalk.hex(agentStatusColor(colors, agent.status))(
      agent.status === 'idle' ? '○' : '●',
    );
    const nameCell = chalk.hex(selected ? colors.primary : colors.textStrong)(
      padToWidth(truncateToWidth(agent.type, AGENT_NAME_COLS, ELLIPSIS), AGENT_NAME_COLS),
    );
    const statusWord = chalk.hex(agentStatusColor(colors, agent.status))(
      agentStatusText(agent.status),
    );
    const count = agent.count > 1 ? chalk.hex(colors.textMuted)(` ×${String(agent.count)}`) : '';

    const head = `${pointerStyled}${marker} ${nameCell} ${statusWord}${count}`;
    const budget = innerWidth - visibleWidth(head) - 1;
    if (budget < 6) return fitExactly(head, innerWidth);

    const hint = singleLine(agent.detail ?? agent.description ?? '');
    if (hint.length === 0) return fitExactly(head, innerWidth);
    const trimmed = truncateToWidth(hint, budget, ELLIPSIS);
    return fitExactly(`${head} ${chalk.hex(colors.textDim)(trimmed)}`, innerWidth);
  }

  private renderListRow(task: BackgroundTaskInfo, selected: boolean, innerWidth: number): string {
    const colors = this.props.colors;
    const pointer = selected ? '> ' : '  ';
    const pointerStyled = chalk.hex(selected ? colors.primary : colors.textDim)(pointer);

    const idColor = selected ? colors.primary : task.taskId.startsWith('agent-')
      ? colors.success
      : colors.accent;
    const idText = selected
      ? chalk.hex(idColor).bold(task.taskId)
      : chalk.hex(idColor)(task.taskId);
    const idPad = ' '.repeat(Math.max(0, 17 - task.taskId.length));

    const status = STATUS_LABEL[task.status];
    const statusBadge = chalk.hex(statusColor(colors, task.status))(status);

    const prefix = `${pointerStyled}${idText}${idPad} ${statusBadge}`;
    const prefixWidth = visibleWidth(prefix);
    // Subagent-owned rows name their owner: the row must not read as the main
    // agent's work (its own registry cannot answer for it). The tag is reserved
    // its width first and the description takes what is left; when only one of
    // the two fits, the tag stays — the detail pane carries the description in
    // full either way.
    const source = this.props.taskSourceNames.get(task.taskId);
    const tag = source === undefined ? '' : ` ${t('taskbrowser.task_source_via', { name: source })}`;
    const remaining = Math.max(0, innerWidth - prefixWidth - 1);
    const descBudget = Math.max(0, remaining - visibleWidth(tag));
    const description =
      singleLine(task.description) || singleLine(task.command) || '(no description)';

    if (tag.length === 0) {
      if (descBudget < 4) return fitExactly(prefix, innerWidth);
      const desc = truncateToWidth(description, descBudget, ELLIPSIS);
      return fitExactly(`${prefix} ${chalk.hex(colors.text)(desc)}`, innerWidth);
    }

    if (descBudget >= 4) {
      const desc = chalk.hex(colors.text)(truncateToWidth(description, descBudget, ELLIPSIS));
      return fitExactly(`${prefix} ${desc}${chalk.hex(colors.textDim)(tag)}`, innerWidth);
    }

    if (remaining < 4) return fitExactly(prefix, innerWidth);
    const tagOnly = truncateToWidth(tag.slice(1), remaining, ELLIPSIS);
    return fitExactly(`${prefix} ${chalk.hex(colors.textDim)(tagOnly)}`, innerWidth);
  }

  private adjustScroll(visibleRows: number): void {
    this.listScroll = clampListScroll(
      this.selectedIndex,
      this.listScroll,
      this.sortedVisible.length,
      visibleRows,
    );
  }

  // ── right: detail + preview stack ────────────────────────────────────

  private renderRightStack(width: number, height: number): string[] {
    // Detail gets ~8 rows (or 40% of body, whichever is larger). Preview
    // takes the rest. Both rendered as separate frames stacked vertically.
    const detailHeight = Math.max(8, Math.min(Math.floor(height * 0.4), height - 5));
    const previewHeight = height - detailHeight;
    return [
      ...this.renderDetailFrame(width, detailHeight),
      ...this.renderPreviewFrame(width, previewHeight),
    ];
  }

  private renderDetailFrame(width: number, height: number): string[] {
    if (this.props.filter === 'agents') return this.renderAgentDetailFrame(width, height);
    const colors = this.props.colors;
    const innerHeight = Math.max(0, height - 2);
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      const empty = chalk.hex(colors.textMuted)(t('taskbrowser.select_task'));
      const lines: string[] = [empty];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(t('taskbrowser.detail'), lines, width, height);
    }

    const label = (text: string): string => chalk.hex(colors.textMuted)(text.padEnd(14));
    const value = (text: string): string => chalk.hex(colors.text)(text);

    const lines: string[] = [
      `${label(t('taskbrowser.task_id'))}${value(task.taskId)}`,
      `${label(t('taskbrowser.status'))}${chalk.hex(statusColor(colors, task.status))(STATUS_LABEL[task.status])}`,
      `${label(t('taskbrowser.description'))}${value(singleLine(task.description) || '—')}`,
    ];
    const source = this.props.taskSourceNames.get(task.taskId);
    if (source !== undefined) {
      // Detail line label reused from the Agents view: the value is the owning
      // subagent, i.e. whose registry holds this task.
      lines.push(`${label(t('taskbrowser.agent_source'))}${value(singleLine(source))}`);
    }
    if (task.command && task.command !== task.description) {
      lines.push(`${label(t('taskbrowser.command'))}${value(singleLine(task.command))}`);
    }
    const timing =
      task.status === 'running'
        ? `${t('taskbrowser.running_time')} ${formatRelativeTime(task.startedAt)}`
        : task.endedAt !== null && task.endedAt !== undefined
          ? `${t('taskbrowser.completed_time')} ${formatRelativeTime(task.endedAt)}`
          : '';
    if (timing.length > 0) lines.push(`${label(t('taskbrowser.time'))}${chalk.hex(colors.textMuted)(timing)}`);
    if (task.pid > 0) lines.push(`${label(t('taskbrowser.process_id'))}${chalk.hex(colors.textMuted)(String(task.pid))}`);
    if (task.exitCode !== null && task.exitCode !== undefined) {
      lines.push(`${label(t('taskbrowser.exit_code'))}${chalk.hex(colors.textMuted)(String(task.exitCode))}`);
    }
    if (task.stopReason !== undefined && task.stopReason.length > 0) {
      lines.push(`${label(t('taskbrowser.stop_reason'))}${chalk.hex(colors.textMuted)(task.stopReason)}`);
    }
    if (task.timedOut === true) {
      lines.push(`${label(t('taskbrowser.timed_out'))}${chalk.hex(colors.warning)(t('taskbrowser.yes'))}`);
    }

    while (lines.length < innerHeight) lines.push('');
    return this.renderFrame(t('taskbrowser.detail'), lines, width, height);
  }

  /** Right-top pane, `agents` filter: provenance of the selected agent —
   *  type, live status, spawn description, trigger source, parent chain,
   *  latest activity and the current instance id. */
  private renderAgentDetailFrame(width: number, height: number): string[] {
    const colors = this.props.colors;
    const innerHeight = Math.max(0, height - 2);
    const agent = this.props.agents[this.agentIndex];
    if (agent === undefined) {
      const empty = chalk.hex(colors.textMuted)(t('taskbrowser.agents_empty'));
      const lines: string[] = [empty];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(t('taskbrowser.agent_detail'), lines, width, height);
    }

    const label = (text: string): string => chalk.hex(colors.textMuted)(text.padEnd(14));
    const value = (text: string): string => chalk.hex(colors.text)(text);

    const countSuffix = agent.count > 1 ? chalk.hex(colors.textMuted)(` ×${String(agent.count)}`) : '';
    const lines: string[] = [
      `${label(t('taskbrowser.agent_type'))}${value(agent.type)}`,
      `${label(t('taskbrowser.status'))}${chalk.hex(agentStatusColor(colors, agent.status))(agentStatusText(agent.status))}${countSuffix}`,
      `${label(t('taskbrowser.agent_source'))}${value(singleLine(formatAgentSource(agent.source)))}`,
      `${label(t('taskbrowser.agent_chain'))}${chalk.hex(colors.textMuted)(formatAgentChain(agent))}`,
    ];
    if (agent.description !== undefined && agent.description.length > 0) {
      lines.push(`${label(t('taskbrowser.description'))}${value(singleLine(agent.description))}`);
    }
    if (agent.detail !== undefined && agent.detail.length > 0) {
      lines.push(`${label(t('taskbrowser.agent_activity'))}${value(singleLine(agent.detail))}`);
    }
    const when = formatRelativeTime(agent.lastActivityAt);
    if (when.length > 0) {
      lines.push(`${label(t('taskbrowser.time'))}${chalk.hex(colors.textMuted)(when)}`);
    }
    if (agent.instanceId !== undefined) {
      lines.push(`${label(t('taskbrowser.agent_instance'))}${chalk.hex(colors.textMuted)(agent.instanceId)}`);
    }

    while (lines.length < innerHeight) lines.push('');
    return this.renderFrame(t('taskbrowser.agent_detail'), lines, width, height);
  }

  private renderPreviewFrame(width: number, height: number): string[] {
    const colors = this.props.colors;
    const innerHeight = Math.max(0, height - 2);

    if (this.props.filter === 'agents') {
      const note = chalk.hex(colors.textMuted)(t('taskbrowser.agents_no_output'));
      const lines: string[] = [note];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Preview Output', lines, width, height);
    }

    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      const lines: string[] = [chalk.hex(colors.textMuted)('No task selected.')];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Preview Output', lines, width, height);
    }

    let body: string;
    if (this.props.tailLoading) body = '[loading…]';
    else if (this.props.tailOutput === undefined || this.props.tailOutput.length === 0)
      body = '[no output captured]';
    else body = sanitizeShellOutput(this.props.tailOutput);

    const rawLines = body.split('\n');
    const tailLines = rawLines.slice(-innerHeight);
    const styled = tailLines.map((line) => chalk.hex(colors.textDim)(line));
    while (styled.length < innerHeight) styled.push('');
    return this.renderFrame('Preview Output', styled, width, height);
  }

  // ── too-small fallback ──────────────────────────────────────────────

  private renderTooSmall(width: number, rows: number): string[] {
    const lines: string[] = [];
    const msg = chalk.hex(this.props.colors.error)(
      `Terminal too small (need ≥ ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)})`,
    );
    lines.push(fitExactly(msg, width));
    for (let i = 1; i < rows; i++) lines.push(' '.repeat(width));
    return lines;
  }
}
