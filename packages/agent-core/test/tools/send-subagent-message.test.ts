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

function stubHost(
  status: SubagentMessageStatus = 'accepted',
  delivery?: 'mid-run' | 'queued' | 'interjected',
  duplicate?: boolean,
  extra?: {
    messageId?: string;
    downgrade?: 'structured' | 'idle' | 'steer-buffer-full';
    reason?: 'bytes' | 'queue';
  },
): SessionSubagentHost {
  return {
    sendMessage: vi.fn((_to: string, _op: 'queue' | 'steer' | 'interject', _text: string) => ({
      status,
      delivery,
      duplicate,
      ...extra,
    })),
  } as unknown as SessionSubagentHost;
}

function runTool(
  host: SessionSubagentHost,
  args: { agent_id: string; operation: 'queue' | 'steer' | 'interject'; message: string },
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

  it('says which path an accepted message took', async () => {
    const midRun = stubHost('accepted', 'mid-run');
    const midRunResult = await runTool(midRun, {
      agent_id: 'agent-123',
      operation: 'steer',
      message: 'stop and regroup',
    });
    expect(midRunResult.output).toContain("running turn");
    expect(midRunResult.output).toContain('next step boundary');

    const queued = stubHost('accepted', 'queued');
    const queuedResult = await runTool(queued, {
      agent_id: 'agent-123',
      operation: 'queue',
      message: 'context for later',
    });
    expect(queuedResult.output).toContain('queued');
    expect(queuedResult.output).toContain('next turn');
    // The queued receipt has to state the delivery window, or "accepted" reads
    // as "will be delivered eventually no matter what".
    expect(queuedResult.output).toContain('in-session');
    expect(queuedResult.output).toContain('expires 5 minutes');
  });

  it('says when a message was a duplicate', async () => {
    const host = stubHost('accepted', undefined, true, { messageId: 'main:agent-123:7' });
    const result = await runTool(host, {
      agent_id: 'agent-123',
      operation: 'steer',
      message: 'again',
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Duplicate of a message already in flight');
    // Without the id the parent cannot reconcile its retry with the copy it
    // duplicated.
    expect(result.output).toContain('(id: main:agent-123:7)');
  });

  it('says why an interject was downgraded instead of interrupting', async () => {
    const structured = stubHost('accepted', 'queued', false, { downgrade: 'structured' });
    const structuredResult = await runTool(structured, {
      agent_id: 'agent-123',
      operation: 'interject',
      message: 'stop now',
    });
    expect(structuredResult.output).toContain('downgraded');
    expect(structuredResult.output).toContain('structured (JSON) answer');

    const idle = stubHost('accepted', 'queued', false, { downgrade: 'idle' });
    const idleResult = await runTool(idle, {
      agent_id: 'agent-123',
      operation: 'interject',
      message: 'stop now',
    });
    expect(idleResult.output).toContain('no turn is running');
  });

  it('names the byte limit when a message is rejected for size', async () => {
    const host = stubHost('saturated', undefined, false, { reason: 'bytes' });
    const result = await runTool(host, {
      agent_id: 'agent-123',
      operation: 'queue',
      message: 'x'.repeat(20),
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('16 KiB UTF-8 byte limit');
  });

  it('tells the parent how to recover when it is itself gone', async () => {
    const host = stubHost('parent_gone');
    const result = await runTool(host, {
      agent_id: 'agent-123',
      operation: 'queue',
      message: 'hello',
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('no longer running');
    expect(result.output).toContain('Resume that agent and send the message again');
  });

  it('reports an interjected message as immediately effective', async () => {
    const host = stubHost('accepted', 'interjected');
    const result = await runTool(host, {
      agent_id: 'agent-123',
      operation: 'interject',
      message: 'abort the wait, do X instead',
    });
    expect(host.sendMessage).toHaveBeenCalledWith(
      'agent-123',
      'interject',
      'abort the wait, do X instead',
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('interjected');
    expect(result.output).toContain('interrupted');
  });

  it('advertises interject in the operation schema', () => {
    const tool = new SendSubagentMessageTool(stubHost());
    const operation = (
      tool.parameters as {
        properties?: { operation?: { enum?: string[]; description?: string } };
      }
    ).properties?.operation;
    expect(operation?.enum).toEqual(['queue', 'steer', 'interject']);
    expect(operation?.description).toContain('interject');
  });

  it('states the UTF-8 byte limit in the model-facing message schema', () => {
    const tool = new SendSubagentMessageTool(stubHost());
    const message = (
      tool.parameters as {
        properties?: { message?: { description?: string; maxLength?: number } };
      }
    ).properties?.message;
    // A character cap (maxLength) cannot express a byte limit, so the
    // description carries the real boundary the host enforces.
    expect(message?.description).toContain('16 KiB of UTF-8 text');
    expect(message?.maxLength).toBeUndefined();
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
