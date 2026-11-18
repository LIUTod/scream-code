import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireProcessLock,
  processLockAddress,
  queryProcessLock,
  requestProcessLock,
  type HeldProcessLock,
} from '../../src/utils/process-lock';

const held: HeldProcessLock[] = [];

afterEach(async () => {
  while (held.length > 0) await held.pop()!.release();
});

function scope(): string {
  return `/test/home/${randomUUID()}`;
}

async function take(options: Parameters<typeof acquireProcessLock>[0]): Promise<HeldProcessLock> {
  const lock = await acquireProcessLock(options);
  if (!lock.held) throw new Error('expected to take the lock');
  held.push(lock);
  return lock;
}

describe('processLockAddress', () => {
  it('uses a named pipe on Windows and an abstract socket on Linux', () => {
    expect(processLockAddress('/h', 'host', 'win32')).toMatch(/^\\\\\.\\pipe\\scream-[0-9a-f]{24}$/);
    expect(processLockAddress('/h', 'host', 'linux')).toMatch(/^\0scream-[0-9a-f]{24}$/);
    expect(processLockAddress('/h', 'host', 'darwin')).toMatch(/scream-[0-9a-f]{24}\.sock$/);
  });

  it('gives every scope and name its own address', () => {
    const a = processLockAddress('/home/a/.scream-code', 'host', 'linux');
    expect(processLockAddress('/home/b/.scream-code', 'host', 'linux')).not.toBe(a);
    expect(processLockAddress('/home/a/.scream-code', 'session:x', 'linux')).not.toBe(a);
  });

  it('keeps a socket file path short enough for sun_path', () => {
    expect(processLockAddress('/h', 'host', 'darwin').length).toBeLessThanOrEqual(100);
  });
});

describe('acquireProcessLock', () => {
  it('lets one holder in and tells the next caller who holds it', async () => {
    const options = { scope: scope(), name: 'host', info: { kind: 'host', version: '1.2.3' } };
    const first = await take(options);

    const second = await acquireProcessLock(options);
    if (second.held) throw new Error('expected the lock to be busy');
    expect(second.holder).toMatchObject({
      pid: process.pid,
      runId: first.identity.runId,
      info: { kind: 'host', version: '1.2.3' },
    });

    expect(await queryProcessLock(options)).toMatchObject({ held: true, holder: { runId: first.identity.runId } });
  });

  it('is free again once released', async () => {
    const options = { scope: scope(), name: 'host' };
    const first = await take(options);
    await first.release();
    held.pop();

    expect(await queryProcessLock(options)).toEqual({ held: false });
    const again = await take(options);
    expect(again.identity.runId).not.toBe(first.identity.runId);
  });

  it('answers requests that carry the token, and only those', async () => {
    const options = { scope: scope(), name: 'host', token: 'secret-token' };
    const lock = await take(options);
    const seen: unknown[] = [];
    lock.onRequest((request) => {
      seen.push(request.type);
      return { ok: true, echoed: request.type };
    });

    expect(await requestProcessLock(options, { type: 'stop', token: 'wrong' })).toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(await requestProcessLock(options, { type: 'stop' })).toEqual({ ok: false, error: 'unauthorized' });
    expect(seen).toEqual([]);

    expect(await requestProcessLock(options, { type: 'stop', token: 'secret-token' })).toEqual({
      ok: true,
      echoed: 'stop',
    });
    expect(seen).toEqual(['stop']);
  });

  it('returns undefined for a request when nobody holds the name', async () => {
    expect(await requestProcessLock({ scope: scope(), name: 'host' }, { type: 'stop' })).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' || process.platform === 'linux')(
    'takes over a socket file a killed holder left behind',
    async () => {
      const options = { scope: scope(), name: 'host' };
      const address = processLockAddress(options.scope, options.name);
      writeFileSync(address, '');
      expect(existsSync(address)).toBe(true);

      await take(options);
      expect(await queryProcessLock(options)).toMatchObject({ held: true });
    },
  );

  it('is released when the holder process dies without cleaning up', async () => {
    const options = { scope: scope(), name: 'host' };
    const moduleUrl = new URL('../../src/utils/process-lock.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(moduleUrl)});
         const lock = await m.acquireProcessLock(${JSON.stringify(options)});
         process.stdout.write(lock.held ? 'held\\n' : 'busy\\n');
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('held')) resolve();
          else reject(new Error(chunk.toString()));
        });
        child.on('exit', (code) => {
          reject(new Error(`child exited ${String(code)}`));
        });
      });
      expect(await queryProcessLock(options)).toMatchObject({ held: true, holder: { pid: child.pid } });

      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));

      const lock = await take(options);
      expect(lock.identity.pid).toBe(process.pid);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe('signed requests', () => {
  it('never sends the token, accepts a signed request once, and refuses a replay or a wrong key', async () => {
    const { acquireProcessLock: acquire, requestProcessLock: request, signProcessLockRequest, processLockAddress } = await import(
      '../../src/utils/process-lock'
    );
    const { createConnection } = await import('node:net');
    const scope = `signed-${String(process.pid)}-${String(Date.now())}`;
    const lock = await acquire({ scope, name: 'host', token: 'secret-token' });
    if (!lock.held) throw new Error('not held');
    const seen: unknown[] = [];
    lock.onRequest((req) => {
      seen.push(req);
      return { ok: true };
    });
    try {
      expect(await request({ scope, name: 'host' }, { type: 'sweep', token: 'secret-token' })).toEqual({ ok: true });
      expect(JSON.stringify(seen[0])).not.toContain('secret-token');
      expect(await request({ scope, name: 'host' }, { type: 'sweep', token: 'wrong' })).toMatchObject({ error: 'unauthorized' });

      const signed = signProcessLockRequest({ type: 'stop', token: 'secret-token' });
      expect(JSON.stringify(signed)).not.toContain('secret-token');
      const send = (line: string): Promise<string> =>
        new Promise((resolve, reject) => {
          const socket = createConnection(processLockAddress(scope, 'host'));
          let data = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk: string) => {
            data += chunk;
            if (data.split('\n').length > 2) socket.end();
          });
          socket.on('end', () => {
            resolve(data.split('\n')[1] ?? '');
          });
          socket.on('error', reject);
          socket.write(`${line}\n`);
        });
      expect(await send(JSON.stringify(signed))).toContain('"ok":true');
      expect(await send(JSON.stringify(signed))).toContain('unauthorized');
      const old = signProcessLockRequest({ type: 'stop', token: 'secret-token' }, Date.now() - 5 * 60_000);
      expect(await send(JSON.stringify(old))).toContain('unauthorized');
    } finally {
      await lock.release();
    }
  });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'freebsd')('stale socket file', () => {
  // Smoke test only: it does not force the interleaving that let two
  // acquirers both hold the lock (that needs a delay between probe and
  // unlink); the guard's correctness rests on the code, not on this test.
  it('is cleared, and two acquirers at once end with one holder', async () => {
    const { acquireProcessLock: acquire, processLockAddress } = await import('../../src/utils/process-lock');
    const { writeFileSync, rmSync } = await import('node:fs');
    const scope = `stale-${String(process.pid)}-${String(Date.now())}`;
    const address = processLockAddress(scope, 'jobs-store');
    writeFileSync(address, '');
    try {
      const results = await Promise.all([acquire({ scope, name: 'jobs-store' }), acquire({ scope, name: 'jobs-store' })]);
      expect(results.filter((r) => r.held)).toHaveLength(1);
      for (const r of results) if (r.held) await r.release();
    } finally {
      rmSync(address, { force: true });
      rmSync(`${address}.clearing`, { force: true });
    }
  });
});

describe.runIf(process.platform === 'darwin')('socket file address', () => {
  it('lives in the home, whatever TMPDIR says, so every process of a home finds it', async () => {
    const { processLockAddress } = await import('../../src/utils/process-lock');
    const { mkdtempSync, rmSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = realpathSync(mkdtempSync('/tmp/h-'));
    try {
      const before = processLockAddress(home, 'host');
      const saved = process.env['TMPDIR'];
      process.env['TMPDIR'] = '/somewhere/else';
      try {
        expect(processLockAddress(home, 'host')).toBe(before);
      } finally {
        if (saved === undefined) delete process.env['TMPDIR'];
        else process.env['TMPDIR'] = saved;
      }
      expect(before.startsWith(join(home, 'run'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
