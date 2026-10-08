import type { Component } from '@liutod-scream/pi-tui';
import { Text } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import { CachedContainer } from '../../utils/cached-container';
import { formatCollapsedEntries } from '../../utils/collapse-stub';
import chalk from 'chalk';

import { NoticeMessageComponent, StatusMessageComponent } from '../messages/status-message';
import { UserMessageComponent } from '../messages/user-message';
import type { ColorPalette } from '../../theme/colors';
import type { TranscriptEntry } from '../../types';

class CommittedMessageComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly entry: TranscriptEntry,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = this.renderForEntry(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderForEntry(width: number): string[] {
    const { entry, colors } = this;

    switch (entry.kind) {
      case 'user': {
        const text = entry.content.trim();
        if (text.length === 0) return [];
        const images = entry.imageAttachmentIds !== undefined && entry.imageAttachmentIds.length > 0
          ? ` [${t('transcript.attachments', { count: entry.imageAttachmentIds.length })}]`
          : '';
        return new UserMessageComponent(`${text}${images}`, colors, undefined).render(width);
      }
      case 'assistant': {
        const text = entry.content.trim();
        if (text.length === 0) return [];
        const maxLen = 200;
        const snippet = text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
        return new Text(
          `  ${chalk.hex(colors.roleAssistant)(t('transcript.assistant'))}${chalk.hex(colors.text)(snippet)}`,
          0,
          0,
        ).render(width);
      }
      case 'thinking': {
        const text = entry.content.trim();
        if (text.length === 0) return [];
        return new Text(`  ${chalk.hex(colors.textDim)(t('transcript.thinking'))}${text}`, 0, 0).render(width);
      }
      case 'tool_call': {
        const data = entry.toolCallData;
        const name = data?.name ?? entry.content;
        const output = data?.result?.output ?? '';
        const trimmed = output.trim();
        const summary = trimmed.length > 0
          ? `${trimmed.slice(0, 160)}${trimmed.length > 160 ? '…' : ''}`
          : '…';
        return new Text(
          `  ${chalk.hex(colors.textDim)(t('transcript.tool_name', { name }))}${summary}`,
          0,
          0,
        ).render(width);
      }
      case 'status': {
        if (entry.renderMode === 'notice') {
          return new NoticeMessageComponent(
            entry.content,
            entry.detail,
            colors,
            entry.noticeMarkerColor,
          ).render(width);
        }
        return new StatusMessageComponent(entry.content, colors, entry.color).render(width);
      }
      case 'skill_activation': {
        const text = entry.skillName ?? entry.content;
        return new Text(
          `  ${chalk.hex(colors.textDim)(t('transcript.activated_skill', { name: text }))}`,
          0,
          0,
        ).render(width);
      }
      case 'cron': {
        const text = entry.content.trim();
        if (text.length === 0) return [];
        return new Text(`  ${chalk.hex(colors.textDim)(text)}`, 0, 0).render(width);
      }
      case 'welcome':
        return [];
      case 'tool_result':
        return [];
    }
  }
}

/**
 * Retention point of the committed tree: how many entry children it keeps —
 * the summary stub included. It mirrors the shadow entry array's
 * MAX_TRANSCRIPT_ENTRIES (transcript-controller), because the live fold hands
 * rows to this tree and history must not stay unbounded on the render side
 * either. It is its own cap rather than the array's because it bounds its own
 * set: entries reach the tree only through `commit()`, and the array cap can
 * already have dropped an entry whose component is still live. Each side
 * counting only the rows it holds is what keeps the two folds from
 * double-counting.
 */
export const MAX_COMMITTED_ENTRIES = 500;

export class CommittedTranscriptComponent extends CachedContainer {
  private readonly header: Text;
  private readonly colors: ColorPalette;
  private committedCount = 0;
  /** Rows the retention cap has folded into the summary stub. */
  private collapsedCount = 0;
  private collapseStub: Text | undefined;

  constructor(colors: ColorPalette) {
    super();
    this.colors = colors;
    this.header = new Text('', 0, 0);
    this.addChild(this.header);
  }

  getCount(): number {
    return this.committedCount;
  }

  /** Rows the tree folded into its summary stub. They still count toward
   *  {@link getCount()}: folding changes what is on screen, never what was
   *  committed. */
  getCollapsedCount(): number {
    return this.collapsedCount;
  }

  setCount(count: number): void {
    this.committedCount = count;
    if (count === 0) {
      this.header.setText('');
    } else {
      this.header.setText(`  ${chalk.hex(this.colors.textDim)(t('transcript.more_history', { count }))}`);
    }
    this.invalidate();
  }

  appendEntry(
    entry: TranscriptEntry,
    colors: ColorPalette,
  ): void {
    this.addChild(new CommittedMessageComponent(entry, colors));
    this.enforceRetentionCap();
  }

  /**
   * Holds the tree at its retention point: the entry children it renders —
   * the summary stub included — never exceed MAX_COMMITTED_ENTRIES. Past that
   * the oldest rows fold into the stub, the same semantics as the entry-array
   * cap, so the child list (and the render cache every child carries) stops
   * growing with the session. The stub takes one slot of the budget, so the
   * fold lands on stub + (MAX - 1) rows: the cap is the actually retained set.
   */
  private enforceRetentionCap(): void {
    if (this.children.length - 1 <= MAX_COMMITTED_ENTRIES) return;

    let stub = this.collapseStub;
    if (stub === undefined) {
      // The stub takes the first entry slot, right under the header.
      stub = new Text('', 0, 0);
      this.collapseStub = stub;
      this.children.splice(1, 0, stub);
    }

    const fold = this.children.length - 2 - (MAX_COMMITTED_ENTRIES - 1);
    // The oldest rows are the ones right under the stub.
    this.children.splice(2, fold);
    this.collapsedCount += fold;
    stub.setText(
      `  ${chalk.hex(this.colors.textDim)(formatCollapsedEntries(this.collapsedCount))}`,
    );
    this.invalidate();
  }
}
