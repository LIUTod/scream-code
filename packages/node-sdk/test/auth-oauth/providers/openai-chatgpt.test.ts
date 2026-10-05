/**
 * OpenAI ChatGPT provider flow tests: dynamic client registration through the
 * loopback listener or a pasted redirect URL, issued client id and scopes on
 * the credential, refresh and error paths. Every token endpoint round-trip is
 * stubbed; no request leaves the machine.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/openai-chatgpt';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const REQUIRED_SCOPE =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DEVICE_ID = 'e61bbe28-07ef-466d-8e5d-a344f94ab305';
const nativeFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(scope = REQUIRED_SCOPE): Record<string, unknown> {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    id_token: 'id-token',
    scope,
  };
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const request = { url, init: init ?? {} };
    requests.push(request);
    return handler(url, request.init);
  });
  return requests;
}

interface Harness {
  interaction: ProviderAuthInteraction;
  events: AuthEvent[];
  prompts: AuthPrompt[];
}

function createInteraction(manual: string | ((events: AuthEvent[]) => string)): Harness {
  const events: AuthEvent[] = [];
  const prompts: AuthPrompt[] = [];
  const interaction: ProviderAuthInteraction = {
    signal: new AbortController().signal,
    prompt: async (prompt) => {
      prompts.push(prompt);
      if (prompt.type !== 'manual_code') throw new Error(`Unexpected prompt: ${prompt.type}`);
      return typeof manual === 'function' ? manual(events) : manual;
    },
    notify: (event) => {
      events.push(event);
    },
  };
  return { interaction, events, prompts };
}

function authUrlFrom(events: AuthEvent[]): URL {
  const event = events.find((item) => item.type === 'auth_url');
  if (event?.type !== 'auth_url') throw new Error('No auth_url event was emitted');
  return new URL(event.url);
}

/** Builds the redirect with the code, state and issued client id. */
function issuedRedirect(events: AuthEvent[], clientId = 'oaiapp_issued'): string {
  const authorize = authUrlFrom(events);
  const callback = new URL(REDIRECT_URI);
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  callback.searchParams.set('client_id', clientId);
  return callback.toString();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai-chatgpt login', () => {
  it('registers a dynamic client and stores the issued id and granted scopes', async () => {
    const requests = stubFetch((url) => {
      if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
      return json(tokenResponse());
    });

    const { interaction, events, prompts } = createInteraction((seen) => issuedRedirect(seen));
    const credential = await provider.login(interaction, { getDeviceId: () => DEVICE_ID });

    const authorizeUrl = authUrlFrom(events);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      'https://auth.openai.com/api/accounts/authorize',
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorizeUrl.searchParams.get('agent_name_hint')).not.toBe('');
    expect(authorizeUrl.searchParams.get('ext_agent_host_id')).toBe(`urn:uuid:${DEVICE_ID}`);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(authorizeUrl.searchParams.get('scope')).toBe(REQUIRED_SCOPE);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('nonce')).not.toBe('');
    expect(prompts.some((prompt) => prompt.type === 'manual_code')).toBe(true);

    expect(requests).toHaveLength(1);
    const body = new URLSearchParams(requests[0]?.init.body as string | URLSearchParams);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('oaiapp_issued');
    expect(body.get('code')).toBe('authorization-code');
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('resource')).toBe('https://api.openai.com/v1');
    const verifier = body.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBe(challenge);

    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      clientId: 'oaiapp_issued',
      scopes: REQUIRED_SCOPE.split(' '),
    });
    expect(credential.expires).toBeGreaterThan(Date.now());
  });

  it('requires a device ID (UUID) before authorization starts', async () => {
    const { interaction, events } = createInteraction('unused');

    await expect(provider.login(interaction)).rejects.toThrow('requires a device ID (UUID)');
    await expect(provider.login(interaction, { getDeviceId: () => 'not-a-uuid' })).rejects.toThrow(
      'requires a device ID (UUID)',
    );
    expect(events.find((event) => event.type === 'auth_url')).toBeUndefined();
  });

  it('rejects a pasted redirect URL with a mismatched state', async () => {
    const requests = stubFetch(() => json(tokenResponse()));

    const { interaction } = createInteraction((seen) => {
      const callback = new URL(issuedRedirect(seen));
      callback.searchParams.set('state', 'not-the-expected-state');
      return callback.toString();
    });
    await expect(provider.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
      'OAuth state mismatch',
    );
    expect(requests).toHaveLength(0);
  });

  it('requires the pasted URL to be the registration redirect', async () => {
    const { interaction } = createInteraction('https://example.com/?code=x&state=y&client_id=z');

    await expect(provider.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
      `The pasted callback URL must start with ${REDIRECT_URI}`,
    );
  });

  it('rejects a token response that did not grant direct token use', async () => {
    stubFetch(() => json(tokenResponse('openid profile email offline_access resource.invoke')));

    const { interaction } = createInteraction((seen) => issuedRedirect(seen));
    await expect(provider.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
      'grant did not include chatgpt.tokens.use.direct',
    );
  });

  it('surfaces token endpoint failures', async () => {
    stubFetch(() => json({ error: 'invalid_grant' }, 400));

    const { interaction } = createInteraction((seen) => issuedRedirect(seen));
    await expect(provider.login(interaction, { getDeviceId: () => DEVICE_ID })).rejects.toThrow(
      'OpenAI OAuth token request failed (400): {"error":"invalid_grant"}',
    );
  });

  it('completes sign-in through the loopback listener', async () => {
    const requests = stubFetch((url) => {
      if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
      return json(tokenResponse());
    });

    let callbackResponse: Promise<Response> | undefined;
    const events: AuthEvent[] = [];
    const interaction: ProviderAuthInteraction = {
      signal: new AbortController().signal,
      prompt: (prompt) =>
        new Promise<string>((_resolve, reject) => {
          prompt.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
      notify: (event) => {
        events.push(event);
        if (event.type !== 'auth_url') return;
        const callback = new URL(issuedRedirect(events, 'oaiapp_callback'));
        callbackResponse = nativeFetch(callback);
      },
    };

    const credential = await provider.login(interaction, { getDeviceId: () => DEVICE_ID });

    expect(credential['clientId']).toBe('oaiapp_callback');
    expect(requests).toHaveLength(1);
    const body = new URLSearchParams(requests[0]?.init.body as string | URLSearchParams);
    expect(body.get('code')).toBe('authorization-code');
    const response = await callbackResponse;
    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('ChatGPT authentication completed');
  });

  it('falls back to the pasted URL when the loopback port is taken', async () => {
    const occupying = createServer();
    const occupied = await new Promise<boolean>((resolve) => {
      occupying.once('error', () => {
        resolve(false);
      });
      occupying.listen(1455, '127.0.0.1', () => {
        resolve(true);
      });
    });

    try {
      stubFetch((url) => {
        if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
        return json(tokenResponse());
      });

      const { interaction, events } = createInteraction((seen) => issuedRedirect(seen));
      const credential = await provider.login(interaction, { getDeviceId: () => DEVICE_ID });

      expect(credential['clientId']).toBe('oaiapp_issued');
      expect(
        events.some(
          (event) => event.type === 'info' && event.message.includes('Could not listen on'),
        ),
      ).toBe(true);
    } finally {
      if (occupied) occupying.close();
    }
  });
});

describe('openai-chatgpt refresh', () => {
  it('refreshes with the stored client id and stores replacement scopes', async () => {
    let refreshBody: URLSearchParams | undefined;
    stubFetch((url, init) => {
      if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
      refreshBody = new URLSearchParams(init.body as string | URLSearchParams);
      return json({ ...tokenResponse(), access_token: 'new-access', refresh_token: 'new-refresh' });
    });

    const before = Date.now();
    const credential = await provider.refresh(
      {
        type: 'oauth',
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 0,
        clientId: 'oaiapp_existing',
        scopes: REQUIRED_SCOPE.split(' '),
      },
      new AbortController().signal,
    );

    expect(refreshBody?.get('grant_type')).toBe('refresh_token');
    expect(refreshBody?.get('client_id')).toBe('oaiapp_existing');
    expect(refreshBody?.get('refresh_token')).toBe('old-refresh');
    expect(refreshBody?.get('resource')).toBe('https://api.openai.com/v1');
    expect(refreshBody?.has('scope')).toBe(false);
    expect(credential).toMatchObject({
      access: 'new-access',
      refresh: 'new-refresh',
      clientId: 'oaiapp_existing',
      scopes: REQUIRED_SCOPE.split(' '),
    });
    expect(credential.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it('requires a stored client id for refresh', async () => {
    await expect(
      provider.refresh(
        { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('does not contain an issued client ID');
  });

  it('requires refresh responses to rotate the refresh token', async () => {
    const { refresh_token: _refreshToken, ...withoutRefresh } = tokenResponse();
    stubFetch(() => json(withoutRefresh));

    await expect(
      provider.refresh(
        {
          type: 'oauth',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: 0,
          clientId: 'oaiapp_existing',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('token response has invalid refresh_token');
  });
});

describe('openai-chatgpt module metadata', () => {
  it('identifies itself to the provider registry and derives request auth', () => {
    expect(provider).toMatchObject({
      id: 'openai-chatgpt',
      name: 'ChatGPT (subscription)',
      isSubscription: true,
      providerConfigType: 'openai_responses',
    });
    expect(
      provider.toAuth?.({ type: 'oauth', access: 'access-token', refresh: '', expires: 0 }),
    ).toEqual({ apiKey: 'access-token' });
  });
});
