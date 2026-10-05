/**
 * Anthropic provider flow tests: PKCE browser sign-in through a pasted
 * redirect URL (including state binding), the token exchange, refresh and
 * error paths. Every token endpoint round-trip is stubbed; no request leaves
 * the machine.
 */

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/anthropic';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'http://localhost:53692/callback';
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

/** Builds the redirect the browser would land on, echoing the expected state. */
function manualRedirect(events: AuthEvent[], state?: string): string {
  const authorize = authUrlFrom(events);
  const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  callback.searchParams.set('code', 'manual-code');
  callback.searchParams.set('state', state ?? authorize.searchParams.get('state') ?? '');
  return callback.toString();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anthropic login', () => {
  it('exchanges a pasted redirect URL and pairs the PKCE verifier', async () => {
    const requests = stubFetch((url) => {
      if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
      return json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      });
    });

    const { interaction, events, prompts } = createInteraction((seen) => manualRedirect(seen));
    const before = Date.now();
    const credential = await provider.login(interaction);

    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
    });
    expect(credential.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);

    const manualPrompt = prompts.find((prompt) => prompt.type === 'manual_code');
    expect(manualPrompt).toBeDefined();
    // The prompt's signal is aborted once login settles, so UIs can dismiss it.
    expect(manualPrompt?.signal?.aborted).toBe(true);

    const authUrl = authUrlFrom(events);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe('https://claude.ai/oauth/authorize');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('code')).toBe('true');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authUrl.searchParams.get('scope')).toBe(SCOPES);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const clientId = authUrl.searchParams.get('client_id');
    expect(clientId).toBeTruthy();
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]?.init.body as string) as Record<string, string>;
    expect(body['grant_type']).toBe('authorization_code');
    expect(body['client_id']).toBe(clientId);
    expect(body['code']).toBe('manual-code');
    expect(body['state']).toBe(state);
    expect(body['redirect_uri']).toBe(REDIRECT_URI);
    const verifier = body['code_verifier'] ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(authUrl.searchParams.get('code_challenge')).toBe(challenge);
  });

  it('rejects a pasted redirect with a mismatched state', async () => {
    const requests = stubFetch(() => json({}));

    const { interaction } = createInteraction((seen) =>
      manualRedirect(seen, 'not-the-expected-state'),
    );
    await expect(provider.login(interaction)).rejects.toThrow('OAuth state mismatch');
    expect(requests).toHaveLength(0);
  });

  it('surfaces token exchange failures', async () => {
    stubFetch(() => json({ error: 'invalid_grant' }, 400));

    const { interaction } = createInteraction((seen) => manualRedirect(seen));
    await expect(provider.login(interaction)).rejects.toThrow('HTTP request failed. status=400');
  });

  it('rejects empty manual input without exchanging a code', async () => {
    const requests = stubFetch(() => json({}));

    const { interaction } = createInteraction('   ');
    await expect(provider.login(interaction)).rejects.toThrow('Missing authorization code');
    expect(requests).toHaveLength(0);
  });
});

describe('anthropic refresh', () => {
  it('exchanges the refresh token for a new credential', async () => {
    const requests = stubFetch((url) => {
      if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
      return json({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 1800,
      });
    });

    const before = Date.now();
    const credential = await provider.refresh(
      { type: 'oauth', access: 'old-access-token', refresh: 'old-refresh-token', expires: 0 },
      new AbortController().signal,
    );

    expect(credential).toMatchObject({
      access: 'new-access-token',
      refresh: 'new-refresh-token',
    });
    expect(credential.expires).toBeGreaterThanOrEqual(before + 1800 * 1000);

    const body = JSON.parse(requests[0]?.init.body as string) as Record<string, string>;
    expect(body['grant_type']).toBe('refresh_token');
    expect(body['refresh_token']).toBe('old-refresh-token');
    expect(body['client_id']).toBeTruthy();
    expect(body).not.toHaveProperty('scope');
  });

  it('surfaces refresh failures', async () => {
    stubFetch(() => json({ error: 'invalid_grant' }, 401));

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'old-access-token', refresh: 'stale-refresh-token', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Anthropic token refresh request failed');
  });
});

describe('anthropic provider metadata', () => {
  it('exposes the selector fields and derives request auth', () => {
    expect(provider).toMatchObject({
      id: 'anthropic',
      name: 'Anthropic (Claude Pro/Max)',
      isSubscription: true,
      loginLabel: 'Sign in with Claude (Anthropic)',
      flowLabel: 'browser',
      providerConfigType: 'anthropic',
    });
    expect(
      provider.toAuth?.({ type: 'oauth', access: 'token', refresh: '', expires: 0 }),
    ).toEqual({ headers: { Authorization: 'Bearer token' } });
  });
});
