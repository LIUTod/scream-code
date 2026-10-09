/**
 * A failed `closeSession` / `deleteSession` must still drop the session from
 * the core's active map. `Session.close()` latches every background manager
 * shut before it tears anything down (`markSessionClosed`), and that latch has
 * no reset counterpart — so a session kept around after a throwing close would
 * be handed straight back by a later `resumeSession` and stay permanently
 * unable to deliver background task notifications. The failure must still
 * surface to the caller (the teardown was not clean); only the active-map
 * delete is unconditional. `deleteSession` keeps its destructive store delete
 * behind a clean close: a failed teardown must not destroy recoverable data,
 * and a retried delete then goes straight to the store.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  ScreamCore,
  type ApprovalResponse,
  type CoreAPI,
  type RPCMethods,
  type SDKAPI,
} from '../../src';
import type { Session } from '../../src/session';

let tmp: string;

afterEach(async () => {
  if (tmp !== undefined) {
    await rm(tmp, { recursive: true, force: true });
  }
});

describe('close failure', () => {
  it('drops a session whose close threw so a later resume never serves its latched instance', async () => {
    const { core, rpc, workDir } = await createHarness();
    const created = await rpc.createSession({ id: 'ses_close_failure', workDir });
    const session = core.sessions.get(created.id);
    expect(session).toBeDefined();
    sabotageClose(session!);

    await expect(rpc.closeSession({ sessionId: created.id })).rejects.toThrow(/disposal step/);

    // The delete is unconditional: the latched instance is gone from the
    // active map even though the close threw...
    expect(core.sessions.has(created.id)).toBe(false);

    // ...so a later resume builds a fresh Session instead of serving the stale
    // one back. Serving it would leave the reopened session with latched
    // background managers — its terminal task notifications could never steer
    // again.
    const resumed = await rpc.resumeSession({ sessionId: created.id });
    expect(resumed.id).toBe(created.id);
    expect(core.sessions.has(created.id)).toBe(true);
    expect(core.sessions.get(created.id)).not.toBe(session);

    await rpc.closeSession({ sessionId: created.id });
  }, 60_000);

  it('deleteSession clears the active map on a failed close but keeps the store for a retry', async () => {
    const { core, rpc, workDir } = await createHarness();
    const created = await rpc.createSession({ id: 'ses_delete_failure', workDir });
    const session = core.sessions.get(created.id);
    expect(session).toBeDefined();
    sabotageClose(session!);

    // ① The teardown failure still reaches the caller...
    await expect(rpc.deleteSession({ sessionId: created.id })).rejects.toThrow(/disposal step/);
    // ② ...the latched instance still leaves the active map...
    expect(core.sessions.has(created.id)).toBe(false);

    // ③ ...and the store survives: the failed close must not destroy
    // recoverable data, so the session is still resumable from disk — and the
    // resume builds a fresh instance instead of serving the stale one back.
    const resumed = await rpc.resumeSession({ sessionId: created.id });
    expect(resumed.id).toBe(created.id);
    expect(core.sessions.get(created.id)).not.toBe(session);
    await rpc.closeSession({ sessionId: created.id });

    // ④ The retried delete finds no active session and removes the store for
    // real (the directory on disk is the data the earlier attempt preserved).
    expect(await directoryExists(created.sessionDir)).toBe(true);
    await expect(rpc.deleteSession({ sessionId: created.id })).resolves.toBeUndefined();
    expect(await directoryExists(created.sessionDir)).toBe(false);
  }, 60_000);
});

interface Harness {
  readonly core: ScreamCore;
  readonly rpc: RPCMethods<CoreAPI>;
  readonly workDir: string;
}

/** Core + SDK RPC pair over a throwaway home, wired with a mock provider. */
async function createHarness(): Promise<Harness> {
  tmp = await mkdtemp(join(tmpdir(), 'scream-close-failure-'));
  const homeDir = join(tmp, 'home');
  const workDir = join(tmp, 'work');
  await mkdir(homeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(
    join(homeDir, 'config.toml'),
    `default_model = "default-mock"

[providers.test]
type = "scream"
api_key = "test-key"

[models."default-mock"]
provider = "test"
model = "default-mock"
max_context_size = 100000
`,
  );

  const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
  const core = new ScreamCore(coreRpc, { homeDir });
  const rpc = await sdkRpc({
    emitEvent: vi.fn(),
    requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '' })),
  });
  return { core, rpc, workDir };
}

/**
 * Sabotage one close-out step. `disposeAll()` still runs every other step (one
 * failure never skips the rest) and `close()` rejects with the collected
 * AggregateError, so this reproduces the failing-close path exactly.
 */
function sabotageClose(session: Session): void {
  session.disposables.add('test-close-failure', () => {
    throw new Error('close exploded');
  });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
