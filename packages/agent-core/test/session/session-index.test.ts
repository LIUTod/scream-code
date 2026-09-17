/**
 * session_index.jsonl read cache.
 *
 * `readSessionIndex` runs on every session lookup and every `listAll`; the
 * cache must serve repeat reads without re-parsing while picking up both our
 * own writes and writes made by other processes (validated via mtime+size).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { utimes } from 'node:fs/promises';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendSessionIndexEntry,
  readSessionIndex,
  removeSessionIndexEntry,
  sessionIndexPath,
} from '../../src/session/store/session-index';

describe('session index cache', () => {
  let homeDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'session-index-'));
    sessionsDir = join(homeDir, 'sessions');
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns entries and serves repeat reads from cache', async () => {
    await appendSessionIndexEntry(homeDir, {
      sessionId: 'session_alpha',
      sessionDir: join(sessionsDir, 'session_alpha'),
      workDir: '/tmp/work-a',
    });

    const first = await readSessionIndex(homeDir, sessionsDir);
    expect(first.get('session_alpha')?.workDir).toBe('/tmp/work-a');

    // Cache hit path: same content, same map identity.
    const second = await readSessionIndex(homeDir, sessionsDir);
    expect(second).toBe(first);
  });

  it('picks up entries appended after a cached read', async () => {
    await appendSessionIndexEntry(homeDir, {
      sessionId: 'session_alpha',
      sessionDir: join(sessionsDir, 'session_alpha'),
      workDir: '/tmp/work-a',
    });
    await readSessionIndex(homeDir, sessionsDir);

    await appendSessionIndexEntry(homeDir, {
      sessionId: 'session_beta',
      sessionDir: join(sessionsDir, 'session_beta'),
      workDir: '/tmp/work-b',
    });

    const map = await readSessionIndex(homeDir, sessionsDir);
    expect(map.has('session_alpha')).toBe(true);
    expect(map.get('session_beta')?.workDir).toBe('/tmp/work-b');
  });

  it('picks up external writes that change mtime or size', async () => {
    await appendSessionIndexEntry(homeDir, {
      sessionId: 'session_alpha',
      sessionDir: join(sessionsDir, 'session_alpha'),
      workDir: '/tmp/work-a',
    });
    await readSessionIndex(homeDir, sessionsDir);

    // Another process rewrites the file: different size.
    const external = `${JSON.stringify({
      sessionId: 'session_gamma',
      sessionDir: join(sessionsDir, 'session_gamma'),
      workDir: '/tmp/work-g',
    })}\n`;
    writeFileSync(sessionIndexPath(homeDir), external, 'utf-8');
    const map = await readSessionIndex(homeDir, sessionsDir);
    expect(map.has('session_alpha')).toBe(false);
    expect(map.get('session_gamma')?.workDir).toBe('/tmp/work-g');

    // Same size, different content: only the mtime change can reveal it, so
    // bump mtime deterministically after the same-length rewrite.
    writeFileSync(sessionIndexPath(homeDir), external.replace('work-g', 'work-h'), 'utf-8');
    await utimes(sessionIndexPath(homeDir), new Date(), new Date(Date.now() + 5000));
    const map2 = await readSessionIndex(homeDir, sessionsDir);
    expect(map2.get('session_gamma')?.workDir).toBe('/tmp/work-h');
  });

  it('reflects removals and keeps the cache consistent afterwards', async () => {
    await appendSessionIndexEntry(homeDir, {
      sessionId: 'session_alpha',
      sessionDir: join(sessionsDir, 'session_alpha'),
      workDir: '/tmp/work-a',
    });
    await appendSessionIndexEntry(homeDir, {
      sessionId: 'session_beta',
      sessionDir: join(sessionsDir, 'session_beta'),
      workDir: '/tmp/work-b',
    });
    await readSessionIndex(homeDir, sessionsDir);

    await removeSessionIndexEntry(homeDir, 'session_alpha');

    const map = await readSessionIndex(homeDir, sessionsDir);
    expect(map.has('session_alpha')).toBe(false);
    expect(map.has('session_beta')).toBe(true);
  });

  it('returns an empty map when the index does not exist', async () => {
    const map = await readSessionIndex(homeDir, sessionsDir);
    expect(map.size).toBe(0);
  });
});
