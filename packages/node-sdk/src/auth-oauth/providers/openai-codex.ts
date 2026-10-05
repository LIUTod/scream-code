/**
 * OpenAI Codex OAuth provider (ChatGPT subscription sign-in).
 *
 * Two flows, chosen interactively:
 * - browser: loopback callback listener on a fixed port; when the port is
 *   already taken or the browser cannot reach the loopback server, the user
 *   pastes the authorization code / redirect URL instead;
 * - device code: headless RFC 8628 device authorization.
 *
 * Both finish with an authorization-code exchange against the token endpoint.
 * The access token is a JWT carrying the account id requests are routed with,
 * so that id is extracted and stored alongside the credential.
 */

import { startOAuthCallbackServer, waitForCallbackOrManualInput } from '../callback-server';
import { pollOAuthDeviceCodeFlow } from '../device-code';
import { generatePKCE, randomUrlSafe } from '../pkce';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

/** Public client id registered for the loopback and device-code redirect URIs. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
/** Fixed loopback port; other clients of this provider use it too. */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const SCOPE = 'openid profile email offline_access';
/** Claim namespace that holds the account id inside the access token. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
/** Client identifier reported to the authorization server. */
const ORIGINATOR = 'scream-code';
/**
 * Backend root for subscription requests. The request layer appends the
 * `/codex/responses` streaming path to the configured base URL.
 */
const API_BASE_URL = 'https://chatgpt.com/backend-api';
/** Optional override for the loopback bind address. */
const CALLBACK_HOST_ENV = 'SCREAM_CODE_OAUTH_CALLBACK_HOST';
/** Upper bound on a single authorization-server request during sign-in. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

const BROWSER_LOGIN_METHOD = 'browser';
const DEVICE_CODE_LOGIN_METHOD = 'device_code';

type OAuthToken = { access: string; refresh: string; expires: number };
type TokenOperation = 'exchange' | 'refresh';

type DeviceAuthInfo = {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
};

type DeviceTokenSuccess = {
  authorizationCode: string;
  codeVerifier: string;
};

type JwtPayload = {
  [JWT_CLAIM_PATH]?: { chatgpt_account_id?: string };
  [key: string]: unknown;
};

function getCallbackHost(): string {
  const configured = process.env[CALLBACK_HOST_ENV];
  return configured === undefined || configured === '' ? '127.0.0.1' : configured;
}

function createState(): string {
  return randomUrlSafe(16);
}

/** Accepts a redirect URL, a `code#state` pair, a query string or a bare code. */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // Not a URL; fall through to the loose formats below.
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
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

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8');
    return JSON.parse(payload) as JwtPayload;
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

/**
 * Bound a sign-in request: the interactive signal only fires when the user
 * cancels, so a stalled authorization server needs its own deadline.
 */
function requestSignal(signal: AbortSignal | null | undefined): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    signal ?? new AbortController().signal,
  ]);
}

async function fetchWithLoginCancellation(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: requestSignal(init.signal) });
  } catch (error) {
    // Only the caller's own signal means "the user cancelled"; the deadline
    // above rejects with its own timeout error.
    if (init.signal?.aborted) {
      throw new Error('Login cancelled', { cause: error });
    }
    throw error;
  }
}

async function readTokenResponse(response: Response, operation: TokenOperation): Promise<OAuthToken> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

function credentialsFromToken(token: OAuthToken): OAuthCredential {
  const accountId = getAccountId(token.access);
  if (!accountId) {
    throw new Error('Failed to extract accountId from token');
  }
  return {
    type: 'oauth',
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId,
  };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  signal: AbortSignal,
): Promise<OAuthToken> {
  const response = await fetchWithLoginCancellation(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal,
  });

  return readTokenResponse(response, 'exchange');
}

async function refreshAccessToken(refreshToken: string, signal: AbortSignal): Promise<OAuthToken> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal,
    });
  } catch (error) {
    throw new Error(
      `OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return readTokenResponse(response, 'refresh');
}

async function startDeviceAuth(signal: AbortSignal): Promise<DeviceAuthInfo> {
  const response = await fetchWithLoginCancellation(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        'OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.',
      );
    }
    const responseBody = await response.text().catch(() => '');
    throw new Error(
      `OpenAI Codex device code request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ''}`,
    );
  }

  const json = (await response.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: number | string;
  } | null;
  const intervalSeconds =
    typeof json?.interval === 'string' ? Number(json.interval.trim()) : json?.interval;
  if (
    !json?.device_auth_id ||
    !json.user_code ||
    typeof intervalSeconds !== 'number' ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 0
  ) {
    throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
  }

  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds,
  };
}

async function pollDeviceAuth(device: DeviceAuthInfo, signal: AbortSignal): Promise<DeviceTokenSuccess> {
  return pollOAuthDeviceCodeFlow<DeviceTokenSuccess>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
    signal,
    poll: async () => {
      const response = await fetchWithLoginCancellation(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: device.deviceAuthId,
          user_code: device.userCode,
        }),
        signal,
      });

      if (response.ok) {
        const json = (await response.json()) as {
          authorization_code?: string;
          code_verifier?: string;
        } | null;
        if (!json?.authorization_code || !json.code_verifier) {
          return {
            status: 'failed',
            message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`,
          };
        }
        return {
          status: 'complete',
          value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier },
        };
      }

      // Not-yet-authorized polls answer 403/404 without a body worth reading.
      if (response.status === 403 || response.status === 404) {
        return { status: 'pending' };
      }

      const responseBody = await response.text().catch(() => '');
      let errorCode: unknown;
      try {
        const json = JSON.parse(responseBody) as { error?: string | { code?: string } } | null;
        const error = json?.error;
        errorCode = typeof error === 'object' ? error?.code : error;
      } catch {
        // Non-JSON error body; handled as an unknown failure below.
      }

      if (errorCode === 'deviceauth_authorization_pending') {
        return { status: 'pending' };
      }
      if (errorCode === 'slow_down') {
        return { status: 'slow_down' };
      }

      return {
        status: 'failed',
        message: `OpenAI Codex device auth failed with status ${response.status}${responseBody ? `: ${responseBody}` : ''}`,
      };
    },
  });
}

function createAuthorizationFlow(): { verifier: string; state: string; url: string } {
  const { verifier, challenge } = generatePKCE();
  const state = createState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', ORIGINATOR);

  return { verifier, state, url: url.toString() };
}

async function exchangeAuthorizationCodeForCredentials(
  code: string,
  verifier: string,
  redirectUri: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, redirectUri, signal));
}

async function loginWithDeviceCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const device = await startDeviceAuth(interaction.signal);
  interaction.notify({
    type: 'device_code',
    userCode: device.userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
  });
  const code = await pollDeviceAuth(device, interaction.signal);
  return exchangeAuthorizationCodeForCredentials(
    code.authorizationCode,
    code.codeVerifier,
    DEVICE_REDIRECT_URI,
    interaction.signal,
  );
}

async function loginWithBrowser(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { verifier, state, url } = createAuthorizationFlow();
  // The port is shared with other clients of this provider; when it is taken,
  // fall back to the pasted redirect URL.
  const callback = await startOAuthCallbackServer({
    providerName: 'OpenAI',
    host: getCallbackHost(),
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    state,
    complete: async (code) => code,
    signal: interaction.signal,
  }).catch(() => undefined);

  interaction.notify({
    type: 'auth_url',
    url,
    instructions: 'Complete sign-in in your browser, then return to the terminal.',
  });

  try {
    const result = await waitForCallbackOrManualInput(interaction, callback, {
      message: 'Complete login in your browser, or paste the authorization code / redirect URL here:',
      placeholder: REDIRECT_URI,
    });
    let code: string | undefined;
    if (result.type === 'callback') {
      code = result.value;
    } else {
      const parsed = parseAuthorizationInput(result.input);
      if (parsed.state && parsed.state !== state) throw new Error('State mismatch');
      code = parsed.code;
    }

    if (!code) throw new Error('Missing authorization code');
    return await exchangeAuthorizationCodeForCredentials(code, verifier, REDIRECT_URI, interaction.signal);
  } finally {
    callback?.close();
  }
}

async function refreshCredentials(
  refreshToken: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  return credentialsFromToken(await refreshAccessToken(refreshToken, signal));
}

export const provider: OAuthProviderModule = {
  id: 'openai-codex',
  name: 'ChatGPT Plus/Pro (Codex Subscription)',
  isSubscription: true,
  loginLabel: 'Sign in with OpenAI',
  flowLabel: 'browser or device code',
  providerConfigType: 'openai-codex',

  async login(interaction) {
    const method = await interaction.prompt({
      type: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [
        { id: BROWSER_LOGIN_METHOD, label: 'Browser login (default)' },
        { id: DEVICE_CODE_LOGIN_METHOD, label: 'Device code login (headless)' },
      ],
    });

    if (method === DEVICE_CODE_LOGIN_METHOD) {
      return loginWithDeviceCode(interaction);
    }
    if (method !== BROWSER_LOGIN_METHOD) {
      throw new Error(`Unknown OpenAI Codex login method: ${method}`);
    }

    return loginWithBrowser(interaction);
  },

  refresh: (credential, signal) => refreshCredentials(credential.refresh, signal),

  /**
   * The backend routes requests by account, so the access token and the
   * account id extracted from it travel together as one structured credential
   * on the api-key channel: the request layer sends the token on the bearer
   * channel and the account id as its own header.
   */
  toAuth: (credential) => {
    const accountId = credential['accountId'];
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new Error(
        'OpenAI Codex credential carries no account id. Sign in again with /login for this provider.',
      );
    }
    return {
      apiKey: JSON.stringify({ token: credential.access, accountId }),
      baseUrl: API_BASE_URL,
    };
  },
};
