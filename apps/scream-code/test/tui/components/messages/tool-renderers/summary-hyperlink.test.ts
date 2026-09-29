/**
 * The WebSearch glance (collapsed card) shows a truncated URL — it must still
 * be a clickable OSC 8 link that targets the untruncated URL.
 */
import { describe, expect, it } from 'vitest';

import { webSearchSummary } from '#/tui/components/messages/tool-renderers/summary';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

const LONG_URL = `https://example.com/${'segment/'.repeat(12)}end`;
const CALL: ToolCallBlockData = { id: 'tc', name: 'WebSearch', args: { query: 'papers' } };

function renderWebSearch(output: string, expanded = false): string {
  const result: ToolResultBlockData = { tool_call_id: 'tc', output };
  return webSearchSummary(CALL, result, { expanded, colors: darkColors })
    .flatMap((component) => component.render(100))
    .join('\n');
}

/** Visible text, with the OSC 8 hyperlink wrappers removed. */
function stripOsc8(text: string): string {
  return text.replaceAll(/\u001B\]8;;[^\u0007]*\u0007/g, '');
}

describe('webSearchSummary glance', () => {
  it('links a truncated URL to its full target', () => {
    const rendered = renderWebSearch(['Title: A Search Result', `URL: ${LONG_URL}`, 'Snippet: …'].join('\n'));

    expect(rendered).toContain(`\u001B]8;;${LONG_URL}\u0007`);
    // The visible text stays truncated — only zero-width escapes were added, so
    // the full URL appears in the payload but never as display text.
    expect(rendered).toContain('…');
    expect(stripOsc8(rendered)).not.toContain(LONG_URL);
    expect(stripOsc8(rendered)).toContain('https://example.com/segment/segment/');
  });

  it('leaves results without a URL untouched', () => {
    const rendered = renderWebSearch(['Title: A Search Result', 'Snippet: …'].join('\n'));

    expect(rendered).toContain('A Search Result');
    expect(rendered).not.toContain(']8;;');
  });
});
