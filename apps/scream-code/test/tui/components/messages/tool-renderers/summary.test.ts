/**
 * Glance-style tool bodies (Read, Grep, Glob) render their raw output when the
 * card is expanded. That output can reach hundreds of rows, so it must be capped
 * exactly like every other tool body instead of being dumped in full.
 */
import { describe, expect, it } from 'vitest';

import { readSummary } from '#/tui/components/messages/tool-renderers/summary';
import { TOOL_OUTPUT_PREVIEW_LINES } from '#/tui/constant/rendering';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const call: ToolCallBlockData = {
  id: 'tc',
  name: 'Read',
  args: { path: 'src/web/server.ts' },
};

/** Read attaches a `NNN\t` prefix to every line it returns. */
function readOutput(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `${String(i + 1)}\tconst n${String(i + 1)} = 1;`).join('\n');
}

function renderBody(output: string, expanded: boolean): string[] {
  const result: ToolResultBlockData = { tool_call_id: 'tc', output };
  return readSummary(call, result, { expanded, colors: darkColors })
    .flatMap((component) => component.render(100))
    .map(strip);
}

describe('readSummary', () => {
  it('keeps the collapsed body to the summary glance', () => {
    const rows = renderBody(readOutput(200), false);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('200 lines');
    expect(rows[0]).not.toContain('n1 =');
  });

  it('caps the expanded body and announces the hidden lines', () => {
    const rows = renderBody(readOutput(200), true);
    const hidden = 200 - TOOL_OUTPUT_PREVIEW_LINES;

    // Glance row + capped preview + hint row: the file never renders in full.
    expect(rows.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_LINES + 2);
    expect(rows.join('\n')).toContain('n1 =');
    expect(rows.join('\n')).not.toContain('n200 =');
    expect(rows.at(-1)).toContain(String(hidden));
  });

  it('keeps the head of the file rather than its tail', () => {
    const rows = renderBody(readOutput(50), true).join('\n');

    expect(rows).toContain('n1 =');
    expect(rows).not.toContain('n50 =');
  });
});
