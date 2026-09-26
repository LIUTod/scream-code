import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorCodes } from '../../src/errors';
import { readSessionIndex } from '../../src/session/store/session-index';
import { SessionStore } from '../../src/session/store/session-store';

describe('SessionStore.delete', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'session-store-del-'));
    homes.push(home);
    return home;
  }

  it('removes the directory and the index entry', async () => {
    const home = makeHome();
    const store = new SessionStore(home);
    await store.create({ id: 'session_del_ok', workDir: '/tmp/work-del' });
    const dir = store.sessionDirFor({ id: 'session_del_ok', workDir: '/tmp/work-del' });
    expect(existsSync(dir)).toBe(true);

    await store.delete('session_del_ok');

    expect(existsSync(dir)).toBe(false);
    const index = await readSessionIndex(home, join(home, 'sessions'));
    expect(index.has('session_del_ok')).toBe(false);
  });

  it('throws SESSION_DELETE_FAILED and keeps the index entry when the directory cannot be removed', async () => {
    const home = makeHome();
    const store = new SessionStore(home);
    await store.create({ id: 'session_del_stuck', workDir: '/tmp/work-stuck' });
    const dir = store.sessionDirFor({ id: 'session_del_stuck', workDir: '/tmp/work-stuck' });
    // The session dir must be non-empty: rmdir of an empty directory is
    // permission-checked against its parent, so only a child unlink really
    // exercises the "files held by another program" failure shape.
    writeFileSync(join(dir, 'wire.jsonl'), '{}\n');

    // A read-only session dir makes every unlink inside it fail with
    // EPERM/EACCES — the shape of a real "files held by another program"
    // failure, exercised through the real fs instead of a mock.
    chmodSync(dir, 0o555);
    try {
      await expect(store.delete('session_del_stuck')).rejects.toMatchObject({
        code: ErrorCodes.SESSION_DELETE_FAILED,
      });
    } finally {
      if (existsSync(dir)) chmodSync(dir, 0o755);
    }

    // The deletion did not lie: directory, file and index entry all remain.
    expect(existsSync(join(dir, 'wire.jsonl'))).toBe(true);
    const index = await readSessionIndex(home, join(home, 'sessions'));
    expect(index.has('session_del_stuck')).toBe(true);
  });
});
