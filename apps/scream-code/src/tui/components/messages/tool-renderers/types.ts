import type { Component } from '@earendil-works/pi-tui';

import { RESULT_PREVIEW_LINES } from '#/tui/constant/rendering';
import type { ColorPalette } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

export interface RendererContext {
  readonly expanded: boolean;
  readonly colors: ColorPalette;
}

export type ResultRenderer = (
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx: RendererContext,
) => Component[];

export const PREVIEW_LINES = RESULT_PREVIEW_LINES;

export function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}
