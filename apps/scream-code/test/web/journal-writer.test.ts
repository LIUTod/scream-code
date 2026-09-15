import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendJournalLineSerialized, resetJournalWriteChains } from '../../src/web/journal-writer.js';

/**
 * Incident regression: journal appends used writeFile(flag:'a') directly, so
 * 400k-character finalized bodies and concurrent entries interleaved at the byte
 * level and landed as malformed lines where two records were split into each other
 * → JSON.parse failed → the whole message disappeared from the UI. These cases pin
 * the serialized-concurrent-write contract: any interleaving makes JSON.parse blow
 * up on the spot.
 */
describe('journal append serialization (no interleaved writes)', () => {
  async function makePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'journal-writer-'));
    return join(dir, 'session_under_test.jsonl');
  }

  it('concurrent large payloads: every line is complete parseable JSON with no cross-line contamination', async () => {
    const path = await makePath();
    resetJournalWriteChains();
    const payloads = Array.from({ length: 32 }, (_, i) =>
      JSON.stringify({
        type: 'web.message.finalized',
        seq: i,
        message: { id: `m${i}`, role: 'assistant', content: `#${i}:` + 'x'.repeat(200_000) + `:END#${i}` },
      }),
    );
    const errors: unknown[] = [];
    await Promise.all(
      payloads.map((line) => appendJournalLineSerialized(path, line, (error) => errors.push(error))),
    );
    expect(errors).toEqual([]);

    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(payloads.length);

    const seenSeq = new Set<number>();
    const order: number[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as { seq: number; message: { content: string } };
      // Interleaving would splice another record's fragment into the body → these
      // two assertions are the most direct bite point.
      expect(parsed.message.content.startsWith(`#${parsed.seq}:`)).toBe(true);
      expect(parsed.message.content.endsWith(`:END#${parsed.seq}`)).toBe(true);
      seenSeq.add(parsed.seq);
      order.push(parsed.seq);
    }
    expect(seenSeq.size).toBe(payloads.length);
    // The ordering contract of the serialization gate: file order = submission
    // order, which must hold under concurrency as well.
    expect(order).toEqual(Array.from({ length: payloads.length }, (_, i) => i));
    await rm(join(path, '..'), { recursive: true, force: true });
  });

  it('one failed write does not block the queue: later appends still all land on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journal-writer-'));
    // Use a directory as the write target to provoke an EISDIR failure.
    const broken = join(dir, 'not-a-file');
    await (await import('node:fs/promises')).mkdir(broken);
    const good = join(dir, 'good.jsonl');
    resetJournalWriteChains();

    const errors: unknown[] = [];
    await appendJournalLineSerialized(broken, '{"a":1}', (error) => errors.push(error));
    await Promise.all([
      appendJournalLineSerialized(good, '{"b":1}', (error) => errors.push(error)),
      appendJournalLineSerialized(good, '{"c":1}', (error) => errors.push(error)),
    ]);
    expect(errors).toHaveLength(1);
    const lines = (await readFile(good, 'utf-8')).split('\n').filter((l) => l.length > 0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ b: 1 }, { c: 1 }]);
    await rm(dir, { recursive: true, force: true });
  });

  it('appends line by line to existing content without overwriting history', async () => {
    const path = await makePath();
    resetJournalWriteChains();
    await writeFile(path, '{"seq":0}\n', 'utf-8');
    await appendJournalLineSerialized(path, '{"seq":1}', () => undefined);
    await appendJournalLineSerialized(path, '{"seq":2}', () => undefined);
    const lines = (await readFile(path, 'utf-8')).split('\n').filter((l) => l.length > 0);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
    await rm(join(path, '..'), { recursive: true, force: true });
  });
});
