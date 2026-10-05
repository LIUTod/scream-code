/**
 * Meta Model API OAuth flow.
 *
 * RFC 8628 device authorization grant against https://auth.meta.com (JSON
 * responses). Identity is split from API access: the resulting identity token
 * is not accepted for inference, so it is exchanged for a Model API key via the
 * key-mint endpoint (minted keys live about a day). The identity token is
 * stored as `refresh` and the minted key as `access`, so the standard OAuth
 * scheduler re-mints the key when it expires with no bespoke renewal
 * machinery. The identity token itself is not renewable (the authorization
 * server answers `grant_type=refresh_token` with 404 and issues no
 * `refresh_token`), so a 401/403 from the mint endpoint means the session is
 * dead and the user must sign in again.
 */

import { pollOAuthDeviceCodeFlow } from '../device-code';
import type { OAuthCredential, OAuthProviderModule, ProviderAuthInteraction } from '../types';

const CLIENT_ID = '1031625952748946';
const AUTH_HOST = 'https://auth.meta.com';
const DEVICE_AUTHORIZATION_URL = `${AUTH_HOST}/oidc/device/authorization/`;
const DEVICE_TOKEN_URL = `${AUTH_HOST}/oidc/device/token/`;
const API_KEY_MINT_URL = 'https://api.meta.ai/muse-code/key';
/** Inference base URL for the OpenAI-compatible endpoint. */
const API_BASE_URL = 'https://api.meta.ai/v1';
const API_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds?: number;
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

function errorDetail(json: Record<string, unknown> | null): string {
  for (const key of ['error_description', 'detail', 'message', 'error']) {
    const value = json?.[key];
    if (typeof value === 'string' && value.trim()) return `: ${value.trim()}`;
  }
  return '';
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

async function startDeviceAuthorization(signal: AbortSignal): Promise<DeviceAuthorization> {
  const response = await fetch(DEVICE_AUTHORIZATION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
    signal: requestSignal(signal),
  });
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `Meta device authorization failed with status ${response.status}${errorDetail(json)}`,
    );
  }
  const deviceCode = json?.['device_code'];
  const userCode = json?.['user_code'];
  const verificationUri = trustedHttpUrl(json?.['verification_uri_complete']) ?? trustedHttpUrl(json?.['verification_uri']);
  if (
    typeof deviceCode !== 'string' ||
    deviceCode.length === 0 ||
    typeof userCode !== 'string' ||
    userCode.length === 0 ||
    !verificationUri
  ) {
    throw new Error(`Invalid Meta device authorization response: ${JSON.stringify(json)}`);
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds: positiveNumber(json?.['interval']),
    expiresInSeconds: positiveNumber(json?.['expires_in']),
  };
}

async function pollForIdentityToken(
  device: DeviceAuthorization,
  signal: AbortSignal,
): Promise<string> {
  return pollOAuthDeviceCodeFlow<string>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    waitBeforeFirstPoll: true,
    signal,
    poll: async () => {
      const response = await fetch(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: device.deviceCode,
          client_id: CLIENT_ID,
        }).toString(),
        signal: requestSignal(signal),
      });
      const json = await readJson(response);
      const accessToken = json?.['access_token'];
      if (response.ok && typeof accessToken === 'string' && accessToken.length > 0) {
        return { status: 'complete', value: accessToken };
      }
      switch (json?.['error']) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return { status: 'slow_down', intervalSeconds: positiveNumber(json?.['interval']) };
        case 'access_denied':
          return { status: 'failed', message: 'Meta login was denied.' };
        case 'expired_token':
          return {
            status: 'failed',
            message: 'Meta device authorization expired. Please restart login.',
          };
        default:
          return {
            status: 'failed',
            message: `Meta device token request failed with status ${response.status}${errorDetail(json)}`,
          };
      }
    },
  });
}

/** Exchange an identity token for a Model API key. Keys are valid for about a day. */
async function mintApiKey(identityToken: string, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetch(API_KEY_MINT_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${identityToken}`,
      'Content-Type': 'application/json',
      'x-api-version': '1.0.0',
    },
    body: '{}',
    signal: requestSignal(signal),
  });
  const json = await readJson(response);
  if (response.status === 401 || response.status === 403) {
    // The identity token is not renewable (see file header); only a fresh
    // device flow helps.
    throw new Error(
      `Meta session expired (status ${response.status}). Run \`/login meta\` to sign in again.${errorDetail(json)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Meta API key mint failed with status ${response.status}${errorDetail(json)}`);
  }
  const apiKey = json?.['api_key'];
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    const actionUrl = trustedHttpUrl(json?.['action_url']);
    throw new Error(`Meta did not issue an API key.${actionUrl ? ` Complete setup at ${actionUrl}` : ''}`);
  }
  return {
    type: 'oauth',
    refresh: identityToken,
    access: apiKey,
    expires: Date.now() + API_KEY_LIFETIME_MS,
  };
}

async function loginMeta(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  try {
    const device = await startDeviceAuthorization(interaction.signal);
    interaction.notify({
      type: 'device_code',
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: device.expiresInSeconds,
    });
    const identityToken = await pollForIdentityToken(device, interaction.signal);
    interaction.notify({ type: 'progress', message: 'Enabling Meta Model API access...' });
    return await mintApiKey(identityToken, interaction.signal);
  } catch (error) {
    // An in-flight fetch rejects with a DOMException on abort; the login UI
    // matches on this message.
    if (interaction.signal.aborted) throw new Error('Login cancelled', { cause: error });
    throw error;
  }
}

export const provider: OAuthProviderModule = {
  id: 'meta',
  name: 'Meta (Muse subscription)',
  isSubscription: true,
  loginLabel: 'Sign in with Meta',
  flowLabel: 'device code',
  providerConfigType: 'openai_responses',

  login: loginMeta,

  refresh: (credential, signal) => mintApiKey(credential.refresh, signal),

  toAuth: (credential) => ({ apiKey: credential.access, baseUrl: API_BASE_URL }),
};
