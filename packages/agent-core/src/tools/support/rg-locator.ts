/**
 * rg-locator — hybrid ripgrep binary resolution.
 *
 * Lookup order (first hit wins):
 *   1. System PATH (`which rg`) — fastest, respects developer setup
 *   2. Bundled vendor binary (hook; not wired yet — `getVendorRgPath` is a stub)
 *   3. `<SCREAM_CODE_HOME>/bin/rg` — persistent cache for this app.
 *   4. CDN download to <SCREAM_CODE_HOME>/bin/ — one-off bootstrap
 *
 * If steps 1-4 all fail, callers receive a structured error they can
 * turn into a user-facing "install ripgrep" hint instead of the naked
 * `spawn rg ENOENT`.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'pathe';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extract as extractTar } from 'tar';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

import { resolveScreamHome } from '../../config/path';
import { abortable } from '../../utils/abort';

const RG_VERSION = '15.0.0';
const RG_BASE_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const RG_ARCHIVE_SHA256: Record<string, string> = {
  'ripgrep-15.0.0-aarch64-apple-darwin.tar.gz':
    '98bb2e61e7277ba0ea72d2ae2592497fd8d2940934a16b122448d302a6637e3b',
  'ripgrep-15.0.0-aarch64-pc-windows-msvc.zip':
    '572709c8770cb7f9385d725cb06d2bcd9537ec24d4dd17b1be1d65a876f8b591',
  'ripgrep-15.0.0-aarch64-unknown-linux-gnu.tar.gz':
    '15f8cc2fab12d88491c54d49f38589922a9d6a7353c29b0a0856727bcdf80754',
  'ripgrep-15.0.0-x86_64-apple-darwin.tar.gz':
    '44128c733d127ddbda461e01225a68b5f9997cfe7635242a797f645ca674a71a',
  'ripgrep-15.0.0-x86_64-pc-windows-msvc.zip':
    '21a98bf42c4da97ca543c010e764cc6dec8b9b7538d05f8d21874016385e0860',
  'ripgrep-15.0.0-x86_64-unknown-linux-musl.tar.gz':
    '253ad0fd5fef0d64cba56c70dccdacc1916d4ed70ad057cc525fcdb0c3bbd2a7',
};

export type RgResolutionSource =
  | 'system-path'
  | 'vendor'
  | 'share-bin-cached'
  | 'share-bin-downloaded';

export interface RgResolution {
  readonly path: string;
  readonly source: RgResolutionSource;
}

export interface EnsureRgPathOptions {
  readonly shareDir?: string | undefined;
  /**
   * Cancels this caller's wait. A shared bootstrap download that is already in
   * progress may continue so other callers can still use the same result.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolve the absolute path to a usable `rg` binary, downloading it
 * into `<shareDir>/bin/` if necessary. Multiple concurrent callers are
 * serialized by a module-level lock so the download happens at most
 * once per process.
 */
export async function ensureRgPath(options: EnsureRgPathOptions = {}): Promise<RgResolution> {
  options.signal?.throwIfAborted();
  const resolution = resolveRgPath(options.shareDir ?? resolveScreamHome(), options.signal);
  return options.signal === undefined ? resolution : abortable(resolution, options.signal);
}

async function resolveRgPath(
  shareDir: string,
  signal?: AbortSignal | undefined,
): Promise<RgResolution> {
  const existing = await findExistingRg(shareDir);
  if (existing) return existing;
  signal?.throwIfAborted();
  return downloadRgWithLock(shareDir);
}

/**
 * Pure-lookup variant for test harnesses that want to assert on the
 * resolution order without triggering a real download.
 */
export async function findExistingRg(shareDir: string): Promise<RgResolution | undefined> {
  const binName = rgBinaryName();
  const systemRg = await whichRg();
  if (systemRg !== undefined) return { path: systemRg, source: 'system-path' };
  const vendorPath = getVendorRgPath(binName);
  if (vendorPath !== undefined && (await fileExists(vendorPath))) {
    return { path: vendorPath, source: 'vendor' };
  }
  const cachePath = join(shareDir, 'bin', binName);
  if (await fileExists(cachePath)) {
    return { path: cachePath, source: 'share-bin-cached' };
  }
  return undefined;
}

let downloadPromise: Promise<RgResolution> | undefined;
async function downloadRgWithLock(shareDir: string): Promise<RgResolution> {
  if (downloadPromise !== undefined) return downloadPromise;
  downloadPromise = (async () => {
    try {
      const existing = await findExistingRg(shareDir);
      if (existing) return existing;
      const binPath = await downloadAndInstallRg(shareDir);
      return { path: binPath, source: 'share-bin-downloaded' };
    } finally {
      downloadPromise = undefined;
    }
  })();
  return downloadPromise;
}

function rgBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function getVendorRgPath(_binName: string): string | undefined {
  return undefined;
}

async function whichRg(): Promise<string | undefined> {
  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const binName = rgBinaryName();
  for (const dir of pathEnv.split(sep)) {
    if (dir === '') continue;
    const candidate = join(dir, binName);
    try {
      const st = await stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* not here, try next */
    }
  }
  return undefined;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Rust target-triple arch component, for the Node arches ripgrep ships binaries for. */
const TARGET_ARCH: Record<string, string | undefined> = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

/** Node arch → the arch component musl uses in its dynamic loader file name. */
const LINUX_LOADER_ARCH: Record<string, string | undefined> = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

export type LinuxLibc = 'glibc' | 'musl';

export interface LibcProbe {
  readonly arch: string;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly glibcVersionRuntime: () => string | undefined;
}

export interface RgTargetProbe {
  readonly platform: string;
  readonly arch: string;
  readonly detectLinuxLibc: () => Promise<LinuxLibc>;
}

/**
 * Decide whether the Linux host is musl- or glibc-based.
 *
 * The libc is probed, never inferred from the arch: a glibc-linked binary
 * cannot exec on a musl host, so guessing wrong hands the user a broken `rg`.
 * Three positive signals, each cheap, then a documented default:
 *
 *   1. `/etc/alpine-release` — Alpine states its own libc here, and the marker
 *      wins over the probes below because Alpine also ships a glibc-compat
 *      shim that would otherwise make the next signal claim "glibc".
 *   2. Node's diagnostic report `header.glibcVersionRuntime` — populated only
 *      when the *running* binary bound to glibc, so it is strong evidence for
 *      distros that carry no marker file.
 *   3. The musl dynamic loader `/lib/ld-musl-<arch>.so.1` — covers non-Alpine
 *      musl distros and musl container images.
 *   4. Default `glibc`: the Linux baseline. A wrong guess here only changes the
 *      outcome on aarch64 Linux, where it selects the glibc build.
 */
export async function detectLinuxLibc(probe: Partial<LibcProbe> = {}): Promise<LinuxLibc> {
  const isFile = probe.isFile ?? fileExists;
  if (await isFile('/etc/alpine-release')) return 'musl';

  const glibcVersion = (probe.glibcVersionRuntime ?? nodeGlibcVersionRuntime)();
  if (glibcVersion !== undefined && glibcVersion.length > 0) return 'glibc';

  const loaderArch = LINUX_LOADER_ARCH[probe.arch ?? process.arch];
  if (loaderArch !== undefined && (await isFile(`/lib/ld-musl-${loaderArch}.so.1`))) {
    return 'musl';
  }
  return 'glibc';
}

function nodeGlibcVersionRuntime(): string | undefined {
  try {
    const report = process.report.getReport() as unknown;
    const header = (report as { header?: unknown }).header;
    const version = (header as { glibcVersionRuntime?: unknown } | undefined)?.glibcVersionRuntime;
    return typeof version === 'string' ? version : undefined;
  } catch {
    // `getReport()` is unavailable under `--report-...` restrictions and can
    // throw on some embedded runtimes — treat that as "no glibc signal".
    return undefined;
  }
}

type RgTargetDecision =
  | { readonly kind: 'target'; readonly target: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * The single decision tree behind {@link detectTarget} and
 * {@link resolveRgArchive}: one place that knows which host maps to which
 * upstream release, so the "which target" and "why is there none" answers
 * cannot drift apart.
 *
 * Linux is the only platform whose libc matters, and upstream publishes exactly
 * one Linux build per arch:
 *   - x86_64: the static musl build only. Static musl runs unchanged on glibc
 *     hosts, so both libcs resolve to the same archive and no probe is needed.
 *   - aarch64: the glibc build only, so musl (e.g. Alpine) has no build at all.
 */
async function decideTarget(probe: Partial<RgTargetProbe>): Promise<RgTargetDecision> {
  const nodeArch = probe.arch ?? process.arch;
  const arch = TARGET_ARCH[nodeArch];
  if (arch === undefined) {
    return { kind: 'unavailable', reason: `unsupported architecture '${nodeArch}'` };
  }

  const platform = probe.platform ?? process.platform;
  if (platform === 'darwin') return { kind: 'target', target: `${arch}-apple-darwin` };
  if (platform === 'win32') return { kind: 'target', target: `${arch}-pc-windows-msvc` };
  if (platform !== 'linux') {
    return { kind: 'unavailable', reason: `unsupported platform '${platform}'` };
  }

  if (arch === 'x86_64') return { kind: 'target', target: 'x86_64-unknown-linux-musl' };

  // The injected arch has to reach the default probe: the loader it looks for
  // is `/lib/ld-musl-<arch>.so.1`, so probing with the host's arch instead
  // would answer a question about a different machine (and make the injected
  // arch a seam that only half applies).
  const libc = await (probe.detectLinuxLibc !== undefined
    ? probe.detectLinuxLibc()
    : detectLinuxLibc({ arch: nodeArch }));
  if (libc === 'glibc') return { kind: 'target', target: 'aarch64-unknown-linux-gnu' };
  return {
    kind: 'unavailable',
    reason:
      `no upstream ripgrep ${RG_VERSION} release exists for aarch64 Linux with musl ` +
      '(Alpine ARM64); upstream publishes glibc only for aarch64',
  };
}

/** @internal for tests — rust-style `<arch>-<vendor>-<os>` target triple. */
export async function detectTarget(
  probe: Partial<RgTargetProbe> = {},
): Promise<string | undefined> {
  const decision = await decideTarget(probe);
  return decision.kind === 'target' ? decision.target : undefined;
}

interface RgArchive {
  readonly target: string;
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly isWindows: boolean;
}

/**
 * Build the download plan for one target triple, or throw when that archive is
 * not pinned in {@link RG_ARCHIVE_SHA256}. Kept separate from
 * {@link resolveRgArchive} so the pin gate is directly testable without
 * inventing a reachable-but-unpinned host.
 *
 * @internal for tests
 */
export function pinnedRgArchive(target: string): RgArchive {
  const isWindows = target.includes('windows');
  const name = `ripgrep-${RG_VERSION}-${target}.${isWindows ? 'zip' : 'tar.gz'}`;
  const sha256 = RG_ARCHIVE_SHA256[name];
  if (sha256 === undefined) {
    throw new Error(
      `No pinned SHA-256 is configured for ripgrep archive ${name}, so it will not be ` +
        'downloaded. Install ripgrep with your package manager and re-run.',
    );
  }
  return { target, name, url: `${RG_BASE_URL}/${name}`, sha256, isWindows };
}

/**
 * Resolve the release archive to bootstrap — the only download gate.
 *
 * Throws (never falls back to a different target) when the host has no
 * supported build or when the resulting archive is not in
 * {@link RG_ARCHIVE_SHA256}: downloading bytes we cannot verify against a
 * pinned digest is worse than telling the user to install ripgrep themselves.
 * Callers turn the thrown message into user-facing text with
 * {@link rgUnavailableMessage}.
 *
 * @internal for tests
 */
export async function resolveRgArchive(probe: Partial<RgTargetProbe> = {}): Promise<RgArchive> {
  const decision = await decideTarget(probe);
  if (decision.kind === 'unavailable') {
    throw new Error(
      `No automatic ripgrep bootstrap is available on this host: ${decision.reason}. ` +
        'Install ripgrep with your package manager and re-run.',
    );
  }
  return pinnedRgArchive(decision.target);
}

async function downloadAndInstallRg(shareDir: string): Promise<string> {
  // Windows ripgrep releases ship as `.zip`; macOS / Linux as `.tar.gz`.
  // The extraction branch inside the try block handles the format-specific
  // unpack; the fetch + download-to-tmp pipeline is identical.
  const { name: archiveName, target, url, sha256: expectedSha256, isWindows } = await resolveRgArchive();

  const binDir = join(shareDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const destination = join(binDir, rgBinaryName());

  const tmp = await mkdtemp(join(tmpdir(), 'scream-rg-'));
  try {
    const archivePath = join(tmp, archiveName);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!resp.ok || resp.body === null) {
      throw new Error(`Failed to download ripgrep: HTTP ${String(resp.status)} ${resp.statusText}`);
    }
    const write = createWriteStream(archivePath);
    // Readable.fromWeb is typed as accepting a web ReadableStream; the
    // undici/fetch body matches that shape at runtime.
    await pipeline(Readable.fromWeb(resp.body as never), write);
    await verifyArchiveChecksum(archivePath, archiveName, expectedSha256);

    if (isWindows) {
      await extractRgFromZip(archivePath, destination);
      // Windows does not need `chmod +x`: execution is gated by the
      // `.exe` extension + NTFS ACLs, which are already correct.
    } else {
      const extractDir = join(tmp, 'extract');
      await mkdir(extractDir, { recursive: true });
      // tar.gz uses hard-coded prefix because the CDN's tar.gz layout is stable
      // and known from upstream releases; zip branch uses basename matching as
      // a looser contract so a CDN prefix change doesn't silently fall through.
      await extractTar({
        file: archivePath,
        cwd: extractDir,
        gzip: true,
        filter: (entryPath: string) => entryPath.endsWith(`/${rgBinaryName()}`),
      });
      const extracted = join(extractDir, `ripgrep-${RG_VERSION}-${target}`, rgBinaryName());
      if (!existsSync(extracted)) {
        throw new Error(
          `Ripgrep archive did not contain expected binary at ${extracted}. ` +
            'CDN content may have changed.',
        );
      }
      const installDir = await mkdtemp(join(binDir, '.rg-install-'));
      const staged = join(installDir, rgBinaryName());
      try {
        await copyFile(extracted, staged);
        await chmod(staged, 0o755);
        await rename(staged, destination);
      } finally {
        await rm(installDir, { recursive: true, force: true });
      }
    }
    return destination;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** @internal for tests — fail closed before extracting downloaded bytes. */
export async function verifyArchiveChecksum(
  archivePath: string,
  archiveName: string,
  expectedSha256: string,
): Promise<void> {
  const actualSha256 = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Ripgrep archive checksum mismatch for ${archiveName}: expected ${expectedSha256}, ` +
        `got ${actualSha256}. CDN content may have changed.`,
    );
  }
}

/**
 * Read the downloaded `.zip` at `archivePath`, find the `rg.exe` entry
 * (basename match), and stream it out to `destination`. Throws with
 * the shared "CDN content may have
 * changed" sentinel when the archive holds no matching entry — same
 * failure semantics as the tar.gz path's `existsSync(extracted)` gate
 * so callers see a single actionable message.
 */
export async function extractRgFromZip(archivePath: string, destination: string): Promise<void> {
  const buf = await readFile(archivePath);
  const binName = rgBinaryName(); // 'rg.exe' on win32
  await new Promise<void>((resolve, reject) => {
    yauzlFromBuffer(buf, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(new Error(`Failed to open ripgrep archive: ${openErr?.message ?? 'unknown error'}`));
        return;
      }
      let found = false;
      const onEntry = (entry: Entry): void => {
        // Match on basename (not full path) — keeps the matcher robust
        // against CDN repackaging tweaks (e.g. an unexpected
        // `ripgrep-X.Y.Z-TARGET/` prefix change).
        if (basename(entry.fileName) !== binName) {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null) {
            reject(
              new Error(`Failed to read ${entry.fileName} from archive: ${streamErr.message}`),
            );
            zipfile.close();
            return;
          }
          const out = createWriteStream(destination);
          void (async () => {
            try {
              await pipeline(stream, out);
              zipfile.close();
              resolve();
            } catch (error) {
              zipfile.close();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          })();
        });
      };
      zipfile.on('entry', onEntry);
      zipfile.on('end', () => {
        // With lazyEntries:true, `end` fires only after readEntry() is called
        // for every central-directory entry. We stop calling readEntry() once
        // `found` becomes true, so `end` only reaches this branch on the
        // not-found path.
        if (!found) {
          reject(
            new Error(
              `Ripgrep archive did not contain expected binary '${binName}'. ` +
                'CDN content may have changed.',
            ),
          );
        }
      });
      zipfile.on('error', (err: Error) => {
        reject(err);
      });
      zipfile.readEntry();
    });
  });
}

/**
 * User-facing error message to show when `ensureRgPath` throws. Kept
 * in one place so the Grep / Glob / Bash plumbing can reuse it.
 */
export function rgUnavailableMessage(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  const shareBin = join(resolveScreamHome(), 'bin', rgBinaryName());
  return (
    `ripgrep (rg) is not available and the automatic bootstrap failed.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `  macOS:   brew install ripgrep\n` +
    `  Ubuntu:  sudo apt-get install ripgrep\n` +
    `  Other:   https://github.com/BurntSushi/ripgrep#installation\n` +
    `\n` +
    `Alternatively, drop a static rg binary at ${shareBin}`
  );
}
