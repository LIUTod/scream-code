import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { buildReport } from '#/host/report';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildReport', () => {
  it('says what jobs did in the period and what waits for the person', async () => {
    const home = mkdtempSync(join(tmpdir(), 'report-'));
    homes.push(home);
    const store = new JobStore(home);
    const job = await store.add({
      title: 'CI check',
      prompt: 'check CI',
      starts: { kind: 'cron', cron: '0 9 * * *' },
      does: 'report',
      workDir: home,
      createdBy: 'person',
    });
    const now = Date.now();
    await store.recordRun(job.id, { at: now - 3_600_000, ok: true, sessionId: 's1', summary: 'all green' }, now);
    await store.recordRun(job.id, { at: now - 10 * 86_400_000, ok: false, sessionId: 's0', summary: 'old' }, now);
    mkdirSync(join(home, 'host', 'inbox'), { recursive: true });
    writeFileSync(
      join(home, 'host', 'inbox', 'inbox-1.json'),
      JSON.stringify({
        id: 'inbox-1',
        kind: 'approval',
        sessionId: 's',
        workDir: home,
        createdAt: now - 1000,
        expiresAt: now + 3_600_000,
        status: 'pending',
        approval: { tool: 'Bash', action: 'git push origin main', key: 'k', reason: '' },
      }),
    );
    const text = buildReport(home, 86_400_000, now).join('\n');
    expect(text).toContain('CI check');
    expect(text).toContain('all green');
    expect(text).not.toContain('old');
    expect(text).toContain('git push origin main');
  });
});
