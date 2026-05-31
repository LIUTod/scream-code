import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { SCREAM_CODE_PLUGIN_MARKETPLACE_URL } from '#/constant/app';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('loadPluginMarketplace', () => {
  it('loads a local marketplace file and resolves relative plugin sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scream-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        version: '1',
        plugins: [
          {
            id: 'scream-datasource',
            tier: 'official',
            displayName: 'Scream Datasource',
            version: '1.0.0',
            description: 'Datasource tools',
            source: './scream-datasource',
            keywords: ['data'],
          },
          {
            id: 'superpowers',
            tier: 'curated',
            displayName: 'Superpowers',
            version: '5.1.0',
            description: 'Workflow skills',
            homepage: 'https://github.com/obra/superpowers',
            source: './curated/superpowers',
            keywords: ['skills', 'workflow'],
          },
        ],
      }),
      'utf8',
    );

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source: file });

    expect(marketplace).toEqual({
      source: file,
      version: '1',
      plugins: [
        {
          id: 'scream-datasource',
          displayName: 'Scream Datasource',
          tier: 'official',
          version: '1.0.0',
          description: 'Datasource tools',
          source: join(dir, 'scream-datasource'),
          keywords: ['data'],
          homepage: undefined,
        },
        {
          id: 'superpowers',
          displayName: 'Superpowers',
          tier: 'curated',
          version: '5.1.0',
          description: 'Workflow skills',
          source: join(dir, 'curated', 'superpowers'),
          keywords: ['skills', 'workflow'],
          homepage: 'https://github.com/obra/superpowers',
        },
      ],
    });
  });

  it('loads the default CDN marketplace with injectable fetch', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plugins: [
            {
              id: 'scream-datasource',
              displayName: 'Scream Datasource',
              source: './official/scream-datasource.zip',
            },
          ],
        }),
    })) as unknown as typeof fetch;

    const marketplace = await loadPluginMarketplace({
      workDir: '/tmp/work',
      source: SCREAM_CODE_PLUGIN_MARKETPLACE_URL,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(SCREAM_CODE_PLUGIN_MARKETPLACE_URL);
    expect(marketplace.plugins[0]).toEqual(
      expect.objectContaining({
        id: 'scream-datasource',
        displayName: 'Scream Datasource',
        source: new URL(
          './official/scream-datasource.zip',
          SCREAM_CODE_PLUGIN_MARKETPLACE_URL,
        ).toString(),
      }),
    );
  });

  it('loads an explicit remote marketplace with injectable fetch', async () => {
    const source = 'https://example.com/plugins/marketplace.json';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plugins: [{ id: 'superpowers', name: 'Superpowers', url: 'superpowers.zip' }],
        }),
    })) as unknown as typeof fetch;

    const marketplace = await loadPluginMarketplace({ workDir: '/tmp/work', source, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(source);
    expect(marketplace.plugins[0]).toEqual(
      expect.objectContaining({
        id: 'superpowers',
        displayName: 'Superpowers',
        source: new URL('superpowers.zip', source).toString(),
      }),
    );
  });

  it('rejects malformed marketplace entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scream-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(file, JSON.stringify({ plugins: [{ displayName: 'Missing id' }] }), 'utf8');

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /必须定义 "id"/,
    );
  });

  it('rejects unknown marketplace tier values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scream-plugin-marketplace-'));
    const file = join(dir, 'marketplace.json');
    await writeFile(
      file,
      JSON.stringify({
        plugins: [{ id: 'demo', tier: 'community', source: './demo' }],
      }),
      'utf8',
    );

    await expect(loadPluginMarketplace({ workDir: '/tmp/work', source: file })).rejects.toThrow(
      /"tier" 必须是以下之一/,
    );
  });
});
