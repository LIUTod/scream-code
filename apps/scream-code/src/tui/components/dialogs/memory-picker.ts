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

import { CHECKBOX_OFF, CHECKBOX_ON, SELECT_POINTER } from '../../constant/symbols';
import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TUI,
} from '@liutod-scream/pi-tui';
import chalk from 'chalk';
import * as path from 'node:path';
import { t } from '@scream-code/config';

import type { MemoryMemo, MemoryMemoSummary } from '@scream-code/memory';
import { MemoryMemoStore } from '@scream-code/memory';

import type { ColorPalette } from '#/tui/theme/colors';
import { printableChar } from '#/tui/utils/printable-key';

const ELLIPSIS = '…';

/** One-sentence conclusion: generous for a rule, bounded for prompt injection. */
const MAX_DISTILLED_CHARS = 200;

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

/** Local calendar date as YYYY-MM-DD; avoids the UTC off-by-one of toISOString. */
function formatDate(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
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

type PickerMode = 'list' | 'detail' | 'confirmDelete' | 'editDistilled';

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
  /** Draft text for the in-place edit of the latest distillation. */
  private editBuffer = '';
  /** Set when the last save failed; keeps the draft on screen for a retry. */
  private editError = false;
  /** Guards against a second Enter while the update is in flight. */
  private saving = false;
  /** Memo ids ticked for batch delete (space toggles, a selects all). */
  private selectedIds = new Set<string>();

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
      // A data reload invalidates any batch selection.
      this.selectedIds.clear();
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

    if (this.mode === 'editDistilled') {
      if (matchesKey(data, Key.escape)) {
        this.editBuffer = '';
        this.mode = 'detail';
        this.ui?.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (!this.saving) void this.saveDistilled();
        return;
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        // Slice by code point so an emoji is removed whole.
        this.editBuffer = Array.from(this.editBuffer).slice(0, -1).join('');
        this.ui?.requestRender();
        return;
      }
      const typed = printableChar(data);
      if (typed.length > 0) {
        if (Array.from(this.editBuffer).length < MAX_DISTILLED_CHARS) this.editBuffer += typed;
        this.ui?.requestRender();
      }
      return;
    }

    if (this.mode === 'confirmDelete') {
      if (matchesKey(data, Key.enter)) {
        if (this.selectedIds.size > 0) {
          void this.deleteSelectedAndReload();
        } else {
          const memo = this.memos[this.selectedIndex];
          if (memo) void this.deleteAndReload(memo.id);
        }
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
      const key = printableChar(data);
      if ((key === 'e' || key === 'E') && this.detailMemo !== null) {
        this.editBuffer = this.detailMemo.distilled ?? '';
        this.editError = false;
        this.mode = 'editDistilled';
        this.ui?.requestRender();
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
      if (this.selectedIds.size > 0 || this.memos.length > 0) this.mode = 'confirmDelete';
      return;
    }
    if (ch === ' ') {
      const memo = this.memos[this.selectedIndex];
      if (memo) {
        if (this.selectedIds.has(memo.id)) this.selectedIds.delete(memo.id);
        else this.selectedIds.add(memo.id);
        this.ui?.requestRender();
      }
      return;
    }
    if (ch === 'a' || ch === 'A') {
      if (this.memos.length === 0) return;
      const allSelected = this.memos.every((memo) => this.selectedIds.has(memo.id));
      if (allSelected) this.selectedIds.clear();
      else for (const memo of this.memos) this.selectedIds.add(memo.id);
      this.ui?.requestRender();
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

  /**
   * Persist the edited distillation. A non-empty text becomes a user-authored
   * rule; clearing it drops back to a plain extracted memo.
   */
  private async saveDistilled(): Promise<void> {
    const memo = this.detailMemo;
    if (memo === null) {
      this.mode = 'list';
      return;
    }
    this.saving = true;
    const text = this.editBuffer.trim();
    // Pressing Enter without changing the conclusion must not rewrite its
    // provenance (origin would flip to `user` and the real date would be lost).
    if (text === (memo.distilled ?? '').trim()) {
      this.saving = false;
      this.editBuffer = '';
      this.mode = 'detail';
      this.ui?.requestRender();
      return;
    }
    try {
      await this.store.update(memo.id, {
        distilled: text.length > 0 ? text : undefined,
        // A cleared conclusion is no longer a rule, so its lineage goes too.
        distilledFrom: text.length > 0 ? memo.distilledFrom : undefined,
        origin: text.length > 0 ? 'user' : 'session',
        distilledAt: text.length > 0 ? Date.now() : undefined,
      });
    } catch {
      // Keep the edit view and the draft so the user can retry.
      this.editError = true;
      this.saving = false;
      this.ui?.requestRender();
      return;
    }
    this.saving = false;
    this.editError = false;
    this.editBuffer = '';
    await this.loadMemos();
    // loadMemos resets the cursor; keep the edited memo selected so the detail
    // view returns to the entry that was just saved. An active search may have
    // filtered it out, in which case there is nothing safe to open.
    const index = this.memos.findIndex((item) => item.id === memo.id);
    if (index < 0) {
      this.detailMemo = null;
      this.mode = 'list';
      this.ui?.requestRender();
      return;
    }
    this.selectedIndex = index;
    await this.showDetail();
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

  private async deleteSelectedAndReload(): Promise<void> {
    const ids = [...this.selectedIds];
    for (const id of ids) {
      try {
        await this.store.delete(id);
      } catch { /* keep going */ }
    }
    // loadMemos clears selectedIds (a reload invalidates the selection) and
    // resets the index, so nothing stays highlighted after a batch delete.
    await this.loadMemos();
    this.mode = 'list';
    this.ui?.requestRender();
  }

  override render(width: number): string[] {
    const c = this.colors;
    // ── separator
    const lines: string[] = [chalk.hex(c.primary)('─'.repeat(width))];

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
      : this.selectedIds.size > 0
        ? t('memory.batch_hint', { count: String(this.selectedIds.size) })
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

    // In-place editing of the latest distillation
    if (this.mode === 'editDistilled' && this.detailMemo) {
      return this.renderEditDistilled(lines, width, c);
    }

    // Confirm delete
    if (this.mode === 'confirmDelete') {
      if (this.selectedIds.size > 0) {
        lines.push(truncateToWidth(
          chalk.hex(c.warning).bold(
            t('memory.batch_delete_confirm', { count: String(this.selectedIds.size) }),
          ),
          width, ELLIPSIS,
        ));
        lines.push(chalk.hex(c.warning)(t('memory.batch_delete_hint')));
        const hasRule = this.memos.some(
          (memo) =>
            this.selectedIds.has(memo.id) &&
            memo.origin !== undefined &&
            memo.origin !== 'session',
        );
        if (hasRule) {
          lines.push(chalk.hex(c.warning)(
            truncateToWidth(`  ${t('memory.delete_rule_warning')}`, width, ELLIPSIS),
          ));
        }
      } else {
        const memo = this.memos[this.selectedIndex];
        if (memo) {
          lines.push(truncateToWidth(
            chalk.hex(c.warning).bold(`  ${t('memory.deleting')}${memo.userNeed}`),
            width, ELLIPSIS,
          ));
          lines.push(chalk.hex(c.warning)(t('memory.delete_confirm_hint')));
          if (memo.origin !== undefined && memo.origin !== 'session') {
            lines.push(chalk.hex(c.warning)(
              truncateToWidth(`  ${t('memory.delete_rule_warning')}`, width, ELLIPSIS),
            ));
          }
        }
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
    const check = this.selectedIds.has(memo.id) ? CHECKBOX_ON : CHECKBOX_OFF;
    const indent = '  ';
    const indentWidth = visibleWidth(indent);
    const titleColor = isSelected ? c.primary : c.text;
    const titleStyle = isSelected ? chalk.hex(titleColor).bold : chalk.hex(titleColor);

    const sources = memo.distilledFrom ?? [];
    const isRule = memo.origin !== undefined && memo.origin !== 'session';
    const time = formatRelativeTime(isRule ? (memo.distilledAt ?? memo.recordedAt) : memo.recordedAt);
    const src = isRule
      ? memo.origin === 'user'
        ? t('memory.origin_user')
        : t('memory.origin_dream')
      : sourceLabel(memo.extractionSource);
    const trailingParts = [time, src].filter((p) => p.length > 0);
    if (isRule && sources.length > 0) {
      trailingParts.push(t('memory.source_count', { count: String(sources.length) }));
    }
    const trailingText = trailingParts.length > 0 ? '  ' + trailingParts.join('  ') : '';
    const trailingWidth = visibleWidth(trailingText);
    const headerPrefixWidth = visibleWidth(pointer) + 1 + visibleWidth(check) + 1;
    const titleBudget = Math.max(8, width - headerPrefixWidth - trailingWidth);
    const shownTitle = truncateToWidth(singleLine(memo.userNeed), titleBudget, ELLIPSIS);

    const checkColor = this.selectedIds.has(memo.id) ? c.primary : c.textDim;
    let header = chalk.hex(isSelected ? c.primary : c.textDim)(pointer + ' ');
    header += chalk.hex(checkColor)(check + ' ');
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

    // Fifth line: latest distillation (only when /dream wrote one)
    if (memo.distilled !== undefined && memo.distilled.length > 0) {
      const distilledPreview = t('memory.distilled_label') + singleLine(memo.distilled);
      card.push(
        indent + chalk.hex(c.success ?? c.primary)(truncateToWidth(distilledPreview, Math.max(8, width - indentWidth), ELLIPSIS)),
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
    const time = formatDate(memo.recordedAt);
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
    const sourceName = memo.origin !== undefined && memo.origin !== 'session'
      ? memo.origin === 'user'
        ? t('memory.origin_user')
        : t('memory.origin_dream')
      : sourceLabel(memo.extractionSource);
    lines.push(chalk.hex(c.textMuted)(
      truncateToWidth(`${indent}${t('memory.result_label')}${memo.outcome}    ${t('memory.source_label')}${sourceName}    ${time}`, width, ELLIPSIS),
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
    if (memo.distilled !== undefined && memo.distilled.length > 0) {
      const label = t('memory.distilled_label');
      const wrapped = wrapText(memo.distilled, contentWidth - visibleWidth(label));
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? `${indent}${label}` : indent + ' '.repeat(visibleWidth(label));
        lines.push(truncateToWidth(
          chalk.hex(c.success ?? c.primary)(prefix + wrapped[i]),
          width, ELLIPSIS,
        ));
      }
      lines.push('');
    }
    if (memo.origin !== undefined && memo.origin !== 'session') {
      const distilledAtLabel = memo.distilledAt !== undefined
        ? `${t('memory.distilled_at')} ${formatDate(memo.distilledAt)}`
        : t('memory.distilled_at_unknown');
      lines.push(chalk.hex(c.textMuted)(
        truncateToWidth(`${indent}${distilledAtLabel}`, width, ELLIPSIS),
      ));
      const sources = memo.distilledFrom ?? [];
      lines.push(chalk.hex(c.textMuted)(truncateToWidth(
        `${indent}${sources.length > 0
          ? t('memory.source_count', { count: String(sources.length) })
          : t('memory.source_unknown')}`,
        width, ELLIPSIS,
      )));
      for (const source of sources.slice(0, 5)) {
        const date = formatDate(source.at);
        lines.push(chalk.hex(c.textMuted)(truncateToWidth(
          `${indent}- ${date} · ${singleLine(source.title)}`, width, ELLIPSIS,
        )));
      }
      if (sources.length > 5) {
        lines.push(chalk.hex(c.textDim)(
          truncateToWidth(
            `${indent}${t('memory.source_more', { count: String(sources.length - 5) })}`,
            width,
            ELLIPSIS,
          ),
        ));
      }
      lines.push('');
    }
    if (memo.note !== undefined && memo.note.length > 0) {
      const label = t('memory.note_label');
      const wrapped = wrapText(memo.note, contentWidth - visibleWidth(label));
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? `${indent}${label}` : indent + ' '.repeat(visibleWidth(label));
        lines.push(truncateToWidth(
          chalk.hex(c.textMuted)(prefix + wrapped[i]),
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

  private renderEditDistilled(
    lines: string[],
    width: number,
    c: ColorPalette,
  ): string[] {
    const memo = this.detailMemo!;
    const indent = '  ';
    lines.push(truncateToWidth(
      chalk.hex(c.primary).bold(`${indent}${t('memory.requirement_label')}${memo.userNeed}`),
      width, ELLIPSIS,
    ));
    lines.push('');
    lines.push(chalk.hex(c.textMuted)(
      truncateToWidth(`${indent}${t('memory.distilled_label')}`, width, ELLIPSIS),
    ));
    // Wrap instead of truncating: the cursor must stay visible while typing.
    const contentWidth = Math.max(8, width - indent.length * 2);
    for (const line of wrapText(`${this.editBuffer}█`, contentWidth)) {
      lines.push(chalk.hex(c.success ?? c.primary)(`${indent}${line}`));
    }
    lines.push('');
    if (this.editError) {
      lines.push(chalk.hex(c.error)(
        truncateToWidth(`${indent}${t('memory.edit_save_failed')}`, width, ELLIPSIS),
      ));
    }
    lines.push(chalk.hex(c.textMuted)(
      truncateToWidth(`${indent}${t('memory.edit_distilled_hint')}`, width, ELLIPSIS),
    ));
    lines.push(chalk.hex(c.primary)('─'.repeat(width)));
    return lines;
  }
}
