import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySessionDir } from '../../src/sessions/classify.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'classify-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeSession(name: string, files: Record<string, string>): Promise<string> {
  const path = join(dir, name);
  await mkdir(path, { recursive: true });
  for (const [k, v] of Object.entries(files)) {
    await writeFile(join(path, k), v, 'utf-8');
  }
  return path;
}

describe('classifySessionDir', () => {
  it('placeholder: dir contains only a `test` file', async () => {
    const p = await makeSession('uuid1', { test: 'test' });
    expect(await classifySessionDir(p)).toBe('placeholder');
  });

  it('empty: dir has zero files', async () => {
    const p = join(dir, 'uuid2');
    await mkdir(p, { recursive: true });
    expect(await classifySessionDir(p)).toBe('empty');
  });

  it('malformed: dir missing both context.jsonl and state.json', async () => {
    const p = await makeSession('uuid3', { 'wire.jsonl': '{}\n' });
    expect(await classifySessionDir(p)).toBe('malformed');
  });

  it('real: context.jsonl carries a user/assistant/tool message', async () => {
    const p = await makeSession('uuid4', {
      'state.json': '{}',
      'context.jsonl': '{"role":"_system_prompt","content":"hi"}\n{"role":"user","content":"hello"}\n',
      'wire.jsonl': '',
    });
    expect(await classifySessionDir(p)).toBe('real');
  });

  it('malformed: state.json only (no context.jsonl) is not migratable', async () => {
    // `migrateOneSession` hard-fails without context.jsonl, so a state-only
    // dir must not be classified as `real` — otherwise migration would enter
    // its hard-fail path and surface the dir as a failure instead of a
    // skipped-malformed entry.
    const p = await makeSession('uuid5', { 'state.json': '{}' });
    expect(await classifySessionDir(p)).toBe('malformed');
  });

  it('real: context.jsonl alone is enough when it has a real message', async () => {
    const p = await makeSession('uuid6', {
      'context.jsonl': '{"role":"assistant","content":[{"type":"text","text":"hi"}]}\n',
    });
    expect(await classifySessionDir(p)).toBe('real');
  });

  it('empty: context.jsonl is a zero-byte file', async () => {
    // The file exists but carries no conversation — an unused session.
    const p = await makeSession('uuid7', { 'context.jsonl': '' });
    expect(await classifySessionDir(p)).toBe('empty');
  });

  it('empty: context.jsonl holds only a _system_prompt marker', async () => {
    // A session the user cleared/reverted in scream-cli: the live context is
    // emptied, so it carries no migratable conversation.
    const p = await makeSession('uuid8', {
      'context.jsonl': '{"role":"_system_prompt","content":"You are ..."}\n',
    });
    expect(await classifySessionDir(p)).toBe('empty');
  });

  it('empty: context.jsonl holds only _checkpoint / _usage markers', async () => {
    const p = await makeSession('uuid9', {
      'context.jsonl': '{"role":"_checkpoint","id":0}\n{"role":"_usage","token_count":12}\n',
    });
    expect(await classifySessionDir(p)).toBe('empty');
  });

  it('real: context.jsonl is corrupt — migrateOneSession surfaces it as a failure', async () => {
    // A corrupt context.jsonl must reach `migrateOneSession` so that the
    // failure ends up in `sessionsFailed` and `migration-errors.log` — not
    // silently absorbed by `sessionsSkippedMalformed` (which the result
    // screen does not even render). Classify therefore routes corrupt
    // contexts as `'real'` and lets the migration step report a real
    // failure with diagnostic detail.
    const p = await makeSession('uuid10', {
      'context.jsonl': 'not-json\n{broken\n}}}\n',
    });
    expect(await classifySessionDir(p)).toBe('real');
  });
});
