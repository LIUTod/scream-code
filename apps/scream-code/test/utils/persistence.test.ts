import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { appendJsonlLine, readJsonFile, readJsonlFile, writeJsonFile } from '#/utils/persistence';

interface TestJson {
  name: string;
  count: number;
}

const TestJsonSchema: z.ZodType<TestJson> = z.object({
  name: z.string(),
  count: z.number().int(),
});

interface TestLine {
  content: string;
}

const TestLineSchema: z.ZodType<TestLine> = z.object({
  content: z.string(),
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scream-persistence-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('persistence helpers', () => {
  it('readJsonFile returns fallback when file is missing', async () => {
    const fallback = { name: 'fallback', count: 1 };
    await expect(
      readJsonFile(join(dir, 'missing.json'), TestJsonSchema, fallback),
    ).resolves.toEqual(fallback);
  });

  it('writeJsonFile writes schema-valid JSON atomically', async () => {
    const file = join(dir, 'nested', 'state.json');
    await writeJsonFile(file, TestJsonSchema, { name: 'ok', count: 2 });

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ name: 'ok', count: 2 });
    await expect(
      readJsonFile(file, TestJsonSchema, { name: 'fallback', count: 0 }),
    ).resolves.toEqual({ name: 'ok', count: 2 });
  });

  it('readJsonFile rejects schema-invalid JSON', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ name: 'bad', count: 'nope' }), 'utf-8');

    await expect(
      readJsonFile(file, TestJsonSchema, { name: 'fallback', count: 0 }),
    ).rejects.toThrow();
  });

  it('writeJsonFile refuses to write config.toml', async () => {
    await expect(
      writeJsonFile(join(dir, 'config.toml'), TestJsonSchema, { name: 'bad', count: 1 }),
    ).rejects.toThrow(/config\.toml/);
  });

  it('readJsonlFile preserves valid line order', async () => {
    const file = join(dir, 'history.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ content: 'first' }),
        JSON.stringify({ content: 'second' }),
        JSON.stringify({ content: 'third' }),
      ].join('\n'),
      'utf-8',
    );

    await expect(readJsonlFile(file, TestLineSchema)).resolves.toEqual([
      { content: 'first' },
      { content: 'second' },
      { content: 'third' },
    ]);
  });

  it('readJsonlFile skips malformed and schema-invalid lines', async () => {
    const file = join(dir, 'history.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ content: 'good' }),
        'not json',
        JSON.stringify({ wrong: 'shape' }),
        '',
        JSON.stringify({ content: 'tail' }),
      ].join('\n'),
      'utf-8',
    );

    await expect(readJsonlFile(file, TestLineSchema)).resolves.toEqual([
      { content: 'good' },
      { content: 'tail' },
    ]);
  });

  it('appendJsonlLine creates the parent directory', async () => {
    const file = join(dir, 'nested', 'history.jsonl');
    await appendJsonlLine(file, TestLineSchema, { content: 'hello' });

    expect(readFileSync(file, 'utf-8').trim()).toBe(JSON.stringify({ content: 'hello' }));
  });
});
