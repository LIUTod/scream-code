/**
 * One process holds a session at a time.
 *
 * Two cores on the same Scream home stand in for two processes (a terminal and
 * the background host): the lock is a listening socket, so it behaves the same
 * whether the second holder is another core in this process or another
 * process. A second open is refused with `session.in_use` instead of two
 * writers interleaving one session's records; a close lets the next open in;
 * a holder hands a session over only when it agreed to.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  ScreamCore,
  type ApprovalResponse,
  type CoreAPI,
  type CoreRPC,
  type SDKAPI,
} from '../../src';
import { requestSessionHandover, sessionLockHolder } from '../../src/utils/session-lock';

describe('session process lock', () => {
  let tmp: string;
  let homeDir: string;
  let workDir: string;
  const cores: ScreamCore[] = [];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'scream-session-lock-'));
    homeDir = join(tmp, 'home');
    workDir = join(tmp, 'work');
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      for (const id of [...core.sessions.keys()]) {
        await core.closeSession({ sessionId: id });
      }
    }
    await rm(tmp, { recursive: true, force: true });
  });

  async function createTestRpc(): Promise<{ core: ScreamCore; rpc: CoreRPC }> {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new ScreamCore(coreRpc, { homeDir });
    cores.push(core);
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    return { core, rpc };
  }

  it('refuses a second open while the first holder has the session', async () => {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_lock_busy', workDir });
    expect(await sessionLockHolder(homeDir, created.id)).toMatchObject({ pid: process.pid });

    const second = await createTestRpc();
    await expect(second.rpc.resumeSession({ sessionId: created.id })).rejects.toMatchObject({
      code: 'session.in_use',
    });
    expect(second.core.sessions.has(created.id)).toBe(false);
  });

  it('gives two opens of one session at once in one process the same session, and keeps the lock', async () => {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_lock_race', workDir });
    await first.rpc.closeSession({ sessionId: created.id });

    const host = await createTestRpc();
    const [a, b] = await Promise.all([
      host.rpc.resumeSession({ sessionId: created.id }),
      host.rpc.resumeSession({ sessionId: created.id }),
    ]);
    expect(a.id).toBe(created.id);
    expect(b.id).toBe(created.id);
    expect(host.core.sessions.size).toBe(1);
    expect(await sessionLockHolder(homeDir, created.id)).toMatchObject({ pid: process.pid });
    const other = await createTestRpc();
    await expect(other.rpc.resumeSession({ sessionId: created.id })).rejects.toMatchObject({ code: 'session.in_use' });
  });

  it('lets the next process in once the holder closes the session', async () => {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_lock_close', workDir });
    await first.rpc.closeSession({ sessionId: created.id });
    expect(await sessionLockHolder(homeDir, created.id)).toBeUndefined();

    const second = await createTestRpc();
    await expect(second.rpc.resumeSession({ sessionId: created.id })).resolves.toBeDefined();
  });

  it('refuses to delete a session another process has open', async () => {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_lock_delete', workDir });

    const second = await createTestRpc();
    await expect(second.rpc.deleteSession({ sessionId: created.id })).rejects.toMatchObject({
      code: 'session.in_use',
    });
    expect(first.core.sessions.has(created.id)).toBe(true);
  });

  it('refuses a handover unless the holder agreed to hand sessions over', async () => {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_lock_refuse', workDir });

    expect(await requestSessionHandover(homeDir, created.id, 1_000)).toBe(false);
    expect(first.core.sessions.has(created.id)).toBe(true);
  });

  it('hands a session over when the holder agrees, and closes it there', async () => {
    const first = await createTestRpc();
    const asked: string[] = [];
    first.core.setSessionHandoverHandler(async (sessionId) => {
      asked.push(sessionId);
      return true;
    });
    const created = await first.rpc.createSession({ id: 'ses_lock_handover', workDir });

    expect(await requestSessionHandover(homeDir, created.id, 10_000)).toBe(true);
    expect(asked).toEqual([created.id]);
    expect(first.core.sessions.has(created.id)).toBe(false);

    const second = await createTestRpc();
    await expect(second.rpc.resumeSession({ sessionId: created.id })).resolves.toBeDefined();
  });

  it('hands nothing off from an idle session, and leaves no record behind', async () => {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_lock_idle_handoff', workDir });
    await expect(first.rpc.handOffSession({ sessionId: created.id })).resolves.toEqual({ handedOff: false });
    await expect(first.rpc.handOffSession({ sessionId: 'ses_not_open' })).resolves.toEqual({ handedOff: false });
    const { listRunningWork } = await import('../../src/session/running-work');
    expect(listRunningWork(homeDir)).toEqual([]);
  });
});
