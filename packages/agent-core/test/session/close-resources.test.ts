/**
 * Session close-out checklist.
 *
 * `Session.disposables` is the mechanism that keeps `close()` complete, and it
 * is checked from both directions here: the names snapshot freezes every
 * registered step — a dropped, renamed or invented registration fails instead
 * of leaking — while the release case pairs the collaborators this session
 * holds today (log sink, mcp, cron, bus, ...) with the registration that owns
 * each one and observes exactly one release per collaborator through `close()`.
 * The cases below also observe two cleanups that used to be pure memory leaks —
 * the shell tool's parked commands (per-agent background tasks today) and the
 * subagent message bus.
 *
 * Both checks are bounded by their inputs, and stating that is the point: the
 * registry enumerates the steps that registered, not the resources that exist,
 * so a resource the session acquires without a registration — the proverbial
 * ninth collaborator — fails neither check; and the release list is hand-kept,
 * so a freshly registered step is covered only once its entry is added there
 * (the snapshot flags the new registration, not the missing release case). No
 * field in the session object graph is marked as needing teardown, so telling
 * "must be released" from "plain field" stays a code-review job; what is
 * machine-checked is every registration this checklist contains and every
 * release the listed collaborators get.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, type Writable } from 'node:stream';
import { join } from 'pathe';

import type { JianProcess } from '@scream-code/jian';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

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

/**
 * The close-out checklist every session registers at construction, in
 * registration order. A registered step must appear here — the snapshot fails
 * until it does — and that is its whole reach: it freezes registrations, so a
 * resource that should have one but never got registered is invisible to it
 * (the file header states the shared blind spot).
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

  it('still fires SessionEnd when the metadata flush in the finalize step rejects', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-finalize-flush-fails',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const { agent } = await session.createAgent({ type: 'main' });

    // A real flush failure, not a mocked step: the per-agent records flush is
    // what `flushMetadata()` awaits last, and its rejection is the one that
    // must not unwind the step before the SessionEnd trigger runs.
    const flushError = new Error('records flush failed');
    const flushSpy = vi.spyOn(agent.records, 'flush').mockRejectedValue(flushError);
    const triggerSpy = vi.spyOn(session.hookEngine, 'trigger');

    const closeError = await session.close().catch((error: unknown) => error);

    // The trigger runs from a `finally`: a rejected flush may not skip it...
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(triggerSpy).toHaveBeenCalledWith('SessionEnd', {
      matcherValue: 'exit',
      inputData: { reason: 'exit' },
    });
    // ...and the rejection still surfaces through the close() AggregateError.
    expect(closeError).toBeInstanceOf(AggregateError);
    expect((closeError as AggregateError).errors).toContain(flushError);
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

    // The behavioural half of the snapshot above: each collaborator the
    // checklist knows about today is paired with the registration that owns it,
    // and closing the session must release each one exactly once. Wiring drift
    // among these eight is a failure — a registration dropped or turned into a
    // no-op leaves its spy at 0 calls, a collaborator released by two steps
    // reaches 2 — and the name filter above keeps each listed collaborator
    // matched to exactly one registration. The list itself is hand-kept,
    // though: a ninth collaborator grown without a registration has no spy
    // here to notice it, and a new registration is covered only once its entry
    // is added below. That residue needs review, not this case (see the file
    // header).
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

  it('stops the parked commands of its own agents on close', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-pending-sweep',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const { agent } = await session.createAgent({ type: 'main' });
    const { completion, kill } = parkableCommand();
    // A timed-out foreground command parked by this session's agent lives in
    // that agent's own background manager.
    const taskId = agent.background.parkForegroundProcess(
      completion,
      'sleep 60',
      'parked on close',
      { kill, pid: 4242 },
    );
    expect(agent.background.getTask(taskId)?.status).toBe('running');

    // keepAliveOnExit=false is the exit policy that reclaims parked commands;
    // the default keepAlive leaves bash processes running on purpose.
    vi.stubEnv(BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV, 'false');
    try {
      await session.close();
    } finally {
      vi.unstubAllEnvs();
    }

    // Timed-out commands parked in the background must not outlive the
    // session: the sweep kills them and the ledger records the kill.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(agent.background.getTask(taskId)?.status).toBe('killed');
  });

  it('stops only its own parked commands, never another session ones', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-close-scoped',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const otherSession = new Session({
      jian: testJian.withCwd(workDir),
      id: 'session-other',
      homedir: join(sessionDir, 'other'),
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const { agent } = await session.createAgent({ type: 'main' });
    const { agent: otherAgent } = await otherSession.createAgent({ type: 'main' });
    expect(agent.sessionId).toBe('session-close-scoped');

    const own = parkableCommand();
    const foreign = parkableCommand();
    const ownId = agent.background.parkForegroundProcess(
      own.completion,
      'own-build',
      'own',
      { kill: own.kill, pid: 5001 },
    );
    const foreignId = otherAgent.background.parkForegroundProcess(
      foreign.completion,
      'foreign-build',
      'foreign',
      { kill: foreign.kill, pid: 5002 },
    );

    vi.stubEnv(BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV, 'false');
    try {
      await session.close();
    } finally {
      vi.unstubAllEnvs();
    }

    // Closing this session reclaims its own parked command...
    expect(own.kill).toHaveBeenCalledTimes(1);
    expect(agent.background.getTask(ownId)?.status).toBe('killed');
    // ...and leaves the other session's running: the task belongs to the
    // other session's own agent manager, so an unscoped sweep is impossible.
    expect(foreign.kill).not.toHaveBeenCalled();
    expect(otherAgent.background.getTask(foreignId)?.status).toBe('running');

    vi.stubEnv(BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV, 'false');
    try {
      await otherSession.close();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(foreign.kill).toHaveBeenCalledTimes(1);
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
    // SessionOptions.id is optional, so the SDK can build a session that
    // identifies no owner at all.
    const anonymous = new Session({
      jian: testJian.withCwd(workDir),
      homedir: join(sessionDir, 'anonymous'),
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    expect(anonymous.options.id).toBeUndefined();
    const { agent: anonymousAgent } = await anonymous.createAgent({ type: 'main' });
    const { agent: identifiedAgent } = await identified.createAgent({ type: 'main' });

    const anonymousCmd = parkableCommand();
    const identifiedCmd = parkableCommand();
    const anonymousId = anonymousAgent.background.parkForegroundProcess(
      anonymousCmd.completion,
      'anonymous-build',
      'anonymous',
      { kill: anonymousCmd.kill, pid: 6002 },
    );
    const identifiedId = identifiedAgent.background.parkForegroundProcess(
      identifiedCmd.completion,
      'identified-build',
      'identified',
      { kill: identifiedCmd.kill, pid: 6001 },
    );

    vi.stubEnv(BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV, 'false');
    try {
      await anonymous.close();
    } finally {
      vi.unstubAllEnvs();
    }

    // The id-less session sweeps what ITS agents parked...
    expect(anonymousCmd.kill).toHaveBeenCalledTimes(1);
    expect(anonymousAgent.background.getTask(anonymousId)?.status).toBe('killed');
    // ...and stops there: the absence of a session id must not read as "every
    // owner", or this close would execute the identified session's command.
    expect(identifiedCmd.kill).not.toHaveBeenCalled();
    expect(identifiedAgent.background.getTask(identifiedId)?.status).toBe('running');

    vi.stubEnv(BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV, 'false');
    try {
      await identified.close();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(identifiedCmd.kill).toHaveBeenCalledTimes(1);
  });

  it('parks a timed-out command in its own agent manager, not another agent one', async () => {
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

    // A command that outlives its timeout is parked as a task of the agent
    // that ran it — addressable by TaskList/TaskOutput/TaskStop and reclaimed
    // by that agent's session-exit policy — instead of in a process-wide
    // registry every other agent could read from.
    const result = await executeTool(bash!, {
      turnId: '0',
      toolCallId: 'call_bash',
      args: { command: 'sleep 60', timeout: 0.01 },
      signal: new AbortController().signal,
    });
    expect(result.output).toContain('still running in the background');
    const parked = ctx.agent.background.list();
    expect(parked).toHaveLength(1);
    expect(parked[0]?.status).toBe('running');
    expect(result.output).toContain(parked[0]?.taskId);

    // Another agent's ledger holds nothing of this command: ownership is the
    // manager, so no cross-agent leak is possible at all.
    const other = testAgent({ sessionId: 'session-elsewhere' });
    other.configure();
    expect(other.agent.background.list()).toEqual([]);
    expect(other.agent.background.getTask((parked[0]?.taskId ?? ''))).toBeUndefined();
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

/**
 * A parked command whose completion settles when its kill handle runs — the
 * way a real process behaves, so a stop finishes inside the grace window
 * instead of waiting it out.
 */
function parkableCommand(): {
  readonly completion: Promise<{ exitCode: number }>;
  readonly kill: Mock<() => Promise<void>>;
} {
  let resolveCompletion: (value: { exitCode: number }) => void = () => {};
  const completion = new Promise<{ exitCode: number }>((resolve) => {
    resolveCompletion = resolve;
  });
  const kill = vi.fn<() => Promise<void>>(async () => {
    resolveCompletion({ exitCode: 143 });
  });
  return { completion, kill };
}

/**
 * A process that never exits: the Bash tool times out and parks the command.
 */
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
