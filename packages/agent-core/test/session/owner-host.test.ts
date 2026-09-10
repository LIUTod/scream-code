import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { testJian } from '../fixtures/test-jian';
import type { ProviderConfig } from '@scream-code/ltod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderManager } from '../../src/session/provider-manager';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';

const MOCK_PROVIDER = {
  type: 'scream',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    // Session background writers (metadata, agent dirs) may still settle for a
    // moment after the assertions; retry the recursive remove so cleanup is
    // deterministic (ENOTEMPTY race otherwise).
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-owner-host-'));
  tempDirs.push(dir);
  return dir;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: {
          type: MOCK_PROVIDER.type,
          apiKey: MOCK_PROVIDER.apiKey,
        },
      },
      models: {
        [MOCK_PROVIDER.model]: {
          provider: 'test',
          model: MOCK_PROVIDER.model,
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}

function testProfile(): ResolvedAgentProfile {
  return {
    name: 'test',
    systemPrompt: () => '<system-prompt>',
    tools: [],
  };
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}

/**
 * Real-topology verification: `Session.instantiateAgent` must give every
 * subagent an `ownerHost` pointing at its PARENT's SubagentHost (where it is
 * registered as an active child), while its own `subagentHost` stays its own
 * (for grandchildren). ContactParent mounts against ownerHost.
 */
describe('ownerHost wiring (real Session)', () => {
  it('sets ownerHost to the parent host for subagents, and leaves main without one', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const scripted = createScriptedGenerate();
    const session = new Session({
      id: 'test-owner-host',
      jian: testJian.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });

    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: scripted.generate },
      testProfile(),
    );
    const { agent: child } = await session.createAgent(
      { type: 'sub', generate: scripted.generate },
      testProfile(),
      'main',
    );

    try {
      // Main has no owner.
      expect(mainAgent.ownerHost).toBeUndefined();
      // The child's ownerHost is the MAIN agent's host...
      expect(child.ownerHost).toBe(mainAgent.subagentHost);
      // ...while the child keeps its own host for spawning grandchildren.
      expect(child.subagentHost).toBeDefined();
      expect(child.subagentHost).not.toBe(mainAgent.subagentHost);
    } finally {
      // Stop background writers (metadata flush, cron) before the afterEach
      // removes the session directory.
      await session.close();
    }
  });
});
