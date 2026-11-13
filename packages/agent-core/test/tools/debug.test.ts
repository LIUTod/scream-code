/**
 * DebugTool — operation dispatch, output shape, session lifecycle and the
 * portal wiring around it. The adapter is the scripted stdio fake from
 * `test/dap/fake-dap-server.ts` (a real child process), so these tests cover
 * framing, request/response correlation and teardown, not a mock API.
 */

import { describe, expect, it } from 'vitest';

import { resolveDebugpy } from '../../src/dap/adapter';
import type { DebugInput } from '../../src/tools/builtin/debug';
import { DebugTool } from '../../src/tools/builtin/debug';
import {
  DEFAULT_DEFERRED_GROUP_NAMES,
  getDeferredGroup,
} from '../../src/tools/builtin/deferred-tools';
import { testAgent } from '../agent/harness/agent';
import { fakeDapCommand, type FakeDapScenario } from '../dap/fake-dap-server';
import { testJian } from '../fixtures/test-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

/** Tool backed by the scripted adapter for `scenario`. */
function createTool(scenario: FakeDapScenario): DebugTool {
  const [, , source] = fakeDapCommand(scenario);
  return new DebugTool(testJian, '/tmp', undefined, {
    resolveAdapter: async () => ({
      ok: true,
      command: ['node'],
      args: ['-e', source!],
      python: ['python3'],
    }),
  });
}

function run(tool: DebugTool, args: DebugInput) {
  return executeTool(tool, { turnId: '0', toolCallId: 'call_debug', args, signal });
}

/** Text output of a result; these assertions never expect structured parts. */
function textOf(result: { readonly output: string | readonly unknown[] }): string {
  if (typeof result.output !== 'string') throw new Error('expected text output');
  return result.output;
}

async function launched(scenario: FakeDapScenario = 'entry'): Promise<DebugTool> {
  const tool = createTool(scenario);
  const result = await run(tool, { operation: 'launch', program: '/tmp/fake_program.py' });
  expect(result.isError).toBe(false);
  return tool;
}

describe('DebugTool launch', () => {
  it('launches with breakpoints and reports the entry stop', async () => {
    const tool = createTool('entry');
    const result = await run(tool, {
      operation: 'launch',
      program: '/tmp/fake_program.py',
      breakpoints: [{ path: '/tmp/fake_program.py', lines: [3, 12] }],
    });
    const output = textOf(result);

    expect(result.isError).toBe(false);
    expect(output).toContain('status: stopped');
    expect(output).toContain('reason: entry');
    expect(output).toContain('thread: 1');
    expect(output).toContain('frame: #0 main at /tmp/fake_program.py:3 (id 1)');
    expect(output).toContain('/tmp/fake_program.py:3 verified');
    expect(output).toContain(
      '/tmp/fake_program.py:12 unverified — no executable code at line 12',
    );
    await run(tool, { operation: 'disconnect' });
  });

  it('requires a program and refuses a second concurrent session', async () => {
    const tool = createTool('entry');
    const missing = await run(tool, { operation: 'launch' });
    expect(missing.isError).toBe(true);
    expect(missing.output).toBe("'launch' requires 'program' (the Python file to debug).");

    await run(tool, { operation: 'launch', program: '/tmp/fake_program.py' });
    const again = await run(tool, { operation: 'launch', program: '/tmp/fake_program.py' });
    expect(again.isError).toBe(true);
    expect(again.output).toContain('already open');
    await run(tool, { operation: 'disconnect' });
  });

  it('reports termination, then has no session left to inspect', async () => {
    const tool = createTool('terminate');
    const result = await run(tool, { operation: 'launch', program: '/tmp/fake_program.py' });
    expect(result.output).toContain('status: terminated (exit code 0)');

    const after = await run(tool, { operation: 'stack_trace' });
    expect(after.isError).toBe(true);
    expect(after.output).toBe('No debug session is open; call launch or attach first.');
  });

  it('attaches to a listening debuggee and sets breakpoints', async () => {
    const tool = createTool('entry');
    const result = await run(tool, {
      operation: 'attach',
      port: 5678,
      breakpoints: [{ path: '/tmp/fake_program.py', lines: [4] }],
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('status: stopped');
    expect(result.output).toContain('/tmp/fake_program.py:4 verified');
    await run(tool, { operation: 'disconnect' });
  });
});

describe('DebugTool inspection', () => {
  it('walks the stop → frames → scopes → variables → evaluate chain', async () => {
    const tool = await launched();
    try {
      const trace = await run(tool, { operation: 'stack_trace' });
      expect(trace.output).toContain('Thread 1 stack (2 frame(s)):');
      expect(trace.output).toContain('#0 main at /tmp/fake_program.py:3 (id 1)');
      expect(trace.output).toContain('#1 helper at /tmp/fake_program.py:9 (id 2)');

      const scopes = await run(tool, { operation: 'scopes' });
      expect(scopes.output).toContain('Scopes of frame 1:');
      expect(scopes.output).toContain('Locals — variables_reference 1000');
      expect(scopes.output).toContain('Globals — variables_reference 1001 (expensive)');

      const variables = await run(tool, { operation: 'variables', variables_reference: 1000 });
      expect(variables.output).toContain('Variables (3):');
      expect(variables.output).toContain('x = 42 (int)');
      expect(variables.output).toContain("items = [1] (list) (ref 1002)");

      const nested = await run(tool, { operation: 'variables', variables_reference: 1002 });
      expect(nested.output).toContain('0 = 1 (int)');

      const evaluated = await run(tool, { operation: 'evaluate', expression: '1 + 41' });
      expect(evaluated.output).toBe('42 (int)');
    } finally {
      await run(tool, { operation: 'disconnect' });
    }
  });

  it('adds breakpoints mid-session and reports verification per line', async () => {
    const tool = await launched();
    try {
      const result = await run(tool, {
        operation: 'set_breakpoints',
        path: 'fake_program.py',
        lines: [5, 40],
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain('Breakpoints in /tmp/fake_program.py:');
      expect(result.output).toContain('/tmp/fake_program.py:5 verified');
      expect(result.output).toContain(
        '/tmp/fake_program.py:40 unverified — no executable code at line 40',
      );
    } finally {
      await run(tool, { operation: 'disconnect' });
    }
  });

  it('continues to the next breakpoint', async () => {
    const tool = await launched();
    try {
      const result = await run(tool, { operation: 'continue', timeout_seconds: 5 });
      expect(result.isError).toBe(false);
      expect(result.output).toContain('status: stopped');
      expect(result.output).toContain('reason: breakpoint');
    } finally {
      await run(tool, { operation: 'disconnect' });
    }
  });

  it('reports a still-running program after a continue timeout', async () => {
    const tool = await launched('running');
    try {
      const result = await run(tool, { operation: 'continue', timeout_seconds: 1 });
      expect(result.isError).toBe(false);
      expect(result.output).toContain('status: running');
      expect(result.output).toContain('No stop event within 1s');
    } finally {
      await run(tool, { operation: 'disconnect' });
    }
  });

  it('surfaces adapter errors and closes the session on disconnect', async () => {
    const tool = await launched();
    const failed = await run(tool, { operation: 'evaluate', expression: 'boom' });
    expect(failed.isError).toBe(true);
    expect(failed.output).toContain("Debug evaluate failed: NameError: name 'boom' is not defined");

    const closed = await run(tool, { operation: 'disconnect' });
    expect(closed.output).toBe(
      'Debug session closed; the adapter and the debuggee were terminated.',
    );
    const again = await run(tool, { operation: 'disconnect' });
    expect(again.output).toBe('No debug session is open.');
  });
});

describe('DebugTool requirements and permissions', () => {
  it('reports a missing debugpy with the install instruction', async () => {
    const tool = new DebugTool(testJian, '/tmp', undefined, {
      resolveAdapter: (jian) => resolveDebugpy(jian, 'scream-code-no-such-python-binary'),
    });
    const result = await run(tool, { operation: 'launch', program: '/tmp/fake_program.py' });
    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      'debugpy is not installed. Install it with: python3 -m pip install debugpy',
    );
  });

  it('advertises every operation and a closed parameter schema', () => {
    const tool = createTool('entry');
    const parameters = tool.parameters as {
      required?: string[];
      additionalProperties?: boolean;
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(parameters.required).toEqual(['operation']);
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties?.['operation']?.enum).toEqual([
      'launch',
      'attach',
      'set_breakpoints',
      'continue',
      'stack_trace',
      'scopes',
      'variables',
      'evaluate',
      'disconnect',
    ]);
    expect(tool.description).toContain('Debug a Python program');
  });

  it('declares an exclusive process-tree access and a Bash-style approval rule', () => {
    const tool = createTool('entry');
    const execution = tool.resolveExecution({ operation: 'launch', program: '/tmp/prog.py' });
    expect(execution.isError).toBeUndefined();
    if (execution.isError === true) return;
    expect(execution.accesses).toEqual([{ kind: 'all' }]);
    expect(execution.approvalRule).toBe('Debug(launch /tmp/prog.py)');
    expect(execution.description).toBe('Debugging: launch /tmp/prog.py');
  });
});

describe('DebugTool portal wiring', () => {
  it('advertises the debug group but keeps it out of the default tool table', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.applyDefaultProfile();
    const tools = ctx.agent.tools;

    expect(DEFAULT_DEFERRED_GROUP_NAMES).toContain('debug');
    expect(getDeferredGroup('debug')?.toolNames).toEqual(['Debug']);
    const portal = tools.getBuiltinTool('DiscoverTools');
    expect(portal?.description).toContain('debug (Debug)');
    expect(tools.getBuiltinTool('Debug')).toBeUndefined();
    expect(tools.getActiveTools()).not.toContain('Debug');
    expect(tools.loopTools.map((tool) => tool.name)).not.toContain('Debug');
    expect(tools.defaultShapedToolNames(['Read', 'Debug'])).not.toContain('Debug');
  });

  it('constructs the tool when the group is enabled', () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.applyDefaultProfile();
    const tools = ctx.agent.tools;

    const outcome = tools.enableDeferredToolGroup('debug');
    expect(outcome).toEqual({ status: 'enabled', toolNames: ['Debug'] });
    expect(tools.getBuiltinTool('Debug')).toBeInstanceOf(DebugTool);
    expect(tools.getActiveTools()).toContain('Debug');
    expect(tools.loopTools.map((tool) => tool.name)).toContain('Debug');
    expect(tools.defaultShapedToolNames(['Read'])).toContain('Debug');
    expect(tools.enableDeferredToolGroup('debug')).toEqual({ status: 'already-enabled' });
  });
});
