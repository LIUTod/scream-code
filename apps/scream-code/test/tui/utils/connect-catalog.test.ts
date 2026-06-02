import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CATALOG_URL, loadBuiltInCatalog } from '@scream-cli/scream-code-sdk';
import { describe, expect, it } from 'vitest';

import { BUILT_IN_CATALOG_JSON } from '#/built-in-catalog';
import { resolveConnectCatalogRequest } from '#/tui/utils/connect-catalog';

import { builtInCatalogDefine } from '../../../scripts/built-in-catalog.mjs';

describe('resolveConnectCatalogRequest', () => {
  it('returns default URL with diy=false for empty or unknown args', () => {
    expect(resolveConnectCatalogRequest('')).toEqual({ url: DEFAULT_CATALOG_URL, diy: false });
    expect(resolveConnectCatalogRequest('refresh')).toEqual({ url: DEFAULT_CATALOG_URL, diy: false });
    expect(resolveConnectCatalogRequest('  refresh  ')).toEqual({ url: DEFAULT_CATALOG_URL, diy: false });
    expect(resolveConnectCatalogRequest('--refresh')).toEqual({ url: DEFAULT_CATALOG_URL, diy: false });
    expect(resolveConnectCatalogRequest('ignored text')).toEqual({ url: DEFAULT_CATALOG_URL, diy: false });
  });

  it('returns diy=true for /config diy (case-insensitive)', () => {
    expect(resolveConnectCatalogRequest('diy')).toEqual({ url: DEFAULT_CATALOG_URL, diy: true });
    expect(resolveConnectCatalogRequest('DIY')).toEqual({ url: DEFAULT_CATALOG_URL, diy: true });
    expect(resolveConnectCatalogRequest('  diy  ')).toEqual({ url: DEFAULT_CATALOG_URL, diy: true });
  });
});

describe('built-in connect catalog injection', () => {
  it('keeps the source placeholder empty so generated catalog data is not committed', () => {
    expect(BUILT_IN_CATALOG_JSON).toBeUndefined();
    expect(loadBuiltInCatalog(BUILT_IN_CATALOG_JSON)).toBeUndefined();
  });

  it('embeds a generated catalog file through the tsdown define value', async () => {
    const catalog = {
      openai: {
        id: 'openai',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-test': {
            id: 'gpt-test',
            limit: { context: 1000, output: 100 },
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'scream-built-in-catalog-'));
    try {
      const file = join(dir, 'catalog.json');
      const text = JSON.stringify(catalog);
      await writeFile(file, text, 'utf-8');

      const defineValue = builtInCatalogDefine({ SCREAM_CODE_BUILT_IN_CATALOG_FILE: file });
      expect(JSON.parse(defineValue)).toBe(text);
      expect(loadBuiltInCatalog(JSON.parse(defineValue))).toEqual(catalog);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
