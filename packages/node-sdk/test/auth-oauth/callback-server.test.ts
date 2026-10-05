import { once } from 'node:events';
import { connect } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startOAuthCallbackServer,
  type OAuthCallbackServer,
} from '../../src/auth-oauth/callback-server';

const servers: OAuthCallbackServer<unknown>[] = [];

function track<T>(server: OAuthCallbackServer<T>): OAuthCallbackServer<T> {
  servers.push(server as OAuthCallbackServer<unknown>);
  return server;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
});

async function startServer(
  overrides: Partial<{ state: string; complete: (code: string) => Promise<string> }> = {},
): Promise<OAuthCallbackServer<string>> {
  return track(
    await startOAuthCallbackServer({
      providerName: 'TestProvider',
      host: '127.0.0.1',
      port: 0,
      path: '/callback',
      state: overrides.state ?? 'expected-state',
      complete: overrides.complete ?? (async (code: string) => `done:${code}`),
    }),
  );
}

/**
 * Await `promise`, failing after `ms` instead of hanging when it never
 * settles. A regression here leaves `wait()` pending forever, which would
 * otherwise stall the whole test run instead of failing this assertion.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not settle within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('startOAuthCallbackServer', () => {
  it('completes the wait when the browser redirects with code and state', async () => {
    const server = await startServer();
    const response = await fetch(`${server.redirectUri}?code=abc&state=expected-state`);
    expect(response.status).toBe(200);
    await expect(server.wait()).resolves.toBe('done:abc');
  });

  it('rejects requests with the wrong state but keeps waiting', async () => {
    const server = await startServer();
    const bad = await fetch(`${server.redirectUri}?code=abc&state=wrong`);
    expect(bad.status).toBe(400);

    const good = await fetch(`${server.redirectUri}?code=abc&state=expected-state`);
    expect(good.status).toBe(200);
    await expect(server.wait()).resolves.toBe('done:abc');
  });

  it('rejects the wait when the provider redirects with an error', async () => {
    const server = await startServer();
    const response = await fetch(
      `${server.redirectUri}?error=access_denied&error_description=nope&state=expected-state`,
    );
    expect(response.status).toBe(400);
    await expect(server.wait()).rejects.toThrow('authorization failed: nope');
  });

  it('answers duplicate callbacks with 409 once one was claimed', async () => {
    const server = await startServer();
    await fetch(`${server.redirectUri}?code=abc&state=expected-state`);
    await server.wait();
    const duplicate = await fetch(`${server.redirectUri}?code=abc&state=expected-state`);
    expect(duplicate.status).toBe(409);
  });

  it('resolves undefined after cancel()', async () => {
    const server = await startServer();
    server.cancel();
    await expect(server.wait()).resolves.toBeUndefined();
  });

  it('rejects the wait when the signal aborts', async () => {
    const controller = new AbortController();
    const server = track(
      await startOAuthCallbackServer({
        providerName: 'TestProvider',
        host: '127.0.0.1',
        port: 0,
        path: '/callback',
        complete: async (code: string) => code,
        signal: controller.signal,
      }),
    );
    controller.abort();
    await expect(server.wait()).rejects.toThrow('Login cancelled');
  });

  it('rejects the wait when the signal aborts while the port is still binding', async () => {
    const controller = new AbortController();
    const pending = startOAuthCallbackServer({
      providerName: 'TestProvider',
      host: '127.0.0.1',
      port: 0,
      path: '/callback',
      complete: async (code: string) => code,
      signal: controller.signal,
    });

    // The abort lands before the listener reports it is bound, so the 'abort'
    // event is dispatched while the server is still starting up. A server that
    // only registers its abort listener after `listen()` resolves misses that
    // event and the wait never settles: the user cancelled and the sign-in
    // hangs forever.
    controller.abort();
    const server = track(await pending);

    await expect(settleWithin(server.wait(), 250, 'wait()')).rejects.toThrow('Login cancelled');
    server.close();
  });

  it('leaves no deadline timer armed when the signal aborts while binding', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = startOAuthCallbackServer({
        providerName: 'TestProvider',
        host: '127.0.0.1',
        port: 0,
        path: '/callback',
        complete: async (code: string) => code,
        signal: controller.signal,
        timeoutMs: 4_000,
      });

      controller.abort();
      const server = track(await pending);

      await expect(server.wait()).rejects.toThrow('Login cancelled');
      // The cancelled sign-in must take its deadline with it: an armed timer
      // keeps a short-lived CLI process alive for the whole timeout window
      // (minutes, for providers that sign in with a long timeout).
      expect(vi.getTimerCount()).toBe(0);
      server.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects the wait when the server closes before a callback', async () => {
    const server = await startServer();
    server.close();
    await expect(server.wait()).rejects.toThrow('closed');
  });

  it('does not show the success page when the exchange finishes after the timeout', async () => {
    const server = track(
      await startOAuthCallbackServer({
        providerName: 'TestProvider',
        host: '127.0.0.1',
        port: 0,
        path: '/callback',
        state: 'expected-state',
        timeoutMs: 20,
        complete: async (code: string) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return `done:${code}`;
        },
      }),
    );

    const response = await fetch(`${server.redirectUri}?code=abc&state=expected-state`);

    // The browser must not be told the sign-in succeeded: the wait already
    // timed out and the exchanged credential was discarded.
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('You may now close this page');
    await expect(server.wait()).rejects.toThrow('timed out');
  });

  it('destroys idle keep-alive connections on close()', async () => {
    const server = await startServer();
    const url = new URL(server.redirectUri);
    const socket = connect(Number(url.port), url.hostname);
    try {
      await once(socket, 'connect');
      socket.write(
        `GET ${url.pathname}?code=abc&state=expected-state HTTP/1.1\r\n` +
          `Host: ${url.hostname}\r\nConnection: keep-alive\r\n\r\n`,
      );
      await once(socket, 'data');
      await server.wait();

      // The browser now holds a spare connection. A later sign-in on a fixed
      // port would inherit it and have its callback answered by this server's
      // state check, so close() has to drop it.
      const closed = once(socket, 'close').then(() => 'closed' as const);
      const idle = new Promise<'idle'>((resolve) => {
        const timer = setTimeout(() => {
          resolve('idle');
        }, 500);
        timer.unref?.();
      });
      server.close();
      await expect(Promise.race([closed, idle])).resolves.toBe('closed');
    } finally {
      socket.destroy();
    }
  });
});
