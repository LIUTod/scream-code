/**
 * Session close-out checklist.
 *
 * `Session.disposables` is the mechanism that keeps `close()` complete: the
 * names snapshot freezes the full cleanup list so a dropped or renamed
 * registration fails here instead of leaking, and the cases below observe two
 * cleanups that used to be pure memory leaks — the shell tool's pending-task
 * map and the subagent message bus.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { testJian } from '../fixtures/test-jian';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { buildSubagentMessage } from '../../src/session/subagent-messages';
import {
  createBackgroundTask,
  getPendingBackgroundCount,
  stopAllPendingBackgroundTasks,
} from '../../src/tools/builtin/shell/background-tasks';

/**
 * The close-out checklist every session registers at construction, in
 * registration order. A new teardown step must appear here — making the
 * omission a test failure is the point of the snapshot.
 */
const EXPECTED_DISPOSABLES = [
  'background-pending',
  'cron',
  'rlm',
  'lsp',
  'mcp',
  'log',
  'message-bus',
] as const;

const tempDirs: string[] = [];

afterEach(async () => {
  stopAllPendingBackgroundTasks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('Session close-out checklist', () => {
  it('registers every close-out step at construction', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-disposables-snapshot',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });

    expect(session.disposables.names()).toEqual([...EXPECTED_DISPOSABLES]);
  });

  it('sweeps the shell tool pending-task registry on close', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-pending-sweep',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const kill = vi.fn(async () => {});
    createBackgroundTask('sleep 60', new Promise(() => {}), { kill, pid: 4242 });
    expect(getPendingBackgroundCount()).toBe(1);

    await session.close();

    // Timed-out commands parked in the background must not outlive the
    // session: the sweep kills them and empties the module-level registry.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(getPendingBackgroundCount()).toBe(0);
  });

  it('clears undelivered subagent messages on close', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-message-bus',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    session.subagentMessages.send(buildSubagentMessage('main', 'sub-1', 'queue', 'hello'));
    expect(session.subagentMessages.activeCount('sub-1')).toBe(1);

    await session.close();

    // A queued parent→child message must not survive the session that owns
    // its mailbox.
    expect(session.subagentMessages.activeCount('sub-1')).toBe(0);
  });
});

async function sessionFixture(): Promise<{
  readonly sessionDir: string;
  readonly workDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-session-close-'));
  tempDirs.push(dir);
  const workDir = join(dir, 'work');
  const sessionDir = join(dir, 'session');
  return { sessionDir, workDir };
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}
