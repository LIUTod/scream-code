/**
 * OpenAI Codex provider flow tests: device-code state machine, browser
 * sign-in via a pasted redirect URL, refresh and error paths. Every network
 * round-trip is stubbed; no request leaves the machine.
 */

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/openai-codex';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal unsigned JWT whose payload carries the account claim. */
function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

interface Harness {
  interaction: ProviderAuthInteraction;
  prompts: AuthPrompt[];
  events: AuthEvent[];
}

function createInteraction(answers: {
  select?: string;
  manual?: string | (() => string);
}): Harness {
  const prompts: AuthPrompt[] = [];
  const events: AuthEvent[] = [];
  const interaction: ProviderAuthInteraction = {
    signal: new AbortController().signal,
    prompt: async (prompt) => {
      prompts.push(prompt);
      if (prompt.type === 'select') return answers.select ?? 'browser';
      if (prompt.type === 'manual_code') {
        return typeof answers.manual === 'function' ? answers.manual() : (answers.manual ?? '');
      }
      return '';
    },
    notify: (event) => {
      events.push(event);
    },
  };
  return { interaction, prompts, events };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(handler: Handler): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const request = { url, init: init ?? {} };
    requests.push(request);
    return handler(url, request.init);
  });
  return requests;
}

function authUrlFrom(events: AuthEvent[]): URL {
  const event = events.find((item) => item.type === 'auth_url');
  if (event?.type !== 'auth_url') throw new Error('No auth_url event was emitted');
  return new URL(event.url);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('openai-codex module metadata', () => {
  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'openai-codex',
      name: 'ChatGPT Plus/Pro (Codex Subscription)',
      isSubscription: true,
      flowLabel: 'browser or device code',
      providerConfigType: 'openai-codex',
    });
    expect(provider.loginLabel).not.toBe('');
  });

  it('derives backend request auth from the stored account id', () => {
    const credential = {
      type: 'oauth' as const,
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 0,
      accountId: 'acct-1',
    };

    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: JSON.stringify({ token: 'access-1', accountId: 'acct-1' }),
      baseUrl: 'https://chatgpt.com/backend-api',
    });
  });

  it('rejects a credential that carries no account id', () => {
    expect(() =>
      provider.toAuth?.({ type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 0 }),
    ).toThrow('account id');
  });
});

describe('openai-codex device code login', () => {
  it('returns a credential with the account id from the access token', async () => {
    const accessToken = fakeJwt('acct-device');
    let polls = 0;
    const requests = stubFetch((url) => {
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return json({ device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '0' });
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        polls += 1;
        return json({ authorization_code: 'auth_code', code_verifier: 'device_verifier' });
      }
      if (url.endsWith('/oauth/token')) {
        return json({ access_token: accessToken, refresh_token: 'refresh_1', expires_in: 3600 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction, events } = createInteraction({ select: 'device_code' });
    const credential = await provider.login(interaction);

    expect(polls).toBe(1);
    expect(credential).toMatchObject({
      type: 'oauth',
      access: accessToken,
      refresh: 'refresh_1',
      accountId: 'acct-device',
    });
    expect(credential.expires).toBeGreaterThan(Date.now());

    expect(events.find((event) => event.type === 'device_code')).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 0,
      expiresInSeconds: 900,
    });

    const exchange = requests.find((request) => request.url.endsWith('/oauth/token'));
    const body = new URLSearchParams(exchange?.init.body as string | URLSearchParams);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('code')).toBe('auth_code');
    expect(body.get('code_verifier')).toBe('device_verifier');
    expect(body.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
  });

  it('keeps polling through pending and slow_down responses', async () => {
    vi.useFakeTimers();
    const accessToken = fakeJwt('acct-backoff');
    let polls = 0;
    stubFetch((url) => {
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return json({ device_auth_id: 'dev_2', user_code: 'WXYZ-0001', interval: 1 });
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        polls += 1;
        if (polls === 1) return json({ error: 'deviceauth_authorization_pending' }, 400);
        if (polls === 2) return json({ error: 'slow_down' }, 400);
        return json({ authorization_code: 'auth_code_2', code_verifier: 'device_verifier_2' });
      }
      if (url.endsWith('/oauth/token')) {
        return json({ access_token: accessToken, refresh_token: 'refresh_2', expires_in: 60 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction, events } = createInteraction({ select: 'device_code' });
    const pending = provider.login(interaction);
    await vi.advanceTimersByTimeAsync(0);
    // One second for the server interval, then five more for slow_down.
    await vi.advanceTimersByTimeAsync(7000);
    const credential = await pending;

    expect(polls).toBe(3);
    expect(credential.access).toBe(accessToken);
    expect(events.filter((event) => event.type === 'device_code')).toHaveLength(1);
  });

  it('reports a server that does not offer device code login', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404));

    const { interaction } = createInteraction({ select: 'device_code' });
    await expect(provider.login(interaction)).rejects.toThrow(
      'OpenAI Codex device code login is not enabled for this server',
    );
  });

  it('surfaces token endpoint failures', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return json({ device_auth_id: 'dev_3', user_code: 'CODE-3', interval: 0 });
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        return json({ authorization_code: 'code_3', code_verifier: 'verifier_3' });
      }
      if (url.endsWith('/oauth/token')) {
        return json({ error: 'invalid_grant' }, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction({ select: 'device_code' });
    await expect(provider.login(interaction)).rejects.toThrow(
      'OpenAI Codex token exchange failed (400): {"error":"invalid_grant"}',
    );
  });
});

describe('openai-codex browser login', () => {
  it('signs in from a pasted redirect URL and pairs the PKCE verifier', async () => {
    const accessToken = fakeJwt('acct-browser');
    const requests = stubFetch((url) => {
      if (url.endsWith('/oauth/token')) {
        return json({ access_token: accessToken, refresh_token: 'refresh_browser', expires_in: 3600 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    let pasted = '';
    const events: AuthEvent[] = [];
    const interaction: ProviderAuthInteraction = {
      signal: new AbortController().signal,
      prompt: async (prompt) => {
        if (prompt.type === 'select') return 'browser';
        if (prompt.type === 'manual_code') {
          const state = authUrlFrom(events).searchParams.get('state') ?? '';
          pasted = `${REDIRECT_URI}?code=pasted_code&state=${state}`;
          return pasted;
        }
        return '';
      },
      notify: (event) => {
        events.push(event);
      },
    };

    const credential = await provider.login(interaction);

    expect(credential.access).toBe(accessToken);
    expect(pasted).not.toBe('');

    const authUrl = authUrlFrom(events);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe('https://auth.openai.com/oauth/authorize');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authUrl.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(authUrl.searchParams.get('originator')).not.toBe('');

    const exchange = requests.find((request) => request.url.endsWith('/oauth/token'));
    const body = new URLSearchParams(exchange?.init.body as string | URLSearchParams);
    expect(body.get('code')).toBe('pasted_code');
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    const verifier = body.get('code_verifier') ?? '';
    const challenge = Buffer.from(createHash('sha256').update(verifier).digest()).toString('base64url');
    expect(challenge).toBe(authUrl.searchParams.get('code_challenge'));
  });

  it('rejects a pasted redirect URL with a mismatched state', async () => {
    stubFetch(() => json({}));

    const { interaction } = createInteraction({
      select: 'browser',
      manual: `${REDIRECT_URI}?code=pasted_code&state=not-the-expected-state`,
    });
    await expect(provider.login(interaction)).rejects.toThrow('State mismatch');
  });
});

describe('openai-codex refresh', () => {
  it('exchanges the refresh token for a new credential', async () => {
    const accessToken = fakeJwt('acct-refreshed');
    const requests = stubFetch((url) => {
      if (url.endsWith('/oauth/token')) {
        return json({ access_token: accessToken, refresh_token: 'refresh_next', expires_in: 1800 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const credential = await provider.refresh(
      { type: 'oauth', access: fakeJwt('acct-old'), refresh: 'refresh_old', expires: 0 },
      new AbortController().signal,
    );

    expect(credential).toMatchObject({
      access: accessToken,
      refresh: 'refresh_next',
      accountId: 'acct-refreshed',
    });
    const body = new URLSearchParams(requests[0]?.init.body as string | URLSearchParams);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh_old');
    expect(body.get('client_id')).toBe(CLIENT_ID);
  });

  it('rejects when the access token carries no account id', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url');
    stubFetch(() =>
      json({
        access_token: `${header}.${payload}.signature`,
        refresh_token: 'refresh_next',
        expires_in: 1800,
      }),
    );

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'stale', refresh: 'refresh_old', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Failed to extract accountId from token');
  });
});
