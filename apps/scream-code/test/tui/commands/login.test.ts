import { t } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleLoginCommand } from '#/tui/commands/login';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';

import { makeMockHarness, makeMockSlashCommandHost } from '../fixtures/mock-host';

const PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    providerConfigType: 'openai-legacy',
    flowLabel: 'browser',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    providerConfigType: 'anthropic',
    flowLabel: 'browser',
  },
];

/** A registry slice wide enough to exercise prefix matching and ambiguity. */
const SELECTOR_PROVIDERS = [
  {
    id: 'openai-chatgpt',
    name: 'ChatGPT (subscription)',
    providerConfigType: 'openai_responses',
    flowLabel: 'browser',
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT Plus/Pro (Codex Subscription)',
    providerConfigType: 'openai_responses',
    flowLabel: 'browser or device code',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter OAuth',
    providerConfigType: 'openai',
    flowLabel: 'browser',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi Code (subscription)',
    providerConfigType: 'anthropic',
    flowLabel: 'device code',
  },
];

/**
 * A registry slice in the real registry's shape: the ids carry a namespace
 * prefix (`openai-…`, `google-…`) while the display names never start with the
 * vendor word users type, so `/login codex` and `/login gemini` can only be
 * resolved through the id.
 */
const ID_NAMED_PROVIDERS = [
  {
    id: 'openai-codex',
    name: 'ChatGPT Plus/Pro (Codex Subscription)',
    providerConfigType: 'openai-codex',
    flowLabel: 'browser or device code',
  },
  {
    id: 'google-gemini-cli',
    name: 'Google Cloud Code Assist (Gemini CLI)',
    providerConfigType: 'google-cloud-code',
    flowLabel: 'browser',
  },
  {
    id: 'google-antigravity',
    name: 'Antigravity (Gemini 3, Claude, GPT-OSS)',
    providerConfigType: 'google-cloud-code',
    flowLabel: 'browser',
  },
];

interface MountedDialog {
  handleInput(data: string): void;
  render(width: number): string[];
}

/**
 * Await `promise`, failing after `ms` instead of hanging when it never
 * settles. A command that falls back to the picker waits for input that a
 * direct-selection test never provides, so without this a regression stalls
 * the run instead of failing the assertion.
 */
async function settleWithin(promise: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not settle within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The component the command installed in place of the editor. */
function mountedDialog(host: SlashCommandHost, index = 0): MountedDialog {
  const call = vi.mocked(host.mountEditorReplacement).mock.calls[index];
  if (call === undefined) throw new Error('No dialog was mounted');
  return call[0] as unknown as MountedDialog;
}

interface MockConfig {
  providers: Record<string, Record<string, unknown>>;
  models: Record<string, unknown>;
  defaultModel: string;
  defaultThinking: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Patch semantics of the host's `setConfig`: the patch is merged into the
 * config already on disk, so a field the patch omits keeps its stored value and
 * an explicit empty string is how a field is cleared. Mirrors the real merge so
 * a function-level mock cannot hide a wrong patch shape.
 */
function mergePatch(base: object, patch: object): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? mergePatch(current, value) : value;
  }
  return result;
}

function makeLoginHost(overrides: { loginResult?: unknown; loginError?: Error } = {}) {
  const auth = {
    listOAuthProviders: vi.fn(() => PROVIDERS),
    hasOAuthCredential: vi.fn(() => false),
    loginOAuthProvider: vi.fn(async (providerId: string) => {
      if (overrides.loginError !== undefined) throw overrides.loginError;
      return (
        overrides.loginResult ?? {
          providerId,
          providerName: 'OpenRouter',
          requestAuth: { baseUrl: 'https://base.example/v1' },
        }
      );
    }),
    logoutOAuthProvider: vi.fn(),
    getCachedAccessToken: vi.fn(),
  };

  const config: MockConfig = {
    providers: {},
    models: { 'test-model': { provider: 'openrouter', model: 'x' } },
    defaultModel: 'test-model',
    defaultThinking: false,
  };

  const harness = makeMockHarness({
    auth,
    getConfig: vi.fn(async () => structuredClone(config)),
    setConfig: vi.fn(async (patch: MockConfig) => {
      Object.assign(config, mergePatch(config, patch));
    }),
  });

  const host = makeMockSlashCommandHost({ harness: harness as never });
  (host as { authFlow: unknown }).authFlow = {
    refreshConfigAfterLogin: vi.fn(async () => {}),
  };
  return { host, auth, config, harness };
}

describe('handleLoginCommand', () => {
  it('signs in a directly named provider and persists the oauth entry', async () => {
    const { host, auth, config, harness } = makeLoginHost();
    await handleLoginCommand(host, 'openrouter');

    expect(auth.loginOAuthProvider).toHaveBeenCalledTimes(1);
    const call = auth.loginOAuthProvider.mock.calls[0] as unknown as [
      string,
      { prompt: unknown; notify: unknown },
    ];
    expect(call[0]).toBe('openrouter');
    expect(typeof call[1].prompt).toBe('function');
    expect(typeof call[1].notify).toBe('function');

    expect(config.providers['openrouter']).toMatchObject({
      type: 'openai-legacy',
      baseUrl: 'https://base.example/v1',
      oauth: { storage: 'file', key: 'openrouter' },
    });
    expect(harness['setConfig']).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('clears a pre-existing api key when signing in', async () => {
    const { host, config } = makeLoginHost();
    config.providers['openrouter'] = { type: 'openai-legacy', apiKey: 'sk-old' };
    await handleLoginCommand(host, 'openrouter');
    // The patch is merged into the config on disk, so the cleared key must be
    // sent as an explicit empty string; an omitted field would leave 'sk-old'
    // in place and the entry would carry an api key and oauth at once.
    expect(config.providers['openrouter']?.['apiKey']).toBe('');
    expect(config.providers['openrouter']?.['oauth']).toBeDefined();
  });

  it('keeps a base URL the provider entry already configures', async () => {
    const { host, config } = makeLoginHost();
    config.providers['openrouter'] = {
      type: 'openai-legacy',
      baseUrl: 'https://proxy.example/v1',
    };
    await handleLoginCommand(host, 'openrouter');
    // A proxy or mirror the user configured wins over the sign-in default.
    expect(config.providers['openrouter']?.['baseUrl']).toBe('https://proxy.example/v1');
  });

  it('reloads the config before building the provider patch', async () => {
    const { host, harness } = makeLoginHost();
    await handleLoginCommand(host, 'openrouter');
    expect(harness['getConfig']).toHaveBeenCalledWith({ reload: true });
  });

  it('reports cancellation without persisting when the flow is cancelled', async () => {
    const { host, config } = makeLoginHost({ loginError: new Error('Login cancelled') });
    await handleLoginCommand(host, 'openrouter');
    expect(config.providers['openrouter']).toBeUndefined();
    expect(host.showStatus).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('reports other failures via showError', async () => {
    const { host, auth, config } = makeLoginHost({ loginError: new Error('boom') });
    await handleLoginCommand(host, 'openrouter');
    expect(host.showError).toHaveBeenCalled();
    expect(config.providers['openrouter']).toBeUndefined();
    void auth;
  });

  it('shows a status when no providers are registered', async () => {
    const { host, auth } = makeLoginHost();
    auth.listOAuthProviders.mockReturnValueOnce([]);
    await handleLoginCommand(host);
    expect(host.showStatus).toHaveBeenCalled();
    expect(auth.loginOAuthProvider).not.toHaveBeenCalled();
  });

  it('matches a multi-word display name by its unique prefix', async () => {
    const { host, auth } = makeLoginHost();
    auth.listOAuthProviders.mockReturnValue(SELECTOR_PROVIDERS);

    await handleLoginCommand(host, 'kimi');

    // A single match means no picker: the command signs in directly.
    expect(mountedDialog(host)).not.toBeInstanceOf(ChoicePickerComponent);
    expect(auth.loginOAuthProvider).toHaveBeenCalledTimes(1);
    expect(auth.loginOAuthProvider.mock.calls[0]?.[0]).toBe('kimi-coding');
  });

  it('accepts a full multi-word display name around surrounding whitespace', async () => {
    const { host, auth } = makeLoginHost();
    auth.listOAuthProviders.mockReturnValue(SELECTOR_PROVIDERS);

    await handleLoginCommand(host, '  ChatGPT (subscription)  ');

    expect(auth.loginOAuthProvider).toHaveBeenCalledTimes(1);
    expect(auth.loginOAuthProvider.mock.calls[0]?.[0]).toBe('openai-chatgpt');
  });

  it('falls back to the selector when a prefix names more than one provider', async () => {
    const { host, auth } = makeLoginHost();
    auth.listOAuthProviders.mockReturnValue(SELECTOR_PROVIDERS);

    const pending = handleLoginCommand(host, 'chatgpt');

    // Two display names start with "chatgpt": guessing one would sign in the
    // wrong provider, so the command opens the picker instead.
    expect(auth.loginOAuthProvider).not.toHaveBeenCalled();
    const picker = mountedDialog(host);
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    const rendered = picker.render(120).join('\n');
    expect(rendered).toContain('ChatGPT (subscription)');
    expect(rendered).toContain('ChatGPT Plus/Pro (Codex Subscription)');
    expect(rendered).toContain('Kimi Code (subscription)');

    picker.handleInput('\r');
    await pending;

    expect(auth.loginOAuthProvider).toHaveBeenCalledTimes(1);
    expect(auth.loginOAuthProvider.mock.calls[0]?.[0]).toBe('openai-chatgpt');
  });

  it('cancels the provider selection without signing in', async () => {
    const { host, auth, config } = makeLoginHost();
    auth.listOAuthProviders.mockReturnValue(SELECTOR_PROVIDERS);

    const pending = handleLoginCommand(host);
    const picker = mountedDialog(host);
    picker.handleInput('\u001B');
    await pending;

    expect(auth.loginOAuthProvider).not.toHaveBeenCalled();
    expect(config.providers).toEqual({});
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it.each([
    ['codex', 'openai-codex'],
    ['gemini', 'google-gemini-cli'],
    ['antigravity', 'google-antigravity'],
  ])('signs in the provider whose id segment is "%s"', async (requested, expectedId) => {
    const { host, auth } = makeLoginHost();
    auth.listOAuthProviders.mockReturnValue(ID_NAMED_PROVIDERS);

    // No display name starts with these words; only the id names the provider,
    // and exactly one does, so the command signs in instead of opening the
    // picker (which would wait for input this test never sends).
    await settleWithin(handleLoginCommand(host, requested), 2_000, `login ${requested}`);

    expect(mountedDialog(host)).not.toBeInstanceOf(ChoicePickerComponent);
    expect(auth.loginOAuthProvider).toHaveBeenCalledTimes(1);
    expect(auth.loginOAuthProvider.mock.calls[0]?.[0]).toBe(expectedId);
  });

  it('keeps the sign-in when saving the provider config fails', async () => {
    const { host, auth, harness } = makeLoginHost();
    const setConfig = vi.mocked(harness['setConfig'] as (patch: unknown) => Promise<void>);
    setConfig.mockRejectedValue(new Error('config write failed'));

    await handleLoginCommand(host, 'openrouter');

    // The credential is already stored, so the failure is reported as a
    // persistence problem; "Login failed" would send the user through the
    // whole sign-in again for nothing.
    expect(auth.loginOAuthProvider).toHaveBeenCalledTimes(1);
    const message = vi.mocked(host.showError).mock.calls[0]?.[0] ?? '';
    expect(message).toBe(t('login.persist_failed', { message: 'config write failed' }));
    expect(message).not.toBe(t('login.failed', { message: 'config write failed' }));
    expect(vi.mocked(host.showStatus).mock.calls.map((call) => call[0])).not.toContain(
      t('login.success', { name: 'OpenRouter' }),
    );
  });
});
