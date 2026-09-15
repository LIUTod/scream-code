import { access, constants, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '@scream-code/scream-code-sdk';
import { vi } from 'vitest';

import { SessionManager, runWebServer, validateSessionWorkDir, type WebServerHandle } from '#/web/server';

/**
 * The workDir parameter chain for session creation:
 * 1. validateSessionWorkDir input validation (absolute path, no `..`, exists, is a
 *    directory, is readable and writable);
 * 2. REST: an invalid directory -> 4xx + message, no session created; GET /workdir
 *    reports the default workspace;
 * 3. SessionManager: workDir is passed through to harness.createSession; without one the
 *    server directory is kept;
 * 4. a fork follows the source session's workDir (no falling back to the server directory
 *    now that multiple workspaces coexist).
 */

const handles: WebServerHandle[] = [];
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-workdir-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
  await Promise.all(
    tempDirs
      .splice(0)
      .map(async (dir) => {
        await chmodSafe(dir);
        await rm(dir, { recursive: true, force: true });
      }),
  );
});

async function chmodSafe(dir: string): Promise<void> {
  try {
    const { chmod } = await import('node:fs/promises');
    await chmod(dir, 0o700);
  } catch {
    /* the directory may be writable already */
  }
}

// ── validateSessionWorkDir ────────────────────────────────────────────────

describe('validateSessionWorkDir', () => {
  it('no value / null / empty string = undefined (keep the server process directory)', async () => {
    await expect(validateSessionWorkDir(undefined)).resolves.toBeUndefined();
    await expect(validateSessionWorkDir(null)).resolves.toBeUndefined();
    await expect(validateSessionWorkDir('   ')).resolves.toBeUndefined();
  });

  it('a non-string and a relative path -> 400', async () => {
    await expect(validateSessionWorkDir(123)).rejects.toMatchObject({ statusCode: 400 });
    await expect(validateSessionWorkDir('src/web')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('绝对路径'),
    });
  });

  it('a `..` traversal segment -> 400 (even when it still resolves to something on disk)', async () => {
    const base = await makeTempDir();
    const traversal = `${base}/../${base.split('/').pop()}/..`;
    await expect(validateSessionWorkDir(traversal)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('..'),
    });
  });

  it('missing -> 404; a file instead of a directory -> 400', async () => {
    await expect(validateSessionWorkDir('/definitely/not/a/real-dir-9f3a1e')).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining('目录不存在'),
    });
    const base = await makeTempDir();
    const filePath = join(base, 'a-file.txt');
    await writeFile(filePath, 'x');
    await expect(validateSessionWorkDir(filePath)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('不是目录'),
    });
  });

  it('a valid readable and writable directory -> returned as is (no resolve rewrite)', async () => {
    const base = await makeTempDir();
    await expect(validateSessionWorkDir(base)).resolves.toBe(base);
  });

  it('a directory without write permission -> 403 (when W_OK always holds as root, pin the positive "writable passes" result instead)', async () => {
    const base = await makeTempDir();
    const ro = join(base, 'read-only');
    await mkdir(ro);
    const { chmod } = await import('node:fs/promises');
    await chmod(ro, 0o500);
    const writable = await access(ro, constants.W_OK).then(
      () => true,
      () => false,
    );
    if (writable) {
      // Under root / CIFS the chmod cannot block writes, so the 403 branch cannot be
      // constructed at all. Assert the **observable** substitute contract here (validation
      // passes the path through) instead of returning silently - a green test with zero
      // assertions disguises "not tested" as "passed".
      await expect(validateSessionWorkDir(ro)).resolves.toBe(ro);
      return;
    }
    await expect(validateSessionWorkDir(ro)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('不可读写'),
    });
  });
});

// ── SessionManager passthrough ────────────────────────────────────────────

function fakeCoreSession(id: string): Session {
  return {
    id,
    workDir: '/ignored',
    onEvent: () => () => {},
    setApprovalHandler: () => {},
    setQuestionHandler: () => {},
    getStatus: async () => ({ model: 'test-model', permission: 'manual', busy: false }),
    getGoal: async () => ({ goal: null }),
    getTodos: async () => [],
    prompt: async () => {},
    close: async () => {},
  } as unknown as Session;
}

describe('SessionManager.createSession workDir passthrough', () => {
  it('an explicit workDir reaches the harness and the session list; omitting it falls back to the server directory; a fork follows the source session', async () => {
    const homeDir = await makeTempDir();
    const harness = {
      createSession: vi.fn(async ({ workDir }: { workDir: string }) => fakeCoreSession(`core-${workDir.length}`)),
      resumeSession: vi.fn(async () => fakeCoreSession('core-x')),
      forkSession: vi.fn(async () => fakeCoreSession('core-fork')),
    };
    const manager = new SessionManager({
      harness: harness as never,
      homeDir,
      workDir: '/server/base',
      model: 'test-model',
      permission: 'manual',
      yolo: false,
    });
    await manager.init();

    const chosen = await manager.createSession('/chosen/dir');
    expect(harness.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ workDir: '/chosen/dir' }),
    );
    expect(chosen.getListItem().workDir).toBe('/chosen/dir');
    expect(manager.list().some((s) => s.sessionId === chosen.sessionId && s.workDir === '/chosen/dir')).toBe(true);

    // The fork inherits the source session's workspace instead of falling back to /server/base.
    const forked = await manager.forkSession(chosen.sessionId);
    expect(forked).not.toBeNull();
    const forkItem = manager.list().find((s) => s.sessionId === forked!.sessionId);
    expect(forkItem?.workDir).toBe('/chosen/dir');

    // Not specified = the previous behaviour: the server process directory.
    const fallback = await manager.createSession();
    expect(harness.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ workDir: '/server/base' }),
    );
    expect(fallback.getListItem().workDir).toBe('/server/base');

    expect(manager.defaultWorkDir).toBe('/server/base');
    await manager.closeAll();
  });
});

// ── REST endpoints ────────────────────────────────────────────────────────

describe('POST /api/v1/sessions workDir validation', () => {
  async function startServer(): Promise<WebServerHandle> {
    const home = await makeTempDir();
    process.env['SCREAM_CODE_HOME'] = home;
    const handle = await runWebServer({
      port: 0,
      workDir: process.cwd(),
      yolo: false,
      auto: false,
      open: false,
      skillsDirs: [],
    });
    handles.push(handle);
    return handle;
  }

  it('GET /workdir reports the server default workspace', async () => {
    const handle = await startServer();
    const res = await fetch(`${handle.url}/api/v1/workdir`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workDir: process.cwd() });
  });

  it('an invalid directory -> 4xx + message, leaving no ghost session behind', async () => {
    const handle = await startServer();
    const res = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: '/no/such/dir-e8d210' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.message).toContain('目录不存在');

    const rel = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: 'relative/path' }),
    });
    expect(rel.status).toBe(400);

    // A failed validation creates no session: the list stays empty.
    const list = await fetch(`${handle.url}/api/v1/sessions`);
    await expect(list.json()).resolves.toEqual([]);
  });

  it('malformed JSON -> 400 (no longer swallowed as 500)', async () => {
    const handle = await startServer();
    const res = await fetch(`${handle.url}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ message: expect.stringContaining('JSON') });
  });
});
