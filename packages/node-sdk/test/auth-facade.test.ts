import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTokenStorage, SCREAM_CODE_PROVIDER_NAME, type TokenInfo } from '@scream-cli/scream-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreamHarness } from '#/index';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { TEST_IDENTITY } from './test-identity';

let homeDir: string;

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function freshToken(): TokenInfo {
  return {
    accessToken: 'oauth-access-token',
    refreshToken: 'oauth-refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };
}

beforeEach(() => {
  homeDir = join(tmpdir(), `scream-sdk-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('ScreamHarness.auth', () => {
  it('can construct auth facade without host identity', () => {
    expect(() => new ScreamHarness({ homeDir })).not.toThrow();
  });

  it('exposes a cached access token without refreshing auth state', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.getCachedAccessToken()).resolves.toBe('oauth-access-token');
  });

  it('provisions SDK config using an existing Scream OAuth token', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'scream-for-coding',
                context_length: 262144,
                supports_reasoning: true,
                supports_image_in: true,
                supports_video_in: true,
                display_name: 'Scream for Coding',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });
    const result = await harness.auth.login();
    const config = await harness.getConfig({ reload: true });

    expect(result).toMatchObject({
      providerName: SCREAM_CODE_PROVIDER_NAME,
      ok: true,
      defaultModel: 'scream-code/scream-for-coding',
      defaultThinking: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.scream.com/coding/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
        }),
      }),
    );
    expect(config.defaultModel).toBe('scream-code/scream-for-coding');
    expect(config.models?.['scream-code/scream-for-coding']).toMatchObject({
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Scream for Coding',
    });
    expect(new ProviderManager({ config }).resolveProviderConfig(config.defaultModel!)).toMatchObject({
      modelCapabilities: {
        tool_use: true,
      },
    });
    expect(config.providers[SCREAM_CODE_PROVIDER_NAME]).toMatchObject({
      type: 'scream',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/scream-code' },
    });
    expect(config.services?.screamCliSearch?.oauth).toEqual({
      storage: 'file',
      key: 'oauth/scream-code',
    });
  });

  it('fails clearly when a configured model alias does not have max_context_size', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "scream-code/scream-for-coding"

[providers."managed:scream-code"]
type = "scream"
api_key = ""

[models."scream-code/scream-for-coding"]
provider = "managed:scream-code"
model = "scream-for-coding"
`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'scream-for-coding',
                  context_length: 262144,
                  supports_reasoning: true,
                  supports_image_in: true,
                  supports_video_in: true,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    expect(() => new ScreamHarness({ homeDir, identity: TEST_IDENTITY })).toThrow(
      /Model "scream-code\/scream-for-coding" must define a positive max_context_size/,
    );
  });

  it('removes managed Scream config on logout', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "scream-code/scream-for-coding"

[providers."managed:scream-code"]
type = "scream"
api_key = ""
oauth = { storage = "file", key = "oauth/scream-code" }

[providers.custom]
type = "scream"
api_key = "sk-existing"

[models."scream-code/scream-for-coding"]
provider = "managed:scream-code"
model = "scream-for-coding"
max_context_size = 262144

[models.custom-default]
provider = "custom"
model = "custom-model"
max_context_size = 1000

[services.scream_cli_search]
base_url = "https://api.scream.com/coding/v1/search"
api_key = ""
oauth = { storage = "file", key = "oauth/scream-code" }

[services.scream_cli_fetch]
base_url = "https://api.scream.com/coding/v1/fetch"
api_key = ""
oauth = { storage = "file", key = "oauth/scream-code" }
`,
    );

    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    await expect(harness.auth.logout()).resolves.toMatchObject({
      providerName: SCREAM_CODE_PROVIDER_NAME,
      ok: true,
    });

    const config = await harness.getConfig({ reload: true });
    expect(config.defaultModel).toBeUndefined();
    expect(config.providers[SCREAM_CODE_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['custom']).toMatchObject({ apiKey: 'sk-existing' });
    expect(config.models?.['scream-code/scream-for-coding']).toBeUndefined();
    expect(config.models?.['custom-default']).toMatchObject({ provider: 'custom' });
    expect(config.services?.screamCliSearch).toBeUndefined();
    expect(config.services?.screamCliFetch).toBeUndefined();
    await expect(
      new FileTokenStorage(join(homeDir, 'credentials')).load('scream-code'),
    ).resolves.toBeUndefined();

    const text = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(text).not.toContain('managed:scream-code');
    expect(text).not.toContain('scream-code/scream-for-coding');
    expect(text).not.toContain('scream_cli_search');
  });

  it('gets managed usage without host identity and sends only auth headers', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(
      async (_input, _init) =>
        new Response(
          JSON.stringify({
            usage: { used: 1, limit: 10, name: 'Weekly limit' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const harness = new ScreamHarness({ homeDir });
    const result = await harness.auth.getManagedUsage();

    expect(result).toMatchObject({
      kind: 'ok',
      summary: { label: 'Weekly limit', used: 1, limit: 10 },
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBeNull();
    expect(headers.get('x-msh-platform')).toBeNull();
  });

  it('submitFeedback maps camelCase input to snake_case body and posts with bearer auth', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    const fetchMock = vi.fn<FetchMock>(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const harness = new ScreamHarness({ homeDir });
    const result = await harness.auth.submitFeedback({
      content: 'great tool',
      sessionId: 'sess-42',
      version: 'scream-code-0.1.1',
      os: 'Darwin 25.3.0',
      model: 'scream-code/scream-for-coding',
    });

    expect(result).toEqual({ kind: 'ok' });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.scream.com/coding/v1/feedback');
    expect(init?.method).toBe('POST');

    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    expect(headers.get('content-type')).toBe('application/json');

    expect(JSON.parse(init?.body as string)).toEqual({
      session_id: 'sess-42',
      content: 'great tool',
      version: 'scream-code-0.1.1',
      os: 'Darwin 25.3.0',
      model: 'scream-code/scream-for-coding',
    });
  });

  it('submitFeedback surfaces HTTP errors without throwing', async () => {
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchMock>(
        async () =>
          new Response(JSON.stringify({ message: 'feedback API rejected the request' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const harness = new ScreamHarness({ homeDir });
    const result = await harness.auth.submitFeedback({
      content: 'x',
      sessionId: 's',
      version: 'scream-code-0.0.0',
      os: 'Darwin 25.3.0',
      model: null,
    });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('feedback API rejected the request');
  });
});
