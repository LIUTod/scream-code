/**
 * OAuth sign-in service — the entry point behind the `/login` command.
 *
 * Owns the credential store for the current home directory, exposes the
 * provider list, and resolves bearer tokens for the request auth pipeline
 * (`provider-manager` -> `resolveOAuthTokenProvider`).
 */

import { join } from 'node:path';

import type { BearerTokenProvider, OAuthRef } from '@scream-code/agent-core';

import { resolveAccessToken } from './refresh';
import { findOAuthProvider, listLoginProviders } from './registry';
import { FileOAuthCredentialStore } from './store';
import type {
  LoginOptions,
  LoginProviderInfo,
  OAuthCredential,
  OAuthRequestAuth,
  ProviderAuthInteraction,
} from './types';

export interface OAuthLoginServiceOptions {
  /** Scream home directory; credentials live under `<homeDir>/oauth/`. */
  readonly homeDir: string;
}

export interface OAuthLoginSuccess {
  readonly providerId: string;
  readonly providerName: string;
  readonly credential: OAuthCredential;
  /** Request auth derived from the fresh credential (providers with `toAuth`). */
  readonly requestAuth?: OAuthRequestAuth;
}

/**
 * Token resolution options forwarded from the request auth pipeline: `force`
 * after a 401, carrying the access token that request was rejected with.
 */
interface TokenResolutionOptions {
  readonly force?: boolean;
  readonly rejectedAccess?: string;
}

export class OAuthLoginService {
  private readonly store: FileOAuthCredentialStore;

  constructor(options: OAuthLoginServiceOptions) {
    this.store = new FileOAuthCredentialStore(join(options.homeDir, 'oauth'));
  }

  listProviders(): readonly LoginProviderInfo[] {
    return listLoginProviders();
  }

  hasCredential(providerId: string): boolean {
    return this.store.read(providerId) !== undefined;
  }

  /** Run the provider's interactive login and persist the credential. */
  async login(
    providerId: string,
    interaction: ProviderAuthInteraction,
    options?: LoginOptions,
  ): Promise<OAuthLoginSuccess> {
    const provider = findOAuthProvider(providerId);
    if (provider === undefined) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }
    const credential = await provider.login(interaction, options);
    this.store.write(providerId, credential);
    const requestAuth = provider.toAuth?.(credential);
    return {
      providerId,
      providerName: provider.name,
      credential,
      ...(requestAuth !== undefined ? { requestAuth } : {}),
    };
  }

  /** Remove the stored credential (the provider config is cleared separately). */
  logout(providerId: string): void {
    this.store.delete(providerId);
  }

  /**
   * Bearer-token provider consumed by the request auth pipeline. Returns
   * `undefined` for provider ids that have no OAuth module, letting the
   * runtime fall back to api-key auth.
   *
   * The credential key recorded at login (`oauth.key`) wins over the config
   * key, so renaming or copying a provider entry still resolves the credential
   * written for that sign-in; the config key is the fallback.
   */
  resolveTokenProvider(providerName: string, oauthRef?: OAuthRef): BearerTokenProvider | undefined {
    const configured = oauthRef?.key === undefined ? undefined : findOAuthProvider(oauthRef.key);
    const provider = configured ?? findOAuthProvider(providerName);
    if (provider === undefined) return undefined;
    const credentialKey = configured === undefined ? providerName : provider.id;
    return {
      getAccessToken: async (options?: TokenResolutionOptions) =>
        resolveAccessToken(this.store, provider, credentialKey, {
          force: options?.force,
          rejectedAccess: options?.rejectedAccess,
        }),

      getRequestAuth: async (options?: TokenResolutionOptions): Promise<OAuthRequestAuth> => {
        const token = await resolveAccessToken(this.store, provider, credentialKey, {
          force: options?.force,
          rejectedAccess: options?.rejectedAccess,
        });
        const credential = this.store.read(credentialKey);
        const auth: OAuthRequestAuth =
          credential === undefined
            ? { apiKey: token }
            : (provider.toAuth?.(credential) ?? { apiKey: token });
        const hasRequestAuth =
          (auth.apiKey ?? '').length > 0 ||
          (auth.headers !== undefined && Object.keys(auth.headers).length > 0) ||
          auth.baseUrl !== undefined;
        // An auth shape carrying none of the three fields would read as signed
        // out downstream; keep the bearer token as the floor.
        return hasRequestAuth ? auth : { ...auth, apiKey: token };
      },
    };
  }

  /** Cached access token without refreshing (for display/status use). */
  getCachedAccessToken(providerName: string): string | undefined {
    return this.store.read(providerName)?.access;
  }
}

export * from './types';
export { findOAuthProvider, listLoginProviders, OAUTH_PROVIDERS } from './registry';
