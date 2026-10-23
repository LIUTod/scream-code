/**
 * SDK surface the bot runtime depends on: session profiles, exact work dirs,
 * the host tool callback, and tool-registry forwarding.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ScreamHarness, type ToolCallRequest, type ToolCallResponse } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeTestModelConfig(homeDir: string): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
[providers.local]
type = "scream"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."sdk-test-model"]
provider = "local"
model = "sdk-test-model"
max_context_size = 1000
`,
    'utf-8',
  );
}

interface ToolCallRpc {
  toolCall(request: ToolCallRequest): Promise<ToolCallResponse>;
}

/** `rpc` is private to ScreamHarness; the SDK hosts one per instance. */
function sdkRpcOf(harness: ScreamHarness): ToolCallRpc {
  return (harness as unknown as { readonly rpc: ToolCallRpc }).rpc;
}

interface CoreMainAgent {
  readonly config: {
    readonly cwd: string;
    readonly profileName?: string;
    readonly systemPrompt: string;
  };
  readonly tools: { getActiveTools(): readonly string[] };
}

function mainAgentOf(harness: ScreamHarness, sessionId: string): CoreMainAgent {
  const core = (
    harness as unknown as {
      readonly rpc: {
        readonly core: {
          readonly sessions: ReadonlyMap<
            string,
            { readonly agents: ReadonlyMap<string, CoreMainAgent> }
          >;
        };
      };
    }
  ).rpc.core;
  const agent = core.sessions.get(sessionId)?.agents.get('main');
  if (agent === undefined) throw new Error(`main agent missing for ${sessionId}`);
  return agent;
}

describe('SDK host tool callback', () => {
  it('routes in-band tool calls to onToolCall', async () => {
    const homeDir = await makeTempDir('scream-sdk-toolcall-home-');
    const requests: ToolCallRequest[] = [];
    const harness = new ScreamHarness({
      identity: TEST_IDENTITY,
      homeDir,
      onToolCall: async (request) => {
        requests.push(request);
        return { output: `handled ${request.toolCallId}` };
      },
    });

    try {
      const response = await sdkRpcOf(harness).toolCall({
        toolCallId: 'call_1',
        args: { text: 'hello' },
      });

      expect(response).toEqual({ output: 'handled call_1' });
      expect(requests).toEqual([{ toolCallId: 'call_1', args: { text: 'hello' } }]);
    } finally {
      await harness.close();
    }
  });

  it('turns a throwing handler into a tool error instead of rejecting', async () => {
    const homeDir = await makeTempDir('scream-sdk-toolcall-home-');
    const harness = new ScreamHarness({
      identity: TEST_IDENTITY,
      homeDir,
      onToolCall: async () => {
        throw new Error('boom');
      },
    });

    try {
      await expect(
        sdkRpcOf(harness).toolCall({ toolCallId: 'call_throw', args: {} }),
      ).resolves.toEqual({ output: 'SDK custom tool handler failed: boom', isError: true });
    } finally {
      await harness.close();
    }
  });

  it('keeps the historical rejection when no onToolCall is configured', async () => {
    const homeDir = await makeTempDir('scream-sdk-toolcall-home-');
    const harness = new ScreamHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await expect(
        sdkRpcOf(harness).toolCall({ toolCallId: 'call_2', args: {} }),
      ).resolves.toEqual({
        output: 'SDK custom tool calls are not supported: call_2',
        isError: true,
      });
    } finally {
      await harness.close();
    }
  });
});

describe('SDK session tools', () => {
  it('forwards registerTool, unregisterTool, and setActiveTools to the core', async () => {
    const homeDir = await makeTempDir('scream-sdk-tools-home-');
    await writeTestModelConfig(homeDir);
    const workDir = await makeTempDir('scream-sdk-tools-work-');
    const harness = new ScreamHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_tool_registry',
        workDir,
        model: 'sdk-test-model',
      });
      const main = mainAgentOf(harness, session.id);

      await session.registerTool({
        name: 'hello_tool',
        description: 'Says hello',
        parameters: { type: 'object', properties: {} },
      });
      expect(main.tools.getActiveTools()).toContain('hello_tool');

      await session.setActiveTools(['Read', 'hello_tool']);
      expect(main.tools.getActiveTools().toSorted()).toEqual(['Read', 'hello_tool']);

      await session.unregisterTool('hello_tool');
      expect(main.tools.getActiveTools()).toEqual(['Read']);
      await expect(session.unregisterTool('  ')).rejects.toMatchObject({
        name: 'ScreamError',
      });
    } finally {
      await harness.close();
    }
  });
});

describe('SDK session profile and exact work dir', () => {
  it('passes the profile through createSession and keeps it on resume', async () => {
    const homeDir = await makeTempDir('scream-sdk-profile-home-');
    await writeTestModelConfig(homeDir);
    const root = await makeTempDir('scream-sdk-profile-root-');
    await mkdir(join(root, '.git'));
    const nested = join(root, 'research');
    await mkdir(nested);
    const role = 'You are the research bot: cite every claim.';

    const created = new ScreamHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      const session = await created.createSession({
        id: 'ses_sdk_profile',
        workDir: nested,
        exactWorkDir: true,
        model: 'sdk-test-model',
        profile: { name: 'research-bot', systemPrompt: role, activeTools: ['Read', 'Grep'] },
      });

      // exactWorkDir: the bot root stays `nested` instead of walking up to `.git`.
      expect(session.workDir).toBe(nested);
      const main = mainAgentOf(created, session.id);
      expect(main.config.cwd).toBe(nested);
      expect(main.config.profileName).toBe('research-bot');
      expect(main.config.systemPrompt.endsWith(`\n\n${role}`)).toBe(true);
      expect(main.tools.getActiveTools().toSorted()).toEqual(['Grep', 'Read']);
    } finally {
      await created.close();
    }

    const resumedHarness = new ScreamHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      const resumed = await resumedHarness.resumeSession({ id: 'ses_sdk_profile' });
      expect(resumed.workDir).toBe(nested);
      const main = mainAgentOf(resumedHarness, resumed.id);
      expect(main.config.cwd).toBe(nested);
      expect(main.config.profileName).toBe('research-bot');
      expect(main.config.systemPrompt).toContain(role);
      expect(main.tools.getActiveTools().toSorted()).toEqual(['Grep', 'Read']);
    } finally {
      await resumedHarness.close();
    }
  });
});
