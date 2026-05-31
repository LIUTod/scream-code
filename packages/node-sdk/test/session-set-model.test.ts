import { join } from 'node:path';

import { FileTokenStorage, type TokenInfo } from '@scream-cli/scream-code-oauth';
import { afterEach, describe, expect, it } from 'vitest';

import { ScreamHarness, type ScreamError } from '#/index';
import { makeTempDir, removeTempDirs, waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

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

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setModel', () => {
  it('updates the runtime model and sends config.update with the resolved model', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-model-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({
        id: 'ses_model_wire',
        workDir,
        model: 'initial-model',
      });

      await session.setModel('next-model');

      await expect(session.getStatus()).resolves.toMatchObject({ model: 'next-model' });
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'next-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'next-model',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('resolves managed OAuth aliases before updating the runtime provider', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-model-work-');
    await new FileTokenStorage(join(homeDir, 'credentials')).save('scream-code', freshToken());
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await harness.setConfig({
        providers: {
          'managed:scream-code': {
            type: 'scream',
            baseUrl: 'https://api.scream.com/coding/v1',
            apiKey: '',
            oauth: { storage: 'file', key: 'oauth/scream-code' },
          },
        },
        models: {
          'scream-code/initial': {
            provider: 'managed:scream-code',
            model: 'scream-initial',
            maxContextSize: 262144,
          },
          'scream-code/scream-for-coding': {
            provider: 'managed:scream-code',
            model: 'scream-for-coding',
            maxContextSize: 262144,
          },
        },
        defaultModel: 'scream-code/initial',
      });
      const session = await harness.createSession({
        id: 'ses_model_oauth_wire',
        workDir,
        model: 'scream-code/initial',
      });

      await session.setModel('scream-code/scream-for-coding');

      await expect(session.getStatus()).resolves.toMatchObject({
        model: 'scream-code/scream-for-coding',
      });
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'scream-code/scream-for-coding',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'scream-code/scream-for-coding',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('rejects empty model names', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-model-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({ id: 'ses_model_empty', workDir });

      await expect(session.setModel('   ')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'session.model_empty',
      } satisfies Partial<ScreamError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'scream-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'scream-sdk-model-work-');
    const harness = new ScreamHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({ id: 'ses_model_closed', workDir });
      await session.close();

      await expect(session.setModel('next-model')).rejects.toMatchObject({
        name: 'ScreamError',
        code: 'session.closed',
      } satisfies Partial<ScreamError>);
    } finally {
      await harness.close();
    }
  });
});

async function configureLocalProvider(harness: ScreamHarness): Promise<void> {
  await harness.setConfig({
    providers: {
      local: {
        type: 'scream',
        apiKey: 'sk-test',
      },
    },
    models: {
      'initial-model': {
        provider: 'local',
        model: 'initial-model',
        maxContextSize: 262144,
      },
      'next-model': {
        provider: 'local',
        model: 'next-model',
        maxContextSize: 262144,
      },
    },
    defaultProvider: 'local',
  });
}
