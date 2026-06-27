import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import { CachedContainer } from '../../utils/cached-container';
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
          ? ` [${entry.imageAttachmentIds.length} 个附件]`
          : '';
        return new UserMessageComponent(`${text}${images}`, colors, undefined).render(width);
      }
      case 'assistant': {
        const text = entry.content.trim();
        if (text.length === 0) return [];
        const maxLen = 200;
        const snippet = text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
        return new Text(
          `  ${chalk.hex(colors.roleAssistant)('助手：')}${chalk.hex(colors.text)(snippet)}`,
          0,
          0,
        ).render(width);
      }
      case 'thinking': {
        const text = entry.content.trim();
        if (text.length === 0) return [];
        return new Text(`  ${chalk.hex(colors.textDim)('思考：')}${text}`, 0, 0).render(width);
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
          `  ${chalk.hex(colors.textDim)(`工具 ${name}：`)}${summary}`,
          0,
          0,
        ).render(width);
      }
      case 'status': {
        if (entry.renderMode === 'notice') {
          return new NoticeMessageComponent(entry.content, entry.detail, colors).render(width);
        }
        return new StatusMessageComponent(entry.content, colors, entry.color).render(width);
      }
      case 'skill_activation': {
        const text = entry.skillName ?? entry.content;
        return new Text(
          `  ${chalk.hex(colors.textDim)(`已激活技能：${text}`)}`,
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
    }
  }
}

export class CommittedTranscriptComponent extends CachedContainer {
  private readonly header: Text;
  private readonly colors: ColorPalette;
  private committedCount = 0;

  constructor(colors: ColorPalette) {
    super();
    this.colors = colors;
    this.header = new Text('', 0, 0);
    this.addChild(this.header);
  }

  getCount(): number {
    return this.committedCount;
  }

  setCount(count: number): void {
    this.committedCount = count;
    if (count === 0) {
      this.header.setText('');
    } else {
      this.header.setText(`  ${chalk.hex(this.colors.textDim)(`↑ 还有 ${count} 条历史消息`)}`);
    }
    this.invalidate();
  }

  appendEntry(
    entry: TranscriptEntry,
    colors: ColorPalette,
  ): void {
    this.addChild(new CommittedMessageComponent(entry, colors));
    this.invalidate();
  }
}
