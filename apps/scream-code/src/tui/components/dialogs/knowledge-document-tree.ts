/**
 * KnowledgeDocumentTree — collapsible tree view for /knowledge list.
 *
 * Replaces the flat KnowledgeResultViewer when listing documents: sources
 * (files) are top-level rows, expandable to reveal chunk headings. Default
 * state is collapsed so the user sees a clean file list instead of every
 * chunk heading at once.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  type Focusable,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '@/tui/theme/colors';
import { printableChar } from '@/tui/utils/printable-key';
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSource,
} from '@scream-code/knowledge';

const ELLIPSIS = '…';

export interface KnowledgeDocumentTreeEntry {
  readonly source: KnowledgeSource;
  readonly document: KnowledgeDocument & { sourceName: string };
  readonly chunks: readonly KnowledgeChunk[];
}

export interface KnowledgeDocumentTreeProps {
  readonly title: string;
  readonly entries: readonly KnowledgeDocumentTreeEntry[];
  readonly colors: ColorPalette;
  readonly onClose: () => void;
}

type RenderLine =
  | {
      kind: 'source';
      sourceId: string;
      label: string;
      meta: string;
      expanded: boolean;
    }
  | {
      kind: 'chunk';
      sourceId: string;
      heading: string;
    };

export class KnowledgeDocumentTree extends Container implements Focusable {
  focused = false;

  private title: string;
  private colors: ColorPalette;
  private readonly onClose: () => void;
  private readonly terminal: Terminal;
  private readonly entries: KnowledgeDocumentTreeEntry[];
  private expanded: Set<string>;
  private cursor = 0;
  private scrollTop = 0;

  constructor(props: KnowledgeDocumentTreeProps, terminal: Terminal) {
    super();
    this.title = props.title;
    this.colors = props.colors;
    this.onClose = props.onClose;
    this.terminal = terminal;
    this.entries = [...props.entries];
    this.expanded = new Set<string>();
  }

  handleInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.moveCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.moveCursor(1);
      return;
    }
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.space) ||
      k === ' '
    ) {
      this.toggleAtCursor();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.expandAtCursor();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.collapseAtCursor();
      return;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.cursor = 0;
      this.clampScroll();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      const lines = this.buildRenderLines();
      this.cursor = Math.max(0, lines.length - 1);
      this.clampScroll();
      this.invalidate();
      return;
    }
  }

  private moveCursor(delta: number): void {
    const lines = this.buildRenderLines();
    if (lines.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.cursor + delta, lines.length - 1));
    this.clampScroll();
    this.invalidate();
  }

  private toggleAtCursor(): void {
    const line = this.buildRenderLines()[this.cursor];
    if (line === undefined || line.kind !== 'source') return;
    if (this.expanded.has(line.sourceId)) {
      this.expanded.delete(line.sourceId);
    } else {
      this.expanded.add(line.sourceId);
    }
    this.clampScroll();
    this.invalidate();
  }

  private expandAtCursor(): void {
    const line = this.buildRenderLines()[this.cursor];
    if (line === undefined || line.kind !== 'source') return;
    if (!this.expanded.has(line.sourceId)) {
      this.expanded.add(line.sourceId);
      this.clampScroll();
      this.invalidate();
    }
  }

  private collapseAtCursor(): void {
    const line = this.buildRenderLines()[this.cursor];
    if (line === undefined) return;
    if (line.kind === 'source') {
      if (this.expanded.has(line.sourceId)) {
        this.expanded.delete(line.sourceId);
        this.clampScroll();
        this.invalidate();
      }
      return;
    }
    // On a chunk row: jump to its parent source and collapse.
    this.expanded.delete(line.sourceId);
    const lines = this.buildRenderLines();
    const parentIdx = lines.findIndex(
      (l) => l.kind === 'source' && l.sourceId === line.sourceId,
    );
    if (parentIdx >= 0) this.cursor = parentIdx;
    this.clampScroll();
    this.invalidate();
  }

  private buildRenderLines(): RenderLine[] {
    const out: RenderLine[] = [];
    for (const entry of this.entries) {
      const expanded = this.expanded.has(entry.source.id);
      out.push({
        kind: 'source',
        sourceId: entry.source.id,
        label: entry.source.name,
        meta: `${String(entry.chunks.length)} chunks · ${entry.document.status}`,
        expanded,
      });
      if (expanded) {
        for (const chunk of entry.chunks) {
          out.push({
            kind: 'chunk',
            sourceId: entry.source.id,
            heading: chunk.heading ?? '(无标题)',
          });
        }
      }
    }
    return out;
  }

  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  private maxScroll(): number {
    const lines = this.buildRenderLines();
    return Math.max(0, lines.length - this.viewableRows());
  }

  private clampScroll(): void {
    const max = this.maxScroll();
    if (this.scrollTop > max) this.scrollTop = max;
    if (this.scrollTop < 0) this.scrollTop = 0;
    const view = this.viewableRows();
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    if (this.cursor >= this.scrollTop + view) {
      this.scrollTop = this.cursor - view + 1;
    }
  }

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;

    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width);

    const out: string[] = [header];
    for (const line of body) out.push(line);
    out.push(footer);
    return out;
  }

  private renderHeader(width: number): string {
    const title = chalk.hex(this.colors.primary).bold(` ${this.title} `);
    return fitExactly(title, width);
  }

  private renderBody(width: number, bodyHeight: number): string[] {
    const stroke = this.colors.primary;
    const innerWidth = Math.max(1, width - 4);

    const lines = this.buildRenderLines();
    const viewRows = bodyHeight - 2;
    const top = chalk.hex(stroke)('┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = chalk.hex(stroke)('└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [top];
    if (lines.length === 0) {
      const empty = chalk.hex(this.colors.textMuted)('(空)');
      out.push(
        chalk.hex(stroke)('│ ') +
          fitExactly(empty, innerWidth) +
          chalk.hex(stroke)(' │'),
      );
    } else {
      const start = this.scrollTop;
      const end = Math.min(lines.length, start + viewRows);
      for (let i = start; i < end; i++) {
        const line = lines[i]!;
        const isSelected = i === this.cursor;
        out.push(this.renderLine(line, isSelected, innerWidth, stroke));
      }
    }
    while (out.length < bodyHeight - 1) {
      out.push(
        chalk.hex(stroke)('│ ') +
          ' '.repeat(innerWidth) +
          chalk.hex(stroke)(' │'),
      );
    }
    out.push(bottom);
    return out;
  }

  private renderLine(
    line: RenderLine,
    selected: boolean,
    innerWidth: number,
    stroke: string,
  ): string {
    let content: string;
    if (line.kind === 'source') {
      const marker = line.expanded ? '▼' : '▶';
      const icon = '📁';
      const label = `${icon} ${marker} ${line.label}`;
      const meta = chalk.hex(this.colors.textMuted)(` (${line.meta})`);
      const styled = selected
        ? chalk.hex(this.colors.primary).bold(label) + meta
        : chalk.hex(this.colors.text)(label) + meta;
      content = styled;
    } else {
      const indent = '  ';
      const bullet = '•';
      const text = `${indent}${bullet} ${line.heading}`;
      content = selected
        ? chalk.hex(this.colors.primary)(text)
        : chalk.hex(this.colors.textMuted)(text);
    }
    return (
      chalk.hex(stroke)('│ ') +
      fitExactly(content, innerWidth) +
      chalk.hex(stroke)(' │')
    );
  }

  private renderFooter(width: number): string {
    const key = (text: string): string => chalk.hex(this.colors.primary).bold(text);
    const dim = (text: string): string => chalk.hex(this.colors.textMuted)(text);

    const lines = this.buildRenderLines();
    const total = lines.length;
    const view = this.viewableRows();
    const maxScroll = Math.max(0, total - view);
    const percent = maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
    const position = chalk.hex(this.colors.textMuted)(
      ` ${String(Math.min(this.cursor + 1, total))}/${String(total)} (${String(percent)}%) `,
    );

    const keys =
      `${key('↑↓')} ${dim('移动')}  ` +
      `${key('→/Enter')} ${dim('展开')}  ` +
      `${key('←')} ${dim('折叠')}  ` +
      `${key('g/G')} ${dim('顶/底')}  ` +
      `${key('Q/Esc')} ${dim('返回')}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}
