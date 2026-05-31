import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMainAgentWire } from '../../src/sessions/wire-writer.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wire-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeMainAgentWire', () => {
  it('writes a metadata header at line 0 with protocol_version=1.0', async () => {
    await writeMainAgentWire(dir, { createdAtMs: 1700000000000, messages: [] });
    const content = await readFile(join(dir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const firstLine = content.split('\n')[0]!;
    const parsed = JSON.parse(firstLine);
    expect(parsed).toEqual({
      type: 'metadata',
      protocol_version: '1.0',
      created_at: 1700000000000,
    });
  });

  it('emits one context.append_message per message', async () => {
    await writeMainAgentWire(dir, {
      createdAtMs: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      ],
    });
    const lines = (await readFile(join(dir, 'agents', 'main', 'wire.jsonl'), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    const second = JSON.parse(lines[1]!);
    expect(second.type).toBe('context.append_message');
    expect(second.message.role).toBe('user');
  });

  it('creates agents/main directory tree if missing', async () => {
    await writeMainAgentWire(dir, { createdAtMs: 1, messages: [] });
    const path = join(dir, 'agents', 'main', 'wire.jsonl');
    await expect(readFile(path, 'utf-8')).resolves.not.toThrow();
  });
});
