import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { SessionSubagentHost } from '../../src/session/subagent-host';
import { SubagentMessageBus } from '../../src/session/subagent-messages';
import { AgentTool } from '../../src/tools/builtin/collaboration/agent';
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
      const deadline = Date.now() + 60_000;
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
    markAgentCapability: vi.fn((agentId: string, mode: string) => {
      const meta = metadataAgents[agentId];
      if (meta === undefined) return;
      metadataAgents[agentId] = { ...meta, capabilityMode: mode as never };
    }),
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
    (host as unknown as { activeChildren: Map<string, unknown> }).activeChildren = new Map([
      ['agent-0', { controller: new AbortController(), runInBackground: false, structured: false }],
    ]);

    const historyLength = child.agent.context.history.length;
    const ok = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(ok.status).toBe('accepted');
    // No live turn, so the message waits in the mailbox instead of the host
    // launching one behind runChild's back.
    expect(ok.delivery).toBe('queued');
    expect(historyLength).toBe(child.agent.context.history.length);
    expect(child.agent.turn.hasActiveTurn).toBe(false);
    const delivered = bus.poll('agent-0');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.operation).toBe('steer');
    expect(delivered[0]!.text).toBe('reconsider the approach');
    expect(delivered[0]!.fromAgentId).toBe('main');

    const foreign = host.sendMessage('nobody', 'queue', 'x');
    expect(foreign.status).toBe('not_found');
  });

  it('deduplicates a retried parent message within the child turn', () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);
    (host as unknown as { activeChildren: Map<string, unknown> }).activeChildren = new Map([
      ['agent-0', { controller: new AbortController(), runInBackground: false, structured: false }],
    ]);
    const resetTurn = (
      host as unknown as { resetChildRequestLimits(id: string): void }
    ).resetChildRequestLimits.bind(host);

    const first = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(first.status).toBe('accepted');
    expect(first.duplicate).not.toBe(true);

    // A retry — the parent re-issuing the same directive — must not reach the
    // child a second time.
    const retry = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(retry.status).toBe('accepted');
    expect(retry.duplicate).toBe(true);
    expect(bus.activeCount('agent-0')).toBe(1);

    // A different message is not a duplicate...
    expect(host.sendMessage('agent-0', 'steer', 'different words').duplicate).not.toBe(true);
    // ...and asking again in a later turn is a legitimate re-ask.
    resetTurn('agent-0');
    expect(host.sendMessage('agent-0', 'steer', 'reconsider the approach').duplicate).not.toBe(true);
  });

  it('does not poison the dedupe key when the mailbox refuses the send', () => {
    const child = testAgent();
    const parent = testAgent();
    parent.configure();
    child.configure();

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);
    (host as unknown as { activeChildren: Map<string, unknown> }).activeChildren = new Map([
      ['agent-0', { controller: new AbortController(), runInBackground: false, structured: false }],
    ]);

    // Fill the mailbox to its in-flight limit.
    for (let index = 0; index < 4; index += 1) {
      expect(host.sendMessage('agent-0', 'queue', `fill-${index}`).status).toBe('accepted');
    }
    const rejected = host.sendMessage('agent-0', 'queue', 'important thing');
    expect(rejected.status).toBe('saturated');

    // A retry of the REJECTED message must be attempted honestly — not
    // swallowed as a duplicate of a message that never reached the mailbox.
    const retry = host.sendMessage('agent-0', 'queue', 'important thing');
    expect(retry.status).toBe('saturated');
    expect(retry.duplicate).not.toBe(true);
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
    // active child with the same shape spawn uses.
    (host as unknown as { activeChildren: Map<string, unknown> }).activeChildren = new Map([
      ['agent-0', { controller: new AbortController(), runInBackground: false, structured: false }],
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

  it('routes structured-output children through the guarded delivery turn', async () => {
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
    // The guarded delivery turn: the JSON guard means the structured contract
    // survives reading the [parent_messages] block.
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
    // Structured children keep the mailbox path: the mid-run fast path would
    // hand them a raw block with no JSON guard.
    const sent = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(sent.status).toBe('accepted');
    expect(sent.delivery).toBe('queued');
    gate.release();

    const handle = await spawnPromise;
    const completion = await handle.completion;
    gate.cleanup();

    // The delivery turn ran and the final structured answer reflects the steer.
    expect(completion.result).toContain('"steered":true');
    const history = child.agent.context.history as readonly { role: string; content: unknown }[];
    const textOf = (content: unknown): string =>
      Array.isArray(content)
        ? content.map((x: { text?: string }) => x.text ?? '').join('\n')
        : String(content);
    const deliveryPrompt = history.find(
      (m) => m.role === 'user' && textOf(m.content).includes('[parent_messages]'),
    );
    expect(deliveryPrompt).toBeDefined();
    expect(textOf(deliveryPrompt!.content)).toContain('[directive] reconsider the approach');
  }, 15_000);

  it('falls back to the mailbox when the steer buffer is full', async () => {
    const child = testAgent();
    const parent = testAgent();
    const signal = new AbortController().signal;
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

    const gate = drainGate();
    const longAnswer = `done. ${'x'.repeat(220)}`;
    child.mockNextResponse({
      type: 'function',
      id: 'tc_bash',
      name: 'Bash',
      arguments: JSON.stringify({ command: gate.command }),
    });
    child.mockNextResponse({ type: 'text', text: longAnswer });
    // The delivery turn that carries the mailbox fallback message.
    child.mockNextResponse({ type: 'text', text: `done. acknowledged ${'x'.repeat(200)}` });

    const spawnPromise = host.spawn('coder', {
      parentToolCallId: 'call_1',
      parentToolCallUuid: undefined,
      prompt: 'original prompt',
      description: 'child',
      runInBackground: false,
      signal,
    });
    await gate.waitForStart();
    // Fill the steer buffer to the shared in-flight budget while the turn runs.
    for (let index = 0; index < 4; index += 1) {
      child.agent.turn.steer([{ type: 'text', text: `pre-${index}` }], {
        kind: 'system_trigger',
        name: 'parent_message',
      });
    }
    // The fifth message cannot join the buffer; it keeps the mailbox contract
    // instead of being dropped.
    const sent = host.sendMessage('agent-0', 'steer', 'one more');
    expect(sent.status).toBe('accepted');
    expect(sent.delivery).toBe('queued');
    expect(bus.activeCount('agent-0')).toBe(1);
    gate.release();

    const handle = await spawnPromise;
    const completion = await handle.completion;
    gate.cleanup();
    expect(completion.result).toContain('done.');
    // The overflow message arrived via the mailbox + delivery turn, not lost.
    // It keeps its steer priority, so it renders as a directive.
    const history = child.agent.context.history as readonly { role: string; content: unknown }[];
    const textOf = (content: unknown): string =>
      Array.isArray(content)
        ? content.map((x: { text?: string }) => x.text ?? '').join('\n')
        : String(content);
    expect(
      history.some((m) => m.role === 'user' && textOf(m.content).includes('[directive] one more')),
    ).toBe(true);
  }, 15_000);

  it('re-flushes a steer that arrives while the Stop hook is awaiting', async () => {
    const child = testAgent();
    const parent = testAgent();
    const signal = new AbortController().signal;
    parent.configure();
    child.configure();
    parent.newEvents();
    await parent.rpc.setPermission({ mode: 'yolo' });
    await child.rpc.setPermission({ mode: 'yolo' });

    // A Stop hook that blocks until the test releases it, opening the window
    // between the initial steer flush and the turn ending. Without the
    // re-flush, a steer landing in that window is discarded by end() even
    // though the parent already received a "delivered" acknowledgement.
    let hookEntered!: () => void;
    let releaseHook!: () => void;
    const entered = new Promise<void>((resolve) => {
      hookEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    (child.agent as unknown as { hooks: unknown }).hooks = {
      triggerBlock: async (block: string) => {
        if (block === 'Stop') {
          hookEntered();
          await release;
        }
        return undefined;
      },
    };

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': { homedir: '/tmp/x', type: 'sub', parentAgentId: 'main' },
    });
    const bus = new SubagentMessageBus();
    const host = new SessionSubagentHost(session, 'main', undefined, undefined, bus);

    child.mockNextResponse({ type: 'text', text: `first answer ${'x'.repeat(220)}` });
    child.mockNextResponse({ type: 'text', text: `second answer after steer ${'x'.repeat(220)}` });

    const spawnPromise = host.spawn('coder', {
      parentToolCallId: 'call_1',
      parentToolCallUuid: undefined,
      prompt: 'original prompt',
      description: 'child',
      runInBackground: false,
      signal,
    });

    // The turn is inside the Stop hook: still active, but the initial flush
    // has already happened.
    await entered;
    const sent = host.sendMessage('agent-0', 'steer', 'arrived during stop hook');
    expect(sent.status).toBe('accepted');
    expect(sent.delivery).toBe('mid-run');
    releaseHook();

    const handle = await spawnPromise;
    const completion = await handle.completion;

    const history = child.agent.context.history as readonly { role: string; content: unknown }[];
    const textOf = (content: unknown): string =>
      Array.isArray(content)
        ? content.map((x: { text?: string }) => x.text ?? '').join('\n')
        : String(content);
    // The steered turn actually continued and delivered the message.
    expect(
      history.some(
        (m) => m.role === 'user' && textOf(m.content).includes('[directive] arrived during stop hook'),
      ),
    ).toBe(true);
    expect(completion.result).toContain('second answer after steer');
  }, 15_000);

  it('injects a mid-run steer into an ordinary running turn without aborting the tool', async () => {
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

    const gate = drainGate();
    child.mockNextResponse({
      type: 'function',
      id: 'tc_bash',
      name: 'Bash',
      arguments: JSON.stringify({ command: gate.command }),
    });
    // Answer produced after the steer joins the turn (long enough that no
    // summary-expansion turn follows).
    child.mockNextResponse({ type: 'text', text: `finished, applying the steer. ${'x'.repeat(220)}` });

    const spawnPromise = host.spawn('coder', {
      parentToolCallId: 'call_1',
      parentToolCallUuid: undefined,
      prompt: 'original prompt',
      description: 'child',
      runInBackground: false,
      signal,
    });
    await gate.waitForStart();
    const sent = host.sendMessage('agent-0', 'steer', 'reconsider the approach');
    expect(sent.status).toBe('accepted');
    expect(sent.delivery).toBe('mid-run');
    gate.release();

    const handle = await spawnPromise;
    const completion = await handle.completion;
    gate.cleanup();

    const history = child.agent.context.history as readonly { role: string; content: unknown }[];
    const textOf = (content: unknown): string =>
      Array.isArray(content)
        ? content.map((x: { text?: string }) => x.text ?? '').join('\n')
        : String(content);
    // The in-flight tool ran to completion: its result is in the history and the
    // steer was injected only after it — had the tool been aborted, the steer
    // would have been injected instead of (before) the tool result.
    const toolResultAt = history.findIndex((m) => m.role === 'tool');
    expect(toolResultAt).toBeGreaterThan(-1);
    // The steer block landed in the same turn, after the tool result and before
    // the final answer.
    const injectedAt = history.findIndex(
      (m) => m.role === 'user' && textOf(m.content).includes('[parent_messages]'),
    );
    const answeredAt = history.findIndex(
      (m) => m.role === 'assistant' && textOf(m.content).includes('finished, applying the steer'),
    );
    expect(injectedAt).toBeGreaterThan(toolResultAt);
    expect(answeredAt).toBeGreaterThan(injectedAt);
    expect(textOf(history[injectedAt]!.content)).toContain('[directive] reconsider the approach');
    expect(completion.result).toContain('finished, applying the steer');
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
    // A queue message keeps the mailbox path even while the child is running, so
    // this still exercises the structured delivery turn.
    const sent = host.sendMessage('agent-0', 'queue', 'reconsider the approach');
    expect(sent.status).toBe('accepted');
    expect(sent.delivery).toBe('queued');
    gate.release();

    const handle = await spawnPromise;
    const completion = await handle.completion;
    gate.cleanup();

    // The structured answer from the first turn is kept, not the prose ack.
    expect(completion.result).toContain('{"ok":true}');
    expect(completion.result).not.toContain('will adjust');
  }, 15_000);

  it('delivers a message queued after the summary-expansion turn spent its budget', async () => {
    const child = testAgent();
    const parent = testAgent();
    const signal = new AbortController().signal;
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

    const longSummary = 's'.repeat(240);
    const firstGate = drainGate();
    const expansionGate = drainGate();
    child.mockNextResponse({
      type: 'function',
      id: 'tc_1',
      name: 'Bash',
      arguments: JSON.stringify({ command: firstGate.command }),
    });
    // A summary too short to pass on its own: the expansion turn runs and spends
    // the summary budget.
    child.mockNextResponse({ type: 'text', text: 'short.' });
    child.mockNextResponse({
      type: 'function',
      id: 'tc_2',
      name: 'Bash',
      arguments: JSON.stringify({ command: expansionGate.command }),
    });
    child.mockNextResponse({ type: 'text', text: longSummary });
    // Answer to the delivery turn that only the separate message budget allows.
    child.mockNextResponse({ type: 'text', text: `${longSummary} acknowledged` });

    const spawnPromise = host.spawn('coder', {
      parentToolCallId: 'call_1',
      parentToolCallUuid: undefined,
      prompt: 'original prompt',
      description: 'child',
      runInBackground: false,
      signal,
    });

    await firstGate.waitForStart();
    firstGate.release();
    // Wait until the child sits inside the expansion turn's gated Bash. That
    // turn already polled the mailbox, so this message can only arrive through a
    // further turn — the one the shared budget used to deny it.
    await expansionGate.waitForStart();
    const sent = host.sendMessage('agent-0', 'queue', 'late but important');
    expect(sent.status).toBe('accepted');
    expect(sent.delivery).toBe('queued');
    expansionGate.release();

    const handle = await spawnPromise;
    const completion = await handle.completion;
    firstGate.cleanup();
    expansionGate.cleanup();

    const history = child.agent.context.history as readonly { role: string; content: unknown }[];
    const textOf = (content: unknown): string =>
      Array.isArray(content)
        ? content.map((x: { text?: string }) => x.text ?? '').join('\n')
        : String(content);
    const injected = history.find(
      (m) => m.role === 'user' && textOf(m.content).includes('[parent_messages]'),
    );
    expect(injected).toBeDefined();
    expect(textOf(injected!.content)).toContain('[message] late but important');
    // The delivery turn really ran: the child answered after reading the message.
    expect(completion.result).toContain('acknowledged');
  }, 30_000);

  it('wakes a blocked foreground Agent call on a child request and hands the child to the background', async () => {
    const child = testAgent({ type: 'sub' });
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
    (child.agent as unknown as { ownerHost?: SessionSubagentHost }).ownerHost = host;
    // The child_request wake launches a parent turn while the parent is idle
    // (mid-turn it is flushed at the parent's next step boundary instead); give
    // that turn a scripted answer.
    parent.mockNextResponse({ type: 'text', text: 'acknowledged.' });

    const gate = drainGate();
    child.mockNextResponse({
      type: 'function',
      id: 'tc_cp',
      name: 'ContactParent',
      arguments: JSON.stringify({
        request_type: 'info',
        message: 'which branch should I target?',
      }),
    });
    child.mockNextResponse({
      type: 'function',
      id: 'tc_bash',
      name: 'Bash',
      arguments: JSON.stringify({ command: gate.command }),
    });
    child.mockNextResponse({ type: 'text', text: `finished. ${'x'.repeat(220)}` });

    const completions: Promise<{ result: string }>[] = [];
    const backgroundManager = {
      registerAgentTask: vi.fn((completion: Promise<{ result: string }>) => {
        completions.push(completion);
        return 'task-42';
      }),
    };
    // Foreground call, no timeout: the wait can only end early through the
    // request leg.
    const tool = new AgentTool(host, backgroundManager as never);
    const execution = tool.resolveExecution({
      prompt: 'original prompt',
      description: 'needs input',
    } as never) as { execute(ctx: unknown): Promise<{ output: string; isError?: boolean }> };
    const execPromise = execution.execute({
      toolCallId: 'call_1',
      signal: new AbortController().signal,
    } as never);

    // The child is parked in the gated Bash: its request was accepted in an
    // earlier step, and its completion cannot settle before the gate opens, so
    // only the request wake can resolve the tool call.
    await gate.waitForStart();
    const resolvedWhileChildParked = await Promise.race([
      execPromise.then(() => true as const),
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, 2_000);
      }),
    ]);

    const internals = host as unknown as {
      activeChildren: Map<string, { runInBackground: boolean }>;
      childRequestWaiters: Map<string, unknown>;
    };
    // Read the handoff's side effects while the child is still parked, so the
    // child's own teardown cannot race these observations.
    const flippedToBackground = internals.activeChildren.get('agent-0')?.runInBackground;
    const wakeRegistrations = internals.childRequestWaiters.size;
    // Release before asserting: in the no-wake state the tool only settles once
    // the child runs to completion, and the gate has to open for that.
    gate.release();
    const output = await execPromise;

    expect(resolvedWhileChildParked).toBe(true);
    expect(output.isError).toBeUndefined();
    expect(output.output).toContain('status: backgrounded');
    expect(output.output).toContain('task_id: task-42');
    expect(output.output).not.toContain('status: completed');
    // The request path names the reply route for the still-running child.
    expect(output.output).toContain('SendSubagentMessage');
    expect(output.output).toContain('TaskOutput(task_id="task-42", block=true)');
    expect(backgroundManager.registerAgentTask).toHaveBeenCalledWith(
      expect.anything(),
      'needs input',
      expect.objectContaining({ agentId: 'agent-0', subagentType: 'coder' }),
    );
    // The handoff flipped the child to the background lifecycle and the wait
    // released its wake-up registration.
    expect(flippedToBackground).toBe(true);
    expect(wakeRegistrations).toBe(0);
    // Nothing was aborted: the child still runs to its final answer.
    const completion = await completions[0]!;
    gate.cleanup();
    expect(completion.result).toContain('finished.');
  }, 20_000);

  it('steers the still-running child mid-run after the request handoff', async () => {
    const child = testAgent({ type: 'sub' });
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
    (child.agent as unknown as { ownerHost?: SessionSubagentHost }).ownerHost = host;
    parent.mockNextResponse({ type: 'text', text: 'acknowledged.' });

    const gate = drainGate();
    child.mockNextResponse({
      type: 'function',
      id: 'tc_cp',
      name: 'ContactParent',
      arguments: JSON.stringify({
        request_type: 'info',
        message: 'which branch should I target?',
      }),
    });
    child.mockNextResponse({
      type: 'function',
      id: 'tc_bash',
      name: 'Bash',
      arguments: JSON.stringify({ command: gate.command }),
    });
    child.mockNextResponse({ type: 'text', text: `finished with the instruction. ${'x'.repeat(200)}` });

    const completions: Promise<{ result: string }>[] = [];
    const backgroundManager = {
      registerAgentTask: vi.fn((completion: Promise<{ result: string }>) => {
        completions.push(completion);
        return 'task-43';
      }),
    };
    const tool = new AgentTool(host, backgroundManager as never);
    const execution = tool.resolveExecution({
      prompt: 'original prompt',
      description: 'needs input',
    } as never) as { execute(ctx: unknown): Promise<{ output: string; isError?: boolean }> };
    const execPromise = execution.execute({
      toolCallId: 'call_1',
      signal: new AbortController().signal,
    } as never);

    await gate.waitForStart();
    const resolvedWhileChildParked = await Promise.race([
      execPromise.then(() => true as const),
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, 2_000);
      }),
    ]);

    // The parent received the request: the idle parent's wake-up turn carries
    // the notification text into its next LLM input.
    await parent.untilTurnEnd();
    const parentInput = JSON.stringify(parent.lastLlmInput());
    expect(parentInput).toContain('child_request');
    expect(parentInput).toContain('which branch should I target?');

    // The parent answers while the child still runs — a steer into the live
    // turn, no resume and no waiting for the child to finish.
    const sent = host.sendMessage('agent-0', 'steer', 'Target the release branch.');
    expect(sent.status).toBe('accepted');
    expect(sent.delivery).toBe('mid-run');

    gate.release();
    const output = await execPromise;
    const completion = await completions[0]!;
    gate.cleanup();

    expect(resolvedWhileChildParked).toBe(true);
    expect(output.output).toContain('status: backgrounded');

    // The reply landed inside the running turn at its next step boundary, and
    // the child completed normally afterwards.
    const history = child.agent.context.history as readonly { role: string; content: unknown }[];
    const textOf = (content: unknown): string =>
      Array.isArray(content)
        ? content.map((x: { text?: string }) => x.text ?? '').join('\n')
        : String(content);
    const injectedAt = history.findIndex(
      (m) => m.role === 'user' && textOf(m.content).includes('[parent_messages]'),
    );
    expect(injectedAt).toBeGreaterThan(-1);
    expect(textOf(history[injectedAt]!.content)).toContain('[directive] Target the release branch.');
    expect(completion.result).toContain('finished with the instruction.');
  }, 20_000);
});
