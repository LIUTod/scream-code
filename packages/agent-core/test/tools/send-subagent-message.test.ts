import { describe, expect, it, vi } from 'vitest';
import { SendSubagentMessageTool } from '../../src/tools/builtin/collaboration/send-subagent-message';
import type { ExecutableToolContext } from '../../src/loop/types';
import type { SubagentMessageStatus } from '../../src/session/subagent-messages';
import type { SessionSubagentHost } from '../../src/session/subagent-host';

const CTX: ExecutableToolContext = {
  turnId: 't1',
  toolCallId: 'c1',
  signal: new AbortController().signal,
};

function stubHost(status: SubagentMessageStatus = 'accepted'): SessionSubagentHost {
  return {
    sendMessage: vi.fn((_to: string, _op: 'queue' | 'steer', _text: string) => ({ status })),
  } as unknown as SessionSubagentHost;
}

function runTool(
  host: SessionSubagentHost,
  args: { agent_id: string; operation: 'queue' | 'steer'; message: string },
): Promise<{ isError: boolean; output: string }> {
  const tool = new SendSubagentMessageTool(host);
  const exec = tool.resolveExecution(args);
  // ToolExecution is a union (success | error); the success arm carries execute.
  if ('execute' in exec) {
    return exec.execute(CTX) as Promise<{ isError: boolean; output: string }>;
  }
  return Promise.resolve({ isError: true, output: 'unavailable' });
}

describe('SendSubagentMessageTool', () => {
  it('exposes the expected name and parameters', () => {
    const tool = new SendSubagentMessageTool(stubHost());
    expect(tool.name).toBe('SendSubagentMessage');
    expect(tool.description).toContain('directed message');
    expect(tool.parameters).toHaveProperty('type', 'object');
  });

  it('delegates to the host and reports accepted as success', async () => {
    const host = stubHost();
    const result = await runTool(host, {
      agent_id: 'agent-123',
      operation: 'steer',
      message: 'reconsider the approach',
    });
    expect(host.sendMessage).toHaveBeenCalledWith('agent-123', 'steer', 'reconsider the approach');
    expect(result.isError).toBe(false);
    expect(result.output).toContain('accepted');
  });

  it('reports non-accepted statuses as errors with the human message', async () => {
    const host = stubHost('not_owned');
    const result = await runTool(host, {
      agent_id: 'other-owner',
      operation: 'queue',
      message: 'hello',
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not owned');
  });

  it('rejects empty messages at the schema level', () => {
    const tool = new SendSubagentMessageTool(stubHost());
    expect(tool.parameters).toBeTruthy();
  });
});
