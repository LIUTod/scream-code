import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { testJian } from '../fixtures/test-jian';

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: 'unsupported', isError: true })),
  } as SDKSessionRPC;
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

async function fixture(): Promise<{ sessionDir: string; workDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scream-mcp-resume-'));
  tempDirs.push(root);
  const workDir = join(root, 'work');
  const sessionDir = join(root, 'session');
  await mkdir(workDir, { recursive: true });
  return { sessionDir, workDir };
}

describe('MCP instructions on resume', () => {
  it('schedules instruction delivery after a resume (resume bypasses createMain)', async () => {
    const { sessionDir, workDir } = await fixture();
    const options = {
      jian: testJian.withCwd(workDir),
      id: 'resume-instructions',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    } as const;

    // Persist a session first, then close it: resume reads its metadata.
    const first = new Session(options as never);
    await first.createMain();
    await first.close();

    const resumed = new Session(options as never);
    const inject = vi.fn();
    (resumed as unknown as { injectMcpInstructions: () => void }).injectMcpInstructions = inject;

    await resumed.resume();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Without the resume hook this never fires: createMain is the only other
    // delivery point, and resume does not go through it.
    expect(inject).toHaveBeenCalled();
    await resumed.close();
  }, 20_000);
});
