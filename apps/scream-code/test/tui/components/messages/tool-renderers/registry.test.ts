import type { Component } from '@liutod-scream/pi-tui';
import { setLocale } from '@scream-code/config';
import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { pickResultRenderer } from '#/tui/components/messages/tool-renderers/registry';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

// Ensure deterministic i18n output for assertion matching.
setLocale('en');

// NOTE: do not force chalk.level globally here — the legacy `strip` helper
// below leaves raw ESC bytes behind, and several existing assertions rely on
// plain-text matching. Tests that need real ANSI codes set chalk.level
// locally and restore it.

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function joinRender(components: Component[], width = 100): string {
  return components.flatMap((c) => c.render(width)).join('\n');
}

function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'tc', name, args };
}

function result(output: string, isError = false): ToolResultBlockData {
  return { tool_call_id: 'tc', output, is_error: isError };
}

const ctx = { expanded: false, colors: darkColors };
const expandedCtx = { expanded: true, colors: darkColors };

describe('tool-result registry', () => {
  it('falls back to truncated renderer for unknown tools', () => {
    const renderer = pickResultRenderer('SomethingUnknown');
    const out = strip(joinRender(renderer(call('SomethingUnknown'), result('a\nb\nc\nd\ne'), ctx)));
    // Tail preview: last 3 lines shown, first 2 hidden, expand hint on top.
    expect(out).toContain('... (2 more lines, ctrl+o to expand)');
    expect(out).toContain('  c');
    expect(out).toContain('  d');
    expect(out).toContain('  e');
    expect(out).not.toContain('  a');
    expect(out).not.toContain('  b');
  });

  it('uses truncated renderer for Bash to preserve raw output UX', () => {
    const renderer = pickResultRenderer('Bash');
    const out = strip(joinRender(renderer(call('Bash'), result('one\ntwo\nthree\nfour'), ctx)));
    // Bash collapsed: output lines hidden, only the expand hint shows.
    expect(out).not.toContain('one');
    expect(out).not.toContain('two');
    expect(out).not.toContain('three');
    expect(out).not.toContain('four');
    expect(out).toContain('ctrl+o');
  });

  it('Read renders line count · extension glance when collapsed', () => {
    const renderer = pickResultRenderer('Read');
    const out = strip(
      joinRender(
        renderer(call('Read', { path: 'foo.ts' }), result('1\tfoo\n2\tbar'), ctx),
      ),
    );
    expect(out).toContain('2 lines');
    expect(out).toContain('ts');
  });

  it('Read expands to the raw file content when expanded', () => {
    const renderer = pickResultRenderer('Read');
    const out = strip(
      joinRender(renderer(call('Read', { path: 'foo.ts' }), result('1\tfoo\n2\tbar'), expandedCtx)),
    );
    expect(out).toContain('foo');
    expect(out).toContain('bar');
  });

  it('Grep glance lists path samples below the chip', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo' }),
          result('src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts\nsrc/e.ts'),
          ctx,
        ),
      ),
    );
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
    expect(out).toContain('src/c.ts');
    expect(out).toContain('+2 more');
    expect(out).not.toContain('src/d.ts');
  });

  it('Grep glance strips trailing :line:text in content mode', () => {
    const renderer = pickResultRenderer('Grep');
    const out = strip(
      joinRender(
        renderer(
          call('Grep', { pattern: 'foo' }),
          result('src/a.ts:42:    foo()\nsrc/b.ts:7:foo'),
          ctx,
        ),
      ),
    );
    expect(out).toContain('src/a.ts:42');
    expect(out).not.toContain('foo()');
  });

  it('Grep with empty result renders nothing in collapsed state', () => {
    const renderer = pickResultRenderer('Grep');
    const out = joinRender(renderer(call('Grep', { pattern: 'foo' }), result(''), ctx));
    expect(out.trim()).toBe('');
  });

  it('Glob glance groups by directory with extension counts', () => {
    const renderer = pickResultRenderer('Glob');
    const out = strip(
      joinRender(
        renderer(call('Glob', { pattern: '**/*.ts' }), result('a.ts\nb.ts\nc.ts\nd.ts'), ctx),
      ),
    );
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    expect(out).toContain('c.ts');
    expect(out).toContain('./'); // directory group header
    expect(out).toContain('(+1)'); // one remaining file beyond the sample window
    expect(out).toContain('.ts: 4'); // extension count
  });

  it('FetchURL renders no body when collapsed', () => {
    const renderer = pickResultRenderer('FetchURL');
    const out = joinRender(
      renderer(call('FetchURL', { url: 'https://example.com/x' }), result('<body>...'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('WebSearch renders no body when collapsed', () => {
    const renderer = pickResultRenderer('WebSearch');
    const out = joinRender(
      renderer(call('WebSearch', { query: 'scream' }), result('1. Alpha\n2. Beta'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('Edit renders no body when collapsed', () => {
    const renderer = pickResultRenderer('Edit');
    const out = joinRender(
      renderer(
        call('Edit', { path: 'foo.ts', old_string: 'a', new_string: 'b' }),
        result('Replaced 1 occurrence in foo.ts'),
        ctx,
      ),
    );
    expect(out.trim()).toBe('');
  });

  it('Write renders no body when collapsed', () => {
    const renderer = pickResultRenderer('Write');
    const out = joinRender(
      renderer(call('Write', { path: 'a.txt', content: 'a\nb\n' }), result('Wrote'), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('Think renders no body even with a thought arg', () => {
    const renderer = pickResultRenderer('Think');
    const out = joinRender(renderer(call('Think', { thought: 'hello' }), result('Recorded.'), ctx));
    expect(out.trim()).toBe('');
  });

  it('Errors always fall back to truncated renderer regardless of tool', () => {
    const renderer = pickResultRenderer('Read');
    const out = strip(
      joinRender(
        renderer(call('Read', { path: 'foo.ts' }), result('ENOENT: foo.ts not found', true), ctx),
      ),
    );
    expect(out).toContain('ENOENT: foo.ts not found');
  });
});

describe('Grep glance rendering', () => {
  // Full ANSI strip (the file-level `strip` leaves raw ESC bytes behind,
  // which would skew column-index assertions).
  const stripAnsi = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');

  function searchResult(matches: { file: string; line: number; text: string }[]): ToolResultBlockData {
    return {
      tool_call_id: 'tc',
      output: 'Found N results',
      is_error: false,
      display: { kind: 'search_results', query: 'foo', matches },
    };
  }

  const matches = [
    { file: 'src/a.ts', line: 42, text: 'const foo = bar()' },
    { file: 'src/tui/deep/longer.ts', line: 7, text: 'baz(qux)' },
  ];

  it('column-aligns match text regardless of path length', () => {
    const renderer = pickResultRenderer('Grep');
    const out = joinRender(
      renderer(call('Grep', { pattern: 'foo' }), searchResult(matches), ctx),
    );
    const lines = out.split('\n').map(stripAnsi);
    const lineA = lines.find((l) => l.includes('const foo'));
    const lineB = lines.find((l) => l.includes('baz(qux)'));
    expect(lineA).toBeDefined();
    expect(lineB).toBeDefined();
    expect(lineA!.indexOf('const foo')).toBe(lineB!.indexOf('baz(qux)'));
  });

  it('truncates to render width without wrapping', () => {
    const longText = { file: 'src/a.ts', line: 1, text: 'x'.repeat(200) };
    const renderer = pickResultRenderer('Grep');
    const out = joinRender(
      renderer(call('Grep', { pattern: 'foo' }), searchResult([longText]), ctx),
      40,
    );
    const lines = out.split('\n');
    // One sample => exactly one visual line, never wrapped.
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toHaveLength(40);
    expect(stripAnsi(lines[0]!).endsWith('…')).toBe(true);
  });

  it('dims the directory part and keeps the basename undyed', () => {
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
          const renderer = pickResultRenderer('Grep');
          const raw = joinRender(
            renderer(call('Grep', { pattern: 'foo' }), searchResult([matches[0]!]), ctx),
          );
      // Directory wrapped in dim codes, basename follows after the dim reset.
      expect(raw).toContain('\u001B[2msrc/\u001B[22m');
      expect(raw).toContain('a.ts');
    } finally {
      chalk.level = prevLevel;
    }
  });
});
