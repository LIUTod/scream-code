/**
 * The resume payload is sized by what the client renders, not by how large the
 * session grew.
 *
 * `resumeSessionResult` used to pack every agent in the session — with each
 * agent's full `context.history` — into the value it returns. That value
 * crosses the in-process RPC "network", which deep-copies it through
 * `JSON.stringify`; on a large session the string blew past V8's ~537M
 * character limit and the session became permanently unresumable
 * (`[internal] Invalid string length`).
 *
 * The client only ever reads `agents['main']` (session-replay.ts), and only
 * `context.tokenCount` from it (message-replay.ts) — history comes from the
 * on-demand `getContext({ agentId })` channel. These tests pin both halves of
 * that contract so the payload cannot quietly regrow with session size.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  ScreamCore,
  type ApprovalResponse,
  type CoreAPI,
  type CoreRPC,
  type SDKAPI,
} from '../../src';

describe('resume payload', () => {
  let tmp: string;
  let homeDir: string;
  let workDir: string;
  const cores: ScreamCore[] = [];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'scream-resume-payload-'));
    homeDir = join(tmp, 'home');
    workDir = join(tmp, 'work');
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      await Promise.allSettled(Array.from(core.sessions.values(), (session) => session.close()));
    }
    await rm(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('carries the interactive agent only, even when the session has subagents', async () => {
    const { resumed, agentIds } = await resumeSessionWithSubagent('ses_resume_payload_agents');

    // The session itself really did come back with every agent instantiated —
    // the payload is trimmed, not the session.
    expect(new Set(agentIds)).toEqual(new Set(['main', 'agent-0']));

    // ...but the wire payload carries the interactive agent alone: nothing
    // reads a subagent entry, and paying for them is what made the payload
    // scale with session size.
    expect(Object.keys(resumed.agents)).toEqual(['main']);
  }, 60_000);

  it('carries no context history for the interactive agent', async () => {
    const { resumed } = await resumeSessionWithSubagent('ses_resume_payload_context');

    // The client's one context read is token accounting. `history` is fetched
    // on demand via getContext({ agentId }) and must not ride along here — it
    // is by far the largest field the payload could carry.
    expect(resumed.agents['main']?.context).toEqual({ tokenCount: expect.any(Number) });
    expect(resumed.agents['main']?.context).not.toHaveProperty('history');
  }, 60_000);

  /**
   * Creates a session, adds a real subagent the way the agent tool does
   * (createAgent + metadata), then resumes it from a second core and returns
   * both the wire payload and the agents the reopened session instantiated.
   */
  async function resumeSessionWithSubagent(sessionId: string): Promise<{
    resumed: Awaited<ReturnType<CoreRPC['resumeSession']>>;
    agentIds: readonly string[];
  }> {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: sessionId, workDir });

    const live = first.core.sessions.get(created.id);
    expect(live).toBeDefined();
    const { id: subagentId } = await live!.createAgent({ type: 'sub' });
    expect(subagentId).not.toBe('main');
    await live!.flushMetadata();

    const second = await createTestRpc();
    const resumed = await second.rpc.resumeSession({ sessionId: created.id });

    const reopened = second.core.sessions.get(created.id);
    expect(reopened).toBeDefined();
    return { resumed, agentIds: [...reopened!.agents.keys()] };
  }

  async function createTestRpc(): Promise<{
    core: ScreamCore;
    rpc: CoreRPC;
  }> {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new ScreamCore(coreRpc, { homeDir });
    cores.push(core);
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    return { core, rpc };
  }
});
