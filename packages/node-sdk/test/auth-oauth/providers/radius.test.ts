import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/radius';
import type { AuthEvent, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const GATEWAY = 'https://gateway.test';
const DISCOVERY_URL = `${GATEWAY}/v1/oauth`;
const DEVICE_URL = `${GATEWAY}/v1/oauth/device`;
const TOKEN_URL = `${GATEWAY}/v1/oauth/token`;
const CALLBACK_URL = 'http://127.0.0.1:1456/oauth/callback';

const TOKEN_BODY = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  scope: 'gateway offline_access',
};

/** Original fetch, used to drive the loopback callback server for real. */
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bodyOf(invocation: unknown[] | undefined): URLSearchParams {
  return new URLSearchParams(
    (invocation?.[1] as RequestInit | undefined)?.body as string | URLSearchParams,
  );
}

describe('radius OAuth provider', () => {
  const controllers: AbortController[] = [];

  beforeEach(() => {
    vi.stubEnv('SCREAM_CODE_RADIUS_GATEWAY', GATEWAY);
  });

  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.abort();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'radius',
      name: 'Radius',
    });
  });

  function interactionFor(
    select: string,
    events: AuthEvent[],
    onAuthUrl?: (url: string) => void,
  ): ProviderAuthInteraction {
    const controller = new AbortController();
    controllers.push(controller);
    return {
      signal: controller.signal,
      prompt: async () => select,
      notify: (event) => {
        events.push(event);
        if (event.type === 'auth_url') onAuthUrl?.(event.url);
      },
    };
  }

  it('completes the browser flow through the loopback callback', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === DISCOVERY_URL) {
        return jsonResponse({ authorizationEndpoint: `${GATEWAY}/oauth/authorize` });
      }
      if (url === TOKEN_URL) return jsonResponse(TOKEN_BODY);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const events: AuthEvent[] = [];
    const pendingAuthUrl = Promise.withResolvers<string>();
    const interaction = interactionFor('browser', events, (url) => {
      pendingAuthUrl.resolve(url);
    });

    const login = provider.login(interaction);
    const authorizeUrl = new URL(await pendingAuthUrl.promise);

    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://gateway.test/oauth/authorize');
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('scream-gateway');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(events).toContainEqual({
      type: 'progress',
      message: `Listening for OAuth callback on ${CALLBACK_URL}`,
    });

    const state = authorizeUrl.searchParams.get('state');
    const codeChallenge = authorizeUrl.searchParams.get('code_challenge');
    expect(state).toBeTruthy();
    expect(codeChallenge).toBeTruthy();

    const callbackResponse = await realFetch(`${CALLBACK_URL}?code=code-1&state=${state}`);
    expect(callbackResponse.status).toBe(200);

    const credential = await login;

    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      scope: 'gateway offline_access',
    });
    const exchange = fetchMock.mock.calls.find((call) => String(call[0]) === TOKEN_URL);
    const exchangeBody = bodyOf(exchange);
    expect(exchangeBody.get('grant_type')).toBe('authorization_code');
    expect(exchangeBody.get('code')).toBe('code-1');
    expect(exchangeBody.get('code_verifier')).toBeTruthy();
    expect(createHash('sha256').update(exchangeBody.get('code_verifier') ?? '').digest('base64url')).toBe(
      codeChallenge,
    );
    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: 'access-1',
      baseUrl: GATEWAY,
    });
    expect(provider.providerConfigType).toBe('openai');
  });

  it('completes the device code flow after a pending poll', async () => {
    let tokenPolls = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === DEVICE_URL) {
        return jsonResponse({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://gateway.test/device',
          expires_in: 900,
          interval: 1,
        });
      }
      if (url === TOKEN_URL) {
        tokenPolls += 1;
        return tokenPolls === 1
          ? jsonResponse({ error: 'authorization_pending' }, 400)
          : jsonResponse(TOKEN_BODY);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const events: AuthEvent[] = [];

    const credential = await provider.login(interactionFor('device-code', events));

    expect(events).toEqual([
      {
        type: 'device_code',
        userCode: 'USER-1',
        verificationUri: 'https://gateway.test/device',
        intervalSeconds: 1,
        expiresInSeconds: 900,
      },
    ]);
    expect(credential).toMatchObject({ access: 'access-1', refresh: 'refresh-1' });
    const deviceBody = bodyOf(fetchMock.mock.calls[0]);
    expect(deviceBody.get('client_id')).toBe('scream-gateway');
    expect(deviceBody.get('scope')).toBe('gateway offline_access');
    expect(tokenPolls).toBe(2);
  });

  it('maps a denied device authorization to a failure', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === DEVICE_URL) {
        return jsonResponse({
          device_code: 'device-1',
          user_code: 'USER-1',
          verification_uri: 'https://gateway.test/device',
          expires_in: 900,
          interval: 1,
        });
      }
      return jsonResponse({ error: 'access_denied', error_description: 'user refused' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.login(interactionFor('device-code', []))).rejects.toThrow(
      'Device authorization was denied.',
    );
  });

  it('refreshes through the gateway with the configured client id', async () => {
    vi.stubEnv('SCREAM_CODE_RADIUS_CLIENT_ID', 'custom-client');
    const fetchMock = vi.fn(async (_input: string | URL) => jsonResponse(TOKEN_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await provider.refresh(
      { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 0 },
      new AbortController().signal,
    );

    expect(refreshed).toMatchObject({ access: 'access-1', refresh: 'refresh-1' });
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('custom-client');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('refuses to start without a configured gateway', async () => {
    vi.stubEnv('SCREAM_CODE_RADIUS_GATEWAY', '');
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.login(interactionFor('device-code', []))).rejects.toThrow(
      'This provider has no gateway endpoint configured. Set SCREAM_CODE_RADIUS_GATEWAY to the gateway base URL.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits the base URL from request auth when no gateway is configured', () => {
    vi.stubEnv('SCREAM_CODE_RADIUS_GATEWAY', '');

    expect(
      provider.toAuth?.({ type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 0 }),
    ).toEqual({ apiKey: 'access-1' });
  });

  it('rejects an unknown sign-in method', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.login(interactionFor('bogus', []))).rejects.toThrow(
      'Unknown Radius sign-in method: bogus',
    );
  });

  it('names Radius in every gateway OAuth failure message', async () => {
    // Discovery (browser flow) — the user must be able to tell which provider
    // the failing gateway belongs to when several are configured.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(provider.login(interactionFor('browser', []))).rejects.toThrow(
      `Could not load Radius OAuth config from ${GATEWAY}: 500 nope`,
    );

    // Device authorization.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    await expect(provider.login(interactionFor('device-code', []))).rejects.toThrow(
      'Radius OAuth device authorization failed',
    );

    // Token request (refresh shares the same helper as the code exchange).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 410 })));
    await expect(
      provider.refresh(
        { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Radius OAuth token request failed');
  });
});
