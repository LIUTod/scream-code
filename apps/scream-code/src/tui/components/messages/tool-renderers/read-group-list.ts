/**
 * Batch file reader (`ReadGroup`) result renderer.
 *
 * The tool returns one `--- path ---` section per file. The card's header chip
 * carries the numeric summary (see chip.ts), so the body is empty while
 * collapsed and lists the paths with their own line counts once expanded —
 * capped at the standard preview budget, like every other tool body.
 *
 * Errors fall through to the truncated renderer so the real message is visible.
 */

import type { Component } from '@liutod-scream/pi-tui';
import { Text } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import { TOOL_OUTPUT_PREVIEW_LINES } from '#/tui/constant/rendering';

import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

// Column-0 git merge conflict markers. The reader prefixes each line with
// `NNN\t`, so that prefix is stripped before scanning.
const CONFLICT_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)/;

export interface ReadGroupEntry {
  readonly filePath: string;
  readonly lines: number;
  readonly failed: boolean;
  readonly hasConflicts: boolean;
}

function detectConflictMarkers(contentLines: readonly string[]): boolean {
  for (const raw of contentLines) {
    const tabIdx = raw.indexOf('\t');
    const line = tabIdx >= 0 ? raw.slice(tabIdx + 1) : raw;
    if (CONFLICT_MARKER_RE.test(line)) return true;
  }
  return false;
}

/** Parses the `--- path ---` sections of the batch reader's output. */
export function parseReadGroupOutput(output: string): ReadGroupEntry[] {
  const results: ReadGroupEntry[] = [];
  const lines = output.split('\n');
  let currentPath: string | undefined;
  let currentLines: string[] = [];

  const finishSection = (path: string | undefined, contentLines: string[]): void => {
    if (path === undefined) return;
    const text = contentLines.join('\n');
    const trimmed = text.trimStart();
    if (trimmed.startsWith('[ERROR]')) {
      results.push({ filePath: path, lines: 0, failed: true, hasConflicts: false });
      return;
    }
    // The reader appends trailing blocks (`Imports:`, `Skipped:`, …) after the
    // content, so the count is searched anywhere in the section and the last
    // report wins — anchoring to the section end dropped it to zero.
    let lineCount = 0;
    for (const match of text.matchAll(/(\d+)\s+lines?\s+read\s+from\s+file/g)) {
      const count = match[1];
      if (count !== undefined) lineCount = parseInt(count, 10);
    }
    const hasConflicts = detectConflictMarkers(contentLines);
    results.push({ filePath: path, lines: lineCount, failed: false, hasConflicts });
  };

  for (const line of lines) {
    const match = line.match(/^---\s+(.+?)\s+---$/);
    if (match !== null) {
      finishSection(currentPath, currentLines);
      currentPath = match[1];
      currentLines = [];
    } else if (currentPath !== undefined) {
      currentLines.push(line);
    }
  }
  finishSection(currentPath, currentLines);

  return results;
}

export const readGroupListSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);
  if (!ctx.expanded) return [];
  const entries = parseReadGroupOutput(result.output);
  if (entries.length === 0) return renderTruncated(toolCall, result, ctx);

  const shown = entries.slice(0, TOOL_OUTPUT_PREVIEW_LINES);
  const rows = shown.map((entry) => {
    const path = chalk.hex(ctx.colors.text)(entry.filePath);
    if (entry.failed) {
      return `${path}${chalk.hex(ctx.colors.error)(t('readgroup.failed_suffix'))}`;
    }
    let tail = chalk.dim(t('readgroup.lines_suffix', { count: String(entry.lines) }));
    if (entry.hasConflicts) {
      tail += chalk.hex(ctx.colors.warning)(` ⚠ ${t('readgroup.conflict_suffix')}`);
    }
    return `${path}${tail}`;
  });
  const remaining = entries.length - shown.length;
  if (remaining > 0) {
    rows.push(chalk.dim(t('readgroup.more_files', { count: String(remaining) })));
  }

  const components: Component[] = [new Text(rows.map((row) => `  ${row}`).join('\n'), 0, 0)];
  return components;
};
