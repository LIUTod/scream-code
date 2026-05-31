import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  ScreamCore,
  type ApprovalResponse,
  type CoreAPI,
  type SDKAPI,
} from '../../src';
import type { OAuthTokenProviderResolver } from '../../src/session/provider-manager';

describe('ScreamCore runtime config', () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp !== undefined) {
      await rm(tmp, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it('uses the shared OAuth resolver for ScreamCli service tokens', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'scream-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[services.scream_cli_search]
base_url = "https://search.example/v1"
oauth = { storage = "file", key = "oauth/custom-scream-code" }
custom_headers = { "X-Test" = "1" }
`,
    );

    const getAccessToken = vi.fn().mockResolvedValue('service-token');
    const resolveOAuthTokenProvider = vi.fn<OAuthTokenProviderResolver>(() => ({
      getAccessToken,
    }));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ search_results: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new ScreamCore(coreRpc, {
      homeDir,
      screamRequestHeaders: {
        'User-Agent': 'scream-code-cli/0.0.0-test',
        'X-Msh-Version': '0.0.0-test',
      },
      resolveOAuthTokenProvider,
    });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({ id: 'ses_runtime_service_oauth', workDir });
    const session = core.sessions.get(created.id);

    expect(resolveOAuthTokenProvider).toHaveBeenCalledWith('managed:scream-code', {
      storage: 'file',
      key: 'oauth/custom-scream-code',
    });
    expect(session?.options.toolServices?.webSearcher).toBeDefined();

    await session!.options.toolServices?.webSearcher!.search('scream');

    expect(getAccessToken).toHaveBeenCalledWith();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer service-token',
      'User-Agent': 'scream-code-cli/0.0.0-test',
      'X-Msh-Version': '0.0.0-test',
      'X-Test': '1',
    });
  });

  it('falls back to defaultModel when createSession receives no model option', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'scream-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `default_model = "default-mock"

[providers.test]
type = "scream"
api_key = "test-key"

[models."default-mock"]
provider = "test"
model = "default-mock"
max_context_size = 100000
`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new ScreamCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({ id: 'ses_runtime_default_model', workDir });
    const session = core.sessions.get(created.id);
    const mainAgent = session?.agents.get('main');

    expect(mainAgent?.config.modelAlias).toBe('default-mock');
  });
});
