import { describe, expect, it } from 'vitest';

import type { ToolCall } from '@scream-code/ltod';

import { createCommandJian, testAgent } from '../agent/harness/agent';

function runScriptCall(code: string, id = 'call_script'): ToolCall {
  return {
    type: 'function',
    id,
    name: 'RunScript',
    arguments: JSON.stringify({ code }),
  };
}

const SCRIPT_THAT_CALLS_BASH = [
  'const out = await tools.Bash({ command: "printf nested-output", timeout: 60 });',
  'text("bash said: " + out);',
].join('\n');

function toolMessages(ctx: ReturnType<typeof testAgent>) {
  return ctx.agent.context.history.filter((message) => message.role === 'tool');
}

describe('RunScript tool', () => {
  it('runs nested tool calls without leaking them into the conversation', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse(
      { type: 'text', text: 'Running a batch.' },
      runScriptCall(SCRIPT_THAT_CALLS_BASH),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Batch finished.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Batch please' }] });
    const events = JSON.stringify(await ctx.untilTurnEnd());

    // Exactly one tool message: the RunScript result. The nested Bash call
    // produced no transcript entry of its own.
    const messages = toolMessages(ctx);
    expect(messages).toHaveLength(1);
    const serialized = JSON.stringify(messages[0]?.content ?? []);
    expect(serialized).toContain('bash said: nested-output');
    // The nested result text itself must not appear as loose output.
    expect(serialized).not.toEqual('"nested-output"');

    // The nested call is recorded as a UI/persistence side channel on the
    // tool.result event (callId `<parent>/<n>`).
    expect(events).toContain('nestedCalls');
    expect(events).toContain('call_script/1');
  });

  it('routes nested calls through the approval flow', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    // Default permission mode: EXECUTE tools need approval, so both the
    // RunScript call itself and the nested Bash call ask.
    ctx.mockNextResponse(
      { type: 'text', text: 'Running a batch.' },
      runScriptCall(SCRIPT_THAT_CALLS_BASH),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Batch finished.' });
    const prompt = ctx.rpc.prompt({ input: [{ type: 'text', text: 'Batch please' }] });

    const scriptApproval = await ctx.takeApprovalRequest();
    expect(JSON.stringify(scriptApproval.events)).toContain('RunScript');
    scriptApproval.respond({ decision: 'approved', selectedLabel: 'approve' });

    const nestedApproval = await ctx.takeApprovalRequest();
    expect(JSON.stringify(nestedApproval.events)).toContain('Bash');
    nestedApproval.respond({ decision: 'approved', selectedLabel: 'approve' });

    await prompt;
    await ctx.untilTurnEnd();

    const messages = toolMessages(ctx);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]?.content ?? [])).toContain('bash said: nested-output');
  });

  it('fails the script with the denial text when a nested call is rejected', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    ctx.mockNextResponse(
      { type: 'text', text: 'Running a batch.' },
      runScriptCall(SCRIPT_THAT_CALLS_BASH),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Batch finished.' });
    const prompt = ctx.rpc.prompt({ input: [{ type: 'text', text: 'Batch please' }] });

    const scriptApproval = await ctx.takeApprovalRequest();
    scriptApproval.respond({ decision: 'approved', selectedLabel: 'approve' });
    const nestedApproval = await ctx.takeApprovalRequest();
    nestedApproval.respond({ decision: 'rejected', selectedLabel: 'reject' });

    await prompt;
    await ctx.untilTurnEnd();

    const messages = toolMessages(ctx);
    expect(messages).toHaveLength(1);
    const serialized = JSON.stringify(messages[0]?.content ?? []);
    // A denied nested call rejects inside the script (mirroring the reference
    // runner), so the script fails with the denial text instead of silently
    // continuing with a placeholder result.
    expect(serialized).toMatch(/rejected|not run/i);
    expect(serialized).toContain('Script failed');
  });

  it('does not deadlock when the model issued the same call with the same args in the same step', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    // The model issues Bash AND RunScript in the same step, and the script
    // calls Bash with identical arguments: nested calls must stay out of the
    // same-step dedup ledger, otherwise the parent result waits on a nested
    // duplicate of itself and the turn never settles.
    ctx.mockNextResponse(
      { type: 'text', text: 'Running.' },
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'printf nested-output', timeout: 60 }),
      },
      runScriptCall(SCRIPT_THAT_CALLS_BASH),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await ctx.untilTurnEnd();

    const messages = toolMessages(ctx);
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages.map((message) => message.content))).toContain(
      'bash said: nested-output',
    );
  });

  it('runs oversized nested arguments and only degrades the record', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    const bigArg = 'x'.repeat(9 * 1024);
    const code = [
      `const out = await tools.Bash({ command: "printf nested-output # " + ${JSON.stringify(bigArg)}, timeout: 60 });`,
      'text("bash said: " + out);',
    ].join('\n');
    ctx.mockNextResponse({ type: 'text', text: 'Running.' }, runScriptCall(code));
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    const events = JSON.stringify(await ctx.untilTurnEnd());

    // The call still ran (arguments over the byte budget only drop the record
    // details, they never refuse execution).
    const messages = toolMessages(ctx);
    expect(JSON.stringify(messages[0]?.content ?? [])).toContain('bash said: nested-output');
    // The event snapshot is compact JSON: `"incomplete":true` marks the
    // record whose arguments were dropped for size.
    expect(events).toContain('"incomplete":true');
  });

  it('toggles the tool in and out of the active set via setScriptEnabled', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash'] });

    // Bare call toggles (the /script command sends no argument) and reports
    // the resulting state.
    expect(await ctx.rpc.setScriptEnabled({})).toBe(true);
    expect(ctx.agent.tools.getActiveTools()).toContain('RunScript');

    expect(await ctx.rpc.setScriptEnabled({})).toBe(false);
    expect(ctx.agent.tools.getActiveTools()).not.toContain('RunScript');

    // Explicit targets still work.
    expect(await ctx.rpc.setScriptEnabled({ enabled: true })).toBe(true);
    expect(await ctx.rpc.setScriptEnabled({ enabled: false })).toBe(false);
    expect(ctx.agent.tools.getActiveTools()).not.toContain('RunScript');
  });

  it('keeps the enabled state across resume', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash'] });

    await ctx.rpc.setScriptEnabled({ enabled: true });
    await ctx.expectResumeMatches();

    await ctx.rpc.setScriptEnabled({ enabled: false });
    await ctx.expectResumeMatches();
  });

  it('rejects invalid @options without running the script', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse(
      { type: 'text', text: 'Running.' },
      runScriptCall('// @options: {"bogus_option": 1}\ntext("should not run");', 'call_bad'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await ctx.untilTurnEnd();

    const messages = toolMessages(ctx);
    const serialized = JSON.stringify(messages[0]?.content ?? []);
    expect(serialized).toContain('Script rejected');
    expect(serialized).not.toContain('should not run');
  });

  it('never embeds the untruncated text when the output budget is zero', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    // `max_output_tokens: 0` is legal (non-negative), and `slice(-0)` returns
    // the whole string — the truncated result must not smuggle the full text.
    const secret = 'SECRET-CONTENT-'.repeat(50);
    const code = [
      '// @options: {"max_output_tokens": 0}',
      `text(${JSON.stringify(secret)});`,
    ].join('\n');
    ctx.mockNextResponse(
      { type: 'text', text: 'Running.' },
      runScriptCall(code, 'call_zero'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await ctx.untilTurnEnd();

    const serialized = JSON.stringify(toolMessages(ctx)[0]?.content ?? []);
    expect(serialized).toContain('truncated');
    expect(serialized).not.toContain('SECRET-CONTENT-');
  });

  it('persists store writes across invocations (successful runs only)', async () => {
    const ctx = testAgent({ jian: createCommandJian('nested-output') });
    ctx.configure({ tools: ['Bash', 'RunScript'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    const runScript = async (code: string, id: string): Promise<string> => {
      ctx.mockNextResponse({ type: 'text', text: 'ok' }, runScriptCall(code, id));
      ctx.mockNextResponse({ type: 'text', text: 'done' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'step' }] });
      await ctx.untilTurnEnd();
      const messages = toolMessages(ctx);
      return JSON.stringify(messages.at(-1)?.content ?? []);
    };

    expect(await runScript('store("seen", 1); text("stored");', 'call_s1')).toContain('stored');
    expect(await runScript('text("seen=" + load("seen"));', 'call_s2')).toContain('seen=1');
    expect(
      await runScript('store("lost", 1); throw new Error("nope");', 'call_s3'),
    ).toContain('nope');
    expect(await runScript('text("lost=" + load("lost"));', 'call_s4')).toContain('lost=undefined');
  });
});
