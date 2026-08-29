import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GatewayAuth,
  gatewayVerdict,
  isLoopbackAddress,
  parseCookies,
} from '#/web/auth';
import { createFixedWindowLimiter } from '#/web/rateLimit';
import { runWebServer, type WebServerHandle } from '#/web/server';

const tempDirs: string[] = [];
const handles: WebServerHandle[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'scream-web-gateway-'));
  tempDirs.push(home);
  return home;
}

interface ServerOptions {
  readonly lan?: boolean;
  readonly token?: string;
}

async function startServer(extra: ServerOptions = {}): Promise<WebServerHandle> {
  const home = await makeHome();
  process.env['SCREAM_CODE_HOME'] = home;
  const handle = await runWebServer({
    port: 0,
    workDir: process.cwd(),
    yolo: false,
    auto: false,
    open: false,
    skillsDirs: [],
    ...extra,
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await handle.close().catch(() => undefined);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('runWebServer default mode (no gateway)', () => {
  it('serves the REST API without any auth requirement', async () => {
    const handle = await startServer();
    const res = await fetch(`${handle.url}/api/v1/sessions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe('runWebServer LAN mode', () => {
  it('trusts loopback, enforces the key on the login endpoint, and rate limits', async () => {
    const handle = await startServer({ lan: true, token: 'unit-test-key' });

    // Loopback is always trusted: the API works without any cookie.
    const sessions = await fetch(`${handle.url}/api/v1/sessions`);
    expect(sessions.status).toBe(200);

    // Status endpoint: gateway is on and the loopback caller is authenticated.
    const status = await (await fetch(`${handle.url}/api/v1/gateway/status`)).json();
    expect(status).toEqual({ authRequired: true, authenticated: true });

    // Gateway page is served to unauthenticated (simulated non-local) gate
    // decisions; from loopback it is directly reachable as well.
    const page = await fetch(`${handle.url}/gateway`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('访问验证');

    // Wrong key → 401, never a session.
    const bad = await fetch(`${handle.url}/api/v1/gateway/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'wrong-key' }),
    });
    expect(bad.status).toBe(401);

    // Correct key → 200 + HttpOnly session cookie.
    const ok = await fetch(`${handle.url}/api/v1/gateway/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'unit-test-key' }),
    });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('scream_gateway=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    // Key material is never written to disk.
    const keyPath = join(process.env['SCREAM_CODE_HOME']!, 'web-gateway.json');
    const raw = await readFile(keyPath, 'utf-8');
    expect(raw).not.toContain('unit-test-key');
    const keyStat = await stat(keyPath);
    expect(keyStat.mode & 0o777).toBe(0o600);

    // Rate limit: 10 failed attempts allowed per window, the 11th is blocked.
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${handle.url}/api/v1/gateway/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'wrong-key' }),
      });
      expect(res.status).toBe(401);
    }
    const blocked = await fetch(`${handle.url}/api/v1/gateway/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'wrong-key' }),
    });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { retryAfter?: number };
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('accepts loopback WebSocket connections without a cookie', async () => {
    const handle = await startServer({ lan: true, token: 'unit-test-key' });
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${handle.url.replace('http', 'ws')}/api/v1/ws`);
      ws.on('open', () => {
        ws.close();
        resolve(true);
      });
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(opened).toBe(true);
  });
});

describe('GatewayAuth', () => {
  it('persists an explicit key as scrypt hash with 0600 mode and reloads it', async () => {
    const home = await makeHome();
    const first = await GatewayAuth.setup({ homeDir: home, token: 'secret-key' });
    expect(first.plaintext).toBe('secret-key');
    expect(first.generated).toBe(false);
    expect(first.verifyKey('secret-key')).toBe(true);
    expect(first.verifyKey('wrong')).toBe(false);
    expect(first.verifyKey('')).toBe(false);

    const keyPath = join(home, 'web-gateway.json');
    const raw = await readFile(keyPath, 'utf-8');
    expect(raw).not.toContain('secret-key');
    const fileStat = await stat(keyPath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const reloaded = await GatewayAuth.setup({ homeDir: home });
    expect(reloaded.plaintext).toBeNull();
    expect(reloaded.generated).toBe(false);
    expect(reloaded.verifyKey('secret-key')).toBe(true);
  });

  it('generates a key when none exists and reuses it on reload', async () => {
    const home = await makeHome();
    const first = await GatewayAuth.setup({ homeDir: home });
    expect(first.generated).toBe(true);
    expect(first.plaintext).toBeTruthy();
    expect(first.plaintext!.length).toBeGreaterThanOrEqual(16);

    const reloaded = await GatewayAuth.setup({ homeDir: home });
    expect(reloaded.generated).toBe(false);
    expect(reloaded.plaintext).toBeNull();
    expect(reloaded.verifyKey(first.plaintext!)).toBe(true);
  });

  it('issues, verifies, and destroys cookie sessions', async () => {
    const home = await makeHome();
    const auth = await GatewayAuth.setup({ homeDir: home, token: 'k' });
    const sid = auth.createSession();
    const cookie = auth.sessionCookie(sid);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(auth.verifySession(cookie)).toBe(true);
    expect(auth.verifySession('scream_gateway=forged-sid')).toBe(false);
    expect(auth.verifySession(undefined)).toBe(false);
    auth.destroySession(cookie);
    expect(auth.verifySession(cookie)).toBe(false);
  });
});

describe('gatewayVerdict', () => {
  const base = { loopback: false, authenticated: false, apiPrefix: '/api/v1' };

  it('allows loopback, authenticated, and gateway paths', () => {
    expect(gatewayVerdict({ ...base, loopback: true, path: '/', method: 'GET' })).toBe('allow');
    expect(gatewayVerdict({ ...base, authenticated: true, path: '/', method: 'GET' })).toBe('allow');
    expect(gatewayVerdict({ ...base, path: '/gateway', method: 'GET' })).toBe('allow');
    expect(gatewayVerdict({ ...base, path: '/api/v1/gateway/status', method: 'GET' })).toBe('allow');
    expect(gatewayVerdict({ ...base, path: '/api/v1/gateway/login', method: 'POST' })).toBe('allow');
    expect(gatewayVerdict({ ...base, path: '/api/v1/gateway/logout', method: 'POST' })).toBe('allow');
  });

  it('rejects unauthenticated API and non-GET page requests', () => {
    expect(gatewayVerdict({ ...base, path: '/api/v1/sessions', method: 'GET' })).toBe('unauthorized');
    expect(gatewayVerdict({ ...base, path: '/api/v1/ws', method: 'GET' })).toBe('unauthorized');
    expect(gatewayVerdict({ ...base, path: '/api/v1/gateway/other', method: 'GET' })).toBe('unauthorized');
    expect(gatewayVerdict({ ...base, path: '/', method: 'POST' })).toBe('unauthorized');
  });

  it('redirects unauthenticated page GETs to the gateway', () => {
    expect(gatewayVerdict({ ...base, path: '/', method: 'GET' })).toBe('redirect');
    expect(gatewayVerdict({ ...base, path: '/assets/app.js', method: 'GET' })).toBe('redirect');
  });
});

describe('helpers', () => {
  it('detects loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('parses cookie headers', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' });
    expect(parseCookies('scream_gateway=abc%20d')).toEqual({ scream_gateway: 'abc d' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('broken')).toEqual({});
  });
});

describe('createFixedWindowLimiter', () => {
  it('blocks beyond max within the window and resets on demand', () => {
    const limiter = createFixedWindowLimiter({ windowMs: 60_000, max: 3 });
    expect(limiter.hit('ip').ok).toBe(true);
    expect(limiter.hit('ip').ok).toBe(true);
    expect(limiter.hit('ip').ok).toBe(true);
    const fourth = limiter.hit('ip');
    expect(fourth.ok).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.hit('other').ok).toBe(true);
    limiter.reset('ip');
    expect(limiter.hit('ip').ok).toBe(true);
  });
});
