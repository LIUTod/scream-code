import vm from 'node:vm';

import { getLocale, setLocale } from '@scream-code/config';
import { describe, expect, it } from 'vitest';

import { renderTraceHtml } from '#/utils/trace/render-trace-html';
import type { TraceCell } from '#/utils/trace/trace-types';

function sampleCell(overrides: Partial<TraceCell> = {}): TraceCell {
  return {
    index: 1,
    kind: 'message',
    text: 'hello',
    timeSeconds: 1.5,
    input: 100,
    cacheRead: 50,
    output: 20,
    ...overrides,
  };
}

describe('renderTraceHtml', () => {
  it('produces a self-contained document with inlined data and no external URLs', () => {
    const html = renderTraceHtml({
      title: '测试会话',
      sessionId: 'sess-1',
      createdAt: 1700000000000,
      cells: [sampleCell()],
    });

    expect(html).toContain('<title>测试会话 — 会话轨迹</title>');
    expect(html).toContain('sess-1');
    expect(html).toContain('id="data"');
    expect(html).toContain('"text":"hello"');
    // Self-contained skeleton: toolbar + timeline + fixed two-column table + drawer.
    expect(html).toContain('class="toolbar"');
    expect(html).toContain('id="timeline-track"');
    expect(html).toContain('id="turns"');
    expect(html).toContain('id="calls"');
    expect(html).toContain('id="mode"');
    expect(html).toContain('id="json"');
    expect(html).toContain('event-column');
    expect(html).toContain('id="detail"');
    expect(html).toContain('content-visibility: auto');
    // No external resources: the document must be fully offline.
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
    expect(html).not.toMatch(/@import/);
  });

  it('escapes closing script tags in embedded data', () => {
    const html = renderTraceHtml({
      title: 't',
      sessionId: 's',
      createdAt: 0,
      cells: [sampleCell({ text: '</script><script>alert(1)</script>' })],
    });
    const dataBlock = html.split('id="data" type="application/json">')[1]?.split('</script>')[0] ?? '';
    expect(dataBlock).not.toContain('</script>');
    expect(dataBlock).toContain('<\\/script>');
  });

  it('keeps cells ordered and includes kind labels for the renderer', () => {
    const cells = [
      sampleCell({ index: 1, kind: 'user', text: 'u' }),
      sampleCell({ index: 2, kind: 'tool', text: 't', isError: true }),
    ];
    const html = renderTraceHtml({ title: 't', sessionId: 's', createdAt: 0, cells });
    // The renderer embeds the label map; data keeps raw kinds.
    expect(html).toContain('"user":"USER"');
    expect(html).toContain('"kind":"user"');
    expect(html).toContain('"isError":true');
  });
});

describe('renderTraceHtml in the UI language', () => {
  function render(locale: 'en' | 'zh'): string {
    const previous = getLocale();
    setLocale(locale);
    try {
      return renderTraceHtml({
        title: 'demo',
        sessionId: 'sess-1',
        createdAt: 1700000000000,
        cells: [sampleCell()],
      });
    } finally {
      setLocale(previous);
    }
  }

  /** The report's script: the last <script>, after the JSON data block. */
  function scriptOf(html: string): string {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    return blocks.at(-1)?.[1] ?? '';
  }

  /** The `ui` label table the script is rendered with. */
  function uiTableOf(script: string): Record<string, string> {
    const line = script.split('\n').find((l) => l.startsWith('var ui = '));
    return JSON.parse((line ?? '').replace(/^var ui = /, '').replace(/;$/, '')) as Record<string, string>;
  }

  it('titles and labels the English report in English', () => {
    const html = render('en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>demo — Session trace</title>');
    expect(html).toContain('placeholder="Search…"');
    expect(html).not.toMatch(/[\u4E00-\u9FFF]/);
  });

  it('keeps the Chinese report as it was', () => {
    const html = render('zh');
    expect(html).toContain('<html lang="zh">');
    expect(html).toContain('<title>demo — 会话轨迹</title>');
    expect(html).toContain('placeholder="搜索…"');
    const ui = uiTableOf(scriptOf(html));
    expect(ui['kind']).toBe('类型');
    expect(ui['cacheRead']).toBe('缓存读');
    expect(ui['count']).toBe('{shown} / {total} 条');
  });

  it.each(['en', 'zh'] as const)('emits a script that is valid JavaScript (%s)', (locale) => {
    expect(() => new vm.Script(scriptOf(render(locale)))).not.toThrow();
  });

  it.each(['en', 'zh'] as const)('defines every label the script reads (%s)', (locale) => {
    // A typo like `ui.cachRead` is valid JavaScript and renders "undefined" in the page.
    const script = scriptOf(render(locale));
    const table = uiTableOf(script);
    const used = new Set([...script.matchAll(/\bui\.([A-Za-z]+)/g)].map((m) => m[1] as string));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(table[name], `ui.${name}`).toBeTypeOf('string');
    for (const value of Object.values(table)) expect(value.length).toBeGreaterThan(0);
  });

  it('fills {placeholders} in the label templates', () => {
    const script = scriptOf(render('en'));
    const prelude = script.split('\n').filter((l) => l.startsWith('var ui = ') || l.startsWith('function fill(')).join('\n');
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(`${prelude}\nresult = [fill(ui.count, { shown: 3, total: 10 }), fill(ui.timeTip, { seconds: '1.5' }), fill(ui.turnCount, { n: 4 })];`, sandbox);
    expect(sandbox['result']).toEqual(['3 / 10 records', 'Time 1.5s', '· 4 records']);
  });

  it('cannot be broken out of the script block by a label', () => {
    const script = scriptOf(render('en'));
    expect(script).not.toContain('</script');
  });
});
