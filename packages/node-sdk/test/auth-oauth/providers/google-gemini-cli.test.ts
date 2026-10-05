/**
 * Gemini CLI provider flow tests: the Google authorization-code sign-in,
 * project discovery and onboarding, the workspace-project requirements, refresh
 * semantics and the error paths. Every round-trip is stubbed; no request leaves
 * the machine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provider } from '../../../src/auth-oauth/providers/google-gemini-cli';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '../../../src/auth-oauth/types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const LOAD_CODE_ASSIST_URL = `${ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${ENDPOINT}/v1internal:onboardUser`;
const OPERATIONS_URL = `${ENDPOINT}/v1internal`;
const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const WORKSPACE_PROJECT_HINT = 'requires setting the GOOGLE_CLOUD_PROJECT';
const MANUAL_PROMPT_MESSAGE =
  'Complete the sign-in in your browser, or paste the authorization code / redirect URL here:';

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

function createInteraction(manual: string): Harness {
  const events: AuthEvent[] = [];
  const prompts: AuthPrompt[] = [];
  const controller = new AbortController();
  const interaction: ProviderAuthInteraction = {
    signal: controller.signal,
    prompt: async (prompt) => {
      prompts.push(prompt);
      if (prompt.type !== 'manual_code') throw new Error(`Unexpected prompt: ${prompt.type}`);
      return manual;
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

function headersOf(request: RecordedRequest | undefined): Record<string, string> {
  return (request?.init.headers ?? {}) as Record<string, string>;
}

/** The request body as sent: the control-plane bodies are JSON strings. */
function bodyText(request: RecordedRequest | undefined): string {
  const body = request?.init.body;
  if (typeof body !== 'string') throw new Error('Expected a string request body');
  return body;
}

/** Exchanges the pasted code for tokens and returns the account email. */
function tokenHandler(): Handler {
  return (url) => {
    if (url === TOKEN_URL) {
      return json({ access_token: 'gc-access', refresh_token: 'gc-refresh', expires_in: 3600 });
    }
    if (url === USERINFO_URL) return json({ email: 'user@example.com' });
    throw new Error(`Unexpected request: ${url}`);
  };
}

/** Fails a request only after the token and userinfo legs have answered. */
function afterSignIn(url: string, handler: Handler): Handler {
  return (candidate, init) => {
    if (candidate === TOKEN_URL || candidate === USERINFO_URL) return tokenHandler()(candidate, init);
    if (candidate !== url) throw new Error(`Unexpected request: ${candidate}`);
    return handler(candidate, init);
  };
}

beforeEach(() => {
  // The workspace-project variables steer project resolution; the rest pin the
  // callback host and the client-version overrides the Google flows read.
  // Tests that need a value set their own; pinning the rest keeps the suite
  // hermetic.
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT_ID', '');
  vi.stubEnv('SCREAM_CODE_OAUTH_CALLBACK_HOST', '');
  vi.stubEnv('SCREAM_CODE_GEMINI_CLI_VERSION', '');
  vi.stubEnv('SCREAM_CODE_ANTIGRAVITY_VERSION', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('google-gemini-cli module metadata', () => {
  it('identifies itself to the provider registry', () => {
    expect(provider).toMatchObject({
      id: 'google-gemini-cli',
      name: 'Google Cloud Code Assist (Gemini CLI)',
      isSubscription: true,
      flowLabel: 'browser',
      providerConfigType: 'google-cloud-code',
    });
    expect(provider.loginLabel).not.toBe('');
  });
});

describe('google-gemini-cli sign-in', () => {
  it('signs in with a pasted authorization code and reuses the account project', async () => {
    const requests = stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () =>
        json({ currentTier: { id: 'free-tier' }, cloudaicompanionProject: 'proj-existing' }),
      ),
    );
    const before = Date.now();

    const { interaction, events, prompts } = createInteraction('manual-code');
    const credential = await provider.login(interaction);

    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'gc-access',
      refresh: 'gc-refresh',
      email: 'user@example.com',
      projectId: 'proj-existing',
    });
    const expiresInMs = credential.expires - before;
    expect(expiresInMs).toBeGreaterThan(3600 * 1000 - EXPIRY_SKEW_MS - 5_000);
    expect(expiresInMs).toBeLessThan(3600 * 1000 - EXPIRY_SKEW_MS + 5_000);

    const authUrl = authUrlFrom(events);
    const params = authUrl.searchParams;
    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('scope')).toBe(
      [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ].join(' '),
    );
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('code_challenge')).toBeNull();
    const redirectUri = new URL(params.get('redirect_uri') ?? '');
    expect(redirectUri.hostname).toBe('127.0.0.1');
    expect(redirectUri.pathname).toBe('/oauth2callback');

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

    expect(formBody(requests.find((request) => request.url === TOKEN_URL)).get('code')).toBe(
      'manual-code',
    );

    // An account that already has a project needs no onboarding round-trip.
    const tierRequests = requests.filter((request) => request.url === LOAD_CODE_ASSIST_URL);
    expect(tierRequests).toHaveLength(1);
    const headers = headersOf(tierRequests[0]);
    expect(headers['Authorization']).toBe('Bearer gc-access');
    expect(headers['Client-Metadata']).toBe(
      'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
    );
    expect(headers['User-Agent']).toMatch(/^GeminiCLI\/\d+\.\d+\.\d+\/.+ \(.+; .+; terminal\)$/);
    expect(tierRequests[0]?.init.body).toContain('"pluginType":"GEMINI"');
  });

  it('onboards the account and follows the provisioning operation', async () => {
    vi.useFakeTimers();
    let operationReads = 0;
    const requests = stubFetch((url) => {
      if (url === LOAD_CODE_ASSIST_URL)
        return json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] });
      if (url === ONBOARD_USER_URL) return json({ name: 'operations/onboard-1', done: false });
      if (url === `${OPERATIONS_URL}/operations/onboard-1`) {
        operationReads += 1;
        // The first poll still finds the operation running; the second one
        // reports the provisioned project.
        return operationReads === 1
          ? json({ done: false })
          : json({ done: true, response: { cloudaicompanionProject: { id: 'proj-onboarded' } } });
      }
      return tokenHandler()(url, {});
    });

    const { interaction, events } = createInteraction('manual-code');
    const pending = provider.login(interaction);
    await vi.advanceTimersByTimeAsync(5_000);
    const credential = await pending;

    expect(credential['projectId']).toBe('proj-onboarded');
    const onboardRequest = requests.find((request) => request.url === ONBOARD_USER_URL);
    expect(onboardRequest?.init.body).toContain('"tierId":"free-tier"');
    expect(progressMessages(events)).toEqual([
      'Exchanging the authorization code for tokens...',
      'Checking for existing Cloud Code Assist project...',
      'Provisioning Cloud Code Assist project (this may take a moment)...',
      'Waiting for project provisioning (attempt 2/24)...',
    ]);
  });

  it('honors the workspace project named by the environment', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    const requests = stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () => json({ currentTier: { id: 'legacy-tier' } })),
    );

    const { interaction } = createInteraction('manual-code');
    const credential = await provider.login(interaction);

    expect(credential['projectId']).toBe('env-project');
    expect(requests.find((request) => request.url === LOAD_CODE_ASSIST_URL)?.init.body).toContain(
      '"cloudaicompanionProject":"env-project"',
    );
  });

  it('falls back to GOOGLE_CLOUD_PROJECT_ID when GOOGLE_CLOUD_PROJECT is blank', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT_ID', 'fallback-project');
    const requests = stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () => json({ currentTier: { id: 'legacy-tier' } })),
    );

    const { interaction } = createInteraction('manual-code');
    const credential = await provider.login(interaction);

    expect(credential['projectId']).toBe('fallback-project');
    const body = bodyText(requests.find((request) => request.url === LOAD_CODE_ASSIST_URL));
    expect(body).toContain('"cloudaicompanionProject":"fallback-project"');
    expect(body).toContain('"duetProject":"fallback-project"');
  });

  it('onboards a non-free tier account scoped to the environment project', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    const requests = stubFetch((url, init) => {
      if (url === LOAD_CODE_ASSIST_URL) {
        return json({ allowedTiers: [{ id: 'standard-tier', isDefault: true }] });
      }
      if (url === ONBOARD_USER_URL) {
        return json({ done: true, response: { cloudaicompanionProject: { id: 'env-project' } } });
      }
      return tokenHandler()(url, init);
    });

    const { interaction } = createInteraction('manual-code');
    const credential = await provider.login(interaction);

    expect(credential['projectId']).toBe('env-project');
    expect(requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      USERINFO_URL,
      LOAD_CODE_ASSIST_URL,
      ONBOARD_USER_URL,
    ]);
    // A non-free tier keeps its scope: the onboarding operation is addressed
    // to the environment project, both top-level and in the metadata.
    const onboardBody: unknown = JSON.parse(
      bodyText(requests.find((request) => request.url === ONBOARD_USER_URL)),
    );
    expect(onboardBody).toEqual({
      tierId: 'standard-tier',
      cloudaicompanionProject: 'env-project',
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: 'env-project',
      },
    });
  });

  it('requires a workspace project when the policy needs one', async () => {
    stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () => json({ allowedTiers: [{ id: 'standard-tier', isDefault: true }] })),
    );

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(WORKSPACE_PROJECT_HINT);
  });

  it('treats a policy-blocked account as already provisioned', async () => {
    stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () =>
        new Response(
          JSON.stringify({
            error: { details: [{ reason: 'SECURITY_POLICY_VIOLATED' }] },
          }),
          { status: 403, statusText: 'Forbidden' },
        ),
      ),
    );

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(WORKSPACE_PROJECT_HINT);
  });

  it('reuses the environment project for a policy-blocked account', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    const requests = stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () =>
        new Response(
          JSON.stringify({
            error: { details: [{ reason: 'SECURITY_POLICY_VIOLATED' }] },
          }),
          { status: 403, statusText: 'Forbidden' },
        ),
      ),
    );

    const { interaction } = createInteraction('manual-code');
    const credential = await provider.login(interaction);

    // A policy-blocked account is treated as already provisioned: the
    // environment project is used without an onboarding round-trip.
    expect(credential['projectId']).toBe('env-project');
    expect(requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      USERINFO_URL,
      LOAD_CODE_ASSIST_URL,
    ]);
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

  it('gives up when provisioning never completes', async () => {
    vi.useFakeTimers();
    stubFetch((url, init) => {
      if (url === ONBOARD_USER_URL) return json({ name: 'operations/onboard-stuck', done: false });
      if (url === `${OPERATIONS_URL}/operations/onboard-stuck`) return json({ done: false });
      return afterSignIn(LOAD_CODE_ASSIST_URL, () =>
        json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      )(url, init);
    });

    const { interaction } = createInteraction('manual-code');
    const assertion = expect(provider.login(interaction)).rejects.toThrow(
      'Project provisioning did not complete after 24 attempts',
    );
    await vi.advanceTimersByTimeAsync(200_000);
    await assertion;
  });

  it('surfaces token exchange failures', async () => {
    stubFetch((url) => {
      if (url === TOKEN_URL) return new Response('invalid_grant', { status: 400 });
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'google-gemini-cli token exchange failed: 400 invalid_grant',
    );
  });

  it('reports the overridden client version in the control-plane user agent', async () => {
    vi.stubEnv('SCREAM_CODE_GEMINI_CLI_VERSION', '9.9.9-test');
    const requests = stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () =>
        json({ currentTier: { id: 'legacy-tier' }, cloudaicompanionProject: 'proj-existing' }),
      ),
    );

    const { interaction } = createInteraction('manual-code');
    await provider.login(interaction);

    expect(
      headersOf(requests.find((request) => request.url === LOAD_CODE_ASSIST_URL))['User-Agent'],
    ).toBe(`GeminiCLI/9.9.9-test/gemini-3.1-pro-preview (${process.platform}; ${process.arch}; terminal)`);
  });

  it('falls back to the bundled client version when the override is blank', async () => {
    const requests = stubFetch(
      afterSignIn(LOAD_CODE_ASSIST_URL, () =>
        json({ currentTier: { id: 'legacy-tier' }, cloudaicompanionProject: 'proj-existing' }),
      ),
    );

    const { interaction } = createInteraction('manual-code');
    await provider.login(interaction);

    expect(
      headersOf(requests.find((request) => request.url === LOAD_CODE_ASSIST_URL))['User-Agent'],
    ).toBe(`GeminiCLI/0.46.0/gemini-3.1-pro-preview (${process.platform}; ${process.arch}; terminal)`);
  });

  it('requires a refresh token in the token response', async () => {
    stubFetch((url) => {
      if (url === TOKEN_URL) return json({ access_token: 'gc-access', expires_in: 3600 });
      if (url === USERINFO_URL) return json({ email: 'user@example.com' });
      throw new Error(`Unexpected request: ${url}`);
    });

    const { interaction } = createInteraction('manual-code');
    await expect(provider.login(interaction)).rejects.toThrow(
      'No refresh token received. Please try again.',
    );
  });
});

describe('google-gemini-cli refresh', () => {
  it('refreshes the token pair and keeps the bound project', async () => {
    const requests = stubFetch((url) => {
      if (url === TOKEN_URL) return json({ access_token: 'fresh-access', expires_in: 1800 });
      throw new Error(`Unexpected request: ${url}`);
    });

    const credential = await provider.refresh(
      {
        type: 'oauth',
        access: 'stale-access',
        refresh: 'gc-refresh',
        expires: 0,
        email: 'user@example.com',
        projectId: 'proj-existing',
      },
      new AbortController().signal,
    );

    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'fresh-access',
      refresh: 'gc-refresh',
      email: 'user@example.com',
      projectId: 'proj-existing',
    });
    const body = formBody(requests[0]);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe('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');
    expect(body.get('refresh_token')).toBe('gc-refresh');
  });

  it('requires the stored project before refreshing', async () => {
    const requests = stubFetch(() => json({}));

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'stale', refresh: 'gc-refresh', expires: 0 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('google-gemini-cli credentials are missing projectId; sign in again');
    expect(requests).toHaveLength(0);
  });

  it('surfaces refresh failures', async () => {
    stubFetch(() => new Response('invalid_grant', { status: 400 }));

    await expect(
      provider.refresh(
        { type: 'oauth', access: 'stale', refresh: 'expired', expires: 0, projectId: 'proj-1' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('google-gemini-cli token refresh failed: 400 invalid_grant');
  });

  it('derives structured Cloud Code Assist request auth from the stored credential', () => {
    const credential = {
      type: 'oauth',
      access: 'gc-access',
      refresh: 'gc-refresh',
      expires: Date.now() + 60 * 60 * 1000,
      projectId: 'proj-1',
    } as const;

    const auth = provider.toAuth?.({ ...credential });
    expect(auth?.headers).toBeUndefined();
    expect(auth?.baseUrl).toBe(ENDPOINT);
    expect(JSON.parse(auth?.apiKey ?? '')).toEqual({
      token: 'gc-access',
      projectId: 'proj-1',
      endpoint: ENDPOINT,
    });
  });
});
