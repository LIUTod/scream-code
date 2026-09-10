import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { testAgent } from '../agent/harness/agent';

/**
 * Integration smoke: real permission chain + real tool execution (no mocks
 * beyond the scripted LLM). Verifies bot mode end-to-end at the TOOL RESULT
 * level (not just transcript text):
 * - destructive Bash is denied by the fail-closed policy (tool result carries
 *   the "bot:" denial reason, not a tool-not-found error);
 * - in-workspace writes execute (tool result is a success, not a denial).
 */
describe('bot mode integration smoke', () => {
  afterAll(() => {
    const leftover = join(process.cwd(), 'smoke-write.tmp');
    if (existsSync(leftover)) unlinkSync(leftover);
  });

  it('denies destructive Bash at the tool-result level and allows in-workspace writes', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Bash', 'Write'] });
    await ctx.rpc.setPermission({ mode: 'bot' });

    const toolResults = () =>
      ctx.agent.context.history
        .filter((m: { role: string }) => m.role === 'tool')
        .map((m: { content: unknown }) => JSON.stringify(m.content));

    // 1) Destructive command → denied by the bot policy (fail-closed).
    ctx.mockNextResponse({
      type: 'function',
      id: 'tc_deny',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'git push origin main' }),
    });
    ctx.mockNextResponse({
      type: 'text',
      text: 'The push was denied in bot mode, so I parked it for human review and continued with the remaining safe work here.',
    });
    await ctx.agent.turn.prompt([{ type: 'text', text: 'try to push' }], {
      kind: 'system_trigger',
      name: 'smoke',
    });
    await ctx.agent.turn.waitForCurrentTurn();

    const afterPush = toolResults().join('\n');
    // The tool actually EXECUTED and was refused by permission — not tool-not-found.
    expect(afterPush).not.toContain('Tool "Bash" not found');
    expect(afterPush).toContain('bot:');
    expect(afterPush.toLowerCase()).toContain('parked for human review');

    // 2) In-workspace write → approved and executed (success result, no denial).
    ctx.mockNextResponse({
      type: 'function',
      id: 'tc_write',
      name: 'Write',
      arguments: JSON.stringify({ path: './smoke-write.tmp', content: 'ok' }),
    });
    ctx.mockNextResponse({
      type: 'text',
      text: 'Wrote the temporary file inside the workspace as a reversible action, verified it, and finished the smoke run cleanly today.',
    });
    await ctx.agent.turn.prompt([{ type: 'text', text: 'write a temp file' }], {
      kind: 'system_trigger',
      name: 'smoke',
    });
    await ctx.agent.turn.waitForCurrentTurn();

    const afterWrite = toolResults().slice(-1).join('\n');
    expect(afterWrite).not.toContain('Tool "Write" not found');
    expect(afterWrite).toContain('smoke-write.tmp');
    expect(afterWrite).not.toContain('not in the reversible allowlist');
    expect(afterWrite).not.toContain('outside the workspace');
  });
});
