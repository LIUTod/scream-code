/**
 * ActivityGroupComponent compacts one turn's reasoning and tool calls into a
 * single block: three rows while collapsed (header, latest activity, reasoning
 * summary) and a tree with per-tool result previews while expanded.
 *
 * Design (mirrors AgentGroupComponent):
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

import type { TUI } from '@liutod-scream/pi-tui';
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import {
  ACTIVITY_GROUP_EXPANDED_LINES,
  ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
  ACTIVITY_GROUP_THINKING_SUMMARY_CELLS,
  ACTIVITY_GROUP_TOOL_EXPANDED_LINES,
  ACTIVITY_GROUP_TOOL_PREVIEW_LINES,
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import {
  easeSpeedRatio,
  estimateTokens,
  getSharedSpeedTracker,
  lerpHex,
  SPEED_MAX,
} from '#/tui/utils/speed-tracker';

import type { ToolCallComponent } from './tool-call';
import { strArg } from './tool-renderers/types';
import { WrappedLine } from './wrapped-line';

/** Visible width of the tree prefixes (`  ├─ `) reserved for each row. */
const BRANCH_WIDTH = 5;
/** Visible width of a row's status glyph plus its trailing space. */
const STATUS_WIDTH = 2;
const BRANCH_FIRST = '  ├─ ';
const BRANCH_LAST = '  └─ ';
const BRANCH_PIPE = '  │  ';
const TREE_PIPE_ROW = '  │';
const THINKING_BODY_PREFIX = '     ';
const THROTTLE_MS = 200;
/** Rates below this are noise: the live badge stays hidden until tokens flow. */
const MIN_RATE = 0.05;
/** Smallest usable reasoning-summary budget in the collapsed row. */
const MIN_SUMMARY_CELLS = 8;
const SEPARATOR = ' · ';
/** The card renders a two-cell status marker the row prefix accounts for. */
const CARD_MARKERS = ['■', '✗', '▸', '●', '○', '⊙', '◐'];
const CARD_MARKER_AT_START_RE = new RegExp(`^(?:\\u001b\\[[0-9;]*m)*(?:${CARD_MARKERS.join('|')}) `);
const CARD_MARKER_CHAR_RE = new RegExp(`^(?:\\u001b\\[[0-9;]*m)*(${CARD_MARKERS.join('|')}) `);
const CARD_INDENT_RE = /^(\u001B\[[0-9;]*m)*( {2})/;

interface BorrowedTool {
  readonly tc: ToolCallComponent;
  readonly step: number | undefined;
}

interface ToolRow {
  readonly header: string;
  readonly body: string[];
  readonly done: boolean;
  readonly failed: boolean;
  readonly aborted: boolean;
}

/** Token count for a text block; empty text is zero, unlike the rate estimator. */
function countTokens(text: string): number {
  return text.trim().length === 0 ? 0 : estimateTokens(text);
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
  private readonly tools: BorrowedTool[] = [];
  private readonly steps = new Set<number>();
  private thinkingText = '';
  private thinkingLive = false;
  private running = true;
  private expanded = false;
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private spinnerTimer: ReturnType<typeof setTimeout> | undefined;
  private spinnerFrame = 0;
  private lastSpinnerTickAt = 0;
  private renderedWidth: number | undefined;
  /** Token estimates per borrowed card, keyed by the result text they counted. */
  private readonly toolTokenCache = new WeakMap<
    ToolCallComponent,
    { output: string; tokens: number }
  >();
  private thinkingTokenCache: { text: string; tokens: number } | undefined;

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

  /** True when the group owns neither reasoning nor tool calls. */
  isEmpty(): boolean {
    return this.tools.length === 0 && this.thinkingText.trim().length === 0;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  /**
   * Borrows a tool card as a hidden state container. Re-attaching the same
   * card is a no-op.
   */
  attachTool(tc: ToolCallComponent, step: number | undefined): void {
    if (this.tools.some((entry) => entry.tc === tc)) return;
    this.tools.push({ tc, step });
    if (step !== undefined) this.steps.add(step);
    tc.setExpanded(this.expanded);
    tc.setSnapshotListener(() => {
      this.scheduleFlush();
    });
    this.flushNow();
  }

  /** Updates the reasoning text; `live` drives the streaming rate in the header. */
  setThinking(text: string, live: boolean): void {
    if (text === this.thinkingText && live === this.thinkingLive) return;
    const structureChanged = text.length === 0 !== (this.thinkingText.length === 0);
    this.thinkingText = text;
    this.thinkingLive = live;
    // Reasoning appearing or disappearing changes the row count, so it must not
    // wait for the next throttled tick; growing text can.
    if (structureChanged) this.flushNow();
    else this.scheduleFlush();
  }

  endThinking(): void {
    if (!this.thinkingLive) return;
    this.thinkingLive = false;
    this.flushNow();
  }

  /** Marks the producing turn as finished: the header stops spinning. */
  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    if (running) this.startSpinner();
    else this.stopSpinner();
    this.flushNow();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    // Borrowed cards render their own previews: expanding the block must deepen
    // them too, otherwise grouping would hide output the card used to show.
    for (const entry of this.tools) entry.tc.setExpanded(expanded);
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
    for (const entry of this.tools) entry.tc.invalidate();
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

  private buildHeader(width: number): string {
    const colors = this.colors;
    const frame = BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0];
    const marker = this.running
      ? chalk.hex(colors.roleThinking)(`${frame} `)
      : chalk.hex(colors.success)(STATUS_BULLET);
    const label = this.running ? t('activitygroup.running') : t('activitygroup.done');

    const parts: string[] = [];
    if (this.steps.size > 0) parts.push(t('activitygroup.steps', { count: String(this.steps.size) }));
    if (this.tools.length > 0) parts.push(t('activitygroup.tools', { count: String(this.tools.length) }));
    parts.push(t('activitygroup.tokens', { tok: this.formatTokens(this.blockTokens()) }));
    const stats = chalk.dim(SEPARATOR + parts.join(SEPARATOR));

    // The rate slot is always present: a dash keeps the header width stable and
    // tells the user the meter is idle rather than missing.
    const speed = this.thinkingLive ? getSharedSpeedTracker().getSpeed() : 0;
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
    // wrap into a second row: the collapsed block must stay three rows tall.
    const head = `${marker}${chalk.hex(colors.primary).bold(label)}${stats}`;
    const withRate = `${head}${rate}`;
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

  /** Collapsed state: at most three rows, matching the documented preview. */
  private buildCollapsedRows(width: number): void {
    const hasThinking = this.thinkingText.trim().length > 0;
    const latest = this.tools.at(-1);
    if (latest !== undefined) {
      const prefix = hasThinking ? BRANCH_PIPE : BRANCH_LAST;
      const row = this.toolRow(latest.tc, width, ACTIVITY_GROUP_TOOL_PREVIEW_LINES);
      this.bodyContainer.addChild(
        new Text(`${prefix}${this.statusGlyph(row)} ${row.header}`, 0, 0),
      );
    }
    if (hasThinking) {
      this.bodyContainer.addChild(new Text(this.thinkingRow(width), 0, 0));
    }
  }

  /** Expanded state: one branch per tool plus a reasoning excerpt. */
  private buildExpandedRows(width: number): void {
    const colors = this.colors;
    const hasThinking = this.thinkingText.trim().length > 0;
    this.bodyContainer.addChild(new Text(TREE_PIPE_ROW, 0, 0));

    // Rows are budgeted for the whole block: a turn with dozens of tools must
    // not expand to hundreds of rows. Tools beyond the budget collapse into one
    // summary row, and the reasoning excerpt gets whatever is left.
    const toolRows = this.tools.map((entry) => ({
      row: this.toolRow(entry.tc, width, ACTIVITY_GROUP_TOOL_EXPANDED_LINES),
    }));
    let used = 1;
    let hiddenTools = 0;
    let shownTools = 0;
    toolRows.forEach(({ row }, index) => {
      const cost = 1 + row.body.length;
      if (shownTools > 0 && used + cost > ACTIVITY_GROUP_EXPANDED_LINES) {
        hiddenTools += 1;
        return;
      }
      const isLast =
        index === this.tools.length - 1 && !hasThinking && hiddenTools === 0;
      this.bodyContainer.addChild(
        new Text(`${isLast ? BRANCH_LAST : BRANCH_FIRST}${this.statusGlyph(row)} ${row.header}`, 0, 0),
      );
      const continuation = isLast ? THINKING_BODY_PREFIX : BRANCH_PIPE;
      for (const line of row.body) {
        this.bodyContainer.addChild(new Text(`${continuation}${line}`, 0, 0));
      }
      used += cost;
      shownTools += 1;
    });
    if (hiddenTools > 0) {
      const prefix = hasThinking ? BRANCH_FIRST : BRANCH_LAST;
      const summary = t('activitygroup.tools_hidden', { count: String(hiddenTools) });
      this.bodyContainer.addChild(new Text(`${prefix}${chalk.dim(summary)}`, 0, 0));
      used += 1;
    }

    if (!hasThinking) return;
    // The excerpt takes whatever the tool rows left over, capped by its own limit.
    // The "N more lines" hint row is part of the body too, so reserve it whenever
    // lines will be hidden.
    const thinkingLines = this.thinkingLines();
    let excerptBudget = Math.min(
      ACTIVITY_GROUP_THINKING_EXCERPT_LINES,
      Math.max(0, ACTIVITY_GROUP_EXPANDED_LINES - used - 1),
    );
    // Only when the block budget is what limits the excerpt does the hint row
    // need its own slot; with room to spare the excerpt keeps its full limit.
    if (excerptBudget < ACTIVITY_GROUP_THINKING_EXCERPT_LINES && thinkingLines.length > excerptBudget) {
      excerptBudget -= 1;
    }
    if (excerptBudget <= 0) return;
    const tokens = chalk.dim(t('activitygroup.tokens', { tok: this.formatTokens(this.thinkingTokens()) }));
    this.bodyContainer.addChild(
      new Text(
        `${BRANCH_LAST} ${chalk.dim('·')} ${chalk.hex(colors.roleThinking)(t('activitygroup.thinking_label'))}${chalk.dim(SEPARATOR)}${tokens}`,
        0,
        0,
      ),
    );

    // The excerpt is capped by RENDERED lines: a long unbroken paragraph wraps
    // into many rows, and the budget must hold regardless of the source shape.
    // Rows keep chronological order; the oldest (live) or newest (settled) end
    // is dropped until the budget fits.
    const lines = thinkingLines;
    const inner = Math.max(1, width - visibleWidth(THINKING_BODY_PREFIX));
    const height = (line: string): number =>
      new WrappedLine(THINKING_BODY_PREFIX, THINKING_BODY_PREFIX, line).render(inner).length;
    const candidates = this.thinkingLive
      ? lines.slice(-ACTIVITY_GROUP_THINKING_EXCERPT_LINES)
      : lines.slice(0, ACTIVITY_GROUP_THINKING_EXCERPT_LINES);
    let selected = candidates;
    while (
      selected.length > 1 &&
      selected.reduce((sum, line) => sum + height(line), 0) > excerptBudget
    ) {
      selected = this.thinkingLive ? selected.slice(1) : selected.slice(0, -1);
    }
    const first = selected[0];
    if (selected.length === 1 && first !== undefined && height(first) > excerptBudget) {
      // One unbroken paragraph: clip its text so the wrapped height stays inside
      // the row budget instead of relying on line-level trimming.
      selected = [truncateToWidth(first, inner * excerptBudget, '…')];
    }
    for (const line of selected) {
      const row = new WrappedLine(
        THINKING_BODY_PREFIX,
        THINKING_BODY_PREFIX,
        chalk.hex(colors.roleThinking)(line),
      );
      this.bodyContainer.addChild(row);
      used += height(line);
    }
    const hidden = lines.length - selected.length;
    if (hidden > 0) {
      const hint = this.thinkingLive
        ? t('activitygroup.thinking_earlier', { count: String(hidden) })
        : t('activitygroup.thinking_more', { count: String(hidden) });
      this.bodyContainer.addChild(new Text(`${THINKING_BODY_PREFIX}${chalk.dim(hint)}`, 0, 0));
    }
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
  private toolRow(tc: ToolCallComponent, width: number, maxLines: number): ToolRow {
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
    return {
      header: condenseRowLabel(
        stripCardMarker(rawHeader),
        tc.toolCallView.name,
        tc.toolCallView.args,
        Math.max(1, width - BRANCH_WIDTH - STATUS_WIDTH),
      ),
      body,
      done: result !== undefined,
      failed: result?.is_error === true || cardMarkerChar(rawHeader) === '✗',
      aborted: cardMarkerChar(rawHeader) === '⊙',
    };
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

  private thinkingLines(): string[] {
    return this.thinkingText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * Collapsed reasoning row: the first reasoning line clipped to whatever space
   * the row can still hold at this width, so a narrow terminal cannot wrap the
   * block into a fourth row. The token tail is dropped when it would not fit.
   */
  private thinkingRow(width: number): string {
    const first = this.thinkingLines()[0] ?? '';
    const label = t('activitygroup.thinking_summary', { summary: '' });
    const tail = t('activitygroup.tokens', { tok: this.formatTokens(this.thinkingTokens()) });
    const glue = visibleWidth(SEPARATOR);
    const bareFixed = BRANCH_WIDTH + glue + visibleWidth(label);
    const withTailFixed = bareFixed + glue + visibleWidth(tail);
    const withTail = width - withTailFixed >= MIN_SUMMARY_CELLS;
    const cells = Math.max(
      1,
      Math.min(
        ACTIVITY_GROUP_THINKING_SUMMARY_CELLS,
        width - (withTail ? withTailFixed : bareFixed),
      ),
    );
    const summary = chalk.hex(this.colors.roleThinking)(
      t('activitygroup.thinking_summary', { summary: truncateToWidth(first, cells, '…') }),
    );
    const tailText = withTail ? `${chalk.dim(SEPARATOR)}${chalk.dim(tail)}` : '';
    return `${BRANCH_LAST} ${chalk.dim('·')} ${summary}${tailText}`;
  }

  /**
   * Token estimate for the whole block: the reasoning text plus every result the
   * block owns, i.e. how much material this stretch of work moved through.
   */
  private blockTokens(): number {
    let tokens = this.thinkingTokens();
    for (const entry of this.tools) tokens += this.toolTokens(entry.tc);
    return tokens;
  }

  /** Result tokens of one card, counted once per distinct result text. */
  private toolTokens(tc: ToolCallComponent): number {
    const output = tc.resultView?.output ?? '';
    const cached = this.toolTokenCache.get(tc);
    if (cached !== undefined && cached.output === output) return cached.tokens;
    const tokens = countTokens(output);
    this.toolTokenCache.set(tc, { output, tokens });
    return tokens;
  }

  /**
   * Token estimate for the block's reasoning. Character-based and script-aware
   * (CJK ≈ one token per char, Latin ≈ a quarter), using the same estimator as
   * the streaming speed gauge so both numbers agree. Empty reasoning counts as
   * zero: the estimator's floor of one token is for per-delta rates.
   */
  private thinkingTokens(): number {
    const cached = this.thinkingTokenCache;
    if (cached !== undefined && cached.text === this.thinkingText) return cached.tokens;
    const tokens = countTokens(this.thinkingText);
    this.thinkingTokenCache = { text: this.thinkingText, tokens };
    return tokens;
  }

  private formatTokens(tokens: number): string {
    if (tokens < 1000) return String(tokens);
    if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  // ---------------------------------------------------------------------------
  // Spinner (same drift-free + paint-backpressure chain as the thinking row)
  // ---------------------------------------------------------------------------

  private scheduleSpinnerTick(delayMs: number): void {
    if (this.ui === undefined) return;
    const timer = setTimeout(() => {
      if (this.spinnerTimer !== timer) return;
      const startedAt = performance.now();
      const elapsed = startedAt - this.lastSpinnerTickAt;
      if (elapsed >= BRAILLE_SPINNER_INTERVAL_MS) {
        const steps = Math.floor(elapsed / BRAILLE_SPINNER_INTERVAL_MS);
        this.spinnerFrame = (this.spinnerFrame + steps) % BRAILLE_SPINNER_FRAMES.length;
        this.lastSpinnerTickAt += steps * BRAILLE_SPINNER_INTERVAL_MS;
        const width = this.renderedWidth ?? 80;
        // While collapsed a running tool row mirrors the header frame; at most
        // two rows, so refreshing the body here stays cheap. Expanded groups
        // keep static glyphs (the rows carry content, not progress).
        if (!this.expanded && this.tools.some((entry) => entry.tc.resultView === undefined)) {
          this.rebuild(width);
        } else {
          this.headerText.setText(this.buildHeader(width));
        }
        this.ui?.requestRender();
      }
      const frameCostMs = performance.now() - startedAt;
      if (this.spinnerTimer !== timer) return;
      const cadenceDelayMs = Math.max(0, BRAILLE_SPINNER_INTERVAL_MS - frameCostMs);
      const backpressureDelayMs = frameCostMs * 9;
      this.scheduleSpinnerTick(Math.max(cadenceDelayMs, backpressureDelayMs));
    }, delayMs);
    this.spinnerTimer = timer;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerTimer !== undefined) return;
    this.lastSpinnerTickAt = performance.now();
    this.scheduleSpinnerTick(BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return;
    clearTimeout(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }
}
