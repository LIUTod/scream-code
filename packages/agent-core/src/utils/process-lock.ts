/**
 * Process locks: "one live process per name", held for exactly as long as the
 * holder lives.
 *
 * A lock is a listening socket the operating system owns on the holder's
 * behalf: an abstract socket on Linux, a named pipe on Windows, a socket file
 * elsewhere (macOS, the BSDs). A second process that tries to listen on the
 * same address is refused by the kernel, so two would-be holders cannot both
 * win, and a holder that dies — crash, `kill -9`, power loss — releases the
 * lock with its last breath. A pidfile cannot do either: a crashed holder leaves
 * the file behind, and the pid in it can be handed to an unrelated process, so
 * "is that pid alive" answers the wrong question (on Windows there is not even
 * a command line to check it against).
 *
 * The socket is also how others talk to the holder. On every connection the
 * holder writes one JSON line naming itself (pid, run id, start time and what
 * the caller put in `info`), so `queryProcessLock` learns who holds a name
 * without trusting any file. A caller may then send one JSON request line; the
 * holder answers it with one JSON line through `onRequest`. A request that
 * changes anything (a stop, say) must carry a secret only the owner can read —
 * see `ProcessLockOptions.token` — because a named pipe or an abstract socket
 * is reachable by every user on the machine. The secret itself never goes over
 * the socket: another user could bind a lock's (predictable) address before
 * the owner's process does and collect whatever is sent there. A request
 * carries an HMAC of itself instead, keyed with the secret and bound to a
 * timestamp and a one-time nonce, so a captured request proves nothing and
 * cannot be replayed.
 *
 * A socket file left by a holder killed without its exit hooks (only possible
 * where locks are files) is detected by connecting to it: nobody answers, so it
 * is removed and the listen is tried once more.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';

/** What a holder says about itself to every caller. */
export interface ProcessLockIdentity {
  readonly pid: number;
  /** Random per acquisition: tells two holders of the same pid apart. */
  readonly runId: string;
  readonly startedAt: number;
  readonly info?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProcessLockRequest {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type ProcessLockRequestHandler = (request: ProcessLockRequest) => unknown;

export interface HeldProcessLock {
  readonly held: true;
  readonly address: string;
  readonly identity: ProcessLockIdentity;
  /**
   * Answer requests from other processes. A request whose `token` does not
   * match the lock's token is answered with `{ ok: false, error: 'unauthorized' }`
   * and never reaches the handler.
   */
  onRequest(handler: ProcessLockRequestHandler): void;
  release(): Promise<void>;
}

export interface BusyProcessLock {
  readonly held: false;
  readonly address: string;
  /** The holder's identity; undefined when it did not answer in time. */
  readonly holder: ProcessLockIdentity | undefined;
}

export interface ProcessLockOptions {
  /**
   * What the name is unique within, typically the real path of the Scream
   * home. Two homes never share a lock, and two users never share one either,
   * because their homes differ.
   */
  readonly scope: string;
  readonly name: string;
  readonly info?: Readonly<Record<string, unknown>> | undefined;
  /** Secret a request must carry to reach `onRequest`. */
  readonly token?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

const QUERY_TIMEOUT_MS = 1_500;
/** Longest path a Unix socket address may have on macOS (sun_path is 104 bytes). */
const MAX_SOCKET_PATH = 100;

/** The address a lock name lives at. Exported for tests and diagnostics. */
export function processLockAddress(
  scope: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const digest = createHash('sha256').update(`${scope}\0${name}`).digest('hex').slice(0, 24);
  const base = `scream-${digest}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${base}`;
  if (platform === 'linux' || platform === 'android') return `\0${base}`;
  // A socket file. Its place must not depend on the process's environment:
  // `os.tmpdir()` follows TMPDIR, which differs between a Terminal window, an
  // SSH login and a launchd service, so two processes of the same home would
  // look at different addresses and both "hold" the lock. Inside the home
  // when the scope is an existing directory (every real caller: the home's
  // real path), else a fixed /tmp.
  if (isAbsolute(scope) && existsSync(scope)) {
    const inHome = join(scope, 'run', `${base}.sock`);
    if (inHome.length <= MAX_SOCKET_PATH) return inHome;
  }
  return join('/tmp', `${base}.sock`);
}

function isSocketFile(address: string): boolean {
  return !address.startsWith('\0') && !address.startsWith('\\\\.\\pipe\\');
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

/** How old a signed request may be, and how long its nonce is remembered. */
const AUTH_WINDOW_MS = 60_000;

function requestMac(token: string, at: number, nonce: string, body: string): string {
  return createHmac('sha256', token).update(`${String(at)}\n${nonce}\n${body}`).digest('hex');
}

/**
 * Replace a request's `token` with a proof of it (see the file header): the
 * holder can check it, an impostor listening at the address learns nothing.
 */
export function signProcessLockRequest(request: ProcessLockRequest, now: number = Date.now()): ProcessLockRequest {
  const token = request['token'];
  if (typeof token !== 'string') return request;
  const { token: _secret, ...rest } = request;
  const nonce = randomUUID();
  return { ...rest, auth: { at: now, nonce, mac: requestMac(token, now, nonce, JSON.stringify(rest)) } } as ProcessLockRequest;
}

/** Check a signed request against `token`; remembers its nonce so it works once. */
function verifySignedRequest(token: string, request: ProcessLockRequest, seen: Map<string, number>, now: number): boolean {
  const auth = request['auth'] as { at?: unknown; nonce?: unknown; mac?: unknown } | undefined;
  if (auth === undefined || typeof auth.at !== 'number' || typeof auth.nonce !== 'string' || typeof auth.mac !== 'string') {
    return false;
  }
  if (Math.abs(now - auth.at) > AUTH_WINDOW_MS) return false;
  for (const [nonce, at] of seen) if (now - at > 2 * AUTH_WINDOW_MS) seen.delete(nonce);
  if (seen.has(auth.nonce)) return false;
  const { auth: _auth, ...rest } = request;
  if (!tokensMatch(requestMac(token, auth.at, auth.nonce, JSON.stringify(rest)), auth.mac)) return false;
  seen.set(auth.nonce, now);
  return true;
}

function tokensMatch(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read one JSON line from a socket, or `undefined` when the connection could
 * not be made (nobody holds the name) or nothing complete arrived in time.
 */
function exchange(
  address: string,
  request: ProcessLockRequest | undefined,
  timeoutMs: number,
): Promise<{ connected: boolean; identity?: ProcessLockIdentity; reply?: unknown }> {
  return new Promise((resolve) => {
    let connected = false;
    let buffer = '';
    let identity: ProcessLockIdentity | undefined;
    let settled = false;
    const socket: Socket = createConnection(address);
    const finish = (reply?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ connected, ...(identity === undefined ? {} : { identity }), ...(reply === undefined ? {} : { reply }) });
    };
    const timer = setTimeout(() => {
      finish();
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
    });
    socket.on('error', () => {
      finish();
    });
    socket.on('close', () => {
      finish();
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          finish();
          return;
        }
        if (identity === undefined) {
          identity = parsed as ProcessLockIdentity;
          if (request === undefined) {
            finish();
            return;
          }
          socket.write(`${JSON.stringify(request)}\n`);
        } else {
          finish(parsed);
          return;
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
}

/** Who holds `name` in `scope`, or `undefined` when nobody does. */
export async function queryProcessLock(
  options: Pick<ProcessLockOptions, 'scope' | 'name' | 'platform'>,
): Promise<{ held: boolean; holder?: ProcessLockIdentity }> {
  const address = processLockAddress(options.scope, options.name, options.platform);
  const result = await exchange(address, undefined, QUERY_TIMEOUT_MS);
  if (!result.connected) return { held: false };
  return { held: true, ...(result.identity === undefined ? {} : { holder: result.identity }) };
}

/**
 * Send one request to the holder of `name` and return its answer, or
 * `undefined` when nobody holds the name or the holder did not answer.
 */
export async function requestProcessLock(
  options: Pick<ProcessLockOptions, 'scope' | 'name' | 'platform'>,
  request: ProcessLockRequest,
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<unknown> {
  const address = processLockAddress(options.scope, options.name, options.platform);
  const result = await exchange(address, signProcessLockRequest(request), timeoutMs);
  return result.reply;
}

/** Take `name` in `scope`, or learn who holds it. Never waits for the holder. */
export async function acquireProcessLock(
  options: ProcessLockOptions,
): Promise<HeldProcessLock | BusyProcessLock> {
  const address = processLockAddress(options.scope, options.name, options.platform);
  const identity: ProcessLockIdentity = {
    pid: process.pid,
    runId: randomUUID(),
    startedAt: Date.now(),
    ...(options.info === undefined ? {} : { info: options.info }),
  };
  let handler: ProcessLockRequestHandler | undefined;
  const sockets = new Set<Socket>();
  const seenNonces = new Map<string, number>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    socket.write(`${JSON.stringify(identity)}\n`);
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        if (buffer.length > 64 * 1024) socket.destroy();
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = '';
      void answer(line).then((reply) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
      });
    });
  });
  server.unref();

  async function answer(line: string): Promise<unknown> {
    let request: ProcessLockRequest;
    try {
      request = JSON.parse(line) as ProcessLockRequest;
    } catch {
      return { ok: false, error: 'bad_request' };
    }
    // A signed request (every current caller), or the bare token an older
    // scream still sends during an upgrade.
    if (
      options.token !== undefined &&
      !verifySignedRequest(options.token, request, seenNonces, Date.now()) &&
      !tokensMatch(options.token, request['token'])
    ) {
      return { ok: false, error: 'unauthorized' };
    }
    if (handler === undefined) return { ok: false, error: 'unsupported' };
    try {
      return (await handler(request)) ?? { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let releaseClearGuard: (() => Promise<void>) | undefined;
  try {
    if (isSocketFile(address)) await mkdir(dirname(address), { recursive: true, mode: 0o700 }).catch(() => {});
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await listen(server, address);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        const probe = await exchange(address, undefined, QUERY_TIMEOUT_MS);
        if (probe.connected) {
          return { held: false, address, holder: probe.identity };
        }
        if (attempt === 1) return { held: false, address, holder: undefined };
        // Nobody answered. A pipe or an abstract socket ends with its holder,
        // so a refusal there is a race with a holder that is just going away;
        // a socket file is what a killed holder leaves behind, and it is
        // cleared before the second try. Two processes clearing it at once
        // could each remove the other's fresh socket and both "hold" the
        // lock, so clearing takes an exclusive guard file first and looks
        // again under it.
        if (isSocketFile(address)) {
          releaseClearGuard = await takeClearGuard(address);
          if (releaseClearGuard === undefined) return { held: false, address, holder: undefined };
          const again = await exchange(address, undefined, QUERY_TIMEOUT_MS);
          if (again.connected) return { held: false, address, holder: again.identity };
          await unlink(address).catch(() => {});
        }
      }
    }
  } finally {
    await releaseClearGuard?.();
  }

  let released = false;
  return {
    held: true,
    address,
    identity,
    onRequest(next) {
      handler = next;
    },
    async release() {
      if (released) return;
      released = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      // `server.close` unlinks a socket file it created; nothing else to do.
    },
  };
}

/** A guard file older than this was left by a process that died while clearing. */
const CLEAR_GUARD_STALE_MS = 10_000;

/**
 * Take the exclusive right to clear a stale socket file at `address`, or
 * undefined when another process is clearing it right now.
 */
async function takeClearGuard(address: string): Promise<(() => Promise<void>) | undefined> {
  const guard = `${address}.clearing`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(guard, 'wx');
      await handle.close();
      return async () => {
        await unlink(guard).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      const info = await stat(guard).catch(() => undefined);
      if (info === undefined || Date.now() - info.mtimeMs > CLEAR_GUARD_STALE_MS) {
        await unlink(guard).catch(() => {});
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}
