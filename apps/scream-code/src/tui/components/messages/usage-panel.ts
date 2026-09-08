/**
 * UsagePanelComponent — wraps pre-coloured `/usage` lines in a blue box
 * border with a left indent, mirroring the PlanBoxComponent layout so
 * the pattern stays consistent across command-triggered panels.
 */

import type { Component } from '@liutod-scream/pi-tui';
import { truncateToWidth, visibleWidth } from '@liutod-scream/pi-tui';
import type { SessionUsage, TokenUsage } from '@scream-code/scream-code-sdk';
import chalk from 'chalk';
import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
} from '#/utils/usage/usage-format';
import type { ColorPalette } from '#/tui/theme/colors';
import type { SubagentUsageMap } from '#/tui/types';
import { t } from '@scream-code/config';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const MIN_INTERIOR_WIDTH = 20;

type Colorize = (text: string) => string;

export interface ManagedUsageRow {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly resetHint?: string;
}

export interface ManagedUsageReport {
  readonly summary: ManagedUsageRow | null;
  readonly limits: readonly ManagedUsageRow[];
}

export interface UsageReportOptions {
  readonly colors: ColorPalette;
  readonly sessionUsage?: SessionUsage;
  readonly sessionUsageError?: string;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
  readonly subagentUsage?: SubagentUsageMap;
  /**
   * Terminal width in columns (optional). When absent the name column uses
   * a safe fixed cap; when present the cap scales with the available width
   * so overlong model names never push the panel past the terminal edge.
   */
  readonly terminalWidth?: number;
}

export interface ManagedUsageReportLineOptions {
  readonly colors: ColorPalette;
  readonly managedUsage?: ManagedUsageReport;
  readonly managedUsageError?: string;
  /** Optional shared name-column width; omitting keeps local alignment. */
  readonly nameWidth?: number;
}
function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}


function usageInputTotal(usage: TokenUsage): number {
  return (
    usageNumber(usage.inputOther) +
    usageNumber(usage.inputCacheRead) +
    usageNumber(usage.inputCacheCreation)
  );
}

/**
 * Table geometry for the whole usage report. Every row that carries an
 * `input/output/total` triple shares the same name column (left) and the
 * same right-aligned numeric columns, so the report reads as one table.
 */
interface UsageTable {
  /** Width of the left-hand name column, padded with spaces. */
  readonly nameWidth: number;
  /** Width of each right-aligned numeric column. */
  readonly numWidth: number;
  readonly padName: (name: string) => string;
  /**
   * Truncate/pad a plain name to the name column, then colour it. Colour
   * must come AFTER truncation so the escape sequence is never cut.
   */
  readonly padNameColored: (name: string, colorize: Colorize) => string;
  readonly num: (n: number) => string;
}

/**
 * Fixed chrome overhead outside the shareable interior: left margin (2)
 * + box borders (2) + side paddings (2×1). Mirrors UsagePanelComponent.
 */
const PANEL_CHROME_WIDTH = 2 + 2 + 2 * 1;

function makeUsageTable(names: readonly string[], terminalWidth?: number): UsageTable {
  // Hard cap: 12..24 normally; when the terminal width is known, allow up
  // to 40 but only while the name column + numeric triples + context row
  // still fit inside the panel interior.
  const availableInterior =
    terminalWidth === undefined ? Number.POSITIVE_INFINITY : terminalWidth - PANEL_CHROME_WIDTH;
  // The context-window row additionally carries a 20-cell bar + % + token
  // fraction: reserve that so it never gets fallback-truncated.
  const contextOverhead = 1 + 20 + 2 + 6 + 2 + 20;
  let cap = 24;
  if (Number.isFinite(availableInterior)) {
    cap = Math.min(40, availableInterior - contextOverhead);
  }
  const nameWidth = Math.max(
    12,
    Math.min(cap, Math.max(...names.map((n) => visibleWidth(n))) + 1),
  );
  const numWidth = 7;
  return {
    nameWidth,
    numWidth,
    padName: (name: string): string => {
      // Truncate overlong names (e.g. provider/model aliases) so a single
      // long row never pushes the panel past its width budget.
      const clipped =
        visibleWidth(name) > nameWidth ? truncateToWidth(name, nameWidth, '…') : name;
      return clipped + ' '.repeat(Math.max(0, nameWidth - visibleWidth(clipped)));
    },
    padNameColored: (name: string, colorize: Colorize): string => {
      const clipped = visibleWidth(name) > nameWidth ? truncateToWidth(name, nameWidth, '…') : name;
      return colorize(clipped) + ' '.repeat(Math.max(0, nameWidth - visibleWidth(clipped)));
    },
    num: (n: number): string => formatTokenCount(n).padStart(numWidth, ' '),
  };
}

function usageTableHeader(table: UsageTable, title: string): string {
  // Labels must align on the same right edge as the numeric columns. Use
  // visible-width padding (CJK labels occupy 2 columns, not 1 char).
  const cell = (label: string): string =>
    ' '.repeat(Math.max(0, table.numWidth - visibleWidth(label))) + label;
  return (
    table.padName(title) + cell(t('usage.input')) + cell(t('usage.output')) + cell(t('usage.total'))
  );
}

/** Sum a set of `TokenUsage` rows into a single triple. */
function sumTokenRows(rows: readonly TokenUsage[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += usageInputTotal(row);
    output += usageNumber(row.output);
  }
  return { input, output };
}

function buildSessionUsageSection(
  usage: SessionUsage | undefined,
  error: string | undefined,
  table: UsageTable,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
  subagentUsage: SubagentUsageMap | undefined,
): string[] {
  if (error !== undefined) return [errorStyle(`  ${error}`)];
  const byModel = (usage as { readonly byModel?: Record<string, TokenUsage> } | undefined)
    ?.byModel;
  const entries = Object.entries(byModel ?? {});
  if (entries.length === 0) return [muted(`  ${t('usage.no_token')}`)];

  const { padName, padNameColored, num } = table;
  const sessionTotal = sumTokenRows(entries.map(([, row]) => row));
  const subagentRows = Object.values(subagentUsage ?? {});
  const subagentTotal = sumTokenRows(subagentRows);

  const lines: string[] = [];
  // 1. Session total, then a main/sub split so the relationship is explicit:
  //    session total = main agent + sub-agents (no double-counting).
  lines.push(padName(t('usage.session_total')) + num(sessionTotal.input) + num(sessionTotal.output) + num(sessionTotal.input + sessionTotal.output));
  if (subagentRows.length > 0) {
    const mainInput = Math.max(0, sessionTotal.input - subagentTotal.input);
    const mainOutput = Math.max(0, sessionTotal.output - subagentTotal.output);
    lines.push(
      padName(`  ├ ${t('usage.main_agent')}`) + num(mainInput) + num(mainOutput) + num(mainInput + mainOutput),
    );
    lines.push(
      padName(`  └ ${t('usage.sub_agent')}`) + num(subagentTotal.input) + num(subagentTotal.output) + num(subagentTotal.input + subagentTotal.output),
    );
  }

  // 2. Per-model breakdown. Truncate the plain model name first, then
  // colour — truncating an ANSI-wrapped string would cut the escape code.
  lines.push(usageTableHeader(table, t('usage.model')));
  for (const [model, row] of entries) {
    const input = usageInputTotal(row);
    const output = usageNumber(row.output);
    lines.push(padNameColored(model, muted) + num(input) + num(output) + num(input + output));
  }
  return lines;
}

function buildManagedUsageSection(
  usage: ManagedUsageReport | undefined,
  error: string | undefined,
  accent: Colorize,
  value: Colorize,
  muted: Colorize,
  errorStyle: Colorize,
  severityHex: (sev: 'ok' | 'warn' | 'danger') => string,
  nameWidth?: number,
): string[] {
  if (error !== undefined) return [accent(t('usage.managed_title')), errorStyle(`  ${error}`)];
  if (usage === undefined) return [];
  const { summary, limits } = usage;
  if (summary === null && limits.length === 0) {
    return [accent(t('usage.managed_title')), muted(`  ${t('usage.no_data')}`)];
  }

  const rows: ManagedUsageRow[] = [];
  if (summary !== null) rows.push(summary);
  rows.push(...limits);
  const usedRatio = (r: ManagedUsageRow): number =>
    r.limit > 0 ? Math.max(0, Math.min(r.used / r.limit, 1)) : 0;
  const pctWidth = Math.max(
    ...rows.map((r) => visibleWidth(`${Math.round(usedRatio(r) * 100)}% ${t('usage.used')}`)),
  );
  const out: string[] = [accent(t('usage.managed_title'))];
  for (const row of rows) {
    const ratioUsed = usedRatio(row);
    const bar = renderProgressBar(ratioUsed, 20);
    const pct = `${Math.round(ratioUsed * 100)}% ${t('usage.used')}`;
    const barColoured = chalk.hex(severityHex(ratioSeverity(ratioUsed)))(bar);
    const label = nameWidth === undefined
      ? `  ${muted(row.label.padEnd(Math.max(10, ...rows.map((r) => r.label.length)), ' '))}`
      : `  ${muted(row.label)}${' '.repeat(Math.max(0, nameWidth - visibleWidth(row.label) - 2))}`;
    const resetStr = row.resetHint ? `  ${muted(row.resetHint)}` : '';
    const pctPad = Math.max(0, pctWidth - visibleWidth(pct));
    out.push(`${label}  ${barColoured}  ${value(pct + ' '.repeat(pctPad))}${resetStr}`);
  }
  return out;
}

export function buildManagedUsageReportLines(options: ManagedUsageReportLineOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);

  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success;

  return buildManagedUsageSection(
    options.managedUsage,
    options.managedUsageError,
    accent,
    value,
    muted,
    errorStyle,
    severityHex,
    options.nameWidth,
  );
}


function buildSubagentUsageSection(
  usage: SubagentUsageMap | undefined,
  table: UsageTable,
  muted: Colorize,
): string[] {
  const entries = Object.entries(usage ?? {});
  if (entries.length === 0) return [];

  const { padNameColored, num } = table;
  const lines: string[] = [usageTableHeader(table, t('usage.sub_agent'))];
  for (const [name, row] of entries) {
    const input = usageInputTotal(row);
    const output = usageNumber(row.output);
    lines.push(padNameColored(name, muted) + num(input) + num(output) + num(input + output));
  }
  return lines;
}

export function buildUsageReportLines(options: UsageReportOptions): string[] {
  const colors = options.colors;
  const accent = chalk.hex(colors.primary).bold;
  const value = chalk.hex(colors.text);
  const muted = chalk.hex(colors.textDim);
  const errorStyle = chalk.hex(colors.error);
  const severityHex = (sev: 'ok' | 'warn' | 'danger'): string =>
    sev === 'danger' ? colors.error : sev === 'warn' ? colors.warning : colors.success;

  const byModel = (options.sessionUsage as { readonly byModel?: Record<string, TokenUsage> } | undefined)
    ?.byModel;
  const modelNames = Object.keys(byModel ?? {});
  const subagentNames = Object.keys(options.subagentUsage ?? {});
  const table = makeUsageTable(
    [
      t('usage.session_total'),
      `  ├ ${t('usage.main_agent')}`,
      `  └ ${t('usage.sub_agent')}`,
      t('usage.model'),
      ...modelNames,
      t('usage.context_window'),
      t('usage.sub_agent'),
      ...subagentNames,
      t('usage.managed_title'),
    ],
    options.terminalWidth,
  );

  const lines: string[] = buildSessionUsageSection(
    options.sessionUsage,
    options.sessionUsageError,
    table,
    value,
    muted,
    errorStyle,
    options.subagentUsage,
  );

  if (options.maxContextTokens > 0) {
    const ratio = safeUsageRatio(options.contextUsage);
    const bar = renderProgressBar(ratio, 20);
    const pct = `${(ratio * 100).toFixed(1)}%`;
    const barColoured = chalk.hex(severityHex(ratioSeverity(ratio)))(bar);
    lines.push('');
    lines.push(
      table.padName(t('usage.context_window')) +
        ` ${barColoured}  ${value(pct.padStart(6, ' '))}  ` +
        muted(
          `(${formatTokenCount(options.contextTokens)} / ${formatTokenCount(options.maxContextTokens)})`,
        ),
    );
  }

  const managedSection = buildManagedUsageReportLines({
    colors,
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
    nameWidth: table.nameWidth,
  });
  if (managedSection.length > 0) {
    lines.push('');
    lines.push(...managedSection);
  }

  const subagentSection = buildSubagentUsageSection(options.subagentUsage, table, muted);
  if (subagentSection.length > 0) {
    lines.push('');
    lines.push(...subagentSection);
  }

  return lines;
}

export class UsagePanelComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly lines: readonly string[],
    private readonly borderHex: string,
    private readonly title: string = t('usage.panel_title'),
  ) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const paint = (s: string): string => chalk.hex(this.borderHex)(s);
    const indent = ' '.repeat(LEFT_MARGIN);

    const availableInterior = Math.max(
      MIN_INTERIOR_WIDTH,
      width - LEFT_MARGIN - 2 - 2 * SIDE_PADDING,
    );
    const longestLine = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const contentWidth = Math.max(
      MIN_INTERIOR_WIDTH,
      Math.min(availableInterior, longestLine, Math.max(longestLine, this.title.length)),
    );
    const horzLen = contentWidth + 2 * SIDE_PADDING;

    const trailingDashLen = Math.max(0, horzLen - visibleWidth(this.title));
    const top =
      indent + paint('╭') + paint(this.title) + paint('─'.repeat(trailingDashLen)) + paint('╮');
    const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

    const out: string[] = [top];
    for (const line of this.lines) {
      const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(indent + paint('│') + ' ' + clipped + ' '.repeat(pad) + ' ' + paint('│'));
    }
    out.push(bottom);

    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }
}
