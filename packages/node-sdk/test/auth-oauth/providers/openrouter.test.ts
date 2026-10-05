/**
 * OpenRouter provider flow tests: PKCE sign-in through the loopback callback
 * or a pasted redirect URL, the permanent-key exchange, and error paths.
 * Every token endpoint round-trip is stubbed; no request leaves the machine.
 */

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/openrouter';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';
const nativeFetch = globalThis.fetch;

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

function callbackUrlFrom(events: AuthEvent[]): URL {
  return new URL(authUrlFrom(events).searchParams.get('callback_url') ?? '');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openrouter sign-in', () => {
  it('exchanges a pasted redirect URL for a permanent API key', async () => {
    const requests = stubFetch(() => json({ key: 'sk-or-manual' }));

    const { interaction, events, prompts } = createInteraction(
      (seen) => `${callbackUrlFrom(seen).href}?code=manual-code`,
    );
    const credential = await provider.login(interaction);

    expect(credential).toEqual({
      type: 'oauth',
      access: 'sk-or-manual',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    });
    expect(prompts.some((prompt) => prompt.type === 'manual_code')).toBe(true);

    const authUrl = authUrlFrom(events);
    expect(authUrl.origin).toBe('https://openrouter.ai');
    expect(authUrl.pathname).toBe('/auth');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const callbackUrl = callbackUrlFrom(events);
    expect(callbackUrl.hostname).toBe('127.0.0.1');
    expect(callbackUrl.pathname).toMatch(/^\/oauth\/callback\/[A-Za-z0-9_-]+$/);
    expect(events.some((event) => event.type === 'progress')).toBe(true);

    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]?.init.body as string) as Record<string, string>;
    expect(body['code']).toBe('manual-code');
    expect(body['code_challenge_method']).toBe('S256');
    const verifier = body['code_verifier'] ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(authUrl.searchParams.get('code_challenge')).toBe(challenge);
  });

  it('accepts a bare authorization code from the manual prompt', async () => {
    const requests = stubFetch(() => json({ key: 'sk-or-bare' }));

    const { interaction } = createInteraction('  manual-code  ');
    const credential = await provider.login(interaction);

    expect(credential.access).toBe('sk-or-bare');
    const body = JSON.parse(requests[0]?.init.body as string) as Record<string, string>;
    expect(body['code']).toBe('manual-code');
  });

  it('completes sign-in through the loopback callback', async () => {
    const requests = stubFetch((url) => {
      if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
      return json({ key: 'sk-or-callback' });
    });

    let callbackResponse: Promise<Response> | undefined;
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
        if (event.type !== 'auth_url') return;
        const callback = new URL(new URL(event.url).searchParams.get('callback_url') ?? '');
        callback.searchParams.set('code', 'callback-code');
        callbackResponse = nativeFetch(callback);
      },
    };

    const credential = await provider.login(interaction);

    expect(credential.access).toBe('sk-or-callback');
    const response = await callbackResponse;
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('Signed in to OpenRouter');
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]?.init.body as string) as Record<string, string>;
    expect(body['code']).toBe('callback-code');
  });

  it('surfaces key-exchange failures from the token endpoint', async () => {
    stubFetch(() => json({ error: { message: 'invalid code' } }, 403));

    const { interaction } = createInteraction('bad-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'OpenRouter OAuth key exchange failed (HTTP 403): invalid code',
    );
  });

  it('rejects a successful response that carries no key', async () => {
    stubFetch(() => json({ user_id: 'user-1' }));

    const { interaction } = createInteraction('code-without-key');
    await expect(provider.login(interaction)).rejects.toThrow(
      'OpenRouter OAuth response carries no "key"',
    );
  });

  it('rejects empty manual input without exchanging a code', async () => {
    const requests = stubFetch(() => json({ key: 'sk-or-unexpected' }));

    const { interaction } = createInteraction('   ');
    await expect(provider.login(interaction)).rejects.toThrow('Missing authorization code');
    expect(requests).toHaveLength(0);
  });
});

describe('openrouter credential', () => {
  it('keeps the permanent key on refresh and derives request auth', async () => {
    expect(provider).toMatchObject({
      id: 'openrouter',
      name: 'OpenRouter OAuth',
      loginLabel: 'Sign in with OpenRouter',
      flowLabel: 'browser',
    });

    const credential = {
      type: 'oauth',
      access: 'sk-or-stored',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    } as const;
    await expect(provider.refresh({ ...credential }, new AbortController().signal)).resolves.toEqual(
      credential,
    );
    expect(provider.toAuth?.({ ...credential })).toEqual({
      apiKey: 'sk-or-stored',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(provider.providerConfigType).toBe('openai');
  });
});
