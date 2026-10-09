/**
 * Ghost-turn gate: `Session.close()` vs. background task notifications.
 *
 * A session can close while `keepAliveOnExit` (default true) keeps background
 * tasks running. When such a task reached a terminal state, its notification
 * was steered into the now-dead session — and steering an idle agent
 * auto-launches a turn (`AgentTurn.steer` → `launch`), so the product paid for
 * an invisible "ghost turn": API calls spent, wire records written, no user
 * watching. The fix has two halves, both pinned here against a real `Session`:
 *
 *   1. `close()` latches every resident agent's BackgroundManager as closed
 *      before any teardown. A terminal notification is then dropped — not
 *      steered, not marked delivered — which is exactly what lets the reopen
 *      path (`Agent.resume()` → `reconcile()` → restore) append it silently.
 *   2. `keepAliveOnExit` now protects only real bash processes. Agent-class
 *      tasks (registered through `registerAgentTask`) are coroutines over a
 *      subagent turn that the close cancelled, so close stops them explicitly
 *      instead of stranding a half-dead ledger entry that later notifies a
 *      dead session.
 *   3. The latch reaches managers whose agents were already evicted, not just
 *      the current `session.agents` members: a finished subagent leaves that
 *      map while a background task it owns may still be running, so the
 *      session keeps a weak reference to every manager it ever created and
 *      latches the surviving ones on close (a GC-reclaimed manager has no one
 *      left to notify and is skipped).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable, type Writable } from 'node:stream';
import { join } from 'pathe';

import type { JianProcess } from '@scream-code/jian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testJian } from '../fixtures/test-jian';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('Session close vs. background task notifications', () => {
  it('does not let a task that terminals after close steer a ghost turn', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-ghost-gate',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const main = await session.createMain();
    const steerSpy = vi.spyOn(main.turn, 'steer');
    const deliveredSpy = vi.spyOn(main.background, 'markDeliveredNotification');

    const bash = controllableProcess();
    const taskId = main.background.register(bash.proc, 'sleep 300', 'long build');

    await session.close();

    // keepAliveOnExit defaults to true: the bash process itself survives the
    // close and its ledger entry stays live...
    expect(main.background.getTask(taskId)?.status).toBe('running');

    // ...and it reaches its natural terminal state AFTER the session is gone.
    bash.exit(0);
    await main.background.waitForTerminal(taskId);

    // fireTerminalCallbacks does not await the notification pipeline, so give
    // its async tail a beat before the negative assertions: without the gate
    // the steer lands well within it (this case is the fix's red-proof).
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No ghost turn: nothing steered, no turn active, notification not planted.
    expect(steerSpy).not.toHaveBeenCalled();
    expect(main.turn.hasActiveTurn).toBe(false);
    expect(JSON.stringify(main.context.data())).not.toContain(taskId);
    // And no delivery mark, or the reopen path below could never re-deliver.
    expect(deliveredSpy).not.toHaveBeenCalled();

    // The reopen path (`Agent.resume()` → `reconcile()`) is what delivers the
    // suppressed notification: a silent context append, no steer — and the
    // append writes the delivery mark, so a second reconcile cannot double it.
    await main.background.reconcile();
    const flatContext = JSON.stringify(main.context.data());
    expect(flatContext).toContain('<notification');
    expect(flatContext).toContain(taskId);
    expect(flatContext).toContain('long build');
    expect(steerSpy).not.toHaveBeenCalled();
    expect(deliveredSpy).toHaveBeenCalledTimes(1);

    await main.background.reconcile();
    expect(steerSpy).not.toHaveBeenCalled();
    expect(deliveredSpy).toHaveBeenCalledTimes(1);
  });

  it('latches an evicted subagent manager so its own tasks cannot steer after close', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-evicted-subagent',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await session.createMain();
    // A subagent whose run has already finished: the subagent host evicts it
    // from `session.agents` (see withChildTerminalRelease), yet a background
    // task it registered — a grandchild still running — keeps its manager
    // alive. Before the weak registry, `close()` walked only `session.agents`
    // and could no longer reach this manager.
    const { id: childId, agent: child } = await session.createAgent(
      { type: 'sub' },
      undefined,
      'main',
    );
    session.removeAgent(childId);
    expect(session.agents.has(childId)).toBe(false);

    // The spy replaces the implementation: a real steer on this unconfigured
    // test agent would try to launch a turn; what the case pins is that the
    // ghost-turn attempt never happens.
    const steerSpy = vi.spyOn(child.turn, 'steer').mockImplementation(() => null);
    const deliveredSpy = vi.spyOn(child.background, 'markDeliveredNotification');
    const bash = controllableProcess();
    const taskId = child.background.register(bash.proc, 'sleep 300', 'grandchild build');

    await session.close();

    // keepAliveOnExit defaults to true: the bash task is still running after
    // the close and only reaches its terminal state afterwards.
    expect(child.background.getTask(taskId)?.status).toBe('running');
    bash.exit(0);
    await child.background.waitForTerminal(taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No ghost turn for the evicted subagent's manager either: nothing
    // steered, no turn launched, and the notification was not marked
    // delivered (that mark is what would block the reopen re-delivery).
    expect(steerSpy).not.toHaveBeenCalled();
    expect(child.turn.hasActiveTurn).toBe(false);
    expect(deliveredSpy).not.toHaveBeenCalled();

    // The reopen path still works on this manager: reconcile appends the
    // suppressed notification silently and writes the delivery mark.
    await child.background.reconcile();
    const flatContext = JSON.stringify(child.context.data());
    expect(flatContext).toContain(taskId);
    expect(flatContext).toContain('grandchild build');
    expect(steerSpy).not.toHaveBeenCalled();
    expect(deliveredSpy).toHaveBeenCalledTimes(1);
  });

  it('stops agent-class tasks on close while keeping bash processes alive', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-agent-task-stop',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const main = await session.createMain();
    const steerSpy = vi.spyOn(main.turn, 'steer');

    // A background subagent run: a coroutine over a turn the close cancels, so
    // its completion promise can only settle through the abort callback.
    const aborted = vi.fn();
    const completion = new Promise<{ result: string }>((_resolve, reject) => {
      aborted.mockImplementation(() => {
        const error = new Error('subagent run aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const agentTaskId = main.background.registerAgentTask(completion, 'subagent run', {
      abort: () => aborted(),
    });

    const bash = controllableProcess();
    const bashTaskId = main.background.register(bash.proc, 'sleep 300', 'long build');

    await session.close();

    // The agent task is over: aborted, recorded as killed...
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(main.background.getTask(agentTaskId)?.status).toBe('killed');
    // ...and it did not notify the dead session on its way out.
    expect(steerSpy).not.toHaveBeenCalled();
    // The bash process is exactly what keepAliveOnExit still protects.
    expect(main.background.getTask(bashTaskId)?.status).toBe('running');
    expect(bash.kill).not.toHaveBeenCalled();
  });

  it('keeps the keepAlive=false contract: close stops bash processes too', async () => {
    vi.stubEnv(BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV, 'false');
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-keepalive-off',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const main = await session.createMain();

    let abort: () => void = () => {};
    const agentTaskId = main.background.registerAgentTask(
      new Promise<{ result: string }>((_resolve, reject) => {
        abort = () => {
          const error = new Error('subagent run aborted');
          error.name = 'AbortError';
          reject(error);
        };
      }),
      'subagent run',
      { abort: () => abort() },
    );
    const bash = controllableProcess();
    const bashTaskId = main.background.register(bash.proc, 'sleep 300', 'long build');

    await session.close();

    // The keepAlive=false path stays a blanket stopAll: both kinds die.
    expect(main.background.getTask(agentTaskId)?.status).toBe('killed');
    expect(main.background.getTask(bashTaskId)?.status).toBe('killed');
    expect(bash.kill).toHaveBeenCalledTimes(1);
  });
});

async function sessionFixture(): Promise<{
  readonly sessionDir: string;
  readonly workDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-bg-close-gate-'));
  tempDirs.push(dir);
  const workDir = join(dir, 'work');
  const sessionDir = join(dir, 'session');
  return { sessionDir, workDir };
}

/** Matches the private constant in `src/session/index.ts`. */
const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'SCREAM_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';

/**
 * A bash-backed task whose process exits only when the test (or a `kill`) says
 * so — the handle a case needs to drive a task terminal AFTER `close()`.
 */
function controllableProcess(): {
  readonly proc: JianProcess;
  readonly exit: (code: number) => void;
  readonly kill: ReturnType<typeof vi.fn>;
} {
  let settleWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    settleWait = resolve;
  });
  let exitCode: number | null = null;
  const settle = (code: number): void => {
    if (exitCode !== null) return;
    exitCode = code;
    settleWait(code);
  };
  const kill = vi.fn(async () => {
    settle(143);
  });
  return {
    proc: {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 4242,
      get exitCode(): number | null {
        return exitCode;
      },
      wait: () => waitPromise,
      kill,
    } as unknown as JianProcess,
    exit: settle,
    kill,
  };
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
