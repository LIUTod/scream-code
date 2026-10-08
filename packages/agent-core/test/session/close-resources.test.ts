/**
 * Session close-out checklist.
 *
 * `Session.disposables` is the mechanism that keeps `close()` complete: the
 * names snapshot freezes the full cleanup list so a dropped or renamed
 * registration fails here instead of leaking, and the cases below observe two
 * cleanups that used to be pure memory leaks — the shell tool's pending-task
 * map and the subagent message bus.
 *
 * The pending-task map is process-wide while sessions are not, so its teardown
 * cases also pin the ownership contract: what an agent's Bash tool parks is
 * stamped with the session id, and a close sweeps exactly that owner.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, type Writable } from 'node:stream';
import { join } from 'pathe';

import type { JianProcess } from '@scream-code/jian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_OS_ENV, testJian } from '../fixtures/test-jian';
import { testAgent } from '../agent/harness/agent';
import { createFakeJian } from '../tools/fixtures/fake-jian';
import { executeTool } from '../tools/fixtures/execute-tool';
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
 * omission a test failure is the point of the snapshot. Release order is the
 * reverse of this list, so `log` sitting first means the session log sink is
 * still open while every other resource (LSP, MCP, parked commands) reports
 * its teardown, and the sink itself is closed last.
 */
const EXPECTED_DISPOSABLES = [
  'log',
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
