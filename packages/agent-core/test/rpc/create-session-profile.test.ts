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
    expect(sorted(main.tools.getActiveTools())).toEqual(
      sorted(DEFAULT_AGENT_PROFILES['agent']?.tools ?? []),
    );
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
