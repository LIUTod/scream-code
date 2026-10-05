/**
 * OpenRouter OAuth provider (PKCE sign-in).
 *
 * The authorization code is exchanged for a permanent, user-controlled API
 * key rather than an expiring access/refresh token pair. The callback is
 * received by a one-shot loopback listener on an ephemeral port with a random
 * path, raced against a manual prompt so headless or remote sessions can paste
 * the redirect URL when the browser cannot reach the loopback server.
 */

import { startOAuthCallbackServer, waitForCallbackOrManualInput } from '../callback-server';
import { generatePKCE, randomUrlSafe } from '../pkce';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

const AUTHORIZE_URL = 'https://openrouter.ai/auth';
const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';
/** Inference base URL for the OpenAI-compatible endpoint. */
const API_BASE_URL = 'https://openrouter.ai/api/v1';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
/** Optional override for the loopback bind address. */
const CALLBACK_HOST_ENV = 'SCREAM_CODE_OAUTH_CALLBACK_HOST';

type JsonObject = Record<string, unknown>;

function getCallbackHost(): string {
  const configured = process.env[CALLBACK_HOST_ENV];
  return configured === undefined || configured === '' ? '127.0.0.1' : configured;
}

/** Accepts a redirect URL, a query string, or a bare authorization code. */
function parseAuthorizationInput(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;

  try {
    return new URL(value).searchParams.get('code') ?? undefined;
  } catch {
    // Not a URL; fall through to the loose formats below.
  }

  if (value.includes('code=')) {
    return new URLSearchParams(value).get('code') ?? undefined;
  }

  return value;
}

function errorDetail(body: JsonObject): string | undefined {
  if (typeof body['error_description'] === 'string') return body['error_description'];
  if (typeof body['message'] === 'string') return body['message'];
  if (typeof body['error'] === 'string') return body['error'];
  const error = body['error'];
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as JsonObject)['message'];
    if (typeof message === 'string') return message;
  }
  return undefined;
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  if (signal.aborted) throw new Error('Login cancelled');
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error('OpenRouter OAuth token exchange timed out'));
  }, TOKEN_EXCHANGE_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal.aborted) throw new Error('Login cancelled', { cause: error });
      if (controller.signal.aborted) {
        throw new Error('OpenRouter OAuth token exchange timed out', { cause: error });
      }
      throw error;
    }

    let body: JsonObject = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as JsonObject;
      }
    } catch {
      if (signal.aborted) throw new Error('Login cancelled');
      if (controller.signal.aborted) throw new Error('OpenRouter OAuth token exchange timed out');
      if (response.ok) throw new Error('OpenRouter OAuth returned invalid JSON');
      // A non-JSON error body is reported through the HTTP status below.
    }

    if (!response.ok) {
      const detail = errorDetail(body);
      throw new Error(
        `OpenRouter OAuth key exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      );
    }

    const key = body['key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('OpenRouter OAuth response carries no "key"');
    }

    return {
      type: 'oauth',
      access: key,
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

async function loginOpenRouter(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { verifier, challenge } = generatePKCE();
  // The provider sends no `state`; the random callback path keeps stray
  // requests from completing the sign-in.
  const callback = await startOAuthCallbackServer({
    providerName: 'OpenRouter',
    host: getCallbackHost(),
    port: 0,
    path: `/oauth/callback/${randomUrlSafe()}`,
    complete: (code) => exchangeAuthorizationCode(code, verifier, interaction.signal),
    signal: interaction.signal,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });

  try {
    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      callback_url: callback.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    interaction.notify({
      type: 'progress',
      message: `Listening for OpenRouter OAuth callback on ${callback.redirectUri}`,
    });
    interaction.notify({
      type: 'auth_url',
      url: authorizeUrl.toString(),
      instructions:
        'Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.',
    });

    const result = await waitForCallbackOrManualInput(interaction, callback, {
      message:
        'Complete sign-in in your browser, or paste the authorization code / redirect URL here:',
      placeholder: callback.redirectUri,
    });
    if (result.type === 'callback') return result.value;

    const code = parseAuthorizationInput(result.input);
    if (!code) throw new Error('Missing authorization code');
    interaction.notify({
      type: 'progress',
      message: 'Exchanging authorization code for an API key...',
    });
    return await exchangeAuthorizationCode(code, verifier, interaction.signal);
  } finally {
    callback.close();
  }
}

export const provider: OAuthProviderModule = {
  id: 'openrouter',
  name: 'OpenRouter OAuth',
  loginLabel: 'Sign in with OpenRouter',
  flowLabel: 'browser',
  providerConfigType: 'openai',

  login: loginOpenRouter,

  /** The exchanged API key is permanent; there is nothing to refresh. */
  refresh: async (credential) => credential,

  toAuth: (credential) => ({ apiKey: credential.access, baseUrl: API_BASE_URL }),
};
