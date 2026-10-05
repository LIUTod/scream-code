/**
 * Kimi Code (subscription) OAuth flow.
 *
 * RFC 8628 device authorization grant against https://auth.kimi.com with JSON
 * responses. The access token authenticates requests to
 * https://api.kimi.com/coding as an `Authorization: Bearer` header.
 */

import { abortableSleep, pollOAuthDeviceCodeFlow } from '../device-code';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const DEFAULT_OAUTH_HOST = 'https://auth.kimi.com';
/** Inference base URL for the Messages-API-compatible endpoint. */
const API_BASE_URL = 'https://api.kimi.com/coding';
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REFRESH_MAX_RETRIES = 3;
const REFRESH_ABORT_MESSAGE = 'Kimi Code token refresh aborted';
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

interface TokenResponse {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

/** OAuth host; overridable for staging deployments, otherwise the production host. */
function oauthHost(): string {
  const override = process.env['KIMI_CODE_OAUTH_HOST'] ?? process.env['KIMI_OAUTH_HOST'];
  return (override ?? DEFAULT_OAUTH_HOST).replace(/\/+$/, '');
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const json: unknown = await response.json();
    return json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Only http(s) URLs are trusted: the verification page is opened in a browser. */
function trustedHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function errorDetail(json: Record<string, unknown> | null): string {
  const description = json?.['error_description'];
  return typeof description === 'string' ? `: ${description}` : '';
}

async function startDeviceAuthorization(
  host: string,
  signal: AbortSignal,
): Promise<DeviceAuthorization> {
  const response = await fetch(`${host}/api/oauth/device_authorization`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
    signal: requestSignal(signal),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ''}`,
    );
  }

  const json = await readJson(response);
  const deviceCode = json?.['device_code'];
  const userCode = json?.['user_code'];
  const verificationUri = trustedHttpUrl(json?.['verification_uri']);
  const verificationUriComplete = trustedHttpUrl(json?.['verification_uri_complete']);
  if (
    typeof deviceCode !== 'string' ||
    deviceCode.length === 0 ||
    typeof userCode !== 'string' ||
    userCode.length === 0 ||
    !verificationUri ||
    !verificationUriComplete
  ) {
    throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds: positiveNumber(json?.['interval']) ?? DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds: positiveNumber(json?.['expires_in']) ?? DEVICE_CODE_TIMEOUT_SECONDS,
  };
}

function parseTokenResponse(json: Record<string, unknown> | null, operation: string): TokenResponse {
  const accessToken = json?.['access_token'];
  const refreshToken = json?.['refresh_token'];
  const expiresIn = json?.['expires_in'];
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof refreshToken !== 'string' ||
    refreshToken.length === 0 ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`);
  }
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: Date.now() + expiresIn * 1000,
  };
}

async function pollForToken(
  host: string,
  device: DeviceAuthorization,
  signal: AbortSignal,
): Promise<TokenResponse> {
  return pollOAuthDeviceCodeFlow<TokenResponse>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const response = await fetch(`${host}/api/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: DEVICE_CODE_GRANT_TYPE,
        }).toString(),
        signal: requestSignal(signal),
      });

      if (response.status >= 500) {
        const text = await response.text().catch(() => '');
        return {
          status: 'failed',
          message: `Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ''}`,
        };
      }

      const json = await readJson(response);
      if (response.ok && typeof json?.['access_token'] === 'string') {
        try {
          return { status: 'complete', value: parseTokenResponse(json, 'poll') };
        } catch (error) {
          return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
        }
      }

      const error = json?.['error'];
      if (error === 'authorization_pending') {
        return { status: 'pending' };
      }
      if (error === 'slow_down') {
        return { status: 'slow_down', intervalSeconds: positiveNumber(json?.['interval']) };
      }
      if (error === 'expired_token') {
        return {
          status: 'failed',
          message: 'Kimi Code device authorization expired. Please restart login.',
        };
      }
      if (error === 'access_denied') {
        return { status: 'failed', message: 'Kimi Code login was denied.' };
      }
      return {
        status: 'failed',
        message: `Kimi Code device token request failed (status ${response.status})${
          typeof error === 'string' ? `: ${error}${errorDetail(json)}` : ''
        }`,
      };
    },
  });
}

function isRetryableRefreshFailure(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

async function refreshToken(
  host: string,
  refreshTokenValue: string,
  signal: AbortSignal,
): Promise<TokenResponse> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await abortableSleep(1000 * 2 ** (attempt - 1), signal, REFRESH_ABORT_MESSAGE);
    }
    if (signal.aborted) {
      throw new Error(REFRESH_ABORT_MESSAGE);
    }

    let response: Response;
    try {
      response = await fetch(`${host}/api/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshTokenValue,
        }).toString(),
        signal: requestSignal(signal),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    const json = await readJson(response);
    if (response.ok) {
      return parseTokenResponse(json, 'refresh');
    }

    // Unauthorized means the stored credential is dead; the host clears it and
    // prompts for a fresh sign-in.
    if (response.status === 401 || response.status === 403 || json?.['error'] === 'invalid_grant') {
      throw new Error(
        `Kimi Code token refresh unauthorized (status ${response.status})${errorDetail(json)}`,
      );
    }

    if (isRetryableRefreshFailure(response) && attempt < REFRESH_MAX_RETRIES) {
      lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`);
      continue;
    }

    throw new Error(
      `Kimi Code token refresh failed with status ${response.status}${
        JSON.stringify(json) ? `: ${JSON.stringify(json)}` : ''
      }`,
    );
  }

  throw lastError ?? new Error('Kimi Code token refresh failed');
}

async function loginKimiCoding(
  interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
  const host = oauthHost();
  const device = await startDeviceAuthorization(host, interaction.signal);
  interaction.notify({
    type: 'device_code',
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  });
  const token = await pollForToken(host, device, interaction.signal);
  return { type: 'oauth', access: token.access, refresh: token.refresh, expires: token.expires };
}

export const provider: OAuthProviderModule = {
  id: 'kimi-coding',
  name: 'Kimi Code (subscription)',
  isSubscription: true,
  loginLabel: 'Sign in with Kimi Code',
  flowLabel: 'device code',
  providerConfigType: 'anthropic',

  login: loginKimiCoding,

  refresh: async (credential, signal) => {
    const token = await refreshToken(oauthHost(), credential.refresh, signal);
    return { type: 'oauth', access: token.access, refresh: token.refresh, expires: token.expires };
  },

  /** The subscription token rides the bearer channel of the Messages API. */
  toAuth: (credential) => ({
    headers: { Authorization: `Bearer ${credential.access}` },
    baseUrl: API_BASE_URL,
  }),
};
