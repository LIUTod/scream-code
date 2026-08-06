import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExecutableToolContext } from '#/loop/types';
import { PythonTool } from '#/tools/builtin/python/python';

const ctx = { turnId: 't', toolCallId: 'c', signal: undefined } as unknown as ExecutableToolContext;

async function runTool(t: PythonTool, args: { code: string }): Promise<import('#/loop/types').ExecutableToolResult> {
  const exec = t.resolveExecution(args);
  if ('execute' in exec) return exec.execute(ctx);
  return exec;
}

describe('PythonTool (persistent kernel)', () => {
  let tool: PythonTool;

  beforeAll(async () => {
    tool = new PythonTool(process.cwd());
  });

  afterAll(() => {
    tool.dispose();
  });

  it('prefers python3 on POSIX and python on Windows', () => {
    expect(PythonTool.pythonCandidates('darwin')).toEqual(['python3', 'python']);
    expect(PythonTool.pythonCandidates('linux')).toEqual(['python3', 'python']);
    expect(PythonTool.pythonCandidates('win32')).toEqual(['python', 'python3']);
  });

  it('executes code and persists state across calls', async () => {
    const r1 = await runTool(tool, { code: 'a = 1' });
    expect(r1.isError).toBeFalsy();
    const r2 = await runTool(tool, { code: 'print(a)' });
    expect(r2.isError).toBeFalsy();
    expect(String(r2.output)).toContain('1');
  }, 20_000);

  it('keeps imports across calls', async () => {
    const r1 = await runTool(tool, { code: 'import math' });
    expect(r1.isError).toBeFalsy();
    const r2 = await runTool(tool, { code: 'print(math.sqrt(16))' });
    expect(String(r2.output)).toContain('4.0');
  }, 20_000);

  it('returns tracebacks as error output', async () => {
    const r = await runTool(tool, { code: '1 / 0' });
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('Traceback');
  }, 20_000);

  it('does not leak the DONE marker into output', async () => {
    const r = await runTool(tool, { code: 'print("hello")' });
    expect(String(r.output)).toContain('hello');
    expect(String(r.output)).not.toContain('__SCREAM_PY_DONE__');
  }, 20_000);

  it('executes multi-line blocks and keeps state from inside them', async () => {
    const r1 = await runTool(tool, { code: 'total = 0\nfor i in range(1, 4):\n    total += i' });
    expect(r1.isError).toBeFalsy();
    const r2 = await runTool(tool, { code: 'print(total)' });
    expect(String(r2.output)).toContain('6');
  }, 20_000);

  it('keeps the kernel consistent under concurrent calls', async () => {
    // Two parallel calls: the kernel is single-threaded, so at most one runs
    // and the other reports busy — but the kernel must not corrupt.
    const results = await Promise.all([
      runTool(tool, { code: 'x = 10' }),
      runTool(tool, { code: 'y = 20' }),
    ]);
    const ok = results.filter((r) => !r.isError);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const r3 = await runTool(tool, { code: 'print((x if "x" in dir() else 0) + (y if "y" in dir() else 0))' });
    expect(r3.isError).toBeFalsy();
    const total = parseInt(String(r3.output).match(/\d+/)?.[0] ?? '0', 10);
    expect([0, 10, 20, 30]).toContain(total);
  }, 20_000);

  it('bridges rlm() host requests to registered handlers', async () => {
    const tool2 = new PythonTool(process.cwd(), {
      hostHandlers: {
        'rlm.run': async (payload) => ({ id: 'sub-1', name: String(payload['name'] ?? '') }),
      },
    });
    try {
      const r = await runTool(tool2, {
        code: 'handle = rlm("review the auth flow", name="auth-review")\nprint(handle)',
      });
      expect(r.isError).toBeFalsy();
      expect(String(r.output)).toContain('sub-1');
      expect(String(r.output)).toContain('auth-review');
    } finally {
      tool2.dispose();
    }
  }, 20_000);

  it('surfaces handler errors back to the kernel as exceptions', async () => {
    const tool2 = new PythonTool(process.cwd(), {
      hostHandlers: {
        'rlm.run': async () => {
          throw new Error('no subagent host');
        },
      },
    });
    try {
      const r = await runTool(tool2, {
        code: 'try:\n    rlm("task")\n    print("NO_ERROR")\nexcept Exception as e:\n    print("ERR", str(e))',
      });
      expect(r.isError).toBeFalsy();
      expect(String(r.output)).toContain('ERR');
      expect(String(r.output)).toContain('no subagent host');
    } finally {
      tool2.dispose();
    }
  }, 20_000);
});
