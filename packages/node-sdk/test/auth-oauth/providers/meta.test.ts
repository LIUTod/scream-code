import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/meta';
import type { AuthEvent, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const DEVICE_AUTHORIZATION_URL = 'https://auth.meta.com/oidc/device/authorization/';
const DEVICE_TOKEN_URL = 'https://auth.meta.com/oidc/device/token/';
const API_KEY_MINT_URL = 'https://api.meta.ai/muse-code/key';
const API_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createInteraction(): { interaction: ProviderAuthInteraction; events: AuthEvent[] } {
  const events: AuthEvent[] = [];
  return {
    events,
    interaction: {
      signal: new AbortController().signal,
      prompt: () => Promise.reject(new Error('unexpected prompt')),
      notify: (event) => events.push(event),
    },
  };
}

function headersOf(invocation: unknown[] | undefined): Record<string, string> {
  return (invocation?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
}

describe('meta OAuth provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'meta',
      name: 'Meta (Muse subscription)',
    });
  });

  it('runs the device flow and mints an API key', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === DEVICE_AUTHORIZATION_URL) {
        return jsonResponse({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://auth.meta.com/device',
          verification_uri_complete: 'https://auth.meta.com/device?code=USER-1',
          interval: 1,
          expires_in: 900,
        });
      }
      if (url === DEVICE_TOKEN_URL) {
        return jsonResponse({ access_token: 'identity-1' });
      }
      if (url === API_KEY_MINT_URL) {
        return jsonResponse({ api_key: 'key-1' });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { interaction, events } = createInteraction();
    const startedAt = Date.now();

    const credential = await provider.login(interaction);

    expect(events).toEqual([
      {
        type: 'device_code',
        userCode: 'USER-1',
        verificationUri: 'https://auth.meta.com/device?code=USER-1',
        intervalSeconds: 1,
        expiresInSeconds: 900,
      },
      { type: 'progress', message: 'Enabling Meta Model API access...' },
    ]);
    expect(credential).toMatchObject({ type: 'oauth', access: 'key-1', refresh: 'identity-1' });
    expect(credential.expires).toBeGreaterThanOrEqual(startedAt + API_KEY_LIFETIME_MS);
    expect(credential.expires).toBeLessThanOrEqual(Date.now() + API_KEY_LIFETIME_MS);

    const mintRequest = fetchMock.mock.calls.find((call) => String(call[0]) === API_KEY_MINT_URL);
    expect(headersOf(mintRequest)['Authorization']).toBe('Bearer identity-1');
    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: 'key-1',
      baseUrl: 'https://api.meta.ai/v1',
    });
    expect(provider.providerConfigType).toBe('openai_responses');
  });

  it('re-mints the API key from the stored identity token on refresh', async () => {
    const fetchMock = vi.fn(async (_input: string | URL) => jsonResponse({ api_key: 'key-2' }));
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await provider.refresh(
      { type: 'oauth', access: 'key-1', refresh: 'identity-1', expires: 0 },
      new AbortController().signal,
    );

    expect(refreshed).toMatchObject({ access: 'key-2', refresh: 'identity-1' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(API_KEY_MINT_URL);
    expect(headersOf(fetchMock.mock.calls[0])['Authorization']).toBe('Bearer identity-1');
  });

  it('reports a dead session when the identity token is rejected', async () => {
    const fetchMock = vi.fn(async (_input: string | URL) =>
      jsonResponse({ detail: 'token expired' }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'key-1', refresh: 'identity-1', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      'Meta session expired (status 401). Run `/login meta` to sign in again.: token expired',
    );
  });

  it('surfaces a failed device authorization with the server detail', async () => {
    const fetchMock = vi.fn(async (_input: string | URL) =>
      jsonResponse({ error: 'invalid_client', error_description: 'unknown client' }, 400),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { interaction } = createInteraction();

    await expect(provider.login(interaction)).rejects.toThrow(
      'Meta device authorization failed with status 400: unknown client',
    );
  });
});
