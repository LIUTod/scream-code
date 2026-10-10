import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { testJian } from '../fixtures/test-jian';
import type { ProviderConfig } from '@scream-code/ltod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { SessionAPIImpl } from '../../src/session/rpc';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';

const MOCK_PROVIDER = {
  type: 'scream',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-permission-grants-'));
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
 * Real-topology verification: the session-level grant list is the main
 * agent's memorize ledger, and revoking through the session (the path the
 * `/grants` command and the SDK RPC take) actually drops it.
 */
describe('session approval grants (real Session)', () => {
  it('lists and revokes main-agent grants through the session and its RPC impl', async () => {
    const workDir = await makeTempDir();
    const sessionDir = await makeTempDir();
    const session = new Session({
      id: 'test-permission-grants',
      jian: testJian.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
      providerManager: testProviderManager(),
    });
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: createScriptedGenerate().generate },
      testProfile(),
    );
    const api = new SessionAPIImpl(session);

    try {
      expect(api.getSessionApprovalGrants({})).toEqual([]);
      expect(api.revokeSessionApprovalGrant({ pattern: 'Bash' })).toBe(false);

      mainAgent.permission.recordApprovalResult({
        turnId: 0,
        toolCallId: 'call_bash',
        toolName: 'Bash',
        action: 'Run a command',
        sessionApprovalRule: 'Bash',
        result: { decision: 'approved', scope: 'session' },
      });

      expect(session.getSessionApprovalGrants()).toEqual(['Bash']);
      expect(api.getSessionApprovalGrants({})).toEqual(['Bash']);

      expect(session.revokeSessionApprovalGrant('Bash')).toBe(true);
      expect(api.getSessionApprovalGrants({})).toEqual([]);
      expect(api.revokeSessionApprovalGrant({ pattern: 'Bash' })).toBe(false);
    } finally {
      await session.close();
    }
  });
});
