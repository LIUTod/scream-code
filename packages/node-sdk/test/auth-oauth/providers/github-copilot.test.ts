/**
 * GitHub Copilot provider flow tests: device-code sign-in with the follow-up
 * API token exchange, enterprise endpoint routing, refresh semantics and
 * error paths. Every network round-trip is stubbed; no request leaves the
 * machine.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/github-copilot';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const API_TOKEN = 'tid=1;exp=99;proxy-ep=proxy.individual.githubcopilot.com;';
const API_TOKEN_MARGIN_MS = 5 * 60 * 1000;

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

interface Harness {
  interaction: ProviderAuthInteraction;
  prompts: AuthPrompt[];
  events: AuthEvent[];
}

function createInteraction(answers: { text?: string } = {}): Harness {
  const prompts: AuthPrompt[] = [];
  const events: AuthEvent[] = [];
  const interaction: ProviderAuthInteraction = {
    signal: new AbortController().signal,
    prompt: async (prompt) => {
      prompts.push(prompt);
      if (prompt.type === 'text') return answers.text ?? '';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('github-copilot module metadata', () => {
  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      isSubscription: true,
      flowLabel: 'device code',
      providerConfigType: 'openai',
    });
    expect(provider.loginLabel).not.toBe('');
  });
});

describe('github-copilot device code login', () => {
  it('signs in and exchanges the GitHub token for an API token', async () => {
    vi.useFakeTimers();
    const requests = stubFetch((url) => {
      if (url === 'https://github.com/login/device/code') {
        return json({
          device_code: 'dc_1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 900,
        });
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        return json({ access_token: 'gho_1', token_type: 'bearer', scope: '' });
      }
      if (url === 'https://api.github.com/copilot_internal/v2/token') {
        return json({ token: API_TOKEN, expires_at: 1_800_000_000 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction, prompts, events } = createInteraction();
    const pending = provider.login(interaction);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const credential = await pending;

    expect(prompts[0]).toMatchObject({ type: 'text' });
    expect(events.find((event) => event.type === 'device_code')).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      intervalSeconds: 1,
      expiresInSeconds: 900,
    });

    expect(credential).toMatchObject({
      type: 'oauth',
      access: API_TOKEN,
      refresh: 'gho_1',
      expires: 1_800_000_000 * 1000 - API_TOKEN_MARGIN_MS,
      enterpriseUrl: undefined,
    });
    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: API_TOKEN,
      baseUrl: 'https://api.individual.githubcopilot.com',
    });

    const deviceRequest = requests.find((request) => request.url.endsWith('/login/device/code'));
    const deviceBody = new URLSearchParams(deviceRequest?.init.body as string | URLSearchParams);
    expect(deviceBody.get('scope')).toBe('read:user');

    const tokenRequest = requests.find(
      (request) => request.url === 'https://api.github.com/copilot_internal/v2/token',
    );
    expect(tokenRequest?.init.headers).toMatchObject({
      Authorization: 'Bearer gho_1',
      'Copilot-Integration-Id': 'vscode-chat',
    });
  });

  it('reports a denied device authorization', async () => {
    vi.useFakeTimers();
    stubFetch((url) => {
      if (url.endsWith('/login/device/code')) {
        return json({
          device_code: 'dc_2',
          user_code: 'CODE-2',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 900,
        });
      }
      if (url.endsWith('/login/oauth/access_token')) {
        return json({ error: 'access_denied', error_description: 'Denied by user' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction();
    const assertion = expect(provider.login(interaction)).rejects.toThrow(
      'Device flow failed: access_denied: Denied by user',
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('rejects a device code response with missing fields', async () => {
    stubFetch(() => json({ device_code: 'dc_3', user_code: 'CODE-3' }));

    const { interaction } = createInteraction();
    await expect(provider.login(interaction)).rejects.toThrow('Invalid device code response fields');
  });

  it('rejects a verification URI that is not http(s)', async () => {
    stubFetch(() =>
      json({
        device_code: 'dc_4',
        user_code: 'CODE-4',
        verification_uri: 'file:///tmp/device',
        interval: 1,
        expires_in: 900,
      }),
    );

    const { interaction } = createInteraction();
    await expect(provider.login(interaction)).rejects.toThrow(
      'Untrusted verification_uri in device code response',
    );
  });

  it('rejects an invalid enterprise domain before any request', async () => {
    const requests = stubFetch(() => json({}));

    const { interaction } = createInteraction({ text: 'not a domain' });
    await expect(provider.login(interaction)).rejects.toThrow('Invalid GitHub Enterprise URL/domain');
    expect(requests).toHaveLength(0);
  });
  it('marks the enterprise prompt as answerable with an empty value', async () => {
    vi.useFakeTimers();
    stubFetch((url) => {
      if (url === 'https://github.com/login/device/code') {
        return json({
          device_code: 'dc_1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          interval: 1,
          expires_in: 900,
        });
      }
      if (url === 'https://github.com/login/oauth/access_token') {
        return json({ access_token: 'gho_1' });
      }
      if (url === 'https://api.github.com/copilot_internal/v2/token') {
        return json({ token: API_TOKEN, expires_at: 1_800_000_000 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction, prompts } = createInteraction();
    const pending = provider.login(interaction);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    // The flow documents "blank for github.com", so the prompt has to allow an
    // empty answer — an input widget that ignores empty submissions would
    // otherwise block every device-code sign-in.
    expect(prompts[0]).toMatchObject({ type: 'text', allowEmpty: true });
  });
});

describe('github-copilot enterprise routing', () => {
  it('uses enterprise endpoints and stores the domain', async () => {
    vi.useFakeTimers();
    const enterpriseToken = 'tid=2;exp=1;proxy-ep=proxy.business.githubcopilot.com;';
    stubFetch((url) => {
      if (url === 'https://company.ghe.com/login/device/code') {
        return json({
          device_code: 'dc_ent',
          user_code: 'ENT-1',
          verification_uri: 'https://company.ghe.com/login/device',
          interval: 1,
          expires_in: 900,
        });
      }
      if (url === 'https://company.ghe.com/login/oauth/access_token') {
        return json({ access_token: 'gho_ent' });
      }
      if (url === 'https://api.company.ghe.com/copilot_internal/v2/token') {
        return json({ token: enterpriseToken, expires_at: 1_800_000_000 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction({ text: 'https://company.ghe.com' });
    const pending = provider.login(interaction);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const credential = await pending;

    expect(credential).toMatchObject({
      access: enterpriseToken,
      refresh: 'gho_ent',
      enterpriseUrl: 'company.ghe.com',
    });
    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: enterpriseToken,
      baseUrl: 'https://api.business.githubcopilot.com',
    });
  });
});

describe('github-copilot refresh', () => {
  it('rotates the API token through the stored enterprise domain', async () => {
    const rotated = 'tid=3;exp=2;proxy-ep=proxy.business.githubcopilot.com;';
    const requests = stubFetch((url) => {
      if (url === 'https://api.company.ghe.com/copilot_internal/v2/token') {
        return json({ token: rotated, expires_at: 1_900_000_000 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const credential = await provider.refresh(
      { type: 'oauth', access: 'stale', refresh: 'gho_ent', expires: 0, enterpriseUrl: 'company.ghe.com' },
      new AbortController().signal,
    );

    expect(credential).toMatchObject({
      access: rotated,
      refresh: 'gho_ent',
      expires: 1_900_000_000 * 1000 - API_TOKEN_MARGIN_MS,
      enterpriseUrl: 'company.ghe.com',
    });
    expect(requests[0]?.init.headers).toMatchObject({ Authorization: 'Bearer gho_ent' });
    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: rotated,
      baseUrl: 'https://api.business.githubcopilot.com',
    });
  });

  it('falls back to the account endpoint when the token carries no proxy endpoint', async () => {
    const tokenWithoutProxy = 'tid=4;exp=3;sku=free';
    stubFetch(() => json({ token: tokenWithoutProxy, expires_at: 1_900_000_000 }));

    const credential = await provider.refresh(
      { type: 'oauth', access: 'stale', refresh: 'gho_1', expires: 0 },
      new AbortController().signal,
    );

    expect(provider.toAuth?.(credential)).toEqual({
      apiKey: tokenWithoutProxy,
      baseUrl: 'https://api.individual.githubcopilot.com',
    });
  });

  it('surfaces API token exchange failures', async () => {
    stubFetch(() => new Response('boom', { status: 503, statusText: 'Service Unavailable' }));

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'stale', refresh: 'gho_1', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('503 Service Unavailable: boom');
  });
});
