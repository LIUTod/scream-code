/**
 * Shared authorization-code machinery for the Google Cloud Code Assist
 * sign-ins (Antigravity and Gemini CLI).
 *
 * Both sign-ins run the same shape: a loopback redirect listener on a fixed
 * port — falling back to an ephemeral one when the preferred port is taken —
 * raced against a manual paste prompt, a form-encoded code exchange, a
 * best-effort userinfo lookup that records the account email, and a
 * project-resolution step that binds the credential to a Cloud Code Assist
 * project. Everything that differs between the two (client credentials,
 * scopes, callback coordinates, API host, project rules) is supplied by the
 * calling provider module.
 */

import { randomBytes } from 'node:crypto';

import {
  startOAuthCallbackServer,
  waitForCallbackOrManualInput,
  type OAuthCallbackServer,
} from '../callback-server';
import type { OAuthCredential, ProviderAuthInteraction } from '../types';

/** Google's authorization endpoint for the installed-app code flow. */
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Account lookup used to record the signed-in email on the credential. */
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
/** Optional override for the loopback bind address. */
const CALLBACK_HOST_ENV = 'SCREAM_CODE_OAUTH_CALLBACK_HOST';
/** Offline access asks Google for a refresh token, not just an access token. */
const AUTHORIZE_PARAMS: Readonly<Record<string, string>> = {
  access_type: 'offline',
  prompt: 'consent',
};
/** Deadline for one token, userinfo or provisioning round-trip. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh this long before the reported `expires_in` elapses. */
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** Give up on a sign-in the browser never completes. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CANCEL_MESSAGE = 'Login cancelled';
const SIGN_IN_INSTRUCTIONS = 'Complete the sign-in in your browser.';

/**
 * A failure reported deliberately by this module or by a project-resolution
 * step. The shared wrapper passes these through verbatim; anything else is an
 * unexpected transport or parse failure and is reported with the provider's
 * own wording.
 */
export class GoogleCloudCodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GoogleCloudCodeError';
  }
}

/** Everything the shared flow needs to run one provider's sign-in. */
export interface GoogleCloudCodeLoginConfig {
  /** Stable provider id, used in error messages. */
  readonly providerId: string;
  /** Display name shown on the loopback callback pages. */
  readonly providerName: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** Preferred loopback port; an ephemeral port is used when it is taken. */
  readonly callbackPort: number;
  readonly callbackPath: string;
  /** Resolves the Cloud Code Assist project the credential is bound to. */
  readonly discoverProject: (context: ProjectDiscoveryContext) => Promise<string>;
  /**
   * Wraps an unexpected project-resolution failure in the provider's wording.
   * Omitted when the provider reports its own failures in full.
   */
  readonly describeDiscoveryFailure?: (message: string) => string;
}

/** Inputs handed to a provider's project-resolution step. */
export interface ProjectDiscoveryContext {
  readonly accessToken: string;
  readonly signal: AbortSignal;
  /** Progress line for the UI while the project is resolved. */
  readonly progress: (message: string) => void;
  /** Signed-in account email, when the userinfo lookup returned one. */
  readonly email: string | undefined;
}

function getCallbackHost(): string {
  const configured = process.env[CALLBACK_HOST_ENV];
  return configured === undefined || configured === '' ? '127.0.0.1' : configured;
}

/** 16 random bytes as hex: the opaque `state` the endpoints expect back. */
function createState(): string {
  return randomBytes(16).toString('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * `fetch` with its own deadline, mapping cancellation onto the flow's cancel
 * message and a stall onto a bounded request timeout.
 */
export async function googleFetch(
  url: string,
  init: RequestInit,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout]);
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (options.signal.aborted) throw new Error(CANCEL_MESSAGE, { cause: error });
    if (timeout.aborted) {
      throw new GoogleCloudCodeError(`Timed out after ${timeoutMs}ms waiting for ${url}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Accepts a redirect URL, a query string, a `code#state` pair or a bare
 * authorization code from the manual paste prompt.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (value.length === 0) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // Not a URL; fall through to the loose formats below.
  }

  const fragment = value.indexOf('#');
  if (fragment >= 0) {
    return {
      code: value.slice(0, fragment),
      state: value.slice(fragment + 1) || undefined,
    };
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }

  return { code: value };
}

interface TokenResult {
  readonly access: string;
  /** Absent when the response carried no usable refresh token. */
  readonly refresh: string | undefined;
  readonly expires: number;
}

function readTokenResponse(body: Record<string, unknown>, providerId: string): TokenResult {
  const access = readNonEmptyString(body['access_token']);
  if (access === undefined) {
    const excerpt = JSON.stringify(body).slice(0, 500);
    throw new GoogleCloudCodeError(
      `${providerId} token response missing access token: ${excerpt}`,
    );
  }
  const expiresIn = body['expires_in'];
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    throw new GoogleCloudCodeError(`${providerId} token response missing expires_in`);
  }
  return {
    access,
    refresh: readNonEmptyString(body['refresh_token']),
    expires: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS,
  };
}

async function requestTokens(
  params: URLSearchParams,
  signal: AbortSignal,
  providerId: string,
  grant: 'token exchange' | 'token refresh',
): Promise<TokenResult> {
  const response = await googleFetch(
    TOKEN_URL,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params,
    },
    { signal },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new GoogleCloudCodeError(
      `${providerId} ${grant} failed: ${response.status} ${text.slice(0, 500)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GoogleCloudCodeError(`${providerId} ${grant} returned invalid JSON: ${text.slice(0, 500)}`);
  }
  if (!isRecord(body)) {
    throw new GoogleCloudCodeError(`${providerId} ${grant} returned an unexpected payload`);
  }
  return readTokenResponse(body, providerId);
}

/** Reads the account email; a failed lookup is not a sign-in failure. */
async function fetchAccountEmail(
  accessToken: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await googleFetch(
      USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { signal },
    );
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isRecord(body) ? readNonEmptyString(body['email']) : undefined;
  } catch (error) {
    if (signal.aborted) throw new Error(CANCEL_MESSAGE, { cause: error });
    return undefined;
  }
}

/** Starts the loopback listener, falling back to an ephemeral port. */
async function startCallbackServer(
  config: GoogleCloudCodeLoginConfig,
  state: string,
  interaction: ProviderAuthInteraction,
): Promise<OAuthCallbackServer<string>> {
  const options = {
    providerName: config.providerName,
    host: getCallbackHost(),
    path: config.callbackPath,
    state,
    complete: async (code: string) => code,
    signal: interaction.signal,
    timeoutMs: LOGIN_TIMEOUT_MS,
  };
  try {
    return await startOAuthCallbackServer({ ...options, port: config.callbackPort });
  } catch (error) {
    if (interaction.signal.aborted) throw new Error(CANCEL_MESSAGE, { cause: error });
    // The preferred port is the registered one, but a loopback redirect may
    // use any port: a busy port degrades to an ephemeral one instead of
    // failing the sign-in.
    const fallback = await startOAuthCallbackServer({ ...options, port: 0 });
    interaction.notify({
      type: 'info',
      message: `Port ${config.callbackPort} is in use; listening on ${fallback.redirectUri} instead.`,
    });
    return fallback;
  }
}

/** Reports a project-resolution failure in the provider's own wording. */
async function resolveProject(
  config: GoogleCloudCodeLoginConfig,
  context: ProjectDiscoveryContext,
): Promise<string> {
  try {
    return await config.discoverProject(context);
  } catch (error) {
    if (context.signal.aborted) throw new Error(CANCEL_MESSAGE, { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    // An account that has to be verified first is reported with the link that
    // completes the verification, whichever layer raised it.
    const validationUrl = extractGoogleValidationUrl(message);
    if (validationUrl !== undefined) {
      throw new GoogleCloudCodeError(
        formatGoogleValidationRequiredMessage(validationUrl, 'sign in again', context.email),
        { cause: error },
      );
    }
    if (error instanceof GoogleCloudCodeError) throw error;
    const describe = config.describeDiscoveryFailure;
    if (describe === undefined) throw error;
    throw new GoogleCloudCodeError(describe(message), { cause: error });
  }
}

/**
 * Pulls the account-verification URL out of a Google error body. The endpoint
 * reports it as a `VALIDATION_REQUIRED` detail with a `validation_url`.
 */
export function extractGoogleValidationUrl(errorBody: string): string | undefined {
  if (!errorBody.includes('VALIDATION_REQUIRED')) return undefined;
  const start = errorBody.indexOf('{');
  if (start === -1) return undefined;
  try {
    const parsed: unknown = JSON.parse(errorBody.slice(start));
    if (!isRecord(parsed)) return undefined;
    const error = parsed['error'];
    if (!isRecord(error)) return undefined;
    const details = error['details'];
    if (!Array.isArray(details)) return undefined;
    for (const detail of details) {
      if (!isRecord(detail) || detail['reason'] !== 'VALIDATION_REQUIRED') continue;
      const metadata = detail['metadata'];
      if (!isRecord(metadata)) continue;
      const url = readNonEmptyString(metadata['validation_url']);
      if (url !== undefined) return url;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function formatGoogleValidationRequiredMessage(
  validationUrl: string,
  nextAction: string,
  email: string | undefined,
): string {
  const account = email === undefined ? '' : ` for ${email}`;
  return `Account verification required${account}. Visit ${validationUrl} to continue, then ${nextAction}.`;
}

/**
 * Runs the interactive sign-in and returns a credential carrying the token
 * pair plus the Cloud Code Assist project resolved for it.
 */
export async function loginGoogleCloudCode(
  interaction: ProviderAuthInteraction,
  config: GoogleCloudCodeLoginConfig,
): Promise<OAuthCredential> {
  const state = createState();
  const callback = await startCallbackServer(config, state, interaction);

  try {
    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: callback.redirectUri,
      scope: config.scopes.join(' '),
      state,
      ...AUTHORIZE_PARAMS,
    }).toString();
    interaction.notify({
      type: 'auth_url',
      url: authorizeUrl.toString(),
      instructions: SIGN_IN_INSTRUCTIONS,
    });

    const result = await waitForCallbackOrManualInput(interaction, callback, {
      message:
        'Complete the sign-in in your browser, or paste the authorization code / redirect URL here:',
      placeholder: callback.redirectUri,
    });
    const pasted = result.type === 'manual' ? parseAuthorizationInput(result.input) : undefined;
    const code = result.type === 'callback' ? result.value : pasted?.code;
    if (pasted?.state !== undefined && pasted.state !== state) {
      throw new Error('OAuth state mismatch');
    }
    if (code === undefined || code.length === 0) throw new Error('Missing authorization code');

    interaction.notify({
      type: 'progress',
      message: 'Exchanging the authorization code for tokens...',
    });
    const tokens = await requestTokens(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callback.redirectUri,
      }),
      interaction.signal,
      config.providerId,
      'token exchange',
    );
    const email = await fetchAccountEmail(tokens.access, interaction.signal);
    const refresh = tokens.refresh;
    if (refresh === undefined) {
      throw new GoogleCloudCodeError('No refresh token received. Please try again.');
    }

    const projectId = await resolveProject(config, {
      accessToken: tokens.access,
      signal: interaction.signal,
      progress: (message) => {
        interaction.notify({ type: 'progress', message });
      },
      email,
    });

    return {
      type: 'oauth',
      access: tokens.access,
      refresh,
      expires: tokens.expires,
      ...(email === undefined ? {} : { email }),
      projectId,
    };
  } finally {
    callback.close();
  }
}

/**
 * Refresh-token grant for the shared endpoints. The resolved project id is
 * carried over from the stored credential rather than resolved again: project
 * provisioning is a sign-in-time step, and the credential is only usable with
 * the project it was bound to.
 */
export async function refreshGoogleCloudCode(
  credential: OAuthCredential,
  signal: AbortSignal,
  config: GoogleCloudCodeLoginConfig,
): Promise<OAuthCredential> {
  const projectId = readNonEmptyString(credential['projectId']);
  if (projectId === undefined) {
    throw new GoogleCloudCodeError(
      `${config.providerId} credentials are missing projectId; sign in again`,
    );
  }

  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: credential.refresh,
    }),
    signal,
    config.providerId,
    'token refresh',
  );
  const email = readNonEmptyString(credential['email']);

  return {
    type: 'oauth',
    access: tokens.access,
    // A non-rotating grant leaves the stored refresh token in place.
    refresh: tokens.refresh ?? credential.refresh,
    expires: tokens.expires,
    ...(email === undefined ? {} : { email }),
    projectId,
  };
}
