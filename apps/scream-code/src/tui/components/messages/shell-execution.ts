import type { Component } from '@liutod-scream/pi-tui';
import { Container, Text } from '@liutod-scream/pi-tui';
import { t } from '@scream-code/config';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import {
  MAX_SHELL_OUTPUT_BYTES,
  SHELL_COMMAND_COLLAPSED_LINES,
  TOOL_OUTPUT_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { highlightLines } from '../media/code-highlight';

import type { ResultRenderer } from './tool-renderers/types';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly colors: ColorPalette;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  /**
   * Max command lines to render. `undefined` means no cap — used by the
   * ctrl+o expanded view so the user can see the full multi-line command
   * even when the header preview was truncated.
   */
  readonly commandPreviewLines?: number;
  readonly resultPreviewLines?: number;
}

export class ShellExecutionComponent extends Container {
  constructor(options: ShellExecutionOptions) {
    super();

    if (options.showCommand === true) {
      this.addCommandPreview(
        options.command ?? '',
        options.commandPreviewLines,
        options.colors,
      );
    }

    if (options.result !== undefined) {
      this.addResultPreview(
        options.result,
        options.colors,
        options.expanded ?? false,
        options.resultPreviewLines ?? TOOL_OUTPUT_PREVIEW_LINES,
      );
    }
  }

  private addCommandPreview(
    command: string,
    previewLines: number | undefined,
    colors: ColorPalette,
  ): void {
    if (command.length === 0) return;
    // Bash syntax highlight (same pipeline as Write streaming previews) makes
    // the command the visually brightest element of the card; on highlight
    // failure it falls back to plain terminal default color — never dim, so
    // the command always stands out from the dimmed output below.
    const allLines = highlightLines(command, 'bash', colors);
    const lines = previewLines === undefined ? allLines : allLines.slice(0, previewLines);
    for (const [i, line] of lines.entries()) {
      const prefix = i === 0 ? '$ ' : '  ';
      this.addChild(new Text(`${chalk.dim(prefix)}${line}`, 2, 0));
    }
  }

  private addResultPreview(
    result: ToolResultBlockData,
    colors: ColorPalette,
    expanded: boolean,
    previewLines: number,
  ): void {
    if (!result.output) return;
    this.addChild(
      new TruncatedOutputComponent(result.output, {
        expanded,
        isError: result.is_error ?? false,
        colors,
        maxLines: previewLines,
        maxBytes: MAX_SHELL_OUTPUT_BYTES,
        hintFormatter: (remaining) =>
          t('shell.more_lines', { count: String(remaining) }),
        collapseHintFormatter: () => t('shell.collapse_hint'),
      }),
    );
  }
}

export const shellExecutionResultRenderer: ResultRenderer = (
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx,
): Component[] => [
  new ShellExecutionComponent({
    command: typeof toolCall.args['command'] === 'string' ? toolCall.args['command'] : '',
    result,
    colors: ctx.colors,
    expanded: ctx.expanded,
    // The header truncates long bash commands to 60 chars, so the command
    // stays visible in the body even when collapsed — capped at a few lines.
    // ctrl+o reveals the full command (no line cap).
    showCommand: true,
    commandPreviewLines: ctx.expanded ? undefined : SHELL_COMMAND_COLLAPSED_LINES,
  }),
];
