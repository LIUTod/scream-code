/**
 * OpenAI provider (ChatGPT subscription sign-in).
 *
 * Public-client flow for the Responses API: the resulting user access token is
 * sent directly to api.openai.com. Every login registers a fresh client at the
 * authorization server (the request carries a placeholder client id) and the
 * server returns the issued client id inside the redirect, together with the
 * code and state. That id is stored with the credential and reused by refresh.
 *
 * A loopback listener on a fixed port receives the redirect; when it cannot
 * listen (port taken) or the browser cannot reach it, the user pastes the
 * final redirect URL instead.
 */

import { createServer, type ServerResponse } from 'node:http';

import { waitForCallbackOrManualInput, type OAuthCallbackServer } from '../callback-server';
import { oauthErrorHtml, oauthSuccessHtml } from '../oauth-page';
import { generatePKCE, randomUrlSafe } from '../pkce';
import type {
  LoginOptions,
  OAuthCredential,
  OAuthProviderModule,
  ProviderAuthInteraction,
} from '../types';

// Every login registers a new client with this placeholder id; the server
// returns the issued client id in the callback.
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/** Client name shown on the authorization page. */
const AGENT_NAME_HINT = 'scream-code';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
/** Optional override for the loopback bind address. */
const CALLBACK_HOST_ENV = 'SCREAM_CODE_OAUTH_CALLBACK_HOST';
/** Fixed loopback port; the redirect URI is registered with it. */
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;

type AuthorizationResult = {
  readonly code: string;
  readonly clientId: string;
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  scope?: unknown;
};

function getCallbackHost(): string {
  const configured = process.env[CALLBACK_HOST_ENV];
  return configured === undefined || configured === '' ? '127.0.0.1' : configured;
}

function sendPage(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
}

/** Reads code, state and the issued client id from a registration redirect. */
function authorizationResultFromCallback(url: URL, expectedState: string): AuthorizationResult {
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Missing authorization code');
  const state = url.searchParams.get('state');
  if (!state) throw new Error('Missing OAuth state');
  if (state !== expectedState) throw new Error('OAuth state mismatch');
  const clientId = url.searchParams.get('client_id')?.trim();
  if (!clientId) {
    throw new Error('OpenAI OAuth registration callback did not contain an issued client ID');
  }
  return { code, clientId };
}

/** Validates a pasted redirect URL before reading the result out of it. */
function authorizationResultFromManualInput(
  input: string,
  expectedState: string,
): AuthorizationResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Paste the full callback URL from the browser');
  }
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`The pasted callback URL must start with ${REDIRECT_URI}`);
  }
  const error = url.searchParams.get('error');
  if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
  return authorizationResultFromCallback(url, expectedState);
}

/**
 * Loopback listener for the registration redirect. Unlike the shared callback
 * server it must surface two values from the redirect (the authorization code
 * and the issued client id), so it wires the HTTP server directly while
 * keeping the same cancellation surface as `OAuthCallbackServer`.
 */
function startRegistrationCallbackServer(
  expectedState: string,
  signal: AbortSignal,
): Promise<OAuthCallbackServer<AuthorizationResult>> {
  return new Promise<OAuthCallbackServer<AuthorizationResult>>((resolveStart, rejectStart) => {
    if (signal.aborted) {
      rejectStart(new Error('Login cancelled'));
      return;
    }

    let settled = false;
    let resolveWait: (value: AuthorizationResult | undefined) => void = () => {};
    let rejectWait: (error: Error) => void = () => {};
    const waitPromise = new Promise<AuthorizationResult | undefined>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    // A cancelled or closed wait may never be observed.
    waitPromise.catch(() => undefined);

    const onAbort = (): void => {
      finish({ error: new Error('Login cancelled') });
    };
    const finish = (
      result: { value: AuthorizationResult | undefined } | { error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if ('error' in result) rejectWait(result.error);
      else resolveWait(result.value);
    };

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', REDIRECT_URI);
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        sendPage(response, 404, oauthErrorHtml('Callback route not found.'));
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        sendPage(response, 400, oauthErrorHtml('ChatGPT was not connected.', `Error: ${error}`));
        finish({ error: new Error(`ChatGPT authorization failed: ${error}`) });
        return;
      }

      let result: AuthorizationResult;
      try {
        result = authorizationResultFromCallback(url, expectedState);
      } catch (error) {
        // An invalid redirect does not end the sign-in: a later valid callback
        // (or the pasted URL) can still complete it.
        const message = error instanceof Error ? error.message : 'Invalid callback';
        sendPage(response, 400, oauthErrorHtml(message));
        return;
      }

      sendPage(
        response,
        200,
        oauthSuccessHtml('ChatGPT authentication completed. You can close this window.'),
      );
      finish({ value: result });
    });

    server.once('error', rejectStart);
    server.listen(CALLBACK_PORT, getCallbackHost(), () => {
      server.off('error', rejectStart);
      server.on('error', (error) => {
        finish({ error });
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        finish({ error: new Error('Login cancelled') });
      }
      resolveStart({
        redirectUri: REDIRECT_URI,
        wait: () => waitPromise,
        cancel: () => {
          finish({ value: undefined });
        },
        close: () => {
          finish({ error: new Error('OAuth callback server closed') });
          server.close();
          // close() only stops accepting new connections; browsers keep spare
          // connections open, and one inherited by a later login would answer
          // that login's callback with this server's state check.
          server.closeAllConnections();
        },
      });
    });
  });
}

async function requestToken(body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal,
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    throw new Error(
      `OpenAI OAuth token request failed (${response.status}): ${responseBody || response.statusText}`,
    );
  }
  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('OpenAI OAuth token response must be an object');
  }
  return data as TokenResponse;
}

function requireTokenString(
  value: unknown,
  field: 'access_token' | 'refresh_token' | 'scope',
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenAI OAuth token response has invalid ${field}`);
  }
  return value;
}

function credentialFromTokenResponse(token: TokenResponse, clientId: string): OAuthCredential {
  const access = requireTokenString(token.access_token, 'access_token');
  const refresh = requireTokenString(token.refresh_token, 'refresh_token');
  const scope = requireTokenString(token.scope, 'scope');
  const expiresIn = token.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OpenAI OAuth token response has invalid expires_in');
  }
  const scopes = scope.trim().split(/\s+/).filter(Boolean);
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
    throw new Error(`OpenAI OAuth grant did not include ${DIRECT_TOKEN_SCOPE}`);
  }
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    clientId,
    scopes,
  };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  clientId: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const token = await requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    }),
    signal,
  );
  // The ID token is not used to identify the user or read profile data; its
  // presence is kept as part of the token-response contract.
  if (typeof token.id_token !== 'string' || token.id_token.trim().length === 0) {
    throw new Error('OpenAI OAuth token response did not contain an ID token');
  }
  return credentialFromTokenResponse(token, clientId);
}

async function refreshAccessToken(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const clientId = credential['clientId'];
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    throw new Error(
      'Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT',
    );
  }
  const token = await requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: credential.refresh,
      resource: RESOURCE,
    }),
    signal,
  );
  return credentialFromTokenResponse(token, clientId);
}

/** The authorization server identifies each installation by `urn:uuid:<uuid>`. */
function agentHostId(deviceId: string | undefined): string {
  if (!deviceId || !UUID_PATTERN.test(deviceId)) {
    throw new Error('Sign in with ChatGPT requires a device ID (UUID) for this installation');
  }
  return `urn:uuid:${deviceId.toLowerCase()}`;
}

async function loginOpenAIChatGPT(
  interaction: ProviderAuthInteraction,
  options?: LoginOptions,
): Promise<OAuthCredential> {
  const hostId = agentHostId(options?.getDeviceId?.());
  const { verifier, challenge } = generatePKCE();
  const state = randomUrlSafe();
  const nonce = randomUrlSafe();
  let callback: OAuthCallbackServer<AuthorizationResult> | undefined;
  try {
    callback = await startRegistrationCallbackServer(state, interaction.signal);
  } catch (error) {
    if (interaction.signal.aborted) throw new Error('Login cancelled', { cause: error });
    interaction.notify({
      type: 'info',
      message: `Could not listen on ${REDIRECT_URI}; paste the final redirect URL to continue. ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const authorizationUrl = new URL(AUTHORIZE_URL);
  authorizationUrl.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: AGENT_NAME_HINT,
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce,
  }).toString();
  interaction.notify({
    type: 'auth_url',
    url: authorizationUrl.toString(),
    instructions:
      'Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.',
  });

  try {
    const result = await waitForCallbackOrManualInput(interaction, callback, {
      message: 'Complete login in your browser, or paste the final redirect URL here:',
      placeholder: REDIRECT_URI,
    });
    const authorization =
      result.type === 'callback'
        ? result.value
        : authorizationResultFromManualInput(result.input, state);
    interaction.notify({
      type: 'progress',
      message: 'Exchanging authorization code for tokens...',
    });
    return await exchangeAuthorizationCode(
      authorization.code,
      verifier,
      authorization.clientId,
      interaction.signal,
    );
  } catch (error) {
    if (interaction.signal.aborted) throw new Error('Login cancelled', { cause: error });
    throw error;
  } finally {
    callback?.close();
  }
}

export const provider: OAuthProviderModule = {
  id: 'openai-chatgpt',
  name: 'ChatGPT (subscription)',
  isSubscription: true,
  loginLabel: 'Sign in with ChatGPT',
  flowLabel: 'browser',
  providerConfigType: 'openai_responses',

  login: loginOpenAIChatGPT,

  refresh: refreshAccessToken,

  /** The access token authenticates the Responses API as the bearer key. */
  toAuth: (credential) => ({ apiKey: credential.access }),
};
