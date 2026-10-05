import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/kimi-coding';
import type { AuthEvent, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const DEVICE_AUTHORIZATION_BODY = {
  device_code: 'device-1',
  user_code: 'USER-1',
  verification_uri: 'https://auth.kimi.com/device',
  verification_uri_complete: 'https://auth.kimi.com/device?user_code=USER-1',
  interval: 1,
  expires_in: 900,
};

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

function tokenRequestBody(fetchMock: { mock: { calls: unknown[][] } }): URLSearchParams {
  const call = fetchMock.mock.calls.find((invocation) =>
    String(invocation[0]).endsWith('/api/oauth/token'),
  );
  return new URLSearchParams((call?.[1] as RequestInit | undefined)?.body as string | URLSearchParams);
}

function deviceRequestBody(fetchMock: { mock: { calls: unknown[][] } }): URLSearchParams {
  const call = fetchMock.mock.calls.find((invocation) =>
    String(invocation[0]).endsWith('/api/oauth/device_authorization'),
  );
  return new URLSearchParams((call?.[1] as RequestInit | undefined)?.body as string | URLSearchParams);
}

describe('kimi-coding OAuth provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'kimi-coding',
      name: 'Kimi Code (subscription)',
    });
  });

  it('runs the device authorization flow and returns a credential', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
        return jsonResponse(DEVICE_AUTHORIZATION_BODY);
      }
      if (url === 'https://auth.kimi.com/api/oauth/token') {
        return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { interaction, events } = createInteraction();

    const credential = await provider.login(interaction);

    expect(events).toEqual([
      {
        type: 'device_code',
        userCode: 'USER-1',
        verificationUri: 'https://auth.kimi.com/device?user_code=USER-1',
        intervalSeconds: 1,
        expiresInSeconds: 900,
      },
    ]);
    expect(credential).toMatchObject({ type: 'oauth', access: 'access-1', refresh: 'refresh-1' });
    expect(credential.expires).toBeGreaterThan(Date.now());

    const deviceRequest = fetchMock.mock.calls[0];
    expect(String(deviceRequest?.[0])).toBe('https://auth.kimi.com/api/oauth/device_authorization');
    expect(deviceRequestBody(fetchMock).get('client_id')).toBe(
      '17e5f671-d194-4dfb-9706-5516cb48c098',
    );

    const body = tokenRequestBody(fetchMock);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(body.get('device_code')).toBe('device-1');
    expect(body.get('client_id')).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
    expect(provider.toAuth?.(credential)).toEqual({
      headers: { Authorization: 'Bearer access-1' },
      baseUrl: 'https://api.kimi.com/coding',
    });
    expect(provider.providerConfigType).toBe('anthropic');
  });

  it('refreshes the credential through the token endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const credential = {
      type: 'oauth' as const,
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 0,
    };

    const refreshed = await provider.refresh(credential, new AbortController().signal);

    expect(refreshed).toMatchObject({ access: 'access-2', refresh: 'refresh-2' });
    const body = tokenRequestBody(fetchMock);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('retries a transient refresh failure', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'server_error' }, 500)
        : jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await provider.refresh(
      { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 0 },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.access).toBe('access-2');
  });

  it('fails fast when the refresh token is rejected', async () => {
    const fetchMock = vi.fn(async (_input: string | URL) =>
      jsonResponse({ error: 'invalid_grant' }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Kimi Code token refresh unauthorized (status 401)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a denied device authorization', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
        return jsonResponse(DEVICE_AUTHORIZATION_BODY);
      }
      return jsonResponse({ error: 'access_denied' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { interaction } = createInteraction();

    await expect(provider.login(interaction)).rejects.toThrow('Kimi Code login was denied.');
  });
});
