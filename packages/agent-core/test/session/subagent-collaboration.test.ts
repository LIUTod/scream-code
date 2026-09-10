import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { SessionSubagentHost } from '../../src/session/subagent-host';
import { SubagentMessageBus } from '../../src/session/subagent-messages';
import type { Agent } from '../../src/agent';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { Session } from '../../src/session';

const signal = new AbortController().signal;

/**
 * Deterministic async boundary: the gated Bash command starts, touches a
 * marker file, then blocks until the test writes the release file. This makes
 * "message arrives mid-run" independent of scheduling load (time-based windows
 * flake under full-suite parallelism).
 */
function drainGate() {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const started = join(tmpdir(), `scream-drain-started-${stamp}`);
  const go = `${started}.go`;
  return {
    command: `touch "${started}" && while [ ! -f "${go}" ]; do sleep 0.05; done`,
    async waitForStart() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (existsSync(started)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('drain gate: the gated Bash command never started');
    },
    release() {
      writeFileSync(go, 'go');
    },
    cleanup() {
      try {
        unlinkSync(go);
      } catch {}
      try {
        unlinkSync(started);
      } catch {}
    },
  };
}

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

  it('delivers mid-run parent messages to a structured-output subagent via a bounded delivery turn', async () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();
    parent.newEvents();
    await parent.rpc.setPermission({ mode: 'yolo' });
    await child.rpc.setPermission({ mode: 'yolo' });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);

    // Turn 1: a gated Bash call — the child blocks inside it until we release,
    // so the parent message deterministically arrives mid-run.
    const gate = drainGate();
    child.mockNextResponse({
      type: 'function',
      id: 'tc_bash',
      name: 'Bash',
      arguments: JSON.stringify({ command: gate.command }),
    });
    child.mockNextResponse({ type: 'text', text: '{"ok":true}' });
    // Bounded delivery turn (structured message delivery): resend the JSON
    // answer after reading the [parent_messages] block.
    child.mockNextResponse({ type: 'text', text: '{"ok":true,"steered":true}' });

    const spawnPromise = host.spawn('coder', {
      parentToolCallId: 'call_1',
      parentToolCallUuid: undefined,
      prompt: 'original prompt',
      description: 'child',
      runInBackground: false,
      signal,
      outputSchema: '{"type":"object"}',
    });
    // The child's first prompt is committed and the gated Bash is running.
    await gate.waitForStart();
    // Mid-run steer: arrives after the first-prompt injection (the child is
    // blocked inside its turn) but before it finalizes. The structured branch
    // must deliver it via the bounded delivery turn instead of dropping it.
    const sent = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(sent.status).toBe('accepted');
    gate.release();

    const handle = await spawnPromise;
    const completion = await handle.completion;
    gate.cleanup();

    // The final structured answer reflects the steered instruction.
    expect(completion.result).toContain('"steered":true');
    // The delivery turn's prompt carried the [parent_messages] block.
    const prompts = child.agent.context.history
      .filter((m: { role: string }) => m.role === 'user')
      .map((m: { content: unknown }) => m.content);
    const deliveryPrompt = prompts
      .map((p) => (Array.isArray(p) ? p.map((x: { text: string }) => x.text).join('\n') : String(p)))
      .find((p: string) => p.includes('[parent_messages]'));
    expect(deliveryPrompt).toBeDefined();
    expect(deliveryPrompt).toContain('[directive] reconsider the approach');
  }, 15_000);

  it('keeps the pre-drain structured result when the delivery turn returns no JSON', async () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();
    parent.newEvents();
    await parent.rpc.setPermission({ mode: 'yolo' });
    await child.rpc.setPermission({ mode: 'yolo' });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);

    // Turn 1: a gated Bash call, then the final JSON answer.
    const gate = drainGate();
    child.mockNextResponse({
      type: 'function',
      id: 'tc_bash',
      name: 'Bash',
      arguments: JSON.stringify({ command: gate.command }),
    });
    child.mockNextResponse({ type: 'text', text: '{"ok":true}' });
    // Delivery turn replies in prose (not JSON): the pre-drain result must be
    // preserved so the [structured] contract is not destroyed by delivery.
    child.mockNextResponse({ type: 'text', text: 'Got it, will adjust.' });

    const spawnPromise = host.spawn('coder', {
      parentToolCallId: 'call_1',
      parentToolCallUuid: undefined,
      prompt: 'original prompt',
      description: 'child',
      runInBackground: false,
      signal,
      outputSchema: '{"type":"object"}',
    });
    await gate.waitForStart();
    expect(host.sendMessage('agent-0', 'steer', 'reconsider the approach').status).toBe('accepted');
    gate.release();

    const handle = await spawnPromise;
    const completion = await handle.completion;
    gate.cleanup();

    // The structured answer from the first turn is kept, not the prose ack.
    expect(completion.result).toContain('{"ok":true}');
    expect(completion.result).not.toContain('will adjust');
  }, 15_000);
});
