/**
 * ApprovalPanel — pi-tui version of the approval request UI.
 *
 * Container-based component with keyboard navigation.
 */

import { selectedRow } from '../../utils/select-row';
import {
  Container,
  Input,
  matchesKey,
  Key,
  decodeKittyPrintable,
  type Focusable,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { changeFromTexts, renderFileChange, type FileChange } from '#/tui/components/messages/file-change';
import {
  DOCK_FOOTER_ROWS,
  DOCK_STATUS_ROWS,
  PANEL_MIN_TRANSCRIPT_ROWS,
  PIXEL_PULSE_FRAMES,
  PIXEL_PULSE_INTERVAL_MS,
} from '#/tui/constant/rendering';
import type {
  ApprovalPanelChoice,
  DiffDisplayBlock,
  DisplayBlock,
  FileContentDisplayBlock,
  PendingApproval,
} from '#/tui/reverse-rpc/types';
import type { ColorPalette } from '#/tui/theme/colors';
import { motionEnabled } from '#/tui/utils/motion';
import { replaceTabs } from '#/tui/utils/sanitize';

export interface ApprovalPanelResponse {
  readonly response: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled';
  readonly feedback?: string | undefined;
  readonly selected_label?: string | undefined;
}

function truncateOneLine(text: string, max: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
}

const CONTENT_SUMMARY_MAX_LINES = 10;

/**
 * How much of the panel is drawn. The panel replaces the editor, so on a short
 * terminal it must give rows back, and it does so by level. The choices, the
 * question and the key hints stay at every level; the rest yields:
 *  0  roomy: source line, a dashed frame and the unchanged lines around a diff,
 *     a command's description and directory;
 *  1  no frame, only the changed lines of a diff (capped), no directory;
 *  2  no source line, no description; the diff shrinks to whatever is left.
 */
type DetailLevel = 0 | 1 | 2;

/** Changed/context rows a roomy panel draws for a diff, and a folded one. */
const DIFF_ROWS_ROOMY = 12;
const DIFF_ROWS_FOLDED = 8;
const DIFF_ROWS_TIGHT = 6;

interface BlockStyles {
  colors: ColorPalette;
  strong: (s: string) => string;
  dim: (s: string) => string;
  accent: (s: string) => string;
  gutter: (s: string) => string;
  errorBold: (s: string) => string;
}

function makeBlockStyles(colors: ColorPalette): BlockStyles {
  return {
    colors,
    strong: (s) => chalk.hex(colors.textStrong)(s),
    dim: (s) => chalk.hex(colors.textDim)(s),
    accent: (s) => chalk.hex(colors.accent)(s),
    gutter: (s) => chalk.hex(colors.diffGutter)(s),
    errorBold: (s) => chalk.bold.hex(colors.error)(s),
  };
}

function renderDisplayBlock(block: DisplayBlock, s: BlockStyles, level: DetailLevel): string[] {
  switch (block.type) {
    case 'diff':
      // Drawn by the panel (see `diffRows`): it owns the header row and the frame.
      return [];
    case 'file_content': {
      const lang = block.language ?? langFromPath(block.path);
      const content = replaceTabs(block.content);
      const allLines = highlightLines(content, lang, s.colors);
      const cap = level === 0 ? CONTENT_SUMMARY_MAX_LINES : level === 1 ? 6 : 3;
      const shown = allLines.slice(0, cap);
      const lines = [s.strong(block.path)];
      for (const [i, line] of shown.entries()) {
        lines.push(s.gutter(String(i + 1).padStart(4) + '  ') + line);
      }
      const remaining = allLines.length - shown.length;
      if (remaining > 0) {
        lines.push(s.dim(`     ${t('approval.more_lines', { count: String(remaining) })} (ctrl+e)`));
      }
      return lines;
    }
    case 'shell': {
      // The command first, then what a person decides on: the danger, then
      // the notes that can go when the terminal is short.
      const lines: string[] = [];
      const command = replaceTabs(block.command);
      const cmdLines = command.length > 0 ? command.split('\n') : [''];
      const shownCmd = cmdLines.slice(0, level === 0 ? CONTENT_SUMMARY_MAX_LINES : 4);
      shownCmd.forEach((cmdLine, idx) => {
        const prefix = idx === 0 ? s.accent('$') : s.dim('·');
        lines.push(`${prefix} ${s.strong(cmdLine)}`);
      });
      const remainingCmd = cmdLines.length - shownCmd.length;
      if (remainingCmd > 0) {
        lines.push(s.dim(`  ${t('approval.more_lines', { count: String(remainingCmd) })}`));
      }
      if (block.description !== undefined && block.description.length > 0 && level < 2) {
        lines.push(`  ${s.dim(replaceTabs(block.description))}`);
      }
      if (block.cwd !== undefined && block.cwd.length > 0 && level === 0) {
        lines.push(`  ${s.dim(`${t('approval.cwd')} ${block.cwd}`)}`);
      }
      return lines;
    }
    case 'file_op': {
      const op = s.accent(block.operation.padEnd(5));
      const lines = [`${op} ${s.strong(block.path)}`];
      if (block.detail !== undefined && block.detail.length > 0) {
        lines.push(s.dim(block.detail));
      }
      return lines;
    }
    case 'url_fetch': {
      const method = s.accent((block.method ?? 'GET').toUpperCase().padEnd(5));
      return [`${method} ${s.strong(block.url)}`];
    }
    case 'search': {
      const lines = [`${s.accent('search')} ${s.strong(block.query)}`];
      if (block.scope !== undefined && block.scope.length > 0) {
        lines.push(s.dim(`scope: ${block.scope}`));
      }
      return lines;
    }
    case 'invocation': {
      const lines = [`${s.accent(block.kind.padEnd(5))} ${s.strong(block.name)}`];
      if (block.description !== undefined && block.description.length > 0) {
        lines.push(s.dim(truncateOneLine(block.description, 200)));
      }
      return lines;
    }
    case 'brief':
      return block.text
        ? replaceTabs(block.text).split('\n').map((line) => (line.length > 0 ? s.strong(line) : ''))
        : [];
    case 'background_task':
      return [
        s.strong(`${block.status} ${block.kind} task ${block.task_id}: ${block.description}`),
      ];
    case 'todo':
      return block.items.map((item) => s.strong(`- [${item.status}] ${item.title}`));
    default:
      return [];
  }
}

function normalizeApprovalText(text: string): string {
  return replaceTabs(text.replaceAll('\r\n', '\n').trim());
}

function isDuplicateBriefBlock(block: DisplayBlock, description: string): boolean {
  if (block.type !== 'brief' || block.text.trim().length === 0) return false;
  const normalizedDescription = normalizeApprovalText(description);
  if (normalizedDescription.length === 0) return false;
  const normalizedBlockText = normalizeApprovalText(block.text);
  if (normalizedBlockText === normalizedDescription) return true;
  const blockLines = normalizedBlockText.split('\n');
  if (blockLines.length <= 1) return false;
  return normalizeApprovalText(blockLines.slice(1).join('\n')) === normalizedDescription;
}

/** The question the choices answer. */
function headerFor(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return t('approval.header.command');
    case 'Write':
      return t('approval.header.file_write');
    case 'Edit':
      return t('approval.header.file_edit');
    case 'TaskStop':
      return t('approval.header.stop_task');
    case 'ExitPlanMode':
      return t('approval.header.plan');
    default:
      return t('approval.header.generic', { name: toolName });
  }
}

/** What the panel is about, as a noun: the title row. */
function titleFor(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return t('approval.title.command');
    case 'Write':
      return t('approval.title.file_write');
    case 'Edit':
      return t('approval.title.file_edit');
    case 'TaskStop':
      return t('approval.title.stop_task');
    case 'ExitPlanMode':
      return t('approval.title.plan');
    default:
      return toolName;
  }
}

/** `text` cut to `max` columns keeping its end — a path is told apart by its tail. */
function truncateStart(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  let tail = text;
  while (tail.length > 0 && visibleWidth(tail) > max - 1) tail = tail.slice(1);
  return `…${tail}`;
}

export class ApprovalPanelComponent extends Container implements Focusable {
  focused = false;
  private selectedIndex = 0;
  private feedbackMode = false;
  private readonly feedbackInput = new Input();
  private onResponse: (response: ApprovalPanelResponse) => void;
  private request: PendingApproval;
  private readonly colors: ColorPalette;
  private readonly onToggleToolOutput: (() => void) | undefined;
  private readonly onTogglePlanExpand: (() => void) | undefined;
  private readonly onOpenPreview:
    | ((block: DiffDisplayBlock | FileContentDisplayBlock) => void)
    | undefined;
  private readonly ui: TUI | undefined;
  /** Terminal height, read on every render; unknown in tests and previews. */
  private readonly viewportRows: (() => number) | undefined;
  /** The diff of each Edit block, computed once: the pulse repaints the panel every tick. */
  private readonly changes = new WeakMap<DiffDisplayBlock, FileChange | null>();
  private animFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    request: PendingApproval,
    onResponse: (response: ApprovalPanelResponse) => void,
    colors: ColorPalette,
    onToggleToolOutput?: () => void,
    onTogglePlanExpand?: () => void,
    onOpenPreview?: (block: DiffDisplayBlock | FileContentDisplayBlock) => void,
    ui?: TUI,
    viewportRows?: () => number,
  ) {
    super();
    this.viewportRows = viewportRows;
    this.request = request;
    this.onResponse = onResponse;
    this.colors = colors;
    this.onToggleToolOutput = onToggleToolOutput;
    this.onTogglePlanExpand = onTogglePlanExpand;
    this.onOpenPreview = onOpenPreview;
    this.ui = ui;
    this.feedbackInput.onSubmit = (value) => {
      this.submit(this.selectedIndex, value);
    };
    this.feedbackInput.onEscape = () => {
      this.feedbackMode = false;
      this.feedbackInput.setValue('');
    };
    // Tests construct the panel without a TUI: no timer, the indicator
    // stays on the first frame so snapshots stay deterministic.
    // Motion off: the indicator stays on its first frame too.
    if (this.ui !== undefined && motionEnabled()) {
      this.intervalId = setInterval(() => {
        this.animFrame = (this.animFrame + 1) % PIXEL_PULSE_FRAMES.length;
        this.ui?.requestRender();
      }, PIXEL_PULSE_INTERVAL_MS);
    }
  }

  /** Stop the selection pulse. Idempotent; called on submit and on hide. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private submit(index: number, feedback: string = ''): void {
    const option = this.choiceAt(index);
    if (!option) return;
    this.stop();
    this.onResponse({
      response: option.response,
      feedback: feedback || undefined,
      selected_label: option.selected_label,
    });
  }

  private selectAndSubmit(index: number): void {
    const option = this.choiceAt(index);
    if (!option) return;
    if (option.requires_feedback === true) {
      this.selectedIndex = index;
      this.feedbackMode = true;
    } else {
      this.submit(index);
    }
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.stop();
      this.onResponse({ response: 'rejected' });
      return;
    }

    if (matchesKey(data, Key.ctrl('e'))) {
      const previewable = this.findPreviewableBlock();
      if (previewable !== undefined && this.onOpenPreview !== undefined) {
        this.onOpenPreview(previewable);
      } else {
        this.onTogglePlanExpand?.();
      }
      return;
    }

    if (matchesKey(data, Key.ctrl('o'))) {
      this.onToggleToolOutput?.();
      return;
    }

    if (this.feedbackMode) {
      if (matchesKey(data, Key.up)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.feedbackMode = false;
        this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
        return;
      }
      this.feedbackInput.handleInput(data);
      return;
    }

    if (this.choiceCount() === 0) return;
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + this.choiceCount()) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % this.choiceCount();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.selectAndSubmit(this.selectedIndex);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      // A note travels with a refusal only: the core hands it to the model as
      // the reason, and drops one sent with an approval.
      if (this.selectedChoiceRejects()) this.feedbackMode = true;
      return;
    }

    const printable = decodeKittyPrintable(data) ?? data;
    const numericIndex = Number(printable) - 1;
    if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < this.choiceCount()) {
      this.selectAndSubmit(numericIndex);
    }
  }

  override render(width: number): string[] {
    this.clear();
    this.ensureValidSelection();
    this.feedbackInput.focused = this.focused && this.feedbackMode;

    const budget = this.rowBudget();
    // The roomiest level that fits; the last one shrinks the diff until it does.
    for (const level of [0, 1] as const) {
      const lines = this.compose(width, level, level === 0 ? DIFF_ROWS_ROOMY : DIFF_ROWS_FOLDED);
      if (lines.length <= budget) return lines;
    }
    let limit = DIFF_ROWS_TIGHT;
    let lines = this.compose(width, 2, limit);
    while (lines.length > budget && limit > 0) {
      limit -= 1;
      lines = this.compose(width, 2, limit);
    }
    // Still over (a command with a warning on a very short terminal): the
    // closing rule is the one row that carries nothing.
    if (lines.length > budget) lines.pop();
    return lines;
  }

  /** Rows the panel may take: the terminal minus the dock below it and a few transcript rows above. */
  private rowBudget(): number {
    const rows = this.viewportRows?.();
    if (rows === undefined || !Number.isFinite(rows)) return Number.POSITIVE_INFINITY;
    return Math.max(6, rows - DOCK_STATUS_ROWS - DOCK_FOOTER_ROWS - PANEL_MIN_TRANSCRIPT_ROWS);
  }

  private compose(width: number, level: DetailLevel, diffLimit: number): string[] {
    const { data } = this.request;
    const blockStyles = makeBlockStyles(this.colors);
    // Frame and focus share the brand fluorescent green: pastel borderFocus
    // reads muddy on dark terminals, so the bars/title/indicator all use
    // the vivid primary — hierarchy comes from bold and the pulse, not hue.
    const borderColor = chalk.hex(this.colors.primary);
    const borderColorBold = chalk.bold.hex(this.colors.primary);
    const dim = chalk.hex(this.colors.textDim);
    const strong = chalk.hex(this.colors.textStrong);
    const horizontalBar = borderColor('─'.repeat(width));
    const indent = (s: string): string => `  ${s}`;
    const inner = Math.max(width - 4, 1);

    const dedupedBlocks = data.display.filter(
      (block) => !isDuplicateBriefBlock(block, data.description),
    );
    const visibleBlocks = dedupedBlocks.slice(0, 5);
    const hasPreviewable = visibleBlocks.some(
      (block) => block.type === 'diff' || block.type === 'file_content',
    );
    const diffBlock = visibleBlocks.find((block): block is DiffDisplayBlock => block.type === 'diff');
    const change = diffBlock === undefined ? undefined : this.changeOf(diffBlock);

    // Title: the noun, then — for an edit — which file and how much changed.
    const title = borderColorBold(titleFor(data.tool_name));
    let titleRow: string;
    if (diffBlock !== undefined && change !== undefined) {
      const added = change.rows.filter((row) => row.kind === 'add').length;
      const removed = change.rows.filter((row) => row.kind === 'delete').length;
      const counts = `${chalk.bold.hex(this.colors.diffAddedStrong)(`+${String(added)}`)} ${chalk.bold.hex(this.colors.diffRemovedStrong)(`-${String(removed)}`)}`;
      const left = `${title}  `;
      const room = Math.max(width - 4 - visibleWidth(left) - visibleWidth(counts) - 2, 4);
      const path = strong(truncateStart(diffBlock.path, room));
      const gap = Math.max(1, width - 4 - visibleWidth(left) - visibleWidth(path) - visibleWidth(counts));
      titleRow = indent(`${left}${path}${' '.repeat(gap)}${counts}`);
    } else {
      titleRow = indent(title);
    }
    const lines: string[] = [horizontalBar, titleRow];

    // One quiet line for where it came from and what was asked.
    if (level < 2) {
      const meta: string[] = [];
      if (data.source_label !== undefined && data.source_label.length > 0) meta.push(data.source_label);
      if (data.request_summary !== undefined && data.request_summary.length > 0) {
        meta.push(`${t('approval.request_summary')} ${replaceTabs(data.request_summary)}`);
      }
      if (meta.length > 0) lines.push(indent(dim(truncateToWidth(meta.join('  ·  '), inner))));
    }

    // What is shown: the diff (or the other blocks), then the warnings.
    const body: string[] = [];
    if (diffBlock !== undefined && change !== undefined && diffLimit > 0) {
      const view = level === 0 ? 'expanded' : 'folded';
      const dashes = level === 0 ? [chalk.hex(this.colors.border)('╌'.repeat(inner))] : [];
      body.push(...dashes);
      for (const row of renderFileChange(change, view, diffLimit, inner, this.colors)) body.push(row);
      body.push(...dashes);
    }
    for (const block of visibleBlocks) {
      if (block.type === 'diff') continue;
      body.push(...renderDisplayBlock(block, blockStyles, level));
    }
    if (visibleBlocks.length === 0 && data.description) {
      for (const descLine of data.description.split('\n')) body.push(dim(descLine));
    }
    const warning = chalk.hex(this.colors.warning);
    const reasons = data.reasons ?? [];
    if (reasons.length === 1) {
      body.push(warning(t('approval.warning_line', { reason: truncateToWidth(replaceTabs(reasons[0]!), Math.max(inner - 8, 1)) })));
    } else if (reasons.length > 1) {
      body.push(warning(t('approval.warnings_title')));
      for (const reason of reasons) {
        body.push(warning(`· ${truncateToWidth(replaceTabs(reason), Math.max(inner - 2, 1))}`));
      }
    }
    for (const block of visibleBlocks) {
      if (block.type === 'shell' && block.danger !== undefined) {
        body.push(blockStyles.errorBold(t('approval.danger', { reason: block.danger })));
      }
    }
    for (const line of body) lines.push(indent(line));

    // The question sits right above the choices it is asked of.
    lines.push(indent(chalk.bold.hex(this.colors.textStrong)(headerFor(data.tool_name))));
    for (let idx = 0; idx < data.choices.length; idx++) {
      const option = data.choices[idx];
      if (option === undefined) continue;
      const isSelected = idx === this.selectedIndex;
      const num = idx + 1;

      const labelWithNum = `${String(num)}. ${option.label}`;
      if (this.feedbackMode && isSelected) {
        lines.push(selectedRow(this.colors, indent(this.renderInlineFeedbackLine(width - 2, labelWithNum)), width));
      } else if (isSelected) {
        // The shared selection bar; the pointer is the breathing pixel block
        // instead of ❯, since this panel is waiting on the person.
        const indicator = chalk.hex(this.colors.primary)(PIXEL_PULSE_FRAMES[this.animFrame]!);
        const selectedLabel = chalk.bold.hex(this.colors.primary)(labelWithNum);
        lines.push(selectedRow(this.colors, indent(`${indicator} ${selectedLabel}`), width));
      } else {
        lines.push(indent(dim(`  ${labelWithNum}`)));
      }
    }

    if (this.feedbackMode) {
      lines.push(indent(dim(t('approval.feedback_hint'))));
    } else {
      const parts = [
        t('approval.hint.select'),
        t('approval.hint.choose', { keys: buildNumericHint(data.choices.length) }),
        t('approval.hint.confirm'),
        t('approval.hint.reject'),
      ];
      if (this.selectedChoiceRejects() && level < 2) parts.push(t('approval.hint.note'));
      if (hasPreviewable && level < 2) parts.push(t('approval.hint.preview'));
      lines.push(indent(dim(parts.join(' · '))));
    }
    lines.push(horizontalBar);

    return lines.map((line) => truncateToWidth(line, width));
  }

  /** The Edit block as the activity block draws it, once per block. */
  private changeOf(block: DiffDisplayBlock): FileChange | undefined {
    const known = this.changes.get(block);
    if (known !== undefined) return known ?? undefined;
    const change = changeFromTexts(replaceTabs(block.old_text), replaceTabs(block.new_text), {
      path: block.path,
      oldStart: block.old_start,
      newStart: block.new_start,
    });
    this.changes.set(block, change ?? null);
    return change;
  }

  private selectedChoiceRejects(): boolean {
    return this.choiceAt(this.selectedIndex)?.response === 'rejected';
  }

  private findPreviewableBlock(): DiffDisplayBlock | FileContentDisplayBlock | undefined {
    for (const block of this.request.data.display) {
      if (block.type === 'diff' || block.type === 'file_content') return block;
    }
    return undefined;
  }

  private choiceAt(index: number): ApprovalPanelChoice | undefined {
    return this.request.data.choices[index];
  }

  private choiceCount(): number {
    return this.request.data.choices.length;
  }

  private ensureValidSelection(): void {
    const count = this.choiceCount();
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedIndex < 0 || this.selectedIndex >= count) {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, count - 1));
    }
  }

  private renderInlineFeedbackLine(width: number, labelWithNum: string): string {
    const indicator = chalk.hex(this.colors.primary)(PIXEL_PULSE_FRAMES[this.animFrame]!);
    const selectedLabel = chalk.bold.hex(this.colors.primary)(labelWithNum);
    const prefix = `${indicator} ${selectedLabel}  `;
    const inputWidth = Math.max(4, width - visibleWidth(prefix) + 2);
    const inputLine = this.feedbackInput.render(inputWidth)[0] ?? '> ';
    const inlineInput = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine;
    return prefix + inlineInput;
  }

  override invalidate(): void {
    super.invalidate();
    this.feedbackInput.invalidate();
  }
}

function buildNumericHint(count: number): string {
  if (count <= 0) return '↵';
  return Array.from({ length: Math.min(count, 9) }, (_, idx) => String(idx + 1)).join('/');
}
