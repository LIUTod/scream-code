import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { UserPrefsInjector } from '../../../src/agent/injection/user-prefs';
import type { ContextMessage } from '../../../src/agent/context/types';
import { testJian } from '../../fixtures/test-jian';

const PREFS_CONTENT = [
  '# USER PREFERENCES (set via /like — HIGHEST PRIORITY)',
  '',
  '- Nickname: address the user as "Alex".',
  '- Tone: respond in friendly tone.',
].join('\n');

interface StubState {
  history: ContextMessage[];
  systemPrompt?: string;
}

function makeAgent(state: StubState): Agent {
  return {
    type: 'main',
    jian: testJian,
    config: { systemPrompt: state.systemPrompt ?? '' },
    context: {
      history: state.history,
      appendSystemReminder: (content: string, origin: unknown) => {
        state.history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin: origin as ContextMessage['origin'],
        });
      },
    },
  } as unknown as Agent;
}

function userPrompt(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function assistant(text: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

describe('UserPrefsInjector', () => {
  let homeDir: string;
  const ORIGINAL_HOME_ENV = process.env['SCREAM_CODE_HOME'];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'scream-user-prefs-'));
    process.env['SCREAM_CODE_HOME'] = homeDir;
  });

  afterEach(async () => {
    if (ORIGINAL_HOME_ENV === undefined) {
      delete process.env['SCREAM_CODE_HOME'];
    } else {
      process.env['SCREAM_CODE_HOME'] = ORIGINAL_HOME_ENV;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  it('does not inject when user-prefs.md is absent', async () => {
    const state: StubState = { history: [] };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    await injector.inject();

    expect(state.history).toHaveLength(0);
  });

  it('does not inject when user-prefs.md is empty', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), '   \n  ', 'utf-8');
    const state: StubState = { history: [] };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    await injector.inject();

    expect(state.history).toHaveLength(0);
  });

  it('injects when prefs exist and history is empty', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), PREFS_CONTENT, 'utf-8');
    const state: StubState = { history: [] };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    await injector.inject();

    expect(state.history).toHaveLength(1);
    const text = (state.history[0]!.content[0] as { text: string }).text;
    expect(text).toContain('USER PREFERENCES REMINDER');
    expect(text).toContain('Alex');
    expect(text).toContain('friendly tone');
    expect(text).toContain('direct user instructions');
  });

  it('does not re-inject before a new user prompt arrives', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), PREFS_CONTENT, 'utf-8');
    const state: StubState = { history: [] };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    await injector.inject();
    state.history.push(assistant('working'));
    await injector.inject();

    expect(state.history.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('does not repeat an identical reminder after a new user prompt', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), PREFS_CONTENT, 'utf-8');
    const state: StubState = { history: [] };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    await injector.inject();
    state.history.push(assistant('ok'));
    state.history.push(userPrompt('next task'));
    await injector.inject();

    const injections = state.history.filter(
      (m) => m.origin?.kind === 'injection' && m.origin?.variant === 'user_prefs',
    );
    // The identical 1.6 KB block is not repeated on every prompt — the system
    // prompt still carries the preferences.
    expect(injections).toHaveLength(1);
  });

  it('re-injects when the preferences changed', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), PREFS_CONTENT, 'utf-8');
    const state: StubState = { history: [] };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    await injector.inject();
    await writeFile(join(homeDir, 'user-prefs.md'), `${PREFS_CONTENT}\n- Extra: be brief.\n`, 'utf-8');
    state.history.push(assistant('ok'));
    state.history.push(userPrompt('next task'));
    await injector.inject();

    const injections = state.history.filter(
      (m) => m.origin?.kind === 'injection' && m.origin?.variant === 'user_prefs',
    );
    expect(injections).toHaveLength(2);
    expect((injections[1]!.content[0] as { text: string }).text).toContain('be brief');
  });

  it('re-injects after the previous copy left the context', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), PREFS_CONTENT, 'utf-8');
    const state: StubState = { history: [] };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    await injector.inject();
    // Context maintenance dropped the injected message: the injector forgets
    // where it was (injectedAt → null) and restores the reminder even though
    // the text did not change.
    injector.onContextMessageRemoved(0);
    state.history.push(userPrompt('next task'));
    await injector.inject();

    const injections = state.history.filter(
      (m) => m.origin?.kind === 'injection' && m.origin?.variant === 'user_prefs',
    );
    expect(injections).toHaveLength(2);
  });

  it('skips the reminder while the system prompt already carries the prefs', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), PREFS_CONTENT, 'utf-8');
    const state: StubState = { history: [], systemPrompt: PREFS_CONTENT };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    state.history.push(userPrompt('first task'));
    await injector.inject();

    const reminders = state.history.filter(
      (m) => m.origin?.kind === 'injection' && m.origin?.variant === 'user_prefs',
    );
    expect(reminders).toHaveLength(0);
  });

  it('still fires when the prefs change after the system prompt carried an older copy', async () => {
    await writeFile(join(homeDir, 'user-prefs.md'), PREFS_CONTENT, 'utf-8');
    const state: StubState = { history: [], systemPrompt: PREFS_CONTENT };
    const agent = makeAgent(state);
    const injector = new UserPrefsInjector(agent);

    state.history.push(userPrompt('first task'));
    await injector.inject();

    const changed = `${PREFS_CONTENT}\n- New rule: never push without asking.`;
    await writeFile(join(homeDir, 'user-prefs.md'), changed, 'utf-8');
    state.history.push(userPrompt('second task'));
    await injector.inject();

    const reminders = state.history.filter(
      (m) => m.origin?.kind === 'injection' && m.origin?.variant === 'user_prefs',
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.content?.[0]?.text).toContain('never push without asking');
  });
});
