/**
 * Access-token resolution with a freshness margin.
 *
 * The provider layer calls this on every request: fresh tokens return
 * immediately; expired ones (or `force` after a 401) refresh inside the
 * store's per-provider queue with a double-check so concurrent requests
 * trigger at most one refresh.
 */

import { ErrorCodes, ScreamError } from '@scream-code/agent-core';

import type { FileOAuthCredentialStore } from './store';
import { ACCESS_TOKEN_REFRESH_MARGIN_MS, type OAuthCredential, type OAuthProviderModule } from './types';

/** Upper bound on a single provider refresh call. */
const REFRESH_TIMEOUT_MS = 15_000;

/** Thrown when no credential is stored for the provider (sign in first). */
export class OAuthLoginRequiredError extends ScreamError {
  constructor(providerId: string) {
    super(
      ErrorCodes.AUTH_LOGIN_REQUIRED,
      `OAuth provider "${providerId}" requires login. Run /login to sign in.`,
    );
    this.name = 'OAuthLoginRequiredError';
  }
}

export interface ResolveAccessTokenOptions {
  /** Force a refresh regardless of the remaining lifetime (used after a 401). */
  force?: boolean;
  /**
   * Access token the failed request was rejected with. A forced refresh only
   * runs while this token is still the stored one, so a rotation that landed
   * before this call is honored instead of being rotated a second time.
   * Defaults to the token observed at call entry when omitted.
   */
  rejectedAccess?: string;
  signal?: AbortSignal;
}

function isFresh(credential: OAuthCredential): boolean {
  return Date.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS < credential.expires;
}

export async function resolveAccessToken(
  store: FileOAuthCredentialStore,
  module: OAuthProviderModule,
  providerId: string,
  options: ResolveAccessTokenOptions = {},
): Promise<string> {
  const initial = store.read(providerId);
  if (initial === undefined) throw new OAuthLoginRequiredError(providerId);
  if (options.force !== true && isFresh(initial)) return initial.access;

  // Bounded so a stalled token endpoint cannot hold the store's per-provider
  // queue (and every request waiting behind it) for the runtime's own timeout.
  const refreshSignal = (): AbortSignal =>
    AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    ]);

  const refreshed = await store.modify(providerId, async (locked) => {
    if (locked === undefined) throw new OAuthLoginRequiredError(providerId);
    if (options.force !== true) {
      // Someone may have refreshed while this call waited in the queue.
      return isFresh(locked) ? undefined : module.refresh(locked, refreshSignal());
    }
    // Forced refresh (after a 401): skip when another request already rotated
    // the token past the one this call was rejected with.
    const rejected = options.rejectedAccess ?? initial.access;
    return locked.access !== rejected ? undefined : module.refresh(locked, refreshSignal());
  });

  const resolved = refreshed ?? store.read(providerId);
  if (resolved === undefined) throw new OAuthLoginRequiredError(providerId);
  return resolved.access;
}
