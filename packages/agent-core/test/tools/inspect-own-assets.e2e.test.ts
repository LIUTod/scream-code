import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../../src/loop/types';
import { DEFAULT_AGENT_PROFILES } from '../../src/profile';
import { testAgent } from '../agent/harness';

describe('InspectOwnAssets e2e (temporary)', () => {
  it('is registered on the main agent and callable end-to-end', async () => {
    const ctx = testAgent();
    ctx.configure();
    const agent = ctx.agent;

    const tool = agent.tools.getBuiltinTool('InspectOwnAssets');
    expect(tool).toBeDefined();

    // Mount the real default agent profile (as session/index.ts:310 does) so
    // the full wiring is exercised: profile tools list -> enabledTools ->
    // model-visible loopTools.
    agent.useProfile(DEFAULT_AGENT_PROFILES['agent']!);

    // Full profile wiring: the tool must be in the model-visible loopTools
    // with a rendered description and parameter schema.
    const modelTool = agent.tools.loopTools.find((t) => t.name === 'InspectOwnAssets');
    expect(modelTool).toBeDefined();
    expect(modelTool!.description.length).toBeGreaterThan(50);
    expect(modelTool!.parameters).toBeDefined();
    expect(JSON.stringify(modelTool!.parameters)).toContain('skills');
    expect(JSON.stringify(modelTool!.parameters)).toContain('knowledge');

    const execution = await tool!.resolveExecution({});
    // RunnableToolExecution carries `execute`; error results do not.
    if (!('execute' in execution)) {
      throw new Error('unexpected error execution');
    }

    const result = await execution.execute({
      turnId: 'e2e',
      toolCallId: 'e2e',
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(false);
    // Real scream home must surface the asset sections
    expect(result.output).toContain('## Config');
    expect(result.output).toContain('config.toml');
    expect(result.output).toContain('## Skills');
    expect(result.output).toContain('## MCP servers');
    expect(result.output).toContain('## Memory');
    expect(result.output).toContain('## Knowledge');
  });

  it('keeps existing core tools registered alongside', async () => {
    const ctx = testAgent();
    ctx.configure();
    const agent = ctx.agent;

    for (const name of ['Bash', 'Read', 'Edit', 'Glob', 'Grep', 'TodoList']) {
      expect(agent.tools.getBuiltinTool(name), name).toBeDefined();
    }
  });

  it('full turn: tool is injected into the model request and callable by the model', async () => {
    const ctx = testAgent();
    // The harness enables tools explicitly via configure({ tools }) — the
    // same way turn.test.ts enables Bash. (In real runs, session useProfile
    // drives activeTools from profile.tools, covered by the first test.)
    ctx.configure({ tools: ['InspectOwnAssets'] });

    // The session flow mounts the default agent profile (session/index.ts:310),
    // which lists InspectOwnAssets — the model request must carry it.
    const inspectCall: ToolCall = {
      id: 'call_inspect',
      type: 'function',
      name: 'InspectOwnAssets',
      arguments: JSON.stringify({ scope: 'all' }),
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will inspect my assets.' }, inspectCall);
    // After the tool executes, the model summarizes — feed the second request.
    ctx.mockNextResponse({ type: 'text', text: 'Here is the asset inventory.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Inspect your assets' }] });

    const events = JSON.stringify(await ctx.untilTurnEnd());

    // 1. Injection: the model request advertises the tool in activeTools
    //    (precise — the header carries the enabled-tool name array).
    expect(events).toContain('"activeTools":["InspectOwnAssets"]');

    // 2. The read-only tool must be auto-approved: no approval request.
    expect(events).not.toContain('requestApproval');

    // 3. Invocation: the model's tool_call was dispatched (tool.call carries
    //    the only `"name":` key in the stream) and executed (tool.result
    //    output carries the asset sections).
    expect(events).toContain('"name":"InspectOwnAssets"');
    expect(events).toContain('## Config');
    expect(events).toContain('## Skills');
    expect(events).toContain('## Knowledge');
  });
});
