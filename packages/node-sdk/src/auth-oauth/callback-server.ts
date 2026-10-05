/**
 * Loopback OAuth redirect listener shared by the browser sign-in flows.
 *
 * Uses node:http; only runs inside the CLI/SDK host, never in browser-facing
 * code. The listener binds a fixed port when the provider requires an exact
 * registered redirect URI (`port: 0` picks a free port for providers that
 * accept dynamic redirect URIs).
 */

import { createServer, type ServerResponse } from 'node:http';

import { oauthErrorHtml, oauthSuccessHtml } from './oauth-page';
import type { ProviderAuthInteraction } from './types';

export interface OAuthCallbackServerOptions<T> {
  /** Provider name shown on the browser page. */
  providerName: string;
  /** Address to listen on. */
  host: string;
  /** Port to listen on; `0` picks a free port. */
  port: number;
  /** Path of the redirect route, e.g. `/callback`. */
  path: string;
  /** Host in `redirectUri` when it differs from `host`, e.g. `localhost`. */
  redirectHost?: string;
  /** Expected `state` parameter. Omit when the provider does not send one. */
  state?: string;
  /**
   * Finishes the sign-in with the received code before the browser page is
   * sent, so the page can show exchange failures. Pass `async (code) => code`
   * to exchange the code later.
   */
  complete: (code: string) => Promise<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OAuthCallbackServer<T> {
  redirectUri: string;
  /**
   * Resolves with the result of `complete`, or `undefined` after `cancel()`.
   * Rejects when the provider redirects with an error, `complete` fails, the
   * signal aborts, or the timeout elapses.
   */
  wait(): Promise<T | undefined>;
  /** Stop waiting for the browser unless a callback is already being completed. */
  cancel(): void;
  close(): void;
}

function sendPage(response: ServerResponse, status: number, html: string): void {
  // A connection already torn down (close(), timeout) cannot carry a page.
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
}

export async function startOAuthCallbackServer<T>(
  options: OAuthCallbackServerOptions<T>,
): Promise<OAuthCallbackServer<T>> {
  const { providerName, signal } = options;
  if (signal?.aborted) throw new Error('Login cancelled');

  let resolveWait: (value: T | undefined) => void = () => {};
  let rejectWait: (error: Error) => void = () => {};
  const waitPromise = new Promise<T | undefined>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  // A cancelled or closed wait may never be observed.
  waitPromise.catch(() => undefined);

  let claimed = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    finish({ error: new Error('Login cancelled') });
  };
  const finish = (result: { value: T | undefined } | { error: Error }): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if ('error' in result) rejectWait(result.error);
    else resolveWait(result.value);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method !== 'GET' || url.pathname !== options.path) {
        sendPage(response, 404, oauthErrorHtml('Callback route not found.'));
        return;
      }
      if (options.state !== undefined && url.searchParams.get('state') !== options.state) {
        sendPage(response, 400, oauthErrorHtml('State mismatch.'));
        return;
      }
      if (claimed || settled) {
        sendPage(response, 409, oauthErrorHtml('This sign-in has already been handled.'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const description = url.searchParams.get('error_description') ?? error;
        sendPage(
          response,
          400,
          oauthErrorHtml(`${providerName} authorization failed.`, description),
        );
        finish({ error: new Error(`${providerName} authorization failed: ${description}`) });
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        sendPage(response, 400, oauthErrorHtml('Missing authorization code.'));
        return;
      }
      claimed = true;
      try {
        const value = await options.complete(code);
        if (settled) {
          // The wait already ended (timeout, cancel or stop) while the exchange
          // was in flight: the caller can never receive this value, so the
          // browser must not be told the sign-in succeeded. The credential it
          // produced is discarded either way.
          sendPage(
            response,
            502,
            oauthErrorHtml(`${providerName} sign-in is no longer active.`),
          );
          return;
        }
        sendPage(
          response,
          200,
          oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`),
        );
        finish({ value });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        sendPage(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
        finish({ error: failure });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('OAuth callback server did not bind to TCP');
  }

  server.on('error', (error) => {
    finish({ error });
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      finish({ error: new Error(`${providerName} sign-in timed out`) });
      // Nothing can be accepted any more: stop listening. Idle connections are
      // dropped by the caller's close() once the wait rejects.
      server.close();
    }, options.timeoutMs);
  }
  // Re-checked after the deadline is armed (and not before): the listener above
  // only sees aborts from now on, so an abort that fired while the port was
  // still binding (the caller pressed Esc during `listen`) has already
  // dispatched its event and would otherwise leave the wait pending forever.
  // Ordering matters the other way round too: this call has to happen after
  // `timer` is set, otherwise `finish` cannot clear the deadline and a
  // short-lived CLI process keeps running for the whole timeout window.
  if (signal?.aborted) {
    finish({ error: new Error('Login cancelled') });
  }
  const redirectHost = options.redirectHost ?? options.host;
  return {
    redirectUri: `http://${redirectHost.includes(':') ? `[${redirectHost}]` : redirectHost}:${address.port}${options.path}`,
    wait: () => waitPromise,
    cancel: () => {
      if (!claimed) finish({ value: undefined });
    },
    close: () => {
      finish({ error: new Error('OAuth callback server closed') });
      server.close();
      // close() only stops accepting new connections; a browser can keep a
      // spare connection alive and reuse it for a later sign-in, whose
      // callback would then be answered by this server's state check.
      server.closeAllConnections?.();
    },
  };
}

/**
 * Wait for the browser callback, or for the user to paste the code or redirect
 * URL when the browser cannot reach the loopback server (for example over
 * SSH). Without a callback server only the manual prompt is used.
 */
export async function waitForCallbackOrManualInput<T>(
  interaction: ProviderAuthInteraction,
  callback: OAuthCallbackServer<T> | undefined,
  prompt: { message: string; placeholder: string },
): Promise<{ type: 'callback'; value: T } | { type: 'manual'; input: string }> {
  const manualAbort = new AbortController();
  let manualError: Error | undefined;
  const manual = interaction
    .prompt({ type: 'manual_code', ...prompt, signal: manualAbort.signal })
    .then((input) => {
      callback?.cancel();
      return input;
    })
    .catch((error: unknown) => {
      manualError = error instanceof Error ? error : new Error(String(error));
      callback?.cancel();
      return undefined;
    });
  try {
    const value = await callback?.wait();
    if (manualError) throw manualError;
    if (value !== undefined) return { type: 'callback', value };
    const input = await manual;
    if (manualError) throw manualError as Error;
    return { type: 'manual', input: input ?? '' };
  } finally {
    manualAbort.abort();
  }
}
