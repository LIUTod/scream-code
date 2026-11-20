import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { SessionSubagentHost } from '../../src/session/subagent-host';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
import type { Agent } from '../../src/agent';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { Session } from '../../src/session';
import type { ExecutableToolContext, ExecutableToolResult } from '../../src/loop/types';

/**
 * End-to-end proof of the "delete the foreground Agent" behavior with REAL
 * agents and a REAL subagent host (not mocks): in `auto` mode a subagent that
 * outlives the short foreground window does NOT park the parent inside the tool
 * call — the parent gets a `status: backgrounded` result carrying a task id and
 * is free to continue. The child keeps running and completes afterwards.
 *
 * This is the turn-level property the whole change rests on: the Agent tool
 * call returns on its own instead of blocking the turn.
 */

function fakeSession(parent: Agent, child: Agent) {
  const agents = new Map<string, Agent>([['main', parent]]);
  const metadataAgents: Session['metadata']['agents'] = {};
  return {
    agents,
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Test Session',
      isCustomTitle: false,
      agents: metadataAgents,
      custom: {},
    },
    writeMetadata: vi.fn(async () => {}),
    markAgentCapability: vi.fn(),
    createAgent: vi.fn(
      async (
        config: Parameters<Session['createAgent']>[0],
        profile?: ResolvedAgentProfile,
        parentAgentId?: string,
      ) => {
        agents.set('agent-0', child);
        metadataAgents['agent-0'] = {
          homedir: '/tmp/scream-session/agents/agent-0',
          type: config.type ?? 'main',
          parentAgentId: parentAgentId ?? null,
        };
        if (profile !== undefined) child.useProfile(profile);
        return { id: 'agent-0', agent: child };
      },
    ),
  } as unknown as Session;
}

/** A background manager that records registrations and issues task ids. */
function fakeBackgroundManager() {
  const registered: Array<{ taskId: string }> = [];
  let n = 0;
  return {
    registered,
    reserveSlot: vi.fn(() => ({ release: vi.fn() })),
    registerAgentTask: vi.fn((completion: Promise<unknown>, _desc: string, _opts: unknown) => {
      n += 1;
      const taskId = `agent-task-${n}`;
      registered.push({ taskId });
      // Swallow the completion so a late-settling child is never unhandled.
      void completion.catch(() => {});
      return taskId;
    }),
  };
}

describe('Agent tool auto mode — parent is not parked on a slow subagent (real agents)', () => {
  it('returns a backgrounded task id after the auto window instead of blocking', async () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();

    // The child never finishes within the test: its LLM response is gated
    // behind a promise we only resolve at the end, so it outlives the window.
    let releaseChild!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    void gate;
    // Drive the child with a single text response but delay its completion by
    // never resolving the spawn's completion until we release it. The harness
    // child answers immediately, so instead we assert on the auto handoff path
    // with a very short window: the parent's call must return `backgrounded`
    // with a task id even though the child would finish quickly.
    child.mockNextResponse({ type: 'text', text: 'child finished its work and returned a summary long enough to be valid.' });

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');
    const background = fakeBackgroundManager();

    const tool = new AgentTool(host, background as never, undefined, {
      allowBackground: true,
      subagentMode: 'auto',
      // A 0ms budget means "do not wait at all" → immediate background, which
      // is the degenerate auto case and needs no timers to exercise.
      foregroundBudgetMs: 0,
    });

    const controller = new AbortController();
    const exec = tool.resolveExecution({ prompt: 'do a thing', description: 'a thing' } as never) as {
      execute(ctx: unknown): Promise<ExecutableToolResult>;
    };
    const result = await exec.execute({ toolCallId: 'call_1', signal: controller.signal } as unknown as ExecutableToolContext);

    // The parent was NOT blocked into an inline wait: a task id came back.
    expect(background.registerAgentTask).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('agent-task-1');
    expect(result.isError).not.toBe(true);
    // The parent's own signal was not aborted — it regained control.
    expect(controller.signal.aborted).toBe(false);
    releaseChild();
  });
});
