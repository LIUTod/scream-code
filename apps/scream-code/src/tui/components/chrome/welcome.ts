/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box with the logo, session, model, and version.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';

export class WelcomeComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;

  constructor(state: AppState, colors: ColorPalette) {
    this.state = state;
    this.colors = colors;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const primary = (s: string): string => chalk.hex(this.colors.primary)(s);
    const innerWidth = Math.max(10, width - 4);
    const pad = '  ';

    // Logo + side-by-side text.
    const logo = ['░▒▓██▄▄▄██', '░▒▓▐█▄▀▄█▌'];
    const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);

    const rightRow0 = truncateToWidth(
      chalk.bold.hex(this.colors.primary)('欢迎使用Scream 您的中文Ai助手'),
      textWidth,
      '…',
    );
    const isLoggedOut = !this.state.model;
    const dim = chalk.hex(this.colors.textDim);
    const labelStyle = chalk.bold.hex(this.colors.textDim);
    const rightRow1 = truncateToWidth(
      dim(isLoggedOut ? '运行 /config 开始配置。' : '发送 /help 获取帮助信息。/config 配置模型'),
      textWidth,
      '…',
    );

    const headerLines = [
      primary(logo[0]!.padEnd(logoWidth)) + gap + rightRow0,
      primary(logo[1]!.padEnd(logoWidth)) + gap + rightRow1,
    ];

    const activeModel = this.state.availableModels[this.state.model];
    const modelValue = isLoggedOut
      ? chalk.hex(this.colors.warning)('未设置，运行 /config')
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);

    let versionValue = this.state.version;
    if (this.state.hasNewVersion && this.state.latestVersion !== null) {
      versionValue += chalk.hex(this.colors.warning)(` → ${this.state.latestVersion} 可更新`);
    }

    const infoLines = [
      labelStyle('目录： ') + this.state.workDir,
      labelStyle('模型： ') + modelValue,
      labelStyle('版本： ') + versionValue,
    ];

    const hintLine = chalk.hex(this.colors.textMuted)('按 / 可进入快捷指令菜单，输入 /sessions 可恢复或管理会话');
    const tipLine = chalk.hex(this.colors.textMuted)('Tips：试试让它写代码、做研报、做攻略、清理电脑...');
    const contentLines: string[] = [...headerLines, '', ...infoLines, '', hintLine, tipLine];

    const lines: string[] = [
      '',
      primary('╭' + '─'.repeat(width - 2) + '╮'),
      primary('│') + ' '.repeat(width - 2) + primary('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('│') + ' '.repeat(width - 2) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(width - 2) + '╯'));
    lines.push('');

    return lines;
  }
}
