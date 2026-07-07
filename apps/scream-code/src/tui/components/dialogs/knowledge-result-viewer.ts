/**
 * KnowledgeResultViewer — full-screen scrollable text viewer for /knowledge
 * command results (document list, search results, stats). Replaces the
 * previous approach of dumping results into the transcript via showNotice,
 * which pushed the input area down and cluttered the view.
 *
 * Mounted via `host.mountEditorReplacement` while the menu is closed; on
 * close, the caller re-shows the menu.
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
import { t } from '@scream-code/config';

const ELLIPSIS = '…';

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

export interface KnowledgeResultViewerProps {
  readonly title: string;
  readonly content: string;
  readonly colors: ColorPalette;
  readonly onClose: () => void;
}

export class KnowledgeResultViewer extends Container implements Focusable {
  focused = false;

  private title: string;
  private colors: ColorPalette;
  private readonly onClose: () => void;
  private lines: string[];
  private scrollTop = 0;
  private readonly terminal: Terminal;

  constructor(props: KnowledgeResultViewerProps, terminal: Terminal) {
    super();
    this.title = props.title;
    this.colors = props.colors;
    this.onClose = props.onClose;
    this.terminal = terminal;
    this.lines = props.content.length > 0 ? props.content.split('\n') : [t('kresult.empty')];
  }

  handleInput(data: string): void {
    const visible = this.viewableRows();
    const k = printableChar(data);

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q' || matchesKey(data, Key.enter)) {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp) || k === ' ' || data === '' /* C-b */) {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.pageDown) || data === '' /* C-f */) {
      this.scrollBy(Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      this.scrollTo(this.maxScroll());
      return;
    }
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollTop + delta);
  }

  private scrollTo(target: number): void {
    this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
    this.invalidate();
  }

  private maxScroll(): number {
    return Math.max(0, this.lines.length - this.viewableRows());
  }

  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;

    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width, bodyHeight);

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

    const max = this.maxScroll();
    if (this.scrollTop > max) this.scrollTop = max;
    if (this.scrollTop < 0) this.scrollTop = 0;

    const viewRows = bodyHeight - 2;
    const top = chalk.hex(stroke)('┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = chalk.hex(stroke)('└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [top];
    for (let i = 0; i < viewRows; i++) {
      const lineIndex = this.scrollTop + i;
      const raw = this.lines[lineIndex] ?? '';
      const inner = fitExactly(chalk.hex(this.colors.text)(raw), innerWidth);
      out.push(chalk.hex(stroke)('│ ') + inner + chalk.hex(stroke)(' │'));
    }
    out.push(bottom);
    return out;
  }

  private renderFooter(width: number, bodyHeight: number): string {
    const key = (text: string): string => chalk.hex(this.colors.primary).bold(text);
    const dim = (text: string): string => chalk.hex(this.colors.textMuted)(text);

    const total = this.lines.length;
    const viewRows = Math.max(1, bodyHeight - 2);
    const maxScroll = Math.max(0, total - viewRows);
    const percent = maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
    const lineFrom = this.scrollTop + 1;
    const lineTo = Math.min(total, this.scrollTop + viewRows);

    const position = chalk.hex(this.colors.textMuted)(
      ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `,
    );
    const keys =
      `${key('↑↓')} ${dim(t('kresult.line'))}  ` +
      `${key('PgUp/PgDn')} ${dim(t('kresult.page'))}  ` +
      `${key('g/G')} ${dim(t('kresult.top_bottom'))}  ` +
      `${key('Q/Esc/Enter')} ${dim(t('kresult.back'))}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }
}
