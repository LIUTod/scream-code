/**
 * Facade passthrough test: `loginOAuthProvider` must forward the request auth
 * derived by the login service so the caller can persist the provider entry.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreamAuthFacade } from '../../src/auth';
import type {
  LoginOptions,
  OAuthCredential,
  OAuthProviderModule,
  ProviderAuthInteraction,
} from '../../src/auth-oauth/types';

/** Device id the mocked provider module observed for the last login. */
const captured = vi.hoisted(() => ({ deviceId: undefined as string | undefined }));

vi.mock('../../src/auth-oauth/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth-oauth/registry')>();
  const credential = (): OAuthCredential => ({
    type: 'oauth',
    access: 'access-1',
    refresh: 'refresh-1',
    expires: Date.now() + 60 * 60 * 1000,
  });
  const providers = {
    'shaped-provider': {
      id: 'shaped-provider',
      name: 'Provider with request auth',
      login: async () => credential(),
      refresh: async (stored: OAuthCredential) => stored,
      toAuth: (stored: OAuthCredential) => ({
        apiKey: stored.access,
        baseUrl: 'https://shaped.example/v1',
        headers: { 'x-extra': '1' },
      }),
    },
    'plain-provider': {
      id: 'plain-provider',
      name: 'Provider without toAuth',
      login: async () => credential(),
      refresh: async (stored: OAuthCredential) => stored,
    },
    'host-id-provider': {
      id: 'host-id-provider',
      name: 'Provider that identifies this installation',
      login: async (_interaction: ProviderAuthInteraction, options?: LoginOptions) => {
        captured.deviceId = options?.getDeviceId?.();
        return credential();
      },
      refresh: async (stored: OAuthCredential) => stored,
    },
  } satisfies Record<string, OAuthProviderModule>;
  return {
    ...actual,
    findOAuthProvider: (id: string) =>
      providers[id as keyof typeof providers] ?? actual.findOAuthProvider(id),
  };
});

function createInteraction(): ProviderAuthInteraction {
  return {
    signal: new AbortController().signal,
    prompt: async () => '',
    notify: () => undefined,
  };
}

describe('ScreamAuthFacade OAuth login result', () => {
  let homeDir: string;
  let facade: ScreamAuthFacade;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'oauth-facade-'));
    facade = new ScreamAuthFacade({ homeDir, configPath: join(homeDir, 'config.toml') });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('passes the derived request auth through to the caller', async () => {
    await expect(
      facade.loginOAuthProvider('shaped-provider', createInteraction()),
    ).resolves.toEqual({
      providerId: 'shaped-provider',
      providerName: 'Provider with request auth',
      requestAuth: {
        apiKey: 'access-1',
        baseUrl: 'https://shaped.example/v1',
        headers: { 'x-extra': '1' },
      },
    });
  });

  it('omits request auth when the provider has no toAuth', async () => {
    const result = await facade.loginOAuthProvider('plain-provider', createInteraction());
    expect(result.providerId).toBe('plain-provider');
    expect(result.requestAuth).toBeUndefined();
  });

  it('supplies a stable per-installation device id to flows that need one', async () => {
    await facade.loginOAuthProvider('host-id-provider', createInteraction());

    // The ChatGPT sign-in rejects anything that is not a UUID, so the value the
    // facade supplies has to be one.
    expect(captured.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const first = captured.deviceId;

    await facade.loginOAuthProvider('host-id-provider', createInteraction());
    expect(captured.deviceId).toBe(first);
    // Created on first use and reused, stored under the Scream home directory.
    expect((await readFile(join(homeDir, 'device_id'), 'utf-8')).trim()).toBe(first);
  });

  it('lets the caller override the device id', async () => {
    await facade.loginOAuthProvider('host-id-provider', createInteraction(), {
      getDeviceId: () => 'caller-supplied-id',
    });
    expect(captured.deviceId).toBe('caller-supplied-id');
  });
});
