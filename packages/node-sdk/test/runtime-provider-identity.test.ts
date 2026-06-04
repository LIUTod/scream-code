import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScreamConfig } from '@scream-cli/agent-core';
import { createScreamDefaultHeaders, SCREAM_CODE_PLATFORM } from '@scream-cli/config';

import { ProviderManager } from '../../agent-core/src/session/provider-manager';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

function resolveRuntimeProvider(options: {
  readonly config: ScreamConfig;
  readonly model?: string;
  readonly screamRequestHeaders?: Record<string, string>;
}) {
  const manager = new ProviderManager({
    config: options.config,
    screamRequestHeaders: options.screamRequestHeaders,
  });
  const model = options.model ?? options.config.defaultModel;
  if (model === undefined) {
    throw new Error('No model selected');
  }
  return manager.resolveProviderConfig(model);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-sdk-provider-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime provider identity headers', () => {
  it('adds scream-code-cli User-Agent and complete X-Msh headers to the default Scream provider', async () => {
    const homeDir = await makeTempDir();
    const screamRequestHeaders = createScreamDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const resolved = resolveRuntimeProvider({
      config: {
        defaultModel: 'scream-model',
        providers: {
          scream: {
            type: 'scream',
            apiKey: 'test-key',
          },
        },
        models: {
          'scream-model': {
            provider: 'scream',
            model: 'scream-model',
            maxContextSize: 1000,
          },
        },
      },
      screamRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'scream',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'scream-code-cli/0.0.0-test',
        'X-Msh-Platform': SCREAM_CODE_PLATFORM,
        'X-Msh-Version': '0.0.0-test',
        'X-Msh-Device-Name': expect.any(String),
        'X-Msh-Device-Model': expect.any(String),
        'X-Msh-Os-Version': expect.any(String),
        'X-Msh-Device-Id': expect.stringMatching(/^[0-9a-f-]+$/),
      }),
    });
  });

  it('lets Scream provider customHeaders override default identity headers', async () => {
    const homeDir = await makeTempDir();
    const screamRequestHeaders = createScreamDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: ScreamConfig = {
      providers: {
        scream: {
          type: 'scream',
          apiKey: 'test-key',
          customHeaders: {
            'User-Agent': 'Custom/1',
            'X-Msh-Version': 'override-version',
          },
        },
      },
      defaultProvider: 'scream',
      defaultModel: 'scream-model',
      models: {
        'scream-model': {
          provider: 'scream',
          model: 'scream-model',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      screamRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'scream',
      defaultHeaders: expect.objectContaining({
        'User-Agent': 'Custom/1',
        'X-Msh-Version': 'override-version',
        'X-Msh-Platform': SCREAM_CODE_PLATFORM,
      }),
    });
  });

  it('does not add Scream identity headers to non-Scream providers', async () => {
    const homeDir = await makeTempDir();
    const screamRequestHeaders = createScreamDefaultHeaders({ homeDir, ...TEST_IDENTITY });
    const config: ScreamConfig = {
      providers: {
        openai: {
          type: 'openai',
          baseUrl: 'https://example.test/v1',
          apiKey: 'sk-test',
        },
      },
      defaultProvider: 'openai',
      defaultModel: 'gpt-test',
      models: {
        'gpt-test': {
          provider: 'openai',
          model: 'gpt-test',
          maxContextSize: 1000,
        },
      },
    };

    const resolved = resolveRuntimeProvider({
      config,
      screamRequestHeaders,
    });

    expect(resolved.provider).toMatchObject({
      type: 'openai',
      model: 'gpt-test',
    });
    expect(resolved.provider).not.toHaveProperty('defaultHeaders');
  });
});
