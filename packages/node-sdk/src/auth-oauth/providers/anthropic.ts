/**
 * Anthropic OAuth provider (Claude Pro/Max subscription sign-in).
 *
 * Browser PKCE flow against a fixed loopback callback port. The PKCE verifier
 * doubles as the OAuth `state`, so a redirect that does not carry it back is
 * rejected before the code is exchanged. When the port is already taken or the
 * browser cannot reach the loopback server, the user pastes the authorization
 * code or redirect URL instead.
 */

import { startOAuthCallbackServer, waitForCallbackOrManualInput } from '../callback-server';
import { generatePKCE } from '../pkce';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

/** Public client id of the loopback flow. */
const CLIENT_ID = Buffer.from(
  'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl',
  'base64',
).toString('utf-8');
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Optional override for the loopback bind address. */
const CALLBACK_HOST_ENV = 'SCREAM_CODE_OAUTH_CALLBACK_HOST';
/** Fixed loopback port; the redirect URI is registered with it. */
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const REQUEST_TIMEOUT_MS = 30_000;

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
};

function getCallbackHost(): string {
  const configured = process.env[CALLBACK_HOST_ENV];
  return configured === undefined || configured === '' ? '127.0.0.1' : configured;
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

function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const details: string[] = [`${error.name}: ${error.message}`];
    const withCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
    if (withCode.code) details.push(`code=${withCode.code}`);
    if (withCode.errno !== undefined) details.push(`errno=${String(withCode.errno)}`);
    if (withCode.cause !== undefined) {
      details.push(`cause=${formatErrorDetails(withCode.cause)}`);
    }
    if (error.stack) {
      details.push(`stack=${error.stack}`);
    }
    return details.join('; ');
  }
  return String(error);
}

async function postJson(
  url: string,
  body: Record<string, string | number>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });

  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
  }

  return responseBody;
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  let responseBody: string;
  try {
    responseBody = await postJson(
      TOKEN_URL,
      {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        state,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      signal,
    );
  } catch (error) {
    throw new Error(
      `Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  let tokenData: TokenResponse;
  try {
    tokenData = JSON.parse(responseBody) as TokenResponse;
  } catch (error) {
    throw new Error(
      `Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  if (
    typeof tokenData.access_token !== 'string' ||
    typeof tokenData.refresh_token !== 'string' ||
    typeof tokenData.expires_in !== 'number'
  ) {
    throw new TypeError(`Token exchange returned an unexpected response. url=${TOKEN_URL}; body=${responseBody}`);
  }

  return {
    type: 'oauth',
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: Date.now() + tokenData.expires_in * 1000,
  };
}

async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { verifier, challenge } = generatePKCE();
  const callback = await startOAuthCallbackServer({
    providerName: 'Anthropic',
    host: getCallbackHost(),
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    state: verifier,
    complete: async (code) => code,
    signal: interaction.signal,
  }).catch(() => undefined);

  try {
    const authParams = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: verifier,
    });
    interaction.notify({
      type: 'auth_url',
      url: `${AUTHORIZE_URL}?${authParams.toString()}`,
      instructions:
        'Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.',
    });

    const result = await waitForCallbackOrManualInput(interaction, callback, {
      message:
        'Complete login in your browser, or paste the authorization code / redirect URL here:',
      placeholder: REDIRECT_URI,
    });
    let code: string | undefined;
    let state = verifier;
    if (result.type === 'callback') {
      code = result.value;
    } else {
      const parsed = parseAuthorizationInput(result.input);
      if (parsed.state && parsed.state !== verifier) throw new Error('OAuth state mismatch');
      code = parsed.code;
      state = parsed.state ?? verifier;
    }

    if (!code) throw new Error('Missing authorization code');
    interaction.notify({
      type: 'progress',
      message: 'Exchanging authorization code for tokens...',
    });
    return await exchangeAuthorizationCode(code, state, verifier, REDIRECT_URI, interaction.signal);
  } finally {
    callback?.close();
  }
}

async function refreshAnthropicToken(
  refreshToken: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  let responseBody: string;
  try {
    responseBody = await postJson(
      TOKEN_URL,
      {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      },
      signal,
    );
  } catch (error) {
    throw new Error(
      `Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  let data: TokenResponse;
  try {
    data = JSON.parse(responseBody) as TokenResponse;
  } catch (error) {
    throw new Error(
      `Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
      { cause: error },
    );
  }

  if (
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    typeof data.expires_in !== 'number'
  ) {
    throw new TypeError(
      `Anthropic token refresh returned an unexpected response. url=${TOKEN_URL}; body=${responseBody}`,
    );
  }

  return {
    type: 'oauth',
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

export const provider: OAuthProviderModule = {
  id: 'anthropic',
  name: 'Anthropic (Claude Pro/Max)',
  isSubscription: true,
  loginLabel: 'Sign in with Claude (Anthropic)',
  flowLabel: 'browser',
  providerConfigType: 'anthropic',

  login: loginAnthropic,

  refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal),

  /** The subscription token rides the bearer channel of the Messages API. */
  toAuth: (credential) => ({ headers: { Authorization: `Bearer ${credential.access}` } }),
};
