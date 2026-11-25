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
    // Without memory numbers there is no memory section.
    expect(block).not.toContain('<memory-use');
    const withMemory = renderFrictionBlock(report, report, [], undefined, {
      total: 106,
      added: 4,
      recalled: 2,
      neverRecalledOld: 40,
      topRecalled: [{ id: 'memo-a-1', count: 3 }],
    });
    expect(withMemory).toContain('<memory-use window="7 days">');
    expect(withMemory).toContain('memories: 106 (4 added this week)');
    expect(withMemory).toContain('recalled this week: 2; most: memo-a-1 (3 times in all)');
    expect(withMemory).toContain('never recalled and older than 30 days: 40');
    expect(JSON.stringify(report)).not.toContain('API_KEY');
  });

  it('counts edits made through Edit / Write against shell commands that changed files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'friction-'));
    homes.push(home);
    wire(home, 'ses-b', [
      { type: 'tool.call', toolCallId: '1', name: 'Edit', args: {} },
      { type: 'tool.result', toolCallId: '1', result: { isError: false, output: 'ok' } },
      { type: 'tool.call', toolCallId: '2', name: 'Write', args: {} },
      { type: 'tool.result', toolCallId: '2', result: { isError: false, output: 'ok' } },
      { type: 'tool.call', toolCallId: '3', name: 'Bash', args: {} },
      { type: 'tool.result', toolCallId: '3', result: { isError: false, output: '', display: { kind: 'file_changes', scripted: true, files: [] } } },
      { type: 'tool.call', toolCallId: '5', name: 'Bash', args: {} },
      // A formatter changing files is not an edit that should have gone through Edit.
      { type: 'tool.result', toolCallId: '5', result: { isError: false, output: '', display: { kind: 'file_changes', files: [] } } },
      { type: 'tool.call', toolCallId: '4', name: 'Bash', args: {} },
      { type: 'tool.result', toolCallId: '4', result: { isError: false, output: 'listing' } },
    ]);
    const report = await collectFriction(home, Date.now() - 86_400_000);
    expect(report.fileEdits).toEqual({ viaTools: 2, viaShell: 1 });
    const block = renderFrictionBlock(report, report, []);
    expect(block).toContain('<file-edits window="7 days">');
    expect(block).toContain('through Edit / Write: 2; shell commands that changed files the agent was editing: 1 (33% of edits)');
  });
});
