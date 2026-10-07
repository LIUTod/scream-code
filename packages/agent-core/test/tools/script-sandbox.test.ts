import { describe, expect, it } from 'vitest';

import { CodemodeSandbox, MAX_OUTPUT_CHARS } from '@earendil-works/pi-codemode';

describe('script sandbox (package integration)', () => {
  it('runs a script that calls an injected tool and returns its text output', async () => {
    const calls: unknown[] = [];
    const sandbox = new CodemodeSandbox({
      tools: [
        {
          name: 'echo',
          description: 'Echoes the input back.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          execute: (args) => {
            calls.push(args);
            return { echoed: (args as { text: string }).text };
          },
        },
      ],
    });
    try {
      const result = await sandbox.execute(
        [
          'const r = await tools.echo({ text: "hi" });',
          'text("echoed:" + r.echoed);',
        ].join('\n'),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.output).toEqual([{ type: 'text', text: 'echoed:hi' }]);
      expect(calls).toEqual([{ text: 'hi' }]);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toMatchObject({ name: 'echo', status: 'ok' });
    } finally {
      await sandbox.close();
    }
  });

  it('reports script errors as the script kind', async () => {
    const sandbox = new CodemodeSandbox({ tools: [] });
    try {
      const result = await sandbox.execute('throw new Error("boom");');

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected the script to fail');
      expect(result.error.kind).toBe('script');
      expect(result.error.message).toContain('boom');
    } finally {
      await sandbox.close();
    }
  });

  it('surfaces store writes only for successful runs', async () => {
    const sandbox = new CodemodeSandbox({ tools: [] });
    try {
      const ok = await sandbox.execute('store("kept", 1); text("done");');
      expect(ok.ok).toBe(true);
      if (!ok.ok) throw new Error(ok.error.message);
      expect(ok.storeWrites).toEqual({ set: { kept: 1 }, delete: [] });

      const failed = await sandbox.execute('store("lost", 2); throw new Error("nope");');
      expect(failed.ok).toBe(false);
      expect('storeWrites' in failed).toBe(false);
    } finally {
      await sandbox.close();
    }
  });

  it('fails a script whose output exceeds the package output limit, even when the script swallows the error', async () => {
    const sandbox = new CodemodeSandbox({ tools: [] });
    const chunkChars = 100_000;
    const chunks = Math.ceil(MAX_OUTPUT_CHARS / chunkChars) + 5;
    try {
      // The limit exists so one script cannot grow host memory without bound;
      // it must fail the run even when the throw is caught inside the script.
      const result = await sandbox.execute(
        [
          'try {',
          `  for (let i = 0; i < ${chunks}; i++) text("x".repeat(${chunkChars}));`,
          '} catch (error) {',
          '  text("swallowed");',
          '}',
          'text("after");',
        ].join('\n'),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected the script to fail');
      expect(result.error.kind).toBe('script');
      expect(result.error.message).toContain('exceeded the limit');
    } finally {
      await sandbox.close();
    }
  }, 30_000);
});
