/**
 * Gateway OAuth flow for a self-hosted model gateway.
 *
 * The OAuth client endpoints live on the configured gateway; only the
 * interactive browser authorization endpoint is discovered from it. Two
 * sign-in methods are offered: a loopback browser redirect with PKCE, and the
 * RFC 8628 device code grant.
 *
 * NOTE: the browser flow uses node:http (via callback-server.ts) for the OAuth
 * callback server, so this module only runs in the CLI/SDK host, never in
 * browser-facing code.
 */

import { startOAuthCallbackServer } from '../callback-server';
import { pollOAuthDeviceCodeFlow } from '../device-code';
import { generatePKCE, randomUrlSafe } from '../pkce';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1456;
const CALLBACK_PATH = '/oauth/callback';
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const LOGIN_METHOD_BROWSER = 'browser';
const LOGIN_METHOD_DEVICE_CODE = 'device-code';
/**
 * Default client id, for self-hosted gateway deployments that provision this
 * client; deployments with a different client override it.
 */
const DEFAULT_CLIENT_ID = 'scream-gateway';
const SCOPE = 'gateway offline_access';
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const GATEWAY_NOT_CONFIGURED_MESSAGE =
  'This provider has no gateway endpoint configured. Set SCREAM_CODE_RADIUS_GATEWAY to the gateway base URL.';
/** Upper bound on a single gateway request. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

interface OAuthDiscovery {
  readonly authorizationEndpoint: string;
}

interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval?: number;
}

function normalizeGatewayUrl(value: string): string {
  const withScheme = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/u, '');
}

/** Gateway base URL of the deployment, configured by the host environment. */
function gatewayUrl(): string {
  const value = process.env['SCREAM_CODE_RADIUS_GATEWAY'];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(GATEWAY_NOT_CONFIGURED_MESSAGE);
  }
  return normalizeGatewayUrl(value.trim());
}

/** OAuth client id registered with the gateway; overridable per deployment. */
function clientId(): string {
  const value = process.env['SCREAM_CODE_RADIUS_CLIENT_ID'];
  return value !== undefined && value.trim().length > 0 ? value.trim() : DEFAULT_CLIENT_ID;
}

/**
 * Bound a gateway request: the interactive signal only fires when the user
 * cancels, so a stalled gateway needs its own deadline.
 */
function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function loadOAuthDiscovery(
  gateway: string,
  signal: AbortSignal,
): Promise<OAuthDiscovery> {
  const response = await fetch(new URL('/v1/oauth', gateway), {
    headers: { accept: 'application/json' },
    signal: requestSignal(signal),
  });

  if (!response.ok) {
    throw new Error(
      `Could not load Radius OAuth config from ${gateway}: ${response.status} ${await response.text()}`,
    );
  }

  const discovery = (await response.json()) as Partial<OAuthDiscovery>;
  if (typeof discovery.authorizationEndpoint !== 'string') {
    throw new TypeError(`Invalid Radius OAuth config from ${gateway}`);
  }
  return { authorizationEndpoint: discovery.authorizationEndpoint };
}

class OAuthResponseError extends Error {
  readonly status: number;
  readonly oauthError?: string;

  constructor(
    status: number,
    oauthError: string | undefined,
    description: string | undefined,
    message: string,
  ) {
    const detail = oauthError
      ? description
        ? `${oauthError}: ${description}`
        : oauthError
      : description === undefined || description === ''
        ? String(status)
        : description;
    super(`${message}: ${detail}`);
    this.status = status;
    this.oauthError = oauthError;
  }
}

async function readOAuthResponseError(
  response: Response,
  message: string,
): Promise<OAuthResponseError> {
  const text = await response.text().catch(() => '');
  let oauthError: string | undefined;
  let description: string | undefined;

  if (text) {
    try {
      const data = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      oauthError = typeof data.error === 'string' ? data.error : undefined;
      description = typeof data.error_description === 'string' ? data.error_description : undefined;
    } catch {
      description = text;
    }
  }

  return new OAuthResponseError(response.status, oauthError, description, message);
}

async function requestOAuthToken(
  gateway: string,
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  let response: Response;
  try {
    response = await fetch(new URL('/v1/oauth/token', gateway), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error('Login cancelled', { cause: error });
    }
    throw error;
  }

  if (!response.ok) {
    throw await readOAuthResponseError(response, 'Radius OAuth token request failed');
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  return {
    type: 'oauth',
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
    scope: data.scope,
  };
}

async function loginWithBrowser(
  gateway: string,
  client: string,
  authorizationEndpoint: string,
  interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
  const { verifier, challenge } = generatePKCE();
  const state = randomUrlSafe();
  const authorizeUrl = new URL(authorizationEndpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    handoff: 'url',
    state,
  }).toString();

  const callback = await startOAuthCallbackServer({
    providerName: 'Radius',
    host: CALLBACK_HOST,
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    state,
    complete: (code) =>
      requestOAuthToken(
        gateway,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client,
          redirect_uri: REDIRECT_URI,
          code,
          code_verifier: verifier,
        }),
        interaction.signal,
      ),
    signal: interaction.signal,
  });
  interaction.notify({
    type: 'progress',
    message: `Listening for OAuth callback on ${REDIRECT_URI}`,
  });
  interaction.notify({
    type: 'auth_url',
    url: authorizeUrl.toString(),
    instructions: 'Continue in your browser.',
  });

  try {
    const credential = await callback.wait();
    if (!credential) throw new Error('OAuth callback did not complete.');
    return credential;
  } finally {
    callback.close();
  }
}

async function requestDeviceAuthorization(
  gateway: string,
  client: string,
  signal: AbortSignal,
): Promise<DeviceAuthorizationResponse> {
  let response: Response;
  try {
    response = await fetch(new URL('/v1/oauth/device', gateway), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client, scope: SCOPE }),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error('Login cancelled', { cause: error });
    }
    throw error;
  }

  if (!response.ok) {
    throw await readOAuthResponseError(response, 'Radius OAuth device authorization failed');
  }

  const data = (await response.json()) as Partial<DeviceAuthorizationResponse>;
  if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in) {
    throw new Error('Gateway OAuth device authorization response is missing required fields');
  }

  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval: data.interval,
  };
}

async function loginWithDeviceCode(
  gateway: string,
  client: string,
  interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
  const device = await requestDeviceAuthorization(gateway, client, interaction.signal);
  interaction.notify({
    type: 'device_code',
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  });

  return pollOAuthDeviceCodeFlow<OAuthCredential>({
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
    signal: interaction.signal,
    poll: async () => {
      try {
        const credentials = await requestOAuthToken(
          gateway,
          new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT_TYPE,
            client_id: client,
            device_code: device.device_code,
          }),
          interaction.signal,
        );
        return { status: 'complete', value: credentials };
      } catch (error) {
        if (!(error instanceof OAuthResponseError)) {
          throw error;
        }
        switch (error.oauthError) {
          case 'authorization_pending':
            return { status: 'pending' };
          case 'slow_down':
            return { status: 'slow_down' };
          case 'expired_token':
            return { status: 'failed', message: 'Device authorization expired.' };
          case 'access_denied':
            return { status: 'failed', message: 'Device authorization was denied.' };
          case undefined:
            throw error;
          default:
            throw error;
        }
      }
    },
  });
}

export const provider: OAuthProviderModule = {
  id: 'radius',
  name: 'Radius',
  loginLabel: 'Sign in with Radius',
  flowLabel: 'browser or device code',
  providerConfigType: 'openai',

  async login(interaction): Promise<OAuthCredential> {
    const loginMethod = await interaction.prompt({
      type: 'select',
      message: 'Sign in to Radius:',
      options: [
        { id: LOGIN_METHOD_BROWSER, label: 'Sign in with browser (recommended)' },
        {
          id: LOGIN_METHOD_DEVICE_CODE,
          label: 'Sign in with device code (when signing in from another device)',
        },
      ],
    });
    const gateway = gatewayUrl();
    const client = clientId();

    if (loginMethod === LOGIN_METHOD_DEVICE_CODE) {
      return loginWithDeviceCode(gateway, client, interaction);
    }
    if (loginMethod === LOGIN_METHOD_BROWSER) {
      const discovery = await loadOAuthDiscovery(gateway, interaction.signal);
      return loginWithBrowser(gateway, client, discovery.authorizationEndpoint, interaction);
    }
    throw new Error(`Unknown Radius sign-in method: ${loginMethod}`);
  },

  async refresh(credential, signal): Promise<OAuthCredential> {
    const client = clientId();
    return requestOAuthToken(
      gatewayUrl(),
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client,
        refresh_token: credential.refresh,
      }),
      signal,
    );
  },

  /**
   * Request auth for the configured gateway. The gateway base URL is
   * deployment configuration, so it is only reported when the gateway
   * environment variable is set; no default domain is invented.
   *
   * TODO(verify): this returns the gateway root while every OAuth endpoint on
   * the same gateway lives under `/v1/*`. Confirm against the gateway contract
   * whether the OpenAI-compatible inference path is `<root>/chat/completions`
   * or `<root>/v1/chat/completions`; if it is the latter, append `/v1` here (or
   * reuse a base URL the gateway reports) or every inference request will 404
   * while sign-in itself succeeds. Left as-is because the contract is
   * unverified and a wrong guess breaks working deployments.
   */
  toAuth: (credential) => {
    const configured = process.env['SCREAM_CODE_RADIUS_GATEWAY'];
    const baseUrl =
      configured === undefined || configured.trim().length === 0
        ? undefined
        : normalizeGatewayUrl(configured.trim());
    return baseUrl === undefined
      ? { apiKey: credential.access }
      : { apiKey: credential.access, baseUrl };
  },
};
