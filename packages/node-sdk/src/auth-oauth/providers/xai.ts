/**
 * xAI OAuth device-code flow.
 *
 * RFC 8628 device authorization grant against https://auth.x.ai; the access
 * token is used as an API key by the model client.
 */

import { pollOAuthDeviceCodeFlow } from '../device-code';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
/** Inference base URL for the OpenAI-compatible endpoint. */
const API_BASE_URL = 'https://api.x.ai/v1';
// Identifies the client host to the authorization server; informational only.
const REFERRER = 'scream-code';
// Refresh slightly before the reported expiry to avoid using a token that dies mid-request.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** Upper bound on a single request to the authorization server. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

interface JsonObject {
  [key: string]: unknown;
}

interface OAuthHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: JsonObject;
}

interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds: number;
}

function requiredString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

function positiveNumber(body: JsonObject, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid xAI OAuth response field: ${field}`);
  }
  return value;
}

/**
 * The verification URI is opened in the user's browser, so it must be an https
 * URL; a malicious response must not be able to hand the host something else.
 */
function validateVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Untrusted verification URI in xAI OAuth response');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Untrusted verification URI in xAI OAuth response');
  }
  return url.href;
}

/**
 * Bound a request to the authorization server. The interactive signal only
 * fires when the user cancels, so a stalled endpoint needs its own deadline.
 */
function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal,
): Promise<OAuthHttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields),
      signal: requestSignal(signal),
    });
  } catch (error) {
    if (signal.aborted) {
      throw new Error('Login cancelled', { cause: error });
    }
    throw error;
  }

  let body: JsonObject;
  try {
    const parsed: unknown = await response.json();
    body =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as JsonObject)
        : {};
  } catch {
    if (signal.aborted) {
      throw new Error('Login cancelled');
    }
    throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
  }
  return { ok: response.ok, status: response.status, body };
}

function requestFailure(action: string, response: OAuthHttpResponse): Error {
  const error = typeof response.body['error'] === 'string' ? response.body['error'] : undefined;
  const description =
    typeof response.body['error_description'] === 'string'
      ? response.body['error_description']
      : undefined;
  const detail = [error, description].filter(Boolean).join(': ');
  return new Error(
    `xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
  );
}

function parseDeviceCode(body: JsonObject): DeviceCode {
  // RFC 8628 allows interval 0 (no minimum wait); fall back to the poller's
  // default instead of failing on non-positive or malformed values.
  const interval = body['interval'];
  const intervalSeconds =
    typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined;
  const rawVerificationUriComplete = body['verification_uri_complete'];
  const verificationUriComplete =
    typeof rawVerificationUriComplete === 'string' && rawVerificationUriComplete.length > 0
      ? validateVerificationUri(rawVerificationUriComplete)
      : undefined;
  return {
    deviceCode: requiredString(body, 'device_code'),
    userCode: requiredString(body, 'user_code'),
    verificationUri: validateVerificationUri(requiredString(body, 'verification_uri')),
    verificationUriComplete,
    intervalSeconds,
    expiresInSeconds: positiveNumber(body, 'expires_in'),
  };
}

function credentialsFromTokenResponse(
  body: JsonObject,
  previousRefreshToken?: string,
): OAuthCredential {
  const access = requiredString(body, 'access_token');
  // A refresh response may omit refresh_token when the token is not rotated.
  const refresh =
    body['refresh_token'] === undefined && previousRefreshToken !== undefined
      ? previousRefreshToken
      : requiredString(body, 'refresh_token');
  const expiresInSeconds =
    body['expires_in'] === undefined
      ? DEFAULT_TOKEN_LIFETIME_SECONDS
      : positiveNumber(body, 'expires_in');
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
  };
}

async function requestDeviceCode(signal: AbortSignal): Promise<DeviceCode> {
  const response = await postForm(
    DEVICE_CODE_URL,
    {
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: REFERRER,
    },
    signal,
  );
  if (!response.ok) {
    throw requestFailure('device authorization', response);
  }
  return parseDeviceCode(response.body);
}

async function pollForTokens(device: DeviceCode, signal: AbortSignal): Promise<OAuthCredential> {
  return pollOAuthDeviceCodeFlow<OAuthCredential>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const response = await postForm(
        TOKEN_URL,
        {
          grant_type: DEVICE_CODE_GRANT_TYPE,
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
        },
        signal,
      );

      if (response.ok) {
        try {
          return { status: 'complete', value: credentialsFromTokenResponse(response.body) };
        } catch (error) {
          return {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const error = response.body['error'];
      if (error === 'authorization_pending') {
        return { status: 'pending' };
      }
      if (error === 'slow_down') {
        const interval = response.body['interval'];
        return { status: 'slow_down', intervalSeconds: typeof interval === 'number' ? interval : undefined };
      }
      if (error === 'access_denied' || error === 'authorization_denied') {
        return { status: 'failed', message: 'xAI device authorization was denied' };
      }
      if (error === 'expired_token') {
        return { status: 'failed', message: 'xAI device code expired' };
      }
      return { status: 'failed', message: requestFailure('device token polling', response).message };
    },
  });
}

async function loginXai(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const device = await requestDeviceCode(interaction.signal);
  interaction.notify({
    type: 'device_code',
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete ?? device.verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  });
  return pollForTokens(device, interaction.signal);
}

async function refreshXaiToken(
  refreshToken: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const response = await postForm(
    TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    },
    signal,
  );
  if (!response.ok) {
    throw requestFailure('token refresh', response);
  }
  return credentialsFromTokenResponse(response.body, refreshToken);
}

export const provider: OAuthProviderModule = {
  id: 'xai',
  name: 'xAI Grok OAuth (SuperGrok or X Premium+)',
  isSubscription: true,
  loginLabel: 'Sign in with SuperGrok or X Premium',
  flowLabel: 'device code',
  providerConfigType: 'openai_responses',

  login: loginXai,

  refresh: (credential, signal) => refreshXaiToken(credential.refresh, signal),

  toAuth: (credential) => ({ apiKey: credential.access, baseUrl: API_BASE_URL }),
};
