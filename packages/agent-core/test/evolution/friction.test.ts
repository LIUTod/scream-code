import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectFriction, renderFrictionBlock } from '../../src/evolution/friction';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function wire(home: string, sessionId: string, events: unknown[]): void {
  const dir = join(home, 'sessions', 'wd-key', sessionId, 'agents', 'main');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(dir, 'wire.jsonl'),
    events.map((event) => JSON.stringify({ type: 'context.append_loop_event', event, time: now })).join('\n') + '\n',
  );
}

describe('collectFriction', () => {
  it('counts calls, errors and skill use without keeping any content', async () => {
    const home = mkdtempSync(join(tmpdir(), 'friction-'));
    homes.push(home);
    wire(home, 'ses-a', [
      { type: 'tool.call', toolCallId: '1', name: 'Edit', args: { path: 'secret-path', old: 'API_KEY=xyz' } },
      { type: 'tool.result', toolCallId: '1', result: { isError: true, output: 'old string not found: API_KEY=xyz' } },
      { type: 'tool.call', toolCallId: '2', name: 'Edit', args: {} },
      { type: 'tool.result', toolCallId: '2', result: { isError: false, output: 'ok' } },
      { type: 'tool.call', toolCallId: '3', name: 'Skill', args: { skill: 'fix-flaky' } },
      { type: 'tool.result', toolCallId: '3', result: { isError: false, output: '' } },
    ]);
    const report = await collectFriction(home, Date.now() - 86_400_000);
    expect(report.sessions).toBe(1);
    expect(report.tools.find((t) => t.tool === 'Edit')).toEqual({ tool: 'Edit', calls: 2, errors: 1, worstSessions: ['ses-a'] });
    expect(report.skillCalls).toEqual({ 'fix-flaky': 1 });
    const block = renderFrictionBlock(report, report, ['fix-flaky', 'old-skill']);
    expect(block).toContain('Edit: 2 calls, 1 errors (50%); most in sessions ses-a');
    expect(block).toContain('never invoked: old-skill');
    expect(block).not.toContain('API_KEY');
    expect(JSON.stringify(report)).not.toContain('API_KEY');
  });
});
