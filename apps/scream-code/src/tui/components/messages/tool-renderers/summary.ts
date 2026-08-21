/**
 * Summary-style renderers — produce optional inline-glance content for
 * tools whose raw output is high-volume but low-information (Grep,
 * Glob, Read). The numeric summary (line counts, exit codes, sizes)
 * lives in the header chip (see chip.ts), so most tools intentionally
 * render an empty body and only expose details when the global expand
 * toggle is on.
 *
 * Errors always fall through to the truncated renderer so the user sees
 * the actual error message, not a synthetic summary.
 */

import type { Component } from '@liutod-scream/pi-tui';
import { Text, visibleWidth } from '@liutod-scream/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import { GlanceLinesComponent } from './glance-lines';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

const GLANCE_SAMPLES = 3;
const MAX_EXTENSION_COUNTS = 4;
const MAX_DIRECTORY_GROUPS = 3;

type GlanceFn = (
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  colors: ColorPalette,
) => string | Component;

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    if (result.is_error) return renderTruncated(toolCall, result, ctx);

    const out: Component[] = [];
    if (glance !== null) {
      const glanceOut = glance(toolCall, result, ctx.colors);
      if (typeof glanceOut === 'string') {
        if (glanceOut.length > 0) {
          // Indent every line so multi-line glances stay aligned when the
          // terminal wraps long paths. Without this, wrap continuations
          // start at column 0 and look unaligned with the first indented row.
          const indented = glanceOut
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n');
          out.push(new Text(indented, 0, 0));
        }
      } else {
        // Component glances (e.g. Grep samples) manage their own indent and
        // truncate to render width instead of wrapping.
        out.push(glanceOut);
      }
    }
    if (ctx.expanded && result.output.length > 0) {
      out.push(new Text(chalk.dim(result.output), 4, 0));
    }
    return out;
  };
}

function nonEmptyLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n').filter((line) => line.length > 0);
}

// Strip a trailing `:line:col:text` so the glance shows the file path
// only, even when grep is in `content` mode (`src/foo.ts:42:    foo()`).
function pathFromGrepLine(line: string): string {
  const idx = line.indexOf(':');
  if (idx <= 0) return line;
  const second = line.indexOf(':', idx + 1);
  if (second <= 0) return line;
  return line.slice(0, second);
}

interface GrepMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function readSearchResultsMatches(result: ToolResultBlockData): GrepMatch[] | undefined {
  const display = result.display;
  if (display === undefined) return undefined;
  if (display.kind !== 'search_results') return undefined;
  return display.matches;
}

// Directory part dim, basename in terminal default color — the basename pops
// without dyeing the whole path in the amber tool color.
function styleFilePath(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return path;
  return `${chalk.dim(path.slice(0, idx + 1))}${path.slice(idx + 1)}`;
}

const grepGlance: GlanceFn = (_toolCall, result, colors) => {
  const matches = readSearchResultsMatches(result);
  if (matches !== undefined && matches.length > 0) {
    const samples = matches.slice(0, GLANCE_SAMPLES);
    // Column-align: pad `path:line` to the widest sample so every match text
    // starts in the same column regardless of path length.
    const plainLocs = samples.map((m) =>
      m.line > 0 ? `${m.file}:${String(m.line)}` : m.file,
    );
    const colWidth = Math.max(...plainLocs.map((s) => visibleWidth(s)));
    const lineNoColor = chalk.hex(colors.roleTool);
    const lines = samples.map((m, i) => {
      const loc =
        m.line > 0
          ? `${styleFilePath(m.file)}${chalk.dim(':')}${lineNoColor(String(m.line))}`
          : styleFilePath(m.file);
      const pad = ' '.repeat(Math.max(0, colWidth - visibleWidth(plainLocs[i] ?? '')));
      const text = m.text.trim();
      return text.length > 0 ? `${loc}${pad}  ${chalk.dim(text)}` : `${loc}${pad}`;
    });
    const remaining = matches.length - GLANCE_SAMPLES;
    if (remaining > 0) {
      lines.push(chalk.dim(`+${String(remaining)} more`));
    }
    return new GlanceLinesComponent(lines);
  }
  // Fallback: parse paths out of the text output for `files_with_matches`
  // mode or older persisted results that don't carry a structured display.
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';
  const samples = lines.slice(0, GLANCE_SAMPLES).map(pathFromGrepLine);
  const remaining = lines.length - samples.length;
  const out = samples.map((s) => styleFilePath(s));
  if (remaining > 0) {
    out.push(chalk.dim(`+${String(remaining)} more`));
  }
  return new GlanceLinesComponent(out);
};

function fileBasename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function fileDirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return path.slice(0, idx);
}

function fileExtension(path: string): string {
  const base = fileBasename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function groupByDirectory(paths: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const dir = fileDirname(path);
    const group = groups.get(dir) ?? [];
    group.push(fileBasename(path));
    groups.set(dir, group);
  }
  return groups;
}

function countExtensions(paths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const ext = fileExtension(path);
    const key = ext.length > 0 ? `.${ext}` : '(no-ext)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const globGlance: GlanceFn = (_toolCall, result, colors) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return '';

  const dirColor = chalk.hex(colors.roleTool);
  const nameColor = chalk.hex(colors.primary);
  const dim = chalk.dim;

  // Directory grouping: `dir/ · file1, file2, file3 (+N)`
  const dirGroups = groupByDirectory(lines);
  const dirEntries = [...dirGroups.entries()].slice(0, MAX_DIRECTORY_GROUPS);
  const dirParts = dirEntries.map(([dir, names]) => {
    const head = `${dirColor(`${dir}/`)}${dim(' · ')}`;
    const shown = names.slice(0, GLANCE_SAMPLES).map((n) => nameColor(n)).join(dim(', '));
    const more = names.length - GLANCE_SAMPLES;
    const tail = more > 0 ? dim(` (+${String(more)})`) : '';
    return `${head}${shown}${tail}`;
  });
  const dirLine = dirParts.join(dim('  '));

  // Extension counts: `.ts: 5, .md: 3, ...`
  const extCounts = countExtensions(lines);
  const extEntries = [...extCounts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_EXTENSION_COUNTS);
  const extLine = extEntries
    .map(([ext, count]) => `${dim(ext)}:${dim(` ${String(count)}`)}`)
    .join(dim(', '));

  if (extLine.length === 0) return dirLine;
  return `${dirLine}${dim('  ')}${extLine}`;
};

function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function countOutputLines(output: string): number {
  if (output.length === 0) return 0;
  let count = 0;
  for (const line of output.split('\n')) {
    if (line.length > 0) count += 1;
  }
  return count;
}

const readGlance: GlanceFn = (toolCall, result, colors) => {
  const path = strArg(toolCall.args, 'path', 'file_path', 'filePath');
  if (path.length === 0) return '';
  const lineCount = countOutputLines(result.output);
  const ext = fileExtension(path);
  const dim = chalk.dim;
  const accentColor = chalk.hex(colors.primary);
  // The chip already shows `Read (relative/path.ts)`, so the glance just
  // surfaces the line count and extension underneath — no path duplication.
  const parts: string[] = [];
  if (lineCount > 0) parts.push(`${String(lineCount)} lines`);
  if (ext.length > 0) parts.push(accentColor(ext));
  if (parts.length === 0) return '';
  return parts.join(dim(' · '));
};

interface WebSearchEntry {
  readonly title: string;
  readonly url: string;
}

/**
 * Parse the fixed WebSearch output protocol emitted by
 * `web-search.ts` (`Title: …` / `Date: …` / `URL: …` / `Snippet: …`,
 * entries separated by `---`) into structured entries so the collapsed
 * card can show a title/URL glance instead of a bare "N results" chip.
 */
function parseWebSearchOutput(output: string): WebSearchEntry[] {
  const entries: WebSearchEntry[] = [];
  let title: string | undefined;
  let url: string | undefined;
  let inSnippet = false;
  for (const line of output.split('\n')) {
    if (line.startsWith('---')) {
      if (title !== undefined || url !== undefined) {
        entries.push({ title: title ?? '', url: url ?? '' });
      }
      title = undefined;
      url = undefined;
      inSnippet = false;
      continue;
    }
    // Page content appended by `include_content` may contain arbitrary
    // lines; stop field parsing once the snippet begins so a `Title:` /
    // `URL:` / `---` inside the body cannot corrupt the current entry.
    if (inSnippet) continue;
    if (line.startsWith('Snippet: ')) {
      inSnippet = true;
    } else if (line.startsWith('Title: ')) {
      title = line.slice('Title: '.length);
    } else if (line.startsWith('URL: ')) {
      url = line.slice('URL: '.length);
    }
  }
  if (title !== undefined || url !== undefined) {
    entries.push({ title: title ?? '', url: url ?? '' });
  }
  return entries;
}

function truncateText(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const webSearchGlance: GlanceFn = (_toolCall, result, colors) => {
  const entries = parseWebSearchOutput(result.output);
  if (entries.length === 0) return '';
  const titleColor = chalk.hex(colors.roleTool);
  const dim = chalk.dim;
  const lines = entries.slice(0, GLANCE_SAMPLES).map((e) => {
    const title = e.title.length > 0 ? titleColor(truncateText(e.title)) : '';
    const url = e.url.length > 0 ? dim(truncateText(e.url)) : '';
    return [title, url].filter((s) => s.length > 0).join(dim(' — '));
  });
  const remaining = entries.length - GLANCE_SAMPLES;
  if (remaining > 0) {
    lines.push(dim(`+${String(remaining)} more`));
  }
  return lines.join('\n');
};

// ── Exports ──────────────────────────────────────────────────────────

// Tools whose chip already conveys everything — the body is empty in
// the collapsed state and only the raw output appears when expanded.
export const fetchSummary: ResultRenderer = withGlance(null);
export const webSearchSummary: ResultRenderer = withGlance(webSearchGlance);
export const thinkSummary: ResultRenderer = withGlance(null);
export const editSummary: ResultRenderer = withGlance(null);
export const writeSummary: ResultRenderer = withGlance(null);

// Tools that benefit from inline path samples below the chip.
export const readSummary: ResultRenderer = withGlance(readGlance);
export const grepSummary: ResultRenderer = withGlance(grepGlance);
export const globSummary: ResultRenderer = withGlance(globGlance);
