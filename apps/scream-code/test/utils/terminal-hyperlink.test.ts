import { visibleWidth } from '@liutod-scream/pi-tui';
import { describe, expect, it } from 'vitest';

import { hasHttpUrl, toTerminalHyperlink, trimUrlTail, wrapUrlsAsHyperlinks } from '#/utils/terminal-hyperlink';

/** Visible text of a wrapped line, with the OSC 8 wrappers removed. */
function stripOsc8(text: string): string {
  return text.replaceAll(/\u001B\]8;;[^\u0007]*\u0007/g, '');
}

function openCount(text: string): number {
  return text.split('\u001B]8;;').length - 1;
}

describe('wrapUrlsAsHyperlinks', () => {
  it('returns text without a URL untouched', () => {
    const plain = 'no links here';
    expect(wrapUrlsAsHyperlinks(plain)).toBe(plain);
  });

  it('wraps a bare URL without changing the visible text', () => {
    const line = 'URL: https://arxiv.org/abs/2405.00001';

    const wrapped = wrapUrlsAsHyperlinks(line);

    expect(wrapped).toBe(
      `URL: ${toTerminalHyperlink('https://arxiv.org/abs/2405.00001', 'https://arxiv.org/abs/2405.00001')}`,
    );
    expect(stripOsc8(wrapped)).toBe(line);
  });

  it('keeps the visible width unchanged (the escapes are zero-width)', () => {
    const line = '  ✓ fetched https://arxiv.org/abs/2405.00001 (200 OK)';

    expect(visibleWidth(wrapUrlsAsHyperlinks(line))).toBe(visibleWidth(line));
  });

  it('wraps every URL on the line and leaves the pair balanced', () => {
    const wrapped = wrapUrlsAsHyperlinks('https://a.example https://b.example');

    expect(openCount(wrapped)).toBe(4); // two opens + two closes
    expect(stripOsc8(wrapped)).toBe('https://a.example https://b.example');
  });

  it('styles only the visible URL text', () => {
    const wrapped = wrapUrlsAsHyperlinks('see https://example.com now', (url) => `<${url}>`);
    expect(wrapped).toContain('<https://example.com>');
    expect(wrapped).toContain('\u001B]8;;https://example.com\u0007');
    expect(stripOsc8(wrapped)).toBe('see <https://example.com> now');
  });

  it('leaves ASCII sentence punctuation outside the link', () => {
    const wrapped = wrapUrlsAsHyperlinks('Done: https://example.com/x, then more.');
    expect(wrapped).toContain('\u001B]8;;https://example.com/x\u0007');
    expect(stripOsc8(wrapped)).toBe('Done: https://example.com/x, then more.');
  });

  it('leaves CJK and full-width punctuation outside the link', () => {
    const line = '详见 https://example.com/docs。谢谢，另见（https://example.com/b）：完';

    const wrapped = wrapUrlsAsHyperlinks(line);

    expect(wrapped).toContain('\u001B]8;;https://example.com/docs\u0007');
    expect(wrapped).toContain('\u001B]8;;https://example.com/b\u0007');
    expect(stripOsc8(wrapped)).toBe(line);
  });

  it('never swallows an ANSI reset into the link target', () => {
    // Colored CLI output puts the reset right after the URL; `\S+` alone would
    // pull those bytes into the OSC payload and corrupt the stream.
    const wrapped = wrapUrlsAsHyperlinks('\u001B[34mhttps://example.com/path\u001B[0m tail');

    expect(wrapped).toContain('\u001B]8;;https://example.com/path\u0007');
    expect(wrapped).not.toContain('\u001B]8;;https://example.com/path\u001B');
    expect(wrapped.endsWith('\u001B[0m tail')).toBe(true);
  });

  it('replaces an existing link instead of nesting sequences', () => {
    const existing = toTerminalHyperlink('https://a.example/u', 'https://a.example/u');
    const line = `X ${existing} Y`;

    const wrapped = wrapUrlsAsHyperlinks(line);

    expect(openCount(wrapped)).toBe(2); // exactly one open + one close
    expect(stripOsc8(wrapped)).toBe('X https://a.example/u Y');
  });

  it('keeps a balanced bracket inside the link but trims an unbalanced one', () => {
    expect(wrapUrlsAsHyperlinks('see https://en.wikipedia.org/wiki/Memory_(disambiguation) x')).toContain(
      ']8;;https://en.wikipedia.org/wiki/Memory_(disambiguation)\u0007',
    );
    const wrapped = wrapUrlsAsHyperlinks('(see https://example.com/x)');
    expect(wrapped).toContain('\u001B]8;;https://example.com/x\u0007');
    expect(stripOsc8(wrapped)).toBe('(see https://example.com/x)');
  });
});

describe('trimUrlTail', () => {
  it('trims trailing prose punctuation', () => {
    expect(trimUrlTail('https://example.com/a.,;:!?')).toBe('https://example.com/a');
    expect(trimUrlTail('https://example.com/a。，、；：！？')).toBe('https://example.com/a');
    expect(trimUrlTail('https://example.com/a…')).toBe('https://example.com/a');
  });

  it('trims only unmatched closing brackets', () => {
    expect(trimUrlTail('https://example.com/a)')).toBe('https://example.com/a');
    expect(trimUrlTail('https://example.com/a(b)')).toBe('https://example.com/a(b)');
    expect(trimUrlTail('https://example.com/a）')).toBe('https://example.com/a');
  });

  it('keeps trimming until nothing changes', () => {
    // Bracket first, then the full stop that sat behind it.
    expect(trimUrlTail('https://example.com/a.)')).toBe('https://example.com/a');
    expect(trimUrlTail('https://example.com/a）。')).toBe('https://example.com/a');
  });
});

describe('hasHttpUrl', () => {
  it('detects http and https URLs', () => {
    expect(hasHttpUrl('http://a.example')).toBe(true);
    expect(hasHttpUrl('prefix https://b.example suffix')).toBe(true);
  });

  it('is false for text without a URL', () => {
    expect(hasHttpUrl('plain text')).toBe(false);
    expect(hasHttpUrl('file:///tmp/x')).toBe(false);
  });

  it('gives the same answer when called repeatedly', () => {
    // A module-level global regex leaks lastIndex between calls if it is not reset.
    expect(hasHttpUrl('https://a.example')).toBe(true);
    expect(hasHttpUrl('https://a.example')).toBe(true);
    expect(hasHttpUrl('plain')).toBe(false);
    expect(hasHttpUrl('https://a.example')).toBe(true);
  });
});
