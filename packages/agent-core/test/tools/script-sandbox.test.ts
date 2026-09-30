import { describe, expect, it } from 'vitest';

import { CodemodeSandbox } from '@earendil-works/pi-codemode';

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
});
