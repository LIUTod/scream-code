import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { SessionSubagentHost } from '../../src/session/subagent-host';
import { SubagentMessageBus } from '../../src/session/subagent-messages';
import type { Agent } from '../../src/agent';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { Session } from '../../src/session';

const signal = new AbortController().signal;

/** Minimal Session-shaped object mirroring the subagent-host test fixture. */
function fakeSession(parent: Agent, child: Agent, metadataAgents: Session['metadata']['agents'] = {}) {
  const agents = new Map<string, Agent>([['main', parent]]);
  if (metadataAgents['agent-0'] !== undefined) {
    agents.set('agent-0', child);
  }
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
        if (profile !== undefined) {
          child.useProfile(profile);
        }
        return { id: 'agent-0', agent: child };
      },
    ),
  } as unknown as Session;
}

function stubJian() {
  return undefined; // use the harness default (testJian), same as subagent-host.test.ts
}

describe('subagent collaboration integration', () => {
  it('capability_mode read-only strips Write/Bash/nesting tools from the child', async () => {
    const child = testAgent();
    const parent = testAgent({ jian: stubJian() });
    parent.configure();
    child.configure();
    parent.newEvents();

    const summary =
      'Implemented the subagent task completely and returned a detailed enough summary for the parent agent to continue confidently without repeating the child agent work. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const host = new SessionSubagentHost(session, 'main');

    const childAgent = child.agent as unknown as {
      tools: { getActiveTools(): string[] };
    };
    // Sanity: before spawn the profile has not been mounted, so tools are empty.
    expect(childAgent.tools.getActiveTools()).toHaveLength(0);

    const handle = await host.spawn('coder', {
      parentToolCallId: 'call_agent',
      prompt: 'Inspect only, do not modify',
      description: 'read-only child',
      runInBackground: false,
      signal,
      capabilityMode: 'read-only',
    });
    await handle.completion;

    const after = childAgent.tools.getActiveTools();
    expect(after).not.toContain('Write');
    expect(after).not.toContain('Bash');
    expect(after).not.toContain('Agent');
    expect(after).not.toContain('WolfPack');
    expect(after).not.toContain('SendSubagentMessage');
    expect(after).toContain('Read');
    expect(after).toContain('Grep');
  });

  it('SendSubagentMessage delivers into the shared bus; foreign owner is refused', () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);
    // Simulate an active child in the host's tracking set.
    (host as unknown as { activeChildren: Set<string> }).activeChildren = new Set(['agent-0']);

    const ok = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(ok.status).toBe('accepted');
    const delivered = bus.poll('agent-0');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.operation).toBe('steer');
    expect(delivered[0]!.text).toBe('reconsider the approach');
    expect(delivered[0]!.fromAgentId).toBe('main');

    const foreign = host.sendMessage('nobody', 'queue', 'x');
    expect(foreign.status).toBe('not_found');
  });

  it('parent messages are injected into the child prompt at turn start', async () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();
    parent.newEvents();

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);

    // Queue a steer message before the child starts its turn. Simulate an
    // active child with the same shape spawn uses (controller + runInBackground).
    (host as unknown as { activeChildren: Map<string, unknown> }).activeChildren = new Map([
      ['agent-0', { controller: new AbortController(), runInBackground: false }],
    ]);
    const sent = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(sent.status).toBe('accepted');

    // The child's first prompt must contain the injected parent message.
    child.mockNextResponse({ type: 'text', text: 'ok' });
    const handle = await host.spawn('coder', {
      parentToolCallId: 'call_1',
      parentToolCallUuid: undefined,
      prompt: 'original prompt',
      description: 'child',
      runInBackground: false,
      signal,
    });
    await handle.completion.catch(() => undefined);

    const prompts = child.agent.context
      .history.filter((m: { role: string }) => m.role === 'user')
      .map((m: { content: unknown }) => m.content);
    const firstPrompt = Array.isArray(prompts[0]) ? prompts[0].map((p) => (p as { text: string }).text).join('\n') : String(prompts[0]);
    expect(firstPrompt).toContain('[parent_messages]');
    expect(firstPrompt).toContain('[directive] reconsider the approach');
  });

  it('a host owned by someone else cannot message the child', () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();
    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const host = new SessionSubagentHost(session, 'other-agent');
    (host as unknown as { activeChildren: Set<string> }).activeChildren = new Set(['agent-0']);
    expect(host.sendMessage('agent-0', 'queue', 'x').status).toBe('not_owned');
  });
});
