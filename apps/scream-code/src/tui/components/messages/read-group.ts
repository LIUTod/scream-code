/**
 * ReadGroupComponent renders 2+ Read tool calls from the same step as one group.
 *
 * It follows the same structure as `AgentGroupComponent`, with a smaller
 * surface:
 * - one summary header and a tree body listing each file path and status;
 * - permanently grouped, while the body remains visible;
 * - 200ms throttling, matching AgentGroup;
 * - state stays in each `ToolCallComponent`; the group only reads snapshots.
 *
 * Header forms:
 *   pending > 0: Reading {N} files
 *   all done:    Read {N} files · {L} lines
 *   some failed: append · {F} failed
 *   all failed:  Read {N} files · failed
 *
 * Body lines follow AgentGroup's branch style:
 *   src/main.ts · 51 lines
 *   src/cli.ts · reading
 *   src/missing.ts · failed
 *   src/conflict.ts · 12 lines ⚠ conflict
 */

import type { TUI } from '@liutod-scream/pi-tui';
import { Container, Spacer, Text } from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import { t } from '@scream-code/config';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

import type { ToolCallComponent, ToolCallReadSnapshot } from './tool-call';

const THROTTLE_MS = 200;
// Column-0 git merge conflict markers. Read's output prefixes each line
// with `NNN\t` so we strip that before scanning for markers at column 0.
const CONFLICT_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)/;

interface ReadEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export interface DirectResult {
  readonly filePath: string;
  readonly lines: number;
  readonly failed: boolean;
  readonly hasConflicts?: boolean;
}

function detectConflictMarkers(contentLines: readonly string[]): boolean {
  for (const raw of contentLines) {
    // Strip the `NNN\t` line-number prefix that Read attaches.
    const tabIdx = raw.indexOf('\t');
    const line = tabIdx >= 0 ? raw.slice(tabIdx + 1) : raw;
    if (CONFLICT_MARKER_RE.test(line)) return true;
  }
  return false;
}

export function parseReadGroupOutput(output: string): DirectResult[] {
  const results: DirectResult[] = [];
  const lines = output.split('\n');
  let currentPath: string | undefined;
  let currentLines: string[] = [];

  const finishSection = (path: string | undefined, contentLines: string[]): void => {
    if (path === undefined) return;
    const text = contentLines.join('\n');
    const trimmed = text.trimStart();
    if (trimmed.startsWith('[ERROR]')) {
      results.push({ filePath: path, lines: 0, failed: true });
      return;
    }
    const systemMatch = text.match(/<system>([\s\S]*?)<\/system>\s*$/);
    let lineCount = 0;
    if (systemMatch !== null) {
      const systemBody = systemMatch[1];
      if (systemBody !== undefined) {
        const lineMatch = systemBody.match(/(\d+)\s+lines?\s+read\s+from\s+file/);
        if (lineMatch !== null) {
          const count = lineMatch[1];
          if (count !== undefined) lineCount = parseInt(count, 10);
        }
      }
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

export class ReadGroupComponent extends Container {
  private readonly entries: ReadEntry[] = [];
  private directResults: DirectResult[] | undefined;
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallReadSnapshot['phase']>();

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
  }

  size(): number {
    return this.directResults?.length ?? this.entries.length;
  }

  setResults(results: DirectResult[]): void {
    this.directResults = results;
    this.flushRender();
  }

  /**
   * Borrows a standalone `ToolCallComponent` into the group as a hidden state
   * container. Snapshot changes trigger throttled refreshes. Re-attaching the
   * same toolCallId is a no-op.
   */
  attach(toolCallId: string, tc: ToolCallComponent): void {
    if (this.entries.some((e) => e.toolCallId === toolCallId)) return;
    this.entries.push({ toolCallId, tc });
    tc.setSnapshotListener(() => {
      this.scheduleRender();
    });
    this.flushRender();
  }

  /**
   * The pending -> done/failed transition is the important visible change, so
   * it refreshes immediately. Other changes are throttled.
   */
  private scheduleRender(): void {
    if (this.detectPhaseTransition()) {
      this.flushRender();
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flushRender();
    }, THROTTLE_MS);
  }

  private detectPhaseTransition(): boolean {
    for (const e of this.entries) {
      const phase = e.tc.getReadSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) return true;
    }
    return false;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    if (this.directResults !== undefined) {
      this.renderDirectResults();
      return;
    }

    const snapshots = this.entries.map((e) => e.tc.getReadSnapshot());
    let pending = 0;
    let failed = 0;
    let totalLines = 0;
    for (const snap of snapshots) {
      if (snap.phase === 'pending') pending += 1;
      else if (snap.phase === 'failed') failed += 1;
      else totalLines += snap.lines;
    }
    this.headerText.setText(this.buildHeader(snapshots.length, pending, failed, totalLines));

    this.bodyContainer.clear();
    const visibleSnapshots = snapshots.filter(
      (snap) => snap.filePath !== undefined && snap.filePath.length > 0,
    );
    visibleSnapshots.forEach((snap, idx) => {
      const isLast = idx === visibleSnapshots.length - 1;
      this.bodyContainer.addChild(new Text(this.buildBodyLine(snap, isLast), 0, 0));
    });

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private renderDirectResults(): void {
    const results = this.directResults ?? [];
    let failed = 0;
    let totalLines = 0;
    for (const r of results) {
      if (r.failed) failed += 1;
      else totalLines += r.lines;
    }
    this.headerText.setText(this.buildHeader(results.length, 0, failed, totalLines));

    this.bodyContainer.clear();
    results.forEach((r, idx) => {
      const isLast = idx === results.length - 1;
      this.bodyContainer.addChild(new Text(this.buildDirectBodyLine(r, isLast), 0, 0));
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(total: number, pending: number, failed: number, totalLines: number): string {
    const colors = this.colors;
    const dim = chalk.dim;

    if (pending > 0) {
      const bullet = chalk.hex(colors.roleAssistant)(STATUS_BULLET);
      const label = chalk.hex(colors.primary).bold(t('readgroup.reading', { count: total }));
      return `${bullet}${label}`;
    }

    // All reads have finished, either successfully or with failures.
    if (failed === total) {
      const bullet = chalk.hex(colors.error)('✗ ');
      const label = chalk.hex(colors.error).bold(t('readgroup.read', { count: total }));
      return `${bullet}${label}${chalk.hex(colors.error)(t('readgroup.failed_suffix'))}`;
    }

    const bullet = chalk.hex(colors.success)(STATUS_BULLET);
    const label = chalk.hex(colors.primary).bold(t('readgroup.read', { count: total }));
    const linesPart = dim(t('readgroup.lines_suffix', { count: totalLines }));
    const failPart = failed > 0 ? chalk.hex(colors.error)(t('readgroup.failed_count', { count: failed })) : '';
    return `${bullet}${label}${linesPart}${failPart}`;
  }

  private buildBodyLine(snap: ToolCallReadSnapshot, isLast: boolean): string {
    const colors = this.colors;
    const dim = chalk.dim;
    const branch = isLast ? '└─' : '├─';
    const path = snap.filePath ?? '';
    const pathPart = chalk.hex(colors.text)(path);

    let tail: string;
    if (snap.phase === 'pending') {
      tail = dim(t('readgroup.reading_suffix'));
    } else if (snap.phase === 'failed') {
      tail = chalk.hex(colors.error)(t('readgroup.failed_suffix'));
    } else {
      tail = dim(t('readgroup.lines_suffix', { count: snap.lines }));
    }
    return `  ${branch} ${pathPart}${tail}`;
  }

  private buildDirectBodyLine(result: DirectResult, isLast: boolean): string {
    const colors = this.colors;
    const dim = chalk.dim;
    const branch = isLast ? '└─' : '├─';
    const pathPart = chalk.hex(colors.text)(result.filePath);

    let tail: string;
    if (result.failed) {
      tail = chalk.hex(colors.error)(t('readgroup.failed_suffix'));
    } else {
      tail = dim(t('readgroup.lines_suffix', { count: result.lines }));
      if (result.hasConflicts) {
        tail = `${tail}${chalk.hex(colors.warning)(` ⚠ ${t('readgroup.conflict_suffix')}`)}`;
      }
    }
    return `  ${branch} ${pathPart}${tail}`;
  }

  /** Releases throttle timers so destroyed components cannot refresh later. */
  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    for (const e of this.entries) {
      e.tc.setSnapshotListener(undefined);
    }
  }
}
