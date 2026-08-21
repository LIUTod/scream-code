import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildTraceCells } from '../../src/utils/trace/trace-builder';
import { renderTraceHtml } from '../../src/utils/trace/render-trace-html';
import type { TraceDocument } from '../../src/utils/trace/trace-types';

function writeWire(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'scream-trace-'));
  const path = join(dir, 'wire.jsonl');
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

describe('buildTraceCells', () => {
  it('builds a user cell from a prompt and a message cell from a step', () => {
    const path = writeWire([
      '{"time":1000,"type":"turn.prompt","input":[{"type":"text","text":"hello"}]}',
      '{"time":2000,"type":"context.append_loop_event","event":{"type":"step.begin","stepUuid":"s1"}}',
      '{"time":2100,"type":"context.append_loop_event","event":{"type":"block.start","blockType":"text"}}',
      '{"time":2200,"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"the answer"}}}',
      '{"time":2300,"type":"context.append_loop_event","event":{"type":"block.end"}}',
      '{"time":3000,"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":10,"inputCacheRead":5,"inputCacheCreation":2,"output":7}}}',
    ]);

    const cells = buildTraceCells({ wirePath: path });
    expect(cells).toHaveLength(2);

    expect(cells[0]).toMatchObject({ index: 1, kind: 'user', text: 'hello', opensTurn: true, turn: 1 });
    expect(cells[1]).toMatchObject({
      index: 2,
      kind: 'message',
      text: 'the answer',
      turn: 1,
      input: 10,
      output: 7,
      cacheRead: 5,
      cacheWrite: 2,
    });
  });

  it('computes per-cell duration from the time delta', () => {
    const path = writeWire([
      '{"time":1000,"type":"turn.prompt","input":[{"type":"text","text":"hi"}]}',
      '{"time":2000,"type":"context.append_loop_event","event":{"type":"step.begin","stepUuid":"s1"}}',
      '{"time":2100,"type":"context.append_loop_event","event":{"type":"block.start","blockType":"text"}}',
      '{"time":2200,"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"ok"}}}',
      '{"time":4000,"type":"context.append_loop_event","event":{"type":"step.end"}}',
    ]);

    const cells = buildTraceCells({ wirePath: path });
    // Message cell spans step.begin (2000) to step.end (4000) → 2.0s.
    expect(cells[1]!.timeSeconds).toBeCloseTo(2.0);
  });

  it('pairs a tool call with its result and marks success/failure', () => {
    const okPath = writeWire([
      '{"time":1000,"type":"turn.prompt","input":[{"type":"text","text":"run ls"}]}',
      '{"time":1500,"type":"context.append_loop_event","event":{"type":"step.begin","stepUuid":"s1"}}',
      '{"time":1600,"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"t1","name":"Bash","args":{"cmd":"ls"}}}',
      '{"time":2000,"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"t1","result":{"output":"file1\\nfile2"}}}',
      '{"time":2500,"type":"context.append_loop_event","event":{"type":"step.end"}}',
    ]);
    const okCells = buildTraceCells({ wirePath: okPath });
    const okTool = okCells.find((c) => c.kind === 'tool');
    expect(okTool).toMatchObject({ text: 'Bash ✓', result: 'file1 file2', isError: false });

    const errPath = writeWire([
      '{"time":1000,"type":"turn.prompt","input":[{"type":"text","text":"boom"}]}',
      '{"time":1500,"type":"context.append_loop_event","event":{"type":"step.begin","stepUuid":"s1"}}',
      '{"time":1600,"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"t1","name":"Bash","args":{"cmd":"ls"}}}',
      '{"time":2000,"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"t1","result":{"isError":true,"error_message":"nope"}}}',
      '{"time":2500,"type":"context.append_loop_event","event":{"type":"step.end"}}',
    ]);
    const errCells = buildTraceCells({ wirePath: errPath });
    const errTool = errCells.find((c) => c.kind === 'tool');
    expect(errTool).toMatchObject({ text: 'Bash ✗', result: 'nope', isError: true });
  });

  it('increments the turn number across multiple prompts', () => {
    const path = writeWire([
      '{"time":1000,"type":"turn.prompt","input":[{"type":"text","text":"first"}]}',
      '{"time":3000,"type":"turn.prompt","input":[{"type":"text","text":"second"}]}',
    ]);
    const cells = buildTraceCells({ wirePath: path });
    const users = cells.filter((c) => c.kind === 'user');
    expect(users.map((c) => c.turn)).toEqual([1, 2]);
  });

  it('throws when the wire file is missing', () => {
    expect(() => buildTraceCells({ wirePath: join(tmpdir(), 'does-not-exist.jsonl') })).toThrow();
  });

  it('throws when the wire file has no usable records', () => {
    const path = writeWire([]);
    expect(() => buildTraceCells({ wirePath: path })).toThrow(/no wire records/);
  });

  it('skips malformed lines without aborting the trace', () => {
    const path = writeWire([
      '{"time":1000,"type":"turn.prompt","input":[{"type":"text","text":"hi"}]}',
      '{this is not json',
    ]);
    const cells = buildTraceCells({ wirePath: path });
    expect(cells.filter((c) => c.kind === 'user')).toHaveLength(1);
  });
});

describe('renderTraceHtml', () => {
  function doc(cells: TraceDocument['cells']): TraceDocument {
    return { title: 'Trace', sessionId: 's1', createdAt: 0, cells };
  }

  it('neutralizes </ in cell content so it cannot break out of the data script', () => {
    const html = renderTraceHtml(doc([{ index: 1, kind: 'user', text: 'a</script>b', timeSeconds: null }]));
    // The raw, unescaped sequence must not survive into the emitted document.
    expect(html).not.toContain('a</script>b');
    // The cell content is escaped so the closing tag cannot terminate the JSON script early.
    expect(html).toContain('a<\\/script>b');
  });

  it('HTML-escapes the title and session id', () => {
    const html = renderTraceHtml({
      title: '<img src=x onerror=alert(1)>',
      sessionId: '<b>s</b>',
      createdAt: 0,
      cells: [],
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;s&lt;/b&gt;');
    // The raw, unescaped markup must not appear.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('emits a well-formed document shell with the embedded data payload', () => {
    const html = renderTraceHtml(doc([{ index: 1, kind: 'user', text: 'hi', timeSeconds: null }]));
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<script id="data" type="application/json">');
    expect(html).toContain('<script>');
    expect(html).toContain('</html>');
  });
});
