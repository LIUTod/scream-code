import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@scream-code/ltod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentProfile } from '../../src/profile';
import type { AgentStatusUpdatedEvent, SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testJian } from '../fixtures/test-jian';

const MOCK_PROVIDER = {
  type: 'scream',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-agent-id-'));
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
  } as unknown as SDKSessionRPC;
}

describe('Session agent ids', () => {
  it('stamps the main agent as main and reports it on status events', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const session = new Session({
      id: 'test-agent-id',
      jian: testJian.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });

    try {
      const { agent: main } = await session.createAgent(
        { type: 'main', generate: createScriptedGenerate().generate },
        testProfile(),
      );
      expect(main.agentId).toBe('main');

      const statuses: AgentStatusUpdatedEvent[] = [];
      main.eventBus.subscribe('agent.status.updated', (event) => {
        statuses.push(event as AgentStatusUpdatedEvent);
      });
      main.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingLevel: 'off' });
      statuses.length = 0;

      main.setRlmMaxDepth(3);
      expect(statuses.at(-1)).toMatchObject({ agentId: 'main', rlmMaxDepth: 3 });

      // A subagent gets the generated session id, and the id is what the
      // status payload would carry for it.
      const { id, agent: sub } = await session.createAgent({ type: 'sub' }, undefined, 'main');
      expect(id).not.toBe('main');
      expect(sub.agentId).toBe(id);
    } finally {
      await session.close();
    }
  });
});
