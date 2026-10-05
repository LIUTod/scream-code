/**
 * Antigravity provider flow tests: the Google authorization-code sign-in, the
 * free-tier provisioning path, project resolution, refresh semantics and the
 * error paths. Every round-trip is stubbed; no request leaves the machine.
 */

import { createServer } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/google-antigravity';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const LOAD_CODE_ASSIST_URL = `${ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${ENDPOINT}/v1internal:onboardUser`;
const OPERATIONS_URL = `${ENDPOINT}/v1internal`;
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const MANUAL_PROMPT_MESSAGE =
  'Complete the sign-in in your browser, or paste the authorization code / redirect URL here:';
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

interface Harness {
  interaction: ProviderAuthInteraction;
  events: AuthEvent[];
  prompts: AuthPrompt[];
  controller: AbortController;
}

function createInteraction(manual: string | ((events: AuthEvent[]) => string)): Harness {
  const events: AuthEvent[] = [];
  const prompts: AuthPrompt[] = [];
  const controller = new AbortController();
  const interaction: ProviderAuthInteraction = {
    signal: controller.signal,
    prompt: async (prompt) => {
      prompts.push(prompt);
      if (prompt.type !== 'manual_code') throw new Error(`Unexpected prompt: ${prompt.type}`);
      return typeof manual === 'function' ? manual(events) : manual;
    },
    notify: (event) => {
      events.push(event);
    },
  };
  return { interaction, events, prompts, controller };
}

function authUrlFrom(events: AuthEvent[]): URL {
  const event = events.find((item) => item.type === 'auth_url');
  if (event?.type !== 'auth_url') throw new Error('No auth_url event was emitted');
  return new URL(event.url);
}

function progressMessages(events: AuthEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'progress' ? [event.message] : []));
}

function formBody(request: RecordedRequest | undefined): URLSearchParams {
  return new URLSearchParams(request?.init.body as string);
}

/** The happy-path control plane: free tier allowed, project already assigned. */
function provisionedHandler(projectId = 'proj-1'): Handler {
  return (url, init) => {
    if (url === TOKEN_URL) {
      expect(init.method).toBe('POST');
      return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
    }
    if (url === USERINFO_URL) return json({ email: 'user@example.com' });
    if (url === LOAD_CODE_ASSIST_URL) {
      // The control plane is addressed with POST; a GET here is a regression.
      expect(init.method).toBe('POST');
      return json({
        currentTier: { id: 'free-tier' },
        allowedTiers: [{ id: 'free-tier' }],
        cloudaicompanionProject: projectId,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

function userAgentOf(request: RecordedRequest | undefined): string {
  return ((request?.init.headers ?? {}) as Record<string, string>)['User-Agent'] ?? '';
}

beforeEach(() => {
  // The Google flows read these overrides; pin them so a value exported in
  // the developer environment cannot change what these tests exercise.
  vi.stubEnv('SCREAM_CODE_OAUTH_CALLBACK_HOST', '');
  vi.stubEnv('SCREAM_CODE_ANTIGRAVITY_VERSION', '');
  vi.stubEnv('SCREAM_CODE_GEMINI_CLI_VERSION', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('google-antigravity module metadata', () => {
  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'google-antigravity',
      name: 'Antigravity (Gemini 3, Claude, GPT-OSS)',
      isSubscription: true,
      flowLabel: 'browser',
      providerConfigType: 'google-cloud-code',
    });
    expect(provider.loginLabel).not.toBe('');
  });
});

describe('google-antigravity sign-in', () => {
  it('signs in with a pasted authorization code and resolves the project', async () => {
    const requests = stubFetch(provisionedHandler());
    const before = Date.now();

    const { interaction, events, prompts } = createInteraction('  manual-code  ');
    const credential = await provider.login(interaction);

    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'ag-access',
      refresh: 'ag-refresh',
      email: 'user@example.com',
      projectId: 'proj-1',
    });
    const expiresInMs = credential.expires - before;
    expect(expiresInMs).toBeGreaterThan(3600 * 1000 - EXPIRY_SKEW_MS - 5_000);
    expect(expiresInMs).toBeLessThan(3600 * 1000 - EXPIRY_SKEW_MS + 5_000);

    const authUrl = authUrlFrom(events);
    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(authUrl.pathname).toBe('/o/oauth2/v2/auth');
    const params = authUrl.searchParams;
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe(
      [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
      ].join(' '),
    );
    expect(params.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
    // This client is not a PKCE client.
    expect(params.get('code_challenge')).toBeNull();

    const redirectUri = new URL(params.get('redirect_uri') ?? '');
    expect(redirectUri.hostname).toBe('127.0.0.1');
    expect(redirectUri.pathname).toBe('/oauth-callback');

    // The paste prompt is the manual fallback for when the browser cannot
    // reach the loopback listener; its placeholder is the redirect URL.
    expect(prompts).toEqual([
      {
        type: 'manual_code',
        message: MANUAL_PROMPT_MESSAGE,
        placeholder: redirectUri.toString(),
        signal: expect.any(AbortSignal),
      },
    ]);

    const tokenRequest = requests.find((request) => request.url === TOKEN_URL);
    const tokenBody = formBody(tokenRequest);
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('client_id')).toBe(CLIENT_ID);
    expect(tokenBody.get('code')).toBe('manual-code');
    expect(tokenBody.get('redirect_uri')).toBe(redirectUri.toString());

    // The account's tier is read twice — once plainly, once scoped to the
    // project found in the first response — and both reads are repeated after
    // the tier check to pick up the project the backend assigns.
    const tierRequests = requests.filter((request) => request.url === LOAD_CODE_ASSIST_URL);
    expect(tierRequests).toHaveLength(4);
    expect(tierRequests[0]?.init.body).not.toContain('cloudaicompanionProject');
    expect(tierRequests[1]?.init.body).toContain('"cloudaicompanionProject":"proj-1"');
    expect(tierRequests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer ag-access',
      'Content-Type': 'application/json',
    });
    expect((tierRequests[0]?.init.headers as Record<string, string>)['User-Agent']).toMatch(
      /^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=darwin; arch=arm64; cl=\d+\)$/,
    );

    expect(progressMessages(events)).toEqual([
      'Exchanging the authorization code for tokens...',
      'Checking Cloud Code Assist account status...',
      'Refreshing Cloud Code Assist project...',
    ]);
  });

  it('completes the sign-in through the loopback callback', { timeout: 15_000 }, async () => {
    stubFetch(provisionedHandler('proj-callback'));

    let callbackResponse: Promise<Response> | undefined;
    let failPendingPrompt: (() => void) | undefined;
    const events: AuthEvent[] = [];
    const interaction: ProviderAuthInteraction = {
      signal: new AbortController().signal,
      prompt: (prompt) =>
        new Promise<string>((_resolve, reject) => {
          // The browser leg owns the answer: the prompt never resolves on its
          // own. The test's finally block rejects it so a callback that never
          // arrives fails with a diagnostic instead of hanging.
          failPendingPrompt = () => {
            reject(new Error('the loopback callback never arrived'));
          };
          prompt.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            {
              once: true,
            },
          );
        }),
      notify: (event) => {
        events.push(event);
        if (event.type !== 'auth_url') return;
        const url = new URL(event.url);
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
        redirect.searchParams.set('code', 'callback-code');
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
        callbackResponse = nativeFetch(redirect);
      },
    };

    try {
      const credential = await provider.login(interaction);

      expect(credential['projectId']).toBe('proj-callback');
      const response = await callbackResponse;
      expect(response?.status).toBe(200);
      expect(await response?.text()).toContain('Signed in to Antigravity');
    } finally {
      failPendingPrompt?.();
    }
  });

  it('provisions the free tier when the account has none', async () => {
    vi.useFakeTimers();
    let tierReads = 0;
    stubFetch((url, init) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) {
        tierReads += 1;
        return tierReads === 1
          ? json({ allowedTiers: [{ id: 'free-tier' }] })
          : json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'proj-new' });
      }
      if (url === ONBOARD_USER_URL) {
        expect(init.method).toBe('POST');
        return json({ name: 'operations/onboard-1', done: false });
      }
      if (url === `${OPERATIONS_URL}/operations/onboard-1`) {
        // The operation is polled with GET.
        expect(init.method).toBe('GET');
        return json({ done: true, response: { cloudaicompanionProject: 'proj-new' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction, events } = createInteraction('manual-code');
    const pending = provider.login(interaction);
    await vi.advanceTimersByTimeAsync(1_000);
    const credential = await pending;

    expect(credential['projectId']).toBe('proj-new');
    expect(progressMessages(events)).toContain('Provisioning the Antigravity free tier...');
  });

  it('reports an onboarding operation that completes with an error', async () => {
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) return json({ allowedTiers: [{ id: 'free-tier' }] });
      if (url === ONBOARD_USER_URL) {
        return json({ done: true, error: { code: 500, message: 'backend exploded' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'OnboardUser operation failed: 500: backend exploded',
    );
    expect(requests.filter((request) => request.url === ONBOARD_USER_URL)).toHaveLength(1);
  });

  it('gives up on an onboarding operation that outlives the deadline', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) return json({ allowedTiers: [{ id: 'free-tier' }] });
      if (url === ONBOARD_USER_URL) {
        return json({ name: 'operations/onboard-slow', done: false });
      }
      if (url === `${OPERATIONS_URL}/operations/onboard-slow`) {
        polls += 1;
        return json({ name: 'operations/onboard-slow', done: false });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    const assertion = expect(provider.login(interaction)).rejects.toThrow(
      'onboardUser timed out after 30000ms',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(requests.filter((request) => request.url === ONBOARD_USER_URL)).toHaveLength(1);
    expect(polls).toBe(29);
  });

  it('rejects an onboarding operation that does not name itself', async () => {
    vi.useFakeTimers();
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) return json({ allowedTiers: [{ id: 'free-tier' }] });
      if (url === ONBOARD_USER_URL) return json({ done: false });
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    const assertion = expect(provider.login(interaction)).rejects.toThrow(
      'onboardUser returned an operation without a name',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    // The nameless operation cannot be polled, so no polling request is made.
    expect(requests.filter((request) => request.url === ONBOARD_USER_URL)).toHaveLength(1);
    expect(requests.filter((request) => request.url.startsWith(`${OPERATIONS_URL}/`))).toHaveLength(
      0,
    );
  });

  it('rejects an onboarding operation that completes without a response', async () => {
    vi.useFakeTimers();
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) return json({ allowedTiers: [{ id: 'free-tier' }] });
      if (url === ONBOARD_USER_URL) {
        return json({ name: 'operations/onboard-empty', done: false });
      }
      if (url === `${OPERATIONS_URL}/operations/onboard-empty`) return json({ done: true });
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    const assertion = expect(provider.login(interaction)).rejects.toThrow(
      'failed to unmarshal OnboardUserResponse',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(
      requests.filter((request) => request.url === `${OPERATIONS_URL}/operations/onboard-empty`),
    ).toHaveLength(1);
  });

  it('reports a sign-in that finishes without a resolvable project', async () => {
    let tierReads = 0;
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) {
        tierReads += 1;
        return tierReads === 1 ? json({ allowedTiers: [{ id: 'free-tier' }] }) : json({});
      }
      if (url === ONBOARD_USER_URL) {
        return json({ done: true, response: { cloudaicompanionProject: 'proj-unused' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'loadCodeAssist did not return a cloudaicompanionProject',
    );
    expect(requests.filter((request) => request.url === LOAD_CODE_ASSIST_URL)).toHaveLength(2);
  });

  it('wraps unexpected discovery failures in the provider wording', async () => {
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) throw new Error('socket hang up');
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'Could not discover an Antigravity project. socket hang up',
    );
    expect(requests).toHaveLength(3);
  });

  it('signs in even when the userinfo lookup fails', async () => {
    stubFetch((url, init) => {
      if (url === USERINFO_URL) {
        return new Response('temporarily unavailable', {
          status: 500,
          statusText: 'Internal Server Error',
        });
      }
      return provisionedHandler()(url, init);
    });

    const { interaction } = createInteraction('manual-code');
    const credential = await provider.login(interaction);

    expect(credential).toMatchObject({ access: 'ag-access', projectId: 'proj-1' });
    // Best effort: the failed lookup yields a credential with no email key at
    // all, not one carrying `email: undefined`.
    expect('email' in credential).toBe(false);
  });

  it('reports cancellation while the token exchange is in flight', async () => {
    let onTokenRequest: (() => void) | undefined;
    const tokenRequestStarted = new Promise<void>((resolve) => {
      onTokenRequest = resolve;
    });
    const requests = stubFetch((url, init) => {
      if (url !== TOKEN_URL) throw new Error(`Unexpected request: ${url}`);
      onTokenRequest?.();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('request aborted'));
          },
          { once: true },
        );
      });
    });

    const { interaction, controller } = createInteraction('manual-code');
    const pending = provider.login(interaction);
    await tokenRequestStarted;
    controller.abort();

    await expect(pending).rejects.toThrow('Login cancelled');
    // Nothing follows the aborted exchange: no userinfo lookup, no tier read.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(TOKEN_URL);
  });

  it('falls back to an ephemeral port when the registered one is in use', async () => {
    const occupyingServer = createServer();
    await new Promise<void>((resolve, reject) => {
      occupyingServer.once('error', reject);
      occupyingServer.listen(51121, '127.0.0.1', resolve);
    });

    try {
      stubFetch(provisionedHandler());
      const { interaction, events } = createInteraction('manual-code');
      const credential = await provider.login(interaction);

      expect(credential['projectId']).toBe('proj-1');
      const redirectUri = new URL(authUrlFrom(events).searchParams.get('redirect_uri') ?? '');
      expect(redirectUri.hostname).toBe('127.0.0.1');
      expect(redirectUri.pathname).toBe('/oauth-callback');
      expect(Number(redirectUri.port)).toBeGreaterThan(0);
      expect(Number(redirectUri.port)).not.toBe(51121);

      expect(events.filter((event) => event.type === 'info')).toEqual([
        {
          type: 'info',
          message: `Port 51121 is in use; listening on ${redirectUri.toString()} instead.`,
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => {
        occupyingServer.close(() => {
          resolve();
        });
      });
    }
  });

  it('reports the overridden client version in the control-plane user agent', async () => {
    vi.stubEnv('SCREAM_CODE_ANTIGRAVITY_VERSION', '9.9.9-test');
    const requests = stubFetch(provisionedHandler());

    const { interaction } = createInteraction('manual-code');
    await provider.login(interaction);

    expect(userAgentOf(requests.find((request) => request.url === LOAD_CODE_ASSIST_URL))).toMatch(
      /^antigravity\/hub\/9\.9\.9-test \(aidev_client; os_type=darwin; arch=arm64; cl=\d+\)$/,
    );
  });

  it('falls back to the bundled client version when the override is blank', async () => {
    const requests = stubFetch(provisionedHandler());

    const { interaction } = createInteraction('manual-code');
    await provider.login(interaction);

    expect(userAgentOf(requests.find((request) => request.url === LOAD_CODE_ASSIST_URL))).toMatch(
      /^antigravity\/hub\/2\.19\.1 \(aidev_client; os_type=darwin; arch=arm64; cl=\d+\)$/,
    );
  });

  it('reports an account that is not eligible for the free tier', async () => {
    stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) {
        return json({
          allowedTiers: [],
          ineligibleTiers: [
            {
              tierId: 'free-tier',
              reasonMessage: 'This account is not eligible',
              validationUrl: 'https://example.test/verify',
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'This account is not eligible\nhttps://example.test/verify',
    );
  });

  it('turns an account-verification error into a validation message', async () => {
    stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'ag-access', refresh_token: 'ag-refresh', expires_in: 3600 });
      }
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      if (url === LOAD_CODE_ASSIST_URL) {
        return new Response(
          JSON.stringify({
            error: {
              details: [
                {
                  reason: 'VALIDATION_REQUIRED',
                  metadata: { validation_url: 'https://example.test/validate' },
                },
              ],
            },
          }),
          { status: 403, statusText: 'Forbidden' },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'Account verification required for user@example.com. ' +
        'Visit https://example.test/validate to continue, then sign in again.',
    );
  });

  it('rejects a token response without a refresh token', async () => {
    stubFetch((url) => {
      if (url === TOKEN_URL) return json({ access_token: 'ag-access', expires_in: 3600 });
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'No refresh token received. Please try again.',
    );
  });

  it('surfaces token exchange failures', async () => {
    stubFetch((url) => {
      if (url === TOKEN_URL) return new Response('invalid_grant', { status: 400 });
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'google-antigravity token exchange failed: 400 invalid_grant',
    );
  });

  it('rejects a pasted redirect URL whose state does not match', async () => {
    stubFetch(provisionedHandler());

    const { interaction } = createInteraction(
      (events) =>
        `${authUrlFrom(events).searchParams.get('redirect_uri')}?code=manual-code&state=forged`,
    );
    await expect(provider.login(interaction)).rejects.toThrow('OAuth state mismatch');
  });
});

describe('google-antigravity refresh', () => {
  it('refreshes the token pair and keeps the bound project', async () => {
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) {
        return json({ access_token: 'fresh-access', expires_in: 1800 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const credential = await provider.refresh(
      {
        type: 'oauth',
        access: 'stale-access',
        refresh: 'ag-refresh',
        expires: 0,
        email: 'user@example.com',
        projectId: 'proj-1',
      },
      new AbortController().signal,
    );

    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'fresh-access',
      // A non-rotating grant keeps the stored refresh token.
      refresh: 'ag-refresh',
      email: 'user@example.com',
      projectId: 'proj-1',
    });

    const body = formBody(requests[0]);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe('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');
    expect(body.get('refresh_token')).toBe('ag-refresh');
  });

  it('requires the stored project before refreshing', async () => {
    const requests = stubFetch(() => json({}));

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'stale', refresh: 'ag-refresh', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('google-antigravity credentials are missing projectId; sign in again');
    expect(requests).toHaveLength(0);
  });

  it('surfaces refresh failures', async () => {
    stubFetch(() => new Response('invalid_grant', { status: 400 }));

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'stale', refresh: 'expired', expires: 0, projectId: 'proj-1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('google-antigravity token refresh failed: 400 invalid_grant');
  });

  it('derives structured Cloud Code Assist request auth from the stored credential', () => {
    const credential = {
      type: 'oauth',
      access: 'ag-access',
      refresh: 'ag-refresh',
      expires: Date.now() + 60 * 60 * 1000,
      projectId: 'proj-1',
    } as const;

    const auth = provider.toAuth?.({ ...credential });
    expect(auth?.headers).toBeUndefined();
    expect(auth?.baseUrl).toBe(ENDPOINT);
    expect(JSON.parse(auth?.apiKey ?? '')).toEqual({
      token: 'ag-access',
      projectId: 'proj-1',
      endpoint: ENDPOINT,
    });
  });
});
