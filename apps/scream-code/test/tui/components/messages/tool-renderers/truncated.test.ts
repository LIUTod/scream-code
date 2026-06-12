import { describe, expect, it } from 'vitest';

import { TruncatedOutputComponent } from '#/tui/components/messages/tool-renderers/truncated';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('TruncatedOutputComponent', () => {
  it('renders small output unchanged', () => {
    const component = new TruncatedOutputComponent('hello\nworld', {
      expanded: false,
      isError: false,
      colors: darkColors,
    });

    const lines = component.render(80).map(strip);
    expect(lines[0]).toContain('hello');
    expect(lines[1]).toContain('world');
  });

  it('keeps the tail when output exceeds the byte cap', () => {
    const tail = 'visible tail line';
    const padding = 'x'.repeat(200_000);
    const output = padding + '\n' + tail;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 1024,
    });

    const lines = component.render(80).map(strip);
    const text = lines.join('\n');
    expect(text).toContain(tail);
    expect(text).not.toContain(padding.slice(0, 100));
  });

  it('does not split multi-byte UTF-8 characters when truncating', () => {
    const tail = '中文字尾';
    const padding = 'a'.repeat(200_000);
    const output = padding + tail;

    const component = new TruncatedOutputComponent(output, {
      expanded: true,
      isError: false,
      colors: darkColors,
      maxBytes: 16,
    });

    const lines = component.render(80).map(strip);
    const text = lines.join('\n');
    expect(text).toContain(tail);
    // Each CJK character is 3 bytes in UTF-8; with a 16-byte cap we should
    // still see all four characters (12 bytes) rather than a split.
    expect(text).toContain('中文字尾');
  });

  it('renders oversized output without throwing', () => {
    const output = 'line\n'.repeat(1_000_000);

    expect(() => {
      const component = new TruncatedOutputComponent(output, {
        expanded: false,
        isError: false,
        colors: darkColors,
        maxBytes: 1024,
      });
      component.render(80);
    }).not.toThrow();
  });
});
