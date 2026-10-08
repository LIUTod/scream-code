import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readExistingImageConfig } from '#/tui/utils/image-config';

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env['SCREAM_CODE_HOME'];
  home = await mkdtemp(join(tmpdir(), 'scream-image-config-'));
  process.env['SCREAM_CODE_HOME'] = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = originalHome;
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(join(home, 'image-config.json'), JSON.stringify(value), 'utf8');
}

describe('readExistingImageConfig', () => {
  it('returns undefined when the config file is missing', async () => {
    await expect(readExistingImageConfig()).resolves.toBeUndefined();
  });

  it('returns a summary for a usable config (without the key)', async () => {
    await writeConfig({
      provider: 'openai',
      url: 'https://gateway.test/v1/images/generations',
      api_key: 'sk-real-key',
      model: 'gpt-image-2',
    });
    await expect(readExistingImageConfig()).resolves.toEqual({
      provider: 'openai',
      model: 'gpt-image-2',
      url: 'https://gateway.test/v1/images/generations',
    });
  });

  it('treats placeholder url/key values as unconfigured (mirrors the tool predicate)', async () => {
    await writeConfig({
      provider: 'openai',
      url: 'replace-with-your-endpoint',
      api_key: 'sk-real-key',
      model: 'gpt-image-2',
    });
    await expect(readExistingImageConfig()).resolves.toBeUndefined();

    await writeConfig({
      provider: 'openai',
      url: 'https://gateway.test/v1/images/generations',
      api_key: '<sk-...>',
      model: 'gpt-image-2',
    });
    await expect(readExistingImageConfig()).resolves.toBeUndefined();

    await writeConfig({
      provider: 'openai',
      url: '<https://gateway.test/v1/images/generations>',
      api_key: 'sk-real-key',
      model: 'gpt-image-2',
    });
    await expect(readExistingImageConfig()).resolves.toBeUndefined();
  });

  it('composes the legacy base_url into the classic endpoint', async () => {
    await writeConfig({
      base_url: 'https://gateway.test/v1/',
      api_key: 'sk-real-key',
      model: 'gpt-image-2',
    });
    await expect(readExistingImageConfig()).resolves.toMatchObject({
      url: 'https://gateway.test/v1/images/generations',
    });
  });

  it('rejects an angle-wrapped legacy base_url (the tool rejects it too)', async () => {
    await writeConfig({
      base_url: '<http://host:9/v1>',
      api_key: 'sk-real-key',
      model: 'gpt-image-2',
    });
    await expect(readExistingImageConfig()).resolves.toBeUndefined();
  });

  it('reports a blank model as unconfigured (deliberately stricter than the tool)', async () => {
    // `loadConfig` accepts `model: ""` and would fail at request time; the
    // status line must not advertise a setup that cannot produce an image.
    await writeConfig({
      url: 'https://gateway.test/v1/images/generations',
      api_key: 'sk-real-key',
      model: '   ',
    });
    await expect(readExistingImageConfig()).resolves.toBeUndefined();
  });

  it('returns undefined for malformed JSON or a config missing required fields', async () => {
    await writeFile(join(home, 'image-config.json'), '{not json', 'utf8');
    await expect(readExistingImageConfig()).resolves.toBeUndefined();

    await writeConfig({
      url: 'https://gateway.test/v1/images/generations',
      api_key: 'sk-real-key',
    });
    await expect(readExistingImageConfig()).resolves.toBeUndefined();
  });
});
