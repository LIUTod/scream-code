/**
 * OAuth provider-login contracts.
 *
 * Flow code lives per provider (one module per provider); the shared
 * mechanics live in the sibling modules: `pkce` (code verifier/challenge),
 * `callback-server` (loopback redirect listener), `device-code` (RFC 8628
 * polling), `store` (credential persistence) and `refresh` (token resolution
 * with a freshness margin).
 *
 * UI is injected: flows talk to the user through a `ProviderAuthInteraction`
 * so the same module runs under the TUI, tests, or any other host.
 */

/** Refresh the access token when it expires within this margin. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Stored OAuth credential (one per provider, `<home>/oauth/<providerId>.json`). */
export interface OAuthCredential {
  readonly type: 'oauth';
  /** Current access token. */
  access: string;
  /** Long-lived refresh token. */
  refresh: string;
  /** Epoch milliseconds at which `access` expires. */
  expires: number;
  /** Provider-specific extras (account id, plan, email, base URL, ...). */
  [key: string]: unknown;
}

/** Request-shaped auth derived from a credential. */
export interface OAuthRequestAuth {
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly baseUrl?: string;
}

/**
 * A user-facing prompt issued by a login flow.
 *
 * `allowEmpty` is honored by the text-like prompts: when set, submitting an
 * empty value is a valid answer (a flow may document a blank line as "use the
 * default") instead of being ignored by the input widget.
 */
export type AuthPrompt = { signal?: AbortSignal; allowEmpty?: boolean } & (
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | {
      type: 'select';
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | { type: 'manual_code'; message: string; placeholder?: string }
);

/** Progress/notification events emitted by a login flow. */
export type AuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: 'progress'; message: string };

/**
 * Host callbacks used by login flows. `prompt()` resolves with the entered or
 * selected string (a `select` resolves with the option id) and rejects on
 * cancel. `signal` aborts the whole flow; per-prompt cancellation uses
 * `AuthPrompt.signal` (e.g. a manual-code prompt raced against a callback
 * server is aborted when the callback wins).
 */
export interface AuthInteraction {
  readonly signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** Normalized interaction passed to provider modules (signal always present). */
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

/** Extra inputs some flows need. */
export interface LoginOptions {
  /**
   * Stable per-installation identifier (created on first use, then constant).
   * Sent by flows that identify the client host.
   */
  getDeviceId?: () => string;
}

/** A provider's OAuth login/refresh implementation. */
export interface OAuthProviderModule {
  /** Stable provider id; also the credential-store key. */
  readonly id: string;
  /** Display name, e.g. "OpenRouter". */
  readonly name: string;
  /** True when access is backed by a subscription rather than API billing. */
  readonly isSubscription?: boolean;
  /** Optional selector label override. */
  readonly loginLabel?: string;
  /** Short hint about the flow shape for the selector UI ("browser", "device code"). */
  readonly flowLabel?: string;
  /**
   * Our provider-config `type` for this sign-in target (used when writing the
   * provider entry after login). Defaults to the module id when omitted.
   */
  readonly providerConfigType?: string;

  /** Run the interactive login and return a fresh credential. */
  login(interaction: ProviderAuthInteraction, options?: LoginOptions): Promise<OAuthCredential>;

  /** Exchange the refresh token for a new credential. Throws on failure. */
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;

  /** Derive request auth from a valid credential (defaults to `{ apiKey: access }`). */
  toAuth?(credential: OAuthCredential): OAuthRequestAuth;
}

/** Selector row for the login command (serializable for UI use). */
export interface LoginProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly isSubscription?: boolean;
  readonly loginLabel?: string;
  readonly flowLabel?: string;
  /** Provider-config type to write for this sign-in target (defaults to `id`). */
  readonly providerConfigType?: string;
}
