/**
 * MemoryPicker — pi-tui interactive memory memo browser.
 * Mirrors SessionPickerComponent layout and interaction patterns 1:1.
 *
 * Data must be loaded BEFORE mounting — see SessionPickerComponent.
 *
 * Keyboard:
 *   ↑↓      Navigate
 *   Enter   View detail / confirm delete
 *   i       Inject into current session
 *   d       Delete (with confirmation)
 *   /       Search filter
 *   Esc     Cancel / back
 */

import { SELECT_POINTER } from '../../constant/symbols';
import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TUI,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import * as path from 'node:path';
import { t } from '@scream-code/config';

import type { MemoryMemo, MemoryMemoSummary } from '@scream-code/memory';
import { MemoryMemoStore } from '@scream-code/memory';

import type { ColorPalette } from '#/tui/theme/colors';
import { printableChar } from '#/tui/utils/printable-key';

const ELLIPSIS = '…';

function formatRelativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return t('memory.just_now');
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return t('memory.minutes_ago', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('memory.hours_ago', { hours });
  const days = Math.floor(hours / 24);
  return t('memory.days_ago', { days });
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Wrap text to fit within `maxWidth` display columns.
 * Handles CJK double-width characters via `visibleWidth`.
 * Returns an array of lines, each ≤ maxWidth columns.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length === 0) continue;
    const candidate = current + word;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current.length > 0) lines.push(current.trimEnd());
      // If a single word exceeds maxWidth, hard-break it
      if (visibleWidth(word) > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (visibleWidth(chunk + ch) > maxWidth) {
            if (chunk.length > 0) lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word.trimStart();
      }
    }
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [''];
}

function sourceLabel(source: string): string {
  if (source === 'compaction') return t('memory.compaction_extract');
  if (source === 'manual') return t('memory.manual_record');
  return t('memory.exit_extract');
}

function formatProject(memo: MemoryMemoSummary): string {
  if (memo.projectDir.length === 0) return '';
  return path.basename(memo.projectDir);
}

function formatTags(memo: MemoryMemoSummary): string {
  if (memo.tags === undefined || memo.tags.length === 0) return '';
  return memo.tags.join(', ');
}

export interface MemoryPickerOptions {
  store: MemoryMemoStore;
  memos: MemoryMemoSummary[];
  total: number;
  loading: boolean;
  colors: ColorPalette;
  ui?: TUI;
  onCancel: () => void;
  onInject: (memo: MemoryMemoSummary) => void;
}

type PickerMode = 'list' | 'detail' | 'confirmDelete';

export class MemoryPickerComponent extends Container implements Focusable {
  private store: MemoryMemoStore;
  private colors: ColorPalette;
  private readonly ui: TUI | undefined;
  private onCancel: () => void;
  private onInject: (memo: MemoryMemoSummary) => void;

  focused = false;
  private selectedIndex = 0;
  private mode: PickerMode = 'list';
  private searchQuery = '';
  private isSearching = false;
  private searchInput = '';

  private memos: MemoryMemoSummary[];
  private total: number;
  private loading: boolean;
  private detailMemo: MemoryMemo | null = null;

  private maxVisibleItems = 5;

  constructor(opts: MemoryPickerOptions) {
    super();
    this.store = opts.store;
    this.memos = opts.memos;
    this.total = opts.total;
    this.loading = opts.loading;
    this.colors = opts.colors;
    this.ui = opts.ui;
    this.onCancel = opts.onCancel;
    this.onInject = opts.onInject;
  }

  private async loadMemos(): Promise<void> {
    this.loading = true;
    this.ui?.requestRender();
    try {
      await this.store.init();
      const result = await this.store.list({ limit: 50, search: this.searchQuery || undefined });
      this.memos = result.memos;
      this.total = result.total;
      this.selectedIndex = 0;
    } catch {
      this.memos = [];
      this.total = 0;
    } finally {
      this.loading = false;
      this.ui?.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.isSearching) {
      if (matchesKey(data, Key.escape)) {
        this.isSearching = false;
        this.searchInput = '';
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.isSearching = false;
        this.searchQuery = this.searchInput.trim();
        void this.loadMemos();
        return;
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.searchInput = this.searchInput.slice(0, -1);
        return;
      }
      const ch = printableChar(data);
      if (ch.length > 0) {
        this.searchInput += ch;
      }
      return;
    }

    if (this.mode === 'confirmDelete') {
      if (matchesKey(data, Key.enter)) {
        const memo = this.memos[this.selectedIndex];
        if (memo) void this.deleteAndReload(memo.id);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.mode = 'list';
        return;
      }
      return;
    }

    if (this.mode === 'detail') {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
        this.mode = 'list';
        this.detailMemo = null;
        return;
      }
    }

    // List mode
    if (matchesKey(data, Key.escape)) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = '';
        void this.loadMemos();
        return;
      }
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter) && this.memos.length > 0) {
      void this.showDetail();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.memos.length - 1, this.selectedIndex + 1);
      return;
    }

    const ch = printableChar(data);
    if (ch === 'i' || ch === 'I') {
      const memo = this.memos[this.selectedIndex];
      if (memo) {
        this.onInject(memo);
        this.onCancel();
      }
      return;
    }
    if (ch === 'd' || ch === 'D') {
      if (this.memos.length > 0) this.mode = 'confirmDelete';
      return;
    }
    if (ch === '/') {
      this.isSearching = true;
      this.searchInput = '';
      return;
    }
  }

  private async showDetail(): Promise<void> {
    const summary = this.memos[this.selectedIndex];
    if (!summary) return;
    try {
      this.detailMemo = await this.store.get(summary.id) ?? null;
    } catch {
      this.detailMemo = null;
    }
    if (this.detailMemo) this.mode = 'detail';
    this.ui?.requestRender();
  }

  private async deleteAndReload(id: string): Promise<void> {
    try {
      await this.store.delete(id);
    } catch { /* ignore */ }
    await this.loadMemos();
    this.mode = 'list';
    if (this.selectedIndex >= this.memos.length) {
      this.selectedIndex = Math.max(0, this.memos.length - 1);
    }
    this.ui?.requestRender();
  }

  override render(width: number): string[] {
    const c = this.colors;
    const lines: string[] = [];

    // ── separator
    lines.push(chalk.hex(c.primary)('─'.repeat(width)));

    // Search input bar
    if (this.isSearching) {
      const prompt = t('memory.search_label');
      const cursor = '█';
      const input = this.searchInput.length > 0 ? this.searchInput : cursor;
      lines.push(truncateToWidth(
        chalk.hex(c.primary).bold(prompt) + chalk.hex(c.text)(input),
        width, ELLIPSIS,
      ));
      lines.push(chalk.hex(c.primary)('─'.repeat(width)));
      return lines;
    }

    // Header
    const headerLabel = t('memory.notebook_title');
    const headerHint = this.searchQuery.length > 0
      ? t('memory.esc_clear_search')
      : t('memory.nav_hint');
    const labelWidth = visibleWidth(headerLabel);
    const hintBudget = Math.max(0, width - labelWidth);
    const shownHint = truncateToWidth(headerHint, hintBudget, ELLIPSIS);
    lines.push(
      chalk.hex(c.primary).bold(headerLabel) + chalk.hex(c.textMuted)(shownHint),
    );
    lines.push('');

    // Loading
    if (this.loading) {
      lines.push(chalk.hex(c.textMuted)(truncateToWidth(`  ${t('memory.loading')}`, width, ELLIPSIS)));
      lines.push(chalk.hex(c.primary)('─'.repeat(width)));
      return lines;
    }

    // Empty
    if (this.memos.length === 0) {
      if (this.searchQuery.length > 0) {
        lines.push(chalk.hex(c.textMuted)(
          truncateToWidth(`  ${t('memory.no_match', { query: this.searchQuery })}`, width, ELLIPSIS),
        ));
      } else {
        lines.push(chalk.hex(c.textMuted)(
          truncateToWidth(`  ${t('memory.empty')}`, width, ELLIPSIS),
        ));
        lines.push(chalk.hex(c.textMuted)(
          truncateToWidth(t('memory.auto_extract_hint'), width, ELLIPSIS),
        ));
      }
      lines.push(chalk.hex(c.primary)('─'.repeat(width)));
      return lines;
    }

    // Detail mode
    if (this.mode === 'detail' && this.detailMemo) {
      return this.renderDetail(lines, width, c);
    }

    // Confirm delete
    if (this.mode === 'confirmDelete') {
      const memo = this.memos[this.selectedIndex];
      if (memo) {
        lines.push(truncateToWidth(
          chalk.hex(c.warning).bold(`  ${t('memory.deleting')}${memo.userNeed}`),
          width, ELLIPSIS,
        ));
        lines.push(chalk.hex(c.warning)(t('memory.delete_confirm_hint')));
      }
      lines.push(chalk.hex(c.primary)('─'.repeat(width)));
      return lines;
    }

    // ── List mode ──
    const visibleStart = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisibleItems / 2),
        Math.max(0, this.memos.length - this.maxVisibleItems),
      ),
    );
    const visible = this.memos.slice(visibleStart, visibleStart + this.maxVisibleItems);

    for (const [vi, memo] of visible.entries()) {
      const index = visibleStart + vi;
      const isSelected = index === this.selectedIndex;
      const card = this.renderMemoCard(width, memo, isSelected);
      lines.push(...card);
      if (vi < visible.length - 1) lines.push('');
    }

    if (this.memos.length > visible.length) {
      lines.push('');
      const footer = t('memory.showing_range', { start: String(visibleStart + 1), end: String(visibleStart + visible.length), total: String(this.total) });
      lines.push(chalk.hex(c.textMuted)(truncateToWidth(footer, width, ELLIPSIS)));
    }

    lines.push(chalk.hex(c.primary)('─'.repeat(width)));
    return lines;
  }

  private renderMemoCard(
    width: number,
    memo: MemoryMemoSummary,
    isSelected: boolean,
  ): string[] {
    const c = this.colors;
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const indent = '  ';
    const indentWidth = visibleWidth(indent);
    const titleColor = isSelected ? c.primary : c.text;
    const titleStyle = isSelected ? chalk.hex(titleColor).bold : chalk.hex(titleColor);

    const time = formatRelativeTime(memo.recordedAt);
    const src = sourceLabel(memo.extractionSource);
    const trailingParts = [time, src].filter((p) => p.length > 0);
    const trailingText = trailingParts.length > 0 ? '  ' + trailingParts.join('  ') : '';
    const trailingWidth = visibleWidth(trailingText);
    const headerPrefixWidth = visibleWidth(pointer) + 1;
    const titleBudget = Math.max(8, width - headerPrefixWidth - trailingWidth);
    const shownTitle = truncateToWidth(singleLine(memo.userNeed), titleBudget, ELLIPSIS);

    let header = chalk.hex(isSelected ? c.primary : c.textDim)(pointer + ' ');
    header += titleStyle(shownTitle);
    if (trailingText.length > 0) header += chalk.hex(c.textDim)(trailingText);
    const card: string[] = [truncateToWidth(header, width, ELLIPSIS)];

    // Second line: session + id
    const sessionLabel = memo.sourceSessionTitle && memo.sourceSessionTitle.length > 0
      ? memo.sourceSessionTitle
      : memo.sourceSessionId.slice(0, 12);
    const idInfo = `${t('memory.id_label')}${memo.id}    ${t('memory.source_label')}${sessionLabel}`;
    card.push(
      indent + chalk.hex(c.textMuted)(truncateToWidth(idInfo, Math.max(8, width - indentWidth), ELLIPSIS)),
    );

    // Third line: project + tags (if any)
    const project = formatProject(memo);
    const tags = formatTags(memo);
    const metaParts = [
      project.length > 0 ? `${t('memory.project_label')}${project}` : '',
      tags.length > 0 ? `${t('memory.tags_label')}${tags}` : '',
    ].filter((p) => p.length > 0);
    if (metaParts.length > 0) {
      const metaLine = metaParts.join('    ');
      card.push(
        indent + chalk.hex(c.textMuted)(truncateToWidth(metaLine, Math.max(8, width - indentWidth), ELLIPSIS)),
      );
    }

    // Fourth line: approach preview
    if (memo.approach.length > 0) {
      const approachPreview = t('memory.plan_label') + singleLine(memo.approach);
      card.push(
        indent + chalk.hex(c.textDim)(truncateToWidth(approachPreview, Math.max(8, width - indentWidth), ELLIPSIS)),
      );
    }

    return card;
  }

  private renderDetail(
    lines: string[],
    width: number,
    c: ColorPalette,
  ): string[] {
    const memo = this.detailMemo!;
    const time = new Date(memo.recordedAt).toLocaleString('zh-CN');
    const sessionLabel = memo.sourceSessionTitle && memo.sourceSessionTitle.length > 0
      ? `${memo.sourceSessionTitle} (${memo.sourceSessionId.slice(0, 12)})`
      : memo.sourceSessionId.slice(0, 12);
    const indent = '  ';
    const contentWidth = Math.max(8, width - visibleWidth(indent));

    lines.push(truncateToWidth(
      chalk.hex(c.primary).bold(`${indent}${t('memory.requirement_label')}${memo.userNeed}`),
      width, ELLIPSIS,
    ));
    lines.push('');
    lines.push(chalk.hex(c.textMuted)(
      truncateToWidth(`${indent}${t('memory.result_label')}${memo.outcome}    ${t('memory.source_label')}${sourceLabel(memo.extractionSource)}    ${time}`, width, ELLIPSIS),
    ));
    lines.push(chalk.hex(c.textMuted)(
      truncateToWidth(`${indent}${t('memory.session_label')}${sessionLabel}`, width, ELLIPSIS),
    ));
    const project = formatProject(memo);
    const tags = formatTags(memo);
    if (project.length > 0) {
      lines.push(chalk.hex(c.textMuted)(
        truncateToWidth(`${indent}${t('memory.project_label')}${project}`, width, ELLIPSIS),
      ));
    }
    if (tags.length > 0) {
      lines.push(chalk.hex(c.textMuted)(
        truncateToWidth(`${indent}${t('memory.tags_label')}${tags}`, width, ELLIPSIS),
      ));
    }
    lines.push(chalk.hex(c.textMuted)(
      truncateToWidth(`${indent}${t('memory.id_label')}${memo.id}`, width, ELLIPSIS),
    ));
    lines.push('');

    if (memo.approach.length > 0) {
      const label = t('memory.plan_label');
      const wrapped = wrapText(memo.approach, contentWidth - visibleWidth(label));
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? `${indent}${label}` : indent + ' '.repeat(visibleWidth(label));
        lines.push(truncateToWidth(
          chalk.hex(c.text)(prefix + wrapped[i]),
          width, ELLIPSIS,
        ));
      }
      lines.push('');
    }
    if (memo.whatFailed.length > 0 && memo.whatFailed !== 'none') {
      const label = t('memory.pitfall_label');
      const wrapped = wrapText(memo.whatFailed, contentWidth - visibleWidth(label));
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? `${indent}${label}` : indent + ' '.repeat(visibleWidth(label));
        lines.push(truncateToWidth(
          chalk.hex(c.warning)(prefix + wrapped[i]),
          width, ELLIPSIS,
        ));
      }
      lines.push('');
    }
    if (memo.whatWorked.length > 0 && memo.whatWorked !== 'none') {
      const label = t('memory.experience_label');
      const wrapped = wrapText(memo.whatWorked, contentWidth - visibleWidth(label));
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? `${indent}${label}` : indent + ' '.repeat(visibleWidth(label));
        lines.push(truncateToWidth(
          chalk.hex(c.success ?? c.primary)(prefix + wrapped[i]),
          width, ELLIPSIS,
        ));
      }
      lines.push('');
    }

    lines.push(chalk.hex(c.textMuted)(
      truncateToWidth(t('memory.detail_nav_hint'), width, ELLIPSIS),
    ));
    lines.push(chalk.hex(c.primary)('─'.repeat(width)));
    return lines;
  }
}
