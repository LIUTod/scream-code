import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/xai';
import type { AuthEvent, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const DEVICE_CODE_BODY = {
  device_code: 'device-1',
  user_code: 'USER-1',
  verification_uri: 'https://x.ai/device',
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

function bodyOf(invocation: unknown[] | undefined): URLSearchParams {
  return new URLSearchParams(
    (invocation?.[1] as RequestInit | undefined)?.body as string | URLSearchParams,
  );
}

describe('xai OAuth provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'xai',
      name: 'xAI Grok OAuth (SuperGrok or X Premium+)',
    });
  });

  it('runs the device flow and returns a credential expiring before the reported expiry', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === DEVICE_CODE_URL) return jsonResponse(DEVICE_CODE_BODY);
      if (url === TOKEN_URL) {
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
        verificationUri: 'https://x.ai/device',
        intervalSeconds: 1,
        expiresInSeconds: 900,
      },
    ]);
    expect(credential).toMatchObject({ type: 'oauth', access: 'access-1', refresh: 'refresh-1' });
    expect(credential.expires).toBeGreaterThan(Date.now() + 3600_000 - REFRESH_SKEW_MS - 5000);
    expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - REFRESH_SKEW_MS);

    const deviceBody = bodyOf(fetchMock.mock.calls[0]);
    expect(deviceBody.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(deviceBody.get('scope')).toBe('openid profile email offline_access grok-cli:access api:access');
    expect([...deviceBody.keys()].toSorted()).toEqual(['client_id', 'referrer', 'scope']);

    const tokenBody = bodyOf(fetchMock.mock.calls[1]);
    expect(tokenBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(tokenBody.get('device_code')).toBe('device-1');
    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: 'access-1',
      baseUrl: 'https://api.x.ai/v1',
    });
    expect(provider.providerConfigType).toBe('openai_responses');
  });

  it('keeps the stored refresh token when a refresh response does not rotate it', async () => {
    const fetchMock = vi.fn(async (_input: string | URL) =>
      jsonResponse({ access_token: 'access-2', expires_in: 1800 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await provider.refresh(
      { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 0 },
      new AbortController().signal,
    );

    expect(refreshed).toMatchObject({ access: 'access-2', refresh: 'refresh-1' });
    expect(refreshed.expires).toBeGreaterThan(Date.now() + 1800_000 - REFRESH_SKEW_MS - 5000);
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('surfaces a rejected device authorization with the server error detail', async () => {
    const fetchMock = vi.fn(async (_input: string | URL) =>
      jsonResponse({ error: 'invalid_client', error_description: 'unknown client' }, 400),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { interaction } = createInteraction();

    await expect(provider.login(interaction)).rejects.toThrow(
      'xAI OAuth device authorization failed (HTTP 400): invalid_client: unknown client',
    );
  });

  it('reports an expired device code', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === DEVICE_CODE_URL) return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ error: 'expired_token' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { interaction } = createInteraction();

    await expect(provider.login(interaction)).rejects.toThrow('xAI device code expired');
  });
});
