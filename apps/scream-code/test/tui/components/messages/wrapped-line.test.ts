import { describe, expect, it } from 'vitest';

import { visibleWidth } from '@liutod-scream/pi-tui';
import { WrappedLine } from '#/tui/components/messages/wrapped-line';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('WrappedLine', () => {
  it('wraps long text and re-applies the continuation prefix (hanging indent)', () => {
    const line = new WrappedLine('  ├─ ', '  │  ', 'this is a fairly long description that will wrap', {
      truncate: false,
    });
    const lines = strip(line.render(30).join('\n')).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^  ├─ /);
    expect(lines[0]).not.toMatch(/^  │  /);
    for (const rest of lines.slice(1)) {
      expect(rest).toMatch(/^  │  /);
    }
  });

  it('truncates to exactly one padded row of the viewport width', () => {
    const line = new WrappedLine('  │  ', '  │  ', 'streaming activity grows and grows and grows', {
      truncate: true,
    });
    const rendered = line.render(30);
    expect(rendered.length).toBe(1);
    expect(visibleWidth(rendered[0] ?? '')).toBe(30);
    expect(strip(rendered[0] ?? '')).toContain('...');
  });

  it('truncate mode keeps the row count constant as text grows (no bounce)', () => {
    const w = 40;
    const short = new WrappedLine('  │      ', '  │      ', 'short', { truncate: true });
    const long = new WrappedLine('  │      ', '  │      ', 'a much longer streaming line ' + 'x'.repeat(120), {
      truncate: true,
    });
    expect(short.render(w).length).toBe(1);
    expect(long.render(w).length).toBe(1);
    expect(visibleWidth(long.render(w)[0] ?? '')).toBe(w);
  });

  it('does not truncate in default mode (contract of the old PrefixedWrappedLine)', () => {
    const line = new WrappedLine('  └ ', '    ', 'wrap me ' + 'word '.repeat(30));
    const rendered = line.render(40);
    expect(rendered.length).toBeGreaterThan(1);
  });

  it('renders nothing for empty content in both modes', () => {
    expect(new WrappedLine('  │  ', '  │  ', '', { truncate: false }).render(30)).toEqual([]);
    expect(new WrappedLine('  │  ', '  │  ', '', { truncate: true }).render(30)).toEqual([]);
    expect(new WrappedLine('  │  ', '  │  ', '   ', { truncate: true }).render(30)).toEqual([]);
  });

  it('flattens embedded newlines and tabs in truncate mode', () => {
    const line = new WrappedLine('  ├─ ', '  │  ', 'part one\npart two\ttabbed', {
      truncate: true,
    });
    const rendered = line.render(30);
    expect(rendered.length).toBe(1);
    expect(strip(rendered[0] ?? '')).not.toContain('\n');
    expect(strip(rendered[0] ?? '')).not.toContain('\t');
  });

  it('caches per (text, width) so repeated renders return the same rows', () => {
    const line = new WrappedLine('  ├─ ', '  │  ', 'cached content', { truncate: true });
    const first = line.render(40);
    expect(line.render(40)).toBe(first);
    // Different width recomputes.
    const wider = line.render(60);
    expect(wider).not.toBe(first);
    expect(wider.length).toBe(1);
  });

  it('keeps the branch connector column aligned between first and continuation lines', () => {
    const line = new WrappedLine('  ├─ ', '  │  ', 'x'.repeat(60), { truncate: false });
    const rendered = line.render(30).map(strip);
    // First row carries the branch head, continuations the vertical line;
    // both sit in column 3 so the tree stays connected.
    expect(rendered[0]?.[2]).toBe('├');
    for (const rest of rendered.slice(1)) {
      expect(rest[2]).toBe('│');
    }
  });
});
