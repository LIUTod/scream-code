import { describe, expect, it } from 'vitest';

import { DapAbortedError, DapClient } from '../../src/dap/client';
import { testJian } from '../fixtures/test-jian';
import { fakeDapCommand, type FakeDapScenario } from './fake-dap-server';

/** Real child process, real stdio framing; only the protocol peer is scripted. */
function createClient(scenario: FakeDapScenario): DapClient {
  return new DapClient({
    jian: testJian,
    command: fakeDapCommand(scenario),
    workspaceRoot: process.cwd(),
    requestTimeoutMs: 5_000,
  });
}

async function initialized(scenario: FakeDapScenario): Promise<DapClient> {
  const client = createClient(scenario);
  await client.start();
  await client.initialize();
  return client;
}

const LAUNCH = {
  python: ['python3'],
  program: '/tmp/fake_program.py',
  args: ['--flag'],
  cwd: '/tmp',
  stopOnEntry: true,
} as const;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

describe('DapClient handshake', () => {
  it('initializes, launches and reaches a stop after configurationDone', async () => {
    const client = await initialized('entry');
    try {
      client.launch(LAUNCH);
      await client.configurationDone();

      const event = await client.waitForEvent(['stopped', 'terminated'], 5_000);
      expect(event?.event).toBe('stopped');
      expect(event?.body['reason']).toBe('entry');
      expect(event?.body['threadId']).toBe(1);
    } finally {
      await client.dispose();
    }
  });

  it('maps setBreakpoints results to verified/unverified per requested line', async () => {
    const client = await initialized('entry');
    try {
      client.launch(LAUNCH);
      const breakpoints = await client.setBreakpoints('/tmp/fake_program.py', [3, 12]);
      await client.configurationDone();

      expect(breakpoints).toEqual([
        { verified: true, line: 3, message: undefined },
        { verified: false, line: 12, message: 'no executable code at line 12' },
      ]);
    } finally {
      await client.dispose();
    }
  });

  it('attaches to a listening debuggee and reports the stop', async () => {
    const client = await initialized('entry');
    try {
      await client.attach(5678);
      await client.configurationDone();
      const event = await client.waitForEvent(['stopped'], 5_000);
      expect(event?.body['reason']).toBe('entry');
    } finally {
      await client.dispose();
    }
  });

  it('surfaces a failed launch from configurationDone', async () => {
    const client = await initialized('launch-error');
    try {
      client.launch(LAUNCH);
      await expect(client.configurationDone()).rejects.toThrow('launch failed: no such program');
    } finally {
      await client.dispose();
    }
  });
});

describe('DapClient inspection', () => {
  it('walks stackTrace → scopes → variables', async () => {
    const client = await initialized('entry');
    try {
      client.launch(LAUNCH);
      await client.configurationDone();
      await client.waitForEvent(['stopped'], 5_000);

      const frames = await client.stackTrace(1);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({
        id: 1,
        name: 'main',
        line: 3,
        sourcePath: '/tmp/fake_program.py',
      });

      const scopes = await client.scopes(frames[0]!.id);
      expect(scopes).toEqual([
        { name: 'Locals', variablesReference: 1000, expensive: false },
        { name: 'Globals', variablesReference: 1001, expensive: true },
      ]);

      const variables = await client.variables(1000);
      expect(variables[0]).toMatchObject({ name: 'x', value: '42', type: 'int' });
      expect(variables[2]?.variablesReference).toBe(1002);
      const nested = await client.variables(1002);
      expect(nested[0]).toMatchObject({ name: '0', value: '1' });
    } finally {
      await client.dispose();
    }
  });

  it('evaluates expressions and reports adapter errors as rejections', async () => {
    const client = await initialized('entry');
    try {
      client.launch(LAUNCH);
      await client.configurationDone();
      await client.waitForEvent(['stopped'], 5_000);

      await expect(client.evaluate('1 + 41', 1)).resolves.toEqual({ result: '42', type: 'int' });
      await expect(client.evaluate('boom')).rejects.toThrow("NameError: name 'boom' is not defined");
    } finally {
      await client.dispose();
    }
  });

  it('resolves undefined when continue produces no stop within the wait budget', async () => {
    const client = await initialized('running');
    try {
      client.launch(LAUNCH);
      await client.configurationDone();
      await client.waitForEvent(['stopped'], 5_000);

      await expect(client.continue_(1)).resolves.toEqual({ allThreadsContinued: true });
      const next = await client.waitForEvent(['stopped', 'terminated'], 200);
      expect(next).toBeUndefined();
    } finally {
      await client.dispose();
    }
  });

  it('reports termination with the debuggee exit code', async () => {
    const client = await initialized('terminate');
    try {
      let exitCode: number | undefined;
      client.onEvent((event) => {
        if (event.event === 'exited' && typeof event.body['exitCode'] === 'number') {
          exitCode = event.body['exitCode'];
        }
      });
      client.launch(LAUNCH);
      await client.configurationDone();
      const event = await client.waitForEvent(['terminated'], 5_000);
      expect(event?.event).toBe('terminated');
      expect(exitCode).toBe(0);
    } finally {
      await client.dispose();
    }
  });

  it('rejects a wait when the caller aborts', async () => {
    const client = await initialized('running');
    try {
      const controller = new AbortController();
      const waiting = client.waitForEvent(['stopped'], 5_000, controller.signal);
      controller.abort();
      await expect(waiting).rejects.toBeInstanceOf(DapAbortedError);
    } finally {
      await client.dispose();
    }
  });
});

describe('DapClient teardown', () => {
  it('disconnect kills the spawned adapter process', async () => {
    const client = await initialized('entry');
    const pid = client.pid;
    expect(pid).toBeTypeOf('number');
    expect(isAlive(pid!)).toBe(true);

    await client.disconnect();

    expect(client.pid).toBeUndefined();
    expect(await waitUntilDead(pid!)).toBe(true);
    // Idempotent: a second close is a no-op, not an error.
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  it('rejects requests after the adapter is gone', async () => {
    const client = await initialized('entry');
    await client.dispose();
    await expect(client.stackTrace(1)).rejects.toThrow('Debug adapter is not running.');
  });
});
