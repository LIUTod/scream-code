/**
 * Covers: rg-locator (ripgrep hybrid binary resolution).
 *
 * Pure-lookup pins (no real CDN download):
 *   - `findExistingRg` returns undefined when PATH + share-bin are both empty
 *   - Resolves from `<shareDir>/bin/rg` when that binary exists
 *   - Prefers system PATH over share-dir cache when both are available
 *   - `rgUnavailableMessage` surfaces the underlying cause + install hints
 *
 * Platform pins (injected probes, no ambient `process` state):
 *   - `detectTarget` / `resolveRgArchive` host → upstream release matrix,
 *     including the Linux libc probe that decides aarch64
 *   - `detectLinuxLibc` signal order (Alpine marker → diagnostic report →
 *     musl loader → glibc default)
 *   - the pin gate: an archive with no pinned SHA-256 is never downloaded
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { extract as extractTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';

import {
  detectLinuxLibc,
  detectTarget,
  ensureRgPath,
  extractRgFromZip,
  findExistingRg,
  pinnedRgArchive,
  resolveRgArchive,
  rgUnavailableMessage,
  verifyArchiveChecksum,
  type LinuxLibc,
} from '../../src/tools/support/rg-locator';

// Download-branch tests mock `tar.extract` so the archive layout is
// controlled by the test, not the real CDN. `fetch` is replaced per-test
// on `globalThis` to drive the failure and success paths.
vi.mock('tar', () => ({ extract: vi.fn() }));

describe('findExistingRg', () => {
  let fakeShare: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    fakeShare = join(tmpdir(), `scream-rg-${String(Date.now())}-${String(Math.random()).slice(2)}`);
    mkdirSync(join(fakeShare, 'bin'), { recursive: true });
    savedPath = process.env['PATH'];
    // Empty PATH → rules out step 1 (system-path) for the default case.
    process.env['PATH'] = '';
  });
  afterEach(() => {
    rmSync(fakeShare, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
  });

  it('returns undefined when no rg anywhere', async () => {
    const result = await findExistingRg(fakeShare);
    expect(result).toBeUndefined();
  });

  it('resolves from share-dir when cached', async () => {
    const cached = join(fakeShare, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    writeFileSync(cached, '#!/bin/sh\necho ripgrep 15.0.0\n');
    chmodSync(cached, 0o755);
    const result = await findExistingRg(fakeShare);
    expect(result).toEqual({ path: cached, source: 'share-bin-cached' });
  });

  it('prefers system PATH over share-dir when both are available', async () => {
    // Stage a fake rg on PATH.
    const pathDir = join(fakeShare, 'path');
    mkdirSync(pathDir, { recursive: true });
    const onPath = join(pathDir, process.platform === 'win32' ? 'rg.exe' : 'rg');
    writeFileSync(onPath, '#!/bin/sh\n');
    chmodSync(onPath, 0o755);
    process.env['PATH'] = pathDir;
    // Also stage a cached one to confirm the order.
    const cached = join(fakeShare, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    writeFileSync(cached, '#!/bin/sh\n');
    chmodSync(cached, 0o755);
    const result = await findExistingRg(fakeShare);
    expect(result?.source).toBe('system-path');
    expect(result?.path).toBe(onPath);
  });
});

// Every host decision comes from injected probes, so this suite answers the
// same way on any CI runner: no `process.platform` / `process.arch` patching.
describe('detectTarget', () => {
  it('darwin arm64 → aarch64-apple-darwin', async () => {
    await expect(detectTarget({ platform: 'darwin', arch: 'arm64' })).resolves.toBe(
      'aarch64-apple-darwin',
    );
  });
  it('darwin x64 → x86_64-apple-darwin', async () => {
    await expect(detectTarget({ platform: 'darwin', arch: 'x64' })).resolves.toBe(
      'x86_64-apple-darwin',
    );
  });
  it('win32 x64 → x86_64-pc-windows-msvc', async () => {
    await expect(detectTarget({ platform: 'win32', arch: 'x64' })).resolves.toBe(
      'x86_64-pc-windows-msvc',
    );
  });
  it('win32 arm64 → aarch64-pc-windows-msvc', async () => {
    await expect(detectTarget({ platform: 'win32', arch: 'arm64' })).resolves.toBe(
      'aarch64-pc-windows-msvc',
    );
  });
  it('linux x64 on glibc → x86_64-unknown-linux-musl, without probing the libc', async () => {
    // Upstream ships exactly one Linux x64 build (static musl, which runs
    // unchanged on glibc), so the libc cannot change the answer here — and the
    // probe must not even run, since it costs a diagnostic report.
    const detectLinuxLibc = vi.fn(
      (): Promise<LinuxLibc> => Promise.reject(new Error('libc probe must not run')),
    );
    await expect(
      detectTarget({ platform: 'linux', arch: 'x64', detectLinuxLibc }),
    ).resolves.toBe('x86_64-unknown-linux-musl');
    expect(detectLinuxLibc).not.toHaveBeenCalled();
  });
  it('linux x64 on musl → x86_64-unknown-linux-musl (the same static build)', async () => {
    await expect(
      detectTarget({ platform: 'linux', arch: 'x64', detectLinuxLibc: async () => 'musl' }),
    ).resolves.toBe('x86_64-unknown-linux-musl');
  });
  it('linux arm64 on glibc → aarch64-unknown-linux-gnu', async () => {
    await expect(
      detectTarget({ platform: 'linux', arch: 'arm64', detectLinuxLibc: async () => 'glibc' }),
    ).resolves.toBe('aarch64-unknown-linux-gnu');
  });
  it('linux arm64 on musl → undefined (upstream ships no musl aarch64 build)', async () => {
    await expect(
      detectTarget({ platform: 'linux', arch: 'arm64', detectLinuxLibc: async () => 'musl' }),
    ).resolves.toBeUndefined();
  });
  it('probes the musl loader for the injected arch, not the host arch', async () => {
    // Both ambient inputs are pinned so this means the same thing on an x64 and
    // an arm64 runner: a diagnostic report with no glibc signal, and a host arch
    // whose musl loader is *not* the one the fake filesystem has. With
    // `arch: 'arm64'` the probe must look for `ld-musl-aarch64.so.1`; reading
    // the host arch instead would answer for a different machine and report
    // this one as glibc.
    const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!;
    const report = vi.spyOn(process.report, 'getReport').mockReturnValue({ header: {} } as never);
    Object.defineProperty(process, 'arch', { ...archDescriptor, value: 'x64' });
    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
      return {
        ...actual,
        stat: async (path: string) => {
          if (path === '/lib/ld-musl-aarch64.so.1') return { isFile: () => true };
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      };
    });

    try {
      const { detectTarget: isolatedDetectTarget } =
        await import('../../src/tools/support/rg-locator');
      await expect(
        isolatedDetectTarget({ platform: 'linux', arch: 'arm64' }),
      ).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, 'arch', archDescriptor);
      report.mockRestore();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('unsupported arch → undefined', async () => {
    await expect(detectTarget({ platform: 'linux', arch: 'mips' })).resolves.toBeUndefined();
  });
  it('unsupported platform → undefined', async () => {
    await expect(detectTarget({ platform: 'freebsd', arch: 'arm64' })).resolves.toBeUndefined();
  });
});

describe('detectLinuxLibc', () => {
  const noFile = async (): Promise<boolean> => false;

  it('reports musl from the Alpine marker, which outranks a reported glibc runtime', async () => {
    // Alpine ships a glibc-compat shim, so the marker has to win over the
    // "running binary is glibc-linked" signal.
    await expect(
      detectLinuxLibc({
        arch: 'arm64',
        isFile: async (path) => path === '/etc/alpine-release',
        glibcVersionRuntime: () => '2.31',
      }),
    ).resolves.toBe('musl');
  });

  it('reports glibc from the diagnostic report when no marker file exists', async () => {
    await expect(
      detectLinuxLibc({ arch: 'arm64', isFile: noFile, glibcVersionRuntime: () => '2.31' }),
    ).resolves.toBe('glibc');
  });

  it('reports musl from the musl loader on a non-Alpine host', async () => {
    await expect(
      detectLinuxLibc({
        arch: 'arm64',
        isFile: async (path) => path === '/lib/ld-musl-aarch64.so.1',
        glibcVersionRuntime: () => undefined,
      }),
    ).resolves.toBe('musl');
  });

  it('defaults to glibc when no signal is present', async () => {
    await expect(
      detectLinuxLibc({ arch: 'arm64', isFile: noFile, glibcVersionRuntime: () => undefined }),
    ).resolves.toBe('glibc');
  });

  it('treats an empty report value as "no glibc signal"', async () => {
    await expect(
      detectLinuxLibc({
        arch: 'x64',
        isFile: async (path) => path === '/lib/ld-musl-x86_64.so.1',
        glibcVersionRuntime: () => '',
      }),
    ).resolves.toBe('musl');
  });
});

describe('resolveRgArchive', () => {
  it('glibc x64 → the pinned static musl archive over HTTPS', async () => {
    const archive = await resolveRgArchive({
      platform: 'linux',
      arch: 'x64',
      detectLinuxLibc: async () => 'glibc',
    });
    expect(archive.target).toBe('x86_64-unknown-linux-musl');
    expect(archive.name).toBe('ripgrep-15.0.0-x86_64-unknown-linux-musl.tar.gz');
    expect(new URL(archive.url).protocol).toBe('https:');
    expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(archive.isWindows).toBe(false);
  });

  it('musl arm64 → rejects with an install hint instead of a target that cannot run', async () => {
    const error = await resolveRgArchive({
      platform: 'linux',
      arch: 'arm64',
      detectLinuxLibc: async () => 'musl',
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    const message = rgUnavailableMessage(error);
    expect(message).toContain('musl');
    expect(message).toContain('brew install ripgrep');
  });

  it('windows x64 → the pinned .zip plan', async () => {
    const archive = await resolveRgArchive({ platform: 'win32', arch: 'x64' });
    expect(archive.name).toBe('ripgrep-15.0.0-x86_64-pc-windows-msvc.zip');
    expect(archive.isWindows).toBe(true);
  });

  it('refuses an archive that has no pinned SHA-256', () => {
    // Not reachable through `detectTarget` today (every target it can emit is
    // pinned) — this is the gate that keeps a future target from shipping an
    // unverified download.
    expect(() => pinnedRgArchive('x86_64-unknown-linux-gnu')).toThrow(/No pinned SHA-256/);
  });

  it('has a pinned archive for every target the host decision can produce', async () => {
    // Guards the other direction: adding a `decideTarget` branch without a
    // matching pin would make bootstrap fail at runtime instead of here.
    const combos: Array<Partial<Parameters<typeof resolveRgArchive>[0]>> = [
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'darwin', arch: 'x64' },
      { platform: 'win32', arch: 'x64' },
      { platform: 'win32', arch: 'arm64' },
      { platform: 'linux', arch: 'x64' },
      { platform: 'linux', arch: 'arm64', detectLinuxLibc: async () => 'glibc' },
    ];

    for (const combo of combos) {
      const archive = await resolveRgArchive(combo);
      expect(archive.name).toBe(
        `ripgrep-15.0.0-${archive.target}.${archive.isWindows ? 'zip' : 'tar.gz'}`,
      );
      expect(archive.sha256).toHaveLength(64);
    }
  });
});

describe('rgUnavailableMessage', () => {
  it('surfaces the underlying cause and install hints', () => {
    const msg = rgUnavailableMessage(new Error('fetch failed'));
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('brew install ripgrep');
    expect(msg).toContain('https://github.com/BurntSushi/ripgrep');
  });

  it('handles non-Error causes (string, unknown)', () => {
    const a = rgUnavailableMessage('boom');
    expect(a).toContain('boom');
    const b = rgUnavailableMessage(42);
    expect(b).toContain('unknown error');
  });
});

describe('verifyArchiveChecksum', () => {
  let fakeDir: string;
  beforeEach(() => {
    fakeDir = join(tmpdir(), `scream-rg-sha-${String(Date.now())}-${String(Math.random()).slice(2)}`);
    mkdirSync(fakeDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('accepts a file whose SHA-256 matches the expected digest', async () => {
    const archivePath = join(fakeDir, 'archive.tar.gz');
    const payload = Buffer.from('trusted archive bytes', 'utf8');
    writeFileSync(archivePath, payload);
    const expectedSha256 = createHash('sha256').update(payload).digest('hex');

    await expect(
      verifyArchiveChecksum(archivePath, 'archive.tar.gz', expectedSha256),
    ).resolves.toBeUndefined();
  });

  it('rejects a file whose SHA-256 differs from the expected digest', async () => {
    const archivePath = join(fakeDir, 'archive.tar.gz');
    writeFileSync(archivePath, 'tampered archive bytes');

    await expect(
      verifyArchiveChecksum(archivePath, 'archive.tar.gz', '0'.repeat(64)),
    ).rejects.toThrow(/checksum mismatch/);
  });
});

describe('ensureRgPath download branch', () => {
  let fakeShare: string;
  let savedPath: string | undefined;
  let savedFetch: typeof globalThis.fetch | undefined;
  beforeEach(() => {
    fakeShare = join(
      tmpdir(),
      `scream-rg-dl-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    );
    mkdirSync(join(fakeShare, 'bin'), { recursive: true });
    savedPath = process.env['PATH'];
    process.env['PATH'] = ''; // force the locator past `whichRg`
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    rmSync(fakeShare, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    if (savedFetch === undefined) {
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    } else {
      globalThis.fetch = savedFetch;
    }
    vi.restoreAllMocks();
  });

  it('surfaces a network error when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network unreachable')) as typeof fetch;
    await expect(ensureRgPath({ shareDir: fakeShare })).rejects.toThrow(/network unreachable/);
  });

  it('does not start bootstrap work when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ensureRgPath({ shareDir: fakeShare, signal: controller.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not start bootstrap work when aborted after lookup misses', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let rejectFirstStat: ((error: Error) => void) | undefined;
    let statCalls = 0;
    const statMock = vi.fn(() => {
      statCalls += 1;
      if (statCalls === 1) {
        return new Promise<never>((_resolve, reject) => {
          rejectFirstStat = reject;
        });
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
      return { ...actual, stat: statMock };
    });

    try {
      const { ensureRgPath: isolatedEnsureRgPath } =
        await import('../../src/tools/support/rg-locator');
      const resultPromise = isolatedEnsureRgPath({
        shareDir: fakeShare,
        signal: controller.signal,
      });

      await vi.waitFor(() => {
        expect(statMock).toHaveBeenCalledTimes(1);
      });
      controller.abort();
      rejectFirstStat?.(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expect(resultPromise).rejects.toHaveProperty('name', 'AbortError');
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      expect(statMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('aborts the current caller wait while shared bootstrap work continues', async () => {
    const controller = new AbortController();
    let resolveFetch: (response: {
      ok: false;
      status: number;
      statusText: string;
      body: null;
    }) => void = () => {};
    const fetchResponse = new Promise<{
      ok: false;
      status: number;
      statusText: string;
      body: null;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = vi.fn(() => fetchResponse) as unknown as typeof fetch;

    const resultPromise = ensureRgPath({ shareDir: fakeShare, signal: controller.signal });
    await vi.waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    controller.abort();
    await expect(resultPromise).rejects.toHaveProperty('name', 'AbortError');

    resolveFetch({ ok: false, status: 499, statusText: 'Client Closed', body: null });
    await expect(ensureRgPath({ shareDir: fakeShare })).rejects.toThrow(/HTTP 499 Client Closed/);
  });

  it('surfaces HTTP failure (non-2xx response) with status + statusText', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: null,
    }) as unknown as typeof fetch;
    await expect(ensureRgPath({ shareDir: fakeShare })).rejects.toThrow(/HTTP 404 Not Found/);
  });

  it('fetches ripgrep over HTTPS', async () => {
    const body = bodyFromBuffer(Buffer.from('not a real archive', 'utf8'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(ensureRgPath({ shareDir: fakeShare })).rejects.toThrow();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).protocol).toBe('https:');
  });

  it('rejects archives that do not match the pinned SHA-256 before extraction', async () => {
    const tarMock = vi.mocked(extractTar);
    tarMock.mockClear();
    const body = bodyFromBuffer(Buffer.from('tampered archive', 'utf8'));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body,
    }) as unknown as typeof fetch;

    await expect(ensureRgPath({ shareDir: fakeShare })).rejects.toThrow(/checksum/i);

    expect(tarMock).not.toHaveBeenCalled();
    expect(existsSync(join(fakeShare, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'))).toBe(
      false,
    );
  });
});

// ── Windows zip download branch ─────────────────────────────────────────
//
// Counterpart to the Linux `ensureRgPath download branch` tests but
// drives the `target.includes('windows')` path: the CDN delivers a `.zip`,
// yauzl walks the entries, and `rg.exe` lands at `<shareDir>/bin/rg.exe`.
// `detectTarget()` reads `process.platform` + `process.arch`, so we
// override both per-test via Object.defineProperty (the same trick used
// by the `detectTarget` suite above).
//
// Fixture zips are built in-memory with `yazl` so tests stay hermetic
// (no committed binary fixtures on the repo). The archive uses the
// layout the CDN actually ships (`ripgrep-{ver}-{target}/rg.exe`).

function buildFixtureZip(entries: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const { name, content } of entries) {
      zip.addBuffer(content, name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zip.outputStream.on('error', reject);
  });
}

function bodyFromBuffer(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

describe('ensureRgPath Windows download branch', () => {
  let fakeShare: string;
  let savedPath: string | undefined;
  let savedFetch: typeof globalThis.fetch | undefined;
  let savedArch: string;
  let savedPlatform: string;
  beforeEach(() => {
    fakeShare = join(
      tmpdir(),
      `scream-rg-win-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    );
    mkdirSync(join(fakeShare, 'bin'), { recursive: true });
    savedPath = process.env['PATH'];
    process.env['PATH'] = ''; // force past whichRg
    savedFetch = globalThis.fetch;
    savedArch = process.arch;
    savedPlatform = process.platform;
    // Simulate a Windows host end-to-end — `rgBinaryName()`, `whichRg()`
    // (PATH sep), and `detectTarget()` all key off these two values.
    Object.defineProperty(process, 'arch', { value: 'x64' });
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    rmSync(fakeShare, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    if (savedFetch === undefined) {
      delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    } else {
      globalThis.fetch = savedFetch;
    }
    Object.defineProperty(process, 'arch', { value: savedArch });
    Object.defineProperty(process, 'platform', { value: savedPlatform });
    vi.restoreAllMocks();
  });

  it('fetches the .zip URL (not .tar.gz) on Windows target', async () => {
    const zipBuf = await buildFixtureZip([
      {
        name: 'ripgrep-15.0.0-x86_64-pc-windows-msvc/rg.exe',
        content: Buffer.from('MZfake-pe-bytes', 'utf8'),
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: bodyFromBuffer(zipBuf),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(ensureRgPath({ shareDir: fakeShare })).rejects.toThrow(/checksum mismatch/);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/ripgrep-15\.0\.0-x86_64-pc-windows-msvc\.zip$/);
  });

  it('extracts rg.exe into <shareDir>/bin/rg.exe', async () => {
    const payload = Buffer.from('MZfake-pe-bytes-extracted', 'utf8');
    const zipBuf = await buildFixtureZip([
      {
        name: 'ripgrep-15.0.0-x86_64-pc-windows-msvc/rg.exe',
        content: payload,
      },
    ]);

    const archivePath = join(fakeShare, 'fixture.zip');
    const installed = join(fakeShare, 'bin', 'rg.exe');
    writeFileSync(archivePath, zipBuf);

    await extractRgFromZip(archivePath, installed);

    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed)).toEqual(payload);
  });

  it('throws with "CDN content may have changed" when the zip omits rg.exe', async () => {
    // Archive is well-formed but holds the wrong entry — mirrors the
    // Counterpart to the Linux third-download test's sentinel.
    const zipBuf = await buildFixtureZip([{ name: 'README.md', content: Buffer.from('readme') }]);
    const archivePath = join(fakeShare, 'fixture.zip');
    const installed = join(fakeShare, 'bin', 'rg.exe');
    writeFileSync(archivePath, zipBuf);

    await expect(extractRgFromZip(archivePath, installed)).rejects.toThrow(
      /CDN content may have changed/,
    );
  });

  it('surfaces HTTP failure on Windows with status + statusText', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      body: null,
    }) as unknown as typeof fetch;
    await expect(ensureRgPath({ shareDir: fakeShare })).rejects.toThrow(/HTTP 502 Bad Gateway/);
  });
});
