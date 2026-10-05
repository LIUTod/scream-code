import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAccessToken } from '../../src/auth-oauth/refresh';
import { FileOAuthCredentialStore } from '../../src/auth-oauth/store';
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  type OAuthCredential,
  type OAuthProviderModule,
} from '../../src/auth-oauth/types';

const HOUR_MS = 60 * 60 * 1000;

function credential(access: string, expiresInMs: number): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh: 'refresh-token',
    expires: Date.now() + expiresInMs,
  };
}

describe('resolveAccessToken', () => {
  let dir: string;
  let store: FileOAuthCredentialStore;
  let module: OAuthProviderModule;
  let refresh: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oauth-refresh-'));
    store = new FileOAuthCredentialStore(join(dir, 'oauth'));
    refresh = vi.fn(async (_credential: OAuthCredential) =>
      credential('rotated-access', 2 * HOUR_MS),
    );
    module = {
      id: 'test-provider',
      name: 'Test Provider',
      login: vi.fn(),
      refresh: refresh as unknown as OAuthProviderModule['refresh'],
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a fresh token without refreshing', async () => {
    store.write('test-provider', credential('fresh-access', HOUR_MS));
    await expect(resolveAccessToken(store, module, 'test-provider')).resolves.toBe('fresh-access');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the token is inside the freshness margin and persists the result', async () => {
    store.write('test-provider', credential('stale-access', ACCESS_TOKEN_REFRESH_MARGIN_MS / 2));
    await expect(resolveAccessToken(store, module, 'test-provider')).resolves.toBe(
      'rotated-access',
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.read('test-provider')?.access).toBe('rotated-access');
  });

  it('refreshes in place of a valid token when forced', async () => {
    store.write('test-provider', credential('fresh-access', HOUR_MS));
    await expect(
      resolveAccessToken(store, module, 'test-provider', { force: true }),
    ).resolves.toBe('rotated-access');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('throws login-required when no credential is stored', async () => {
    await expect(resolveAccessToken(store, module, 'test-provider')).rejects.toThrow(
      'requires login',
    );
  });

  it('double-checks inside the queue so concurrent expiries refresh once', async () => {
    store.write('test-provider', credential('stale-access', ACCESS_TOKEN_REFRESH_MARGIN_MS / 2));
    const [a, b] = await Promise.all([
      resolveAccessToken(store, module, 'test-provider'),
      resolveAccessToken(store, module, 'test-provider'),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe('rotated-access');
    expect(b).toBe('rotated-access');
  });

  it('skips a forced refresh when another caller already rotated the token', async () => {
    store.write('test-provider', credential('rejected-access', HOUR_MS));
    const first = resolveAccessToken(store, module, 'test-provider', { force: true });
    const second = resolveAccessToken(store, module, 'test-provider', { force: true });
    await Promise.all([first, second]);
    // Both callers were forced with the same stale token; only one rotation
    // may happen (the second observes a different access token and skips).
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('honors a rotation that landed before a forced refresh of the rejected token', async () => {
    store.write('test-provider', credential('rejected-access', HOUR_MS));

    await expect(
      resolveAccessToken(store, module, 'test-provider', {
        force: true,
        rejectedAccess: 'rejected-access',
      }),
    ).resolves.toBe('rotated-access');
    expect(refresh).toHaveBeenCalledTimes(1);

    // The staggered second caller was rejected with the *same* token, which the
    // store no longer holds: refreshing again would rotate a token that was
    // never rejected (and, for providers that invalidate on rotation, break the
    // request retrying with it).
    await expect(
      resolveAccessToken(store, module, 'test-provider', {
        force: true,
        rejectedAccess: 'rejected-access',
      }),
    ).resolves.toBe('rotated-access');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('still forces a refresh for the token that is actually stored', async () => {
    store.write('test-provider', credential('current-access', HOUR_MS));

    await expect(
      resolveAccessToken(store, module, 'test-provider', {
        force: true,
        rejectedAccess: 'current-access',
      }),
    ).resolves.toBe('rotated-access');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('bounds the refresh call with its own timeout and forwards the caller signal', async () => {
    store.write('test-provider', credential('stale-access', ACCESS_TOKEN_REFRESH_MARGIN_MS / 2));
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let seen: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gatedRefresh = vi.fn(async (_credential: OAuthCredential, signal: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return credential('rotated-access', 2 * HOUR_MS);
    });
    refresh = gatedRefresh;
    module.refresh = gatedRefresh;
    try {
      const pending = resolveAccessToken(store, module, 'test-provider', { signal: caller.signal });
      await vi.waitFor(() => {
        expect(seen).toBeDefined();
      });

      // The refresh runs under its own deadline, not under the never-aborting
      // default signal the call sites pass.
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
      expect(seen?.aborted).toBe(false);

      // The caller's signal is forwarded into the refresh call.
      caller.abort();
      expect(seen?.aborted).toBe(true);

      timeout.abort();
      release?.();
      await expect(pending).resolves.toBe('rotated-access');
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
