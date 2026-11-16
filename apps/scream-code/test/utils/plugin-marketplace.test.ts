import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLocale, setLocale } from '@scream-code/config';
import { describe, expect, it, vi } from 'vitest';

import { SCREAM_CODE_PLUGIN_MARKETPLACE_URL } from '#/constant/app';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';

const REPO_ROOT = join(import.meta.dirname, '../../../..');

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

  describe('error messages follow the UI language', () => {
    async function load(manifest: unknown, locale: 'en' | 'zh'): Promise<Error> {
      const dir = await mkdtemp(join(tmpdir(), 'scream-plugin-marketplace-'));
      const file = join(dir, 'marketplace.json');
      await writeFile(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
      const previous = getLocale();
      setLocale(locale);
      try {
        await loadPluginMarketplace({ workDir: '/tmp/work', source: file });
      } catch (error) {
        return error as Error;
      } finally {
        setLocale(previous);
      }
      throw new Error('expected the marketplace to be rejected');
    }

    it.each([
      ['not json', 'The plugin marketplace is not valid JSON:', '插件市场不是有效的 JSON:'],
      ['[]', 'The plugin marketplace must be an object.', '插件市场必须是一个对象.'],
      [{ nope: true }, 'The plugin marketplace must contain a "plugins" array.', '插件市场必须包含 "plugins" 数组.'],
      [{ plugins: [1] }, 'Plugin marketplace entry 1 must be an object.', '插件市场条目 1 必须是一个对象.'],
      [{ plugins: [{ displayName: 'x' }] }, 'Plugin marketplace entry 1 must define "id".', '插件市场条目 1 必须定义 "id".'],
      [{ plugins: [{ id: 'demo' }] }, 'Plugin marketplace entry demo must define "source".', '插件市场条目 demo 必须定义 "source".'],
      [{ plugins: [{ id: 'demo', source: './d', tier: 3 }] }, 'Plugin marketplace entry demo "tier" must be a string.', '插件市场条目 demo "tier" 必须是字符串.'],
      [
        { plugins: [{ id: 'demo', source: './d', tier: 'community' }] },
        'Plugin marketplace entry demo "tier" must be one of: official, curated.',
        '插件市场条目 demo "tier" 必须是以下之一: official, curated.',
      ],
    ])('rejects %j in both languages', async (manifest, english, chinese) => {
      expect((await load(manifest, 'en')).message).toContain(english);
      expect((await load(manifest, 'zh')).message).toContain(chinese);
    });
  });
});
