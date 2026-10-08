/**
 * Session close-out checklist.
 *
 * `Session.disposables` is the mechanism that keeps `close()` complete, and it
 * is checked from both directions here: the names snapshot freezes the full
 * cleanup list so a dropped, renamed or invented registration fails instead of
 * leaking, while the release case pairs each collaborator the session actually
 * holds (log sink, mcp, cron, bus, ...) with the registration that owns it and
 * observes exactly one release per collaborator through `close()`. The cases
 * below also observe two cleanups that used to be pure memory leaks — the shell
 * tool's pending-task map and the subagent message bus.
 *
 * The pending-task map is process-wide while sessions are not, so its teardown
 * cases also pin the ownership contract: what an agent's Bash tool parks is
 * stamped with the session id, and a close sweeps exactly that owner.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, type Writable } from 'node:stream';
import { join } from 'pathe';

import type { JianProcess } from '@scream-code/jian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_OS_ENV, testJian } from '../fixtures/test-jian';
import { testAgent } from '../agent/harness/agent';
import { createFakeJian } from '../tools/fixtures/fake-jian';
import { executeTool } from '../tools/fixtures/execute-tool';
import { __resetRootLoggerForTest, getRootLogger, resolveGlobalLogPath } from '../../src/logging/logger';
import type { SessionLogHandle } from '../../src/logging/types';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { buildSubagentMessage } from '../../src/session/subagent-messages';
import { BashTool } from '../../src/tools/builtin/shell/bash';
import {
  createBackgroundTask,
  getPendingBackgroundCount,
  killAllPendingBackgroundTasks,
  stopAllPendingBackgroundTasks,
} from '../../src/tools/builtin/shell/background-tasks';

/**
 * The close-out checklist every session registers at construction, in
 * registration order. A new teardown step must appear here — making the
 * omission a test failure is the point of the snapshot.
 *
 * Release order is the reverse of this list, which is what makes the order
 * load-bearing: `log` sitting first means the session log sink is still open
 * while every other step reports its teardown and closes last, and
 * `session-finalize` (metadata flush + SessionEnd hooks, registered second)
 * runs with the sink open while still after every resource teardown above it.
 */
const EXPECTED_DISPOSABLES = [
  'log',
  'session-finalize',
  'background-pending',
  'cron',
  'rlm',
  'lsp',
  'mcp',
  'message-bus',
] as const;

const tempDirs: string[] = [];

afterEach(async () => {
  // Module-level registry shared by every case: the process-wide sweep is the
  // only reset that can clear owners this file does not own.
  killAllPendingBackgroundTasks();
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

  it('writes through the session log sink from the finalize step', async () => {
    const logHome = await mkdtemp(join(tmpdir(), 'scream-session-finalize-log-'));
    tempDirs.push(logHome);
    await getRootLogger().configure({
      level: 'info',
      globalLogPath: resolveGlobalLogPath(logHome),
      globalMaxBytes: 1_000_000,
      globalFiles: 1,
      sessionMaxBytes: 500_000,
      sessionFiles: 1,
    });
    try {
      const { sessionDir, workDir } = await sessionFixture();
      // The finalize step is the metadata flush. `close()` used to run it AFTER
      // `disposeAll()` had closed the sink, and a record emitted then is routed
      // to the GLOBAL log instead of the session's — so logging from inside the
      // step observes the order directly: this marker only reaches the session
      // file while the sink is still open, which is also why it must land before
      // the SessionEnd hooks that follow it.
      class FinalizeMarkerSession extends Session {
        override async flushMetadata(): Promise<void> {
          this.log.info('session-finalize marker');
          await super.flushMetadata();
        }
      }
      const session = new FinalizeMarkerSession({
        jian: testJian.withCwd(workDir),
        id: 'session-finalize-sink',
        homedir: sessionDir,
        rpc: createSessionRpc(),
        skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      });

      await session.close();

      // A sink that closed before the step ran writes no session file at all,
      // so the missing-file case is the same failure as a missing marker.
      const text = await readFile(join(sessionDir, 'logs', 'scream-code.log'), 'utf-8').catch(
        () => '',
      );
      expect(text).toContain('session-finalize marker');
    } finally {
      await __resetRootLoggerForTest();
    }
  });

  it('releases each collaborator exactly once through its own registration', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-collaborator-release',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const { agent } = await session.createAgent({ type: 'main' });

    // The positive direction of the snapshot above, in behavioural form: every
    // teardown-relevant collaborator the session holds is paired with the
    // registration that owns it, and closing the session must release each one
    // exactly once. A collaborator nobody registered is never released (0
    // calls) and one registered twice is released twice (2 calls) — neither is
    // visible in a name list, which only knows the names it was told about.
    vi.stubEnv(BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV, 'false');
    try {
      const releases = [
        { name: 'log', spy: vi.spyOn(logHandleOf(session), 'close') },
        { name: 'session-finalize', spy: vi.spyOn(session, 'flushMetadata') },
        { name: 'background-pending', spy: vi.spyOn(agent.background, 'stopAll') },
        { name: 'cron', spy: vi.spyOn(agent.cron!, 'stop') },
        { name: 'rlm', spy: vi.spyOn(agent, 'disposeRlm') },
        { name: 'lsp', spy: vi.spyOn(agent.tools, 'disposeLsp') },
        { name: 'mcp', spy: vi.spyOn(session.mcp, 'shutdown') },
        { name: 'message-bus', spy: vi.spyOn(session.subagentMessages, 'clear') },
      ];
      for (const { name } of releases) {
        expect(session.disposables.names().filter((entry) => entry === name), name).toHaveLength(1);
      }

      await session.close();

      for (const { name, spy } of releases) {
        expect(spy, `${name} release`).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.unstubAllEnvs();
    }
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
    // The owner key is the session's own id — the same value its agents stamp
    // on what their Bash tools park (see the scoping case below).
    createBackgroundTask('sleep 60', new Promise(() => {}), {
      kill,
      pid: 4242,
      ownerId: 'session-close-pending-sweep',
    });
    expect(getPendingBackgroundCount()).toBe(1);

    await session.close();

    // Timed-out commands parked in the background must not outlive the
    // session: the sweep kills them and empties the registry entry.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(getPendingBackgroundCount()).toBe(0);
  });

  it('sweeps only its own parked commands, never another session ones', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-scoped',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    // The key the sweep uses is the id stamped on every agent this session
    // creates, which is where its Bash tools take the owner they park under.
    const { agent } = await session.createAgent({ type: 'main' });
    expect(agent.sessionId).toBe('session-close-scoped');

    const ownKill = vi.fn(async () => {});
    const foreignKill = vi.fn(async () => {});
    createBackgroundTask('own-build', new Promise(() => {}), {
      kill: ownKill,
      pid: 5001,
      ownerId: 'session-close-scoped',
    });
    createBackgroundTask('foreign-build', new Promise(() => {}), {
      kill: foreignKill,
      pid: 5002,
      ownerId: 'session-other',
    });
    expect(getPendingBackgroundCount()).toBe(2);

    await session.close();

    // Closing this session reclaims its own parked command...
    expect(ownKill).toHaveBeenCalledTimes(1);
    // ...and leaves the other session's running: the registry is process-wide,
    // so an unscoped sweep here would execute another session's command.
    expect(foreignKill).not.toHaveBeenCalled();
    expect(getPendingBackgroundCount()).toBe(1);
  });

  it('leaves an identified session alone when an id-less session closes', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const identified = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-identified',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    // SessionOptions.id is optional, so the SDK can build a session that stamps
    // no owner on anything its agents park.
    const anonymous = new Session({
      jian: testJian.withCwd(workDir),
      homedir: join(sessionDir, 'anonymous'),
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    expect(anonymous.options.id).toBeUndefined();

    const identifiedKill = vi.fn(async () => {});
    const anonymousKill = vi.fn(async () => {});
    createBackgroundTask('identified-build', new Promise(() => {}), {
      kill: identifiedKill,
      pid: 6001,
      ownerId: 'session-identified',
    });
    createBackgroundTask('anonymous-build', new Promise(() => {}), {
      kill: anonymousKill,
      pid: 6002,
    });
    expect(getPendingBackgroundCount()).toBe(2);

    await anonymous.close();

    // The id-less session sweeps what ITS agents parked — the owner-less
    // tasks...
    expect(anonymousKill).toHaveBeenCalledTimes(1);
    // ...and stops there: "no id" must not read as "every owner", or this
    // close would execute a command the identified session still owns.
    expect(identifiedKill).not.toHaveBeenCalled();
    expect(getPendingBackgroundCount()).toBe(1);

    await identified.close();
    expect(identifiedKill).toHaveBeenCalledTimes(1);
    expect(getPendingBackgroundCount()).toBe(0);
  });

  it('parks a timed-out command under the session its agent belongs to', async () => {
    const ctx = testAgent({
      sessionId: 'session-parks-own',
      jian: createFakeJian({
        execWithEnv: vi.fn().mockResolvedValue(neverExitingProcess()),
        osEnv: TEST_OS_ENV,
      }),
    });
    ctx.configure();
    const bash = ctx.agent.tools.getBuiltinTool('Bash') as BashTool | undefined;
    expect(bash).toBeDefined();

    // A command that outlives its timeout is parked module-wide, so the tool
    // has to stamp the owner it parks under; without it no session teardown
    // could ever reclaim the command.
    const result = await executeTool(bash!, {
      turnId: '0',
      toolCallId: 'call_bash',
      args: { command: 'sleep 60', timeout: 0.01 },
      signal: new AbortController().signal,
    });
    expect(result.output).toContain('still running in the background');
    expect(getPendingBackgroundCount()).toBe(1);

    stopAllPendingBackgroundTasks('session-elsewhere');
    expect(getPendingBackgroundCount()).toBe(1);

    stopAllPendingBackgroundTasks('session-parks-own');
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

/** Matches the private constant in `src/session/index.ts` (see disposables). */
const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'SCREAM_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';

/**
 * The session log sink handle the session owns. Private on `Session` — the
 * collaborator the `log` registration exists to release, so the release test
 * has to reach it the way the registration does.
 */
function logHandleOf(session: Session): SessionLogHandle {
  const handle = (session as unknown as { logHandle?: SessionLogHandle }).logHandle;
  if (handle === undefined) throw new Error('session fixture must be created with an id');
  return handle;
}

/** A process that never exits: the Bash tool times out and parks the command. */
function neverExitingProcess(): JianProcess {
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    exitCode: null,
    wait: vi.fn(async () => new Promise<number>(() => {})),
    kill: vi.fn(async () => {}),
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
