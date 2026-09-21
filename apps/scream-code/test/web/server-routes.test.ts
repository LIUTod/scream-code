import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Session } from '@scream-code/scream-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWebServer, type WebServerHandle } from '#/web/server';

const execFileAsync = promisify(execFile);
const handles: WebServerHandle[] = [];
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function makeRepo(root: string, name: string, value: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q');
  await writeFile(join(repo, 'tracked.txt'), `${value}\n`);
  await git(repo, 'add', 'tracked.txt');
  await execFileAsync('git', [
    '-C', repo,
    '-c', 'user.name=Web route test',
    '-c', 'user.email=web-route-test@example.invalid',
    'commit', '-qm', 'baseline',
  ]);
  return repo;
}

async function startServer(homeDir: string, workDir: string): Promise<WebServerHandle> {
  const previousHome = process.env['SCREAM_CODE_HOME'];
  process.env['SCREAM_CODE_HOME'] = homeDir;
  const handle = await runWebServer({
    port: 0,
    workDir,
    yolo: false,
    auto: false,
    open: false,
    skillsDirs: [],
  });
  // Keep restoration local to the test cleanup. The server resolves its home
  // during startup, so subsequent requests do not depend on this environment.
  if (previousHome === undefined) delete process.env['SCREAM_CODE_HOME'];
  else process.env['SCREAM_CODE_HOME'] = previousHome;
  handles.push(handle);
  return handle;
}

async function createSession(handle: WebServerHandle, workDir: string): Promise<string> {
  const response = await fetch(`${handle.url}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workDir }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { sessionId: string };
  expect(body.sessionId).toEqual(expect.any(String));
  return body.sessionId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('session-scoped git REST routes', () => {
  it('uses each selected session workspace for status and file diffs', async () => {
    const root = await makeTempDir('scream-web-routes-');
    const home = join(root, 'home');
    const serverWorkspace = join(root, 'server-workspace');
    await mkdir(serverWorkspace);
    const repoA = await makeRepo(root, 'repo-a', 'before-a');
    const repoB = await makeRepo(root, 'repo-b', 'before-b');
    await writeFile(join(repoA, 'tracked.txt'), 'after-a\n');
    await writeFile(join(repoA, 'untracked.txt'), 'new-a\n');
    await writeFile(join(repoB, 'tracked.txt'), 'after-b\n');

    const handle = await startServer(home, serverWorkspace);
    const sessionA = await createSession(handle, repoA);
    const sessionB = await createSession(handle, repoB);

    const statusA = await fetch(`${handle.url}/api/v1/git/status?sessionId=${encodeURIComponent(sessionA)}`);
    expect(statusA.status).toBe(200);
    const bodyA = (await statusA.json()) as {
      isRepo: boolean;
      files?: Array<{ path: string; status: string }>;
    };
    expect(bodyA.isRepo).toBe(true);
    expect(bodyA.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt' }),
      expect.objectContaining({ path: 'untracked.txt', status: '?' }),
    ]));

    const statusB = await fetch(`${handle.url}/api/v1/git/status?sessionId=${encodeURIComponent(sessionB)}`);
    expect(statusB.status).toBe(200);
    const bodyB = (await statusB.json()) as {
      isRepo: boolean;
      files?: Array<{ path: string; status: string }>;
    };
    expect(bodyB.isRepo).toBe(true);
    expect(bodyB.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt' }),
    ]));
    expect(bodyB.files?.some((file) => file.path === 'untracked.txt')).toBe(false);

    const diff = await fetch(
      `${handle.url}/api/v1/git/diff?sessionId=${encodeURIComponent(sessionA)}&path=${encodeURIComponent('tracked.txt')}`,
    );
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as { path: string; patch: string };
    expect(diffBody.path).toBe('tracked.txt');
    expect(diffBody.patch).toContain('+after-a');
    expect(diffBody.patch).not.toContain('after-b');
  });
});

describe('background task REST routes', () => {
  it('matches task routes before parsing query parameters and forwards filters', async () => {
    const root = await makeTempDir('scream-web-task-routes-');
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    const listed = [{ id: 'task-1', status: 'running', description: 'route test' }];
    const listTasks = vi.spyOn(Session.prototype, 'listBackgroundTasks')
      .mockResolvedValue(listed as never);
    const getOutput = vi.spyOn(Session.prototype, 'getBackgroundTaskOutput')
      .mockResolvedValue('tail output');

    const handle = await startServer(home, workspace);
    const sessionId = await createSession(handle, workspace);

    const tasks = await fetch(
      `${handle.url}/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks?activeOnly=true&limit=7`,
    );
    expect(tasks.status).toBe(200);
    await expect(tasks.json()).resolves.toEqual(listed);
    expect(listTasks).toHaveBeenCalledWith({ activeOnly: true, limit: 7 });

    const output = await fetch(
      `${handle.url}/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks/task-1/output?tail=12`,
    );
    expect(output.status).toBe(200);
    await expect(output.json()).resolves.toEqual({ output: 'tail output' });
    expect(getOutput).toHaveBeenCalledWith('task-1', { tail: 12 });
  });
});
