import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { SessionSubagentHost } from '../../src/session/subagent-host';
import { SubagentMessageBus } from '../../src/session/subagent-messages';
import type { Agent } from '../../src/agent';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { Session } from '../../src/session';

const signal = new AbortController().signal;

/** Minimal Session-shaped object mirroring the subagent-host test fixture. */
function fakeSession(parent: Agent, child: Agent) {
  const agents = new Map<string, Agent>([
    ['main', parent],
    ['agent-0', child],
  ]);
  return {
    agents,
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Test Session',
      isCustomTitle: false,
      agents: { 'agent-0': { homedir: '/tmp/scream-session/agents/agent-0', type: 'sub', parentAgentId: 'main' } },
      custom: {},
    },
    writeMetadata: vi.fn(async () => {}),
    createAgent: vi.fn(
      async (config: Parameters<Session['createAgent']>[0], profile?: ResolvedAgentProfile) => {
        if (profile !== undefined) child.useProfile(profile);
        return { id: 'agent-0', agent: child };
      },
    ),
  } as unknown as Session;
}

function stubJian() {
  return undefined; // use the harness default (testJian), same as subagent-host.test.ts
}

describe('child→parent collaboration (ContactParent)', () => {
  it('delivers a mid-run ContactParent request into the parent inbox', async () => {
    const child = testAgent({ type: 'sub', jian: stubJian() });
    const parent = testAgent({ jian: stubJian() });
    const session = fakeSession(parent.agent, child.agent);
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);
    // Real sessions set ownerHost on subagents (Session.instantiateAgent:
    // `ownerHost: parentAgent?.subagentHost`); mirror that so ContactParent
    // mounts against the OWNER's host (where this child is registered).
    (child.agent as unknown as { ownerHost?: SessionSubagentHost }).ownerHost = host;
    parent.configure();
    child.configure();
    parent.newEvents();
    await parent.rpc.setPermission({ mode: 'yolo' });
    await child.rpc.setPermission({ mode: 'yolo' });
    // The child_request notification wakes the parent (steer → launch when
    // idle); give the parent scripted replies so the wake-up turn settles.
    // Sub-agents of type 'sub' generate via the parent's rawGenerate, so the
    // parent's scripted responses may also be consumed by the child turn.
    parent.mockNextResponse({ type: 'text', text: 'acknowledged.' });
    parent.mockNextResponse({ type: 'text', text: 'acknowledged.' });
    parent.mockNextResponse({ type: 'text', text: 'acknowledged.' });

    // Turn 1: the child calls ContactParent (handoff request), then answers.
    child.mockNextResponse({
      type: 'function',
      id: 'tc_cp',
      name: 'ContactParent',
      arguments: JSON.stringify({
        request_type: 'handoff',
        message: 'I need this logic independently verified before I continue.',
        needs: 'independent verification',
        payload: { artifacts: ['src/foo.ts'], evidence: ['test-output.txt'] },
      }),
    });
    child.mockNextResponse({
      type: 'text',
      text: '{"done":true,"summary":"I requested an independent verification of the pricing logic before proceeding. The request was accepted and I will continue with the remaining work once the parent routes the handoff."}',
    });

    let completion;
    try {
      const handle = await host.spawn('coder', {
        parentToolCallId: 'call_1',
        parentToolCallUuid: undefined,
        prompt: 'original prompt',
        description: 'child',
        runInBackground: false,
        signal,
      });
      completion = await handle.completion;
    } catch (error) {
      throw error;
    }
    expect(completion.turns).toBe(1);

    // Delivery is notification-only: the child_request waked the parent
    // (steer → launch while idle), so the parent's scripted generate ran.
    const parentGen = (parent as unknown as {
      scriptedGenerate: { calls: unknown[]; lastInput: () => unknown };
    }).scriptedGenerate;
    expect(parentGen.calls.length).toBeGreaterThan(0);
    const parentInput = parentGen.lastInput();
    expect(parentInput).toBeDefined();
    expect(JSON.stringify(parentInput)).toContain('child_request');
    expect(JSON.stringify(parentInput)).toContain('handoff');
    expect(JSON.stringify(parentInput)).toContain('independent verification');
    expect(JSON.stringify(parentInput)).toContain('artifacts: [src/foo.ts]');
  });

  it('rate-limits child→parent requests to 4 per turn', async () => {
    const child = testAgent({ type: 'sub', jian: stubJian() });
    const parent = testAgent({ jian: stubJian() });
    parent.configure();
    child.configure();
    const session = fakeSession(parent.agent, child.agent);
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);
    const anyHost = host as unknown as {
      activeChildren: Map<string, unknown>;
      childIdByAgent: WeakMap<Agent, string>;
    };
    anyHost.activeChildren = new Map([['agent-0', {}]]);
    anyHost.childIdByAgent.set(child.agent, 'agent-0');

    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(
        host.submitChildRequest(child.agent, {
          request_type: 'info',
          message: `request number ${i}`,
        }).status,
      );
    }
    expect(statuses.slice(0, 4)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(statuses[4]).toBe('saturated');
  });

  it('dedupes identical requests within a turn', async () => {
    const child = testAgent({ type: 'sub', jian: stubJian() });
    const parent = testAgent({ jian: stubJian() });
    parent.configure();
    child.configure();
    const session = fakeSession(parent.agent, child.agent);
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);
    const anyHost = host as unknown as {
      activeChildren: Map<string, unknown>;
      childIdByAgent: WeakMap<Agent, string>;
    };
    anyHost.activeChildren = new Map([['agent-0', {}]]);
    anyHost.childIdByAgent.set(child.agent, 'agent-0');

    const req = { request_type: 'escalate' as const, message: 'conflicting evidence on pricing' };
    const first = host.submitChildRequest(child.agent, req);
    const second = host.submitChildRequest(child.agent, req);
    expect(first.status).toBe('accepted');
    expect(second).toEqual({ status: 'accepted', deduped: true });
  });

  it('rejects requests from agents that are not active children', async () => {
    const child = testAgent({ type: 'sub', jian: stubJian() });
    const parent = testAgent({ jian: stubJian() });
    parent.configure();
    child.configure();
    const session = fakeSession(parent.agent, child.agent);
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);
    // No activeChildren / no id mapping → not_active.
    expect(
      host.submitChildRequest(child.agent, { request_type: 'info', message: 'hi' }).status,
    ).toBe('not_active');
  });
});
