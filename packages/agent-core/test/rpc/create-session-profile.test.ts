/**
 * `createSession` session profile + exact work dir.
 *
 * The default path must stay byte-for-byte identical to the pre-profile
 * behavior; a supplied profile is composed onto the built-in agent profile and
 * persisted so resume() re-applies it.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRPC, ScreamCore, type ApprovalResponse, type CoreAPI, type SDKAPI } from '../../src';
import type { Agent } from '../../src/agent';
import { DEFAULT_AGENT_PROFILES, prepareSystemPromptContext } from '../../src/profile';
import { DEFERRED_GROUPS } from '../../src/tools/builtin/deferred-tools';
import { readSessionAgentProfile } from '../../src/session';

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

const TEST_CONFIG = `default_model = "profile-test-model"

[providers.test]
type = "scream"
api_key = "test-key"

[models."profile-test-model"]
provider = "test"
model = "profile-test-model"
max_context_size = 100000
`;

interface PersistedProfile {
  name?: string;
  systemPrompt?: string;
  activeTools?: string[];
}

interface PersistedState {
  custom?: { agentProfile?: PersistedProfile };
}

async function createCore(homeDir: string) {
  const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
  const core = new ScreamCore(coreRpc, { homeDir });
  const rpc = await sdkRpc({
    emitEvent: vi.fn(),
    requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '' })),
  });
  return { core, rpc };
}

function mainAgentOf(core: ScreamCore, sessionId: string): Agent {
  const agent = core.sessions.get(sessionId)?.agents.get('main');
  if (agent === undefined) throw new Error(`main agent missing for ${sessionId}`);
  return agent;
}

async function readPersistedState(sessionDir: string): Promise<PersistedState> {
  return JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')) as PersistedState;
}

function sorted(names: readonly string[]): string[] {
  return names.toSorted();
}

/**
 * Renders the built-in agent prompt through the same inputs `Agent.useProfile`
 * supplies. The prompt embeds the current timestamp, so it is read back out of
 * the live prompt and fed to the renderer — otherwise the expected value would
 * differ by the milliseconds between render and assertion.
 */
async function expectedBasePrompt(agent: Agent): Promise<string> {
  const now = /ISO format is `([^`]+)`/.exec(agent.config.systemPrompt)?.[1];
  if (now === undefined) throw new Error('system prompt is missing the ISO timestamp');
  const context = await prepareSystemPromptContext(agent.jian);
  const base = DEFAULT_AGENT_PROFILES['agent'];
  if (base === undefined) throw new Error('default agent profile is missing');
  return base.systemPrompt({
    osEnv: agent.jian.osEnv,
    cwd: agent.config.cwd,
    skills: agent.skills?.registry,
    cwdListing: context.cwdListing,
    agentsMd: context.agentsMd,
    now,
  });
}

describe('createSession session profile', () => {
  it('keeps the default session byte-identical and pins nothing', async () => {
    const homeDir = await makeTempDir('scream-profile-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const workDir = await makeTempDir('scream-profile-work-');
    const { core, rpc } = await createCore(homeDir);

    const created = await rpc.createSession({ id: 'ses_default_profile', workDir });
    const main = mainAgentOf(core, created.id);

    expect(main.config.profileName).toBe('agent');
    expect(main.config.systemPrompt).toBe(await expectedBasePrompt(main));
    // The deferred-tool portal reshapes the profile list: the low-frequency
    // group names are held back and DiscoverTools fronts them. MCP patterns
    // are not part of the deferral — they pass through untouched.
    const deferredNames = new Set(DEFERRED_GROUPS.flatMap((group) => [...group.toolNames]));
    const expectedActive = (DEFAULT_AGENT_PROFILES['agent']?.tools ?? [])
      .filter((name) => !deferredNames.has(name))
      .concat('DiscoverTools');
    expect(sorted(main.tools.getActiveTools())).toEqual(sorted(expectedActive));
    expect((await readPersistedState(created.sessionDir)).custom).toEqual({});
  });

  it('appends the role text, replaces active tools, and persists the profile', async () => {
    const homeDir = await makeTempDir('scream-profile-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const workDir = await makeTempDir('scream-profile-work-');
    const { core, rpc } = await createCore(homeDir);
    const role = 'You are the research bot: answer with sources.';

    const created = await rpc.createSession({
      id: 'ses_bot_profile',
      workDir,
      profile: { name: 'research-bot', systemPrompt: role, activeTools: ['Read', 'Grep'] },
    });
    const main = mainAgentOf(core, created.id);

    expect(main.config.profileName).toBe('research-bot');
    expect(main.config.systemPrompt).toBe(`${await expectedBasePrompt(main)}\n\n${role}`);
    // An explicit `activeTools` list is an exact contract: no portal shaping.
    expect(sorted(main.tools.getActiveTools())).toEqual(['Grep', 'Read']);
    expect((await readPersistedState(created.sessionDir)).custom?.agentProfile).toEqual({
      name: 'research-bot',
      systemPrompt: role,
      activeTools: ['Read', 'Grep'],
    });
  });

  it('re-applies the persisted profile on resume, including edits made between runs', async () => {
    const homeDir = await makeTempDir('scream-profile-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const workDir = await makeTempDir('scream-profile-work-');
    const { core, rpc } = await createCore(homeDir);

    const created = await rpc.createSession({
      id: 'ses_bot_resume',
      workDir,
      profile: { name: 'research-bot', systemPrompt: 'role v1', activeTools: ['Read'] },
    });
    await rpc.closeSession({ sessionId: created.id });

    const statePath = join(created.sessionDir, 'state.json');
    const state = await readPersistedState(created.sessionDir);
    if (state.custom?.agentProfile === undefined) {
      throw new Error('profile was not persisted');
    }
    state.custom.agentProfile.systemPrompt = 'role v2';
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');

    const resumed = await rpc.resumeSession({ sessionId: created.id });
    const main = mainAgentOf(core, created.id);

    expect(resumed.sessionMetadata.custom?.['agentProfile']).toMatchObject({
      systemPrompt: 'role v2',
    });
    expect(main.config.profileName).toBe('research-bot');
    expect(main.config.systemPrompt).toContain('role v2');
    expect(main.config.systemPrompt).not.toContain('role v1');
    // The pinned profile's explicit activeTools list survives the resume
    // exactly — the portal never reshapes it.
    expect(sorted(main.tools.getActiveTools())).toEqual(['Read']);
  });
});

describe('readSessionAgentProfile', () => {
  it('degrades malformed input to undefined', () => {
    for (const value of [
      undefined,
      null,
      'research-bot',
      42,
      [],
      {},
      { name: '   ' },
      { activeTools: [1, 2] },
    ]) {
      expect(readSessionAgentProfile(value)).toBeUndefined();
    }
  });

  it('keeps name, systemPrompt and activeTools and drops unknown fields', () => {
    expect(
      readSessionAgentProfile({
        name: 'research-bot',
        systemPrompt: ' role ',
        activeTools: ['Read'],
        base: 'coder',
      }),
    ).toEqual({ name: 'research-bot', systemPrompt: 'role', activeTools: ['Read'] });
  });
});

describe('createSession exactWorkDir', () => {  it('skips the ancestor walk only when exactWorkDir is set', async () => {
    const homeDir = await makeTempDir('scream-exact-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const root = await makeTempDir('scream-exact-root-');
    await mkdir(join(root, '.git'));
    const nested = join(root, 'bots', 'research');
    await mkdir(nested, { recursive: true });
    const { core, rpc } = await createCore(homeDir);

    const walked = await rpc.createSession({ id: 'ses_walk_up', workDir: nested });
    expect(walked.workDir).toBe(root);
    expect(mainAgentOf(core, walked.id).config.cwd).toBe(root);

    const exact = await rpc.createSession({
      id: 'ses_exact',
      workDir: nested,
      exactWorkDir: true,
    });
    expect(exact.workDir).toBe(nested);
    expect(mainAgentOf(core, exact.id).config.cwd).toBe(nested);
    // Distinct roots are keyed into distinct session directories.
    expect(exact.sessionDir).not.toBe(walked.sessionDir);
  });
});

describe('createSession permission deny rules', () => {
  function toolContext(agent: Agent, name: string, args: Record<string, unknown>) {
    return {
      turnId: '0',
      stepNumber: 1,
      signal: new AbortController().signal,
      llm: {},
      args,
      toolCall: { type: 'function', id: 'call_deny', name, arguments: JSON.stringify(args) },
      execution: {
        description: `call ${name}`,
        display: { kind: 'other' },
        accesses: [],
        approvalRule: name,
        // The real Bash tool resolves command-family patterns; the harness
        // mirrors that so deny rules with an argument glob can match.
        matchesRule:
          name === 'Bash' && typeof args['command'] === 'string'
            ? (pattern: string) => {
                const command = args['command'] as string;
                if (pattern.endsWith('*')) return command.startsWith(pattern.slice(0, -1));
                return command === pattern;
              }
            : undefined,
        execute: async () => ({ output: '' }),
      },
    } as never;
  }

  it('maps the host deny list onto session deny rules that fire in yolo', async () => {
    const homeDir = await makeTempDir('scream-deny-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const workDir = await makeTempDir('scream-deny-work-');
    const { core, rpc } = await createCore(homeDir);
    let createdId = '';

    try {
      const created = await rpc.createSession({
        workDir,
        permission: 'yolo',
        permissionDenyRules: ['Bash'],
      });
      createdId = created.id;
      const agent = mainAgentOf(core, created.id);

      expect(agent.permission.mode).toBe('yolo');
      expect(agent.permission.rules).toEqual([
        {
          decision: 'deny',
          scope: 'project',
          pattern: 'Bash',
          reason: 'denied by the session host',
        },
      ]);
      // Deny rules outrank the mode: yolo would otherwise approve this call.
      await expect(
        agent.permission.beforeToolCall(
          toolContext(agent, 'Bash', { command: 'printf blocked', timeout: 60 }),
        ),
      ).resolves.toMatchObject({
        block: true,
        reason: expect.stringContaining('denied by the session host'),
      });
      // Tools outside the deny list are unaffected.
      await expect(
        agent.permission.beforeToolCall(toolContext(agent, 'Read', { path: 'README.md' })),
      ).resolves.toBeUndefined();
    } finally {
      await core.sessions.get(createdId)?.close();
    }
  });

  it('reapplies host deny rules on resume', async () => {
    const homeDir = await makeTempDir('scream-resume-deny-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const workDir = await makeTempDir('scream-resume-deny-work-');
    const { core, rpc } = await createCore(homeDir);

    try {
      const created = await rpc.createSession({
        workDir,
        permission: 'yolo',
        permissionDenyRules: ['Bash'],
      });
      await core.sessions.get(created.id)?.close();

      // A resumed session is rebuilt, so the host must send its deny list again.
      const resumed = await rpc.resumeSession({
        sessionId: created.id,
        permissionDenyRules: ['Bash'],
      });
      const agent = mainAgentOf(core, resumed.id);

      expect(agent.permission.rules).toEqual([
        {
          decision: 'deny',
          scope: 'project',
          pattern: 'Bash',
          reason: 'denied by the session host',
        },
      ]);
      await expect(
        agent.permission.beforeToolCall(
          toolContext(agent, 'Bash', { command: 'printf still-blocked', timeout: 60 }),
        ),
      ).resolves.toMatchObject({
        block: true,
        reason: expect.stringContaining('denied by the session host'),
      });
      await core.sessions.get(resumed.id)?.close();
    } finally {
      /* temp dirs are removed by afterEach */
    }
  });

  it('denies a command family from the translated CLI shorthand', async () => {
    const homeDir = await makeTempDir('scream-family-deny-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const workDir = await makeTempDir('scream-family-deny-work-');
    const { core, rpc } = await createCore(homeDir);

    try {
      // `Bash(git:*)` in a --disallowedTools list arrives here as `Bash(git *)`.
      const created = await rpc.createSession({
        workDir,
        permission: 'yolo',
        permissionDenyRules: ['Bash(git *)'],
      });
      const agent = mainAgentOf(core, created.id);

      await expect(
        agent.permission.beforeToolCall(
          toolContext(agent, 'Bash', { command: 'git push origin main', timeout: 60 }),
        ),
      ).resolves.toMatchObject({ block: true });
      await expect(
        agent.permission.beforeToolCall(
          toolContext(agent, 'Bash', { command: 'printf allowed', timeout: 60 }),
        ),
      ).resolves.toBeUndefined();
      await core.sessions.get(created.id)?.close();
    } finally {
      /* temp dirs are removed by afterEach */
    }
  });

  it('adds no rules when the host sends no deny list', async () => {
    const homeDir = await makeTempDir('scream-nodeny-home-');
    await writeFile(join(homeDir, 'config.toml'), TEST_CONFIG, 'utf-8');
    const workDir = await makeTempDir('scream-nodeny-work-');
    const { core, rpc } = await createCore(homeDir);
    let createdId = '';

    try {
      const created = await rpc.createSession({ workDir, permission: 'yolo' });
      createdId = created.id;
      expect(mainAgentOf(core, created.id).permission.rules).toHaveLength(0);
    } finally {
      await core.sessions.get(createdId)?.close();
    }
  });
});
