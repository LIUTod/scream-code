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
    // dsh-style skeleton: toolbar + timeline + fixed two-column table + drawer.
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
