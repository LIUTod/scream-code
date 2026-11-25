/**
 * ActivityGroupComponent compacts one turn's reasoning and tool calls into a
 * single block: a header plus the newest steps of the timeline while collapsed,
 * and — while expanded — the timeline itself, reasoning runs and tool calls
 * interleaved in the order they happened with per-tool result previews: the
 * newest steps while the turn is still running, the whole timeline in order
 * once it settles.
 *
 * Rows follow the work rather than the tool type: each reasoning run stays next
 * to the tools it produced, so the block reads as a timeline instead of one
 * merged reasoning summary appended below every tool call.
 *
 * Design:
 * - Borrowed ToolCallComponents keep all of their state; the group never mounts
 *   them as children and only renders their own header row plus a short preview
 *   of their own rendered body. Group rows therefore always match the
 *   standalone cards, including their chips and expansion-independent previews.
 * - Child-driven refreshes are throttled (200ms); lifecycle changes (attaching a
 *   card, turn end, expand toggle) flush immediately so the visible state never
 *   lags a user action.
 * - The header carries the live reasoning rate (toks/s) the standalone thinking
 *   row used to show, sourced from the shared speed tracker.
 */

import { changeRowCount, fileChangeOf, renderFileChange, type FileChange } from './file-change';
import type { Component, TUI } from '@liutod-scream/pi-tui';
import { Container, getCapabilities, getImageDimensions, Spacer, Text, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import {
  ACTIVITY_GROUP_EXPANDED_LINES,
  ACTIVITY_GROUP_TOOL_PREVIEW_LINES,
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
} from '#/tui/constant/rendering';
import { spinnerPeriodMs } from '#/tui/utils/motion';
import { renderBackgroundStatus } from './background-agent-status';
import { getActivityLines } from '#/tui/utils/activity-lines';

import type { BackgroundAgentStatusData } from '#/tui/types';
import type { ApprovalNoticeTone } from '#/tui/utils/approval-notice';
import { DONE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import { lerpHex } from '#/tui/utils/gradient';
import {
  easeSpeedRatio,
  getSharedSpeedTracker,
  SPEED_MAX,
} from '#/tui/utils/speed-tracker';

import { createImageComponent } from '#/tui/components/media/image-thumbnail';
import type { ToolCallComponent } from './tool-call';
import { replaceTabs, sanitizeShellOutput } from '#/tui/utils/sanitize';
import { parseReadMediaOutput } from './tool-renderers/media';
import { strArg } from './tool-renderers/types';
import { WrappedLine } from './wrapped-line';

/** Visible width of the tree prefixes (`  ├─ `) reserved for each row. */
const BRANCH_WIDTH = 5;
/** Visible width of a row's status glyph plus its trailing space. */
const STATUS_WIDTH = 2;
const BRANCH_FIRST = '  ├─ ';
const BRANCH_LAST = '  └─ ';
const BRANCH_PIPE = '  │  ';
const BRANCH_CORNER = '  └  ';
const TREE_PIPE_ROW = '  │';
/**
 * Extra indent shared by every body row of a block. File and diff bodies
 * reserve three cells for their line-number gutter (`   1  /**`), so tool
 * bodies, reasoning rows and hints all start at that same content column
 * instead of sitting three cells to its left.
 */
const BODY_TEXT_INDENT = '   ';
/** Result lines (warnings, diagnostics) kept under an expanded change. */
const CHANGE_NOTE_LINES = 3;
/** Cells of a background task notice bullet (`⠋ ` / `✓ ` / `✗ `). */
const NOTICE_BULLET_WIDTH = 2;
const THROTTLE_MS = 200;
/** Rates below this are noise: the live badge stays hidden until tokens flow. */
const MIN_RATE = 0.05;
const SEPARATOR = ' · ';
/** The card renders a two-cell status marker the row prefix accounts for. */
const CARD_MARKERS = ['■', '✗', '▸', '●', '○', '⊙', '◐'];
const CARD_MARKER_AT_START_RE = new RegExp(`^(?:\\u001b\\[[0-9;]*m)*(?:${CARD_MARKERS.join('|')}) `);
const CARD_MARKER_CHAR_RE = new RegExp(`^(?:\\u001b\\[[0-9;]*m)*(${CARD_MARKERS.join('|')}) `);
const CARD_INDENT_RE = /^(\u001B\[[0-9;]*m)*( {2})/;

/**
 * One step of the block's timeline: either a reasoning run (kept as the text it
 * streamed) or a borrowed tool card. The array order is the order the work
 * happened in, which is what the block renders.
 */
type BlockSegment =
  | { readonly kind: 'thinking'; text: string; live: boolean }
  | {
      readonly kind: 'tool';
      readonly tc: ToolCallComponent;
      readonly step: number | undefined;
      /** The call's id, so an approval can be filed under the call it allowed. */
      readonly callId: string | undefined;
    }
  // Background task lifecycle rows (started / completed / failed). They are part
  // of the work a turn produced, so they take a step of the same timeline
  // instead of sitting in the transcript as messages of their own.
  | { readonly kind: 'notice'; readonly data: BackgroundAgentStatusData }
  // Approval outcomes (approved / rejected / cancelled) for the same reason: the
  // approval belongs to the call that asked for it, and a step of the block is
  // bounded by the block's row budget instead of piling up one row per approval.
  | {
      readonly kind: 'approval';
      readonly label: string;
      readonly detail: string;
      readonly tone: ApprovalNoticeTone;
    }
  // A notice the work raised while it ran (a background command finished, a
  // skill was activated, the reply was cut at the output limit): one row of
  // the timeline, so it never lands below the block and pushes it up.
  | { readonly kind: 'note'; readonly text: string; readonly tone: BlockNoteTone };

/** How a note row reads: quiet, a warning, or a failure. */
export type BlockNoteTone = 'info' | 'warning' | 'error';

/** One pre-rendered line that must reach the terminal as is (an image escape). */
class RawLine implements Component {
  constructor(private readonly line: string) {}
  render(): string[] {
    return [this.line];
  }
  invalidate(): void {}
}

const KITTY_IMAGE = '\u001B_G';
const ITERM_IMAGE = '\u001B]1337;File=';
function isImageLine(line: string): boolean {
  return line.includes(KITTY_IMAGE) || line.includes(ITERM_IMAGE);
}

/** Segment render rows plus how many block rows they consume. */
interface SegmentRows {
  readonly components: Component[];
  readonly cost: number;
}

interface ToolRow {
  readonly header: string;
  readonly body: string[];
  readonly done: boolean;
  readonly failed: boolean;
  readonly aborted: boolean;
}

/** Non-empty, trimmed lines of one reasoning run. */
function thinkingLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Drops the card's own two-cell status marker so a row prefix can take its
 * place without shifting the row.
 */
function stripCardMarker(line: string): string {
  return line.replace(CARD_MARKER_AT_START_RE, '');
}

/** The card's own marker glyph, used to mirror its status in the row. */
function cardMarkerChar(line: string): string | undefined {
  return CARD_MARKER_CHAR_RE.exec(line)?.[1];
}

/** Drops the card's own two-space continuation indent (ANSI-aware). */
function stripCardIndent(line: string): string {
  return line.replace(CARD_INDENT_RE, '');
}

const ANSI_RE = /\u001B\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * What an Edit / Write result says beyond its summary line ("Replaced 1
 * occurrence in …", "Wrote … bytes to …"): the sections after the first,
 * line by line — a stale-read warning, the language server's report.
 */
function changeNotes(output: string): string[] {
  return output
    .split(/\r?\n\s*\r?\n/)
    .slice(1)
    .flatMap((section) => section.split(/\r?\n/))
    .map((line) => sanitizeShellOutput(replaceTabs(line)).trimEnd())
    .filter((line) => line.trim().length > 0);
}

/** Paths deep enough to be worth shortening to their last two segments. */
function shortenPathArgument(value: string): string {
  const parts = value.split('/').filter((part) => part.length > 0);
  if (parts.length <= 2) return value;
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * Splits a shell command on separators outside quotes, so an SQL `||` or a
 * quoted `;` is not mistaken for a pipeline boundary.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '|' || char === '&') {
      const isDouble = (char === '&' || char === '|') && command[index + 1] === char;
      segments.push(current);
      current = '';
      if (isDouble) index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/**
 * Last segment of a shell command. `cd X && sqlite3 …` is about the query, not
 * about changing directory, so the recap keeps the action instead of the setup.
 */
function clipShellCommand(command: string): string {
  const segments = splitShellSegments(command);
  return segments.at(-1) ?? command.trim();
}

/** Tools whose first argument is a file path worth shortening. */
const PATH_ARGUMENT_TOOLS = new Set(['Edit', 'Write', 'Read', 'ReadMediaFile']);

/**
 * Short recap of a tool call for a grouped row, built from the tool's own
 * arguments when they name the thing that matters (a command, a path, a
 * pattern, a URL) and from the card's rendered argument blob otherwise. The
 * card's verb, tool name and chip are left untouched, so grouping stays
 * consistent with the standalone card.
 */
function summarizeArguments(
  toolName: string,
  args: Record<string, unknown>,
  rawArgsFallback: string,
): string {
  const collapse = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
  const command = strArg(args, 'command');
  if (toolName === 'Bash' && command.length > 0) return clipShellCommand(collapse(command));
  const path = strArg(args, 'file_path', 'path');
  if (PATH_ARGUMENT_TOOLS.has(toolName) && path.length > 0) return shortenPathArgument(path);
  const pattern = strArg(args, 'pattern');
  if (pattern.length > 0) return collapse(pattern);
  const url = strArg(args, 'url');
  if (url.length > 0) return url.replace(/^https?:\/\//, '').split(/[?#]/)[0] ?? url;
  const collapsed = collapse(rawArgsFallback);
  return collapsed;
}

/**
 * Splits the card's rendered `(arguments)` blob from its trailing chip using the
 * parenthesis that actually closes the arguments, so a chip that contains
 * parentheses (`image (image/png, 300 KB)`) is not swallowed as an argument.
 */
function splitArgumentsBlob(rest: string): { rawArgs: string; tail: string } {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index] as string;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) return { rawArgs: rest.slice(0, index), tail: rest.slice(index + 1) };
      depth -= 1;
    }
  }
  // Unbalanced: the header was truncated at the render width, so it is all args.
  return { rawArgs: rest, tail: '' };
}

/**
 * Rebuilds a card header as `verb name · short arguments · chip`, keeping the
 * trailing chip (elapsed time, line counts, status) so a grouped row states what
 * ran without repeating an entire command line.
 */
function condenseRowLabel(
  header: string,
  toolName: string,
  args: Record<string, unknown>,
  budget: number,
): string {
  const open = header.indexOf('(');
  if (open < 0) return header;
  const head = header.slice(0, open).trimEnd();
  const { rawArgs, tail } = splitArgumentsBlob(header.slice(open + 1));
  const argsSummary = summarizeArguments(toolName, args, stripAnsi(rawArgs));
  if (argsSummary.length === 0) return `${head}${tail}`;
  const fixed = visibleWidth(head) + visibleWidth(SEPARATOR) + visibleWidth(tail);
  const argumentsBudget = budget - fixed;
  if (argumentsBudget < 6) return header;
  return `${head}${SEPARATOR}${chalk.dim(truncateToWidth(argsSummary, argumentsBudget, '…'))}${tail}`;
}

export class ActivityGroupComponent extends Container {
  private readonly segments: BlockSegment[] = [];
  private readonly steps = new Set<number>();
  private running = true;
  private expanded = false;
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  private spinnerFrame = 0;
  private lastSpinnerTickAt = 0;
  /** Frame period for this animation run (see utils/motion); set when it starts. */
  private spinnerPeriod = BRAILLE_SPINNER_INTERVAL_MS;
  private renderedWidth: number | undefined;
  /** Reasoning text already shown when a notice interrupted the newest run. */
  private interruptedThinking: { text: string; length: number } | undefined;
  /** Thumbnails of image reads, made once: an image is costly to encode on every repaint. */
  private readonly thumbnails = new WeakMap<ToolCallComponent, Component | null>();

  constructor(
    private readonly colors: ColorPalette,
    private readonly ui: TUI | undefined,
  ) {
    super();
    this.addChild(new Spacer(1));
    this.headerText = new Text('', 0, 0);
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
    this.startSpinner();
  }

  /** True when the group owns neither reasoning nor tool calls nor approvals. */
  isEmpty(): boolean {
    return this.segments.every(
      (segment) => segment.kind === 'thinking' && segment.text.trim().length === 0,
    );
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  /** The borrowed cards, in timeline order (lookups by subagent id walk them). */
  getToolComponents(): ToolCallComponent[] {
    const cards: ToolCallComponent[] = [];
    for (const segment of this.segments) if (segment.kind === 'tool') cards.push(segment.tc);
    return cards;
  }

  /**
   * Borrows a tool card as a hidden state container. Re-attaching the same
   * card is a no-op. `callId` is what later lets an approval be filed under the
   * call it allowed.
   */
  attachTool(tc: ToolCallComponent, step: number | undefined, callId?: string): void {
    if (this.segments.some((segment) => segment.kind === 'tool' && segment.tc === tc)) return;
    this.segments.push({ kind: 'tool', tc, step, callId });
    if (step !== undefined) this.steps.add(step);
    tc.setExpanded(this.expanded);
    tc.setSnapshotListener(() => {
      this.scheduleFlush();
    });
    this.flushNow();
  }

  /** Adds a background task notice as the newest step of the timeline. */
  attachNotice(data: BackgroundAgentStatusData): void {
    this.splitLiveThinking();
    this.segments.push({ kind: 'notice', data });
    this.flushNow();
  }

  /**
   * Adds an approval outcome as the step directly under the call it allowed, so
   * a run of approved calls reads as call/approval pairs. Returns false when
   * that call has no row here — a subagent's call, a card that stays standalone
   * — leaving the caller to decide where the outcome goes.
   */
  attachApproval(
    callId: string,
    label: string,
    detail: string,
    tone: ApprovalNoticeTone,
  ): boolean {
    const index = this.segments.findIndex(
      (segment) => segment.kind === 'tool' && segment.callId === callId,
    );
    if (index < 0) return false;
    this.segments.splice(index + 1, 0, { kind: 'approval', label, detail, tone });
    this.flushNow();
    return true;
  }

  /** Adds a note as the newest step of the timeline. */
  attachNote(text: string, tone: BlockNoteTone): void {
    this.splitLiveThinking();
    this.segments.push({ kind: 'note', text, tone });
    this.flushNow();
  }

  /**
   * Adds an approval outcome as the newest step, for a call that has no row
   * here (a subagent's call): the outcome still belongs to this stretch of
   * work, so it is a step of it rather than a row below the block.
   */
  appendApproval(label: string, detail: string, tone: ApprovalNoticeTone): void {
    this.splitLiveThinking();
    this.segments.push({ kind: 'approval', label, detail, tone });
    this.flushNow();
  }

  /**
   * A step landing mid-reasoning splits the run in two: the part that already
   * streamed is closed and its length remembered, so the continuation keeps only
   * what is new instead of repeating the whole run.
   */
  private splitLiveThinking(): void {
    const last = this.segments.at(-1);
    if (last === undefined || last.kind !== 'thinking' || !last.live) return;
    last.live = false;
    this.interruptedThinking = { text: last.text, length: last.text.length };
  }

  /**
   * Appends to the reasoning run streaming right now, opening a new step of the
   * timeline when the last step is a tool call or a reasoning run that already
   * ended. `live` drives the streaming rate in the header.
   */
  appendThinking(text: string, live: boolean): void {
    // The run text is cumulative and a notice may have split the run in two: for
    // as long as the prefix that already streamed is still there, only the new
    // part belongs to this row. The offset survives every flush of the run and is
    // dropped in `endThinking`/`setRunning(false)`.
    const interrupted = this.interruptedThinking;
    const split = interrupted !== undefined && text.startsWith(interrupted.text);
    if (interrupted !== undefined && !split) this.interruptedThinking = undefined;
    const body = split && interrupted !== undefined ? text.slice(interrupted.length) : text;

    const last = this.segments.at(-1);
    if (
      last !== undefined &&
      last.kind === 'thinking' &&
      (last.live || last.text.trim().length === 0)
    ) {
      if (last.text === body && last.live === live) return;
      const structureChanged = body.length === 0 !== (last.text.length === 0);
      last.text = body;
      last.live = live;
      // Reasoning appearing or disappearing changes the row count, so it must not
      // wait for the next throttled tick; growing text can.
      if (structureChanged) this.flushNow();
      else this.scheduleFlush();
      return;
    }
    // An empty draft must not materialise a row of its own.
    if (body.trim().length === 0) return;
    this.segments.push({ kind: 'thinking', text: body, live });
    this.flushNow();
  }

  endThinking(): void {
    // The run is over: a later draft is a new one and must not be shortened.
    this.interruptedThinking = undefined;
    const last = this.segments.at(-1);
    if (last === undefined || last.kind !== 'thinking' || !last.live) return;
    last.live = false;
    this.flushNow();
  }

  /** Marks the producing turn as finished: the header stops spinning. */
  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    if (running) this.startSpinner();
    else {
      this.stopSpinner();
      // A settled block must not claim live reasoning: the rate slot and the
      // "earlier lines" wording both key off the newest run's live flag. The
      // split offset goes with it — any later draft is a new run.
      this.interruptedThinking = undefined;
      const last = this.segments.at(-1);
      if (last !== undefined && last.kind === 'thinking') last.live = false;
    }
    this.flushNow();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    // Borrowed cards render their own previews: expanding the block must deepen
    // them too, otherwise grouping would hide output the card used to show.
    for (const segment of this.segments) {
      if (segment.kind === 'tool') segment.tc.setExpanded(expanded);
    }
    this.flushNow();
  }

  /** Repaints after a borrowed card changed (results land via setResult). */
  notifyToolChanged(): void {
    this.flushNow();
  }

  /** Releases the group's timers. Borrowed cards stay owned by their caller. */
  dispose(): void {
    this.stopSpinner();
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  override render(width: number): string[] {
    if (this.isEmpty()) return [];
    if (this.renderedWidth !== width) this.rebuild(width);
    return super.render(width);
  }

  /**
   * Forces the cached rows to be rebuilt on the next render. The transcript
   * container invalidates every child on theme changes, but the group renders
   * pre-composed row strings (including the borrowed cards' own colours), so it
   * must rebuild instead of only re-rendering the cached children. The borrowed
   * cards are not container children either, so they are invalidated here too.
   */
  override invalidate(): void {
    this.renderedWidth = undefined;
    for (const segment of this.segments) {
      if (segment.kind === 'tool') segment.tc.invalidate();
    }
    super.invalidate();
  }

  private scheduleFlush(): void {
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.rebuild(this.renderedWidth ?? 80);
      this.ui?.requestRender();
    }, THROTTLE_MS);
  }

  private flushNow(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.rebuild(this.renderedWidth ?? 80);
    this.ui?.requestRender();
  }

  private rebuild(width: number): void {
    // Assign the width AFTER the invalidation so the cached width stays valid:
    // calling this.invalidate() here would clear it and force a full rebuild on
    // every single render.
    super.invalidate();
    this.renderedWidth = width;
    this.headerText.setText(this.buildHeader(width));
    this.bodyContainer.clear();
    if (this.expanded) this.buildExpandedRows(width);
    else this.buildCollapsedRows(width);
  }

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------

  /**
   * Aggregate diff of the group's finished, successful file mutations
   * (Edit/Write), shown in the header. Read-only tools contribute nothing;
   * failed attempts changed nothing, so only successful calls count.
   * `removed` stays undefined when any contributor could not report its
   * deletions (replayed records carry no display payload): summing a partial
   * number would claim a deletion count the group never measured.
   */
  private diffTotals(): { added: number; removed: number | undefined } | undefined {
    let added = 0;
    let removed = 0;
    let removedKnown = true;
    let seen = false;
    for (const segment of this.segments) {
      if (segment.kind !== 'tool') continue;
      const contribution = segment.tc.diffContribution();
      if (contribution === undefined) continue;
      seen = true;
      added += contribution.added;
      if (contribution.removed === undefined) removedKnown = false;
      else removed += contribution.removed;
    }
    if (!seen) return undefined;
    return { added, removed: removedKnown ? removed : undefined };
  }

  private buildHeader(width: number): string {
    const colors = this.colors;
    const frame = BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0];
    const marker = this.running
      ? chalk.hex(colors.roleThinking)(`${frame} `)
      : chalk.hex(colors.success)(STATUS_BULLET);
    const label = this.running ? t('activitygroup.running') : t('activitygroup.done');

    const parts: string[] = [];
    const toolCount = this.toolCount();
    if (this.steps.size > 0) parts.push(t('activitygroup.steps', { count: String(this.steps.size) }));
    if (toolCount > 0) parts.push(t('activitygroup.tools', { count: String(toolCount) }));
    const stats = chalk.dim(SEPARATOR + parts.join(SEPARATOR));

    // Aggregate diff of the group's successful file mutations (Edit/Write).
    // Failed attempts changed nothing and count zero; a read-only group omits
    // the segment entirely.
    const diff = this.diffTotals();
    const diffPart = diff
      ? SEPARATOR +
        (diff.removed === undefined
          ? t('activitygroup.diffAddedOnly', {
              added: chalk.hex(colors.diffAdded)(`+${diff.added}`),
            })
          : t('activitygroup.diff', {
              added: chalk.hex(colors.diffAdded)(`+${diff.added}`),
              removed: chalk.hex(colors.diffRemoved)(`-${diff.removed}`),
            }))
      : '';

    // The rate slot is always present: a dash keeps the header width stable and
    // tells the user the meter is idle rather than missing.
    const speed = this.liveThinking() ? getSharedSpeedTracker().getSpeed() : 0;
    const rate =
      speed > MIN_RATE
        ? chalk.hex(
            lerpHex(colors.textDim, colors.primary, easeSpeedRatio(speed / SPEED_MAX)),
          )(t('activitygroup.rate', { rate: speed.toFixed(1) }))
        : chalk.dim(t('activitygroup.rate', { rate: '-' }));

    const hint = chalk.dim(
      this.expanded ? t('activitygroup.hint_collapse') : t('activitygroup.hint_expand'),
    );
    // Drop the optional tail on narrow terminals instead of letting the header
    // wrap into a second row: a collapsed header occupies exactly one row.
    const head = `${marker}${chalk.hex(colors.primary).bold(label)}${stats}`;
    const withRate = `${head}${diffPart}${rate}`;
    const full = `${withRate}${hint}`;
    if (visibleWidth(full) <= width) return full;
    if (visibleWidth(withRate) <= width) return withRate;
    if (visibleWidth(head) <= width) return head;
    // Extremely narrow: drop the statistics, then clip the label. The label is
    // plain text here, so clipping never cuts an escape sequence.
    const bare = `${marker}${chalk.hex(colors.primary).bold(label)}`;
    if (visibleWidth(bare) <= width) return bare;
    return chalk.hex(colors.primary).bold(truncateToWidth(label, Math.max(1, width - 2), '…'));
  }

  /**
   * Collapsed state: the newest steps of the timeline, kept in chronological
   * order so the block still reads top-down. Reasoning runs, tool calls and the
   * inline edit previews (the changed lines under an Edit / Write row) share
   * one row budget, filled from the newest step back: every edit shows its
   * preview, cut to what is left (the newest even with a single row left).
   * Previews stay inside the tree: under the last row the tree goes on as a
   * pipe and closes with a corner on the preview's last line.
   */
  private buildCollapsedRows(width: number): void {
    const { collapsed, editPreview } = getActivityLines();
    let rowsLeft = Math.max(1, collapsed - 1);
    const picked: {
      segment: BlockSegment;
      preview: FileChange | undefined;
      previewRows: number;
      /** What a running subagent is doing, one row under its own. */
      live: string | undefined;
    }[] = [];
    let previewGiven = false;
    for (let index = this.segments.length - 1; index >= 0 && rowsLeft > 0; index -= 1) {
      const segment = this.segments[index] as BlockSegment;
      rowsLeft -= 1;
      let preview: FileChange | undefined;
      let previewRows = 0;
      if (segment.kind === 'tool' && editPreview > 0 && rowsLeft > 0) {
        preview = fileChangeOf(segment.tc.toolCallView, segment.tc.resultView);
        if (preview !== undefined) {
          const wanted = changeRowCount(preview, 'folded', editPreview);
          if (wanted <= rowsLeft) {
            previewRows = editPreview;
          } else if (!previewGiven || rowsLeft >= 2) {
            // Cut to what is left, one row kept for the "… N more" count; the
            // newest edit keeps a preview even when only one row is left.
            previewRows = Math.max(1, rowsLeft - 1);
          }
          if (previewRows > 0) {
            rowsLeft -= Math.min(rowsLeft, changeRowCount(preview, 'folded', previewRows));
            previewGiven = true;
          } else {
            preview = undefined;
          }
        }
      }
      let live: string | undefined;
      if (segment.kind === 'tool' && rowsLeft > 0) {
        live = this.agentActivity(segment.tc);
        if (live !== undefined) rowsLeft -= 1;
      }
      picked.push({ segment, preview, previewRows, live });
    }
    picked.reverse();
    picked.forEach(({ segment, preview, previewRows, live }, index) => {
      const isLast = index === picked.length - 1;
      if (segment.kind === 'tool') {
        const row = this.toolRow(segment.tc, width, ACTIVITY_GROUP_TOOL_PREVIEW_LINES, !this.running);
        const lines =
          preview === undefined
            ? []
            : renderFileChange(preview, 'folded', previewRows, width - BRANCH_PIPE.length, this.colors);
        if (live !== undefined) {
          const textWidth = Math.max(1, width - BRANCH_PIPE.length - BODY_TEXT_INDENT.length);
          lines.push(`${BODY_TEXT_INDENT}${chalk.hex(this.colors.textDim)(truncateToWidth(live, textWidth, '…'))}`);
        }
        // A last row with a preview keeps the tree open (├─ / │) and closes it
        // on the preview's last line, so the changed lines sit inside the frame.
        this.bodyContainer.addChild(
          new Text(
            `${isLast && lines.length === 0 ? BRANCH_LAST : BRANCH_FIRST}${this.statusGlyph(row)} ${row.header}`,
            0,
            0,
          ),
        );
        lines.forEach((line, lineIndex) => {
          const closing = isLast && lineIndex === lines.length - 1;
          this.bodyContainer.addChild(new Text(`${closing ? BRANCH_CORNER : BRANCH_PIPE}${line}`, 0, 0));
        });
        return;
      }
      if (segment.kind === 'notice') {
        this.bodyContainer.addChild(this.noticeRow(segment.data, width, isLast));
        return;
      }
      if (segment.kind === 'approval') {
        this.bodyContainer.addChild(this.approvalRow(segment, width, isLast));
        return;
      }
      if (segment.kind === 'note') {
        this.bodyContainer.addChild(this.noteRow(segment, width, isLast));
        return;
      }
      this.bodyContainer.addChild(this.thinkingSummaryRow(segment, width, isLast));
    });
    // Height follows content: no reserved blank rows while the turn runs. The
    // steady-height padding this slot used to hold rendered as terminal-
    // background rows — a black band at the bottom of the viewport for every
    // running tool — and the step swaps it avoided are absorbed by the follow
    // logic (a following viewport re-seats on every layout frame anyway).
  }

  /**
   * Expanded state, split by whether the block is still running. A running block
   * anchors its window on the newest steps — the part of the timeline still
   * moving — while a settled block keeps the window that starts at the first
   * step. Both spend one shared row budget for the block as a whole.
   */
  private buildExpandedRows(width: number): void {
    if (this.running) this.buildExpandedRowsTail(width);
    else this.buildExpandedRowsHead(width);
  }

  /**
   * Settled state: the whole timeline in order. Rows are budgeted for the block
   * as a whole, so a turn with dozens of steps cannot expand into hundreds of
   * rows; whatever does not fit is summarised in one row at the end.
   */
  private buildExpandedRowsHead(width: number): void {
    this.bodyContainer.addChild(new Text(TREE_PIPE_ROW, 0, 0));
    let used = 1;
    let hidden = 0;
    for (let index = 0; index < this.segments.length; index += 1) {
      const segment = this.segments[index] as BlockSegment;
      const isLastStep = index === this.segments.length - 1;
      const rows = this.segmentRows(segment, width, isLastStep);
      // The first step always renders so a single oversized step cannot leave the
      // block expanded-but-empty. Hiding anything costs one more row for the hint,
      // which the last step does not need because nothing can follow it.
      const budget = ACTIVITY_GROUP_EXPANDED_LINES - (isLastStep ? 0 : 1);
      if (index > 0 && used + rows.cost > budget) {
        hidden = this.segments.length - index;
        break;
      }
      for (const component of rows.components) this.bodyContainer.addChild(component);
      used += rows.cost;
    }
    if (hidden > 0) {
      // The count is the last row of the tree, so it closes it.
      const summary = t('activitygroup.segments_hidden', { count: String(hidden) });
      this.bodyContainer.addChild(new Text(`${BRANCH_CORNER}${BODY_TEXT_INDENT}${chalk.dim(summary)}`, 0, 0));
    }
  }

  /**
   * Running state: the newest steps, still in chronological order so the tail
   * reads top-down, with the older steps that no longer fit counted in one row
   * above them. The budget is spent from the newest end backwards and the newest
   * step always renders, mirroring the head-anchored loop's rule that the first
   * step always renders — a single oversized step cannot leave the block
   * expanded-but-empty in either direction. The end-of-tree summary of the
   * settled loop is structurally unreachable here: a running block never keeps
   * rows below its newest step, so there is nothing at the end to count.
   */
  private buildExpandedRowsTail(width: number): void {
    const visible: Component[] = [];
    let used = 1;
    let hidden = 0;
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const segment = this.segments[index] as BlockSegment;
      const isLastStep = index === this.segments.length - 1;
      const rows = this.segmentRows(segment, width, isLastStep);
      // A counted run of older steps costs one more row for its row above the
      // window, which the newest step does not need because nothing can precede
      // the top of the tree.
      const budget = ACTIVITY_GROUP_EXPANDED_LINES - (isLastStep ? 0 : 1);
      if (!isLastStep && used + rows.cost > budget) {
        hidden = index + 1;
        break;
      }
      visible.unshift(...rows.components);
      used += rows.cost;
    }
    this.bodyContainer.addChild(new Text(TREE_PIPE_ROW, 0, 0));
    if (hidden > 0) {
      const summary = t('activitygroup.segments_folded_above', { count: String(hidden) });
      this.bodyContainer.addChild(new Text(`${BRANCH_PIPE}${BODY_TEXT_INDENT}${chalk.dim(summary)}`, 0, 0));
    }
    for (const component of visible) this.bodyContainer.addChild(component);
  }

  /**
   * Renders one step of the timeline: its branch row plus its own body rows.
   * The tree runs down the body of every step and closes on the very last
   * row of the block (`└`), so the last step's body sits inside the frame.
   */
  private segmentRows(segment: BlockSegment, width: number, isLast: boolean): SegmentRows {
    if (segment.kind === 'tool') {
      const row = this.toolRow(segment.tc, width, getActivityLines().expandedTool, !this.running);
      const body = this.expandedToolBody(segment.tc, row, width);
      const components: Component[] = [
        new Text(`${isLast && body.length === 0 ? BRANCH_LAST : BRANCH_FIRST}${this.statusGlyph(row)} ${row.header}`, 0, 0),
      ];
      body.forEach((line, index) => {
        const closing = isLast && index === body.length - 1;
        const text = `${closing ? BRANCH_CORNER : BRANCH_PIPE}${line}`;
        components.push(isImageLine(text) ? new RawLine(text) : new Text(text, 0, 0));
      });
      return { components, cost: 1 + body.length };
    }
    if (segment.kind === 'notice') {
      return { components: [this.noticeRow(segment.data, width, isLast)], cost: 1 };
    }
    if (segment.kind === 'approval') {
      return { components: [this.approvalRow(segment, width, isLast)], cost: 1 };
    }
    if (segment.kind === 'note') {
      return { components: [this.noteRow(segment, width, isLast)], cost: 1 };
    }
    return this.thinkingSegmentRows(segment, width, isLast);
  }

  /**
   * Body rows of an expanded tool step, without the tree prefix. An Edit /
   * Write shows its change the way the folded block does, only with the
   * unchanged lines around it and more of it, followed by whatever its result
   * said beyond the summary line (a stale-read warning, diagnostics). Every
   * other tool keeps the preview of its own card.
   */
  private expandedToolBody(tc: ToolCallComponent, row: ToolRow, width: number): string[] {
    if (tc.toolCallView.name === 'ReadMediaFile') {
      // An image read is one row while folded; expanded, the picture sits
      // inside the tree under it (on a terminal that can draw images —
      // elsewhere the row's own chip already names the file).
      const thumbnail = this.thumbnailOf(tc);
      if (thumbnail === null) return [];
      if (thumbnail !== undefined) {
        const inner = Math.max(1, width - BRANCH_PIPE.length - BODY_TEXT_INDENT.length);
        return thumbnail.render(inner).map((line) => `${BODY_TEXT_INDENT}${line}`);
      }
    }
    const change = fileChangeOf(tc.toolCallView, tc.resultView);
    if (change === undefined) return row.body.map((line) => `${BODY_TEXT_INDENT}${line}`);
    const limit = getActivityLines().expandedTool;
    const notes = changeNotes(tc.resultView?.output ?? '').slice(0, CHANGE_NOTE_LINES);
    // The step's body stays within its budget: the count row and the notes
    // come out of it too.
    const rows = renderFileChange(change, 'expanded', Math.max(1, limit - notes.length - 1), width - BRANCH_PIPE.length, this.colors);
    const textWidth = Math.max(1, width - BRANCH_PIPE.length - BODY_TEXT_INDENT.length);
    return [
      ...rows,
      ...notes.map((note) => `${BODY_TEXT_INDENT}${chalk.hex(this.colors.textDim)(truncateToWidth(note, textWidth, '…'))}`),
    ];
  }

  /**
   * The thumbnail of a finished image read: null when there is nothing to
   * draw (the terminal cannot show images), undefined when the result is not
   * an image (an error, a video) and the card's own preview applies.
   */
  private thumbnailOf(tc: ToolCallComponent): Component | null | undefined {
    const result = tc.resultView;
    if (result === undefined || result.is_error === true) return undefined;
    const cached = this.thumbnails.get(tc);
    if (cached !== undefined) return cached;
    const summary = parseReadMediaOutput(result.output);
    if (summary === null || summary.kind !== 'image' || summary.base64 === undefined || summary.mimeType === undefined) {
      return undefined;
    }
    const images = getCapabilities().images;
    let thumbnail: Component | null = null;
    if (images === 'kitty' || images === 'iterm2') {
      const dims = getImageDimensions(summary.base64, summary.mimeType) ?? { widthPx: 800, heightPx: 600 };
      thumbnail = createImageComponent(
        { base64: summary.base64, mime: summary.mimeType, width: dims.widthPx, height: dims.heightPx, filename: summary.path },
        this.colors,
      );
    }
    this.thumbnails.set(tc, thumbnail);
    return thumbnail;
  }

  /** One note, kept to a single row in its tone. */
  private noteRow(segment: Extract<BlockSegment, { kind: 'note' }>, width: number, isLast: boolean): Text {
    const prefix = isLast ? BRANCH_LAST : BRANCH_FIRST;
    const tone =
      segment.tone === 'error' ? this.colors.error : segment.tone === 'warning' ? this.colors.warning : this.colors.textDim;
    const plain = segment.text.replaceAll(/\s+/g, ' ').trim();
    return new Text(`${prefix}${chalk.hex(tone)(truncateToWidth(plain, Math.max(1, width - visibleWidth(prefix)), '…'))}`, 0, 0);
  }

  /** One background task notice, kept to a single row. */
  private noticeRow(
    data: BackgroundAgentStatusData,
    width: number,
    isLast: boolean,
  ): Text {
    const prefix = isLast ? BRANCH_LAST : BRANCH_FIRST;
    // Cells already spent: the branch and the bullet (glyph plus its trailing
    // space, exactly like the standalone notice row composes them).
    const view = renderBackgroundStatus(
      data,
      this.colors,
      Math.max(1, width - visibleWidth(prefix) - NOTICE_BULLET_WIDTH),
      this.spinnerFrame,
    );
    return new Text(`${prefix}${view.bullet}${view.text}`, 0, 0);
  }

  /**
   * One approval outcome, kept to a single row. Approvals read as a quiet note
   * next to the work they allowed — dim, unlike a rejection, which keeps the
   * error tone so a denied call is never mistaken for an allowed one.
   */
  private approvalRow(
    segment: Extract<BlockSegment, { kind: 'approval' }>,
    width: number,
    isLast: boolean,
  ): Text {
    const prefix = isLast ? BRANCH_LAST : BRANCH_FIRST;
    const tone = segment.tone === 'rejected' ? this.colors.error : this.colors.textDim;
    const plain = `${segment.label}${SEPARATOR}${segment.detail}`;
    return new Text(
      `${prefix}${chalk.hex(tone)(truncateToWidth(plain, Math.max(1, width - visibleWidth(prefix)), '…'))}`,
      0,
      0,
    );
  }

  /**
   * One reasoning run: a label row plus as many of its lines as its own budget
   * allows. Lines keep their order; the oldest end of a live run (or the newest
   * end of a finished one) is dropped until the budget fits.
   */
  private thinkingSegmentRows(
    segment: Extract<BlockSegment, { kind: 'thinking' }>,
    width: number,
    isLast: boolean,
  ): SegmentRows {
    const colors = this.colors;
    const lines = thinkingLines(segment.text);
    if (lines.length === 0) return { components: [], cost: 0 };
    // A run always has body rows, so its own row never closes the tree: the
    // last body row of the last step does.
    const components: Component[] = [
      new Text(
        `${BRANCH_FIRST}${this.thinkingGlyph(segment)}${chalk.hex(colors.roleThinking)(t('activitygroup.thinking_label'))}`,
        0,
        0,
      ),
    ];
    let cost = 1;
    // Capped by RENDERED lines: a long unbroken paragraph wraps into many rows,
    // and the budget must hold regardless of the source shape.
    const budget = getActivityLines().expandedThinking;
    const textPrefix = `${BRANCH_PIPE}${BODY_TEXT_INDENT}`;
    const closingPrefix = `${BRANCH_CORNER}${BODY_TEXT_INDENT}`;
    const inner = Math.max(1, width - visibleWidth(textPrefix));
    const height = (line: string): number =>
      new WrappedLine(textPrefix, textPrefix, line).render(inner).length;
    let selected = segment.live ? lines.slice(-budget) : lines.slice(0, budget);
    while (selected.length > 1 && selected.reduce((sum, line) => sum + height(line), 0) > budget) {
      selected = segment.live ? selected.slice(1) : selected.slice(0, -1);
    }
    const first = selected[0];
    if (selected.length === 1 && first !== undefined && height(first) > budget) {
      // One unbroken paragraph: clip its text so the wrapped height stays inside
      // the row budget instead of relying on line-level trimming.
      selected = [truncateToWidth(first, inner * budget, '…')];
    }
    const hiddenLines = lines.length - selected.length;
    selected.forEach((line, index) => {
      const closing = isLast && hiddenLines === 0 && index === selected.length - 1;
      components.push(
        new WrappedLine(textPrefix, textPrefix, chalk.hex(colors.roleThinking)(line), closing ? { lastPrefix: closingPrefix } : {}),
      );
      cost += height(line);
    });
    if (hiddenLines > 0) {
      const hint = segment.live
        ? t('activitygroup.thinking_earlier', { count: String(hiddenLines) })
        : t('activitygroup.thinking_more', { count: String(hiddenLines) });
      components.push(new Text(`${isLast ? closingPrefix : textPrefix}${chalk.dim(hint)}`, 0, 0));
      cost += 1;
    }
    return { components, cost };
  }

  /** Number of tool calls on the timeline. */
  private toolCount(): number {
    let count = 0;
    for (const segment of this.segments) {
      if (segment.kind === 'tool') count += 1;
    }
    return count;
  }

  /** True while the newest step of the timeline is a reasoning run still streaming. */
  private liveThinking(): boolean {
    const last = this.segments.at(-1);
    return last !== undefined && last.kind === 'thinking' && last.live;
  }

  // ---------------------------------------------------------------------------
  // Row extraction
  // ---------------------------------------------------------------------------

  /**
   * Renders one borrowed card at the width left over by the row prefix and
   * status glyph, then splits its own output into the header row and a capped
   * result preview. The card's own status marker is captured (not just dropped)
   * so the row can mirror running / failed / aborted states.
   */
  private toolRow(tc: ToolCallComponent, width: number, maxLines: number, settled = false): ToolRow {
    const inner = Math.max(1, width - BRANCH_WIDTH - STATUS_WIDTH);
    const rendered = tc.render(inner);
    const rawHeader = rendered[1] ?? '';
    const body: string[] = [];
    for (const line of rendered.slice(2)) {
      // Real body rows are indented by the card; an unindented line is the wrap
      // continuation of a long header and must not be mistaken for a preview.
      if (!/^(\u001B\[[0-9;]*m)* {2}/.test(line)) continue;
      if (visibleWidth(line) === 0) continue;
      body.push(stripCardIndent(line));
      if (body.length >= maxLines) break;
    }
    const result = tc.resultView;
    // A subagent's row follows the subagent, not its tool call: a run handed
    // to the background has its result already, yet is still working.
    const phase = tc.toolCallView.name === 'Agent' ? tc.getSubagentSnapshot().phase : undefined;
    const agentRunning = phase === 'spawning' || phase === 'running' || phase === 'backgrounded';
    return {
      header: condenseRowLabel(
        stripCardMarker(rawHeader),
        tc.toolCallView.name,
        tc.toolCallView.args,
        Math.max(1, width - BRANCH_WIDTH - STATUS_WIDTH),
      ),
      body,
      // A settled block's header already claims the work finished, so a row
      // still missing its result event (a reset raced the result, or the event
      // was lost) must settle with the block instead of spinning forever.
      // Live blocks keep the honest running state for parallel batches; a late
      // real result still lands via onToolCallEnd and overwrites success/✗.
      done: !agentRunning && (result !== undefined || settled),
      failed: phase === 'failed' || result?.is_error === true || cardMarkerChar(rawHeader) === '✗',
      aborted: cardMarkerChar(rawHeader) === '⊙',
    };
  }

  /** What a running subagent is doing now, for the line under its row; undefined otherwise. */
  private agentActivity(tc: ToolCallComponent): string | undefined {
    if (tc.toolCallView.name !== 'Agent') return undefined;
    const snapshot = tc.getSubagentSnapshot();
    if (snapshot.phase !== 'spawning' && snapshot.phase !== 'running' && snapshot.phase !== 'backgrounded') return undefined;
    const activity = snapshot.latestActivity?.replaceAll(/\s+/g, ' ').trim();
    return activity === undefined || activity.length === 0 ? undefined : activity;
  }

  /** Mirrors a tool row's status prefix so reasoning and tool rows line up: a
   *  live run spins with the block frame, a finished run takes the success mark
   *  (`DONE_MARK` carries its own trailing space, so the column stays 2 cells). */
  private thinkingGlyph(segment: Extract<BlockSegment, { kind: 'thinking' }>): string {
    if (segment.live) {
      const frame = BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0];
      return `${chalk.hex(this.colors.roleThinking)(frame)} `;
    }
    return chalk.hex(this.colors.success)(DONE_MARK);
  }

  /** Mirrors the card's own status: running spins, failed/aborted stay visible. */
  private statusGlyph(row: ToolRow): string {
    if (row.aborted) return chalk.hex(this.colors.error)('⊙');
    if (row.failed) return chalk.hex(this.colors.error)('✗');
    if (!row.done) {
      const frame = BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0];
      return chalk.hex(this.colors.textDim)(frame);
    }
    return chalk.hex(this.colors.success)('✓');
  }

  /**
   * Collapsed reasoning row: the run's first line clipped to whatever space the
   * row can still hold at this width, so a narrow terminal cannot wrap the block
   * past its height. The token estimate lives in the block header only.
   */
  private thinkingSummaryRow(
    segment: Extract<BlockSegment, { kind: 'thinking' }>,
    width: number,
    isLast: boolean,
  ): Text {
    const first = thinkingLines(segment.text)[0] ?? '';
    const label = t('activitygroup.thinking_summary', { summary: '' });
    const prefix = isLast ? BRANCH_LAST : BRANCH_FIRST;
    // The row carries the same status glyph as a tool row — spinning while the
    // run is live, `✓` once it ends — so the summary gets whatever is left after
    // prefix + glyph + label. The block is the main view of a turn now, so the
    // row is bounded by the terminal, not by a fixed slice.
    const used = visibleWidth(prefix) + visibleWidth(this.thinkingGlyph(segment)) + visibleWidth(label);
    // One cell of breathing room on the right: flush against the edge, a
    // truncated summary reads as bleeding out of the frame, and the ellipsis
    // glyph of several fonts adds to that on real terminals.
    const cells = Math.max(1, width - used - 1);
    const summary = chalk.hex(this.colors.roleThinking)(
      t('activitygroup.thinking_summary', { summary: truncateToWidth(first, cells, '…') }),
    );
    return new Text(`${prefix}${this.thinkingGlyph(segment)}${summary}`, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Spinner (same drift-free + paint-backpressure chain as the thinking row)
  // ---------------------------------------------------------------------------

  /**
   * True while at least one visible row carries a live animation. Reasoning rows
   * spin too now, and a background task that is still running keeps its glyph
   * moving, so this can no longer be "collapsed with a pending tool": the only
   * question is whether repainting the body on this tick would show anything new.
   * Finished rows stay static by design.
   */
  private needsRowAnimation(): boolean {
    if (!this.running) return false;
    for (const segment of this.segments) {
      if (segment.kind === 'thinking' && segment.live) return true;
      if (segment.kind === 'notice' && segment.data.phase === 'started') return true;
      if (segment.kind === 'tool' && segment.tc.resultView === undefined) return true;
      if (segment.kind === 'tool' && this.agentActivity(segment.tc) !== undefined) return true;
    }
    return false;
  }

  private scheduleSpinnerTick(delayMs: number): void {
    if (this.ui === undefined) return;
    const timer = setTimeout(() => {
      if (this.spinnerTimer !== timer) return;
      const startedAt = performance.now();
      const elapsed = startedAt - this.lastSpinnerTickAt;
      if (elapsed >= this.spinnerPeriod) {
        const steps = Math.floor(elapsed / this.spinnerPeriod);
        this.spinnerFrame = (this.spinnerFrame + steps) % BRAILLE_SPINNER_FRAMES.length;
        this.lastSpinnerTickAt += steps * this.spinnerPeriod;
        const width = this.renderedWidth ?? 80;
        // A live row must follow the frame in both modes: the header alone used
        // to spin while collapsed, which left expanded groups (and every
        // reasoning row) showing a frozen glyph.
        if (this.needsRowAnimation()) {
          this.rebuild(width);
        } else {
          this.headerText.setText(this.buildHeader(width));
        }
        this.ui?.requestRender();
      }
      const frameCostMs = performance.now() - startedAt;
      if (this.spinnerTimer !== timer) return;
      const cadenceDelayMs = Math.max(0, this.spinnerPeriod - frameCostMs);
      const backpressureDelayMs = frameCostMs * 9;
      this.scheduleSpinnerTick(Math.max(cadenceDelayMs, backpressureDelayMs));
    }, delayMs);
    this.spinnerTimer = timer;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerTimer !== undefined) return;
    // Motion off or a static spinner (interval 0): the glyph keeps its first
    // frame and no timer runs.
    const period = spinnerPeriodMs();
    if (period === undefined) return;
    this.spinnerPeriod = period;
    this.lastSpinnerTickAt = performance.now();
    this.scheduleSpinnerTick(period);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return;
    clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }
}
