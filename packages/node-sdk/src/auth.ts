import {
  type BearerTokenProvider,
  type OAuthRef,
} from '@scream-code/agent-core';
import { createScreamDeviceId } from '@scream-code/config';

import { OAuthLoginService } from './auth-oauth/index';
import type {
  LoginOptions,
  LoginProviderInfo,
  OAuthRequestAuth,
  ProviderAuthInteraction,
} from './auth-oauth/index';

export interface ScreamAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
}

export interface ScreamAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

export interface ScreamAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface ScreamAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
}

export interface ScreamAuthOAuthLoginResult {
  readonly providerId: string;
  readonly providerName: string;
  /** Request auth derived from the fresh credential, for the provider entry. */
  readonly requestAuth?: OAuthRequestAuth;
}

export class ScreamAuthFacade {
  private readonly oauth: OAuthLoginService;

  constructor(private readonly options: ScreamAuthFacadeOptions) {
    this.oauth = new OAuthLoginService({ homeDir: options.homeDir });
  }

  // ── OAuth provider sign-in ─────────────────────────────────────────────

  /** Providers with built-in OAuth sign-in support (selector order). */
  listOAuthProviders(): readonly LoginProviderInfo[] {
    return this.oauth.listProviders();
  }

  /** Whether a stored credential exists for the provider (selector ✓ marker). */
  hasOAuthCredential(providerId: string): boolean {
    return this.oauth.hasCredential(providerId);
  }

  /**
   * Run the interactive login for `providerId`; credentials are persisted.
   *
   * The stable per-installation device id is supplied here (created on first
   * use under the Scream home directory) so flows that identify this host —
   * e.g. the ChatGPT sign-in, which sends it as the agent host id — work on
   * every host path without each caller wiring it up. Callers may still
   * override it through `options`.
   */
  async loginOAuthProvider(
    providerId: string,
    interaction: ProviderAuthInteraction,
    options?: LoginOptions,
  ): Promise<ScreamAuthOAuthLoginResult> {
    const getDeviceId =
      options?.getDeviceId ?? ((): string => createScreamDeviceId(this.options.homeDir));
    const result = await this.oauth.login(providerId, interaction, { ...options, getDeviceId });
    return {
      providerId: result.providerId,
      providerName: result.providerName,
      ...(result.requestAuth !== undefined ? { requestAuth: result.requestAuth } : {}),
    };
  }

  /** Remove the stored credential for `providerId` (no-op when absent). */
  logoutOAuthProvider(providerId: string): void {
    this.oauth.logout(providerId);
  }

  // ── Runtime auth pipeline ──────────────────────────────────────────────

  async getManagedUsage(_providerName?: string | undefined): Promise<
    | { readonly kind: 'ok'; readonly summary: unknown; readonly limits: readonly unknown[] }
    | { readonly kind: 'error'; readonly message: string }
  > {
    return {
      kind: 'error',
      message: 'Managed usage requires OAuth login. Use /config to set up a custom model provider.',
    };
  }

  async getCachedAccessToken(providerName?: string): Promise<string | undefined> {
    if (providerName === undefined) return undefined;
    return this.oauth.getCachedAccessToken(providerName);
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider | undefined => this.oauth.resolveTokenProvider(providerName, oauthRef);
}
